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
/** The selector for the fields a keystroke belongs to rather than the map. */
const TEXT_FIELDS = 'input, textarea, select, [contenteditable="true"]';

/**
 * Everything this page remembers about playing the enemy phase, in one place. None of it is saved; the stop mark a
 * reloaded page reads is a flag on the Combat (`foundry/flags.mjs`).
 *
 * `beginRun` and `endRun` start and finish a run. `stoppedPhase`, `ranPhases` and `resumeOffered` outlive the run:
 * this page never plays a phase it gave up on, and never offers to resume a phase it ran itself.
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
  /** Whether this page holds the system's board hold. Page memory only; the hold itself is a world setting. */
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

/** Whether the phase run in progress drives this encounter. */
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
  globalThis.ui?.notifications?.info('Enemy AI will stop after its current action.');
  const combat = documentByUuid(DRIVER.running.combatUuid);
  if (!combat) return;
  Promise.resolve(writeCombatMode(combat, 'off'))
    .catch(error => console.error(`${LOG} could not clear the Enemy AI mode flag.`, error));
}

/**
 * Whether the run has been asked to stop. A stop asked for by any GM through the system is treated like the
 * double-Space abort.
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
/*  The abort key                               */
/* -------------------------------------------- */
/**
 * Listen for the double-Space abort while the AI holds the board, on the host client only. The listener runs in the
 * capture phase and stops each Space press outside a text field, so Foundry's keybindings (the system's
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
