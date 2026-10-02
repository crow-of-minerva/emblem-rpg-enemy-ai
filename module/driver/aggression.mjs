/** @layer driver */
import { AI_PROFILE_FACTIONS, LOG } from '../constants.mjs';
import { documentByUuid, readActorAi, sceneUuidOfToken, writeActorAi } from '../foundry/flags.mjs';
import { factionsFriendly, unitBoard } from '../foundry/system-bridge.mjs';
import { invalidateBoardMemo } from '../planner/memo.mjs';
import { delay } from './pacing.mjs';

/** How long `awaitMarkWrites` holds the driver for mark writes still running before it plans without them. */
const MARK_WRITE_TIMEOUT_MS = 5000;

/**
 * The mark writes the committed-event handlers below have started and not yet finished. The system publishes those
 * events through Foundry's `Hooks.callAll`, which never waits for a handler, so a write can still be running when the
 * driver plans its next unit.
 */
const writesInFlight = new Set();

/* -------------------------------------------- */
/*  Aggression marks                            */
/* -------------------------------------------- */
/** Whether an action by one faction against another counts as aggression: any pair the system doesn't call friendly. */
function isAggression(sourceRole, targetRole) {
  if (!sourceRole || !targetRole) return false;
  return !factionsFriendly(sourceRole, targetRole);
}

/** Whether marking this pair would change anything: only driven factions are marked, and only once. */
function marksAggression(sourceRole, targetRole, targetAlreadyMarked) {
  if (!AI_PROFILE_FACTIONS.includes(targetRole)) return false;
  if (targetAlreadyMarked === true) return false;
  return isAggression(sourceRole, targetRole);
}

/* -------------------------------------------- */
/*  Writing                                     */
/* -------------------------------------------- */
async function write(actors, value) {
  try {
    await Promise.all(actors.map(actor => writeActorAi(actor, { wasAggressed: value })));
    return actors.length;
  } catch (error) {
    console.error(`${'emblem-rpg-enemy-ai'} | could not record an aggression mark.`, error);
    return 0;
  }
}

/** Mark the units a committed action came at, given the acting Actor and the Actors acted on. */
async function markAggressedMany(sourceActor, targetActors, sceneUuid = '') {
  const roles = factionRoles(sceneUuid);
  const sourceRole = roles.get(sourceActor.uuid) ?? '';
  const targets = new Map();
  for (const actor of targetActors) {
    if (!actor.uuid) continue;
    const role = roles.get(actor.uuid) ?? '';
    if (!marksAggression(sourceRole, role, readActorAi(actor).wasAggressed)) continue;
    targets.set(actor.uuid, actor);
  }
  if (targets.size === 0) return 0;
  return write([...targets.values()], true);
}

/** Clear one unit's aggression mark. `endTurn` in `driver/turn.mjs` calls this as the unit's turn ends. */
export async function clearAggressed(actor) {
  if (!actor || readActorAi(actor).wasAggressed !== true) return false;
  return await write([actor], false) > 0;
}

/** Wipe one Scene's marks when its battle ends. */
async function clearAllAggression(scene) {
  const marked = new Map();
  for (const token of scene?.tokens ?? []) {
    const actor = token?.actor;
    if (actor?.uuid && readActorAi(actor).wasAggressed === true) marked.set(actor.uuid, actor);
  }
  if (marked.size === 0) return 0;
  return write([...marked.values()], false);
}

/* -------------------------------------------- */
/*  Committed event handlers                    */
/* -------------------------------------------- */
/**
 * On a committed combat exchange, mark the defender. The attacker is not marked for the counter it took, since a
 * counter answers an attack rather than starting one.
 */
export function onExchangeCommitted(event) {
  const data = event?.data ?? {};
  const source = documentByUuid(data.sourceActorUuid);
  const target = documentByUuid(data.targetActorUuid);
  if (!source || !target) return Promise.resolve(0);
  return inFlight(markAggressedMany(source, [target], eventSceneUuid(data)));
}

/** On a committed item activation, mark every other unit it was delivered to, whether or not the effect landed. */
export function onActivationCommitted(event) {
  const data = event?.data ?? {};
  const source = documentByUuid(data.sourceActorUuid);
  if (!source) return Promise.resolve(0);
  const targets = (data.deliveries ?? [])
    .map(delivery => documentByUuid(delivery?.targetActorUuid))
    .filter(actor => actor && actor.uuid !== source.uuid);
  return inFlight(markAggressedMany(source, targets, eventSceneUuid(data)));
}

/** When an encounter ends, clear the aggression marks on its Scene. */
export function onEncounterEnded(event) {
  const scene = documentByUuid(event?.data?.sceneUuid);
  return inFlight(clearAllAggression(scene));
}

/** The Scene a committed action happened on: the one its event names, else the acting Token's own. */
function eventSceneUuid(data) {
  return String(data.sceneUuid || sceneUuidOfToken(data.sourceTokenUuid ?? ''));
}

/** Every placed unit's faction role by actor uuid, read from the Scene the action happened on. */
function factionRoles(sceneUuid) {
  const roles = new Map();
  for (const unit of unitBoard(sceneUuid)?.units ?? []) roles.set(unit.actorUuid, unit.factionRole);
  return roles;
}

/* -------------------------------------------- */
/*  Writes in flight                            */
/* -------------------------------------------- */
/**
 * Wait until every mark write the event handlers started has finished, or the time limit passes. The driver waits
 * here before it reads the units and before each turn, so plans see the latest marks. Writes still running at the
 * limit are forgotten, so a stuck write delays the run once rather than once per unit. The cached map data is cleared
 * afterwards.
 * @returns {Promise<boolean>} False when the limit passed with a write still running.
 */
export async function awaitMarkWrites() {
  if (!writesInFlight.size) return true;
  let expired = false;
  const bound = delay(MARK_WRITE_TIMEOUT_MS).then(() => { expired = true; });
  while (writesInFlight.size && !expired) await Promise.race([Promise.all(writesInFlight), bound]);
  invalidateBoardMemo();
  if (!expired) return true;
  console.warn(`${LOG} planning on while ${writesInFlight.size} aggression mark write(s) have not finished.`);
  writesInFlight.clear();
  return false;
}

/**
 * Keep one handler's write in `writesInFlight` until it finishes. `write` logs a failed Actor update itself. Anything
 * else that fails on the way is logged here, since the hook that called the handler drops its promise.
 */
function inFlight(work) {
  const flight = Promise.resolve(work)
    .then(() => undefined, error => console.error(`${LOG} could not record an aggression mark.`, error))
    .finally(() => writesInFlight.delete(flight));
  writesInFlight.add(flight);
  return work;
}
