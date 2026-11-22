/**
 * Place NPCs / descriptions onto cloned template scenes and remove unused slots.
 *
 * Template conventions (FOUNDRY_SYNC):
 * - Location NPC slots: 1A1, 2A1, 2A2, ...
 * - Landing PC slots only (`{partySize}P{seat}`): world Landing template keeps
 *   layout rows 3P1–3P3, 4P1–4P4, 5P1–5P5, 6P1–6P6. DLFI picks one row by
 *   seated count (see {@link selectLandingPcSlots}); position + texture scale
 *   stay on the template token. Non-`nPm` tokens are ignored.
 * - Location field drawings (by text/name): Description, POIs / Points of Interest,
 *   Session Notes… — plus legacy Description 1–3 (Description 4 is unused leftover)
 * - Battlemaps: ignore A#/P# placeholders; create enemy + party roster lines in
 *   the bottom canvas padding (footprint-spaced, flush to canvas bottom)
 * - Location Item Piles: lower-right outside the map art (bottom padding, 5 cols
 *   right-aligned to the map edge), matching Expo Scene Template Item 1–5
 */

import { FLAG_SCOPE, MODULE_ID, TOKEN_DISPOSITION } from "../constants.mjs";
import { pickTokenTexture, tokenDisplayAlways, tokenDisplayHover } from "./tokenArt.mjs";

const NPC_SLOT_RE = /^(\d+)A(\d+)$/i;
const PC_SLOT_RE = /^(\d+)P(\d+)$/i;

/**
 * Item Piles Foundry module id (manifest `id` is hyphenated since v3).
 * Legacy installs / docs sometimes used `itempiles` without a hyphen.
 */
export const ITEM_PILES_MODULE_ID = "item-piles";
/** Older module id — still accepted when detecting an active install. */
export const ITEM_PILES_MODULE_ID_LEGACY = "itempiles";
/** Item Piles flag namespace on tokens/actors. */
export const ITEM_PILES_FLAG_SCOPE = "item-piles";
/** Columns in the Expo template Item 1–5 row. */
export const ITEM_PILE_COLUMNS = 5;
/** Token / single-item scale from the Expo template. */
export const ITEM_PILE_SCALE = 0.75;
/** flags.item-piles.version matching the Expo template. */
export const ITEM_PILES_FLAG_VERSION = "3.3.4";

/**
 * Item Piles `data` flags from the Expo Scene Template (Item 1–5).
 * @type {Readonly<{
 *   enabled: boolean,
 *   type: string,
 *   deleteWhenEmpty: boolean,
 *   displayOne: boolean,
 *   showItemName: boolean,
 *   overrideSingleItemScale: boolean,
 *   singleItemScale: number
 * }>}
 */
export const ITEM_PILE_DATA_FLAGS = Object.freeze({
  enabled: true,
  type: "pile",
  deleteWhenEmpty: true,
  displayOne: true,
  showItemName: true,
  overrideSingleItemScale: true,
  singleItemScale: ITEM_PILE_SCALE
});

/**
 * Sort priority for location Item Pile placement.
 *
 * Mapping (flags.dlfi.subtype / manifest subtype → priority):
 * | Priority | Group                         | Subtype keys                          |
 * |----------|--------------------------------|---------------------------------------|
 * | 1        | Plot items                     | plot, plot_item                       |
 * | 2        | Permanent magical items        | magic, magical, magic_item, permanent |
 * | 3        | Consumables                    | consumable, potion, scroll            |
 * | 4        | Cash loot                      | cash_loot, cash                       |
 * | 5        | Gold                           | gold_pieces, gold                     |
 * | 6        | Mundane items                  | mundane, loot, equipment, gear        |
 * | 7        | Unknown / unrecognised         | (anything else — after mundane)       |
 *
 * @param {string|null|undefined} subtype
 * @returns {number}
 */
export function itemPileSortKey(subtype) {
  const key = String(subtype ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!key || key === "plot" || key === "plot_item") return 1;
  if (
    key === "magic" ||
    key === "magical" ||
    key === "magic_item" ||
    key === "permanent" ||
    key === "permanent_magic" ||
    key === "permanent_magical"
  ) {
    return 2;
  }
  if (key === "consumable" || key === "consumables" || key === "potion" || key === "scroll") {
    return 3;
  }
  if (key === "cash_loot" || key === "cash" || key === "cashloot") return 4;
  if (key === "gold_pieces" || key === "gold" || key === "gp") return 5;
  if (key === "mundane" || key === "loot" || key === "equipment" || key === "gear") return 6;
  // Unknown subtypes sort after mundane so they stay visible but do not jump groups.
  return 7;
}

/**
 * Sort items for location piles: subtype group, then alphabetical name.
 * @param {{ name?: string, subtype?: string, flags?: object }} a
 * @param {{ name?: string, subtype?: string, flags?: object }} b
 */
export function compareItemsForPilePlacement(a, b) {
  const subtypeOf = (row) =>
    row?.subtype ??
    row?.flags?.[FLAG_SCOPE]?.subtype ??
    row?.item?.flags?.[FLAG_SCOPE]?.subtype ??
    "";
  const nameOf = (row) =>
    String(row?.name ?? row?.item?.name ?? "").trim() || "";
  const ka = itemPileSortKey(subtypeOf(a));
  const kb = itemPileSortKey(subtypeOf(b));
  if (ka !== kb) return ka - kb;
  return nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" });
}

/**
 * Lower-right Item Pile positions outside the map art (bottom padding).
 * Reference: 1920×1080, padding 0.25, grid 120 → first row y = mapBottom,
 * x starts at mapRight − 5×grid, step = grid, 5 per row then y += grid.
 *
 * @param {{
 *   metrics: ReturnType<typeof sceneCanvasMetrics>,
 *   grid?: number,
 *   count: number,
 *   columns?: number
 * }} opts
 * @returns {Array<{ x: number, y: number, col: number, row: number }>}
 */
export function layoutLocationItemPilePositions({
  metrics,
  grid,
  count,
  columns = ITEM_PILE_COLUMNS
} = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const cols = Math.max(1, Math.floor(Number(columns) || ITEM_PILE_COLUMNS));
  const g = Math.max(1, Number(grid ?? metrics?.gridSize ?? 100) || 100);
  const sceneX = Number(metrics?.sceneX ?? 0) || 0;
  const sceneWidth = Number(metrics?.sceneWidth ?? metrics?.width ?? 0) || 0;
  const mapRight = sceneX + sceneWidth;
  const yStart =
    metrics?.mapBottom != null
      ? Number(metrics.mapBottom) || 0
      : (Number(metrics?.sceneY ?? 0) || 0) +
        (Number(metrics?.sceneHeight ?? metrics?.height ?? 0) || 0);
  const xStart = mapRight - cols * g;
  /** @type {Array<{ x: number, y: number, col: number, row: number }>} */
  const positions = [];
  for (let i = 0; i < n; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.push({
      x: Math.round(xStart + col * g),
      y: Math.round(yStart + row * g),
      col,
      row
    });
  }
  return positions;
}

/**
 * Token create payload shaped like the Expo template Item piles.
 * Used when falling back from the Item Piles API.
 *
 * @param {{
 *   name: string,
 *   x: number,
 *   y: number,
 *   img?: string|null,
 *   itemUuid?: string|null,
 *   dlceId?: string|null,
 *   actorId?: string|null
 * }} opts
 */
export function buildItemPileTokenData({
  name,
  x,
  y,
  img = null,
  itemUuid = null,
  dlceId = null,
  actorId = null
} = {}) {
  const texture = {
    src: img || "icons/svg/item-bag.svg",
    scaleX: ITEM_PILE_SCALE,
    scaleY: ITEM_PILE_SCALE,
    fit: "contain"
  };
  return {
    name: String(name || "Item").trim() || "Item",
    ...(actorId ? { actorId, actorLink: false } : {}),
    disposition: TOKEN_DISPOSITION.FRIENDLY,
    displayName: tokenDisplayAlways(),
    width: 1,
    height: 1,
    x: Math.round(Number(x) || 0),
    y: Math.round(Number(y) || 0),
    texture,
    flags: {
      [ITEM_PILES_FLAG_SCOPE]: {
        version: ITEM_PILES_FLAG_VERSION,
        data: { ...ITEM_PILE_DATA_FLAGS }
      },
      [FLAG_SCOPE]: {
        kind: "item-pile",
        itemUuid: itemUuid ?? null,
        dlceId: dlceId ?? null
      }
    }
  };
}

/**
 * @param {Scene} scene
 * @returns {object[]}
 */
export function listDlfiItemPileTokens(scene) {
  return [...(scene?.tokens?.contents ?? scene?.tokens ?? [])].filter((token) => {
    const kind = token?.flags?.[FLAG_SCOPE]?.kind;
    if (kind === "item-pile") return true;
    // Legacy / API-created piles we tagged only via item uuid on prior runs.
    return Boolean(token?.flags?.[FLAG_SCOPE]?.itemPile);
  });
}

/**
 * True when Item Piles is enabled for this world.
 * Prefers module id `item-piles`; also accepts legacy `itempiles` and a live API.
 * @returns {boolean}
 */
export function isItemPilesActive() {
  const modules = globalThis.game?.modules;
  const byId =
    Boolean(modules?.get?.(ITEM_PILES_MODULE_ID)?.active) ||
    Boolean(modules?.get?.(ITEM_PILES_MODULE_ID_LEGACY)?.active);
  const api = Boolean(globalThis.game?.itempiles?.API);
  return byId || api;
}

/**
 * Debug snapshot for console when Item Piles detection fails.
 * @returns {object}
 */
export function itemPilesDetectionDebug() {
  const modules = globalThis.game?.modules;
  const primary = modules?.get?.(ITEM_PILES_MODULE_ID);
  const legacy = modules?.get?.(ITEM_PILES_MODULE_ID_LEGACY);
  return {
    expectedModuleId: ITEM_PILES_MODULE_ID,
    legacyModuleId: ITEM_PILES_MODULE_ID_LEGACY,
    primaryActive: Boolean(primary?.active),
    legacyActive: Boolean(legacy?.active),
    apiPresent: Boolean(globalThis.game?.itempiles?.API),
    createItemPile:
      typeof globalThis.game?.itempiles?.API?.createItemPile === "function"
  };
}

/**
 * Modal + console debug when Item Piles is required but inactive.
 * @param {{ scene?: { name?: string, id?: string }|null, items?: Array<{ name?: string, id?: string, uuid?: string, dlceId?: string }> }} opts
 */
export async function alertItemPilesMissing({ scene = null, items = [] } = {}) {
  const sceneName = scene?.name ?? "(unknown scene)";
  const sceneId = scene?.id ?? null;
  const rows = (items ?? []).map((item) => ({
    name: item?.name ?? item?.item?.name ?? "(unnamed)",
    id: item?.id ?? item?.item?.id ?? null,
    uuid: item?.uuid ?? item?.item?.uuid ?? null,
    dlceId: item?.dlceId ?? item?.flags?.[FLAG_SCOPE]?.dlceId ?? null
  }));
  console.warn(`${MODULE_ID} | Item Piles module inactive — skipping location pile placement`, {
    ...itemPilesDetectionDebug(),
    sceneName,
    sceneId,
    itemCount: rows.length,
    items: rows
  });

  const listHtml = rows.length
    ? `<ul>${rows
        .map(
          (row) =>
            `<li><code>${escapeHtmlLite(row.name)}</code>` +
            (row.dlceId ? ` <span>(${escapeHtmlLite(row.dlceId)})</span>` : "") +
            `</li>`
        )
        .join("")}</ul>`
    : "<p><em>No items listed.</em></p>";
  const content =
    `<p>The <strong>Item Piles</strong> module (<code>${ITEM_PILES_MODULE_ID}</code>) ` +
    `is not active. DLFI will not place item piles on <strong>${escapeHtmlLite(sceneName)}</strong>.</p>` +
    `<p>Enable Item Piles and re-import the session to place these items:</p>${listHtml}`;

  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (DialogV2?.prompt) {
    await DialogV2.prompt({
      window: { title: "Item Piles required" },
      content,
      ok: { label: "OK" }
    });
    return;
  }
  if (typeof globalThis.Dialog?.prompt === "function") {
    await globalThis.Dialog.prompt({
      title: "Item Piles required",
      content,
      label: "OK",
      callback: () => undefined
    });
    return;
  }
  // Last resort: notification only (still no silent token fallback).
  console.warn(`${MODULE_ID} | ${content.replace(/<[^>]+>/g, " ")}`);
}

function escapeHtmlLite(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Clear prior DLFI item-pile tokens and place one pile per related Item.
 * Prefers `game.itempiles.API.createItemPile`; falls back to Token create with
 * Item Piles flags when the API is missing but the module is active.
 *
 * @param {Scene} scene
 * @param {Array<{ item: Item, name?: string, subtype?: string, dlceId?: string|null }>} items
 */
export async function placeLocationItemPiles(scene, items = []) {
  if (!scene) return;

  const prior = listDlfiItemPileTokens(scene);
  if (prior.length) {
    await scene.deleteEmbeddedDocuments(
      "Token",
      prior.map((t) => t.id).filter(Boolean)
    );
    console.log(
      `${MODULE_ID} | ${scene.name}: cleared ${prior.length} prior DLFI item-pile token(s)`
    );
  }

  const rows = [...(items ?? [])].filter((row) => row?.item || row?.uuid);
  if (!rows.length) {
    return;
  }

  if (!isItemPilesActive()) {
    await alertItemPilesMissing({ scene, items: rows });
    return;
  }

  const sorted = [...rows].sort(compareItemsForPilePlacement);
  const metrics = sceneCanvasMetrics(scene);
  const grid = Math.max(1, Number(scene.grid?.size ?? metrics.gridSize ?? 100) || 100);
  const positions = layoutLocationItemPilePositions({
    metrics,
    grid,
    count: sorted.length,
    columns: ITEM_PILE_COLUMNS
  });

  const api = globalThis.game?.itempiles?.API;
  let placed = 0;
  /** @type {object[]} */
  const fallbackTokens = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    const item = row.item ?? null;
    const name = String(row.name || item?.name || "Item").trim() || "Item";
    const pos = positions[i];
    const img = item?.img || row.img || null;
    const dlceId =
      row.dlceId ?? item?.flags?.[FLAG_SCOPE]?.dlceId ?? null;
    const itemUuid = item?.uuid ?? row.uuid ?? null;

    if (typeof api?.createItemPile === "function") {
      try {
        const result = await api.createItemPile({
          position: { x: pos.x, y: pos.y },
          sceneId: scene.id,
          createActor: true,
          items: item ? [item] : [],
          itemPileFlags: { ...ITEM_PILE_DATA_FLAGS },
          actorOverrides: { name },
          tokenOverrides: {
            name,
            disposition: TOKEN_DISPOSITION.FRIENDLY,
            displayName: tokenDisplayAlways(),
            width: 1,
            height: 1,
            texture: {
              ...(img ? { src: img } : {}),
              scaleX: ITEM_PILE_SCALE,
              scaleY: ITEM_PILE_SCALE,
              fit: "contain"
            },
            flags: {
              [FLAG_SCOPE]: {
                kind: "item-pile",
                itemUuid,
                dlceId
              }
            }
          }
        });
        // Tag the created token if the API ignored our flags merge.
        const tokenUuid = result?.tokenUuid ?? result?.token?.uuid ?? null;
        if (tokenUuid && globalThis.fromUuid) {
          const tokenDoc = await globalThis.fromUuid(tokenUuid);
          if (tokenDoc?.update) {
            await tokenDoc.update({
              [`flags.${FLAG_SCOPE}.kind`]: "item-pile",
              [`flags.${FLAG_SCOPE}.itemUuid`]: itemUuid,
              [`flags.${FLAG_SCOPE}.dlceId`]: dlceId
            });
          }
        }
        placed += 1;
        continue;
      } catch (error) {
        console.warn(
          `${MODULE_ID} | ${scene.name}: createItemPile failed for ${name}; falling back to Token create`,
          error
        );
      }
    }

    fallbackTokens.push(
      buildItemPileTokenData({
        name,
        x: pos.x,
        y: pos.y,
        img,
        itemUuid,
        dlceId
      })
    );
  }

  if (fallbackTokens.length) {
    await scene.createEmbeddedDocuments("Token", fallbackTokens);
    placed += fallbackTokens.length;
    console.warn(
      `${MODULE_ID} | ${scene.name}: placed ${fallbackTokens.length} item-pile token(s) without API ` +
        `(flags only — open Item Piles on each if interaction is missing)`
    );
  }

  console.log(
    `${MODULE_ID} | ${scene.name}: placed ${placed}/${sorted.length} location item pile(s) ` +
      `(grid=${grid}, mapBottom=${metrics.mapBottom}, cols=${ITEM_PILE_COLUMNS})`
  );
}

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
  {
    description = "",
    poisText = "",
    sessionNotes = "",
    npcs = [],
    items = [],
    skipItemPiles = false
  } = {}
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

  // Item piles in lower-right padding (requires Item Piles module when items exist).
  if (!skipItemPiles) {
    await placeLocationItemPiles(scene, items);
  } else {
    // Module missing (caller already alerted): clear stale piles, never place fakes.
    const prior = listDlfiItemPileTokens(scene);
    if (prior.length) {
      await scene.deleteEmbeddedDocuments(
        "Token",
        prior.map((t) => t.id).filter(Boolean)
      );
    }
  }
}

export async function finalizeLandingScene(scene, pcs = []) {
  if (!scene) return;
  // Only `{n}P{m}` placeholders — party-size layouts on the world Landing template.
  const allPcSlots = listPcSlots(scene);
  const slots = selectLandingPcSlots(allPcSlots, pcs.length);
  const usedPcIds = await placePcsOnScene(scene, pcs, slots);

  const deleteDrawingIds = listManagedFieldDrawings(scene).map((d) => d.id);
  // Drop every unused nPm placeholder (other party-size rows + unused seats).
  const deleteTokenIds = allPcSlots
    .map((t) => t.id)
    .filter((id) => id && !usedPcIds.has(id));
  await deleteEmbedded(scene, deleteDrawingIds, deleteTokenIds);
}

/**
 * Pick Landing PC placeholders for the seated party size.
 *
 * | Seated | Slots |
 * |------:|:------|
 * | 1 | `3P2` (centre of the 3-row) |
 * | 2 | `4P2`, `4P3` (centred pair on the 4-row) |
 * | 3–6 | `{n}P1`…`{n}P{n}` |
 * | 7+ | `6P1`…`6P6` (extras overflow to the right of `6P6`) |
 *
 * @param {Iterable<object>} allPcSlots tokens whose names match `{n}P{m}`
 * @param {number} partySize seated PC count
 * @returns {object[]}
 */
export function selectLandingPcSlots(allPcSlots, partySize) {
  const byGroup = new Map();
  for (const token of allPcSlots ?? []) {
    const parsed = parseSlot(token?.name);
    if (!Number.isFinite(parsed.major) || parsed.major >= 99) continue;
    if (!byGroup.has(parsed.major)) byGroup.set(parsed.major, []);
    byGroup.get(parsed.major).push(token);
  }
  for (const group of byGroup.values()) {
    group.sort(
      (a, b) => parseSlot(a.name).minor - parseSlot(b.name).minor
    );
  }

  const n = Math.max(0, Number(partySize) || 0);
  if (n <= 0) return [];

  const seat = (groupSize, minor) =>
    (byGroup.get(groupSize) ?? []).find(
      (token) => parseSlot(token.name).minor === minor
    ) ?? null;

  if (n === 1) {
    return [seat(3, 2)].filter(Boolean);
  }
  if (n === 2) {
    return [seat(4, 2), seat(4, 3)].filter(Boolean);
  }
  if (n >= 3 && n <= 6) {
    const group = byGroup.get(n) ?? [];
    return group.filter((token) => {
      const minor = parseSlot(token.name).minor;
      return minor >= 1 && minor <= n;
    });
  }
  // 7+: fill the 6-row; overflow is created beside 6P6.
  return byGroup.get(6) ?? [];
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
 *   enemies?: Array<{ actor: Actor, count?: number, disposition?: number }>,
 *   party?: Array<{ actor: Actor, linked?: boolean, kind?: string, dlceId?: string|null, label?: string|null }>
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
        disposition: row.disposition,
        variantIndex: count > 1 ? i : undefined,
        suffix: count > 1 ? ` ${i + 1}` : ""
      });
    }
  }

  const partyRows = [];
  for (const row of party ?? []) {
    const pcLabel = row?.dlceId || row?.label || row?.actor?.name || "(unknown)";
    if (!row?.actor) {
      console.warn(
        `${MODULE_ID} | ${scene.name}: skipped party token ${pcLabel} — no actor on party row`
      );
      continue;
    }
    partyRows.push({
      actor: row.actor,
      linked: row.linked !== false,
      kind: row.kind || "battle-party",
      disposition: TOKEN_DISPOSITION.FRIENDLY,
      suffix: "",
      dlceId: row.dlceId ?? null,
      label: row.label ?? null,
      tokenName: row.tokenName ?? row.label ?? null
    });
  }

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
  const enemyIds = [...new Set(expandedEnemies.map((row) => row.actor?.id).filter(Boolean))];
  const partyIds = partyRows.map((row) => row.dlceId || row.actor?.id).filter(Boolean);
  if (!layout.enemyTokens.length) {
    console.warn(`${MODULE_ID} | ${scene.name}: no enemy tokens to place (${enemies.length} enemy row(s) supplied)`);
  }
  if ((party ?? []).length && !layout.partyTokens.length) {
    console.warn(
      `${MODULE_ID} | ${scene.name}: party placement produced 0 tokens despite ${party.length} party row(s)` +
        (partyIds.length ? ` (ids: ${partyIds.join(", ")})` : "")
    );
  }
  if (create.length) {
    const created = await scene.createEmbeddedDocuments("Token", create);
    const createdCount = created?.length ?? create.length;
    console.log(
      `${MODULE_ID} | ${scene.name}: placed ${createdCount}/${create.length} tokens ` +
        `(${layout.enemyTokens.length} enemy, ${layout.partyTokens.length} party); ` +
        `enemy npc actor ids: ${enemyIds.join(", ") || "none"}; party ids: ${partyIds.join(", ") || "none"}`
    );
  } else {
    console.warn(`${MODULE_ID} | ${scene.name}: no tokens created (0 enemies, 0 party)`);
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
 * @param {{
 *   actor: Actor,
 *   linked?: boolean,
 *   kind?: string,
 *   suffix?: string,
 *   tokenName?: string|null,
 *   label?: string|null
 * }} row
 */
export function tokenPlacementSpec(row) {
  const actor = row.actor;
  const proto = actor?.prototypeToken ?? {};
  const width = Math.max(0.5, Number(proto.width) || 1);
  const height = Math.max(0.5, Number(proto.height) || 1);
  const textureSrc = pickTokenTexture(actor, row.variantIndex, FLAG_SCOPE);
  const scaleX = Number(proto?.texture?.scaleX);
  const scaleY = Number(proto?.texture?.scaleY);
  const baseName =
    String(row.tokenName || row.label || actor?.name || "").trim() || "Token";
  return {
    name: `${baseName}${row.suffix || ""}`,
    actorId: actor.id,
    actorUuid: actor.uuid,
    linked: Boolean(row.linked),
    kind: row.kind || "battle-token",
    disposition: row.disposition,
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
        disposition:
          spec.kind === "battle-enemy"
            ? (spec.disposition ?? TOKEN_DISPOSITION.HOSTILE)
            : (spec.disposition ?? TOKEN_DISPOSITION.FRIENDLY),
        displayName: tokenDisplayHover(),
        ...(spec.kind === "battle-enemy"
          ? {
              lockRotation: true
            }
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
        disposition: TOKEN_DISPOSITION.NEUTRAL,
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
      disposition: TOKEN_DISPOSITION.NEUTRAL,
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
  const create = [];
  const slotted = Math.min(pcs.length, slots.length);

  for (let i = 0; i < slotted; i += 1) {
    const actor = pcs[i]?.actor;
    const token = slots[i];
    if (!actor || !token) continue;
    used.add(token.id);
    const textureSrc = pickTokenTexture(actor, undefined, FLAG_SCOPE);
    // Keep template x/y/width/height/texture.scale* — only bind actor + art.
    updates.push({
      _id: token.id,
      name: actor.name,
      actorId: actor.id,
      actorLink: true,
      disposition: TOKEN_DISPOSITION.FRIENDLY,
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

  // Overflow (party > 6): clone pose/scale from the last template seat (6P6).
  const anchor = slots[slots.length - 1] ?? null;
  const grid = Number(scene.grid?.size ?? scene.grid) || 100;
  for (let i = slotted; i < pcs.length; i += 1) {
    const actor = pcs[i]?.actor;
    if (!actor) continue;
    const textureSrc = pickTokenTexture(actor, undefined, FLAG_SCOPE);
    const overflowIndex = i - slotted;
    const anchorScaleX = Number(anchor?.texture?.scaleX);
    const anchorScaleY = Number(anchor?.texture?.scaleY);
    const width = Math.max(0.5, Number(anchor?.width) || 1);
    const height = Math.max(0.5, Number(anchor?.height) || 1);
    const step = width * grid * 1.05;
    const x =
      Number(anchor?.x ?? 0) + step * (overflowIndex + 1);
    const y = Number(anchor?.y ?? Math.floor((scene.height ?? 1080) * 0.75));
    create.push({
      name: actor.name,
      actorId: actor.id,
      actorLink: true,
      disposition: TOKEN_DISPOSITION.FRIENDLY,
      width,
      height,
      x,
      y,
      texture: {
        ...(textureSrc ? { src: textureSrc } : {}),
        ...(Number.isFinite(anchorScaleX) && anchorScaleX > 0
          ? { scaleX: anchorScaleX }
          : {}),
        ...(Number.isFinite(anchorScaleY) && anchorScaleY > 0
          ? { scaleY: anchorScaleY }
          : {})
      },
      flags: {
        [FLAG_SCOPE]: {
          kind: "pc-overflow",
          actorUuid: actor.uuid
        }
      }
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
