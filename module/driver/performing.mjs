/** @layer driver */
import { LOG } from '../constants.mjs';
import { faceTargets, playSound } from '../foundry/system-bridge.mjs';
import { unitByTokenUuid } from '../planner/board.mjs';
import { occupiedCells } from '../planner/geometry.mjs';
import { invalidateBoardMemo } from '../planner/memo.mjs';
import { canActivate, canTarget, loadout } from '../planner/roster.mjs';
import { bonusSelfHealItemsOf, healThresholdOf, itemHasUses } from '../planner/support.mjs';
import { footprintOccupiedIn, unitDistance } from '../planner/vocabulary.mjs';
import { awaitSettled } from './pacing.mjs';
import { routeFrom, segmentRoute } from './routes.mjs';
import { NO_EXECUTION } from './segment.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
/** What the driver answers when an exchange or an activation offers it a choice. */
const END_TURN_DECISION = 'end-turn';

/* -------------------------------------------- */
/*  Movement execution                          */
/* -------------------------------------------- */
/** Whether the unit's document now stands on a destination, read off a freshly invalidated board. */
function hasArrived(unit, destination) {
  const fresh = unitByTokenUuid(unit.tokenUuid);
  if (!fresh || !destination) return false;
  return fresh.x === destination.x && fresh.y === destination.y;
}

/**
 * Walk and hop a unit to a destination, settling the plan the way the caller asked. Each walked run goes to the
 * system's own drive through the run's execution segment (`driver/segment.mjs`), which re-judges the route itself.
 * @param {object} planner The Scene's planner, which owns the teleport pads a route may use.
 * @param {object} unit The unit as the board last showed it.
 * @param {object} destination The square the plan wants.
 * @param {object} graph The movement graph the plan was made on.
 * @param {object} [options] `path` overrides the route, `then` settles the plan, `actions` is the segment's gameplay.
 * @returns {Promise<boolean>} Whether the unit's document ended up on the destination.
 */
export async function moveTo(planner, unit, destination, graph, {
  path = null, then = 'stand', actions = NO_EXECUTION
} = {}) {
  const route = path?.length ? path : routeFrom(graph, unit.x, unit.y, destination);
  const segments = segmentRoute(planner, [unit.x, unit.y], route ?? []);
  if (!segments.length) {
    await driveCells(unit, [], then, actions);
    return hasArrived(unit, destination);
  }
  let walked = false;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const last = index === segments.length - 1;
    if (segment.kind === 'teleport' && !walked && !await openPlan(unit, actions)) break;
    const landed = segment.kind === 'teleport'
      ? await hop(unit, segment, actions)
      : await driveCells(unit, segment.steps, last ? then : 'plan', actions);
    if (!landed) break;
    walked = walked || segment.kind === 'walk';
    if (last && segment.kind === 'teleport' && then !== 'plan') await driveCells(unit, [], then, actions);
  }
  return hasArrived(unit, destination);
}

/** Open a movement plan for an action to settle from. The system's drive leaves a plan that is already open alone. */
async function openPlan(unit, actions = NO_EXECUTION) {
  return driveCells(unit, [], 'plan', actions);
}

/** Hand one walked run to the system's own drive, which re-judges the route before it moves anything. */
async function driveCells(unit, steps, then, actions = NO_EXECUTION) {
  const path = steps.map(([x, y]) => ({ x, y }));
  const result = await actions.drive({ tokenUuid: unit.tokenUuid, path, then });
  invalidateBoardMemo();
  if (result?.ok !== true) console.warn(`${LOG} ${unit.name} could not walk its route.`, result?.code ?? '');
  return result?.ok === true;
}

/** Teleport from the pad the unit stands on, using the plan the walk before it left open or `moveTo` opened. */
async function hop(unit, segment, actions = NO_EXECUTION) {
  const result = await actions.teleport(unit.tokenUuid);
  invalidateBoardMemo();
  if (result?.ok !== true) {
    console.warn(`${LOG} ${unit.name}'s teleport ${segment.letter} was refused.`, result?.code ?? '');
    return false;
  }
  await playSound('ui.select');
  return true;
}

/**
 * Take off with the system's flight action, which is taken from an open plan and spends the whole action, ending
 * the unit's turn. False when the plan or the flight is refused, so the turn can carry on without it.
 */
export async function takeOff(unit, actions = NO_EXECUTION) {
  if (!await openPlan(unit, actions)) return false;
  const result = await actions.toggleFlight(unit.tokenUuid);
  invalidateBoardMemo();
  if (result?.ok !== true) console.warn(`${LOG} ${unit.name} could not take off.`, result?.code ?? '');
  return result?.ok === true;
}

/* -------------------------------------------- */
/*  Performing                                  */
/* -------------------------------------------- */
/** Wield the weapon a unit is about to swing, unless it already is. */
async function equip(unit, weapon, actions = NO_EXECUTION) {
  if (!weapon || weapon.wielded === true) return true;
  const result = await actions.wieldWeapon(unit.actorUuid, weapon.id);
  invalidateBoardMemo();
  return result?.ok !== false;
}

/** Whether a unit is standing on another, which denies it the action outright. */
function squareShared(unit) {
  return footprintOccupiedIn(occupiedCells(unit), unit, unit.x, unit.y);
}

/** The acting unit behind a plan, re-read off the current board. */
function actingUnit(plan) {
  return unitByTokenUuid(plan.unit?.tokenUuid ?? plan.tokenUuid ?? '');
}

/** The unit a plan is aimed at, re-read off the current board. */
function planTarget(plan) {
  return unitByTokenUuid((plan.target ?? plan.targetToken)?.tokenUuid ?? '');
}

/** Answer a continuation the system offered, ending the turn rather than taking a second swing on the spot. */
async function answerContinuation(unit, continuation, actions = NO_EXECUTION) {
  if (continuation?.requiresChoice !== true) return false;
  const result = await actions.resolveContinuation({
    sourceTokenUuid: unit.tokenUuid,
    exchangeRequestId: continuation.exchangeRequestId ?? '',
    decision: END_TURN_DECISION
  });
  invalidateBoardMemo();
  return result?.ok === true;
}

/** Carry out a planned attack, everything the plan assumed re-verified on the board as it now stands. */
export async function attack(plan, actions = NO_EXECUTION) {
  const unit = actingUnit(plan);
  const target = planTarget(plan);
  if (!unit || !target || !plan.weapon) {
    console.warn(`${LOG} an attack lost its unit or its target before it landed and was aborted.`);
    return false;
  }
  if (!verifyAttack(unit, target, plan)) return false;
  await equip(unit, plan.weapon, actions);
  actions.checkpoint();
  await faceTargets(unit.tokenUuid, target.tokenUuid);
  if (!await openPlan(unit, actions)) return false;
  const result = await actions.resolveExchange({
    sourceTokenUuid: unit.tokenUuid,
    targetTokenUuid: target.tokenUuid,
    itemUuid: plan.weapon.uuid,
    damageType: plan.dmgType ?? '',
    skippedAttacks: [],
    previewFingerprint: '',
    weaponArtUuid: ''
  });
  invalidateBoardMemo();
  if (result?.ok !== true) {
    console.warn(`${LOG} ${unit.name}'s exchange was refused.`, result?.code ?? '');
    return false;
  }
  await answerContinuation(unit, result.data?.continuation, actions);
  return true;
}

/** The checks an attack must pass once the unit has stopped walking: its square, range and weapon requirements. */
function verifyAttack(unit, target, plan) {
  if (squareShared(unit)) {
    console.warn(`${LOG} ${unit.name} is sharing a square, so its attack was aborted.`);
    return false;
  }
  const distance = unitDistance(unit, target);
  const range = plan.weapon.range;
  if (!range || distance < range.minRange || distance > range.maxRange) {
    console.warn(`${LOG} ${unit.name} was at range ${distance}, outside ${plan.weapon.name}, so it was aborted.`);
    return false;
  }
  if (!canActivate(unit, plan.weapon) || !canTarget(unit, plan.weapon, target)) {
    console.warn(`${LOG} ${plan.weapon.name} no longer meets its requirements, so the attack was aborted.`);
    return false;
  }
  return true;
}

/**
 * Use a bonus-action self-heal between moving and acting when the unit is below the item's heal threshold. It costs
 * the turn's action nothing. Returns true when one was used.
 */
export async function useBonusSelfHeal(unit, { onEngage = null, actions = NO_EXECUTION } = {}) {
  const fresh = unitByTokenUuid(unit.tokenUuid) ?? unit;
  if (fresh.turn?.bonusActionAvailable !== true) return false;
  const maxHp = Number(fresh.hpMax) || 0;
  const hp = Number(fresh.hp) || 0;
  if (maxHp <= 0 || hp <= 0) return false;
  const fraction = hp / maxHp;
  for (const item of bonusSelfHealItemsOf(loadout(fresh).items)) {
    if (!item.range || fraction >= healThresholdOf(item)) continue;
    if (!canActivate(fresh, item) || !canTarget(fresh, item, fresh)) continue;
    if (onEngage) await onEngage();
    if (!await activate(fresh, item, fresh, actions)) return false;
    await awaitSettled({ label: `${fresh.name}'s bonus action` });
    return true;
  }
  return false;
}

/** Perform a planned support action, re-verifying what may have changed while the unit walked. */
export async function useAbility(plan, actions = NO_EXECUTION) {
  const unit = actingUnit(plan);
  const target = planTarget(plan);
  const item = plan.item;
  if (!unit || !target || !item) {
    console.warn(`${LOG} an ability lost its unit or its target before it landed and was aborted.`);
    return false;
  }
  if (!verifyAbility(unit, target, item)) return false;
  actions.checkpoint();
  if (target.tokenUuid !== unit.tokenUuid) await faceTargets(unit.tokenUuid, target.tokenUuid);
  return activate(unit, item, target, actions);
}

/** The checks an ability must pass once the unit has stopped walking: its square, uses, requirements and range. */
function verifyAbility(unit, target, item) {
  if (squareShared(unit)) {
    console.warn(`${LOG} ${unit.name} is sharing a square, so its ability was aborted.`);
    return false;
  }
  if (!itemHasUses(item)) {
    console.warn(`${LOG} ${item.name} is out of uses, so the ability was aborted.`);
    return false;
  }
  if (!canActivate(unit, item) || !canTarget(unit, item, target)) {
    console.warn(`${LOG} ${item.name} no longer meets its requirements, so the ability was aborted.`);
    return false;
  }
  if (target.tokenUuid === unit.tokenUuid) return true;
  const distance = unitDistance(unit, target);
  const range = item.range;
  if (!range || distance < range.minRange || distance > range.maxRange) {
    console.warn(`${LOG} ${unit.name} was at range ${distance}, outside ${item.name}, so the ability was aborted.`);
    return false;
  }
  return true;
}

/** Hand one activation to the system, then answer whatever continuation it offers. */
async function activate(unit, item, target, actions = NO_EXECUTION) {
  if (!await openPlan(unit, actions)) return false;
  const result = await actions.activateItem({
    sourceTokenUuid: unit.tokenUuid,
    itemUuid: item.uuid,
    targetTokenUuids: [target.tokenUuid],
    aim: null,
    placement: null,
    params: {}
  });
  invalidateBoardMemo();
  if (result?.ok !== true) {
    console.warn(`${LOG} ${unit.name} could not use ${item.name}.`, result?.code ?? '');
    return false;
  }
  await answerContinuation(unit, result.data?.continuation, actions);
  return true;
}
