/** @layer driver */
import { ABORT_DOUBLE_PRESS_MS, LOG } from '../constants.mjs';
import { documentByUuid, writeCombatMode } from '../foundry/flags.mjs';
import { isCommandHost } from '../foundry/system-bridge.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
/**
 * The abort key, pressed twice quickly to stop a run. It is Space, the default of the system's Select and Confirm
 * keybinding, and stays Space even when that keybinding is changed.
 */
const ABORT_KEY = 'Space';
/** The selector for the fields a keystroke belongs to rather than the board. */
const TEXT_FIELDS = 'input, textarea, select, [contenteditable="true"]';

/**
 * Everything this page remembers about driving, in one place.
 *
 * `driver/phase.mjs` owns every transition: it registers the run it starts, clears it in teardown, and records the
 * phase it stopped driving. `beginRun` and `endRun` bracket a run. `stoppedPhase`, `ranPhases` and `resumeOffered`
 * outlive it on purpose, because a page neither drives nor offers a phase it already gave up on, and never offers one
 * it ran itself. Nothing here is persisted: `foundry/flags.mjs` writes the stop mark a reloaded page reads.
 */
export const DRIVER = {
  /** The active phase run, or null while the driver is idle. */
  running: null,
  /** Whether the GM has asked the run to stop. */
  abortRequested: false,
  /** When the first of the two abort presses landed. */
  lastAbortKeyAt: 0,
  /** The live abort listener, while the AI holds the board. */
  abortKeyHandler: null,
  /** Whether the AI holds the board, which a run hands back for every manual unit it reaches. */
  holdingBoard: false,
  /** The phase a run stopped driving after an uncertain outcome. This page never drives that phase again. */
  stoppedPhase: '',
  /** The phases this page has run, however each run ended. This page never offers to resume one of them. */
  ranPhases: new Set(),
  /** The resume prompts this page has offered, by host session and encounter. */
  resumeOffered: new Set(),
  /** The resume check under way, which later callers join rather than starting another. */
  resumeCheck: null
};

/* -------------------------------------------- */
/*  Transitions                                 */
/* -------------------------------------------- */
/** Take the run: the driver is busy from here until `endRun`. */
export function beginRun(run) {
  DRIVER.running = run;
  DRIVER.abortRequested = false;
}

/** Free the driver, whatever became of the run, and stop listening for the abort gesture. */
export function endRun() {
  detachAbortKey();
  DRIVER.running = null;
  DRIVER.abortRequested = false;
}

/** Whether a phase run is in progress. */
export function isRunning() {
  return DRIVER.running !== null;
}

/** Whether the phase run in progress drives this encounter. */
export function drivesEncounter(combatUuid) {
  return Boolean(combatUuid) && DRIVER.running?.combatUuid === combatUuid;
}

/**
 * Ask the running phase to stop at its next safe boundary. An action already in flight finishes first. The mode flag
 * goes off with it, so nothing starts the phase again behind the stop.
 */
export function requestAbort() {
  if (!DRIVER.running || DRIVER.abortRequested) return;
  DRIVER.abortRequested = true;
  DRIVER.running.segment.requestStop();
  globalThis.ui?.notifications?.info('Enemy AI will stop after its current action.');
  const combat = documentByUuid(DRIVER.running.combatUuid);
  if (!combat) return;
  Promise.resolve(writeCombatMode(combat, 'off'))
    .catch(error => console.error(`${LOG} could not clear the Enemy AI mode flag.`, error));
}

/**
 * Whether the run has been asked to stop, by the abort gesture here or by staff through the system's stop request.
 * The first sight of a system stop request is handled exactly like the gesture.
 */
export function abortWanted() {
  if (!DRIVER.abortRequested && DRIVER.running?.segment.stopRequested === true) requestAbort();
  return DRIVER.abortRequested;
}

/** Remember that this page gave up on a phase, keyed the way `phaseKey` describes one. */
export function markPhaseStopped(key) {
  DRIVER.stoppedPhase = key;
}

/** Whether this page is the one that gave up on a phase. */
export function phaseWasStopped(key) {
  return DRIVER.stoppedPhase === key;
}

/** Remember that this page ran a phase, keyed the way `phaseKey` describes one. */
export function markPhaseRan(key) {
  DRIVER.ranPhases.add(key);
}

/** Whether this page has already run a phase, so no reload interrupted it. */
export function phaseWasRun(key) {
  return DRIVER.ranPhases.has(key);
}

/* -------------------------------------------- */
/*  The abort gesture                           */
/* -------------------------------------------- */
/**
 * Listen for the abort gesture while the AI holds the board, on the command host only. Space presses outside text
 * fields are swallowed while it listens.
 */
export function attachAbortKey() {
  if (DRIVER.abortKeyHandler || !isCommandHost()) return;
  DRIVER.lastAbortKeyAt = 0;
  DRIVER.abortKeyHandler = event => {
    if (event.repeat || event.code !== ABORT_KEY) return;
    if (event.target?.closest?.(TEXT_FIELDS)) return;
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (DRIVER.lastAbortKeyAt && (now - DRIVER.lastAbortKeyAt) <= ABORT_DOUBLE_PRESS_MS) {
      DRIVER.lastAbortKeyAt = 0;
      requestAbort();
    } else {
      DRIVER.lastAbortKeyAt = now;
    }
  };
  globalThis.document?.addEventListener?.('keydown', DRIVER.abortKeyHandler, true);
}

/** Stop listening, and forget any half-finished gesture. */
export function detachAbortKey() {
  if (!DRIVER.abortKeyHandler) return;
  globalThis.document?.removeEventListener?.('keydown', DRIVER.abortKeyHandler, true);
  DRIVER.abortKeyHandler = null;
  DRIVER.lastAbortKeyAt = 0;
}
