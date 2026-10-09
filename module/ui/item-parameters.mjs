/** @layer ui */
/*
 * The AI Parameters button on the sheet of an item the AI can use, for the GM and Assistant GMs, and its dialog: the
 * item's AI role, such as Heal, and that role's settings, saved as a flag on the item.
 */
import { AI_ITEM_ROLES, LOG, MODULE_ID } from '../constants.mjs';
import { readItemAiData, writeItemAiData } from '../foundry/flags.mjs';
import { systemItemType } from '../foundry/system-bridge.mjs';
import { aiUsesItemKind } from '../planner/support.mjs';

/* -------------------------------------------- */
/*  Constants                                   */
/* -------------------------------------------- */
const TEMPLATE = `modules/${MODULE_ID}/templates/ai-parameters.hbs`;
const FRAME_ACTION = 'enemyAiParameters';
const FRAME_LABEL = 'AI Parameters';

/* -------------------------------------------- */
/*  Applicability                               */
/* -------------------------------------------- */
/** Whether an item's sheet gets AI parameters: only the kinds of item the AI can choose to use on its turn. */
function supportsAiParameters(item) {
  if (item?.documentName !== 'Item') return false;
  return aiUsesItemKind({ type: item.type, itemType: systemItemType(item) });
}

/* -------------------------------------------- */
/*  Injection                                   */
/* -------------------------------------------- */
/**
 * Put the AI Parameters control in a rendered item sheet's header, for GMs only. It runs from the `renderItemSheetV2`
 * hook on every render of any ItemSheetV2, and removes its own earlier button first.
 */
export function injectItemParametersButton(app, element) {
  const root = element ?? app?.element ?? null;
  if (!root?.querySelector || !game.user.isGM || app?.isEditable !== true) return;
  if (!supportsAiParameters(app.document)) return;
  const header = root.querySelector('.window-header');
  const close = header?.querySelector('button[data-action="close"]');
  if (!close) return;
  header.querySelector(`button[data-action="${FRAME_ACTION}"]`)?.remove();
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'header-control fas fa-brain icon';
  button.dataset.action = FRAME_ACTION;
  button.setAttribute('aria-label', FRAME_LABEL);
  button.setAttribute('data-tooltip', FRAME_LABEL);
  button.addEventListener('click', event => {
    event.preventDefault();
    openAiParametersDialog(app.document)
      .catch(error => console.error(`${LOG} could not open the AI Parameters dialog.`, error));
  });
  close.insertAdjacentElement('beforebegin', button);
}

/* -------------------------------------------- */
/*  Editor                                      */
/* -------------------------------------------- */
/** Edit what an item is for as far as the enemy AI is concerned: its role, and the role's own parameters. */
async function openAiParametersDialog(item) {
  if (!item || !game.user.isGM) return null;
  const stored = readItemAiData(item);
  const content = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
    roles: AI_ITEM_ROLES.map(role => ({ ...role, selected: role.value === stored.role })),
    threshold: stored.threshold,
    amount: stored.amount
  });
  return foundry.applications.api.DialogV2.wait({
    window: { title: `AI Parameters: ${item.name}`, icon: 'fas fa-brain', resizable: false },
    classes: ['emblem-rpg', 'dialog-editor', 'dialog-ai-parameters'],
    position: { width: 360 },
    content,
    buttons: parameterButtons(item),
    render: (event, dialog) => wireRolePanels(dialog.element)
  });
}

function parameterButtons(item) {
  return [
    {
      action: 'save',
      label: 'Save',
      icon: 'fas fa-save',
      default: true,
      callback: (event, button, dialog) => writeItemAiData(item, gatherParameters(dialog.element))
    },
    { action: 'cancel', label: 'Cancel' }
  ];
}

/** Read the parameters back out of the dialog, clamped to what the scorers can use. */
function gatherParameters(root) {
  const read = name => root?.querySelector(`[name="${name}"]`)?.value;
  const threshold = Math.max(1, Math.min(100, Number(read('aiThreshold')) || 50));
  const amount = Math.max(0, Number(read('aiAmount')) || 0);
  return { role: String(read('aiRole') ?? ''), threshold, amount };
}

/** Show only the parameter panel belonging to the selected role. */
function wireRolePanels(root) {
  const select = root?.querySelector('[name="aiRole"]');
  if (!select) return;
  const panels = root.querySelectorAll('[data-role-params]');
  const apply = () => {
    for (const panel of panels) panel.classList.toggle('is-hidden', panel.dataset.roleParams !== select.value);
  };
  apply();
  select.addEventListener('change', apply);
}
