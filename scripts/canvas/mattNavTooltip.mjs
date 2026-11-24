/**
 * Show the scene name when hovering MATT nav tiles (Foundry tiles have no built-in nameplate).
 */

import { FLAG_SCOPE, MODULE_ID } from "../constants.mjs";

const TOOLTIP_ID = "dlfi-matt-nav-tooltip";

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
    "max-width:360px",
    "padding:6px 10px",
    "border-radius:6px",
    "background:rgba(20,18,14,0.92)",
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

function hideTooltip() {
  const el = document.getElementById(TOOLTIP_ID);
  if (el) {
    el.style.display = "none";
    el.textContent = "";
  }
}

/**
 * @param {string} text
 * @param {number} clientX
 * @param {number} clientY
 */
function showTooltip(text, clientX, clientY) {
  const el = ensureTooltipEl();
  el.textContent = text;
  el.style.display = "block";
  const pad = 14;
  const rect = el.getBoundingClientRect();
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

/** @type {string} */
let activeTooltipText = "";

function pointerClient() {
  const pointer = globalThis.canvas?.app?.renderer?.events?.pointer;
  if (pointer && typeof pointer.clientX === "number") {
    return { x: pointer.clientX, y: pointer.clientY };
  }
  const ev = globalThis.event;
  if (ev && typeof ev.clientX === "number") {
    return { x: ev.clientX, y: ev.clientY };
  }
  return { x: window.innerWidth / 2, y: 40 };
}

/**
 * Register canvas hover hooks for MATT scene-nav tiles.
 */
export function registerMattNavTooltipHooks() {
  Hooks.on("hoverTile", (tile, hovered) => {
    try {
      if (!hovered) {
        activeTooltipText = "";
        hideTooltip();
        return;
      }
      const doc = tile?.document ?? tile;
      const text = mattNavTooltipText(doc);
      if (!text) {
        activeTooltipText = "";
        hideTooltip();
        return;
      }
      activeTooltipText = text;
      const { x, y } = pointerClient();
      showTooltip(text, x, y);
    } catch (error) {
      console.warn(`${MODULE_ID} | matt nav tooltip failed`, error);
      activeTooltipText = "";
      hideTooltip();
    }
  });

  // Keep the label next to the cursor while hovering.
  Hooks.on("canvasReady", () => {
    const canvasEl = globalThis.canvas?.app?.view;
    if (!canvasEl || canvasEl.dataset.dlfiMattTip === "1") {
      return;
    }
    canvasEl.dataset.dlfiMattTip = "1";
    canvasEl.addEventListener("pointermove", (ev) => {
      if (!activeTooltipText) {
        return;
      }
      showTooltip(activeTooltipText, ev.clientX, ev.clientY);
    });
  });

  // Clear when the cursor leaves the canvas / switches tools.
  Hooks.on("canvasTearDown", () => {
    activeTooltipText = "";
    hideTooltip();
  });
}
