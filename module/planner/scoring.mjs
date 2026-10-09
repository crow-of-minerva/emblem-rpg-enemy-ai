/** @layer planner */
/*
 * Scoring an attack: the matchup the system measures for it from a given square, as the exchange would resolve it,
 * weighed by the unit's profile for damage, risk and position.
 */
import { AI_LESSER_TARGET_FACTIONS } from '../constants.mjs';
import { measure as measureMatchup } from '../foundry/system-bridge.mjs';
import { groundSignature } from './squares.mjs';
import { tauntorOf } from './targeting.mjs';
import {
  AI_LESSER_TARGET_APPEAL,
  BREAK_BONUS,
  BREAK_PROGRESS_WEIGHT,
  LETHAL_BONUS,
  MIN_MEANINGFUL_DAMAGE,
  POSITION_COVER_UNIT,
  POSITION_EXPOSURE_PENALTY,
  POSITION_FLANK_BONUS,
  POSITION_HOLD_GROUND,
  SCORE_EPSILON,
  SCORE_SCALE,
  SEIZE_BLOCKER_BONUS,
  SUICIDE_PENALTY,
  UNANSWERED_FACTOR
} from './tuning.mjs';

/* -------------------------------------------- */
/*  Measurement                                 */
/* -------------------------------------------- */
/**
 * One matchup as the exchange would resolve it, measured from a hypothetical square. `ground` passes the terrain and
 * aura values the planner has already read for the square; the system reads any part left out, which is slow for auras.
 * @param {import('./types.mjs').PlannerUnit} attacker The unit attacking.
 * @param {import('./types.mjs').PlannerUnit} defender The unit attacked.
 * @param {import('./types.mjs').LoadoutWeapon|null} weapon The attacker's weapon.
 * @param {number} distance The distance it attacks from, in squares.
 * @param {string|null} [dmgType] The damage type to deal; the system picks when null.
 * @param {object} [options]
 * @param {boolean} [options.targetFlanked] Whether the attack flanks the defender.
 * @param {boolean} [options.attackerFlanked] Whether the attacker is flanked on that square.
 * @param {{x: number, y: number}|null} [options.standing] The square it attacks from; where it stands when null.
 * @param {string} [options.defenderWeaponId] The weapon the defender counters with, instead of its equipped one.
 * @param {{terrain?: object|null, aura?: object|null}|null} [options.ground] The square's terrain bonus and aura
 *   fields, already read.
 * @returns {import('./types.mjs').Matchup|null} Null when the system can't measure the matchup.
 */
export function measure(attacker, defender, weapon, distance, dmgType = null,
  { targetFlanked = false, attackerFlanked = false, standing = null, defenderWeaponId, ground = null } = {}) {
  return measureMatchup({
    ...suppliedGround(ground),
    attackerTokenUuid: attacker.tokenUuid,
    defenderTokenUuid: defender.tokenUuid,
    weaponId: weapon?.id ?? '',
    distance,
    damageType: dmgType,
    standing: standing ?? { x: attacker.x, y: attacker.y },
    attackerFlanked,
    targetFlanked,
    defenderWeaponId
  }) ?? null;
}

/**
 * The ground values to pass to the system: terrain the planner priced, and aura fields only when the record has some.
 * An empty aura record is left out, so the system reads the square's auras again.
 */
function suppliedGround(ground) {
  const supplied = {};
  if (ground?.terrain) supplied.terrainModifiers = ground.terrain;
  if (ground?.aura && Object.keys(ground.aura).length > 0) supplied.auraFields = ground.aura;
  return supplied;
}

/**
 * Score every candidate square for one weapon, measuring each distinct matchup once, and return the best so far. It
 * yields after every matchup the system really measured, the one expensive call in a plan, and never after one it
 * remembered.
 * @param {import('./types.mjs').ActionSearch} search The unit attacking and the weights it plans with.
 * @param {object[]} group The candidates that share one weapon: each a square, a target and the distance, with the
 *   square's ground and position.
 * @param {object|null} best The best candidate from earlier groups, or null.
 * @param {object} [seize]
 * @param {import('./types.mjs').PlannerUnit|null} [seize.blocker] A unit in a Seize unit's way, whose attack earns
 *   the Seize bonus.
 * @param {number} [seize.unlock] How much clearing that blocker shortens the Seize route, from 0 to 1.
 * @returns {Generator<void, object|null>} The best candidate so far, with its `score` and `matchup` added.
 */
export function* measureGroupSteps(search, group, best, { blocker = null, unlock = 0 } = {}) {
  const { unit, risk: riskProfile } = search;
  const weapon = group[0].weapon;
  const measured = new Map();
  let winner = best;
  for (const candidate of group) {
    const defender = candidate.target;
    const flank = { targetFlanked: candidate.flank, attackerFlanked: candidate.flanked };
    const bits = `${flank.targetFlanked ? 1 : 0}${flank.attackerFlanked ? 1 : 0}`;
    const key = `${defender.tokenUuid}|${candidate.distance}|${groundSignature(candidate)}|${bits}`;
    let matchup = measured.get(key);
    if (matchup === undefined) {
      matchup = measure(unit, defender, weapon, candidate.distance, null, {
        ...flank, standing: { x: candidate.anchorX, y: candidate.anchorY },
        ground: { terrain: candidate.terrain, aura: candidate.aura }
      });
      measured.set(key, matchup);
      yield;
    }
    if (!matchup) continue;
    if (matchup.attackCount < 1) continue;
    const blocking = (blocker && defender.tokenUuid === blocker.tokenUuid) ? unlock : 0;
    const scored = score(matchup, unit, defender, riskProfile, candidate, blocking);
    if (!scored.productive) continue;
    if (isBetter(scored, candidate, winner)) winner = { ...candidate, score: scored, matchup };
  }
  return winner;
}

/* -------------------------------------------- */
/*  Scoring                                     */
/* -------------------------------------------- */
/**
 * What a square is worth beyond what can be hit from it: exposure, cover, the flank, the hazard and the walk.
 * @param {import('./types.mjs').StandingSquare|null} position The square as the planner read it.
 * @param {import('./types.mjs').RiskProfile} profile The weights the unit plans with.
 * @param {import('./types.mjs').PlannerUnit} unit The unit standing there.
 * @returns {number} Points added to a plan's total, negative for a bad square.
 */
export function positionalValue(position, profile, unit) {
  if (!position) return 0;
  const maxHp = unit.hpMax || 1;
  let value = 0;
  value -= POSITION_EXPOSURE_PENALTY * profile.exposureWeight * position.exposure;
  value += POSITION_COVER_UNIT * profile.coverWeight * position.cover;
  if (position.flank) value += POSITION_FLANK_BONUS * profile.flankWeight;
  value += SCORE_SCALE * (position.hazard / maxHp) * profile.hazardWeight;
  value -= POSITION_HOLD_GROUND * profile.holdGround * position.moveCost;
  return value;
}

/** The share of a target's worth its faction keeps: an Ally, such as an escort, counts for less than a player unit. */
function targetAppeal(defender) {
  return AI_LESSER_TARGET_FACTIONS.includes(defender?.factionRole) ? AI_LESSER_TARGET_APPEAL : 1;
}

/** The midpoint of a damage figure, which may be a single number or a range such as "4-8". */
function averageDamage(damageValue) {
  const text = String(damageValue ?? '0').trim();
  const spread = text.match(/^(\d+)-(\d+)$/);
  if (spread) return (parseInt(spread[1], 10) + parseInt(spread[2], 10)) / 2;
  const flat = parseInt(text, 10);
  return Number.isNaN(flat) ? 0 : flat;
}

/**
 * Score one attack: what it deals, what it invites, what it opens, and where it leaves the unit. Only `total` weighs
 * damage types, through the profile's `dealtTypeWeight` and `takenTypeWeight`; every other field stays as measured.
 * @param {import('./types.mjs').Matchup} matchup The system's forecast of the exchange.
 * @param {import('./types.mjs').PlannerUnit} unit The unit attacking.
 * @param {import('./types.mjs').PlannerUnit} defender The unit attacked.
 * @param {import('./types.mjs').RiskProfile} risk The weights it plans with.
 * @param {import('./types.mjs').StandingSquare|null} [position] The square it attacks from, or null to leave the
 *   square out.
 * @param {number} [blockerUnlock] How much clearing this defender shortens a Seize route, from 0 to 1; 0 when it
 *   isn't in the way.
 * @returns {import('./types.mjs').AttackScore}
 */
export function score(matchup, unit, defender, risk, position = null, blockerUnlock = 0) {
  if (!risk) throw new TypeError('score: a risk profile is required.');
  const blocking = blockerUnlock > 0;
  const compelled = !!tauntorOf(unit);
  const appeal = (compelled || blocking) ? 1 : targetAppeal(defender);
  const { hitChance, attacks, expected, targetHp, killChance, counterChance, expectedTaken } =
    exchangeOdds(matchup, defender);

  const selfHpNow = unit.hp;
  const selfHp = Math.max(1, selfHpNow - unit.pendingPhaseDamage);
  const selfMaxHp = unit.hpMax || selfHp || 1;
  const targetMaxHp = defender.hpMax || targetHp || 1;
  const suicidal = selfHpNow > 0 && expectedTaken >= selfHp;
  const dealtFraction = expected / targetMaxHp;
  const takenFraction = expectedTaken / selfMaxHp;
  const positional = positionalValue(position, risk, unit);
  const riskDiscount = blocking ? Math.min(1, Math.max(0, blockerUnlock)) : 0;
  const breaksTarget = matchup.willBreak === true;
  const breakProgress = breakProgressOf(matchup, breaksTarget, hitChance, attacks);

  // What the blow gains, in shares of the target's max HP, scaled by what the target is worth to its faction.
  const dealtWorth = dealtFraction * (1 + (risk.dealtTypeWeight * typeAffinity(matchup)));
  const lethalBonus = LETHAL_BONUS * risk.lethalWeight * killChance;
  const unansweredBonus = (1 - counterChance) * dealtWorth * UNANSWERED_FACTOR;
  const breakBonus = breaksTarget ? BREAK_BONUS : 0;
  const progressBonus = BREAK_PROGRESS_WEIGHT * breakProgress;
  const gain = appeal * (dealtWorth + lethalBonus + unansweredBonus + breakBonus + progressBonus);
  // What it risks, in shares of the unit's max HP. The more clearing a blocker opens a Seize route, the less the
  // counter counts, and the same goes for the square below.
  const takenCost = takenFraction * (1 + (risk.takenTypeWeight * typeAffinity(matchup.defender)));
  const counterCost = risk.counterWeight * takenCost * (1 - riskDiscount);
  const suicideCost = (suicidal && !blocking) ? (risk.suicideWeight ?? 1) * SUICIDE_PENALTY : 0;
  // The square and the Seize blocker bonus are already in score points.
  const squareValue = positional * (1 - riskDiscount);
  const blockerBonus = blocking ? SEIZE_BLOCKER_BONUS * blockerUnlock : 0;

  return {
    expectedDamage: expected,
    expectedTaken,
    dealtFraction,
    takenFraction,
    hitChance: matchup.hitChance,
    killChance,
    counterChance,
    unanswered: counterChance === 0,
    suicidal,
    positional,
    breaksTarget,
    breakProgress,
    blocking,
    compelled,
    productive: risk.ignoresProductivity === true || blocking || compelled || expected >= MIN_MEANINGFUL_DAMAGE,
    appeal,
    total: (SCORE_SCALE * (gain - counterCost - suicideCost)) + squareValue + blockerBonus
  };
}

/**
 * The exchange's odds: the attacker's hit chance and blows, the damage it is expected to deal, the target's HP once
 * its pending phase damage lands, and the kill and counter figures `walkExchange` works out.
 */
function exchangeOdds(matchup, defender) {
  const hitChance = Math.max(0, Math.min(100, matchup.hitChance)) / 100;
  const critChance = Math.max(0, Math.min(100, matchup.critChance)) / 100;
  const critMult = matchup.critMultiplier;
  const baseHit = averageDamage(matchup.damage);
  const perHit = baseHit * (1 + (critChance * (critMult - 1)));
  const attacks = Math.max(1, matchup.attackCount || 1);
  const expected = hitChance * perHit * attacks;
  const targetHp = Math.max(1, defender.hp - defender.pendingPhaseDamage);
  const walked = walkExchange(matchup, {
    hitChance, critChance, normalDamage: baseHit, critDamage: baseHit * critMult, targetHp, attacks,
    counters: matchup.defenderCanRespond ? Math.max(0, matchup.defender?.attackCount || 0) : 0,
    counterPerHit: counterPerHitOf(matchup)
  });
  return { hitChance, attacks, expected, targetHp, ...walked };
}

/** The damage each blow of the defender's counter is expected to deal, crits included, or 0 when it can't counter. */
function counterPerHitOf(matchup) {
  if (!matchup.defenderCanRespond) return 0;
  const counterHit = Math.max(0, Math.min(100, matchup.defender?.hitChance ?? 0)) / 100;
  const counterCrit = Math.max(0, Math.min(100, matchup.defender?.critChance ?? 0)) / 100;
  const counterMult = matchup.defender.critMultiplier;
  return counterHit * averageDamage(matchup.defender?.damage) * (1 + (counterCrit * (counterMult - 1)));
}

/** How far, from 0 to 1, the expected hits wear down the target's stance, or 0 when they break it outright. */
function breakProgressOf(matchup, breaksTarget, hitChance, attacks) {
  const targetStance = Math.max(0, matchup.defender?.stance ?? 0);
  return (!breaksTarget && targetStance > 0)
    ? Math.min(1, (hitChance * Math.max(0, matchup.breakDamage ?? 0) * attacks) / targetStance)
    : 0;
}

/**
 * How one side of a matchup lands its damage type on the other: 1 on a vulnerability, -1 on a protection, and 0
 * otherwise or for a side that rolls its type per blow. Immunity needs no sign, since its measured damage is already 0.
 */
function typeAffinity(side) {
  if (!side || side.randomizeDamageType === true) return 0;
  if (side.breakVulnerable === true) return 1;
  return side.breakResisted === true ? -1 : 0;
}

/** Walk an exchange blow by blow, in the order the sequence says, for the kill and the counter it really invites. */
function walkExchange(matchup, {
  hitChance, critChance, normalDamage, critDamage, targetHp, attacks, counters, counterPerHit
}) {
  let strikes = (String(matchup.attackSequence ?? '').match(/[AD]\d+/g) ?? []).map(entry => entry[0]);
  if (!strikes.includes('A')) strikes = [...Array(attacks).fill('A'), ...Array(counters).fill('D')];
  if (counters <= 0) strikes = strikes.filter(entry => entry === 'A');

  const missP = 1 - hitChance;
  const critP = hitChance * critChance;
  const hitP = hitChance - critP;
  let states = new Map([[0, 1]]);
  const standing = () => {
    let mass = 0;
    for (const [dealt, prob] of states) if (targetHp <= 0 || dealt < targetHp) mass += prob;
    return mass;
  };

  let expectedTaken = 0;
  let counterChance = 0;
  let firstCounter = true;
  for (const strike of strikes) {
    if (strike === 'D') {
      const alive = standing();
      if (firstCounter) { counterChance = alive; firstCounter = false; }
      expectedTaken += alive * counterPerHit;
      continue;
    }
    const next = new Map();
    const add = (dealt, prob) => { if (prob > 0) next.set(dealt, (next.get(dealt) ?? 0) + prob); };
    for (const [dealt, prob] of states) {
      add(dealt, prob * missP);
      add(dealt + normalDamage, prob * hitP);
      add(dealt + critDamage, prob * critP);
    }
    states = next;
  }
  const killChance = targetHp > 0 ? Math.max(0, Math.min(1, 1 - standing())) : 0;
  return { killChance, counterChance, expectedTaken };
}

/** Whether a candidate beats the best so far: score, hit chance, movement cost, then token id for determinism. */
function isBetter(scored, candidate, best) {
  if (!best) return true;
  if (scored.total > best.score.total + SCORE_EPSILON) return true;
  if (scored.total < best.score.total - SCORE_EPSILON) return false;
  if (scored.hitChance !== best.score.hitChance) return scored.hitChance > best.score.hitChance;
  if (candidate.moveCost !== best.moveCost) return candidate.moveCost < best.moveCost;
  return candidate.target.tokenId.localeCompare(best.target.tokenId) < 0;
}
