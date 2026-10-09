/** @layer planner */
/*
 * What a unit's turn will be, decided in one place from its profile, its statuses and its directive: the GM's condition
 * that applies to it right now. The driver plays each turn by it, and the phase order and the threat line read it.
 */
import { directiveOf, isManual, isPassive } from './profile.mjs';
import { fleesByStatus, isHeldByStatus, isStanceBroken } from './readiness.mjs';
import { canAct } from './roster.mjs';
import { tauntorToken } from './targeting.mjs';

/** Behaviours that move a unit only when its turn found nothing else to do. */
const AI_MOVEMENT_FALLBACK_BEHAVIORS = Object.freeze(['freeRoam', 'pursue']);
/** Behaviours that move the unit before its action rather than instead of it. */
const AI_MOVEMENT_PRIMARY_BEHAVIORS = Object.freeze(['seize']);

/** The kinds of turn `turnCourse` gives a unit. The driver plays each one its own way and refuses any other value. */
export const TURN_KINDS = Object.freeze({
  /** The GM plays the unit by hand. */
  MANUAL: 'manual',
  /** A fleeing status, such as fear: the turn is spent running from every threat. */
  FLEE: 'flee',
  /** The Passive profile: the turn ends at once. */
  PASSIVE: 'passive',
  /** A status takes the unit's action away: the turn ends at once. */
  HELD: 'held',
  /** A Retreat condition: the turn is spent walking away. */
  DIRECTIVE_MOVE: 'directive-move',
  /** A broken stance: the unit may fall back, then its turn ends and its stance recovers. */
  BROKEN: 'broken',
  /** The action is already spent: the turn ends at once. */
  IDLE: 'idle',
  /** The normal turn: a Seize advance if it has one, its actions, then any fallback movement and bonus self-heal. */
  ACT: 'act'
});

/**
 * The course a unit's turn takes, checked in the order of TURN_KINDS. A Switch AI Profile condition that holds is
 * applied first, in memory only, and `switchTo` says it still has to be saved.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit about to take its turn.
 * @param {object} [options]
 * @param {boolean} [options.ignoreTurnState] Judge the unit as if it had its whole turn in hand, so its kind is never
 *   `TURN_KINDS.IDLE`.
 * @returns {import('./types.mjs').TurnCourse}
 */
export function turnCourse(planner, unit, { ignoreTurnState = false } = {}) {
  if (isManual(unit)) return courseOf(TURN_KINDS.MANUAL, { unit, directive: directiveOf(planner, unit) });
  let current = unit;
  let directive = directiveOf(planner, current);
  let switchTo = null;
  if (directive?.behavior === 'switchProfile') {
    switchTo = directive.profile;
    current = Object.freeze({ ...current, ai: Object.freeze({ ...current.ai, switchedProfile: switchTo }) });
    directive = directiveOf(planner, current);
  }
  const tauntor = tauntorToken(planner, current);
  const fallback = !tauntor && AI_MOVEMENT_FALLBACK_BEHAVIORS.includes(directive?.behavior) ? directive : null;
  const primary = !tauntor && AI_MOVEMENT_PRIMARY_BEHAVIORS.includes(directive?.behavior) ? directive : null;
  const parts = { unit: current, switchTo, directive, tauntor, fallback, primary };
  return courseOf(courseKind(parts, ignoreTurnState), parts);
}

/** Which kind of turn the unit takes, from what `turnCourse` read. */
function courseKind({ unit, directive, tauntor, fallback, primary }, ignoreTurnState) {
  if (isManual(unit)) return TURN_KINDS.MANUAL;
  if (fleesByStatus(unit)) return TURN_KINDS.FLEE;
  if (isPassive(unit)) return TURN_KINDS.PASSIVE;
  if (isHeldByStatus(unit)) return TURN_KINDS.HELD;
  // Only a Retreat is left here: Free Roam and Pursue move only when the turn found nothing to do, and Seize moves
  // before the action. A taunt overrides all of them.
  if (directive && !tauntor && !fallback && !primary) return TURN_KINDS.DIRECTIVE_MOVE;
  if (isStanceBroken(unit)) return TURN_KINDS.BROKEN;
  if (!ignoreTurnState && !canAct(unit)) return TURN_KINDS.IDLE;
  return TURN_KINDS.ACT;
}

/** A frozen course, with the fields `turnCourse` did not reach left empty. */
function courseOf(kind, parts) {
  return Object.freeze({
    kind, switchTo: null, directive: null, tauntor: null, fallback: null, primary: null, ...parts
  });
}
