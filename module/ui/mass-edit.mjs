/** @layer ui */
/*
 * The Set Combat AI on Selected window, which overwrites the AI profile, priority and conditions of every selected unit
 * the AI plays at once. The system's Configure Combat AI macro opens it through the module API.
 */
import {
  AI_MANUAL_PROFILE,
  AI_PRIORITY_DEFAULT,
  AI_PROFILES,
  AI_PROFILE_DEFAULT,
  AI_PROFILE_VALUES,
  LOG,
  MODULE_ID,
  MODULE_TITLE
} from '../constants.mjs';
import { defaultConditionEntry, sanitizeConditionEntry } from '../condition-entries.mjs';
import { actorOfToken } from '../foundry/documents.mjs';
import { writeActorAi } from '../foundry/flags.mjs';
import { isAiFaction, systemAiFactions, systemIntegrated } from '../foundry/system-bridge.mjs';
import { unitByTokenUuid } from '../planner/board.mjs';
import {
  clampVariable,
  conditionRow,
  loadConditionRowPartial,
  shiftCollapsed,
  syncConditionRow,
  toggleConditionRow
} from './condition-rows.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

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
    if (!unit || !isAiFaction(unit.factionRole)) {
      skipped.push(name);
      continue;
    }
    if (seen.has(unit.actorUuid)) continue;
    seen.add(unit.actorUuid);
    targets.push({
      tokenUuid: unit.tokenUuid,
      actorUuid: unit.actorUuid,
      name: unit.name || name,
      movement: Math.max(0, unit.movement),
      ai: unit.ai
    });
  }
  return { targets, skipped };
}

/** The window's opening choices, seeded from the first target so the common case is already filled in. */
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

/** The note naming the selected tokens that were left out, or an empty string when none were. */
function skippedNote(skipped) {
  if (!skipped.length) return '';
  const factions = systemAiFactions().join(' / ');
  return `Skipped ${countOf(skipped.length, 'selected token')} that ${skipped.length === 1 ? 'is' : 'are'} `
    + `not ${factions}: ${skipped.join(', ')}`;
}

/** Whether Apply sets the units to Manual, which the AI never plays. */
function settingManual(choices) {
  return choices.writeProfile && choices.profile === AI_MANUAL_PROFILE;
}

/**
 * Whether Apply writes the conditions: Overwrite Conditions is ticked and the units are not being set to Manual. Units
 * set to Manual keep the conditions they have.
 */
function writesConditions(choices) {
  return choices.writeConditions && !settingManual(choices);
}

/** A count with its noun, made plural when the count is not one: "1 unit", "3 units". */
function countOf(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/* -------------------------------------------- */
/*  The window                                  */
/* -------------------------------------------- */
/**
 * Set Combat AI on Selected: the profile, priority and conditions to write to every selected AI unit, which the GM
 * edits here before pressing Overwrite. Its choices live on the instance until the window closes, and `wait` hands
 * them back.
 */
class SetCombatAiDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  /** The choices the window edits: the two Overwrite boxes, the profile, the priority and the condition entries. */
  #choices;
  /** The positions of the condition rows the GM has folded shut. */
  #collapsed = new Set();
  /** The units Overwrite writes to, from collectMassEditTargets. */
  #targets;
  /** The names of the selected tokens that are left out. */
  #skipped;
  /** The choices handed back when the window closes: a copy taken when the GM presses Overwrite, else null. */
  #submitted = null;
  /** Hands the submitted choices to `wait` once the window has closed. */
  #onClosed = () => {};

  /**
   * @param {object[]} targets The units Overwrite writes to, from collectMassEditTargets.
   * @param {string[]} skipped The names of the selected tokens that are left out.
   * @param {object} [options] Application options.
   */
  constructor(targets, skipped, options = {}) {
    super(options);
    this.#targets = targets;
    this.#skipped = skipped;
    this.#choices = massEditState(targets);
  }

  static DEFAULT_OPTIONS = {
    id: 'enemy-ai-set-combat-ai-{id}',
    classes: ['emblem-rpg', 'emblem-ai-overwrite'],
    window: {
      title: 'Set Combat AI on Selected',
      icon: 'fas fa-brain',
      resizable: true,
      minimizable: false,
      contentTag: 'form',
      contentClasses: ['standard-form']
    },
    position: { width: 440, height: 620 },
    form: { handler: SetCombatAiDialog.#onSubmit, closeOnSubmit: true },
    actions: {
      addCondition: SetCombatAiDialog.#onAddCondition,
      removeCondition: SetCombatAiDialog.#onRemoveCondition,
      toggleCondition: SetCombatAiDialog.#onToggleCondition
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/mass-edit.hbs` },
    footer: { template: `modules/${MODULE_ID}/templates/mass-edit-footer.hbs` }
  };

  /**
   * Open the window for these targets and wait for it to close.
   * @param {object[]} targets The units Overwrite writes to, from collectMassEditTargets.
   * @param {string[]} skipped The names of the selected tokens that are left out.
   * @returns {Promise<object|null>} A copy of the choices when the GM pressed Overwrite, else null.
   */
  static wait(targets, skipped) {
    return new Promise((resolve, reject) => {
      const app = new this(targets, skipped);
      app.#onClosed = resolve;
      app.render({ force: true }).catch(reject);
    });
  }

  /** The largest movement among the targets, the highest budget the Max Squares field offers. */
  get #mvmtMax() {
    return this.#targets.reduce((max, target) => Math.max(max, target.movement), 0);
  }

  /** @override */
  async _preFirstRender(context, options) {
    await super._preFirstRender(context, options);
    await loadConditionRowPartial();
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const choices = this.#choices;
    return Object.assign(context, {
      skippedNote: skippedNote(this.#skipped),
      writeProfile: choices.writeProfile,
      writeConditions: choices.writeConditions,
      conditionsOff: !writesConditions(choices),
      settingManual: settingManual(choices),
      profiles: AI_PROFILES.map(profile => ({ ...profile, selected: profile.value === choices.profile })),
      priority: choices.priority,
      rows: choices.entries.map((entry, index) => conditionRow(entry, index, this.#collapsed, this.#mvmtMax)),
      applyLabel: `Overwrite ${countOf(this.#targets.length, 'Unit')}`,
      canApply: choices.writeProfile || writesConditions(choices)
    });
  }

  /**
   * Escape closes this window wherever the focus is in it, as it does a DialogV2. Foundry's own Escape handling skips
   * a key pressed in a field, and otherwise closes every open window.
   * @override
   */
  _attachFrameListeners() {
    super._attachFrameListeners();
    this.element.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    });
  }

  /**
   * Keep the choices in step with each changed field. An Overwrite box or the profile redraws the window to grey out
   * blocks and enable Overwrite; the other fields are updated where they stand, so a held number arrow keeps counting
   * and a focused field keeps the focus.
   * @override
   */
  _onChangeForm(formConfig, event) {
    super._onChangeForm(formConfig, event);
    const field = event.target;
    if (field.dataset?.condField) {
      this.#changeCondition(field);
      return;
    }
    const choices = this.#choices;
    if (field.name === 'priority') {
      const priority = Math.trunc(Number(field.value));
      choices.priority = Number.isFinite(priority) ? priority : AI_PRIORITY_DEFAULT;
      field.value = String(choices.priority);
      return;
    }
    if (field.name === 'writeProfile') choices.writeProfile = field.checked;
    else if (field.name === 'writeConditions') choices.writeConditions = field.checked;
    else if (field.name === 'profile') {
      choices.profile = AI_PROFILE_VALUES.includes(field.value) ? field.value : AI_PROFILE_DEFAULT;
    } else return;
    this.#redraw(['body', 'footer']);
  }

  /** Copy a changed condition field into its entry, within what the field may hold, and refresh its row. */
  #changeCondition(field) {
    const name = field.dataset.condField;
    const entry = this.#choices.entries[Number(field.dataset.index)];
    const row = field.closest?.('.acp-cond-entry');
    if (!entry || !row) return;
    if (name === 'num') {
      entry.num = sanitizeConditionEntry({ num: field.value }).num;
      field.value = String(entry.num);
    } else if (name === 'variable') {
      entry.variable = clampVariable(field.value, this.#mvmtMax);
      field.value = String(entry.variable);
    } else {
      entry[name] = field.value;
    }
    syncConditionRow(row, entry);
  }

  /** Draw these parts of the window again from the current choices. */
  #redraw(parts) {
    this.render({ parts }).catch(error => console.error(`${LOG} could not redraw Set Combat AI on Selected.`, error));
  }

  /** Add a blank condition entry at the end of the list. */
  static #onAddCondition() {
    this.#choices.entries.push(defaultConditionEntry());
    this.#redraw(['body']);
  }

  /** Remove the condition entry whose trash button was pressed; the folded rows after it move up one place. */
  static #onRemoveCondition(event, target) {
    const index = Number(target.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= this.#choices.entries.length) return;
    this.#choices.entries.splice(index, 1);
    this.#collapsed = shiftCollapsed(this.#collapsed, index);
    this.#redraw(['body']);
  }

  /** Fold a condition row shut or open it again, where it stands, so its chevron turns as it does in the tab. */
  static #onToggleCondition(event, target) {
    toggleConditionRow(this.element, this.#collapsed, Number(target.dataset.index));
  }

  /** Overwrite: keep a copy of the choices for `wait`; the window then closes. */
  static #onSubmit() {
    this.#submitted = foundry.utils.deepClone(this.#choices);
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    this.#onClosed(this.#submitted);
  }
}

/* -------------------------------------------- */
/*  Writing the choices                         */
/* -------------------------------------------- */
/**
 * Write the window's choices to each target's Actor in turn, logging a failed write and going on with the rest. Every
 * unit gets the same conditions, unless they are being set to Manual; the planner caps each Max Squares at the unit's
 * movement on its turn.
 */
async function applyToTargets(choices, targets) {
  const entries = choices.entries.map(sanitizeConditionEntry);
  const writeConditions = writesConditions(choices);
  const applied = [];
  const failures = [];
  for (const target of targets) {
    const changes = {};
    if (choices.writeProfile) {
      changes.profile = choices.profile;
      changes.priority = choices.priority;
    }
    if (writeConditions) changes.conditions = entries;
    try {
      await writeActorAi(actorOfToken(target.tokenUuid), changes);
      applied.push({
        unit: target.name,
        profile: choices.writeProfile ? choices.profile : '(kept)',
        priority: choices.writeProfile ? choices.priority : '(kept)',
        conditions: writeConditions ? entries.length : '(kept)'
      });
    } catch (error) {
      failures.push({ unit: target.name, error: error.message });
      console.error(`${LOG} Set Combat AI failed for ${target.name}:`, error);
    }
  }
  return { applied, failures };
}

/** Log what was written, and tell the GM how many units were updated, skipped or failed. */
function report({ applied, failures }, skipped) {
  console.group(`${LOG} Set Combat AI on Selected: ${applied.length} unit(s) updated`);
  if (applied.length) console.table(applied);
  if (skipped.length) console.info(`${LOG} skipped (not an AI faction):`, skipped);
  if (failures.length) console.table(failures);
  console.groupEnd();
  if (failures.length) {
    ui.notifications?.error(`Updated ${countOf(applied.length, 'unit')}, but ${failures.length} failed. `
      + 'The console lists each failure.');
    return;
  }
  if (skipped.length) {
    ui.notifications?.info(`Updated ${countOf(applied.length, 'unit')}. Skipped ${countOf(skipped.length, 'token')} `
      + 'that cannot use Combat AI.');
    return;
  }
  ui.notifications?.info(`Updated ${countOf(applied.length, 'unit')}.`);
}

/* -------------------------------------------- */
/*  Entry point                                 */
/* -------------------------------------------- */
/**
 * Overwrite the Combat AI profile, priority and conditions of every selected AI unit at once; units set to Manual keep
 * their conditions. This is the module API's `openMassEdit`, which the system's "Configure Combat AI" macro calls. It
 * resolves once the window has closed and every write has finished.
 */
export async function openMassEditDialog() {
  if (game.user?.isGM !== true) {
    ui.notifications?.warn('Only a GM can set Combat AI on selected tokens.');
    return;
  }
  if (!systemIntegrated()) {
    ui.notifications?.warn(`Combat AI can't be set while ${MODULE_TITLE} is switched off.`);
    return;
  }
  if (!(globalThis.canvas?.tokens?.controlled ?? []).length) {
    ui.notifications?.warn('Select one or more tokens first.');
    return;
  }
  const { targets, skipped } = collectMassEditTargets();
  if (!targets.length) {
    const factions = systemAiFactions().join(', ');
    ui.notifications?.warn(`Combat AI applies to ${factions} units only, and nothing selected qualifies.`);
    return;
  }
  const choices = await SetCombatAiDialog.wait(targets, skipped);
  if (!choices) return;
  if (!choices.writeProfile && !writesConditions(choices)) {
    ui.notifications?.warn('Nothing selected to overwrite.');
    return;
  }
  report(await applyToTargets(choices, targets), skipped);
}
