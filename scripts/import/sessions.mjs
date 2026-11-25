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
import { navSceneIdsFor, setExclusiveSceneNavigation } from "./folders.mjs";
import { deleteDataFile, normalizeDataPath } from "../package/dataFolders.mjs";
import { getFilePicker, isNotFoundError } from "../package/filePicker.mjs";
import { resolveImportedSessionThumbUrl } from "./resolveLandingArt.mjs";
import {
  isDlfiCreatedPileActor,
  isDlfiItemPileActor,
  tokenActorId
} from "./scenePlacement.mjs";
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

/**
 * Session codes a world document belongs to: its folder, its importKey, an Item
 * Pile `sessionCode`, or PC membership in `flags.dlfi.sessionCodes` (a PC reused
 * across sessions keeps the importKey of its first import).
 * @param {object} doc
 * @param {Map<string, string>} folderToCode
 * @param {string[]} codes
 * @returns {Set<string>}
 */
function sessionCodesForDoc(doc, folderToCode, codes) {
  const found = new Set();
  const parent = folderId(doc.folder);
  if (parent && folderToCode.has(parent)) {
    found.add(folderToCode.get(parent));
  }
  const flags = doc.flags?.[FLAG_SCOPE] ?? {};
  if (flags.importKey) {
    for (const code of codes) {
      if (importKeyBelongsToSession(flags.importKey, code)) {
        found.add(code);
      }
    }
  }
  if (flags.kind === "item-pile" && flags.sessionCode && codes.includes(String(flags.sessionCode))) {
    found.add(String(flags.sessionCode));
  }
  for (const code of Array.isArray(flags.sessionCodes) ? flags.sessionCodes : []) {
    if (codes.includes(String(code))) {
      found.add(String(code));
    }
  }
  return found;
}

/**
 * True when this actor is a seated PC that must survive session delete.
 * Item Pile actors (even if typed as "character" by the Item Piles setting) are never PCs.
 */
export function isSessionProtectedPc(actor) {
  if (!actor || actor.type !== "character") {
    return false;
  }
  return !isDlfiItemPileActor(actor);
}

/**
 * DLFI-created Item Pile world Actors referenced by tokens on session scenes
 * (covers piles that lost their folder). Piles stamped for another session are skipped.
 * @param {Iterable<object>} scenes
 * @param {object} [world]
 * @param {string|null} [sessionCode]
 * @returns {object[]}
 */
export function collectItemPileActorsFromScenes(scenes, world = game, sessionCode = null) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const scene of scenes ?? []) {
    const tokens = [...(scene?.tokens?.contents ?? scene?.tokens ?? [])];
    for (const token of tokens) {
      const actorId = tokenActorId(token);
      if (!actorId || byId.has(actorId)) {
        continue;
      }
      const actor = world?.actors?.get?.(actorId) ?? null;
      if (!actor || !isDlfiCreatedPileActor(actor)) {
        continue;
      }
      const flags = actor.flags?.[FLAG_SCOPE] ?? {};
      const otherSession =
        sessionCode &&
        ((flags.sessionCode && String(flags.sessionCode) !== String(sessionCode)) ||
          (!flags.sessionCode &&
            flags.importKey &&
            !importKeyBelongsToSession(flags.importKey, sessionCode)));
      if (!otherSession) {
        byId.set(actorId, actor);
      }
    }
  }
  return [...byId.values()];
}

/**
 * One pass over the world: documents per imported session code.
 * Character actors (PCs) are reported separately and never deleted.
 * @param {Array<{ sessionCode: string, folderIds: string[], folders?: object[] }>} sessions
 * @param {object} [world]
 * @returns {Map<string, { scenes: object[], actors: object[], pcs: object[], items: object[], journals: object[] }>}
 */
export function buildSessionIndex(sessions, world = game) {
  const codes = sessions.map((session) => String(session.sessionCode));
  /** @type {Map<string, string>} */
  const folderToCode = new Map();
  for (const session of sessions) {
    for (const id of allFolderIds(session)) {
      folderToCode.set(id, String(session.sessionCode));
    }
  }
  const empty = () => ({ scenes: [], actors: [], items: [], journals: [] });
  /** @type {Map<string, ReturnType<typeof empty>>} */
  const raw = new Map(codes.map((code) => [code, empty()]));
  const sweep = (collection, key) => {
    for (const doc of collection ?? []) {
      for (const code of sessionCodesForDoc(doc, folderToCode, codes)) {
        raw.get(code)?.[key].push(doc);
      }
    }
  };
  sweep(world.scenes, "scenes");
  sweep(world.actors, "actors");
  sweep(world.items, "items");
  sweep(world.journal, "journals");

  /** @type {Map<string, any>} */
  const index = new Map();
  for (const code of codes) {
    const docs = raw.get(code);
    const actorById = new Map(docs.actors.map((actor) => [actor.id, actor]));
    for (const pile of collectItemPileActorsFromScenes(docs.scenes, world, code)) {
      if (!actorById.has(pile.id)) {
        actorById.set(pile.id, pile);
      }
    }
    const allActors = [...actorById.values()];
    index.set(code, {
      scenes: docs.scenes,
      actors: allActors.filter((actor) => !isSessionProtectedPc(actor)),
      pcs: allActors.filter((actor) => isSessionProtectedPc(actor)),
      items: docs.items,
      journals: docs.journals
    });
  }
  return index;
}

/** World documents belonging to one imported session. */
export function collectSessionDocuments(session, world = game) {
  return buildSessionIndex([session], world).get(String(session.sessionCode));
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
  const index = buildSessionIndex(sessions, world);
  return sessions.map((session) => {
    const docs = index.get(String(session.sessionCode));
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
  await setExclusiveSceneNavigation(navSceneIdsFor(docs.scenes));
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

export function findSession(sessionCode, world = game) {
  const liveKey = setting(SETTING_LIVE_SESSION);
  return (
    groupSessionFolders([...(world.folders ?? [])], { liveKey }).find(
      (session) => session.sessionCode === sessionCode
    ) ?? null
  );
}

/** Seated PC actors for the currently Live imported session (or empty). */
export function liveSessionPcActors(world = game) {
  const liveKey = setting(SETTING_LIVE_SESSION);
  const sessions = groupSessionFolders([...(world.folders ?? [])], { liveKey });
  const live = sessions.find((session) => isLiveSession(liveKey, session.sessionCode));
  if (!live) {
    return [];
  }
  return collectSessionDocuments(live, world).pcs;
}

async function deleteIds(documentClass, collection, docs) {
  const ids = docs
    .map((doc) => doc.id)
    .filter((id) => id && (typeof collection?.get !== "function" || collection.get(id)));
  if (!ids.length) {
    return 0;
  }
  await documentClass.deleteDocuments(ids);
  return ids.length;
}

/**
 * Freeze the documents + folders of an imported session so they can be purged
 * later without touching anything created afterwards (replace-on-reimport).
 * @param {string} sessionCode
 * @returns {{ session: object, docs: ReturnType<typeof collectSessionDocuments>, folders: object[] }|null}
 */
export function snapshotSessionDocuments(sessionCode, world = game) {
  const session = findSession(sessionCode, world);
  if (!session) {
    return null;
  }
  const folders = session.folders
    .flatMap((folder) => [folder, ...(folder.getSubfolders?.(true) ?? [])])
    .filter((folder, index, list) => list.findIndex((other) => other.id === folder.id) === index);
  return { session, docs: collectSessionDocuments(session, world), folders };
}

/** Folder ids captured by {@link snapshotSessionDocuments}. */
export function snapshotFolderIds(snapshot) {
  return new Set((snapshot?.folders ?? []).map((folder) => folder.id));
}

async function deleteFoldersDeepestFirst(folders, world) {
  const depth = (folder) => {
    let count = 0;
    let parent = folderId(folder.folder);
    while (parent) {
      count += 1;
      parent = folderId(world.folders.get?.(parent)?.folder);
    }
    return count;
  };
  let deleted = 0;
  for (const folder of [...folders].sort((a, b) => depth(b) - depth(a))) {
    const stillThere = world.folders.get ? world.folders.get(folder.id) : folder;
    if (!stillThere) {
      continue;
    }
    try {
      await stillThere.delete({ deleteSubfolders: false, deleteContents: false });
      deleted += 1;
    } catch (error) {
      console.warn(`${MODULE_ID} | could not delete folder ${folder.name}`, error);
    }
  }
  return deleted;
}

/**
 * Delete exactly the documents + folders captured in a snapshot (PC actors are kept).
 * @param {ReturnType<typeof snapshotSessionDocuments>} snapshot
 * @param {{ clearLive?: boolean }} [options]
 */
export async function purgeSnapshot(snapshot, world = game, { clearLive = true } = {}) {
  if (!snapshot) {
    return null;
  }
  const { session, docs, folders } = snapshot;
  const summary = {
    sessionCode: session.sessionCode,
    displayCode: session.displayCode,
    scenes: await deleteIds(Scene, world.scenes, docs.scenes),
    actors: await deleteIds(Actor, world.actors, docs.actors),
    items: await deleteIds(Item, world.items, docs.items),
    journals: await deleteIds(JournalEntry, world.journal, docs.journals),
    keptPcs: docs.pcs.length,
    folders: 0
  };
  summary.folders = await deleteFoldersDeepestFirst(folders, world);
  if (clearLive && isLiveSession(setting(SETTING_LIVE_SESSION), session.sessionCode)) {
    await setSetting(SETTING_LIVE_SESSION, "");
  }
  return summary;
}

/**
 * Delete world documents + folders for one imported session (PC actors are kept).
 */
export async function purgeSessionDocuments(sessionCode, world = game) {
  return purgeSnapshot(snapshotSessionDocuments(sessionCode, world), world);
}

/**
 * Undo a failed import: delete every non-PC document tagged with `importKey` or
 * filed under the new import's folders, then those folders. Documents captured
 * in `keepIds` (the previous import when the same export is re-imported) survive.
 * @param {string} importKey
 * @param {Iterable<object>} newFolders
 * @param {{ keepIds?: Set<string> }} [options]
 */
export async function rollbackImport(importKey, newFolders, { keepIds = new Set() } = {}, world = game) {
  const folders = [...(newFolders ?? [])]
    .filter(Boolean)
    .flatMap((folder) => [folder, ...(folder.getSubfolders?.(true) ?? [])]);
  const folderIds = new Set(folders.map((folder) => folder.id));
  const created = (collection) =>
    [...(collection ?? [])].filter((doc) => {
      if (!doc?.id || keepIds.has(doc.id)) {
        return false;
      }
      const parent = folderId(doc.folder);
      return (parent && folderIds.has(parent)) || doc.flags?.[FLAG_SCOPE]?.importKey === importKey;
    });
  const summary = {
    scenes: await deleteIds(Scene, world.scenes, created(world.scenes)),
    actors: await deleteIds(
      Actor,
      world.actors,
      created(world.actors).filter((actor) => !isSessionProtectedPc(actor))
    ),
    items: await deleteIds(Item, world.items, created(world.items)),
    journals: await deleteIds(JournalEntry, world.journal, created(world.journal)),
    folders: 0
  };
  summary.folders = await deleteFoldersDeepestFirst(
    folders.filter((folder) => !keepIds.has(folder.id)),
    world
  );
  return summary;
}

/** Every document id in a snapshot (folders included). */
export function snapshotIds(snapshot) {
  const ids = snapshotFolderIds(snapshot);
  for (const list of Object.values(snapshot?.docs ?? {})) {
    for (const doc of list ?? []) {
      if (doc?.id) ids.add(doc.id);
    }
  }
  return ids;
}

/**
 * Remove `{importsPath}/{sessionCode}__*` trees. Foundry V14 has no file-delete API: in
 * that case nothing is browsed beyond the imports root and the session's folders are
 * reported back so the GM can clear them by hand.
 * @param {string} sessionCode
 * @param {string} importsPath
 * @param {{ exceptDirs?: string[] }} [options]
 * @returns {Promise<{ dirs: string[], filesDeleted: number, filesSkipped: number, remainingDirs: string[], deleteUnsupported?: boolean }>}
 */
export async function purgeSessionAssets(sessionCode, importsPath, { exceptDirs = [] } = {}) {
  const root = normalizeDataPath(importsPath || setting(SETTING_IMPORTS) || DEFAULT_IMPORTS_PATH);
  const result = { dirs: [], filesDeleted: 0, filesSkipped: 0, remainingDirs: [] };
  const except = new Set(exceptDirs.map((dir) => normalizeDataPath(dir)));
  let browse;
  try {
    browse = await getFilePicker().browse("data", root);
  } catch (_error) {
    return result;
  }
  const dirs = (browse.dirs ?? [])
    .map((dir) => normalizeDataPath(dir))
    .filter((dir) => isSessionAssetDir(dir, sessionCode) && !except.has(dir));
  if (typeof getFilePicker().deletePath !== "function") {
    result.dirs = dirs;
    result.remainingDirs = [...dirs];
    result.deleteUnsupported = true;
    return result;
  }
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
    if (!deleteWorks) {
      result.remainingDirs.push(dir);
      continue;
    }
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
  const remainingDirs = [];
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
    remainingDirs.push(...(row.assets?.remainingDirs ?? []));
  }
  let text =
    `Deleted ${totals.sessions} session(s): ${totals.scenes} scenes, ${totals.actors} actors, ` +
    `${totals.items} items, ${totals.journals} journals.`;
  if (totals.keptPcs) {
    text += ` Kept ${totals.keptPcs} PC actor(s) in the Damned Lucky folder.`;
  }
  if (totals.remaining) {
    text +=
      ` ${totals.remaining} asset folder(s) under Data could not be removed by Foundry — delete them manually: ` +
      remainingDirs.map((dir) => `Data/${dir}`).join(", ");
  }
  return text;
}
