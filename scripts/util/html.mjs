/**
 * Shared HTML helpers: escaping, entity decoding, attribute removal, sanitising.
 */

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

export function decodeHtmlEntities(value) {
  return String(value ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function stripTags(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ATTRIBUTE_RE = /(\s+)([^\s"'<>\/=]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/**
 * Remove attributes from every opening tag. Text content and attribute values
 * are never touched ("A hidden door" stays intact).
 * @param {string} html
 * @param {(name: string, value: string|null) => boolean} shouldRemove
 */
export function removeAttributes(html, shouldRemove) {
  return String(html ?? "").replace(/<([a-z][\w:-]*)(\s[^>]*?)?(\/?)>/gi, (match, tag, attrs = "", selfClose) => {
    if (!attrs) {
      return match;
    }
    const kept = attrs.replace(ATTRIBUTE_RE, (attr, _space, name, valuePart) => {
      const value = valuePart ? valuePart.replace(/^\s*=\s*/, "").replace(/^["']|["']$/g, "") : null;
      return shouldRemove(name.toLowerCase(), value) ? "" : attr;
    });
    return `<${tag}${kept}${selfClose}>`;
  });
}

const DROP_TAGS = ["script", "iframe", "object", "embed", "style", "form", "link", "meta", "base", "frame", "frameset", "noscript", "template"];
const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "background", "srcset"]);

/** Relative paths, http(s), mailto, and data:image (for src) are allowed. */
export function isSafeUrl(value, attrName = "href") {
  const raw = String(value ?? "").replace(/[\u0000-\u0020\u007f]+/g, "").trim();
  if (!raw) {
    return true;
  }
  if (attrName === "srcset") {
    return raw.split(",").every((part) => isSafeUrl(part.trim().split(/\s+/)[0], "src"));
  }
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (!scheme) {
    return true;
  }
  if (scheme === "http" || scheme === "https" || scheme === "mailto") {
    return true;
  }
  return scheme === "data" && attrName !== "href" && /^data:image\//i.test(raw);
}

function shouldDropAttribute(name, value) {
  if (name.startsWith("on")) {
    return true;
  }
  if (URL_ATTRS.has(name)) {
    return !isSafeUrl(decodeHtmlEntities(value ?? ""), name);
  }
  if (name === "style") {
    return /expression\s*\(|javascript:|url\s*\(\s*['"]?\s*(?!https?:|data:image\/)[a-z]+:/i.test(
      decodeHtmlEntities(value ?? "")
    );
  }
  return false;
}

function sanitizeWithRegex(html) {
  let next = String(html ?? "");
  for (const tag of DROP_TAGS) {
    next = next.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
    next = next.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
  }
  return removeAttributes(next, shouldDropAttribute);
}

/**
 * Allow-list clean of HTML before it is written into journals/items: drops
 * script-capable elements, on* handlers, and non-http(s)/relative/data:image URLs.
 * Uses DOMParser in the browser; a regex fallback keeps node selftests working.
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  const source = String(html ?? "");
  if (!source) {
    return "";
  }
  const Parser = globalThis.DOMParser;
  if (typeof Parser !== "function") {
    return sanitizeWithRegex(source);
  }
  const doc = new Parser().parseFromString(`<!doctype html><body>${source}</body>`, "text/html");
  for (const el of [...doc.body.querySelectorAll(DROP_TAGS.join(","))]) {
    el.remove();
  }
  for (const el of doc.body.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (shouldDropAttribute(attr.name.toLowerCase(), attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}
