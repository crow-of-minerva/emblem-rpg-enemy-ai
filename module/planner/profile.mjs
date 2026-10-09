/** @layer planner */
/*
 * A unit's AI profile, priority and risk weights, whether it is Manual or Passive, and the directive its conditions
 * give it now. An Unpredictable unit's rolls are fixed for the round.
 */
import {
  AI_MANUAL_PROFILE,
  AI_PRIORITY_DEFAULT,
  AI_PROFILE_DEFAULT,
  AI_PROFILE_VALUES,
  PROFILE_RETREATS_WHEN_BROKEN
} from '../constants.mjs';
import { sceneUuidOfToken } from '../foundry/documents.mjs';
import { aiConditionContext, currentCombatRound } from './board.mjs';
import { resolveDirective } from './conditions.mjs';
import { RISK_PROFILES } from './tuning.mjs';

/** Behaviours under which a unit is not looking for something to hit, and so is not fooled by an illusion. */
const AI_LURE_BLIND_BEHAVIORS = Object.freeze(['seize', 'retreat']);

/* -------------------------------------------- */
/*  Profiles                                    */
/* -------------------------------------------- */
/**
 * The AI profile a unit plays by: the one a Switch AI Profile condition switched it to this battle, else the GM's,
 * falling back to the default for anything unrecognised.
 */
export function profileOf(unit) {
  const profile = unit?.ai?.switchedProfile || unit?.ai?.profile;
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

/** Split a roster into the units the AI plays and the Manual ones it must leave alone. */
export function partitionManual(units) {
  const driven = [];
  const manual = [];
  for (const unit of units) (isManual(unit) ? manual : driven).push(unit);
  return { driven, manual };
}

/**
 * Whether a unit falls back when its stance breaks, as its profile sets in AI_PROFILES. A coin-flip profile
 * (Unpredictable) gets one flip per round.
 */
export function retreatsWhenBroken(planner, unit) {
  const retreats = PROFILE_RETREATS_WHEN_BROKEN[profileOf(unit)];
  if (retreats === 'coin') return unpredictableRoll(planner, unit, 'retreat') < 0.5;
  return retreats;
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

/** A string's 32-bit FNV-1a hash. */
function hashString(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A string's hash as a number in [0, 1): a repeatable stand-in for Math.random(). */
function hashToUnit(text) {
  return hashString(String(text)) / 4294967296;
}

/* -------------------------------------------- */
/*  Conditions                                  */
/* -------------------------------------------- */
/** The directive the GM's conditions on a unit resolve to right now, against its own Scene's round, or null. */
export function directiveOf(planner, unit) {
  const sceneUuid = sceneUuidOfToken(unit.tokenUuid ?? '') || planner.sceneUuid;
  return resolveDirective(directiveFacts(unit), aiConditionContext(sceneUuid));
}

/**
 * The values a condition reads off a unit, and the profile it plays by now, which tells resolveDirective in
 * conditions.mjs whether a Switch AI Profile entry is already in effect.
 */
export function directiveFacts(unit) {
  return {
    hp: unit.hp,
    hpMax: unit.hpMax,
    stance: unit.stance,
    movement: unit.movement,
    wasAggressed: unit.ai.wasAggressed,
    conditions: unit.ai.conditions,
    spawnBehavior: unit.ai.spawnBehavior,
    profile: profileOf(unit)
  };
}

/**
 * Whether an illusion has nothing to offer this unit: it is Passive, or its Seize or Retreat directive means it is not
 * looking for something to hit.
 */
export function ignoresLures(planner, unit) {
  if (isPassive(unit)) return true;
  const directive = directiveOf(planner, unit);
  return AI_LURE_BLIND_BEHAVIORS.includes(directive?.behavior);
}
