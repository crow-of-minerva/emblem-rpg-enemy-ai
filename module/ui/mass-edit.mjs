/** @layer ui */
import {
  AI_BEHAVIORS,
  AI_BEHAVIORS_WITH_VARIABLE,
  AI_CONDITION_TARGETS,
  AI_CONDITION_TYPES,
  AI_MANUAL_PROFILE,
  AI_PRIORITY_DEFAULT,
  AI_PROFILES,
  AI_PROFILE_DEFAULT,
  AI_PROFILE_FACTIONS,
  AI_PROFILE_VALUES,
  AI_ROUND_MIN
} from '../constants.mjs';
import { actorOfToken, writeActorAi } from '../foundry/flags.mjs';
import { conditionTakesNum, defaultConditionEntry, sanitizeConditionEntry } from '../planner/conditions.mjs';
import { unitByTokenUuid } from '../planner/board.mjs';
import { conditionSummary } from './control-panel.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
const PRIORITY_TIP = 'Enemy-phase order '
  + '(higher acts first)';
const NUM_TIP = 'Round this entry starts applying, continuing every round after';
const VARIABLE_TIP = 'Squares of movement to spend, '
  + '0 for full movement';
const EMPTY_NOTE = 'No conditions, so applying clears every entry these units already have.';

/* -------------------------------------------- */
/*  Targets                                     */
/* -------------------------------------------- */
/** The selected tokens the Combat AI applies to, deduped by Actor, and the names of the ones it does not. */
function collectMassEditTargets() {
  const targets = [];
  const skipped = [];
  const seen = new Set();
  for (const token of globalThis.canvas?.tokens?.controlled ?? []) {
    const unit = unitByTokenUuid(token.document.uuid ?? '');
    const name = token.document.name;
    if (!unit || !AI_PROFILE_FACTIONS.includes(unit.factionRole)) {
      skipped.push(name);
      continue;
    }
    if (seen.has(unit.actorUuid)) continue;
    seen.add(unit.actorUuid);
    targets.push({
      tokenUuid: unit.tokenUuid,
      actorUuid: unit.actorUuid,
      name: unit.name || name,
      movement: Math.max(0, Number(unit.movement) || 0),
      ai: unit.ai
    });
  }
  return { targets, skipped };
}

/** The dialog's opening state, seeded from the first target so the common case is already filled in. */
function massEditState(targets) {
  const seed = targets[0].ai;
  return {
    writeProfile: true,
    writeConditions: true,
    profile: seed.profile,
    priority: Math.trunc(seed.priority),
    entries: seed.conditions.map(sanitizeConditionEntry)
  };
}

/** The authored entries as one unit will hold them: a movement budget can never exceed that unit's own allowance. */
function cappedConditions(entries, movement) {
  return entries.map(entry => ({
    ...entry, variable: movement > 0 ? Math.min(entry.variable, movement) : entry.variable
  }));
}

/* -------------------------------------------- */
/*  Markup                                      */
/* -------------------------------------------- */
function escape(text) {
  return foundry.utils.escapeHTML(text);
}

function optionsHtml(list, current) {
  return list.map(option => {
    const selected = option.value === current ? ' selected' : '';
    const disabled = option.disabled ? ' disabled' : '';
    return `<option value="${escape(option.value)}"${selected}${disabled}>${escape(option.label)}</option>`;
  }).join('');
}

function helpDot(tip, direction) {
  return `<span class="acp-help-dot" data-tooltip="${escape(tip)}" data-tooltip-direction="${direction}">?</span>`;
}

function rowHeadHtml(entry, index, open) {
  return `<div class="acp-cond-entry${open}" data-cond-index="${index}">
      <header class="acp-cond-header" data-action="toggle" data-index="${index}">
        <i class="fas fa-chevron-down acp-cond-chevron"></i>
        <span class="acp-cond-title" data-cond-summary>${escape(conditionSummary(entry))}</span>
        <button type="button" class="acp-btn acp-btn-icon acp-cond-delete" data-action="remove"
          data-index="${index}" data-tooltip="Remove entry"><i class="fas fa-trash"></i></button>
      </header>`;
}

function rowTopHtml(entry, index, types) {
  const numHidden = conditionTakesNum(entry.type) ? '' : ' hidden';
  return `<div class="acp-row acp-row-split">
          <div class="acp-field">
            <label class="ed-label">Target</label>
            <select class="ed-select ed-input--compact" data-field="target"
              data-index="${index}">${optionsHtml(AI_CONDITION_TARGETS, entry.target)}</select>
          </div>
          <div class="acp-field">
            <label class="ed-label">Condition</label>
            <select class="ed-select ed-input--compact" data-field="type"
              data-index="${index}">${optionsHtml(types, entry.type)}</select>
          </div>
          <div class="acp-field acp-cond-num" data-cond-num-row${numHidden}>
            <label class="ed-label">Num ${helpDot(NUM_TIP, 'LEFT')}</label>
            <input type="number" class="ed-input ed-input--compact" data-field="num" data-index="${index}"
              value="${entry.num}" min="${AI_ROUND_MIN}" step="1" />
          </div>
        </div>`;
}

function rowTailHtml(entry, index, mvmtMax) {
  const noteHidden = entry.target === 'players' ? '' : ' hidden';
  const profileHidden = entry.behavior === 'switchProfile' ? '' : ' hidden';
  const variableHidden = AI_BEHAVIORS_WITH_VARIABLE.includes(entry.behavior) ? '' : ' hidden';
  return `<p class="acp-cond-note" data-cond-player-note${noteHidden}>
          <i class="fas fa-triangle-exclamation"></i> Player conditions are saved but not yet evaluated in combat.
        </p>
        <div class="acp-field">
          <label class="ed-label">Behavior</label>
          <select class="ed-select ed-input--compact" data-field="behavior"
            data-index="${index}">${optionsHtml(AI_BEHAVIORS, entry.behavior)}</select>
        </div>
        <div class="acp-field acp-cond-profile" data-cond-profile-row${profileHidden}>
          <label class="ed-label">Switch To</label>
          <select class="ed-select ed-input--compact" data-field="profile"
            data-index="${index}">${optionsHtml(AI_PROFILES, entry.profile)}</select>
        </div>
        <div class="acp-field acp-cond-variable" data-cond-variable-row${variableHidden}>
          <label class="ed-label">Variable ${helpDot(VARIABLE_TIP, 'RIGHT')}</label>
          <input type="number" class="ed-input ed-input--compact" data-field="variable" data-index="${index}"
            value="${entry.variable}" min="0" max="${mvmtMax}" step="1" />
        </div>`;
}

function rowHtml(entry, index, collapsed, mvmtMax) {
  const types = AI_CONDITION_TYPES[entry.target] ?? AI_CONDITION_TYPES.self;
  const open = collapsed.has(index) ? '' : ' is-open';
  return `${rowHeadHtml(entry, index, open)}
      <div class="acp-cond-body">
        ${rowTopHtml(entry, index, types)}
        ${rowTailHtml(entry, index, mvmtMax)}
      </div>
    </div>`;
}

function skippedHtml(skipped) {
  if (!skipped.length) return '';
  const factions = AI_PROFILE_FACTIONS.join(' / ');
  return `<p class="acp-cond-note"><i class="fas fa-triangle-exclamation"></i> Skipped ${skipped.length} selected `
    + `token(s) that are not ${escape(factions)}: ${escape(skipped.join(', '))}</p>`;
}

function dialogContent(state, skipped) {
  return `<div class="emblem-aiset ed-container">
    ${skippedHtml(skipped)}
    <label class="ed-label aiset-scope">
      <input type="checkbox" class="ed-checkbox" data-scope="profile" checked /> Overwrite AI Profile
    </label>
    <div class="aiset-block" data-scope-body="profile">
      <div class="acp-row acp-row-split">
        <div class="acp-field">
          <label class="ed-label">Combat AI Profile</label>
          <select class="ed-select" data-ai-profile>${optionsHtml(AI_PROFILES, state.profile)}</select>
        </div>
        <div class="acp-field acp-ai-priority">
          <label class="ed-label">Priority ${helpDot(PRIORITY_TIP, 'LEFT')}</label>
          <input type="number" class="ed-input" data-ai-priority value="${state.priority}" step="1" />
        </div>
      </div>
    </div>
    <hr class="aiset-rule" />
    <label class="ed-label aiset-scope">
      <input type="checkbox" class="ed-checkbox" data-scope="conditions" checked /> Overwrite Conditions
    </label>
    <div class="aiset-block acp-ai-conditions" data-scope-body="conditions">
      <div class="acp-section-head">
        <label class="ed-label">Conditions</label>
        <button type="button" class="acp-btn acp-btn-mini" data-action="add"><i class="fas fa-plus"></i> Add Entry
        </button>
      </div>
      <div class="acp-cond-list" data-cond-list></div>
    </div>
  </div>`;
}

/* -------------------------------------------- */
/*  Live dialog                                 */
/* -------------------------------------------- */
function paintList(root, state, collapsed, mvmtMax) {
  const list = root.querySelector('[data-cond-list]');
  if (!list) return;
  list.innerHTML = state.entries.length
    ? state.entries.map((entry, index) => rowHtml(entry, index, collapsed, mvmtMax)).join('')
    : `<p class="acp-cond-note"><i class="fas fa-triangle-exclamation"></i> ${EMPTY_NOTE}</p>`;
}

function syncRow(root, state, index) {
  const row = root.querySelector(`.acp-cond-entry[data-cond-index="${index}"]`);
  const entry = state.entries[index];
  if (!row || !entry) return;
  const set = (selector, hidden) => {
    const element = row.querySelector(selector);
    if (element) element.hidden = hidden;
  };
  set('[data-cond-num-row]', !conditionTakesNum(entry.type));
  set('[data-cond-profile-row]', entry.behavior !== 'switchProfile');
  set('[data-cond-variable-row]', !AI_BEHAVIORS_WITH_VARIABLE.includes(entry.behavior));
  set('[data-cond-player-note]', entry.target !== 'players');
  const summary = row.querySelector('[data-cond-summary]');
  if (summary) summary.textContent = conditionSummary(entry);
}

/**
 * Grey out the blocks that won't be written. Conditions are also greyed while the profile is being set to Manual,
 * but `applyToTargets` still writes them when "Overwrite Conditions" is ticked.
 */
function syncScopes(root, dialog, state) {
  const manual = state.profile === AI_MANUAL_PROFILE;
  root.querySelector('[data-scope-body="profile"]')?.classList.toggle('is-off', !state.writeProfile);
  root.querySelector('[data-scope-body="conditions"]')
    ?.classList.toggle('is-off', !state.writeConditions || (state.writeProfile && manual));
  const apply = dialog.element?.querySelector('button[data-action="apply"]');
  if (apply) apply.disabled = !state.writeProfile && !state.writeConditions;
}

function onDialogClick(event, root, state, collapsed, mvmtMax) {
  const control = event.target?.closest?.('[data-action]');
  if (!control || !root.contains(control)) return;
  const action = control.dataset.action;
  const index = Number(control.dataset.index);
  if (action === 'add') {
    event.preventDefault();
    state.entries.push(defaultConditionEntry());
    paintList(root, state, collapsed, mvmtMax);
    return;
  }
  if (action === 'remove') {
    event.preventDefault();
    event.stopPropagation();
    if (!Number.isInteger(index) || index < 0 || index >= state.entries.length) return;
    state.entries.splice(index, 1);
    const shifted = [...collapsed].filter(entry => entry !== index).map(entry => (entry > index ? entry - 1 : entry));
    collapsed.clear();
    for (const entry of shifted) collapsed.add(entry);
    paintList(root, state, collapsed, mvmtMax);
    return;
  }
  if (action !== 'toggle' || !Number.isInteger(index)) return;
  if (collapsed.has(index)) collapsed.delete(index);
  else collapsed.add(index);
  root.querySelector(`.acp-cond-entry[data-cond-index="${index}"]`)?.classList.toggle('is-open', !collapsed.has(index));
}

function onScopeChange(element, root, dialog, state) {
  if (element.matches('[data-scope]')) {
    if (element.dataset.scope === 'profile') state.writeProfile = element.checked;
    else state.writeConditions = element.checked;
    syncScopes(root, dialog, state);
    return true;
  }
  if (element.matches('[data-ai-profile]')) {
    state.profile = AI_PROFILE_VALUES.includes(element.value) ? element.value : AI_PROFILE_DEFAULT;
    syncScopes(root, dialog, state);
    return true;
  }
  if (!element.matches('[data-ai-priority]')) return false;
  const priority = Math.trunc(Number(element.value));
  state.priority = Number.isFinite(priority) ? priority : AI_PRIORITY_DEFAULT;
  element.value = String(state.priority);
  return true;
}

function onEntryChange(element, root, state, mvmtMax) {
  const field = element.dataset?.field;
  const index = Number(element.dataset?.index);
  const entry = state.entries[index];
  if (!field || !entry) return;
  if (field === 'num') {
    entry.num = sanitizeConditionEntry({ num: element.value }).num;
    element.value = String(entry.num);
  } else if (field === 'variable') {
    const raw = Math.max(0, Math.floor(Number(element.value) || 0));
    entry.variable = mvmtMax > 0 ? Math.min(raw, mvmtMax) : raw;
    element.value = String(entry.variable);
  } else {
    entry[field] = element.value;
  }
  if (field === 'target') {
    const types = AI_CONDITION_TYPES[entry.target] ?? AI_CONDITION_TYPES.self;
    if (!types.some(type => type.value === entry.type)) entry.type = types[0].value;
    const select = root.querySelector(`select[data-field="type"][data-index="${index}"]`);
    if (select) select.innerHTML = optionsHtml(types, entry.type);
  }
  syncRow(root, state, index);
}

function wireDialog(dialog, state, collapsed, mvmtMax) {
  const root = dialog.element?.querySelector('.emblem-aiset');
  if (!root) return;
  paintList(root, state, collapsed, mvmtMax);
  syncScopes(root, dialog, state);
  root.addEventListener('click', event => onDialogClick(event, root, state, collapsed, mvmtMax));
  root.addEventListener('change', event => {
    const element = event.target;
    if (onScopeChange(element, root, dialog, state)) return;
    onEntryChange(element, root, state, mvmtMax);
  });
}

/* -------------------------------------------- */
/*  Application                                 */
/* -------------------------------------------- */
async function applyToTargets(result, targets) {
  const entries = result.entries.map(sanitizeConditionEntry);
  const applied = [];
  const failures = [];
  for (const target of targets) {
    const changes = {};
    if (result.writeProfile) {
      changes.profile = result.profile;
      changes.priority = result.priority;
    }
    if (result.writeConditions) changes.conditions = cappedConditions(entries, target.movement);
    try {
      await writeActorAi(actorOfToken(target.tokenUuid), changes);
      applied.push({
        unit: target.name,
        profile: result.writeProfile ? result.profile : '(kept)',
        priority: result.writeProfile ? result.priority : '(kept)',
        conditions: result.writeConditions ? entries.length : '(kept)'
      });
    } catch (error) {
      failures.push({ unit: target.name, error: error.message });
      console.error(`emblem-rpg-enemy-ai | Set Combat AI failed for ${target.name}:`, error);
    }
  }
  return { applied, failures };
}

function report({ applied, failures }, skipped) {
  console.group(`emblem-rpg-enemy-ai | Set Combat AI on Selected: ${applied.length} unit(s) updated`);
  if (applied.length) console.table(applied);
  if (skipped.length) console.info('Skipped (not an AI faction):', skipped);
  if (failures.length) console.table(failures);
  console.groupEnd();
  if (failures.length) {
    ui.notifications?.error(`Updated ${applied.length} unit(s), but ${failures.length} failed. See console.`);
    return;
  }
  if (skipped.length) {
    ui.notifications?.info(`Updated ${applied.length} unit(s). Skipped ${skipped.length} non-AI token(s).`);
    return;
  }
  ui.notifications?.info(`Updated ${applied.length} unit(s).`);
}

/* -------------------------------------------- */
/*  Entry point                                 */
/* -------------------------------------------- */
/**
 * Overwrite the Combat AI profile, priority and conditions of every selected AI unit at once. This is the module
 * API's `openMassEdit`, which the system's "Configure Combat AI" macro calls.
 */
export async function openMassEditDialog() {
  if (game.user?.isGM !== true) {
    ui.notifications?.warn('Set Combat AI on Selected is GM-only.');
    return;
  }
  if (!(globalThis.canvas?.tokens?.controlled ?? []).length) {
    ui.notifications?.warn('Select one or more tokens first.');
    return;
  }
  const { targets, skipped } = collectMassEditTargets();
  if (!targets.length) {
    const factions = AI_PROFILE_FACTIONS.join(', ');
    ui.notifications?.warn(`Combat AI applies to ${factions} units only, and nothing selected qualifies.`);
    return;
  }
  const state = massEditState(targets);
  const collapsed = new Set();
  const mvmtMax = targets.reduce((max, target) => Math.max(max, target.movement), 0);
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: 'Set Combat AI on Selected', icon: 'fas fa-brain', resizable: true },
    position: { width: 440, height: 620 },
    classes: ['emblem-rpg', 'emblem-ai-overwrite'],
    content: dialogContent(state, skipped),
    buttons: [
      {
        action: 'apply', label: `Overwrite ${targets.length} Unit(s)`, icon: 'fas fa-brain', default: true,
        callback: () => foundry.utils.deepClone(state)
      },
      { action: 'cancel', label: 'Cancel', icon: 'fas fa-times' }
    ],
    render: (event, dialog) => wireDialog(dialog, state, collapsed, mvmtMax)
  });
  if (!result || typeof result !== 'object') return;
  if (!result.writeProfile && !result.writeConditions) {
    ui.notifications?.warn('Nothing selected to overwrite.');
    return;
  }
  report(await applyToTargets(result, targets), skipped);
}
