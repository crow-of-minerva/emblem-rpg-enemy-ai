/** @layer planner */
/*
 * Which units the AI plays on a Scene, in a fixed order, and whether a unit can act. Who a unit may attack is in
 * targeting.mjs, and what it carries and may use is in loadout.mjs.
 */
import { isAiFaction } from '../foundry/system-bridge.mjs';
import { board } from './board.mjs';
import { isAlive, isHeldByStatus, isStanceBroken } from './readiness.mjs';

/* -------------------------------------------- */
/*  Roster                                      */
/* -------------------------------------------- */
/** Every unit the AI could play on this planner's Scene, in a fixed order so a phase replays the same way. */
export function collectUnits(planner) {
  return board(planner).units
    .filter(unit => isEligibleUnit(unit))
    .sort((a, b) => (a.sort - b.sort) || a.tokenId.localeCompare(b.tokenId));
}

/**
 * Whether a unit is one the AI plays (a Character of one of the system's enemy or neutral factions), alive and on the
 * map. A hidden token counts as not yet on the map.
 */
export function isEligibleUnit(unit) {
  if (!unit) return false;
  if (unit.hidden) return false;
  if (!unit.isCharacter) return false;
  if (!isAiFaction(unit.factionRole)) return false;
  return isAlive(unit);
}

/** Whether a unit is able to act at all, ignoring this turn's bookkeeping. */
export function canEverAct(unit) {
  return isAlive(unit) && !isStanceBroken(unit) && !isHeldByStatus(unit);
}

/** Whether a unit may act right now: able to act at all, and with its action still in hand. */
export function canAct(unit) {
  if (!unit) return false;
  if (unit.turn?.turnComplete === true) return false;
  if (unit.turn?.actionAvailable !== true) return false;
  return canEverAct(unit);
}
