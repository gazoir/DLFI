/**
 * Foundry Data/ folder helpers for DLCE inbox + DLFI imports.
 */

import { MODULE_ID } from "../constants.mjs";

/**
 * Ensure a Data/ folder path exists (create parents as needed).
 * @param {string} folderPath e.g. "dlce-inbox" or "dlfi-imports/SESSION_014/…"
 */
export async function ensureDataFolder(folderPath) {
  const normalized = normalizeDataPath(folderPath);
  if (!normalized) {
    return "";
  }
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await FilePicker.createDirectory("data", current, { notify: false });
    } catch (error) {
      const message = String(error?.message ?? error ?? "");
      if (/exist|EEXIST|already/i.test(message)) {
        continue;
      }
      try {
        await FilePicker.browse("data", current);
      } catch (browseError) {
        console.warn(`${MODULE_ID} | could not ensure folder ${current}`, error, browseError);
        throw error;
      }
    }
  }
  return normalized;
}

export function normalizeDataPath(path) {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** Safe single path segment for Data/ folders and filenames. */
export function safeSegment(value, fallback = "item") {
  const cleaned = String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return cleaned || fallback;
}

/**
 * Inbox subfolder for a session: "SESSION_014 · Misty Lake"
 */
export function sessionInboxFolderName(manifest) {
  const code = safeSegment(manifest?.displayCode || manifest?.sessionCode, "SESSION");
  const name = safeSegment(manifest?.sessionName, "Untitled");
  return `${code} · ${name}`;
}

/**
 * Import root matching typical DLCE zip folder naming:
 * `{sessionCode}__{slugName}__{exportStamp}`
 */
export function packageImportRoot(manifest, sourceLabel = "") {
  const fromLabel = String(sourceLabel ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/\.zip$/i, "");
  if (fromLabel && /__/.test(fromLabel) && fromLabel.includes(String(manifest?.sessionCode ?? ""))) {
    return safeSegment(fromLabel, fromLabel).replace(/\s+/g, "_");
  }
  const code = safeSegment(manifest?.sessionCode, "SESSION").replace(/\s+/g, "_");
  const slug = safeSegment(manifest?.sessionName, "session")
    .replace(/\s+/g, "_")
    .replace(/[^\w.-]+/g, "");
  const stamp = String(manifest?.exportedAt ?? Date.now()).replace(/[:.]/g, "-");
  return `${code}__${slug}__${stamp}`;
}

/**
 * Open a Foundry folder picker and return the chosen Data-relative path.
 * @param {string} current
 * @returns {Promise<string|null>}
 */
export function pickDataFolder(current = "") {
  return new Promise((resolve) => {
    const FP = foundry.applications?.apps?.FilePicker ?? globalThis.FilePicker;
    let settled = false;
    const finish = (path) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(path == null ? null : normalizeDataPath(path));
    };
    try {
      const picker = new FP({
        type: "folder",
        current: normalizeDataPath(current) || "",
        callback: (path) => finish(path),
        // If the user closes without picking, ApplicationV2 close may not call callback.
      });
      const originalClose = picker.close?.bind(picker);
      if (originalClose) {
        picker.close = async (options) => {
          const result = await originalClose(options);
          finish(null);
          return result;
        };
      }
      picker.render(true);
    } catch (error) {
      console.error(`${MODULE_ID} | folder picker failed`, error);
      finish(null);
    }
  });
}

/**
 * Best-effort delete of a Data/ file. Foundry versions vary; failures are logged.
 * @param {string} path
 */
export async function deleteDataFile(path) {
  const target = normalizeDataPath(path);
  if (!target) {
    return false;
  }
  try {
    if (typeof FilePicker.deletePath === "function") {
      await FilePicker.deletePath("data", target);
      return true;
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | FilePicker.deletePath failed for ${target}`, error);
  }
  try {
    const response = await fetch(foundry.utils.getRoute("filesystem"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "deleteFiles",
        source: "data",
        paths: [target]
      })
    });
    if (response.ok) {
      return true;
    }
    console.warn(`${MODULE_ID} | filesystem delete failed for ${target}`, response.status);
  } catch (error) {
    console.warn(`${MODULE_ID} | could not delete ${target}`, error);
  }
  return false;
}

/**
 * Upload bytes as a file into a Data/ folder (creates the folder first).
 * @returns {Promise<string|null>} Data-relative path on success
 */
export async function uploadDataFile(folderPath, fileName, bytes, { contentType } = {}) {
  const folder = await ensureDataFolder(folderPath);
  const name = String(fileName || "file.bin").replace(/[\\/]+/g, "_");
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: contentType || "application/octet-stream" });
  const file = new File([blob], name, { type: blob.type || contentType || "application/octet-stream" });
  try {
    await FilePicker.upload("data", folder, file, {}, { notify: false });
  } catch (_error) {
    await FilePicker.upload("data", folder, file, { notify: false });
  }
  return folder ? `${folder}/${name}` : name;
}
