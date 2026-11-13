/** @typedef {import("../schemas/types.js").SessionPackageManifest} SessionPackageManifest */

export const MODULE_ID = "dlfi";
export const PACKAGE_FORMAT_VERSION = 2;

export const SETTING_INBOX = "inboxPath";
export const SETTING_TEMPLATE_LOCATION = "templateLocation";
export const SETTING_TEMPLATE_BATTLEMAP = "templateBattlemap";
export const SETTING_TEMPLATE_LANDING = "templateLanding";
export const SETTING_TEMPLATE_INBOX = "templateInbox";
export const SETTING_SPELL_PACKS = "spellItemPacks";
export const SETTING_LIVE_SESSION = "liveSessionKey";

/** World flag namespace for DLFI metadata on Folders / documents. */
export const FLAG_SCOPE = MODULE_ID;

export function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

export function notify(message, { permanent = false, type = "info" } = {}) {
  ui.notifications[type]?.(message, { permanent }) ?? ui.notifications.info(message);
}

export function sessionFolderName(manifest) {
  const code = String(manifest.displayCode || manifest.sessionCode || "SESSION").trim();
  const name = String(manifest.sessionName || "Untitled").trim() || "Untitled";
  return `${code} · ${name}`;
}

export function sessionKey(manifest) {
  return `${manifest.sessionCode}::${manifest.exportedAt}`;
}
