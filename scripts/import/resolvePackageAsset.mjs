/**
 * Resolve package asset paths to uploaded world Data/ paths.
 * DLCE v2 organises artwork by WD type (assets/location/, assets/npc/, …)
 * while older packages used assets/portraits/ and assets/tokens/.
 */

import { resolveNpcTokenSlots } from "./tokenArt.mjs";

/**
 * @param {Map<string, string>} uploaded packagePath -> world path
 * @param {string[]} candidates package-relative paths to try
 * @returns {string|null}
 */
export function lookupUploaded(uploaded, candidates = []) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const key = String(candidate).replace(/^\/+/, "").replace(/\\/g, "/");
    if (uploaded.has(key)) {
      return uploaded.get(key);
    }
  }
  return null;
}

/** @type {WeakMap<Map<string, string>, Map<string, Array<[string, string]>>>} */
const basenameIndexCache = new WeakMap();

/** basename → [packagePath, worldPath][] for an uploads map (built once per map). */
function basenameIndex(uploaded) {
  let index = basenameIndexCache.get(uploaded);
  if (index && index.__size === uploaded.size) {
    return index;
  }
  index = new Map();
  for (const [packagePath, worldPath] of uploaded.entries()) {
    const base = packagePath.split("/").pop()?.toLowerCase() ?? "";
    const list = index.get(base) ?? [];
    list.push([packagePath, worldPath]);
    index.set(base, list);
  }
  index.__size = uploaded.size;
  basenameIndexCache.set(uploaded, index);
  return index;
}

/**
 * Find an uploaded asset whose filename matches (e.g. loc_ancient_ruin.webp),
 * only inside `preferredFolders` (earlier folders win). A root folder such as
 * `assets` matches files directly inside it, not every subfolder — otherwise an
 * NPC could pick up an item's art with the same filename.
 * @param {Map<string, string>} uploaded
 * @param {string[]} fileNames
 * @param {string[]} [preferredFolders]
 */
export function lookupUploadedByFileName(uploaded, fileNames = [], preferredFolders = []) {
  const prefer = preferredFolders.map((folder) =>
    String(folder).replace(/^\/+|\/+$/g, "").toLowerCase()
  );
  const index = basenameIndex(uploaded);
  let best = null;
  for (const name of fileNames) {
    if (!name) continue;
    const base = String(name).replace(/^\/+/, "").split("/").pop().toLowerCase();
    for (const [packagePath, worldPath] of index.get(base) ?? []) {
      const folder = packagePath.split("/").slice(0, -1).join("/").toLowerCase();
      const preferIndex = prefer.findIndex(
        (prefix) => folder === prefix || (prefix.includes("/") && folder.startsWith(`${prefix}/`))
      );
      if (preferIndex !== -1 && (!best || preferIndex < best.preferIndex)) {
        best = { worldPath, preferIndex };
      }
    }
  }
  return best?.worldPath ?? null;
}

/**
 * Location / scene background art for a manifest location entry.
 */
export function resolveLocationBackground(entry, uploaded) {
  const id = String(entry?.id ?? "").trim();
  const stems = [id, id.replace(/^loc_/, "")].filter(Boolean);
  const fileNames = [];
  for (const stem of stems) {
    for (const ext of ["webp", "png", "jpg", "jpeg", "webm"]) {
      fileNames.push(`${stem}.${ext}`);
    }
  }

  return (
    lookupUploaded(uploaded, [
      entry?.portrait,
      entry?.background,
      entry?.artwork,
      entry?.image,
      id ? `assets/location/${id}.webp` : null,
      id ? `assets/locations/${id}.webp` : null,
      id ? `assets/portraits/${id}.webp` : null
    ]) ||
    lookupUploadedByFileName(uploaded, fileNames, [
      "assets/location",
      "assets/locations",
      "assets/portraits",
      "assets"
    ])
  );
}

/**
 * NPC portrait / token art.
 */
export function resolveNpcMedia(entry, uploaded, { npcIds = null } = {}) {
  const id = String(entry?.id ?? "").trim();
  const stems = [id, id.replace(/^npc_/, "")].filter(Boolean);
  const portraitNames = [];
  const tokenNames = [];
  for (const stem of stems) {
    for (const ext of ["webp", "png", "jpg", "jpeg"]) {
      portraitNames.push(`${stem}.${ext}`);
      tokenNames.push(`${stem}_token.${ext}`, `${stem}.token.${ext}`, `${stem}.${ext}`);
    }
  }

  const portrait =
    lookupUploaded(uploaded, [
      entry?.portrait,
      id ? `assets/npc/${id}.webp` : null,
      id ? `assets/npcs/${id}.webp` : null,
      id ? `assets/portraits/${id}.webp` : null
    ]) ||
    lookupUploadedByFileName(uploaded, portraitNames, [
      "assets/npc",
      "assets/npcs",
      "assets/portraits",
      "assets"
    ]);

  const explicitToken =
    lookupUploaded(uploaded, [
      entry?.token,
      id ? `assets/token/${id}.webp` : null,
      id ? `assets/tokens/${id}.webp` : null
    ]) ||
    lookupUploadedByFileName(uploaded, tokenNames, [
      "assets/token",
      "assets/tokens",
      "assets/npc",
      "assets/portraits",
      "assets"
    ]);

  const { slots, wildcard, firstSlot } = resolveNpcTokenSlots(entry, uploaded, { npcIds });
  // Slots that cannot form a safe wildcard: use the first one, without randomImg.
  const token = explicitToken || firstSlot || portrait;
  if (slots.length >= 2) {
    return {
      portrait,
      token: slots[0],
      tokenSlots: slots,
      tokenWildcard: wildcard
    };
  }

  return { portrait, token, tokenSlots: [], tokenWildcard: null };
}
