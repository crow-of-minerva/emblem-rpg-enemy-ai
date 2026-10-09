/** @layer planner */
/*
 * Whether a unit can act, read straight off the system's record for it. That record's numbers are never missing and
 * its status keys are already lowercase, so nothing here converts them.
 */
import { FLEEING_STATUSES } from '../constants.mjs';
import { systemIncapacitatingStatuses } from '../foundry/system-bridge.mjs';

/* -------------------------------------------- */
/*  Readiness                                   */
/* -------------------------------------------- */
/** Whether a unit is still standing. */
export function isAlive(unit) {
  return unit.hp > 0;
}

/** Whether a unit's stance is exhausted. */
export function isStanceBroken(unit) {
  return unit.stance <= 0;
}

/**
 * Whether a status has taken this unit's action away, so it attacks nobody: one of the system's incapacitating
 * statuses. A feared unit counts as held.
 */
export function isHeldByStatus(unit) {
  const incapacitating = systemIncapacitatingStatuses();
  return unit.statuses.some(status => incapacitating.includes(status));
}

/**
 * Whether a status forces this unit to spend its own turn fleeing: it is feared, and no other status holds it in place.
 * Everywhere but its own turn, a feared unit counts as held through {@link isHeldByStatus}.
 */
export function fleesByStatus(unit) {
  if (!unit.statuses.some(status => FLEEING_STATUSES.includes(status))) return false;
  const incapacitating = systemIncapacitatingStatuses();
  return !unit.statuses.some(status => incapacitating.includes(status) && !FLEEING_STATUSES.includes(status));
}

/** Whether this unit can't act at all when its turn comes: its stance is broken, or a status holds it. */
export function isIncapacitated(unit) {
  if (!unit) return false;
  return isStanceBroken(unit) || isHeldByStatus(unit);
}
