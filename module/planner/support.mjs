/** @layer planner */
import { AI_ITEM_ROLE_VALUES, SUPPORT_ITEM_TYPES } from '../constants.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
/** The authored AI role of a loadout item, or null when it has none or names one the runtime does not offer. */
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
/** Items with the Heal role (support subtypes and Consumables) that heal one target with a standard action. */
export function healItemsOf(items) {
  return (items ?? []).filter(item => itemRole(item) === 'heal'
    && (SUPPORT_ITEM_TYPES.has(item.itemType) || item.type === 'Consumable')
    && item.actionType === 'Standard Action'
    && (item.rangeType ?? 'Single') === 'Single'
    && itemHasUses(item));
}

/**
 * Heal-role items that heal the user as a bonus action, such as Second Wind. `useBonusSelfHeal` in
 * `driver/performing.mjs` uses them between moving and acting. The planner never plans them.
 */
export function bonusSelfHealItemsOf(items) {
  return (items ?? []).filter(item => itemRole(item) === 'heal'
    && (SUPPORT_ITEM_TYPES.has(item.itemType) || item.type === 'Consumable')
    && item.actionType === 'Bonus Action'
    && item.targetType === 'Self'
    && itemHasUses(item));
}

/* -------------------------------------------- */
/*  Valuation                                   */
/* -------------------------------------------- */
/** The health fraction below which a target qualifies for this item's heal. */
export function healThresholdOf(item) {
  return item.aiData.threshold / 100;
}

/** How much this item is expected to heal: the authored amount, else the formula average, else infinity. */
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
