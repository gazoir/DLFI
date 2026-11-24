/**
 * Monk's Active Tile Triggers — scene navigation strips on Location / Landing / Outro.
 *
 * Expo Location template: ~22 landscape tiles (left/bottom padding) for
 * Landing → locations → Outro; ~6 portrait tiles (right padding) for battlemaps.
 * Click → view target scene (GM). Hover shows scene name via DLFI tooltip hook.
 *
 * Left list order: Landing → locations (MSD order) → Outro.
 * When more than 22 targets, each scene gets a rolling window that starts shifting
 * from Scene 10 (1-based).
 */

import { FLAG_SCOPE, MODULE_ID } from "../constants.mjs";
import { sceneCanvasMetrics } from "./scenePlacement.mjs";

export const MONKS_ACTIVE_TILES_ID = "monks-active-tiles";
export const LEFT_NAV_SLOTS = 22;
export const RIGHT_NAV_SLOTS = 6;
/** 1-based index where the left rolling window begins (Scene 10). */
export const LEFT_NAV_ROLL_FROM = 10;
/** Max NPC token faces on a left nav thumbnail (locations only). */
export const NAV_FACE_MAX = 5;
/** Face size as a fraction of the parent thumb width. */
export const NAV_FACE_SIZE_RATIO = 0.2;
/** Keep faces fully inside the thumb (px above the bottom edge). */
export const NAV_FACE_BOTTOM_INSET = 4;

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
    // Scene 10 (i=9) → start 1; Scene 11 → start 2; …
    start = index - (LEFT_NAV_ROLL_FROM - 2);
  }
  start = Math.min(start, Math.max(0, n - slots));
  return list.slice(start, start + slots);
}

/**
 * Battlemap targets for the right strip — always show every map (up to `slots`).
 * On a location, linked maps are listed first, then the rest in session order.
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
    const linked = [];
    const rest = [];
    for (const row of list) {
      if (row.hostLocationId === current.dlceId) {
        linked.push(row);
      } else {
        rest.push(row);
      }
    }
    return [...linked, ...rest].slice(0, slots);
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
 * Landscape MATT tiles → location nav (left/bottom); portrait → battlemap nav (right).
 * Prefer aspect over x so bottom-row location thumbs under the map art still count as left.
 * @param {object} tile
 * @param {ReturnType<typeof sceneCanvasMetrics>} [_metrics]
 * @returns {"left"|"right"|null}
 */
export function classifyMattNavSide(tile, _metrics) {
  if (!isMattTriggerTile(tile)) {
    return null;
  }
  const w = Math.max(1, Number(tile.width) || 1);
  const h = Math.max(1, Number(tile.height) || 1);
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
 * Read tile scene geometry. Prefer `toObject()` / `_source` so we never pick up
 * PIXI display sizes (which can be texture-pixel dimensions and shift faces).
 * @param {object} tile
 * @returns {{ id: string|null, x: number, y: number, width: number, height: number, sort: number, flags: object }}
 */
export function navTileGeometry(tile) {
  const doc = tile?.document ?? tile;
  let data = null;
  try {
    if (typeof doc?.toObject === "function") {
      data = doc.toObject();
    }
  } catch (_error) {
    data = null;
  }
  const src = data ?? doc?._source ?? doc ?? {};
  const x = Number(src.x);
  const y = Number(src.y);
  const width = Number(src.width);
  const height = Number(src.height);
  const sort = Number(src.sort);
  return {
    id: doc?.id ?? doc?._id ?? src?._id ?? null,
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    width: Number.isFinite(width) && width > 0 ? width : 1,
    height: Number.isFinite(height) && height > 0 ? height : 1,
    sort: Number.isFinite(sort) ? sort : 0,
    flags: doc?.flags ?? src?.flags ?? {}
  };
}

/**
 * Layout small token-art faces along the bottom edge of a left nav thumbnail:
 * horizontally centered, fully inside the thumb (bottom edge of face on/above
 * the nav tile bottom border). No texture scale — box size is the visual size.
 * @param {object} parentTile
 * @param {Array<{ img: string, name?: string }>} faces
 * @returns {object[]} Tile create payloads
 */
export function buildNavFaceTiles(parentTile, faces = []) {
  const list = (faces ?? []).filter((face) => face?.img);
  const max = Math.min(NAV_FACE_MAX, list.length);
  if (!max || !parentTile) {
    return [];
  }
  const geom = navTileGeometry(parentTile);
  const parentId = geom.id;
  const pw = geom.width;
  const ph = geom.height;
  // Cap face size so a row of NAV_FACE_MAX still fits inside the thumb.
  const size = Math.max(
    28,
    Math.min(72, Math.floor(pw * NAV_FACE_SIZE_RATIO), Math.floor((pw - 8) / max))
  );
  const gap = 4;
  const total = max * size + (max - 1) * gap;
  const startX = geom.x + (pw - total) / 2;
  // Bottom of face tile == bottom of nav tile, then nudge up by inset.
  const y = geom.y + ph - size - NAV_FACE_BOTTOM_INSET;
  const sort = geom.sort + 10;
  /** @type {object[]} */
  const created = [];
  for (let i = 0; i < max; i += 1) {
    const face = list[i];
    created.push({
      name: String(face.name || "NPC").trim() || "NPC",
      x: Math.round(startX + i * (size + gap)),
      y: Math.round(y),
      width: size,
      height: size,
      rotation: 0,
      alpha: 1,
      hidden: false,
      locked: false,
      sort,
      texture: {
        src: face.img,
        scaleX: 1,
        scaleY: 1,
        fit: "contain"
      },
      flags: {
        [FLAG_SCOPE]: {
          kind: "matt-nav-face",
          parentTileId: parentId,
          targetSceneId: geom.flags?.[FLAG_SCOPE]?.targetSceneId ?? null
        }
      }
    });
  }
  return created;
}

/**
 * @param {Scene} scene
 * @returns {string[]}
 */
export function listMattNavFaceTileIds(scene) {
  const tiles = [...(scene?.tiles?.contents ?? scene?.tiles ?? [])];
  return tiles
    .filter((tile) => tile?.flags?.[FLAG_SCOPE]?.kind === "matt-nav-face")
    .map((tile) => tile.id ?? tile._id)
    .filter(Boolean);
}

/**
 * Populate MATT nav tiles on one scene; delete unused placeholders.
 *
 * @param {Scene} scene
 * @param {{
 *   leftTargets: Array<{ sceneId: string, name: string, img?: string|null, kind?: string, faces?: Array<{img:string,name?:string}> }>,
 *   rightTargets: Array<{ sceneId: string, name: string, img?: string|null, kind?: string }>
 * }} targets
 * @returns {Promise<{ updated: number, deleted: number, faces: number }>}
 */
export async function populateMattSceneNav(scene, targets = {}) {
  if (!scene) {
    return { updated: 0, deleted: 0, faces: 0 };
  }
  const { left, right } = listMattNavTiles(scene);
  if (!left.length && !right.length) {
    return { updated: 0, deleted: 0, faces: 0 };
  }

  const leftTargets = targets.leftTargets ?? [];
  const rightTargets = targets.rightTargets ?? [];
  /** @type {object[]} */
  const updates = [];
  /** @type {string[]} */
  const deleteIds = [...listMattNavFaceTileIds(scene)];
  /** @type {Array<{ tileId: string, faces: object[] }>} */
  const pendingFaces = [];

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
      if (side === "left" && Array.isArray(row.faces) && row.faces.length) {
        pendingFaces.push({ tileId: id, faces: row.faces });
      }
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

  // Build faces from the live TileDocument after updates (authoritative x/y/w/h).
  /** @type {object[]} */
  const faceCreates = [];
  for (const pending of pendingFaces) {
    const live =
      scene.tiles?.get?.(pending.tileId) ??
      [...(scene.tiles?.contents ?? [])].find((t) => (t.id ?? t._id) === pending.tileId) ??
      null;
    if (!live) {
      continue;
    }
    const geom = navTileGeometry(live);
    console.log(
      `${MODULE_ID} | nav faces on ${scene.name}: parent=${pending.tileId}` +
        ` @ ${geom.x},${geom.y} ${geom.width}x${geom.height} (n=${pending.faces.length})`
    );
    faceCreates.push(...buildNavFaceTiles(live, pending.faces));
  }
  if (faceCreates.length) {
    await scene.createEmbeddedDocuments("Tile", faceCreates);
  }
  return { updated: updates.length, deleted: deleteIds.length, faces: faceCreates.length };
}

/**
 * @param {object} tile
 * @param {{ sceneId: string, name: string, img?: string|null, kind?: string }} target
 * @param {"left"|"right"} side
 */
export function mattTileUpdate(tile, target, side) {
  const id = tile.id ?? tile._id;
  const existing = tile.flags?.[MONKS_ACTIVE_TILES_ID] ?? {};
  const sceneName = String(target.name || "").trim() || "Scene";
  const patch = {
    _id: id,
    // Foundry tile name — shown in Tile HUD / config; pairs with pointer cursor.
    name: sceneName,
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
        // Hand cursor on hover so the strip feels clickable.
        pointer: true,
        vision: existing.vision ?? false,
        pertoken: existing.pertoken ?? false,
        actions: [
          buildMattSceneAction({
            id: target.sceneId,
            name: sceneName
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
    if (result.updated || result.deleted || result.faces) {
      console.log(
        `${MODULE_ID} | ${row.scene.name}: MATT nav tiles updated=${result.updated} deleted=${result.deleted}` +
          ` faces=${result.faces}` +
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
