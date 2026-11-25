/** @typedef {import("../schemas/types.js").SessionPackageManifest} SessionPackageManifest */

export const MODULE_ID = "dlfi";
/** Accepted Session Package format versions (DLCE may bump independently). */
export const PACKAGE_FORMAT_VERSION = 3;
export const PACKAGE_FORMAT_VERSIONS = new Set([1, 2, 3]);

/** Data/ folder for DLCE Session Package zips only. */
export const SETTING_INBOX = "inboxPath";
/** Data/ folder for imported package trees (mirrors zip layout). */
export const SETTING_IMPORTS = "importsPath";
export const SETTING_TEMPLATE_LOCATION = "templateLocation";
export const SETTING_TEMPLATE_BATTLEMAP = "templateBattlemap";
export const SETTING_TEMPLATE_LANDING = "templateLanding";
/** Outro page (Thanks for Playing) — same shape as Landing, without logo/title tiles. */
export const SETTING_TEMPLATE_OUTRO = "templateOutro";
export const SETTING_TEMPLATE_INBOX = "templateInbox";
export const SETTING_SPELL_PACKS = "spellItemPacks";
export const SETTING_LIVE_SESSION = "liveSessionKey";
/** Delete the previous import of the same sessionCode (world docs + assets) before re-importing. */
export const SETTING_REPLACE_ON_REIMPORT = "replaceOnReimport";
/**
 * When true, session-linked Player accounts may log in (role PLAYER).
 * When false, Player-role accounts are soft-hidden (role NONE + `_` name prefix).
 */
export const SETTING_PLAYERS_UNLOCKED = "playersUnlocked";

/** Keep this many zip copies per session under the DLCE inbox. */
export const INBOX_KEEP_PER_SESSION = 3;

export const DEFAULT_INBOX_PATH = "dlce-inbox";
export const DEFAULT_IMPORTS_PATH = "dlfi-imports";

/** World flag namespace for DLFI metadata on Folders / documents. */
export const FLAG_SCOPE = MODULE_ID;

/**
 * Shared Actor folder for Player Character stubs (not session-scoped).
 * All seated PCs created by DLFI live here so they persist across session imports.
 */
export const PC_ACTOR_FOLDER_NAME = "Damned Lucky";

/**
 * Child Actor folder under each session folder for Item Pile actors.
 * e.g. `DL304 · Mist Opportunity` / `Item Piles`.
 */
export const ITEM_PILES_FOLDER_NAME = "Item Piles";

/** Foundry CONST.TOKEN_DISPOSITIONS — keep numeric so Node selftests work offline. */
export const TOKEN_DISPOSITION = Object.freeze({
  SECRET: -2,
  HOSTILE: -1,
  NEUTRAL: 0,
  FRIENDLY: 1
});

export function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

export function notify(message, { permanent = false, type = "info" } = {}) {
  const text = String(message ?? "");
  // Foundry Notifications has info / warn / error (no "warning").
  const kind = type === "warning" ? "warn" : type;
  const level = kind === "error" ? "error" : kind === "warn" ? "warn" : "log";
  console[level](`${MODULE_ID} | ${text}`);
  const show = typeof ui.notifications[kind] === "function" ? ui.notifications[kind] : ui.notifications.info;
  show.call(ui.notifications, text, { permanent });
}

export function sessionFolderName(manifest) {
  const code = String(manifest.displayCode || manifest.sessionCode || "SESSION").trim();
  const name = String(manifest.sessionName || "Untitled").trim() || "Untitled";
  return `${code} · ${name}`;
}

export function sessionKey(manifest) {
  return `${manifest.sessionCode}::${manifest.exportedAt}`;
}
