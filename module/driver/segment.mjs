/** @layer driver */
import { EXECUTION_SEGMENT_LABEL, EXECUTION_TIMING, MODULE_ID } from '../constants.mjs';
import {
  SEGMENT_GAMEPLAY_METHODS,
  hostRefusalCode,
  isCommandHost,
  openExecutionSegment,
  pacingWait,
  segmentGameplay,
  systemResultCodes
} from '../foundry/system-bridge.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
/** What one action's result lets the run do next. */
const ACTION_VERDICTS = Object.freeze({
  COMPLETED: 'completed',
  REFUSED: 'refused',
  UNKNOWN: 'unknown',
  AUTHORITY: 'authority',
  RELEASED: 'released'
});

/** Why a runner stopped driving. */
export const HALT_REASONS = Object.freeze({
  ABORT: 'abort',
  UNKNOWN: 'unknown',
  AUTHORITY: 'authority',
  RELEASED: 'released',
  CLOSED: 'closed',
  NO_EXECUTION: 'no-execution'
});

/** The codes a runner answers with itself, before or instead of asking the system. */
const RUNNER_CODES = Object.freeze({
  HELD: 'enemy-ai.segment-held',
  STALE: 'enemy-ai.run-stale',
  STOPPED: 'enemy-ai.run-stopped',
  CLOSED: 'enemy-ai.segment-closed',
  NO_SEGMENT: 'enemy-ai.no-segment'
});

/** The halt a turn played outside any execution segment reports. */
const NO_EXECUTION_HALT = Object.freeze({ reason: HALT_REASONS.NO_EXECUTION, action: '', code: '', error: null });

/* -------------------------------------------- */
/*  Classification                              */
/* -------------------------------------------- */
/**
 * What one action's result lets the run do next.
 *
 * Only a completed action, or one the system refused cleanly, lets the turn go on. A result that may hide landed
 * writes, including a refusal whose writes the dispatcher could not fully restore (`data.restored === false`), or
 * that says this client no longer executes, stops the run, because the AI never replays mechanics.
 *
 * The result codes are read from `systemResultCodes()` on each call rather than at import time, because the system
 * may not have published its API yet when this module loads. By the time a result is classified,
 * `systemIntegrated()` has already let the run start.
 * @param {*} result The system's `{ok, code, data}` result.
 * @returns {string} One of {@link ACTION_VERDICTS}.
 */
function classifyActionResult(result) {
  if (!result || typeof result !== 'object') return ACTION_VERDICTS.UNKNOWN;
  const code = String(result.code ?? '');
  const codes = systemResultCodes();
  if (code === codes.COMMAND_OUTCOME_UNKNOWN || code === codes.COMMAND_FAILED) return ACTION_VERDICTS.UNKNOWN;
  if (result.ok === true) return ACTION_VERDICTS.COMPLETED;
  if ([codes.SOCKET_AUTHORITY_LOST, codes.NO_ACTIVE_GM, codes.SOCKET_MULTIPLE_HOSTS,
    codes.SOCKET_HOST_SESSION_STALE, codes.SOCKET_HOST_UNREACHABLE, codes.RECOVERY_STARTING].includes(code)) {
    return ACTION_VERDICTS.AUTHORITY;
  }
  if (code === codes.COMMAND_SEGMENT_RELEASED || code === codes.COMMAND_EXECUTION_BUSY) {
    return ACTION_VERDICTS.RELEASED;
  }
  if (result.data?.restored === false) return ACTION_VERDICTS.UNKNOWN;
  return ACTION_VERDICTS.REFUSED;
}

/* -------------------------------------------- */
/*  Halting                                     */
/* -------------------------------------------- */
/** Thrown at an action boundary once the run may drive no further. It unwinds the whole turn. */
class DriveHalted extends Error {
  constructor(halt) {
    super(`Enemy AI stopped driving: ${halt.reason}${halt.code ? ` (${halt.code})` : ''}.`);
    this.name = 'DriveHalted';
    this.reason = halt.reason;
    this.halt = halt;
  }
}

/** Whether an error is the runner stopping, rather than something failing inside the AI. */
export function isDriveHalted(error) {
  return error instanceof DriveHalted;
}

/** The gameplay methods of a turn played outside any execution segment. Each one fails with `DriveHalted`. */
export const NO_EXECUTION = haltedActions(NO_EXECUTION_HALT);

/* -------------------------------------------- */
/*  Runner                                      */
/* -------------------------------------------- */
/**
 * The host-local driver of one enemy phase's world execution. `drivePhase` in `driver/phase.mjs` builds one per run.
 *
 * It opens one execution segment for the run and keeps it across consecutive automatic units. The turn driver gets
 * gameplay methods bound to that segment alone. Each call is one system action with its own authorization, resource
 * claims and undo boundary. The runner stops at the first uncertain outcome, stops at the next action boundary when
 * asked, and never releases execution while one of its own actions can still write. A busy world is waited for
 * within the acquire bound in `EXECUTION_TIMING`.
 */
export class ExecutionSegmentRunner {
  #segment = null;
  #actions = NO_EXECUTION;
  #inFlight = null;
  #stopRequested = false;
  #halt = null;

  /* -------------------------------------------- */
  /*  State                                       */
  /* -------------------------------------------- */
  /** Whether the runner holds world execution right now. */
  get held() {
    return this.#segment?.held === true && this.#segment.closed !== true;
  }

  /** Why the runner stopped driving, or null while it may still drive. */
  get halt() {
    return this.#halt;
  }

  /** Whether a stop was asked for, here or by staff through the system. The run halts at its next action boundary. */
  get stopRequested() {
    return this.#stopRequested || this.#segment?.stopRequested === true;
  }

  /** The gameplay methods bound to this run's segment. Before a segment opens, each one fails with `DriveHalted`. */
  get actions() {
    return this.#actions;
  }

  /* -------------------------------------------- */
  /*  Ownership                                   */
  /* -------------------------------------------- */
  /**
   * Take world execution for the run. Only a busy world is asked again, within the runner's bound, and only while
   * `revalidate` still says the run is wanted.
   * @param {object} [options]
   * @param {Function} [options.revalidate] Whether the run should still take execution.
   * @returns {Promise<object>} The system's result, or the runner's own refusal.
   */
  async open({ revalidate = () => true } = {}) {
    if (this.#segment) return refusal(RUNNER_CODES.CLOSED);
    if (!isCommandHost()) return refusal(hostRefusalCode());
    const result = await this.#acquire(() => openExecutionSegment(EXECUTION_SEGMENT_LABEL), revalidate);
    const segment = result?.ok === true ? result.data?.segment : null;
    if (!segment) return result?.ok === true ? refusal(RUNNER_CODES.NO_SEGMENT) : result;
    this.#segment = segment;
    this.#actions = this.#bind(segment);
    return result;
  }

  /** Hand world execution back for a human's turn or a dialog, once the runner's own action has settled. */
  async release() {
    await this.#settled();
    if (!this.held) return this.#segment?.held !== true;
    await this.#segment.release();
    return this.#segment.held !== true;
  }

  /**
   * Take world execution back after a hand-off. The run is revalidated before every attempt and again once execution
   * is held, because the board may have changed while the table had it.
   * @param {object} [options]
   * @param {Function} [options.revalidate] Whether the run is still wanted on the board as it now stands.
   * @returns {Promise<object>} The system's result, or the runner's own refusal.
   */
  async reacquire({ revalidate = () => true } = {}) {
    if (this.#halt) return refusal(RUNNER_CODES.STOPPED);
    if (!this.#segment || this.#segment.closed === true) return refusal(RUNNER_CODES.CLOSED);
    if (this.held) return revalidate() === true ? accepted(RUNNER_CODES.HELD) : refusal(RUNNER_CODES.STALE);
    const result = await this.#acquire(() => this.#segment.reacquire(), revalidate);
    if (result?.ok !== true) return result;
    return revalidate() === true ? result : refusal(RUNNER_CODES.STALE);
  }

  /** Close the segment at the end of the run, once the runner's own action has settled. */
  async close() {
    await this.#settled();
    if (!this.#segment || this.#segment.closed === true) return true;
    await this.#segment.close();
    return this.#segment.closed === true;
  }

  /** Ask the run to stop at its next action boundary. An action already in flight finishes first. */
  requestStop() {
    this.#stopRequested = true;
  }

  /**
   * The action boundary: throws {@link DriveHalted} unless the run may still drive on a held segment. The turn driver
   * also passes through it before its own writes between actions.
   */
  checkpoint() {
    if (this.#halt) throw new DriveHalted(this.#halt);
    if (this.stopRequested) this.#stop(HALT_REASONS.ABORT);
    if (!this.#segment) throw new DriveHalted(NO_EXECUTION_HALT);
    if (this.#segment.closed === true) this.#stop(HALT_REASONS.CLOSED);
    if (this.#segment.held !== true) this.#stop(HALT_REASONS.RELEASED);
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */
  /** This segment's gameplay methods, each wrapped as one action, with the boundary check beside them. */
  #bind(segment) {
    const methods = Object.entries(segmentGameplay(segment))
      .map(([name, call]) => [name, (...args) => this.#act(name, call, args)]);
    return Object.freeze({ ...Object.fromEntries(methods), checkpoint: () => this.checkpoint() });
  }

  /** Run one action inside the held segment, then decide from its result whether the run may go on. */
  async #act(name, call, args) {
    this.checkpoint();
    const flight = (async () => call(...args))();
    this.#inFlight = flight;
    let result;
    try {
      result = await flight;
    } catch (error) {
      this.#stop(HALT_REASONS.UNKNOWN, { action: name, error });
    } finally {
      if (this.#inFlight === flight) this.#inFlight = null;
    }
    const verdict = classifyActionResult(result);
    const code = String(result?.code ?? '');
    if (verdict === ACTION_VERDICTS.UNKNOWN) this.#stop(HALT_REASONS.UNKNOWN, { action: name, code });
    if (verdict === ACTION_VERDICTS.AUTHORITY) this.#stop(HALT_REASONS.AUTHORITY, { action: name, code });
    if (verdict === ACTION_VERDICTS.RELEASED) this.#stop(HALT_REASONS.RELEASED, { action: name, code });
    if (this.#segment.closed === true) this.#halt ??= freezeHalt(HALT_REASONS.AUTHORITY, { action: name, code });
    return result;
  }

  /** Wait out the runner's own action in flight, whatever its outcome. */
  async #settled() {
    const flight = this.#inFlight;
    if (flight) await flight.then(() => undefined, () => undefined);
  }

  /**
   * Ask again while only a busy world stands in the way, and only while the run is wanted. The bound is elapsed time,
   * so a page whose timers run slow gives up when the bound has passed rather than after a count of slow attempts.
   */
  async #acquire(attempt, revalidate) {
    const { acquirePollMs, acquireTimeoutMs } = EXECUTION_TIMING;
    const deadline = Date.now() + acquireTimeoutMs;
    while (true) {
      if (this.stopRequested) return refusal(RUNNER_CODES.STOPPED);
      if (revalidate() !== true) return refusal(RUNNER_CODES.STALE);
      let result;
      try {
        result = await attempt();
      } catch (error) {
        console.error(`${MODULE_ID} | taking world execution failed.`, error);
        return refusal(systemResultCodes().COMMAND_FAILED);
      }
      if (result?.code !== systemResultCodes().COMMAND_EXECUTION_BUSY) return result;
      if (Date.now() + acquirePollMs > deadline) return result;
      await this.#pause(acquirePollMs);
    }
  }

  /** One pause on the segment's pacing clock, else the system's. A hidden host page slows neither. */
  #pause(milliseconds) {
    if (typeof this.#segment?.wait === 'function') return this.#segment.wait(milliseconds);
    return pacingWait(milliseconds);
  }

  /** Record the first reason the run stopped, and unwind the turn. */
  #stop(reason, detail = {}) {
    this.#halt ??= freezeHalt(reason, detail);
    throw new DriveHalted(this.#halt);
  }
}

/* -------------------------------------------- */
/*  Results and halts                           */
/* -------------------------------------------- */
function accepted(code) {
  return { ok: true, code, data: {} };
}

function refusal(code) {
  return { ok: false, code, data: {} };
}

function freezeHalt(reason, { action = '', code = '', error = null } = {}) {
  return Object.freeze({ reason, action, code, error });
}

/** Gameplay methods that all refuse with one halt, for a turn that has no execution to drive with. */
function haltedActions(halt) {
  const refuse = () => { throw new DriveHalted(halt); };
  const methods = SEGMENT_GAMEPLAY_METHODS.map(name => [name, async () => refuse()]);
  return Object.freeze({ ...Object.fromEntries(methods), checkpoint: refuse });
}
