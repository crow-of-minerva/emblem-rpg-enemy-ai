/** @layer planner */
/*
 * What a unit carries, as the system judges it, with the AI parameters the GM gave each item: its weapons and their
 * ranges, and whether it may use an item at all or on a given target. The answers come from the system and are
 * cached until the map changes.
 */
import { readItemAiData } from '../foundry/flags.mjs';
import { canUse, itemSightRule, itemTargetsSelf, loadoutOf } from '../foundry/system-bridge.mjs';
import { boardMemo } from './memo.mjs';

/* -------------------------------------------- */
/*  Loadout                                     */
/* -------------------------------------------- */
/**
 * A unit's weapons and items as the system judges them, each item joined to its AI parameters and a Self item given a
 * range of 0 to 0 (cached until the map changes). Each weapon also carries `losRule`, copied from the same item in
 * `items`, because the system's weapon records leave out the line-of-sight rule an attack is judged by.
 */
export function loadout(unit) {
  return boardMemo(`loadout|${unit.tokenUuid}`, () => {
    const carried = loadoutOf(unit.tokenUuid);
    const itemsById = new Map((carried.items ?? []).map(item => [item.id, item]));
    return Object.freeze({
      weapons: Object.freeze((carried.weapons ?? []).map(weapon => Object.freeze({
        ...weapon,
        losRule: itemSightRule(itemsById.get(weapon.id))
      }))),
      items: Object.freeze((carried.items ?? []).map(item => Object.freeze({
        ...item,
        range: item.range && itemTargetsSelf(item) ? { minRange: 0, maxRange: 0 } : item.range,
        aiData: readItemAiData(item)
      })))
    });
  });
}

/** Every weapon this unit could actually swing (cached until the map changes). */
export function usableWeapons(unit) {
  return boardMemo(`weapons|${unit.tokenUuid}`, () => loadout(unit).weapons
    .filter(weapon => weapon.usable === true && weapon.range));
}

/** Whether this unit may activate this item at all, by its own state. */
export function canActivate(unit, item) {
  if (!unit || !item) return false;
  return boardMemo(`activate|${unit.tokenUuid}|${item.id}`, () => canUse({
    tokenUuid: unit.tokenUuid, itemId: item.id
  }).ok === true);
}

/** Whether this item may be used against this target, by the target's state. */
export function canTarget(unit, item, target) {
  if (!unit || !item || !target) return false;
  return boardMemo(`target|${unit.tokenUuid}|${item.id}|${target.tokenUuid}`, () => canUse({
    tokenUuid: unit.tokenUuid, itemId: item.id, targetTokenUuid: target.tokenUuid
  }).ok === true);
}

/** The ranges of every weapon this unit could swing. */
export function pursuitRanges(unit) {
  const ranges = [];
  for (const weapon of usableWeapons(unit)) {
    if (weapon.range) ranges.push(weapon.range);
  }
  return ranges;
}
