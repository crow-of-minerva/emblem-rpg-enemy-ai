/** @layer ui */
/*
 * The dialog in which the host client asks the GM whether to resume an enemy phase that a reload interrupted.
 */

/* -------------------------------------------- */
/*  Resume after a reload                       */
/* -------------------------------------------- */
/**
 * Ask the GM, in a modal dialog on the host client, whether the AI should resume an enemy phase that a reload
 * interrupted. Closing the dialog counts as no.
 * @param {number} pendingCount How many units the AI still has to play.
 * @returns {Promise<boolean>} Whether the GM chose to resume.
 */
export async function confirmResume(pendingCount) {
  const plural = pendingCount > 1 ? 's' : '';
  const resumed = await foundry.applications.api.DialogV2.confirm({
    window: { title: 'Enemy AI' },
    content: `<p>The enemy phase was interrupted by a reload with ${pendingCount} unit${plural} still to act. `
      + 'Resume the Enemy AI?</p>',
    rejectClose: false,
    modal: true
  });
  return resumed === true;
}
