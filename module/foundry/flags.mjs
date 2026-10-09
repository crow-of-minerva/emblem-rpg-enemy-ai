/** @layer foundry */
/*
 * Reads and writes of the module's flags on Actors, Items, Combats and Scenes; each read checks the stored value before
 * handing it on. A condition entry's saved shape is in module/condition-entries.mjs.
 */
import {
  ACTOR_FLAGS,
  AI_MODES,
  AI_PRIORITY_DEFAULT,
  AI_PROFILE_DEFAULT,
  AI_PROFILE_VALUES,
  COMBAT_FLAGS,
  ITEM_FLAGS,
  MODULE_ID,
  SCENE_FLAGS
} from '../constants.mjs';
import { conditionsWithSpawnEntry, normalizeStoredConditionEntry, spawnConditionEntry } from '../condition-entries.mjs';
import { systemSpawnBehaviorOf } from './system-bridge.mjs';

/* -------------------------------------------- */
/*  Actor flags                                 */
/* -------------------------------------------- */
/**
 * The module's AI settings for one Actor, each field as the UnitAi typedef in planner/types.mjs describes it.
 * `spawnBehavior` reads blank once `adoptSpawnBehavior` has copied the spawn order into the conditions.
 */
export function readActorAi(actor) {
  const scope = actor?.flags?.[MODULE_ID] ?? {};
  const stored = scope[ACTOR_FLAGS.PROFILE];
  const profile = AI_PROFILE_VALUES.includes(stored) ? stored : AI_PROFILE_DEFAULT;
  const priority = Number(scope[ACTOR_FLAGS.PRIORITY]);
  const conditions = Array.isArray(scope[ACTOR_FLAGS.CONDITIONS])
    ? scope[ACTOR_FLAGS.CONDITIONS].map(normalizeStoredConditionEntry) : [];
  const spawn = systemSpawnBehaviorOf(actor);
  const switched = scope[ACTOR_FLAGS.SWITCHED_PROFILE];
  const markScene = scope[ACTOR_FLAGS.MARK_SCENE];
  return Object.freeze({
    profile,
    priority: Number.isFinite(priority) ? priority : AI_PRIORITY_DEFAULT,
    conditions: Object.freeze(conditions),
    wasAggressed: scope[ACTOR_FLAGS.WAS_AGGRESSED] === true,
    switchedProfile: AI_PROFILE_VALUES.includes(switched) ? switched : '',
    markScene: typeof markScene === 'string' ? markScene : '',
    spawnBehavior: scope[ACTOR_FLAGS.SPAWN_ADOPTED] === spawn ? '' : spawn
  });
}

/**
 * Copy the terrain spawn's order into the Actor's conditions once, as a last Always entry the GM can edit or remove.
 * Runs on the host client only, when the flag arrives on the Actor and when the Actor Control Panel draws its AI tab.
 */
export async function adoptSpawnBehavior(actor) {
  const spawn = systemSpawnBehaviorOf(actor);
  if (!spawnConditionEntry(spawn)) return false;
  const ai = readActorAi(actor);
  if (!ai.spawnBehavior) return false;
  return writeActorAi(actor, { conditions: conditionsWithSpawnEntry(ai.conditions, spawn), spawnAdopted: spawn });
}

/**
 * Write one or more AI fields on an Actor, the conditions as a whole list; a `switchedProfile` or `markScene` of ''
 * clears that field. Saving the GM's `profile` also clears a profile switch, so the new choice takes effect at once.
 */
export async function writeActorAi(actor, {
  profile, priority, conditions, wasAggressed, switchedProfile, markScene, spawnAdopted
} = {}) {
  if (!actor) return false;
  const changes = {};
  const switchPath = flagPath(ACTOR_FLAGS.SWITCHED_PROFILE);
  if (profile !== undefined && AI_PROFILE_VALUES.includes(profile)) {
    changes[flagPath(ACTOR_FLAGS.PROFILE)] = profile;
    if (actor.flags?.[MODULE_ID]?.[ACTOR_FLAGS.SWITCHED_PROFILE]) changes[switchPath] = '';
  }
  if (priority !== undefined) {
    const value = Math.trunc(Number(priority));
    changes[flagPath(ACTOR_FLAGS.PRIORITY)] = Number.isFinite(value) ? value : AI_PRIORITY_DEFAULT;
  }
  if (conditions !== undefined) {
    changes[flagPath(ACTOR_FLAGS.CONDITIONS)] = conditions.map(normalizeStoredConditionEntry);
  }
  if (wasAggressed !== undefined) changes[flagPath(ACTOR_FLAGS.WAS_AGGRESSED)] = wasAggressed;
  if (switchedProfile !== undefined) {
    changes[switchPath] = AI_PROFILE_VALUES.includes(switchedProfile) ? switchedProfile : '';
  }
  if (markScene !== undefined) changes[flagPath(ACTOR_FLAGS.MARK_SCENE)] = String(markScene);
  if (spawnAdopted !== undefined) changes[flagPath(ACTOR_FLAGS.SPAWN_ADOPTED)] = spawnAdopted;
  if (!Object.keys(changes).length) return false;
  await actor.update(changes);
  return true;
}

function flagPath(key) {
  return `flags.${MODULE_ID}.${key}`;
}

/* -------------------------------------------- */
/*  Item flags                                  */
/* -------------------------------------------- */
/** An Item's AI parameters (role, heal threshold and amount), from a loadout entry's flags or an Item document. */
export function readItemAiData(source) {
  const scope = source?.flags?.[MODULE_ID] ?? {};
  const data = scope[ITEM_FLAGS.AI_DATA] ?? {};
  const threshold = Number(data.threshold);
  const amount = Number(data.amount);
  return Object.freeze({
    role: String(data.role ?? ''),
    threshold: Number.isFinite(threshold) && threshold > 0 ? Math.min(100, threshold) : 50,
    amount: Number.isFinite(amount) && amount >= 0 ? amount : 0
  });
}

/** Write an Item's AI parameters, as the AI Parameters dialog saves them. */
export async function writeItemAiData(item, aiData) {
  if (!item) return false;
  await item.update({ [flagPath(ITEM_FLAGS.AI_DATA)]: { ...aiData } });
  return true;
}

/* -------------------------------------------- */
/*  Combat flags                                */
/* -------------------------------------------- */
/** The Enemy AI mode stored on an encounter. Anything but a known mode reads as off. */
export function readCombatMode(combat) {
  const raw = combat?.flags?.[MODULE_ID]?.[COMBAT_FLAGS.MODE];
  return AI_MODES.includes(raw) ? raw : 'off';
}

/** Store the Enemy AI mode on an encounter. */
export async function writeCombatMode(combat, mode) {
  if (!combat || !AI_MODES.includes(mode)) return false;
  if (readCombatMode(combat) === mode) return false;
  await combat.setFlag(MODULE_ID, COMBAT_FLAGS.MODE, mode);
  return true;
}

/**
 * Whether an update sets or removes the module's mode flag, or removes the module's whole flag scope. Foundry v14 hands
 * the update hook a removal as a `foundry.data.operators.ForcedDeletion` in place of the value, even when the caller
 * asked for it with an older `-=` key.
 */
export function changesCombatMode(changed) {
  const scope = changed.flags?.[MODULE_ID];
  if (scope instanceof foundry.data.operators.ForcedDeletion) return true;
  return scope?.[COMBAT_FLAGS.MODE] !== undefined;
}

/* -------------------------------------------- */
/*  Stop mark                                   */
/* -------------------------------------------- */
/** Where the Enemy AI gave up after an uncertain result, as recorded on the encounter, or null. */
export function readStopMark(combat) {
  const raw = combat?.flags?.[MODULE_ID]?.[COMBAT_FLAGS.STOPPED_PHASE];
  if (!raw || typeof raw !== 'object') return null;
  return {
    sceneUuid: String(raw.sceneUuid ?? ''),
    combatUuid: String(raw.combatUuid ?? ''),
    phase: String(raw.phase ?? ''),
    round: roundOf(raw.round)
  };
}

/** Record the Scene, encounter, phase and round where the Enemy AI stopped. Only the host client writes it. */
export async function writeStopMark(combat, { sceneUuid, combatUuid, phase, round }) {
  if (!combat) return false;
  await combat.setFlag(MODULE_ID, COMBAT_FLAGS.STOPPED_PHASE, {
    sceneUuid: String(sceneUuid ?? ''),
    combatUuid: String(combatUuid ?? ''),
    phase: String(phase ?? ''),
    round: roundOf(round)
  });
  return true;
}

/** Remove an encounter's stop mark, when it has one. */
export async function clearStopMark(combat) {
  if (!readStopMark(combat)) return false;
  await combat.unsetFlag(MODULE_ID, COMBAT_FLAGS.STOPPED_PHASE);
  return true;
}

/** A round number as the encounter reports it, or null when it has none. */
function roundOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const round = Number(value);
  return Number.isFinite(round) ? round : null;
}

/* -------------------------------------------- */
/*  Scene flags                                 */
/* -------------------------------------------- */
/** The mode a paused encounter had, as set aside on its Scene, or null. */
export function readPausedMode(scene) {
  const raw = scene?.flags?.[MODULE_ID]?.[SCENE_FLAGS.PAUSED_MODE];
  return AI_MODES.includes(raw) ? raw : null;
}

/** Set a paused encounter's mode aside on its Scene. Only the host client writes it. */
export async function writePausedMode(scene, mode) {
  if (!scene || !AI_MODES.includes(mode)) return false;
  await scene.setFlag(MODULE_ID, SCENE_FLAGS.PAUSED_MODE, mode);
  return true;
}

/** Remove a Scene's set-aside mode, when it has one. */
export async function clearPausedMode(scene) {
  if (!readPausedMode(scene)) return false;
  await scene.unsetFlag(MODULE_ID, SCENE_FLAGS.PAUSED_MODE);
  return true;
}
