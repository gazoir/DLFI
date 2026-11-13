/**
 * Set a Scene background image in a way that works on Foundry 13 and 14+.
 *
 * Foundry 14 moved background onto embedded Level documents
 * (`scene.levels[].background.src`). Updating top-level `background` alone
 * leaves the active level's src null — which is what the Texture Browser shows.
 */

import { MODULE_ID } from "../constants.mjs";

/**
 * @param {Scene} scene
 * @param {string|null|undefined} src Data-relative path or URL
 */
export async function applySceneBackground(scene, src) {
  if (!scene || !src) {
    return false;
  }
  const path = String(src).trim();
  if (!path) {
    return false;
  }

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

  return updated;
}
