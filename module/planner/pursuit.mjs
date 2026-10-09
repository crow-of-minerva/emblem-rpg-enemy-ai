/** @layer planner */
/*
 * Chasing a target across several turns, for a Pursue condition or a taunt, from `planPursue`: which target to chase
 * and where in reach of it to head, a climb or drop that is a real shortcut, and a blunt approach when no route is
 * found. The threat-aware routing it moves by is in routing.mjs.
 */
import { cellKey, parseCellKey, standingDistance } from './grid.mjs';
import { usableWeapons } from './loadout.mjs';
import { canAttemptCrossing, collectCrossings, crossingRisk, movementOptions } from './movement.mjs';
import { riskProfileFor } from './profile.mjs';
import { engagementRing, pursuingAllies, routeContext, routeField, routeStop, spreadPenalty } from './routing.mjs';
import { reachableAnchors } from './squares.mjs';
import { collectTargets, pursuableHostiles } from './targeting.mjs';
import {
  PURSUIT_CROSSING_CANDIDATES,
  PURSUIT_CROSSING_MARGIN,
  PURSUIT_FALL_COST_SQUARES,
  PURSUIT_SWITCH_MARGIN_TURNS
} from './tuning.mjs';

/* -------------------------------------------- */
/*  The goal                                    */
/* -------------------------------------------- */
/**
 * Which target to chase, and which square of its engagement ring to head for. The target this unit is already
 * chasing is kept unless another is nearer by more than a turn's movement.
 */
function pursuitGoal(route, targets, weapons) {
  const { planner, unit, field } = route;
  const routes = field?.routeByCell;
  if (!routes) return null;
  const allies = pursuingAllies(planner, unit);

  const options = [];
  for (const target of targets) {
    const ring = engagementRing(planner, unit, target, weapons);
    if (ring.size === 0) continue;
    const packed = allies.filter(entry => entry.targetUuid === target.tokenUuid).map(entry => entry.unit);
    let best = null;
    for (const key of ring) {
      const cost = routes[key];
      if (!Number.isFinite(cost)) continue;
      const { x, y } = parseCellKey(key);
      const value = cost + spreadPenalty(unit, x, y, packed);
      if (!best || value < best.value || (value === best.value && cost < best.route)) {
        best = { x, y, route: cost, value };
      }
    }
    if (best) options.push({ target, ring, ...best });
  }
  if (options.length === 0) return null;
  options.sort((a, b) => (a.value - b.value) || a.target.tokenId.localeCompare(b.target.tokenId));

  const lockedUuid = planner.pursuitTargets.get(unit.tokenUuid);
  const locked = lockedUuid ? options.find(option => option.target.tokenUuid === lockedUuid) : null;
  if (!locked) return options[0];
  const margin = Math.max(1, unit.movement) * PURSUIT_SWITCH_MARGIN_TURNS;
  return (options[0].value + margin < locked.value) ? options[0] : locked;
}

/* -------------------------------------------- */
/*  Crossings and the blunt approach            */
/* -------------------------------------------- */
/** One candidate crossing priced in squares against the ground route: approach, the turn spent, landing, fall. */
function pursuitCrossingValue(route, goal, option, bounds) {
  const { unit, field, risk } = route;
  const { crossing, anchorX, anchorY, landingX, landingY, moveCost } = option;
  const accepted = crossingRisk(crossing, unit, risk);
  if (!accepted) return null;

  const landingField = routeField(route, { start: { x: landingX, y: landingY } });
  let landingToGoal = Infinity;
  for (const key of goal.ring) {
    const fromLanding = landingField?.routeByCell?.[key];
    if (Number.isFinite(fromLanding) && fromLanding < landingToGoal) landingToGoal = fromLanding;
  }
  if (!Number.isFinite(landingToGoal)) return null;

  const approach = field?.routeByCell?.[cellKey(anchorX, anchorY)];
  const fall = accepted.expectedFallFraction * PURSUIT_FALL_COST_SQUARES * risk.fallAversion;
  const total = (Number.isFinite(approach) ? approach : moveCost)
    + (accepted.descending ? bounds.movement : bounds.movement / accepted.odds) + landingToGoal + fall;

  return {
    kind: 'crossing',
    total,
    skill: crossing.skillKey,
    chance: accepted.chance,
    crossing,
    origin: { x: anchorX, y: anchorY },
    needsMove: anchorX !== unit.x || anchorY !== unit.y,
    graph: bounds.graph,
    target: goal.target
  };
}

/**
 * The best climb or drop that is a real shortcut to the target, or null. Only weighed when walking to the goal takes
 * more than one turn, and only from a start square the unit can walk to within the route's budget.
 */
function planPursuitCrossing(route, goal) {
  const { planner, unit, budget } = route;
  if (!canAttemptCrossing(planner, unit)) return null;
  const movement = Math.max(1, unit.movement);
  const groundRoute = goal.route;
  if (groundRoute <= movement) return null;

  const { graph, anchors } = reachableAnchors(unit);
  const candidates = collectCrossings(unit, graph, anchors)
    .filter(option => budget === null || option.moveCost <= budget);
  if (candidates.length === 0) return null;

  const dims = { width: unit.width, height: unit.height };
  const shortlist = candidates
    .map(option => ({ option, lead: standingDistance(option.landingX, option.landingY, dims, goal.target) }))
    .sort((a, b) => (a.lead - b.lead) || (a.option.moveCost - b.option.moveCost))
    .slice(0, PURSUIT_CROSSING_CANDIDATES);

  const bounds = { movement, graph };
  let best = null;
  for (const { option } of shortlist) {
    const priced = pursuitCrossingValue(route, goal, option, bounds);
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
  const { options, graph, hostileCount, standing } = movementOptions(planner, unit, { budget, hostiles });
  if (hostileCount === 0 || options.length === 0) return null;

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
 * Chase the best target: by a crossing where that is really shorter, otherwise by the route that best avoids threat.
 * A chase that must leave the unit its action, as a walk before a take-off does, asks for no crossing.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit chasing.
 * @param {object} [options]
 * @param {number|null} [options.budget] The most movement it may spend, on every route including the walk to a climb
 *   or drop; null for all it has.
 * @param {Set<string>|null} [options.freeCells] Occupied cell keys to treat as free to stop on.
 * @param {boolean} [options.crossings] Whether a climb or drop may be planned.
 * @returns {import('./types.mjs').MovePlan|import('./types.mjs').CrossingPlan|null} Null when it has no target,
 *   already stands in reach of its goal, or can get no nearer.
 */
export function planPursue(planner, unit, { budget = null, freeCells = null, crossings = true } = {}) {
  const targets = collectTargets(planner, unit);
  if (targets.length === 0) return null;

  const weapons = usableWeapons(unit);
  if (weapons.length === 0) return planPursueApproach(planner, unit, { budget });

  const route = routeContext(planner, unit, riskProfileFor(planner, unit), { budget });
  const goal = pursuitGoal(route, targets, weapons);
  if (!goal) return planPursueApproach(planner, unit, { budget });
  if (goal.route === 0) return null;

  const crossing = crossings ? planPursuitCrossing(route, goal) : null;
  if (crossing) return crossing;

  const stop = routeStop(route, goal, { freeCells });
  if (!stop) return planPursueApproach(planner, unit, { budget });

  return {
    kind: 'move',
    destination: { x: stop.x, y: stop.y },
    graph: route.field,
    path: stop.path,
    remaining: stop.remaining,
    target: goal.target
  };
}
