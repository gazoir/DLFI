/**
 * Resolve Foundry's FilePicker class without touching the deprecated global (removed in V15).
 */

let cached = null;

function resolveFilePicker() {
  const apps = globalThis.foundry?.applications?.apps;
  const modern = apps?.FilePicker?.implementation ?? apps?.FilePicker;
  if (modern) {
    return modern;
  }
  return globalThis.FilePicker ?? null;
}

/**
 * @returns {typeof foundry.applications.apps.FilePicker}
 */
export function getFilePicker() {
  if (cached) {
    return cached;
  }
  const resolved = resolveFilePicker();
  if (!resolved) {
    throw new Error("DLFI: FilePicker is not available");
  }
  if (globalThis.foundry?.applications?.apps?.FilePicker) {
    cached = resolved;
  }
  return resolved;
}

/** True when an error from a Data/ filesystem call means the path does not exist. */
export function isNotFoundError(error) {
  if (!error) {
    return false;
  }
  if (Number(error.status ?? error.statusCode ?? error.code) === 404) {
    return true;
  }
  return /\b404\b|not found|ENOENT|does not exist|no such file/i.test(String(error?.message ?? error));
}
