/** @layer planner */
/*
 * Running the planner's stepped work, written as generators, straight through in one go.
 */

/* -------------------------------------------- */
/*  Running a plan in one go                    */
/* -------------------------------------------- */
/**
 * Run stepped planner work straight through and hand back its answer: the planner writes long computations as
 * generators that yield between expensive calls. Draining runs in one go, so the browser neither redraws nor takes
 * input until the plan is done.
 */
export function drain(steps) {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
