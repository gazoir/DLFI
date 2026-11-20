/**
 * NPC prototype-token art: multi-slot VTT tokens → Foundry wildcard + randomImg.
 *
 * Package contract (document entries, all optional):
 * - `tokens`: string[] — sequentially numbered token files, e.g.
 *   `assets/npc/tokens/npc_goblin_1.webp`, `…_2.webp`
 * - `tokenWildcard`: string — package-relative glob containing `*`
 *   (e.g. `assets/npc/tokens/npc_goblin_*.webp`)
 * Without either field, DLFI auto-detects `{id}_{n}.{ext}` files under
 * `assets/{npc,npcs}/tokens/` (two or more).
 */

/** Foundry CONST.TOKEN_DISPLAY_MODES.HOVER — "Hovered by Anyone". */
export const TOKEN_DISPLAY_HOVER = 30;

export function tokenDisplayHover() {
  return globalThis.CONST?.TOKEN_DISPLAY_MODES?.HOVER ?? TOKEN_DISPLAY_HOVER;
}

export function isWildcardPath(path) {
  return typeof path === "string" && path.includes("*");
}

function normalizePath(path) {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function escapeRegex(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Convert a glob (only `*` is special) into a RegExp. */
export function wildcardToRegExp(pattern) {
  const source = normalizePath(pattern)
    .split("*")
    .map(escapeRegex)
    .join(".*");
  return new RegExp(`^${source}$`, "i");
}

/**
 * Trailing `{n}.{ext}` of a path, if any.
 * @returns {{ prefix: string, index: number, ext: string }|null}
 */
export function parseSlotPath(path) {
  const match = normalizePath(path).match(/^(.*?)(\d+)(\.[A-Za-z0-9]+)$/);
  if (!match) {
    return null;
  }
  return { prefix: match[1], index: Number(match[2]), ext: match[3] };
}

/**
 * Sort slot paths sequentially (by trailing number, then natural order).
 * @param {string[]} paths
 */
export function sortSlotPaths(paths) {
  return [...paths].sort((a, b) => {
    const pa = parseSlotPath(a);
    const pb = parseSlotPath(b);
    if (pa && pb && pa.prefix === pb.prefix && pa.index !== pb.index) {
      return pa.index - pb.index;
    }
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  });
}

function longestCommonPrefix(values) {
  if (!values.length) {
    return "";
  }
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

/**
 * Wildcard path (single `*`) covering a set of sequentially numbered paths.
 * `a/n_1.webp`, `a/n_2.webp` → `a/n_*.webp`
 * @param {string[]} paths
 * @returns {string|null}
 */
export function buildTokenWildcard(paths) {
  const list = paths.map(normalizePath).filter(Boolean);
  if (list.length < 2) {
    return null;
  }
  const parsed = list.map(parseSlotPath);
  if (
    parsed.every(Boolean) &&
    parsed.every((p) => p.prefix === parsed[0].prefix && p.ext.toLowerCase() === parsed[0].ext.toLowerCase())
  ) {
    return `${parsed[0].prefix}*${parsed[0].ext}`;
  }
  const prefix = longestCommonPrefix(list);
  const exts = new Set(list.map((p) => (p.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "").toLowerCase()));
  const ext = exts.size === 1 ? [...exts][0] : "";
  return `${prefix}*${ext}`;
}

/**
 * Discover `{id}_{n}.{ext}` slot files for an NPC in the uploaded map.
 * @param {string} npcId
 * @param {Map<string, string>} uploaded packagePath -> world path
 * @returns {string[]} package paths, sequentially sorted
 */
export function discoverTokenSlotPaths(npcId, uploaded) {
  const id = String(npcId ?? "").trim();
  if (!id) {
    return [];
  }
  const stems = [...new Set([id, id.replace(/^npc_/, "")].filter(Boolean))];
  const found = [];
  for (const packagePath of uploaded.keys()) {
    const normalized = normalizePath(packagePath);
    if (!/^assets\/(?:npc|npcs)\/(?:[^/]+\/)*tokens?\//i.test(normalized)) {
      continue;
    }
    const base = normalized.split("/").pop() ?? "";
    const parsed = parseSlotPath(base);
    if (!parsed) {
      continue;
    }
    const stem = parsed.prefix.replace(/[_.\- ]+$/, "");
    if (stems.some((s) => s.toLowerCase() === stem.toLowerCase())) {
      found.push(normalized);
    }
  }
  return sortSlotPaths(found);
}

/**
 * Resolve multi-slot token art for an NPC document entry.
 * @param {object} entry manifest document entry
 * @param {Map<string, string>} uploaded packagePath -> world Data path
 * @returns {{ slots: string[], packageSlots: string[], wildcard: string|null }}
 */
export function resolveNpcTokenSlots(entry, uploaded) {
  const empty = { slots: [], packageSlots: [], wildcard: null };
  const declared = [entry?.tokens, entry?.tokenSlots].find(Array.isArray) ?? [];
  let packageSlots = declared.map(normalizePath).filter((path) => uploaded.has(path));

  const explicitWildcard = [entry?.tokenWildcard, isWildcardPath(entry?.token) ? entry.token : null]
    .map((value) => (typeof value === "string" ? normalizePath(value) : ""))
    .find((value) => value.includes("*"));

  if (explicitWildcard) {
    const matcher = wildcardToRegExp(explicitWildcard);
    const matched = sortSlotPaths([...uploaded.keys()].filter((path) => matcher.test(path)));
    if (matched.length) {
      packageSlots = matched;
    }
  }

  if (packageSlots.length < 2) {
    packageSlots = discoverTokenSlotPaths(entry?.id, uploaded);
  }
  if (packageSlots.length < 2) {
    return empty;
  }
  packageSlots = sortSlotPaths([...new Set(packageSlots)]);

  const packageWildcard = explicitWildcard || buildTokenWildcard(packageSlots);
  if (!packageWildcard) {
    return empty;
  }
  const slots = packageSlots.map((path) => uploaded.get(path)).filter(Boolean);
  return {
    slots,
    packageSlots,
    wildcard: toWorldWildcard(packageWildcard, packageSlots[0], uploaded.get(packageSlots[0]))
  };
}

/**
 * Re-root a package-relative wildcard onto the world Data path of one matching file.
 */
export function toWorldWildcard(packageWildcard, samplePackagePath, sampleWorldPath) {
  const pkg = normalizePath(samplePackagePath);
  const world = normalizePath(sampleWorldPath);
  if (!world) {
    return packageWildcard;
  }
  if (world.endsWith(pkg)) {
    return `${world.slice(0, world.length - pkg.length)}${normalizePath(packageWildcard)}`;
  }
  const worldDir = world.split("/").slice(0, -1).join("/");
  const wildName = normalizePath(packageWildcard).split("/").pop();
  return worldDir ? `${worldDir}/${wildName}` : wildName;
}

/**
 * Prototype-token fields for an NPC that has multiple token art slots.
 * @param {string[]} slots world paths
 * @param {string|null} wildcard world wildcard path
 */
export function wildcardPrototypeTokenPatch(slots, wildcard) {
  if (!wildcard || (slots?.length ?? 0) < 2) {
    return null;
  }
  return { randomImg: true, texture: { src: wildcard } };
}

/**
 * Concrete texture path for placing a token on a scene when the actor uses a wildcard.
 * @param {{ prototypeToken?: any, img?: string|null, flags?: any }} actor
 * @param {number} [variantIndex] cycle through slots; omit for a random pick
 * @param {string} [scope] flag scope
 */
export function pickTokenTexture(actor, variantIndex, scope = "dlfi") {
  const src = actor?.prototypeToken?.texture?.src || null;
  const slots = actor?.flags?.[scope]?.tokenSlots;
  if (Array.isArray(slots) && slots.length && (isWildcardPath(src) || actor?.prototypeToken?.randomImg)) {
    const index =
      Number.isInteger(variantIndex) && variantIndex >= 0
        ? variantIndex % slots.length
        : Math.floor(Math.random() * slots.length);
    return slots[index];
  }
  if (isWildcardPath(src)) {
    return actor?.img || null;
  }
  return src || actor?.img || null;
}
