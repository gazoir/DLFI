/**
 * Imported session management: list, activate, bulk delete, replace-on-reimport.
 *
 * Imported sessions are identified by root Folders (Actor / Item / Scene / JournalEntry)
 * carrying `flags.dlfi.sessionCode` (written by `ensureSessionFolders`).
 */

import {
  DEFAULT_IMPORTS_PATH,
  FLAG_SCOPE,
  MODULE_ID,
  SETTING_IMPORTS,
  SETTING_LIVE_SESSION,
  setSetting,
  setting
} from "../constants.mjs";
import { setExclusiveSceneNavigation } from "./folders.mjs";
import { deleteDataFile, normalizeDataPath } from "../package/dataFolders.mjs";
import { getFilePicker, isNotFoundError } from "../package/filePicker.mjs";
import { resolveImportedSessionThumbUrl } from "./resolveLandingArt.mjs";
import { softSeatPlayersFromSessionDocs } from "./softSeatPlayers.mjs";

const SESSION_FOLDER_TYPES = ["Actor", "Item", "Scene", "JournalEntry"];
const EXPORT_STAMP = /^\d{4}-\d{2}-\d{2}T/;

/** Live-session setting value for a session code + export stamp (matches `sessionKey`). */
export function liveKeyFor(sessionCode, exportedAt) {
  return `${sessionCode}::${exportedAt}`;
}

/** True when the live setting points at this session code. */
export function isLiveSession(liveKey, sessionCode) {
  return Boolean(liveKey) && String(liveKey).startsWith(`${sessionCode}::`);
}

/**
 * Does a document `flags.dlfi.importKey` belong to this session code?
 * Keys look like `SESSION_014_2026-11-20T10-00-00-000Z`.
 */
export function importKeyBelongsToSession(importKey, sessionCode) {
  const key = String(importKey ?? "");
  const prefix = `${sessionCode}_`;
  return Boolean(sessionCode) && key.startsWith(prefix) && EXPORT_STAMP.test(key.slice(prefix.length));
}

/** Directory name prefix used under the imports root for a session's asset trees. */
export function sessionAssetDirPrefix(sessionCode) {
  const code = String(sessionCode ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, "_");
  return `${code}__`;
}

/** Is `dirPath` (Data-relative) an imports tree for this session (`{sessionCode}__*`)? */
export function isSessionAssetDir(dirPath, sessionCode) {
  const base = normalizeDataPath(dirPath).split("/").pop() ?? "";
  const prefix = sessionAssetDirPrefix(sessionCode);
  return prefix.length > 2 && base.toLowerCase().startsWith(prefix.toLowerCase());
}

function folderId(ref) {
  return ref?.id ?? ref ?? null;
}

/**
 * Group imported-session root folders by sessionCode.
 * @param {Array<{ id: string, type: string, name: string, flags?: object, folder?: any }>} folders
 * @param {{ liveKey?: string }} [options]
 */
export function groupSessionFolders(folders, { liveKey = "" } = {}) {
  /** @type {Map<string, any>} */
  const bySession = new Map();
  for (const folder of folders) {
    const meta = folder.flags?.[FLAG_SCOPE];
    if (!meta?.sessionCode || !SESSION_FOLDER_TYPES.includes(folder.type)) {
      continue;
    }
    const code = String(meta.sessionCode);
    const row = bySession.get(code) ?? {
      sessionCode: code,
      displayCode: meta.displayCode ?? code,
      sessionName: meta.sessionName ?? folder.name,
      exportedAt: meta.exportedAt ?? "",
      importedAt: meta.importedAt ?? "",
      importKeys: [],
      folderIds: [],
      folders: []
    };
    row.folders.push(folder);
    row.folderIds.push(folder.id);
    if (meta.importKey && !row.importKeys.includes(meta.importKey)) {
      row.importKeys.push(meta.importKey);
    }
    if (String(meta.importedAt ?? "") >= String(row.importedAt ?? "")) {
      row.importedAt = meta.importedAt ?? row.importedAt;
      row.exportedAt = meta.exportedAt ?? row.exportedAt;
      row.displayCode = meta.displayCode ?? row.displayCode;
      row.sessionName = meta.sessionName ?? row.sessionName;
    }
    bySession.set(code, row);
  }

  const sessions = [...bySession.values()].map((row) => ({
    ...row,
    isLive: isLiveSession(liveKey, row.sessionCode),
    liveKey: liveKeyFor(row.sessionCode, row.exportedAt)
  }));
  sessions.sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
  return sessions;
}

function allFolderIds(session) {
  const ids = new Set(session.folderIds);
  for (const folder of session.folders ?? []) {
    for (const sub of folder.getSubfolders?.(true) ?? []) {
      ids.add(sub.id);
    }
  }
  return ids;
}

function belongsToSession(doc, session, ids) {
  const parent = folderId(doc.folder);
  if (parent && ids.has(parent)) {
    return true;
  }
  return importKeyBelongsToSession(doc.flags?.[FLAG_SCOPE]?.importKey, session.sessionCode);
}

/**
 * World documents belonging to an imported session.
 * Character actors (PCs) are reported separately and never deleted.
 */
export function collectSessionDocuments(session, world = game) {
  const ids = allFolderIds(session);
  const pick = (collection) => [...(collection ?? [])].filter((doc) => belongsToSession(doc, session, ids));
  const actors = pick(world.actors);
  return {
    scenes: pick(world.scenes),
    actors: actors.filter((actor) => actor.type !== "character"),
    pcs: actors.filter((actor) => actor.type === "character"),
    items: pick(world.items),
    journals: pick(world.journal)
  };
}

/** List imported sessions with document counts, newest import first. */
export function listImportedSessions(world = game) {
  const liveKey = (() => {
    try {
      return setting(SETTING_LIVE_SESSION);
    } catch (_error) {
      return "";
    }
  })();
  const sessions = groupSessionFolders([...(world.folders ?? [])], { liveKey });
  return sessions.map((session) => {
    const docs = collectSessionDocuments(session, world);
    const landing = docs.scenes.find((scene) => scene.flags?.[FLAG_SCOPE]?.kind === "landing") ?? null;
    const thumbUrl = resolveImportedSessionThumbUrl(landing);
    const title = `${session.displayCode} · ${session.sessionName}`;
    const countsTooltip =
      `${docs.scenes.length} scenes · ${docs.actors.length} actors · ${docs.pcs.length} PCs · ` +
      `${docs.items.length} items · ${docs.journals.length} journals`;
    return {
      ...session,
      folders: undefined,
      title,
      counts: {
        scenes: docs.scenes.length,
        actors: docs.actors.length,
        pcs: docs.pcs.length,
        items: docs.items.length,
        journals: docs.journals.length
      },
      countsTooltip,
      thumbUrl,
      landingId: landing?.id ?? null
    };
  });
}

/**
 * Switch the world to an already-imported session: exclusive navigation,
 * Landing scene active, live-session setting updated. No re-import.
 * @param {string} sessionCode
 */
export async function activateImportedSession(sessionCode, world = game) {
  const session = findSession(sessionCode, world);
  if (!session) {
    throw new Error(`No imported session found for ${sessionCode}.`);
  }
  const docs = collectSessionDocuments(session, world);
  if (!docs.scenes.length) {
    throw new Error(`Imported session ${session.displayCode} has no scenes to activate.`);
  }
  await setExclusiveSceneNavigation(new Set(docs.scenes.map((scene) => scene.id)));
  const landing =
    docs.scenes.find((scene) => scene.flags?.[FLAG_SCOPE]?.kind === "landing") ?? docs.scenes[0];
  await landing.activate();
  await setSetting(SETTING_LIVE_SESSION, session.liveKey);
  let softSeat = null;
  try {
    softSeat = await softSeatPlayersFromSessionDocs(docs, { world });
  } catch (error) {
    console.warn(`${MODULE_ID} | soft-seat after activate failed`, error);
  }
  return {
    session,
    landingId: landing.id,
    sceneIds: docs.scenes.map((scene) => scene.id),
    softSeat
  };
}

function findSession(sessionCode, world = game) {
  const liveKey = setting(SETTING_LIVE_SESSION);
  return (
    groupSessionFolders([...(world.folders ?? [])], { liveKey }).find(
      (session) => session.sessionCode === sessionCode
    ) ?? null
  );
}

async function deleteIds(documentClass, docs) {
  const ids = docs.map((doc) => doc.id);
  if (!ids.length) {
    return 0;
  }
  await documentClass.deleteDocuments(ids);
  return ids.length;
}

/**
 * Delete world documents + folders for one imported session (PCs are kept and moved to root).
 */
export async function purgeSessionDocuments(sessionCode, world = game) {
  const session = findSession(sessionCode, world);
  if (!session) {
    return null;
  }
  const docs = collectSessionDocuments(session, world);
  const summary = {
    sessionCode,
    displayCode: session.displayCode,
    scenes: await deleteIds(Scene, docs.scenes),
    actors: await deleteIds(Actor, docs.actors),
    items: await deleteIds(Item, docs.items),
    journals: await deleteIds(JournalEntry, docs.journals),
    keptPcs: docs.pcs.length,
    folders: 0
  };

  // Deepest folders first; contents already removed except kept PCs (re-parent to root).
  const folders = session.folders
    .flatMap((folder) => [folder, ...(folder.getSubfolders?.(true) ?? [])])
    .filter((folder, index, list) => list.findIndex((other) => other.id === folder.id) === index);
  const depth = (folder) => {
    let count = 0;
    let parent = folderId(folder.folder);
    while (parent) {
      count += 1;
      parent = folderId(world.folders.get?.(parent)?.folder);
    }
    return count;
  };
  folders.sort((a, b) => depth(b) - depth(a));
  for (const folder of folders) {
    const stillThere = world.folders.get ? world.folders.get(folder.id) : folder;
    if (!stillThere) {
      continue;
    }
    try {
      await stillThere.delete({ deleteSubfolders: false, deleteContents: false });
      summary.folders += 1;
    } catch (error) {
      console.warn(`${MODULE_ID} | could not delete folder ${folder.name}`, error);
    }
  }

  if (isLiveSession(setting(SETTING_LIVE_SESSION), sessionCode)) {
    await setSetting(SETTING_LIVE_SESSION, "");
  }
  return summary;
}

/**
 * Remove `{importsPath}/{sessionCode}__*` trees. Foundry has no official file-delete API, so
 * this is best-effort: when the first delete fails the rest are skipped and reported.
 * @returns {Promise<{ dirs: string[], filesDeleted: number, filesSkipped: number, remainingDirs: string[] }>}
 */
export async function purgeSessionAssets(sessionCode, importsPath) {
  const root = normalizeDataPath(importsPath || setting(SETTING_IMPORTS) || DEFAULT_IMPORTS_PATH);
  const result = { dirs: [], filesDeleted: 0, filesSkipped: 0, remainingDirs: [] };
  let browse;
  try {
    browse = await getFilePicker().browse("data", root);
  } catch (_error) {
    return result;
  }
  const dirs = (browse.dirs ?? []).filter((dir) => isSessionAssetDir(dir, sessionCode));
  let deleteWorks = true;

  async function removeTree(dir) {
    let listing;
    try {
      listing = await getFilePicker().browse("data", dir);
    } catch (error) {
      if (!isNotFoundError(error)) {
        console.debug(`${MODULE_ID} | could not browse ${dir} during purge`, error);
      }
      return;
    }
    for (const file of listing.files ?? []) {
      if (!deleteWorks) {
        result.filesSkipped += 1;
        continue;
      }
      if (await deleteDataFile(file)) {
        result.filesDeleted += 1;
      } else {
        deleteWorks = false;
        result.filesSkipped += 1;
      }
    }
    for (const sub of listing.dirs ?? []) {
      await removeTree(sub);
    }
    if (deleteWorks) {
      await deleteDataFile(dir);
    }
  }

  for (const dir of dirs) {
    result.dirs.push(dir);
    await removeTree(dir);
    try {
      await getFilePicker().browse("data", dir);
      result.remainingDirs.push(dir);
    } catch (_error) {
      /* directory is gone */
    }
  }
  return result;
}

/**
 * Bulk delete imported sessions (world folders/docs, and optionally their asset trees).
 * @param {string[]} sessionCodes
 * @param {{ deleteAssets?: boolean, importsPath?: string }} [options]
 */
export async function deleteImportedSessions(sessionCodes, options = {}) {
  const { deleteAssets = true, importsPath } = options;
  const results = [];
  for (const code of sessionCodes) {
    const docs = await purgeSessionDocuments(code);
    const assets = deleteAssets ? await purgeSessionAssets(code, importsPath) : null;
    results.push({ sessionCode: code, docs, assets });
  }
  return results;
}

/** Human-readable summary line for a bulk delete. */
export function describeDeleteResults(results) {
  const totals = { sessions: 0, scenes: 0, actors: 0, items: 0, journals: 0, keptPcs: 0, remaining: 0 };
  for (const row of results) {
    if (row.docs) {
      totals.sessions += 1;
      totals.scenes += row.docs.scenes;
      totals.actors += row.docs.actors;
      totals.items += row.docs.items;
      totals.journals += row.docs.journals;
      totals.keptPcs += row.docs.keptPcs;
    }
    totals.remaining += row.assets?.remainingDirs?.length ?? 0;
  }
  let text =
    `Deleted ${totals.sessions} session(s): ${totals.scenes} scenes, ${totals.actors} actors, ` +
    `${totals.items} items, ${totals.journals} journals.`;
  if (totals.keptPcs) {
    text += ` Kept ${totals.keptPcs} PC actor(s) (moved to the Actors root).`;
  }
  if (totals.remaining) {
    text += ` ${totals.remaining} asset folder(s) under Data could not be removed by Foundry — delete them manually.`;
  }
  return text;
}
