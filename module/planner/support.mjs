/** @layer planner */
/*
 * The items the AI uses besides its weapons, today the ones the GM gave the Heal role: which kinds of item it may
 * use, which heals it can pick, when a unit is hurt enough for one, and what a heal is worth.
 */
import { AI_ITEM_ROLE_VALUES, AI_ITEM_SUBTYPES } from '../constants.mjs';
import {
  itemIsConsumable,
  itemReachesOneUnit,
  itemTakesBonusAction,
  itemTakesStandardAction,
  itemTargetsSelf
} from '../foundry/system-bridge.mjs';
import { canActivate, canTarget, loadout } from './loadout.mjs';
import { isAlive } from './readiness.mjs';

/* -------------------------------------------- */
/*  Item role and uses                          */
/* -------------------------------------------- */
/** The AI role the GM gave a loadout item, or null when it has none or names one this module does not offer. */
function itemRole(item) {
  const role = item?.aiData?.role;
  return AI_ITEM_ROLE_VALUES.includes(role) ? role : null;
}

/** Whether a loadout item can still be used. */
export function itemHasUses(item) {
  if (!item) return false;
  return item.usesInfinite === true || (Number(item.usesCurrent) || 0) > 0;
}

/* -------------------------------------------- */
/*  Item selection                              */
/* -------------------------------------------- */
/**
 * Whether the AI may use an item of this kind: a Consumable, or one of the subtypes in AI_ITEM_SUBTYPES. Only these
 * items get the AI Parameters button on their sheet.
 * @param {{type: string, itemType: string}} kind The Foundry item type and the system's subtype of the item.
 * @returns {boolean}
 */
export function aiUsesItemKind(kind) {
  return AI_ITEM_SUBTYPES.includes(kind.itemType) || itemIsConsumable(kind);
}

/** Items with the Heal role (support subtypes and Consumables) that heal one target with a standard action. */
export function healItemsOf(items) {
  return (items ?? []).filter(item => itemRole(item) === 'heal'
    && aiUsesItemKind(item)
    && itemTakesStandardAction(item)
    && itemReachesOneUnit(item)
    && itemHasUses(item));
}

/**
 * Heal-role items that heal the user as a bonus action, such as Second Wind. The planner never plans them; the unit's
 * turn takes one through `bonusSelfHealDue`.
 */
export function bonusSelfHealItemsOf(items) {
  return (items ?? []).filter(item => itemRole(item) === 'heal'
    && aiUsesItemKind(item)
    && itemTakesBonusAction(item)
    && itemTargetsSelf(item)
    && itemHasUses(item));
}

/**
 * The bonus-action self-heal a unit would use now, or null: the first Heal-role item it can use on itself as a bonus
 * action while its HP is below that item's heal threshold. Every profile uses one, whatever its heal weight.
 * @param {import('./types.mjs').PlannerUnit} unit The unit as last read from the map.
 * @returns {object|null} The loadout item.
 */
export function bonusSelfHealDue(unit) {
  if (unit?.turn?.bonusActionAvailable !== true || !isAlive(unit)) return null;
  return bonusSelfHealItemsOf(loadout(unit).items).find(item => item.range && hurtEnoughFor(unit, item)
    && canActivate(unit, item) && canTarget(unit, item, unit)) ?? null;
}

/* -------------------------------------------- */
/*  Valuation                                   */
/* -------------------------------------------- */
/** The health fraction below which a target qualifies for this item's heal. */
function healThresholdOf(item) {
  return item.aiData.threshold / 100;
}

/**
 * Whether a unit is hurt enough for this item's heal: alive, with its HP below the item's threshold share of its max.
 * @param {{hp: number, hpMax: number}} unit The unit the heal would land on.
 * @param {object} item A Heal-role loadout item.
 * @returns {boolean}
 */
export function hurtEnoughFor(unit, item) {
  if (unit.hpMax <= 0 || unit.hp <= 0) return false;
  return unit.hp / unit.hpMax < healThresholdOf(item);
}

/** How much this item is expected to heal: the amount the GM set, else the formula average, else infinity. */
export function healAmountOf(item) {
  const authored = item.aiData.amount;
  if (authored > 0) return authored;
  const average = Number(item.healAverage);
  if (Number.isFinite(average) && average > 0) return average;
  return Infinity;
}

/** The value of one heal in the planner's score currency, a point being one percent of the target's max health. */
export function healValue({ missingHp, amount, targetMaxHp, critical, healWeight, scoreScale, criticalBonus }) {
  const max = targetMaxHp > 0 ? targetMaxHp : 1;
  const effective = Math.min(Math.max(0, missingHp), amount);
  if (effective <= 0) return 0;
  return (scoreScale * (effective / max) * healWeight) + (critical ? criticalBonus : 0);
}
