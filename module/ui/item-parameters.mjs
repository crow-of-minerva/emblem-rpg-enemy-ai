/** @layer ui */
import { AI_ITEM_ROLES, AI_PARAMETER_ITEM_TYPES, MODULE_ID } from '../constants.mjs';
import { readItemAiData, writeItemAiData } from '../foundry/flags.mjs';

/* -------------------------------------------- */
/*  Vocabulary                                  */
/* -------------------------------------------- */
const TEMPLATE = `modules/${MODULE_ID}/templates/ai-parameters.hbs`;
const FRAME_ACTION = 'enemyAiParameters';
const FRAME_LABEL = 'AI Parameters';
const CONSUMABLE_DOCUMENT = 'Consumable';

/* -------------------------------------------- */
/*  Applicability                               */
/* -------------------------------------------- */
/**
 * Whether an item's sheet gets AI parameters: Consumables and the subtypes in AI_PARAMETER_ITEM_TYPES, the only
 * items the AI can choose to use on its turn.
 */
function supportsAiParameters(capabilities) {
  if (!capabilities) return false;
  if (String(capabilities.documentType ?? '') === CONSUMABLE_DOCUMENT) return true;
  return AI_PARAMETER_ITEM_TYPES.has(String(capabilities.itemType ?? ''));
}

/* -------------------------------------------- */
/*  Injection                                   */
/* -------------------------------------------- */
/**
 * Put the AI Parameters control in a rendered item sheet's header, for GMs only. The `renderItemSheet` hook in
 * `foundry/hooks.mjs` calls it on every render, and it removes its own earlier button first.
 */
export function injectItemParametersButton(app, element, context) {
  const root = element ?? app?.element ?? null;
  if (!root?.querySelector || !game.user.isGM || app?.isEditable !== true) return;
  if (!supportsAiParameters(app?.capabilities ?? context?.capabilities ?? null)) return;
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
    void openAiParametersDialog(app.document);
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
