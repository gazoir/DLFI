/**
 * Build Foundry Item create data from a DLCE Session Package item entry.
 *
 * Cash loot / gold pieces store value in `fields.gp_value` (plain number string).
 * That maps to dnd5e loot `system.price = { value, denomination: "gp" }`.
 */

import { FLAG_SCOPE } from "../constants.mjs";
import { markdownToHtml } from "./markdown.mjs";

/**
 * Parse a gold-piece amount from DLCE item fields.
 * Prefers `gp_value`, then common aliases.
 *
 * @param {object|null|undefined} fields
 * @returns {number|null}
 */
export function resolveItemGpValue(fields = {}) {
  const raw = firstFilled(fields, [
    "gp_value",
    "gpValue",
    "value_gp",
    "valueGp",
    "gold_value",
    "goldValue",
    "price",
    "value"
  ]);
  if (raw == null) {
    return null;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.round(raw));
  }
  const text = String(raw).trim();
  if (!text) {
    return null;
  }
  // Accept "393", "393 GP", "393gp", "1,200"
  const cleaned = text.replace(/,/g, "").replace(/\s*g[pP]\s*$/i, "").trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.max(0, Math.round(n));
}

/**
 * dnd5e price object for loot (and other) items.
 * @param {object|null|undefined} fields
 * @returns {{ value: number, denomination: "gp" }|undefined}
 */
export function buildItemPrice(fields = {}) {
  const gp = resolveItemGpValue(fields);
  if (gp == null) {
    return undefined;
  }
  return { value: gp, denomination: "gp" };
}

/**
 * Map DLCE item subtype → Foundry dnd5e item type.
 * @param {string|null|undefined} subtype
 * @param {object|null|undefined} fields
 * @returns {string}
 */
export function mapItemType(subtype, fields = {}) {
  void fields;
  // All DLCE item subtypes currently import as loot piles / treasure cards.
  if (subtype === "magic" || subtype === "plot") {
    return "loot";
  }
  if (subtype === "cash_loot" || subtype === "gold_pieces") {
    return "loot";
  }
  return "loot";
}

/**
 * @param {{
 *   entry: { id: string, name: string, subtype?: string, locationIds?: string[], portrait?: string|null },
 *   fields?: object,
 *   portraitWorldPath?: string|null,
 *   folderId?: string|null,
 *   importKey: string
 * }} opts
 */
export function buildItemCreateData(opts) {
  const entry = opts.entry ?? {};
  const fields = opts.fields ?? {};
  const subtype = entry.subtype ?? fields.subtype ?? "plot";
  const price = buildItemPrice(fields);
  /** @type {Record<string, unknown>} */
  const system = {
    description: {
      value: markdownToHtml(
        fields.description || fields.appearance || fields.effect || fields.text || ""
      )
    }
  };
  const rarity = String(fields.rarity || "").toLowerCase();
  if (rarity) {
    system.rarity = rarity;
  }
  if (price) {
    system.price = price;
  }

  return {
    name: entry.name,
    type: mapItemType(subtype, fields),
    img: opts.portraitWorldPath || undefined,
    folder: opts.folderId ?? null,
    system,
    flags: {
      [FLAG_SCOPE]: {
        dlceId: entry.id,
        subtype,
        locationIds: entry.locationIds ?? [],
        importKey: opts.importKey,
        gpValue: price?.value ?? null
      }
    }
  };
}

function firstFilled(obj, keys) {
  if (!obj || typeof obj !== "object") {
    return null;
  }
  for (const key of keys) {
    const value = obj[key];
    if (value == null) {
      continue;
    }
    if (typeof value === "string" && !value.trim()) {
      continue;
    }
    return value;
  }
  return null;
}
