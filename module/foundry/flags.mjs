/** @layer foundry */
import {
  ACTOR_FLAGS,
  AI_MODES,
  AI_PRIORITY_DEFAULT,
  AI_PROFILE_DEFAULT,
  AI_PROFILE_VALUES,
  COMBAT_FLAGS,
  ITEM_FLAGS,
  MODULE_ID,
  SCENE_FLAGS,
  SYSTEM_ID,
  SYSTEM_SPAWN_BEHAVIOR_FLAG
} from '../constants.mjs';
import { normalizeStoredConditionEntry, sanitizeConditionEntry, spawnConditionEntry } from '../planner/conditions.mjs';

/* -------------------------------------------- */
/*  Document lookup                             */
/* -------------------------------------------- */
/** The document a uuid names, or null. A uuid that fails to resolve also reads as null instead of throwing. */
export function documentByUuid(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid) ?? null;
  } catch {
    return null;
  }
}

/** The Actor behind a placed Token uuid, or null. */
export function actorOfToken(tokenUuid) {
  const token = documentByUuid(tokenUuid);
  return token?.documentName === 'Token' ? token.actor ?? null : null;
}

/** The uuid of a placed Token's Scene, read from the token uuid or else from the Token's parent, or ''. */
export function sceneUuidOfToken(tokenUuid) {
  const uuid = String(tokenUuid ?? '');
  const named = /^(Scene\.[^.]+)\.Token\.[^.]+$/.exec(uuid)?.[1];
  if (named) return named;
  const token = documentByUuid(uuid);
  return token?.documentName === 'Token' ? String(token.parent?.uuid ?? '') : '';
}

/** The uuid of an Actor's Scene: its own Token's for a synthetic Actor, else its first placed Token's, or ''. */
export function sceneUuidOfActor(actor) {
  const token = actor?.isToken ? actor.token : actor?.getDependentTokens?.()?.[0];
  return String(token?.parent?.uuid ?? '');
}

/** The Scenes of every started encounter, read off the Combat documents rather than any client's view. */
export function startedEncounterSceneUuids() {
  const combats = globalThis.game?.combats;
  const documents = combats?.contents ?? Array.from(combats ?? []);
  const scenes = documents
    .filter(combat => combat?.started === true)
    .map(combat => String(combat.scene?.uuid ?? ''))
    .filter(Boolean);
  return [...new Set(scenes)];
}

/* -------------------------------------------- */
/*  Actor flags                                 */
/* -------------------------------------------- */
/**
 * The module's AI settings for one Actor. Once `adoptSpawnBehavior` has copied the spawn order into the conditions,
 * `spawnBehavior` reads blank, since the condition entry now carries it.
 */
export function readActorAi(actor) {
  const scope = actor?.flags?.[MODULE_ID] ?? {};
  const stored = scope[ACTOR_FLAGS.PROFILE];
  const profile = AI_PROFILE_VALUES.includes(stored) ? stored : AI_PROFILE_DEFAULT;
  const priority = Number(scope[ACTOR_FLAGS.PRIORITY]);
  const conditions = Array.isArray(scope[ACTOR_FLAGS.CONDITIONS])
    ? scope[ACTOR_FLAGS.CONDITIONS].map(normalizeStoredConditionEntry) : [];
  const spawn = spawnBehaviorOf(actor);
  return Object.freeze({
    profile,
    priority: Number.isFinite(priority) ? priority : AI_PRIORITY_DEFAULT,
    conditions: Object.freeze(conditions),
    wasAggressed: scope[ACTOR_FLAGS.WAS_AGGRESSED] === true,
    spawnBehavior: scope[ACTOR_FLAGS.SPAWN_ADOPTED] === spawn ? '' : spawn
  });
}

/** The system's spawn-order flag on an Actor, as written by the terrain spawn that placed it. */
function spawnBehaviorOf(actor) {
  return String(actor?.flags?.[SYSTEM_ID]?.[SYSTEM_SPAWN_BEHAVIOR_FLAG] ?? '');
}

/** Whether an Actor update carries the system's spawn-order flag. */
export function changesSpawnBehavior(changed) {
  return changed.flags?.[SYSTEM_ID]?.[SYSTEM_SPAWN_BEHAVIOR_FLAG] !== undefined;
}

/**
 * Copy the terrain spawn's order into the Actor's conditions once, as a last Always entry the GM can edit or remove.
 * `onUpdateActor` in `foundry/hooks.mjs` calls it when the flag lands, and the Control Panel tray when it renders.
 */
export async function adoptSpawnBehavior(actor) {
  const spawn = spawnBehaviorOf(actor);
  const entry = spawnConditionEntry(spawn);
  if (!entry) return false;
  const ai = readActorAi(actor);
  if (!ai.spawnBehavior) return false;
  const authored = sanitizeConditionEntry(entry);
  const present = ai.conditions.some(item => sameConditionEntry(item, authored));
  return writeActorAi(actor, { conditions: present ? undefined : [...ai.conditions, authored], spawnAdopted: spawn });
}

function sameConditionEntry(left, right) {
  return Object.keys(right).every(key => left[key] === right[key]);
}

/** Write one or more AI fields on an Actor. Conditions are written as a whole list, never merged. */
export async function writeActorAi(actor, { profile, priority, conditions, wasAggressed, spawnAdopted } = {}) {
  if (!actor) return false;
  const changes = {};
  if (profile !== undefined && AI_PROFILE_VALUES.includes(profile)) changes[flagPath(ACTOR_FLAGS.PROFILE)] = profile;
  if (priority !== undefined) {
    const value = Math.trunc(Number(priority));
    changes[flagPath(ACTOR_FLAGS.PRIORITY)] = Number.isFinite(value) ? value : AI_PRIORITY_DEFAULT;
  }
  if (conditions !== undefined) {
    changes[flagPath(ACTOR_FLAGS.CONDITIONS)] = conditions.map(normalizeStoredConditionEntry);
  }
  if (wasAggressed !== undefined) changes[flagPath(ACTOR_FLAGS.WAS_AGGRESSED)] = wasAggressed;
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

/** Write an Item's AI parameters. The AI Parameters dialog in `ui/item-parameters.mjs` saves through this. */
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

/** Whether an update carries a change to the module's mode flag, its removal included. */
export function changesCombatMode(changed) {
  const flags = changed.flags;
  const scope = flags?.[MODULE_ID];
  if (scope?.[COMBAT_FLAGS.MODE] !== undefined) return true;
  if (scope && Object.hasOwn(scope, `-=${COMBAT_FLAGS.MODE}`)) return true;
  if (flags && Object.hasOwn(flags, `-=${MODULE_ID}`)) return true;
  return false;
}

/* -------------------------------------------- */
/*  Stop mark                                   */
/* -------------------------------------------- */
/** Where the Enemy AI stopped driving after an uncertain outcome, as recorded on the encounter, or null. */
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

/** Record the Scene, encounter, phase and round where the Enemy AI stopped. Only the command host writes it. */
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

/** Set a paused encounter's mode aside on its Scene. Only the command host writes it. */
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
