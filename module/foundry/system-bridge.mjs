/** @layer foundry */
import { LOG, MODULE_ID, MODULE_TITLE, REQUIRED_API_VERSION } from '../constants.mjs';
import { documentByUuid } from './flags.mjs';

/* -------------------------------------------- */
/*  System API version                          */
/* -------------------------------------------- */
/** The system's public facade, `game.emblemRpg.api`, which the system publishes at its own `init`. */
function systemApi() {
  return globalThis.game?.emblemRpg?.api ?? null;
}

/**
 * Whether the system's facade is at the API version this module is written against. The system raises `api.version`
 * whenever it changes a member a companion module calls, so this one number covers every facade member used below.
 * When it answers false, `foundry/hooks.mjs` skips its ready-time wiring (committed events, the intent line and the
 * resume check) and `driver/phase.mjs` refuses to drive. Both then call `reportStandDown`.
 */
export function systemIntegrated() {
  const api = systemApi();
  return api !== null && Number(api.version) >= REQUIRED_API_VERSION;
}

/** Whether this page has already said why the module stands down. */
let standDownReported = false;

/**
 * Say why the module cannot drive: a warning the GM sees and a console error for the log. Called by
 * `foundry/hooks.mjs` when the world becomes ready and by `driver/phase.mjs` before it would drive, so it is said
 * once per page rather than once per attempt.
 */
export function reportStandDown() {
  if (standDownReported || systemIntegrated()) return;
  standDownReported = true;
  const reason = `the system does not publish API version ${REQUIRED_API_VERSION} or later`;
  console.error(`${LOG} standing down: ${reason}.`);
  globalThis.ui?.notifications?.warn(`${MODULE_TITLE} is standing down: ${reason}.`);
}

/* -------------------------------------------- */
/*  System vocabulary                           */
/* -------------------------------------------- */
/** The result codes the system's commands answer with (`protocol.resultCodes`), keyed by the system's own names. */
export function systemResultCodes() {
  return systemApi().protocol.resultCodes;
}

/** The host states `protocol.host()` reports (`protocol.hostStates`). */
export function systemHostStates() {
  return systemApi().protocol.hostStates;
}

/** The committed-event ids `events.on` subscribes to (`events.types`). */
export function systemEventTypes() {
  return systemApi().events.types;
}

/** The threat tiers `combat.gradeThreat` answers with (`combat.threatTiers`). */
export function systemThreatTiers() {
  return systemApi().combat.threatTiers;
}

/* -------------------------------------------- */
/*  Board and terrain reads                     */
/* -------------------------------------------- */
/**
 * The encounter's phase state on a named Scene.
 * Every read here names its Scene or its Token. An unnamed read answers empty without asking the system, which would
 * otherwise read whatever Scene this client happens to display.
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
  const combat = documentByUuid(combatUuid);
  return combat?.documentName === 'Combat' ? combat : null;
}

/** Every placed unit's facts on a named Scene. */
export function unitBoard(sceneUuid) {
  if (!sceneUuid) return null;
  return systemApi().encounters.getBoard(sceneUuid) ?? null;
}

/** The terrain facts on a named Scene: defend points, teleports, elevations, the travel bound. */
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
/** A movement graph or traversal field for a unit. */
export function movementField(tokenUuid, options = {}) {
  if (!tokenUuid) return null;
  return systemApi().movement.getField({ tokenUuid, ...options }) ?? null;
}

/** Every crossing a unit could attempt this turn, with its odds. */
export function crossingsOf(tokenUuid) {
  if (!tokenUuid) return [];
  return systemApi().movement.crossings({ tokenUuid }) ?? [];
}

/* -------------------------------------------- */
/*  Combat reads                                */
/* -------------------------------------------- */
/** One matchup as the exchange would resolve it, from a hypothetical square. */
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

/** A unit's weapons and items as the system judges them. */
export function loadoutOf(tokenUuid) {
  if (!tokenUuid) return { weapons: [], items: [] };
  return systemApi().combat.loadout(tokenUuid) ?? { weapons: [], items: [] };
}

/** Whether a unit may use an item, and on a target. */
export function canUse(intent) {
  if (!intent?.tokenUuid) return { ok: false };
  return systemApi().combat.canUse(intent) ?? { ok: false };
}

/**
 * Grade one matchup against a target's health with the system's threat rule in `game/combat/threat.mjs`, the rule its
 * threat overlay uses. The intent line in `ui/threat-intent.mjs` passes `allowLethal: true`, which the overlay never
 * does, so a blow that would kill grades lethal there rather than severe.
 * @param {{matchup: object|null, targetHp: number, allowLethal?: boolean}} intent
 * @returns {{tier: string, damageOnHit: number, bestCase: number}|null}
 */
export function gradeThreat(intent) {
  return systemApi().combat.gradeThreat(intent) ?? null;
}

/**
 * The system's rule for an airborne target melee cannot reach: in the air with its stance whole, struck at from the
 * ground, where the world does not play Classic flyer targeting and the map allows flight.
 * @param {object} facts `sourceAirborne`, `targetAirborne`, `targetStanceBroken`, `classicFlyers` and
 *   `flightForbidden`: the attacker's and the target's flight, the target's stance, the world's flyer targeting and
 *   the map's permission.
 * @returns {boolean}
 */
export function airborneBeyondMelee(facts) {
  return systemApi().combat.airborneBeyondMelee(facts) === true;
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
/*  Command host and execution segment          */
/* -------------------------------------------- */
/**
 * The world's command host as this client sees it, or null when the system does not say. This one read is defensive,
 * because the Foundry hooks `foundry/hooks.mjs` installs ask it before the world is ready and whether or not
 * `systemIntegrated` passed. A system too old to answer it is reported by `reportStandDown`.
 */
function commandHost() {
  return systemApi()?.protocol?.host?.() ?? null;
}

/** Whether this client is the one full-GM host that executes, and so drives, for the whole table. */
export function isCommandHost() {
  return commandHost()?.localIsHost === true;
}

/** The refusal the system gives a client that is not the command host. */
export function hostRefusalCode() {
  return commandHost()?.state === systemHostStates().MULTIPLE_HOSTS
    ? systemResultCodes().SOCKET_MULTIPLE_HOSTS
    : systemResultCodes().NO_ACTIVE_GM;
}

/** The host's session, lifecycle and execution as the host reports them, or null when it cannot be asked. */
export async function commandHostStatus() {
  try {
    return await systemApi().protocol.status() ?? null;
  } catch (error) {
    console.warn(`${LOG} could not read the command host's status.`, error);
    return null;
  }
}

/** Open a host-local execution segment, which only the command host may do. */
export async function openExecutionSegment(label) {
  return systemApi().protocol.openExecutionSegment({ label });
}

/** The processing hold this client follows, as the system's blocker reports it, or null when nothing holds it. */
export function processingView() {
  return systemApi().protocol.execution();
}

/** Ask the command host to stop the open execution segment at its next safe boundary. The host checks for staff. */
export async function requestSegmentStop() {
  try {
    return await systemApi().protocol.requestSegmentStop();
  } catch (error) {
    console.warn(`${LOG} could not ask the command host to stop the Enemy AI.`, error);
    return Object.freeze({ ok: false, code: systemResultCodes().COMMAND_FAILED, data: Object.freeze({}) });
  }
}

/** A pause on the system's pacing clock, which a hidden host page cannot slow. */
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

/** One segment's gameplay methods by name, each calling that segment's API and never the global facade. */
export function segmentGameplay(segment) {
  return Object.fromEntries(Object.entries(SEGMENT_GAMEPLAY)
    .map(([name, call]) => [name, (...args) => call(segment.api, ...args)]));
}

/* -------------------------------------------- */
/*  Driven board hold                           */
/* -------------------------------------------- */
/**
 * Claim the system's driven-board hold for this module, naming the unit on the move. The system answers null while
 * another client holds the board. `driver/phase.mjs` takes it for the run and again for each unit.
 */
export function holdBoard({ label, tokenName = '', tokenImg = '' }) {
  return systemApi().encounters.driven.hold({ driverId: MODULE_ID, label, tokenName, tokenImg });
}

/** Release the driven-board hold `holdBoard` took. */
export function releaseBoard() {
  return systemApi().encounters.driven.release();
}

/* -------------------------------------------- */
/*  Board barrier and presentation              */
/* -------------------------------------------- */
/** Block until the board has been continuously quiet for the settle window. */
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
