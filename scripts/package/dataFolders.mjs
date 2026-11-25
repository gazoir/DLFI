/**
 * Foundry Data/ folder helpers for DLCE inbox + DLFI imports.
 */

import { MODULE_ID } from "../constants.mjs";
import { getFilePicker, isNotFoundError } from "./filePicker.mjs";

/**
 * Ensure a Data/ folder path exists (create parents as needed).
 * @param {string} folderPath e.g. "dlce-inbox" or "dlfi-imports/SESSION_014/…"
 * @param {{ cache?: Set<string> }} [options] folders already ensured this run (skipped and recorded)
 */
export async function ensureDataFolder(folderPath, { cache } = {}) {
  const normalized = normalizeDataPath(folderPath);
  if (!normalized) {
    return "";
  }
  if (cache?.has(normalized)) {
    return normalized;
  }
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (cache?.has(current)) {
      continue;
    }
    cache?.add(current);
    try {
      await getFilePicker().createDirectory("data", current, { notify: false });
    } catch (error) {
      const message = String(error?.message ?? error ?? "");
      if (/exist|EEXIST|already/i.test(message)) {
        continue;
      }
      try {
        await getFilePicker().browse("data", current);
      } catch (browseError) {
        cache?.delete(current);
        console.warn(`${MODULE_ID} | could not ensure folder ${current}`, error, browseError);
        throw error;
      }
    }
  }
  return normalized;
}

/** Data-relative path: forward slashes, no leading/trailing slash. */
export function normalizeDataPath(path) {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * True for a relative package path that cannot escape its root: no `..`, `.` or
 * empty segments, no leading slash, drive letter, or control characters.
 * @param {string} path
 */
export function isSafePackagePath(path) {
  const raw = String(path ?? "").replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-z]:/i.test(raw) || /[\u0000-\u001f]/.test(raw)) {
    return false;
  }
  const segments = raw.replace(/\/$/, "").split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

/** Encode each segment of a Data-relative path for use in a URL. */
export function encodeDataPathForUrl(path) {
  return normalizeDataPath(path)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
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
  const code = safeSegment(manifest?.sessionCode, "SESSION").replace(/\s+/g, "_");
  const labelRoot = fromLabel ? safeSegment(fromLabel, fromLabel).replace(/\s+/g, "_") : "";
  if (labelRoot && labelRoot.toLowerCase().startsWith(`${code}__`.toLowerCase())) {
    return labelRoot;
  }
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
    const FP = getFilePicker();
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

/** Once-per-session note when Foundry has no public Data/ delete API (V14+). */
let loggedDeleteUnsupported = false;

/**
 * Best-effort delete of a Data/ file.
 * Uses FilePicker.deletePath when present (Foundry ≤13). Foundry V14 removed
 * `/filesystem` and has no public delete API — do not POST that route (route
 * 404s spam the console and must not be treated as successful deletes).
 * @param {string} path
 * @returns {Promise<boolean>} true when deleted or already absent via deletePath
 */
export async function deleteDataFile(path) {
  const target = normalizeDataPath(path);
  if (!target) {
    return false;
  }
  const FP = getFilePicker();
  if (typeof FP.deletePath === "function") {
    try {
      await FP.deletePath("data", target);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        console.debug(`${MODULE_ID} | already gone (404): ${target}`);
        return true;
      }
      console.warn(`${MODULE_ID} | FilePicker.deletePath failed for ${target}`, error);
      return false;
    }
  }
  if (!loggedDeleteUnsupported) {
    loggedDeleteUnsupported = true;
    console.debug(
      `${MODULE_ID} | Data/ file delete unsupported (no FilePicker.deletePath; Foundry V14+ has no public delete API). Skipping deletes.`
    );
  }
  return false;
}

/**
 * Upload bytes as a file into a Data/ folder (creates the folder first).
 * FilePicker.upload reports most failures (size limit, disallowed extension) by
 * returning false/undefined/{} instead of throwing, so only a result with a path counts.
 * @param {string} folderPath
 * @param {string} fileName
 * @param {Uint8Array|Blob} bytes
 * @param {{ contentType?: string, cache?: Set<string> }} [options]
 * @returns {Promise<string|null>} Data-relative path on success, null on failure
 */
export async function uploadDataFile(folderPath, fileName, bytes, { contentType, cache } = {}) {
  const folder = await ensureDataFolder(folderPath, { cache });
  const name = String(fileName || "file.bin").replace(/[\\/]+/g, "_");
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: contentType || "application/octet-stream" });
  const file = new File([blob], name, { type: blob.type || contentType || "application/octet-stream" });
  const result = await getFilePicker().upload("data", folder, file, {}, { notify: false });
  if (!result?.path) {
    return null;
  }
  return normalizeDataPath(decodeURIComponentSafe(result.path));
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value));
  } catch (_error) {
    return String(value);
  }
}

/**
 * Run async jobs with at most `limit` in flight; results keep input order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}
