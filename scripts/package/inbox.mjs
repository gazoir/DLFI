/**
 * DLCE Session Package inbox: zip-only storage nested by session.
 */

import {
  INBOX_KEEP_PER_SESSION,
  MODULE_ID,
  SETTING_INBOX,
  setting
} from "../constants.mjs";
import {
  deleteDataFile,
  ensureDataFolder,
  normalizeDataPath,
  sessionInboxFolderName
} from "./dataFolders.mjs";
import { browseDataFolder } from "./readPackage.mjs";

/**
 * Ensure the configured inbox root exists.
 */
export async function ensureInboxRoot(inboxPath = setting(SETTING_INBOX)) {
  return ensureDataFolder(inboxPath || "dlce-inbox");
}

/**
 * Recursively find .zip files under the inbox (session subfolders + legacy top-level).
 * @returns {Promise<Array<{ kind: "zip", path: string, name: string, sessionFolder: string|null }>>}
 */
export async function listInboxZipCandidates(inboxPath = setting(SETTING_INBOX)) {
  const root = await ensureInboxRoot(inboxPath);
  const candidates = [];

  async function walk(dir, sessionFolder = null, depth = 0) {
    let browse;
    try {
      browse = await browseDataFolder(dir);
    } catch (error) {
      console.warn(`${MODULE_ID} | cannot browse inbox ${dir}`, error);
      return;
    }
    for (const file of browse.files ?? []) {
      if (!/\.zip$/i.test(file)) {
        continue;
      }
      const name = file.split("/").pop() ?? file;
      candidates.push({
        kind: "zip",
        path: normalizeDataPath(file),
        name,
        sessionFolder
      });
    }
    // Nest one level: inbox / {Session Code · Name} / *.zip
    if (depth >= 1) {
      return;
    }
    for (const sub of browse.dirs ?? []) {
      const folderName = sub.split("/").pop() ?? sub;
      await walk(sub, folderName, depth + 1);
    }
  }

  await walk(root, null, 0);
  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create `inbox/{Session Code · Name}/` for a session. Foundry's FilePicker.upload
 * rejects `.zip`, so a zip chosen with "Choose zip…" is imported from memory and not
 * copied here; drop zips into this folder via the OS to keep them in the inbox.
 * @param {object} manifest
 * @returns {Promise<string>} the session inbox folder (Data-relative)
 */
export async function ensureSessionInboxFolder(manifest) {
  const inbox = await ensureInboxRoot();
  const folder = `${inbox}/${sessionInboxFolderName(manifest)}`;
  try {
    await ensureDataFolder(folder);
  } catch (error) {
    console.warn(`${MODULE_ID} | could not prepare inbox folder ${folder}`, error);
  }
  return folder;
}

/**
 * Keep only the newest `keep` zip files in a session inbox folder.
 * Prefer lexicographic descending on filename (export stamps sort well).
 */
export async function pruneSessionInboxFolder(folderPath, keep = INBOX_KEEP_PER_SESSION) {
  const dir = normalizeDataPath(folderPath);
  let browse;
  try {
    browse = await browseDataFolder(dir);
  } catch (error) {
    console.warn(`${MODULE_ID} | prune browse failed for ${dir}`, error);
    return;
  }
  const zips = (browse.files ?? [])
    .filter((file) => /\.zip$/i.test(file))
    .map((file) => normalizeDataPath(file))
    .sort((a, b) => b.localeCompare(a));
  const excess = zips.slice(Math.max(0, keep));
  for (const path of excess) {
    const deleted = await deleteDataFile(path);
    console.log(`${MODULE_ID} | inbox prune ${deleted ? "deleted" : "left"} ${path}`);
  }
}
