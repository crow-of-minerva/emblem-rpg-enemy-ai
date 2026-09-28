/** @layer enemy-ai */
import { ScenePlanner } from './planner/scene.mjs';

/* -------------------------------------------- */
/*  The planner every caller starts from        */
/* -------------------------------------------- */

/**
 * The module's root planner: bound to no Scene, and the one every other planner comes from.
 *
 * `CombatAI.forScene(sceneUuid)` hands back the single planner for that Scene, which `foundry/hooks.mjs` and
 * `ui/threat-intent.mjs` pass to the planner and driver functions that do the work. `runEnemyPhase`, reached from
 * `foundry/hooks.mjs` and `api.mjs`, rebinds the root to the encounter's Scene the same way. `foundry/hooks.mjs`
 * calls `clearMemory()` to wipe the battle memory when an encounter ends. A pause keeps it.
 */
export const CombatAI = new ScenePlanner('');
