/** @layer planner */
/*
 * Grid math the planner does itself, on squares counted from the map's top-left corner: the distance between
 * footprints, the squares a footprint covers, the "x,y" cell keys the planner's sets and maps use, and the route a
 * movement search's parent links lead along. What the planner asks the system about squares is in squares.mjs.
 */

/* -------------------------------------------- */
/*  Distance                                    */
/* -------------------------------------------- */
/** The steps between two spans on one axis: 0 when they overlap, 1 when they are side by side. */
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

/* -------------------------------------------- */
/*  Cells                                       */
/* -------------------------------------------- */
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
/*  Routes                                      */
/* -------------------------------------------- */
/**
 * The route a movement search's parent links lead along to a goal, as `[x, y]` squares from the first square of the
 * walk to the goal, both included. The walk goes back from the goal and ends at `start` when one is given, or else at
 * the first square with no parent, which is the square the search began from.
 * @param {import('./types.mjs').MovementGraph|null} graph The movement search.
 * @param {{x: number, y: number}} goal The square the route ends on.
 * @param {{x: number, y: number}|null} [start] The square the route must begin on, such as where the unit stands now.
 * @returns {Array<[number, number]>|null} Null when the graph has no parent links, a link names no square, the links
 *   loop, or the walk never reaches `start`.
 */
export function parentPath(graph, goal, start = null) {
  const parents = graph?.parentByCell;
  if (!parents) return null;
  const startKey = start ? cellKey(start.x, start.y) : null;
  const path = [];
  const visited = new Set();
  let key = cellKey(goal.x, goal.y);
  for (;;) {
    const { x, y } = parseCellKey(key);
    if (visited.has(key) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    visited.add(key);
    path.push([x, y]);
    if (key === startKey) return path.reverse();
    const parent = parents[key];
    if (typeof parent !== 'string' || !parent) return startKey ? null : path.reverse();
    key = parent;
  }
}
