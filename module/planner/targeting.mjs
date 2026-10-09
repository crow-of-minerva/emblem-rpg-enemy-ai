/** @layer planner */
/*
 * Who a unit may attack or chase: the hostiles on the map, its taunter, the lures that draw it, sneaking units kept
 * for last, the Guard bond that turns a blow onto the guard, and Sanctuary, which shields a unit from being aimed at.
 */
import { LURE_PROOF_FACTIONS } from '../constants.mjs';
import { factionsFriendly, factionsHostile } from '../foundry/system-bridge.mjs';
import { board } from './board.mjs';
import { unitDistance } from './grid.mjs';
import { pursuitRanges } from './loadout.mjs';
import { boardMemo } from './memo.mjs';
import { ignoresLures } from './profile.mjs';
import { isAlive } from './readiness.mjs';
import { LURE_WIT_THRESHOLD } from './tuning.mjs';

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
  return boardMemo(`hostiles|${unit.tokenUuid}`, () => {
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

/** Whether a unit is a decoy planted to draw attention: a token spawned from an Actor marked as a lure. */
export function isLure(unit) {
  return unit?.lure === true;
}

/** Whether a unit sees through illusions: bosses always, and anyone sharp enough. */
function resistsLure(unit) {
  if (LURE_PROOF_FACTIONS.includes(unit.factionRole)) return true;
  return unit.wit > LURE_WIT_THRESHOLD;
}

/** Lures this unit would be drawn to, if any are close enough to matter. */
function lureTokens(planner, unit) {
  if (resistsLure(unit)) return [];
  let maxRange = 0;
  for (const range of pursuitRanges(unit)) maxRange = Math.max(maxRange, range.maxRange);
  if (maxRange <= 0) return [];
  const bound = unit.movement + maxRange;
  const units = board(planner).units;
  const lures = [];
  for (const candidate of units) {
    if (candidate.tokenUuid === unit.tokenUuid || !isLure(candidate)) continue;
    if (!isAlive(candidate) || candidate.sanctuary) continue;
    const caster = units.find(other => other.actorUuid === candidate.summonedBy) ?? null;
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
  return boardMemo(`tiers|${unit.tokenUuid}`, () => buildTargetTiers(planner, unit));
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
 * A unit under Sanctuary is never chased, since nothing may be aimed at it.
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
