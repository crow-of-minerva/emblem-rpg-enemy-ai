/** @layer planner */
/*
 * Movement plans that need no target: zone crossings (climbs and drops) and whether one is worth its fall risk, taking
 * off again after a stance break, and the Retreat and Free Roam moves.
 */
import { airborneBeyondMelee, crossingsOf, systemMeleeElevationReach } from '../foundry/system-bridge.mjs';
import { board } from './board.mjs';
import { cellKey, footprintOccupiedIn, parseCellKey, standingDistance } from './grid.mjs';
import { usableWeapons } from './loadout.mjs';
import { unpredictableRoll } from './profile.mjs';
import { measure, score } from './scoring.mjs';
import { elevationAt, moveCostAt, occupiedCells, reachableAnchors } from './squares.mjs';
import { collectTargets, hostileTokens } from './targeting.mjs';
import {
  CROSSING_TEMPO_PENALTY,
  CROSSING_VALUE_MARGIN,
  FALL_EXPECTED_MULTIPLIER,
  LETHAL_RISK_MIN_CHANCE,
  SCORE_SCALE,
  SEVERE_FALL_FRACTION
} from './tuning.mjs';

/* -------------------------------------------- */
/*  Crossings                                   */
/* -------------------------------------------- */
/** Whether this unit could climb or drop at all: not exploring, on foot, unmounted, with stance and an action. */
export function canAttemptCrossing(planner, unit) {
  if (board(planner).exploration === true) return false;
  if (unit.airborne === true) return false;
  if (unit.mounted === true) return false;
  if (unit.stance < 1) return false;
  return unit.turn?.actionAvailable === true;
}

/* -------------------------------------------- */
/*  Flight                                      */
/* -------------------------------------------- */
/**
 * Whether this unit should take to the air again: a stance break grounded it, and the system reports that the
 * flight action would lift it now, its stance recovered, its action unspent and the map open to flight.
 */
export function takesOffAgain(unit) {
  return unit?.groundedByStanceBreak === true && unit.canTakeOff === true;
}

/** The weapon this unit is holding, or the first it could swing when nothing is marked wielded. */
function wieldedWeapon(unit) {
  const weapons = usableWeapons(unit);
  return weapons.find(weapon => weapon.wielded === true) ?? weapons[0] ?? null;
}

/**
 * What the best attack after landing on a square would be worth next turn, with melee reach judged by the system's
 * flight and height rules from the landing square. With a shared `measured` map, each target and distance is measured
 * once, from the first square asked about, and reused for every other square.
 */
function crossingFutureValue(planner, unit, landingX, landingY, risk = null,
  { targets = null, measured = null } = {}) {
  const weapon = wieldedWeapon(unit);
  if (!weapon) return 0;
  const range = weapon.range;
  if (!range) return 0;

  const dims = { width: unit.width, height: unit.height };
  const movement = unit.movement;
  const landingElevation = elevationAt(planner, landingX, landingY, dims);
  const meleeOnly = range.maxRange <= 1 && unit.airborne !== true;
  const meleeReach = systemMeleeElevationReach();
  const grid = board(planner);

  let bestValue = 0;
  for (const target of targets ?? collectTargets(planner, unit)) {
    const distance = standingDistance(landingX, landingY, dims, target);
    if (distance > movement + range.maxRange) continue;
    // meleeOnly is only true for a unit on the ground, so the attacker is never airborne here.
    if (meleeOnly && airborneBeyondMelee({
      sourceAirborne: false,
      targetAirborne: target.airborne === true,
      targetStanceBroken: target.stanceBroken === true,
      classicFlyers: grid.classicFlyers === true,
      flightForbidden: grid.flightForbidden === true
    })) continue;
    const targetDims = { width: target.width, height: target.height };
    if (meleeOnly
      && Math.abs(landingElevation - elevationAt(planner, target.x, target.y, targetDims)) > meleeReach) continue;

    // Next turn's attack square is unknown, so the attack is measured at the nearest distance within the weapon's
    // range after a full move.
    const closest = Math.max(1, distance - movement);
    const engageDistance = Math.min(range.maxRange, Math.max(range.minRange, closest));
    const key = `${target.tokenUuid}|${engageDistance}`;
    let matchup = measured?.get(key);
    if (matchup === undefined) {
      matchup = measure(unit, target, weapon, engageDistance, null, { standing: { x: landingX, y: landingY } });
      measured?.set(key, matchup);
    }
    if (!matchup) continue;
    const scored = score(matchup, unit, target, risk);
    if (!scored.productive) continue;
    if (scored.total > bestValue) bestValue = scored.total;
  }
  return bestValue;
}

/**
 * Whether a unit takes on a crossing, and what a failure is expected to cost it. A crossing is refused below the
 * profile's lowest chance, and a drop whose worst fall would kill the unit or take SEVERE_FALL_FRACTION of its max HP
 * is refused below LETHAL_RISK_MIN_CHANCE.
 * @param {object} crossing The system's crossing (`movement.crossings`).
 * @param {import('./types.mjs').PlannerUnit} unit The unit that would climb or drop.
 * @param {import('./types.mjs').RiskProfile} risk The weights it plans with.
 * @returns {{chance: number, odds: number, descending: boolean, expectedFallFraction: number}|null} Null when the
 *   unit refuses the crossing; `odds` is the chance from 0 to 1, and `expectedFallFraction` the share of its max HP a
 *   drop is expected to cost, 0 for a climb.
 */
export function crossingRisk(crossing, unit, risk) {
  const chance = Number(crossing.chance) || 0;
  if (chance <= 0 || chance < risk.minChance) return null;

  const descending = crossing.descending === true;
  const worstFall = descending ? Number(crossing.worstFallDamage) || 0 : 0;
  const maxHp = unit.hpMax || 1;
  const severe = worstFall >= unit.hp || worstFall >= maxHp * SEVERE_FALL_FRACTION;
  if (descending && severe && chance < LETHAL_RISK_MIN_CHANCE) return null;

  const odds = chance / 100;
  const expectedFallFraction = descending
    ? (1 - odds) * (Number(crossing.fallFraction) || 0) * FALL_EXPECTED_MULTIPLIER
    : 0;
  return { chance, odds, descending, expectedFallFraction };
}

/** Every crossing this unit could attempt this turn, keyed by landing so the cheapest approach to each is kept. */
export function collectCrossings(unit, graph, anchors) {
  const byLanding = new Map();
  const occupied = occupiedCells(unit);
  const dims = { width: unit.width, height: unit.height };
  for (const crossing of crossingsOf(unit.tokenUuid)) {
    const anchorX = crossing.from?.x;
    const anchorY = crossing.from?.y;
    if (!anchors.has(cellKey(anchorX, anchorY))) continue;
    const moveCost = moveCostAt(graph, anchorX, anchorY);
    if (!Number.isFinite(moveCost)) continue;
    if (footprintOccupiedIn(occupied, dims, anchorX, anchorY)) continue;

    const landingX = crossing.to?.x;
    const landingY = crossing.to?.y;
    const landingKey = cellKey(landingX, landingY);
    const existing = byLanding.get(landingKey);
    if (existing && existing.moveCost <= moveCost) continue;
    byLanding.set(landingKey, { crossing, anchorX, anchorY, landingX, landingY, moveCost });
  }
  return [...byLanding.values()];
}

/**
 * The best zone crossing for this turn, or null when none beats what the turn otherwise offers. Each crossing is
 * charged for its fall risk and for the turn spent climbing.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit that would climb or drop.
 * @param {import('./types.mjs').TurnPlan|null} currentPlan The action it would otherwise take; a crossing must beat
 *   its attack.
 * @param {import('./types.mjs').RiskProfile} riskProfile The weights it plans with.
 * @returns {import('./types.mjs').CrossingPlan|null}
 */
export function planCrossing(planner, unit, currentPlan, riskProfile) {
  if (!riskProfile) throw new TypeError('planCrossing: a risk profile is required.');
  if (!canAttemptCrossing(planner, unit)) return null;

  const risk = riskProfile;
  const { graph, anchors } = reachableAnchors(unit);
  const startX = unit.x;
  const startY = unit.y;
  const currentValue = currentPlan?.kind === 'attack' ? currentPlan.score.total : 0;

  const options = collectCrossings(unit, graph, anchors);
  const targets = collectTargets(planner, unit);
  const measured = new Map();
  const future = (x, y) => crossingFutureValue(planner, unit, x, y, risk, { targets, measured });

  const baseline = Math.max(currentValue, future(startX, startY) * risk.futureDiscount);
  let best = null;
  for (const option of options) {
    const { crossing, anchorX, anchorY, landingX, landingY, moveCost } = option;
    const accepted = crossingRisk(crossing, unit, risk);
    if (!accepted) continue;

    const futureValue = future(landingX, landingY);
    if (futureValue <= 0) continue;

    const value = (accepted.odds * futureValue * risk.futureDiscount)
      - (SCORE_SCALE * accepted.expectedFallFraction * risk.fallAversion)
      - CROSSING_TEMPO_PENALTY;

    if (value <= baseline + CROSSING_VALUE_MARGIN) continue;
    if (best && !(value > best.value || (value === best.value && moveCost < best.moveCost))) continue;
    best = {
      kind: 'crossing',
      skill: crossing.skillKey,
      chance: accepted.chance,
      futureValue,
      value,
      moveCost,
      crossing,
      origin: { x: anchorX, y: anchorY },
      needsMove: anchorX !== startX || anchorY !== startY,
      graph
    };
  }
  return best;
}

/* -------------------------------------------- */
/*  Simple movement                             */
/* -------------------------------------------- */
/** The distance in squares from a footprint on a square to the nearest of the hostiles, or Infinity with none. */
function nearestHostileDistance(x, y, dims, hostiles) {
  let nearest = Infinity;
  for (const hostile of hostiles) nearest = Math.min(nearest, standingDistance(x, y, dims, hostile));
  return nearest;
}

/**
 * Every square this unit could move to and stop on, leaving out the one it stands on, with its cost and its distance
 * to the nearest hostile. `standing` is that distance from the square the unit stands on now.
 */
export function movementOptions(planner, unit, { budget = null, hostiles = null } = {}) {
  const { graph, anchors } = reachableAnchors(unit);
  const landable = new Set((graph.destinations ?? []).map(cell => cellKey(cell.x, cell.y)));
  const dims = { width: unit.width, height: unit.height };
  const occupied = occupiedCells(unit);
  const startX = unit.x;
  const startY = unit.y;
  const threats = hostiles ?? hostileTokens(planner, unit);

  const options = [];
  for (const anchorKey of anchors) {
    if (!landable.has(anchorKey)) continue;
    const { x: anchorX, y: anchorY } = parseCellKey(anchorKey);
    const moveCost = moveCostAt(graph, anchorX, anchorY);
    if (!Number.isFinite(moveCost)) continue;
    if (budget !== null && moveCost > budget) continue;
    if (anchorX === startX && anchorY === startY) continue;
    if (footprintOccupiedIn(occupied, dims, anchorX, anchorY)) continue;
    const nearestHostile = nearestHostileDistance(anchorX, anchorY, dims, threats);
    options.push({ anchorX, anchorY, moveCost, nearestHostile });
  }
  const standing = nearestHostileDistance(startX, startY, dims, threats);
  return { options, graph, hostileCount: threats.length, standing };
}

/**
 * Back away: the square furthest from the nearest hostile, ties going to the cheapest. The unit stays where it is
 * when no square it can reach is further from the nearest hostile than its own, as in a dead end.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit retreating.
 * @param {object} [options]
 * @param {number|null} [options.budget] How far the unit's condition lets it walk; null for all it has.
 * @returns {import('./types.mjs').WalkPlan|null} Null when no hostile is on the map or no reachable square is
 *   further from one.
 */
export function planRetreat(planner, unit, { budget = null } = {}) {
  const { options, graph, hostileCount, standing } = movementOptions(planner, unit, { budget });
  if (hostileCount === 0) return null;

  let best = null;
  for (const option of options) {
    if (!best
        || option.nearestHostile > best.nearestHostile
        || (option.nearestHostile === best.nearestHostile && option.moveCost < best.moveCost)) {
      best = option;
    }
  }
  if (!best || best.nearestHostile <= standing) return null;
  return { destination: { x: best.anchorX, y: best.anchorY }, graph };
}

/**
 * Wander: a uniformly random reachable square, deliberately unweighted, since any bias would read as intent. The draw
 * is `unpredictableRoll`, fixed for the round and the unit, so a turn replayed after a rollback wanders to the same
 * square.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The wandering unit.
 * @param {object} [options]
 * @param {number|null} [options.budget] How far the unit's condition lets it walk.
 * @returns {import('./types.mjs').WalkPlan|null} The square to wander to, or null when it has nowhere to go.
 */
export function planFreeRoam(planner, unit, { budget = null } = {}) {
  const { options, graph } = movementOptions(planner, unit, { budget });
  if (options.length === 0) return null;
  const draw = unpredictableRoll(planner, unit, 'roam');
  const pick = options[Math.min(options.length - 1, Math.floor(draw * options.length))];
  return { destination: { x: pick.anchorX, y: pick.anchorY }, graph };
}
