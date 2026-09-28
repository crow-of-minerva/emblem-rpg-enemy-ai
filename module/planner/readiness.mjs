/** @layer planner */
import { FLEEING_STATUSES, INCAPACITATING_STATUSES } from '../constants.mjs';

/* -------------------------------------------- */
/*  Readiness                                   */
/* -------------------------------------------- */
/** Whether a unit is still standing. */
export function isAlive(unit) {
  return (Number(unit?.hp) || 0) > 0;
}

/** Whether a unit's stance is exhausted. */
export function isStanceBroken(unit) {
  return (Number(unit?.stance) || 0) <= 0;
}

/** Whether a status has taken this unit's action away, so it attacks nobody. A feared unit counts as held. */
export function isHeldByStatus(unit) {
  return statusKeysOf(unit).some(status => INCAPACITATING_STATUSES.includes(status));
}

/**
 * Whether a status forces this unit to spend its own turn fleeing: it is feared, and no other status holds it in place
 * outright. `planner/phase-roster.mjs` gives such a unit its turn and `driver/turn.mjs` spends it on a retreat. Every
 * other reader still counts it held through {@link isHeldByStatus}.
 */
export function fleesByStatus(unit) {
  const statuses = statusKeysOf(unit);
  if (!statuses.some(status => FLEEING_STATUSES.includes(status))) return false;
  return !statuses.some(status => INCAPACITATING_STATUSES.includes(status) && !FLEEING_STATUSES.includes(status));
}

/** Whether this unit can't act at all when its turn comes: its stance is broken, or a status holds it. */
export function isIncapacitated(unit) {
  if (!unit) return false;
  return isStanceBroken(unit) || isHeldByStatus(unit);
}

/** A unit's status keys, lower-cased so a status is matched without regard to case. */
function statusKeysOf(unit) {
  return Array.from(unit?.statuses ?? [], status => String(status).toLowerCase());
}
