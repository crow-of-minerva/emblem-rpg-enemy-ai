/** @layer driver */
/*
 * The Aggressed mark that an Aggressed condition reads, set on a unit of a faction the AI plays when a unit not
 * friendly to it attacks it or uses an item on it, and cleared when its turn or its battle ends. The marks are written
 * from the system's committed events, which only the host client receives.
 */
import { LOG } from '../constants.mjs';
import { documentByUuid, sceneUuidOfToken, worldActors } from '../foundry/documents.mjs';
import { readActorAi, writeActorAi } from '../foundry/flags.mjs';
import { factionsFriendly, isAiFaction, unitBoard } from '../foundry/system-bridge.mjs';
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

/** Whether marking this pair would change anything: only the factions the AI plays are marked, and only once. */
function marksAggression(sourceRole, targetRole, targetAlreadyMarked) {
  if (!isAiFaction(targetRole)) return false;
  if (targetAlreadyMarked === true) return false;
  return isAggression(sourceRole, targetRole);
}

/* -------------------------------------------- */
/*  Writing                                     */
/* -------------------------------------------- */
/** Write the same AI flag changes on several Actors. A failed update is logged and counts as nothing written. */
async function write(actors, changes) {
  try {
    await Promise.all(actors.map(actor => writeActorAi(actor, changes)));
    return actors.length;
  } catch (error) {
    console.error(`${LOG} could not save a unit's Enemy AI flags.`, error);
    return 0;
  }
}

/**
 * Mark the units a committed action came at. Each mark records the Scene it was set on.
 * @param {{factionRole?: string, actorUuid?: string}} source The acting unit: the faction role its event carries, or
 *   its actor uuid to look the role up on the map.
 * @param {object[]} targetActors The Actors acted on.
 * @param {string} sceneUuid The Scene the action happened on.
 * @returns {Promise<number>} How many Actors were marked.
 */
async function markAggressedMany(source, targetActors, sceneUuid = '') {
  const roles = factionRoles(sceneUuid);
  const sourceRole = source.factionRole ?? roles.get(source.actorUuid) ?? '';
  const targets = new Map();
  for (const actor of targetActors) {
    if (!actor.uuid) continue;
    const role = roles.get(actor.uuid) ?? '';
    if (!marksAggression(sourceRole, role, readActorAi(actor).wasAggressed)) continue;
    targets.set(actor.uuid, actor);
  }
  if (targets.size === 0) return 0;
  return write([...targets.values()], { wasAggressed: true, markScene: sceneUuid });
}

/** Clear one unit's aggression mark, once its turn has ended. */
export async function clearAggressed(actor) {
  if (!actor || readActorAi(actor).wasAggressed !== true) return false;
  return await write([actor], { wasAggressed: false }) > 0;
}

/**
 * Wipe one Scene's aggression marks and profile switches when its battle ends, so each unit goes back to the profile
 * the GM chose. That covers the units still on the Scene and every world Actor marked there, such as a linked unit
 * that fell or was removed during the battle.
 */
async function clearBattleMarks(sceneUuid) {
  const onScene = (documentByUuid(sceneUuid)?.tokens ?? []).map(token => token?.actor);
  const leftScene = sceneUuid ? worldActors().filter(actor => readActorAi(actor).markScene === sceneUuid) : [];
  const marked = new Map();
  for (const actor of [...onScene, ...leftScene]) {
    if (!actor?.uuid) continue;
    const ai = readActorAi(actor);
    if (ai.wasAggressed === true || ai.switchedProfile) marked.set(actor.uuid, actor);
  }
  if (marked.size === 0) return 0;
  return write([...marked.values()], { wasAggressed: false, switchedProfile: '', markScene: '' });
}

/* -------------------------------------------- */
/*  Committed event handlers                    */
/* -------------------------------------------- */
/**
 * On a committed combat exchange, mark the defender. The attacker is not marked for the counter it took, since a
 * counter answers an attack rather than starting one. The attacker's faction comes from the event, because an
 * attacker the counter killed has had its token removed by the time the event arrives.
 */
export function onExchangeCommitted(event) {
  const data = event?.data ?? {};
  const target = documentByUuid(data.targetActorUuid);
  if (!target) return Promise.resolve(0);
  const source = { factionRole: String(data.sourceFactionRole ?? '') };
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
  return inFlight(markAggressedMany({ actorUuid: source.uuid }, targets, eventSceneUuid(data)));
}

/** When an encounter ends, clear the aggression marks and profile switches its battle left. */
export function onEncounterEnded(event) {
  return inFlight(clearBattleMarks(String(event?.data?.sceneUuid ?? '')));
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
 * Wait until every mark write the event handlers started has finished, or the time limit passes, so plans see the
 * latest marks. Writes still running at the limit are forgotten, so a stuck write delays the run once rather than
 * once per unit.
 * @returns {Promise<boolean>} False when the limit passed with a write still running.
 */
export async function awaitMarkWrites() {
  if (!writesInFlight.size) return true;
  let expired = false;
  const bound = delay(MARK_WRITE_TIMEOUT_MS).then(() => { expired = true; });
  while (writesInFlight.size && !expired) await Promise.race([Promise.all(writesInFlight), bound]);
  if (!expired) return true;
  console.warn(`${LOG} planning on while ${writesInFlight.size} aggression mark write(s) have not finished.`);
  writesInFlight.clear();
  return false;
}

/**
 * Keep one handler's write in `writesInFlight` until it finishes. A failure `write` has not logged already is logged
 * here, since the hook that called the handler drops its promise.
 */
function inFlight(work) {
  const flight = Promise.resolve(work)
    .then(() => undefined, error => console.error(`${LOG} could not record an aggression mark.`, error))
    .finally(() => writesInFlight.delete(flight));
  writesInFlight.add(flight);
  return work;
}
