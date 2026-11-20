/**
 * Place NPCs / descriptions onto cloned template scenes and remove unused slots.
 *
 * Template conventions (FOUNDRY_SYNC):
 * - Location/Landing NPC slots: 1A1, 2A1, 2A2, ...
 * - Landing PC slots: 3P1 ... 6P6
 * - Location field drawings (by text/name): Description, POIs / Points of Interest,
 *   Session Notes… — plus legacy Description 1–3 (Description 4 is unused leftover)
 * - Battlemaps: ignore A#/P# placeholders; create enemy + party roster lines in
 *   the bottom canvas padding (footprint-spaced, flush to canvas bottom)
 */

import { FLAG_SCOPE, MODULE_ID } from "../constants.mjs";
import { pickTokenTexture, tokenDisplayHover } from "./tokenArt.mjs";

const NPC_SLOT_RE = /^(\d+)A(\d+)$/i;
const PC_SLOT_RE = /^(\d+)P(\d+)$/i;

const CREATE_LAYOUT = {
  description: { x: 100, y: 100 },
  pois: { x: 100, y: 520 },
  sessionNotes: { x: 100, y: 940 }
};

/**
 * Classify a drawing label into a managed location field kind.
 * @param {string} label
 * @returns {"description"|"pois"|"sessionNotes"|"leftover"|null}
 */
export function classifyLocationFieldLabel(label) {
  const text = String(label ?? "").trim();
  if (!text) {
    return null;
  }
  if (/^Session\s+Notes?(?:\.{0,3}|…)?$/i.test(text)) {
    return "sessionNotes";
  }
  if (/^(?:POIs?|Points?\s+of\s+Interest)$/i.test(text)) {
    return "pois";
  }
  // Bare "Description" (new templates) — not Description 2/3/4.
  if (/^Description$/i.test(text)) {
    return "description";
  }
  // Legacy randomised boxes.
  if (/^Description\s*1$/i.test(text)) {
    return "description";
  }
  if (/^Description\s*2$/i.test(text)) {
    return "pois";
  }
  if (/^Description\s*3$/i.test(text)) {
    return "sessionNotes";
  }
  if (/^Description\s*4$/i.test(text)) {
    return "leftover";
  }
  return null;
}

/**
 * Partition location template drawings into dedicated field boxes.
 * Prefer the first match per kind; duplicates and Description 4 go to leftovers.
 *
 * @param {Iterable<object>} drawings
 * @returns {{
 *   description: object|null,
 *   pois: object|null,
 *   sessionNotes: object|null,
 *   leftovers: object[],
 *   managed: object[]
 * }}
 */
export function classifyLocationFieldDrawings(drawings) {
  const result = {
    description: null,
    pois: null,
    sessionNotes: null,
    leftovers: [],
    managed: []
  };
  for (const drawing of drawings ?? []) {
    const kind = classifyLocationFieldLabel(drawing?.text ?? drawing?.name);
    if (!kind) {
      continue;
    }
    result.managed.push(drawing);
    if (kind === "leftover") {
      result.leftovers.push(drawing);
      continue;
    }
    if (!result[kind]) {
      result[kind] = drawing;
    } else {
      result.leftovers.push(drawing);
    }
  }
  return result;
}

export async function finalizeLocationScene(
  scene,
  { description = "", poisText = "", sessionNotes = "", npcs = [] } = {}
) {
  if (!scene) return;
  const npcSlots = listNpcSlots(scene);
  const classified = classifyLocationFieldDrawings(
    scene.drawings?.contents ?? scene.drawings ?? []
  );
  const hasManagedBoxes = classified.managed.length > 0;

  const deleteDrawingIds = classified.leftovers.map((d) => d.id).filter(Boolean);

  await applyLocationFieldDrawing(scene, {
    kind: "description",
    text: description,
    drawing: classified.description,
    hasManagedBoxes,
    deleteDrawingIds
  });
  await applyLocationFieldDrawing(scene, {
    kind: "pois",
    text: poisText,
    drawing: classified.pois,
    hasManagedBoxes,
    deleteDrawingIds
  });
  await applyLocationFieldDrawing(scene, {
    kind: "sessionNotes",
    text: sessionNotes,
    drawing: classified.sessionNotes,
    hasManagedBoxes,
    deleteDrawingIds
  });

  const usedNpcIds = await placeNpcsOnScene(scene, npcs, npcSlots);

  const deleteTokenIds = npcSlots
    .map((t) => t.id)
    .filter((id) => !usedNpcIds.has(id));

  // Also clear leftover PC placeholders on location scenes
  deleteTokenIds.push(...listPcSlots(scene).map((t) => t.id));

  await deleteEmbedded(scene, deleteDrawingIds, deleteTokenIds);
}

export async function finalizeLandingScene(scene, pcs = []) {
  if (!scene) return;
  // Prefer dedicated PC slots (3P1…); fall back to A-slots used by the bundled landing template.
  const pcSlots = listPcSlots(scene);
  const slots = pcSlots.length ? pcSlots : listNpcSlots(scene);
  const usedPcIds = await placePcsOnScene(scene, pcs, slots);

  const deleteDrawingIds = listManagedFieldDrawings(scene).map((d) => d.id);
  const deleteTokenIds = [
    ...(pcSlots.length ? listNpcSlots(scene).map((t) => t.id) : []),
    ...slots.map((t) => t.id).filter((id) => !usedPcIds.has(id))
  ];
  await deleteEmbedded(scene, deleteDrawingIds, deleteTokenIds);
}

export async function finalizeUtilityScene(scene) {
  if (!scene) return;
  const deleteDrawingIds = listManagedFieldDrawings(scene).map((d) => d.id);
  const deleteTokenIds = [
    ...listNpcSlots(scene).map((t) => t.id),
    ...listPcSlots(scene).map((t) => t.id)
  ];
  await deleteEmbedded(scene, deleteDrawingIds, deleteTokenIds);
}

/**
 * Place combat enemies (unlinked) and party (linked PCs + pets) on a battlemap.
 *
 * Layout: two footprint-spaced rows flush to the canvas bottom (below the map
 * art). Enemies on the upper row; PCs then their pets on the lower row.
 * Template A#/P# placeholders are deleted — tokens are always created fresh.
 *
 * @param {Scene} scene
 * @param {{
 *   enemies?: Array<{ actor: Actor, count?: number }>,
 *   party?: Array<{ actor: Actor, linked?: boolean, kind?: string }>
 * }} [options]
 */
export async function finalizeBattlemapScene(scene, options = {}) {
  if (!scene) return;
  const enemies = options.enemies ?? (Array.isArray(options) ? options : []);
  const party = options.party ?? [];

  const expandedEnemies = [];
  for (const row of enemies) {
    const count = Math.max(1, Number(row?.count) || 1);
    for (let i = 0; i < count; i += 1) {
      expandedEnemies.push({
        actor: row.actor,
        linked: false,
        kind: "battle-enemy",
        variantIndex: count > 1 ? i : undefined,
        suffix: count > 1 ? ` ${i + 1}` : ""
      });
    }
  }

  const partyRows = (party ?? [])
    .filter((row) => row?.actor)
    .map((row) => ({
      actor: row.actor,
      linked: row.linked !== false,
      kind: row.kind || "battle-party",
      suffix: ""
    }));

  // Drop all template placeholders and managed field drawings on battlemaps.
  const deleteDrawingIds = listManagedFieldDrawings(scene).map((d) => d.id);
  const deleteTokenIds = [
    ...listNpcSlots(scene).map((t) => t.id),
    ...listPcSlots(scene).map((t) => t.id)
  ];
  await deleteEmbedded(scene, deleteDrawingIds, deleteTokenIds);

  const metrics = sceneCanvasMetrics(scene);
  const grid = Math.max(1, Number(scene.grid?.size ?? metrics.gridSize ?? 100));
  const enemySpecs = expandedEnemies.map((row) => tokenPlacementSpec(row));
  const partySpecs = partyRows.map((row) => tokenPlacementSpec(row));

  const layout = layoutBattlemapRosterLines({
    metrics,
    grid,
    enemySpecs,
    partySpecs
  });

  const create = [...layout.enemyTokens, ...layout.partyTokens];
  if (create.length) {
    await scene.createEmbeddedDocuments("Token", create);
  }
}

/**
 * Scene canvas metrics including padding / map art rectangle.
 * @param {Scene} scene
 */
export function sceneCanvasMetrics(scene) {
  const dims = scene?.dimensions ?? {};
  const width = Number(dims.width ?? scene?.width ?? 4000) || 4000;
  const height = Number(dims.height ?? scene?.height ?? 3000) || 3000;
  const sceneWidth = Number(dims.sceneWidth ?? scene?.width ?? width) || width;
  const sceneHeight = Number(dims.sceneHeight ?? scene?.height ?? height) || height;
  const sceneX = Number(dims.sceneX ?? 0) || 0;
  const sceneY = Number(dims.sceneY ?? 0) || 0;
  const gridSize = Number(scene?.grid?.size ?? dims.size ?? 100) || 100;
  return {
    width,
    height,
    sceneWidth,
    sceneHeight,
    sceneX,
    sceneY,
    mapBottom: sceneY + sceneHeight,
    canvasBottom: height,
    gridSize
  };
}

/**
 * @param {{ actor: Actor, linked?: boolean, kind?: string, suffix?: string }} row
 */
export function tokenPlacementSpec(row) {
  const actor = row.actor;
  const proto = actor?.prototypeToken ?? {};
  const width = Math.max(0.5, Number(proto.width) || 1);
  const height = Math.max(0.5, Number(proto.height) || 1);
  const textureSrc = pickTokenTexture(actor, row.variantIndex, FLAG_SCOPE);
  const scaleX = Number(proto?.texture?.scaleX);
  const scaleY = Number(proto?.texture?.scaleY);
  return {
    name: `${actor.name}${row.suffix || ""}`,
    actorId: actor.id,
    actorUuid: actor.uuid,
    linked: Boolean(row.linked),
    kind: row.kind || "battle-token",
    width,
    height,
    textureSrc,
    scaleX: Number.isFinite(scaleX) && scaleX > 0 ? scaleX : undefined,
    scaleY: Number.isFinite(scaleY) && scaleY > 0 ? scaleY : undefined
  };
}

/**
 * Compute Token create payloads for enemy + party rows flush to canvas bottom.
 * Footprints are spaced horizontally; each row shares a baseline so Large+
 * tokens sit lower (their top stays at/below the row above / map).
 *
 * @param {{
 *   metrics: ReturnType<typeof sceneCanvasMetrics>,
 *   grid: number,
 *   enemySpecs: ReturnType<typeof tokenPlacementSpec>[],
 *   partySpecs: ReturnType<typeof tokenPlacementSpec>[]
 * }} opts
 */
export function layoutBattlemapRosterLines({
  metrics,
  grid,
  enemySpecs = [],
  partySpecs = []
}) {
  const gap = Math.max(8, Math.floor(grid * 0.25));
  const rowGap = Math.max(16, Math.floor(grid * 0.5));
  const maxPartyH = partySpecs.reduce((max, spec) => Math.max(max, spec.height), 0);
  const maxEnemyH = enemySpecs.reduce((max, spec) => Math.max(max, spec.height), 0);

  // Party baseline flush with canvas bottom; enemy baseline above party row.
  const partyBaseline = metrics.canvasBottom;
  let enemyBaseline =
    partySpecs.length && maxPartyH > 0
      ? partyBaseline - maxPartyH * grid - rowGap
      : partyBaseline;
  // Keep enemy tops at or below the map art bottom when padding allows.
  if (maxEnemyH > 0) {
    const minEnemyBaseline = metrics.mapBottom + maxEnemyH * grid;
    if (enemyBaseline < minEnemyBaseline && minEnemyBaseline <= metrics.canvasBottom) {
      enemyBaseline = minEnemyBaseline;
    }
  }

  const centerLine = (specs, baseline) => {
    if (!specs.length) {
      return [];
    }
    const totalWidth =
      specs.reduce((sum, spec) => sum + spec.width * grid, 0) + gap * (specs.length - 1);
    const mapCenterX = metrics.sceneX + metrics.sceneWidth / 2;
    let x = mapCenterX - totalWidth / 2;
    // Keep the line on-canvas.
    x = Math.max(0, Math.min(x, Math.max(0, metrics.width - totalWidth)));
    return specs.map((spec) => {
      const tokenWidthPx = spec.width * grid;
      const tokenHeightPx = spec.height * grid;
      const token = {
        name: spec.name,
        actorId: spec.actorId,
        actorLink: spec.linked,
        ...(spec.kind === "battle-enemy"
          ? { lockRotation: true, displayName: tokenDisplayHover() }
          : {}),
        width: spec.width,
        height: spec.height,
        x: Math.round(x),
        y: Math.round(baseline - tokenHeightPx),
        flags: {
          [FLAG_SCOPE]: {
            kind: spec.kind,
            actorUuid: spec.actorUuid
          }
        }
      };
      if (spec.textureSrc) {
        token.texture = {
          src: spec.textureSrc,
          ...(spec.scaleX != null ? { scaleX: spec.scaleX } : {}),
          ...(spec.scaleY != null ? { scaleY: spec.scaleY } : {})
        };
      }
      x += tokenWidthPx + gap;
      return token;
    });
  };

  return {
    enemyTokens: centerLine(enemySpecs, enemyBaseline),
    partyTokens: centerLine(partySpecs, partyBaseline),
    enemyBaseline,
    partyBaseline
  };
}

/**
 * Place unplaced NPCs (and optional item notes) onto the Leftovers scene.
 */
export async function finalizeLeftoversScene(scene, { npcs = [], itemNotes = [] } = {}) {
  if (!scene) return;
  const npcSlots = listNpcSlots(scene);
  const usedNpcIds = await placeNpcsOnScene(scene, npcs, npcSlots);
  const deleteDrawingIds = listManagedFieldDrawings(scene).map((d) => d.id);
  const deleteTokenIds = [
    ...npcSlots.map((t) => t.id).filter((id) => !usedNpcIds.has(id)),
    ...listPcSlots(scene).map((t) => t.id)
  ];
  await deleteEmbedded(scene, deleteDrawingIds, deleteTokenIds);

  if (itemNotes.length) {
    const width = scene.width ?? 4000;
    const notes = itemNotes.map((note, index) => {
      const count = itemNotes.length;
      const spacing = Math.max(120, Math.floor(width / (count + 1)));
      return {
        entryId: note.entryId ?? null,
        pageId: note.pageId ?? null,
        text: note.name,
        x: spacing * (index + 1),
        y: Math.floor((scene.height ?? 2000) * 0.35),
        icon: note.img || "icons/svg/item-bag.svg",
        iconSize: 64,
        fontSize: 24,
        textAnchor: 1,
        flags: {
          [FLAG_SCOPE]: {
            kind: "leftover-item",
            dlceId: note.dlceId ?? null,
            itemUuid: note.uuid ?? null
          }
        }
      };
    });
    await scene.createEmbeddedDocuments("Note", notes);
  }
}

async function applyLocationFieldDrawing(
  scene,
  { kind, text, drawing, hasManagedBoxes, deleteDrawingIds }
) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    if (drawing?.id) {
      deleteDrawingIds.push(drawing.id);
    }
    return;
  }
  if (drawing) {
    await scene.updateEmbeddedDocuments("Drawing", [
      {
        _id: drawing.id,
        text: trimmed,
        hidden: true,
        flags: {
          ...(drawing.flags ?? {}),
          [FLAG_SCOPE]: { kind, used: true }
        }
      }
    ]);
    return;
  }
  // Only create when the template has no managed field boxes at all.
  if (hasManagedBoxes) {
    return;
  }
  const layout = CREATE_LAYOUT[kind] ?? CREATE_LAYOUT.description;
  await scene.createEmbeddedDocuments("Drawing", [
    {
      x: layout.x,
      y: layout.y,
      shape: { type: "r", width: 800, height: 400 },
      text: trimmed,
      hidden: true,
      fontSize: 48,
      strokeWidth: 0,
      flags: { [FLAG_SCOPE]: { kind, used: true } }
    }
  ]);
}

async function placeNpcsOnScene(scene, npcs, slots) {
  const used = new Set();
  const updates = [];
  const create = [];

  for (let i = 0; i < npcs.length; i += 1) {
    const actor = npcs[i]?.actor;
    if (!actor) continue;
    const textureSrc = pickTokenTexture(actor, undefined, FLAG_SCOPE);

    if (i < slots.length) {
      const token = slots[i];
      used.add(token.id);
      updates.push({
        _id: token.id,
        name: actor.name,
        actorId: actor.id,
        actorLink: true,
        ...(textureSrc ? { "texture.src": textureSrc } : {}),
        flags: {
          ...(token.flags ?? {}),
          [FLAG_SCOPE]: {
            kind: "npc-slot",
            used: true,
            slot: token.name,
            actorUuid: actor.uuid
          }
        }
      });
      continue;
    }

    const index = i - slots.length;
    const width = scene.width ?? 4000;
    const count = Math.max(npcs.length - slots.length, 1);
    const spacing = Math.max(150, Math.floor(width / (count + 1)));
    create.push({
      name: actor.name,
      actorId: actor.id,
      actorLink: true,
      x: spacing * (index + 1),
      y: 80,
      ...(textureSrc ? { texture: { src: textureSrc } } : {}),
      flags: { [FLAG_SCOPE]: { kind: "npc-overflow", actorUuid: actor.uuid } }
    });
  }

  if (updates.length) {
    await scene.updateEmbeddedDocuments("Token", updates);
  }
  if (create.length) {
    await scene.createEmbeddedDocuments("Token", create);
  }
  return used;
}

async function placePcsOnScene(scene, pcs, slots) {
  const used = new Set();
  const updates = [];
  for (let i = 0; i < Math.min(pcs.length, slots.length); i += 1) {
    const actor = pcs[i]?.actor;
    const token = slots[i];
    if (!actor || !token) continue;
    used.add(token.id);
    const textureSrc = pickTokenTexture(actor, undefined, FLAG_SCOPE);
    updates.push({
      _id: token.id,
      name: actor.name,
      actorId: actor.id,
      actorLink: true,
      ...(textureSrc ? { "texture.src": textureSrc } : {}),
      flags: {
        ...(token.flags ?? {}),
        [FLAG_SCOPE]: {
          kind: "pc-slot",
          used: true,
          slot: token.name,
          actorUuid: actor.uuid
        }
      }
    });
  }
  if (updates.length) {
    await scene.updateEmbeddedDocuments("Token", updates);
  }
  return used;
}

async function deleteEmbedded(scene, drawingIds, tokenIds) {
  const drawings = [...new Set(drawingIds.filter(Boolean))];
  const tokens = [...new Set(tokenIds.filter(Boolean))];
  if (drawings.length) {
    await scene.deleteEmbeddedDocuments("Drawing", drawings);
  }
  if (tokens.length) {
    await scene.deleteEmbeddedDocuments("Token", tokens);
  }
  console.log(
    `${MODULE_ID} | ${scene.name}: removed ${tokens.length} unused tokens, ${drawings.length} unused description drawings`
  );
}

function listNpcSlots(scene) {
  return [...(scene.tokens?.contents ?? scene.tokens ?? [])]
    .filter((token) => NPC_SLOT_RE.test(String(token.name ?? "").trim()))
    .sort(compareSlots);
}

function listPcSlots(scene) {
  return [...(scene.tokens?.contents ?? scene.tokens ?? [])]
    .filter((token) => PC_SLOT_RE.test(String(token.name ?? "").trim()))
    .sort(compareSlots);
}

function listManagedFieldDrawings(scene) {
  return [...(scene.drawings?.contents ?? scene.drawings ?? [])].filter(
    (drawing) => classifyLocationFieldLabel(drawing.text ?? drawing.name) != null
  );
}

function compareSlots(a, b) {
  const pa = parseSlot(a.name);
  const pb = parseSlot(b.name);
  if (pa.major !== pb.major) return pa.major - pb.major;
  return pa.minor - pb.minor;
}

function parseSlot(name) {
  const text = String(name ?? "").trim();
  const npc = text.match(NPC_SLOT_RE);
  if (npc) return { major: Number(npc[1]), minor: Number(npc[2]) };
  const pc = text.match(PC_SLOT_RE);
  if (pc) return { major: Number(pc[1]), minor: Number(pc[2]) };
  return { major: 99, minor: 99 };
}
