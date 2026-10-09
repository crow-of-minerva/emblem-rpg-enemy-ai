/** @layer driver */
/*
 * What this client remembers about playing the enemy phase, in memory only: the run in progress, stop requests, the
 * phases it ran or gave up on, the board hold, resume offers and the double-Space abort key. Only the functions in this
 * file change it.
 */
import { LOG } from '../constants.mjs';
import { documentByUuid } from '../foundry/documents.mjs';
import { writeCombatMode } from '../foundry/flags.mjs';
import { isCommandHost } from '../foundry/system-bridge.mjs';
import { ABORT_DOUBLE_PRESS_MS } from './timing.mjs';

/* -------------------------------------------- */
/*  Driver state                                */
/* -------------------------------------------- */
/**
 * The abort key, pressed twice quickly to stop a run. It is Space, the default of the system's Select and Confirm
 * keybinding, and stays Space even when that keybinding is changed.
 */
const ABORT_KEY = 'Space';
/** The selector for the fields a keystroke belongs to rather than the map. */
const TEXT_FIELDS = 'input, textarea, select, [contenteditable="true"]';
/** The notice a GM sees once the AI's run has been asked to stop after its current action. */
export const AI_STOP_NOTICE = 'Enemy AI will stop after its current action.';

/**
 * Everything this client remembers about playing the enemy phase, kept in memory only and changed only by the
 * functions in this file. `stoppedPhase`, `ranPhases` and `resumeOffered` outlive a run: this client never plays a
 * phase it gave up on, and never offers to resume a phase it ran itself.
 */
const DRIVER = {
  /** The active phase run, or null while the driver is idle. */
  running: null,
  /** Whether this client has asked the run to stop, through `requestAbort`. */
  abortRequested: false,
  /** When the first of the two abort presses landed. */
  lastAbortKeyAt: 0,
  /** The double-Space listener, while the AI holds the movement lock. */
  abortKeyHandler: null,
  /** Whether this client holds the system's board hold. Kept in memory only; the hold itself is a world setting. */
  holdingBoard: false,
  /** The phase a run gave up on after an uncertain result. This client never plays that phase again. */
  stoppedPhase: '',
  /** The phases this client has run, however each run ended. This client never offers to resume one of them. */
  ranPhases: new Set(),
  /** The resume prompts this client has offered, by host session and encounter. */
  resumeOffered: new Set(),
  /** The resume check under way, which a later check joins instead of starting its own. */
  resumeCheck: null
};

/* -------------------------------------------- */
/*  The run, stop requests and finished phases  */
/* -------------------------------------------- */
/** Take the run: the driver is busy from here until `endRun`. */
export function beginRun(run) {
  DRIVER.running = run;
  DRIVER.abortRequested = false;
}

/** Free the driver, whatever became of the run, and stop listening for the abort key. */
export function endRun() {
  detachAbortKey();
  DRIVER.running = null;
  DRIVER.abortRequested = false;
}

/** Whether a phase run is in progress. */
export function isRunning() {
  return DRIVER.running !== null;
}

/** The phase run in progress, or null while the driver is idle. */
export function activeRun() {
  return DRIVER.running;
}

/** Whether the phase run in progress plays this encounter. */
export function drivesEncounter(combatUuid) {
  return Boolean(combatUuid) && DRIVER.running?.combatUuid === combatUuid;
}

/**
 * Ask the running phase to stop after its current action. The AI mode is switched off too, so nothing starts the
 * phase again.
 */
export function requestAbort() {
  if (!DRIVER.running || DRIVER.abortRequested) return;
  DRIVER.abortRequested = true;
  DRIVER.running.segment.requestStop();
  globalThis.ui?.notifications?.info(AI_STOP_NOTICE);
  const combat = documentByUuid(DRIVER.running.combatUuid);
  if (!combat) return;
  Promise.resolve(writeCombatMode(combat, 'off'))
    .catch(error => console.error(`${LOG} could not clear the Enemy AI mode flag.`, error));
}

/**
 * Whether the run has been asked to stop, on this client or by any GM through the system. It only reads, so the
 * system's quiet-map wait may poll it.
 */
export function abortWanted() {
  return DRIVER.abortRequested || DRIVER.running?.segment.stopRequested === true;
}

/**
 * Treat a stop any GM asked for through the system like the double-Space abort: switch the AI off and tell the GM.
 * Does nothing when no such stop is waiting or this client has already asked the run to stop.
 */
export function abortOnSystemStop() {
  if (!DRIVER.abortRequested && DRIVER.running?.segment.stopRequested === true) requestAbort();
}

/** Remember that this client gave up on a phase, keyed the way `phaseKey` describes one. */
export function markPhaseStopped(key) {
  DRIVER.stoppedPhase = key;
}

/** Whether this client is the one that gave up on a phase. */
export function phaseWasStopped(key) {
  return DRIVER.stoppedPhase === key;
}

/** Remember that this client ran a phase, keyed the way `phaseKey` describes one. */
export function markPhaseRan(key) {
  DRIVER.ranPhases.add(key);
}

/** Whether this client has already run a phase, so no reload interrupted it. */
export function phaseWasRun(key) {
  return DRIVER.ranPhases.has(key);
}

/* -------------------------------------------- */
/*  Board hold and resume offers                */
/* -------------------------------------------- */
/** Remember that this client took the system's board hold. */
export function markBoardHeld() {
  DRIVER.holdingBoard = true;
}

/** Remember that this client no longer holds the system's board hold. */
export function markBoardReleased() {
  DRIVER.holdingBoard = false;
}

/** Whether this client took the system's board hold and has not released it since. */
export function holdsBoard() {
  return DRIVER.holdingBoard;
}

/** Remember that this client offered to resume a phase, keyed by host session and encounter. */
export function markResumeOffered(offer) {
  DRIVER.resumeOffered.add(offer);
}

/** Whether this client has already offered to resume a phase, keyed by host session and encounter. */
export function resumeWasOffered(offer) {
  return DRIVER.resumeOffered.has(offer);
}

/**
 * The resume check under way, or a new one from `start` when none is. Later callers join the one under way, and it
 * is forgotten once it finishes, however it ends.
 * @param {() => Promise<boolean>} start Starts a resume check.
 * @returns {Promise<boolean>} Whether the check resumed a phase.
 */
export function joinResumeCheck(start) {
  DRIVER.resumeCheck ??= start().finally(() => { DRIVER.resumeCheck = null; });
  return DRIVER.resumeCheck;
}

/* -------------------------------------------- */
/*  The abort key                               */
/* -------------------------------------------- */
/**
 * Listen for the double-Space abort while the AI holds the movement lock, on the host client only. The listener runs
 * in the capture phase and stops each Space press outside a text field, so Foundry's keybindings (the system's
 * Select/Confirm is also Space) never see it while the AI plays.
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

/** Stop listening, and forget a first press still waiting for its second. */
export function detachAbortKey() {
  if (!DRIVER.abortKeyHandler) return;
  globalThis.document?.removeEventListener?.('keydown', DRIVER.abortKeyHandler, true);
  DRIVER.abortKeyHandler = null;
  DRIVER.lastAbortKeyAt = 0;
}
