/** @layer planner */
/*
 * Seize: heading for the nearest Defense Point, finding what blocks the route, and when breaking through a wall or a
 * unit beats walking round. It also decides which actions are worth a Seize unit pausing its advance for.
 */
import { canPass } from '../foundry/system-bridge.mjs';
import { board, unitByTokenUuid } from './board.mjs';
import { cellKey, footprintOccupiedIn, parentPath, parseCellKey, unitCellKeys } from './grid.mjs';
import { canTarget, usableWeapons } from './loadout.mjs';
import { boardMemo } from './memo.mjs';
import { riskProfileFor } from './profile.mjs';
import { isAlive } from './readiness.mjs';
import { canAct } from './roster.mjs';
import {
  blockedCells,
  engagementRing,
  routeContext,
  routeField,
  routeFieldTo,
  routeStop,
  turnMovementCap
} from './routing.mjs';
import { measure } from './scoring.mjs';
import { elevationAt, engagementIsPossible, moveCostAt, occupiedCells, reachableAnchors } from './squares.mjs';
import { isHostileTo } from './targeting.mjs';
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
} from './tuning.mjs';

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
 * Units and walls that would stop this unit and could be removed: living Characters and walls that can be broken. A
 * hidden wall or a locked Door still blocks but can't be struck, so it is left to the pathfinder as part of the map.
 */
function blockingTokens(planner, unit) {
  const blockers = [];
  for (const other of board(planner).units) {
    if (other.tokenUuid === unit.tokenUuid) continue;
    if (other.destructible === true) {
      if (!breachable(other)) continue;
    } else if (other.isCharacter !== true || !isAlive(other)) continue;
    if (passesThrough(unit, other)) continue;
    blockers.push(other);
  }
  return blockers;
}

/** Whether one unit may move through another, by the system's own pathfinding rule, asked once per pair per map. */
function passesThrough(unit, other) {
  return boardMemo(`passes|${unit.tokenUuid}|${other.tokenUuid}`,
    () => canPass(unit.tokenUuid, other.tokenUuid)?.canPass === true);
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

/**
 * Whether any other unit's footprint overlaps this one's. Standing on a unit that takes up the square denies an
 * action; this check also counts units that don't, such as a Chest or an unlocked Door.
 */
function sharesSquare(planner, unit) {
  return boardMemo(`shares|${unit.tokenUuid}`, () => {
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
function breachDamageType(wall, weapon, matchup) {
  const types = matchup.validDamageTypes ?? [];
  if (types.length === 0) return null;
  const immunities = matchup.defenderImmunities ?? [];
  const allowed = types.filter(type => !immunities.includes(type));
  if (allowed.length === 0) return null;
  if (weapon.randomizeDamageType === true && allowed.length !== types.length) return null;
  const chosen = matchup.damageType ?? '';
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
    const matchup = type === base.damageType ? base : measure(unit, wall, weapon, distance, type, { standing });
    if (!matchup) continue;
    if (matchup.breakVulnerable === true) return matchup;
    if (!unresisted && matchup.breakResisted !== true) unresisted = matchup;
    first ??= matchup;
  }
  return unresisted ?? first;
}

/**
 * What one turn of attacks with a weapon does to a wall. A wall loses integrity only through break damage, so the
 * option is valued by its expected break per turn.
 */
function breachOption(unit, blocker, weapon, distance, standing = null) {
  const matchup = breachMeasurement(unit, blocker, weapon, distance, standing);
  if (!matchup) return null;

  const brk = Math.max(0, Number(matchup.breakDamage) || 0);
  if (brk <= 0) return null;
  const attacks = Math.max(1, Number(matchup.attackCount) || 1);
  const hitChance = Math.max(0, Math.min(100, Number(matchup.hitChance) || 0)) / 100;
  const perTurn = hitChance * brk * attacks;
  if (perTurn <= 0) return null;

  const vulnerable = matchup.breakVulnerable === true;
  const resisted = matchup.breakResisted === true;
  const bias = vulnerable ? BREACH_VULNERABLE_BIAS : (resisted ? BREACH_PROTECTED_BIAS : 1);
  return {
    weapon, distance, dmgType: matchup.damageType, matchup, perTurn, vulnerable, resisted, value: perTurn * bias
  };
}

/**
 * Every way this unit could break a wall, best first (cached until the map changes). With no square chosen yet, each
 * weapon is asked at its closest usable range from the square the unit stands on.
 */
function breachOptions(unit, blocker) {
  return boardMemo(`breach|${unit.tokenUuid}|${blocker.tokenUuid ?? '-'}`, () => buildBreachOptions(unit, blocker));
}

/** Each weapon's breach option from where the unit stands, best first: a rough answer before it commits to a route. */
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
    if (option) options.push(option);
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
    if (!weapon.range) continue;
    if (!canTarget(unit, weapon, blocker)) continue;
    for (const square of squares) {
      const distance = engagementIsPossible(unit, square.x, square.y, blocker, weapon);
      if (distance === null) continue;
      const key = `${weapon.id}|${distance}|${square.elevation}`;
      if (!priced.has(key)) {
        priced.set(key, breachOption(unit, blocker, weapon, distance, { x: square.x, y: square.y }));
      }
      const option = priced.get(key);
      if (!option) continue;
      options.push({ ...option, graph, anchorX: square.x, anchorY: square.y, moveCost: square.moveCost });
    }
  }
  options.sort((a, b) => {
    const value = b.value - a.value;
    if (Math.abs(value) > SCORE_EPSILON) return value;
    return (a.moveCost - b.moveCost) || a.weapon.id.localeCompare(b.weapon.id);
  });
  return options;
}

/**
 * Swing at the wall from wherever swinging at it is worth the most, priced on the ordinary attack scale.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The Seize unit.
 * @param {import('./types.mjs').PlannerUnit} blocker The Destructible wall in its way.
 * @param {number} [unlock] How much breaking the wall shortens the route, from 0 to 1 of a turn's advance.
 * @param {object} [options]
 * @param {boolean} [options.stationary] Strike from the square the unit stands on, without moving.
 * @param {number|null} [options.moveBudget] The most movement it may spend; null for all it has.
 * @returns {import('./types.mjs').AttackPlan|null} A breach plan, or null when the unit can't act or reach the wall.
 */
export function planBreachStrike(planner, unit, blocker, unlock = 0, { stationary = false, moveBudget = null } = {}) {
  if (!unit || !blocker || blocker.destroyed === true) return null;
  if (!canAct(unit)) return null;
  if (sharesSquare(planner, unit)) return null;

  const best = breachAnchors(planner, unit, blocker, { stationary, moveBudget })[0];
  if (!best) return null;

  const integrity = Math.max(1, blocker.stance);
  const breachScore = (SEIZE_BLOCKER_BONUS * unlock)
    + (SEIZE_BREACH_PROGRESS * Math.min(1, best.perTurn / integrity));

  return {
    kind: 'attack',
    breach: true,
    breachScore,
    unit,
    target: blocker,
    weapon: best.weapon,
    dmgType: best.dmgType,
    distance: best.distance,
    destination: { x: best.anchorX, y: best.anchorY },
    needsMove: best.anchorX !== unit.x || best.anchorY !== unit.y,
    moveCost: best.moveCost,
    matchup: best.matchup,
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
  for (const [px, py] of parentPath(field, goal) ?? []) {
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

/**
 * Who is in the way, and how much removing them is worth as a fraction of a whole turn's advance. The open route is
 * searched with the blockers gone as well as the units holding the Defense Points, which every Seize search leaves out.
 */
function analyseSeizeBlockage(route, points, standingRoute) {
  const { planner, unit, ignoreUnits: holders } = route;
  const blockers = blockingTokens(planner, unit);
  if (blockers.length === 0) return null;

  const ignore = new Set(blockers);
  if (holders) for (const holder of holders) ignore.add(holder);
  const openField = routeField(route, { ignoreUnits: ignore });

  let openGoal = null;
  for (const point of points) {
    const cost = openField?.routeByCell?.[cellKey(point.x, point.y)];
    if (!Number.isFinite(cost)) continue;
    if (!openGoal || cost < openGoal.route) openGoal = { x: point.x, y: point.y, route: cost };
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
  const movement = Math.max(1, unit.movement);
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
    const integrity = Math.max(1, blocker.stance);
    turns = Math.ceil(integrity / best.perTurn);
  }
  const movement = Math.max(1, unit.movement);
  return blockage.openGoal.route + (turns * movement) < standingRoute;
}

/**
 * Move into attack range of the unit or wall blocking the route, or hold if already there. The plan carries the chosen
 * `blocker`; the driver records it in the Scene's `seizeBlockers` memory when the unit takes its turn.
 */
function planBlockadeApproach(route, blockage) {
  const { planner, unit, field } = route;
  const startKey = cellKey(unit.x, unit.y);
  for (const blocker of blockage.candidates) {
    const weapons = blocker.destructible === true
      ? breachOptions(unit, blocker).map(option => option.weapon)
      : usableWeapons(unit);
    const commit = plan => ({ ...plan, blocker, unlock: blockage.unlock });

    if (weapons.length > 0) {
      const ring = engagementRing(planner, unit, blocker, weapons);
      if (ring.has(startKey)) return commit({ kind: 'hold' });
      const goal = nearestRingGoal(field, ring);
      if (goal) {
        const stop = routeStop(route, goal);
        if (!stop) return commit({ kind: 'hold' });
        return commit({ kind: 'move', destination: { x: stop.x, y: stop.y }, graph: field, path: stop.path });
      }
    }

    const toBlocker = routeFieldTo(route, { x: blocker.x, y: blocker.y }, blockage.ignore);
    if (!toBlocker?.routeByCell) continue;
    const goal = { x: blocker.x, y: blocker.y, target: null };
    const stop = routeStop(route, goal, { toGoal: toBlocker.routeByCell });
    if (stop) return commit({ kind: 'move', destination: { x: stop.x, y: stop.y }, graph: field, path: stop.path });
  }
  return null;
}

/** The cheapest square of a ring the unit's route search (`field.routeByCell`) reaches, as a goal with no target. */
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
/**
 * A move that ends this turn on a Defense Point, or null; a capture beats anything else the unit could do. The cost
 * checked is the threat-avoiding route's, so a point reachable this turn only through threat is not taken.
 */
function planSeizeCapture(route, points, freeCells = null) {
  const { unit, field } = route;
  const cap = turnMovementCap(unit, route.budget);
  if (cap <= 0) return null;

  const occupied = blockedCells(unit, freeCells);
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
    path: parentPath(field, best)?.slice(1) ?? [],
    remaining: 0
  };
}

/**
 * Head for the nearest Defense Point: arrive if possible, break through a blocker if that beats walking round,
 * otherwise close in. Null, and the unit does nothing, when no route to a Defense Point lies within the search range.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The Seize unit.
 * @param {object} [options]
 * @param {number|null} [options.budget] The most movement it may spend; null for all it has.
 * @param {import('./types.mjs').RiskProfile|null} [options.riskProfile] The weights it plans with; its own
 *   profile's when null.
 * @param {Set<string>|null} [options.freeCells] Occupied cell keys to treat as free to stop on.
 * @returns {import('./types.mjs').MovePlan|import('./types.mjs').HoldPlan|null}
 */
export function planSeize(planner, unit, { budget = null, riskProfile = null, freeCells = null } = {}) {
  const points = defendPoints(planner);
  if (!points.length) return null;
  if (standsOnDefendPoint(planner, unit)) return { kind: 'hold', capture: true, remaining: 0 };

  const risk = riskProfile ?? riskProfileFor(planner, unit);
  const holders = tokensOnCells(planner, points);
  const route = routeContext(planner, unit, risk, { budget, ignoreUnits: holders });
  const field = route.field;

  const capture = planSeizeCapture(route, points, freeCells);
  if (capture) return capture;

  let goal = null;
  for (const point of points) {
    const cost = field?.routeByCell?.[cellKey(point.x, point.y)];
    if (!Number.isFinite(cost)) continue;
    if (!goal || cost < goal.route) goal = { x: point.x, y: point.y, route: cost, target: null };
  }

  const standingRoute = goal ? goal.route : Infinity;
  const blockage = analyseSeizeBlockage(route, points, standingRoute);
  if (blockage && blockadeBeatsDetour(unit, blockage, standingRoute)) {
    const forced = planBlockadeApproach(route, blockage);
    if (forced) return forced;
  }
  if (!goal) return null;

  const stop = routeStop(route, goal, { freeCells });
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
 * @param {import('./types.mjs').TurnPlan|null} plan The action the unit could take instead of advancing.
 * @returns {boolean}
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
