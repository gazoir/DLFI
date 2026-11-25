/**
 * Which Token Magic filter a nav thumbnail should show.
 *
 * Background tiles: the active scene is outlined (also while you are viewing it),
 * the viewed scene is clear, and everything else is darkened.
 * Portrait tokens never take the outline. They are clear only while their scene
 * is the one you are viewing.
 */

const NAV_KINDS = new Set(["matt-nav-left", "matt-nav-right", "matt-nav-face"]);

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSceneId(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  const match = text.match(/^(?:Scene\.)?(.+)$/);
  return match ? match[1] : text;
}

/**
 * @param {object|null|undefined} tile
 * @returns {string}
 */
export function navTileKind(tile) {
  const doc = tile?.document ?? tile;
  return String(doc?.flags?.dlfi?.kind ?? "");
}

/**
 * @param {object|null|undefined} tile
 * @returns {boolean}
 */
export function isMattNavTile(tile) {
  return NAV_KINDS.has(navTileKind(tile));
}

/**
 * Scene id this nav tile represents. DLFI flag first, then a MATT scene action.
 * @param {object|null|undefined} tile
 * @returns {string}
 */
export function navTileTargetSceneId(tile) {
  const doc = tile?.document ?? tile;
  const fromFlag = doc?.flags?.dlfi?.targetSceneId;
  if (fromFlag) {
    return normalizeSceneId(fromFlag);
  }
  const actions = doc?.flags?.["monks-active-tiles"]?.actions;
  if (!Array.isArray(actions)) {
    return "";
  }
  for (const action of actions) {
    if (action?.action !== "scene") {
      continue;
    }
    const raw = action?.data?.sceneid?.id ?? action?.data?.sceneid ?? action?.data?.sceneId ?? null;
    if (raw) {
      return normalizeSceneId(raw);
    }
  }
  return "";
}

/**
 * @param {object|null|undefined} tile
 * @param {string} activeId
 * @param {string} viewedId
 * @param {{ active?: object[], neither?: object[] }} styles
 * @returns {object[]} Empty array clears filters.
 */
export function navTileFilterParams(tile, activeId, viewedId, styles) {
  const id = navTileTargetSceneId(tile);
  const isActive = Boolean(id) && id === normalizeSceneId(activeId);
  const isViewed = Boolean(id) && id === normalizeSceneId(viewedId);
  const darken = Array.isArray(styles?.neither) ? styles.neither : [];
  const outline = Array.isArray(styles?.active) ? styles.active : [];
  if (navTileKind(tile) === "matt-nav-face") {
    return isViewed ? [] : darken;
  }
  if (isActive) {
    return outline;
  }
  if (isViewed) {
    return [];
  }
  return darken;
}
