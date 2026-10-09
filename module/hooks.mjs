/** @layer enemy-ai */
/* Every Foundry hook and system event the module listens to, and what each one starts. */
import { LOG, MODULE_ID } from './constants.mjs';
import { createEnemyAiApi } from './api.mjs';
import { CombatAI } from './combat-ai.mjs';
import { onActivationCommitted, onEncounterEnded, onExchangeCommitted } from './driver/aggression.mjs';
import {
  encounterOf,
  forgetPausedMode,
  isEnabled,
  modeOf,
  notePausingMode,
  restorePausedMode,
  setMode,
  setPausedModeAside
} from './driver/mode.mjs';
import { playsCurrentPhase, resumeAfterReload, runEnemyPhase, setResumePrompt } from './driver/phase.mjs';
import { requestAbort } from './driver/state.mjs';
import { forgetStaleStopMark } from './driver/stop-mark.mjs';
import { adoptSpawnBehavior, changesCombatMode } from './foundry/flags.mjs';
import {
  changesSystemSpawnBehavior,
  encounterState,
  isCommandHost,
  onCommittedEvent,
  reportStandDown,
  systemEventTypes,
  systemIntegrated,
  systemPhases
} from './foundry/system-bridge.mjs';
import { BOARD_MEMO_HOOKS, invalidateBoardMemo } from './planner/memo.mjs';
import { loadConditionRowPartial } from './ui/condition-rows.mjs';
import { injectControlPanelTray } from './ui/control-panel.mjs';
import { injectItemParametersButton } from './ui/item-parameters.mjs';
import { confirmResume } from './ui/resume-prompt.mjs';
import { installIntentProvider } from './ui/threat-intent.mjs';
import { injectTrackerControls } from './ui/tracker.mjs';

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */
/**
 * Install the module's Foundry hooks, and give the driver the dialog it asks the GM to resume with. Runs once, when
 * the module's entry file loads.
 */
export function installEnemyAiHooks() {
  setResumePrompt(confirmResume);
  // Registered first, so the map cache is empty before any other listener of the same hook reads the map.
  for (const hook of BOARD_MEMO_HOOKS) Hooks.on(hook, () => invalidateBoardMemo());
  Hooks.once('init', onInit);
  Hooks.once('ready', onReady);
  Hooks.on('updateCombat', onUpdateCombat);
  Hooks.on('canvasReady', onCanvasReady);
  Hooks.on('deleteCombat', combat => onDeleteCombat(combat));
  Hooks.on('updateActor', (document, changed) => onUpdateActor(document, changed));
  Hooks.on('preUpdateActor', (document, changed, options, userId) => vetoForeignFlagWrite(changed, userId));
  Hooks.on('preUpdateItem', (document, changed, options, userId) => vetoForeignFlagWrite(changed, userId));
  Hooks.on('renderEmblemCombatTracker', (application, element) => injectTrackerControls(application, element));
  Hooks.on('renderActorControlPanel', (application, element) => injectControlPanelTray(application, element)
    .catch(error => console.error(`${LOG} could not draw the Combat AI tab.`, error)));
  Hooks.on('renderItemSheetV2', (application, element) => injectItemParametersButton(application, element));
}

/**
 * Publish the module API, even when the system's API turns out to be too old for the rest of the module, and start
 * loading the condition row partial that the Combat AI tab and the Set Combat AI window draw with.
 */
function onInit() {
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = createEnemyAiApi();
  loadConditionRowPartial().catch(error => console.error(`${LOG} could not load the condition row template.`, error));
}

/**
 * Once the world is ready, listen for the system's events, register the threat-line helper and offer to resume. When
 * the module cannot run against this system, it does none of that, and warns a GM once and says what to update.
 */
function onReady() {
  if (!systemIntegrated()) {
    reportStandDown();
    return;
  }
  const events = systemEventTypes();
  // The system publishes these events only on the host client, so these handlers run only there.
  onCommittedEvent(events.ENCOUNTER_PHASE_ADVANCED, onPhaseAdvanced);
  onCommittedEvent(events.COMBAT_EXCHANGE_COMMITTED, onExchangeCommitted);
  onCommittedEvent(events.ITEM_ACTIVATION_COMMITTED, onActivationCommitted);
  onCommittedEvent(events.ENCOUNTER_ENDED, onEncounterClosed);
  onCommittedEvent(events.ENCOUNTER_BEGAN, onEncounterBegan);
  installIntentProvider();
  resumeAfterReload(CombatAI).catch(error => console.error(`${LOG} the resume check failed.`, error));
}

/* -------------------------------------------- */
/*  Committed events                            */
/* -------------------------------------------- */
/**
 * On the host client: when the player phase starts, turn "On" back to "Off"; when the enemy phase starts with the AI
 * on, play it on the Scene the event names.
 */
function onPhaseAdvanced(event) {
  if (!isCommandHost()) return;
  const data = event?.data ?? {};
  const sceneUuid = String(data.sceneUuid ?? '');
  if (!sceneUuid || !encounterState(sceneUuid)) return;
  const planner = CombatAI.forScene(sceneUuid);
  const combat = encounterOf(planner);
  forgetStaleStopMark(planner);
  const phases = systemPhases();
  if (data.previousPhase === phases.ENEMY && data.phase === phases.PLAYER && modeOf(combat) === 'on') {
    Promise.resolve(setMode(combat, 'off'))
      .catch(error => console.error(`${LOG} could not switch the AI off after its round.`, error));
    return;
  }
  if (data.phase !== phases.ENEMY) return;
  if (!isEnabled(combat)) return;
  runEnemyPhase(CombatAI, { sceneUuid }).catch(error => console.error(`${LOG} the phase run failed.`, error));
}

/**
 * A battle that has ended keeps no pursuit memory, aggression marks, profile switches or set-aside mode, while a paused
 * one keeps them all and sets its mode aside on the Scene for the resume. A pause the system does not report reads
 * as an end.
 */
function onEncounterClosed(event) {
  const sceneUuid = String(event?.data?.sceneUuid ?? '');
  if (encounterState(sceneUuid)?.paused === true) {
    return setPausedModeAside(sceneUuid)
      .catch(error => console.error(`${LOG} could not keep the AI mode across the pause.`, error));
  }
  CombatAI.clearMemory(sceneUuid);
  forgetPausedMode(sceneUuid)
    .catch(error => console.error(`${LOG} could not clear a paused encounter's AI mode.`, error));
  return onEncounterEnded(event);
}

/** On the host client, a resumed battle takes back the mode its pause set aside. */
function onEncounterBegan(event) {
  if (!isCommandHost()) return;
  const sceneUuid = String(event?.data?.sceneUuid ?? '');
  if (encounterState(sceneUuid)?.started !== true) return;
  restorePausedMode(sceneUuid, encounterOf(CombatAI.forScene(sceneUuid)))
    .catch(error => console.error(`${LOG} could not restore the AI mode after a pause.`, error));
}

/* -------------------------------------------- */
/*  Document hooks                              */
/* -------------------------------------------- */
/**
 * On the host client, start or stop the AI when its mode flag is written or removed on an encounter, never while the
 * module is switched off. Off stops a run after its current action while its enemy phase is under way, and a start
 * runs on the encounter's own Scene.
 */
function onUpdateCombat(combat, changed) {
  if (!isCommandHost() || !systemIntegrated()) return;
  if (!changesCombatMode(changed)) return;
  if (!isEnabled(combat)) {
    if (playsCurrentPhase(combat.uuid)) requestAbort();
    return;
  }
  const sceneUuid = String(combat.scene?.uuid ?? '');
  const state = encounterState(sceneUuid);
  if (!state || state.combatUuid !== combat.uuid) return;
  if (combat.started !== true) return;
  if (state.phase !== systemPhases().ENEMY) return;
  runEnemyPhase(CombatAI, { sceneUuid }).catch(error => console.error(`${LOG} the phase run failed.`, error));
}

/**
 * A deleted encounter takes its Scene's battle memory with it, unless the system deleted it to pause the battle.
 * On the host client, the paused Combat's mode is noted for `onEncounterClosed` to set aside.
 */
function onDeleteCombat(combat) {
  const sceneUuid = String(combat?.scene?.uuid ?? '');
  if (!systemIntegrated() || encounterState(sceneUuid)?.paused !== true) {
    CombatAI.clearMemory(sceneUuid);
    return;
  }
  if (isCommandHost()) notePausingMode(combat);
}

/** When a terrain spawn writes its order onto the arriving unit, copy it into the unit's AI conditions. */
function onUpdateActor(actor, changed) {
  if (!isCommandHost()) return;
  if (!changesSystemSpawnBehavior(changed)) return;
  adoptSpawnBehavior(actor).catch(error => console.error(`${LOG} could not adopt a spawn order.`, error));
}

/**
 * When the canvas is drawn, offer to resume an interrupted phase. Each Scene keeps its own battle memory until its
 * encounter ends, so switching Scenes mid-battle or during a pause loses nothing.
 */
function onCanvasReady() {
  resumeAfterReload(CombatAI).catch(error => console.error(`${LOG} the resume check failed.`, error));
}

/**
 * Block a non-GM user's update that touches this module's flags. Foundry runs preUpdate hooks only on the client
 * making the change, so this guards the user interface; it is not a permission check.
 */
function vetoForeignFlagWrite(changed, userId) {
  if (isGamemaster(userId)) return true;
  if (!touchesModuleFlags(changed)) return true;
  console.warn(`${LOG} refused a non-Gamemaster write to the module's flags.`);
  return false;
}

/** Whether an update names the module's flag scope, expanded or as a dotted path. */
function touchesModuleFlags(changed) {
  if (!changed || typeof changed !== 'object') return false;
  if (changed.flags?.[MODULE_ID] !== undefined) return true;
  return Object.keys(changed).some(key => key.startsWith(`flags.${MODULE_ID}`));
}

/** Whether the user behind an update is a Gamemaster. */
function isGamemaster(userId) {
  const user = game.users.get(userId);
  if (user) return user.isGM;
  return game.user.id === userId && game.user.isGM;
}
