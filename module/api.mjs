/** @layer enemy-ai */
/*
 * The module API, published on the module's `api` property at init: an encounter's Enemy AI mode, running and stopping
 * an enemy phase, and the Set Combat AI on Selected window. It is published even when the system's API is too old for
 * the rest of the module.
 */
import { API_VERSION } from './constants.mjs';
import { CombatAI } from './combat-ai.mjs';
import { cycleMode, isEnabled, modeOf, setMode } from './driver/mode.mjs';
import { runEnemyPhase } from './driver/phase.mjs';
import { isRunning, requestAbort } from './driver/state.mjs';
import { modeEncounter, systemIntegrated } from './foundry/system-bridge.mjs';
import { openMassEditDialog } from './ui/mass-edit.mjs';

/* -------------------------------------------- */
/*  The published API                           */
/* -------------------------------------------- */
/**
 * The frozen module API, published at game.modules.get('emblem-rpg-enemy-ai').api during init. The system's Configure
 * Combat AI macro opens Set Combat AI on Selected through `openMassEdit`.
 */
export function createEnemyAiApi() {
  return Object.freeze({
    version: API_VERSION,
    mode: target => modeOf(modeEncounter(target)),
    isEnabled: target => isEnabled(modeEncounter(target)),
    setMode: (target, mode) => setMode(modeEncounter(target), mode),
    cycleMode: target => cycleMode(modeEncounter(target)),
    isRunning,
    runEnemyPhase: intent => runEnemyPhase(CombatAI, intent),
    requestAbort,
    openMassEdit: openMassEditDialog,
    systemIntegrated
  });
}
