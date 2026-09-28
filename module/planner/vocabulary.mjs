/** @layer planner */

/* -------------------------------------------- */
/*  Grid helpers                                */
/* -------------------------------------------- */
function axisGap(aStart, aSize, bStart, bSize) {
  return Math.max(0, aStart - (bStart + bSize - 1), bStart - (aStart + aSize - 1));
}

/** The distance between two footprints, edge to edge, in grid squares. */
export function footprintDistance(ax, ay, aw, ah, bx, by, bw, bh) {
  return axisGap(ax, aw, bx, bw) + axisGap(ay, ah, by, bh);
}

/** The distance between two units' footprints. */
export function unitDistance(a, b) {
  return footprintDistance(a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height);
}

/** The distance from a footprint standing at a cell to a unit. */
export function standingDistance(x, y, dims, unit) {
  return footprintDistance(x, y, dims.width, dims.height, unit.x, unit.y, unit.width, unit.height);
}

/** Every cell a footprint of these dimensions would cover from this origin. */
function cellsAt(gx, gy, dims) {
  const cells = [];
  for (let dx = 0; dx < dims.width; dx += 1) {
    for (let dy = 0; dy < dims.height; dy += 1) cells.push([gx + dx, gy + dy]);
  }
  return cells;
}

/** The cell keys a unit's footprint covers. */
export function unitCellKeys(unit) {
  return cellsAt(unit.x, unit.y, unit).map(([x, y]) => `${x},${y}`);
}

/** The "x,y" key the planner uses for a grid cell in its sets and maps. */
export function cellKey(x, y) {
  return `${x},${y}`;
}

/** A cell key parsed back into coordinates. */
export function parseCellKey(key) {
  const [x, y] = String(key).split(',').map(Number);
  return { x, y };
}

/** Whether a footprint standing at a cell overlaps any occupied cell in the set. */
export function footprintOccupiedIn(occupied, dims, gx, gy) {
  for (let dx = 0; dx < dims.width; dx += 1) {
    for (let dy = 0; dy < dims.height; dy += 1) {
      if (occupied.has(cellKey(gx + dx, gy + dy))) return true;
    }
  }
  return false;
}

/* -------------------------------------------- */
/*  Damage                                      */
/* -------------------------------------------- */
/** The midpoint of a damage figure, which may be a single number or a range. */
export function averageDamage(damageValue) {
  const text = String(damageValue ?? '0').trim();
  const spread = text.match(/^(\d+)-(\d+)$/);
  if (spread) return (parseInt(spread[1], 10) + parseInt(spread[2], 10)) / 2;
  const flat = parseInt(text, 10);
  return Number.isNaN(flat) ? 0 : flat;
}

/* -------------------------------------------- */
/*  Deterministic draws                         */
/* -------------------------------------------- */
function hashString(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A string's FNV-1a hash as a number in [0, 1): a repeatable stand-in for Math.random(). */
export function hashToUnit(text) {
  return hashString(String(text)) / 4294967296;
}

