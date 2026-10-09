/** @layer driver */
/*
 * The driver's waits and time limits on the host client, in milliseconds: the pauses the table watches between
 * moves and units, how often it polls, and how long it waits for the system or the map before giving up.
 */

/* -------------------------------------------- */
/*  Pauses                                      */
/* -------------------------------------------- */
/**
 * The driver's two pauses, in ms, set as short as the table can still follow: UNIT_HANDOFF_DELAY_MS between units and
 * POST_MOVE_DELAY_MS after a move.
 */
export const UNIT_HANDOFF_DELAY_MS = 113;
export const POST_MOVE_DELAY_MS = 63;
/** The wait, in ms, after the AI ends the turn of each unit that has nothing to do as the phase starts. */
export const IDLE_TURN_YIELD_MS = 30;
/** How often, in ms, the run re-reads the map while it waits for the GM to end a Manual unit's turn. */
export const MANUAL_POLL_MS = 400;

/* -------------------------------------------- */
/*  Stop key                                    */
/* -------------------------------------------- */
/** The longest gap, in ms, between the two Space presses that stop a run (`driver/state.mjs`). */
export const ABORT_DOUBLE_PRESS_MS = 300;

/* -------------------------------------------- */
/*  Waiting for the system and the map          */
/* -------------------------------------------- */
/**
 * How long a run keeps asking while the system is busy with other commands, and how long a resume check waits for the
 * host client to finish starting up.
 */
export const EXECUTION_TIMING = Object.freeze({
  acquirePollMs: 400,
  acquireTimeoutMs: 30000,
  readinessPollMs: 1000,
  readinessTimeoutMs: 600000
});
/**
 * How long, in ms, nothing may move or run on the map before the driver counts it as quiet (`awaitSettled` in
 * `driver/pacing.mjs`).
 */
export const SETTLE_STABLE_MS = 400;
/** How long, in ms, the driver waits for a quiet map before giving up. Giving up before a turn stops the run. */
export const SETTLE_TIMEOUT_MS = 120000;
/** How often, in ms, the system checks whether the map has gone quiet during that wait. */
export const SETTLE_POLL_MS = 200;
