/**
 * Hide Active Effect status icons on Landing scenes (and any scene flagged
 * `flags.dlfi.hideTokenEffects`), while keeping tokens clickable with names.
 */

import { FLAG_SCOPE } from "../constants.mjs";

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
 * Hide the effect-icon container on a Token placeable. The sprites stay owned
 * by Foundry (no detach / destroy), so redraws and status changes keep working.
 * @param {Token} token
 */
export function clearTokenEffectIcons(token) {
  const effects = token?.effects;
  if (effects && effects.visible !== false) {
    effects.visible = false;
  }
}

/**
 * @param {object} canvas
 */
export function hideLandingEffectsOnCanvas(canvas) {
  if (!sceneHidesTokenEffects(canvas?.scene)) {
    return;
  }
  for (const token of canvas.tokens?.placeables ?? []) {
    clearTokenEffectIcons(token);
  }
}

/**
 * Register canvas hooks so Landing token effect icons stay hidden.
 * @returns {{ onCanvasReady: (canvas: object) => void }}
 */
export function registerHideLandingEffectsHooks() {
  const hideIfNeeded = (token) => {
    const scene = token?.scene ?? globalThis.canvas?.scene;
    if (sceneHidesTokenEffects(scene)) {
      clearTokenEffectIcons(token);
    }
  };

  // refreshToken runs after every effect redraw / status toggle.
  Hooks.on("drawToken", hideIfNeeded);
  Hooks.on("refreshToken", hideIfNeeded);
  Hooks.on("canvasReady", hideLandingEffectsOnCanvas);
  return { onCanvasReady: hideLandingEffectsOnCanvas };
}
