/** @layer planner */
/*
 * The map as the planner reads it: each Scene's units and terrain as the system reports them, each unit joined to its
 * Enemy AI flags, and the encounter's round. Reads are cached until the map changes and shared between callers, so
 * never edit what they return.
 */
import { actorOfToken, sceneUuidOfToken } from '../foundry/documents.mjs';
import { readActorAi } from '../foundry/flags.mjs';
import { encounterState, terrainBoard, unitBoard } from '../foundry/system-bridge.mjs';
import { boardMemo } from './memo.mjs';

/* -------------------------------------------- */
/*  The map as the planner reads it             */
/* -------------------------------------------- */
/** The terrain the planner assumes when its Scene has none. */
const NO_TERRAIN = Object.freeze({ hasTerrain: false, defendPoints: [], travelBoundedByDistance: true });

/**
 * The planner's own Scene as it reads it: the units and terrain the system reports there, cached until the map changes
 * and shared, so don't edit it.
 * @param {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @returns {import('./types.mjs').PlannerBoard}
 */
export function board(planner) {
  return boardView(planner.sceneUuid);
}

/**
 * One Scene as the planner reads it, each placed unit joined to its AI flags. Both reads name that Scene, so it never
 * describes whatever Scene the host client shows, and an unnamed Scene reads as empty.
 * @param {string} sceneUuid The Scene to read.
 * @returns {import('./types.mjs').PlannerBoard}
 */
function boardView(sceneUuid) {
  const scene = String(sceneUuid ?? '');
  return boardMemo(`board|${scene}`, () => {
    const reported = unitBoard(scene);
    const units = (reported?.units ?? []).map(withAiFlags);
    const byTokenUuid = new Map(units.map(unit => [unit.tokenUuid, unit]));
    const byTokenId = new Map(units.map(unit => [unit.tokenId, unit]));
    return Object.freeze({
      sceneUuid: reported ? scene : '',
      gridSize: reported?.gridSize ?? 100,
      columns: reported?.columns ?? 0,
      rows: reported?.rows ?? 0,
      phase: reported?.phase ?? '',
      round: reported?.round ?? null,
      encounterActive: reported?.encounterActive === true,
      exploration: reported?.exploration === true,
      classicFlyers: reported?.classicFlyers === true,
      flightForbidden: reported?.flightForbidden === true,
      terrain: (reported ? terrainBoard(scene) : null) ?? NO_TERRAIN,
      units: Object.freeze(units),
      byTokenUuid,
      byTokenId
    });
  });
}

/**
 * One unit's record from the system, with its actor's Enemy AI flags added as `ai`.
 * @param {import('../foundry/system-bridge.mjs').MeasuredUnit} record The system's record for one token.
 * @returns {import('./types.mjs').PlannerUnit}
 */
function withAiFlags(record) {
  const actor = actorOfToken(record.tokenUuid);
  return Object.freeze({ ...record, ai: readActorAi(actor) });
}

/**
 * The unit behind a token uuid, read from the Scene that Token belongs to, or null.
 * @param {string} tokenUuid The unit's token.
 * @returns {import('./types.mjs').PlannerUnit|null}
 */
export function unitByTokenUuid(tokenUuid) {
  return boardView(sceneUuidOfToken(tokenUuid)).byTokenUuid.get(tokenUuid) ?? null;
}

/**
 * The unit standing behind a token id on a named Scene, or null.
 * @param {string} tokenId The unit's token id.
 * @param {string} sceneUuid The Scene the token is on.
 * @returns {import('./types.mjs').PlannerUnit|null}
 */
export function unitByTokenId(tokenId, sceneUuid) {
  return boardView(sceneUuid).byTokenId.get(tokenId) ?? null;
}

/* -------------------------------------------- */
/*  The encounter's round                       */
/* -------------------------------------------- */
/** The round the GM's conditions on a named Scene are checked against, or null outside a started encounter there. */
export function aiConditionContext(sceneUuid) {
  const state = encounterState(sceneUuid);
  const round = Number(state?.round);
  return { round: state?.started === true && Number.isFinite(round) ? round : null };
}

/** A named Scene's current combat round, or null when no encounter is running there. */
export function currentCombatRound(sceneUuid) {
  return aiConditionContext(sceneUuid).round;
}
