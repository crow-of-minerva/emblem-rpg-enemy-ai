/** @layer planner */
/*
 * Chasing a target across several turns. `planPursue` is the entry point, which `driver/turn.mjs` runs for a Pursue
 * directive or a taunt, and `planner/phase-roster.mjs` runs to decide whether a unit should wait for an ally.
 * `planner/seize.mjs` reuses the engagement rings, the threat map, the pursuit field and the stop search.
 */
import {
  ALLY_ROOM_PENALTY,
  ALLY_ROOM_RADIUS,
  ALLY_ROOM_UNMOVED_WEIGHT,
  FALL_EXPECTED_MULTIPLIER,
  LETHAL_RISK_MIN_CHANCE,
  PURSUIT_CROSSING_CANDIDATES,
  PURSUIT_CROSSING_MARGIN,
  PURSUIT_FALL_COST_SQUARES,
  PURSUIT_HORIZON_SQUARES,
  PURSUIT_HORIZON_TURNS,
  PURSUIT_SPREAD_PENALTY,
  PURSUIT_SPREAD_RADIUS,
  PURSUIT_STOP_SLACK,
  PURSUIT_STOP_THREAT,
  PURSUIT_SWITCH_MARGIN_TURNS,
  PURSUIT_TRANSIT_THREAT,
  SEVERE_FALL_FRACTION
} from '../constants.mjs';
import { airborneBeyondMelee, movementField } from '../foundry/system-bridge.mjs';
import { board, unitByTokenUuid } from './board.mjs';
import { engagementIsPossible, occupiedCells, reachableAnchors } from './geometry.mjs';
import { boardMemo } from './memo.mjs';
import { canAttemptCrossing, collectCrossings, movementOptions } from './movement.mjs';
import { riskProfileFor } from './profile.mjs';
import { isAlive, isIncapacitated } from './readiness.mjs';
import {
  collectTargets,
  hostileTokens,
  isEligibleUnit,
  isHostileTo,
  areFriendly,
  pursuableHostiles,
  pursuitRanges
} from './roster.mjs';
import { cellKey, footprintDistance, footprintOccupiedIn, parseCellKey, standingDistance } from './vocabulary.mjs';

/* -------------------------------------------- */
/*  Threat map identity                         */
/* -------------------------------------------- */
const threatIds = new WeakMap();
let threatSerial = 0;

/** An id for a threat map, assigned on first use, so fields over different threat maps get different memo keys. */
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
/** Every square this unit could actually strike a target from, bounded to the box its reach could cover. */
export function engagementRing(planner, unit, target, ranges) {
  const ring = new Set();
  let maxRange = 0;
  for (const range of ranges) maxRange = Math.max(maxRange, range.maxRange);
  if (maxRange <= 0) return ring;

  const grid = board(planner);
  const loX = Math.max(0, target.x - unit.width + 1 - maxRange);
  const hiX = Math.min(grid.columns - unit.width, target.x + target.width - 1 + maxRange);
  const loY = Math.max(0, target.y - unit.height + 1 - maxRange);
  const hiY = Math.min(grid.rows - unit.height, target.y + target.height - 1 + maxRange);

  for (let x = loX; x <= hiX; x += 1) {
    for (let y = loY; y <= hiY; y += 1) {
      for (const range of ranges) {
        if (engagementIsPossible(unit, x, y, target, range) === null) continue;
        ring.add(cellKey(x, y));
        break;
      }
    }
  }
  return ring;
}

/**
 * Every square a hostile could strike, with how many could strike it (cached per board and shared, so don't
 * modify it).
 */
export function threatCells(planner, unit) {
  return boardMemo(`threat-cells|${unit.tokenId}`, () => buildThreatCells(planner, unit));
}

/**
 * The threat count per square. A hostile's melee-only reach is dropped where the system's airborneBeyondMelee says
 * it cannot touch the pursuer: the pursuer in the air with its stance whole, the hostile on the ground, no Classic
 * flyer targeting, and a map that allows flight.
 */
function buildThreatCells(planner, unit) {
  const cells = new Map();
  const grid = board(planner);
  for (const hostile of hostileTokens(planner, unit)) {
    if (isIncapacitated(hostile)) continue;
    let ranges = pursuitRanges(hostile);
    const outOfMelee = airborneBeyondMelee({
      sourceAirborne: hostile.airborne === true,
      targetAirborne: unit.airborne === true,
      targetStanceBroken: unit.stanceBroken === true,
      classicFlyers: grid.classicFlyers === true,
      flightForbidden: grid.flightForbidden === true
    });
    if (outOfMelee) ranges = ranges.filter(range => range.maxRange > 1);
    if (ranges.length === 0) continue;

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

/** What entering each square costs this unit over and above the ground, charged by its footprint's worst square. */
function threatPenalties(planner, unit, threat, risk) {
  const dims = { width: unit.width, height: unit.height };
  const weight = PURSUIT_TRANSIT_THREAT * risk.counterWeight;
  const grid = board(planner);
  const origins = new Set();
  for (const key of threat.keys()) {
    const { x, y } = parseCellKey(key);
    for (let dx = 0; dx < dims.width; dx += 1) {
      for (let dy = 0; dy < dims.height; dy += 1) {
        const originX = x - dx;
        const originY = y - dy;
        if (originX < 0 || originY < 0 || originX >= grid.columns || originY >= grid.rows) continue;
        origins.add(cellKey(originX, originY));
      }
    }
  }
  const penalties = {};
  for (const key of origins) {
    const { x, y } = parseCellKey(key);
    const value = threatAt(threat, x, y, dims) * weight;
    if (value > 0) penalties[key] = value;
  }
  return penalties;
}

/* -------------------------------------------- */
/*  Pursuit field                               */
/* -------------------------------------------- */
/**
 * A traversal field over the whole map, with threatened squares charged extra to cross (cached per board and shared,
 * so don't modify it).
 */
export function pursuitField(planner, unit, threat, risk, start = null, ignoreUnits = null) {
  const from = start ? cellKey(start.x, start.y) : '-';
  const ignored = ignoreUnits ? [...ignoreUnits].map(other => other.tokenId).sort().join(',') : '-';
  const weight = risk.counterWeight;
  return boardMemo(`field|${unit.tokenId}|${from}|${ignored}|${weight}|${threatId(threat)}`,
    () => buildPursuitField(planner, unit, threat, risk, start, ignoreUnits));
}

/**
 * The same field searched backward from a goal, so each square's route is what walking from it to the goal costs.
 * The system's graph is directional, a teleport running pad to exit and a step between floors only where the crossing
 * allows it, so a field searched out from the goal would price the way back instead (cached per board and shared, so
 * don't modify it).
 */
export function pursuitFieldTo(planner, unit, threat, risk, goal, ignoreUnits = null) {
  const to = cellKey(goal.x, goal.y);
  const ignored = ignoreUnits ? [...ignoreUnits].map(other => other.tokenId).sort().join(',') : '-';
  const weight = risk.counterWeight;
  return boardMemo(`field-to|${unit.tokenId}|${to}|${ignored}|${weight}|${threatId(threat)}`,
    () => buildPursuitField(planner, unit, threat, risk, { x: goal.x, y: goal.y }, ignoreUnits, true));
}

/** The field itself, built far enough out that a chase can be planned across several turns. */
function buildPursuitField(planner, unit, threat, risk, start, ignoreUnits, reverse = false) {
  const movement = Number(unit.movement) || 0;
  const options = {
    nextTurn: true,
    maxCost: Math.max(PURSUIT_HORIZON_SQUARES, movement * PURSUIT_HORIZON_TURNS),
    start,
    ignoreTokenIds: ignoreUnits ? [...ignoreUnits].map(other => other.tokenId) : [],
    teleports: true,
    attackReach: false
  };
  if (reverse) options.reverse = true;
  if (threat.size > 0) options.cellPenalties = threatPenalties(planner, unit, threat, risk);
  return movementField(unit.tokenUuid, options)?.graph ?? null;
}

/* -------------------------------------------- */
/*  Crowding                                    */
/* -------------------------------------------- */
/** Which friendly units are currently chasing something, and what, out of this Scene's pursuit memory. */
function pursuingAllies(planner, unit) {
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

/** How much standing here would crowd allies chasing the same target, falling off with distance. */
function spreadPenalty(unit, gx, gy, allyUnits) {
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

/** The living allies a unit should leave room for (cached per board and shared, so don't modify it). */
function roomAllies(planner, unit) {
  return boardMemo(`room-allies|${unit.tokenId}`, () => board(planner).units.filter(candidate => {
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
 * The cells this unit can't stand on, less any in `freeCells`. Treating those as free lets `yieldsToPendingAlly` in
 * `planner/phase-roster.mjs` plan the turn as if a pending ally had already moved.
 */
export function standableCells(unit, freeCells = null) {
  const occupied = occupiedCells(unit);
  if (!freeCells?.size) return occupied;
  const open = new Set();
  for (const key of occupied) {
    if (!freeCells.has(key)) open.add(key);
  }
  return open;
}

/* -------------------------------------------- */
/*  Goals and stops                             */
/* -------------------------------------------- */
/**
 * Which target to chase, and which square of its engagement ring to head for. The target this unit is already
 * chasing is kept unless another is nearer by more than a turn's movement.
 */
function pursuitGoal(planner, unit, targets, ranges, field) {
  const routes = field?.routeByCell;
  if (!routes) return null;
  const allies = pursuingAllies(planner, unit);

  const options = [];
  for (const target of targets) {
    const ring = engagementRing(planner, unit, target, ranges);
    if (ring.size === 0) continue;
    const packed = allies.filter(entry => entry.targetUuid === target.tokenUuid).map(entry => entry.unit);
    let best = null;
    for (const key of ring) {
      const route = routes[key];
      if (!Number.isFinite(route)) continue;
      const { x, y } = parseCellKey(key);
      const value = route + spreadPenalty(unit, x, y, packed);
      if (!best || value < best.value || (value === best.value && route < best.route)) best = { x, y, route, value };
    }
    if (best) options.push({ target, ring, ...best });
  }
  if (options.length === 0) return null;
  options.sort((a, b) => (a.value - b.value) || a.target.tokenId.localeCompare(b.target.tokenId));

  const lockedUuid = planner.pursuitTargets.get(unit.tokenUuid);
  const locked = lockedUuid ? options.find(option => option.target.tokenUuid === lockedUuid) : null;
  if (!locked) return options[0];
  const margin = Math.max(1, Number(unit.movement) || 0) * PURSUIT_SWITCH_MARGIN_TURNS;
  return (options[0].value + margin < locked.value) ? options[0] : locked;
}

/** The route a traversal field took to a cell, rebuilt from its parent links, start first. */
export function fieldPath(field, goalX, goalY) {
  const parents = field?.parentByCell;
  if (!parents) return [[goalX, goalY]];

  const path = [[goalX, goalY]];
  let key = cellKey(goalX, goalY);
  let guard = 0;
  while (guard < 4000) {
    guard += 1;
    const parent = parents[key];
    if (typeof parent !== 'string') break;
    const { x, y } = parseCellKey(parent);
    path.push([x, y]);
    key = parent;
  }
  return path.reverse();
}

/** Every square this turn can afford that gets genuinely nearer the goal than the one already stood on. */
function pursuitStopCandidates(unit, field, toGoal, cap, standing, freeCells) {
  const dims = { width: unit.width, height: unit.height };
  const occupied = standableCells(unit, freeCells);
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
 * Where to stop this turn on the way to a goal it can't reach yet. Squares close to the best progress qualify, and
 * among them the threat there and crowding decide.
 */
export function pursuitStop(planner, unit, field, goal, threat, risk, budget, ignoreUnits = null,
  toGoalOverride = null, freeCells = null) {
  const dims = { width: unit.width, height: unit.height };
  const allowance = unit.turn?.movementAvailable === false ? 0 : (Number(unit.movement) || 0);
  const cap = budget === null ? allowance : Math.min(budget, allowance);
  if (cap <= 0) return null;
  if (!toGoalOverride && !Number.isFinite(field?.routeByCell?.[cellKey(goal.x, goal.y)] ?? Infinity)) return null;

  const toGoal = toGoalOverride
    ?? pursuitFieldTo(planner, unit, threat, risk, goal, ignoreUnits)?.routeByCell;
  if (!toGoal) return null;
  const standing = toGoal[cellKey(unit.x, unit.y)] ?? Infinity;
  const reachable = pursuitStopCandidates(unit, field, toGoal, cap, standing, freeCells);
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
  return { ...best, path: fieldPath(field, best.x, best.y).slice(1) };
}

/* -------------------------------------------- */
/*  Crossings and the blunt approach            */
/* -------------------------------------------- */
/** One candidate crossing priced in squares against the ground route: approach, the turn spent, landing, fall. */
function pursuitCrossingValue(planner, unit, option, goal, threat, risk, field, bounds) {
  const { crossing, anchorX, anchorY, landingX, landingY, moveCost } = option;
  const chance = Number(crossing.chance) || 0;
  if (chance <= 0 || chance < risk.minChance) return null;

  const descending = crossing.descending === true;
  const worstFall = descending ? Number(crossing.worstFallDamage) || 0 : 0;
  const severe = worstFall >= bounds.currentHp || worstFall >= bounds.maxHp * SEVERE_FALL_FRACTION;
  if (descending && severe && chance < LETHAL_RISK_MIN_CHANCE) return null;

  const landingField = pursuitField(planner, unit, threat, risk, { x: landingX, y: landingY });
  let landingToGoal = Infinity;
  for (const key of goal.ring) {
    const route = landingField?.routeByCell?.[key];
    if (Number.isFinite(route) && route < landingToGoal) landingToGoal = route;
  }
  if (!Number.isFinite(landingToGoal)) return null;

  const approach = field?.routeByCell?.[cellKey(anchorX, anchorY)];
  const odds = chance / 100;
  const fall = descending
    ? (1 - odds) * (Number(crossing.fallFraction) || 0) * FALL_EXPECTED_MULTIPLIER * PURSUIT_FALL_COST_SQUARES
      * risk.fallAversion
    : 0;
  const total = (Number.isFinite(approach) ? approach : moveCost)
    + (descending ? bounds.movement : bounds.movement / odds) + landingToGoal + fall;

  return {
    kind: 'crossing',
    total,
    skill: crossing.skillKey,
    chance,
    crossing: { ...crossing, destX: landingX, destY: landingY },
    destination: { x: anchorX, y: anchorY },
    needsMove: anchorX !== unit.x || anchorY !== unit.y,
    graph: bounds.graph,
    target: goal.target
  };
}

/**
 * The best climb or drop that is a real shortcut to the target, or null. Only weighed when walking there takes more
 * than one turn.
 */
function planPursuitCrossing(planner, unit, goal, threat, risk, field, groundRoute) {
  if (!canAttemptCrossing(planner, unit)) return null;
  const movement = Math.max(1, Number(unit.movement) || 0);
  if (groundRoute <= movement) return null;

  const { graph, anchors } = reachableAnchors(unit);
  const candidates = collectCrossings(unit, graph, anchors);
  if (candidates.length === 0) return null;

  const dims = { width: unit.width, height: unit.height };
  const shortlist = candidates
    .map(option => ({ option, lead: standingDistance(option.landingX, option.landingY, dims, goal.target) }))
    .sort((a, b) => (a.lead - b.lead) || (a.option.moveCost - b.option.moveCost))
    .slice(0, PURSUIT_CROSSING_CANDIDATES);

  const bounds = { maxHp: Number(unit.hpMax) || 1, currentHp: Number(unit.hp) || 0, movement, graph };
  let best = null;
  for (const { option } of shortlist) {
    const priced = pursuitCrossingValue(planner, unit, option, goal, threat, risk, field, bounds);
    if (!priced) continue;
    if (priced.total + PURSUIT_CROSSING_MARGIN >= groundRoute) continue;
    if (best && priced.total >= best.total) continue;
    best = priced;
  }
  return best;
}

/** The blunt fallback: close on the nearest hostile, refusing a square no closer than the one already held. */
function planPursueApproach(planner, unit, { budget = null } = {}) {
  const hostiles = pursuableHostiles(planner, unit);
  const { options, graph, hostileCount } = movementOptions(planner, unit, { budget, hostiles });
  if (hostileCount === 0 || options.length === 0) return null;

  const dims = { width: unit.width, height: unit.height };
  let standing = Infinity;
  for (const hostile of hostiles) {
    standing = Math.min(standing, standingDistance(unit.x, unit.y, dims, hostile));
  }

  let best = null;
  for (const option of options) {
    if (!best
        || option.nearestHostile < best.nearestHostile
        || (option.nearestHostile === best.nearestHostile && option.moveCost < best.moveCost)) {
      best = option;
    }
  }
  if (!best || best.nearestHostile >= standing) return null;
  return { kind: 'move', destination: { x: best.anchorX, y: best.anchorY }, graph };
}

/* -------------------------------------------- */
/*  Pursue                                      */
/* -------------------------------------------- */
/**
 * Chase the best target: by a crossing where that is really shorter, otherwise over the threat-aware field. A chase
 * that must leave the unit its action, as a walk before a take-off does, asks for no crossing (`crossings: false`).
 */
export function planPursue(planner, unit, { budget = null, freeCells = null, crossings = true } = {}) {
  const targets = collectTargets(planner, unit);
  if (targets.length === 0) return null;

  const ranges = pursuitRanges(unit);
  if (ranges.length === 0) return planPursueApproach(planner, unit, { budget });

  const risk = riskProfileFor(planner, unit);
  const threat = threatCells(planner, unit);
  const field = pursuitField(planner, unit, threat, risk);

  const goal = pursuitGoal(planner, unit, targets, ranges, field);
  if (!goal) return planPursueApproach(planner, unit, { budget });
  if (goal.route === 0) return null;

  const crossing = crossings ? planPursuitCrossing(planner, unit, goal, threat, risk, field, goal.route) : null;
  if (crossing) return crossing;

  const stop = pursuitStop(planner, unit, field, goal, threat, risk, budget, null, null, freeCells);
  if (!stop) return planPursueApproach(planner, unit, { budget });

  return {
    kind: 'move',
    destination: { x: stop.x, y: stop.y },
    graph: field,
    path: stop.path,
    remaining: stop.remaining,
    target: goal.target
  };
}
