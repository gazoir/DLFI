import { MODULE_ID, PACKAGE_FORMAT_VERSION, notify } from "../constants.mjs";
import { normalizePackageFiles, readStoreZip } from "./storeZip.mjs";

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
  if (version !== PACKAGE_FORMAT_VERSION) {
    notify(
      `DLFI: packageFormatVersion ${version} (expected ${PACKAGE_FORMAT_VERSION}). Trying anyway.`,
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

/**
 * Fetch a FilePicker data path as ArrayBuffer.
 * @param {string} dataPath path relative to Data/
 */
export async function fetchDataFile(dataPath) {
  const normalized = dataPath.replace(/^\/+/, "");
  const url = foundry.utils.getRoute(`/${normalized}`);
  const response = await fetch(url, { method: "GET", cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Could not read ${normalized} (${response.status})`);
  }
  return response.arrayBuffer();
}

/**
 * Browse a Data/ folder via FilePicker.
 * @param {string} dataPath
 */
export async function browseDataFolder(dataPath) {
  const normalized = dataPath.replace(/^\/+|\/+$/g, "") || "";
  return FilePicker.browse("data", normalized);
}

/**
 * Scan inbox for package folders (containing manifest.json) and .zip files.
 * @param {string} inboxPath
 * @returns {Promise<Array<{ kind: "folder"|"zip", path: string, name: string }>>}
 */
export async function listInboxCandidates(inboxPath) {
  const browse = await browseDataFolder(inboxPath);
  const candidates = [];

  for (const file of browse.files ?? []) {
    if (/\.zip$/i.test(file)) {
      const name = file.split("/").pop() ?? file;
      candidates.push({ kind: "zip", path: file, name });
    }
  }

  for (const dir of browse.dirs ?? []) {
    try {
      const inner = await browseDataFolder(dir);
      const hasManifest = (inner.files ?? []).some((file) => file.endsWith("/manifest.json") || file.endsWith("manifest.json"));
      if (hasManifest) {
        const name = dir.split("/").pop() ?? dir;
        candidates.push({ kind: "folder", path: dir, name });
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | skip inbox dir ${dir}`, error);
    }
  }

  return candidates.sort((a, b) => a.name.localeCompare(b.name));
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
    sessions.push({
      sessionCode,
      displayCode: latest.package.manifest.displayCode,
      sessionName: latest.package.manifest.sessionName,
      partyLevel: latest.package.manifest.partyLevel,
      crLabel: latest.package.manifest.crLabel ?? null,
      sessionArt: latest.package.manifest.sessionArt ?? null,
      latestExportedAt: latest.package.manifest.exportedAt,
      versions
    });
  }

  sessions.sort((a, b) => String(b.latestExportedAt).localeCompare(String(a.latestExportedAt)));
  return sessions;
}
