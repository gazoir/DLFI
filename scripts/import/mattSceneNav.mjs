/**
 * Monk's Active Tile Triggers — scene navigation strips on Location / Landing / Outro.
 *
 * Expo Location template: ~14 landscape tiles in left padding (locations + Landing + Outro),
 * ~4 portrait tiles in right padding (battlemaps). Click → view target scene (GM).
 *
 * Left list order: Landing → locations (MSD order) → Outro.
 * When more than 14 targets, each scene gets a rolling window that starts shifting
 * from Scene 7 (1-based): Scene 7 drops Landing and gains scene 15, etc.
 */

import { FLAG_SCOPE, MODULE_ID } from "../constants.mjs";
import { sceneCanvasMetrics } from "./scenePlacement.mjs";

export const MONKS_ACTIVE_TILES_ID = "monks-active-tiles";
export const LEFT_NAV_SLOTS = 14;
export const RIGHT_NAV_SLOTS = 4;
/** 1-based index where the left rolling window begins (Scene 7). */
export const LEFT_NAV_ROLL_FROM = 7;

/**
 * @returns {boolean}
 */
export function isMonksActiveTilesActive() {
  const modules = globalThis.game?.modules;
  return Boolean(modules?.get?.(MONKS_ACTIVE_TILES_ID)?.active);
}

/**
 * Rolling window of left-nav targets for the scene at `currentIndex` (0-based).
 * @param {object[]} targets
 * @param {number} currentIndex
 * @param {number} [slots]
 * @returns {object[]}
 */
export function leftNavWindow(targets, currentIndex, slots = LEFT_NAV_SLOTS) {
  const list = Array.isArray(targets) ? targets : [];
  const n = list.length;
  if (n <= slots) {
    return list.slice();
  }
  const index = Math.max(0, Math.min(Number(currentIndex) || 0, n - 1));
  let start = 0;
  if (index >= LEFT_NAV_ROLL_FROM - 1) {
    // Scene 7 (i=6) → start 1; Scene 8 → start 2; …
    start = index - (LEFT_NAV_ROLL_FROM - 2);
  }
  start = Math.min(start, Math.max(0, n - slots));
  return list.slice(start, start + slots);
}

/**
 * Cap battlemap targets for the right strip (prefer linked, then session order).
 * @param {object[]} battlemaps
 * @param {{ kind?: string, dlceId?: string|null }} current
 * @param {number} [slots]
 */
export function rightNavWindow(battlemaps, current = {}, slots = RIGHT_NAV_SLOTS) {
  const list = Array.isArray(battlemaps) ? battlemaps : [];
  if (!list.length) {
    return [];
  }
  if (current.kind === "location" && current.dlceId) {
    const linked = list.filter((row) => row.hostLocationId === current.dlceId);
    if (linked.length) {
      return linked.slice(0, slots);
    }
  }
  return list.slice(0, slots);
}

/**
 * @param {object} tile
 * @returns {boolean}
 */
export function isMattTriggerTile(tile) {
  const flags = tile?.flags?.[MONKS_ACTIVE_TILES_ID];
  return Boolean(flags && typeof flags === "object");
}

/**
 * Left padding = landscape nav; right padding = portrait battlemap nav.
 * @param {object} tile
 * @param {ReturnType<typeof sceneCanvasMetrics>} metrics
 * @returns {"left"|"right"|null}
 */
export function classifyMattNavSide(tile, metrics) {
  if (!isMattTriggerTile(tile)) {
    return null;
  }
  const x = Number(tile.x) || 0;
  const w = Math.max(1, Number(tile.width) || 1);
  const h = Math.max(1, Number(tile.height) || 1);
  const cx = x + w / 2;
  const mapLeft = Number(metrics?.sceneX) || 0;
  const mapRight = mapLeft + (Number(metrics?.sceneWidth) || 0);

  if (mapRight > mapLeft) {
    if (cx < mapLeft) {
      return "left";
    }
    if (cx > mapRight) {
      return "right";
    }
  }
  // Fallback: landscape → left strip, portrait → right strip.
  return w >= h ? "left" : "right";
}

/**
 * @param {Scene} scene
 * @returns {{ left: object[], right: object[] }}
 */
export function listMattNavTiles(scene) {
  const tiles = [...(scene?.tiles?.contents ?? scene?.tiles ?? [])];
  const metrics = sceneCanvasMetrics(scene);
  /** @type {object[]} */
  const left = [];
  /** @type {object[]} */
  const right = [];
  for (const tile of tiles) {
    const side = classifyMattNavSide(tile, metrics);
    if (side === "left") {
      left.push(tile);
    } else if (side === "right") {
      right.push(tile);
    }
  }
  left.sort((a, b) => Number(a.y) - Number(b.y) || Number(a.x) - Number(b.x));
  right.sort((a, b) => Number(a.y) - Number(b.y) || Number(a.x) - Number(b.x));
  return { left, right };
}

/**
 * @param {{ id: string, name: string }} scene
 */
export function buildMattSceneAction(scene) {
  return {
    action: "scene",
    data: {
      sceneid: {
        id: `Scene.${scene.id}`,
        name: String(scene.name || "")
      },
      activate: false,
      for: "trigger"
    },
    id: randomId(16)
  };
}

/**
 * Best-effort scene background / art path for a nav thumb.
 * @param {Scene|object|null} scene
 * @returns {string|null}
 */
export function sceneArtSrc(scene) {
  if (!scene) {
    return null;
  }
  const top = scene.background?.src || scene.img || null;
  if (top) {
    return String(top);
  }
  const levels = scene.levels ?? scene._source?.levels;
  if (Array.isArray(levels)) {
    for (const level of levels) {
      const src = level?.background?.src;
      if (src) {
        return String(src);
      }
    }
  }
  return null;
}

/**
 * Populate MATT nav tiles on one scene; delete unused placeholders.
 *
 * @param {Scene} scene
 * @param {{
 *   leftTargets: Array<{ sceneId: string, name: string, img?: string|null, kind?: string }>,
 *   rightTargets: Array<{ sceneId: string, name: string, img?: string|null, kind?: string }>
 * }} targets
 * @returns {Promise<{ updated: number, deleted: number }>}
 */
export async function populateMattSceneNav(scene, targets = {}) {
  if (!scene) {
    return { updated: 0, deleted: 0 };
  }
  const { left, right } = listMattNavTiles(scene);
  if (!left.length && !right.length) {
    return { updated: 0, deleted: 0 };
  }

  const leftTargets = targets.leftTargets ?? [];
  const rightTargets = targets.rightTargets ?? [];
  /** @type {object[]} */
  const updates = [];
  /** @type {string[]} */
  const deleteIds = [];

  const assign = (slots, rows, side) => {
    for (let i = 0; i < slots.length; i += 1) {
      const tile = slots[i];
      const id = tile.id ?? tile._id;
      if (!id) {
        continue;
      }
      const row = rows[i];
      if (!row?.sceneId) {
        deleteIds.push(id);
        continue;
      }
      updates.push(mattTileUpdate(tile, row, side));
    }
  };

  assign(left, leftTargets, "left");
  assign(right, rightTargets, "right");

  if (updates.length) {
    await scene.updateEmbeddedDocuments("Tile", updates);
  }
  if (deleteIds.length) {
    await scene.deleteEmbeddedDocuments("Tile", [...new Set(deleteIds)]);
  }
  return { updated: updates.length, deleted: deleteIds.length };
}

/**
 * @param {object} tile
 * @param {{ sceneId: string, name: string, img?: string|null, kind?: string }} target
 * @param {"left"|"right"} side
 */
export function mattTileUpdate(tile, target, side) {
  const id = tile.id ?? tile._id;
  const existing = tile.flags?.[MONKS_ACTIVE_TILES_ID] ?? {};
  const patch = {
    _id: id,
    flags: {
      ...(tile.flags ?? {}),
      [FLAG_SCOPE]: {
        ...(tile.flags?.[FLAG_SCOPE] ?? {}),
        kind: side === "left" ? "matt-nav-left" : "matt-nav-right",
        targetSceneId: target.sceneId,
        targetKind: target.kind ?? null
      },
      [MONKS_ACTIVE_TILES_ID]: {
        ...existing,
        active: true,
        record: existing.record ?? false,
        restriction: existing.restriction ?? "gm",
        controlled: existing.controlled ?? "all",
        trigger: Array.isArray(existing.trigger) ? existing.trigger : ["click"],
        allowpaused: existing.allowpaused ?? false,
        usealpha: existing.usealpha ?? false,
        pointer: existing.pointer ?? false,
        vision: existing.vision ?? false,
        pertoken: existing.pertoken ?? false,
        actions: [
          buildMattSceneAction({
            id: target.sceneId,
            name: target.name
          })
        ],
        files: existing.files ?? []
      }
    }
  };
  if (target.img) {
    patch["texture.src"] = target.img;
  }
  return patch;
}

/**
 * Apply rolling left + capped right nav to every Location / Landing / Outro scene.
 *
 * @param {{
 *   navScenes: Array<{ scene: Scene, kind: string, dlceId?: string|null, img?: string|null }>,
 *   leftTargets: Array<{ sceneId: string, name: string, img?: string|null, kind?: string }>,
 *   battlemaps: Array<{ sceneId: string, name: string, img?: string|null, kind?: string, hostLocationId?: string|null }>
 * }} opts
 */
export async function populateAllMattSceneNav(opts) {
  const navScenes = opts.navScenes ?? [];
  const leftTargets = opts.leftTargets ?? [];
  const battlemaps = opts.battlemaps ?? [];

  if (!navScenes.length) {
    return { scenes: 0, updated: 0, deleted: 0 };
  }
  if (!isMonksActiveTilesActive()) {
    console.warn(
      `${MODULE_ID} | Monk's Active Tile Triggers not active — skipping scene-nav tile population`
    );
    return { scenes: 0, updated: 0, deleted: 0, skipped: true };
  }

  let updated = 0;
  let deleted = 0;
  for (let i = 0; i < navScenes.length; i += 1) {
    const row = navScenes[i];
    if (!row?.scene) {
      continue;
    }
    const left = leftNavWindow(leftTargets, i);
    const right = rightNavWindow(battlemaps, {
      kind: row.kind,
      dlceId: row.dlceId ?? null
    });
    const result = await populateMattSceneNav(row.scene, {
      leftTargets: left,
      rightTargets: right
    });
    updated += result.updated;
    deleted += result.deleted;
    if (result.updated || result.deleted) {
      console.log(
        `${MODULE_ID} | ${row.scene.name}: MATT nav tiles updated=${result.updated} deleted=${result.deleted}` +
          ` (left ${left.length}/${LEFT_NAV_SLOTS}, right ${right.length}/${RIGHT_NAV_SLOTS})`
      );
    }
  }
  return { scenes: navScenes.length, updated, deleted };
}

function randomId(size = 16) {
  if (globalThis.foundry?.utils?.randomID) {
    return foundry.utils.randomID(size);
  }
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < size; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
