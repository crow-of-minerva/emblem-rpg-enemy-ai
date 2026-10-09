/** @layer planner */
/*
 * The planner's cache of answers about the map, emptied after any document write or canvas draw that could change them.
 * A plan spread over several frames reads `boardEpoch` to learn the map changed under it.
 */

/* -------------------------------------------- */
/*  Cached map reads                            */
/* -------------------------------------------- */
/**
 * Hooks after which the cached answers about the map are thrown away: a write to any document that a system command
 * changes and the planner reads, and a newly drawn canvas. On the client that writes, Foundry calls the hook before
 * the write's promise resolves, so a command's writes have emptied the cache by the time its result comes back.
 * Nothing else in the module empties the cache.
 */
export const BOARD_MEMO_HOOKS = Object.freeze([
  'createToken', 'updateToken', 'deleteToken',
  'createActor', 'updateActor', 'deleteActor',
  'createItem', 'updateItem', 'deleteItem',
  'createActiveEffect', 'updateActiveEffect', 'deleteActiveEffect',
  'createWall', 'updateWall', 'deleteWall',
  'createCombat', 'updateCombat', 'deleteCombat',
  'updateScene',
  // A world setting's first change from its default creates its Setting document rather than updating one.
  'createSetting', 'updateSetting',
  'canvasReady'
]);

const store = new Map();
let epoch = 0;

/** Forget everything the planner remembered about the map. */
export function invalidateBoardMemo() {
  store.clear();
  epoch += 1;
}

/** How often the cache has been emptied. A plan spread over several frames compares it to learn the map changed. */
export function boardEpoch() {
  return epoch;
}

/** The cached answer for a key, or else the answer `build` gives, now cached. The value is shared, so don't edit it. */
export function boardMemo(key, build) {
  if (store.has(key)) return store.get(key);
  const value = build();
  store.set(key, value);
  return value;
}

/** Whether the cache already holds an answer for a key. */
export function boardMemoHas(key) {
  return store.has(key);
}
