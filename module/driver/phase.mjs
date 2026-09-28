/** @layer driver */
import {
  EXECUTION_TIMING,
  IDLE_TURN_YIELD_MS,
  LOG,
  MANUAL_POLL_MS,
  UNIT_HANDOFF_DELAY_MS
} from '../constants.mjs';
import { startedEncounterSceneUuids } from '../foundry/flags.mjs';
import {
  commandHostStatus,
  encounterState,
  enemyPhaseCamera,
  holdBoard,
  isCommandHost,
  releaseBoard,
  reportStandDown,
  systemHostStates,
  systemIntegrated,
  systemResultCodes
} from '../foundry/system-bridge.mjs';
import { board, unitByTokenUuid } from '../planner/board.mjs';
import { invalidateBoardMemo } from '../planner/memo.mjs';
import { orderForPhase, triage, yieldsToPendingAlly } from '../planner/phase-roster.mjs';
import { isManual, partitionManual, profileOf } from '../planner/profile.mjs';
import { collectUnits, isEligibleUnit } from '../planner/roster.mjs';
import { awaitMarkWrites } from './aggression.mjs';
import { encounterOf, isEnabled } from './mode.mjs';
import { awaitSettled, delay } from './pacing.mjs';
import { ExecutionSegmentRunner, HALT_REASONS, isDriveHalted } from './segment.mjs';
import {
  DRIVER,
  abortWanted,
  attachAbortKey,
  beginRun,
  detachAbortKey,
  endRun,
  markPhaseRan,
  phaseWasRun
} from './state.mjs';
import { markStopped, phaseKey, phaseStopped } from './stop-mark.mjs';
import { endTurn, recoverFailedUnit, takeTurn } from './turn.mjs';

/* -------------------------------------------- */
/*  One run                                     */
/* -------------------------------------------- */
/** One enemy phase as it is being driven: its queue, its casualties, its execution, and how it ended. */
class PhaseRun {
  constructor(state) {
    this.summary = [];
    this.failed = [];
    this.queue = [];
    this.aborted = false;
    this.stalled = false;
    this.standDown = false;
    this.recovering = false;
    this.holdRefused = false;
    this.releaseFailed = false;
    this.handoffFailed = false;
    this.closeFailed = false;
    this.acquireRefused = '';
    this.reacquireRefused = '';
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

  /** Whether the roster may be read and played at all. */
  get blocked() {
    return this.aborted || this.stalled || this.standDown
      || this.holdRefused || this.releaseFailed || this.handoffFailed
      || Boolean(this.acquireRefused || this.reacquireRefused || this.segment.halt);
  }

  /** Whether the run stopped on an outcome nobody can vouch for, so its phase must not be driven again. */
  get uncertain() {
    const reason = this.segment.halt?.reason;
    return reason === HALT_REASONS.UNKNOWN || reason === HALT_REASONS.AUTHORITY;
  }
}

/* -------------------------------------------- */
/*  The phase driver                            */
/* -------------------------------------------- */
/**
 * Drive the whole enemy phase on one Scene, one unit at a time, inside one host-local execution segment. The Scene
 * is the one named, else the planner's own, else the one started encounter's, and never the Scene the host displays.
 * `foundry/hooks.mjs` calls this when the enemy phase begins or the mode flag turns the AI on, and the module API
 * and `offerResume` call it too.
 * @param {object} planner The planner the caller holds, rebound here to the encounter's own Scene.
 * @param {{sceneUuid?: string}} [intent] The encounter's Scene.
 * @returns {Promise<object[]>} What each unit did.
 */
export async function runEnemyPhase(planner, intent = {}) {
  if (!systemIntegrated()) {
    reportStandDown();
    return [];
  }
  if (!isCommandHost()) return [];
  if (DRIVER.running) return [];
  const named = String(intent?.sceneUuid ?? '');
  const state = encounterState(named || planner.sceneUuid || soleEncounterSceneUuid());
  if (!state?.sceneUuid || !state.combatUuid || state.started !== true || state.phase !== 'Enemy') return [];
  if (phaseStopped(state)) {
    globalThis.ui?.notifications?.warn('Enemy AI stopped this phase after an uncertain result. '
      + 'Run the remaining units manually.');
    return [];
  }
  return drivePhase(planner.forScene(state.sceneUuid), state);
}

/** The run itself, on a planner bound to the encounter's Scene. */
async function drivePhase(planner, state) {
  if (board(planner)?.exploration === true) return [];
  invalidateBoardMemo();
  const run = new PhaseRun(state);
  run.segment = new ExecutionSegmentRunner();
  beginRun(run);
  try {
    if (DRIVER.holdingBoard && !await releaseTheBoard()) {
      run.releaseFailed = true;
      run.holdRefused = true;
      return [];
    }
    await preparePhase(planner, run);
    if (!run.blocked) await runQueue(planner, run);
  } catch (error) {
    if (!isDriveHalted(error)) {
      console.error(`${LOG} the enemy phase failed.`, error);
      globalThis.ui?.notifications?.error('Enemy AI failed. Run the remaining units manually!');
    }
  } finally {
    if (!run.recovering) markPhaseRan(phaseKey(run));
    await teardownPhase(planner, run);
    if (run.uncertain) await markStopped(run);
    reportPhase(planner, run);
  }
  return run.summary;
}

/**
 * Settle the phase in, take world execution and the board, let the aggression marks still being written land, then
 * split and order the roster before anybody acts.
 */
async function preparePhase(planner, run) {
  if (!await awaitSettled({ label: 'the enemy phase' })) run.stalled = true;
  if (!phaseStillCurrent(run)) {
    run.standDown = true;
    return;
  }
  if (run.blocked) return;
  if (!await openSegment(planner, run)) return;
  if (!await takeTheBoard()) {
    run.holdRefused = true;
    return;
  }
  await awaitMarkWrites();
  if (abortWanted()) run.aborted = true;
  if (!phaseStillCurrent(run)) {
    run.standDown = true;
    return;
  }
  const roster = run.blocked ? { driven: [], manual: [] } : partitionManual(collectUnits(planner));
  const { acting, idle } = run.blocked ? { acting: [], idle: [] } : triage(planner, roster.driven);
  await endIdleTurns(run, idle);
  run.queue = run.blocked ? [] : orderForPhase(planner, [...acting, ...roster.manual]);
}

/** End the turns of every unit that provably has nothing to do this phase. */
async function endIdleTurns(run, idle) {
  for (const unit of idle) {
    if (!phaseStillCurrent(run)) {
      run.standDown = true;
      break;
    }
    if (abortWanted()) {
      run.aborted = true;
      break;
    }
    const live = unitByTokenUuid(unit.tokenUuid);
    if (!live || live.turn?.turnComplete === true) continue;
    try {
      await endTurn(live, { actions: run.gameplay });
      run.idled += 1;
    } catch (error) {
      if (isDriveHalted(error)) {
        noteHalt(run, unit, error);
        break;
      }
      console.error(`${LOG} could not end ${unit.name}'s turn.`, error);
    }
    await delay(IDLE_TURN_YIELD_MS);
  }
}

/**
 * Play the queue one unit at a time, with the camera on and a settle wait before every turn. A unit that should let
 * a pending ally move first (`yieldsToPendingAlly`) goes to the back of the queue, once per phase.
 */
async function runQueue(planner, run) {
  if (!run.queue.length) return;
  run.cameraOn = true;
  await camera('begin');
  const stoodAside = new Set();
  while (run.queue.length) {
    const queued = run.queue.shift();
    if (abortWanted()) {
      run.aborted = true;
      break;
    }
    if (!await readyForTurn(run, queued)) break;
    const unit = unitByTokenUuid(queued.tokenUuid);
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
    await playUnit(planner, run, unit);
    if (run.blocked) break;
  }
}

/**
 * The wait before a turn, which also protects the planning the turn is about to do. The board settles first, then
 * any aggression marks `driver/aggression.mjs` is still writing finish, so the plan sees them.
 */
async function readyForTurn(run, unit) {
  const settled = await awaitSettled({ label: `${unit.name}'s turn` });
  await awaitMarkWrites();
  if (abortWanted()) {
    run.aborted = true;
    return false;
  }
  if (!settled) {
    run.stalled = true;
    return false;
  }
  return phaseStillCurrent(run);
}

/** Play one unit's turn. An error is logged and the run moves on to the next unit, but a halt stops the whole run. */
async function playUnit(planner, run, unit) {
  if (!await holdBoard({ label: 'Enemy Phase', tokenName: unit.name, tokenImg: unit.img })) {
    run.holdRefused = true;
    return;
  }
  if (!phaseStillCurrent(run)) {
    run.standDown = true;
    return;
  }
  let engaged = false;
  const onEngage = async () => {
    engaged = true;
    await camera('focus', unit.tokenUuid);
  };
  try {
    const result = await takeTurn(planner, unit, { onEngage, actions: run.gameplay });
    run.summary.push({ name: unit.name, profile: profileOf(unit), ...result });
  } catch (error) {
    if (isDriveHalted(error)) {
      noteHalt(run, unit, error);
      run.summary.push({ name: unit.name, acted: false, didSomething: engaged, reason: `halted-${error.reason}` });
      return;
    }
    console.error(`${LOG} ${unit.name} failed its turn; continuing.`, error);
    run.failed.push(unit.name);
    run.summary.push({ name: unit.name, acted: false, didSomething: false, reason: 'error', error: error?.message });
    await recoverFailedUnit(unit, run.gameplay);
  }
  if (run.segment.halt) {
    noteHalt(run, unit, null);
    return;
  }
  const drained = await awaitSettled({ label: `the turn after ${unit.name}` });
  if (abortWanted()) run.aborted = true;
  else if (!drained) run.stalled = true;
  else if (engaged) await delay(UNIT_HANDOFF_DELAY_MS);
}

/* -------------------------------------------- */
/*  Manual turns                                */
/* -------------------------------------------- */
/**
 * A manual unit pauses the run: the board hold and world execution go back to the table for that one turn, and the
 * run takes both back once the GM ends it.
 */
async function holdForManual(planner, run, unit) {
  await camera('focus', unit.tokenUuid);
  if (!await releaseTheBoard() || !await run.segment.release()) {
    run.releaseFailed = true;
    run.handoffFailed = true;
    return false;
  }
  if (!await awaitManualTurns(planner, [unit], run)) return false;
  if (!phaseStillCurrent(run)) return false;
  if (!await reacquireSegment(planner, run)) return false;
  if (!await takeTheBoard()) {
    run.holdRefused = true;
    return false;
  }
  if (!await awaitSettled({ label: `${unit.name}'s manual turn` })) {
    run.stalled = true;
    return false;
  }
  if (abortWanted()) {
    run.aborted = true;
    return false;
  }
  return phaseStillCurrent(run);
}

/** Hold the run while the GM plays units by hand, polling a fresh board read until their turns close. */
async function awaitManualTurns(planner, units, run) {
  const pending = () => units
    .map(entry => unitByTokenUuid(entry.tokenUuid))
    .filter(live => live && (Number(live.hp) || 0) > 0 && live.turn?.turnComplete !== true);
  let waiting = pending();
  if (!waiting.length) return true;
  const names = waiting.map(entry => entry.name).join(', ');
  const plural = waiting.length > 1 ? 'their turns' : 'its turn';
  globalThis.ui?.notifications?.info(`Enemy AI is holding for ${names}. End ${plural} to continue.`);
  while (waiting.length) {
    await delay(MANUAL_POLL_MS);
    invalidateBoardMemo();
    if (abortWanted()) {
      run.aborted = true;
      return false;
    }
    if (!isEnabled(encounterOf(planner))) return false;
    if (!phaseStillCurrent(run)) return false;
    waiting = pending();
  }
  return true;
}

/* -------------------------------------------- */
/*  Holding the board and world execution       */
/* -------------------------------------------- */
/**
 * Take the driven-board hold for the AI and start listening for the abort gesture. Does nothing when the AI already
 * holds the board.
 */
async function takeTheBoard() {
  if (DRIVER.holdingBoard) return true;
  if (!await holdBoard({ label: 'Enemy Phase' })) return false;
  DRIVER.holdingBoard = true;
  attachAbortKey();
  return true;
}

/** Hand the board back, for a manual unit's turn or at the end of the run, and stop listening for the abort key. */
async function releaseTheBoard() {
  if (!DRIVER.holdingBoard) return true;
  if (await releaseBoard() !== true) return false;
  DRIVER.holdingBoard = false;
  detachAbortKey();
  return true;
}

/** Whether the run is still wanted: nobody asked it to stop, the AI is on, and its phase is still current. */
function runStillWanted(planner, run) {
  return !abortWanted() && isEnabled(encounterOf(planner)) && phaseStillCurrent(run);
}

/** Take world execution for the run, waiting only while the run is still wanted. */
async function openSegment(planner, run) {
  const result = await run.segment.open({ revalidate: () => runStillWanted(planner, run) });
  if (result?.ok === true) return true;
  if (result?.code === systemResultCodes().RECOVERY_STARTING) {
    run.standDown = true;
    run.recovering = true;
    resumeAfterReload(planner).catch(error => console.error(`${LOG} the resume check failed.`, error));
    return false;
  }
  noteRefusal(planner, run, result, 'acquireRefused');
  return false;
}

/** Take world execution back after a manual unit's turn. The run is checked again before and after it is held. */
async function reacquireSegment(planner, run) {
  const result = await run.segment.reacquire({ revalidate: () => runStillWanted(planner, run) });
  if (result?.ok === true) return true;
  noteRefusal(planner, run, result, 'reacquireRefused');
  return false;
}

/** Record why execution was not taken: an abort, a run no longer wanted, or a refusal the GM is told about. */
function noteRefusal(planner, run, result, field) {
  if (abortWanted()) run.aborted = true;
  else if (!isEnabled(encounterOf(planner)) || !phaseStillCurrent(run)) run.standDown = true;
  else run[field] = String(result?.code ?? 'unknown');
}

/** Record which unit's turn a halt unwound, and whether the halt was an abort, here or requested by staff. */
function noteHalt(run, unit, error) {
  run.haltedUnit ||= unit.name ?? '';
  if (error?.reason !== HALT_REASONS.ABORT) return;
  run.aborted = true;
  abortWanted();
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

/** Close the run's execution segment. By teardown, every action the run started has settled. */
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
/** Whether this client is still the command host, on the scene, encounter, phase and round where the run began. */
function phaseStillCurrent(run) {
  const state = encounterState(run.sceneUuid);
  return isCommandHost() && state?.started === true
    && state.sceneUuid === run.sceneUuid && state.combatUuid === run.combatUuid
    && state.phase === run.phase && (state.round ?? null) === run.round;
}

/** The Scene of the one started encounter, read off the Combat documents, or '' when there is none or several. */
function soleEncounterSceneUuid() {
  const scenes = startedEncounterSceneUuids();
  return scenes.length === 1 ? scenes[0] : '';
}

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
/** Tell the GM what the run left behind: the abort, the stall, the casualties and the manual units. */
function reportPhase(planner, run) {
  const notify = globalThis.ui?.notifications;
  const halt = run.segment.halt;
  if (run.releaseFailed) notify?.warn('Enemy AI could not release the board. Retry after restoring GM control.');
  if (run.closeFailed) {
    notify?.error('Enemy AI could not hand world execution back. Reload this client if play stays blocked.');
  }
  if (run.holdRefused) notify?.warn('Enemy AI could not hold the board. Run the remaining units manually.');
  if (run.acquireRefused) {
    notify?.warn(`Enemy AI could not take the board: ${refusalReason(run.acquireRefused)}. `
      + 'Run the remaining units manually.');
  }
  if (run.reacquireRefused) {
    const reason = refusalReason(run.reacquireRefused);
    notify?.warn(`Enemy AI could not take the board back after a manual turn: ${reason}. `
      + 'Run the remaining units manually.');
  }
  if (halt?.reason === HALT_REASONS.UNKNOWN) {
    const unit = run.haltedUnit || 'the acting unit';
    notify?.warn(`Enemy AI stopped: the result of ${unit}'s last action is not known. `
      + `Check ${unit}, then run the remaining units manually.`);
  } else if (halt && halt.reason !== HALT_REASONS.ABORT) {
    notify?.warn('Enemy AI stopped: this client no longer holds command execution. '
      + 'Run the remaining units manually.');
  }
  if (run.handoffFailed && !run.releaseFailed) {
    notify?.warn('Enemy AI stopped after a failed manual hand-off. Run the remaining units manually.');
  }
  if (halt?.reason === HALT_REASONS.ABORT && run.haltedUnit) {
    notify?.info(`Enemy AI stopped after ${run.haltedUnit}'s last action. Finish its turn, `
      + 'then run any remaining units manually.');
  } else if (run.aborted && run.queue.length) notify?.info('Enemy AI aborted. Run the remaining units manually.');
  else if (run.stalled) notify?.warn('Enemy AI stopped: the board never settled. Run the remaining units manually.');
  if (run.failed.length) {
    notify?.warn(`${run.failed.join(', ')} failed to act. Run ${run.failed.length > 1 ? 'them' : 'it'} manually.`);
  }
  const pending = pendingManualCount(planner);
  if (pending && !run.blocked) {
    const plural = pending > 1 ? 's are' : ' is';
    notify?.info(`${pending} unit${plural} set to Manual. Run ${pending > 1 ? 'them' : 'it'} yourself to end it.`);
  }
  if (run.idled) console.debug(`${LOG} ${run.idled} unit(s) had nothing to do; turns ended without processing.`);
}

/** Why the system would not give the run world execution, in words the GM can act on. */
function refusalReason(code) {
  const codes = systemResultCodes();
  if (code === codes.COMMAND_EXECUTION_BUSY) return 'other gameplay is still running';
  if (code === codes.NO_ACTIVE_GM || code === codes.SOCKET_MULTIPLE_HOSTS) {
    return 'this client is not the command host';
  }
  return `the system refused (${code})`;
}

/** Manual units still holding the phase open, counted off the live board rather than tracked through the run. */
function pendingManualCount(planner) {
  try {
    invalidateBoardMemo();
    return partitionManual(collectUnits(planner)).manual
      .filter(unit => unit.turn?.turnComplete !== true).length;
  } catch {
    return 0;
  }
}

/* -------------------------------------------- */
/*  Picking an interrupted phase back up        */
/* -------------------------------------------- */
/**
 * Offer, once per host session and encounter and only after startup recovery, to pick an interrupted phase up.
 * `foundry/hooks.mjs` asks when the world is ready and when the canvas is drawn, and `openSegment` asks when the
 * host was still recovering. A phase this page ran itself was never interrupted by a reload, however its run ended,
 * so it is never offered. A run that stood down for startup recovery doesn't count as run.
 */
export function resumeAfterReload(planner) {
  if (!isCommandHost()) return Promise.resolve(false);
  DRIVER.resumeCheck ??= resumeWhenReady(planner).finally(() => { DRIVER.resumeCheck = null; });
  return DRIVER.resumeCheck;
}

/** The resume check: an encounter with the AI on, the host's readiness, then each started encounter's own Scene. */
async function resumeWhenReady(planner) {
  const enabledSomewhere = startedEncounterSceneUuids()
    .some(sceneUuid => isEnabled(encounterOf(planner.forScene(sceneUuid))));
  if (!enabledSomewhere) return false;
  const status = await awaitHostReady();
  if (!status) return false;
  for (const sceneUuid of startedEncounterSceneUuids()) {
    if (DRIVER.running) return false;
    const answer = await offerResume(planner.forScene(sceneUuid), status);
    if (answer !== null) return answer;
  }
  return false;
}

/** One encounter's resume offer, on a planner bound to its Scene, or null when it has nothing to offer. */
async function offerResume(planner, status) {
  const state = encounterState(planner.sceneUuid);
  if (state?.started !== true || state.phase !== 'Enemy' || !state.combatUuid) return null;
  if (!isEnabled(encounterOf(planner))) return null;
  if (phaseStopped(state) || phaseWasRun(phaseKey(state))) return null;
  const offer = `${status.hostSession ?? ''}|${state.combatUuid}`;
  if (DRIVER.resumeOffered.has(offer)) return null;
  invalidateBoardMemo();
  const pending = partitionManual(collectUnits(planner)).driven
    .filter(unit => unit.turn?.turnComplete !== true);
  if (!pending.length) return null;
  DRIVER.resumeOffered.add(offer);
  const plural = pending.length > 1 ? 's' : '';
  const resumed = await confirmDialog({
    window: { title: 'Enemy AI' },
    content: `<p>The enemy phase was interrupted by a reload with ${pending.length} unit${plural} still to act. `
      + 'Resume the Enemy AI?</p>',
    rejectClose: false,
    modal: true
  });
  if (resumed !== true) return false;
  await runEnemyPhase(planner);
  return true;
}

/**
 * The host's status once startup recovery and maintenance are done, or null if this client stops hosting first.
 * `protocol.status()`'s `lifecycle` field is the host's startup lifecycle, not a host-authority state, but the
 * system publishes no separate lifecycle map and its ready value is the same string as `protocol.hostStates.READY`.
 */
async function awaitHostReady() {
  const { readinessPollMs, readinessTimeoutMs } = EXECUTION_TIMING;
  const attempts = Math.ceil(readinessTimeoutMs / readinessPollMs);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isCommandHost()) return null;
    const status = await commandHostStatus();
    if (status?.ok === true && status.data?.lifecycle === systemHostStates().READY) return status.data;
    if (attempt + 1 < attempts) await delay(readinessPollMs);
  }
  return null;
}

/** Ask the GM a yes-or-no question with Foundry's DialogV2.confirm. */
function confirmDialog(options) {
  return foundry.applications.api.DialogV2.confirm(options);
}
