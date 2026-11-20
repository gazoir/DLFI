/**
 * Resolve DLCE document relationships used for scene placement.
 */

/**
 * Build npcId → locationId[] from location documents that link *to* NPCs
 * (e.g. loc_trader "Owned by" → npc_kira_brannardor).
 * DLCE often stores the ownership link only on the location, not the NPC.
 *
 * @param {Iterable<{ id: string, file?: string }>} locationEntries
 * @param {(file: string) => object|null} readDocument
 * @returns {Map<string, string[]>}
 */
export function buildNpcLocationsFromLocationLinks(locationEntries, readDocument) {
  /** @type {Map<string, string[]>} */
  const map = new Map();
  for (const entry of locationEntries ?? []) {
    const locationId = String(entry?.id ?? "");
    if (!locationId) {
      continue;
    }
    const raw = typeof readDocument === "function" ? readDocument(entry.file) : null;
    for (const link of raw?.links ?? []) {
      if (link?.target_type !== "npc" || !link?.target_id) {
        continue;
      }
      const npcId = String(link.target_id);
      const list = map.get(npcId) ?? [];
      if (!list.includes(locationId)) {
        list.push(locationId);
      }
      map.set(npcId, list);
    }
  }
  return map;
}

/**
 * Collect location ids for an NPC from the manifest entry, NPC→location links,
 * and reverse location→NPC links.
 */
export function collectNpcLocationIds(entry, raw, reverseLocationIds = []) {
  const ids = new Set();
  for (const id of entry?.locationIds ?? []) {
    if (id) {
      ids.add(String(id));
    }
  }
  for (const link of raw?.links ?? []) {
    if (link?.target_type === "location" && link?.target_id) {
      ids.add(String(link.target_id));
    }
  }
  for (const id of reverseLocationIds ?? []) {
    if (id) {
      ids.add(String(id));
    }
  }
  return [...ids];
}

/**
 * Build challengeId → host locationId[] from location→challenge links.
 * DLCE often stores "Hosts" only on the location; challenges may omit occurs_at.
 *
 * @param {Iterable<{ id: string, file?: string }>} locationEntries
 * @param {(file: string) => object|null} readDocument
 * @returns {Map<string, string[]>}
 */
export function buildChallengeHostLocations(locationEntries, readDocument) {
  /** @type {Map<string, string[]>} */
  const map = new Map();
  for (const entry of locationEntries ?? []) {
    const locationId = String(entry?.id ?? "");
    if (!locationId) {
      continue;
    }
    const raw = typeof readDocument === "function" ? readDocument(entry.file) : null;
    for (const link of raw?.links ?? []) {
      if (link?.target_type !== "challenge" || !link?.target_id) {
        continue;
      }
      const challengeId = String(link.target_id);
      const list = map.get(challengeId) ?? [];
      if (!list.includes(locationId)) {
        list.push(locationId);
      }
      map.set(challengeId, list);
    }
  }
  return map;
}

/**
 * Resolve the host location id for a combat challenge.
 * Prefers manifest locationIds, then challenge→location links, then reverse hosts.
 *
 * @param {object} entry
 * @param {object|null|undefined} raw
 * @param {Map<string, string[]>} [hostByChallenge]
 * @returns {string|null}
 */
export function resolveChallengeHostLocationId(entry, raw = null, hostByChallenge = null) {
  for (const id of entry?.locationIds ?? []) {
    if (id) {
      return String(id);
    }
  }
  for (const link of raw?.links ?? []) {
    if (link?.target_type === "location" && link?.target_id) {
      return String(link.target_id);
    }
  }
  const challengeId = String(entry?.id ?? "");
  if (challengeId && hostByChallenge?.has(challengeId)) {
    const hosts = hostByChallenge.get(challengeId) ?? [];
    if (hosts[0]) {
      return String(hosts[0]);
    }
  }
  return null;
}

/**
 * Prefer the colour (non-grid) battlemap asset for a combat encounter.
 * Grid overlays are skipped — Foundry draws its own grid.
 *
 * DLCE v2 stores maps at `assets/location/battlemaps/{locationId}.{ext}` on the
 * location entry (not the challenge). Resolve via location.battlemap first.
 *
 * @param {{
 *   entry?: object,
 *   raw?: object,
 *   locationEntry?: object|null,
 *   uploaded: Map<string, string>,
 *   assetPaths?: string[]
 * }} opts
 * @returns {string|null} world data path
 */
export function resolveColourBattlemapPath({
  entry = null,
  raw = null,
  locationEntry = null,
  uploaded,
  assetPaths = []
} = {}) {
  const candidates = [];

  const push = (packagePath) => {
    if (!packagePath) {
      return;
    }
    const key = String(packagePath).replace(/^\/+/, "").replace(/\\/g, "/");
    if (uploaded.has(key)) {
      candidates.push(key);
    }
  };

  // Location-owned battlemap is the DLCE v2 source of truth.
  push(locationEntry?.battlemap);
  const locationId = String(locationEntry?.id ?? "").trim();
  if (locationId) {
    for (const ext of ["webp", "png", "jpg", "jpeg", "webm"]) {
      push(`assets/location/battlemaps/${locationId}.${ext}`);
      push(`assets/battlemaps/${locationId}.${ext}`);
    }
  }

  push(entry?.battlemap);
  push(raw?.fields?.battlemap);
  push(raw?.fields?.combat_battlemap);
  push(raw?.artwork?.battlemap?.path);
  push(raw?.artwork_by_style?.["90s CRPG"]?.battlemap?.path);

  const idHints = [locationEntry?.id, entry?.id, entry?.name]
    .filter(Boolean)
    .map((value) =>
      String(value)
        .toLowerCase()
        .replace(/^ch_/, "")
        .replace(/[^a-z0-9]+/g, "")
    )
    .filter(Boolean);

  for (const path of assetPaths ?? []) {
    const lower = String(path).toLowerCase();
    const inBattlemapsFolder =
      /^assets\/battlemaps\//i.test(path) || /^assets\/location\/battlemaps\//i.test(path);
    if (!inBattlemapsFolder && !lower.includes("battlemap")) {
      continue;
    }
    // Only auto-pick assets whose filename/path mentions this challenge/location.
    if (idHints.length) {
      const compact = lower.replace(/[^a-z0-9]+/g, "");
      const matches = idHints.some((hint) => hint && compact.includes(hint));
      if (!matches) {
        continue;
      }
    }
    push(path);
  }

  const unique = [...new Set(candidates)];
  if (!unique.length) {
    return null;
  }

  const ranked = unique
    .map((path) => ({ path, score: scoreBattlemapPath(path) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  // Never pick an obvious grid overlay if a better colour candidate exists.
  if (best.score < 0) {
    const nonGrid = ranked.find((row) => row.score >= 0);
    if (nonGrid) {
      return uploaded.get(nonGrid.path) ?? null;
    }
  }
  return uploaded.get(best.path) ?? null;
}

function scoreBattlemapPath(path) {
  const lower = String(path).toLowerCase();
  let score = 0;
  if (/colou?r/.test(lower)) {
    score += 100;
  }
  if (/16\s*[x×_\-]\s*22|22\s*[x×_\-]\s*16/.test(lower)) {
    score += 20;
  }
  if (/grid|overlay|lines/.test(lower)) {
    score -= 100;
  }
  if (/bw|black.?white|greyscale|grayscale/.test(lower)) {
    score -= 10;
  }
  return score;
}

/**
 * Collect enemy NPC ids (+ optional counts) for a combat challenge.
 *
 * @returns {Array<{ npcId: string, count: number }>}
 */
export function collectChallengeEnemies(entry, raw, { npcDocuments = [] } = {}) {
  /** @type {Map<string, number>} */
  const counts = new Map();

  const add = (npcId, count = 1) => {
    const id = String(npcId ?? "").trim();
    if (!id) {
      return;
    }
    const n = Number(count);
    counts.set(id, (counts.get(id) ?? 0) + (Number.isFinite(n) && n > 0 ? Math.floor(n) : 1));
  };

  for (const link of raw?.links ?? []) {
    if (link?.target_type === "npc" && link?.target_id) {
      add(link.target_id, link.count ?? link.quantity ?? 1);
    }
  }

  const fieldValues = [
    raw?.fields?.enemies,
    raw?.fields?.combat_enemies,
    raw?.fields?.enemy_ids,
    raw?.fields?.combat_enemy_ids,
    raw?.fields?.participants,
    raw?.fields?.combat_participants,
    raw?.fields?.creatures,
    raw?.enemies
  ];
  for (const value of fieldValues) {
    for (const row of normalizeEnemyField(value)) {
      add(row.npcId, row.count);
    }
  }

  const challengeId = String(entry?.id ?? "");
  if (challengeId) {
    for (const npc of npcDocuments) {
      const npcRaw = npc.raw ?? npc;
      const npcId = String(npc.id ?? npcRaw?.id ?? "");
      for (const link of npcRaw?.links ?? []) {
        if (link?.target_type === "challenge" && String(link.target_id) === challengeId) {
          add(npcId, link.count ?? 1);
        }
      }
    }
  }

  return [...counts.entries()].map(([npcId, count]) => ({ npcId, count }));
}

/**
 * DLCE NPC ids that appear as enemies in any combat battlemap (unlinked prototype tokens).
 * @param {Array<{ entry: object, raw: object|null }>} battlemaps
 * @param {Array<{ id: string, raw: object }>} npcDocuments
 * @returns {Set<string>}
 */
export function collectCombatEnemyIds(battlemaps = [], npcDocuments = []) {
  const ids = new Set();
  for (const { entry, raw } of battlemaps) {
    for (const { npcId } of collectChallengeEnemies(entry, raw, { npcDocuments })) {
      ids.add(npcId);
    }
  }
  return ids;
}

function normalizeEnemyField(value) {
  if (value == null || value === "") {
    return [];
  }
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (_error) {
      return String(value)
        .split(/[,;\n]/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((npcId) => ({ npcId, count: 1 }));
    }
  }
  if (!Array.isArray(parsed)) {
    if (parsed && typeof parsed === "object") {
      parsed = Object.entries(parsed).map(([npcId, count]) => ({ npcId, count }));
    } else {
      return [];
    }
  }
  return parsed
    .map((row) => {
      if (typeof row === "string") {
        return { npcId: row, count: 1 };
      }
      if (!row || typeof row !== "object") {
        return null;
      }
      const npcId = row.npcId ?? row.id ?? row.target_id ?? row.enemy_id ?? row.name;
      const count = row.count ?? row.quantity ?? row.qty ?? 1;
      return npcId ? { npcId: String(npcId), count } : null;
    })
    .filter(Boolean);
}

/**
 * Location description text for the Description drawing.
 * Session notes are separate — do not fall back to fields.notes.
 */
export function locationDescriptionText(raw) {
  const fields = raw?.fields ?? {};
  return String(
    fields.description || fields.appearance || fields.location_description || ""
  ).trim();
}

/**
 * Session notes for the Session Notes drawing.
 * Prefers document fields, then manifest.sessionNotes.
 *
 * @param {object|null|undefined} raw
 * @param {object|null|undefined} manifest
 */
export function locationSessionNotesText(raw, manifest = null) {
  const fields = raw?.fields ?? {};
  return String(
    fields.session_note ||
      fields.session_notes ||
      fields.sessionNotes ||
      raw?.session_note ||
      raw?.session_notes ||
      raw?.sessionNotes ||
      manifest?.sessionNotes ||
      manifest?.session_notes ||
      ""
  ).trim();
}

/**
 * Collect Points of Interest labels from a location document.
 * Supports several DLCE shapes (array/string/JSON; name|title|label|text objects).
 *
 * @returns {string[]}
 */
export function locationPois(raw) {
  const fields = raw?.fields ?? {};
  const candidates = [
    fields.pois,
    fields.poi,
    fields.points_of_interest,
    fields.pointsOfInterest,
    fields.location_pois,
    fields.locationPois,
    raw?.pois,
    raw?.points_of_interest
  ];

  for (const value of candidates) {
    const list = normalizePoiList(value);
    if (list.length) {
      return list;
    }
  }
  return [];
}

/**
 * Format POIs as a plain-text bullet list for a Foundry Description drawing.
 */
export function formatPoisBulletList(pois) {
  const list = (pois ?? []).map((poi) => String(poi ?? "").trim()).filter(Boolean);
  if (!list.length) {
    return "";
  }
  return list.map((poi) => `• ${poi}`).join("\n");
}

function normalizePoiList(value) {
  if (value == null || value === "") {
    return [];
  }
  let parsed = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch (_error) {
      return trimmed
        .split(/\n+/)
        .map((line) => line.replace(/^[-*•]\s*/, "").trim())
        .filter(Boolean);
    }
  }
  if (!Array.isArray(parsed)) {
    if (parsed && typeof parsed === "object") {
      parsed = Object.values(parsed);
    } else {
      return [];
    }
  }
  return parsed
    .map((row) => {
      if (typeof row === "string" || typeof row === "number") {
        return String(row).trim();
      }
      if (!row || typeof row !== "object") {
        return "";
      }
      return String(
        row.name || row.title || row.label || row.text || row.description || row.poi || ""
      ).trim();
    })
    .filter(Boolean);
}
