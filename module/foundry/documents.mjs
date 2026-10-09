/** @layer foundry */
/*
 * Finding Foundry documents: the document a uuid names, a token's actor and Scene, the world's Actors, an actor's
 * Scene, and the Scenes of the started encounters. Nothing here writes; the module's flags are read and written in
 * flags.mjs.
 */

/* -------------------------------------------- */
/*  Documents                                   */
/* -------------------------------------------- */
/** The document a uuid names, or null. A uuid that fails to resolve also reads as null instead of throwing. */
export function documentByUuid(uuid) {
  if (!uuid) return null;
  try {
    return foundry.utils.fromUuidSync(uuid) ?? null;
  } catch {
    return null;
  }
}

/** The Actor behind a placed Token uuid, or null. */
export function actorOfToken(tokenUuid) {
  const token = documentByUuid(tokenUuid);
  return token?.documentName === 'Token' ? token.actor ?? null : null;
}

/** Every Actor in the world's Actors directory. A linked token's Actor is one of them; an unlinked token's is not. */
export function worldActors() {
  return game.actors?.contents ?? [];
}

/* -------------------------------------------- */
/*  Scenes                                      */
/* -------------------------------------------- */
/** The uuid of a placed Token's Scene, read from the token uuid or else from the Token's parent, or ''. */
export function sceneUuidOfToken(tokenUuid) {
  const uuid = String(tokenUuid ?? '');
  const named = /^(Scene\.[^.]+)\.Token\.[^.]+$/.exec(uuid)?.[1];
  if (named) return named;
  const token = documentByUuid(uuid);
  return token?.documentName === 'Token' ? String(token.parent?.uuid ?? '') : '';
}

/** The uuid of an Actor's Scene: its own Token's for a synthetic Actor, else its first placed Token's, or ''. */
export function sceneUuidOfActor(actor) {
  const token = actor?.isToken ? actor.token : actor?.getDependentTokens?.()?.[0];
  return String(token?.parent?.uuid ?? '');
}

/** The Scenes of every started encounter, read off the Combat documents rather than the Scene a client is showing. */
export function startedEncounterSceneUuids() {
  const scenes = (game.combats?.contents ?? [])
    .filter(combat => combat?.started === true)
    .map(combat => String(combat.scene?.uuid ?? ''))
    .filter(Boolean);
  return [...new Set(scenes)];
}
