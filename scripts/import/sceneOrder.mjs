/**
 * Sequential DM scene names for locations + combat battlemaps from MSD order.
 */

/**
 * Zero-pad a 1-based scene order for DM names (`01`, `02`, …).
 * Invalid / missing values fall back to `99`.
 *
 * @param {unknown} order
 * @returns {string}
 */
export function padSceneOrder(order) {
  const n = Number(order);
  if (!Number.isFinite(n) || n < 1) {
    return "99";
  }
  return String(Math.floor(n)).padStart(2, "0");
}

/**
 * True when a challenge entry is a combat encounter (battlemap scene).
 * Empty / missing kind is treated as combat (DLCE default).
 *
 * @param {object} entry
 * @param {object|null|undefined} raw
 * @returns {boolean}
 */
export function isCombatChallengeEntry(entry, raw = null) {
  if (!entry || entry.type !== "challenge") {
    return false;
  }
  const kind = String(raw?.fields?.kind ?? entry.subtype ?? "")
    .trim()
    .toLowerCase();
  if (kind && kind !== "combat") {
    return false;
  }
  return true;
}

/**
 * DM-facing scene name: `01. Name` or `02. Battle — Name`.
 *
 * @param {"location"|"battlemap"|string} kind
 * @param {{ name?: string }} entry
 * @param {number} order 1-based sequence index
 * @returns {string}
 */
export function formatSceneDmName(kind, entry, order) {
  const padded = padSceneOrder(order);
  const name = String(entry?.name ?? "").trim() || "Untitled";
  if (kind === "battlemap") {
    return `${padded}. Battle — ${name}`;
  }
  return `${padded}. ${name}`;
}

function hasUsableMsdOrder(entry) {
  const n = Number(entry?.msdOrder);
  return Number.isFinite(n) && n >= 1;
}

/**
 * Build the ordered list of location + combat-battlemap scenes for import.
 *
 * Prefer a unified `msdOrder` across locations and combat challenges when every
 * such entry has one. Otherwise: locations by `msdOrder`, with each location's
 * linked combats immediately after it. Non-combat challenges are excluded.
 *
 * @param {{ documents?: object[] }} manifest
 * @param {{ readDocument?: (file: string) => object|null }} [options]
 * @returns {Array<{ kind: "location"|"battlemap", entry: object, order: number, raw?: object|null }>}
 */
export function buildMsdSceneSequence(manifest, { readDocument } = {}) {
  const documents = manifest?.documents ?? [];
  const locations = documents.filter((entry) => entry?.type === "location");

  /** @type {Array<{ entry: object, raw: object|null }>} */
  const combats = [];
  for (const entry of documents.filter((doc) => doc?.type === "challenge")) {
    const raw =
      typeof readDocument === "function" && entry.file ? readDocument(entry.file) : null;
    if (!isCombatChallengeEntry(entry, raw)) {
      continue;
    }
    combats.push({ entry, raw });
  }

  /** @type {Array<{ kind: "location"|"battlemap", entry: object, raw?: object|null }>} */
  let rows;

  const unifiedCandidates = [
    ...locations.map((entry) => ({ kind: "location", entry })),
    ...combats.map(({ entry, raw }) => ({ kind: "battlemap", entry, raw }))
  ];

  const useUnified =
    unifiedCandidates.length > 0 &&
    unifiedCandidates.every((row) => hasUsableMsdOrder(row.entry));

  if (useUnified) {
    rows = [...unifiedCandidates].sort((left, right) => {
      const byOrder = Number(left.entry.msdOrder) - Number(right.entry.msdOrder);
      if (byOrder !== 0) {
        return byOrder;
      }
      return String(left.entry.name || "").localeCompare(String(right.entry.name || ""));
    });
  } else {
    const sortedLocations = [...locations].sort((left, right) => {
      const byOrder = (left.msdOrder ?? 99) - (right.msdOrder ?? 99);
      if (byOrder !== 0) {
        return byOrder;
      }
      return String(left.name || "").localeCompare(String(right.name || ""));
    });

    const usedCombatIds = new Set();
    rows = [];

    for (const location of sortedLocations) {
      rows.push({ kind: "location", entry: location });
      const linked = combats
        .filter(({ entry }) => {
          if (usedCombatIds.has(entry.id)) {
            return false;
          }
          const locationIds = entry.locationIds ?? [];
          return locationIds.map(String).includes(String(location.id));
        })
        .sort((left, right) =>
          String(left.entry.name || "").localeCompare(String(right.entry.name || ""))
        );
      for (const combat of linked) {
        usedCombatIds.add(combat.entry.id);
        rows.push({ kind: "battlemap", entry: combat.entry, raw: combat.raw });
      }
    }

    for (const combat of combats) {
      if (usedCombatIds.has(combat.entry.id)) {
        continue;
      }
      rows.push({ kind: "battlemap", entry: combat.entry, raw: combat.raw });
    }
  }

  return rows.map((row, index) => ({
    ...row,
    order: index + 1
  }));
}
