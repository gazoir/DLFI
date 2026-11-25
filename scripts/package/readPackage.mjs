import { MODULE_ID, PACKAGE_FORMAT_VERSIONS, notify } from "../constants.mjs";
import { resolveSessionThumbPackagePath } from "../import/resolveLandingArt.mjs";
import { encodeDataPathForUrl, isSafePackagePath, normalizeDataPath } from "./dataFolders.mjs";
import { getFilePicker } from "./filePicker.mjs";
import {
  entryDataFromLocal,
  findEndOfCentralDirectory,
  normalizePackageFiles,
  parseCentralDirectory,
  readStoreZip,
  ZIP_TAIL_MAX
} from "./storeZip.mjs";

/**
 * @typedef {object} LoadedPackage
 * @property {string} sourceLabel
 * @property {object} manifest
 * @property {Map<string, Uint8Array>} files  // paths relative to package root
 */

function decodeJson(bytes) {
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest.json missing or invalid");
  }
  const version = Number(manifest.packageFormatVersion);
  if (!PACKAGE_FORMAT_VERSIONS.has(version)) {
    notify(
      `DLFI: packageFormatVersion ${version} (supported ${[...PACKAGE_FORMAT_VERSIONS].join(", ")}). Trying anyway.`,
      { type: "warning" }
    );
  }
  if (!manifest.sessionCode || !manifest.exportedAt) {
    throw new Error("manifest.json missing sessionCode or exportedAt");
  }
  return manifest;
}

/**
 * Load a package from an in-memory STORE zip.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} sourceLabel
 * @returns {LoadedPackage}
 */
export function loadPackageFromZipBytes(buffer, sourceLabel = "zip") {
  const raw = readStoreZip(buffer);
  const { root, files } = normalizePackageFiles(raw);
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) {
    throw new Error(`No manifest.json in ${sourceLabel}${root ? ` (root ${root})` : ""}`);
  }
  const manifest = validateManifest(decodeJson(manifestBytes));
  return { sourceLabel, manifest, files };
}

function dataFileUrl(dataPath) {
  return foundry.utils.getRoute(`/${encodeDataPathForUrl(dataPath)}`);
}

/**
 * Fetch a FilePicker data path as ArrayBuffer.
 * @param {string} dataPath path relative to Data/
 */
export async function fetchDataFile(dataPath) {
  const normalized = normalizeDataPath(dataPath);
  const response = await fetch(dataFileUrl(normalized), { method: "GET", cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Could not read ${normalized} (${response.status})`);
  }
  return response.arrayBuffer();
}

/**
 * Fetch a byte range. `partial` is false when the server ignored Range and sent the whole file.
 * @param {string} url
 * @param {string} range e.g. "bytes=-65557" or "bytes=100-199"
 */
async function fetchRange(url, range) {
  const response = await fetch(url, { method: "GET", cache: "no-cache", headers: { Range: range } });
  if (!response.ok) {
    throw new Error(`Could not read ${url} (${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const partial = response.status === 206;
  const total = partial
    ? Number(String(response.headers.get("Content-Range") ?? "").split("/").pop()) || null
    : bytes.length;
  return { bytes, partial, total };
}

/** @type {Map<string, { size: number|null, modified: string, summary: LoadedPackage }>} */
const inboxSummaryCache = new Map();

/**
 * Manifest + session thumbnail only, read with HTTP Range requests (central directory,
 * then the two entries). Cached by path, size and Last-Modified. Falls back to a full
 * load when the server does not honour Range. Use {@link loadPackageFromZipPath} to import.
 * @param {string} zipPath Data-relative
 * @returns {Promise<LoadedPackage & { partial: boolean, path: string }>}
 */
export async function loadPackageSummaryFromZipPath(zipPath) {
  const path = normalizeDataPath(zipPath);
  const url = dataFileUrl(path);
  let size = null;
  let modified = "";
  try {
    const head = await fetch(url, { method: "HEAD", cache: "no-cache" });
    if (head.ok) {
      size = Number(head.headers.get("Content-Length")) || null;
      modified = head.headers.get("Last-Modified") ?? "";
    }
  } catch (_error) {
    /* HEAD unsupported: no cache check */
  }
  const cached = inboxSummaryCache.get(path);
  if (cached && size != null && cached.size === size && cached.modified === modified) {
    return cached.summary;
  }

  const tail = await fetchRange(url, `bytes=-${ZIP_TAIL_MAX}`);
  let summary;
  if (!tail.partial) {
    summary = { ...loadPackageFromZipBytes(tail.bytes, path), partial: false, path };
  } else {
    summary = await summaryFromRanges(url, path, tail);
  }
  inboxSummaryCache.set(path, { size: size ?? tail.total, modified, summary });
  return summary;
}

async function summaryFromRanges(url, path, tail) {
  const eocd = findEndOfCentralDirectory(tail.bytes);
  if (!eocd || tail.total == null) {
    throw new Error(`No ZIP central directory in ${path}`);
  }
  const tailStart = tail.total - tail.bytes.length;
  const cdBytes =
    eocd.cdOffset >= tailStart
      ? tail.bytes.subarray(eocd.cdOffset - tailStart, eocd.cdOffset - tailStart + eocd.cdSize)
      : (await fetchRange(url, `bytes=${eocd.cdOffset}-${eocd.cdOffset + eocd.cdSize - 1}`)).bytes;
  /** @type {Map<string, ReturnType<typeof parseCentralDirectory>[number]>} */
  const byName = new Map();
  for (const entry of parseCentralDirectory(cdBytes)) {
    if (entry.name && !entry.name.endsWith("/") && isSafePackagePath(entry.name) && entry.method === 0) {
      byName.set(entry.name, entry);
    }
  }
  const { root, files: entries } = normalizePackageFiles(byName);

  const readEntry = async (entry) => {
    const slack = 30 + entry.nameLen + entry.extraLen + 256;
    let local = (await fetchRange(url, `bytes=${entry.localOffset}-${entry.localOffset + slack + entry.compSize - 1}`)).bytes;
    let data = entryDataFromLocal(local, entry);
    if (!data) {
      local = (await fetchRange(url, `bytes=${entry.localOffset}-${entry.localOffset + 30 + 0x1ffff + entry.compSize}`)).bytes;
      data = entryDataFromLocal(local, entry);
    }
    if (!data) {
      throw new Error(`Could not read ${entry.name} from ${path}`);
    }
    return data;
  };

  const manifestEntry = entries.get("manifest.json");
  if (!manifestEntry) {
    throw new Error(`No manifest.json in ${path}${root ? ` (root ${root})` : ""}`);
  }
  const manifest = validateManifest(decodeJson(await readEntry(manifestEntry)));
  /** @type {Map<string, Uint8Array|null>} */
  const files = new Map([...entries.keys()].map((key) => [key, null]));
  files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
  const thumbPath = resolveSessionThumbPackagePath(manifest, files);
  const thumbEntry = thumbPath ? entries.get(thumbPath) : null;
  if (thumbEntry) {
    try {
      files.set(thumbPath, await readEntry(thumbEntry));
    } catch (error) {
      console.warn(`${MODULE_ID} | inbox thumbnail read failed for ${path}`, error);
    }
  }
  return { sourceLabel: path, manifest, files, partial: true, path };
}

/**
 * Browse a Data/ folder via FilePicker.
 * @param {string} dataPath
 */
export async function browseDataFolder(dataPath) {
  const normalized = normalizeDataPath(dataPath);
  return getFilePicker().browse("data", normalized);
}

/**
 * Scan the DLCE inbox for Session Package zips (nested under Session Code · Name).
 * Creates the inbox root if missing. Unpacked folders are ignored — inbox is zip-only.
 * @param {string} inboxPath
 * @returns {Promise<Array<{ kind: "zip", path: string, name: string, sessionFolder?: string|null }>>}
 */
export async function listInboxCandidates(inboxPath) {
  const { listInboxZipCandidates } = await import("./inbox.mjs");
  return listInboxZipCandidates(inboxPath);
}

/**
 * Load package from an inbox zip path (Data-relative).
 * @param {string} zipPath
 * @returns {Promise<LoadedPackage>}
 */
export async function loadPackageFromZipPath(zipPath) {
  const buffer = await fetchDataFile(zipPath);
  return loadPackageFromZipBytes(buffer, zipPath);
}

/**
 * Load package from an unzipped folder under Data/.
 * @param {string} folderPath
 * @returns {Promise<LoadedPackage>}
 */
export async function loadPackageFromFolderPath(folderPath) {
  const files = new Map();

  async function walk(relDir, prefix = "") {
    const browse = await browseDataFolder(relDir);
    for (const filePath of browse.files ?? []) {
      const base = filePath.split("/").pop() ?? filePath;
      const packagePath = prefix ? `${prefix}/${base}` : base;
      const buffer = await fetchDataFile(filePath);
      files.set(packagePath.replace(/\\/g, "/"), new Uint8Array(buffer));
    }
    for (const dirPath of browse.dirs ?? []) {
      const base = dirPath.split("/").pop() ?? dirPath;
      const nextPrefix = prefix ? `${prefix}/${base}` : base;
      await walk(dirPath, nextPrefix);
    }
  }

  await walk(folderPath);
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) {
    throw new Error(`No manifest.json under ${folderPath}`);
  }
  const manifest = validateManifest(decodeJson(manifestBytes));
  return { sourceLabel: folderPath, manifest, files };
}

/**
 * Group loaded package summaries by sessionCode for the Import list.
 * @param {Array<{ path: string, kind: string, package: LoadedPackage }>} loaded
 */
export function groupPackagesBySession(loaded) {
  /** @type {Map<string, Array<{ path: string, kind: string, package: LoadedPackage }>>} */
  const byCode = new Map();
  for (const entry of loaded) {
    const code = entry.package.manifest.sessionCode;
    const list = byCode.get(code) ?? [];
    list.push(entry);
    byCode.set(code, list);
  }

  const sessions = [];
  for (const [sessionCode, versions] of byCode) {
    versions.sort((a, b) =>
      String(b.package.manifest.exportedAt).localeCompare(String(a.package.manifest.exportedAt))
    );
    const latest = versions[0];
    const thumbPackagePath = resolveSessionThumbPackagePath(
      latest.package.manifest,
      latest.package.files
    );
    sessions.push({
      sessionCode,
      displayCode: latest.package.manifest.displayCode,
      sessionName: latest.package.manifest.sessionName,
      partyLevel: latest.package.manifest.partyLevel,
      crLabel: latest.package.manifest.crLabel ?? null,
      sessionArt: latest.package.manifest.sessionArt ?? null,
      thumbPackagePath,
      latestExportedAt: latest.package.manifest.exportedAt,
      versions
    });
  }

  sessions.sort((a, b) => String(b.latestExportedAt).localeCompare(String(a.latestExportedAt)));
  return sessions;
}

/**
 * Flag inbox session rows whose newest zip is newer than the world's imported
 * copy of that sessionCode (`isNew: true`). Never-imported sessions are also New.
 *
 * @param {Array<{ sessionCode: string, latestExportedAt?: string }>} sessions
 * @param {Array<{ sessionCode: string, exportedAt?: string }>} imported
 * @returns {typeof sessions}
 */
export function markInboxSessionsNewerThanImported(sessions = [], imported = []) {
  const importedAt = new Map(
    (imported ?? []).map((row) => [String(row.sessionCode), String(row.exportedAt ?? "")])
  );
  for (const session of sessions ?? []) {
    const code = String(session.sessionCode ?? "");
    const inboxStamp = String(session.latestExportedAt ?? "");
    const worldStamp = importedAt.get(code);
    session.isNew = !worldStamp || (Boolean(inboxStamp) && inboxStamp > worldStamp);
  }
  return sessions;
}
