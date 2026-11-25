/**
 * Nav-tile clicks.
 *
 * Monk's Active Tile Triggers still receives the click (the imported scene
 * action is the trigger). DLFI cancels that action and:
 *   1. Scene A is the scene where the click happened.
 *   2. Scene B is the scene the tile represents.
 *   3. Repaint B as it should look once B is the viewed scene.
 *   4. View B (does not activate it for the players).
 *   5. Repaint A.
 * Other scenes are left alone. Pressing the combat hotkey still repaints the
 * whole session, because that can change which scene is active.
 */

import {
  MODULE_ID,
  SETTING_NAV_TMFX_ACTIVE,
  SETTING_NAV_TMFX_NEITHER,
  setting
} from "../constants.mjs";
import {
  isMattNavTile,
  navTileFilterParams,
  navTileKind,
  navTileTargetSceneId
} from "./navTileHighlight.mjs";

/** Written by the Combat / Scene Controller macro when the GM saves TMFX UUIDs. */
const COMBAT_TMFX_FLAG = { scope: "world", key: "combatControllerTmfxUuids" };

/** @type {Promise<void>} */
let chain = Promise.resolve();
/** Tile id whose view is already queued, so one click does not run twice. */
let queuedTileId = null;
/** @type {{ key: string, styles: { active: object[], neither: object[] } | null } | null} */
let styleCache = null;
let warnedMissingStyles = false;

export function registerNavHighlightSettings() {
  game.settings.register(MODULE_ID, SETTING_NAV_TMFX_ACTIVE, {
    name: "Nav highlight: active scene",
    hint: "Macro UUID whose Token Magic filters outline the nav tile for the active scene. Leave blank to use the UUIDs saved by the Combat / Scene Controller macro.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: () => {
      styleCache = null;
    }
  });
  game.settings.register(MODULE_ID, SETTING_NAV_TMFX_NEITHER, {
    name: "Nav highlight: other scenes",
    hint: "Macro UUID whose Token Magic filters darken nav tiles that are neither the active scene nor the one you are viewing. Leave blank to use the Combat / Scene Controller macro.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: () => {
      styleCache = null;
    }
  });
}

/**
 * Replace MATT's scene change on nav tiles with the view sequence above.
 */
export function registerMattNavViewHooks() {
  if (!globalThis.Hooks?.on) {
    return;
  }
  Hooks.on("preTriggerTile", (tile, _tileAgain, _tokens, action) => {
    try {
      return onNavTileTrigger(tile, action);
    } catch (error) {
      console.warn(`${MODULE_ID} | nav click failed`, error);
      return undefined;
    }
  });
}

/**
 * @param {object} tile
 * @param {object|undefined} action
 * @returns {false|undefined}
 */
function onNavTileTrigger(tile, action) {
  const doc = tile?.document ?? tile;
  const kind = navTileKind(doc);
  if (kind !== "matt-nav-left" && kind !== "matt-nav-right") {
    return undefined;
  }
  const actionName = action?.action;
  // Scene change is the imported trigger. Run Macro is a click handler that
  // used to live in the combat macro; DLFI owns that click now.
  if (actionName !== "scene" && actionName !== "runmacro") {
    return undefined;
  }
  if (!globalThis.game?.user?.isGM) {
    return false;
  }
  const targetId = navTileTargetSceneId(doc);
  if (!targetId || !globalThis.game.scenes?.get?.(targetId)) {
    return undefined;
  }
  queueNavView(doc);
  return false;
}

/**
 * @param {object} tileDoc
 */
function queueNavView(tileDoc) {
  const id = tileDoc?.id ?? tileDoc?._id ?? null;
  if (id && queuedTileId === id) {
    return;
  }
  queuedTileId = id;
  const run = chain.then(() => performNavView(tileDoc));
  chain = run.then(
    () => {
      if (queuedTileId === id) {
        queuedTileId = null;
      }
    },
    (error) => {
      console.warn(`${MODULE_ID} | nav view failed`, error);
      if (queuedTileId === id) {
        queuedTileId = null;
      }
    }
  );
}

/**
 * @param {object} tileDoc
 */
async function performNavView(tileDoc) {
  const sceneA = globalThis.canvas?.scene ?? null;
  const sceneB = globalThis.game?.scenes?.get?.(navTileTargetSceneId(tileDoc)) ?? null;
  if (!sceneA || !sceneB) {
    return;
  }
  const activeId = globalThis.game?.scenes?.active?.id ?? "";
  const viewedId = sceneB.id;
  const styles = await loadNavStyles();
  if (styles) {
    await paintNavScene(sceneB, styles, activeId, viewedId);
  }
  if (sceneA.id !== sceneB.id) {
    await sceneB.view();
    if (styles) {
      await paintNavScene(sceneA, styles, activeId, viewedId);
    }
  }
}

/**
 * @param {object} scene
 * @param {{ active: object[], neither: object[] }} styles
 * @param {string} activeId
 * @param {string} viewedId
 */
async function paintNavScene(scene, styles, activeId, viewedId) {
  const TokenMagic = globalThis.TokenMagic;
  if (!TokenMagic?.addFilters || !TokenMagic?.deleteFilters) {
    return;
  }
  const tiles = [...(scene.tiles?.contents ?? scene.tiles ?? [])].filter(isMattNavTile);
  for (const tile of tiles) {
    const params = navTileFilterParams(tile, activeId, viewedId, styles);
    try {
      await applyNavTmfx(tile, params);
    } catch (error) {
      console.warn(
        `${MODULE_ID} | nav highlight failed on ${scene.name} / ${tile.name ?? tile.id}`,
        error
      );
    }
  }
}

/**
 * @param {object} tile
 * @param {object[]} params
 */
async function applyNavTmfx(tile, params) {
  const TokenMagic = globalThis.TokenMagic;
  const placeable =
    tile.object ??
    (tile.parent?.id && tile.parent.id === globalThis.canvas?.scene?.id
      ? globalThis.canvas?.tiles?.get?.(tile.id)
      : null) ??
    null;
  const target = placeable ?? tile;
  if (params.length) {
    await TokenMagic.addFilters(target, foundry.utils.deepClone(params), true);
    return;
  }
  await TokenMagic.deleteFilters(target);
}

/**
 * @returns {Promise<{ active: object[], neither: object[] } | null>}
 */
async function loadNavStyles() {
  if (!globalThis.TokenMagic?.addFilters) {
    return null;
  }
  const uuids = navStyleUuids();
  const key = `${uuids.active}|${uuids.neither}`;
  if (!uuids.active && !uuids.neither) {
    warnMissingStyles();
    return null;
  }
  if (styleCache?.key === key) {
    return styleCache.styles;
  }
  const active = uuids.active ? await readTmfxMacroParams(uuids.active) : [];
  const neither = uuids.neither ? await readTmfxMacroParams(uuids.neither) : [];
  if (active == null && neither == null) {
    warnMissingStyles();
    styleCache = { key, styles: null };
    return null;
  }
  const styles = {
    active: active ?? [],
    neither: neither ?? []
  };
  styleCache = { key, styles };
  return styles;
}

/**
 * @returns {{ active: string, neither: string }}
 */
function navStyleUuids() {
  let fromSettings = { active: "", neither: "" };
  try {
    fromSettings = {
      active: String(setting(SETTING_NAV_TMFX_ACTIVE) || "").trim(),
      neither: String(setting(SETTING_NAV_TMFX_NEITHER) || "").trim()
    };
  } catch (_error) {
    fromSettings = { active: "", neither: "" };
  }
  const flag = globalThis.game?.user?.getFlag?.(COMBAT_TMFX_FLAG.scope, COMBAT_TMFX_FLAG.key) ?? {};
  return {
    active: fromSettings.active || String(flag.active || "").trim(),
    neither: fromSettings.neither || String(flag.neither || "").trim()
  };
}

function warnMissingStyles() {
  if (warnedMissingStyles) {
    return;
  }
  warnedMissingStyles = true;
  const message =
    "Nav tiles change scene, but highlight macros are not set. Paste them in Configure Settings → Damned Lucky Foundry Import, or press 1 once so the Combat Controller can save them.";
  console.warn(`${MODULE_ID} | ${message}`);
  globalThis.ui?.notifications?.warn?.(message);
}

/**
 * Run a TMFX macro against a stand-in that records add/delete filter calls.
 * @param {string} uuid
 * @returns {Promise<object[]|null>} null when the macro cannot be read
 */
async function readTmfxMacroParams(uuid) {
  const macro = await resolveMacro(uuid);
  if (!macro || macro.type !== "script" || !macro.command) {
    return null;
  }
  /** @type {object[]|null} */
  let captured = null;
  let sawCall = false;
  const real = globalThis.TokenMagic;
  const recorder = new Proxy(
    {},
    {
      get(_target, prop) {
        const name = String(prop);
        if (/^delete/i.test(name)) {
          return async () => {
            sawCall = true;
            captured = [];
          };
        }
        if (/^(add|update)/i.test(name) && /filters/i.test(name)) {
          return async (...args) => {
            const list = args.find((arg) => Array.isArray(arg));
            const single = args.find((arg) => arg && typeof arg === "object" && arg.filterType);
            const params = list ?? (single ? [single] : null);
            if (params) {
              sawCall = true;
              captured = foundry.utils.deepClone(params);
            }
          };
        }
        const value = real?.[prop];
        return typeof value === "function" ? value.bind(real) : value;
      }
    }
  );
  const AsyncFunctionCtor =
    foundry.utils?.AsyncFunction ?? Object.getPrototypeOf(async function asyncFn() {}).constructor;
  try {
    const fn = new AsyncFunctionCtor(
      "TokenMagic",
      "speaker",
      "actor",
      "token",
      "character",
      "scope",
      macro.command
    );
    await fn.call(macro, recorder, {}, null, null, null, {});
  } catch (error) {
    console.warn(`${MODULE_ID} | could not read TMFX params from ${macro.name}`, error);
    return null;
  }
  return sawCall ? captured ?? [] : null;
}

/**
 * @param {string} uuid
 * @returns {Promise<object|null>}
 */
async function resolveMacro(uuid) {
  const text = String(uuid || "").trim();
  if (!text) {
    return null;
  }
  try {
    const doc = await fromUuid(text);
    if (doc?.documentName === "Macro" || doc instanceof Macro) {
      return doc;
    }
  } catch (_error) {
    /* fall through to id lookup */
  }
  const id = text.replace(/^Macro\./, "");
  return globalThis.game?.macros?.get?.(id) ?? null;
}
