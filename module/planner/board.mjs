/** @layer planner */
import { actorOfToken, readActorAi, sceneUuidOfToken } from '../foundry/flags.mjs';
import { encounterState, terrainBoard, unitBoard } from '../foundry/system-bridge.mjs';
import { boardMemo } from './memo.mjs';

/* -------------------------------------------- */
/*  Board view                                  */
/* -------------------------------------------- */
/** The terrain a board reads as when its Scene has no terrain facts. */
const NO_TERRAIN = Object.freeze({ hasTerrain: false, defendPoints: [], travelBoundedByDistance: true });

/** The board of the planner's own Scene, cached in the board memo and shared with every other caller. */
export function board(planner) {
  return boardView(planner.sceneUuid);
}

/**
 * One Scene's board as the planner reads it: the system's facts per placed unit, each joined to the module's AI facts.
 * Its unit and terrain reads both name that Scene, so a board never describes whatever Scene the host displays. An
 * unnamed Scene reads as an empty board.
 * @param {string} sceneUuid The Scene whose board this is.
 * @returns {Readonly<object>}
 */
function boardView(sceneUuid) {
  const scene = String(sceneUuid ?? '');
  return boardMemo(`board|${scene}`, () => {
    const facts = unitBoard(scene);
    const units = (facts?.units ?? []).map(joinAiFacts);
    const byTokenUuid = new Map(units.map(unit => [unit.tokenUuid, unit]));
    const byTokenId = new Map(units.map(unit => [unit.tokenId, unit]));
    return Object.freeze({
      sceneUuid: facts ? scene : '',
      gridSize: facts?.gridSize ?? 100,
      columns: facts?.columns ?? 0,
      rows: facts?.rows ?? 0,
      phase: facts?.phase ?? '',
      round: facts?.round ?? null,
      encounterActive: facts?.encounterActive === true,
      exploration: facts?.exploration === true,
      classicFlyers: facts?.classicFlyers === true,
      flightForbidden: facts?.flightForbidden === true,
      terrain: (facts ? terrainBoard(scene) : null) ?? NO_TERRAIN,
      units: Object.freeze(units),
      byTokenUuid,
      byTokenId
    });
  });
}

function joinAiFacts(facts) {
  const actor = actorOfToken(facts.tokenUuid);
  return Object.freeze({ ...facts, ai: readActorAi(actor) });
}

/** The unit behind a token uuid, read off the board of the Scene that Token belongs to, or null. */
export function unitByTokenUuid(tokenUuid) {
  return boardView(sceneUuidOfToken(tokenUuid)).byTokenUuid.get(tokenUuid) ?? null;
}

/** The unit standing behind a token id on a named Scene's board, or null. */
export function unitByTokenId(tokenId, sceneUuid) {
  return boardView(sceneUuid).byTokenId.get(tokenId) ?? null;
}

/* -------------------------------------------- */
/*  The encounter's round                       */
/* -------------------------------------------- */
/** The round a named Scene's authored conditions are checked against, or null outside a started encounter there. */
export function aiConditionContext(sceneUuid) {
  const state = encounterState(sceneUuid);
  const round = Number(state?.round);
  return { round: state?.started === true && Number.isFinite(round) ? round : null };
}

/** A named Scene's current combat round, or null when no encounter is running there. */
export function currentCombatRound(sceneUuid) {
  return aiConditionContext(sceneUuid).round;
}
