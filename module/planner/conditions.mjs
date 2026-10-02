/** @layer planner */
import {
  AI_BEHAVIORS_WITH_VARIABLE,
  AI_BEHAVIOR_VALUES,
  AI_CONDITION_TARGETS,
  AI_CONDITION_TYPES,
  AI_CONDITIONS_WITH_NUM,
  AI_HP_THRESHOLDS,
  AI_PROFILE_DEFAULT,
  AI_PROFILE_VALUES,
  AI_ROUND_MIN
} from '../constants.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
const SELF_TYPES = new Set(AI_CONDITION_TYPES.self.map(type => type.value));

/** A blank condition entry. */
export function defaultConditionEntry() {
  return {
    target: 'self', type: 'always', behavior: 'pursue', profile: AI_PROFILE_DEFAULT, variable: 0, num: AI_ROUND_MIN
  };
}

/** Fill an editor row with values its current controls can display. */
export function sanitizeConditionEntry(raw) {
  const base = defaultConditionEntry();
  const target = AI_CONDITION_TARGETS.some(entry => entry.value === raw?.target) ? raw.target : base.target;
  const types = AI_CONDITION_TYPES[target];
  const type = raw?.type;
  return {
    target,
    type: types.some(entry => entry.value === type) ? type : types[0].value,
    behavior: AI_BEHAVIOR_VALUES.includes(raw?.behavior) ? raw.behavior : base.behavior,
    profile: AI_PROFILE_VALUES.includes(raw?.profile) ? raw.profile : base.profile,
    variable: Math.max(0, Math.floor(Number(raw?.variable) || 0)),
    num: conditionNum(raw)
  };
}

/** Read saved conditions, keeping unknown types or behaviours as they are so they never fire. */
export function normalizeStoredConditionEntry(raw) {
  return Object.freeze({
    ...sanitizeConditionEntry(raw),
    target: String(raw?.target ?? ''),
    type: String(raw?.type ?? ''),
    behavior: String(raw?.behavior ?? ''),
    profile: String(raw?.profile ?? '')
  });
}

/** The condition's own number, floored at the minimum its type allows. */
function conditionNum(entry) {
  const requested = Math.floor(Number(entry?.num));
  if (!Number.isFinite(requested)) return AI_ROUND_MIN;
  return Math.max(AI_ROUND_MIN, requested);
}

/** Whether this condition type carries a number the author has to supply. */
export function conditionTakesNum(type) {
  return AI_CONDITIONS_WITH_NUM.includes(type);
}

/* -------------------------------------------- */
/*  Evaluation                                  */
/* -------------------------------------------- */
/** Whether one authored self condition holds for this unit right now. Player conditions never hold. */
function conditionHolds(entry, unit, context = {}) {
  if (entry.target !== 'self') return false;
  const type = entry.type;
  if (!SELF_TYPES.has(type)) return false;
  const value = Number(unit.hp) || 0;
  const max = Number(unit.hpMax) || 0;
  const fraction = max > 0 ? value / max : 0;
  if (type in AI_HP_THRESHOLDS) return max > 0 && value > 0 && fraction < AI_HP_THRESHOLDS[type];
  switch (type) {
    case 'always':
      return true;
    case 'broken':
      return (Number(unit.stance) || 0) <= 0;
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
  const allowance = Number(unit.movement) || 0;
  if (allowance <= 0) return 0;
  return Math.min(requested, allowance);
}

/** The first authored entry that currently holds, as a directive. Null means the unit takes its normal turn. */
export function resolveDirective(unit, context = {}) {
  const entries = conditionEntriesOf(unit);
  for (const entry of entries) {
    if (!isUsableEntry(entry)) continue;
    if (!conditionHolds(entry, unit, context)) continue;
    return {
      behavior: entry.behavior,
      profile: entry.behavior === 'switchProfile' ? entry.profile : null,
      budget: movementBudget(entry, unit),
      entry
    };
  }
  return null;
}

/** The unit's authored conditions, followed by its terrain spawn behaviour as an extra Always entry. */
function conditionEntriesOf(unit) {
  const authored = unit.conditions;
  const trailing = spawnConditionEntry(unit.spawnBehavior);
  return trailing ? [...authored, trailing] : authored;
}

/** The terrain spawn's behaviour as an Always condition entry, or null when it isn't a known behaviour. */
export function spawnConditionEntry(spawn) {
  if (!AI_BEHAVIOR_VALUES.includes(spawn)) return null;
  return { target: 'self', type: 'always', behavior: spawn, profile: null, variable: 0, num: AI_ROUND_MIN };
}
