/** @layer planner */
/*
 * Threat-aware routing for a unit heading for a goal over several turns, as Pursue and Seize do: the squares it could
 * strike a target from (its engagement ring), how many hostiles could strike each square, a movement search that
 * charges threatened squares extra, and where to stop this turn on the way. One plan's inputs travel together as a
 * route context (`RouteContext` in types.mjs), built by `routeContext`.
 */
import { movementField } from '../foundry/system-bridge.mjs';
import { board, unitByTokenUuid } from './board.mjs';
import {
  cellKey,
  footprintDistance,
  footprintOccupiedIn,
  parentPath,
  parseCellKey,
  standingDistance
} from './grid.mjs';
import { boardMemo } from './memo.mjs';
import { isAlive } from './readiness.mjs';
import { isEligibleUnit } from './roster.mjs';
import { engagementIsPossible, hostileReach, occupiedCells } from './squares.mjs';
import { areFriendly, isHostileTo } from './targeting.mjs';
import {
  ALLY_ROOM_PENALTY,
  ALLY_ROOM_RADIUS,
  ALLY_ROOM_UNMOVED_WEIGHT,
  PURSUIT_HORIZON_SQUARES,
  PURSUIT_HORIZON_TURNS,
  PURSUIT_SPREAD_PENALTY,
  PURSUIT_SPREAD_RADIUS,
  PURSUIT_STOP_SLACK,
  PURSUIT_STOP_THREAT,
  PURSUIT_TRANSIT_THREAT
} from './tuning.mjs';

/* -------------------------------------------- */
/*  Threat map ids                              */
/* -------------------------------------------- */
const threatIds = new WeakMap();
let threatSerial = 0;

/** An id for a threat map, assigned on first use, so searches over different threat maps get different cache keys. */
function threatId(threat) {
  let id = threatIds.get(threat);
  if (id === undefined) {
    threatSerial += 1;
    id = threatSerial;
    threatIds.set(threat, id);
  }
  return id;
}

/* -------------------------------------------- */
/*  Rings and threat                            */
/* -------------------------------------------- */
/**
 * Every square this unit could actually strike a target from, bounded to the box its reach could cover.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit that would strike.
 * @param {import('./types.mjs').PlannerUnit} target The unit it would strike.
 * @param {import('./types.mjs').PlannerWeapon[]} weapons The weapons it could use, each judged by its own range and
 *   line-of-sight rule.
 * @returns {Set<string>} The cell keys of the squares its top-left corner could stand on.
 */
export function engagementRing(planner, unit, target, weapons) {
  const ring = new Set();
  let maxRange = 0;
  for (const weapon of weapons) maxRange = Math.max(maxRange, weapon.range.maxRange);
  if (maxRange <= 0) return ring;

  const grid = board(planner);
  const loX = Math.max(0, target.x - unit.width + 1 - maxRange);
  const hiX = Math.min(grid.columns - unit.width, target.x + target.width - 1 + maxRange);
  const loY = Math.max(0, target.y - unit.height + 1 - maxRange);
  const hiY = Math.min(grid.rows - unit.height, target.y + target.height - 1 + maxRange);

  for (let x = loX; x <= hiX; x += 1) {
    for (let y = loY; y <= hiY; y += 1) {
      for (const weapon of weapons) {
        if (engagementIsPossible(unit, x, y, target, weapon) === null) continue;
        ring.add(cellKey(x, y));
        break;
      }
    }
  }
  return ring;
}

/**
 * Every square a hostile could strike, with how many could strike it (cached until the map changes and shared, so don't
 * modify it).
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit whose hostiles are counted.
 * @returns {Map<string, number>} How many hostiles could strike each square, by cell key.
 */
export function threatCells(planner, unit) {
  return boardMemo(`threat-cells|${unit.tokenUuid}`, () => buildThreatCells(planner, unit));
}

/**
 * The threat count per square, from the hostiles and ranges in squares.mjs's hostileReach, so a ground melee hostile
 * adds nothing where it could not touch an airborne unit.
 */
function buildThreatCells(planner, unit) {
  const cells = new Map();
  const grid = board(planner);
  for (const { hostile, ranges } of hostileReach(planner, unit)) {
    let maxRange = 0;
    for (const range of ranges) maxRange = Math.max(maxRange, range.maxRange);
    const loX = Math.max(0, hostile.x - maxRange);
    const hiX = Math.min(grid.columns - 1, hostile.x + hostile.width - 1 + maxRange);
    const loY = Math.max(0, hostile.y - maxRange);
    const hiY = Math.min(grid.rows - 1, hostile.y + hostile.height - 1 + maxRange);
    for (let x = loX; x <= hiX; x += 1) {
      for (let y = loY; y <= hiY; y += 1) {
        const distance = footprintDistance(x, y, 1, 1, hostile.x, hostile.y, hostile.width, hostile.height);
        if (!ranges.some(range => distance >= range.minRange && distance <= range.maxRange)) continue;
        const key = cellKey(x, y);
        cells.set(key, (cells.get(key) ?? 0) + 1);
      }
    }
  }
  return cells;
}

/** The highest threat count under a footprint, so a large unit is priced by its most dangerous square, not its size. */
function threatAt(threat, gx, gy, dims) {
  if (threat.size === 0) return 0;
  let worst = 0;
  for (let dx = 0; dx < dims.width; dx += 1) {
    for (let dy = 0; dy < dims.height; dy += 1) {
      const count = threat.get(cellKey(gx + dx, gy + dy)) ?? 0;
      if (count > worst) worst = count;
    }
  }
  return worst;
}

/**
 * The extra cost, by square, of entering a threatened square: its threat count times the unit's threat weight. The
 * system's search charges a footprint the worst value under it, so a large unit pays for its most dangerous square.
 */
function threatPenalties(threat, risk) {
  const weight = PURSUIT_TRANSIT_THREAT * risk.counterWeight;
  const penalties = {};
  for (const [key, count] of threat) {
    const value = count * weight;
    if (value > 0) penalties[key] = value;
  }
  return penalties;
}

/* -------------------------------------------- */
/*  Threat-aware movement search                */
/* -------------------------------------------- */
/**
 * Everything one plan routes with: the unit's threat map and its movement search from where it stands. Each piece is
 * cached until the map changes and shared, so don't modify them.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit moving.
 * @param {import('./types.mjs').RiskProfile} risk The weights it plans with.
 * @param {object} [options]
 * @param {number|null} [options.budget] The most movement it may spend this turn; null for all it has.
 * @param {Iterable<import('./types.mjs').PlannerUnit>|null} [options.ignoreUnits] Units every search of the plan
 *   treats as absent.
 * @returns {import('./types.mjs').RouteContext}
 */
export function routeContext(planner, unit, risk, { budget = null, ignoreUnits = null } = {}) {
  const search = { planner, unit, risk, threat: threatCells(planner, unit), ignoreUnits };
  return { ...search, budget, field: routeField(search) };
}

/**
 * A movement search over the whole map, with threatened squares charged extra to cross (cached until the map changes
 * and shared, so don't modify it).
 * @param {Omit<import('./types.mjs').RouteContext, 'field'|'budget'>} route Who moves, through what threat.
 * @param {object} [options]
 * @param {{x: number, y: number}|null} [options.start] The square to search from instead of the one it stands on.
 * @param {Iterable<import('./types.mjs').PlannerUnit>|null} [options.ignoreUnits] Units the search treats as absent,
 *   in place of the route's own.
 * @returns {import('./types.mjs').MovementGraph|null} Null when the system can't measure the unit.
 */
export function routeField(route, { start = null, ignoreUnits = route.ignoreUnits } = {}) {
  const { unit, threat, risk } = route;
  const from = start ? cellKey(start.x, start.y) : '-';
  const weight = risk.counterWeight;
  return boardMemo(`field|${unit.tokenUuid}|${from}|${ignoredKey(ignoreUnits)}|${weight}|${threatId(threat)}`,
    () => buildRouteField(route, { start, ignoreUnits }));
}

/**
 * The same search run backward from a goal, so each square's route is what walking from it to the goal costs (cached
 * until the map changes and shared). Teleports and steps between floors work one way only, which a plain search out
 * from the goal would get wrong.
 * @param {Omit<import('./types.mjs').RouteContext, 'field'|'budget'>} route Who moves, through what threat.
 * @param {{x: number, y: number}} goal The square to reach.
 * @param {Iterable<import('./types.mjs').PlannerUnit>|null} [ignoreUnits] Units the search treats as absent, in place
 *   of the route's own.
 * @returns {import('./types.mjs').MovementGraph|null} Null when the system can't measure the unit.
 */
export function routeFieldTo(route, goal, ignoreUnits = route.ignoreUnits) {
  const { unit, threat, risk } = route;
  const to = cellKey(goal.x, goal.y);
  const weight = risk.counterWeight;
  return boardMemo(`field-to|${unit.tokenUuid}|${to}|${ignoredKey(ignoreUnits)}|${weight}|${threatId(threat)}`,
    () => buildRouteField(route, { start: { x: goal.x, y: goal.y }, ignoreUnits, reverse: true }));
}

/** The cache-key part for the units a search treats as absent: their sorted token UUIDs, or '-' for none. */
function ignoredKey(ignoreUnits) {
  return ignoreUnits ? [...ignoreUnits].map(other => other.tokenUuid).sort().join(',') : '-';
}

/**
 * The search itself, out to a movement cost of max(40, 10 × movement); beyond that Pursue walks straight at the nearest
 * hostile and Seize does nothing. Each square's cost is that of the route that best avoids threat, not the cheapest.
 * @param {Omit<import('./types.mjs').RouteContext, 'field'|'budget'>} route Who moves, through what threat.
 * @param {object} options
 * @param {{x: number, y: number}|null} options.start The square to search from; null for the one it stands on.
 * @param {Iterable<import('./types.mjs').PlannerUnit>|null} options.ignoreUnits Units the search treats as absent.
 * @param {boolean} [options.reverse] Whether to search backward, from `start` as the goal.
 * @returns {import('./types.mjs').MovementGraph|null} Null when the system can't measure the unit.
 */
function buildRouteField(route, { start, ignoreUnits, reverse = false }) {
  const { unit, threat, risk } = route;
  const options = {
    nextTurn: true,
    maxCost: Math.max(PURSUIT_HORIZON_SQUARES, unit.movement * PURSUIT_HORIZON_TURNS),
    start,
    ignoreTokenIds: ignoreUnits ? [...ignoreUnits].map(other => other.tokenId) : [],
    teleports: true,
    attackReach: false
  };
  if (reverse) options.reverse = true;
  if (threat.size > 0) options.cellPenalties = threatPenalties(threat, risk);
  return movementField(unit.tokenUuid, options)?.graph ?? null;
}

/* -------------------------------------------- */
/*  Crowding                                    */
/* -------------------------------------------- */
/**
 * Which friendly units are currently chasing something, and what, out of this Scene's pursuit memory.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit whose allies are listed; it is left out.
 * @returns {Array<{unit: import('./types.mjs').PlannerUnit, targetUuid: string}>}
 */
export function pursuingAllies(planner, unit) {
  const allies = [];
  for (const [tokenUuid, targetUuid] of planner.pursuitTargets) {
    if (tokenUuid === unit.tokenUuid) continue;
    const other = unitByTokenUuid(tokenUuid);
    if (!other || !isAlive(other)) continue;
    if (isHostileTo(unit.factionRole, other.factionRole)) continue;
    allies.push({ unit: other, targetUuid });
  }
  return allies;
}

/**
 * How much standing here would crowd allies chasing the same target, falling off with distance.
 * @param {import('./types.mjs').PlannerUnit} unit The unit standing.
 * @param {number} gx The square's column.
 * @param {number} gy The square's row.
 * @param {import('./types.mjs').PlannerUnit[]} allyUnits The allies chasing the same target.
 * @returns {number} The cost, in squares of route.
 */
export function spreadPenalty(unit, gx, gy, allyUnits) {
  if (!allyUnits.length) return 0;
  const dims = { width: unit.width, height: unit.height };
  let penalty = 0;
  for (const ally of allyUnits) {
    const distance = standingDistance(gx, gy, dims, ally);
    if (distance >= PURSUIT_SPREAD_RADIUS) continue;
    penalty += PURSUIT_SPREAD_PENALTY * ((PURSUIT_SPREAD_RADIUS - distance) / PURSUIT_SPREAD_RADIUS);
  }
  return penalty;
}

/** The living allies a unit should leave room for (cached until the map changes and shared, so don't modify it). */
function roomAllies(planner, unit) {
  return boardMemo(`room-allies|${unit.tokenUuid}`, () => board(planner).units.filter(candidate => {
    if (candidate.tokenUuid === unit.tokenUuid) return false;
    if (!isEligibleUnit(candidate)) return false;
    return areFriendly(unit.factionRole, candidate.factionRole);
  }));
}

/** How much standing here would crowd the rest of the phase, owed most to the allies that have not moved yet. */
function allyRoomPenalty(unit, gx, gy, dims, allies) {
  if (!allies.length) return 0;
  let penalty = 0;
  for (const ally of allies) {
    const distance = standingDistance(gx, gy, dims, ally);
    if (distance >= ALLY_ROOM_RADIUS) continue;
    const weight = ally.turn?.turnComplete === true ? 1 : ALLY_ROOM_UNMOVED_WEIGHT;
    penalty += ALLY_ROOM_PENALTY * weight * ((ALLY_ROOM_RADIUS - distance) / ALLY_ROOM_RADIUS);
  }
  return penalty;
}

/**
 * The cells this unit can't stand on, less any in `freeCells`, so a plan can treat a pending ally as already moved.
 * @param {import('./types.mjs').PlannerUnit} unit The unit moving.
 * @param {Set<string>|null} [freeCells] Cell keys to treat as free.
 * @returns {Set<string>} The cell keys it can't stand on.
 */
export function blockedCells(unit, freeCells = null) {
  const occupied = occupiedCells(unit);
  if (!freeCells?.size) return occupied;
  const blocked = new Set();
  for (const key of occupied) {
    if (!freeCells.has(key)) blocked.add(key);
  }
  return blocked;
}

/* -------------------------------------------- */
/*  Where to stop this turn                     */
/* -------------------------------------------- */
/**
 * The squares a unit may still walk this turn: none once its move is spent, otherwise its movement, capped by the
 * budget its condition sets.
 * @param {import('./types.mjs').PlannerUnit} unit The unit moving.
 * @param {number|null} budget The most movement its condition lets it spend; null for all it has.
 * @returns {number}
 */
export function turnMovementCap(unit, budget) {
  const allowance = unit.turn?.movementAvailable === false ? 0 : unit.movement;
  return budget === null ? allowance : Math.min(budget, allowance);
}

/**
 * Every square this turn can afford that gets genuinely nearer the goal than the one already stood on. Affordable is
 * judged by the threat-avoiding route's cost, so a square is left out when only a threatened route reaches it in time.
 */
function stopCandidates(unit, field, toGoal, cap, standing, freeCells) {
  const dims = { width: unit.width, height: unit.height };
  const occupied = blockedCells(unit, freeCells);
  const reachable = [];
  for (const [key, travel] of Object.entries(field?.costByCell ?? {})) {
    if (!Number.isFinite(travel) || travel > cap) continue;
    const { x, y } = parseCellKey(key);
    if (x === unit.x && y === unit.y) continue;
    const remaining = toGoal[key];
    if (!Number.isFinite(remaining) || remaining >= standing) continue;
    if (footprintOccupiedIn(occupied, dims, x, y)) continue;
    reachable.push({ x, y, travel, remaining });
  }
  return reachable;
}

/**
 * Where to stop this turn on the way to a goal it can't reach yet, within the route's budget. Squares close to the
 * best progress qualify, and among them the threat there and crowding decide.
 * @param {import('./types.mjs').RouteContext} route The plan's unit, threat, movement search and budget.
 * @param {import('./types.mjs').ChaseGoal} goal The square it heads for.
 * @param {object} [options]
 * @param {Record<string, number>|null} [options.toGoal] Each square's route cost to the goal, used in place of a
 *   search from the goal.
 * @param {Set<string>|null} [options.freeCells] Occupied squares to treat as free to stop on.
 * @returns {import('./types.mjs').RouteStop|null} Null when it has no movement or no square gets it nearer.
 */
export function routeStop(route, goal, { toGoal: toGoalOverride = null, freeCells = null } = {}) {
  const { planner, unit, field, threat, risk } = route;
  const dims = { width: unit.width, height: unit.height };
  const cap = turnMovementCap(unit, route.budget);
  if (cap <= 0) return null;
  if (!toGoalOverride && !Number.isFinite(field?.routeByCell?.[cellKey(goal.x, goal.y)] ?? Infinity)) return null;

  const toGoal = toGoalOverride ?? routeFieldTo(route, goal)?.routeByCell;
  if (!toGoal) return null;
  const standing = toGoal[cellKey(unit.x, unit.y)] ?? Infinity;
  const reachable = stopCandidates(unit, field, toGoal, cap, standing, freeCells);
  if (reachable.length === 0) return null;

  const stopWeight = PURSUIT_STOP_THREAT * risk.counterWeight;
  const allies = goal.target
    ? pursuingAllies(planner, unit).filter(entry => entry.targetUuid === goal.target.tokenUuid)
      .map(entry => entry.unit)
    : [];
  const room = roomAllies(planner, unit);
  let closest = Infinity;
  for (const candidate of reachable) closest = Math.min(closest, candidate.remaining);
  const ceiling = closest + PURSUIT_STOP_SLACK;

  let best = null;
  for (const candidate of reachable) {
    if (candidate.remaining > ceiling) continue;
    const { x, y, travel, remaining } = candidate;
    const atGoal = x === goal.x && y === goal.y;
    const value = atGoal ? 0 : (threatAt(threat, x, y, dims) * stopWeight)
      + spreadPenalty(unit, x, y, allies)
      + allyRoomPenalty(unit, x, y, dims, room);
    if (!best
        || value < best.value
        || (value === best.value && remaining < best.remaining)
        || (value === best.value && remaining === best.remaining && travel < best.travel)) {
      best = { x, y, travel, value, remaining };
    }
  }
  if (!best) return null;
  return { ...best, path: parentPath(field, best)?.slice(1) ?? [] };
}
