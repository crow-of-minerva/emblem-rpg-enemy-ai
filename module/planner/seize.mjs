/** @layer planner */
import {
  BREACH_PROTECTED_BIAS,
  BREACH_VULNERABLE_BIAS,
  SCORE_EPSILON,
  SEIZE_BLOCKADE_TURN_COST,
  SEIZE_BLOCKER_BONUS,
  SEIZE_BREACH_PROGRESS,
  SEIZE_DETOUR_DAMAGE_FRACTION,
  SEIZE_DETOUR_KILL_CHANCE,
  SEIZE_UNLOCK_TURNS
} from '../constants.mjs';
import { board, unitByTokenUuid } from './board.mjs';
import { elevationAt, engagementIsPossible, moveCostAt, occupiedCells, reachableAnchors } from './geometry.mjs';
import { boardMemo } from './memo.mjs';
import { riskProfileFor } from './profile.mjs';
import {
  engagementRing,
  fieldPath,
  pursuitField,
  pursuitFieldTo,
  pursuitStop,
  standableCells,
  threatCells
} from './pursuit.mjs';
import { isAlive } from './readiness.mjs';
import { areFriendly, canAct, canTarget, isHostileTo, pursuitRanges, usableWeapons } from './roster.mjs';
import { measure } from './scoring.mjs';
import { cellKey, footprintOccupiedIn, parseCellKey, unitCellKeys } from './vocabulary.mjs';

/* -------------------------------------------- */
/*  Defense Points                              */
/* -------------------------------------------- */
/** The map's Defense Points as grid cells, read off the terrain rather than off the objectives configuration. */
function defendPoints(planner) {
  const cells = [];
  for (const point of board(planner).terrain.defendPoints ?? []) {
    if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) cells.push({ x: point.x, y: point.y });
  }
  return cells;
}

/** Units whose footprint covers any of these cells, or null for none. */
function tokensOnCells(planner, cells) {
  if (!cells.length) return null;
  const keys = new Set(cells.map(cell => cellKey(cell.x, cell.y)));
  const found = new Set();
  for (const candidate of board(planner).units) {
    if (unitCellKeys(candidate).some(key => keys.has(key))) found.add(candidate);
  }
  return found.size ? found : null;
}

/** Whether this unit is already holding a Defense Point. */
function standsOnDefendPoint(planner, unit) {
  const points = defendPoints(planner);
  if (!points.length) return false;
  const occupied = new Set(unitCellKeys(unit));
  return points.some(point => occupied.has(cellKey(point.x, point.y)));
}

/* -------------------------------------------- */
/*  Obstruction                                 */
/* -------------------------------------------- */
/**
 * Whether one unit can move through another, by the pathfinder's own rule, so the answer agrees with the graph.
 *
 * This copies the pass-through half of `resolveMovementOccupancy` in the system's `game/movement/pathfinding.mjs`.
 * `movement.getField` applies that rule only to the one unit it paths, and the API has no per-pair query, so
 * `blockingTokens`, which must name the unit in the way to weigh forcing a blockade against a detour, asks this copy.
 * Whether the other unit takes its square at all is the system's own answer, the board's `occupiesLanding`: a Convoy,
 * a fixture Object, an unlocked Door and a felled wall take none, so they are walked through. Anything else but a wall,
 * a locked Door included, is passed when one of the two is aloft and the other isn't, or when they are friendly by the
 * system's `character.factions.friendly`, so an unknown faction blocks.
 */
function canTokensPassThrough(unit, other) {
  if (unit.passing === true) return true;
  if (other.passable === true) return true;
  if (other.occupiesLanding === false) return true;
  if (other.destructible === true) {
    if (other.destroyed === true) return true;
    if (other.blocksFlyers === true) return false;
    return unit.airborne === true;
  }
  if ((unit.airborne === true) !== (other.airborne === true)) return true;
  return areFriendly(unit.factionRole, other.factionRole);
}

/**
 * Units and walls that would stop this unit and could be removed: living Characters and walls that can be broken. A
 * destroyed wall or a dead unit doesn't block. A hidden wall does, but it can't be struck, and a locked Door can't be
 * attacked at all, so each is left to the pathfinder as part of the map rather than listed as a blocker to force.
 */
function blockingTokens(planner, unit) {
  const blockers = [];
  for (const other of board(planner).units) {
    if (other.tokenUuid === unit.tokenUuid) continue;
    if (other.destructible === true) {
      if (!breachable(other)) continue;
    } else if (other.isCharacter !== true || !isAlive(other)) continue;
    if (canTokensPassThrough(unit, other)) continue;
    blockers.push(other);
  }
  return blockers;
}

/** Blockers that friendly Seize units have already committed to removing, out of this Scene's seize memory. */
function committedBlockers(planner, unit) {
  const uuids = new Set();
  for (const [tokenUuid, blockerUuid] of planner.seizeBlockers) {
    if (tokenUuid === unit.tokenUuid) continue;
    const other = unitByTokenUuid(tokenUuid);
    if (!other || !isAlive(other)) continue;
    if (isHostileTo(unit.factionRole, other.factionRole)) continue;
    uuids.add(blockerUuid);
  }
  return uuids;
}

/** Whether this unit shares a square with another, which denies it an action. */
function sharesSquare(planner, unit) {
  return boardMemo(`shares|${unit.tokenId}`, () => {
    const mine = new Set(unitCellKeys(unit));
    return board(planner).units.some(other => other.tokenUuid !== unit.tokenUuid
      && unitCellKeys(other).some(key => mine.has(key)));
  });
}

/* -------------------------------------------- */
/*  Breaching                                   */
/* -------------------------------------------- */
/**
 * Whether a wall can be broken: standing, and not hidden. The system treats a hidden Destructible as absent to every
 * rule but movement, so nothing may strike it until it is revealed.
 */
function breachable(blocker) {
  return blocker?.destructible === true && blocker.destroyed !== true && blocker.hidden !== true;
}
/**
 * The damage type to breach with, or null. Types the wall is immune to are skipped, and a weapon that rolls its
 * type per blow is used only when the wall is immune to none of its types.
 */
function breachDamageType(wall, weapon, cData) {
  const types = cData.validDamageTypes ?? [];
  if (types.length === 0) return null;
  const immunities = cData.defenderImmunities ?? [];
  const allowed = types.filter(type => !immunities.includes(type));
  if (allowed.length === 0) return null;
  if (weapon.randomizeDamageType === true && allowed.length !== types.length) return null;
  const chosen = cData.damageType ?? '';
  return allowed.includes(chosen) ? chosen : allowed[0];
}

/**
 * The measurement to breach with: the system's own pick, unless the wall is immune to or resists that type.
 * `standing` is the square the blow is struck from, or the unit's own square when it is omitted.
 */
function breachMeasurement(unit, wall, weapon, distance, standing = null) {
  const base = measure(unit, wall, weapon, distance, null, { standing });
  if (!base) return null;
  const dmgType = breachDamageType(wall, weapon, base);
  if (!dmgType) return null;
  if (dmgType === base.damageType && base.breakResisted !== true) return base;

  const immunities = base.defenderImmunities ?? [];
  let unresisted = null;
  let first = null;
  for (const type of base.validDamageTypes ?? []) {
    if (immunities.includes(type)) continue;
    const cData = type === base.damageType ? base : measure(unit, wall, weapon, distance, type, { standing });
    if (!cData) continue;
    if (cData.breakVulnerable === true) return cData;
    if (!unresisted && cData.breakResisted !== true) unresisted = cData;
    first ??= cData;
  }
  return unresisted ?? first;
}

/**
 * What one turn of attacks with a weapon does to a wall. A wall loses integrity only through break damage, so the
 * option is valued by its expected break per turn.
 */
function breachOption(unit, blocker, weapon, distance, standing = null) {
  const cData = breachMeasurement(unit, blocker, weapon, distance, standing);
  if (!cData) return null;

  const brk = Math.max(0, Number(cData.breakDamage) || 0);
  if (brk <= 0) return null;
  const attacks = Math.max(1, Number(cData.attackCount) || 1);
  const hitChance = Math.max(0, Math.min(100, Number(cData.hitChance) || 0)) / 100;
  const perTurn = hitChance * brk * attacks;
  if (perTurn <= 0) return null;

  const vulnerable = cData.breakVulnerable === true;
  const resisted = cData.breakResisted === true;
  const bias = vulnerable ? BREACH_VULNERABLE_BIAS : (resisted ? BREACH_PROTECTED_BIAS : 1);
  return { weapon, distance, dmgType: cData.damageType, cData, perTurn, vulnerable, resisted, value: perTurn * bias };
}

/**
 * Every way this unit could break a wall, best first (cached per board). With no square chosen yet, each weapon is
 * asked at its closest usable range from the square the unit stands on.
 */
function breachOptions(unit, blocker) {
  return boardMemo(`breach|${unit.tokenId}|${blocker.tokenId ?? '-'}`, () => buildBreachOptions(unit, blocker));
}

/** The rough answer `blockadeBeatsDetour` and `planBlockadeApproach` need before a Seize unit commits to a route. */
function buildBreachOptions(unit, blocker) {
  if (!breachable(blocker)) return [];
  const weapons = usableWeapons(unit);
  if (weapons.length === 0) return [];

  const options = [];
  for (const weapon of weapons) {
    const range = weapon.range;
    if (!range) continue;
    if (!canTarget(unit, weapon, blocker)) continue;
    const option = breachOption(unit, blocker, weapon, range.minRange);
    if (option) options.push({ ...option, range });
  }
  options.sort((a, b) => (b.value - a.value) || a.weapon.id.localeCompare(b.weapon.id));
  return options;
}

/**
 * Every square this unit could attack the wall from, best weapon option first. A stronger blow is worth a few extra
 * steps, so value comes before move cost.
 */
function breachAnchors(planner, unit, blocker, { stationary = false, moveBudget = null } = {}) {
  if (!breachable(blocker)) return [];
  const weapons = usableWeapons(unit);
  if (weapons.length === 0) return [];

  const { graph, anchors } = reachableAnchors(unit, { stationary });
  const dims = { width: unit.width, height: unit.height };
  const occupied = occupiedCells(unit);
  const squares = [];
  for (const key of anchors) {
    const { x, y } = parseCellKey(key);
    const moveCost = moveCostAt(graph, x, y);
    if (!Number.isFinite(moveCost)) continue;
    if (moveBudget !== null && moveCost > moveBudget) continue;
    if (footprintOccupiedIn(occupied, dims, x, y)) continue;
    squares.push({ x, y, moveCost, elevation: elevationAt(planner, x, y, dims) });
  }
  if (squares.length === 0) return [];
  return breachAnchorOptions(unit, blocker, weapons, squares, graph);
}

/**
 * Price each weapon once per distance and elevation, measured from the first square with both, and reuse that price
 * for every square that shares them. Elevation decides whether a blow from a square counts as melee, which can change
 * the damage types a weapon allows.
 */
function breachAnchorOptions(unit, blocker, weapons, squares, graph) {
  const priced = new Map();
  const options = [];
  for (const weapon of weapons) {
    const range = weapon.range;
    if (!range) continue;
    if (!canTarget(unit, weapon, blocker)) continue;
    for (const square of squares) {
      const distance = engagementIsPossible(unit, square.x, square.y, blocker, range);
      if (distance === null) continue;
      const key = `${weapon.id}|${distance}|${square.elevation}`;
      if (!priced.has(key)) {
        priced.set(key, breachOption(unit, blocker, weapon, distance, { x: square.x, y: square.y }));
      }
      const option = priced.get(key);
      if (!option) continue;
      options.push({ ...option, range, graph, anchorX: square.x, anchorY: square.y, moveCost: square.moveCost });
    }
  }
  options.sort((a, b) => {
    const value = b.value - a.value;
    if (Math.abs(value) > SCORE_EPSILON) return value;
    return (a.moveCost - b.moveCost) || a.weapon.id.localeCompare(b.weapon.id);
  });
  return options;
}

/** Swing at the wall from wherever swinging at it is worth the most, priced on the ordinary attack scale. */
export function planBreachStrike(planner, unit, blocker, unlock = 0, { stationary = false, moveBudget = null } = {}) {
  if (!unit || !blocker || blocker.destroyed === true) return null;
  if (!canAct(unit)) return null;
  if (sharesSquare(planner, unit)) return null;

  const best = breachAnchors(planner, unit, blocker, { stationary, moveBudget })[0];
  if (!best) return null;

  const integrity = Math.max(1, Number(blocker.stance) || 0);
  const breachScore = (SEIZE_BLOCKER_BONUS * unlock)
    + (SEIZE_BREACH_PROGRESS * Math.min(1, best.perTurn / integrity));

  return {
    kind: 'attack',
    breach: true,
    breachScore,
    unit,
    target: blocker,
    targetToken: blocker,
    weapon: best.weapon,
    dmgType: best.dmgType,
    distance: best.distance,
    destination: { x: best.anchorX, y: best.anchorY },
    needsMove: best.anchorX !== unit.x || best.anchorY !== unit.y,
    moveCost: best.moveCost,
    cData: best.cData,
    graph: best.graph
  };
}

/* -------------------------------------------- */
/*  Blockades                                   */
/* -------------------------------------------- */
/** Every blocker a route runs into, in the order it meets them. */
function blockersOnPath(unit, field, goal, blockers) {
  const cells = new Map();
  for (const blocker of blockers) {
    for (const key of unitCellKeys(blocker)) cells.set(key, blocker);
  }
  const found = [];
  const seen = new Set();
  for (const [px, py] of fieldPath(field, goal.x, goal.y)) {
    for (let dx = 0; dx < unit.width; dx += 1) {
      for (let dy = 0; dy < unit.height; dy += 1) {
        const hit = cells.get(cellKey(px + dx, py + dy));
        if (!hit || seen.has(hit.tokenId)) continue;
        seen.add(hit.tokenId);
        found.push(hit);
      }
    }
  }
  return found;
}

/** Who is in the way, and how much removing them is worth as a fraction of a whole turn's advance. */
function analyseSeizeBlockage(planner, unit, points, threat, risk, holders, standingRoute) {
  const blockers = blockingTokens(planner, unit);
  if (blockers.length === 0) return null;

  const ignore = new Set(blockers);
  if (holders) for (const holder of holders) ignore.add(holder);
  const openField = pursuitField(planner, unit, threat, risk, null, ignore);

  let openGoal = null;
  for (const point of points) {
    const route = openField?.routeByCell?.[cellKey(point.x, point.y)];
    if (!Number.isFinite(route)) continue;
    if (!openGoal || route < openGoal.route) openGoal = { x: point.x, y: point.y, route };
  }
  if (!openGoal) return null;
  if (openGoal.route >= standingRoute) return null;

  const onPath = blockersOnPath(unit, openField, openGoal, blockers);
  if (onPath.length === 0) return null;

  const committed = committedBlockers(planner, unit);
  const candidates = [
    ...onPath.filter(blocker => committed.has(blocker.tokenUuid)),
    ...onPath.filter(blocker => !committed.has(blocker.tokenUuid))
  ];
  const movement = Math.max(1, Number(unit.movement) || 0);
  const unlock = standingRoute === Infinity
    ? 1
    : Math.min(1, (standingRoute - openGoal.route) / (movement * SEIZE_UNLOCK_TURNS));
  return { candidates, unlock, openField, openGoal, ignore };
}

/** Whether forcing the blockade beats walking round it, with both priced in squares. */
function blockadeBeatsDetour(unit, blockage, standingRoute) {
  const blocker = blockage.candidates[0];
  if (!blocker) return false;

  let turns = SEIZE_BLOCKADE_TURN_COST;
  if (blocker.destructible === true) {
    const best = breachOptions(unit, blocker)[0];
    if (!best) return false;
    const integrity = Math.max(1, Number(blocker.stance) || 0);
    turns = Math.ceil(integrity / best.perTurn);
  }
  const movement = Math.max(1, Number(unit.movement) || 0);
  return blockage.openGoal.route + (turns * movement) < standingRoute;
}

/** Get into position on whoever is holding the doorway, backing off to a firing position where that is the way. */
function planBlockadeApproach(planner, unit, blockage, field, threat, risk, budget, holders) {
  const startKey = cellKey(unit.x, unit.y);
  for (const blocker of blockage.candidates) {
    const ranges = blocker.destructible === true
      ? breachOptions(unit, blocker).map(option => option.range)
      : pursuitRanges(unit);
    const commit = plan => {
      planner.seizeBlockers.set(unit.tokenUuid, blocker.tokenUuid);
      return { ...plan, blocker, unlock: blockage.unlock };
    };

    if (ranges.length > 0) {
      const ring = engagementRing(planner, unit, blocker, ranges);
      if (ring.has(startKey)) return commit({ kind: 'hold' });
      const goal = nearestRingGoal(field, ring);
      if (goal) {
        const stop = pursuitStop(planner, unit, field, goal, threat, risk, budget, holders);
        if (!stop) return commit({ kind: 'hold' });
        return commit({ kind: 'move', destination: { x: stop.x, y: stop.y }, graph: field, path: stop.path });
      }
    }

    const toBlocker = pursuitFieldTo(planner, unit, threat, risk, { x: blocker.x, y: blocker.y }, blockage.ignore);
    if (!toBlocker?.routeByCell) continue;
    const goal = { x: blocker.x, y: blocker.y, target: null };
    const stop = pursuitStop(planner, unit, field, goal, threat, risk, budget, holders, toBlocker.routeByCell);
    if (stop) return commit({ kind: 'move', destination: { x: stop.x, y: stop.y }, graph: field, path: stop.path });
  }
  return null;
}

/** The cheapest square of a ring the field can actually reach, as a goal with no target unit. */
function nearestRingGoal(field, ring) {
  let goal = null;
  for (const key of ring) {
    const route = field?.routeByCell?.[key];
    if (!Number.isFinite(route)) continue;
    if (goal && route >= goal.route) continue;
    const { x, y } = parseCellKey(key);
    goal = { x, y, route, target: null };
  }
  return goal;
}

/* -------------------------------------------- */
/*  Seize                                       */
/* -------------------------------------------- */
/** A move that ends this turn on a Defense Point, or null. A capture beats anything else the unit could do. */
function planSeizeCapture(unit, points, field, budget, freeCells = null) {
  const allowance = unit.turn?.movementAvailable === false ? 0 : (Number(unit.movement) || 0);
  const cap = budget === null ? allowance : Math.min(budget, allowance);
  if (cap <= 0) return null;

  const occupied = standableCells(unit, freeCells);
  const dims = { width: unit.width, height: unit.height };
  let best = null;
  for (const point of points) {
    const cost = moveCostAt(field, point.x, point.y);
    if (!Number.isFinite(cost) || cost > cap) continue;
    if (footprintOccupiedIn(occupied, dims, point.x, point.y)) continue;
    if (!best || cost < best.cost) best = { x: point.x, y: point.y, cost };
  }
  if (!best) return null;
  return {
    kind: 'move',
    capture: true,
    destination: { x: best.x, y: best.y },
    graph: field,
    path: fieldPath(field, best.x, best.y).slice(1),
    remaining: 0
  };
}

/**
 * Drive for the nearest Defense Point: arrive if possible, force the doorway if it pays, otherwise close in.
 * `driver/turn.mjs` runs it for a Seize directive, and `planner/phase-roster.mjs` runs it to decide whether a unit
 * should wait for an ally.
 */
export function planSeize(planner, unit, { budget = null, riskProfile = null, freeCells = null } = {}) {
  const points = defendPoints(planner);
  if (!points.length) return null;
  if (standsOnDefendPoint(planner, unit)) return { kind: 'hold', capture: true, remaining: 0 };

  const risk = riskProfile ?? riskProfileFor(planner, unit);
  const threat = threatCells(planner, unit);
  const holders = tokensOnCells(planner, points);
  const field = pursuitField(planner, unit, threat, risk, null, holders);

  const capture = planSeizeCapture(unit, points, field, budget, freeCells);
  if (capture) return capture;

  let goal = null;
  for (const point of points) {
    const route = field?.routeByCell?.[cellKey(point.x, point.y)];
    if (!Number.isFinite(route)) continue;
    if (!goal || route < goal.route) goal = { x: point.x, y: point.y, route, target: null };
  }

  const standingRoute = goal ? goal.route : Infinity;
  const blockage = analyseSeizeBlockage(planner, unit, points, threat, risk, holders, standingRoute);
  if (blockage && blockadeBeatsDetour(unit, blockage, standingRoute)) {
    const forced = planBlockadeApproach(planner, unit, blockage, field, threat, risk, budget, holders);
    if (forced) return forced;
  }
  if (!goal) return null;

  const stop = pursuitStop(planner, unit, field, goal, threat, risk, budget, holders, null, freeCells);
  if (!stop) return { kind: 'hold', remaining: goal.route };
  return {
    kind: 'move',
    destination: { x: stop.x, y: stop.y },
    graph: field,
    path: stop.path,
    remaining: stop.remaining
  };
}

/**
 * Whether an action is worth a Seize unit pausing its advance for. The Defense Point is what it was sent for, so only
 * a heal, a breach, a blow at a blocker, a stance break, a likely kill or heavy damage qualifies.
 */
export function seizeDetourIsWorthy(plan) {
  if (!plan) return false;
  if (plan.kind === 'ability' || plan.breach === true) return true;
  if (plan.kind !== 'attack') return false;
  const scored = plan.score;
  if (scored.blocking || scored.breaksTarget) return true;
  if (scored.killChance >= SEIZE_DETOUR_KILL_CHANCE) return true;
  return scored.dealtFraction >= SEIZE_DETOUR_DAMAGE_FRACTION;
}
