/** @layer foundry */
import { LOG, MODULE_ID } from '../constants.mjs';
import { createEnemyAiApi } from '../api.mjs';
import { CombatAI } from '../combat-ai.mjs';
import { onActivationCommitted, onEncounterEnded, onExchangeCommitted } from '../driver/aggression.mjs';
import {
  encounterOf,
  forgetPausedMode,
  isEnabled,
  modeOf,
  notePausingMode,
  restorePausedMode,
  setMode,
  setPausedModeAside
} from '../driver/mode.mjs';
import { resumeAfterReload, runEnemyPhase } from '../driver/phase.mjs';
import { drivesEncounter, requestAbort } from '../driver/state.mjs';
import { forgetStaleStopMark } from '../driver/stop-mark.mjs';
import { BOARD_MEMO_HOOKS, invalidateBoardMemo } from '../planner/memo.mjs';
import { injectControlPanelTray } from '../ui/control-panel.mjs';
import { injectItemParametersButton } from '../ui/item-parameters.mjs';
import { installIntentProvider } from '../ui/threat-intent.mjs';
import { injectTrackerControls } from '../ui/tracker.mjs';
import { adoptSpawnBehavior, changesCombatMode, changesSpawnBehavior } from './flags.mjs';
import {
  encounterState,
  isCommandHost,
  onCommittedEvent,
  reportStandDown,
  systemEventTypes,
  systemIntegrated
} from './system-bridge.mjs';

/* -------------------------------------------- */
/*  Phase names                                 */
/* -------------------------------------------- */
/** The phases `onPhaseAdvanced` and `onUpdateCombat` compare against. */
const ENEMY_PHASE = 'Enemy';
const PLAYER_PHASE = 'Player';

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */
/** Install the module's Foundry hooks. The module's entry file calls this once, when the module loads. */
export function installEnemyAiHooks() {
  Hooks.once('init', onInit);
  Hooks.once('ready', onReady);
  Hooks.on('updateCombat', onUpdateCombat);
  Hooks.on('canvasReady', onCanvasReady);
  Hooks.on('deleteCombat', combat => onDeleteCombat(combat));
  for (const hook of BOARD_MEMO_HOOKS) Hooks.on(hook, () => invalidateBoardMemo());
  Hooks.on('updateActor', (document, changed) => onUpdateActor(document, changed));
  Hooks.on('preUpdateActor', (document, changed, options, userId) => vetoForeignFlagWrite(changed, userId));
  Hooks.on('preUpdateItem', (document, changed, options, userId) => vetoForeignFlagWrite(changed, userId));
  Hooks.on('renderEmblemCombatTracker', (application, element) => injectTrackerControls(application, element));
  Hooks.on('renderActorControlPanel', (application, element) => injectControlPanelTray(application, element));
  Hooks.on('renderItemSheet', (application, element, context) =>
    injectItemParametersButton(application, element, context));
}

/** Publish the module API, whether or not the system's API version turns out to pass `systemIntegrated`. */
function onInit() {
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = createEnemyAiApi();
}

/**
 * Wire the committed events, the intent line and the resume check once the system's API version passes
 * `systemIntegrated`, or say once why the module stands down.
 */
function onReady() {
  if (!systemIntegrated()) {
    reportStandDown();
    return;
  }
  const events = systemEventTypes();
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
 * On a phase change, on the command host only: a one-round mode switches itself off when the player phase begins,
 * and an enemy phase with the AI on starts a run on the Scene the event names.
 */
function onPhaseAdvanced(event) {
  if (!isCommandHost()) return;
  const data = event?.data ?? {};
  const sceneUuid = String(data.sceneUuid ?? '');
  if (!sceneUuid || !encounterState(sceneUuid)) return;
  const planner = CombatAI.forScene(sceneUuid);
  const combat = encounterOf(planner);
  forgetStaleStopMark(planner);
  if (data.previousPhase === ENEMY_PHASE && data.phase === PLAYER_PHASE && modeOf(combat) === 'on') {
    Promise.resolve(setMode(combat, 'off'))
      .catch(error => console.error(`${LOG} could not switch the AI off after its round.`, error));
    return;
  }
  if (data.phase !== ENEMY_PHASE) return;
  if (!isEnabled(combat)) return;
  runEnemyPhase(planner).catch(error => console.error(`${LOG} the phase run failed.`, error));
}

/**
 * A battle that has ended keeps no pursuit memory, no aggression marks and no set-aside mode. A paused battle keeps
 * all of them, and its mode is set aside on the Scene for the resume. A system that does not report the pause in its
 * encounter state reads as an end.
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

/** On the command host, a resumed battle takes back the mode its pause set aside. */
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
 * Start or abort the AI when its mode flag is written or removed on an encounter. Any change to Off stops a run driving
 * that encounter at its next safe boundary. A start runs on the encounter's own Scene.
 */
function onUpdateCombat(combat, changed) {
  if (!isCommandHost()) return;
  if (!changesCombatMode(changed)) return;
  if (!isEnabled(combat)) {
    if (drivesEncounter(combat.uuid)) requestAbort();
    return;
  }
  const sceneUuid = String(combat.scene?.uuid ?? '');
  const state = encounterState(sceneUuid);
  if (!state || state.combatUuid !== combat.uuid) return;
  if (combat.started !== true) return;
  if (state.phase !== ENEMY_PHASE) return;
  runEnemyPhase(CombatAI, { sceneUuid }).catch(error => console.error(`${LOG} the phase run failed.`, error));
}

/**
 * A deleted encounter takes its Scene's battle memory with it, unless the system deleted it to pause the battle.
 * On the command host, the paused Combat's mode is noted for `onEncounterClosed` to set aside.
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
  if (!changesSpawnBehavior(changed)) return;
  adoptSpawnBehavior(actor).catch(error => console.error(`${LOG} could not adopt a spawn order.`, error));
}

/**
 * When the canvas is drawn, drop the board memo, then offer to pick an interrupted phase up. The battle memory stays:
 * each Scene keeps its own, and only an ended encounter clears it, so a Scene switch mid-battle or during a pause
 * loses nothing.
 */
function onCanvasReady() {
  invalidateBoardMemo();
  resumeAfterReload(CombatAI).catch(error => console.error(`${LOG} the resume check failed.`, error));
}

/** Refuse a non-GM write that touches the module's flag scope, since only a GM authors AI settings. */
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
