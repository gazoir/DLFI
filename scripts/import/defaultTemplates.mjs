/**
 * Bundled scene templates shipped with the module.
 * Used when module settings have no Scene id/UUID configured.
 */

import { MODULE_ID } from "../constants.mjs";

const BUNDLED = {
  location: "templates/scenes/location.json",
  battlemap: "templates/scenes/battlemap.json",
  landing: "templates/scenes/landing.json",
  leftovers: "templates/scenes/leftovers.json"
};

/** @type {Map<string, object>} */
const cache = new Map();

/**
 * @param {"location"|"battlemap"|"landing"|"leftovers"} kind
 * @returns {Promise<object|null>}
 */
export async function loadBundledSceneTemplate(kind) {
  const rel = BUNDLED[kind];
  if (!rel) {
    return null;
  }
  if (cache.has(kind)) {
    return foundry.utils.duplicate(cache.get(kind));
  }
  const url = `modules/${MODULE_ID}/${rel}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    cache.set(kind, data);
    return foundry.utils.duplicate(data);
  } catch (error) {
    console.warn(`${MODULE_ID} | failed to load bundled template ${kind} from ${url}`, error);
    return null;
  }
}

/**
 * Create a world Scene from a bundled template JSON.
 * @param {"location"|"battlemap"|"landing"|"leftovers"} kind
 * @param {string} name
 * @param {object} [extra]
 * @returns {Promise<Scene|null>}
 */
export async function createSceneFromBundledTemplate(kind, name, extra = {}) {
  const data = await loadBundledSceneTemplate(kind);
  if (!data) {
    return null;
  }
  delete data._id;
  data.name = name;
  data.navigation = false;
  data.navName = "";
  data.active = false;
  data.folder = extra.folder ?? data.folder ?? null;
  data.flags = {
    ...(data.flags ?? {}),
    ...(extra.flags ?? {}),
    [MODULE_ID]: {
      ...((data.flags ?? {})[MODULE_ID] ?? {}),
      ...((extra.flags ?? {})[MODULE_ID] ?? {}),
      bundledTemplate: kind
    }
  };
  // Ensure embedded docs don't carry foreign actor ids
  for (const token of data.tokens ?? []) {
    token.actorId = null;
    token.actorLink = false;
    delete token._id;
  }
  for (const collection of ["drawings", "lights", "sounds", "notes", "tiles", "walls", "templates", "regions"]) {
    for (const emb of data[collection] ?? []) {
      delete emb._id;
    }
  }
  return Scene.create(data);
}

/**
 * Map a settings key to the bundled template kind.
 */
export function bundledKindForSetting(settingKey) {
  switch (settingKey) {
    case "templateLocation":
      return "location";
    case "templateBattlemap":
      return "battlemap";
    case "templateLanding":
      return "landing";
    case "templateInbox":
      return "leftovers";
    default:
      return null;
  }
}
