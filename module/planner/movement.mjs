/** @layer planner */
import {
  CROSSING_TEMPO_PENALTY,
  CROSSING_VALUE_MARGIN,
  FALL_EXPECTED_MULTIPLIER,
  LETHAL_RISK_MIN_CHANCE,
  SCORE_SCALE,
  SEVERE_FALL_FRACTION
} from '../constants.mjs';
import { airborneBeyondMelee, crossingsOf } from '../foundry/system-bridge.mjs';
import { board } from './board.mjs';
import { elevationAt, moveCostAt, occupiedCells, reachableAnchors } from './geometry.mjs';
import { collectTargets, hostileTokens, usableWeapons } from './roster.mjs';
import { measure, score } from './scoring.mjs';
import { unpredictableRoll } from './profile.mjs';
import { cellKey, footprintOccupiedIn, parseCellKey, standingDistance } from './vocabulary.mjs';

/* -------------------------------------------- */
/*  Crossings                                   */
/* -------------------------------------------- */
/** Whether this unit could climb or drop at all: not exploring, on foot, unmounted, with stance and an action. */
export function canAttemptCrossing(planner, unit) {
  if (board(planner).exploration === true) return false;
  if (unit.airborne === true) return false;
  if (unit.mounted === true) return false;
  if ((Number(unit.stance) || 0) < 1) return false;
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
 * What the best attack after landing on a square would be worth next turn. The reach checks use the landing square: a
 * melee weapon skips a target the system's airborneBeyondMelee says it cannot reach from the ground, and a target
 * whose elevation differs from the landing square's by more than 1. With a shared `measured` map, each target and
 * distance is measured once, from the first square asked about, and that result is reused for every other square.
 */
function crossingFutureValue(planner, unit, landingX, landingY, risk = null,
  { targets = null, measured = null } = {}) {
  const weapon = wieldedWeapon(unit);
  if (!weapon) return 0;
  const range = weapon.range;
  if (!range) return 0;

  const dims = { width: unit.width, height: unit.height };
  const movement = Number(unit.movement) || 0;
  const landingElevation = elevationAt(planner, landingX, landingY, dims);
  const meleeOnly = range.maxRange <= 1 && unit.airborne !== true;
  const grid = board(planner);

  let bestValue = 0;
  for (const target of targets ?? collectTargets(planner, unit)) {
    const distance = standingDistance(landingX, landingY, dims, target);
    if (distance > movement + range.maxRange) continue;
    if (meleeOnly && airborneBeyondMelee({
      sourceAirborne: unit.airborne === true,
      targetAirborne: target.airborne === true,
      targetStanceBroken: target.stanceBroken === true,
      classicFlyers: grid.classicFlyers === true,
      flightForbidden: grid.flightForbidden === true
    })) continue;
    const targetDims = { width: target.width, height: target.height };
    if (meleeOnly && Math.abs(landingElevation - elevationAt(planner, target.x, target.y, targetDims)) > 1) continue;

    // Next turn's attack square is unknown, so the attack is measured at the nearest distance within the weapon's
    // range after a full move.
    const closest = Math.max(1, distance - movement);
    const engageDistance = Math.min(range.maxRange, Math.max(range.minRange, closest));
    const key = `${target.actorUuid}|${engageDistance}`;
    let cData = measured?.get(key);
    if (cData === undefined) {
      cData = measure(unit, target, weapon, engageDistance, null, { standing: { x: landingX, y: landingY } });
      measured?.set(key, cData);
    }
    if (!cData) continue;
    const scored = score(cData, unit, target, risk);
    if (!scored.productive) continue;
    if (scored.total > bestValue) bestValue = scored.total;
  }
  return bestValue;
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
 * charged for its fall risk and for the turn spent climbing. `runActionLoop` in `driver/turn.mjs` asks when the turn
 * has no real action to take.
 */
export function planCrossing(planner, unit, currentPlan, riskProfile) {
  if (!riskProfile) throw new TypeError('planCrossing: a risk profile is required.');
  if (!canAttemptCrossing(planner, unit)) return null;

  const risk = riskProfile;
  const { graph, anchors } = reachableAnchors(unit);
  const startX = unit.x;
  const startY = unit.y;
  const maxHp = Number(unit.hpMax) || 1;
  const currentHp = Number(unit.hp) || 0;
  const currentValue = currentPlan?.kind === 'attack' ? currentPlan.score.total : 0;

  const options = collectCrossings(unit, graph, anchors);
  const targets = collectTargets(planner, unit);
  const measured = new Map();
  const future = (x, y) => crossingFutureValue(planner, unit, x, y, risk, { targets, measured });

  const baseline = Math.max(currentValue, future(startX, startY) * risk.futureDiscount);
  let best = null;
  for (const option of options) {
    const { crossing, anchorX, anchorY, landingX, landingY, moveCost } = option;
    const chance = Number(crossing.chance) || 0;
    if (chance <= 0 || chance < risk.minChance) continue;

    const descending = crossing.descending === true;
    const worstFall = descending ? Number(crossing.worstFallDamage) || 0 : 0;
    const severe = worstFall >= currentHp || worstFall >= maxHp * SEVERE_FALL_FRACTION;
    if (descending && severe && chance < LETHAL_RISK_MIN_CHANCE) continue;

    const futureValue = future(landingX, landingY);
    if (futureValue <= 0) continue;

    const fallFraction = descending
      ? (1 - (chance / 100)) * (Number(crossing.fallFraction) || 0) * FALL_EXPECTED_MULTIPLIER
      : 0;
    const value = ((chance / 100) * futureValue * risk.futureDiscount)
      - (SCORE_SCALE * fallFraction * risk.fallAversion)
      - CROSSING_TEMPO_PENALTY;

    if (value <= baseline + CROSSING_VALUE_MARGIN) continue;
    if (best && !(value > best.value || (value === best.value && moveCost < best.moveCost))) continue;
    best = {
      kind: 'crossing',
      unit,
      skill: crossing.skillKey,
      chance,
      futureValue,
      value,
      moveCost,
      crossing: { ...crossing, destX: landingX, destY: landingY },
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
/** Every square this unit could stand on, with its cost and its distance to the nearest hostile. */
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

    let nearestHostile = Infinity;
    for (const hostile of threats) {
      const distance = standingDistance(anchorX, anchorY, dims, hostile);
      if (distance < nearestHostile) nearestHostile = distance;
    }
    options.push({ anchorX, anchorY, moveCost, nearestHostile });
  }
  return { options, graph, hostileCount: threats.length };
}

/** Back away: furthest from the nearest threat, ties going to the cheapest square. */
export function planRetreat(planner, unit, { budget = null } = {}) {
  const { options, graph, hostileCount } = movementOptions(planner, unit, { budget });
  if (hostileCount === 0 || options.length === 0) return null;

  let best = null;
  for (const option of options) {
    if (!best
        || option.nearestHostile > best.nearestHostile
        || (option.nearestHostile === best.nearestHostile && option.moveCost < best.moveCost)) {
      best = option;
    }
  }
  if (!best) return null;
  return { destination: { x: best.anchorX, y: best.anchorY }, graph, safety: best.nearestHostile };
}

/**
 * Wander: a uniformly random reachable square, deliberately unweighted, since any bias would read as intent. The draw
 * is `unpredictableRoll`, fixed for the round and the unit, so a turn replayed after a rollback wanders to the same
 * square.
 * @param {object} planner The Scene's planner.
 * @param {object} unit The wandering unit.
 * @param {object} [options]
 * @param {number|null} [options.budget] How far the authored directive lets it walk.
 * @returns {object|null} The square to wander to, or null when it has nowhere to go.
 */
export function planFreeRoam(planner, unit, { budget = null } = {}) {
  const { options, graph } = movementOptions(planner, unit, { budget });
  if (options.length === 0) return null;
  const draw = unpredictableRoll(planner, unit, 'roam');
  const pick = options[Math.min(options.length - 1, Math.floor(draw * options.length))];
  return { destination: { x: pick.anchorX, y: pick.anchorY }, graph };
}
