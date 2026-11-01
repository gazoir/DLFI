import { FLAG_SCOPE, sessionFolderName } from "../constants.mjs";

/**
 * Ensure a root Folder of the given document type exists.
 * @param {string} type Actor|Item|Scene|JournalEntry|RollTable|Playlist|Cards|Adventure
 * @param {string} name
 * @param {object} [flags]
 */
export async function ensureFolder(type, name, flags = {}) {
  const existing = game.folders.find(
    (folder) => folder.type === type && folder.name === name && !folder.folder
  );
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
 * Create the standard folder set for one imported session.
 * @param {object} manifest
 * @param {string} importKey
 */
export async function ensureSessionFolders(manifest, importKey) {
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
    folders[type] = await ensureFolder(type, name, meta);
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
