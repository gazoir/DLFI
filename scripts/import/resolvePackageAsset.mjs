/**
 * Resolve package asset paths to uploaded world Data/ paths.
 * DLCE v2 organises artwork by WD type (assets/location/, assets/npc/, …)
 * while older packages used assets/portraits/ and assets/tokens/.
 */

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

/**
 * Find an uploaded asset whose filename matches (e.g. loc_ancient_ruin.webp).
 * @param {Map<string, string>} uploaded
 * @param {string[]} fileNames
 * @param {string[]} [preferredFolders]
 */
export function lookupUploadedByFileName(uploaded, fileNames = [], preferredFolders = []) {
  const wanted = new Set(
    fileNames
      .filter(Boolean)
      .map((name) => String(name).replace(/^\/+/, "").split("/").pop().toLowerCase())
  );
  if (!wanted.size) {
    return null;
  }

  const entries = [...uploaded.entries()];
  const prefer = preferredFolders.map((folder) =>
    String(folder).replace(/^\/+|\/+$/g, "").toLowerCase()
  );

  const ranked = entries
    .map(([packagePath, worldPath]) => {
      const base = packagePath.split("/").pop()?.toLowerCase() ?? "";
      if (!wanted.has(base)) {
        return null;
      }
      const folder = packagePath.split("/").slice(0, -1).join("/").toLowerCase();
      const preferIndex = prefer.findIndex(
        (prefix) => folder === prefix || folder.startsWith(`${prefix}/`)
      );
      return { worldPath, preferIndex: preferIndex === -1 ? 999 : preferIndex };
    })
    .filter(Boolean)
    .sort((a, b) => a.preferIndex - b.preferIndex);

  return ranked[0]?.worldPath ?? null;
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
export function resolveNpcMedia(entry, uploaded) {
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

  const token =
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
    ]) ||
    portrait;

  return { portrait, token };
}
