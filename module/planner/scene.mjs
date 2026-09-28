/** @layer planner */

/* -------------------------------------------- */
/*  The Scene's planner                         */
/* -------------------------------------------- */

/**
 * One Scene's planner: the object every planner and driver function takes as its first argument.
 *
 * It carries the Scene that each board, terrain and encounter read names, and the memory one battle builds up.
 * `module/combat-ai.mjs` builds the one root planner and publishes it as `CombatAI`. Every other planner comes from
 * `forScene`, which keeps one instance per Scene so a battle's memory outlives the question that created it.
 */
export class ScenePlanner {
  #family;

  /**
   * @param {string} sceneUuid The Scene this planner reads. An empty string reads an empty board.
   * @param {Map<string, ScenePlanner>} [family] The Scene-keyed instances this planner shares with its own.
   */
  constructor(sceneUuid, family = new Map()) {
    this.sceneUuid = String(sceneUuid ?? '');
    /** Who each unit is chasing, token uuid to token uuid. Kept for the battle and never persisted. */
    this.pursuitTargets = new Map();
    /** Who each Seize unit has committed to removing from a doorway, token uuid to token uuid. */
    this.seizeBlockers = new Map();
    this.#family = family;
    this.#family.set(this.sceneUuid, this);
  }

  /** This planner bound to one Scene: the same instance every time, so its memory carries over. */
  forScene(sceneUuid) {
    const scene = String(sceneUuid ?? '');
    return this.#family.get(scene) ?? new ScenePlanner(scene, this.#family);
  }

  /**
   * Forget what one Scene's planner remembered of the battle, or every Scene's when none is named. `foundry/hooks.mjs`
   * does this when a battle ends, not when it is paused, so a paused battle on another Scene keeps its memory.
   * @param {string} [sceneUuid] The Scene whose battle ended.
   */
  clearMemory(sceneUuid = '') {
    for (const planner of this.#family.values()) {
      if (sceneUuid && planner.sceneUuid !== sceneUuid) continue;
      planner.pursuitTargets.clear();
      planner.seizeBlockers.clear();
    }
  }
}
