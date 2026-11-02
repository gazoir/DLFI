/**
 * Place NPCs / descriptions onto cloned template scenes and remove unused slots.
 *
 * Template conventions (FOUNDRY_SYNC):
 * - NPC slots: 1A1, 2A1, 2A2, ...
 * - PC slots: 3P1 ... 6P6
 * - Description drawings: names/text matching /^Description\s*[1-4]$/i
 * - >4 NPCs beyond slots: extras in a line across the top of the scene
 */

import { FLAG_SCOPE, MODULE_ID } from "../constants.mjs";

const NPC_SLOT_RE = /^(\d+)A(\d+)$/i;
const PC_SLOT_RE = /^(\d+)P(\d+)$/i;
const DESCRIPTION_RE = /^Description\s*([1-4])$/i;

export async function finalizeLocationScene(scene, { description = "", npcs = [] } = {}) {
  if (!scene) return;
  const npcSlots = listNpcSlots(scene);
  const descriptionSlots = listDescriptionDrawings(scene);

  const usedDescriptionId = await placeDescriptionOnScene(scene, description, descriptionSlots);
  const usedNpcIds = await placeNpcsOnScene(scene, npcs, npcSlots);

  const deleteDrawingIds = descriptionSlots
    .map((d) => d.id)
    .filter((id) => id !== usedDescriptionId);
  const deleteTokenIds = npcSlots
    .map((t) => t.id)
    .filter((id) => !usedNpcIds.has(id));

  // Also clear leftover PC placeholders on location scenes
  deleteTokenIds.push(...listPcSlots(scene).map((t) => t.id));

  await deleteEmbedded(scene, deleteDrawingIds, deleteTokenIds);
}

export async function finalizeLandingScene(scene, pcs = []) {
  if (!scene) return;
  const pcSlots = listPcSlots(scene);
  const usedPcIds = await placePcsOnScene(scene, pcs, pcSlots);

  const deleteDrawingIds = listDescriptionDrawings(scene).map((d) => d.id);
  const deleteTokenIds = [
    ...listNpcSlots(scene).map((t) => t.id),
    ...pcSlots.map((t) => t.id).filter((id) => !usedPcIds.has(id))
  ];
  await deleteEmbedded(scene, deleteDrawingIds, deleteTokenIds);
}

export async function finalizeUtilityScene(scene) {
  if (!scene) return;
  const deleteDrawingIds = listDescriptionDrawings(scene).map((d) => d.id);
  const deleteTokenIds = [
    ...listNpcSlots(scene).map((t) => t.id),
    ...listPcSlots(scene).map((t) => t.id)
  ];
  await deleteEmbedded(scene, deleteDrawingIds, deleteTokenIds);
}

async function placeDescriptionOnScene(scene, description, candidates) {
  const text = String(description || "").trim();
  if (!text) {
    return null;
  }
  if (!candidates.length) {
    await scene.createEmbeddedDocuments("Drawing", [
      {
        x: 100,
        y: 100,
        shape: { type: "r", width: 800, height: 400 },
        text,
        hidden: true,
        fontSize: 48,
        strokeWidth: 0,
        flags: { [FLAG_SCOPE]: { kind: "description", used: true } }
      }
    ]);
    return null;
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  await scene.updateEmbeddedDocuments("Drawing", [
    {
      _id: pick.id,
      text,
      hidden: true,
      flags: {
        ...(pick.flags ?? {}),
        [FLAG_SCOPE]: { kind: "description", used: true }
      }
    }
  ]);
  return pick.id;
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

function listDescriptionDrawings(scene) {
  return [...(scene.drawings?.contents ?? scene.drawings ?? [])]
    .filter((drawing) => DESCRIPTION_RE.test(String(drawing.text ?? drawing.name ?? "").trim()))
    .sort((a, b) => descriptionIndex(a) - descriptionIndex(b));
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

function descriptionIndex(drawing) {
  const match = String(drawing.text ?? drawing.name ?? "").trim().match(DESCRIPTION_RE);
  return match ? Number(match[1]) : 99;
}
