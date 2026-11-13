/**
 * Resolve DLCE Landing Page session artwork variants.
 *
 * Package layout (DLCE export):
 *   Landing Page/
 *     …_Clean.webp       — raw session image
 *     …_Logo_Burn.webp   — logo + title burned in → Landing scene background
 *     …_Logo_Only.webp   — full 16:9 logo on transparency (manual tile/drop)
 *     …_Title_Only.webp  — full 16:9 title on transparency (manual tile/drop)
 *
 * Also accepts the same files under assets/Landing Page/, assets/session/,
 * assets/landing/, or paths named in manifest.landingPage / sessionArt.
 */

import { lookupUploaded } from "./resolvePackageAsset.mjs";

const IMAGE_EXT = /\.(webp|png|jpg|jpeg|webm|avif)$/i;

/** Package-relative folders that hold Landing Page slides. */
export const LANDING_PAGE_FOLDER_RE =
  /(^|\/)(Landing[ _-]?Page|landing[ _-]?page|landing)(\/|$)/i;

/**
 * Whether a package path should be uploaded into the world imports tree.
 * Includes assets/** and top-level Landing Page/** (outside assets/).
 */
export function shouldUploadPackagePath(packagePath) {
  const path = String(packagePath || "").replace(/^\/+/, "").replace(/\\/g, "/");
  if (!path || path.endsWith("/")) {
    return false;
  }
  if (path.startsWith("assets/")) {
    return true;
  }
  if (/^Landing[ _-]?Page\//i.test(path)) {
    return true;
  }
  return false;
}

/**
 * @param {string} fileName
 * @returns {"logoBurn"|"logoOnly"|"titleOnly"|"clean"|null}
 */
export function classifyLandingFileName(fileName) {
  const base = String(fileName || "")
    .replace(/^\/+/, "")
    .split("/")
    .pop()
    .replace(IMAGE_EXT, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (!base) {
    return null;
  }
  if (/logo_?burn|burned|burn_?in|with_?logo/.test(base)) {
    return "logoBurn";
  }
  if (/logo_?only|only_?logo|^logo$/.test(base)) {
    return "logoOnly";
  }
  if (/title_?only|only_?title|^title$/.test(base)) {
    return "titleOnly";
  }
  if (/_?clean$|^clean_|(^|_)raw($|_)/.test(base) || base === "clean" || base === "raw") {
    return "clean";
  }
  return null;
}

/**
 * Collect Landing Page variants from uploaded package paths + optional manifest hints.
 *
 * @param {object} manifest
 * @param {Map<string, string>} uploaded packagePath -> world path
 * @returns {{
 *   logoBurn: string|null,
 *   logoOnly: string|null,
 *   titleOnly: string|null,
 *   clean: string|null,
 *   background: string|null,
 *   packagePaths: { logoBurn?: string, logoOnly?: string, titleOnly?: string, clean?: string }
 * }}
 */
export function resolveLandingPageArt(manifest, uploaded) {
  /** @type {Record<string, { packagePath: string, worldPath: string }>} */
  const found = {};

  const manifestLanding = asObject(manifest?.landingPage);
  const named = {
    logoBurn: firstString(manifestLanding, ["logoBurn", "logo_burn", "burn"]),
    logoOnly: firstString(manifestLanding, ["logoOnly", "logo_only", "logo"]),
    titleOnly: firstString(manifestLanding, ["titleOnly", "title_only", "title"]),
    clean: firstString(manifestLanding, ["clean", "raw", "session"])
  };

  for (const [kind, packagePath] of Object.entries(named)) {
    if (!packagePath) {
      continue;
    }
    const worldPath = lookupUploaded(uploaded, [packagePath]);
    if (worldPath) {
      found[kind] = { packagePath, worldPath };
    }
  }

  const assetList = [
    ...(Array.isArray(manifest?.assets?.landingPage) ? manifest.assets.landingPage : []),
    ...(Array.isArray(manifest?.assets?.["Landing Page"]) ? manifest.assets["Landing Page"] : []),
    ...(Array.isArray(manifest?.assets?.session) ? manifest.assets.session : [])
  ];

  for (const packagePath of assetList) {
    considerPath(found, packagePath, uploaded.get(String(packagePath).replace(/^\/+/, "").replace(/\\/g, "/")));
  }

  for (const [packagePath, worldPath] of uploaded.entries()) {
    const inLandingFolder = LANDING_PAGE_FOLDER_RE.test(packagePath);
    const inSessionFolder = /^assets\/(session|landing)\b/i.test(packagePath);
    if (!inLandingFolder && !inSessionFolder) {
      continue;
    }
    considerPath(found, packagePath, worldPath);
  }

  // Legacy single sessionArt path → clean (and background fallback)
  if (manifest?.sessionArt) {
    const packagePath = String(manifest.sessionArt).replace(/^\/+/, "").replace(/\\/g, "/");
    const worldPath = uploaded.get(packagePath) ?? null;
    if (worldPath && !found.clean) {
      found.clean = { packagePath, worldPath };
    }
  }

  const logoBurn = found.logoBurn?.worldPath ?? null;
  const logoOnly = found.logoOnly?.worldPath ?? null;
  const titleOnly = found.titleOnly?.worldPath ?? null;
  const clean = found.clean?.worldPath ?? null;

  // Landing background: Logo_Burn first, then clean / legacy sessionArt.
  const background = logoBurn || clean || lookupUploaded(uploaded, [manifest?.sessionArt]) || null;

  return {
    logoBurn,
    logoOnly,
    titleOnly,
    clean,
    background,
    packagePaths: {
      ...(found.logoBurn ? { logoBurn: found.logoBurn.packagePath } : {}),
      ...(found.logoOnly ? { logoOnly: found.logoOnly.packagePath } : {}),
      ...(found.titleOnly ? { titleOnly: found.titleOnly.packagePath } : {}),
      ...(found.clean ? { clean: found.clean.packagePath } : {})
    }
  };
}

function considerPath(found, packagePath, worldPath) {
  if (!packagePath || !worldPath) {
    return;
  }
  const kind = classifyLandingFileName(packagePath);
  if (!kind) {
    // Unclassified file inside Landing Page folder: treat as clean if none yet.
    if (LANDING_PAGE_FOLDER_RE.test(packagePath) && !found.clean && IMAGE_EXT.test(packagePath)) {
      found.clean = { packagePath, worldPath };
    }
    return;
  }
  if (!found[kind]) {
    found[kind] = { packagePath, worldPath };
  }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function firstString(obj, keys) {
  if (!obj) {
    return null;
  }
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
