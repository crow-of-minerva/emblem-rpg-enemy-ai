/** @layer enemy-ai */
import { ScenePlanner } from './planner/scene.mjs';

/* -------------------------------------------- */
/*  The planner every caller starts from        */
/* -------------------------------------------- */

/**
 * The module's root planner: bound to no Scene, and the one every other planner comes from.
 *
 * `CombatAI.forScene(sceneUuid)` hands back the single planner for that Scene, and `runEnemyPhase` binds the root to
 * the encounter's Scene the same way. When an encounter ends, `foundry/hooks.mjs` calls `clearMemory(sceneUuid)` to
 * wipe that Scene's battle memory. A pause keeps it.
 */
export const CombatAI = new ScenePlanner('');
