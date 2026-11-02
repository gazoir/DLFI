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
  parseWeaponBaseDamage,
  predictFoundryBaseDamage
} from "./damageFormula.mjs";
import { markdownToHtml } from "./markdown.mjs";
import { MODULE_ID } from "../constants.mjs";

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

  const subtype = resolveCreatureSubtype(fields, system.details.type.value);
  if (subtype) {
    system.details.type.subtype = subtype;
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
    const feat = buildFeatFromAction({
      name: block.name,
      body: block.body || "Reaction."
    });
    // Force reaction activation even when the body text omits the word.
    for (const activity of Object.values(feat.system.activities ?? {})) {
      activity.activation = { type: "reaction", value: null, override: false };
    }
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
  const reach = inferReachFeet(name, fields.combat_actions) ?? attack.reach ?? null;
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

  const prediction = predictFoundryBaseDamage(baseDamage, {
    abilityMod,
    dlceFormula: primary.dice
  });
  if (!prediction.matchesDlce) {
    console.warn(
      `${MODULE_ID} | damage mismatch for ${name}: DLCE "${primary.dice}" → Foundry "${prediction.formula}" (expected numeric bonus ${prediction.dlceBonus}, got ${prediction.expectedNumeric})`
    );
  } else {
    console.log(
      `${MODULE_ID} | ${name} damage: DLCE "${primary.dice}" → stored ${baseDamage.number}d${baseDamage.denomination}${baseDamage.bonus ? `+${baseDamage.bonus}` : ""} (Foundry rolls ${prediction.formula})`
    );
  }

  const actionBody = findActionBody(name, fields.combat_actions);
  const descHtml = actionBody
    ? markdownToHtml(`**${name}**\n${actionBody}`)
    : `<p>${escapeHtml(
        [
          statedBonus ? `${statedBonus} to hit` : null,
          reach ? `reach ${reach} ft.` : null,
          `Hit: ${damages.map((d) => `${d.dice} ${d.type}`).join(" plus ")} damage.`
        ]
          .filter(Boolean)
          .join(", ")
      )}</p>`;

  return {
    name,
    type: "weapon",
    img: guessAttackIcon(name),
    system: {
      description: {
        value: descHtml,
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
    },
    flags: {
      [FLAG_SCOPE]: {
        kind: "weapon-attack",
        dlceDamage: primary.dice,
        foundryDamageFormula: prediction.formula,
        strippedAbilityMod: baseDamage.strippedAbilityMod
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
  const activityId = randomId();
  const save = parseSaveFromText(block.body);
  const recharge = parseRechargeFromNameOrBody(block.name, block.body);
  const activation = inferActivation(block.name, block.body);
  const activity = save
    ? {
        type: "save",
        _id: activityId,
        name: block.name.replace(/\s*\([^)]*\)\s*$/, "").trim() || "Save",
        activation,
        consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] },
        duration: parseDuration(block.body),
        range: { override: false, units: "self" },
        target: {
          template: { contiguous: false, units: "ft", stationary: false },
          affects: { choice: false },
          override: false,
          prompt: true
        },
        uses: recharge.uses,
        damage: { parts: [], onSave: /half/i.test(block.body) ? "half" : "none" },
        save: {
          ability: save.ability,
          dc: { calculation: "", formula: String(save.dc) }
        },
        effects: []
      }
    : {
        type: "utility",
        _id: activityId,
        name: "Use",
        activation,
        consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] },
        duration: parseDuration(block.body),
        range: { override: false, units: "self" },
        target: {
          template: { contiguous: false, units: "ft", stationary: false },
          affects: { choice: false },
          override: false,
          prompt: true
        },
        uses: recharge.uses,
        roll: { prompt: false, visible: false }
      };

  return {
    name: block.name,
    type: "feat",
    system: {
      description: { value: markdownToHtml(block.body), chat: "" },
      type: { value: "monster", subtype: "" },
      uses: recharge.itemUses,
      activities: {
        [activityId]: activity
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
    if (!bonusMatch && !/weapon attack|to hit|Hit:/i.test(body)) {
      continue;
    }
    // Skip pure spell/save features that happen to mention Hit elsewhere.
    if (/casts?\b|saving throw|save,? DC/i.test(body) && !/Hit:/i.test(body)) {
      continue;
    }

    const damageParts = parseHitDamageParts(body);
    if (!damageParts.length) {
      continue;
    }

    const reachMatch = body.match(/reach\s*(\d+)\s*ft/i);
    attacks.push({
      name: block.name.replace(/\s*\([^)]*\)\s*$/, "").trim(),
      bonus: bonusMatch ? bonusMatch[1] : "",
      reach: reachMatch ? Number(reachMatch[1]) : null,
      damage: damageParts
    });
  }
  return attacks;
}

/**
 * Parse "Hit: 11 (2d6 + 4) Piercing damage plus 24 (7d6) Poison damage" style text.
 */
export function parseHitDamageParts(body) {
  const text = String(body ?? "");
  const hitIndex = text.search(/Hit:/i);
  const region = hitIndex >= 0 ? text.slice(hitIndex, hitIndex + 240) : text;
  const parts = [];
  const re =
    /(?:^|[plus,]\s*|\()\s*(?:\d+\s*)?\(?(\d+d\d+(?:\s*[+-]\s*\d+)?)\)?\s*([A-Za-z]+)\s*damage/gi;
  let match;
  while ((match = re.exec(region))) {
    parts.push({
      dice: match[1].replace(/\s+/g, " ").trim(),
      type: match[2]
    });
  }
  if (parts.length) {
    return parts;
  }

  // Fallback: first dice expression + nearby damage type word.
  const diceMatch = region.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)/i);
  if (!diceMatch) {
    return [];
  }
  const typeMatch = region.match(/\b(acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder)\b/i);
  return [
    {
      dice: diceMatch[1].replace(/\s+/g, " ").trim(),
      type: typeMatch ? typeMatch[1] : "bludgeoning"
    }
  ];
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
  const body = findActionBody(attackName, actionsMarkdown);
  if (body) {
    const match = body.match(/reach\s*(\d+)\s*ft/i);
    if (match) {
      return Number(match[1]);
    }
  }
  const text = String(actionsMarkdown ?? "");
  const re = new RegExp(
    String.raw`\*\*${escapeRegExp(attackName)}[\s\S]*?reach\s*(\d+)\s*ft`,
    "i"
  );
  const match = text.match(re);
  return match ? Number(match[1]) : null;
}

/**
 * Prefer explicit combat_subtype / creature_subtype. Use `species` only for humanoids
 * (or non-monster editor subtypes) so monster templates don't inherit leftover ancestry
 * like Wyvern.species = "Githzerai".
 */
function resolveCreatureSubtype(fields, creatureTypeValue) {
  const explicit = firstString(fields, ["combat_subtype", "creature_subtype"]);
  if (explicit) {
    return explicit;
  }
  const species = firstString(fields, ["species"]);
  if (!species) {
    return "";
  }
  const npcSubtype = String(fields._npc_subtype ?? fields.npc_subtype ?? "").toLowerCase();
  const creatureType = String(creatureTypeValue || fields.combat_creature_type || fields.creature_type || "")
    .toLowerCase()
    .trim();
  if (npcSubtype === "monster" || (creatureType && creatureType !== "humanoid")) {
    return "";
  }
  return species;
}

function findActionBody(attackName, actionsMarkdown) {
  const needle = String(attackName || "")
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .trim();
  if (!needle) {
    return "";
  }
  for (const block of parseActionBlocks(actionsMarkdown)) {
    const key = block.name.toLowerCase().replace(/\s*\([^)]*\)\s*/g, " ").trim();
    if (key === needle || key.startsWith(`${needle} `) || key.startsWith(needle)) {
      return block.body;
    }
  }
  return "";
}

function parseSaveFromText(text) {
  const source = String(text ?? "");
  const match =
    source.match(
      /\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+save(?:,)?\s*DC\s*(\d+)/i
    ) ||
    source.match(/\b(Str|Dex|Con|Int|Wis|Cha)\s+save(?:,)?\s*DC\s*(\d+)/i) ||
    source.match(/DC\s*(\d+)\s*(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving throw/i);

  if (!match) {
    return null;
  }

  // Normalize capture groups across the three patterns.
  let abilityRaw;
  let dc;
  if (/^\d+$/.test(match[1])) {
    dc = Number(match[1]);
    abilityRaw = match[2];
  } else {
    abilityRaw = match[1];
    dc = Number(match[2]);
  }
  const map = {
    strength: "str",
    str: "str",
    dexterity: "dex",
    dex: "dex",
    constitution: "con",
    con: "con",
    intelligence: "int",
    int: "int",
    wisdom: "wis",
    wis: "wis",
    charisma: "cha",
    cha: "cha"
  };
  const ability = map[String(abilityRaw).toLowerCase()];
  if (!ability || !Number.isFinite(dc)) {
    return null;
  }
  return { ability, dc };
}

function parseRechargeFromNameOrBody(name, body) {
  const text = `${name}\n${body}`;
  const empty = {
    uses: { spent: 0, recovery: [] },
    itemUses: { spent: 0, max: "", recovery: [] }
  };

  const rechargeDice = text.match(/recharge\s*(\d+)(?:\s*[–-]\s*(\d+))?/i);
  if (rechargeDice && !/short or long rest|short rest|long rest/i.test(text)) {
    const formula = rechargeDice[2] ? String(rechargeDice[1]) : String(rechargeDice[1]);
    return {
      uses: {
        spent: 0,
        max: "1",
        recovery: [{ period: "recharge", type: "recoverAll", formula }]
      },
      itemUses: {
        spent: 0,
        max: "1",
        recovery: [{ period: "recharge", type: "recoverAll", formula }]
      }
    };
  }

  if (/recharges after a short or long rest|short or long rest/i.test(text)) {
    return {
      uses: {
        spent: 0,
        max: "1",
        recovery: [{ period: "sr", type: "recoverAll" }]
      },
      itemUses: {
        spent: 0,
        max: "1",
        recovery: [{ period: "sr", type: "recoverAll" }]
      }
    };
  }
  if (/recharges after a long rest|once per long rest/i.test(text)) {
    return {
      uses: {
        spent: 0,
        max: "1",
        recovery: [{ period: "lr", type: "recoverAll" }]
      },
      itemUses: {
        spent: 0,
        max: "1",
        recovery: [{ period: "lr", type: "recoverAll" }]
      }
    };
  }
  return empty;
}

function inferActivation(name, body) {
  const nameLower = String(name ?? "").toLowerCase();
  const bodyText = String(body ?? "").trim();
  const bodyLower = bodyText.toLowerCase();

  // Only treat as bonus/reaction when the feature itself says so — ignore
  // incidental phrases like "can revert … as a bonus action".
  if (/\(bonus action\)/.test(nameLower) || /^(?:as a )?bonus action\b/.test(bodyLower)) {
    return { type: "bonus", value: null, override: false };
  }
  if (/\(reaction\)/.test(nameLower) || /^(?:as a )?reaction\b/.test(bodyLower)) {
    return { type: "reaction", value: null, override: false };
  }
  if (/legendary action/.test(nameLower) || /legendary action/.test(bodyLower)) {
    return { type: "legendary", value: null, override: false };
  }
  // Passive traits like Hold Breath have no activation cost.
  if (
    /can hold|is immune|has advantage|passive|at will/i.test(bodyText) &&
    !/casts?\b|make[s]? .* attack|Hit:/i.test(bodyText)
  ) {
    return { type: "", value: null, override: false };
  }
  return { type: "action", value: null, override: false };
}

function parseDuration(body) {
  const match = String(body ?? "").match(/for\s+(\d+)\s+(minute|minutes|hour|hours|round|rounds)/i);
  if (!match) {
    return { units: "inst", concentration: false, override: false };
  }
  const n = Number(match[1]);
  const unitRaw = match[2].toLowerCase();
  const units = unitRaw.startsWith("minute")
    ? "minute"
    : unitRaw.startsWith("hour")
      ? "hour"
      : "round";
  return {
    value: n,
    units,
    concentration: /concentration/i.test(body),
    override: false
  };
}

/**
 * Collect location ids from the manifest entry and the document's links[] so NPCs
 * linked to multiple locations are placed on all of them (FOUNDRY_SYNC).
 */
export function collectNpcLocationIds(entry, raw) {
  const ids = new Set();
  for (const id of entry?.locationIds ?? []) {
    if (id) {
      ids.add(String(id));
    }
  }
  for (const link of raw?.links ?? []) {
    if (link?.target_type === "location" && link?.target_id) {
      ids.add(String(link.target_id));
    }
  }
  return [...ids];
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
