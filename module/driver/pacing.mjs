/** @layer driver */
import { POST_MOVE_DELAY_MS, SETTLE_POLL_MS, SETTLE_STABLE_MS, SETTLE_TIMEOUT_MS } from '../constants.mjs';
import { awaitBoardSettled, pacingWait } from '../foundry/system-bridge.mjs';
import { invalidateBoardMemo } from '../planner/memo.mjs';
import { abortWanted } from './state.mjs';

/* -------------------------------------------- */
/*  Pauses                                      */
/* -------------------------------------------- */
/**
 * A plain pause on the system's timer (`protocol.wait`), which a hidden host tab does not slow down. The whole table
 * waits on these pauses, so a browser throttling a background tab would otherwise stall everyone.
 */
export function delay(ms) {
  return pacingWait(ms);
}

/** The presentation pause after a move. */
export function pause() {
  return delay(POST_MOVE_DELAY_MS);
}

/* -------------------------------------------- */
/*  Waiting for a quiet map                     */
/* -------------------------------------------- */
/**
 * Wait until nothing has moved or run on the map for a short quiet window (the system's `board.awaitSettled`). The
 * driver waits here before every turn and between a unit's actions, and a double-Space abort cuts the wait short.
 * The cached map data is cleared afterwards, since the map may have changed meanwhile.
 * @param {object} [options]
 * @param {number} [options.timeoutMs] How long the map is given to go quiet.
 * @param {string} [options.label] What the system tells the table this wait is for.
 * @returns {Promise<boolean>} False when the map never went quiet.
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
