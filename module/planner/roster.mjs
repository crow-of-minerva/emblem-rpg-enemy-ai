/** @layer planner */
import { AI_FACTIONS, LURE_WIT_THRESHOLD } from '../constants.mjs';
import { readItemAiData } from '../foundry/flags.mjs';
import { canUse, factionsFriendly, factionsHostile, loadoutOf } from '../foundry/system-bridge.mjs';
import { board } from './board.mjs';
import { boardMemo } from './memo.mjs';
import { ignoresLures } from './profile.mjs';
import { isAlive, isHeldByStatus, isStanceBroken } from './readiness.mjs';
import { unitDistance } from './vocabulary.mjs';

/* -------------------------------------------- */
/*  Roster                                      */
/* -------------------------------------------- */
/** Every unit the AI could drive on this planner's Scene, in a deterministic order so a phase replays the same way. */
export function collectUnits(planner) {
  return board(planner).units
    .filter(unit => isEligibleUnit(unit))
    .sort((a, b) => (a.sort - b.sort) || a.tokenId.localeCompare(b.tokenId));
}

/** Whether a unit is AI-driven, alive and on the map. A hidden token counts as not yet on the map. */
export function isEligibleUnit(unit) {
  if (!unit) return false;
  if (unit.hidden) return false;
  if (!unit.isCharacter) return false;
  if (!AI_FACTIONS.includes(unit.factionRole)) return false;
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

/* -------------------------------------------- */
/*  Targeting                                   */
/* -------------------------------------------- */
/** The actor uuid of whoever taunted this unit, or null. */
export function tauntorOf(unit) {
  return unit?.tauntedByActorUuid || null;
}

/** The unit a taunted one is compelled to go after, or null when nothing compels it. */
export function tauntorToken(planner, unit) {
  if (!tauntorOf(unit)) return null;
  return targetTiers(planner, unit).primary[0] ?? null;
}

/** Whether the planner treats another faction as hostile, by the system's one faction rule. */
export function isHostileTo(myType, otherType) {
  return factionsHostile(myType, otherType);
}

/** Whether two factions are on the same side, by the system's rule. */
export function areFriendly(myType, otherType) {
  return factionsFriendly(myType, otherType);
}

/** Every living, unhidden unit this one would treat as hostile (cached until the map changes). */
export function hostileTokens(planner, unit) {
  return boardMemo(`hostiles|${unit.tokenId}`, () => {
    const seesThroughIllusions = resistsLure(unit);
    return board(planner).units.filter(candidate => {
      if (candidate.tokenUuid === unit.tokenUuid) return false;
      if (candidate.hidden || !candidate.isCharacter) return false;
      if (!isAlive(candidate)) return false;
      if (seesThroughIllusions && isLure(candidate)) return false;
      return isHostileTo(unit.factionRole, candidate.factionRole);
    });
  });
}

/** Whether a unit is an illusion planted to draw attention. */
export function isLure(unit) {
  return Boolean(unit?.illusionCasterUuid);
}

/** Whether a unit sees through illusions: bosses always, and anyone sharp enough. */
function resistsLure(unit) {
  if (unit?.factionRole === 'Boss') return true;
  return (Number(unit?.wit) || 0) > LURE_WIT_THRESHOLD;
}

/** Lures this unit would be drawn to, if any are close enough to matter. */
function lureTokens(planner, unit) {
  if (resistsLure(unit)) return [];
  let maxRange = 0;
  for (const range of pursuitRanges(unit)) maxRange = Math.max(maxRange, range.maxRange);
  if (maxRange <= 0) return [];
  const bound = (Number(unit.movement) || 0) + maxRange;
  const units = board(planner).units;
  const lures = [];
  for (const candidate of units) {
    if (candidate.tokenUuid === unit.tokenUuid || !isLure(candidate)) continue;
    if (!isAlive(candidate) || candidate.sanctuary) continue;
    const caster = units.find(other => other.actorUuid === candidate.illusionCasterUuid) ?? null;
    if (caster) {
      if (!isHostileTo(unit.factionRole, caster.factionRole)) continue;
    } else if (areFriendly(unit.factionRole, candidate.factionRole)) {
      continue;
    }
    if (unitDistance(unit, candidate) > bound) continue;
    lures.push(candidate);
  }
  return lures;
}

/** Whether a unit is sneaking, which makes it a last-choice target rather than an untargetable one. */
function isSneaking(unit) {
  return unit?.sneaking === true;
}

/**
 * Who this unit may attack, split into what it should go for and what it would settle for (cached until the map
 * changes).
 */
export function targetTiers(planner, unit) {
  return boardMemo(`tiers|${unit.tokenId}`, () => buildTargetTiers(planner, unit));
}

function buildTargetTiers(planner, unit) {
  const targets = hostileTokens(planner, unit);
  const tauntorUuid = tauntorOf(unit);
  if (tauntorUuid) {
    const tauntor = targets.filter(target => target.actorUuid === tauntorUuid);
    return { primary: targetableTokens(planner, tauntor), deferred: [] };
  }
  const primary = [];
  const deferred = [];
  for (const candidate of targetableTokens(planner, targets)) {
    (isSneaking(candidate) ? deferred : primary).push(candidate);
  }
  const lures = ignoresLures(planner, unit) ? [] : targetableTokens(planner, lureTokens(planner, unit));
  if (lures.length === 0) return { primary, deferred };
  const lureIds = new Set(lures.map(lure => lure.tokenId));
  return {
    primary: lures,
    deferred: [...primary, ...deferred].filter(candidate => !lureIds.has(candidate.tokenId))
  };
}

/** The tier this unit will actually act on: the primary targets where there are any, otherwise the deferred ones. */
export function collectTargets(planner, unit) {
  const { primary, deferred } = targetTiers(planner, unit);
  return primary.length > 0 ? primary : deferred;
}

/**
 * Who this unit would chase: its taunter when it has one, else units that aren't sneaking, else the sneaking ones.
 * A unit under Sanctuary is never chased. The system marks it `sanctuary`, and nothing may be aimed at it.
 */
export function pursuableHostiles(planner, unit) {
  const hostiles = hostileTokens(planner, unit).filter(hostile => !hostile.sanctuary);
  const tauntorUuid = tauntorOf(unit);
  if (tauntorUuid) {
    const tauntor = hostiles.filter(hostile => hostile.actorUuid === tauntorUuid);
    if (tauntor.length > 0) return tauntor;
  }
  const overt = hostiles.filter(hostile => !isSneaking(hostile));
  return overt.length > 0 ? overt : hostiles;
}

/** Resolve a candidate list into the units a blow would actually land on: the Guard bond redirect, then Sanctuary. */
export function targetableTokens(planner, units) {
  const placed = board(planner).byTokenUuid;
  const out = [];
  const seen = new Set();
  for (const candidate of units) {
    const target = placed.get(candidate.guarderTokenUuid) ?? candidate;
    if (seen.has(target.tokenId)) continue;
    seen.add(target.tokenId);
    if (target.sanctuary) continue;
    out.push(target);
  }
  return out;
}

/* -------------------------------------------- */
/*  Loadout                                     */
/* -------------------------------------------- */
/**
 * A unit's weapons and items as the system judges them, each item joined to its AI parameters (cached until the map
 * changes). Each range is the `{minRange, maxRange}` pair `combat.loadout` publishes. An item's range is null when
 * the system cannot read it, and the system then refuses to activate the item, so every item step skips it. A Self
 * item is used at no distance.
 */
export function loadout(unit) {
  return boardMemo(`loadout|${unit.actorUuid}`, () => {
    const carried = loadoutOf(unit.tokenUuid);
    return Object.freeze({
      weapons: Object.freeze([...(carried.weapons ?? [])]),
      items: Object.freeze((carried.items ?? []).map(item => Object.freeze({
        ...item,
        range: item.range && item.targetType === 'Self' ? { minRange: 0, maxRange: 0 } : item.range,
        aiData: readItemAiData(item)
      })))
    });
  });
}

/** Every weapon this unit could actually swing (cached until the map changes). */
export function usableWeapons(unit) {
  return boardMemo(`weapons|${unit.actorUuid}`, () => loadout(unit).weapons
    .filter(weapon => weapon.usable === true && weapon.range));
}

/** Whether this unit may activate this item at all, by its own state. */
export function canActivate(unit, item) {
  if (!unit || !item) return false;
  return boardMemo(`activate|${unit.actorUuid}|${item.id}`, () => canUse({
    tokenUuid: unit.tokenUuid, itemId: item.id
  }).ok === true);
}

/** Whether this item may be used against this target, by the target's state. */
export function canTarget(unit, item, target) {
  if (!unit || !item || !target) return false;
  return boardMemo(`target|${unit.actorUuid}|${item.id}|${target.tokenId}`, () => canUse({
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
