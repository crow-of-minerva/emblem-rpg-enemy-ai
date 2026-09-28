/** @layer enemy-ai */
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
 * The frozen module API, which `onInit` in `foundry/hooks.mjs` publishes at
 * game.modules.get('emblem-rpg-enemy-ai').api. The system's "Configure Combat AI" macro calls `openMassEdit`, the
 * multi-actor AI editor in `ui/mass-edit.mjs`.
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
