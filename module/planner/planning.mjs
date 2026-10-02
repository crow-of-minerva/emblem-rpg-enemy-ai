/** @layer planner */
import {
  AI_CRITICAL_FRACTION,
  CRITICAL_HEAL_BONUS,
  PURSUIT_HORIZON_SQUARES,
  PURSUIT_HORIZON_TURNS,
  SCORE_EPSILON,
  SCORE_SCALE
} from '../constants.mjs';
import { movementField } from '../foundry/system-bridge.mjs';
import { board } from './board.mjs';
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
} from './geometry.mjs';
import { isAlive } from './readiness.mjs';
import {
  areFriendly,
  canAct,
  canActivate,
  canEverAct,
  canTarget,
  isLure,
  loadout,
  targetTiers,
  targetableTokens,
  tauntorOf,
  usableWeapons
} from './roster.mjs';
import { measureGroupSteps, positionalValue } from './scoring.mjs';
import { drain } from './steps.mjs';
import { healAmountOf, healItemsOf, healThresholdOf, healValue } from './support.mjs';
import { cellKey, footprintOccupiedIn, parseCellKey, standingDistance } from './vocabulary.mjs';

/* -------------------------------------------- */
/*  The turn                                    */
/* -------------------------------------------- */
/**
 * Decide what this unit does with its action: an attack, a heal, an approach, or null for nothing. `driver/turn.mjs`
 * carries out the plan this returns, and `ui/threat-intent.mjs` runs the same planning through `planTurnSteps`.
 * This version runs in one go, so the host client's page is unresponsive until the plan is done.
 */
export function planTurn(planner, unit, risk, options = {}) {
  return drain(planTurnSteps(planner, unit, risk, options));
}

/**
 * `planTurn` as stepped work, yielding between the squares, engagements and matchups it prices. The decision is the
 * same one either way: the drivers drain it in place, and `ui/threat-intent.mjs` takes it a few steps per frame.
 */
export function* planTurnSteps(planner, unit, risk, {
  ignoreTurnState = false, ignoreReadiness = false, stationary = false,
  seizeBlocker = null, seizeUnlock = 0, moveBudget = null
} = {}) {
  if (!risk) throw new TypeError('planTurn: a risk profile is required.');
  const ready = ignoreReadiness
    ? isAlive(unit)
    : (ignoreTurnState ? canEverAct(unit) : canAct(unit));
  if (!ready) return null;
  const riskProfile = risk;

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
  const startX = unit.x;
  const startY = unit.y;
  const freeAnchors = yield* anchorPropertiesSteps(planner, unit, graph, anchors, riskProfile, moveBudget);

  const { candidates, blockedCandidates } = yield* engagementCandidatesSteps(
    unit, canAttack ? targets : [], weapons, freeAnchors
  );

  let attackPlan = null;
  if (candidates.length > 0) {
    attackPlan = yield* bestAttackPlanSteps(
      unit, candidates, riskProfile, startX, startY, graph, blocker, seizeUnlock
    );
  } else if (blockedCandidates.length > 0) {
    attackPlan = planApproach(unit, blockedCandidates, freeAnchors, graph, startX, startY);
  }

  if (attackPlan?.kind !== 'attack' && deferred.length > 0 && canAttack) {
    const { candidates: sneakCandidates } = yield* engagementCandidatesSteps(unit, deferred, weapons, freeAnchors);
    if (sneakCandidates.length > 0) {
      const sneakPlan = yield* bestAttackPlanSteps(unit, sneakCandidates, riskProfile, startX, startY, graph);
      if (sneakPlan) attackPlan = sneakPlan;
    }
  }

  const healPlan = canHeal
    ? yield* planHealSteps(planner, unit, riskProfile, healItems, freeAnchors, startX, startY, graph)
    : null;
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
 * Every weapon, square and target this unit could engage from, split by whether the square is free to stand on.
 * Stepped work, yielding after each square's sight and reach checks.
 */
function* engagementCandidatesSteps(unit, targets, weapons, freeAnchors) {
  const candidates = [];
  const blockedCandidates = [];
  if (targets.length === 0) return { candidates, blockedCandidates };
  for (const weapon of weapons) {
    const range = weapon.range;
    if (!range) continue;
    const allowed = targets.filter(target => canTarget(unit, weapon, target));
    if (allowed.length === 0) continue;
    for (const anchor of freeAnchors.values()) {
      for (const target of allowed) {
        const distance = engagementIsPossible(unit, anchor.anchorX, anchor.anchorY, target, range);
        if (distance === null) continue;
        const candidate = {
          weapon,
          anchorX: anchor.anchorX,
          anchorY: anchor.anchorY,
          target,
          targetToken: target,
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
 * whose steps are the matchups measureGroupSteps in `scoring.mjs` measures.
 */
function* bestAttackPlanSteps(
  unit, candidates, riskProfile, startX, startY, graph, blocker = null, unlock = 0
) {
  const byWeapon = new Map();
  for (const candidate of candidates) {
    if (!byWeapon.has(candidate.weapon.id)) byWeapon.set(candidate.weapon.id, []);
    byWeapon.get(candidate.weapon.id).push(candidate);
  }
  let best = null;
  for (const group of byWeapon.values()) {
    best = yield* measureGroupSteps(group, unit, group[0].weapon, riskProfile, best, blocker, unlock);
  }
  if (!best) return null;
  return {
    kind: 'attack',
    unit,
    target: best.target,
    targetToken: best.target,
    weapon: best.weapon,
    distance: best.distance,
    destination: { x: best.anchorX, y: best.anchorY },
    needsMove: best.anchorX !== startX || best.anchorY !== startY,
    moveCost: best.moveCost,
    score: best.score,
    cData: best.cData,
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

/**
 * Every reachable square with the ground, the exposure and the cost the planner prices a candidate by. Stepped
 * work, yielding after each square's ground, aura and exposure are read.
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
  const freeAnchors = new Map();
  for (const { anchorKey, anchorX, anchorY, moveCost } of candidates) {
    const terrain = terrainMatters ? terrainModsAt(unit, anchorX, anchorY) : null;
    const aura = auraModsAt(unit, anchorX, anchorY);
    freeAnchors.set(anchorKey, {
      anchorX,
      anchorY,
      moveCost,
      free: landable.has(anchorKey) && !footprintOccupiedIn(occupied, dims, anchorX, anchorY),
      terrain,
      terrainSig: terrainSignature(terrain, hasTerrain, anchorX, anchorY),
      elevation: elevationAt(planner, anchorX, anchorY, dims),
      aura: aura.fields,
      auraSig: aura.sig,
      cover: terrain ? terrain.eva + terrain.def + terrain.res : 0,
      hazard: terrainMatters ? hazardAt(unit, anchorX, anchorY) : 0,
      threats: threatRects.length ? exposureAt(dims, threatRects, anchorX, anchorY) : null
    });
    yield;
  }
  return freeAnchors;
}

/**
 * What a square's terrain contributes to the measurement key. The planner passes no terrain for an airborne unit, so
 * the system reads the square's terrain itself when measuring, and each such square gets its own key. The live rules
 * give an airborne unit no terrain bonus, so those measurements overrate it.
 */
function terrainSignature(terrain, hasTerrain, anchorX, anchorY) {
  if (terrain) return `${terrain.eva},${terrain.def},${terrain.res}`;
  return hasTerrain ? `@${anchorX},${anchorY}` : '';
}

/* -------------------------------------------- */
/*  Heal planning                               */
/* -------------------------------------------- */
/**
 * The best heal this turn: every Heal-role item, every wounded friendly, every free square it reaches them from.
 * Stepped work, yielding after each item and ally pairing has tried every square.
 */
function* planHealSteps(planner, unit, riskProfile, healItems, freeAnchors, startX, startY, graph) {
  const healWeight = riskProfile.healWeight;
  if (healWeight <= 0) return null;
  const allies = woundedFriendlies(planner, unit);
  if (allies.length === 0) return null;

  let best = null;
  for (const item of healItems) {
    const range = item.range;
    if (!range) continue;
    const threshold = healThresholdOf(item);
    const amount = healAmountOf(item);
    const losRule = item.losRule ?? 'normal';

    for (const ally of allies) {
      const maxHp = Number(ally.hpMax) || 0;
      if (maxHp <= 0) continue;
      const currentHp = Number(ally.hp) || 0;
      const fraction = currentHp / maxHp;
      if (fraction >= threshold) continue;
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

      best = bestHealAnchor(unit, { item, ally, range, losRule, baseValue }, riskProfile, freeAnchors, best);
      yield;
    }
  }
  if (!best) return null;
  return {
    kind: 'ability',
    unit,
    target: best.ally,
    targetToken: best.ally,
    item: best.item,
    distance: best.distance,
    destination: { x: best.anchorX, y: best.anchorY },
    needsMove: best.anchorX !== startX || best.anchorY !== startY,
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
function bestHealAnchor(unit, { item, ally, range, losRule, baseValue }, riskProfile, freeAnchors, best) {
  let winner = best;
  for (const anchor of freeAnchors.values()) {
    if (!anchor.free) continue;
    const distance = healEngagement(unit, anchor.anchorX, anchor.anchorY, ally, range, losRule);
    if (distance === null) continue;
    const exposure = anchor.threats ? anchor.threats.size : 0;
    const positional = positionalValue({
      cover: anchor.cover, hazard: anchor.hazard, exposure, flank: false, moveCost: anchor.moveCost
    }, riskProfile, unit);
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
 * Every living, unhidden friendly character, this unit included, for callers to check against a heal item's
 * threshold. An allied illusion is left out, since it has no life to save.
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
 * Whether a heal could reach an ally from this square, by the item's line-of-sight rule, and at what distance. Range
 * is counted in straight grid steps; a Square range's diagonal reach and the height limit on range-1 items are not
 * checked.
 */
function healEngagement(unit, anchorX, anchorY, ally, range, losRule = 'normal') {
  if (ally.tokenUuid === unit.tokenUuid) return range.minRange <= 0 ? 0 : null;
  const dims = { width: unit.width, height: unit.height };
  const distance = standingDistance(anchorX, anchorY, dims, ally);
  if (distance < range.minRange || distance > range.maxRange) return null;
  if (sightBlocked(unit, anchorX, anchorY, ally, losRule)) return null;
  return distance;
}

/* -------------------------------------------- */
/*  Approach                                    */
/* -------------------------------------------- */
/** Remaining travel cost from every cell to a goal, as a reverse traversal field keyed by cell. */
function approachField(unit, goalX, goalY) {
  const movement = Number(unit.movement) || 0;
  const maxCost = Math.max(PURSUIT_HORIZON_SQUARES, movement * PURSUIT_HORIZON_TURNS);
  const field = movementField(unit.tokenUuid, {
    nextTurn: true, maxCost, start: { x: goalX, y: goalY }, teleports: true, attackReach: false, reverse: true
  });
  return field?.graph?.routeByCell ?? null;
}

/** Close on a target whose attack squares are all taken, heading for the cheapest one, not the target. */
function planApproach(unit, blockedCandidates, freeAnchors, graph, startX, startY) {
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
  const standing = toGoal?.[cellKey(startX, startY)];
  const routed = Number.isFinite(standing);

  let best = null;
  for (const anchor of freeAnchors.values()) {
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
  if (best.anchorX === startX && best.anchorY === startY) return null;

  return {
    kind: 'approach',
    unit,
    target,
    targetToken: target,
    weapon: null,
    distance: best.distance,
    destination: { x: best.anchorX, y: best.anchorY },
    needsMove: true,
    moveCost: best.moveCost,
    score: null,
    graph
  };
}
