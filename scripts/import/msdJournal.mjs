/**
 * Convert package MSD HTML into Foundry single-column journal HTML.
 */

/**
 * @param {string} html
 * @param {{
 *   createdByDlceId?: Map<string, string>,
 *   uploaded?: Map<string, string>,
 *   documents?: Iterable<object>
 * }} [options]
 * @returns {string}
 */
export function convertMsdHtmlForFoundry(
  html,
  { createdByDlceId = new Map(), uploaded = new Map(), documents = [] } = {}
) {
  const source = String(html ?? "");
  let body = extractMsdSingleColumn(source);
  body = stripPrintChrome(body);
  body = promoteMsdHeadingDivs(body);
  body = mapAnchoredBlocks(body, (attrs, inner) =>
    linkFirstHeading(attrs, inner, createdByDlceId)
  );
  body = rewriteRelatedIdSpans(body, createdByDlceId);
  body = mapAnchoredBlocks(body, (attrs, inner) =>
    injectPortraitAfterFirstHeading(attrs, inner, { uploaded, documents })
  );
  body = rewriteImageSources(body, uploaded);
  return body.trim();
}

/**
 * Depth-aware extract: title article + flow-source inner + appendix-source inner.
 * Falls back to the full document when markers are missing.
 *
 * @param {string} html
 * @returns {string}
 */
export function extractMsdSingleColumn(html) {
  const parts = [];
  const title = extractElementByClass(html, "article", "dlce-v2-msd-title-page");
  if (title) {
    parts.push(title.outer);
  }

  const flow = extractElementByClass(html, "div", "dlce-v2-msd-flow-source");
  if (flow) {
    parts.push(flow.inner);
  }

  const appendix = extractElementByClass(html, "div", "dlce-v2-msd-appendix-source");
  if (appendix) {
    parts.push(appendix.inner);
  }

  if (!parts.length) {
    return html;
  }
  return parts.filter(Boolean).join("\n");
}

/**
 * Promote `.dlce-v2-msd-h1/h2/h3` divs (and title session name) to real headings.
 * Location + combat-challenge headings become `<h2>` so Foundry's journal ToC
 * can jump between them. Nested `<h2>`/`<p>` wrappers from the MSD are flattened.
 *
 * @param {string} html
 * @returns {string}
 */
export function promoteMsdHeadingDivs(html) {
  let next = String(html ?? "");

  // Title card session name → h1 (Foundry journal title signal).
  next = next.replace(
    /<div\b([^>]*\bdlce-v2-msd-title-session-name\b[^>]*)>([\s\S]*?)<\/div>/gi,
    (_match, attrs, inner) =>
      `<h1${stripRoleHeadingAttrs(attrs)}>${flattenHeadingInner(inner)}</h1>`
  );

  // Combat challenge children: promote their h3 wrappers to h2 for journal nav.
  next = next.replace(
    /<(section)\b([^>]*\bis-challenge\b[^>]*)>([\s\S]*?)<\/\1>/gi,
    (_match, tag, attrs, inner) => {
      const promoted = String(inner).replace(
        /<div\b([^>]*\bdlce-v2-msd-h3\b[^>]*)>([\s\S]*?)<\/div>/i,
        (_h, hAttrs, hInner) =>
          `<h2${stripRoleHeadingAttrs(hAttrs)}>${flattenHeadingInner(hInner)}</h2>`
      );
      return `<${tag}${attrs}>${promoted}</${tag}>`;
    }
  );

  next = next.replace(
    /<div\b([^>]*\bdlce-v2-msd-h([123])\b[^>]*)>([\s\S]*?)<\/div>/gi,
    (_match, attrs, level, inner) =>
      `<h${level}${stripRoleHeadingAttrs(attrs)}>${flattenHeadingInner(inner)}</h${level}>`
  );

  return next;
}

/**
 * Unwrap a single nested heading/paragraph so we do not emit `<h2><h2>…</h2></h2>`.
 * @param {string} inner
 */
function flattenHeadingInner(inner) {
  const trimmed = String(inner ?? "").trim();
  const nested = trimmed.match(/^<(h[1-6]|p)\b[^>]*>([\s\S]*)<\/\1>$/i);
  if (nested) {
    return nested[2];
  }
  return inner;
}

/**
 * Strip print/editor chrome that does not belong in a Foundry journal page.
 *
 * @param {string} html
 * @returns {string}
 */
export function stripPrintChrome(html) {
  let next = String(html ?? "");
  // Logo overlay on the title card.
  next = next.replace(/<div\b[^>]*\bdlce-v2-msd-title-logo\b[^>]*>[\s\S]*?<\/div>/gi, "");
  // Editor / print attributes.
  next = next.replace(/\s+draggable=(["'])(?:true|false)\1/gi, "");
  next = next.replace(/\s+hidden(?=[\s>])/gi, "");
  next = next.replace(/\s+aria-hidden=(["'])(?:true|false)\1/gi, "");
  // Page footers are print chrome.
  next = next.replace(
    /<footer\b[^>]*\bdlce-v2-msd-page-footer\b[^>]*>[\s\S]*?<\/footer>/gi,
    ""
  );
  return next;
}

/**
 * Walk blocks that carry data-msd-wd-id / location-id / host-id (nested-safe).
 *
 * @param {string} html
 * @param {(attrs: string, inner: string) => string} mapper
 * @returns {string}
 */
function mapAnchoredBlocks(html, mapper) {
  const openRe =
    /<(section|article|div)\b([^>]*\bdata-msd-(?:wd-id|location-id|host-id)=["'][^"']+["'][^>]*)>/gi;
  let out = "";
  let cursor = 0;
  const source = String(html ?? "");

  while (cursor < source.length) {
    openRe.lastIndex = cursor;
    const match = openRe.exec(source);
    if (!match) {
      out += source.slice(cursor);
      break;
    }
    out += source.slice(cursor, match.index);
    const tag = match[1];
    const attrs = match[2];
    const afterOpen = match.index + match[0].length;
    const closeIdx = findMatchingClose(source, tag, afterOpen);
    if (closeIdx < 0) {
      out += match[0];
      cursor = afterOpen;
      continue;
    }
    let inner = source.slice(afterOpen, closeIdx);
    inner = mapAnchoredBlocks(inner, mapper);
    inner = mapper(attrs, inner) ?? inner;
    out += `<${tag}${attrs}>${inner}</${tag}>`;
    cursor = closeIdx + `</${tag}>`.length;
  }
  return out;
}

function linkFirstHeading(attrs, inner, createdByDlceId) {
  const dlceId = firstMsdAnchorId(attrs);
  if (!dlceId || dlceId.startsWith("__")) {
    return inner;
  }
  const uuid = createdByDlceId?.get(dlceId);
  if (!uuid) {
    return inner;
  }
  const label =
    attrValue(attrs, "data-msd-label") ||
    stripTags(inner.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ?? "").trim() ||
    dlceId;

  let linked = false;
  return inner.replace(/<(h[1-3])\b([^>]*)>([\s\S]*?)<\/\1>/i, (hMatch, hTag, hAttrs, hInner) => {
    if (linked || /@UUID\[/.test(hInner)) {
      return hMatch;
    }
    linked = true;
    return `<${hTag}${hAttrs}>@UUID[${uuid}]{${escapeHtml(label)}}</${hTag}>`;
  });
}

function injectPortraitAfterFirstHeading(attrs, inner, { uploaded = new Map(), documents = [] } = {}) {
  const dlceId = firstMsdAnchorId(attrs);
  if (!dlceId || dlceId.startsWith("__")) {
    return inner;
  }

  /** @type {Map<string, object>} */
  const byId = documents instanceof Map ? documents : null;
  let entry = byId?.get(dlceId) ?? null;
  if (!entry) {
    for (const row of documents ?? []) {
      if (row?.id && String(row.id) === dlceId) {
        entry = row;
        break;
      }
    }
  }
  const portraitPath = entry?.portrait ? String(entry.portrait) : "";
  if (!portraitPath) {
    return inner;
  }
  const worldPath = uploaded.get(portraitPath) || portraitPath;

  const headingMatch = inner.match(/<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]>/i);
  if (!headingMatch || headingMatch.index == null) {
    return inner;
  }
  const afterStart = headingMatch.index + headingMatch[0].length;
  const afterHeading = inner.slice(afterStart, afterStart + 500);
  if (/<img\b/i.test(afterHeading)) {
    return inner;
  }

  const alt = escapeHtml(attrValue(attrs, "data-msd-label") || entry?.name || dlceId);
  const img = `<img class="dlce-v2-msd-art is-portrait" src="${escapeHtml(worldPath)}" alt="${alt}" />`;
  return `${inner.slice(0, afterStart)}\n${img}${inner.slice(afterStart)}`;
}

/**
 * Replace `data-msd-related-id` spans with Foundry @UUID links when resolved.
 *
 * @param {string} html
 * @param {Map<string, string>} createdByDlceId
 * @returns {string}
 */
function rewriteRelatedIdSpans(html, createdByDlceId) {
  return String(html ?? "").replace(
    /<span\b([^>]*\bdata-msd-related-id=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/span>/gi,
    (match, _attrs, relatedId, inner) => {
      const id = String(relatedId || "").trim();
      if (!id || id.startsWith("__")) {
        return match;
      }
      const uuid = createdByDlceId?.get(id);
      if (!uuid) {
        return match;
      }
      const label = stripTags(inner).trim() || id;
      return `@UUID[${uuid}]{${escapeHtml(label)}}`;
    }
  );
}

/**
 * Rewrite `<img src>` values that match package-relative uploaded paths.
 * MSD HTML uses paths relative to `msd/msd.html` (`../assets/...`).
 *
 * @param {string} html
 * @param {Map<string, string>} uploaded
 * @returns {string}
 */
function rewriteImageSources(html, uploaded) {
  if (!uploaded?.size) {
    return html;
  }
  return String(html ?? "").replace(
    /(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi,
    (match, prefix, src, suffix) => {
      const world = resolveUploadedImageSrc(src, uploaded);
      if (!world) {
        return match;
      }
      return `${prefix}${escapeHtml(world)}${suffix}`;
    }
  );
}

/**
 * Map an MSD/img src onto an uploaded world Data path.
 * @param {string} src
 * @param {Map<string, string>} uploaded
 * @returns {string|null}
 */
function resolveUploadedImageSrc(src, uploaded) {
  const raw = String(src || "").trim();
  if (!raw || raw.startsWith("data:") || /^https?:\/\//i.test(raw)) {
    return raw.startsWith("data:") || /^https?:\/\//i.test(raw) ? raw : null;
  }
  if (uploaded.has(raw)) {
    return uploaded.get(raw);
  }
  const key = normalizePackagePath(raw);
  if (uploaded.has(key)) {
    return uploaded.get(key);
  }
  // Basename fallback (e.g. same file under assets/location/ vs portraits/).
  const base = key.split("/").pop();
  if (base) {
    for (const [packagePath, worldPath] of uploaded.entries()) {
      if (String(packagePath).split("/").pop() === base) {
        return worldPath;
      }
    }
  }
  return null;
}

/**
 * Extract the outerHTML (and innerHTML) of the first element with tag+class.
 * Depth-aware so nested same-tag elements close correctly.
 *
 * @param {string} html
 * @param {string} tag
 * @param {string} className
 * @returns {{ outer: string, inner: string }|null}
 */
function extractElementByClass(html, tag, className) {
  const openRe = new RegExp(
    `<${tag}\\b([^>]*\\b${escapeRegExp(className)}\\b[^>]*)>`,
    "i"
  );
  const openMatch = openRe.exec(html);
  if (!openMatch) {
    return null;
  }
  const start = openMatch.index;
  const afterOpen = start + openMatch[0].length;
  const close = findMatchingClose(html, tag, afterOpen);
  if (close < 0) {
    return null;
  }
  const inner = html.slice(afterOpen, close);
  const outer = html.slice(start, close + `</${tag}>`.length);
  return { outer, inner };
}

/**
 * @param {string} html
 * @param {string} tag
 * @param {number} fromIndex index after the opening tag
 * @returns {number} index of the matching closing tag, or -1
 */
function findMatchingClose(html, tag, fromIndex) {
  const openToken = new RegExp(`<${tag}\\b`, "gi");
  const closeToken = new RegExp(`</${tag}\\s*>`, "gi");
  let depth = 1;
  let cursor = fromIndex;
  while (depth > 0 && cursor < html.length) {
    openToken.lastIndex = cursor;
    closeToken.lastIndex = cursor;
    const nextOpen = openToken.exec(html);
    const nextClose = closeToken.exec(html);
    if (!nextClose) {
      return -1;
    }
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return nextClose.index;
    }
    cursor = nextClose.index + nextClose[0].length;
  }
  return -1;
}

function firstMsdAnchorId(attrs) {
  return (
    attrValue(attrs, "data-msd-wd-id") ||
    attrValue(attrs, "data-msd-location-id") ||
    attrValue(attrs, "data-msd-host-id") ||
    ""
  );
}

function attrValue(attrs, name) {
  const match = String(attrs ?? "").match(
    new RegExp(`\\b${escapeRegExp(name)}=["']([^"']*)["']`, "i")
  );
  return match ? String(match[1]).trim() : "";
}

function stripRoleHeadingAttrs(attrs) {
  return String(attrs ?? "")
    .replace(/\s+role=["']heading["']/gi, "")
    .replace(/\s+aria-level=["']\d+["']/gi, "");
}

function stripTags(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePackagePath(src) {
  let next = String(src ?? "")
    .trim()
    .replace(/\\/g, "/")
    .split(/[?#]/)[0];
  // MSD lives under msd/, so artwork is referenced as ../assets/...
  while (next.startsWith("../")) {
    next = next.slice(3);
  }
  while (next.startsWith("./")) {
    next = next.slice(2);
  }
  return next.replace(/^\/+/, "");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
