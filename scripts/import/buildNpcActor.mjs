/**
 * Build a dnd5e NPC Actor create payload from a DLCE document JSON.
 *
 * Preference order:
 * 1. Embedded Foundry actor payload (raw.foundry / raw.actor / raw.system)
 * 2. Map DLCE combat_* (and common aliases) into dnd5e system fields
 *
 * Official foundryvtt-cli packs/unpacks Foundry documents; it does not convert
 * DLCE combat JSON. Mapping belongs here (or in DLCE export).
 */

import { FLAG_SCOPE, MODULE_ID } from "../constants.mjs";

const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];

const ABILITY_ALIASES = {
  str: ["str", "strength", "combat_str", "combat_strength", "ability_str"],
  dex: ["dex", "dexterity", "combat_dex", "combat_dexterity", "ability_dex"],
  con: ["con", "constitution", "combat_con", "combat_constitution", "ability_con"],
  int: ["int", "intelligence", "combat_int", "combat_intelligence", "ability_int"],
  wis: ["wis", "wisdom", "combat_wis", "combat_wisdom", "ability_wis"],
  cha: ["cha", "charisma", "combat_cha", "combat_charisma", "ability_cha"]
};

const SIZE_MAP = {
  tiny: "tiny",
  small: "sm",
  sm: "sm",
  medium: "med",
  med: "med",
  large: "lg",
  lg: "lg",
  huge: "huge",
  gargantuan: "grg",
  grg: "grg"
};

/**
 * @param {object} raw DLCE document JSON
 * @param {object} entry Manifest document entry
 * @param {{ portrait?: string|null, token?: string|null, folderId?: string|null, importKey?: string }} media
 */
export function buildNpcNpcActorData(raw, entry, media = {}) {
  const fields = asObject(raw?.fields) ?? asObject(raw) ?? {};
  const embedded = extractEmbeddedFoundryActor(raw, fields);
  const system = embedded?.system
    ? foundry.utils.duplicate(embedded.system)
    : buildSystemFromFields(fields);

  const name = String(embedded?.name || entry?.name || fields.name || "Unnamed").trim();
  const img = media.portrait || embedded?.img || undefined;
  const tokenSrc = media.token || embedded?.prototypeToken?.texture?.src || img;

  const prototypeToken = foundry.utils.mergeObject(
    embedded?.prototypeToken ? foundry.utils.duplicate(embedded.prototypeToken) : {},
    {
      name,
      actorLink: true,
      ...(tokenSrc ? { texture: { src: tokenSrc } } : {})
    },
    { inplace: false }
  );

  return {
    name,
    type: "npc",
    img,
    folder: media.folderId ?? null,
    system,
    items: Array.isArray(embedded?.items) ? foundry.utils.duplicate(embedded.items) : [],
    effects: Array.isArray(embedded?.effects) ? foundry.utils.duplicate(embedded.effects) : [],
    prototypeToken,
    flags: {
      ...(embedded?.flags ? foundry.utils.duplicate(embedded.flags) : {}),
      [FLAG_SCOPE]: {
        dlceId: entry?.id,
        subtype: entry?.subtype ?? fields.subtype ?? "person",
        locationIds: entry?.locationIds ?? [],
        importKey: media.importKey,
        source: embedded ? "embedded-foundry" : "dlce-fields"
      }
    }
  };
}

function extractEmbeddedFoundryActor(raw, fields) {
  const candidates = [
    raw?.foundryActor,
    raw?.foundry_actor,
    raw?.actor,
    raw?.foundry,
    fields?.foundryActor,
    fields?.foundry_actor,
    fields?.actor,
    fields?.foundry,
    raw
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    // Full actor document shape
    if (candidate.system && (candidate.type === "npc" || candidate.type === "character")) {
      return candidate;
    }
    // Bare system blob with abilities/attributes
    if (
      !candidate.type &&
      candidate.system &&
      (candidate.system.abilities || candidate.system.attributes)
    ) {
      return { type: "npc", system: candidate.system, items: candidate.items, effects: candidate.effects };
    }
    // system at top-level of candidate
    if (candidate.abilities || candidate.attributes?.hp || candidate.attributes?.ac) {
      return { type: "npc", system: candidate };
    }
  }
  return null;
}

function buildSystemFromFields(fields) {
  const system = {
    abilities: {},
    attributes: {
      ac: {},
      hp: {},
      movement: { walk: 0, fly: 0, swim: 0, climb: 0, burrow: 0, units: "ft", hover: false },
      senses: { darkvision: 0, blindsight: 0, tremorsense: 0, truesight: 0, units: "ft", special: "" }
    },
    details: {
      biography: { value: htmlFromText(firstString(fields, ["description", "bio", "biography", "notes"])) },
      type: { value: "", subtype: "", swarm: "", custom: "" },
      cr: null,
      source: { custom: "DLCE" }
    },
    traits: {
      size: "med",
      languages: { value: [], custom: "" }
    }
  };

  for (const key of ABILITY_KEYS) {
    const score = firstNumber(fields, ABILITY_ALIASES[key]);
    if (score != null) {
      system.abilities[key] = { value: clampInt(score, 1, 30) };
    }
  }

  const ac = firstNumber(fields, ["combat_ac", "ac", "armor_class", "armorClass", "armor"]);
  if (ac != null) {
    // dnd5e still accepts calc/flat and migrates to override; set both for safety.
    system.attributes.ac = { calc: "flat", flat: ac, override: ac };
  }

  const hp = firstNumber(fields, ["combat_hp", "hp", "hit_points", "hitPoints", "hp_max", "max_hp"]);
  const hpFormula = firstString(fields, ["combat_hp_formula", "hp_formula", "hit_dice", "hitDice", "formula"]);
  if (hp != null) {
    system.attributes.hp = {
      value: hp,
      max: hp,
      ...(hpFormula ? { formula: hpFormula } : {})
    };
  } else if (hpFormula) {
    system.attributes.hp = { formula: hpFormula };
  }

  const walk = firstNumber(fields, ["combat_speed", "speed", "walk", "combat_walk"]);
  if (walk != null) system.attributes.movement.walk = walk;
  const fly = firstNumber(fields, ["combat_fly", "fly", "speed_fly"]);
  if (fly != null) system.attributes.movement.fly = fly;
  const swim = firstNumber(fields, ["combat_swim", "swim", "speed_swim"]);
  if (swim != null) system.attributes.movement.swim = swim;
  const climb = firstNumber(fields, ["combat_climb", "climb", "speed_climb"]);
  if (climb != null) system.attributes.movement.climb = climb;
  const burrow = firstNumber(fields, ["combat_burrow", "burrow", "speed_burrow"]);
  if (burrow != null) system.attributes.movement.burrow = burrow;

  const darkvision = firstNumber(fields, ["combat_darkvision", "darkvision"]);
  if (darkvision != null) system.attributes.senses.darkvision = darkvision;
  const blindsight = firstNumber(fields, ["combat_blindsight", "blindsight"]);
  if (blindsight != null) system.attributes.senses.blindsight = blindsight;
  const tremorsense = firstNumber(fields, ["combat_tremorsense", "tremorsense"]);
  if (tremorsense != null) system.attributes.senses.tremorsense = tremorsense;
  const truesight = firstNumber(fields, ["combat_truesight", "truesight"]);
  if (truesight != null) system.attributes.senses.truesight = truesight;
  const specialSenses = firstString(fields, ["combat_senses", "senses"]);
  if (specialSenses && !/darkvision|blindsight|tremorsense|truesight/i.test(specialSenses)) {
    system.attributes.senses.special = specialSenses;
  } else if (specialSenses) {
    parseSensesString(specialSenses, system.attributes.senses);
  }

  const cr = firstNumber(fields, ["combat_cr", "cr", "challenge", "challenge_rating", "challengeRating"]);
  if (cr != null) {
    system.details.cr = cr;
  } else {
    const crLabel = firstString(fields, ["crLabel", "cr_label", "challenge_label"]);
    const parsed = parseCrLabel(crLabel);
    if (parsed != null) system.details.cr = parsed;
  }

  const creatureType = firstString(fields, ["combat_type", "creature_type", "creatureType"]);
  if (creatureType) {
    const normalized = creatureType.toLowerCase().trim();
    const known = CONFIG?.DND5E?.creatureTypes ? Object.keys(CONFIG.DND5E.creatureTypes) : [];
    if (known.includes(normalized)) {
      system.details.type.value = normalized;
    } else {
      system.details.type.custom = creatureType;
    }
  }
  const subtype = firstString(fields, ["combat_subtype", "creature_subtype", "subtype"]);
  if (subtype) system.details.type.subtype = subtype;

  const alignment = firstString(fields, ["combat_alignment", "alignment"]);
  if (alignment) system.details.alignment = alignment;

  const sizeRaw = firstString(fields, ["combat_size", "size"]);
  if (sizeRaw) {
    const mapped = SIZE_MAP[sizeRaw.toLowerCase().trim()];
    if (mapped) system.traits.size = mapped;
  }

  const languages = firstString(fields, ["combat_languages", "languages"]);
  if (languages) {
    system.traits.languages.custom = languages;
  }

  applySaveProficiencies(system, fields);
  applySkillProficiencies(system, fields);

  return system;
}

function applySaveProficiencies(system, fields) {
  const saves = firstValue(fields, ["combat_saves", "saving_throws", "savingThrows", "saves"]);
  if (!saves) {
    return;
  }
  const text = typeof saves === "string" ? saves : Array.isArray(saves) ? saves.join(",") : "";
  for (const key of ABILITY_KEYS) {
    const re = new RegExp(String.raw`\b${key}\b|\b${ABILITY_ALIASES[key][1]}\b`, "i");
    if (re.test(text)) {
      system.abilities[key] ??= { value: 10 };
      system.abilities[key].proficient = 1;
    }
  }
}

function applySkillProficiencies(system, fields) {
  const skills = firstValue(fields, ["combat_skills", "skills"]);
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) {
    // string form left for a later slice; scores matter more now
    return;
  }
  system.skills ??= {};
  for (const [key, value] of Object.entries(skills)) {
    const abbr = String(key).toLowerCase().slice(0, 3);
    const num = Number(value);
    if (!Number.isFinite(num)) {
      continue;
    }
    system.skills[abbr] = { value: num >= 2 ? 2 : num >= 1 ? 1 : 0 };
  }
}

function parseSensesString(text, senses) {
  const patterns = [
    ["darkvision", /darkvision\s*(\d+)/i],
    ["blindsight", /blindsight\s*(\d+)/i],
    ["tremorsense", /tremorsense\s*(\d+)/i],
    ["truesight", /truesight\s*(\d+)/i]
  ];
  for (const [key, re] of patterns) {
    const match = text.match(re);
    if (match) {
      senses[key] = Number(match[1]);
    }
  }
  senses.special = text;
}

function parseCrLabel(label) {
  if (!label) {
    return null;
  }
  const text = String(label).trim();
  if (/^1\/4$|^0\.25$/i.test(text)) return 0.25;
  if (/^1\/2$|^0\.5$/i.test(text)) return 0.5;
  if (/^1\/8$|^0\.125$/i.test(text)) return 0.125;
  const num = Number(text.replace(/^cr\s*/i, ""));
  return Number.isFinite(num) ? num : null;
}

function firstNumber(obj, keys) {
  for (const key of keys) {
    if (!(key in obj) || obj[key] == null || obj[key] === "") {
      continue;
    }
    const num = Number(String(obj[key]).replace(/,/g, "").match(/-?\d+(\.\d+)?/)?.[0]);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return null;
}

function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value == null) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function firstValue(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] != null && obj[key] !== "") {
      return obj[key];
    }
  }
  return null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value))));
}

function htmlFromText(text) {
  if (!text) {
    return "";
  }
  if (/[<][a-z!\/]/i.test(text)) {
    return text;
  }
  return `<p>${escapeHtml(text).replace(/\n+/g, "</p><p>")}</p>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Silence unused import in some bundlers
void MODULE_ID;
