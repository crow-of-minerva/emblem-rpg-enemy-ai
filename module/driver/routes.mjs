/** @layer driver */
/*
 * The route a unit walks, rebuilt from a movement search, and that route cut into walked stretches and teleports
 * between paired pads.
 */
import { LOG } from '../constants.mjs';
import { board } from '../planner/board.mjs';
import { cellKey, parentPath } from '../planner/grid.mjs';

/* -------------------------------------------- */
/*  Constants                                   */
/* -------------------------------------------- */
/** The most steps a walk down the search's movement costs takes before it gives up. */
const DESCENT_GUARD = 1000;
/** The steps to a square's four neighbours: up, right, down and left. */
const ORTHOGONAL_STEPS = Object.freeze([[0, -1], [1, 0], [0, 1], [-1, 0]]);

/* -------------------------------------------- */
/*  Routes                                      */
/* -------------------------------------------- */
/**
 * The route a movement search took from the unit's square to a destination, the unit's square left out, or null. It
 * is rebuilt from the search's parent links, or by walking down its movement costs when those do not lead back.
 */
export function routeFrom(graph, fromX, fromY, destination) {
  if (!graph || !destination) return null;
  const parented = parentPath(graph, destination, { x: fromX, y: fromY })?.slice(1);
  if (parented) return parented;
  if (graph.parentByCell) {
    console.warn(`${LOG} a parent route did not start at the unit; falling back to a cost descent.`);
  }
  return costRoute(graph, fromX, fromY, destination);
}

/** Walk down the search's movement costs from a destination to the unit's square, for when parent links do not. */
function costRoute(graph, fromX, fromY, destination) {
  const costs = graph.costByCell;
  if (!costs) return null;
  const route = [[destination.x, destination.y]];
  let x = destination.x;
  let y = destination.y;
  let guard = 0;
  while ((x !== fromX || y !== fromY) && guard < DESCENT_GUARD) {
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
