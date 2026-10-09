/** @layer ui */
/*
 * The Combat AI tab in the system's Actor Control Panel, for the GM and Assistant GMs: the unit's AI profile, priority
 * and conditions, saved to the Actor's flags as they change. The tab is added again on every render of the panel.
 */
import {
  AI_MANUAL_PROFILE,
  AI_PRIORITY_DEFAULT,
  AI_PROFILES,
  AI_PROFILE_DESCRIPTIONS,
  LOG,
  MODULE_ID
} from '../constants.mjs';
import { defaultConditionEntry, sanitizeConditionEntry } from '../condition-entries.mjs';
import { sceneUuidOfActor } from '../foundry/documents.mjs';
import { adoptSpawnBehavior, readActorAi, writeActorAi } from '../foundry/flags.mjs';
import {
  isAiFaction,
  isCommandHost,
  standDownNotice,
  systemAiFactions,
  systemIntegrated,
  unitBoard
} from '../foundry/system-bridge.mjs';
import {
  clampVariable,
  conditionRow,
  loadConditionRowPartial,
  shiftCollapsed,
  syncConditionRow,
  toggleConditionRow
} from './condition-rows.mjs';

/* -------------------------------------------- */
/*  Constants                                   */
/* -------------------------------------------- */
const TEMPLATE = `modules/${MODULE_ID}/templates/control-panel-ai.hbs`;
/** The AI tab's id among the Actor Control Panel's tabs, which each carry theirs as `data-tray`. */
const TRAY = 'ai';
/** The fields of one condition row, read back into a condition entry. */
const CONDITION_FIELDS = Object.freeze(['type', 'behavior', 'profile', 'variable', 'num']);
/** Each open Actor Control Panel's tab state, kept across its re-renders. */
const panelState = new WeakMap();

/* -------------------------------------------- */
/*  Builders                                    */
/* -------------------------------------------- */
/** Whether the tab shows its AI controls: the module is switched on and the AI plays this faction. */
function showsAiControls(actorType) {
  return systemIntegrated() && isAiFaction(actorType);
}

/**
 * Everything the Combat AI tab renders for one Actor, from the module's flags and the unit's data on the map. While
 * the module is switched off, the tab shows only a note saying what to update.
 */
function controlPanelContext(actor, options = {}) {
  const { activeTray = '', collapsed = new Set(), actorType = '', mvmtTotal = 0 } = options;
  const ai = readActorAi(actor);
  const movement = Math.max(0, Math.floor(mvmtTotal));
  return {
    isTrayAi: activeTray === TRAY,
    standDownNote: systemIntegrated() ? '' : standDownNotice(),
    aiFactions: systemAiFactions().join(', '),
    showAiProfile: showsAiControls(actorType),
    aiProfiles: AI_PROFILES.map(profile => ({ ...profile, selected: profile.value === ai.profile })),
    aiProfileTooltip: AI_PROFILE_DESCRIPTIONS[ai.profile] ?? '',
    aiIsManual: ai.profile === AI_MANUAL_PROFILE,
    aiPriority: ai.priority,
    mvmtTotal: movement,
    aiConditions: ai.conditions.map((entry, index) => conditionRow(entry, index, collapsed, movement))
  };
}

/* -------------------------------------------- */
/*  Panel state                                 */
/* -------------------------------------------- */
/** A panel's tab state, made on first use: which tab is open, and which condition rows the GM has folded shut. */
function stateOf(app) {
  let state = panelState.get(app);
  if (!state) {
    state = { activeTray: '', collapsed: new Set() };
    panelState.set(app, state);
  }
  return state;
}

/** The actor's unit as the system reports it on its Scene's map, or null when it has no token there. */
function boardUnitFor(actor) {
  const uuid = actor?.uuid ?? '';
  if (!uuid) return null;
  return (unitBoard(sceneUuidOfActor(actor))?.units ?? []).find(entry => entry.actorUuid === uuid) ?? null;
}

/** The actor's faction: the one picked in the panel's Actor Type select, else its unit's on the map. */
function actorTypeOf(root, placed) {
  const chosen = String(root.querySelector('select[name="actorType"]')?.value ?? '');
  return chosen || String(placed?.factionRole ?? '');
}

/** Log that an expected anchor is missing from the system's own template. The caller goes on without it. */
export function reportMissingAnchor(selector, template) {
  console.error(`${LOG} could not find "${selector}" in the system's ${template} template.`);
}

/* -------------------------------------------- */
/*  Injection                                   */
/* -------------------------------------------- */
/**
 * Add the Combat AI tab to a rendered Actor Control Panel, for GMs only. It runs on every render and removes its own
 * earlier tab and pane first.
 */
export async function injectControlPanelTray(app, element) {
  const root = element ?? app?.element ?? null;
  if (!root?.querySelector || !game.user.isGM) return;
  const rail = root.querySelector('.acp-tray-rail');
  const drawer = root.querySelector('.acp-tray-drawer');
  if (!rail || !drawer) return reportMissingAnchor(rail ? '.acp-tray-drawer' : '.acp-tray-rail', 'Actor Control Panel');
  rail.querySelector('[data-enemy-ai-tab]')?.remove();
  drawer.querySelector('[data-enemy-ai-pane]')?.remove();
  const state = stateOf(app);
  const actor = app.actor ?? null;
  // Only the host client copies a spawn order; the copy updates the Actor, which draws the panel again. Until then,
  // the planner applies the order from the system's flag.
  if (isCommandHost() && await adoptSpawnBehavior(actor)) return;
  const placed = boardUnitFor(actor);
  const context = controlPanelContext(actor, {
    activeTray: state.activeTray,
    collapsed: state.collapsed,
    actorType: actorTypeOf(root, placed),
    mvmtTotal: placed?.movement ?? 0
  });
  const markup = await renderTray(context);
  const tab = buildTab();
  rail.append(tab);
  drawer.insertAdjacentHTML('beforeend', markup);
  const pane = drawer.querySelector('[data-enemy-ai-pane]');
  if (!pane) return;
  wireTray(app, root, rail, tab, pane);
  bindActorTypeSelect(root, pane);
  bindFields(app, root, pane, actor, context.mvmtTotal);
}

/** Draw the tab's pane, once the condition row partial it includes is registered. */
async function renderTray(context) {
  await loadConditionRowPartial();
  return foundry.applications.handlebars.renderTemplate(TEMPLATE, context);
}

/** The AI tab's button for the panel's tab rail. */
function buildTab() {
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'acp-tray-tab';
  tab.dataset.tray = TRAY;
  tab.dataset.enemyAiTab = '1';
  tab.setAttribute('data-tooltip', 'Combat AI');
  const icon = document.createElement('i');
  icon.className = 'fas fa-brain';
  const label = document.createElement('span');
  label.textContent = 'AI';
  tab.append(icon, label);
  return tab;
}

/** Reopen the AI tab when it was open before this render, and remember which tab the GM opens next. */
function wireTray(app, root, rail, tab, pane) {
  const state = stateOf(app);
  if (state.activeTray === TRAY) openTray(root, tab, pane);
  tab.addEventListener('click', event => {
    event.preventDefault();
    state.activeTray = TRAY;
    openTray(root, tab, pane);
  });
  for (const other of rail.querySelectorAll('.acp-tray-tab[data-tray]')) {
    if (other === tab) continue;
    other.addEventListener('click', () => { state.activeTray = String(other.dataset.tray ?? ''); });
  }
}

/** Show the AI tab's pane and mark its tab as the current one, hiding the panel's other panes. */
function openTray(root, tab, pane) {
  for (const other of root.querySelectorAll('[data-tray]')) {
    const active = other === tab;
    other.classList.toggle('is-active', active);
    if (active) other.setAttribute('aria-current', 'page');
    else other.removeAttribute('aria-current');
  }
  for (const other of root.querySelectorAll('[data-tray-pane]')) {
    other.classList.toggle('is-active', other === pane);
  }
}

/**
 * Show the AI controls only while the panel's Actor Type select names a faction the AI plays, and otherwise the note
 * that says so. While the module is switched off the controls stay hidden.
 */
function bindActorTypeSelect(root, pane) {
  const select = root.querySelector('select[name="actorType"]');
  const controls = pane.querySelector('.acp-ai-controls');
  const note = pane.querySelector('[data-ai-gate-note]');
  if (!select || !controls) {
    return reportMissingAnchor(select ? '.acp-ai-controls' : 'select[name="actorType"]', 'Actor Control Panel');
  }
  select.addEventListener('change', () => {
    const enabled = showsAiControls(select.value);
    controls.hidden = !enabled;
    if (note) note.hidden = enabled;
  });
}

/* -------------------------------------------- */
/*  Field wiring                                */
/* -------------------------------------------- */
/** Save each AI field and condition field as the GM changes it, and handle the condition buttons. */
function bindFields(app, root, pane, actor, mvmtTotal) {
  // These change events also bubble to the system's panel form, which submits itself on every change.
  pane.addEventListener('change', event => {
    const field = event.target?.closest?.('[data-ai-field], [data-cond-field]');
    if (!field || !pane.contains(field)) return;
    const write = field.dataset.aiField
      ? onPanelField(pane, field, actor)
      : onConditionField(pane, field, actor, mvmtTotal);
    write.catch(error => console.error(`${LOG} could not save a Combat AI field.`, error));
  });
  pane.addEventListener('click', event => {
    const control = event.target?.closest?.('[data-ai-action]');
    if (!control || !pane.contains(control)) return;
    onAction(app, root, pane, actor, control, event)
      .catch(error => console.error(`${LOG} a Combat AI tab action failed.`, error));
  });
  applyManual(pane);
}

/** Save the profile or the priority. A new profile also updates its tooltip and greys out the conditions for Manual. */
async function onPanelField(pane, field, actor) {
  if (field.dataset.aiField === 'profile') {
    const help = pane.querySelector('[data-ai-profile-help]');
    if (help) help.dataset.tooltip = AI_PROFILE_DESCRIPTIONS[field.value] ?? '';
    applyManual(pane);
    await writeActorAi(actor, { profile: field.value });
    return;
  }
  const priority = Math.trunc(Number(field.value));
  field.value = String(Number.isFinite(priority) ? priority : AI_PRIORITY_DEFAULT);
  await writeActorAi(actor, { priority: field.value });
}

/**
 * Save the whole condition list after one field of a row changes, keeping that field within what it may hold. Only
 * the changed field is capped at the unit's movement; the other rows are saved as they are.
 */
async function onConditionField(pane, field, actor, mvmtTotal) {
  const row = field.closest('.acp-cond-entry');
  if (!row) return;
  if (field.dataset.condField === 'variable') field.value = String(clampVariable(field.value, mvmtTotal));
  if (field.dataset.condField === 'num') field.value = String(sanitizeConditionEntry({ num: field.value }).num);
  syncConditionRow(row, entryOfRow(row));
  await writeActorAi(actor, { conditions: readConditions(pane) });
}

/** One condition row's fields as a cleaned-up condition entry. */
function entryOfRow(row) {
  const raw = {};
  for (const name of CONDITION_FIELDS) raw[name] = row.querySelector(`[data-cond-field="${name}"]`)?.value;
  return sanitizeConditionEntry(raw);
}

/**
 * Every condition row as an entry, in order, as the rows show them. The planner caps each Max Squares at the unit's
 * movement on its turn, which mounts and effects change.
 */
function readConditions(pane) {
  return [...pane.querySelectorAll('.acp-cond-entry[data-cond-index]')].map(entryOfRow);
}

/** Grey out and disable the conditions while the profile select reads Manual, since the AI never plays that unit. */
function applyManual(pane) {
  const block = pane.querySelector('[data-ai-conditions]');
  if (!block) return;
  const manual = String(pane.querySelector('[data-ai-field="profile"]')?.value ?? '') === AI_MANUAL_PROFILE;
  block.classList.toggle('is-disabled', manual);
  for (const control of block.querySelectorAll('select, input, button')) control.disabled = manual;
}

/* -------------------------------------------- */
/*  Condition actions                           */
/* -------------------------------------------- */
/** Fold or unfold a condition row, or add or remove a condition and save the list. */
async function onAction(app, root, pane, actor, control, event) {
  const state = stateOf(app);
  const action = String(control.dataset.aiAction ?? '');
  const index = Number(control.dataset.index);
  if (action === 'toggleCondition') {
    if (event.target?.closest?.('[data-ai-action="removeCondition"]')) return;
    toggleConditionRow(pane, state.collapsed, index);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  state.activeTray = TRAY;
  if (action === 'addCondition') {
    const entries = readConditions(pane);
    entries.push(defaultConditionEntry());
    await saveAddedOrRemoved(app, root, pane, actor, entries);
    return;
  }
  if (action !== 'removeCondition') return;
  const entries = readConditions(pane);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) return;
  entries.splice(index, 1);
  state.collapsed = shiftCollapsed(state.collapsed, index);
  await saveAddedOrRemoved(app, root, pane, actor, entries);
}

/**
 * Save the list after a row is added or removed, then draw the tab again from the saved list. The conditions take no
 * clicks or edits until then, because the rows on screen still show the old list. The tab redraws itself because the
 * system's panel skips its own redraw when an update arrives while the panel is saving.
 */
async function saveAddedOrRemoved(app, root, pane, actor, entries) {
  const block = pane.querySelector('[data-ai-conditions]');
  if (block) block.inert = true;
  try {
    await writeActorAi(actor, { conditions: entries });
    await injectControlPanelTray(app, root);
  } finally {
    if (block) block.inert = false;
  }
}
