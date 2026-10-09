/** @layer driver */
/*
 * Playing the enemy phase on the host client. A run takes the system's execution segment, its exclusive right to run
 * the system's commands, and the board hold, a movement lock that stops everyone moving tokens by hand.
 */
import { LOG } from '../constants.mjs';
import { startedEncounterSceneUuids } from '../foundry/documents.mjs';
import {
  commandHostStatus,
  encounterState,
  enemyPhaseCamera,
  holdBoard,
  isCommandHost,
  releaseBoard,
  reportStandDown,
  systemIntegrated,
  systemLifecycleStates,
  systemPhases,
  systemResultCodes
} from '../foundry/system-bridge.mjs';
import { board, unitByTokenUuid } from '../planner/board.mjs';
import { orderForPhase, triage, yieldsToPendingAlly } from '../planner/phase-roster.mjs';
import { isManual, partitionManual, profileOf } from '../planner/profile.mjs';
import { isAlive } from '../planner/readiness.mjs';
import { collectUnits, isEligibleUnit } from '../planner/roster.mjs';
import { awaitMarkWrites } from './aggression.mjs';
import { encounterOf, isEnabled } from './mode.mjs';
import { awaitSettled, delay } from './pacing.mjs';
import { ExecutionSegmentRunner, HALT_REASONS, isDriveHalted } from './segment.mjs';
import {
  abortOnSystemStop,
  abortWanted,
  activeRun,
  attachAbortKey,
  beginRun,
  detachAbortKey,
  drivesEncounter,
  endRun,
  holdsBoard,
  isRunning,
  joinResumeCheck,
  markBoardHeld,
  markBoardReleased,
  markPhaseRan,
  markResumeOffered,
  phaseWasRun,
  resumeWasOffered
} from './state.mjs';
import { markStopped, phaseKey, phaseStopped } from './stop-mark.mjs';
import { EXECUTION_TIMING, IDLE_TURN_YIELD_MS, MANUAL_POLL_MS, UNIT_HANDOFF_DELAY_MS } from './timing.mjs';
import { SWITCHED_TO_MANUAL, clearMarkIfTurnEnded, endTurn, recoverFailedUnit, takeTurn } from './turn.mjs';

/* -------------------------------------------- */
/*  One run                                     */
/* -------------------------------------------- */
/**
 * Why a run stopped before playing its whole queue. A stop inside one of the system's actions is not listed here: the
 * execution segment keeps it as its `halt`, with one of the `HALT_REASONS`.
 */
export const RUN_STOPS = Object.freeze({
  /** The GM pressed Space twice, or a GM asked the system to stop the AI. */
  ABORTED: 'aborted',
  /** The map was still busy with animations or saves when the wait before a turn ran out. */
  STALLED: 'stalled',
  /**
   * The run is no longer wanted: the AI was switched off, the phase moved on, this client stopped being the host
   * client, or the host client is still starting up.
   */
  STOOD_DOWN: 'stood-down',
  /** The system refused the board hold that locks manual movement. */
  HOLD_REFUSED: 'hold-refused',
  /** An earlier run on this client left its board hold in place, and it still could not be released. */
  LEFTOVER_HOLD: 'leftover-hold',
  /** The board hold or the execution segment could not be given up for a Manual unit's turn. */
  HANDOFF_FAILED: 'handoff-failed',
  /** The system refused the execution segment as the phase began. */
  ACQUIRE_REFUSED: 'acquire-refused',
  /** The system refused the execution segment back after a Manual unit's turn. */
  REACQUIRE_REFUSED: 'reacquire-refused'
});

/**
 * One enemy phase as the AI plays it: its queue, the units that failed, its execution segment, why it stopped, and
 * what its teardown could not undo.
 */
class PhaseRun {
  constructor(state) {
    this.summary = [];
    this.failed = [];
    this.queue = [];
    /** Why the run stopped, one of {@link RUN_STOPS}, or null while it may go on. */
    this.stop = null;
    /** The system's result code when it refused the execution segment, else ''. */
    this.stopCode = '';
    /**
     * The host client refused the execution segment because it is still starting up. The phase does not count as run,
     * so the resume check can offer it to the GM.
     */
    this.recovering = false;
    /** Set by the teardown when the board hold could not be released. */
    this.releaseFailed = false;
    /** Set by the teardown when the execution segment could not be closed. */
    this.closeFailed = false;
    this.haltedUnit = '';
    this.segment = null;
    this.cameraOn = false;
    this.idled = 0;
    this.sceneUuid = state.sceneUuid;
    this.combatUuid = state.combatUuid;
    this.phase = state.phase;
    this.round = state.round ?? null;
  }

  /** The gameplay methods bound to this run's execution segment. */
  get gameplay() {
    return this.segment.actions;
  }

  /**
   * Record why the run stops. The first stop wins, so a later check cannot replace the reason the GM is told.
   * @param {string} reason One of {@link RUN_STOPS}.
   * @param {string} [code] The system's result code, when it refused the execution segment.
   */
  stopWith(reason, code = '') {
    if (this.stop) return;
    this.stop = reason;
    this.stopCode = code;
  }

  /** Whether the run may no longer read or play the roster: it stopped, or the segment halted an action. */
  get blocked() {
    return this.stop !== null || Boolean(this.segment.halt);
  }

  /**
   * Whether the run stopped because an action's result is unknown or this client stopped being the host, so this
   * phase must not be played again.
   */
  get uncertain() {
    const reason = this.segment.halt?.reason;
    return reason === HALT_REASONS.UNKNOWN || reason === HALT_REASONS.AUTHORITY;
  }
}

/* -------------------------------------------- */
/*  Playing the phase                           */
/* -------------------------------------------- */
/**
 * On the host client, when the enemy phase begins or the AI is switched on during it, play the whole phase on one
 * Scene, one unit at a time. The Scene is the one named, else the only started encounter's, never simply the Scene
 * the host client is showing.
 * @param {import('../planner/scene.mjs').ScenePlanners} planners Every Scene's planner; the run takes its Scene's.
 * @param {{sceneUuid?: string}} [intent] The encounter's Scene.
 * @returns {Promise<object[]>} What each unit did.
 */
export async function runEnemyPhase(planners, intent = {}) {
  if (!systemIntegrated()) {
    reportStandDown();
    return [];
  }
  if (!isCommandHost()) return [];
  if (isRunning()) return [];
  const named = String(intent?.sceneUuid ?? '');
  const state = encounterState(named || soleEncounterSceneUuid());
  if (!state?.sceneUuid || !state.combatUuid || state.started !== true
    || state.phase !== systemPhases().ENEMY) return [];
  if (phaseStopped(state)) {
    globalThis.ui?.notifications?.warn('Enemy AI stopped this phase after an uncertain result. '
      + 'Run the remaining units manually.');
    return [];
  }
  return drivePhase(planners, state);
}

/**
 * The run itself, on the planner of the encounter's Scene. When the host client refused the run because it is still
 * starting up, the resume check takes over once the run has ended, and offers the phase to the GM once the host is
 * ready.
 */
async function drivePhase(planners, state) {
  const planner = planners.forScene(state.sceneUuid);
  if (board(planner)?.exploration === true) return [];
  const run = new PhaseRun(state);
  run.segment = new ExecutionSegmentRunner();
  beginRun(run);
  try {
    // A board hold this client could not release after an earlier run. The teardown tries the release once more.
    if (holdsBoard() && !await releaseTheBoard()) {
      run.stopWith(RUN_STOPS.LEFTOVER_HOLD);
      return [];
    }
    await preparePhase(planner, run);
    if (!run.blocked) await runQueue(planner, run);
  } catch (error) {
    if (!isDriveHalted(error)) {
      console.error(`${LOG} the enemy phase failed.`, error);
      globalThis.ui?.notifications?.error('Enemy AI ran into an error. Run the remaining units manually.');
    }
  } finally {
    if (!run.recovering) markPhaseRan(phaseKey(run));
    await teardownPhase(planner, run);
    if (run.uncertain) await markStopped(run);
    reportPhase(planner, run);
    if (run.recovering) {
      resumeAfterReload(planners).catch(error => console.error(`${LOG} the resume check failed.`, error));
    }
  }
  return run.summary;
}

/**
 * Wait for a quiet map, take the execution segment and the board hold, and wait for aggression marks still being
 * saved. Then end the turns of idle units and put the rest in acting order.
 */
async function preparePhase(planner, run) {
  const settled = await awaitSettled({ label: 'the enemy phase' });
  if (stopIfAborted(run)) return;
  if (!settled) run.stopWith(RUN_STOPS.STALLED);
  if (!stillCurrent(run) || run.blocked) return;
  if (!await openSegment(planner, run)) return;
  if (!await takeTheBoard()) {
    run.stopWith(RUN_STOPS.HOLD_REFUSED);
    return;
  }
  await awaitMarkWrites();
  stopIfAborted(run);
  if (!stillCurrent(run)) return;
  const roster = run.blocked ? { driven: [], manual: [] } : partitionManual(collectUnits(planner));
  const { acting, idle } = run.blocked ? { acting: [], idle: [] } : triage(planner, roster.driven);
  await endIdleTurns(run, idle);
  run.queue = run.blocked ? [] : orderForPhase(planner, [...acting, ...roster.manual]);
}

/** End the turns of units that have nothing to do as the phase starts. */
async function endIdleTurns(run, idle) {
  for (const unit of idle) {
    if (!stillCurrent(run)) break;
    if (stopIfAborted(run)) break;
    const live = unitByTokenUuid(unit.tokenUuid);
    if (!live || live.turn?.turnComplete === true) continue;
    try {
      await endTurn(live, { actions: run.gameplay });
      run.idled += 1;
    } catch (error) {
      if (isDriveHalted(error)) {
        noteHalt(run, unit);
        break;
      }
      console.error(`${LOG} could not end ${unit.name}'s turn.`, error);
    }
    await delay(IDLE_TURN_YIELD_MS);
  }
}

/**
 * Play the queue one unit at a time, with the camera on and a wait for a quiet map before every turn; a unit leaves
 * the queue only once its turn may start, so a stop before then still counts it as left to play. A unit that should
 * let a pending ally move first goes to the back once per phase, and a Manual unit pauses the run at its place, as
 * does one a Switch AI Profile condition makes Manual in its turn.
 */
async function runQueue(planner, run) {
  if (!run.queue.length) return;
  run.cameraOn = true;
  await camera('begin');
  const stoodAside = new Set();
  while (run.queue.length) {
    if (stopIfAborted(run)) break;
    if (!await readyForTurn(run, run.queue[0])) break;
    const unit = unitByTokenUuid(run.queue.shift().tokenUuid);
    if (!unit || unit.turn?.turnComplete === true || !isEligibleUnit(unit)) continue;
    if (isManual(unit)) {
      if (!await holdForManual(planner, run, unit)) break;
      continue;
    }
    if (run.queue.length && !stoodAside.has(unit.tokenId) && yieldsToPendingAlly(planner, unit, run.queue)) {
      stoodAside.add(unit.tokenId);
      run.queue.push(unit);
      continue;
    }
    const handedOver = await playUnit(planner, run, unit);
    if (run.blocked) break;
    if (handedOver && !await holdForManual(planner, run, unit)) break;
  }
}

/**
 * The wait before a turn: first for a quiet map, then for any aggression marks still being saved, so the unit's plan
 * sees them.
 */
async function readyForTurn(run, unit) {
  const settled = await awaitSettled({ label: `${unit.name}'s turn` });
  await awaitMarkWrites();
  if (stopIfAborted(run)) return false;
  if (!settled) {
    run.stopWith(RUN_STOPS.STALLED);
    return false;
  }
  return stillCurrent(run);
}

/**
 * Play one unit's turn. An error is logged and the run moves on to the next unit, but a halt stops the whole run.
 * @returns {Promise<boolean>} Whether a Switch AI Profile condition made the unit Manual, leaving its turn to the GM.
 */
async function playUnit(planner, run, unit) {
  if (!await holdBoard({ label: 'Enemy Phase', tokenName: unit.name, tokenImg: unit.img })) {
    run.stopWith(RUN_STOPS.HOLD_REFUSED);
    return false;
  }
  if (!stillCurrent(run)) return false;
  let engaged = false;
  let handedOver = false;
  const onEngage = async () => {
    engaged = true;
    await camera('focus', unit.tokenUuid);
  };
  try {
    const result = await takeTurn(planner, unit, { onEngage, actions: run.gameplay });
    run.summary.push({ name: unit.name, profile: profileOf(unit), ...result });
    handedOver = result.reason === SWITCHED_TO_MANUAL;
  } catch (error) {
    if (isDriveHalted(error)) {
      noteHalt(run, unit);
      run.summary.push({ name: unit.name, acted: false, didSomething: engaged, reason: `halted-${error.reason}` });
      // A stop during the unit's last action halts before its end turn, so its spent turn would keep the mark.
      await clearMarkIfTurnEnded(unit)
        .catch(markError => console.warn(`${LOG} could not clear ${unit.name}'s aggression mark.`, markError));
      return false;
    }
    console.error(`${LOG} ${unit.name} failed its turn; continuing.`, error);
    run.failed.push(unit.name);
    run.summary.push({ name: unit.name, acted: false, didSomething: false, reason: 'error', error: error?.message });
    await recoverFailedUnit(unit, run.gameplay);
  }
  if (run.segment.halt) {
    noteHalt(run, unit);
    return false;
  }
  const drained = await awaitSettled({ label: `the turn after ${unit.name}` });
  if (stopIfAborted(run)) return false;
  if (!drained) run.stopWith(RUN_STOPS.STALLED);
  else if (engaged) await delay(UNIT_HANDOFF_DELAY_MS);
  return handedOver;
}

/* -------------------------------------------- */
/*  Manual turns                                */
/* -------------------------------------------- */
/**
 * A manual unit pauses the run: the board hold and the execution segment are given up for that one turn, and the run
 * takes both back once the GM ends it.
 */
async function holdForManual(planner, run, unit) {
  await camera('focus', unit.tokenUuid);
  if (!await releaseTheBoard() || !await run.segment.release()) {
    run.stopWith(RUN_STOPS.HANDOFF_FAILED);
    return false;
  }
  if (!await awaitManualTurns(planner, [unit], run)) return false;
  if (!stillCurrent(run)) return false;
  if (!await reacquireSegment(planner, run)) return false;
  if (!await takeTheBoard()) {
    run.stopWith(RUN_STOPS.HOLD_REFUSED);
    return false;
  }
  const settled = await awaitSettled({ label: `${unit.name}'s manual turn` });
  if (stopIfAborted(run)) return false;
  if (!settled) {
    run.stopWith(RUN_STOPS.STALLED);
    return false;
  }
  return stillCurrent(run);
}

/** Wait while the GM plays units by hand, re-reading the map on a short timer until their turns end. */
async function awaitManualTurns(planner, units, run) {
  const pending = () => units
    .map(entry => unitByTokenUuid(entry.tokenUuid))
    .filter(live => live && isAlive(live) && live.turn?.turnComplete !== true);
  let waiting = pending();
  if (!waiting.length) return true;
  const names = waiting.map(entry => entry.name).join(', ');
  const plural = waiting.length > 1 ? 'their turns' : 'its turn';
  globalThis.ui?.notifications?.info(`Enemy AI is waiting for ${names}. End ${plural} to continue.`);
  while (waiting.length) {
    await delay(MANUAL_POLL_MS);
    if (stopIfAborted(run)) return false;
    if (!isEnabled(encounterOf(planner))) {
      run.stopWith(RUN_STOPS.STOOD_DOWN);
      return false;
    }
    if (!stillCurrent(run)) return false;
    waiting = pending();
  }
  return true;
}

/* -------------------------------------------- */
/*  Board hold and execution segment            */
/* -------------------------------------------- */
/**
 * Take the system's board hold and start listening for the double-Space abort. The hold is a world setting that
 * survives a reload, while `holdsBoard()` is only this client's memory of having taken it.
 */
async function takeTheBoard() {
  if (holdsBoard()) return true;
  if (!await holdBoard({ label: 'Enemy Phase' })) return false;
  markBoardHeld();
  attachAbortKey();
  return true;
}

/** Release the board hold, for a manual unit's turn or at the end of the run, and stop listening for the abort key. */
async function releaseTheBoard() {
  if (!holdsBoard()) return true;
  if (await releaseBoard() !== true) return false;
  markBoardReleased();
  detachAbortKey();
  return true;
}

/** Whether the run is still wanted: nobody asked it to stop, the AI is on, and its phase is still current. */
function runStillWanted(planner, run) {
  return !abortWanted() && isEnabled(encounterOf(planner)) && phaseStillCurrent(run);
}

/**
 * Open the run's execution segment, waiting only while the run is still wanted. A refusal because the host client is
 * still starting up stops the run without a notice and marks it `recovering`.
 */
async function openSegment(planner, run) {
  const result = await run.segment.open({ revalidate: () => runStillWanted(planner, run) });
  if (result?.ok === true) return true;
  if (result?.code === systemResultCodes().RECOVERY_STARTING) {
    run.stopWith(RUN_STOPS.STOOD_DOWN);
    run.recovering = true;
    return false;
  }
  noteRefusal(planner, run, result, RUN_STOPS.ACQUIRE_REFUSED);
  return false;
}

/** Take the execution segment back after a manual unit's turn. The run is checked again before and after. */
async function reacquireSegment(planner, run) {
  const result = await run.segment.reacquire({ revalidate: () => runStillWanted(planner, run) });
  if (result?.ok === true) return true;
  noteRefusal(planner, run, result, RUN_STOPS.REACQUIRE_REFUSED);
  return false;
}

/**
 * Record why the segment was not taken: an abort, a run no longer wanted, or a refusal the GM is told about.
 * @param {string} reason The stop for a refusal: `RUN_STOPS.ACQUIRE_REFUSED` or `RUN_STOPS.REACQUIRE_REFUSED`.
 */
function noteRefusal(planner, run, result, reason) {
  if (stopIfAborted(run)) return;
  if (!isEnabled(encounterOf(planner)) || !phaseStillCurrent(run)) run.stopWith(RUN_STOPS.STOOD_DOWN);
  else run.stopWith(reason, String(result?.code ?? 'unknown'));
}

/**
 * Record which unit's turn the segment's halt interrupted. A halt for a stop request counts as an abort, and one asked
 * for by a GM through the system switches the AI off here.
 */
function noteHalt(run, unit) {
  run.haltedUnit ||= unit.name ?? '';
  if (run.segment.halt?.reason !== HALT_REASONS.ABORT) return;
  abortOnSystemStop();
  run.stopWith(RUN_STOPS.ABORTED);
}

/**
 * Undo what the run took: end the camera, release the board hold, then close the execution segment. The segment is
 * closed and the run ended even when the release fails.
 */
async function teardownPhase(planner, run) {
  try {
    if (run.cameraOn) await camera('end');
    run.releaseFailed = !await releaseTheBoard();
  } catch (error) {
    run.releaseFailed = true;
    console.error(`${LOG} could not release the Enemy AI board hold.`, error);
  } finally {
    await closeSegment(run);
    endRun();
  }
}

/** Close the run's execution segment. By teardown, every action the run started has finished. */
async function closeSegment(run) {
  try {
    if (!await run.segment.close()) run.closeFailed = true;
  } catch (error) {
    run.closeFailed = true;
    console.error(`${LOG} could not close the Enemy AI execution segment.`, error);
  }
}

/** Play one enemy-phase camera beat on every client. A camera failure is logged and never stops the run. */
async function camera(beat, tokenUuid = '') {
  try {
    await enemyPhaseCamera(beat, tokenUuid);
  } catch (error) {
    console.warn(`${LOG} the enemy-phase camera ${beat} beat failed.`, error);
  }
}

/* -------------------------------------------- */
/*  Where the run stands                        */
/* -------------------------------------------- */
/** Whether this client is still the host client, on the Scene, encounter, phase and round where the run began. */
function phaseStillCurrent(run) {
  const state = encounterState(run.sceneUuid);
  return isCommandHost() && state?.started === true
    && state.sceneUuid === run.sceneUuid && state.combatUuid === run.combatUuid
    && state.phase === run.phase && (state.round ?? null) === run.round;
}

/**
 * Whether this client is playing the encounter's phase and that phase is still under way. A run still finishing after
 * the phase moved on stands down by itself before its next action, so it needs no stop request.
 * @param {string} combatUuid The encounter asked about.
 * @returns {boolean}
 */
export function playsCurrentPhase(combatUuid) {
  return drivesEncounter(combatUuid) && phaseStillCurrent(activeRun());
}

/** Whether the run's phase is still current. When it is not, the run stops as no longer wanted. */
function stillCurrent(run) {
  if (phaseStillCurrent(run)) return true;
  run.stopWith(RUN_STOPS.STOOD_DOWN);
  return false;
}

/**
 * Stop the run when a stop has been asked for, and say whether it did. A stop asked for by a GM through the system
 * also switches the AI off here, as the double-Space abort does.
 */
function stopIfAborted(run) {
  if (!abortWanted()) return false;
  abortOnSystemStop();
  run.stopWith(RUN_STOPS.ABORTED);
  return true;
}

/** The Scene of the one started encounter, read off the Combat documents, or '' when there is none or several. */
function soleEncounterSceneUuid() {
  const scenes = startedEncounterSceneUuids();
  return scenes.length === 1 ? scenes[0] : '';
}

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
/** Show the GM what the run left behind, and log the system's code when it refused the execution segment. */
function reportPhase(planner, run) {
  const notify = globalThis.ui?.notifications;
  if (run.stopCode) console.warn(`${LOG} the system refused the execution segment with code ${run.stopCode}.`);
  const pendingManual = run.blocked ? 0 : pendingManualCount(planner);
  for (const { level, text } of phaseNotices(run, pendingManual)) notify?.[level](text);
  if (run.idled) console.debug(`${LOG} ${run.idled} unit(s) had nothing to do; turns ended without processing.`);
}

/** The sentence that ends most stop notices. */
const RUN_THE_REST = 'Run the remaining units manually.';

/**
 * The notices for a finished run, in the order they are shown: at most one saying why the run stopped, the units
 * that failed, the Manual units still to play, then each thing the teardown could not undo.
 * @param {PhaseRun} run The finished run.
 * @param {number} pendingManual How many Manual units still have a turn to take. Shown only when the run did not stop.
 * @returns {{level: string, text: string}[]} Each notice's level (`info`, `warn` or `error`) and its text.
 */
export function phaseNotices(run, pendingManual) {
  const notices = [];
  const stop = stopNotice(run);
  if (stop) notices.push(stop);
  const failed = run.failed.length;
  if (failed) {
    const names = run.failed.join(', ');
    notices.push({ level: 'warn', text: `${names} failed to act. Run ${failed > 1 ? 'them' : 'it'} manually.` });
  }
  if (pendingManual > 0 && run.stop === null && !run.segment.halt) {
    const which = pendingManual > 1 ? `${pendingManual} units are` : '1 unit is';
    const turns = pendingManual > 1 ? 'their turns' : 'its turn';
    notices.push({ level: 'info', text: `${which} set to Manual. Play ${turns} yourself to finish the phase.` });
  }
  if (run.releaseFailed) {
    notices.push({ level: 'warn', text: 'Enemy AI could not unlock movement on the map. '
      + 'Reload this client if tokens still cannot move.' });
  }
  if (run.closeFailed) {
    notices.push({ level: 'error', text: 'Enemy AI could not give control back to the table. '
      + 'Reload this client if play stays blocked.' });
  }
  return notices;
}

/**
 * The one notice that says why the run stopped, or null when it needs none, as when the run was no longer wanted. A
 * halt inside an action is reported before a stop reason.
 */
function stopNotice(run) {
  const halt = run.segment.halt;
  const unit = run.haltedUnit || 'the acting unit';
  if (halt?.reason === HALT_REASONS.UNKNOWN) {
    return { level: 'warn', text: `Enemy AI stopped: the result of ${unit}'s last action is not known. `
      + `Check ${unit}, then run the remaining units manually.` };
  }
  if (halt?.reason === HALT_REASONS.AUTHORITY) {
    return { level: 'warn', text: `Enemy AI stopped: this client is no longer the host client. ${RUN_THE_REST}` };
  }
  if (halt?.reason === HALT_REASONS.ABORT && run.haltedUnit) {
    return { level: 'info', text: `Enemy AI stopped after ${unit}'s last action. Finish its turn, `
      + 'then run any remaining units manually.' };
  }
  if (halt && halt.reason !== HALT_REASONS.ABORT) {
    return { level: 'warn', text: `Enemy AI stopped: it lost control of the table. ${RUN_THE_REST}` };
  }
  switch (run.stop) {
    case RUN_STOPS.ABORTED:
      return run.queue.length ? { level: 'info', text: `Enemy AI aborted. ${RUN_THE_REST}` } : null;
    case RUN_STOPS.STALLED:
      return { level: 'warn', text: `Enemy AI stopped: the map was still busy after a long wait. ${RUN_THE_REST}` };
    case RUN_STOPS.HOLD_REFUSED:
      return { level: 'warn', text: `Enemy AI could not lock movement on the map. ${RUN_THE_REST}` };
    case RUN_STOPS.LEFTOVER_HOLD:
      return { level: 'warn', text: 'Enemy AI could not remove the movement lock left by its last run. '
        + RUN_THE_REST };
    case RUN_STOPS.HANDOFF_FAILED:
      return { level: 'warn', text: `Enemy AI could not pause for a Manual unit's turn. ${RUN_THE_REST}` };
    case RUN_STOPS.ACQUIRE_REFUSED:
      return { level: 'warn', text: `Enemy AI could not start: ${refusalReason(run.stopCode)}. ${RUN_THE_REST}` };
    case RUN_STOPS.REACQUIRE_REFUSED:
      return { level: 'warn', text: 'Enemy AI could not carry on after a Manual unit\'s turn: '
        + `${refusalReason(run.stopCode)}. ${RUN_THE_REST}` };
    default:
      return null;
  }
}

/** Why the system refused the run its execution segment, in words the GM can act on. */
function refusalReason(code) {
  const codes = systemResultCodes();
  if (code === codes.COMMAND_EXECUTION_BUSY) return 'other gameplay is still running';
  if (code === codes.NO_ACTIVE_GM || code === codes.SOCKET_MULTIPLE_HOSTS) {
    return 'this client is not the host client';
  }
  return 'the system refused it';
}

/** How many Manual units still have a turn to take, counted on the map as it stands now. */
function pendingManualCount(planner) {
  try {
    return partitionManual(collectUnits(planner)).manual
      .filter(unit => unit.turn?.turnComplete !== true).length;
  } catch {
    return 0;
  }
}

/* -------------------------------------------- */
/*  Picking an interrupted phase back up        */
/* -------------------------------------------- */
/** How the host client asks the GM whether to resume. Until hooks.mjs installs the dialog, the answer is no. */
let askToResume = async () => false;

/**
 * Set the question the host client asks the GM before it resumes an enemy phase a reload interrupted.
 * @param {(pendingCount: number) => Promise<boolean>} prompt Told how many units are still to act, resolves true
 *   when the GM chooses to resume.
 */
export function setResumePrompt(prompt) {
  askToResume = prompt;
}

/**
 * Once per host session and encounter, after the host client has finished starting up, offer to resume an enemy
 * phase a reload interrupted, then release any board hold the reload left behind. A phase this client ran itself is
 * never offered, and nothing happens while the module is switched off.
 * @param {import('../planner/scene.mjs').ScenePlanners} planners Every Scene's planner.
 * @returns {Promise<boolean>} Whether a phase was resumed.
 */
export function resumeAfterReload(planners) {
  if (!isCommandHost() || !systemIntegrated()) return Promise.resolve(false);
  return joinResumeCheck(() => resumeWhenReady(planners).then(async resumed => {
    await releaseLeftoverHold();
    return resumed;
  }));
}

/**
 * The board hold is a world setting, so a reload mid-run leaves it standing. Once no run on this client is going,
 * clear any hold this GM left behind so manual movement works again.
 */
async function releaseLeftoverHold() {
  if (isRunning() || !systemIntegrated() || !isCommandHost()) return;
  try {
    if (await releaseBoard() === true) markBoardReleased();
  } catch (error) {
    console.error(`${LOG} could not release a leftover board hold.`, error);
  }
}

/** The resume check: an encounter with the AI on, the host's readiness, then each started encounter's own Scene. */
async function resumeWhenReady(planners) {
  const enabledSomewhere = startedEncounterSceneUuids()
    .some(sceneUuid => isEnabled(encounterOf(planners.forScene(sceneUuid))));
  if (!enabledSomewhere) return false;
  const status = await awaitHostReady();
  if (!status) return false;
  for (const sceneUuid of startedEncounterSceneUuids()) {
    if (isRunning()) return false;
    const answer = await offerResume(planners, sceneUuid, status);
    if (answer !== null) return answer;
  }
  return false;
}

/** One encounter's resume offer, or null when it has nothing to offer. */
async function offerResume(planners, sceneUuid, status) {
  const planner = planners.forScene(sceneUuid);
  const state = encounterState(planner.sceneUuid);
  if (state?.started !== true || state.phase !== systemPhases().ENEMY || !state.combatUuid) return null;
  if (!isEnabled(encounterOf(planner))) return null;
  if (phaseStopped(state) || phaseWasRun(phaseKey(state))) return null;
  const offer = `${status.hostSession ?? ''}|${state.combatUuid}`;
  if (resumeWasOffered(offer)) return null;
  const pending = partitionManual(collectUnits(planner)).driven
    .filter(unit => unit.turn?.turnComplete !== true);
  if (!pending.length) return null;
  markResumeOffered(offer);
  if (await askToResume(pending.length) !== true) return false;
  await runEnemyPhase(planners, { sceneUuid: planner.sceneUuid });
  return true;
}

/** The host's status once it has finished starting up, or null if this client stops being the host first. */
async function awaitHostReady() {
  const { readinessPollMs, readinessTimeoutMs } = EXECUTION_TIMING;
  const attempts = Math.ceil(readinessTimeoutMs / readinessPollMs);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isCommandHost()) return null;
    const status = await commandHostStatus();
    if (status?.ok === true && status.data?.lifecycle === systemLifecycleStates().READY) return status.data;
    if (attempt + 1 < attempts) await delay(readinessPollMs);
  }
  return null;
}
