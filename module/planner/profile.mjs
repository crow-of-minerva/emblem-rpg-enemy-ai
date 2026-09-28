/** @layer planner */
import {
  AI_LURE_BLIND_BEHAVIORS,
  AI_MANUAL_PROFILE,
  AI_PRIORITY_DEFAULT,
  AI_PROFILE_DEFAULT,
  AI_PROFILE_VALUES,
  RISK_PROFILES
} from '../constants.mjs';
import { sceneUuidOfToken } from '../foundry/flags.mjs';
import { aiConditionContext, currentCombatRound } from './board.mjs';
import { resolveDirective } from './conditions.mjs';
import { hashToUnit } from './vocabulary.mjs';

/* -------------------------------------------- */
/*  Posture                                     */
/* -------------------------------------------- */
/** A unit's AI profile, falling back to the default for anything unrecognised. */
export function profileOf(unit) {
  const profile = unit?.ai?.profile;
  return AI_PROFILE_VALUES.includes(profile) ? profile : AI_PROFILE_DEFAULT;
}

/** Whether a unit is dormant, taking no turn unless something wakes it. */
export function isPassive(unit) {
  return profileOf(unit) === 'passive';
}

/** Whether a unit is played by hand. The AI neither plans for it nor ends its turn. */
export function isManual(unit) {
  return profileOf(unit) === AI_MANUAL_PROFILE;
}

/** Where a unit falls in the enemy phase: higher goes first. */
export function priorityOf(unit) {
  const priority = Number(unit?.ai?.priority);
  return Number.isFinite(priority) ? priority : AI_PRIORITY_DEFAULT;
}

/** Split a roster into the units the AI drives and the manual ones it must leave alone. */
export function partitionManual(units) {
  const driven = [];
  const manual = [];
  for (const unit of units) (isManual(unit) ? manual : driven).push(unit);
  return { driven, manual };
}

/** Whether a unit falls back when its stance breaks, which is a property of its profile. */
export function retreatsWhenBroken(planner, unit) {
  const profile = profileOf(unit);
  if (['defensive', 'aggressive', 'berserk', 'passive'].includes(profile)) return false;
  if (profile === 'unpredictable') return unpredictableRoll(planner, unit, 'retreat') < 0.5;
  return true;
}

/* -------------------------------------------- */
/*  Risk                                        */
/* -------------------------------------------- */
/**
 * The risk weights this unit plans with. An unpredictable unit draws Cautious or Aggressive weights once per round,
 * not once per question.
 */
export function riskProfileFor(planner, unit) {
  const profile = profileOf(unit);
  if (profile === 'unpredictable') {
    return unpredictableRoll(planner, unit, 'risk') < 0.5 ? RISK_PROFILES.cautious : RISK_PROFILES.aggressive;
  }
  return RISK_PROFILES[profile];
}

/** An unpredictable unit's roll: uniform on [0, 1), fixed for the round, different per question. */
export function unpredictableRoll(planner, unit, question) {
  const round = currentCombatRound(sceneUuidOfToken(unit?.tokenUuid ?? '') || planner.sceneUuid);
  return hashToUnit(`${round ?? 0}|${unit?.actorUuid ?? ''}|${question}`);
}

/* -------------------------------------------- */
/*  Authored directives                         */
/* -------------------------------------------- */
/** The directive a unit's authored conditions resolve to right now, against its own Scene's round, or null. */
export function directiveOf(planner, unit) {
  const sceneUuid = sceneUuidOfToken(unit.tokenUuid ?? '') || planner.sceneUuid;
  return resolveDirective(directiveFacts(unit), aiConditionContext(sceneUuid));
}

/** The facts an authored condition reads off a unit. */
export function directiveFacts(unit) {
  return {
    hp: unit.hp,
    hpMax: unit.hpMax,
    stance: unit.stance,
    movement: unit.movement,
    wasAggressed: unit.ai.wasAggressed,
    conditions: unit.ai.conditions,
    spawnBehavior: unit.ai.spawnBehavior
  };
}

/** Whether a dormant unit has an authored instruction that would wake it right now. */
export function wakesFromPassive(planner, unit) {
  const directive = directiveOf(planner, unit);
  if (directive?.behavior !== 'switchProfile') return false;
  return directive.profile !== 'passive';
}

/** Whether a unit is looking for something to hit at all, and so whether an illusion has anything to offer it. */
export function ignoresLures(planner, unit) {
  if (isPassive(unit)) return true;
  const directive = directiveOf(planner, unit);
  return AI_LURE_BLIND_BEHAVIORS.includes(directive?.behavior);
}
