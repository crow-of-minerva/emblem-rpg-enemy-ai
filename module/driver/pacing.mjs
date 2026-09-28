/** @layer driver */
import { POST_MOVE_DELAY_MS, SETTLE_POLL_MS, SETTLE_STABLE_MS, SETTLE_TIMEOUT_MS } from '../constants.mjs';
import { awaitBoardSettled, pacingWait } from '../foundry/system-bridge.mjs';
import { invalidateBoardMemo } from '../planner/memo.mjs';
import { abortWanted } from './state.mjs';

/* -------------------------------------------- */
/*  Pauses                                      */
/* -------------------------------------------- */
/**
 * A plain pause, never a settle barrier. It is taken on the system's pacing clock, because the driver pauses while it
 * holds or waits for world execution, and a hidden host page would otherwise stretch every pause the table waits on.
 */
export function delay(ms) {
  return pacingWait(ms);
}

/** The presentation pause after a move. */
export function pause() {
  return delay(POST_MOVE_DELAY_MS);
}

/* -------------------------------------------- */
/*  The settle barrier                          */
/* -------------------------------------------- */
/**
 * Block until the board has been completely quiet for the settle window. Planning counts as work. `driver/phase.mjs`
 * waits here before every turn and `driver/turn.mjs` between a unit's actions, and the abort gesture cuts the wait
 * short. Whatever the board did while it waited, the memo is dropped before the caller reads it again.
 * @param {object} [options]
 * @param {number} [options.timeoutMs] How long the board is given to go quiet.
 * @param {string} [options.label] What the system tells the table this wait is for.
 * @returns {Promise<boolean>} False when the board never settled.
 */
export async function awaitSettled({ timeoutMs = SETTLE_TIMEOUT_MS, label = '' } = {}) {
  const settled = await awaitBoardSettled({
    timeoutMs,
    stableMs: SETTLE_STABLE_MS,
    pollMs: SETTLE_POLL_MS,
    abort: () => abortWanted(),
    label: label ? `${label} (Enemy AI)` : 'Enemy AI'
  });
  invalidateBoardMemo();
  return settled !== false;
}
