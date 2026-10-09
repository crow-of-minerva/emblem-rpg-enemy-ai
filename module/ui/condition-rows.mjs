/** @layer ui */
/*
 * The condition row partial that the Combat AI tab and the Set Combat AI on Selected window draw each condition entry
 * with: its template data, its summary line, and showing, hiding and folding its parts.
 */
import {
  AI_BEHAVIORS,
  AI_BEHAVIORS_WITH_VARIABLE,
  AI_CONDITION_TYPES,
  AI_PROFILES,
  MODULE_ID
} from '../constants.mjs';
import { conditionTakesNum, sanitizeConditionEntry } from '../condition-entries.mjs';

/**
 * The AI condition rows the Combat AI tab and Set Combat AI on Selected share, drawn with the partial
 * templates/partials/condition-row.hbs, with `data-cond-field` and `data-index` on their fields. The template that
 * includes a row names the attribute its buttons carry. The tab gives them `data-ai-action`, read by its own listener,
 * because it sits inside the system's Actor Control Panel, whose ApplicationV2 would otherwise run them as its own
 * actions. The Set Combat AI window gives them `data-action`, so its ApplicationV2 runs them as the window's actions.
 * The fields have no `name`, so the panel's form never saves them as Actor data.
 */

/* -------------------------------------------- */
/*  Partial                                     */
/* -------------------------------------------- */
/** The Handlebars partial name a template includes with `{{> enemy-ai-condition-row}}`. */
export const CONDITION_ROW_PARTIAL = 'enemy-ai-condition-row';
const CONDITION_ROW_TEMPLATE = `modules/${MODULE_ID}/templates/partials/condition-row.hbs`;
let partialLoad = null;

/**
 * Fetch and register the condition row partial once, starting at init; each renderer awaits it again, so a render that
 * comes first still finds it. A failed load is tried again next time.
 * @returns {Promise<unknown>} Resolves once the partial is registered.
 */
export function loadConditionRowPartial() {
  partialLoad ??= foundry.applications.handlebars.loadTemplates({ [CONDITION_ROW_PARTIAL]: CONDITION_ROW_TEMPLATE })
    .catch(error => {
      partialLoad = null;
      throw error;
    });
  return partialLoad;
}

/* -------------------------------------------- */
/*  Row data                                    */
/* -------------------------------------------- */
/** A one-line summary of one condition entry, for its collapsed row header. */
export function conditionSummary(entry) {
  const baseTypeLabel = AI_CONDITION_TYPES.find(item => item.value === entry.type)?.label ?? entry.type;
  const typeLabel = conditionTakesNum(entry.type) ? `${baseTypeLabel} ${entry.num}` : baseTypeLabel;
  const behaviorLabel = AI_BEHAVIORS.find(item => item.value === entry.behavior)?.label ?? entry.behavior;
  return `${typeLabel} → ${behaviorLabel}${summaryDetail(entry)}`;
}

function summaryDetail(entry) {
  if (entry.behavior === 'switchProfile') {
    return ` → ${AI_PROFILES.find(item => item.value === entry.profile)?.label ?? entry.profile}`;
  }
  const carries = AI_BEHAVIORS_WITH_VARIABLE.includes(entry.behavior);
  return carries && entry.variable > 0 ? ` (${entry.variable})` : '';
}

/**
 * The data the condition row partial draws for one entry.
 * @param {object} entry The condition entry; it is sanitized first.
 * @param {number} index The entry's position in the list, which every control carries as `data-index`.
 * @param {Set<number>} collapsed The positions of the rows the GM has folded shut.
 * @param {number} variableMax The highest movement budget the Max Squares field offers, or 0 for no limit, as for an
 *   actor with no token on the map.
 * @returns {object} The row's fields, summary, which parts show, and the option lists with the current value selected.
 */
export function conditionRow(entry, index, collapsed, variableMax) {
  entry = sanitizeConditionEntry(entry);
  return {
    index,
    ...entry,
    variableMax,
    collapsed: collapsed.has(index),
    summary: conditionSummary(entry),
    showProfile: entry.behavior === 'switchProfile',
    showVariable: AI_BEHAVIORS_WITH_VARIABLE.includes(entry.behavior),
    showNum: conditionTakesNum(entry.type),
    typeOptions: AI_CONDITION_TYPES.map(item => ({ ...item, selected: item.value === entry.type })),
    behaviorOptions: AI_BEHAVIORS.map(item => ({ ...item, selected: item.value === entry.behavior })),
    profileOptions: AI_PROFILES.map(item => ({ ...item, selected: item.value === entry.profile }))
  };
}

/* -------------------------------------------- */
/*  Row behaviour                               */
/* -------------------------------------------- */
/** A movement budget as a whole number of squares, never above `max` when the unit has any movement. */
export function clampVariable(value, max) {
  const raw = Math.max(0, Math.floor(Number(value) || 0));
  return max > 0 ? Math.min(raw, max) : raw;
}

/** Show or hide the parts of a drawn row that depend on its entry, and rewrite its summary. */
export function syncConditionRow(row, entry) {
  hide(row, '[data-cond-num-row]', !conditionTakesNum(entry.type));
  hide(row, '[data-cond-profile-row]', entry.behavior !== 'switchProfile');
  hide(row, '[data-cond-variable-row]', !AI_BEHAVIORS_WITH_VARIABLE.includes(entry.behavior));
  const summary = row.querySelector('[data-cond-summary]');
  if (summary) summary.textContent = conditionSummary(entry);
}

function hide(row, selector, hidden) {
  const element = row.querySelector(selector);
  if (element) element.hidden = hidden;
}

/** Fold a row shut or open it again, keeping `collapsed` in step. */
export function toggleConditionRow(root, collapsed, index) {
  if (!Number.isInteger(index)) return;
  if (collapsed.has(index)) collapsed.delete(index);
  else collapsed.add(index);
  root.querySelector(`.acp-cond-entry[data-cond-index="${index}"]`)?.classList.toggle('is-open', !collapsed.has(index));
}

/** The folded rows after the row at `removed` is deleted: later rows move up one place. */
export function shiftCollapsed(collapsed, removed) {
  const shifted = new Set();
  for (const index of collapsed) {
    if (index < removed) shifted.add(index);
    else if (index > removed) shifted.add(index - 1);
  }
  return shifted;
}
