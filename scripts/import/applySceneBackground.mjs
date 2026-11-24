/**
 * Set a Scene background image in a way that works on Foundry 13 and 14+.
 *
 * Foundry 14 moved background onto embedded Level documents
 * (`scene.levels[].background.src`). Updating top-level `background` alone
 * leaves the active level's src null — which is what the Texture Browser shows.
 *
 * After setting the background, regenerate the Scene Directory thumbnail
 * (`scene.thumb`) — Foundry does not refresh it automatically on background update.
 * V14 `Scene#createThumbnail` prefers the initial Level (the `img` option is
 * deprecated); we also fall back to `ImageHelper.createThumbnail(src)` so thumbs
 * still land when Level-based generation fails mid-import.
 */

import { MODULE_ID } from "../constants.mjs";

/**
 * Resolve the best background image path for a scene (top-level or Level).
 * @param {Scene|object|null|undefined} scene
 * @returns {string|null}
 */
export function resolveSceneBackgroundSrc(scene) {
  if (!scene) {
    return null;
  }
  const top = scene.background?.src || scene.img || null;
  if (top) {
    return String(top);
  }
  const levels = scene.levels;
  const list =
    levels?.contents ??
    (Array.isArray(levels) ? levels : levels ? [...levels] : []) ??
    scene._source?.levels ??
    [];
  const initialId = scene.initialLevel ?? scene._source?.initialLevel ?? null;
  if (initialId) {
    const match =
      levels?.get?.(initialId) ||
      list.find((level) => (level?.id ?? level?._id) === initialId);
    const src = match?.background?.src;
    if (src) {
      return String(src);
    }
  }
  for (const level of list) {
    const src = level?.background?.src;
    if (src) {
      return String(src);
    }
  }
  return null;
}

function getImageHelper() {
  return (
    globalThis.foundry?.helpers?.media?.ImageHelper ??
    globalThis.foundry?.canvas?.ImageHelper ??
    globalThis.ImageHelper ??
    null
  );
}

function thumbFromResult(data) {
  if (!data) {
    return null;
  }
  if (typeof data === "string") {
    return data;
  }
  return data.thumb ?? data.thumbnail ?? data.src ?? null;
}

/**
 * Build a thumbnail from an image path when Scene#createThumbnail is unavailable
 * or fails (common mid-import before Level textures are warm).
 * @param {string} src
 * @returns {Promise<string|null>}
 */
export async function createThumbnailFromSrc(src) {
  const path = String(src || "").trim();
  if (!path) {
    return null;
  }
  const Helper = getImageHelper();
  if (!Helper?.createThumbnail) {
    return null;
  }
  try {
    const data = await Helper.createThumbnail(path, {
      width: 300,
      height: 100,
      format: "image/webp",
      quality: 0.8
    });
    return thumbFromResult(data);
  } catch (error) {
    console.warn(`${MODULE_ID} | ImageHelper.createThumbnail failed for ${path}`, error);
    return null;
  }
}

/**
 * Regenerate the Scene Directory thumbnail for a scene.
 * @param {Scene} scene
 * @param {{ img?: string|null }} [options]
 * @returns {Promise<string|null>} thumb path/data-url when created
 */
export async function refreshSceneThumbnail(scene, options = {}) {
  if (!scene) {
    return null;
  }
  const img = options.img ? String(options.img) : resolveSceneBackgroundSrc(scene);
  let thumb = null;

  if (typeof scene.createThumbnail === "function") {
    try {
      /** @type {Record<string, unknown>} */
      const opts = {};
      // V13 still honours img; V14 prefers level (img deprecated but often still works).
      if (img) {
        opts.img = img;
      }
      const level =
        scene.initialLevel ??
        scene.levels?.contents?.[0] ??
        (Array.isArray(scene.levels) ? scene.levels[0] : null);
      if (level) {
        opts.level = level;
      }
      const data = await scene.createThumbnail(opts);
      thumb = thumbFromResult(data);
    } catch (error) {
      console.warn(
        `${MODULE_ID} | Scene#createThumbnail failed for ${scene.name}; trying ImageHelper`,
        error
      );
    }
  }

  if (!thumb && img) {
    thumb = await createThumbnailFromSrc(img);
  }

  if (thumb && typeof scene.update === "function") {
    const current = scene.thumb ?? scene.thumbnail ?? scene._source?.thumb ?? null;
    if (current !== thumb) {
      try {
        await scene.update({ thumb });
      } catch (error) {
        console.warn(`${MODULE_ID} | failed to persist thumb for ${scene.name}`, error);
        return null;
      }
    }
  }

  if (thumb) {
    console.log(`${MODULE_ID} | scene ${scene.name}: thumbnail refreshed`);
  } else if (img) {
    console.warn(`${MODULE_ID} | scene ${scene.name}: no thumbnail produced for ${img}`);
  }
  return thumb ? String(thumb) : null;
}

/**
 * Refresh Scene Directory thumbs for many scenes (e.g. end of import).
 * @param {Iterable<Scene|string|null|undefined>} scenesOrIds
 * @returns {Promise<{ attempted: number, updated: number }>}
 */
export async function refreshSceneThumbnails(scenesOrIds = []) {
  let attempted = 0;
  let updated = 0;
  for (const entry of scenesOrIds) {
    const scene =
      entry && typeof entry === "object"
        ? entry
        : globalThis.game?.scenes?.get?.(entry) ?? null;
    if (!scene) {
      continue;
    }
    attempted += 1;
    const before = scene.thumb ?? scene.thumbnail ?? null;
    const thumb = await refreshSceneThumbnail(scene);
    if (thumb && thumb !== before) {
      updated += 1;
    } else if (thumb && !before) {
      updated += 1;
    }
  }
  if (attempted) {
    console.log(`${MODULE_ID} | refreshed ${updated}/${attempted} scene thumbnails`);
  }
  return { attempted, updated };
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
