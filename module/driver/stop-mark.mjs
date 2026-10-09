/** @layer driver */
/*
 * The stop mark. When a run stops after an uncertain result, the phase is recorded on the encounter's Combat, so
 * neither this client nor a reloaded host client plays or offers that phase again.
 */
import { LOG } from '../constants.mjs';
import { documentByUuid } from '../foundry/documents.mjs';
import { clearStopMark, readStopMark, writeStopMark } from '../foundry/flags.mjs';
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
 * Whether this phase was stopped after an uncertain outcome, by this client or by the host client before a reload,
 * which recorded it on the encounter. It only reads; `forgetStaleStopMark` clears a mark an earlier phase left.
 */
export function phaseStopped(state) {
  if (phaseWasStopped(phaseKey(state))) return true;
  const mark = readStopMark(documentByUuid(state.combatUuid ?? ''));
  return mark !== null && phaseKey(mark) === phaseKey(state);
}

/** On the host client as each phase begins, clear the stop mark an earlier phase or round left on the encounter. */
export function forgetStaleStopMark(planner) {
  const state = encounterState(planner.sceneUuid);
  const combat = documentByUuid(state?.combatUuid ?? '');
  const mark = readStopMark(combat);
  if (!mark || phaseKey(mark) === phaseKey(state)) return;
  Promise.resolve(clearStopMark(combat))
    .catch(error => console.error(`${LOG} could not clear an earlier phase's Enemy AI stop mark.`, error));
}

/** Record the uncertain stop on the encounter, so a reloaded host client neither plays nor offers this phase again. */
export async function markStopped(run) {
  markPhaseStopped(phaseKey(run));
  try {
    await writeStopMark(documentByUuid(run.combatUuid), run);
  } catch (error) {
    console.error(`${LOG} could not record where the Enemy AI stopped; a reload may offer this phase again.`, error);
  }
}
