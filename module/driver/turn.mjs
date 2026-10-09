/** @layer driver */
/*
 * Playing one unit's turn by the course planner/turn-course.mjs gives it: fleeing, falling back, a movement condition,
 * a Seize move or up to two actions, then the end of the turn. Every action goes through the run's execution segment,
 * and a halt there unwinds the whole turn.
 */
import { LOG } from '../constants.mjs';
import { actorOfToken, sceneUuidOfToken } from '../foundry/documents.mjs';
import { writeActorAi } from '../foundry/flags.mjs';
import { unitByTokenUuid } from '../planner/board.mjs';
import { planCrossing, planFreeRoam, planRetreat, takesOffAgain } from '../planner/movement.mjs';
import { planTurn } from '../planner/planning.mjs';
import { isManual, retreatsWhenBroken, riskProfileFor } from '../planner/profile.mjs';
import { isAlive } from '../planner/readiness.mjs';
import { planPursue } from '../planner/pursuit.mjs';
import { canAct, isEligibleUnit } from '../planner/roster.mjs';
import { planBreachStrike, planSeize, seizeDetourIsWorthy } from '../planner/seize.mjs';
import { TURN_KINDS, turnCourse } from '../planner/turn-course.mjs';
import { clearAggressed } from './aggression.mjs';
import { awaitSettled, pause } from './pacing.mjs';
import { attack, moveTo, takeOff, useAbility, useBonusSelfHeal } from './performing.mjs';
import { NO_EXECUTION } from './segment.mjs';

/* -------------------------------------------- */
/*  Constants                                   */
/* -------------------------------------------- */
/** The most actions a unit takes in one turn. */
const MAX_ACTIONS_PER_UNIT = 2;

/* -------------------------------------------- */
/*  Turn state                                  */
/* -------------------------------------------- */
/** @typedef {import('../planner/types.mjs').PlannerUnit} PlannerUnit */
/** @typedef {import('../planner/types.mjs').MovePlan} MovePlan */
/** @typedef {import('../planner/types.mjs').HoldPlan} HoldPlan */

/**
 * What one unit's turn reports to the phase summary.
 * @typedef {object} TurnResult
 * @property {boolean} acted Whether the unit took an action, such as an attack, an ability or a take-off.
 * @property {boolean} didSomething Whether the unit visibly did anything.
 * @property {string} reason Why the turn went as it did, such as 'attacked', 'feared' or 'no-target-in-reach'.
 */

/**
 * One unit's turn as it is being played: what it has done, what it is holding back, and how it ended. The Seize step,
 * the action loop and `closeTurn` read and set its fields as the turn goes on.
 */
class TurnRun {
  constructor(unit, onEngage, gameplay = NO_EXECUTION) {
    /** @type {PlannerUnit} The acting unit, read off the map again by `refresh()`. */
    this.unit = unit;
    /** @type {(() => Promise<void>)|null} Called once, just before the unit first visibly does anything. */
    this.onEngage = onEngage;
    /** @type {object} The gameplay methods of the run's execution segment, which send the turn's commands. */
    this.gameplay = gameplay;
    /** @type {boolean} Whether it carried out a planned action: attack, ability, crossing, take-off or approach. */
    this.acted = false;
    /** @type {boolean} Whether the unit has visibly done anything; `engage()` sets it. */
    this.didSomething = false;
    /** @type {boolean} Whether the unit has used its bonus-action self-heal. */
    this.bonusUsed = false;
    /** @type {string} The reason given when it acted: 'attacked', 'used-<item>' or 'breaching-<target>'. */
    this.actionReason = 'attacked';
    /** @type {number} How many attacks have fully resolved; the action loop stops at MAX_ACTIONS_PER_UNIT. */
    this.actions = 0;
    /** @type {boolean} Whether its Seize step is done, so the rest of its turn is planned without moving. */
    this.stationary = false;
    /** @type {boolean} Whether it walked its Seize move, which the turn reports as 'seizing'. */
    this.seized = false;
    /** @type {PlannerUnit|null} A destructible wall in its Seize route, which it may strike instead. */
    this.breachTarget = null;
    /** @type {PlannerUnit|null} A unit in its Seize route, which its attack plan adds to its targets. */
    this.seizeBlocker = null;
    /** @type {number} How much clearing that wall or unit would shorten the Seize route, from 0 to 1. */
    this.seizeUnlock = 0;
    /** @type {MovePlan|HoldPlan|null} A Seize plan held back while the action loop looks for something better. */
    this.seizeAdvance = null;
    /** @type {boolean} Whether the system refused a take-off this turn, so it is not tried again. */
    this.takeOffRefused = false;
    /** @type {boolean} Whether a taunt sends the unit after its taunter this turn. */
    this.taunted = false;
    /** @type {TurnResult|null} The result once an action has ended the turn; it stops the action loop. */
    this.outcome = null;
  }

  /** Fire the engagement callback once, immediately before the unit visibly does anything. */
  async engage() {
    if (this.didSomething) return;
    this.didSomething = true;
    if (this.onEngage) await this.onEngage();
  }

  /** Re-read the acting unit off the map, after a command or a wait may have changed it. */
  refresh() {
    this.unit = unitByTokenUuid(this.unit.tokenUuid) ?? this.unit;
    return this.unit;
  }

  /**
   * What this turn reports to the phase.
   * @param {string} reason Why the turn went as it did.
   * @returns {TurnResult}
   */
  result(reason) {
    return { acted: this.acted, didSomething: this.didSomething, reason };
  }
}

/**
 * A turn that ended before it began.
 * @param {string} reason Why the unit did not act.
 * @returns {TurnResult}
 */
function idleResult(reason) {
  return { acted: false, didSomething: false, reason };
}

/**
 * The reason takeTurn gives when a Switch AI Profile condition has just made the unit Manual. Its turn is left open,
 * and the phase pauses there for the GM to play it.
 */
export const SWITCHED_TO_MANUAL = 'switched-to-manual';

/* -------------------------------------------- */
/*  Turns                                       */
/* -------------------------------------------- */
/**
 * Play one unit's turn with the run's gameplay methods, by the course `turnCourse` in planner/turn-course.mjs gives
 * it. A Switch AI Profile condition that holds is saved first and the course read again, so a switch to Manual leaves
 * the turn open and any other switch is played under the new profile at once.
 * @param {object} planner The Scene's planner.
 * @param {object} unit The unit as the queue held it.
 * @param {object} [options] `onEngage` fires before the unit visibly acts. `actions` is the segment's gameplay.
 * @returns {Promise<TurnResult>} What the unit did, for the phase summary.
 */
export async function takeTurn(planner, unit, { onEngage = null, actions = NO_EXECUTION } = {}) {
  if (!isEligibleUnit(unit)) return idleResult('ineligible');
  if (isManual(unit)) return idleResult('manual');
  let course = turnCourse(planner, unitByTokenUuid(unit.tokenUuid) ?? unit);
  if (course.switchTo) {
    const switched = await switchProfile(course.unit, course.switchTo, actions);
    course = turnCourse(planner, switched);
  }
  return playCourse(planner, course, { onEngage, actions });
}

/**
 * Play a turn by its course. A kind missing from TURN_KINDS throws, so the phase reports the unit as failed rather
 * than playing it a full turn.
 * @param {object} planner The Scene's planner.
 * @param {import('../planner/types.mjs').TurnCourse} course The course `turnCourse` gave the unit.
 * @param {object} [options] `onEngage` fires before the unit visibly acts. `actions` is the segment's gameplay.
 * @returns {Promise<TurnResult>} What the unit did, for the phase summary.
 */
export async function playCourse(planner, course, { onEngage = null, actions = NO_EXECUTION } = {}) {
  const current = course.unit;
  switch (course.kind) {
    case TURN_KINDS.MANUAL: return idleResult(SWITCHED_TO_MANUAL);
    case TURN_KINDS.FLEE: return flee(planner, current, { onEngage, actions });
    case TURN_KINDS.PASSIVE: return endIdleTurn(current, 'passive', actions);
    case TURN_KINDS.HELD: return endIdleTurn(current, 'incapacitated', actions);
    case TURN_KINDS.DIRECTIVE_MOVE: {
      const moved = await runDirectiveMovement(planner, current, course.directive, { onEngage, actions });
      await endTurn(current, { actions });
      return { acted: false, didSomething: moved, reason: `directive-${course.directive.behavior}` };
    }
    case TURN_KINDS.BROKEN: return handleStanceBroken(planner, current, { onEngage, actions });
    case TURN_KINDS.IDLE: return endIdleTurn(current, 'cannot-act', actions);
    case TURN_KINDS.ACT: {
      const { tauntor, fallback, primary } = course;
      return playTurn(planner, current, { onEngage, tauntor, fallback, primary, actions });
    }
    default:
      throw new Error(`Enemy AI has no turn of the kind "${course.kind}" for ${current?.name ?? 'a unit'}.`);
  }
}

/** End the turn of a unit that does nothing this turn, and report why. */
async function endIdleTurn(unit, reason, actions) {
  await endTurn(unit, { actions });
  return idleResult(reason);
}

/**
 * Save the profile a Switch AI Profile condition names, with the unit's Scene, then re-read the unit. The switch
 * lasts until that Scene's battle ends and leaves the GM's own profile untouched.
 */
async function switchProfile(unit, profile, actions = NO_EXECUTION) {
  actions.checkpoint();
  await writeActorAi(actorOfToken(unit.tokenUuid), {
    switchedProfile: profile, markScene: sceneUuidOfToken(unit.tokenUuid)
  });
  return unitByTokenUuid(unit.tokenUuid) ?? unit;
}

/** A stance-broken unit's turn: fall back if its profile would, then end the turn and recover. */
async function handleStanceBroken(planner, unit, { onEngage = null, actions = NO_EXECUTION } = {}) {
  const retreat = retreatsWhenBroken(planner, unit) ? planRetreat(planner, unit) : null;
  if (retreat) await walkAway(planner, unit, retreat, { onEngage, actions });
  await endTurn(unit, { actions });
  return { acted: true, didSomething: Boolean(retreat), reason: 'stance-broken-recovered' };
}

/**
 * A feared unit's whole turn: a full-movement retreat from every threat, then the end of the turn, with no action.
 * Fear outranks its profile, conditions and taunt, and with no square further from the threats it stays put.
 */
async function flee(planner, unit, { onEngage = null, actions = NO_EXECUTION } = {}) {
  const retreat = planRetreat(planner, unit);
  if (retreat) await walkAway(planner, unit, retreat, { onEngage, actions });
  await endTurn(unit, { actions });
  return { acted: false, didSomething: Boolean(retreat), reason: 'feared' };
}

/** Fire the engagement callback, walk the retreat `planRetreat` gave, then pause after the move. */
async function walkAway(planner, unit, retreat, { onEngage = null, actions = NO_EXECUTION } = {}) {
  if (onEngage) await onEngage();
  await moveTo(planner, unit, retreat.destination, retreat.graph, { actions });
  await pause();
}

/**
 * End a unit's turn as one system action, then clear its aggression mark; a refused or halted end turn leaves the mark.
 * Once the turn has ended, here or before, the mark is cleared even when a stop was asked for.
 * @returns {Promise<boolean>} Whether this call ended the turn.
 */
export async function endTurn(unit, { restoreStance = true, actions = NO_EXECUTION } = {}) {
  const fresh = unitByTokenUuid(unit.tokenUuid ?? '');
  if (!fresh) return false;
  if (fresh.turn?.turnComplete === true) {
    await clearAggressed(actorOfToken(fresh.tokenUuid));
    actions.checkpoint();
    return false;
  }
  const rests = restoreStance && isAlive(fresh);
  const result = await actions.endTurn({ tokenUuid: fresh.tokenUuid, restoreStance: rests });
  if (result?.ok !== true) {
    console.warn(`${LOG} could not end ${fresh.name}'s turn.`, result?.code ?? '');
    return false;
  }
  await clearAggressed(actorOfToken(fresh.tokenUuid));
  return true;
}

/**
 * Clear the aggression mark of a unit whose turn has already ended, without sending a command. A stop during the
 * unit's last action can halt the run before `endTurn` is reached, and nothing else would clear the mark.
 * @returns {Promise<boolean>} Whether the unit's turn had ended.
 */
export async function clearMarkIfTurnEnded(unit) {
  const fresh = unitByTokenUuid(unit?.tokenUuid ?? '');
  if (fresh?.turn?.turnComplete !== true) return false;
  await clearAggressed(actorOfToken(fresh.tokenUuid));
  return true;
}

/**
 * End the turn of a unit whose turn threw an error, so the phase can still finish. The system undoes the failed
 * action itself, at once or when the host client reloads.
 */
export async function recoverFailedUnit(unit, actions = NO_EXECUTION) {
  try {
    await endTurn(unit, { actions });
  } catch (error) {
    console.warn(`${LOG} could not end ${unit?.name}'s turn after it failed.`, error);
  }
}

/* -------------------------------------------- */
/*  Movement conditions                         */
/* -------------------------------------------- */
/** The plan for a Retreat, Free Roam or Pursue condition. Seize isn't here, since `playTurn` plays it. */
function planForDirective(planner, unit, directive) {
  if (directive.behavior === 'retreat') return planRetreat(planner, unit, { budget: directive.budget });
  if (directive.behavior === 'freeRoam') return planFreeRoam(planner, unit, { budget: directive.budget });
  if (directive.behavior === 'pursue') {
    return planPursue(planner, unit, { budget: directive.budget, crossings: directive.crossings !== false });
  }
  return null;
}

/** Resolve one condition entry into movement, and report whether the unit visibly did anything. */
async function runDirectiveMovement(planner, unit, directive, { onEngage = null, actions = NO_EXECUTION } = {}) {
  const plan = planForDirective(planner, unit, directive);
  if (!plan) return false;
  if (plan.target) planner.pursuitTargets.set(unit.tokenUuid, plan.target.tokenUuid);
  if (onEngage) await onEngage();
  if (plan.kind === 'crossing') {
    return (await crossFrom(planner, unit, plan, actions))?.ok === true;
  }
  await moveTo(planner, unit, plan.destination, plan.graph, { path: plan.path ?? null, actions });
  await pause();
  return true;
}

/** Walk to the square a crossing starts from with the plan left open, then attempt the crossing itself. */
async function crossFrom(planner, unit, plan, actions = NO_EXECUTION) {
  const arrived = await moveTo(planner, unit, plan.origin, plan.graph, { then: 'plan', actions });
  if (plan.needsMove) await pause();
  if (!arrived) return null;
  const { x, y } = plan.crossing.to;
  const result = await actions.cross({ tokenUuid: unit.tokenUuid, destinationX: x, destinationY: y });
  if (result?.ok !== true) console.warn(`${LOG} ${unit.name}'s crossing was refused.`, result?.code ?? '');
  return result;
}

/* -------------------------------------------- */
/*  The action loop                             */
/* -------------------------------------------- */
/** The normal turn: the Seize move, the action loop, then `closeTurn` for whatever the loop left open. */
async function playTurn(planner, unit, options) {
  const risk = riskProfileFor(planner, unit);
  const run = new TurnRun(unit, options.onEngage, options.actions);
  run.taunted = Boolean(options.tauntor);
  await runSeizePrimary(planner, run, options.primary, risk);
  await runActionLoop(planner, run, risk, options.primary);
  if (run.outcome) return run.outcome;
  return closeTurn(planner, run, options);
}

/**
 * Take a Seize capture outright when one is in reach. Otherwise the advance is planned and held back, and
 * `consultSeizeAdvance` spends it unless the action loop finds something worth stopping for.
 */
async function runSeizePrimary(planner, run, primary, risk) {
  if (!primary) return;
  const plan = planSeize(planner, run.unit, { budget: primary.budget, riskProfile: risk });
  const blocker = plan?.blocker ?? null;
  if (blocker) planner.seizeBlockers.set(run.unit.tokenUuid, blocker.tokenUuid);
  run.seizeUnlock = plan?.unlock ?? 0;
  if (blocker?.destructible === true) run.breachTarget = blocker;
  else run.seizeBlocker = blocker;
  if (!plan) return;
  if (!plan.capture) {
    run.seizeAdvance = plan;
    return;
  }
  await takeSeizeStep(planner, run, plan);
}

/** Carry out a Seize plan: walk to its square if it is a move. The rest of the turn is planned from where it stands. */
async function takeSeizeStep(planner, run, plan) {
  if (plan.kind === 'move') {
    await run.engage();
    await moveTo(planner, run.unit, plan.destination, plan.graph, {
      path: plan.path ?? null, actions: run.gameplay
    });
    await pause();
    run.refresh();
    run.seized = true;
  }
  run.stationary = true;
}

/** Up to two actions, each fully resolved before the next is planned. */
async function runActionLoop(planner, run, risk, primary) {
  while (!run.outcome && run.actions < MAX_ACTIONS_PER_UNIT && canAct(run.unit)) {
    const plan = choosePlan(planner, run, risk, primary);
    if (run.seizeAdvance && await consultSeizeAdvance(planner, run, plan)) continue;
    const idle = hasNothingToStrike(run, plan);
    if (takesOffInstead(run, idle) && await takeOffAgain(run)) return;
    const crossing = mayCross(run, idle) ? planCrossing(planner, run.unit, plan, risk) : null;
    if (crossing) return takeCrossing(planner, run, crossing);
    if (!plan) return;
    await run.engage();
    if (plan.needsMove && !await walkToPlan(planner, run, plan)) return;
    if (await useBonusSelfHeal(run.unit, { onEngage: () => run.engage(), actions: run.gameplay })) {
      run.bonusUsed = true;
      run.refresh();
    }
    if (await performPlan(run, plan)) return;
  }
}

/**
 * Whether this action has nothing to strike while the unit may still move: no plan, or only a walk toward a target
 * whose attack squares are all taken.
 */
function hasNothingToStrike(run, plan) {
  return !run.stationary && (!plan || plan.kind === 'approach');
}

/** Whether the unit is a flier a stance break grounded that could take off now, and no take-off was refused. */
function mayTakeOff(run) {
  return !run.takeOffRefused && takesOffAgain(run.unit);
}

/**
 * Whether a grounded flier with nothing to strike takes off now. A taunted one walks toward its taunter first and
 * takes off after the walk, in `performPlan` or `closeWithMovement`.
 */
function takesOffInstead(run, idle) {
  return idle && !run.taunted && mayTakeOff(run);
}

/**
 * Whether a turn with nothing to strike may weigh a climb or drop. A taunted flier that could take off keeps its
 * action for the take-off after its walk, so it does not cross.
 */
function mayCross(run, idle) {
  return idle && !(run.taunted && mayTakeOff(run));
}

/**
 * The best plan for this action. When a destructible blocker stands in the Seize route, a strike on it is scored
 * separately and wins if it beats the best attack or ability.
 */
function choosePlan(planner, run, risk, primary) {
  const moveBudget = primary?.budget ?? null;
  const plan = planTurn(planner, run.unit, risk, {
    stationary: run.stationary, seizeBlocker: run.seizeBlocker, seizeUnlock: run.seizeUnlock, moveBudget
  });
  if (!run.breachTarget) return plan;
  const breach = planBreachStrike(planner, run.unit, run.breachTarget, run.seizeUnlock, {
    stationary: run.stationary, moveBudget
  });
  const rival = (plan?.kind === 'attack' || plan?.kind === 'ability') ? plan.score.total : -Infinity;
  return (breach && breach.breachScore > rival) ? breach : plan;
}

/** Spend the held-back advance unless the turn found something worth stopping for. True means plan again. */
async function consultSeizeAdvance(planner, run, plan) {
  const advance = run.seizeAdvance;
  run.seizeAdvance = null;
  if (seizeDetourIsWorthy(plan)) return false;
  await takeSeizeStep(planner, run, advance);
  return true;
}

/**
 * Take a zone crossing, then end the turn whatever the result. The action loop only reaches this when the turn had
 * no real action to take.
 */
async function takeCrossing(planner, run, crossing) {
  await run.engage();
  const result = await crossFrom(planner, run.unit, crossing, run.gameplay);
  run.refresh();
  await endTurn(run.unit, { actions: run.gameplay });
  if (result?.ok !== true) {
    run.outcome = run.result(result ? 'crossing-refused' : 'move-failed');
    return;
  }
  run.acted = true;
  run.outcome = run.result(`zone-crossing-${crossing.chance}%`);
}

/**
 * Take a flier that a stance break grounded back into the air, which uses the whole action and ends the turn, so it is
 * chosen only when there is nothing better to do. A refused take-off is not tried again this turn.
 */
async function takeOffAgain(run) {
  await run.engage();
  const lifted = await takeOff(run.unit, run.gameplay);
  run.refresh();
  if (!lifted) {
    run.takeOffRefused = true;
    return false;
  }
  await endTurn(run.unit, { actions: run.gameplay });
  run.acted = true;
  run.outcome = run.result('took-off');
  return true;
}

/**
 * Walk to the plan's square, leaving the system's movement plan open for the action. If the unit never arrives, the
 * turn ends.
 */
async function walkToPlan(planner, run, plan) {
  const arrived = await moveTo(planner, run.unit, plan.destination, plan.graph, {
    then: 'plan', actions: run.gameplay
  });
  await pause();
  run.refresh();
  if (arrived) return true;
  await endTurn(run.unit, { actions: run.gameplay });
  run.outcome = run.result('move-failed');
  return false;
}

/** Carry the plan out. True stops the action loop. */
async function performPlan(run, plan) {
  if (plan.kind === 'approach') {
    if (run.taunted && mayTakeOff(run) && await takeOffAgain(run)) return true;
    await endTurn(run.unit, { actions: run.gameplay });
    run.acted = true;
    run.outcome = run.result('approached-attack-square-occupied');
    return true;
  }
  if (plan.kind === 'ability') return performAbility(run, plan);
  return performAttack(run, plan);
}

/** One support action is the whole turn, so there is no second pass to plan. */
async function performAbility(run, plan) {
  const used = await useAbility(plan, run.gameplay);
  await awaitSettled({ label: `${run.unit.name}'s ability` });
  run.refresh();
  if (used) {
    run.acted = true;
    run.actionReason = `used-${plan.item.name ?? 'ability'}`;
  }
  return true;
}

/** One swing, then a wait until it has fully resolved, so a second swing never begins early. */
async function performAttack(run, plan) {
  const struck = await attack(plan, run.gameplay);
  if (plan.breach) run.actionReason = `breaching-${plan.target.name ?? 'the way'}`;
  const settled = await awaitSettled({ label: `${run.unit.name}'s next action` });
  run.refresh();
  if (!struck) return true;
  run.acted = true;
  if (!settled) return true;
  run.actions += 1;
  return !isAlive(run.unit);
}

/* -------------------------------------------- */
/*  Closing the turn                            */
/* -------------------------------------------- */
/**
 * Close a turn the action loop left open: a unit that did nothing walks toward its taunter if it has one, or follows
 * its Free Roam or Pursue condition. Otherwise the unit takes its free bonus self-heal if it can.
 */
async function closeTurn(planner, run, { tauntor, fallback }) {
  if (tauntor && !run.didSomething) {
    return closeWithMovement(planner, run, { behavior: 'pursue', budget: null }, true);
  }
  if (fallback && !run.didSomething) return closeWithMovement(planner, run, fallback, false);
  const heal = { onEngage: () => run.engage(), actions: run.gameplay };
  if (!run.bonusUsed && await useBonusSelfHeal(run.unit, heal)) run.bonusUsed = true;
  run.refresh();
  await endTurn(run.unit, { actions: run.gameplay });
  return run.result(turnReason(run));
}

/**
 * Spend the turn on movement instead, then take the bonus heal that still fits before the turn closes. A taunted
 * flier grounded by a stance break walks toward its taunter without crossing, then takes off with the action it kept.
 */
async function closeWithMovement(planner, run, directive, taunted) {
  const engage = () => run.engage();
  const rising = taunted && mayTakeOff(run);
  const course = rising ? { ...directive, crossings: false } : directive;
  const moved = await runDirectiveMovement(planner, run.unit, course, { onEngage: engage, actions: run.gameplay });
  run.refresh();
  const bonused = await useBonusSelfHeal(run.unit, { onEngage: engage, actions: run.gameplay });
  run.refresh();
  const lifted = rising && takesOffAgain(run.unit) && await takeOffAgain(run);
  if (!lifted) await endTurn(run.unit, { actions: run.gameplay });
  const walked = taunted ? 'taunted-approach' : `directive-${directive.behavior}`;
  const reason = lifted ? 'taunted-approach-took-off' : walked;
  return { acted: lifted, didSomething: moved || bonused || lifted, reason };
}

/** The reason `closeTurn` reports to the phase summary. */
function turnReason(run) {
  if (run.acted) return run.actionReason;
  if (run.bonusUsed) return 'bonus-heal';
  if (run.seized) return 'seizing';
  if (run.takeOffRefused) return 'take-off-refused';
  return run.didSomething ? 'moved' : 'no-target-in-reach';
}
