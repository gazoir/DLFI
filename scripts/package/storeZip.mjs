/**
 * Read uncompressed (STORE) zip bytes produced by DLCE Session Package export.
 * Compressed entries are skipped with a warning. Entry paths that could escape
 * the package root (`..`, absolute, drive letters, control characters) are dropped.
 */

import { isSafePackagePath } from "./dataFolders.mjs";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
/** EOCD record (22 bytes) + the largest allowed comment. */
export const ZIP_TAIL_MAX = 22 + 0xffff;

function u16(view, offset) {
  return view.getUint16(offset, true);
}

function u32(view, offset) {
  return view.getUint32(offset, true);
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function asBytes(buffer) {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

/**
 * Locate the End Of Central Directory record in the tail of a zip.
 * @param {Uint8Array} bytes zip bytes or a tail slice of them
 * @returns {{ entries: number, cdSize: number, cdOffset: number }|null}
 */
export function findEndOfCentralDirectory(bytes) {
  const view = viewOf(bytes);
  const stop = Math.max(0, bytes.length - ZIP_TAIL_MAX);
  for (let offset = bytes.length - 22; offset >= stop; offset -= 1) {
    if (u32(view, offset) === SIG_EOCD) {
      return {
        entries: u16(view, offset + 10),
        cdSize: u32(view, offset + 12),
        cdOffset: u32(view, offset + 16)
      };
    }
  }
  return null;
}

/**
 * Parse central directory records.
 * @param {Uint8Array} cdBytes bytes starting at the first central record
 * @returns {Array<{ name: string, method: number, flags: number, compSize: number, nameLen: number, extraLen: number, localOffset: number }>}
 */
export function parseCentralDirectory(cdBytes) {
  const view = viewOf(cdBytes);
  const entries = [];
  let offset = 0;
  while (offset + 46 <= cdBytes.length && u32(view, offset) === SIG_CENTRAL) {
    const nameLen = u16(view, offset + 28);
    const extraLen = u16(view, offset + 30);
    const commentLen = u16(view, offset + 32);
    const nameEnd = offset + 46 + nameLen;
    if (nameEnd > cdBytes.length) {
      throw new Error(`Truncated ZIP central directory at ${offset}`);
    }
    entries.push({
      name: decodeUtf8(cdBytes.subarray(offset + 46, nameEnd)).replace(/\\/g, "/"),
      flags: u16(view, offset + 8),
      method: u16(view, offset + 10),
      compSize: u32(view, offset + 20),
      nameLen,
      extraLen,
      localOffset: u32(view, offset + 42)
    });
    offset = nameEnd + extraLen + commentLen;
  }
  return entries;
}

/**
 * Data bytes for one entry, given bytes that start at its local header.
 * @param {Uint8Array} localBytes
 * @param {{ name: string, compSize: number }} entry
 * @returns {Uint8Array|null} null when `localBytes` is too short (caller fetches more)
 */
export function entryDataFromLocal(localBytes, entry) {
  const view = viewOf(localBytes);
  if (localBytes.length < 30 || u32(view, 0) !== SIG_LOCAL) {
    throw new Error(`Invalid ZIP local header for ${entry.name}`);
  }
  const dataStart = 30 + u16(view, 26) + u16(view, 28);
  const dataEnd = dataStart + entry.compSize;
  if (dataEnd > localBytes.length) {
    return null;
  }
  return localBytes.subarray(dataStart, dataEnd);
}

function keepEntry(files, name, method, data) {
  if (!name || name.endsWith("/")) {
    return;
  }
  if (!isSafePackagePath(name)) {
    console.warn(`dlfi | skipping unsafe zip entry path: ${JSON.stringify(name)}`);
    return;
  }
  if (method !== 0) {
    console.warn(`dlfi | skipping compressed zip entry: ${name} (method ${method})`);
    return;
  }
  files.set(name, data);
}

function readViaCentralDirectory(bytes, eocd) {
  const { cdOffset, cdSize } = eocd;
  if (cdOffset + cdSize > bytes.length) {
    throw new Error("ZIP central directory lies outside the file");
  }
  const files = new Map();
  for (const entry of parseCentralDirectory(bytes.subarray(cdOffset, cdOffset + cdSize))) {
    if (entry.localOffset + 30 > bytes.length) {
      throw new Error(`ZIP entry ${entry.name} starts outside the file`);
    }
    const data = entryDataFromLocal(bytes.subarray(entry.localOffset), entry);
    if (!data) {
      throw new Error(`ZIP entry ${entry.name} runs past the end of the file`);
    }
    keepEntry(files, entry.name, entry.method, data);
  }
  return files;
}

function readViaLocalHeaders(bytes) {
  const view = viewOf(bytes);
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const sig = u32(view, offset);
    if (sig === SIG_CENTRAL || sig === SIG_EOCD) {
      break;
    }
    if (sig !== SIG_LOCAL) {
      throw new Error(`Invalid ZIP local header at ${offset}`);
    }
    const flags = u16(view, offset + 6);
    const method = u16(view, offset + 8);
    const compSize = u32(view, offset + 18);
    const nameLen = u16(view, offset + 26);
    const extraLen = u16(view, offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    const dataStart = nameEnd + extraLen;
    const dataEnd = dataStart + compSize;
    const name = decodeUtf8(bytes.subarray(nameStart, nameEnd)).replace(/\\/g, "/");
    if (flags & 0x08) {
      throw new Error(`ZIP entry ${name} uses a data descriptor and the central directory is missing`);
    }
    if (dataEnd > bytes.length) {
      throw new Error(`ZIP entry ${name} runs past the end of the file`);
    }
    keepEntry(files, name, method, bytes.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }
  return files;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Map<string, Uint8Array>}
 */
export function readStoreZip(buffer) {
  const bytes = asBytes(buffer);
  const eocd = findEndOfCentralDirectory(bytes);
  return eocd ? readViaCentralDirectory(bytes, eocd) : readViaLocalHeaders(bytes);
}

/**
 * Strip a single top-level folder prefix from zip paths when present.
 * @template T
 * @param {Map<string, T>} files
 * @returns {{ root: string, files: Map<string, T> }}
 */
export function normalizePackageFiles(files) {
  const keys = [...files.keys()].filter((key) => key && !key.endsWith("/"));
  if (!keys.length) {
    return { root: "", files: new Map() };
  }

  const first = keys[0];
  const slash = first.indexOf("/");
  const prefix = slash > 0 ? first.slice(0, slash + 1) : "";
  const allShare =
    prefix && keys.every((key) => key.startsWith(prefix) || key === prefix.slice(0, -1));

  if (!allShare) {
    return { root: "", files };
  }

  const next = new Map();
  for (const [key, value] of files) {
    if (key.startsWith(prefix)) {
      next.set(key.slice(prefix.length), value);
    }
  }
  return { root: prefix.slice(0, -1), files: next };
}
