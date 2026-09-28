/** @layer planner */
import {
  AI_LESSER_TARGET_APPEAL,
  AI_LESSER_TARGET_FACTIONS,
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
} from '../constants.mjs';
import { measure as measureMatchup } from '../foundry/system-bridge.mjs';
import { groundSignature } from './geometry.mjs';
import { tauntorOf } from './roster.mjs';
import { averageDamage } from './vocabulary.mjs';

/* -------------------------------------------- */
/*  Measurement                                 */
/* -------------------------------------------- */
/**
 * One matchup as the exchange would resolve it, measured from a hypothetical square. `ground` passes the square's
 * terrain and aura values, which anchorPropertiesSteps in `planning.mjs` has already read. The system works out any
 * part left out itself, and rebuilding the aura board for each matchup is most of what that costs.
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

/** The ground values to pass to the system: terrain the planner priced, and aura fields only when there are some. */
function suppliedGround(ground) {
  const supplied = {};
  if (ground?.terrain) supplied.terrainModifiers = ground.terrain;
  if (ground?.aura && Object.keys(ground.aura).length > 0) supplied.auraFields = ground.aura;
  return supplied;
}

/**
 * Score every candidate square for one weapon, measuring each distinct matchup once, and return the best so far.
 * `planning.mjs` groups the candidates by weapon and calls this once per group. It yields after every matchup the
 * system really measured, the one expensive call in a plan, and never after a remembered one, so
 * `ui/idle-steps.mjs` can spread a plan across frames.
 */
export function* measureGroupSteps(group, unit, weapon, riskProfile, best, blocker = null, unlock = 0) {
  const measured = new Map();
  let winner = best;
  for (const candidate of group) {
    const defender = candidate.targetToken;
    const flank = { targetFlanked: candidate.flank, attackerFlanked: candidate.flanked };
    const bits = `${flank.targetFlanked ? 1 : 0}${flank.attackerFlanked ? 1 : 0}`;
    const key = `${defender.tokenUuid}|${candidate.distance}|${groundSignature(candidate)}|${bits}`;
    let cData = measured.get(key);
    if (cData === undefined) {
      cData = measure(unit, defender, weapon, candidate.distance, null, {
        ...flank, standing: { x: candidate.anchorX, y: candidate.anchorY },
        ground: { terrain: candidate.terrain, aura: candidate.aura }
      });
      measured.set(key, cData);
      yield;
    }
    if (!cData) continue;
    if (cData.attackCount < 1) continue;
    const blocking = (blocker && defender.tokenUuid === blocker.tokenUuid) ? unlock : 0;
    const scored = score(cData, unit, defender, riskProfile, candidate, blocking);
    if (!scored.productive) continue;
    if (isBetter(scored, candidate, winner)) winner = { ...candidate, score: scored, cData };
  }
  return winner;
}

/* -------------------------------------------- */
/*  Scoring                                     */
/* -------------------------------------------- */
/** What a square is worth beyond what can be hit from it: exposure, cover, the flank, the hazard and the walk. */
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

/**
 * Score one attack: what it deals, what it invites, what it opens, and where it leaves the unit. The profile also
 * weighs damage types against the raw numbers: `dealtTypeWeight` scales the blow's worth and `takenTypeWeight` the
 * counter's cost by how each one's type lands, as typeAffinity below reads it. Only `total` carries that weighing.
 * Every other field stays as measured.
 */
export function score(cData, unit, defender, risk, position = null, blockerUnlock = 0) {
  if (!risk) throw new TypeError('score: a risk profile is required.');
  const profile = risk;
  const blocking = blockerUnlock > 0;
  const compelled = !!tauntorOf(unit);
  const appeal = (compelled || blocking) ? 1 : targetAppeal(defender);
  const counterWeight = profile.counterWeight;
  const lethalWeight = profile.lethalWeight;
  const hitChance = Math.max(0, Math.min(100, cData.hitChance)) / 100;
  const critChance = Math.max(0, Math.min(100, cData.critChance)) / 100;
  const critMult = Number(cData.critMultiplier) || Number(unit.critMultiplier) || 2;
  const baseHit = averageDamage(cData.damage);
  const perHit = baseHit * (1 + (critChance * (critMult - 1)));
  const attacks = Math.max(1, cData.attackCount || 1);
  const expected = hitChance * perHit * attacks;

  const targetHp = Math.max(1, (defender.hp ?? 0) - (defender.pendingPhaseDamage ?? 0));
  let counterPerHit = 0;
  if (cData.defenderCanRespond) {
    const counterHit = Math.max(0, Math.min(100, cData.defender?.hitChance ?? 0)) / 100;
    const counterCrit = Math.max(0, Math.min(100, cData.defender?.critChance ?? 0)) / 100;
    const counterMult = Number(cData.defender?.critMultiplier) || Number(defender.critMultiplier) || 2;
    counterPerHit = counterHit * averageDamage(cData.defender?.damage) * (1 + (counterCrit * (counterMult - 1)));
  }
  const { killChance, counterChance, expectedTaken } = walkExchange(cData, {
    hitChance, critChance, normalDamage: baseHit, critDamage: baseHit * critMult, targetHp, attacks,
    counters: cData.defenderCanRespond ? Math.max(0, cData.defender?.attackCount || 0) : 0, counterPerHit
  });

  const selfHpNow = unit.hp ?? 0;
  const selfHp = Math.max(1, selfHpNow - (unit.pendingPhaseDamage ?? 0));
  const selfMaxHp = unit.hpMax || selfHp || 1;
  const targetMaxHp = defender.hpMax || targetHp || 1;
  const suicidal = selfHpNow > 0 && expectedTaken >= selfHp;
  const unanswered = counterChance === 0;

  const dealtFraction = expected / targetMaxHp;
  const takenFraction = expectedTaken / selfMaxHp;
  const dealtWorth = dealtFraction * (1 + (profile.dealtTypeWeight * typeAffinity(cData)));
  const takenCost = takenFraction * (1 + (profile.takenTypeWeight * typeAffinity(cData.defender)));
  const positional = positionalValue(position, profile, unit);
  const caution = blocking ? Math.min(1, Math.max(0, blockerUnlock)) : 0;

  const breaksTarget = cData.willBreak === true;
  const targetStance = Math.max(0, cData.defender?.stance ?? 0);
  const breakProgress = (!breaksTarget && targetStance > 0)
    ? Math.min(1, (hitChance * Math.max(0, cData.breakDamage ?? 0) * attacks) / targetStance)
    : 0;

  return {
    expectedDamage: expected,
    expectedTaken,
    dealtFraction,
    takenFraction,
    hitChance: cData.hitChance,
    killChance,
    counterChance,
    unanswered,
    suicidal,
    positional,
    breaksTarget,
    breakProgress,
    blocking,
    compelled,
    productive: profile.ignoresProductivity === true || blocking || compelled
      || expected >= MIN_MEANINGFUL_DAMAGE,
    appeal,
    total: SCORE_SCALE * (
      appeal * (
        dealtWorth
        + (LETHAL_BONUS * lethalWeight * killChance)
        + ((1 - counterChance) * dealtWorth * UNANSWERED_FACTOR)
        + (breaksTarget ? BREAK_BONUS : 0)
        + (BREAK_PROGRESS_WEIGHT * breakProgress)
      )
      - (counterWeight * takenCost * (1 - caution))
      - ((suicidal && !blocking) ? (profile.suicideWeight ?? 1) * SUICIDE_PENALTY : 0)
    ) + (positional * (1 - caution)) + (blocking ? SEIZE_BLOCKER_BONUS * blockerUnlock : 0)
  };
}

/**
 * How one side of a matchup lands its damage type on the other: 1 on a vulnerability, -1 on a protection, 0
 * otherwise. score reads this unit's blow off the matchup and the counter off its `defender`. The system works out
 * both for the exchange being weighed: this unit attacking from the square with the weapon it would swing, the
 * defender answering with the weapon it holds. A side that rolls its type per blow counts as 0, since the matchup
 * names only the first type it could roll. Immunity needs no sign, because the measured damage is already nothing.
 */
function typeAffinity(side) {
  if (!side || side.randomizeDamageType === true) return 0;
  if (side.breakVulnerable === true) return 1;
  return side.breakResisted === true ? -1 : 0;
}

/** Walk an exchange blow by blow, in the order the sequence says, for the kill and the counter it really invites. */
function walkExchange(cData, {
  hitChance, critChance, normalDamage, critDamage, targetHp, attacks, counters, counterPerHit
}) {
  let strikes = (String(cData.attackSequence ?? '').match(/[AD]\d+/g) ?? []).map(entry => entry[0]);
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
