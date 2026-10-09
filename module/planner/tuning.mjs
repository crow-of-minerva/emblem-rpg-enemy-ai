/** @layer planner */
/*
 * The numbers that balance how the AI plays: what each outcome is worth in the planner's score, each profile's
 * weights, and how zone crossings and pursuits are priced. Only planner/ reads them.
 */

/* -------------------------------------------- */
/*  Targets and wounds                          */
/* -------------------------------------------- */
/** What is left of a target's worth when its faction is in AI_LESSER_TARGET_FACTIONS (constants.mjs). */
export const AI_LESSER_TARGET_APPEAL = 0.5;
/** Below this fraction of max HP a unit counts as critically wounded for heal prioritisation. */
export const AI_CRITICAL_FRACTION = 0.25;
/** Wit above which a unit sees through illusions. */
export const LURE_WIT_THRESHOLD = 10;

/* -------------------------------------------- */
/*  Scoring weights                             */
/* -------------------------------------------- */
/** The score currency: one point is roughly one percent of the relevant unit's maximum health. */
export const SCORE_SCALE = 100;
/** Points added to a heal on a critically wounded ally. */
export const CRITICAL_HEAL_BONUS = 25;
/** A certain kill's worth, in multiples of the target's max HP, scaled by kill chance and the profile. */
export const LETHAL_BONUS = 10;
/** The extra share of a blow's worth when the target can't counter. */
export const UNANSWERED_FACTOR = 0.25;
/** The cost of an attack whose expected counter would kill the attacker, in multiples of its max HP. */
export const SUICIDE_PENALTY = 5;
/** Expected HP damage below which an attack isn't worth making. */
export const MIN_MEANINGFUL_DAMAGE = 0.5;
/** Scores closer than this count as a tie. */
export const SCORE_EPSILON = 0.001;
/** A stance break's worth, as a share of the target's max HP. */
export const BREAK_BONUS = 0.35;
/** The worth of wearing a stance down short of breaking it, as a share of max HP at full progress. */
export const BREAK_PROGRESS_WEIGHT = 0.15;
/** How much more or less a wall breach is worth when the wall is vulnerable to, or resists, the damage type. */
export const BREACH_VULNERABLE_BIAS = 1.2;
export const BREACH_PROTECTED_BIAS = 0.5;
/** Points for attacking whatever blocks a Seize unit's route, at full value when removing it opens the route. */
export const SEIZE_BLOCKER_BONUS = 60;
/** Turns of movement a removed blocker must save to count at full value. */
export const SEIZE_UNLOCK_TURNS = 3;
/** Points for a turn's attacks that would break a blocking wall outright, less for partial damage. */
export const SEIZE_BREACH_PROGRESS = 40;
/** Turns a Seize unit expects to spend removing a blocking unit. */
export const SEIZE_BLOCKADE_TURN_COST = 2;
/** The kill chance, or share of the target's max HP dealt, that makes an attack worth a Seize unit pausing for. */
export const SEIZE_DETOUR_KILL_CHANCE = 0.5;
export const SEIZE_DETOUR_DAMAGE_FRACTION = 0.25;
/** What an on-hit debuff adds to a unit's break damage when ordering the phase. */
export const DEBUFF_SETUP_VALUE = 2;
/** Points lost for each hostile whose weapon covers the square, scaled by the profile. */
export const POSITION_EXPOSURE_PENALTY = 4;
/** Points gained for each point of terrain evasion, defense and resistance on the square, scaled by the profile. */
export const POSITION_COVER_UNIT = 0.75;
/** Points gained for flanking the target, scaled by the profile. */
export const POSITION_FLANK_BONUS = 8;
/** Points lost for each square of movement spent, scaled by the profile's wish to hold its ground. */
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

/* -------------------------------------------- */
/*  Zone crossings and falls                    */
/* -------------------------------------------- */
/**
 * The success chance, in percent, a drop with a severe fall needs before the AI tries it (`crossingRisk` in
 * `planner/movement.mjs`).
 */
export const LETHAL_RISK_MIN_CHANCE = 75;
/** A fall is severe when its worst damage would kill the unit or is at least this share of its max HP. */
export const SEVERE_FALL_FRACTION = 0.5;
/** The share of a failed drop's worst fall damage the AI expects to take, on average. */
export const FALL_EXPECTED_MULTIPLIER = 0.5;
/** Points a zone crossing loses for spending the turn on the climb or drop (`planCrossing`). */
export const CROSSING_TEMPO_PENALTY = 8;
/** Points by which a zone crossing must beat the turn's best other option before the AI takes it (`planCrossing`). */
export const CROSSING_VALUE_MARGIN = 2;

/* -------------------------------------------- */
/*  Pursue and Seize routing weights            */
/* -------------------------------------------- */
/**
 * How far Pursue, Seize and the approach to a blocked target search: a movement cost of the larger of 40 squares and
 * ten turns of movement. A goal beyond it is treated as unreachable.
 */
export const PURSUIT_HORIZON_SQUARES = 40;
export const PURSUIT_HORIZON_TURNS = 10;
/**
 * Extra route cost, in squares, of entering a square for each hostile that can strike it, times the profile's
 * counterWeight (`threatPenalties` in `planner/routing.mjs`).
 */
export const PURSUIT_TRANSIT_THREAT = 0.6;
/**
 * The cost of stopping on a square for each hostile that can strike it, times the profile's counterWeight, when
 * Pursue or Seize picks where to stop this turn (`routeStop` in `planner/routing.mjs`).
 */
export const PURSUIT_STOP_THREAT = 2;
/** Squares within which a pursuer is charged PURSUIT_SPREAD_PENALTY for crowding an ally chasing the same target. */
export const PURSUIT_SPREAD_RADIUS = 3;
/**
 * The most a square costs, in squares of route, for crowding an ally chasing the same target. The cost falls off to
 * nothing at PURSUIT_SPREAD_RADIUS.
 */
export const PURSUIT_SPREAD_PENALTY = 3;
/** Turns of movement by which another target must be nearer before a pursuer gives up the one it is chasing. */
export const PURSUIT_SWITCH_MARGIN_TURNS = 1;
/** How many climbs and drops a pursuer prices in full: the ones that land nearest its target. */
export const PURSUIT_CROSSING_CANDIDATES = 4;
/** Squares by which a climb or drop must beat the walking route before a pursuer takes it. */
export const PURSUIT_CROSSING_MARGIN = 1;
/** What a fall of the unit's whole max HP counts as, in squares of route, when a pursuer prices a drop. */
export const PURSUIT_FALL_COST_SQUARES = 20;
/** Squares a stop may fall short of the best progress this turn and still be weighed for threat and crowding. */
export const PURSUIT_STOP_SLACK = 1;
/** Squares within which a stop is charged ALLY_ROOM_PENALTY for crowding a friendly unit. */
export const ALLY_ROOM_RADIUS = 3;
/** The most a stop costs for crowding a friendly unit. The cost falls off to nothing at ALLY_ROOM_RADIUS. */
export const ALLY_ROOM_PENALTY = 2;
/** How many times more an ally that has not taken its turn yet counts toward ALLY_ROOM_PENALTY. */
export const ALLY_ROOM_UNMOVED_WEIGHT = 2;
/**
 * Squares nearer its goal a Seize or Pursue unit must end up by waiting for a pending ally to move before it stands
 * aside (`yieldsToPendingAlly` in `planner/phase-roster.mjs`).
 */
export const PURSUIT_DEFER_MARGIN = 1;
