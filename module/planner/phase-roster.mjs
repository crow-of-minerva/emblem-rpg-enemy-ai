/** @layer planner */
/*
 * The enemy phase's roster: which units get a turn and which have nothing to do, the order they act in, and when a
 * Seize or Pursue unit lets an ally that has not moved yet go first.
 */
import { PROFILE_ORDER_SPAN, PROFILE_TURN_ORDER } from '../constants.mjs';
import { board } from './board.mjs';
import { standingDistance, unitCellKeys, unitDistance } from './grid.mjs';
import { loadout, usableWeapons } from './loadout.mjs';
import { takesOffAgain } from './movement.mjs';
import { woundedFriendlies } from './planning.mjs';
import { priorityOf, profileOf, riskProfileFor, unpredictableRoll } from './profile.mjs';
import { planPursue } from './pursuit.mjs';
import { planSeize } from './seize.mjs';
import { bonusSelfHealDue, healItemsOf, hurtEnoughFor } from './support.mjs';
import { collectTargets } from './targeting.mjs';
import { DEBUFF_SETUP_VALUE, PURSUIT_DEFER_MARGIN } from './tuning.mjs';
import { TURN_KINDS, turnCourse } from './turn-course.mjs';

/* -------------------------------------------- */
/*  Who acts                                    */
/* -------------------------------------------- */
/** The kinds of turn that are played whatever lies within the unit's reach. */
const COURSES_THAT_ACT = new Set([TURN_KINDS.FLEE, TURN_KINDS.DIRECTIVE_MOVE, TURN_KINDS.BROKEN]);

/**
 * Whether this unit could do anything at all this phase: a quick test on its course, not a plan. A unit with a profile
 * switch to save gets its turn, so the switch is saved when it first holds, and so does a grounded flier that can rise.
 */
function canActThisPhase(planner, unit) {
  if (!unit) return false;
  const course = turnCourse(planner, unit);
  if (course.switchTo || COURSES_THAT_ACT.has(course.kind)) return true;
  if (course.kind !== TURN_KINDS.ACT) return false;
  if (course.directive || course.tauntor) return true;
  if (takesOffAgain(unit)) return true;
  if (canHealSomeone(planner, unit)) return true;
  const weapons = usableWeapons(unit);
  if (!weapons.length) return false;
  const targets = collectTargets(planner, unit);
  if (!targets.length) return false;
  // A unit with no directive holds its ground: unless a target lies within its movement plus weapon reach, its turn is
  // ended. Teleports and free squares make distance no bound on travel, so on such maps every armed unit acts.
  if (board(planner).terrain.travelBoundedByDistance !== true) return true;
  let maxRange = 0;
  for (const weapon of weapons) maxRange = Math.max(maxRange, weapon.range.maxRange ?? 0);
  if (maxRange <= 0) return false;
  const bound = unit.movement + maxRange;
  return targets.some(target => unitDistance(unit, target) <= bound);
}

/**
 * The heal version of the reach check. A bonus-action self-heal the unit would use now counts for every profile;
 * otherwise it needs a profile that heals and a friendly hurt enough for a Heal-role item within movement plus range.
 */
function canHealSomeone(planner, unit) {
  if (bonusSelfHealDue(unit)) return true;
  if (riskProfileFor(planner, unit).healWeight <= 0) return false;
  const items = healItemsOf(loadout(unit).items);
  if (!items.length) return false;
  const allies = woundedFriendlies(planner, unit);
  if (!allies.length) return false;
  const dims = { width: unit.width, height: unit.height };
  const movement = unit.movement;
  const freeTerrain = board(planner).terrain.travelBoundedByDistance !== true;
  for (const item of items) {
    const range = item.range;
    if (!range) continue;
    for (const ally of allies) {
      if (!hurtEnoughFor(ally, item)) continue;
      if (ally.tokenUuid === unit.tokenUuid) {
        if (range.minRange <= 0) return true;
        continue;
      }
      if (freeTerrain) return true;
      if (standingDistance(unit.x, unit.y, dims, ally) <= movement + range.maxRange) return true;
    }
  }
  return false;
}

/**
 * Split the roster into the units that get a turn and the ones whose turns can simply be ended.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit[]} units The units the AI plays this phase.
 * @returns {{acting: import('./types.mjs').PlannerUnit[], idle: import('./types.mjs').PlannerUnit[]}} Both lists
 *   keep the roster's order.
 */
export function triage(planner, units) {
  const acting = [];
  const idle = [];
  for (const unit of units) (canActThisPhase(planner, unit) ? acting : idle).push(unit);
  return { acting, idle };
}

/* -------------------------------------------- */
/*  In what order                               */
/* -------------------------------------------- */
/** Whether a weapon applies something harmful on a hit. */
function hasOnHitDebuff(weapon) {
  return weapon.onHitDebuff === true;
}

/** How much this unit sets a target up for others: its best break damage, plus a bonus for an on-hit debuff. */
function setupValueOf(unit) {
  let maxBrk = 0;
  let debuff = false;
  for (const weapon of usableWeapons(unit)) {
    maxBrk = Math.max(maxBrk, Number(weapon.breakDamage) || 0);
    if (!debuff && hasOnHitDebuff(weapon)) debuff = true;
  }
  return { maxBrk, debuff, value: maxBrk + (debuff ? DEBUFF_SETUP_VALUE : 0) };
}

/**
 * Order the acting units: the GM's priority, then units whose weapons break stance or apply debuffs, then profile,
 * then the roster's own order.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit[]} units The units that take a turn this phase.
 * @returns {import('./types.mjs').PlannerUnit[]} A new list in the order they take their turns.
 */
export function orderForPhase(planner, units) {
  return units
    .map((unit, index) => ({
      unit,
      index,
      rank: phaseRank(planner, unit),
      priority: priorityOf(unit),
      setup: setupValueOf(unit).value
    }))
    .sort((a, b) => (b.priority - a.priority) || (b.setup - a.setup) || (a.rank - b.rank) || (a.index - b.index))
    .map(entry => entry.unit);
}

/** Where a unit's profile places it in the phase. A random place is drawn once per round, anywhere in the span. */
function phaseRank(planner, unit) {
  const order = PROFILE_TURN_ORDER[profileOf(unit)];
  if (order === 'random') return unpredictableRoll(planner, unit, 'order') * PROFILE_ORDER_SPAN;
  return order;
}

/* -------------------------------------------- */
/*  Standing aside                              */
/* -------------------------------------------- */
/**
 * Whether this Seize or Pursue unit should go to the back of the queue, so an ally that has not moved yet clears the
 * ground first.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit about to take its turn.
 * @param {import('./types.mjs').PlannerUnit[]} pending The units still queued to act this phase.
 * @returns {boolean}
 */
export function yieldsToPendingAlly(planner, unit, pending) {
  if (!unit || !pending.length) return false;
  const course = turnCourse(planner, unit);
  if (course.kind !== TURN_KINDS.ACT) return false;
  const directive = course.primary ?? course.fallback;
  const behavior = directive?.behavior;
  if (behavior !== 'seize' && behavior !== 'pursue') return false;
  const freeCells = pendingCells(unit, pending);
  if (!freeCells.size) return false;
  const budget = directive.budget;
  const asIs = marchPlan(planner, course.unit, behavior, { budget });
  const cleared = marchPlan(planner, course.unit, behavior, { budget, freeCells });
  const clearedRemaining = cleared?.remaining;
  if (!Number.isFinite(clearedRemaining)) return false;
  const remaining = asIs?.remaining;
  if (!Number.isFinite(remaining)) return true;
  return clearedRemaining + PURSUIT_DEFER_MARGIN <= remaining;
}

/** Every cell held by an ally that has yet to take its turn. */
function pendingCells(unit, pending) {
  const cells = new Set();
  for (const ally of pending) {
    if (ally.tokenUuid === unit.tokenUuid) continue;
    if (ally.turn?.turnComplete === true) continue;
    for (const key of unitCellKeys(ally)) cells.add(key);
  }
  return cells;
}

/** The marching plan behind a Seize or Pursue directive, optionally with allied ground treated as clear. */
function marchPlan(planner, unit, behavior, options) {
  return behavior === 'seize' ? planSeize(planner, unit, options) : planPursue(planner, unit, options);
}
