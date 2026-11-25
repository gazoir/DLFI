import { FLAG_SCOPE, PC_ACTOR_FOLDER_NAME, sessionFolderName } from "../constants.mjs";

function isRootFolderOfType(folder, type) {
  return folder.type === type && !folder.folder;
}

/**
 * Find an existing root Folder for DLFI. Identity flags win over the name so a
 * GM's own same-named folder is never adopted (and later deleted with a session):
 * - `importKey` → exact import match only;
 * - `sessionCode` (without importKey) → same session code only;
 * - `kind` → same kind first, then a same-named folder with no DLFI flags.
 * @param {string} type
 * @param {string} name
 * @param {object} flags
 * @param {{ excludeIds?: Set<string> }} [options]
 */
export function findDlfiRootFolder(type, name, flags = {}, { excludeIds } = {}, folders = game.folders) {
  const candidates = [...(folders ?? [])].filter(
    (folder) => isRootFolderOfType(folder, type) && !excludeIds?.has?.(folder.id)
  );
  const meta = (folder) => folder.flags?.[FLAG_SCOPE] ?? {};
  if (flags.importKey) {
    return candidates.find((folder) => meta(folder).importKey === flags.importKey) ?? null;
  }
  if (flags.sessionCode) {
    return (
      candidates.find(
        (folder) => String(meta(folder).sessionCode ?? "") === String(flags.sessionCode)
      ) ?? null
    );
  }
  if (flags.kind) {
    const byKind = candidates.find((folder) => meta(folder).kind === flags.kind);
    if (byKind) {
      return byKind;
    }
    return (
      candidates.find(
        (folder) => folder.name === name && !Object.keys(meta(folder)).length
      ) ?? null
    );
  }
  return candidates.find((folder) => folder.name === name) ?? null;
}

/**
 * Ensure a root Folder of the given document type exists.
 * @param {string} type Actor|Item|Scene|JournalEntry|RollTable|Playlist|Cards|Adventure
 * @param {string} name
 * @param {object} [flags]
 * @param {{ excludeIds?: Set<string> }} [options]
 */
export async function ensureFolder(type, name, flags = {}, options = {}) {
  const existing = findDlfiRootFolder(type, name, flags, options);
  if (existing) {
    if (Object.keys(flags).length) {
      await existing.update({ flags: { [FLAG_SCOPE]: flags } });
    }
    return existing;
  }
  return Folder.create({
    name,
    type,
    folder: null,
    flags: { [FLAG_SCOPE]: flags }
  });
}

/**
 * Shared Actor folder for Player Characters (`Damned Lucky`).
 * Not tied to a session import — survives replace/delete of session folders.
 * @returns {Promise<Folder>}
 */
export async function ensurePcActorFolder() {
  return ensureFolder("Actor", PC_ACTOR_FOLDER_NAME, {
    kind: "pc-library",
    name: PC_ACTOR_FOLDER_NAME
  });
}

/**
 * Ensure a child Folder under an existing parent (same document type).
 * @param {Folder} parent
 * @param {string} name
 * @param {object} [flags]
 * @returns {Promise<Folder|null>}
 */
export async function ensureChildFolder(parent, name, flags = {}) {
  if (!parent?.id || !parent?.type) {
    return null;
  }
  const label = String(name || "").trim();
  if (!label) {
    return null;
  }
  const existing = game.folders.find(
    (folder) =>
      folder.type === parent.type &&
      folder.name === label &&
      (folder.folder?.id ?? folder.folder ?? null) === parent.id
  );
  if (existing) {
    if (Object.keys(flags).length) {
      await existing.update({ flags: { [FLAG_SCOPE]: flags } });
    }
    return existing;
  }
  return Folder.create({
    name: label,
    type: parent.type,
    folder: parent.id,
    flags: { [FLAG_SCOPE]: flags }
  });
}

/**
 * Create the standard folder set for one imported session. Folders are keyed by
 * importKey; pass `excludeIds` (the previous import's folders) to force a fresh
 * set when the same export is re-imported with replace on.
 * @param {object} manifest
 * @param {string} importKey
 * @param {{ excludeIds?: Set<string> }} [options]
 */
export async function ensureSessionFolders(manifest, importKey, options = {}) {
  const name = sessionFolderName(manifest);
  const meta = {
    sessionCode: manifest.sessionCode,
    displayCode: manifest.displayCode,
    sessionName: manifest.sessionName,
    exportedAt: manifest.exportedAt,
    importKey,
    importedAt: new Date().toISOString()
  };

  const types = ["Actor", "Item", "Scene", "JournalEntry"];
  /** @type {Record<string, Folder>} */
  const folders = {};
  for (const type of types) {
    folders[type] = await ensureFolder(type, name, meta, options);
  }
  return { name, folders, meta };
}

/**
 * Turn navigation off for every Scene not in the keep set.
 * @param {Set<string>} keepSceneIds
 */
export async function setExclusiveSceneNavigation(keepSceneIds) {
  const updates = [];
  for (const scene of game.scenes) {
    const shouldNav = keepSceneIds.has(scene.id);
    if (Boolean(scene.navigation) !== shouldNav) {
      updates.push({ _id: scene.id, navigation: shouldNav });
    }
  }
  if (updates.length) {
    await Scene.updateDocuments(updates);
  }
}

/** Session scenes that belong in the nav bar (Leftovers stays GM-only). */
export function navSceneIdsFor(scenes) {
  return new Set(
    [...(scenes ?? [])]
      .filter((scene) => scene?.flags?.[FLAG_SCOPE]?.kind !== "leftovers")
      .map((scene) => scene.id)
  );
}
