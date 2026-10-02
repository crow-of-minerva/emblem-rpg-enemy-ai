/** @layer ui */
import {
  AI_BEHAVIORS,
  AI_BEHAVIORS_WITH_VARIABLE,
  AI_CONDITION_TARGETS,
  AI_CONDITION_TYPES,
  AI_MANUAL_PROFILE,
  AI_PRIORITY_DEFAULT,
  AI_PROFILES,
  AI_PROFILE_DESCRIPTIONS,
  AI_PROFILE_FACTIONS,
  MODULE_ID
} from '../constants.mjs';
import { adoptSpawnBehavior, readActorAi, sceneUuidOfActor, writeActorAi } from '../foundry/flags.mjs';
import { unitBoard } from '../foundry/system-bridge.mjs';
import { conditionTakesNum, defaultConditionEntry, sanitizeConditionEntry } from '../planner/conditions.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
const TEMPLATE = `modules/${MODULE_ID}/templates/control-panel-ai.hbs`;
const TRAY = 'ai';
const CONDITION_FIELDS = Object.freeze(['target', 'type', 'behavior', 'profile', 'variable', 'num']);
const panelState = new WeakMap();

/* -------------------------------------------- */
/*  Builders                                    */
/* -------------------------------------------- */
/** A one-line summary of one authored entry, for its collapsed row header. */
export function conditionSummary(entry) {
  const targetLabel = AI_CONDITION_TARGETS.find(item => item.value === entry.target)?.label ?? entry.target;
  const types = AI_CONDITION_TYPES[entry.target] ?? [];
  const baseTypeLabel = types.find(item => item.value === entry.type)?.label ?? entry.type;
  const typeLabel = conditionTakesNum(entry.type) ? `${baseTypeLabel} ${entry.num}` : baseTypeLabel;
  const behaviorLabel = AI_BEHAVIORS.find(item => item.value === entry.behavior)?.label ?? entry.behavior;
  return `${targetLabel}: ${typeLabel} → ${behaviorLabel}${summaryDetail(entry)}`;
}

function summaryDetail(entry) {
  if (entry.behavior === 'switchProfile') {
    return ` → ${AI_PROFILES.find(item => item.value === entry.profile)?.label ?? entry.profile}`;
  }
  const carries = AI_BEHAVIORS_WITH_VARIABLE.includes(entry.behavior);
  return carries && entry.variable > 0 ? ` (${entry.variable})` : '';
}

/** Everything the Combat AI tab renders for one Actor, from the module's flags and the unit's data on the map. */
function controlPanelContext(actor, options = {}) {
  const { activeTray = '', collapsed = new Set(), actorType = '', mvmtTotal = 0 } = options;
  const ai = readActorAi(actor);
  const movement = Math.max(0, Math.floor(Number(mvmtTotal) || 0));
  return {
    isTrayAi: activeTray === TRAY,
    showAiProfile: AI_PROFILE_FACTIONS.includes(actorType),
    aiProfiles: AI_PROFILES.map(profile => ({ ...profile, selected: profile.value === ai.profile })),
    aiProfileTooltip: AI_PROFILE_DESCRIPTIONS[ai.profile] ?? '',
    aiIsManual: ai.profile === AI_MANUAL_PROFILE,
    aiPriority: ai.priority,
    mvmtTotal: movement,
    aiConditions: ai.conditions.map((entry, index) => conditionRow(entry, index, collapsed))
  };
}

function conditionRow(entry, index, collapsed) {
  entry = sanitizeConditionEntry(entry);
  const types = AI_CONDITION_TYPES[entry.target] ?? AI_CONDITION_TYPES.self;
  return {
    index,
    ...entry,
    collapsed: collapsed.has(index),
    summary: conditionSummary(entry),
    isPlayerTarget: entry.target === 'players',
    showProfile: entry.behavior === 'switchProfile',
    showVariable: AI_BEHAVIORS_WITH_VARIABLE.includes(entry.behavior),
    showNum: conditionTakesNum(entry.type),
    targetOptions: AI_CONDITION_TARGETS.map(item => ({ ...item, selected: item.value === entry.target })),
    typeOptions: types.map(item => ({ ...item, selected: item.value === entry.type })),
    behaviorOptions: AI_BEHAVIORS.map(item => ({ ...item, selected: item.value === entry.behavior })),
    profileOptions: AI_PROFILES.map(item => ({ ...item, selected: item.value === entry.profile }))
  };
}

/* -------------------------------------------- */
/*  Panel state                                 */
/* -------------------------------------------- */
function stateOf(app) {
  let state = panelState.get(app);
  if (!state) {
    state = { activeTray: '', collapsed: new Set() };
    panelState.set(app, state);
  }
  return state;
}

function boardUnitFor(actor) {
  const uuid = actor?.uuid ?? '';
  if (!uuid) return null;
  return (unitBoard(sceneUuidOfActor(actor))?.units ?? []).find(entry => entry.actorUuid === uuid) ?? null;
}

function actorTypeOf(root, placed) {
  const chosen = String(root.querySelector('select[name="actorType"]')?.value ?? '');
  return chosen || String(placed?.factionRole ?? '');
}

/** Log that an expected anchor is missing from the system's own template. The caller goes on without it. */
function reportMissingAnchor(selector, template) {
  console.error(`${MODULE_ID} | could not find "${selector}" in the system's ${template} template.`);
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
  // Copying a spawn order updates the Actor, which re-renders the panel and runs this again.
  if (await adoptSpawnBehavior(actor)) return;
  const placed = boardUnitFor(actor);
  const context = controlPanelContext(actor, {
    activeTray: state.activeTray,
    collapsed: state.collapsed,
    actorType: actorTypeOf(root, placed),
    mvmtTotal: Number(placed?.movement) || 0
  });
  const markup = await renderTray(context);
  const tab = buildTab();
  rail.append(tab);
  drawer.insertAdjacentHTML('beforeend', markup);
  const pane = drawer.querySelector('[data-enemy-ai-pane]');
  if (!pane) return;
  wireTray(app, root, rail, tab, pane);
  bindGate(root, pane);
  bindFields(app, pane, actor, context.mvmtTotal);
}

function renderTray(context) {
  return foundry.applications.handlebars.renderTemplate(TEMPLATE, context);
}

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

function bindGate(root, pane) {
  const select = root.querySelector('select[name="actorType"]');
  const controls = pane.querySelector('.acp-ai-controls');
  const note = pane.querySelector('[data-ai-gate-note]');
  if (!select || !controls) {
    return reportMissingAnchor(select ? '.acp-ai-controls' : 'select[name="actorType"]', 'Actor Control Panel');
  }
  select.addEventListener('change', () => {
    const enabled = AI_PROFILE_FACTIONS.includes(select.value);
    controls.hidden = !enabled;
    if (note) note.hidden = enabled;
  });
}

/* -------------------------------------------- */
/*  Field wiring                                */
/* -------------------------------------------- */
function bindFields(app, pane, actor, mvmtTotal) {
  // These change events also bubble to the system's panel form, which submits itself on every change.
  pane.addEventListener('change', event => {
    const field = event.target?.closest?.('[data-ai-field], [data-cond-field]');
    if (!field || !pane.contains(field)) return;
    if (field.dataset.aiField) void onPanelField(pane, field, actor);
    else void onConditionField(pane, field, actor, mvmtTotal);
  });
  pane.addEventListener('click', event => {
    const control = event.target?.closest?.('[data-ai-action]');
    if (!control || !pane.contains(control)) return;
    void onAction(app, pane, actor, mvmtTotal, control, event);
  });
  applyManual(pane);
}

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

async function onConditionField(pane, field, actor, mvmtTotal) {
  const row = field.closest('.acp-cond-entry');
  if (!row) return;
  if (field.dataset.condField === 'target') {
    swapConditionTypes(row);
    return;
  }
  if (field.dataset.condField === 'variable') clampVariable(field, mvmtTotal);
  if (field.dataset.condField === 'num') field.value = String(sanitizeConditionEntry({ num: field.value }).num);
  syncConditionRow(row);
  await writeActorAi(actor, { conditions: readConditions(pane, mvmtTotal) });
}

function swapConditionTypes(row) {
  const target = row.querySelector('[data-cond-field="target"]');
  const select = row.querySelector('[data-cond-field="type"]');
  if (!select) return;
  const types = AI_CONDITION_TYPES[target?.value] ?? AI_CONDITION_TYPES.self;
  select.replaceChildren(...types.map(type => {
    const option = document.createElement('option');
    option.value = type.value;
    option.textContent = type.label;
    return option;
  }));
  select.value = types[0].value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function clampVariable(field, mvmtTotal) {
  const raw = Math.max(0, Math.floor(Number(field.value) || 0));
  field.value = String(mvmtTotal > 0 ? Math.min(raw, mvmtTotal) : raw);
}

function syncConditionRow(row) {
  const value = name => String(row.querySelector(`[data-cond-field="${name}"]`)?.value ?? '');
  const behavior = value('behavior');
  hide(row, '.acp-cond-num', !conditionTakesNum(value('type')));
  hide(row, '.acp-cond-profile', behavior !== 'switchProfile');
  hide(row, '.acp-cond-variable', !AI_BEHAVIORS_WITH_VARIABLE.includes(behavior));
  hide(row, '.acp-cond-note', value('target') !== 'players');
  const summary = row.querySelector('[data-cond-summary]');
  if (summary) summary.textContent = conditionSummary(entryOfRow(row));
}

function hide(row, selector, hidden) {
  const element = row.querySelector(selector);
  if (element) element.hidden = hidden;
}

function entryOfRow(row) {
  const raw = {};
  for (const name of CONDITION_FIELDS) raw[name] = row.querySelector(`[data-cond-field="${name}"]`)?.value;
  return sanitizeConditionEntry(raw);
}

function readConditions(pane, mvmtTotal) {
  const entries = [];
  for (const row of pane.querySelectorAll('.acp-cond-entry[data-cond-index]')) {
    const entry = entryOfRow(row);
    if (mvmtTotal > 0) entry.variable = Math.min(entry.variable, mvmtTotal);
    entries.push(entry);
  }
  return entries;
}

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
async function onAction(app, pane, actor, mvmtTotal, control, event) {
  const state = stateOf(app);
  const action = String(control.dataset.aiAction ?? '');
  const index = Number(control.dataset.index);
  if (action === 'toggleCondition') {
    if (event.target?.closest?.('[data-ai-action="removeCondition"]')) return;
    toggleCondition(pane, state, index);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  state.activeTray = TRAY;
  if (action === 'addCondition') {
    const entries = readConditions(pane, mvmtTotal);
    entries.push(defaultConditionEntry());
    await writeActorAi(actor, { conditions: entries });
    return;
  }
  if (action !== 'removeCondition') return;
  const entries = readConditions(pane, mvmtTotal);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) return;
  entries.splice(index, 1);
  state.collapsed = shiftCollapsed(state.collapsed, index);
  await writeActorAi(actor, { conditions: entries });
}

function toggleCondition(pane, state, index) {
  if (!Number.isInteger(index)) return;
  if (state.collapsed.has(index)) state.collapsed.delete(index);
  else state.collapsed.add(index);
  pane.querySelector(`.acp-cond-entry[data-cond-index="${index}"]`)
    ?.classList.toggle('is-open', !state.collapsed.has(index));
}

/** Rebuild the collapsed set around a removed row, since the indices are positional. */
function shiftCollapsed(collapsed, removed) {
  const shifted = new Set();
  for (const index of collapsed) {
    if (index < removed) shifted.add(index);
    else if (index > removed) shifted.add(index - 1);
  }
  return shifted;
}
