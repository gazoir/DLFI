/**
 * Nav-tile clicks.
 *
 * Monk's Active Tile Triggers still receives the click (the imported scene
 * action is the trigger). DLFI cancels that action and:
 *   1. Scene A is the scene where the click happened.
 *   2. Scene B is the scene the tile represents.
 *   3. Repaint B for the view you are about to open. The outline stays on the
 *      scene the players are in (`scene.active`), which this click does not change.
 *   4. View B.
 *   5. Repaint B again now that it is on screen, then repaint A.
 * Other scenes are left alone. A tile that is not a DLFI nav thumbnail still
 * runs its own Monk's Active Tiles actions, including a scene change.
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

/** Token Magic identity fields. Copied params must not reuse these across tiles. */
const FILTER_IDENTITY = [
  "filterId",
  "filterInternalId",
  "placeableId",
  "placeableType",
  "updateId",
  "filterOwner",
  "rank"
];

/**
 * The scene the players are in. `game.scenes.active` is that same scene; the
 * boolean is read directly so a GM view cannot be mistaken for it.
 * @returns {string}
 */
function playerActiveSceneId() {
  const scenes = globalThis.game?.scenes;
  const contents = scenes?.contents ?? [];
  const flagged = contents.find((scene) => scene.active === true);
  return flagged?.id ?? "";
}

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
  const styles = await loadNavStyles();
  const activeBefore = playerActiveSceneId();

  // Write B before it draws, so the first frame is not the previous visit.
  if (styles) {
    await paintNavScene(sceneB, styles, activeBefore, sceneB.id);
  }
  if (sceneA.id !== sceneB.id) {
    await sceneB.view();
  }

  // Token Magic only redraws a tile while its scene is the viewed one.
  // Paint the scene on screen after the view, then the scene just left.
  const viewedId = globalThis.canvas?.scene?.id ?? sceneB.id;
  const activeId = playerActiveSceneId();
  const viewedScene = globalThis.canvas?.scene ?? sceneB;
  console.log(
    `${MODULE_ID} | nav ${viewedScene?.name ?? sceneB.name}` +
      ` viewed, players still in ${globalThis.game?.scenes?.get?.(activeId)?.name ?? "no active scene"}`
  );
  if (styles) {
    await paintNavScene(viewedScene, styles, activeId, viewedId);
    if (sceneA.id !== viewedId) {
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
 * Drop ids copied from the macro that recorded the preset. Reusing them makes
 * Token Magic stack the outline and the darken onto one tile.
 * @param {object[]} params
 * @returns {object[]}
 */
function detachedFilterParams(params) {
  const cloned = foundry.utils.deepClone(params);
  for (const entry of cloned) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    for (const key of FILTER_IDENTITY) {
      delete entry[key];
    }
  }
  return cloned;
}

async function applyNavTmfx(tile, params) {
  const TokenMagic = globalThis.TokenMagic;
  const onViewedScene = tile.parent?.id && tile.parent.id === globalThis.canvas?.scene?.id;
  const placeable =
    tile.object ?? (onViewedScene ? globalThis.canvas?.tiles?.get?.(tile.id) : null) ?? null;
  const target = placeable ?? tile;
  // Clear first so a previous outline does not sit under the new preset.
  await TokenMagic.deleteFilters(target);
  if (params.length) {
    await TokenMagic.addFilters(target, detachedFilterParams(params), true);
  }
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
