/** @layer ui */
/*
 * The Enemy AI switch and the movement badges in the system's combat tracker, for the GM and Assistant GMs, and what a
 * press of the switch does. Both are added again on every render of the tracker.
 */
import { CombatAI } from '../combat-ai.mjs';
import { LOG } from '../constants.mjs';
import { cycleMode, isEnabled, modeOf } from '../driver/mode.mjs';
import { AI_STOP_NOTICE, isRunning, requestAbort } from '../driver/state.mjs';
import { sceneUuidOfToken } from '../foundry/documents.mjs';
import {
  encounterState,
  isAiFaction,
  isCommandHost,
  processingView,
  requestSegmentStop,
  spawnBehaviorLabel,
  standDownNotice,
  systemIntegrated,
  systemPhases,
  systemProcessingControl,
  systemResultCodes
} from '../foundry/system-bridge.mjs';
import { unitByTokenId } from '../planner/board.mjs';
import { turnCourse } from '../planner/turn-course.mjs';
import { reportMissingAnchor } from './control-panel.mjs';

/* -------------------------------------------- */
/*  Constants                                   */
/* -------------------------------------------- */
const TOGGLE_ACTION = 'enemyAiToggle';
const TOGGLE_LABEL = 'Enemy AI';
const MODE_ICONS = Object.freeze({ off: 'fa-toggle-off', on: 'fa-toggle-on', locked: 'fa-lock' });
const BADGE_SELECTOR = '.ect-unit-icon.ect-behavior';
/** The tooltip on the tracker's Enemy AI switch, by mode. */
export const COMBAT_AI_TOOLTIPS = Object.freeze({
  off: 'Not playing enemy phases',
  on: 'Plays the next enemy phase, then switches itself off '
    + 'when the player phase begins',
  locked: 'Plays every enemy phase until switched off'
});

/* -------------------------------------------- */
/*  Builders                                    */
/* -------------------------------------------- */
/**
 * The Enemy AI switch's state for one encounter: the mode, the flags that pick its styling (`pressed` for any mode but
 * Off), and its tooltip. While the module is switched off, the switch shows Off and is `disabled`, and its tooltip
 * says what to update.
 */
function trackerControlContext(combat) {
  if (!systemIntegrated()) {
    return { mode: 'off', on: false, locked: false, pressed: false, disabled: true, tooltip: standDownNotice() };
  }
  const mode = modeOf(combat);
  return {
    mode,
    on: mode === 'on',
    locked: mode === 'locked',
    pressed: mode !== 'off',
    disabled: false,
    tooltip: COMBAT_AI_TOOLTIPS[mode]
  };
}

/**
 * The movement badge a unit's condition earns on its roster row, or null when it earns none. The condition comes from
 * `turnCourse`, as the unit's turn reads it, so a Switch AI Profile condition not yet saved is already applied.
 */
function unitBehaviorBadge(unit) {
  if (!unit || !isAiFaction(unit.factionRole)) return null;
  const planner = CombatAI.forScene(sceneUuidOfToken(unit.tokenUuid));
  const behavior = turnCourse(planner, unit, { ignoreTurnState: true }).directive?.behavior ?? '';
  const label = spawnBehaviorLabel(behavior);
  return label ? { behavior, label } : null;
}

/* -------------------------------------------- */
/*  Injection                                   */
/* -------------------------------------------- */
/**
 * Put the Enemy AI switch and the behaviour badges into a rendered tracker on every render, for GMs only, removing its
 * own earlier ones first. While the module is switched off it draws only the switch, since the badges need the planner.
 */
export function injectTrackerControls(app, element) {
  const root = element ?? app?.element ?? null;
  if (!root?.querySelector || !game.user.isGM) return;
  injectAiSwitch(app, root);
  if (systemIntegrated()) injectBehaviorBadges(root, String(app.viewed?.scene?.uuid ?? ''));
}

function injectAiSwitch(app, root) {
  const toggles = root.querySelector('.ect-toggles');
  const row = toggles?.querySelector('.ect-toggle-row');
  if (!toggles || !row) {
    if (sceneHasCombat()) reportMissingAnchor(toggles ? '.ect-toggle-row' : '.ect-toggles', 'Combat Tracker');
    return;
  }
  toggles.querySelector(`[data-action="${TOGGLE_ACTION}"]`)?.remove();
  const context = trackerControlContext(app.viewed ?? null);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = switchClasses(context);
  button.dataset.action = TOGGLE_ACTION;
  button.disabled = context.disabled;
  button.setAttribute('aria-pressed', String(context.pressed));
  button.setAttribute('data-tooltip', context.tooltip);
  const icon = document.createElement('i');
  icon.className = `fa-solid ${MODE_ICONS[context.mode]}`;
  icon.setAttribute('inert', '');
  const label = document.createElement('span');
  label.textContent = TOGGLE_LABEL;
  button.append(icon, label);
  if (!context.disabled) {
    const control = systemProcessingControl();
    button.setAttribute(control.ATTRIBUTE, control.SEGMENT_STOP);
    button.addEventListener('click', event => {
      pressSwitch(event, app).catch(error => console.error(`${LOG} the Enemy AI switch failed.`, error));
    });
  }
  row.insertAdjacentElement('afterend', button);
}

function switchClasses(context) {
  const classes = ['ect-btn', 'ect-btn-toggle', 'ect-btn-wide', 'ect-btn-ai'];
  if (context.on) classes.push('is-on');
  if (context.locked) classes.push('is-locked');
  return classes.join(' ');
}

/**
 * Add the movement-behaviour badge to every roster row that carries one. A row missing its icons container means the
 * Combat Tracker template's markup moved, so the first miss in a pass is reported once rather than once per row.
 */
function injectBehaviorBadges(root, sceneUuid) {
  let reported = false;
  for (const row of root.querySelectorAll('.ect-unit[data-token-id]')) {
    const icons = row.querySelector('.ect-unit-icons');
    if (!icons) {
      if (!reported) {
        reportMissingAnchor('.ect-unit-icons', 'Combat Tracker');
        reported = true;
      }
      continue;
    }
    icons.querySelector(BADGE_SELECTOR)?.remove();
    const badge = unitBehaviorBadge(unitByTokenId(row.dataset.tokenId, sceneUuid));
    if (!badge) continue;
    const icon = document.createElement('i');
    icon.className = `ect-unit-icon ect-behavior ect-behavior-${badge.behavior} fa-solid fa-shoe-prints`;
    icon.setAttribute('data-tooltip', badge.label);
    icons.prepend(icon);
  }
}

/**
 * Whether the Scene the system's tracker shows (the canvas Scene, else the active Scene) has a Combat; the tracker
 * leaves out the switch's anchor when there is none, so only then is a missing anchor not reported. The switch itself
 * reads `app.viewed`, Foundry's selected Combat, which is normally the same encounter.
 */
function sceneHasCombat() {
  const scene = canvas.scene ?? game.scenes.active ?? null;
  if (!scene) return false;
  return game.combats.some(combat => combat.scene?.id === scene.id);
}

/* -------------------------------------------- */
/*  Switch presses                              */
/* -------------------------------------------- */
/**
 * One press of the switch: while the AI plays an Enemy Phase, even during a Manual unit's turn, it stops the AI after
 * its current action, and otherwise it steps the mode on. The host client stops its own run even while that run waits
 * to open its execution segment behind another command.
 */
async function pressSwitch(event, app) {
  event.preventDefault();
  if (!game.user.isGM) return;
  if (isRunning()) {
    requestAbort();
    return;
  }
  const owner = processingView()?.owner ?? null;
  if (owner) return stopDuringProcessing(owner);
  const combat = app.viewed ?? null;
  if (!combat) return;
  if (mayAwaitManualTurn(combat) && await stopPausedRun()) return;
  await cycleMode(combat);
}

/**
 * Stop the AI from a GM's client that is not running it, while the system is busy: ask the host client to stop the AI's
 * execution segment, or, while another command runs, say the mode can't change yet.
 */
async function stopDuringProcessing(owner) {
  if (owner.segment !== true) {
    ui.notifications.warn('The Enemy AI mode can change once the current action finishes.');
    return;
  }
  const result = await askHostToStop();
  if (result?.ok !== true) warnStopRefused(result);
}

/**
 * Whether the host client may be running the AI for this encounter while it waits on a Manual unit's turn, during which
 * the run gives up its execution segment and the system shows nothing busy: this is another GM's client, the AI is on,
 * and the encounter is in its Enemy phase.
 */
function mayAwaitManualTurn(combat) {
  if (isCommandHost() || !isEnabled(combat)) return false;
  return encounterState(String(combat.scene?.uuid ?? ''))?.phase === systemPhases().ENEMY;
}

/**
 * Ask the host client to stop a run that waits on a Manual unit's turn. Returns false only when the host client has no
 * run to stop or no host client is connected, and the press then steps the mode instead. Any other refusal, such as a
 * reply that did not come in time, is reported and leaves the mode alone, since the run may still be going.
 */
async function stopPausedRun() {
  const result = await askHostToStop();
  if (result?.ok === true) return true;
  if (hostHasNoRun(result)) return false;
  warnStopRefused(result);
  return true;
}

/** Ask the host client to stop the AI after its current action, and tell this GM when the host client agrees. */
async function askHostToStop() {
  const result = await requestSegmentStop();
  if (result?.ok === true) ui.notifications.info(AI_STOP_NOTICE);
  return result;
}

/** Tell this GM that the host client did not take a stop request, and why. */
function warnStopRefused(result) {
  console.warn(`${LOG} the stop request was refused with code ${result?.code ?? 'unknown'}.`);
  ui.notifications.warn(`Enemy AI could not be asked to stop: ${stopRefusalReason(result?.code)}.`);
}

/** Whether a refused stop request means nothing is running: no execution segment is open, or no host is connected. */
function hostHasNoRun(result) {
  const codes = systemResultCodes();
  return result?.code === codes.COMMAND_SEGMENT_NOT_OPEN || result?.code === codes.NO_ACTIVE_GM;
}

/** Why the host would not take a stop request, in words a GM can act on. */
function stopRefusalReason(code) {
  const codes = systemResultCodes();
  if (code === codes.GM_REQUIRED) return 'only a GM or Assistant GM may stop it';
  if (code === codes.COMMAND_SEGMENT_NOT_OPEN) return 'it is not running right now';
  if (code === codes.NO_ACTIVE_GM) return 'no host client is connected';
  if (code === codes.COMMAND_OUTCOME_UNKNOWN) return 'the host client did not answer in time';
  return 'the system refused the request';
}
