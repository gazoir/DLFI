/**
 * Build a dnd5e character Actor stub from the bundled PC template,
 * ready for D&D Beyond Importer sync.
 *
 * Overwrites: Actor name (full PC name), DDB flags, portrait, prototype
 * token (Known as + Hovered by Anyone + package token art).
 */

import { FLAG_SCOPE, MODULE_ID, TOKEN_DISPOSITION } from "../constants.mjs";
import { tokenDisplayHover } from "./tokenArt.mjs";

/** Default dnd5e character icon — treat as "missing" art for fill-only updates. */
export const DEFAULT_PC_ART = "systems/dnd5e/icons/svg/actors/character.svg";

/**
 * @param {unknown} src
 * @returns {boolean}
 */
export function isMissingPcArt(src) {
  const value = String(src ?? "").trim();
  if (!value) {
    return true;
  }
  return value.replace(/\\/g, "/") === DEFAULT_PC_ART;
}

/**
 * @param {Actor|object|null|undefined} actor
 * @returns {boolean}
 */
export function actorHasDdbLink(actor) {
  const flags = actor?.flags ?? {};
  const dnd = flags?.ddbimporter?.dndbeyond ?? {};
  if (dnd?.characterId != null && String(dnd.characterId).trim()) {
    return true;
  }
  if (dnd?.url != null && String(dnd.url).trim()) {
    return true;
  }
  if (flags?.[FLAG_SCOPE]?.ddbId != null && String(flags[FLAG_SCOPE].ddbId).trim()) {
    return true;
  }
  if (flags?.[FLAG_SCOPE]?.ddbUrl != null && String(flags[FLAG_SCOPE].ddbUrl).trim()) {
    return true;
  }
  return false;
}

/**
 * @param {{
 *   name?: string,
 *   knownAs?: string|null,
 *   ddbId?: string|null,
 *   ddbUrl?: string|null,
 *   playerName?: string|null,
 *   id?: string|null
 * }} pc
 * @param {{
 *   portrait?: string|null,
 *   token?: string|null,
 *   tokenScale?: number|null,
 *   folderId?: string|null,
 *   importKey?: string,
 *   template?: object|null
 * }} [media]
 */
export function buildPcActorData(pc, media = {}) {
  const name = String(pc?.name || "").trim() || "Unnamed PC";
  const knownAs = String(pc?.knownAs || "").trim() || name.split(/\s+/)[0] || name;
  const ddbUrl = String(pc?.ddbUrl || "").trim() || null;
  const ddbId =
    (pc?.ddbId != null && String(pc.ddbId).trim()) ||
    parseDdbCharacterId(ddbUrl) ||
    null;
  const portrait = media.portrait || null;
  const tokenSrc = media.token || portrait || null;
  const scale = Number(media.tokenScale);
  const tokenScale = Number.isFinite(scale) && scale > 0 ? scale : null;

  const base = media.template
    ? foundry.utils.duplicate(media.template)
    : {
        type: "character",
        img: DEFAULT_PC_ART,
        system: {},
        items: [],
        effects: [],
        prototypeToken: {
          width: 1,
          height: 1,
          texture: { src: DEFAULT_PC_ART, scaleX: 1, scaleY: 1 }
        },
        flags: {}
      };

  delete base._id;
  delete base._stats;
  stripEmbeddedIds(base);

  base.name = name;
  base.type = "character";
  base.img = portrait || base.img || DEFAULT_PC_ART;
  base.folder = media.folderId ?? null;
  base.ownership = { default: 0 };
  base.items = Array.isArray(base.items) ? base.items : [];
  base.effects = Array.isArray(base.effects) ? base.effects : [];

  const prototypeToken = base.prototypeToken && typeof base.prototypeToken === "object"
    ? base.prototypeToken
    : {};
  delete prototypeToken._id;
  delete prototypeToken.actorId;
  prototypeToken.name = knownAs;
  prototypeToken.displayName = tokenDisplayHover();
  prototypeToken.actorLink = true;
  prototypeToken.disposition = TOKEN_DISPOSITION.FRIENDLY;
  prototypeToken.width = prototypeToken.width ?? 1;
  prototypeToken.height = prototypeToken.height ?? 1;
  const texture =
    prototypeToken.texture && typeof prototypeToken.texture === "object"
      ? prototypeToken.texture
      : {};
  texture.src = tokenSrc || texture.src || DEFAULT_PC_ART;
  if (tokenScale != null) {
    texture.scaleX = tokenScale;
    texture.scaleY = tokenScale;
  } else {
    texture.scaleX = texture.scaleX ?? 1;
    texture.scaleY = texture.scaleY ?? 1;
  }
  prototypeToken.texture = texture;
  base.prototypeToken = prototypeToken;

  const dndbeyond = {};
  if (ddbUrl) {
    dndbeyond.url = ddbUrl;
    dndbeyond.roUrl = ddbUrl.replace(/^https?:\/\/www\./i, "https://");
  }
  if (ddbId) {
    dndbeyond.characterId = String(ddbId);
  }

  const prevFlags = base.flags && typeof base.flags === "object" ? base.flags : {};
  const prevDdb =
    prevFlags.ddbimporter && typeof prevFlags.ddbimporter === "object"
      ? prevFlags.ddbimporter
      : {};
  base.flags = {
    ...prevFlags,
    ddbimporter: {
      ...prevDdb,
      dndbeyond,
      activeUpdate: false,
      compendium: false
    },
    "ddb-importer": prevFlags["ddb-importer"] ?? {},
    [FLAG_SCOPE]: {
      ...(prevFlags[FLAG_SCOPE] ?? {}),
      kind: "pc",
      dlceId: pc?.id ?? null,
      ddbId,
      ddbUrl,
      knownAs,
      playerName: pc?.playerName ?? null,
      importKey: media.importKey ?? null,
      source: "dlce-pc-stub"
    }
  };

  return base;
}

/**
 * Fill-only patch for an existing matched PC actor (art / DDB / Known as).
 * Always refreshes Friendly disposition + Hovered-by-Anyone nameplate.
 *
 * @param {Actor} actor
 * @param {object} pc
 * @param {{ portrait?: string|null, token?: string|null, tokenScale?: number|null }} media
 * @returns {object} Foundry update diff (may be empty aside from disposition/displayName)
 */
export function buildExistingPcFillPatch(actor, pc, media = {}) {
  const patch = {};
  const portrait = media.portrait || null;
  const token = media.token || null;
  const knownAs =
    String(pc?.knownAs || "").trim() ||
    String(pc?.name || actor?.name || "")
      .trim()
      .split(/\s+/)[0] ||
    actor?.name;

  if (portrait && isMissingPcArt(actor?.img)) {
    patch.img = portrait;
  }

  const currentTokenSrc = actor?.prototypeToken?.texture?.src;
  if (token && isMissingPcArt(currentTokenSrc)) {
    patch["prototypeToken.texture.src"] = token;
    if (pc?.tokenScale != null && Number(pc.tokenScale) > 0) {
      patch["prototypeToken.texture.scaleX"] = Number(pc.tokenScale);
      patch["prototypeToken.texture.scaleY"] = Number(pc.tokenScale);
    }
  }

  const tokenName = String(actor?.prototypeToken?.name ?? "").trim();
  if (knownAs && !tokenName) {
    patch["prototypeToken.name"] = knownAs;
  }

  if (!actorHasDdbLink(actor)) {
    const ddbUrl = String(pc?.ddbUrl || "").trim() || null;
    const ddbId =
      (pc?.ddbId != null && String(pc.ddbId).trim()) ||
      parseDdbCharacterId(ddbUrl) ||
      null;
    if (ddbUrl || ddbId) {
      const dndbeyond = {};
      if (ddbUrl) {
        dndbeyond.url = ddbUrl;
        dndbeyond.roUrl = ddbUrl.replace(/^https?:\/\/www\./i, "https://");
      }
      if (ddbId) {
        dndbeyond.characterId = String(ddbId);
      }
      patch["flags.ddbimporter.dndbeyond"] = dndbeyond;
      if (ddbId) {
        patch[`flags.${FLAG_SCOPE}.ddbId`] = ddbId;
      }
      if (ddbUrl) {
        patch[`flags.${FLAG_SCOPE}.ddbUrl`] = ddbUrl;
      }
    }
  }

  // Behavioural defaults (not package content overwrite).
  patch["prototypeToken.disposition"] = TOKEN_DISPOSITION.FRIENDLY;
  patch["prototypeToken.displayName"] = tokenDisplayHover();

  return patch;
}

/**
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function parseDdbCharacterId(url) {
  const match = String(url || "").match(/dndbeyond\.com\/characters\/(\d+)/i);
  return match?.[1] ?? null;
}

/**
 * Modal when the Session Package has no seated PCs (`manifest.pcs` empty).
 * Damned Lucky folder may still be created, but no character Actors / Landing
 * party tokens can be placed without package entries.
 *
 * @param {{
 *   sessionName?: string|null,
 *   displayCode?: string|null,
 *   partyLevel?: number|null,
 *   exportedAt?: string|null
 * }} [info]
 */
export async function alertEmptyPcs(info = {}) {
  const label =
    [info.displayCode, info.sessionName].filter(Boolean).join(" · ") || "this session";
  console.warn(`${MODULE_ID} | manifest.pcs is empty — no PC Actors will be created`, {
    ...info,
    hint: "In DLCE, seat named PCs on the active Game (or apply a named Party), export again, then import the new zip."
  });

  const partyLevel =
    info.partyLevel != null && Number.isFinite(Number(info.partyLevel))
      ? ` Package partyLevel=${Number(info.partyLevel)} (generic party TPL does not create PC Actors).`
      : "";
  const exported = info.exportedAt
    ? ` Package exportedAt=<code>${escapeHtmlLite(info.exportedAt)}</code>.`
    : "";

  const content =
    `<p><strong>${escapeHtmlLite(label)}</strong> has <strong>0 seated PCs</strong> in the Session Package.</p>` +
    `<p>DLFI created the <strong>Damned Lucky</strong> Actor folder, but left it empty. ` +
    `Landing / battlemap party tokens were also skipped.</p>` +
    `<p>In <strong>DLCE</strong>: open the active Game → seat named Player Characters ` +
    `(or apply a named Party) → click <strong>Foundry</strong> again → import the <em>new</em> zip in DLFI.` +
    `${partyLevel}${exported}</p>`;

  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (DialogV2?.prompt) {
    await DialogV2.prompt({
      window: { title: "No seated PCs in package" },
      content,
      ok: { label: "OK" }
    });
    return;
  }
  if (typeof globalThis.Dialog?.prompt === "function") {
    await globalThis.Dialog.prompt({
      title: "No seated PCs in package",
      content,
      label: "OK",
      callback: () => undefined
    });
    return;
  }
  console.warn(`${MODULE_ID} | ${content.replace(/<[^>]+>/g, " ")}`);
}

/**
 * Modal summarizing PC stub creation when any stub lacks a D&D Beyond URL.
 *
 * @param {{
 *   created?: Array<{ name: string, knownAs?: string|null, ddbUrl?: string|null, id?: string|null }>,
 *   missingDdb?: Array<{ name: string, knownAs?: string|null, id?: string|null }>
 * }} summary
 */
export async function alertPcStubResults(summary = {}) {
  const missing = summary.missingDdb ?? [];
  if (!missing.length) {
    return;
  }
  const created = summary.created ?? [];
  console.warn(`${MODULE_ID} | PC stubs missing D&D Beyond URL`, {
    missingDdb: missing,
    created
  });

  const missingList = missing
    .map((row) => {
      const label = escapeHtmlLite(row.knownAs || row.name || "Unnamed PC");
      const full = row.name && row.knownAs && row.name !== row.knownAs
        ? ` <span>(${escapeHtmlLite(row.name)})</span>`
        : "";
      const id = row.id ? ` <code>${escapeHtmlLite(row.id)}</code>` : "";
      return `<li><strong>${label}</strong>${full}${id}</li>`;
    })
    .join("");

  const createdNote = created.length
    ? `<p>Created <strong>${created.length}</strong> PC stub` +
      `${created.length === 1 ? "" : "s"} this import.` +
      ` Add a D&amp;D Beyond URL on these characters in DLCE (or on the actor flags) before running DDB Importer:</p>`
    : `<p>These seated PCs have no D&amp;D Beyond URL in the Session Package:</p>`;

  const content =
    createdNote +
    `<ul>${missingList}</ul>` +
    `<p>Stubs were still created so Landing / battlemap tokens can place. ` +
    `Set <code>flags.ddbimporter.dndbeyond.url</code> (and characterId) then re-run DDB Importer.</p>`;

  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (DialogV2?.prompt) {
    await DialogV2.prompt({
      window: { title: "PC stubs missing D&D Beyond URL" },
      content,
      ok: { label: "OK" }
    });
    return;
  }
  if (typeof globalThis.Dialog?.prompt === "function") {
    await globalThis.Dialog.prompt({
      title: "PC stubs missing D&D Beyond URL",
      content,
      label: "OK",
      callback: () => undefined
    });
    return;
  }
  console.warn(`${MODULE_ID} | ${content.replace(/<[^>]+>/g, " ")}`);
}

/**
 * @param {object} data
 */
function stripEmbeddedIds(data) {
  if (!data || typeof data !== "object") {
    return;
  }
  for (const collection of ["items", "effects"]) {
    for (const emb of data[collection] ?? []) {
      if (emb && typeof emb === "object") {
        delete emb._id;
      }
    }
  }
}

function escapeHtmlLite(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
