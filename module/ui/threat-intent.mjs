/** @layer ui */
import { LOG } from '../constants.mjs';
import { sceneUuidOfToken } from '../foundry/flags.mjs';
import { gradeThreat, registerIntentProvider, systemThreatTiers } from '../foundry/system-bridge.mjs';
import { CombatAI } from '../combat-ai.mjs';
import { isRunning } from '../driver/state.mjs';
import { unitByTokenUuid } from '../planner/board.mjs';
import { boardEpoch, invalidateBoardMemo } from '../planner/memo.mjs';
import { planTurnSteps } from '../planner/planning.mjs';
import { directiveOf, isManual, isPassive, riskProfileFor } from '../planner/profile.mjs';
import { isIncapacitated } from '../planner/readiness.mjs';
import { ABANDONED, runWhenIdle } from './idle-steps.mjs';

/* -------------------------------------------- */
/*  Grading                                     */
/* -------------------------------------------- */
/** The plan's matchup figures, in the shape `game/combat/threat.mjs`'s gradeMatchupThreat/damageFigures reads. */
function matchupOf(cData) {
  if (!cData) return null;
  return {
    attackCount: cData.attackCount,
    hitChance: cData.hitChance,
    critChance: cData.critChance,
    critMultiplier: cData.critMultiplier,
    damage: cData.damage
  };
}

/* -------------------------------------------- */
/*  Intent                                      */
/* -------------------------------------------- */
/**
 * Who a unit will attack on its turn, and how hard, or null when it has no attack to make. The system's threat lines
 * ask this each time an enemy is selected. A full plan is slow, so `runWhenIdle` runs it in the page's idle time, a
 * few steps per frame. The caller's signal abandons a plan nobody is waiting for, and a plan is started again if
 * anything on the map changed while it ran.
 * @param {string} tokenUuid The unit asked about.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] Aborted by the caller once it no longer wants the answer.
 * @returns {Promise<object|null>} The frozen intent, or null.
 */
async function assessAttackIntent(tokenUuid, { signal = null } = {}) {
  invalidateBoardMemo();
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
    if (isManual(unit)) return null;
    if (unwanted()) return null;
    const directive = directiveOf(planner, unit);
    if (directive?.behavior === 'switchProfile') {
      unit = Object.freeze({ ...unit, ai: Object.freeze({ ...unit.ai, profile: directive.profile }) });
    }
    if (isPassive(unit) || isManual(unit)) return null;
    inert = isIncapacitated(unit);
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
  const target = plan?.target ?? plan?.targetToken ?? null;
  if (!plan || plan.kind !== 'attack' || !target) return null;
  // This line reports the attack the unit is about to make, so it is graded with allowLethal: true, and a blow that
  // would kill grades lethal rather than severe. The system's threat overlay never passes it.
  const graded = inert ? null : gradeThreat({ matchup: matchupOf(plan.cData), targetHp: target.hp, allowLethal: true })
    ?? { tier: systemThreatTiers().MINOR, damageOnHit: 0 };
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
