/**
 * Bundled scene / actor templates shipped with the module.
 * Used when module settings have no Scene id/UUID configured,
 * and when creating PC character stubs.
 */

import { MODULE_ID } from "../constants.mjs";

const BUNDLED = {
  location: "templates/scenes/location.json",
  battlemap: "templates/scenes/battlemap.json",
  landing: "templates/scenes/landing.json",
  leftovers: "templates/scenes/leftovers.json"
};

const BUNDLED_PC_ACTOR = "templates/actors/player-character.json";

/** @type {Map<string, object>} */
const cache = new Map();

/**
 * @param {string} cacheKey
 * @param {string} rel module-relative path
 * @returns {Promise<object|null>}
 */
async function loadBundledJson(cacheKey, rel) {
  if (cache.has(cacheKey)) {
    return foundry.utils.duplicate(cache.get(cacheKey));
  }
  const url = `modules/${MODULE_ID}/${rel}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    cache.set(cacheKey, data);
    return foundry.utils.duplicate(data);
  } catch (error) {
    console.warn(`${MODULE_ID} | failed to load bundled template ${cacheKey} from ${url}`, error);
    return null;
  }
}

/**
 * @param {"location"|"battlemap"|"landing"|"leftovers"} kind
 * @returns {Promise<object|null>}
 */
export async function loadBundledSceneTemplate(kind) {
  const rel = BUNDLED[kind];
  if (!rel) {
    return null;
  }
  return loadBundledJson(kind, rel);
}

/**
 * Bundled empty Player Character actor (DDB-ready stub scaffold).
 * @returns {Promise<object|null>}
 */
export async function loadBundledPcActorTemplate() {
  return loadBundledJson("pc-actor", BUNDLED_PC_ACTOR);
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
