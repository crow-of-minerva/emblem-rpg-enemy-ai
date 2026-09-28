/** @layer driver */
import {
  AI_MOVEMENT_FALLBACK_BEHAVIORS,
  AI_MOVEMENT_PRIMARY_BEHAVIORS,
  LOG,
  MAX_ACTIONS_PER_UNIT
} from '../constants.mjs';
import { actorOfToken, writeActorAi } from '../foundry/flags.mjs';
import { unitByTokenUuid } from '../planner/board.mjs';
import { invalidateBoardMemo } from '../planner/memo.mjs';
import { planCrossing, planFreeRoam, planRetreat, takesOffAgain } from '../planner/movement.mjs';
import { planTurn } from '../planner/planning.mjs';
import {
  directiveOf,
  isManual,
  isPassive,
  profileOf,
  retreatsWhenBroken,
  riskProfileFor
} from '../planner/profile.mjs';
import { planPursue } from '../planner/pursuit.mjs';
import { fleesByStatus, isHeldByStatus, isStanceBroken } from '../planner/readiness.mjs';
import { canAct, isEligibleUnit, tauntorToken } from '../planner/roster.mjs';
import { planBreachStrike, planSeize, seizeDetourIsWorthy } from '../planner/seize.mjs';
import { clearAggressed } from './aggression.mjs';
import { awaitSettled, pause } from './pacing.mjs';
import { attack, moveTo, takeOff, useAbility, useBonusSelfHeal } from './performing.mjs';
import { NO_EXECUTION } from './segment.mjs';

/* -------------------------------------------- */
/*  Turn state                                  */
/* -------------------------------------------- */
/** One unit's turn as it is being played: what it has done, what it is holding back, and how it ended. */
class TurnRun {
  constructor(unit, onEngage, gameplay = NO_EXECUTION) {
    this.unit = unit;
    this.onEngage = onEngage;
    this.gameplay = gameplay;
    this.acted = false;
    this.didSomething = false;
    this.bonusUsed = false;
    this.actionReason = 'attacked';
    this.actions = 0;
    this.stationary = false;
    this.seized = false;
    this.breachTarget = null;
    this.seizeBlocker = null;
    this.seizeUnlock = 0;
    this.seizeAdvance = null;
    this.takeOffRefused = false;
    this.taunted = false;
    this.outcome = null;
  }

  /** Fire the engagement callback once, immediately before the unit visibly does anything. */
  async engage() {
    if (this.didSomething) return;
    this.didSomething = true;
    if (this.onEngage) await this.onEngage();
  }

  /** Re-read the acting unit off a freshly invalidated board, which every command makes necessary. */
  refresh() {
    invalidateBoardMemo();
    this.unit = unitByTokenUuid(this.unit.tokenUuid) ?? this.unit;
    return this.unit;
  }

  /** The verdict this turn reports to the phase. */
  result(reason) {
    return { acted: this.acted, didSomething: this.didSomething, reason };
  }
}

/** A turn that ended before it began. */
function idleResult(reason) {
  return { acted: false, didSomething: false, reason };
}

/* -------------------------------------------- */
/*  Turns                                       */
/* -------------------------------------------- */
/**
 * Play one unit's turn with the run's gameplay methods. The checks run in priority order: a profile switch, fear,
 * Passive, a status that holds the unit, a movement directive, a broken stance, then the action loop.
 * `driver/phase.mjs` calls this once per queued unit, and every plan comes from the planner functions in `planner/`.
 * @param {object} planner The Scene's planner.
 * @param {object} unit The unit as the queue held it.
 * @param {object} [options] `onEngage` fires before the unit visibly acts. `actions` is the segment's gameplay.
 * @returns {Promise<object>} What the unit did, for the phase summary.
 */
export async function takeTurn(planner, unit, { onEngage = null, actions = NO_EXECUTION } = {}) {
  if (!isEligibleUnit(unit)) return idleResult('ineligible');
  if (isManual(unit)) return idleResult('manual');
  invalidateBoardMemo();
  let current = unitByTokenUuid(unit.tokenUuid) ?? unit;
  const directive = directiveOf(planner, current);
  const tauntor = tauntorToken(planner, current);
  const fallback = !tauntor && AI_MOVEMENT_FALLBACK_BEHAVIORS.includes(directive?.behavior) ? directive : null;
  const primary = !tauntor && AI_MOVEMENT_PRIMARY_BEHAVIORS.includes(directive?.behavior) ? directive : null;

  if (directive?.behavior === 'switchProfile') {
    current = await switchProfile(current, directive, actions);
    if (isManual(current)) return idleResult('manual');
  }
  if (fleesByStatus(current)) return flee(planner, current, { onEngage, actions });
  if (isPassive(current)) {
    await endTurn(current, { actions });
    return idleResult('passive');
  }
  if (isHeldByStatus(current)) {
    await endTurn(current, { actions });
    return idleResult('incapacitated');
  }
  if (!tauntor && directive && !fallback && !primary && directive.behavior !== 'switchProfile') {
    const moved = await runDirectiveMovement(planner, current, directive, { onEngage, actions });
    await endTurn(current, { actions });
    return { acted: false, didSomething: moved, reason: `directive-${directive.behavior}` };
  }
  if (isStanceBroken(current)) return handleStanceBroken(planner, current, { onEngage, actions });
  if (!canAct(current)) {
    await endTurn(current, { actions });
    return idleResult('cannot-act');
  }
  return playTurn(planner, current, { onEngage, tauntor, fallback, primary, actions });
}

/** Commit an authored profile switch, then re-read the unit under its new posture. */
async function switchProfile(unit, directive, actions = NO_EXECUTION) {
  if (profileOf(unit) === directive.profile) return unit;
  actions.checkpoint();
  await writeActorAi(actorOfToken(unit.tokenUuid), { profile: directive.profile });
  invalidateBoardMemo();
  return unitByTokenUuid(unit.tokenUuid) ?? unit;
}

/** A stance-broken unit's turn: fall back if its profile would, then end the turn and recover. */
async function handleStanceBroken(planner, unit, { onEngage = null, actions = NO_EXECUTION } = {}) {
  let didSomething = false;
  if (retreatsWhenBroken(planner, unit)) {
    const retreat = planRetreat(planner, unit);
    if (retreat) {
      didSomething = true;
      if (onEngage) await onEngage();
      await moveTo(planner, unit, retreat.destination, retreat.graph, { actions });
      await pause();
    }
  }
  await endTurn(unit, { actions });
  return { acted: true, didSomething, reason: 'stance-broken-recovered' };
}

/**
 * A feared unit's whole turn: the full-movement retreat from every threat that `planRetreat` also plans for a
 * stance-broken unit, then the end of the turn. Fear outranks the unit's profile, directives and taunt, and the unit
 * takes no action. With nowhere to go, its turn simply ends.
 */
async function flee(planner, unit, { onEngage = null, actions = NO_EXECUTION } = {}) {
  const retreat = planRetreat(planner, unit);
  if (retreat) {
    if (onEngage) await onEngage();
    await moveTo(planner, unit, retreat.destination, retreat.graph, { actions });
    await pause();
  }
  await endTurn(unit, { actions });
  return { acted: false, didSomething: Boolean(retreat), reason: 'feared' };
}

/** End a unit's turn as one system action. Its aggression mark is cleared first: a mark lasts until its turn ends. */
export async function endTurn(unit, { restoreStance = true, actions = NO_EXECUTION } = {}) {
  invalidateBoardMemo();
  const fresh = unitByTokenUuid(unit.tokenUuid ?? '');
  if (!fresh) return false;
  actions.checkpoint();
  await clearAggressed(actorOfToken(fresh.tokenUuid));
  if (fresh.turn?.turnComplete === true) return false;
  const rests = restoreStance && (Number(fresh.hp) || 0) > 0;
  const result = await actions.endTurn({ tokenUuid: fresh.tokenUuid, restoreStance: rests });
  invalidateBoardMemo();
  if (result?.ok !== true) console.warn(`${LOG} could not end ${fresh.name}'s turn.`, result?.code ?? '');
  return result?.ok === true;
}

/**
 * End the turn of a unit whose turn threw, so `driver/phase.mjs` can go on to the next unit. The system restores the
 * failed action's snapshot itself, at once or when the host page reloads.
 */
export async function recoverFailedUnit(unit, actions = NO_EXECUTION) {
  try {
    await endTurn(unit, { actions });
  } catch (error) {
    console.warn(`${LOG} could not end ${unit?.name}'s turn after it failed.`, error);
  }
}

/* -------------------------------------------- */
/*  Directive movement                          */
/* -------------------------------------------- */
/** The plan for a Retreat, Free Roam or Pursue directive. Seize isn't here, since `playTurn` drives it. */
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

/** Walk to a crossing's anchor with the plan left open, then attempt the crossing itself. */
async function crossFrom(planner, unit, plan, actions = NO_EXECUTION) {
  const origin = plan.origin ?? plan.destination ?? { x: unit.x, y: unit.y };
  const arrived = await moveTo(planner, unit, origin, plan.graph, { then: 'plan', actions });
  if (plan.needsMove) await pause();
  if (!arrived) return null;
  const to = plan.crossing?.to ?? { x: plan.crossing?.destX, y: plan.crossing?.destY };
  const result = await actions.cross({ tokenUuid: unit.tokenUuid, destinationX: to.x, destinationY: to.y });
  invalidateBoardMemo();
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
  run.seizeUnlock = plan?.unlock ?? 0;
  if (blocker?.destructible === true) run.breachTarget = blocker;
  else run.seizeBlocker = blocker;
  if (!plan) return;
  if (!plan.capture) {
    run.seizeAdvance = plan;
    return;
  }
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
    const plan = await choosePlan(planner, run, risk, primary);
    if (run.seizeAdvance && await consultSeizeAdvance(planner, run, plan)) continue;
    const idle = !run.stationary && (!plan || plan.kind === 'approach');
    const rising = idle && !run.takeOffRefused && takesOffAgain(run.unit);
    if (rising && !run.taunted && await takeOffAgain(run)) return;
    const crossing = idle && !(rising && run.taunted) ? planCrossing(planner, run.unit, plan, risk) : null;
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
 * The best plan for this action. When a destructible blocker stands in the Seize route, a strike on it is scored
 * separately and wins if it beats the best attack or ability.
 */
async function choosePlan(planner, run, risk, primary) {
  const moveBudget = primary?.budget ?? null;
  const plan = await planTurn(planner, run.unit, risk, {
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
  if (advance.kind === 'move') {
    await run.engage();
    await moveTo(planner, run.unit, advance.destination, advance.graph, {
      path: advance.path ?? null, actions: run.gameplay
    });
    await pause();
    run.refresh();
    run.seized = true;
  }
  run.stationary = true;
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
 * Take a flier grounded by a stance break back into the air. Like a crossing, the flight action competes only with
 * doing nothing worthwhile, since it spends the action and ends the turn. A unit with a blow to strike from the
 * ground strikes instead and rises on a later turn. A taunted unit that cannot reach its taunter walks as close as it
 * can first, with no crossing, which would spend the action, and rises at the end of that walk (performPlan and
 * closeWithMovement). A refused take-off is not asked for again this turn.
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
    if (run.taunted && !run.takeOffRefused && takesOffAgain(run.unit) && await takeOffAgain(run)) return true;
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

/** One swing, and the barrier that keeps the second from beginning until the first has fully resolved. */
async function performAttack(run, plan) {
  const struck = await attack(plan, run.gameplay);
  if (plan.breach) run.actionReason = `breaching-${plan.target.name ?? 'the way'}`;
  const settled = await awaitSettled({ label: `${run.unit.name}'s next action` });
  run.refresh();
  if (!struck) return true;
  run.acted = true;
  if (!settled) return true;
  run.actions += 1;
  return (Number(run.unit.hp) || 0) <= 0;
}

/* -------------------------------------------- */
/*  Closing the turn                            */
/* -------------------------------------------- */
/**
 * Close a turn the action loop left open. A taunted unit that did nothing walks toward its taunter, and a unit with a
 * fallback movement directive that did nothing follows it. Otherwise the unit takes the free bonus heal if it can.
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
  const rising = taunted && !run.takeOffRefused && takesOffAgain(run.unit);
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
