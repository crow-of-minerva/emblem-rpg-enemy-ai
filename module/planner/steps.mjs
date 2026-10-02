/** @layer planner */

/* -------------------------------------------- */
/*  Stepped work                                */
/* -------------------------------------------- */
/**
 * Run stepped planner work straight through and hand back its answer. The planner writes its long computations as
 * generators that yield between expensive calls. The drivers want the answer at once and drain them here, while
 * `ui/idle-steps.mjs` takes the same steps a few at a time. Draining runs in one go, so the page neither redraws nor
 * takes input until the plan is done.
 */
export function drain(steps) {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
