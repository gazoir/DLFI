/**
 * Hide Active Effect status icons on Landing scenes (and any scene flagged
 * `flags.dlfi.hideTokenEffects`), while keeping tokens clickable with names.
 */

import { FLAG_SCOPE, MODULE_ID } from "../constants.mjs";

/**
 * @param {object|null|undefined} scene
 * @returns {boolean}
 */
export function sceneHidesTokenEffects(scene) {
  if (!scene) {
    return false;
  }
  const flags = scene.flags?.[FLAG_SCOPE] ?? scene.flags?.dlfi ?? {};
  if (flags.hideTokenEffects === true) {
    return true;
  }
  return flags.kind === "landing";
}

/**
 * Clear drawn effect icons on a Token placeable without touching sheet/nameplate.
 * @param {Token} token
 */
export function clearTokenEffectIcons(token) {
  const effects = token?.effects;
  if (!effects) {
    return;
  }
  try {
    if (typeof effects.removeChildren === "function") {
      effects.removeChildren();
    } else if (Array.isArray(effects.children)) {
      for (const child of [...effects.children]) {
        child.destroy?.({ children: true });
      }
    }
    if ("visible" in effects) {
      effects.visible = false;
    }
  } catch (error) {
    console.debug(`${MODULE_ID} | could not clear token effects`, error);
  }
}

/**
 * Register canvas hooks so Landing token effect icons stay hidden.
 */
export function registerHideLandingEffectsHooks() {
  const hideIfNeeded = (token) => {
    const scene = token?.scene ?? globalThis.canvas?.scene;
    if (!sceneHidesTokenEffects(scene)) {
      return;
    }
    clearTokenEffectIcons(token);
  };

  Hooks.on("refreshToken", hideIfNeeded);
  Hooks.on("drawToken", hideIfNeeded);
  Hooks.on("updateToken", (doc) => {
    const token = doc?.object ?? globalThis.canvas?.tokens?.get?.(doc.id);
    if (token) {
      hideIfNeeded(token);
    }
  });
  Hooks.on("applyTokenStatusEffect", () => {
    const scene = globalThis.canvas?.scene;
    if (!sceneHidesTokenEffects(scene)) {
      return;
    }
    for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
      clearTokenEffectIcons(token);
    }
  });

  // After scene draw, sweep once so already-placed tokens are clean.
  Hooks.on("canvasReady", (canvas) => {
    if (!sceneHidesTokenEffects(canvas?.scene)) {
      return;
    }
    for (const token of canvas.tokens?.placeables ?? []) {
      clearTokenEffectIcons(token);
    }
  });
}
