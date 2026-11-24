/**
 * Set a Scene background image in a way that works on Foundry 13 and 14+.
 *
 * Foundry 14 moved background onto embedded Level documents
 * (`scene.levels[].background.src`). Updating top-level `background` alone
 * leaves the active level's src null — which is what the Texture Browser shows.
 *
 * After setting the background, regenerate the Scene Directory thumbnail
 * (`scene.thumb`) — Foundry does not refresh it automatically on background update.
 */

import { MODULE_ID } from "../constants.mjs";

/**
 * Regenerate the Scene Directory thumbnail for a scene.
 * @param {Scene} scene
 * @param {{ img?: string|null }} [options]
 * @returns {Promise<string|null>} thumb path/data-url when created
 */
export async function refreshSceneThumbnail(scene, options = {}) {
  if (!scene || typeof scene.createThumbnail !== "function") {
    return null;
  }
  try {
    const opts = {};
    if (options.img) {
      opts.img = String(options.img);
    }
    const data = await scene.createThumbnail(opts);
    const thumb =
      data?.thumb ??
      data?.thumbnail ??
      data?.src ??
      (typeof data === "string" ? data : null);
    if (thumb && typeof scene.update === "function") {
      const current = scene.thumb ?? scene._source?.thumb ?? null;
      if (current !== thumb) {
        await scene.update({ thumb });
      }
    }
    if (thumb) {
      console.log(`${MODULE_ID} | scene ${scene.name}: thumbnail refreshed`);
    }
    return thumb ? String(thumb) : null;
  } catch (error) {
    console.warn(`${MODULE_ID} | failed to create thumbnail for ${scene.name}`, error);
    return null;
  }
}

/**
 * @param {Scene} scene
 * @param {string|null|undefined} src Data-relative path or URL
 * @param {{ refreshThumb?: boolean }} [options]
 */
export async function applySceneBackground(scene, src, options = {}) {
  if (!scene || !src) {
    return false;
  }
  const path = String(src).trim();
  if (!path) {
    return false;
  }
  const refreshThumb = options.refreshThumb !== false;

  let updated = false;

  // Foundry 14+: background lives on Level documents.
  const levels = scene.levels;
  const levelDocs = levels?.contents ?? (Array.isArray(levels) ? levels : levels ? [...levels] : []);
  if (levelDocs.length) {
    const initialId = scene.initialLevel ?? scene.system?.initialLevel ?? null;
    const target =
      (initialId && levels?.get?.(initialId)) ||
      levelDocs.find((level) => level.id === initialId || level._id === initialId) ||
      levelDocs[0];
    const levelId = target?.id ?? target?._id;
    if (levelId && typeof scene.updateEmbeddedDocuments === "function") {
      try {
        await scene.updateEmbeddedDocuments("Level", [
          { _id: levelId, background: { src: path } }
        ]);
        updated = true;
        console.log(`${MODULE_ID} | scene ${scene.name}: level ${levelId} background → ${path}`);
      } catch (error) {
        console.warn(`${MODULE_ID} | failed to set Level background on ${scene.name}`, error);
      }
    }
  }

  // Foundry 13 / templates that still carry top-level background.
  try {
    await scene.update({ background: { src: path } });
    updated = true;
    console.log(`${MODULE_ID} | scene ${scene.name}: background → ${path}`);
  } catch (error) {
    // On pure v14 schemas this field may be rejected — Level update above is enough.
    if (!updated) {
      console.warn(`${MODULE_ID} | failed to set top-level background on ${scene.name}`, error);
    }
  }

  if (updated && refreshThumb) {
    await refreshSceneThumbnail(scene, { img: path });
  }

  return updated;
}
