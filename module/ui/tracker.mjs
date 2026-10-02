/** @layer ui */
import {
  AI_BEHAVIOR_LABELS,
  AI_MODES,
  AI_PROFILE_FACTIONS,
  COMBAT_AI_TOOLTIPS,
  MODULE_ID,
  PROCESSING_CONTROL
} from '../constants.mjs';
import { isRunning, requestAbort } from '../driver/state.mjs';
import { readCombatMode, sceneUuidOfToken, writeCombatMode } from '../foundry/flags.mjs';
import { processingView, requestSegmentStop, systemResultCodes } from '../foundry/system-bridge.mjs';
import { aiConditionContext, unitByTokenId } from '../planner/board.mjs';
import { resolveDirective } from '../planner/conditions.mjs';
import { directiveFacts } from '../planner/profile.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
const TOGGLE_ACTION = 'enemyAiToggle';
const TOGGLE_LABEL = 'Enemy AI';
const MODE_ICONS = Object.freeze({ off: 'fa-toggle-off', on: 'fa-toggle-on', locked: 'fa-lock' });
const BADGE_SELECTOR = '.ect-unit-icon.ect-behavior';

/* -------------------------------------------- */
/*  Builders                                    */
/* -------------------------------------------- */
/** The Enemy AI switch's state for one encounter: the mode, the flags that pick its styling, and its tooltip. */
function trackerControlContext(combat) {
  const mode = readCombatMode(combat);
  return {
    mode,
    on: mode === 'on',
    locked: mode === 'locked',
    enabled: mode !== 'off',
    tooltip: COMBAT_AI_TOOLTIPS[mode]
  };
}

/** The mode one press moves to: off, on for the next enemy phase, then locked on, then off again. */
function nextTrackerMode(mode) {
  return AI_MODES[(AI_MODES.indexOf(mode) + 1) % AI_MODES.length];
}

/** The movement badge a unit's authored directive earns on its roster row, or null when it earns none. */
function unitBehaviorBadge(unit) {
  if (!unit || !AI_PROFILE_FACTIONS.includes(unit.factionRole)) return null;
  const context = aiConditionContext(sceneUuidOfToken(unit.tokenUuid));
  const behavior = resolveDirective(directiveFacts(unit), context)?.behavior ?? '';
  const label = AI_BEHAVIOR_LABELS[behavior];
  return label ? { behavior, label } : null;
}

/* -------------------------------------------- */
/*  Injection                                   */
/* -------------------------------------------- */
/**
 * Put the Enemy AI switch and the behaviour badges into a rendered tracker, for GMs only. It runs on every render
 * and removes its own earlier switch and badges first.
 */
export function injectTrackerControls(app, element) {
  const root = element ?? app?.element ?? null;
  if (!root?.querySelector || !game.user.isGM) return;
  injectAiSwitch(app, root);
  injectBehaviorBadges(root, String(app.viewed?.scene?.uuid ?? ''));
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
  button.setAttribute(PROCESSING_CONTROL.ATTRIBUTE, PROCESSING_CONTROL.SEGMENT_STOP);
  button.setAttribute('aria-pressed', String(context.enabled));
  button.setAttribute('data-tooltip', context.tooltip);
  const icon = document.createElement('i');
  icon.className = `fa-solid ${MODE_ICONS[context.mode]}`;
  icon.setAttribute('inert', '');
  const label = document.createElement('span');
  label.textContent = TOGGLE_LABEL;
  button.append(icon, label);
  button.addEventListener('click', event => {
    pressSwitch(event, app).catch(error => console.error(`${MODULE_ID} | the Enemy AI switch failed.`, error));
  });
  row.insertAdjacentElement('afterend', button);
}

function switchClasses(context) {
  const classes = ['ect-btn', 'ect-btn-toggle', 'ect-btn-wide', 'ect-btn-ai'];
  if (context.on) classes.push('is-on');
  if (context.locked) classes.push('is-locked');
  return classes.join(' ');
}

/**
 * One press of the switch. While the system is busy running commands the flag can't be changed, so a press asks the
 * host to stop the AI after its current action. Otherwise it steps the mode on.
 */
async function pressSwitch(event, app) {
  event.preventDefault();
  if (!game.user.isGM) return;
  const owner = processingView()?.owner ?? null;
  if (owner) return stopDuringProcessing(owner);
  const combat = app.viewed ?? null;
  if (!combat) return;
  await writeCombatMode(combat, nextTrackerMode(readCombatMode(combat)));
}

/** Ask the host to stop a running segment, and tell this user what became of the request. */
async function stopDuringProcessing(owner) {
  const notify = ui.notifications;
  if (owner.segment !== true && !isRunning()) {
    notify.warn('The Enemy AI mode can change once the current action finishes.');
    return;
  }
  const result = await requestSegmentStop();
  if (result?.ok !== true) {
    notify.warn(`Enemy AI could not be asked to stop: ${stopRefusalReason(result?.code)}.`);
    return;
  }
  if (isRunning()) requestAbort();
  else notify.info('Enemy AI will stop after its current action.');
}

/** Why the host would not take a stop request, in words a GM can act on. */
function stopRefusalReason(code) {
  const codes = systemResultCodes();
  if (code === codes.GM_REQUIRED) return 'only a GM or Assistant GM may stop it';
  if (code === codes.COMMAND_SEGMENT_NOT_OPEN) return 'it is not holding the table';
  if (code === codes.COMMAND_OUTCOME_UNKNOWN) return 'the command host did not answer in time';
  return `the system refused (${code ?? 'unknown'})`;
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

/** Log that an expected anchor is missing from the system's own template. The caller goes on without it. */
function reportMissingAnchor(selector, template) {
  console.error(`${MODULE_ID} | could not find "${selector}" in the system's ${template} template.`);
}

/**
 * Whether the Scene the system's tracker shows (the canvas Scene, else the active Scene) has a Combat. The tracker
 * leaves the switch's anchor out when there is no encounter, so a missing anchor is only reported when a Combat
 * exists. The switch itself reads `app.viewed`, Foundry's selected Combat, which is normally the same encounter.
 */
function sceneHasCombat() {
  const scene = canvas.scene ?? game.scenes.active ?? null;
  if (!scene) return false;
  return game.combats.some(combat => combat.scene?.id === scene.id);
}
