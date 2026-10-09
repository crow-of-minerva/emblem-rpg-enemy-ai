/** @layer planner */
/*
 * Scene planners: the object every planner and driver function takes first, which names the Scene it reads and keeps
 * the memory of that Scene's battle, and the registry that keeps one per Scene.
 */

/* -------------------------------------------- */
/*  One Scene's planner                         */
/* -------------------------------------------- */

/**
 * One Scene's planner, the first argument of every planner and driver function that reads the map: the Scene it
 * reads, and the memory one battle there builds up. Take it from a ScenePlanners registry, which keeps one per Scene
 * so a battle's memory outlives the question that created it.
 */
export class ScenePlanner {
  /**
   * @param {string} sceneUuid The Scene this planner reads. An empty string reads as a Scene with nothing on it.
   */
  constructor(sceneUuid) {
    this.sceneUuid = String(sceneUuid ?? '');
    /** Who each unit is chasing, token uuid to token uuid. Kept for the battle and never saved. */
    this.pursuitTargets = new Map();
    /** Which unit or wall each Seize unit has committed to removing from its route, token uuid to token uuid. */
    this.seizeBlockers = new Map();
  }

  /** Forget what this planner remembered of the battle. */
  clearMemory() {
    this.pursuitTargets.clear();
    this.seizeBlockers.clear();
  }
}

/* -------------------------------------------- */
/*  Every Scene's planner                       */
/* -------------------------------------------- */

/**
 * The planners of every Scene, one each, made on first use. A battle's end clears its Scene's memory; a pause does
 * not.
 */
export class ScenePlanners {
  #byScene = new Map();

  /** The planner for one Scene: the same instance every time, so its memory carries over. */
  forScene(sceneUuid) {
    const scene = String(sceneUuid ?? '');
    let planner = this.#byScene.get(scene);
    if (!planner) {
      planner = new ScenePlanner(scene);
      this.#byScene.set(scene, planner);
    }
    return planner;
  }

  /**
   * Forget what one Scene's planner remembered of the battle, or every Scene's when none is named.
   * @param {string} [sceneUuid] The Scene whose battle ended.
   */
  clearMemory(sceneUuid = '') {
    for (const planner of this.#byScene.values()) {
      if (!sceneUuid || planner.sceneUuid === sceneUuid) planner.clearMemory();
    }
  }
}
