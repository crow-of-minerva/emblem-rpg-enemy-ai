/** @layer driver */
import { LOG, ORTHOGONAL_STEPS } from '../constants.mjs';
import { board } from '../planner/board.mjs';
import { cellKey, parseCellKey } from '../planner/vocabulary.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
/** How far a route walk-back may descend before it is called a cycle. */
const ROUTE_GUARD = 1000;

/* -------------------------------------------- */
/*  Routes                                      */
/* -------------------------------------------- */
/**
 * The route a movement search took, rebuilt from its parent links, or by walking down the cost field when those
 * fail. Null when neither reaches the unit. `driver/performing.mjs` walks what this returns, cut into runs by
 * {@link segmentRoute}.
 */
export function routeFrom(graph, fromX, fromY, destination) {
  if (!graph || !destination) return null;
  const parented = parentRoute(graph, fromX, fromY, destination);
  if (parented) return parented;
  if (graph.parentByCell) {
    console.warn(`${LOG} a parent route did not start at the unit; falling back to a cost descent.`);
  }
  return costRoute(graph, fromX, fromY, destination);
}

/** Walk the parent chain back from a destination key to the unit's own square. */
function parentRoute(graph, fromX, fromY, destination) {
  const parents = graph.parentByCell;
  if (!parents) return null;
  const startKey = cellKey(fromX, fromY);
  const route = [];
  let current = cellKey(destination.x, destination.y);
  let guard = 0;
  while (current !== startKey && guard < ROUTE_GUARD) {
    guard += 1;
    const cell = parseCellKey(current);
    if (!Number.isFinite(cell.x) || !Number.isFinite(cell.y)) return null;
    route.push([cell.x, cell.y]);
    const parent = parents[current];
    if (!parent) return null;
    current = parent;
  }
  return current === startKey ? route.reverse() : null;
}

/** Descend the cost field from a destination to the unit's square, for a graph with no parent chain. */
function costRoute(graph, fromX, fromY, destination) {
  const costs = graph.costByCell;
  if (!costs) return null;
  const route = [[destination.x, destination.y]];
  let x = destination.x;
  let y = destination.y;
  let guard = 0;
  while ((x !== fromX || y !== fromY) && guard < ROUTE_GUARD) {
    guard += 1;
    const step = cheaperNeighbour(costs, x, y);
    if (!step) return null;
    x = step.x;
    y = step.y;
    route.push([x, y]);
  }
  return (x === fromX && y === fromY) ? route.reverse().slice(1) : null;
}

/** The cheapest orthogonal neighbour strictly cheaper than this cell, or null where the descent stalls. */
function cheaperNeighbour(costs, x, y) {
  const cost = costs[cellKey(x, y)];
  if (!Number.isFinite(cost)) return null;
  let next = null;
  for (const [dx, dy] of ORTHOGONAL_STEPS) {
    const stepCost = costs[cellKey(x + dx, y + dy)];
    if (!Number.isFinite(stepCost) || stepCost >= cost) continue;
    if (!next || stepCost < next.cost) next = { x: x + dx, y: y + dy, cost: stepCost };
  }
  return next;
}

/* -------------------------------------------- */
/*  Teleport pads                               */
/* -------------------------------------------- */
/**
 * The teleport between two consecutive route cells, when `from` is a pad and `to` is its paired exit. Null for an
 * ordinary step, or for a jump that isn't between paired pads.
 */
function teleportHopBetween(planner, from, to) {
  if (Math.abs(to[0] - from[0]) + Math.abs(to[1] - from[1]) === 1) return null;
  const pads = board(planner).terrain.teleports ?? [];
  const pad = pads.find(entry => entry.x === from[0] && entry.y === from[1]);
  if (!pad) return null;
  const exit = pads.find(entry => entry !== pad && entry.letter === pad.letter);
  if (!exit || exit.x !== to[0] || exit.y !== to[1]) return null;
  return { x: exit.x, y: exit.y, letter: pad.letter };
}

/** Cut a route into walked runs separated by teleports. A unit already standing on a pad starts with the teleport. */
export function segmentRoute(planner, start, route) {
  const segments = [];
  let walk = [];
  let cursor = start;
  for (const step of route) {
    const hop = teleportHopBetween(planner, cursor, step);
    if (hop) {
      if (walk.length) segments.push({ kind: 'walk', steps: walk });
      segments.push({ kind: 'teleport', to: step, letter: hop.letter });
      walk = [];
    } else {
      walk.push(step);
    }
    cursor = step;
  }
  if (walk.length) segments.push({ kind: 'walk', steps: walk });
  return segments;
}
