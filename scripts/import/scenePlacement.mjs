/**
 * Place NPCs / descriptions onto cloned template scenes and remove unused slots.
 *
 * Template conventions (FOUNDRY_SYNC):
 * - NPC slots: 1A1, 2A1, 2A2, ...
 * - PC slots: 3P1 ... 6P6
 * - Location field drawings (by text/name): Description, POIs / Points of Interest,
 *   Session Notes… — plus legacy Description 1–3 (Description 4 is unused leftover)
 * - >4 NPCs beyond slots: extras in a line across the top of the scene
 */

import { FLAG_SCOPE, MODULE_ID } from "../constants.mjs";

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
 * Place combat enemies as unlinked tokens on a battlemap, then remove unused A/P slots.
 * @param {Scene} scene
 * @param {Array<{ actor: Actor, count?: number }>} enemies
 */
export async function finalizeBattlemapScene(scene, enemies = []) {
  if (!scene) return;
  const expanded = [];
  for (const row of enemies) {
    const count = Math.max(1, Number(row?.count) || 1);
    for (let i = 0; i < count; i += 1) {
      expanded.push({ actor: row.actor, suffix: count > 1 ? ` ${i + 1}` : "" });
    }
  }
  const npcSlots = listNpcSlots(scene);
  const usedNpcIds = await placeEnemyTokensOnScene(scene, expanded, npcSlots);
  const deleteDrawingIds = listManagedFieldDrawings(scene).map((d) => d.id);
  const deleteTokenIds = [
    ...npcSlots.map((t) => t.id).filter((id) => !usedNpcIds.has(id)),
    ...listPcSlots(scene).map((t) => t.id)
  ];
  await deleteEmbedded(scene, deleteDrawingIds, deleteTokenIds);
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

async function placeEnemyTokensOnScene(scene, enemies, slots) {
  const used = new Set();
  const updates = [];
  const create = [];

  for (let i = 0; i < enemies.length; i += 1) {
    const actor = enemies[i]?.actor;
    if (!actor) continue;
    const textureSrc = actor.prototypeToken?.texture?.src || actor.img || null;
    const name = `${actor.name}${enemies[i].suffix || ""}`;

    if (i < slots.length) {
      const token = slots[i];
      used.add(token.id);
      updates.push({
        _id: token.id,
        name,
        actorId: actor.id,
        actorLink: false,
        ...(textureSrc ? { "texture.src": textureSrc } : {}),
        flags: {
          ...(token.flags ?? {}),
          [FLAG_SCOPE]: {
            kind: "battle-enemy",
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
    const height = scene.height ?? 3000;
    const count = Math.max(enemies.length - slots.length, 1);
    const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / cols));
    const col = index % cols;
    const row = Math.floor(index / cols);
    const xPad = Math.max(120, Math.floor(width / (cols + 1)));
    const yPad = Math.max(120, Math.floor(height / (rows + 1)));
    create.push({
      name,
      actorId: actor.id,
      actorLink: false,
      x: xPad * (col + 1),
      y: yPad * (row + 1),
      ...(textureSrc ? { texture: { src: textureSrc } } : {}),
      flags: { [FLAG_SCOPE]: { kind: "battle-enemy", actorUuid: actor.uuid } }
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

async function placeNpcsOnScene(scene, npcs, slots) {
  const used = new Set();
  const updates = [];
  const create = [];

  for (let i = 0; i < npcs.length; i += 1) {
    const actor = npcs[i]?.actor;
    if (!actor) continue;
    const textureSrc = actor.prototypeToken?.texture?.src || actor.img || null;

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
    const textureSrc = actor.prototypeToken?.texture?.src || actor.img || null;
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
