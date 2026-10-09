/** @layer planner */
/*
 * The questions the Enemy AI planner asks about squares on the map: where a unit can move, whether it could attack or
 * see a target from a square, the terrain, aura and hazard effects there, and which hostiles could reach it. Most
 * answers come from the system and are cached with boardMemo (memo.mjs) until something on the map changes.
 */
import {
  airborneBeyondMelee,
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
import { cellKey, footprintDistance } from './grid.mjs';
import { pursuitRanges } from './loadout.mjs';
import { boardMemo, boardMemoHas } from './memo.mjs';
import { isIncapacitated } from './readiness.mjs';
import { hostileTokens } from './targeting.mjs';

/* -------------------------------------------- */
/*  Anchors and engagement                      */
/* -------------------------------------------- */
/**
 * Every square the unit could end its move on (its "anchors"), plus the movement graph they came from. The square
 * it's standing on is always included.
 * @param {import('./types.mjs').PlannerUnit} unit The unit moving.
 * @param {object} [options]
 * @param {boolean} [options.ignoreTurnState] Measure its full movement, as at the start of its next turn.
 * @param {boolean} [options.stationary] Measure only the square it stands on.
 * @returns {{graph: import('./types.mjs').MovementGraph, anchors: Set<string>}} The graph, and the anchors as cell
 *   keys.
 */
export function reachableAnchors(unit, { ignoreTurnState = false, stationary = false } = {}) {
  if (stationary) return anchorField(unit, { stationary: true, attackReach: false });
  return boardMemo(`reach|${unit.tokenUuid}|${cellKey(unit.x, unit.y)}|${ignoreTurnState ? 1 : 0}`,
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
 * The distance the unit could attack the target with this weapon from this square, or null if it can't (cached until
 * the map changes). The system judges sight by the weapon's line-of-sight rule, as a real attack does.
 * @param {import('./types.mjs').PlannerUnit} unit The unit that would attack.
 * @param {number} anchorX The square's column.
 * @param {number} anchorY The square's row.
 * @param {import('./types.mjs').PlannerUnit} target The unit it would attack.
 * @param {import('./types.mjs').PlannerWeapon} weapon The weapon it would attack with, for its range and its
 *   line-of-sight rule.
 * @returns {number|null}
 */
export function engagementIsPossible(unit, anchorX, anchorY, target, weapon) {
  const { range, losRule } = weapon;
  const key = `engage|${unit.tokenUuid}|${anchorX},${anchorY}|${target.tokenUuid}|${range.minRange}-${range.maxRange}`
    + `|${losRule}`;
  return boardMemo(key, () => canEngage({
    tokenUuid: unit.tokenUuid,
    standing: { x: anchorX, y: anchorY },
    targetTokenUuid: target.tokenUuid,
    range,
    losRule
  }));
}

/**
 * Whether walls or terrain height would block the unit's sight to the target from this square, under the item's
 * line-of-sight rule (cached until the map changes).
 */
export function sightBlocked(unit, anchorX, anchorY, target, losRule) {
  const key = `los|${unit.tokenUuid}|${anchorX},${anchorY}|${target.tokenUuid}|${losRule}`;
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
  return boardMemo(`terrain|${unit.tokenUuid}|${gx},${gy}`, () => {
    const mods = terrainModifiersAt(unit.tokenUuid, { x: gx, y: gy }) ?? {};
    return Object.freeze({ eva: Number(mods.eva) || 0, def: Number(mods.def) || 0, res: Number(mods.res) || 0 });
  });
}

/**
 * The aura effects the unit would have at this square (cached until the map changes), with a signature string so
 * squares with identical auras can share one measurement.
 */
export function auraModsAt(unit, gx, gy) {
  return boardMemo(`aura|${unit.tokenUuid}|${gx},${gy}`,
    () => auraMods(auraFieldsAt(unit.tokenUuid, { x: gx, y: gy })));
}

/** Fill the aura cache for a batch of squares with one auraFieldsAtMany call instead of one call per square. */
export function primeAuraMods(unit, squares) {
  const owed = [];
  for (const square of squares) {
    if (!boardMemoHas(`aura|${unit.tokenUuid}|${square.x},${square.y}`)) owed.push({ x: square.x, y: square.y });
  }
  if (!owed.length) return;
  const fieldsByCell = auraFieldsAtMany(unit.tokenUuid, owed);
  if (!fieldsByCell) return;
  for (const square of owed) {
    const fields = fieldsByCell[`${square.x},${square.y}`];
    if (fields) boardMemo(`aura|${unit.tokenUuid}|${square.x},${square.y}`, () => auraMods(fields));
  }
}

/**
 * The HP change terrain would give the unit at phase start on this square, negative for damage (cached until the map
 * changes).
 */
export function hazardAt(unit, gx, gy) {
  return boardMemo(`hazard|${unit.tokenUuid}|${gx},${gy}`, () => groundHazardAt(unit.tokenUuid, { x: gx, y: gy }));
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
 * The squares other tokens take up, where this unit may not end its move, as the system's movement search for it
 * reports them in `snapshot.occupiedCells` (cached until the map changes and shared, so don't modify it).
 */
export function occupiedCells(unit) {
  return boardMemo(`occupied|${unit.tokenUuid}`, () => {
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
  const key = `flank|${unit.tokenUuid}|${anchorX},${anchorY}|${target?.tokenUuid ?? '-'}`;
  return boardMemo(key, () => flankingAt({
    tokenUuid: unit.tokenUuid,
    standing: { x: anchorX, y: anchorY },
    targetTokenUuid: target?.tokenUuid ?? ''
  }));
}

/**
 * Every hostile that can still act and could strike this unit, with the weapon ranges it could use on it (cached until
 * the map changes and shared, so don't modify it). Melee-only ranges are dropped where the system's
 * airborneBeyondMelee says a hostile on the ground cannot touch the unit in the air.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @param {import('./types.mjs').PlannerUnit} unit The unit the hostiles would strike.
 * @returns {Array<{hostile: import('./types.mjs').PlannerUnit, ranges: Array<{minRange: number, maxRange: number}>}>}
 */
export function hostileReach(planner, unit) {
  return boardMemo(`hostile-reach|${unit.tokenUuid}`, () => {
    const grid = board(planner);
    const reach = [];
    for (const hostile of hostileTokens(planner, unit)) {
      if (isIncapacitated(hostile)) continue;
      let ranges = pursuitRanges(hostile);
      const outOfMelee = airborneBeyondMelee({
        sourceAirborne: hostile.airborne === true,
        targetAirborne: unit.airborne === true,
        targetStanceBroken: unit.stanceBroken === true,
        classicFlyers: grid.classicFlyers === true,
        flightForbidden: grid.flightForbidden === true
      });
      if (outOfMelee) ranges = ranges.filter(range => range.maxRange > 1);
      if (ranges.length) reach.push({ hostile, ranges });
    }
    return reach;
  });
}

/** Footprints and weapon ranges of every hostile in hostileReach, for exposureAt (cached until the map changes). */
export function threatRectsFor(planner, unit) {
  return boardMemo(`threat-rects|${unit.tokenUuid}`, () => hostileReach(planner, unit).map(({ hostile, ranges }) => ({
    id: hostile.tokenId, x: hostile.x, y: hostile.y, w: hostile.width, h: hostile.height, ranges
  })));
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
