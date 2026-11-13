/** @typedef {import("../schemas/types.js").SessionPackageManifest} SessionPackageManifest */

export const MODULE_ID = "dlfi";
/** Accepted Session Package format versions (DLCE may bump independently). */
export const PACKAGE_FORMAT_VERSION = 1;
export const PACKAGE_FORMAT_VERSIONS = new Set([1, 2]);

/** Data/ folder for DLCE Session Package zips only. */
export const SETTING_INBOX = "inboxPath";
/** Data/ folder for imported package trees (mirrors zip layout). */
export const SETTING_IMPORTS = "importsPath";
export const SETTING_TEMPLATE_LOCATION = "templateLocation";
export const SETTING_TEMPLATE_BATTLEMAP = "templateBattlemap";
export const SETTING_TEMPLATE_LANDING = "templateLanding";
export const SETTING_TEMPLATE_INBOX = "templateInbox";
export const SETTING_SPELL_PACKS = "spellItemPacks";
export const SETTING_LIVE_SESSION = "liveSessionKey";

/** Keep this many zip copies per session under the DLCE inbox. */
export const INBOX_KEEP_PER_SESSION = 3;

export const DEFAULT_INBOX_PATH = "dlce-inbox";
export const DEFAULT_IMPORTS_PATH = "dlfi-imports";

/** World flag namespace for DLFI metadata on Folders / documents. */
export const FLAG_SCOPE = MODULE_ID;

export function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

export function notify(message, { permanent = false, type = "info" } = {}) {
  const text = String(message ?? "");
  const level = type === "error" ? "error" : type === "warning" ? "warn" : "log";
  console[level](`${MODULE_ID} | ${text}`);
  ui.notifications[type]?.(text, { permanent }) ?? ui.notifications.info(text);
}

export function sessionFolderName(manifest) {
  const code = String(manifest.displayCode || manifest.sessionCode || "SESSION").trim();
  const name = String(manifest.sessionName || "Untitled").trim() || "Untitled";
  return `${code} · ${name}`;
}

export function sessionKey(manifest) {
  return `${manifest.sessionCode}::${manifest.exportedAt}`;
}
