/**
 * Suppress Foundry's scene texture-loading progress toast ("Loading …") on
 * player clients, gated by the "Suppress loading bars for players" setting.
 *
 * Only scene loads (TextureLoader.loadSceneTextures — draw and preload) are
 * affected; other TextureLoader.load callers keep their progress bar.
 */

import { MODULE_ID, SETTING_SUPPRESS_LOADING_BARS } from "../constants.mjs";

let sceneLoadDepth = 0;

/**
 * @param {{ isGM?: boolean }|null|undefined} user
 * @param {(key: string) => unknown} readSetting
 * @returns {boolean}
 */
export function shouldSuppressLoadingBar(user, readSetting) {
  if (!user || user.isGM) {
    return false;
  }
  try {
    return readSetting(SETTING_SUPPRESS_LOADING_BARS) !== false;
  } catch (_error) {
    return true;
  }
}

/**
 * Fallback for builds where loadSceneTextures awaits before calling load:
 * recognise the localized "SCENE.Loading" message ("Loading {name}").
 * @param {unknown} message
 * @param {string} template localized SCENE.Loading string
 */
export function isSceneLoadingMessage(message, template) {
  const prefix = String(template ?? "").split("{")[0].trim();
  return Boolean(prefix) && prefix !== "SCENE.Loading" && String(message ?? "").startsWith(prefix);
}

function sceneLoadingTemplate() {
  try {
    return globalThis.game?.i18n?.localize?.("SCENE.Loading") ?? "";
  } catch (_error) {
    return "";
  }
}

function suppressForThisClient() {
  return shouldSuppressLoadingBar(globalThis.game?.user, (key) => globalThis.game?.settings?.get(MODULE_ID, key));
}

/**
 * Wrap TextureLoader once. Safe to call from `init`; the setting and user are
 * read per load, so toggling the setting applies on the next scene change.
 * @param {typeof foundry.canvas.TextureLoader} [Loader]
 * @returns {boolean} whether the patch is installed
 */
export function registerSuppressSceneLoadingBar(Loader = globalThis.foundry?.canvas?.TextureLoader) {
  const proto = Loader?.prototype;
  if (!proto || typeof proto.load !== "function" || typeof Loader.loadSceneTextures !== "function") {
    console.warn(`${MODULE_ID} | TextureLoader unavailable — cannot suppress scene loading bar`);
    return false;
  }
  if (Loader.__dlfiSuppressProgress) {
    return true;
  }
  Loader.__dlfiSuppressProgress = true;

  const originalLoad = proto.load;
  proto.load = function dlfiSceneLoad(sources, options = {}) {
    const isScene = sceneLoadDepth > 0 || isSceneLoadingMessage(options?.message, sceneLoadingTemplate());
    if (isScene && suppressForThisClient()) {
      return originalLoad.call(this, sources, { ...options, displayProgress: false });
    }
    return originalLoad.call(this, sources, options);
  };

  const originalScene = Loader.loadSceneTextures;
  Loader.loadSceneTextures = function dlfiLoadSceneTextures(...args) {
    sceneLoadDepth += 1;
    try {
      return originalScene.apply(this, args);
    } finally {
      sceneLoadDepth -= 1;
    }
  };
  return true;
}
