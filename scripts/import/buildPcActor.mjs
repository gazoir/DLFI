/**
 * Build a minimal dnd5e character Actor stub ready for D&D Beyond Importer sync.
 *
 * Flags mirror a real imported character (`flags.ddbimporter.dndbeyond.url` +
 * `characterId`) so the importer can attach without re-creating the actor.
 */

import { FLAG_SCOPE, TOKEN_DISPOSITION } from "../constants.mjs";

/**
 * @param {{
 *   name?: string,
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
 *   importKey?: string
 * }} [media]
 */
export function buildPcActorData(pc, media = {}) {
  const name = String(pc?.name || "").trim() || "Unnamed PC";
  const ddbUrl = String(pc?.ddbUrl || "").trim() || null;
  const ddbId =
    (pc?.ddbId != null && String(pc.ddbId).trim()) ||
    parseDdbCharacterId(ddbUrl) ||
    null;
  const portrait = media.portrait || undefined;
  const tokenSrc = media.token || portrait || undefined;
  const scale = Number(media.tokenScale);
  const tokenScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

  const dndbeyond = {};
  if (ddbUrl) {
    dndbeyond.url = ddbUrl;
    dndbeyond.roUrl = ddbUrl.replace(/^https?:\/\/www\./i, "https://");
  }
  if (ddbId) {
    dndbeyond.characterId = String(ddbId);
  }

  return {
    name,
    type: "character",
    img: portrait,
    folder: media.folderId ?? null,
    system: {},
    items: [],
    effects: [],
    prototypeToken: {
      name,
      actorLink: true,
      disposition: TOKEN_DISPOSITION.FRIENDLY,
      width: 1,
      height: 1,
      texture: {
        src: tokenSrc || "systems/dnd5e/icons/svg/actors/character.svg",
        scaleX: tokenScale,
        scaleY: tokenScale
      }
    },
    flags: {
      ddbimporter: {
        dndbeyond,
        activeUpdate: false,
        compendium: false
      },
      "ddb-importer": {},
      [FLAG_SCOPE]: {
        kind: "pc",
        dlceId: pc?.id ?? null,
        ddbId,
        ddbUrl,
        playerName: pc?.playerName ?? null,
        importKey: media.importKey ?? null,
        source: "dlce-pc-stub"
      }
    }
  };
}

/**
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function parseDdbCharacterId(url) {
  const match = String(url || "").match(/dndbeyond\.com\/characters\/(\d+)/i);
  return match?.[1] ?? null;
}
