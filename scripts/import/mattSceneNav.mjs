/**
 * Monk's Active Tile Triggers — scene navigation strips on Location / Landing / Outro.
 *
 * Expo Location template: ~22 landscape tiles (left/bottom padding) for
 * Landing → locations → Outro; ~6 portrait tiles (right padding) for battlemaps.
 * Click → DLFI views the target scene (GM). The MATT scene action is only the
 * click trigger; DLFI cancels it, repaints the destination, views it, then
 * repaints the scene you left. Hover shows the scene name via the tooltip hook.
 *
 * Left list order: Landing → locations (MSD order) → Outro.
 * When more than 22 targets, each scene gets a rolling window that starts shifting
 * from Scene 10 (1-based).
 */

import { FLAG_SCOPE, MODULE_ID, notify } from "../constants.mjs";
import { bareSceneTitle } from "./sceneOrder.mjs";
import { resolveSceneBackgroundSrc } from "./applySceneBackground.mjs";
import { sceneCanvasMetrics } from "./scenePlacement.mjs";

export const MONKS_ACTIVE_TILES_ID = "monks-active-tiles";
export const LEFT_NAV_SLOTS = 22;
export const RIGHT_NAV_SLOTS = 6;
/** 1-based index where the left rolling window begins (Scene 10). */
export const LEFT_NAV_ROLL_FROM = 10;
/** Max NPC token faces on a left nav thumbnail (locations only). */
export const NAV_FACE_MAX = 5;
/**
 * Face tile size in scene pixels (matches hand-tuned Expo scene).
 * Texture scale {@link NAV_FACE_TEXTURE_SCALE} draws the circular ring larger.
 */
export const NAV_FACE_SIZE = 72;
/** Token-art scale on face tiles (hand-tuned: ring sits on the thumb bottom). */
export const NAV_FACE_TEXTURE_SCALE = 1.2;
/** Centre-to-centre spacing for a multi-face row (hand-tuned: ±60 from parent centre). */
export const NAV_FACE_CENTER_SPACING = 120;
/**
 * Foundry V13+: TileDocument x/y is the mesh origin (texture.anchor). Expo nav
 * tiles use anchor 0.5/0.5, so x/y is the centre of the rectangle — not top-left.
 */
export const NAV_TILE_ANCHOR = 0.5;
/**
 * Nav placeholders are ~448×252 (left) / ~320×440 (right). Outro/Landing centre
 * art ("Title Only" / "Logo Only", Thanks for Playing) is ~1600×900 and must
 * never be treated as a nav slot — even when the template left MATT flags on it.
 */
export const NAV_TILE_MAX_EDGE = 700;

/**
 * @returns {boolean}
 */
export function isMonksActiveTilesActive() {
  const modules = globalThis.game?.modules;
  return Boolean(modules?.get?.(MONKS_ACTIVE_TILES_ID)?.active);
}

/**
 * Centre-stage Landing/Outro artwork tiles that must keep their texture.
 * @param {object} tile
 * @returns {boolean}
 */
export function isProtectedArtTile(tile) {
  const kind = tile?.flags?.[FLAG_SCOPE]?.kind;
  if (kind === "matt-nav-face") {
    return true;
  }
  const name = String(tile?.name ?? "").trim();
  if (/^(logo|title)\s*only$/i.test(name)) {
    return true;
  }
  if (/thanks\s*for\s*playing/i.test(name)) {
    return true;
  }
  const src = String(tile?.texture?.src ?? tile?.img ?? "");
  if (/Logo[_ ]?Only|Title[_ ]?Only|Thanks[%+ ]?for[%+ ]?Playing/i.test(src)) {
    return true;
  }
  return false;
}

/**
 * True when a tile is a MATT nav placeholder (small left/right strip slots).
 * Excludes inactive MATT overlays, NPC faces, and Logo/Title Only centre art.
 * @param {object} tile
 * @returns {boolean}
 */
export function isMattNavSlotTile(tile) {
  const flags = tile?.flags?.[MONKS_ACTIVE_TILES_ID];
  if (!flags || typeof flags !== "object") {
    return false;
  }
  // Outro "Title Only" ships with MATT flags but active:false — never a nav slot.
  if (flags.active === false) {
    return false;
  }
  if (isProtectedArtTile(tile)) {
    return false;
  }
  return !isOversizedTile(tile);
}

/**
 * Backgrounds / centre art: too big to be a nav thumbnail.
 * @param {object} tile
 */
export function isOversizedTile(tile) {
  const w = Math.max(1, Number(tile?.width) || 1);
  const h = Math.max(1, Number(tile?.height) || 1);
  return Math.max(w, h) > NAV_TILE_MAX_EDGE;
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
  return isMattNavSlotTile(tile);
}

/**
 * Landscape MATT tiles → location nav (left/bottom); portrait → battlemap nav (right).
 * Prefer aspect over x so bottom-row location thumbs under the map art still count as left.
 * @param {object} tile
 * @param {ReturnType<typeof sceneCanvasMetrics>} [_metrics]
 * @returns {"left"|"right"|null}
 */
export function classifyMattNavSide(tile, _metrics) {
  if (!isMattNavSlotTile(tile)) {
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

/** Best-effort scene background / art path for a nav thumb. */
export const sceneArtSrc = resolveSceneBackgroundSrc;

/**
 * Read tile scene geometry. Prefer `toObject()` / `_source` so we never pick up
 * PIXI display sizes. Foundry V13+ x/y is the mesh origin (see anchor).
 * @param {object} tile
 * @returns {{
 *   id: string|null,
 *   x: number,
 *   y: number,
 *   width: number,
 *   height: number,
 *   sort: number,
 *   anchorX: number,
 *   anchorY: number,
 *   left: number,
 *   top: number,
 *   right: number,
 *   bottom: number,
 *   flags: object
 * }}
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
  const tex = src.texture ?? doc?.texture ?? {};
  const anchorX = Number(tex.anchorX);
  const anchorY = Number(tex.anchorY);
  const ax = Number.isFinite(anchorX) ? anchorX : NAV_TILE_ANCHOR;
  const ay = Number.isFinite(anchorY) ? anchorY : NAV_TILE_ANCHOR;
  const cx = Number.isFinite(x) ? x : 0;
  const cy = Number.isFinite(y) ? y : 0;
  const w = Number.isFinite(width) && width > 0 ? width : 1;
  const h = Number.isFinite(height) && height > 0 ? height : 1;
  const left = cx - w * ax;
  const top = cy - h * ay;
  return {
    id: doc?.id ?? doc?._id ?? src?._id ?? null,
    x: cx,
    y: cy,
    width: w,
    height: h,
    sort: Number.isFinite(sort) ? sort : 0,
    anchorX: ax,
    anchorY: ay,
    left,
    top,
    right: left + w,
    bottom: top + h,
    flags: doc?.flags ?? src?.flags ?? {}
  };
}

/**
 * Axis-aligned scene bounds for a tile, honouring texture.anchor (V13 centre origin).
 * @param {object} tile
 * @returns {{ x: number, y: number, x2: number, y2: number, width: number, height: number }}
 */
export function navTileAxisBounds(tile) {
  const geom = navTileGeometry(tile);
  return {
    x: geom.left,
    y: geom.top,
    x2: geom.right,
    y2: geom.bottom,
    width: geom.width,
    height: geom.height
  };
}

/**
 * Layout NPC token-art faces on a left nav thumbnail.
 *
 * Rules (from hand-tuned Expo scene `01. 📍 Korbane Village Approach`):
 * - Face tile is 72×72 with texture scale 1.2, fit=fill, anchor 0.5/0.5
 * - Foundry V13 x/y is the tile centre (anchor 0.5)
 * - Single face: same centre-x as parent; centre-y so the face box sits on the
 *   thumb bottom → `y = parent.y + (parent.height - faceSize) / 2`
 * - Multiple faces: same y; centres spaced {@link NAV_FACE_CENTER_SPACING} apart,
 *   row centred on parent.x
 *
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
  const size = NAV_FACE_SIZE;
  // Bottom-align face centres with parent: parent.y + ph/2 - size/2
  // (with centre-origin coords this is parent.y + (ph - size) / 2).
  const faceY = geom.y + (geom.height - size) / 2;
  const spacing = NAV_FACE_CENTER_SPACING;
  const firstCenterX = geom.x - ((max - 1) * spacing) / 2;
  const sort = geom.sort + 1;
  /** @type {object[]} */
  const created = [];
  for (let i = 0; i < max; i += 1) {
    const face = list[i];
    created.push({
      name: String(face.name || "NPC").trim() || "NPC",
      x: Math.round(firstCenterX + i * spacing),
      y: Math.round(faceY),
      width: size,
      height: size,
      rotation: 0,
      alpha: 1,
      hidden: false,
      locked: false,
      sort,
      texture: {
        src: face.img,
        scaleX: NAV_FACE_TEXTURE_SCALE,
        scaleY: NAV_FACE_TEXTURE_SCALE,
        anchorX: NAV_TILE_ANCHOR,
        anchorY: NAV_TILE_ANCHOR,
        fit: "fill"
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
 * Disable accidental MATT triggers on Logo/Title Only / Thanks for Playing tiles
 * and on any oversized tile (never a nav slot), without changing texture or geometry.
 * @param {Scene} scene
 * @returns {object[]}
 */
export function protectedArtMattStripUpdates(scene) {
  const tiles = [...(scene?.tiles?.contents ?? scene?.tiles ?? [])];
  /** @type {object[]} */
  const updates = [];
  for (const tile of tiles) {
    const kind = tile?.flags?.[FLAG_SCOPE]?.kind;
    if (kind === "matt-nav-face") {
      continue;
    }
    if (!isProtectedArtTile(tile) && !isOversizedTile(tile)) {
      continue;
    }
    const matt = tile.flags?.[MONKS_ACTIVE_TILES_ID];
    if (!matt || typeof matt !== "object") {
      continue;
    }
    if (matt.active === false && !(matt.actions ?? []).length) {
      continue;
    }
    const id = tile.id ?? tile._id;
    if (!id) {
      continue;
    }
    // Keep texture/name; just disarm MATT so centre art never navigates.
    updates.push({
      _id: id,
      flags: {
        ...(tile.flags ?? {}),
        [MONKS_ACTIVE_TILES_ID]: {
          ...matt,
          active: false,
          pointer: false,
          actions: []
        }
      }
    });
  }
  return updates;
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
  const protectUpdates = protectedArtMattStripUpdates(scene);
  if (!left.length && !right.length && !protectUpdates.length) {
    return { updated: 0, deleted: 0, faces: 0 };
  }

  const leftTargets = targets.leftTargets ?? [];
  const rightTargets = targets.rightTargets ?? [];
  /** @type {object[]} */
  const updates = [...protectUpdates];
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
  const hoverName = bareSceneTitle(sceneName) || sceneName;
  const patch = {
    _id: id,
    // Hover / nameplate label: bare scene title, without the order or emoji.
    name: hoverName,
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
    const message =
      "Monk's Active Tile Triggers is not active — scene-nav tiles were left as template placeholders. Enable MATT and re-import or Sync.";
    if (globalThis.ui?.notifications && globalThis.game?.user?.isGM) {
      notify(message, { type: "warn" });
    } else {
      console.warn(`${MODULE_ID} | ${message}`);
    }
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
