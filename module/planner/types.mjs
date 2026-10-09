/** @layer planner */
/*
 * The shapes the Enemy AI planner passes between its functions, as JSDoc typedefs that a file names with a
 * comment-only `import('./types.mjs')`, which never runs; the system's own records come from the aliases in
 * foundry/system-bridge.mjs. Squares are counted from the map's top-left corner, and a cell key is the string `"x,y"`.
 */

/** @typedef {import('../foundry/system-bridge.mjs').MeasuredUnit} MeasuredUnit */
/** @typedef {import('../foundry/system-bridge.mjs').TerrainBoard} TerrainBoard */
/** @typedef {import('../foundry/system-bridge.mjs').Matchup} Matchup */
/** @typedef {import('../foundry/system-bridge.mjs').LoadoutWeapon} LoadoutWeapon */
/** @typedef {import('../foundry/system-bridge.mjs').LoadoutItem} LoadoutItem */
/** @typedef {import('../foundry/system-bridge.mjs').MovementGraph} MovementGraph */
/** @typedef {import('../foundry/system-bridge.mjs').MovementCrossing} MovementCrossing */

/* -------------------------------------------- */
/*  Units and the map                           */
/* -------------------------------------------- */

/**
 * One unit as the planner reads it: the system's record for the token, with its actor's Enemy AI flags as `ai`.
 * Frozen, and shared by every reader until something on the map changes.
 * @typedef {MeasuredUnit & {ai: UnitAi}} PlannerUnit
 */

/**
 * A unit's Enemy AI settings, read from its actor's flags by readActorAi in foundry/flags.mjs.
 * @typedef {object} UnitAi
 * @property {string} profile The AI profile the GM chose, such as `'balanced'` or `'manual'`. An unknown value reads
 *   as the default.
 * @property {number} priority Where it acts in the Enemy phase: a higher number goes first.
 * @property {readonly ConditionEntry[]} conditions The GM's conditions, in the order they are listed.
 * @property {boolean} wasAggressed Whether a unit that is not friendly to it has attacked it or used an item on it
 *   since the AI last ended its turn.
 * @property {string} switchedProfile The profile a Switch AI Profile condition switched it to this battle, which
 *   profileOf in planner/profile.mjs plays in place of `profile`, or `''` when it has not been switched.
 * @property {string} markScene The uuid of the Scene where `wasAggressed` or `switchedProfile` was last set, or
 *   `''`. The end of that Scene's battle clears both, even after the unit's token has left the map.
 * @property {string} spawnBehavior The behaviour a terrain spawn gave it, or `''` when it has none or that behaviour
 *   has already been copied into its conditions.
 */

/**
 * A weapon as loadout in planner/loadout.mjs reads it: the system's record plus `losRule`, its item's line-of-sight
 * rule (`'normal'`, `'ignoreHeight'` or `'ignoreLoS'`).
 * @typedef {LoadoutWeapon & {losRule: string}} PlannerWeapon
 */

/**
 * One condition the GM wrote on the Combat AI tab, tested on the unit it is set on. While it holds, the unit takes its
 * behaviour instead of its normal turn; the first entry that holds wins, except a Switch AI Profile entry whose switch
 * is already in effect.
 * @typedef {object} ConditionEntry
 * @property {string} type What it tests, such as `'always'`, `'hpBelow50'` or `'atRound'`.
 * @property {string} behavior What the unit does: `'switchProfile'`, `'retreat'`, `'freeRoam'`, `'pursue'` or
 *   `'seize'`.
 * @property {string|null} profile The profile a `'switchProfile'` entry changes to.
 * @property {number} variable The Max Squares field: the squares a Free Roam or Pursue entry may spend each turn, 0
 *   for the unit's full movement. The planner caps it at the unit's movement that turn.
 * @property {number} num The From Round field: the round an `'atRound'` entry starts holding on.
 */

/**
 * The condition entry that applies to a unit right now, from resolveDirective in planner/conditions.mjs.
 * @typedef {object} Directive
 * @property {string} behavior The entry's behaviour, such as `'pursue'` or `'switchProfile'`.
 * @property {string|null} profile The profile a `'switchProfile'` entry changes to; null for any other behaviour.
 * @property {number|null} budget The squares a Free Roam or Pursue entry may spend, capped by the unit's movement;
 *   null to spend all of it.
 * @property {ConditionEntry} entry The entry itself.
 */

/**
 * What a unit's turn will be, from turnCourse in planner/turn-course.mjs.
 * @typedef {object} TurnCourse
 * @property {string} kind How the turn goes: one of TURN_KINDS in planner/turn-course.mjs.
 * @property {PlannerUnit} unit The unit as the course judged it, with a pending profile switch applied.
 * @property {string|null} switchTo The profile a Switch AI Profile condition switches it to, still to be saved.
 * @property {Directive|null} directive The condition that applies under the profile it plays by, kept for a Manual
 *   unit too, though the GM plays its turn.
 * @property {PlannerUnit|null} tauntor The unit its taunt compels it to go after.
 * @property {Directive|null} fallback A Free Roam or Pursue directive, followed when the turn finds nothing to do.
 * @property {Directive|null} primary A Seize directive, followed before the action.
 */

/**
 * One loadout item as the planner reads it: the system's record, with the item's Enemy AI parameters as `aiData`. A
 * Self item's range is 0 to 0.
 * @typedef {LoadoutItem & {aiData: ItemAi}} PlannerItem
 */

/**
 * An item's Enemy AI parameters, set in its AI Parameters dialog.
 * @typedef {object} ItemAi
 * @property {string} role The item's AI role, `'heal'` or `''`. The AI never uses an item without a role.
 * @property {number} threshold A Heal item is used only on a target below this percentage of its max HP.
 * @property {number} amount The healing the planner expects from it; at 0 it uses the item's average heal instead.
 */

/**
 * One Scene as the planner reads it, from board(planner) in planner/board.mjs. A Scene that can't be read reads as
 * empty, with a `sceneUuid` of `''`.
 * @typedef {object} PlannerBoard
 * @property {string} sceneUuid The Scene read.
 * @property {number} gridSize The grid size in pixels.
 * @property {number} columns The map's width in squares.
 * @property {number} rows The map's height in squares.
 * @property {string} phase One of the system's phase names (`encounters.phases`), or `''` when no phase is set.
 * @property {number|null} round The current round, or null when the Scene can't be read.
 * @property {boolean} encounterActive Whether a started Combat is bound to the Scene.
 * @property {boolean} exploration Whether the Scene is in exploration mode.
 * @property {boolean} classicFlyers Whether the world uses Classic flyer targeting.
 * @property {boolean} flightForbidden Whether the Scene's movement permission forbids flight.
 * @property {TerrainBoard|Pick<TerrainBoard, 'hasTerrain'|'defendPoints'|'travelBoundedByDistance'>} terrain The
 *   map's terrain. A Scene the system reports no terrain for gets no terrain, no Defend points and travel bounded by
 *   distance.
 * @property {readonly PlannerUnit[]} units Every token with an actor.
 * @property {Map<string, PlannerUnit>} byTokenUuid The units by token uuid.
 * @property {Map<string, PlannerUnit>} byTokenId The units by token id.
 */

/**
 * A square a unit could stand on, as positionalValue in planner/scoring.mjs values it.
 * @typedef {object} StandingSquare
 * @property {number} cover The terrain evasion, defense and resistance there.
 * @property {number} hazard The HP the square's hazard adds or takes when the next phase opens.
 * @property {number} exposure How many hostiles could strike the square.
 * @property {boolean} flank Whether the unit flanks its target from there.
 * @property {number} moveCost The movement spent reaching it.
 */

/* -------------------------------------------- */
/*  Profiles and movement                       */
/* -------------------------------------------- */

/**
 * The weights one AI profile plans with, from RISK_PROFILES in tuning.mjs. A weight of 0 ignores that concern.
 * @typedef {object} RiskProfile
 * @property {number} minChance The lowest success chance, in percent, of a climb or drop it will try.
 * @property {number} fallAversion How much the expected fall damage of a failed drop counts against it.
 * @property {number} futureDiscount The share of next turn's best attack a crossing is worth now.
 * @property {number} counterWeight How much a counterattack's damage, and crossing threatened squares, count against
 *   a plan.
 * @property {number} exposureWeight How much each hostile that could strike the square counts against it.
 * @property {number} coverWeight How much the square's terrain evasion, defense and resistance count for it.
 * @property {number} flankWeight How much flanking the target counts for it.
 * @property {number} hazardWeight How much the HP the square's hazard adds or takes counts.
 * @property {number} holdGround How much each square walked counts against a plan.
 * @property {number} healWeight How much a heal is worth. At 0 the unit never plans a heal, but it still uses a
 *   bonus-action self-heal when it is hurt enough.
 * @property {number} lethalWeight How much the chance to kill counts for an attack.
 * @property {number} dealtTypeWeight How much the attack's damage type landing on a weakness or a resistance changes
 *   its worth.
 * @property {number} takenTypeWeight How much the counter's damage type landing on a weakness or a resistance changes
 *   its cost.
 * @property {number} [suicideWeight] How much an attack the unit is expected not to survive counts against it; 1
 *   when left out.
 * @property {boolean} [ignoresProductivity] Whether an attack is worth taking however little damage it deals.
 */

/**
 * What one Pursue or Seize plan routes with, from routeContext in planner/routing.mjs, passed whole to the routing
 * tools there. The threat map and the movement search are cached until the map changes and shared, so don't modify
 * them.
 * @typedef {object} RouteContext
 * @property {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @property {PlannerUnit} unit The unit moving.
 * @property {RiskProfile} risk The weights it plans with; `counterWeight` prices the threat.
 * @property {Map<string, number>} threat How many hostiles could strike each square, by cell key.
 * @property {Iterable<PlannerUnit>|null} ignoreUnits Units every search of the plan treats as absent: the units on
 *   the Defense Points for Seize, none for Pursue.
 * @property {MovementGraph|null} field The movement search from the square the unit stands on, with threatened squares
 *   charged extra to cross; null when the system can't measure the unit.
 * @property {number|null} budget The most movement it may spend this turn; null for all it has.
 */

/**
 * What one unit's action is planned with, built once by planTurnSteps in planner/planning.mjs and passed whole to its
 * attack, heal and approach planning.
 * @typedef {object} ActionSearch
 * @property {import('./scene.mjs').ScenePlanner} planner The Scene's planner.
 * @property {PlannerUnit} unit The unit planning its action.
 * @property {RiskProfile} risk The weights it plans with.
 * @property {MovementGraph} graph The movement search its squares come from.
 * @property {Map<string, object>} squares Every square it can reach, by cell key, occupied ones included, with the
 *   ground, exposure and cost each is priced by. Each one's `free` says whether the unit can end its move there.
 * @property {{x: number, y: number}} start The square it stands on.
 */

/**
 * Where a chase heads: a square, and the unit it chases there, if any.
 * @typedef {object} ChaseGoal
 * @property {number} x The square's column.
 * @property {number} y The square's row.
 * @property {PlannerUnit|null} [target] The unit chased, or null for a Defense Point or a blocker.
 */

/**
 * Where a Pursue or Seize unit stops this turn on the way to a goal, from routeStop in planner/routing.mjs.
 * @typedef {object} RouteStop
 * @property {number} x The stop's column.
 * @property {number} y The stop's row.
 * @property {number} travel The movement spent reaching it.
 * @property {number} value What the stop costs in threat and crowding; lower is better.
 * @property {number} remaining The route cost still left from it to the goal.
 * @property {Array<[number, number]>} path The squares walked, as `[x, y]`, not counting the one the unit stands on.
 */

/* -------------------------------------------- */
/*  Plans                                       */
/* -------------------------------------------- */

/**
 * What a planner function decides a unit does, which driver/turn.mjs carries out. `kind` tells the shapes apart; a
 * Retreat or Free Roam walk has none.
 * @typedef {AttackPlan|AbilityPlan|ApproachPlan|MovePlan|CrossingPlan|HoldPlan|WalkPlan} Plan
 */

/**
 * What planTurn in planner/planning.mjs decides a unit does with its action: attack, heal or close in.
 * @typedef {AttackPlan|AbilityPlan|ApproachPlan} TurnPlan
 */

/**
 * How one attack was valued by score in planner/scoring.mjs. Only `total` weighs damage types.
 * @typedef {object} AttackScore
 * @property {number} total The attack's worth, the number plans are compared by.
 * @property {number} expectedDamage The damage the attack is expected to deal.
 * @property {number} expectedTaken The counter damage the unit is expected to take.
 * @property {number} dealtFraction The expected damage as a share of the target's max HP.
 * @property {number} takenFraction The expected counter damage as a share of the unit's max HP.
 * @property {number} hitChance The hit chance, in percent.
 * @property {number} killChance The chance, from 0 to 1, that the exchange kills the target.
 * @property {number} counterChance The chance, from 0 to 1, that the target lives to counter.
 * @property {boolean} unanswered Whether the target can't counter at all.
 * @property {boolean} suicidal Whether the unit is expected not to survive the counter.
 * @property {number} positional What the square adds or takes away.
 * @property {boolean} breaksTarget Whether the hits, if all land, break the target's stance.
 * @property {number} breakProgress How far, from 0 to 1, the expected hits wear down the target's stance.
 * @property {boolean} blocking Whether the target is a unit a Seize unit is clearing from its route.
 * @property {boolean} compelled Whether the unit is taunted.
 * @property {boolean} productive Whether the attack is worth making at all.
 * @property {number} appeal The share of the target's worth its faction keeps.
 */

/**
 * The square a plan's unit attacks or heals from, as it was valued.
 * @typedef {object} PlanPosition
 * @property {number} cover The terrain evasion, defense and resistance there.
 * @property {number} hazard The HP the square's hazard adds or takes when the next phase opens.
 * @property {number} exposure How many hostiles, the target aside, could strike the square from where they stand.
 * @property {boolean} flank Whether the unit flanks its target from there.
 * @property {boolean} [flanked] Whether the unit is flanked there.
 */

/**
 * Attack a target with a weapon, after moving to `destination` if `needsMove`. A breach plan from planBreachStrike
 * in planner/seize.mjs strikes a wall in a Seize unit's way and has no `score` or `position`.
 * @typedef {object} AttackPlan
 * @property {'attack'} kind
 * @property {PlannerUnit} unit The unit acting.
 * @property {PlannerUnit} target The unit struck.
 * @property {PlannerWeapon} weapon The weapon used.
 * @property {number} distance The distance it strikes from, in squares.
 * @property {{x: number, y: number}} destination The square it strikes from.
 * @property {boolean} needsMove Whether that square is not the one it stands on.
 * @property {number} moveCost The movement it spends getting there.
 * @property {AttackScore} [score] How the attack was valued.
 * @property {Matchup} matchup The system's forecast of the exchange.
 * @property {PlanPosition} [position] The square as it was valued.
 * @property {MovementGraph} graph The movement graph the destination came from.
 * @property {boolean} [breach] Whether it strikes a wall blocking a Seize unit.
 * @property {number} [breachScore] A breach's worth, compared with the unit's best ordinary plan.
 * @property {string} [dmgType] The damage type a breach deals.
 */

/**
 * Use a Heal item on a friendly unit, after moving to `destination` if `needsMove`.
 * @typedef {object} AbilityPlan
 * @property {'ability'} kind
 * @property {PlannerUnit} unit The unit acting.
 * @property {PlannerUnit} target The unit healed, which may be the acting unit.
 * @property {PlannerItem} item The item used.
 * @property {number} distance The distance it heals from, in squares.
 * @property {{x: number, y: number}} destination The square it heals from.
 * @property {boolean} needsMove Whether that square is not the one it stands on.
 * @property {number} moveCost The movement it spends getting there.
 * @property {{total: number, heal: number}} score The heal's worth with its square, and without it.
 * @property {PlanPosition} position The square as it was valued.
 * @property {MovementGraph} graph The movement graph the destination came from.
 */

/**
 * Close on a target whose attack squares are all taken, without attacking.
 * @typedef {object} ApproachPlan
 * @property {'approach'} kind
 * @property {PlannerUnit} unit The unit acting.
 * @property {PlannerUnit} target The unit it closes on.
 * @property {null} weapon
 * @property {number} distance The distance from the destination to the target, in squares.
 * @property {{x: number, y: number}} destination The square it moves to.
 * @property {true} needsMove
 * @property {number} moveCost The movement it spends.
 * @property {null} score
 * @property {MovementGraph} graph The movement graph the destination came from.
 */

/**
 * Walk toward a target or a Defense Point, as Pursue or Seize plans it.
 * @typedef {object} MovePlan
 * @property {'move'} kind
 * @property {{x: number, y: number}} destination The square it stops on this turn.
 * @property {MovementGraph} graph The movement graph the route comes from.
 * @property {Array<[number, number]>} [path] The squares walked, as `[x, y]`, not counting the one it stands on.
 * @property {number} [remaining] The route cost still left to the goal from the destination.
 * @property {PlannerUnit} [target] The unit it is chasing.
 * @property {boolean} [capture] Whether the destination is a Defense Point.
 * @property {PlannerUnit} [blocker] The unit or wall a Seize unit has chosen to clear from its route.
 * @property {number} [unlock] How much clearing that blocker shortens the route, from 0 to 1 of a turn's advance.
 */

/**
 * Climb or drop between floors, after moving to the start of the crossing if `needsMove`. planCrossing and planPursue
 * each add their own measure of worth.
 * @typedef {object} CrossingPlan
 * @property {'crossing'} kind
 * @property {string} skill The skill the climb or drop is rolled with.
 * @property {number} chance The success chance, in percent.
 * @property {MovementCrossing} crossing The climb or drop, as the system reports it; `crossing.to` is the landing
 *   square.
 * @property {{x: number, y: number}} origin The square the crossing starts from.
 * @property {boolean} needsMove Whether the crossing starts away from the square the unit stands on.
 * @property {MovementGraph} graph The movement graph the start square came from.
 * @property {PlannerUnit} [target] The unit a chase is heading for.
 * @property {number} [value] From planCrossing, what the crossing is worth against what the turn otherwise offers.
 * @property {number} [futureValue] From planCrossing, what the unit could do from the landing square.
 * @property {number} [moveCost] From planCrossing, the movement it spends to reach the start square.
 * @property {number} [total] From planPursue, the route cost to the target through the crossing.
 */

/**
 * Stay put this turn. From planSeize, when the unit already stands on a Defense Point or in reach of its blocker, or
 * can get no nearer.
 * @typedef {object} HoldPlan
 * @property {'hold'} kind
 * @property {boolean} [capture] Whether the unit stands on a Defense Point.
 * @property {number} [remaining] The route cost still left to the goal.
 * @property {PlannerUnit} [blocker] The unit or wall a Seize unit has chosen to clear from its route.
 * @property {number} [unlock] How much clearing that blocker shortens the route, from 0 to 1 of a turn's advance.
 */

/**
 * Walk to a square for a Retreat or Free Roam (planner/movement.mjs).
 * @typedef {object} WalkPlan
 * @property {{x: number, y: number}} destination The square it walks to.
 * @property {MovementGraph} graph The movement graph the destination came from.
 */

export {};
