/** @layer driver */
import { LOG } from '../constants.mjs';
import { clearStopMark, documentByUuid, readStopMark, writeStopMark } from '../foundry/flags.mjs';
import { encounterState } from '../foundry/system-bridge.mjs';
import { markPhaseStopped, phaseWasStopped } from './state.mjs';

/* -------------------------------------------- */
/*  Uncertain stops                             */
/* -------------------------------------------- */
/** A key naming one phase: the Scene, encounter, phase and round a run or an encounter state belongs to. */
export function phaseKey(phase) {
  return [phase.sceneUuid ?? '', phase.combatUuid ?? '', phase.phase ?? '', phase.round ?? ''].join('|');
}

/**
 * Whether this phase was stopped after an uncertain outcome, by this page or by an earlier host page that recorded
 * it on the encounter before a reload. A mark an earlier phase or round left is cleared instead.
 */
export function phaseStopped(state) {
  if (phaseWasStopped(phaseKey(state))) return true;
  const combat = documentByUuid(state.combatUuid ?? '');
  const mark = readStopMark(combat);
  if (!mark) return false;
  if (phaseKey(mark) === phaseKey(state)) return true;
  Promise.resolve(clearStopMark(combat))
    .catch(error => console.error(`${LOG} could not clear an earlier phase's Enemy AI stop mark.`, error));
  return false;
}

/** Clear the stop mark on a planner's encounter once its phase or round has moved on. */
export function forgetStaleStopMark(planner) {
  const state = encounterState(planner.sceneUuid);
  if (state?.combatUuid) phaseStopped(state);
}

/** Record the uncertain stop on the encounter, so a reloaded host page neither drives nor offers this phase again. */
export async function markStopped(run) {
  markPhaseStopped(phaseKey(run));
  try {
    await writeStopMark(documentByUuid(run.combatUuid), run);
  } catch (error) {
    console.error(`${LOG} could not record where the Enemy AI stopped; a reload may offer this phase again.`, error);
  }
}
