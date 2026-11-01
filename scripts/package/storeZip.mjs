/**
 * Read uncompressed (STORE) zip bytes produced by DLCE Session Package export.
 * Compressed entries are skipped with a warning.
 */

function u16(view, offset) {
  return view.getUint16(offset, true);
}

function u32(view, offset) {
  return view.getUint32(offset, true);
}

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Map<string, Uint8Array>}
 */
export function readStoreZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map();

  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const sig = u32(view, offset);
    if (sig === 0x02014b50 || sig === 0x06054b50) {
      break;
    }
    if (sig !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header at ${offset}`);
    }

    const method = u16(view, offset + 8);
    const compSize = u32(view, offset + 18);
    const nameLen = u16(view, offset + 26);
    const extraLen = u16(view, offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    const dataStart = nameEnd + extraLen;
    const dataEnd = dataStart + compSize;
    const name = decodeUtf8(bytes.subarray(nameStart, nameEnd)).replace(/\\/g, "/");

    if (method === 0) {
      files.set(name, bytes.subarray(dataStart, dataEnd));
    } else if (name && !name.endsWith("/")) {
      console.warn(`dlfi | skipping compressed zip entry: ${name} (method ${method})`);
    }

    offset = dataEnd;
  }

  return files;
}

/**
 * Strip a single top-level folder prefix from zip paths when present.
 * @param {Map<string, Uint8Array>} files
 * @returns {{ root: string, files: Map<string, Uint8Array> }}
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
