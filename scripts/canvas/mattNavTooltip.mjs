/**
 * Show the scene name when hovering MATT nav tiles.
 *
 * Foundry only fires hoverTile while the Tiles layer is active, so we hit-test
 * on pointermove against matt-nav tiles on every layer (Token layer included).
 */

import { FLAG_SCOPE, MODULE_ID } from "../constants.mjs";

const TOOLTIP_ID = "dlfi-matt-nav-tooltip";
const HIT_ATTR = "data-dlfi-matt-tip";

/**
 * @returns {HTMLElement}
 */
function ensureTooltipEl() {
  let el = document.getElementById(TOOLTIP_ID);
  if (el) {
    return el;
  }
  el = document.createElement("div");
  el.id = TOOLTIP_ID;
  el.style.cssText = [
    "position:fixed",
    "z-index:10000",
    "pointer-events:none",
    "display:none",
    "max-width:420px",
    "padding:6px 10px",
    "border-radius:6px",
    "background:rgba(20,18,14,0.94)",
    "color:#f5efe3",
    "font-size:13px",
    "font-weight:600",
    "line-height:1.25",
    "box-shadow:0 4px 16px rgba(0,0,0,0.45)",
    "border:1px solid rgba(255,255,255,0.12)"
  ].join(";");
  document.body.appendChild(el);
  return el;
}

/** Cached size of the tooltip for its current text (avoids layout per move). */
let tooltipSize = null;

function hideTooltip() {
  const el = document.getElementById(TOOLTIP_ID);
  if (el) {
    el.style.display = "none";
    el.textContent = "";
  }
  tooltipSize = null;
  try {
    globalThis.game?.tooltip?.deactivate?.();
  } catch (_error) {
    /* ignore */
  }
}

/**
 * @param {string} text
 * @param {number} clientX
 * @param {number} clientY
 */
function showTooltip(text, clientX, clientY) {
  const el = ensureTooltipEl();
  if (el.textContent !== text || el.style.display !== "block" || !tooltipSize) {
    el.textContent = text;
    el.style.display = "block";
    const measured = el.getBoundingClientRect();
    tooltipSize = { width: measured.width, height: measured.height };
  }
  const pad = 14;
  const rect = tooltipSize;
  let left = clientX + pad;
  let top = clientY + pad;
  if (left + rect.width > window.innerWidth - 8) {
    left = clientX - rect.width - pad;
  }
  if (top + rect.height > window.innerHeight - 8) {
    top = clientY - rect.height - pad;
  }
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

/**
 * @param {object|null|undefined} tileDoc
 * @returns {string}
 */
export function mattNavTooltipText(tileDoc) {
  if (!tileDoc) {
    return "";
  }
  const kind = tileDoc.flags?.[FLAG_SCOPE]?.kind;
  if (kind !== "matt-nav-left" && kind !== "matt-nav-right") {
    return "";
  }
  return String(tileDoc.name || "").trim();
}

/**
 * Convert a client (browser) point to canvas world coordinates.
 * @param {object} canvas
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{ x: number, y: number }|null}
 */
export function clientToCanvasPoint(canvas, clientX, clientY) {
  if (!canvas) {
    return null;
  }
  // Foundry keeps a live world-space cursor on the canvas.
  const mouse = canvas.mousePosition;
  if (mouse && Number.isFinite(mouse.x) && Number.isFinite(mouse.y)) {
    return { x: mouse.x, y: mouse.y };
  }
  try {
    if (typeof canvas.canvasCoordinatesFromClient === "function") {
      const pt = canvas.canvasCoordinatesFromClient({ x: clientX, y: clientY });
      if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
        return { x: pt.x, y: pt.y };
      }
    }
  } catch (_error) {
    /* fall through */
  }
  try {
    const rect = canvas.app?.view?.getBoundingClientRect?.();
    const stage = canvas.stage;
    if (!rect || !stage?.toLocal) {
      return null;
    }
    const world = stage.toLocal({ x: clientX - rect.left, y: clientY - rect.top });
    if (world && Number.isFinite(world.x) && Number.isFinite(world.y)) {
      return { x: world.x, y: world.y };
    }
  } catch (_error) {
    /* ignore */
  }
  return null;
}

/**
 * Axis-aligned bounds for a nav tile.
 * Foundry V13+ TileDocument x/y is the mesh origin (texture.anchor, usually 0.5
 * = centre). Treating x/y as top-left makes the hit box extend right and below
 * the visible art — use anchor-aware edges only (ignore inflated placeable.bounds).
 * @param {object} tile
 * @returns {{ x: number, y: number, x2: number, y2: number }|null}
 */
export function mattNavTileBounds(tile) {
  const doc = tile?.document ?? tile;
  if (!doc) {
    return null;
  }
  const kind = doc.flags?.[FLAG_SCOPE]?.kind;
  if (kind !== "matt-nav-left" && kind !== "matt-nav-right") {
    return null;
  }
  const src = doc._source ?? doc;
  const x = Number(src.x);
  const y = Number(src.y);
  const w = Number(src.width);
  const h = Number(src.height);
  if (![x, y, w, h].every((n) => Number.isFinite(n)) || w <= 0 || h <= 0) {
    return null;
  }
  const tex = src.texture ?? {};
  const ax = Number.isFinite(Number(tex.anchorX)) ? Number(tex.anchorX) : 0.5;
  const ay = Number.isFinite(Number(tex.anchorY)) ? Number(tex.anchorY) : 0.5;
  const left = x - w * ax;
  const top = y - h * ay;
  return { x: left, y: top, x2: left + w, y2: top + h };
}

/**
 * @param {object} canvas
 * @param {number} worldX
 * @param {number} worldY
 * @returns {object|null} Tile placeable or document
 */
export function findMattNavTileAt(canvas, worldX, worldY) {
  const placeables = canvas?.tiles?.placeables ?? [];
  /** @type {object[]} */
  const hits = [];
  for (const tile of placeables) {
    const box = mattNavTileBounds(tile);
    if (!box) {
      continue;
    }
    if (worldX >= box.x && worldX <= box.x2 && worldY >= box.y && worldY <= box.y2) {
      hits.push(tile);
    }
  }
  if (!placeables.length) {
    // Fallback: documents on the scene (placeables are empty mid-draw).
    const docs = canvas?.scene?.tiles?.contents ?? [];
    for (const doc of docs) {
      const box = mattNavTileBounds(doc);
      if (!box) {
        continue;
      }
      if (worldX >= box.x && worldX <= box.x2 && worldY >= box.y && worldY <= box.y2) {
        hits.push(doc);
      }
    }
  }
  if (!hits.length) {
    return null;
  }
  // Top-most by sort.
  hits.sort((a, b) => {
    const sa = Number((a.document ?? a).sort) || 0;
    const sb = Number((b.document ?? b).sort) || 0;
    return sb - sa;
  });
  return hits[0];
}

/** @type {string} */
let activeTooltipText = "";

/**
 * Register canvas hover hooks for MATT scene-nav tiles.
 * @returns {{ onCanvasReady: (canvas: object) => void }}
 */
export function registerMattNavTooltipHooks() {
  // Still listen in case the Tiles layer is active.
  Hooks.on("hoverTile", (tile, hovered) => {
    try {
      if (!hovered) {
        return;
      }
      const doc = tile?.document ?? tile;
      const text = mattNavTooltipText(doc);
      if (!text) {
        return;
      }
      activeTooltipText = text;
      const pointer = globalThis.canvas?.app?.renderer?.events?.pointer;
      showTooltip(
        text,
        typeof pointer?.clientX === "number" ? pointer.clientX : window.innerWidth / 2,
        typeof pointer?.clientY === "number" ? pointer.clientY : 40
      );
    } catch (error) {
      console.warn(`${MODULE_ID} | matt nav tooltip (hoverTile) failed`, error);
    }
  });

  const onCanvasReady = (canvas) => {
    const view = canvas?.app?.view;
    if (!view || view.getAttribute(HIT_ATTR) === "1") {
      return;
    }
    view.setAttribute(HIT_ATTR, "1");

    // One hit-test per animation frame, using the latest pointer position.
    let pending = null;
    const onMove = (ev) => {
      const first = pending == null;
      pending = { clientX: ev.clientX, clientY: ev.clientY };
      if (first) {
        requestAnimationFrame(flush);
      }
    };
    const flush = () => {
      const ev = pending;
      pending = null;
      if (!ev) {
        return;
      }
      try {
        const world = clientToCanvasPoint(canvas, ev.clientX, ev.clientY);
        if (!world) {
          activeTooltipText = "";
          hideTooltip();
          return;
        }
        const hit = findMattNavTileAt(canvas, world.x, world.y);
        const doc = hit?.document ?? hit;
        const text = mattNavTooltipText(doc);
        if (!text) {
          if (activeTooltipText) {
            activeTooltipText = "";
            hideTooltip();
          }
          return;
        }
        activeTooltipText = text;
        showTooltip(text, ev.clientX, ev.clientY);
      } catch (error) {
        console.warn(`${MODULE_ID} | matt nav tooltip move failed`, error);
      }
    };

    const onLeave = () => {
      pending = null;
      activeTooltipText = "";
      hideTooltip();
    };

    view.addEventListener("pointermove", onMove);
    view.addEventListener("pointerleave", onLeave);
  };
  Hooks.on("canvasReady", onCanvasReady);

  Hooks.on("canvasTearDown", () => {
    activeTooltipText = "";
    hideTooltip();
  });
  return { onCanvasReady };
}
