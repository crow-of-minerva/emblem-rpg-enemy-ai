/** @layer driver */
import { AI_MODES } from '../constants.mjs';
import {
  clearPausedMode,
  documentByUuid,
  readCombatMode,
  readPausedMode,
  writeCombatMode,
  writePausedMode
} from '../foundry/flags.mjs';
import { encounterState } from '../foundry/system-bridge.mjs';

/* -------------------------------------------- */
/*  The encounter                               */
/* -------------------------------------------- */
/**
 * The Combat on the planner's Scene, or null for a planner with no Scene. The tracker and the module API find their
 * Combat differently (`app.viewed` and `modeEncounter`).
 */
export function encounterOf(planner) {
  if (!planner.sceneUuid) return null;
  return documentByUuid(encounterState(planner.sceneUuid)?.combatUuid ?? '');
}

/* -------------------------------------------- */
/*  The mode flag                               */
/* -------------------------------------------- */
/** The Enemy AI mode stored on an encounter. */
export function modeOf(combat) {
  return readCombatMode(combat);
}

/** Whether the GM has switched the AI on for this encounter. */
export function isEnabled(combat) {
  return modeOf(combat) !== 'off';
}

/** Store the Enemy AI mode on an encounter. */
export function setMode(combat, mode) {
  return writeCombatMode(combat, mode);
}

/** Step the mode on: off, on for one round, locked on. */
export function cycleMode(combat) {
  const next = AI_MODES[(AI_MODES.indexOf(modeOf(combat)) + 1) % AI_MODES.length];
  return setMode(combat, next);
}

/* -------------------------------------------- */
/*  Across a pause                              */
/* -------------------------------------------- */
/**
 * The mode each Combat had when a pause deleted it, by Scene uuid, held on this page until the pause commits. The
 * pause deletes the Combat and its mode flag with it, and the resume creates a new Combat.
 */
const pausingModes = new Map();

/** Note the mode on a Combat a pause is deleting. `foundry/hooks.mjs` calls this from `deleteCombat`. */
export function notePausingMode(combat) {
  const sceneUuid = String(combat?.scene?.uuid ?? '');
  if (sceneUuid) pausingModes.set(sceneUuid, modeOf(combat));
}

/** Once a pause commits, set the mode its Combat had aside on the Scene, where a reloaded host still finds it. */
export async function setPausedModeAside(sceneUuid) {
  const mode = pausingModes.get(sceneUuid);
  pausingModes.delete(sceneUuid);
  if (!mode) return false;
  return writePausedMode(documentByUuid(sceneUuid), mode);
}

/** Put a resumed encounter's set-aside mode on its new Combat, then clear the Scene's copy. */
export async function restorePausedMode(sceneUuid, combat) {
  const scene = documentByUuid(sceneUuid);
  const mode = readPausedMode(scene);
  if (!mode || !combat) return false;
  await setMode(combat, mode);
  await clearPausedMode(scene);
  return true;
}

/** Drop a Scene's set-aside mode once its paused encounter is discarded, or a battle there ends. */
export function forgetPausedMode(sceneUuid) {
  pausingModes.delete(sceneUuid);
  return clearPausedMode(documentByUuid(sceneUuid));
}
