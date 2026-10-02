/** @layer ui */

/* -------------------------------------------- */
/*  Idle work                                   */
/* -------------------------------------------- */
/** What `runWhenIdle` resolves with when the work was abandoned rather than finished. */
export const ABANDONED = Symbol('abandoned');

/** How long a page that never goes idle may starve the work before it is given one step anyway. */
const IDLE_TIMEOUT_MS = 60;
/** The slice a browser without `requestIdleCallback` gets per timer turn. */
const FALLBACK_SLICE_MS = 6;

const now = () => globalThis.performance?.now?.() ?? Date.now();

/**
 * Wait for the page's next idle period and report how much of it is left. The browser knows when the canvas frame
 * is done and how long until the next one. A browser without `requestIdleCallback` gets a timer turn and a fixed slice.
 * @returns {Promise<function(): number>} Milliseconds of idle time remaining, asked as often as the caller likes.
 */
function nextIdlePeriod() {
  return new Promise(resolve => {
    if (typeof globalThis.requestIdleCallback === 'function') {
      globalThis.requestIdleCallback(deadline => resolve(() => deadline.timeRemaining()), { timeout: IDLE_TIMEOUT_MS });
      return;
    }
    setTimeout(() => {
      const started = now();
      resolve(() => FALLBACK_SLICE_MS - (now() - started));
    }, 0);
  });
}

/**
 * Run stepped planner work in the page's idle time, so a long plan never holds a frame or an input event.
 * `ui/threat-intent.mjs` plans the selected enemy's turn through here. Nothing runs in the caller's own turn. Each
 * idle period takes at least one step and then as many as still fit, and a period that timed out takes exactly one.
 * @param {Generator} steps Stepped work from `planner/`, one yield between expensive calls.
 * @param {object} [options]
 * @param {function(): boolean} [options.abandoned] Asked before every step. True closes the work unfinished.
 * @returns {Promise<*>} The work's answer, or `ABANDONED`.
 */
export async function runWhenIdle(steps, { abandoned = () => false } = {}) {
  for (;;) {
    const remaining = await nextIdlePeriod();
    do {
      if (abandoned()) {
        steps.return();
        return ABANDONED;
      }
      const step = steps.next();
      if (step.done) return step.value;
    } while (remaining() > 0);
  }
}
