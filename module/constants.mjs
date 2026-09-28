/** @layer enemy-ai */

/* -------------------------------------------- */
/*  Identity                                    */
/* -------------------------------------------- */
export const MODULE_ID = 'emblem-rpg-enemy-ai';
export const MODULE_TITLE = 'Emblem RPG Enemy AI';
/** The prefix on the module's console messages. The module logs straight to the console, not through the system. */
export const LOG = `${MODULE_ID} |`;
export const API_VERSION = '1.0.0';
export const SYSTEM_ID = 'emblem-rpg';
/** The lowest system `api.version` that publishes every facade member `foundry/system-bridge.mjs` calls. */
export const REQUIRED_API_VERSION = 1;

/* -------------------------------------------- */
/*  Flags and settings                          */
/* -------------------------------------------- */
/** Actor flag keys, all under the module scope. */
export const ACTOR_FLAGS = Object.freeze({
  PROFILE: 'profile',
  PRIORITY: 'priority',
  CONDITIONS: 'conditions',
  WAS_AGGRESSED: 'wasAggressed',
  SPAWN_ADOPTED: 'spawnAdopted'
});
/** Item flag key for an item's AI parameters: its AI role and that role's settings. */
export const ITEM_FLAGS = Object.freeze({ AI_DATA: 'aiData' });
/** Combat flag keys: the Enemy AI mode, and the phase the host stopped driving after an uncertain outcome. */
export const COMBAT_FLAGS = Object.freeze({ MODE: 'mode', STOPPED_PHASE: 'stoppedPhase' });
/** Scene flag key: the mode a paused encounter had, kept on its Scene because the pause deletes the Combat. */
export const SCENE_FLAGS = Object.freeze({ PAUSED_MODE: 'pausedMode' });
/** The system flag a terrain spawn leaves on a unit. The AI reads it as an extra Always condition after the rest. */
export const SYSTEM_SPAWN_BEHAVIOR_FLAG = 'spawnBehavior';

/* -------------------------------------------- */
/*  System execution                            */
/* -------------------------------------------- */
/** The label the AI's execution segment carries. */
export const EXECUTION_SEGMENT_LABEL = 'Enemy Phase';
/**
 * The attribute that lets a staff control through the system's processing guard while the world is busy. The
 * tracker's AI switch carries it, so a GM can ask a running segment to stop.
 */
export const PROCESSING_CONTROL = Object.freeze({
  ATTRIBUTE: 'data-emblem-processing-control',
  SEGMENT_STOP: 'segment-stop'
});
/** How long a run waits for world execution, and a resume check for the host to finish startup recovery. */
export const EXECUTION_TIMING = Object.freeze({
  acquirePollMs: 400,
  acquireTimeoutMs: 30000,
  readinessPollMs: 1000,
  readinessTimeoutMs: 600000
});

/* -------------------------------------------- */
/*  Modes and factions                          */
/* -------------------------------------------- */
export const AI_MODES = Object.freeze(['off', 'on', 'locked']);
/** Factions the AI drives, and so the ones that get an AI profile. */
export const AI_FACTIONS = Object.freeze(['Enemy', 'Boss', 'Neutral']);
export const AI_PROFILE_FACTIONS = AI_FACTIONS;
/** Factions the enemy would rather not spend its turn on, and what is left of a target's worth once it is one. */
export const AI_LESSER_TARGET_FACTIONS = Object.freeze(['Ally']);
export const AI_LESSER_TARGET_APPEAL = 0.5;

/* -------------------------------------------- */
/*  Profiles                                    */
/* -------------------------------------------- */
export const AI_PROFILE_DEFAULT = 'balanced';
export const AI_MANUAL_PROFILE = 'manual';
export const AI_PRIORITY_DEFAULT = 0;
/** Every AI profile, in the order the picker lists them. */
export const AI_PROFILES = Object.freeze([
  { value: 'balanced', label: 'Balanced' },
  { value: 'cautious', label: 'Cautious' },
  { value: 'defensive', label: 'Defensive' },
  { value: 'aggressive', label: 'Aggressive' },
  { value: 'berserk', label: 'Berserk' },
  { value: 'support', label: 'Support' },
  { value: 'passive', label: 'Passive' },
  { value: 'manual', label: 'Manual' },
  { value: 'unpredictable', label: 'Unpredictable' }
]);
export const AI_PROFILE_VALUES = Object.freeze(AI_PROFILES.map(profile => profile.value));
/**
 * Tooltip text for the profile picker's help icon in the Actor Control Panel tray. Each entry sums up how the AI
 * plays that profile: its weights in RISK_PROFILES, its place in PROFILE_TURN_ORDER and `retreatsWhenBroken`.
 */
export const AI_PROFILE_DESCRIPTIONS = Object.freeze({
  balanced:
    'The default: weighs damage dealt against counter-attack damage taken, '
    + 'acts mid-phase '
    + 'and falls back when its stance breaks',
  cautious:
    'Fears counter-attacks, avoids squares enemies can reach, '
    + 'seeks cover, shuns hazards and risky zone crossings, '
    + 'acts late in the phase '
    + 'and falls back when its stance breaks',
  defensive:
    'Fears counter-attacks and acts late like Cautious, '
    + 'but prizes defensive terrain, holds its ground '
    + 'and never falls back when its stance breaks',
  aggressive:
    'All but ignores counter-attacks, cover and small hazards, '
    + 'hunts flanks hardest of any profile, '
    + 'acts first and never falls back',
  berserk:
    'Attacks anything it can reach, even when the blow would do nothing, '
    + 'ignores counter-attacks and hazards, '
    + 'acts first and never falls back',
  support:
    'Prefers healing wounded allies over attacking, using items given the Heal role, '
    + 'fears counter-attacks, avoids squares enemies can reach, '
    + 'acts last '
    + 'and falls back when its stance breaks',
  passive:
    'Does nothing '
    + 'and ends its turn at once, '
    + 'until a Switch AI Profile condition '
    + 'wakes it',
  manual:
    'Played by hand: '
    + 'the enemy phase pauses at its place in the order '
    + 'until you end its turn',
  unpredictable:
    'Rolls Cautious or Aggressive weights each round, acts anywhere in the phase '
    + 'and flips a coin on falling back when its stance breaks'
});

/* -------------------------------------------- */
/*  Conditions and behaviours                   */
/* -------------------------------------------- */
export const AI_CONDITION_TARGETS = Object.freeze([
  { value: 'self', label: 'Self' },
  { value: 'players', label: 'Players', disabled: true }
]);
/** The conditions an entry can test, grouped by whose state they watch. Player conditions are saved but never hold. */
export const AI_CONDITION_TYPES = Object.freeze({
  self: Object.freeze([
    { value: 'always', label: 'Always' },
    { value: 'aggressed', label: 'Aggressed' },
    { value: 'hpBelow100', label: 'HP <100%' },
    { value: 'hpBelow75', label: 'HP <75%' },
    { value: 'hpBelow50', label: 'HP <50%' },
    { value: 'hpBelow25', label: 'HP <25%' },
    { value: 'broken', label: 'Stance Broken' },
    { value: 'atRound', label: 'At Round' }
  ]),
  players: Object.freeze([
    { value: 'enteredZone', label: 'Entered Zone(s)' },
    { value: 'defeatedTarget', label: 'Defeated Target' }
  ])
});
/** The fraction of max HP each HP condition fires below. The thresholds overlap on purpose. */
export const AI_HP_THRESHOLDS = Object.freeze({ hpBelow100: 1, hpBelow75: 0.75, hpBelow50: 0.5, hpBelow25: 0.25 });
/** Below this fraction of max HP a unit counts as critically wounded for heal prioritisation. */
export const AI_CRITICAL_FRACTION = 0.25;
export const AI_CONDITIONS_WITH_NUM = Object.freeze(['atRound']);
export const AI_ROUND_MIN = 1;
export const AI_BEHAVIORS = Object.freeze([
  { value: 'switchProfile', label: 'Switch AI Profile' },
  { value: 'retreat', label: 'Retreat' },
  { value: 'freeRoam', label: 'Free Roam' },
  { value: 'pursue', label: 'Pursue' },
  { value: 'seize', label: 'Seize' }
]);
export const AI_BEHAVIOR_VALUES = Object.freeze(AI_BEHAVIORS.map(behavior => behavior.value));
export const AI_BEHAVIORS_WITH_VARIABLE = Object.freeze(['freeRoam', 'pursue']);
/** Behaviours that move a unit only when its turn found nothing else to do. */
export const AI_MOVEMENT_FALLBACK_BEHAVIORS = Object.freeze(['freeRoam', 'pursue']);
/** Behaviours that move the unit before its action rather than instead of it. */
export const AI_MOVEMENT_PRIMARY_BEHAVIORS = Object.freeze(['seize']);
/** Behaviours under which a unit is not looking for something to hit, and so is not fooled by an illusion. */
export const AI_LURE_BLIND_BEHAVIORS = Object.freeze(['seize', 'retreat']);
/** Tracker badge labels for the movement behaviours a unit is under. */
export const AI_BEHAVIOR_LABELS = Object.freeze({ pursue: 'Pursuant', freeRoam: 'Roaming', seize: 'Seizing' });
/** The AI roles an item can be given. The AI never uses an item that has no role. */
export const AI_ITEM_ROLES = Object.freeze([
  { value: '', label: 'None' },
  { value: 'heal', label: 'Heal' }
]);
export const AI_ITEM_ROLE_VALUES = Object.freeze(AI_ITEM_ROLES.map(role => role.value).filter(Boolean));
/** Item subtypes the AI may activate for support. */
export const SUPPORT_ITEM_TYPES = Object.freeze(new Set(['Active', 'Utility', 'Staff (U)']));
/** Item subtypes that carry AI parameters on the item sheet. */
export const AI_PARAMETER_ITEM_TYPES = Object.freeze(new Set(['Active', 'Utility', 'Staff (U)']));
/** Statuses that take a unit's action away, so it plans no attack and threatens nobody. */
export const INCAPACITATING_STATUSES = Object.freeze(['stunned', 'stun', 'stasis', 'fear', 'frozen']);
/** The incapacitating statuses that leave a unit its movement, which its own turn must spend fleeing. */
export const FLEEING_STATUSES = Object.freeze(['fear']);
/** Wit above which a unit sees through illusions. */
export const LURE_WIT_THRESHOLD = 10;

/* -------------------------------------------- */
/*  Tracker tooltips                            */
/* -------------------------------------------- */
/** The tooltip on the tracker's Enemy AI switch, by mode. */
export const COMBAT_AI_TOOLTIPS = Object.freeze({
  off: 'Not playing enemy phases',
  on: 'Plays the next enemy phase, then switches itself off '
    + 'when the player phase begins',
  locked: 'Plays every enemy phase until switched off'
});

/* -------------------------------------------- */
/*  Pacing                                      */
/* -------------------------------------------- */
export const MAX_ACTIONS_PER_UNIT = 2;
/**
 * The two presentation pauses the driver takes, set as short as the table can still follow. `driver/phase.mjs`
 * waits UNIT_HANDOFF_DELAY_MS between units, and `driver/pacing.mjs` waits POST_MOVE_DELAY_MS after a move.
 */
export const UNIT_HANDOFF_DELAY_MS = 113;
export const POST_MOVE_DELAY_MS = 63;
export const IDLE_TURN_YIELD_MS = 30;
export const MANUAL_POLL_MS = 400;
export const ABORT_DOUBLE_PRESS_MS = 300;
export const SETTLE_STABLE_MS = 400;
export const SETTLE_TIMEOUT_MS = 120000;
export const SETTLE_POLL_MS = 200;
/** Turn order within the phase, by profile. Support goes last so its heals land after the fighting. */
export const PROFILE_TURN_ORDER = Object.freeze({
  berserk: 0, aggressive: 0, balanced: 1, defensive: 2, cautious: 2, support: 3, passive: 3
});
export const PROFILE_ORDER_SPAN = 3;

/* -------------------------------------------- */
/*  Scoring weights                             */
/* -------------------------------------------- */
/** The score currency: one point is roughly one percent of the relevant unit's maximum health. */
export const SCORE_SCALE = 100;
export const CRITICAL_HEAL_BONUS = 25;
export const LETHAL_BONUS = 10;
export const UNANSWERED_FACTOR = 0.25;
export const SUICIDE_PENALTY = 5;
export const MIN_MEANINGFUL_DAMAGE = 0.5;
export const SCORE_EPSILON = 0.001;
export const BREAK_BONUS = 0.35;
export const BREAK_PROGRESS_WEIGHT = 0.15;
export const BREACH_VULNERABLE_BIAS = 1.2;
export const BREACH_PROTECTED_BIAS = 0.5;
export const SEIZE_BLOCKER_BONUS = 60;
export const SEIZE_UNLOCK_TURNS = 3;
export const SEIZE_BREACH_PROGRESS = 40;
export const SEIZE_BLOCKADE_TURN_COST = 2;
export const SEIZE_DETOUR_KILL_CHANCE = 0.5;
export const SEIZE_DETOUR_DAMAGE_FRACTION = 0.25;
export const DEBUFF_SETUP_VALUE = 2;
export const POSITION_EXPOSURE_PENALTY = 4;
export const POSITION_COVER_UNIT = 0.75;
export const POSITION_FLANK_BONUS = 8;
export const POSITION_HOLD_GROUND = 1;

/* -------------------------------------------- */
/*  Risk profiles                               */
/* -------------------------------------------- */
/**
 * Each AI profile's weights: what it will risk, what it values, and how far ahead it looks. `dealtTypeWeight` and
 * `takenTypeWeight` weigh damage types against the raw numbers in `planner/scoring.mjs`: the share by which a blow's
 * worth, or the counter's cost, grows when its type strikes a vulnerability and shrinks when it strikes a protection.
 */
export const RISK_PROFILES = Object.freeze({
  cautious: Object.freeze({
    minChance: 60, fallAversion: 2, futureDiscount: 0.35, counterWeight: 1.5,
    exposureWeight: 1.5, coverWeight: 1.5, flankWeight: 0.5, hazardWeight: 1.5, holdGround: 0,
    healWeight: 1.2, lethalWeight: 0.75,
    dealtTypeWeight: 0.1, takenTypeWeight: 0.5
  }),
  defensive: Object.freeze({
    minChance: 60, fallAversion: 2, futureDiscount: 0.35, counterWeight: 1.5,
    exposureWeight: 0, coverWeight: 2, flankWeight: 1, hazardWeight: 1.5, holdGround: 0.5,
    healWeight: 1.2, lethalWeight: 0.75,
    dealtTypeWeight: 0.1, takenTypeWeight: 0.5
  }),
  balanced: Object.freeze({
    minChance: 40, fallAversion: 1, futureDiscount: 0.4, counterWeight: 1,
    exposureWeight: 0, coverWeight: 0.5, flankWeight: 1, hazardWeight: 1, holdGround: 0,
    healWeight: 1, lethalWeight: 1,
    dealtTypeWeight: 0.25, takenTypeWeight: 0.25
  }),
  aggressive: Object.freeze({
    minChance: 25, fallAversion: 0.5, futureDiscount: 0.5, counterWeight: 0.25,
    exposureWeight: 0, coverWeight: 0, flankWeight: 1.5, hazardWeight: 0.5, holdGround: 0,
    healWeight: 0.5, lethalWeight: 1.25,
    dealtTypeWeight: 0.5, takenTypeWeight: 0.1
  }),
  berserk: Object.freeze({
    minChance: 10, fallAversion: 0, futureDiscount: 0.2, counterWeight: 0,
    exposureWeight: 0, coverWeight: 0, flankWeight: 0, hazardWeight: 0, holdGround: 0,
    suicideWeight: 0, ignoresProductivity: true, healWeight: 0, lethalWeight: 1.5,
    dealtTypeWeight: 0, takenTypeWeight: 0
  }),
  support: Object.freeze({
    minChance: 50, fallAversion: 2, futureDiscount: 0.35, counterWeight: 1.5,
    exposureWeight: 1.25, coverWeight: 1, flankWeight: 0.5, hazardWeight: 1.5, holdGround: 0,
    healWeight: 2.5, lethalWeight: 0.75,
    dealtTypeWeight: 0.1, takenTypeWeight: 0.5
  }),
  passive: Object.freeze({
    minChance: 100, fallAversion: 0, futureDiscount: 0, counterWeight: 0,
    exposureWeight: 0, coverWeight: 0, flankWeight: 0, hazardWeight: 0, holdGround: 0,
    healWeight: 0, lethalWeight: 0,
    dealtTypeWeight: 0, takenTypeWeight: 0
  }),
  manual: Object.freeze({
    minChance: 100, fallAversion: 0, futureDiscount: 0, counterWeight: 0,
    exposureWeight: 0, coverWeight: 0, flankWeight: 0, hazardWeight: 0, holdGround: 0,
    healWeight: 0, lethalWeight: 0,
    dealtTypeWeight: 0, takenTypeWeight: 0
  })
});
export const LETHAL_RISK_MIN_CHANCE = 75;
export const SEVERE_FALL_FRACTION = 0.5;
export const FALL_EXPECTED_MULTIPLIER = 0.5;
export const CROSSING_TEMPO_PENALTY = 8;
export const CROSSING_VALUE_MARGIN = 2;
export const ORTHOGONAL_STEPS = Object.freeze([[0, -1], [1, 0], [0, 1], [-1, 0]]);

/* -------------------------------------------- */
/*  Pursuit weights                             */
/* -------------------------------------------- */
export const PURSUIT_HORIZON_SQUARES = 40;
export const PURSUIT_HORIZON_TURNS = 10;
export const PURSUIT_TRANSIT_THREAT = 0.6;
export const PURSUIT_STOP_THREAT = 2;
export const PURSUIT_SPREAD_RADIUS = 3;
export const PURSUIT_SPREAD_PENALTY = 3;
export const PURSUIT_SWITCH_MARGIN_TURNS = 1;
export const PURSUIT_CROSSING_CANDIDATES = 4;
export const PURSUIT_CROSSING_MARGIN = 1;
export const PURSUIT_FALL_COST_SQUARES = 20;
export const PURSUIT_STOP_SLACK = 1;
export const ALLY_ROOM_RADIUS = 3;
export const ALLY_ROOM_PENALTY = 2;
export const ALLY_ROOM_UNMOVED_WEIGHT = 2;
export const PURSUIT_DEFER_MARGIN = 1;

