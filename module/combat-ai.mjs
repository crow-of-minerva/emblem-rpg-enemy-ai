/** @layer enemy-ai */
/*
 * The one set of Scene planners the whole module shares, so a Scene's battle memory is the same whichever part of the
 * module asks for it.
 */
import { ScenePlanners } from './planner/scene.mjs';

/* -------------------------------------------- */
/*  Every Scene's planner                       */
/* -------------------------------------------- */

/**
 * The module's planners, one per Scene. `CombatAI.forScene(sceneUuid)` hands back that Scene's planner, whose battle
 * memory is wiped when its encounter ends and kept through a pause.
 */
export const CombatAI = new ScenePlanners();
