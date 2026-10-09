/** @layer ui */
/*
 * The attack intent the system's threat line shows for a selected enemy: who it will attack on its turn and how hard.
 * The plan runs in the browser's idle time and starts again if the map changes while it runs.
 */
import { LOG } from '../constants.mjs';
import { sceneUuidOfToken } from '../foundry/documents.mjs';
import { gradeThreat, registerIntentProvider, systemThreatTiers } from '../foundry/system-bridge.mjs';
import { CombatAI } from '../combat-ai.mjs';
import { isRunning } from '../driver/state.mjs';
import { unitByTokenUuid } from '../planner/board.mjs';
import { boardEpoch } from '../planner/memo.mjs';
import { planTurnSteps } from '../planner/planning.mjs';
import { isManual, isPassive, riskProfileFor } from '../planner/profile.mjs';
import { isIncapacitated } from '../planner/readiness.mjs';
import { TURN_KINDS, turnCourse } from '../planner/turn-course.mjs';
import { ABANDONED, runWhenIdle } from './idle-steps.mjs';

/* -------------------------------------------- */
/*  Grading                                     */
/* -------------------------------------------- */
/** The figures of a plan's matchup that the system's `combat.gradeThreat` reads. */
function matchupFigures(matchup) {
  if (!matchup) return null;
  return {
    attackCount: matchup.attackCount,
    hitChance: matchup.hitChance,
    critChance: matchup.critChance,
    critMultiplier: matchup.critMultiplier,
    damage: matchup.damage
  };
}

/* -------------------------------------------- */
/*  Intent                                      */
/* -------------------------------------------- */
/**
 * Who a unit will attack on its turn, and how hard, or null, for the system's threat line each time an enemy is
 * selected; a unit on a Retreat gets no line, and one that can't act gets an inert one. The plan runs in the browser's
 * idle time and starts again if anything on the map changed while it ran.
 * @param {string} tokenUuid The unit asked about.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] Aborted by the caller once it no longer wants the answer.
 * @returns {Promise<object|null>} The frozen intent, or null.
 */
async function assessAttackIntent(tokenUuid, { signal = null } = {}) {
  const uuid = String(tokenUuid ?? '');
  const unwanted = () => signal?.aborted === true || isRunning();
  let unit = null;
  let inert = false;
  let plan = null;
  let stale = false;
  do {
    const epoch = boardEpoch();
    const moved = () => epoch !== boardEpoch();
    unit = unitByTokenUuid(uuid);
    if (!unit) return null;
    const planner = CombatAI.forScene(sceneUuidOfToken(uuid));
    if (unwanted()) return null;
    const course = turnCourse(planner, unit, { ignoreTurnState: true });
    unit = course.unit;
    if (isPassive(unit) || isManual(unit)) return null;
    inert = isIncapacitated(unit);
    if (!inert && course.kind !== TURN_KINDS.ACT) return null;
    try {
      plan = await runWhenIdle(planTurnSteps(planner, unit, riskProfileFor(planner, unit), {
        ignoreTurnState: true, ignoreReadiness: inert
      }), { abandoned: () => unwanted() || moved() });
    } catch (error) {
      console.warn(`${LOG} attack intent: planning failed for ${unit.name}.`, error);
      return null;
    }
    if (unwanted()) return null;
    stale = plan === ABANDONED || moved();
  } while (stale);
  const target = plan?.target ?? null;
  if (!plan || plan.kind !== 'attack' || !target) return null;
  // This line reports the attack the unit is about to make, so it is graded with allowLethal: true, and a blow that
  // would kill grades lethal rather than severe. The system's threat overlay never passes it.
  const graded = inert ? null : gradeThreat({
    matchup: matchupFigures(plan.matchup), targetHp: target.hp, allowLethal: true
  }) ?? { tier: systemThreatTiers().MINOR, damageOnHit: 0 };
  return Object.freeze({
    targetTokenUuid: target.tokenUuid,
    weapon: plan.weapon.name ?? null,
    tier: inert ? systemThreatTiers().INERT : graded.tier,
    damageOnHit: inert ? 0 : graded.damageOnHit
  });
}

/** Register the helper the system's threat line asks about the selected enemy's attack. */
export function installIntentProvider() {
  return registerIntentProvider((tokenUuid, options) => assessAttackIntent(tokenUuid, options));
}
