/** @layer planner */
/*
 * Which of the GM's condition entries applies to a unit right now, and the directive it gives. The entry format (a
 * blank row, repairs, the saved shape and the terrain spawn's row) is in module/condition-entries.mjs.
 */
import {
  AI_BEHAVIORS_WITH_VARIABLE,
  AI_BEHAVIOR_VALUES,
  AI_CONDITION_TYPES,
  AI_HP_THRESHOLDS,
  AI_PROFILE_VALUES
} from '../constants.mjs';
import { conditionNum, spawnConditionEntry } from '../condition-entries.mjs';
import { isStanceBroken } from './readiness.mjs';

const CONDITION_TYPES = new Set(AI_CONDITION_TYPES.map(type => type.value));

/* -------------------------------------------- */
/*  Evaluation                                  */
/* -------------------------------------------- */
/** Whether one of the GM's conditions holds for this unit right now. */
function conditionHolds(entry, unit, context = {}) {
  const type = entry.type;
  if (!CONDITION_TYPES.has(type)) return false;
  const value = unit.hp;
  const max = unit.hpMax;
  const fraction = max > 0 ? value / max : 0;
  if (type in AI_HP_THRESHOLDS) return max > 0 && value > 0 && fraction < AI_HP_THRESHOLDS[type];
  switch (type) {
    case 'always':
      return true;
    case 'broken':
      return isStanceBroken(unit);
    case 'aggressed':
      return unit.wasAggressed;
    case 'atRound':
      return Number.isFinite(context?.round) && context.round >= conditionNum(entry);
    default:
      return false;
  }
}

/* -------------------------------------------- */
/*  Resolution                                  */
/* -------------------------------------------- */
function isUsableEntry(entry) {
  if (!entry) return false;
  if (!AI_BEHAVIOR_VALUES.includes(entry.behavior)) return false;
  if (entry.behavior === 'switchProfile' && !AI_PROFILE_VALUES.includes(entry.profile)) return false;
  return true;
}

/** How far a behaviour may travel in squares, capped by the unit's own allowance. Null means spend it all. */
function movementBudget(entry, unit) {
  if (!AI_BEHAVIORS_WITH_VARIABLE.includes(entry.behavior)) return null;
  const requested = Number(entry.variable) || 0;
  if (requested <= 0) return null;
  const allowance = unit.movement;
  if (allowance <= 0) return 0;
  return Math.min(requested, allowance);
}

/**
 * The first of the GM's entries that holds right now, as a directive. A switch lasts the battle, so once the unit plays
 * by its profile every Switch AI Profile entry is passed over, and the entries below still give it movement.
 * @param {object} unit The values directiveFacts in profile.mjs reads off the unit, including its current profile.
 * @param {{round?: number|null}} [context] The encounter's round, which At Round entries read.
 * @returns {import('./types.mjs').Directive|null} Null when the unit takes its normal turn.
 */
export function resolveDirective(unit, context = {}) {
  let switched = false;
  for (const entry of conditionEntriesOf(unit)) {
    if (!isUsableEntry(entry)) continue;
    if (!conditionHolds(entry, unit, context)) continue;
    if (entry.behavior === 'switchProfile' && (switched || entry.profile === unit.profile)) {
      switched = true;
      continue;
    }
    return {
      behavior: entry.behavior,
      profile: entry.behavior === 'switchProfile' ? entry.profile : null,
      budget: movementBudget(entry, unit),
      entry
    };
  }
  return null;
}

/** The GM's conditions on the unit, followed by its terrain spawn behaviour as an extra Always entry. */
function conditionEntriesOf(unit) {
  const authored = unit.conditions;
  const trailing = spawnConditionEntry(unit.spawnBehavior);
  return trailing ? [...authored, trailing] : authored;
}
