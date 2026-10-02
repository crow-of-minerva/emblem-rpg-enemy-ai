/** @layer planner */
/*
 * The questions the Enemy AI planner asks about squares on the map: where a unit can move, whether it could attack or
 * see a target from a square, the terrain, aura and hazard effects there, and which hostiles could reach it. Most
 * answers come from the system through system-bridge.mjs and are cached with boardMemo (memo.mjs) until
 * something on the map changes. The main caller is planning.mjs.
 */
import {
  auraFieldsAt,
  auraFieldsAtMany,
  canEngage,
  elevationAt as groundElevationAt,
  flankingAt,
  hazardAt as groundHazardAt,
  movementField,
  sightBlocked as sightIsBlocked,
  terrainModifiersAt
} from '../foundry/system-bridge.mjs';
import { board } from './board.mjs';
import { boardMemo, boardMemoHas } from './memo.mjs';
import { isIncapacitated } from './readiness.mjs';
import { hostileTokens, pursuitRanges } from './roster.mjs';
import { cellKey, footprintDistance } from './vocabulary.mjs';

/* -------------------------------------------- */
/*  Anchors and engagement                      */
/* -------------------------------------------- */
/**
 * Every square the unit could end its move on (its "anchors"), plus the movement graph they came from. The square
 * it's standing on is always included.
 */
export function reachableAnchors(unit, { ignoreTurnState = false, stationary = false } = {}) {
  if (stationary) return anchorField(unit, { stationary: true, attackReach: false });
  return boardMemo(`reach|${unit.tokenId}|${cellKey(unit.x, unit.y)}|${ignoreTurnState ? 1 : 0}`,
    () => anchorField(unit, { nextTurn: ignoreTurnState, teleports: true, attackReach: false }));
}

/**
 * Ask the system for the unit's movement field and turn it into a set of anchors. If the system returns nothing,
 * fall back to a graph where the unit can only stay where it is.
 */
function anchorField(unit, options) {
  const startKey = cellKey(unit.x, unit.y);
  const graph = movementField(unit.tokenUuid, options)?.graph ?? {
    start: { x: unit.x, y: unit.y },
    allowance: 0,
    costByCell: { [startKey]: 0 },
    routeByCell: { [startKey]: 0 },
    parentByCell: {},
    placements: [{ x: unit.x, y: unit.y, cost: 0 }],
    destinations: []
  };
  const anchors = new Set((graph.placements ?? []).map(cell => cellKey(cell.x, cell.y)));
  anchors.add(startKey);
  return { graph, anchors };
}

/** What reaching a square costs on a movement graph, or Infinity when it is out of reach. */
export function moveCostAt(graph, x, y) {
  return graph?.costByCell?.[cellKey(x, y)] ?? Infinity;
}

/**
 * The distance the unit could attack the target from at this square, or null if it can't (cached until the map
 * changes). No weapon sight rule is passed, so a weapon set to Ignore LoS or Ignore Elev. is checked as a normal one.
 */
export function engagementIsPossible(unit, anchorX, anchorY, target, range) {
  const key = `engage|${unit.tokenId}|${anchorX},${anchorY}|${target.tokenId}|${range.minRange}-${range.maxRange}`;
  return boardMemo(key, () => canEngage({
    tokenUuid: unit.tokenUuid,
    standing: { x: anchorX, y: anchorY },
    targetTokenUuid: target.tokenUuid,
    range
  }));
}

/**
 * Whether walls or terrain height would block the unit's sight to the target from this square (cached until the map
 * changes).
 */
export function sightBlocked(unit, anchorX, anchorY, target, losRule = 'normal') {
  const key = `los|${unit.tokenId}|${anchorX},${anchorY}|${target.tokenId}|${losRule}`;
  return boardMemo(key, () => sightIsBlocked({
    tokenUuid: unit.tokenUuid,
    standing: { x: anchorX, y: anchorY },
    targetTokenUuid: target.tokenUuid,
    losRule
  }));
}

/* -------------------------------------------- */
/*  Ground                                      */
/* -------------------------------------------- */
/** The terrain's evasion, defense and resistance bonuses for the unit at this square (cached until the map changes). */
export function terrainModsAt(unit, gx, gy) {
  return boardMemo(`terrain|${unit.tokenId}|${gx},${gy}`, () => {
    const mods = terrainModifiersAt(unit.tokenUuid, { x: gx, y: gy }) ?? {};
    return Object.freeze({ eva: Number(mods.eva) || 0, def: Number(mods.def) || 0, res: Number(mods.res) || 0 });
  });
}

/**
 * The aura effects the unit would have at this square (cached until the map changes), with a signature string so
 * squares with identical auras can share one measurement.
 */
export function auraModsAt(unit, gx, gy) {
  return boardMemo(`aura|${unit.tokenId}|${gx},${gy}`,
    () => auraMods(auraFieldsAt(unit.tokenUuid, { x: gx, y: gy })));
}

/** Fill the aura cache for a batch of squares with one auraFieldsAtMany call instead of one call per square. */
export function primeAuraMods(unit, squares) {
  const owed = [];
  for (const square of squares) {
    if (!boardMemoHas(`aura|${unit.tokenId}|${square.x},${square.y}`)) owed.push({ x: square.x, y: square.y });
  }
  if (!owed.length) return;
  const fieldsByCell = auraFieldsAtMany(unit.tokenUuid, owed);
  if (!fieldsByCell) return;
  for (const square of owed) {
    const fields = fieldsByCell[`${square.x},${square.y}`];
    if (fields) boardMemo(`aura|${unit.tokenId}|${square.x},${square.y}`, () => auraMods(fields));
  }
}

/**
 * The HP change terrain would give the unit at phase start on this square, negative for damage (cached until the map
 * changes).
 */
export function hazardAt(unit, gx, gy) {
  return boardMemo(`hazard|${unit.tokenId}|${gx},${gy}`, () => groundHazardAt(unit.tokenUuid, { x: gx, y: gy }));
}

/**
 * A key for everything about a square that changes a matchup measured from it: terrain, auras and elevation
 * (elevation decides the engagement, and so whether the defender can counter). scoring.mjs puts it in the key
 * that lets squares with the same ground share one measurement.
 */
export function groundSignature(anchor) {
  return `${anchor.terrainSig}|${anchor.auraSig}|${anchor.elevation}`;
}

/** Terrain elevation under a footprint of the given size at this square, on the planner's scene. */
export function elevationAt(planner, x, y, dims = { width: 1, height: 1 }) {
  return groundElevationAt(board(planner).sceneUuid, { x, y }, dims.width, dims.height);
}

/* -------------------------------------------- */
/*  Occupancy                                   */
/* -------------------------------------------- */
/**
 * Occupied cells as this unit's movement field reports them (cached until the map changes and shared, so don't modify
 * it).
 */
export function occupiedCells(unit) {
  return boardMemo(`occupied|${unit.tokenId}`, () => {
    const field = movementField(unit.tokenUuid, { stationary: true, attackReach: false });
    return new Set(field?.snapshot?.occupiedCells ?? []);
  });
}

/* -------------------------------------------- */
/*  Flanking and exposure                       */
/* -------------------------------------------- */
/** Whether moving here would flank the target. Only single-square targets that aren't already flanked count. */
export function flanksTargetFrom(unit, anchorX, anchorY, target) {
  if (!target || target.width !== 1 || target.height !== 1) return false;
  if (target.flanked === true) return false;
  return flankingFrom(unit, anchorX, anchorY, target).flanks === true;
}

/** Whether moving here would leave this unit flanked. Only checked for single-square units not already flanked. */
export function flankedAt(unit, anchorX, anchorY, target = null) {
  if (unit.width !== 1 || unit.height !== 1) return false;
  if (unit.flanked === true) return false;
  return flankingFrom(unit, anchorX, anchorY, target).flanked === true;
}

/** The system's flanking check from this square (api.combat.flanking), cached for the two above. */
function flankingFrom(unit, anchorX, anchorY, target) {
  const key = `flank|${unit.tokenId}|${anchorX},${anchorY}|${target?.tokenId ?? '-'}`;
  return boardMemo(key, () => flankingAt({
    tokenUuid: unit.tokenUuid,
    standing: { x: anchorX, y: anchorY },
    targetTokenUuid: target?.tokenUuid ?? ''
  }));
}

/** Footprints and weapon ranges of every hostile that can still act, for exposureAt (cached until the map changes). */
export function threatRectsFor(planner, unit) {
  return boardMemo(`threat-rects|${unit.tokenId}`, () => buildThreatRects(planner, unit));
}

function buildThreatRects(planner, unit) {
  const rects = [];
  for (const hostile of hostileTokens(planner, unit)) {
    if (isIncapacitated(hostile)) continue;
    const ranges = pursuitRanges(hostile);
    if (ranges.length === 0) continue;
    rects.push({ id: hostile.tokenId, x: hostile.x, y: hostile.y, w: hostile.width, h: hostile.height, ranges });
  }
  return rects;
}

/**
 * Ids of hostiles whose weapon range covers this square from where they stand now; their movement and sight are not
 * considered. Ids, so the caller can skip the one it's attacking.
 */
export function exposureAt(dims, rects, anchorX, anchorY) {
  const ids = new Set();
  for (const rect of rects) {
    const distance = footprintDistance(anchorX, anchorY, dims.width, dims.height, rect.x, rect.y, rect.w, rect.h);
    if (rect.ranges.some(range => distance >= range.minRange && distance <= range.maxRange)) ids.add(rect.id);
  }
  return ids;
}

/* -------------------------------------------- */
/*  Aura helpers                                */
/* -------------------------------------------- */
/** Aura fields plus a signature string built from them, equal for any two squares with the same values. */
function auraMods(fields = {}) {
  const keys = Object.keys(fields).sort();
  return Object.freeze({ fields, sig: keys.map(field => `${field}=${fields[field]}`).join(',') });
}
