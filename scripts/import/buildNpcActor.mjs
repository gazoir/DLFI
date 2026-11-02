/**
 * Build a dnd5e NPC Actor create payload from a DLCE document JSON.
 *
 * DLCE field contract (from live exports):
 * - Abilities: check_str / check_dex / check_con / check_int / check_wis / check_cha
 * - Size/type: creature_size / creature_type / combat_creature_type
 * - Speed/senses: free-text combat_speed / combat_senses
 * - Attacks: combat_attacks JSON string + combat_actions markdown
 */

import { FLAG_SCOPE } from "../constants.mjs";
import {
  abilityModifier,
  buildAttackConfig,
  parseExtraDamagePart,
  parseWeaponBaseDamage
} from "./damageFormula.mjs";
import { markdownToHtml } from "./markdown.mjs";

const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];

const ABILITY_ALIASES = {
  str: ["check_str", "combat_str", "str", "strength"],
  dex: ["check_dex", "combat_dex", "dex", "dexterity"],
  con: ["check_con", "combat_con", "con", "constitution"],
  int: ["check_int", "combat_int", "int", "intelligence"],
  wis: ["check_wis", "combat_wis", "wis", "wisdom"],
  cha: ["check_cha", "combat_cha", "cha", "charisma"]
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

const SKILL_MAP = {
  acrobatics: "acr",
  "animal handling": "ani",
  animalhandling: "ani",
  arcana: "arc",
  athletics: "ath",
  deception: "dec",
  history: "his",
  insight: "ins",
  intimidation: "itm",
  investigation: "inv",
  medicine: "med",
  nature: "nat",
  perception: "prc",
  performance: "prf",
  persuasion: "per",
  religion: "rel",
  "sleight of hand": "slt",
  sleightofhand: "slt",
  stealth: "ste",
  survival: "sur"
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

  const items = embedded?.items
    ? foundry.utils.duplicate(embedded.items)
    : buildItemsFromFields(fields);

  const name = String(embedded?.name || entry?.name || fields.name || "Unnamed").trim();
  const img = media.portrait || embedded?.img || undefined;
  const tokenSrc = media.token || embedded?.prototypeToken?.texture?.src || img;
  const size = system?.traits?.size;
  const tokenSize = sizeToTokenScale(size);

  const prototypeToken = foundry.utils.mergeObject(
    embedded?.prototypeToken ? foundry.utils.duplicate(embedded.prototypeToken) : {},
    {
      name,
      actorLink: true,
      width: tokenSize,
      height: tokenSize,
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
    items,
    effects: Array.isArray(embedded?.effects) ? foundry.utils.duplicate(embedded.effects) : [],
    prototypeToken,
    flags: {
      ...(embedded?.flags ? foundry.utils.duplicate(embedded.flags) : {}),
      [FLAG_SCOPE]: {
        dlceId: entry?.id,
        subtype: entry?.subtype ?? fields.subtype ?? "person",
        locationIds: entry?.locationIds ?? [],
        importKey: media.importKey,
        source: embedded ? "embedded-foundry" : "dlce-fields",
        officialKey: fields.combat_official_key ?? null
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
    fields?.foundry
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if (candidate.system && (candidate.type === "npc" || candidate.type === "character")) {
      return candidate;
    }
    if (
      !candidate.type &&
      candidate.system &&
      (candidate.system.abilities || candidate.system.attributes)
    ) {
      return { type: "npc", system: candidate.system, items: candidate.items, effects: candidate.effects };
    }
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
      movement: {
        walk: null,
        fly: null,
        swim: null,
        climb: null,
        burrow: null,
        units: "ft",
        hover: false
      },
      senses: {
        units: "ft",
        special: "",
        ranges: {
          darkvision: null,
          blindsight: null,
          tremorsense: null,
          truesight: null
        }
      }
    },
    details: {
      biography: {
        value: markdownToHtml(
          firstString(fields, ["description", "bio", "biography", "notes", "appearance"])
        )
      },
      type: { value: "", subtype: "", swarm: "", custom: "" },
      cr: null,
      source: { custom: String(fields.combat_official_key || "DLCE") }
    },
    traits: {
      size: "med",
      languages: { value: [], custom: "" }
    },
    skills: {}
  };

  for (const key of ABILITY_KEYS) {
    const score = firstNumber(fields, ABILITY_ALIASES[key]);
    if (score != null) {
      system.abilities[key] = { value: clampInt(score, 1, 30), proficient: 0 };
    }
  }

  const ac = firstNumber(fields, ["combat_ac", "ac", "armor_class", "armorClass"]);
  if (ac != null) {
    // Match SRD monsters: natural armor with flat value.
    system.attributes.ac = { calc: "natural", flat: ac };
  }

  const hp = firstNumber(fields, ["combat_hp", "hp", "hit_points", "hitPoints"]);
  const hpFormula = firstString(fields, ["combat_hit_dice", "combat_hp_formula", "hp_formula", "hit_dice"]);
  if (hp != null) {
    system.attributes.hp = {
      value: hp,
      max: hp,
      ...(hpFormula ? { formula: hpFormula } : {})
    };
  } else if (hpFormula) {
    system.attributes.hp = { formula: hpFormula };
  }

  Object.assign(system.attributes.movement, parseSpeedString(firstString(fields, ["combat_speed", "speed"])));
  Object.assign(system.attributes.senses, parseSensesString(firstString(fields, ["combat_senses", "senses"])));

  const cr = firstNumber(fields, ["combat_cr", "cr", "challenge", "challenge_rating"]);
  if (cr != null) {
    system.details.cr = cr;
  }

  const creatureType = firstString(fields, ["combat_creature_type", "creature_type", "creatureType"]);
  if (creatureType) {
    const normalized = creatureType.toLowerCase().trim();
    const known = CONFIG?.DND5E?.creatureTypes ? Object.keys(CONFIG.DND5E.creatureTypes) : [
      "aberration", "beast", "celestial", "construct", "dragon", "elemental", "fey", "fiend",
      "giant", "humanoid", "monstrosity", "ooze", "plant", "undead"
    ];
    if (known.includes(normalized)) {
      system.details.type.value = normalized;
    } else {
      system.details.type.custom = creatureType;
    }
  }

  const species = firstString(fields, ["species", "combat_subtype", "creature_subtype"]);
  if (species) {
    system.details.type.subtype = species;
  }

  const alignment = firstString(fields, ["combat_alignment", "alignment"]);
  if (alignment) {
    system.details.alignment = alignment;
  }

  const sizeRaw = firstString(fields, ["creature_size", "combat_size", "size"]);
  if (sizeRaw) {
    const mapped = SIZE_MAP[sizeRaw.toLowerCase().trim()];
    if (mapped) {
      system.traits.size = mapped;
    }
  }

  const languages = fields.check_languages ?? fields.combat_languages ?? fields.languages;
  if (Array.isArray(languages)) {
    system.traits.languages.custom = languages.filter(Boolean).join(", ");
  } else if (languages) {
    system.traits.languages.custom = String(languages);
  }

  applySaveProficiencies(system, fields);
  applySkillProficiencies(system, fields);

  return system;
}

export function buildItemsFromFields(fields) {
  const items = [];
  const attackNames = new Set();
  let attacks = parseJsonField(fields.combat_attacks);
  if (!Array.isArray(attacks) || !attacks.length) {
    attacks = synthesizeAttacksFromActions(firstString(fields, ["combat_actions", "actions"]));
  }

  if (Array.isArray(attacks)) {
    for (const attack of attacks) {
      const item = buildWeaponFromAttack(attack, fields);
      if (item) {
        items.push(item);
        attackNames.add(String(attack.name || "").toLowerCase());
      }
    }
  }

  for (const block of parseActionBlocks(firstString(fields, ["combat_actions", "actions"]))) {
    const key = block.name.toLowerCase().replace(/\s*\([^)]*\)\s*/g, " ").trim();
    const matchedAttack = [...attackNames].some(
      (name) => key === name || key.startsWith(`${name} `) || key.startsWith(name)
    );
    if (matchedAttack) {
      continue;
    }
    items.push(buildFeatFromAction(block));
  }

  for (const block of parseActionBlocks(firstString(fields, ["combat_reactions", "reactions"]))) {
    const feat = buildFeatFromAction(block);
    feat.system.activities = {
      [randomId()]: {
        type: "utility",
        name: "Use",
        activation: { type: "reaction", value: null, override: false },
        consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] },
        duration: { units: "inst", concentration: false, override: false },
        range: { override: false, units: "self" },
        target: { template: { contiguous: false, units: "ft" }, affects: { choice: false }, override: false, prompt: true },
        uses: { spent: 0, recovery: [] },
        roll: { prompt: false, visible: false }
      }
    };
    items.push(feat);
  }

  return items;
}

function buildWeaponFromAttack(attack, fields) {
  const name = String(attack?.name || "").trim();
  if (!name) {
    return null;
  }
  const damages = Array.isArray(attack.damage) ? attack.damage : [];
  const primary = damages[0] ?? { dice: "1d4", type: "bludgeoning" };
  const strMod = abilityModifier(firstNumber(fields, ["check_str", "combat_str", "str"]));
  const dexMod = abilityModifier(firstNumber(fields, ["check_dex", "combat_dex", "dex"]));
  const attackType = inferAttackType(name, fields.combat_actions);
  const abilityMod = attackType === "ranged" ? dexMod : strMod;
  const baseDamage = parseWeaponBaseDamage(primary.dice, { abilityMod });
  const damageType = String(primary.type || "bludgeoning").toLowerCase();
  const reach = inferReachFeet(name, fields.combat_actions);
  const activityId = randomId();
  const extraParts = damages.slice(1).map((part) => parseExtraDamagePart(part.dice, part.type));

  const statedBonus = String(attack.bonus || fields.combat_attack_bonus || "").trim();
  const prof = firstNumber(fields, ["check_prof", "combat_prof", "proficiency", "proficiency_bonus"]);
  const attackConfig = buildAttackConfig({
    attackBonus: statedBonus,
    abilityMod,
    proficiencyBonus: prof,
    attackType
  });

  const descParts = [
    statedBonus ? `${statedBonus} to hit` : null,
    reach ? `reach ${reach} ft.` : null,
    `Hit: ${damages.map((d) => `${d.dice} ${d.type}`).join(" plus ")} damage.`
  ].filter(Boolean);

  return {
    name,
    type: "weapon",
    img: guessAttackIcon(name),
    system: {
      description: {
        value: `<p>${escapeHtml(descParts.join(", "))}</p>`,
        chat: ""
      },
      type: { value: "natural", baseItem: "" },
      equipped: true,
      identified: true,
      quantity: 1,
      rarity: "",
      properties: [],
      range: {
        units: "ft",
        value: null,
        long: null,
        reach: reach ?? null
      },
      damage: {
        base: {
          number: baseDamage.number,
          denomination: baseDamage.denomination,
          bonus: baseDamage.bonus,
          types: damageType ? [damageType] : [],
          custom: baseDamage.custom,
          scaling: { number: 1 }
        }
      },
      activities: {
        [activityId]: {
          type: "attack",
          _id: activityId,
          activation: { type: "action", value: null, override: false },
          consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] },
          duration: { units: "inst", concentration: false, override: false },
          range: { override: false, units: "self" },
          target: {
            template: { contiguous: false, units: "ft", stationary: false },
            affects: { choice: false },
            override: false,
            prompt: true
          },
          uses: { spent: 0, recovery: [] },
          attack: {
            critical: { threshold: null },
            ...attackConfig
          },
          damage: {
            critical: {},
            includeBase: true,
            parts: extraParts
          }
        }
      }
    }
  };
}

function inferAttackType(attackName, actionsMarkdown) {
  const text = `${attackName}
${actionsMarkdown || ""}`.toLowerCase();
  if (/ranged|ranged weapon attack|shot|bolt|spit/.test(text)) {
    return "ranged";
  }
  return "melee";
}

function buildFeatFromAction(block) {
  return {
    name: block.name,
    type: "feat",
    system: {
      description: { value: markdownToHtml(block.body), chat: "" },
      type: { value: "monster", subtype: "" },
      activities: {
        [randomId()]: {
          type: "utility",
          name: "Use",
          activation: { type: "action", value: null, override: false },
          consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] },
          duration: { units: "inst", concentration: false, override: false },
          range: { override: false, units: "self" },
          target: {
            template: { contiguous: false, units: "ft", stationary: false },
            affects: { choice: false },
            override: false,
            prompt: true
          },
          uses: { spent: 0, recovery: [] },
          roll: { prompt: false, visible: false }
        }
      }
    }
  };
}

export function parseSpeedString(text) {
  const result = {
    walk: null,
    fly: null,
    swim: null,
    climb: null,
    burrow: null,
    units: "ft",
    hover: /hover/i.test(text || "")
  };
  if (!text) {
    return result;
  }
  const source = String(text);
  const labeled = [
    ["fly", /fly\s*(\d+)/i],
    ["swim", /swim\s*(\d+)/i],
    ["climb", /climb\s*(\d+)/i],
    ["burrow", /burrow\s*(\d+)/i],
    ["walk", /walk\s*(\d+)/i]
  ];
  for (const [key, re] of labeled) {
    const match = source.match(re);
    if (match) {
      result[key] = Number(match[1]);
    }
  }
  if (result.walk == null) {
    const bare = source.match(/(?:^|,)\s*(\d+)\s*ft/i);
    if (bare) {
      result.walk = Number(bare[1]);
    }
  }
  return result;
}

export function parseSensesString(text) {
  const senses = {
    units: "ft",
    special: "",
    ranges: {
      darkvision: null,
      blindsight: null,
      tremorsense: null,
      truesight: null
    }
  };
  if (!text) {
    return senses;
  }

  let remainder = String(text);
  const patterns = [
    ["darkvision", /darkvision\s*(\d+)\s*ft\.?/i],
    ["blindsight", /blindsight\s*(\d+)\s*ft\.?/i],
    ["tremorsense", /tremorsense\s*(\d+)\s*ft\.?/i],
    ["truesight", /truesight\s*(\d+)\s*ft\.?/i]
  ];
  for (const [key, re] of patterns) {
    const match = remainder.match(re);
    if (match) {
      senses.ranges[key] = Number(match[1]);
      remainder = remainder.replace(re, "");
    }
  }

  remainder = remainder
    .replace(/,??\s*passive perception\s*\d+/ig, "")
    .replace(/^[\s,;]+|[\s,;]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  senses.special = remainder;
  return senses;
}


function synthesizeAttacksFromActions(markdown) {
  const attacks = [];
  for (const block of parseActionBlocks(markdown)) {
    const body = block.body || "";
    // "+4 to hit" / "+7," patterns imply a weapon attack
    const bonusMatch = body.match(/([+-]\d+)(?:\s*to hit|,)/i);
    const hitMatch = body.match(/Hit:\s*[^.]*?(\d+)?\s*\(?([0-9dD+\-\s]+)\)?\s*([A-Za-z]+)(?:\s*damage)?/i);
    const diceMatch = body.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)/i);
    if (!bonusMatch && !/weapon attack|to hit/i.test(body)) {
      continue;
    }
    const dice = (hitMatch && hitMatch[2]) ? hitMatch[2].replace(/\s+/g, " ").trim() : (diceMatch ? diceMatch[1] : null);
    if (!dice) {
      continue;
    }
    const type = (hitMatch && hitMatch[3]) ? hitMatch[3] : "bludgeoning";
    attacks.push({
      name: block.name.replace(/\s*\([^)]*\)\s*$/, "").trim(),
      bonus: bonusMatch ? bonusMatch[1] : "",
      damage: [{ dice, type }]
    });
  }
  return attacks;
}

export function parseActionBlocks(markdown) {
  const text = String(markdown ?? "").trim();
  if (!text) {
    return [];
  }
  const blocks = [];
  const re = /\*\*([^*]+)\*\*\s*\n?([\s\S]*?)(?=\n\*\*|$)/g;
  let match;
  while ((match = re.exec(text))) {
    blocks.push({
      name: match[1].trim(),
      body: match[2].trim()
    });
  }
  if (!blocks.length && text) {
    blocks.push({ name: "Actions", body: text });
  }
  return blocks;
}

function applySaveProficiencies(system, fields) {
  const saves = firstString(fields, ["combat_saving_throws", "saving_throws", "saves"]);
  if (!saves) {
    return;
  }
  for (const key of ABILITY_KEYS) {
    const re = new RegExp(String.raw`\b${key}\b|\b${ABILITY_ALIASES[key][3] || key}\b`, "i");
    if (re.test(saves)) {
      system.abilities[key] ??= { value: 10, proficient: 0 };
      // DLCE lists modifiers for all creatures; only mark proficient when explicit "proficient" appears.
      if (/proficient/i.test(saves)) {
        system.abilities[key].proficient = 1;
      }
    }
  }
}

function applySkillProficiencies(system, fields) {
  const skills = fields.check_skills ?? fields.combat_skills ?? fields.skills;
  if (!skills) {
    return;
  }
  const list = Array.isArray(skills)
    ? skills
    : String(skills)
        .split(/,|;/)
        .map((part) => part.trim())
        .filter(Boolean);
  for (const entry of list) {
    const abbr = SKILL_MAP[String(entry).toLowerCase().trim()];
    if (!abbr) {
      continue;
    }
    system.skills[abbr] = {
      value: 1,
      ability: abbr === "prc" ? "wis" : undefined,
      bonuses: { check: "", passive: "" }
    };
  }
}



function inferReachFeet(attackName, actionsMarkdown) {
  const text = String(actionsMarkdown ?? "");
  const re = new RegExp(
    String.raw`\*\*${escapeRegExp(attackName)}[\s\S]*?reach\s*(\d+)\s*ft`,
    "i"
  );
  const match = text.match(re);
  return match ? Number(match[1]) : null;
}

function guessAttackIcon(name) {
  const lower = name.toLowerCase();
  if (/bite|fang|tooth/.test(lower)) return "icons/creatures/abilities/fangs-teeth-bite.webp";
  if (/sting|tail/.test(lower)) return "icons/creatures/abilities/stinger-poison-green.webp";
  if (/claw/.test(lower)) return "icons/creatures/abilities/bear-claws-yellow.webp";
  return "icons/skills/melee/strike-sword-steel-yellow.webp";
}

function sizeToTokenScale(size) {
  switch (size) {
    case "tiny":
      return 0.5;
    case "sm":
    case "med":
      return 1;
    case "lg":
      return 2;
    case "huge":
      return 3;
    case "grg":
      return 4;
    default:
      return 1;
  }
}

function parseJsonField(value) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(String(value));
  } catch (_error) {
    return null;
  }
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

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value))));
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

function randomId(size = 16) {
  if (globalThis.foundry?.utils?.randomID) {
    return foundry.utils.randomID(size);
  }
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < size; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
