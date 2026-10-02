/** @layer planner */
import { DEBUFF_SETUP_VALUE, PROFILE_ORDER_SPAN, PROFILE_TURN_ORDER, PURSUIT_DEFER_MARGIN } from '../constants.mjs';
import { board } from './board.mjs';
import { woundedFriendlies } from './planning.mjs';
import {
  directiveOf,
  isManual,
  isPassive,
  priorityOf,
  profileOf,
  riskProfileFor,
  unpredictableRoll,
  wakesFromPassive
} from './profile.mjs';
import { takesOffAgain } from './movement.mjs';
import { planPursue } from './pursuit.mjs';
import { fleesByStatus, isHeldByStatus, isStanceBroken } from './readiness.mjs';
import { canAct, collectTargets, loadout, tauntorToken, usableWeapons } from './roster.mjs';
import { planSeize } from './seize.mjs';
import { bonusSelfHealItemsOf, healItemsOf, healThresholdOf } from './support.mjs';
import { standingDistance, unitCellKeys, unitDistance } from './vocabulary.mjs';

/* -------------------------------------------- */
/*  Who acts                                    */
/* -------------------------------------------- */
/**
 * Whether this unit could do anything at all this phase. It is a quick capability test, not a plan, and the checks
 * are ordered on purpose. A feared unit always gets its turn, whatever its profile, because `driver/turn.mjs` must
 * spend it fleeing. A flier grounded by a stance break gets one to take off in, whatever lies within its reach.
 */
function canActThisPhase(planner, unit) {
  if (!unit) return false;
  if (isManual(unit)) return false;
  if (fleesByStatus(unit)) return true;
  if (isPassive(unit)) return wakesFromPassive(planner, unit);
  if (isHeldByStatus(unit)) return false;
  if (isStanceBroken(unit)) return true;
  if (!canAct(unit)) return false;
  if (directiveOf(planner, unit)) return true;
  if (tauntorToken(planner, unit)) return true;
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
  const bound = (Number(unit.movement) || 0) + maxRange;
  return targets.some(target => unitDistance(unit, target) <= bound);
}

/** The heal version of the reach check: a Heal-role item, and a wounded friendly within movement plus its range. */
function canHealSomeone(planner, unit) {
  if (riskProfileFor(planner, unit).healWeight <= 0) return false;
  const carried = loadout(unit).items;
  const bonus = unit.turn?.bonusActionAvailable === true ? bonusSelfHealItemsOf(carried) : [];
  const items = [...healItemsOf(carried), ...bonus];
  if (!items.length) return false;
  const allies = woundedFriendlies(planner, unit);
  if (!allies.length) return false;
  const dims = { width: unit.width, height: unit.height };
  const movement = Number(unit.movement) || 0;
  const freeTerrain = board(planner).terrain.travelBoundedByDistance !== true;
  for (const item of items) {
    const range = item.range;
    if (!range) continue;
    const threshold = healThresholdOf(item);
    for (const ally of allies) {
      if (!needsThisHeal(ally, threshold)) continue;
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

/** Whether one friendly is hurt enough for an item's own threshold. */
function needsThisHeal(ally, threshold) {
  const maxHp = Number(ally.hpMax) || 0;
  if (maxHp <= 0) return false;
  return ((Number(ally.hp) || 0) / maxHp) < threshold;
}

/**
 * Split the roster into the units that get a turn and the ones whose turns can simply be ended. `preparePhase` in
 * `driver/phase.mjs` calls it once per run.
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
 * Order the acting units: authored priority, then units whose weapons break stance or apply debuffs, then profile,
 * then the roster's own order.
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

/** Where a profile falls in the phase, unpredictable units being drawn to a point anywhere in the span. */
function phaseRank(planner, unit) {
  const profile = profileOf(unit);
  if (profile === 'unpredictable') return unpredictableRoll(planner, unit, 'order') * PROFILE_ORDER_SPAN;
  return PROFILE_TURN_ORDER[profile] ?? 1;
}

/* -------------------------------------------- */
/*  Standing aside                              */
/* -------------------------------------------- */
/**
 * Whether this Seize or Pursue unit should stand aside and let an ally that has not moved yet clear the ground
 * first. `runQueue` in `driver/phase.mjs` then moves it to the back of the queue.
 */
export function yieldsToPendingAlly(planner, unit, pending) {
  if (!unit || !pending.length) return false;
  if (isManual(unit) || isPassive(unit)) return false;
  if (isStanceBroken(unit) || !canAct(unit)) return false;
  if (tauntorToken(planner, unit)) return false;
  const directive = directiveOf(planner, unit);
  const behavior = directive?.behavior;
  if (behavior !== 'seize' && behavior !== 'pursue') return false;
  const freeCells = pendingCells(unit, pending);
  if (!freeCells.size) return false;
  const budget = directive.budget;
  const asIs = marchPlan(planner, unit, behavior, { budget });
  const cleared = marchPlan(planner, unit, behavior, { budget, freeCells });
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
