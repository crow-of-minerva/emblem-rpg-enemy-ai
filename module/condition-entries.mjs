/** @layer enemy-ai */
/*
 * A condition entry is one row of the conditions the GM sets on a unit in the Combat AI tab or in Set Combat AI on
 * Selected. This file holds a blank row, how a row is repaired for the editor or read back from its flag, and the row
 * a terrain spawn's order becomes; which row applies during play is decided in planner/conditions.mjs.
 */
import {
  AI_BEHAVIOR_VALUES,
  AI_CONDITION_TYPES,
  AI_CONDITIONS_WITH_NUM,
  AI_PROFILE_DEFAULT,
  AI_PROFILE_VALUES,
  AI_ROUND_MIN
} from './constants.mjs';

/* -------------------------------------------- */
/*  Condition entries                           */
/* -------------------------------------------- */
/** A blank condition entry. Every condition tests the unit it is set on. */
export function defaultConditionEntry() {
  return { type: 'always', behavior: 'pursue', profile: AI_PROFILE_DEFAULT, variable: 0, num: AI_ROUND_MIN };
}

/** Fill an editor row with values its current controls can display. */
export function sanitizeConditionEntry(raw) {
  const base = defaultConditionEntry();
  const type = raw?.type;
  return {
    type: AI_CONDITION_TYPES.some(entry => entry.value === type) ? type : AI_CONDITION_TYPES[0].value,
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
    type: String(raw?.type ?? ''),
    behavior: String(raw?.behavior ?? ''),
    profile: String(raw?.profile ?? '')
  });
}

/** The entry's number rounded down to a whole number, never below AI_ROUND_MIN, which a missing number reads as. */
export function conditionNum(entry) {
  const requested = Math.floor(Number(entry?.num));
  if (!Number.isFinite(requested)) return AI_ROUND_MIN;
  return Math.max(AI_ROUND_MIN, requested);
}

/** Whether this condition type carries a number the GM has to supply. */
export function conditionTakesNum(type) {
  return AI_CONDITIONS_WITH_NUM.includes(type);
}

/* -------------------------------------------- */
/*  Terrain spawn orders                        */
/* -------------------------------------------- */
/** The terrain spawn's behaviour as an Always condition entry, or null when it isn't a known behaviour. */
export function spawnConditionEntry(spawn) {
  if (!AI_BEHAVIOR_VALUES.includes(spawn)) return null;
  return { type: 'always', behavior: spawn, profile: null, variable: 0, num: AI_ROUND_MIN };
}

/**
 * The GM's conditions with the terrain spawn's order added as a last Always entry, repaired the way the editor shows
 * it. Undefined when the list already has an equal entry or the spawn is not a known behaviour.
 * @param {readonly object[]} conditions The unit's saved condition entries.
 * @param {string} spawn The behaviour the terrain spawn gave the unit.
 * @returns {object[]|undefined} The list to save, or undefined when it stays as it is.
 */
export function conditionsWithSpawnEntry(conditions, spawn) {
  const entry = spawnConditionEntry(spawn);
  if (!entry) return undefined;
  const authored = sanitizeConditionEntry(entry);
  if (conditions.some(item => sameConditionEntry(item, authored))) return undefined;
  return [...conditions, authored];
}

/** Whether a saved entry has every value of a repaired one. */
function sameConditionEntry(left, right) {
  return Object.keys(right).every(key => left[key] === right[key]);
}
