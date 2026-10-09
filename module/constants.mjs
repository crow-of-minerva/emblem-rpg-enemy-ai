/** @layer enemy-ai */
/*
 * The module's identity and flag keys, the values its flags hold (modes, profiles, condition types, behaviours and
 * item roles) with the labels the GM sees, and the system names it relies on. A profile keeps its turn order and
 * falling back beside the tooltip that describes them. Every folder may import this file; the planner's weights are in
 * planner/tuning.mjs and the driver's waits in driver/timing.mjs.
 */

/* -------------------------------------------- */
/*  Identity                                    */
/* -------------------------------------------- */
export const MODULE_ID = 'emblem-rpg-enemy-ai';
export const MODULE_TITLE = 'Emblem RPG Enemy AI';
/** The prefix on the module's console messages. The module logs straight to the console, not through the system. */
export const LOG = `${MODULE_ID} |`;
/** This module's own API version, published at `game.modules.get('emblem-rpg-enemy-ai').api.version`. */
export const API_VERSION = '1.0.0';
export const SYSTEM_ID = 'emblem-rpg';
/** The system API version this module is written for: the same major, at or above this minor. */
export const SYSTEM_API = Object.freeze({ major: 2, minor: 2 });

/* -------------------------------------------- */
/*  Flags                                       */
/* -------------------------------------------- */
/**
 * Actor flag keys, all under the module scope. `SWITCHED_PROFILE` is a Switch AI Profile condition's profile, kept
 * apart from the GM's `PROFILE` until the battle ends, and `MARK_SCENE` names the Scene whose battle's end clears it
 * and the Aggressed mark, even after the unit's token has left the map.
 */
export const ACTOR_FLAGS = Object.freeze({
  PROFILE: 'profile',
  PRIORITY: 'priority',
  CONDITIONS: 'conditions',
  WAS_AGGRESSED: 'wasAggressed',
  SWITCHED_PROFILE: 'switchedProfile',
  MARK_SCENE: 'markScene',
  SPAWN_ADOPTED: 'spawnAdopted'
});
/** Item flag key for an item's AI parameters: its AI role and that role's settings. */
export const ITEM_FLAGS = Object.freeze({ AI_DATA: 'aiData' });
/** Combat flag keys: the Enemy AI mode, and the phase the AI gave up on after an uncertain result. */
export const COMBAT_FLAGS = Object.freeze({ MODE: 'mode', STOPPED_PHASE: 'stoppedPhase' });
/** Scene flag key: the mode a paused encounter had, kept on its Scene because the pause deletes the Combat. */
export const SCENE_FLAGS = Object.freeze({ PAUSED_MODE: 'pausedMode' });

/* -------------------------------------------- */
/*  Modes                                       */
/* -------------------------------------------- */
/**
 * The Enemy AI modes an encounter can be in, in the order the tracker switch moves through them. On plays the next
 * Enemy Phase only; Locked plays every one.
 */
export const AI_MODES = Object.freeze(['off', 'on', 'locked']);

/* -------------------------------------------- */
/*  Profiles                                    */
/* -------------------------------------------- */
/** The profile a unit plays by until the GM picks one. */
export const AI_PROFILE_DEFAULT = 'balanced';
/** The profile of a unit the GM plays by hand. */
export const AI_MANUAL_PROFILE = 'manual';
/** The priority a unit has until the GM sets one. */
export const AI_PRIORITY_DEFAULT = 0;
/**
 * Every AI profile, in the order the picker lists them, with the picker's tooltip as `description`. `turnOrder` is its
 * place in the enemy phase (0 acts first, 'random' draws a place each round), and `retreatsWhenBroken` is whether the
 * unit falls back when its stance breaks (true, false, or 'coin' for a coin flip each round).
 */
export const AI_PROFILES = Object.freeze([
  Object.freeze({
    value: 'balanced', label: 'Balanced', turnOrder: 1, retreatsWhenBroken: true,
    description: 'The default: weighs damage dealt against counter-attack damage taken, acts mid-phase '
      + 'and falls back when its stance breaks'
  }),
  Object.freeze({
    value: 'cautious', label: 'Cautious', turnOrder: 2, retreatsWhenBroken: true,
    description: 'Fears counter-attacks, avoids squares enemies can hit from where they stand, seeks cover, shuns '
      + 'hazards and risky zone crossings, acts late in the phase and falls back when its stance breaks'
  }),
  Object.freeze({
    value: 'defensive', label: 'Defensive', turnOrder: 2, retreatsWhenBroken: false,
    description: 'Fears counter-attacks and acts late like Cautious, but prizes defensive terrain, holds its ground '
      + 'and never falls back when its stance breaks'
  }),
  Object.freeze({
    value: 'aggressive', label: 'Aggressive', turnOrder: 0, retreatsWhenBroken: false,
    description: 'All but ignores counter-attacks, cover and small hazards, hunts flanks hardest of any profile, '
      + 'acts first and never falls back'
  }),
  Object.freeze({
    value: 'berserk', label: 'Berserk', turnOrder: 0, retreatsWhenBroken: false,
    description: 'Attacks anything it can reach, even when the blow would do nothing, ignores counter-attacks and '
      + 'hazards, acts first and never falls back'
  }),
  Object.freeze({
    value: 'support', label: 'Support', turnOrder: 3, retreatsWhenBroken: true,
    description: 'Prefers healing wounded allies over attacking, using items given the Heal role, fears '
      + 'counter-attacks, avoids squares enemies can hit from where they stand, acts last and falls back when its '
      + 'stance breaks'
  }),
  Object.freeze({
    value: 'passive', label: 'Passive', turnOrder: 3, retreatsWhenBroken: false,
    description: 'Does nothing and ends its turn at once, until a Switch AI Profile condition wakes it'
  }),
  Object.freeze({
    value: 'manual', label: 'Manual', turnOrder: 1, retreatsWhenBroken: true,
    description: 'Played by hand: the enemy phase pauses at its place in the order until you end its turn'
  }),
  Object.freeze({
    value: 'unpredictable', label: 'Unpredictable', turnOrder: 'random', retreatsWhenBroken: 'coin',
    description: 'Rolls Cautious or Aggressive weights each round, acts anywhere in the phase '
      + 'and flips a coin on falling back when its stance breaks'
  })
]);
export const AI_PROFILE_VALUES = Object.freeze(AI_PROFILES.map(profile => profile.value));

/** One field of every profile in AI_PROFILES, keyed by the profile's value. */
function byProfile(field) {
  return Object.freeze(Object.fromEntries(AI_PROFILES.map(profile => [profile.value, profile[field]])));
}

/** The tooltip on the profile picker's help icon in the Actor Control Panel, by profile. */
export const AI_PROFILE_DESCRIPTIONS = byProfile('description');
/**
 * Each profile's place in the enemy phase, or 'random'. It only breaks ties after priority and after weapons that
 * break stance or apply debuffs.
 */
export const PROFILE_TURN_ORDER = byProfile('turnOrder');
/** Whether each profile falls back when its stance breaks: true, false or 'coin'. */
export const PROFILE_RETREATS_WHEN_BROKEN = byProfile('retreatsWhenBroken');
/** The range an Unpredictable unit's place is drawn from: anywhere from first up to the last fixed place. */
export const PROFILE_ORDER_SPAN = Math.max(...AI_PROFILES.map(profile => profile.turnOrder).filter(Number.isFinite));

/* -------------------------------------------- */
/*  Conditions and behaviours                   */
/* -------------------------------------------- */
/** The conditions an entry can test, each about the unit itself, in the order the editor lists them. */
export const AI_CONDITION_TYPES = Object.freeze([
  { value: 'always', label: 'Always' },
  { value: 'aggressed', label: 'Aggressed' },
  { value: 'hpBelow100', label: 'HP <100%' },
  { value: 'hpBelow75', label: 'HP <75%' },
  { value: 'hpBelow50', label: 'HP <50%' },
  { value: 'hpBelow25', label: 'HP <25%' },
  { value: 'broken', label: 'Stance Broken' },
  { value: 'atRound', label: 'At Round' }
]);
/** The fraction of max HP each HP condition fires below. The thresholds overlap on purpose. */
export const AI_HP_THRESHOLDS = Object.freeze({ hpBelow100: 1, hpBelow75: 0.75, hpBelow50: 0.5, hpBelow25: 0.25 });
/** The condition types that take a round number in the From Round field. */
export const AI_CONDITIONS_WITH_NUM = Object.freeze(['atRound']);
/** The lowest round an At Round condition can name. */
export const AI_ROUND_MIN = 1;
/** The behaviours a condition entry can give a unit, in the order the editor lists them. */
export const AI_BEHAVIORS = Object.freeze([
  { value: 'switchProfile', label: 'Switch AI Profile' },
  { value: 'retreat', label: 'Retreat' },
  { value: 'freeRoam', label: 'Free Roam' },
  { value: 'pursue', label: 'Pursue' },
  { value: 'seize', label: 'Seize' }
]);
export const AI_BEHAVIOR_VALUES = Object.freeze(AI_BEHAVIORS.map(behavior => behavior.value));
/** Behaviours whose Max Squares field caps the squares of movement they spend each turn. */
export const AI_BEHAVIORS_WITH_VARIABLE = Object.freeze(['freeRoam', 'pursue']);

/* -------------------------------------------- */
/*  Item roles                                  */
/* -------------------------------------------- */
/** The AI roles an item can be given. The AI never uses an item that has no role. */
export const AI_ITEM_ROLES = Object.freeze([
  { value: '', label: 'None' },
  { value: 'heal', label: 'Heal' }
]);
export const AI_ITEM_ROLE_VALUES = Object.freeze(AI_ITEM_ROLES.map(role => role.value).filter(Boolean));

/* -------------------------------------------- */
/*  System names the module relies on           */
/* -------------------------------------------- */
/*
 * foundry/system-bridge.mjs checks each faction and status name below once the world is ready, and a name the system
 * does not publish switches the module off.
 */
/**
 * Factions the enemy would rather not spend its turn on. How much a target of one is still worth is
 * AI_LESSER_TARGET_APPEAL in planner/tuning.mjs.
 */
export const AI_LESSER_TARGET_FACTIONS = Object.freeze(['Ally']);
/** Factions whose units always see through illusions, whatever their Wit. */
export const LURE_PROOF_FACTIONS = Object.freeze(['Boss']);
/**
 * Statuses under which a unit spends its own turn fleeing instead of standing still. The list is the module's own; the
 * module switches itself off unless the system also counts each one as incapacitating.
 */
export const FLEEING_STATUSES = Object.freeze(['fear']);
/**
 * The item subtypes (`system.itemType`) the AI may use besides Consumables. The planner picks support items from these,
 * and only these show the AI Parameters button on their item sheet.
 */
export const AI_ITEM_SUBTYPES = Object.freeze(['Active', 'Utility', 'Staff (U)']);
