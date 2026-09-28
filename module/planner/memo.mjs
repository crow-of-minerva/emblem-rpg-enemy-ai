/** @layer planner */

/* -------------------------------------------- */
/*  Board memo                                  */
/* -------------------------------------------- */
/** The document hooks after which nothing in the memo can be trusted. */
export const BOARD_MEMO_HOOKS = Object.freeze([
  'createToken', 'updateToken', 'deleteToken',
  'createActor', 'updateActor', 'deleteActor',
  'createItem', 'updateItem', 'deleteItem',
  'createActiveEffect', 'updateActiveEffect', 'deleteActiveEffect',
  'createWall', 'updateWall', 'deleteWall',
  'createCombat', 'updateCombat', 'deleteCombat',
  'updateScene', 'updateSetting', 'canvasReady'
]);

const store = new Map();
let epoch = 0;

/** Forget everything the planner remembered about the board. */
export function invalidateBoardMemo() {
  store.clear();
  epoch += 1;
}

/** How often the memo has been emptied. A plan spread over several frames compares it to learn the board moved. */
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

/** Whether the memo already holds an answer for a key. */
export function boardMemoHas(key) {
  return store.has(key);
}
