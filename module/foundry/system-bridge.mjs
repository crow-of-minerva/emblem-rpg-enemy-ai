/** @layer foundry */
/*
 * Editor names for the records the system's API returns and the Item data it names, from the system's
 * module/api/types.mjs, which describes each field. These import() types live only in comments and never run, and
 * this is the one place the module names the system's folder, so other files name these aliases instead.
 */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').ApiVersion} ApiVersion */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').EncounterState} EncounterState */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').UnitBoard} UnitBoard */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').MeasuredUnit} MeasuredUnit */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').MeasuredTurn} MeasuredTurn */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').TerrainBoard} TerrainBoard */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').TerrainTeleport} TerrainTeleport */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').Matchup} Matchup */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').MatchupDefender} MatchupDefender */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').Loadout} Loadout */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').LoadoutWeapon} LoadoutWeapon */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').LoadoutItem} LoadoutItem */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').ItemUsability} ItemUsability */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').PairOccupancy} PairOccupancy */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').MovementField} MovementField */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').MovementGraph} MovementGraph */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').MovementCrossing} MovementCrossing */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').HostView} HostView */
/** @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').ItemSystemData} ItemSystemData */
import {
  AI_LESSER_TARGET_FACTIONS,
  FLEEING_STATUSES,
  LOG,
  LURE_PROOF_FACTIONS,
  MODULE_ID,
  MODULE_TITLE,
  SYSTEM_API,
  SYSTEM_ID
} from '../constants.mjs';

/* -------------------------------------------- */
/*  System API version                          */
/* -------------------------------------------- */
/** The system's public API, `game.emblemRpg.api`, published at the system's own `init`. */
function systemApi() {
  return globalThis.game?.emblemRpg?.api ?? null;
}

/** Whether a system API version has the same major as `SYSTEM_API`, with a minor at or above it. */
function versionRuns(version) {
  return version?.major === SYSTEM_API.major && Number(version.minor) >= SYSTEM_API.minor;
}

/**
 * The faction and status names the module chooses for itself that the system does not publish, such as a faction
 * the system has renamed. The factions are checked against `character.factions.groups` and the fleeing statuses
 * against `combat.incapacitatingStatuses`.
 * @returns {string[]} The missing names, empty when every one is published.
 */
export function vocabularyMismatches() {
  const api = systemApi();
  const factions = Object.values(api?.character?.factions?.groups ?? {}).flat();
  const statuses = api?.combat?.incapacitatingStatuses ?? [];
  return [
    ...[...AI_LESSER_TARGET_FACTIONS, ...LURE_PROOF_FACTIONS].filter(faction => !factions.includes(faction)),
    ...FLEEING_STATUSES.filter(status => !statuses.includes(status))
  ];
}

/**
 * Whether the module can run against this system: its API version is the same major as `SYSTEM_API`, with a minor
 * at or above it, and it publishes every name `vocabularyMismatches` checks. When it answers false, the module skips
 * its `ready` setup and refuses to play.
 */
export function systemIntegrated() {
  return versionRuns(systemApi()?.version) && !vocabularyMismatches().length;
}

/** A system API version written for the console, such as 2.0, or none when the system publishes no API. */
function describeVersion(version) {
  if (version === undefined || version === null) return 'none';
  if (typeof version !== 'object') return String(version);
  return `${version.major}.${version.minor}`;
}

/** Whether this client has already warned that the module cannot run. */
let standDownReported = false;

/**
 * The sentence telling the GM that the module is switched off and what to update. A system major above this
 * module's, or a missing name, means the module is the older one.
 */
export function standDownNotice() {
  const version = systemApi()?.version;
  const moduleIsOlder = versionRuns(version) || Number(version?.major) > SYSTEM_API.major;
  return moduleIsOlder
    ? `${MODULE_TITLE} is older than the Emblem RPG system and is switched off. Update the module.`
    : `${MODULE_TITLE} needs a newer Emblem RPG system and is switched off. Update the system.`;
}

/**
 * Tell a GM why the module cannot run, once per page load: a warning on screen saying what to update, and an error in
 * the console with both version numbers, or with the missing names when the version is one the module runs against.
 * A player's client says nothing, because a player cannot make the update the warning asks for.
 */
export function reportStandDown() {
  if (standDownReported || game.user?.isGM !== true || systemIntegrated()) return;
  standDownReported = true;
  const version = systemApi()?.version;
  if (versionRuns(version)) {
    console.error(`${LOG} standing down: the system does not publish ${vocabularyMismatches().join(', ')}, which `
      + 'this module uses.');
  } else {
    console.error(`${LOG} standing down: the system API is ${describeVersion(version)}, and this module needs `
      + `${SYSTEM_API.major}.${SYSTEM_API.minor} or a later ${SYSTEM_API.major}.x.`);
  }
  globalThis.ui?.notifications?.warn(standDownNotice());
}

/* -------------------------------------------- */
/*  The system's names and codes                */
/* -------------------------------------------- */
/** The result codes the system's commands answer with (`protocol.resultCodes`), keyed by the system's own names. */
export function systemResultCodes() {
  return systemApi().protocol.resultCodes;
}

/** The host client's start-up states, which `protocol.status()` reports as `lifecycle` (`protocol.lifecycleStates`). */
export function systemLifecycleStates() {
  return systemApi().protocol.lifecycleStates;
}

/** The committed-event ids `events.on` subscribes to (`events.types`). */
export function systemEventTypes() {
  return systemApi().events.types;
}

/** The threat tiers `combat.gradeThreat` answers with (`combat.threatTiers`). */
export function systemThreatTiers() {
  return systemApi().combat.threatTiers;
}

/** The two phase names an encounter's state reports, `{PLAYER, ENEMY}` (`encounters.phases`). */
export function systemPhases() {
  return systemApi().encounters.phases;
}

/**
 * Every value of a carried item's fields that the module compares, as the system's LoadoutItem typedef names them:
 * its Foundry `type`, `actionType`, `targetType`, `rangeType` and `losRule`. Renaming one raises the system's API
 * major version, which switches this module off. The item subtypes the AI uses are listed in AI_ITEM_SUBTYPES.
 */
const ITEM_TYPE_CONSUMABLE = 'Consumable';
const ITEM_ACTION_STANDARD = 'Standard Action';
const ITEM_ACTION_BONUS = 'Bonus Action';
const ITEM_TARGETS_SELF = 'Self';
const ITEM_RANGE_SINGLE = 'Single';
const ITEM_SIGHT_NORMAL = 'normal';

/** Whether an item is a Consumable, by its Foundry item type; it takes a loadout item or an Item document. */
export function itemIsConsumable(item) {
  return item?.type === ITEM_TYPE_CONSUMABLE;
}

/** Whether using a loadout item takes the unit's standard action. */
export function itemTakesStandardAction(item) {
  return item.actionType === ITEM_ACTION_STANDARD;
}

/** Whether using a loadout item takes the unit's bonus action. */
export function itemTakesBonusAction(item) {
  return item.actionType === ITEM_ACTION_BONUS;
}

/** Whether a loadout item targets only its user, as a Potion or Second Wind does. */
export function itemTargetsSelf(item) {
  return item.targetType === ITEM_TARGETS_SELF;
}

/** Whether a loadout item reaches a single unit. The system's item data gives a new item the range type Single. */
export function itemReachesOneUnit(item) {
  return (item.rangeType ?? ITEM_RANGE_SINGLE) === ITEM_RANGE_SINGLE;
}

/**
 * A loadout item's line-of-sight rule, or the normal rule, under which walls and height both block sight, when no
 * item is given or it names none.
 */
export function itemSightRule(item) {
  return item?.losRule ?? ITEM_SIGHT_NORMAL;
}

/** Whether a line-of-sight rule is the normal one, under which height also limits a touch-range heal. */
export function isNormalSightRule(losRule) {
  return losRule === ITEM_SIGHT_NORMAL;
}

/** The lowercase status keys that take a unit's action away (`combat.incapacitatingStatuses`). */
export function systemIncapacitatingStatuses() {
  return systemApi().combat.incapacitatingStatuses;
}

/** The largest floor difference a melee attack can reach across (`combat.meleeElevationReach`). */
export function systemMeleeElevationReach() {
  return Number(systemApi().combat.meleeElevationReach);
}

/**
 * The attribute, and its value, that let a GM press a Stop control while the system is busy, as
 * `{ATTRIBUTE, SEGMENT_STOP}` (`protocol.processingControl`). The tracker's Enemy AI switch carries it.
 */
export function systemProcessingControl() {
  return systemApi().protocol.processingControl;
}

/*
 * The faction and spawn readers below also run in the Combat AI tab and on Actor updates, which happen even while the
 * module is switched off. Against a system without them they answer empty instead of throwing.
 */

/** The factions the AI plays: the system's enemy and neutral faction groups (`character.factions.groups`). */
export function systemAiFactions() {
  const groups = systemApi()?.character?.factions?.groups;
  return [...(groups?.enemy ?? []), ...(groups?.neutral ?? [])];
}

/** Whether the AI plays units of this faction, and so whether they get an AI profile. */
export function isAiFaction(role) {
  return systemAiFactions().includes(role);
}

/**
 * The Actor flag, under the system's scope, where a terrain spawn writes the behaviour it gave the unit, and that
 * flag's choices as `{value, label}` (`encounters.spawnBehaviors`).
 * @returns {{flag: string, choices: Array<{value: string, label: string}>}}
 */
function systemSpawnBehaviors() {
  const vocabulary = systemApi()?.encounters?.spawnBehaviors;
  return { flag: String(vocabulary?.flag ?? ''), choices: vocabulary?.choices ?? [] };
}

/** The behaviour a terrain spawn gave this Actor, or an empty string when it gave none. */
export function systemSpawnBehaviorOf(actor) {
  const { flag } = systemSpawnBehaviors();
  return flag ? String(actor?.flags?.[SYSTEM_ID]?.[flag] ?? '') : '';
}

/** Whether an Actor update writes the system's spawn behaviour flag. */
export function changesSystemSpawnBehavior(changed) {
  const { flag } = systemSpawnBehaviors();
  return Boolean(flag) && changed?.flags?.[SYSTEM_ID]?.[flag] !== undefined;
}

/**
 * The system's label for a movement behaviour, such as Pursuant for pursue, or an empty string when the system's
 * spawn choices don't list it. The AI's Pursue, Free Roam and Seize behaviours share their values with those choices.
 */
export function spawnBehaviorLabel(behavior) {
  if (!behavior) return '';
  return systemSpawnBehaviors().choices.find(choice => choice.value === behavior)?.label ?? '';
}

/* -------------------------------------------- */
/*  Item data                                   */
/* -------------------------------------------- */
/**
 * An Item document's subtype within its Foundry item type, such as `'Active'` or `'Staff (U)'`, or `''` when it has
 * none. It reads `system.itemType`, which the system's api/types.mjs names as part of its API (`ItemSystemData`).
 * @param {{system?: ItemSystemData}|null} item The Item document.
 * @returns {string}
 */
export function systemItemType(item) {
  return String(item?.system?.itemType ?? '');
}

/* -------------------------------------------- */
/*  Unit and terrain reads                      */
/* -------------------------------------------- */
/**
 * The encounter's phase state on a named Scene. Like every read here, an unnamed read answers empty without asking
 * the system, which would otherwise read whatever Scene this client happens to show.
 * @param {string} sceneUuid The Scene to read.
 * @returns {EncounterState|null} Null when no Scene is named or the system can't read it.
 */
export function encounterState(sceneUuid) {
  if (!sceneUuid) return null;
  return systemApi().encounters.getState(sceneUuid) ?? null;
}

/**
 * The Combat behind the module API's mode calls, from a Scene or Combat uuid or a document with one. With no target
 * it returns null rather than reading the Scene this client displays.
 */
export function modeEncounter(reference) {
  const uuid = typeof reference === 'string' ? reference : reference?.uuid;
  if (typeof uuid !== 'string') return null;
  const combatUuid = /^Scene\.[^.]+$/.test(uuid) ? encounterState(uuid)?.combatUuid : uuid;
  if (!/^Combat\.[^.]+$/.test(combatUuid ?? '')) return null;
  return globalThis.game?.combats?.get(combatUuid.slice('Combat.'.length)) ?? null;
}

/**
 * Every placed unit's data on a named Scene.
 * @param {string} sceneUuid The Scene to read.
 * @returns {UnitBoard|null} Null when no Scene is named or the system can't read it.
 */
export function unitBoard(sceneUuid) {
  if (!sceneUuid) return null;
  return systemApi().encounters.getBoard(sceneUuid) ?? null;
}

/**
 * The terrain data on a named Scene: defend points, teleports, elevations, the travel bound.
 * @param {string} sceneUuid The Scene to read.
 * @returns {TerrainBoard|null} Null when no Scene is named or the system can't read it.
 */
export function terrainBoard(sceneUuid) {
  if (!sceneUuid) return null;
  return systemApi().terrain.getBoard(sceneUuid) ?? null;
}

/** The defensive terrain a unit would sit on at a square. */
export function terrainModifiersAt(tokenUuid, standing) {
  if (!tokenUuid) return null;
  return systemApi().terrain.modifiersAt({ tokenUuid, standing }) ?? null;
}

/** The net HP delta the phase-opening hazard would apply to a unit standing at a square. */
export function hazardAt(tokenUuid, standing) {
  if (!tokenUuid) return 0;
  return Number(systemApi().terrain.hazardAt({ tokenUuid, standing })) || 0;
}

/** The terrain height under a footprint's centre square on a named Scene. */
export function elevationAt(sceneUuid, standing, width = 1, height = 1) {
  if (!sceneUuid) return 0;
  return Number(systemApi().terrain.elevationAt({ sceneUuid, standing, width, height })) || 0;
}

/** The aura fields a unit would carry standing at a square. */
export function auraFieldsAt(tokenUuid, standing) {
  if (!tokenUuid) return {};
  return systemApi().terrain.auraFieldsAt({ tokenUuid, standing }) ?? {};
}

/** The aura fields a unit would carry on each of several squares, by cell key, in one read. */
export function auraFieldsAtMany(tokenUuid, standings) {
  if (!tokenUuid) return null;
  return systemApi().terrain.auraFieldsAtMany({ tokenUuid, standings }) ?? null;
}

/* -------------------------------------------- */
/*  Movement reads                              */
/* -------------------------------------------- */
/**
 * The system's movement search for a unit (`movement.getField`): what each square costs to reach, the route there,
 * and the squares other tokens take up.
 * @param {string} tokenUuid The unit's token.
 * @param {object} [options] The search options `movement.getField` takes, such as `start`, `maxCost` or `reverse`.
 * @returns {MovementField|null} Null when the token is missing or has no actor.
 */
export function movementField(tokenUuid, options = {}) {
  if (!tokenUuid) return null;
  return systemApi().movement.getField({ tokenUuid, ...options }) ?? null;
}

/**
 * Every climb or drop a unit could attempt this turn, with its odds.
 * @param {string} tokenUuid The unit's token.
 * @returns {readonly MovementCrossing[]} None when the token is missing or has no actor.
 */
export function crossingsOf(tokenUuid) {
  if (!tokenUuid) return [];
  return systemApi().movement.crossings({ tokenUuid }) ?? [];
}

/**
 * Whether one unit may move through another's squares, by the rule the system's own pathfinding uses.
 * @param {string} tokenUuid The moving unit's token.
 * @param {string} otherTokenUuid The token in its way.
 * @returns {PairOccupancy|null} Whether it may pass, and whether it may not stop on those squares; null when either
 *   token is missing.
 */
export function canPass(tokenUuid, otherTokenUuid) {
  if (!tokenUuid || !otherTokenUuid) return null;
  return systemApi().movement.canPass({ tokenUuid, otherTokenUuid }) ?? null;
}

/* -------------------------------------------- */
/*  Combat reads                                */
/* -------------------------------------------- */
/**
 * One matchup as the exchange would resolve it, from a hypothetical square.
 * @param {object} intent The attacker's and defender's tokens, the weapon, the distance and the square to measure from.
 * @returns {Matchup|null} Null when either token is missing or the system can't measure the matchup.
 */
export function measure(intent) {
  if (!intent?.attackerTokenUuid || !intent.defenderTokenUuid) return null;
  return systemApi().combat.measure(intent) ?? null;
}

/** Whether a unit could strike a target from a square, and at what distance. */
export function canEngage(intent) {
  if (!intent?.tokenUuid || !intent.targetTokenUuid) return null;
  const distance = systemApi().combat.canEngage(intent);
  return Number.isFinite(distance) ? distance : null;
}

/** Whether walls or height hide a target from a square. */
export function sightBlocked(intent) {
  if (!intent?.tokenUuid || !intent.targetTokenUuid) return false;
  return systemApi().combat.sightBlocked(intent) === true;
}

/** Whether standing on a square flanks the target, or leaves the unit flanked. */
export function flankingAt(intent) {
  if (!intent?.tokenUuid) return { flanks: false, flanked: false };
  return systemApi().combat.flanking(intent) ?? { flanks: false, flanked: false };
}

/**
 * A unit's weapons and items as the system judges them.
 * @param {string} tokenUuid The unit's token.
 * @returns {Loadout} Empty lists when the token is missing or the system can't read it.
 */
export function loadoutOf(tokenUuid) {
  if (!tokenUuid) return { weapons: [], items: [] };
  return systemApi().combat.loadout(tokenUuid) ?? { weapons: [], items: [] };
}

/**
 * Whether a unit may use an item, and on a target.
 * @param {{tokenUuid: string, itemId: string, targetTokenUuid?: string}} intent The unit, its item and the target.
 * @returns {ItemUsability|{ok: false}} Only `ok: false` when the token is missing or the system can't answer.
 */
export function canUse(intent) {
  if (!intent?.tokenUuid) return { ok: false };
  return systemApi().combat.canUse(intent) ?? { ok: false };
}

/**
 * Grade one matchup against a target's health by the rule the system's threat overlay uses (`combat.gradeThreat`).
 * With `allowLethal: true`, which the overlay never passes, a blow that would kill grades lethal rather than severe.
 * @param {{matchup: object|null, targetHp: number, allowLethal?: boolean}} intent
 * @returns {{tier: string, damageOnHit: number, bestCase: number}|null}
 */
export function gradeThreat(intent) {
  return systemApi().combat.gradeThreat(intent) ?? null;
}

/**
 * The system's rule for an airborne target melee cannot reach: in the air with its stance whole, struck at from the
 * ground, where the world does not play Classic flyer targeting and the map allows flight.
 * @param {object} situation `sourceAirborne`, `targetAirborne`, `targetStanceBroken`, `classicFlyers` and
 *   `flightForbidden`: the attacker's and the target's flight, the target's stance, the world's flyer targeting and
 *   the map's permission.
 * @returns {boolean}
 */
export function airborneBeyondMelee(situation) {
  return systemApi().combat.airborneBeyondMelee(situation) === true;
}

/** Whether the system counts two factions as hostile. */
export function factionsHostile(a, b) {
  return systemApi().character.factions.hostile(a, b) === true;
}

/** Whether the system counts two factions as friendly. */
export function factionsFriendly(a, b) {
  return systemApi().character.factions.friendly(a, b) === true;
}

/* -------------------------------------------- */
/*  Host client and execution segment           */
/* -------------------------------------------- */
/**
 * Which client hosts commands, as this client sees it, or null when the system does not say. This one read is
 * defensive, because Foundry hooks ask it before the world is ready and even when the system's API is too old.
 * @returns {HostView|null}
 */
function commandHost() {
  return systemApi()?.protocol?.host?.() ?? null;
}

/** Whether this is the host client: the one GM client, on one tab, that runs every command and plays the AI. */
export function isCommandHost() {
  return commandHost()?.localIsHost === true;
}

/** The host's session, lifecycle and execution as the host reports them, or null when it cannot be asked. */
export async function commandHostStatus() {
  try {
    return await systemApi().protocol.status() ?? null;
  } catch (error) {
    console.warn(`${LOG} could not read the host client's status.`, error);
    return null;
  }
}

/** Open an execution segment, which gives the host client the sole right to run commands until it is closed. */
export async function openExecutionSegment(label) {
  return systemApi().protocol.openExecutionSegment({ label });
}

/** What the system reports is running right now, if anything; its `owner` says who is running it. */
export function processingView() {
  return systemApi().protocol.execution();
}

/** Ask the host client to stop the open execution segment after its current action. Only a GM or Assistant GM may. */
export async function requestSegmentStop() {
  try {
    return await systemApi().protocol.requestSegmentStop();
  } catch (error) {
    console.warn(`${LOG} could not ask the host client to stop the Enemy AI.`, error);
    return Object.freeze({ ok: false, code: systemResultCodes().COMMAND_FAILED, data: Object.freeze({}) });
  }
}

/** A pause on the system's timer, which a hidden host tab does not slow down. */
export function pacingWait(milliseconds) {
  return Promise.resolve(systemApi().protocol.wait(Math.max(0, Number(milliseconds) || 0)));
}

/** Each gameplay method a turn calls, and the segment API member it runs as one system action. */
const SEGMENT_GAMEPLAY = Object.freeze({
  drive: (api, intent) => api.movement.drive(intent),
  teleport: (api, tokenUuid) => api.movement.teleport(tokenUuid),
  cross: (api, intent) => api.movement.cross(intent),
  toggleFlight: (api, tokenUuid) => api.movement.toggleFlight(tokenUuid),
  resolveExchange: (api, intent) => api.combat.resolveExchange(intent),
  resolveContinuation: (api, intent) => api.combat.resolveContinuation(intent),
  activateItem: (api, intent) => api.items.activate(intent),
  endTurn: (api, intent) => api.encounters.endTurn(intent),
  wieldWeapon: (api, actorUuid, itemId) => api.character.inventory.toggleEquipment({ actorUuid, itemId })
});

/** The names of the gameplay methods a turn may call. */
export const SEGMENT_GAMEPLAY_METHODS = Object.freeze(Object.keys(SEGMENT_GAMEPLAY));

/** One segment's gameplay methods by name, each calling that segment's API, never the global `game.emblemRpg.api`. */
export function segmentGameplay(segment) {
  return Object.fromEntries(Object.entries(SEGMENT_GAMEPLAY)
    .map(([name, call]) => [name, (...args) => call(segment.api, ...args)]));
}

/* -------------------------------------------- */
/*  Board hold                                  */
/* -------------------------------------------- */
/**
 * Take the system's board hold for this module, naming the unit on the move: a world setting that shows a banner and
 * blocks manual movement. The system answers null while someone else holds it.
 */
export function holdBoard({ label, tokenName = '', tokenImg = '' }) {
  return systemApi().encounters.driven.hold({ driverId: MODULE_ID, label, tokenName, tokenImg });
}

/** Release the board hold `holdBoard` took. */
export function releaseBoard() {
  return systemApi().encounters.driven.release();
}

/* -------------------------------------------- */
/*  Waiting and presentation                    */
/* -------------------------------------------- */
/** Wait until the map has been quiet for the given window. */
export function awaitBoardSettled(options) {
  return systemApi().board.awaitSettled(options);
}

/** An enemy-phase camera beat on every client. */
export function enemyPhaseCamera(beat, tokenUuid = '') {
  return systemApi().presentation.camera.enemyPhase({ beat, tokenUuid });
}

/** Face two units toward each other. */
export function faceTargets(sourceTokenUuid, targetTokenUuid) {
  return systemApi().presentation.tokenArt.faceTargets(sourceTokenUuid, targetTokenUuid);
}

/** Play one of the system's sounds. */
export function playSound(soundId, options) {
  return systemApi().presentation.audio.play(soundId, options);
}

/** Register the intent provider the threat lines ask when an enemy is selected. */
export function registerIntentProvider(provider) {
  return systemApi().presentation.threat.registerIntentProvider(provider);
}

/** Subscribe to a committed event. Returns the function that unsubscribes. */
export function onCommittedEvent(type, handler) {
  return systemApi().events.on(type, handler);
}
