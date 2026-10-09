/** @layer planner */
/*
 * Deciding what a unit does with its action: the best attack, heal or approach, priced square by square. The plan is a
 * generator that yields between expensive calls, so the threat line can spread it over idle frames while the driver
 * runs it in one go.
 */
import {
  isNormalSightRule,
  itemSightRule,
  movementField,
  systemMeleeElevationReach
} from '../foundry/system-bridge.mjs';
import { board } from './board.mjs';
import { cellKey, footprintOccupiedIn, parseCellKey, standingDistance } from './grid.mjs';
import { canActivate, canTarget, loadout, usableWeapons } from './loadout.mjs';
import { isAlive } from './readiness.mjs';
import { canAct, canEverAct } from './roster.mjs';
import { measureGroupSteps, positionalValue } from './scoring.mjs';
import {
  auraModsAt,
  elevationAt,
  engagementIsPossible,
  exposureAt,
  flankedAt,
  flanksTargetFrom,
  hazardAt,
  moveCostAt,
  occupiedCells,
  primeAuraMods,
  reachableAnchors,
  sightBlocked,
  terrainModsAt,
  threatRectsFor
} from './squares.mjs';
import { drain } from './steps.mjs';
import { healAmountOf, healItemsOf, healValue, hurtEnoughFor } from './support.mjs';
import { areFriendly, isLure, targetTiers, targetableTokens, tauntorOf } from './targeting.mjs';
import {
  AI_CRITICAL_FRACTION,
  CRITICAL_HEAL_BONUS,
  PURSUIT_HORIZON_SQUARES,
  PURSUIT_HORIZON_TURNS,
  SCORE_EPSILON,
  SCORE_SCALE
} from './tuning.mjs';

/* -------------------------------------------- */
/*  The turn                                    */
/* -------------------------------------------- */
/**
 * Decide what this unit does with its action: an attack, a heal, an approach, or null for nothing. It runs in one go,
 * so the host client does not respond until the plan is done; `planTurnSteps` is the same plan in steps.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit planning its action.
 * @param {import('./types.mjs').RiskProfile} riskProfile The weights it plans with.
 * @param {object} [options] The options `planTurnSteps` takes.
 * @returns {import('./types.mjs').TurnPlan|null}
 */
export function planTurn(planner, unit, riskProfile, options = {}) {
  return drain(planTurnSteps(planner, unit, riskProfile, options));
}

/**
 * `planTurn` as a generator that yields between the squares, engagements and matchups it prices, so one plan can be
 * spread over several frames. The decision is the same either way.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit planning its action.
 * @param {import('./types.mjs').RiskProfile} riskProfile The weights it plans with.
 * @param {object} [options]
 * @param {boolean} [options.ignoreTurnState] Plan as if the unit had its whole turn and full movement in hand.
 * @param {boolean} [options.ignoreReadiness] Plan for any living unit, even one whose stance is broken or whose
 *   status holds it.
 * @param {boolean} [options.stationary] Plan from the square the unit stands on, without moving.
 * @param {import('./types.mjs').PlannerUnit|null} [options.seizeBlocker] A unit in a Seize unit's way, added to the
 *   targets.
 * @param {number} [options.seizeUnlock] How much clearing that blocker shortens the Seize route, from 0 to 1.
 * @param {number|null} [options.moveBudget] The most movement the plan may spend; null for all of it.
 * @returns {Generator<void, import('./types.mjs').TurnPlan|null>}
 */
export function* planTurnSteps(planner, unit, riskProfile, {
  ignoreTurnState = false, ignoreReadiness = false, stationary = false,
  seizeBlocker = null, seizeUnlock = 0, moveBudget = null
} = {}) {
  if (!riskProfile) throw new TypeError('planTurn: a risk profile is required.');
  const ready = ignoreReadiness
    ? isAlive(unit)
    : (ignoreTurnState ? canEverAct(unit) : canAct(unit));
  if (!ready) return null;

  const { primary, deferred: sneaking } = targetTiers(planner, unit);
  const targets = [...(primary.length > 0 ? primary : sneaking)];
  const deferred = primary.length > 0 ? sneaking : [];

  const raw = seizeBlocker?.isCharacter === true ? seizeBlocker : null;
  const blocker = raw ? (targetableTokens(planner, [raw])[0] ?? null) : null;
  if (blocker && !targets.some(target => target.tokenUuid === blocker.tokenUuid)) targets.push(blocker);

  const weapons = usableWeapons(unit);
  const healItems = healItemsOf(loadout(unit).items).filter(item => canActivate(unit, item));
  const canAttack = targets.length > 0 && weapons.length > 0;
  const canHeal = healItems.length > 0 && riskProfile.healWeight > 0 && !tauntorOf(unit);
  if (!canAttack && !canHeal) return null;

  const { graph, anchors } = reachableAnchors(unit, { ignoreTurnState, stationary });
  const squares = yield* anchorPropertiesSteps(planner, unit, graph, anchors, riskProfile, moveBudget);
  /** @type {import('./types.mjs').ActionSearch} */
  const search = { planner, unit, risk: riskProfile, graph, squares, start: { x: unit.x, y: unit.y } };

  const { candidates, blockedCandidates } = yield* engagementCandidatesSteps(
    unit, canAttack ? targets : [], weapons, squares
  );

  let attackPlan = null;
  if (candidates.length > 0) {
    attackPlan = yield* bestAttackPlanSteps(search, candidates, { blocker, unlock: seizeUnlock });
  } else if (blockedCandidates.length > 0) {
    attackPlan = planApproach(search, blockedCandidates);
  }

  if (attackPlan?.kind !== 'attack' && deferred.length > 0 && canAttack) {
    const { candidates: sneakCandidates } = yield* engagementCandidatesSteps(unit, deferred, weapons, squares);
    if (sneakCandidates.length > 0) {
      const sneakPlan = yield* bestAttackPlanSteps(search, sneakCandidates);
      if (sneakPlan) attackPlan = sneakPlan;
    }
  }

  const healPlan = canHeal ? yield* planHealSteps(search, healItems) : null;
  if (healPlan) {
    if (!attackPlan || attackPlan.kind !== 'attack') return healPlan;
    if (healPlan.score.total > attackPlan.score.total + SCORE_EPSILON) return healPlan;
  }
  return attackPlan;
}

/* -------------------------------------------- */
/*  Attack planning                             */
/* -------------------------------------------- */
/**
 * Every weapon, square and target this unit could engage from, split by whether the square is free to stop on.
 * Stepped work, yielding after each square's sight and reach checks.
 */
function* engagementCandidatesSteps(unit, targets, weapons, squares) {
  const candidates = [];
  const blockedCandidates = [];
  if (targets.length === 0) return { candidates, blockedCandidates };
  for (const weapon of weapons) {
    const range = weapon.range;
    if (!range) continue;
    const allowed = targets.filter(target => canTarget(unit, weapon, target));
    if (allowed.length === 0) continue;
    for (const anchor of squares.values()) {
      for (const target of allowed) {
        const distance = engagementIsPossible(unit, anchor.anchorX, anchor.anchorY, target, weapon);
        if (distance === null) continue;
        const candidate = {
          weapon,
          anchorX: anchor.anchorX,
          anchorY: anchor.anchorY,
          target,
          distance,
          moveCost: anchor.moveCost,
          terrain: anchor.terrain,
          terrainSig: anchor.terrainSig,
          elevation: anchor.elevation,
          aura: anchor.aura,
          auraSig: anchor.auraSig,
          cover: anchor.cover,
          hazard: anchor.hazard,
          exposure: anchor.threats ? anchor.threats.size - (anchor.threats.has(target.tokenId) ? 1 : 0) : 0,
          flank: distance === 1 && flanksTargetFrom(unit, anchor.anchorX, anchor.anchorY, target),
          flanked: distance === 1 && flankedAt(unit, anchor.anchorX, anchor.anchorY, target)
        };
        if (anchor.free) candidates.push(candidate);
        else blockedCandidates.push(candidate);
      }
      yield;
    }
  }
  return { candidates, blockedCandidates };
}

/**
 * The best attack among a set of candidates, measured one weapon group at a time by `scoring.mjs`. Stepped work,
 * whose steps are the matchups measureGroupSteps in `scoring.mjs` measures. `blocker` and `unlock` name a unit in
 * a Seize unit's way, as measureGroupSteps takes them.
 */
function* bestAttackPlanSteps(search, candidates, { blocker = null, unlock = 0 } = {}) {
  const { unit, graph, start } = search;
  const byWeapon = new Map();
  for (const candidate of candidates) {
    if (!byWeapon.has(candidate.weapon.id)) byWeapon.set(candidate.weapon.id, []);
    byWeapon.get(candidate.weapon.id).push(candidate);
  }
  let best = null;
  for (const group of byWeapon.values()) {
    best = yield* measureGroupSteps(search, group, best, { blocker, unlock });
  }
  if (!best) return null;
  return {
    kind: 'attack',
    unit,
    target: best.target,
    weapon: best.weapon,
    distance: best.distance,
    destination: { x: best.anchorX, y: best.anchorY },
    needsMove: best.anchorX !== start.x || best.anchorY !== start.y,
    moveCost: best.moveCost,
    score: best.score,
    matchup: best.matchup,
    position: {
      cover: best.cover,
      hazard: best.hazard,
      exposure: best.exposure,
      flank: best.flank,
      flanked: best.flanked
    },
    graph
  };
}

/** The terrain bonus passed to the forecast for an airborne unit: the system's terrain rules give it none. */
const NO_TERRAIN_BONUS = Object.freeze({ eva: 0, def: 0, res: 0 });

/**
 * Every reachable square with the ground, the exposure and the cost the planner prices a candidate by. Stepped
 * work, yielding after each square's ground, aura and exposure are read.
 * @returns {Generator<void, Map<string, object>>} The squares by cell key, occupied ones included. Each one's `free`
 *   says whether the unit can end its move there.
 */
function* anchorPropertiesSteps(planner, unit, graph, anchors, riskProfile, moveBudget = null) {
  const dims = { width: unit.width, height: unit.height };
  const occupied = occupiedCells(unit);
  const hasTerrain = board(planner).terrain.hasTerrain === true;
  const terrainMatters = !unit.airborne && hasTerrain;
  const threatRects = riskProfile.exposureWeight > 0 ? threatRectsFor(planner, unit) : [];
  const landable = new Set((graph.destinations ?? []).map(cell => cellKey(cell.x, cell.y)));
  const candidates = [];
  for (const anchorKey of anchors) {
    const { x: anchorX, y: anchorY } = parseCellKey(anchorKey);
    const moveCost = moveCostAt(graph, anchorX, anchorY);
    if (!Number.isFinite(moveCost)) continue;
    if (moveBudget !== null && moveCost > moveBudget) continue;
    candidates.push({ anchorKey, anchorX, anchorY, moveCost });
  }
  primeAuraMods(unit, candidates.map(candidate => ({ x: candidate.anchorX, y: candidate.anchorY })));
  const squares = new Map();
  for (const { anchorKey, anchorX, anchorY, moveCost } of candidates) {
    const terrain = !hasTerrain ? null : (unit.airborne ? NO_TERRAIN_BONUS : terrainModsAt(unit, anchorX, anchorY));
    const aura = auraModsAt(unit, anchorX, anchorY);
    squares.set(anchorKey, {
      anchorX,
      anchorY,
      moveCost,
      free: landable.has(anchorKey) && !footprintOccupiedIn(occupied, dims, anchorX, anchorY),
      terrain,
      terrainSig: terrainSignature(terrain),
      elevation: elevationAt(planner, anchorX, anchorY, dims),
      aura: aura.fields,
      auraSig: aura.sig,
      cover: terrain ? terrain.eva + terrain.def + terrain.res : 0,
      hazard: terrainMatters ? hazardAt(unit, anchorX, anchorY) : 0,
      threats: threatRects.length ? exposureAt(dims, threatRects, anchorX, anchorY) : null
    });
    yield;
  }
  return squares;
}

/**
 * What a square's terrain contributes to the measurement key: squares with the same bonus share one measurement. An
 * airborne unit always has the zero bonus, so all of its squares share one key.
 */
function terrainSignature(terrain) {
  return terrain ? `${terrain.eva},${terrain.def},${terrain.res}` : '';
}

/* -------------------------------------------- */
/*  Heal planning                               */
/* -------------------------------------------- */
/**
 * The best heal this turn: every Heal-role item, every wounded friendly, every free square it reaches them from.
 * Stepped work, yielding after each item and ally pairing has tried every square.
 */
function* planHealSteps(search, healItems) {
  const { planner, unit, graph, start } = search;
  const healWeight = search.risk.healWeight;
  if (healWeight <= 0) return null;
  const allies = woundedFriendlies(planner, unit);
  if (allies.length === 0) return null;

  let best = null;
  for (const item of healItems) {
    const range = item.range;
    if (!range) continue;
    const amount = healAmountOf(item);
    const losRule = itemSightRule(item);

    for (const ally of allies) {
      if (!hurtEnoughFor(ally, item)) continue;
      const maxHp = ally.hpMax;
      const currentHp = ally.hp;
      const fraction = currentHp / maxHp;
      if (!canTarget(unit, item, ally)) continue;

      const baseValue = healValue({
        missingHp: maxHp - currentHp,
        amount,
        targetMaxHp: maxHp,
        critical: fraction <= AI_CRITICAL_FRACTION,
        healWeight,
        scoreScale: SCORE_SCALE,
        criticalBonus: CRITICAL_HEAL_BONUS
      });
      if (baseValue <= 0) continue;

      const heightLimit = healHeightLimit(planner, unit, ally, range, losRule);
      best = bestHealAnchor(search, { item, ally, range, losRule, heightLimit, baseValue }, best);
      yield;
    }
  }
  if (!best) return null;
  return {
    kind: 'ability',
    unit,
    target: best.ally,
    item: best.item,
    distance: best.distance,
    destination: { x: best.anchorX, y: best.anchorY },
    needsMove: best.anchorX !== start.x || best.anchorY !== start.y,
    moveCost: best.moveCost,
    score: { total: best.total, heal: best.heal },
    position: {
      cover: best.cover,
      hazard: best.hazard,
      exposure: best.exposure,
      flank: false
    },
    graph
  };
}

/** The best square to heal one ally with one item from, against the best found so far. */
function bestHealAnchor(search, heal, best) {
  const { unit, risk } = search;
  const { item, ally, baseValue } = heal;
  let winner = best;
  for (const anchor of search.squares.values()) {
    if (!anchor.free) continue;
    const distance = healEngagement(unit, anchor, heal);
    if (distance === null) continue;
    const exposure = anchor.threats ? anchor.threats.size : 0;
    const positional = positionalValue({
      cover: anchor.cover, hazard: anchor.hazard, exposure, flank: false, moveCost: anchor.moveCost
    }, risk, unit);
    const total = baseValue + positional;
    if (winner
        && total <= winner.total + SCORE_EPSILON
        && !(Math.abs(total - winner.total) <= SCORE_EPSILON && anchor.moveCost < winner.moveCost)) continue;
    winner = {
      item, ally, distance, total, exposure, heal: baseValue,
      anchorX: anchor.anchorX, anchorY: anchor.anchorY,
      moveCost: anchor.moveCost, cover: anchor.cover, hazard: anchor.hazard
    };
  }
  return winner;
}

/**
 * Every living, unhidden friendly character, this unit included, for a heal to check against its own threshold. An
 * allied illusion is left out, since it has no life to save.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit looking for someone to heal.
 * @returns {import('./types.mjs').PlannerUnit[]}
 */
export function woundedFriendlies(planner, unit) {
  return board(planner).units.filter(candidate => {
    if (candidate.hidden) return false;
    if (!candidate.isCharacter) return false;
    if (!isAlive(candidate)) return false;
    if (candidate.tokenUuid === unit.tokenUuid) return true;
    if (isLure(candidate)) return false;
    return areFriendly(unit.factionRole, candidate.factionRole);
  });
}

/**
 * How far up or down a heal from the ground can reach this ally, or null when height does not limit the heal. As in
 * the system's activation check, the limit holds for a range-1 Single-target item used from the ground under the
 * normal line-of-sight rule.
 */
function healHeightLimit(planner, unit, ally, range, losRule) {
  if (range.maxRange !== 1 || unit.airborne === true || !isNormalSightRule(losRule)) return null;
  return {
    height: elevationAt(planner, ally.x, ally.y, { width: ally.width, height: ally.height }),
    reach: systemMeleeElevationReach()
  };
}

/**
 * Whether a heal could reach an ally from this square, and at what distance, counted in straight grid steps, so a
 * Square range's diagonal reach is not checked. Sight follows the item's rule, and the ground must be in `heightLimit`.
 */
function healEngagement(unit, anchor, { ally, range, losRule, heightLimit }) {
  if (ally.tokenUuid === unit.tokenUuid) return range.minRange <= 0 ? 0 : null;
  if (heightLimit && Math.abs(anchor.elevation - heightLimit.height) > heightLimit.reach) return null;
  const dims = { width: unit.width, height: unit.height };
  const distance = standingDistance(anchor.anchorX, anchor.anchorY, dims, ally);
  if (distance < range.minRange || distance > range.maxRange) return null;
  if (sightBlocked(unit, anchor.anchorX, anchor.anchorY, ally, losRule)) return null;
  return distance;
}

/* -------------------------------------------- */
/*  Approach                                    */
/* -------------------------------------------- */
/** The movement cost from every square to a goal, by cell key, from a movement search run backward from the goal. */
function approachField(unit, goalX, goalY) {
  const maxCost = Math.max(PURSUIT_HORIZON_SQUARES, unit.movement * PURSUIT_HORIZON_TURNS);
  const field = movementField(unit.tokenUuid, {
    nextTurn: true, maxCost, start: { x: goalX, y: goalY }, teleports: true, attackReach: false, reverse: true
  });
  return field?.graph?.routeByCell ?? null;
}

/** Close on a target whose attack squares are all taken, heading for the cheapest one, not the target. */
function planApproach(search, blockedCandidates) {
  const { unit, squares, graph, start } = search;
  let approachTarget = null;
  for (const candidate of blockedCandidates) {
    if (!approachTarget
        || candidate.distance < approachTarget.distance
        || (candidate.distance === approachTarget.distance
            && candidate.target.tokenId.localeCompare(approachTarget.target.tokenId) < 0)) {
      approachTarget = candidate;
    }
  }
  if (!approachTarget) return null;

  const target = approachTarget.target;
  const dims = { width: unit.width, height: unit.height };
  let goal = null;
  for (const candidate of blockedCandidates) {
    if (candidate.target.tokenUuid !== target.tokenUuid) continue;
    if (!goal || candidate.moveCost < goal.moveCost) goal = candidate;
  }
  const toGoal = goal ? approachField(unit, goal.anchorX, goal.anchorY) : null;
  const standing = toGoal?.[cellKey(start.x, start.y)];
  const routed = Number.isFinite(standing);

  let best = null;
  for (const anchor of squares.values()) {
    if (!anchor.free) continue;
    const distance = standingDistance(anchor.anchorX, anchor.anchorY, dims, target);
    if (routed) {
      const remaining = toGoal[cellKey(anchor.anchorX, anchor.anchorY)];
      if (!Number.isFinite(remaining) || remaining >= standing) continue;
      if (!best || remaining < best.remaining
          || (remaining === best.remaining && anchor.moveCost < best.moveCost)) {
        best = { anchorX: anchor.anchorX, anchorY: anchor.anchorY, moveCost: anchor.moveCost, distance, remaining };
      }
      continue;
    }
    if (!best || distance < best.distance
        || (distance === best.distance && anchor.moveCost < best.moveCost)) {
      best = { anchorX: anchor.anchorX, anchorY: anchor.anchorY, moveCost: anchor.moveCost, distance };
    }
  }
  if (!best) return null;
  if (best.anchorX === start.x && best.anchorY === start.y) return null;

  return {
    kind: 'approach',
    unit,
    target,
    weapon: null,
    distance: best.distance,
    destination: { x: best.anchorX, y: best.anchorY },
    needsMove: true,
    moveCost: best.moveCost,
    score: null,
    graph
  };
}
