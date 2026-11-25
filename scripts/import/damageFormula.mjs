/**
 * Helpers for translating DLCE damage formulas into dnd5e weapon damage.
 *
 * Investigation (dnd5e AttackActivityData._processDamagePart):
 * - For weapon items, non-deterministic base damage automatically appends `@mod`
 *   unless `@mod` is already present in the formula parts.
 * - Official SRD monsters store dice only (e.g. 2d8 with empty bonus); Foundry
 *   adds STR/DEX at roll time.
 * - If DLFI stores the already-included modifier (2d8 + 4) AND Foundry adds
 *   `@mod` (+4), damage becomes 2d8+8.
 *
 * Therefore: strip the expected attack ability modifier from base damage bonus
 * when it matches. Keep any leftover bonus (magic, etc.).
 */

/**
 * @param {string} formula e.g. "2d8 + 4"
 * @param {{ abilityMod?: number|null }} [options]
 */
export function parseWeaponBaseDamage(formula, { abilityMod = null } = {}) {
  const parsed = parseDiceFormula(formula);
  if (parsed.custom) {
    // Multi-dice ("2d6 + 1d4 + 3"): dnd5e still appends @mod, so take it out of the constant.
    const split = splitFormulaConstant(formula);
    if (split && abilityMod != null && Number.isFinite(abilityMod)) {
      const leftover = split.constant - Number(abilityMod);
      return {
        number: null,
        denomination: null,
        bonus: "",
        custom: { enabled: true, formula: joinFormula(split.dice, leftover) },
        strippedAbilityMod: Number(abilityMod),
        expectedTotalBonus: split.constant
      };
    }
    return {
      number: null,
      denomination: null,
      bonus: "",
      custom: { enabled: true, formula: String(formula ?? "") }
    };
  }

  let numericBonus = parsed.bonus === "" ? 0 : Number(parsed.bonus);
  if (!Number.isFinite(numericBonus)) {
    numericBonus = 0;
  }

  let leftover = numericBonus;
  if (abilityMod != null && Number.isFinite(abilityMod)) {
    leftover = numericBonus - Number(abilityMod);
  }

  return {
    number: parsed.number,
    denomination: parsed.denomination,
    bonus: leftover === 0 ? "" : String(leftover),
    custom: { enabled: false, formula: "" },
    strippedAbilityMod: abilityMod != null && leftover !== numericBonus ? Number(abilityMod) : null,
    expectedTotalBonus: numericBonus
  };
}

/**
 * Extra damage parts (poison, etc.) should NOT strip @mod — Foundry only auto-adds
 * @mod to the weapon *base* damage part.
 */
export function parseExtraDamagePart(formula, type) {
  const parsed = parseDiceFormula(formula);
  return {
    number: parsed.number,
    denomination: parsed.denomination,
    bonus: parsed.bonus,
    types: [normalizeDamageType(type)],
    custom: {
      enabled: Boolean(parsed.custom),
      formula: parsed.custom || ""
    },
    scaling: { number: 1 }
  };
}

export function abilityModifier(score) {
  if (score == null || score === "") {
    return null;
  }
  const n = Number(score);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.floor((n - 10) / 2);
}

export function parseDiceFormula(formula) {
  const cleaned = String(formula ?? "").replace(/\s+/g, "");
  const match = cleaned.match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!match) {
    return { number: null, denomination: null, bonus: "", custom: String(formula ?? "") };
  }
  return {
    number: Number(match[1]),
    denomination: Number(match[2]),
    bonus: match[3] ? String(Number(match[3])) : "",
    custom: ""
  };
}

/**
 * Split a sum of dice terms and integers into its dice part and summed constant.
 * Returns null for anything richer (roll data, functions, multiplication).
 * @param {string} formula
 * @returns {{ dice: string, constant: number }|null}
 */
export function splitFormulaConstant(formula) {
  const cleaned = String(formula ?? "").replace(/\s+/g, "");
  if (!cleaned || !/^[+-]?(\d+d\d+|\d+)([+-](\d+d\d+|\d+))*$/i.test(cleaned)) {
    return null;
  }
  const dice = [];
  let constant = 0;
  for (const [, sign, term] of cleaned.matchAll(/([+-]?)(\d+d\d+|\d+)/gi)) {
    if (/d/i.test(term)) {
      dice.push(`${sign === "-" ? "- " : dice.length ? "+ " : ""}${term}`);
    } else {
      constant += (sign === "-" ? -1 : 1) * Number(term);
    }
  }
  return { dice: dice.join(" "), constant };
}

function joinFormula(dice, constant) {
  if (!constant) {
    return dice;
  }
  const op = constant > 0 ? "+" : "-";
  return dice ? `${dice} ${op} ${Math.abs(constant)}` : String(constant);
}

export function normalizeDamageType(value) {
  const type = String(value ?? "").toLowerCase().trim();
  return type || "bludgeoning";
}

/**
 * 5e proficiency bonus from challenge rating.
 * @param {unknown} cr
 * @returns {number|null}
 */
export function proficiencyBonusFromCr(cr) {
  const n = Number(cr);
  if (!Number.isFinite(n)) {
    return null;
  }
  if (n <= 0) {
    return 2;
  }
  return Math.min(9, 2 + Math.floor((Math.max(n, 1) - 1) / 4));
}

/**
 * Pick STR vs DEX for a weapon attack so DLCE to-hit / damage mods line up.
 * Melee defaults to STR, but uses DEX when the stated bonus matches DEX+prof
 * (Imp Sting, finesse-like natural weapons, etc.).
 *
 * @returns {{ ability: "str"|"dex", mod: number|null }}
 */
export function resolveAttackAbility({
  attackType = "melee",
  strMod = null,
  dexMod = null,
  statedBonus = null,
  proficiencyBonus = null,
  damageBonus = null
} = {}) {
  const statedText = String(statedBonus ?? "").trim().replace(/^\+/, "");
  const stated = statedText === "" ? NaN : Number(statedText);
  const prof = Number(proficiencyBonus);
  const asMod = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const str = asMod(strMod);
  const dex = asMod(dexMod);

  if (attackType === "ranged") {
    return { ability: "dex", mod: dex };
  }

  const candidates = [];
  if (str != null) {
    candidates.push({ ability: "str", mod: str });
  }
  if (dex != null && dex !== str) {
    candidates.push({ ability: "dex", mod: dex });
  }

  if (Number.isFinite(stated) && Number.isFinite(prof) && candidates.length) {
    const exact = candidates.find((c) => c.mod + prof === stated);
    if (exact) {
      return exact;
    }
    // Closest to stated to-hit (keeps residual bonus small).
    let best = candidates[0];
    let bestDist = Infinity;
    for (const c of candidates) {
      const dist = Math.abs(c.mod + prof - stated);
      if (dist < bestDist) {
        best = c;
        bestDist = dist;
      }
    }
    return best;
  }

  if (damageBonus != null && Number.isFinite(Number(damageBonus)) && candidates.length) {
    const byDamage = candidates.find((c) => c.mod === Number(damageBonus));
    if (byDamage) {
      return byDamage;
    }
  }

  return { ability: "str", mod: str };
}

/**
 * Predict the Foundry to-hit total for an attack activity config.
 * flat:true → numeric bonus only; flat:false → ability + prof + bonus.
 */
export function predictFoundryAttackBonus(attackConfig, { abilityMod = null, proficiencyBonus = null } = {}) {
  const bonus = Number(String(attackConfig?.bonus ?? "").replace(/^\+/, ""));
  const extra = Number.isFinite(bonus) ? bonus : 0;
  if (attackConfig?.flat) {
    return extra;
  }
  const mod = Number(abilityMod);
  const prof = Number(proficiencyBonus);
  if (!Number.isFinite(mod) || !Number.isFinite(prof)) {
    return null;
  }
  return mod + prof + extra;
}

/**
 * Soft CR sanity band for monster attack bonuses (DMG-ish: PB + ability, with headroom).
 * Returns null when CR/prof unknown.
 *
 * @returns {{ min: number, max: number, typical: number, proficiency: number }|null}
 */
export function attackBonusBandForCr(cr, { maxAbilityMod = 5 } = {}) {
  const proficiency = proficiencyBonusFromCr(cr);
  if (proficiency == null) {
    return null;
  }
  const ability = Number.isFinite(Number(maxAbilityMod)) ? Number(maxAbilityMod) : 5;
  // Typical = PB + ability; allow +3 magic/special before warning.
  const typical = proficiency + Math.max(0, ability);
  return {
    proficiency,
    typical,
    min: proficiency,
    max: typical + 3
  };
}

/**
 * Decide attack activity configuration so to-hit matches the DLCE bonus when possible.
 * Prefer Foundry's normal mod+prof calculation (flat:false), matching SRD monsters.
 * Always pin `ability` to str/dex when known so Foundry doesn't pick the wrong mod.
 */
export function buildAttackConfig({
  attackBonus,
  abilityMod,
  proficiencyBonus,
  attackType = "melee",
  ability = ""
}) {
  const stated = Number(String(attackBonus ?? "").replace(/^\+/, ""));
  const mod = Number(abilityMod);
  const prof = Number(proficiencyBonus);
  const computed =
    Number.isFinite(mod) && Number.isFinite(prof) ? mod + prof : null;
  const abilityKey = ability === "str" || ability === "dex" ? ability : "";

  if (Number.isFinite(stated) && computed != null && stated === computed) {
    return {
      flat: false,
      ability: abilityKey,
      bonus: "",
      type: { value: attackType, classification: "weapon" }
    };
  }

  if (Number.isFinite(stated) && computed != null) {
    const delta = stated - computed;
    return {
      flat: false,
      ability: abilityKey,
      bonus: delta === 0 ? "" : String(delta),
      type: { value: attackType, classification: "weapon" }
    };
  }

  if (Number.isFinite(stated)) {
    return {
      flat: true,
      ability: "none",
      bonus: String(stated),
      type: { value: attackType, classification: "weapon" }
    };
  }

  return {
    flat: false,
    ability: abilityKey,
    bonus: "",
    type: { value: attackType, classification: "weapon" }
  };
}

/**
 * Predict the Foundry roll formula for a weapon base part after @mod is auto-appended.
 * dnd5e AttackActivityData._processDamagePart pushes `@mod` onto non-deterministic
 * weapon base damage unless `@mod` is already present.
 *
 * @returns {{ formula: string, matchesDlce: boolean, dlceBonus: number|null }}
 */
export function predictFoundryBaseDamage(baseDamage, { abilityMod = null, dlceFormula = "" } = {}) {
  if (baseDamage?.custom?.enabled) {
    const custom = String(baseDamage.custom.formula ?? "");
    const hasMod = abilityMod != null && Number.isFinite(abilityMod);
    const formula = hasMod && !/@mod/.test(custom) ? `${custom} + @mod` : custom;
    const ours = splitFormulaConstant(custom);
    const theirs = splitFormulaConstant(dlceFormula);
    const expectedNumeric = ours && hasMod ? ours.constant + Number(abilityMod) : null;
    const matchesDlce =
      Boolean(ours && theirs) &&
      ours.dice.replace(/\s+/g, "") === theirs.dice.replace(/\s+/g, "") &&
      (expectedNumeric == null || expectedNumeric === theirs.constant);
    return { formula, matchesDlce, dlceBonus: theirs?.constant ?? null, expectedNumeric, custom: true };
  }
  const dice =
    baseDamage?.number != null && baseDamage?.denomination != null
      ? `${baseDamage.number}d${baseDamage.denomination}`
      : "";
  const leftover = String(baseDamage?.bonus ?? "").trim();
  const parts = [];
  if (dice) {
    parts.push(dice);
  }
  if (leftover && leftover !== "0") {
    parts.push(leftover.startsWith("+") || leftover.startsWith("-") ? leftover : `+${leftover}`);
  }
  // Foundry appends @mod for weapon base when the formula is non-deterministic.
  const isDeterministic = !dice && leftover !== "";
  if (!isDeterministic && abilityMod != null && Number.isFinite(abilityMod)) {
    parts.push("@mod");
  }

  const formula = parts.join(" + ").replace(/\+ -/g, "- ").replace(/\s+/g, " ").trim();
  const dlce = parseDiceFormula(dlceFormula);
  const dlceBonus = dlce.custom ? null : dlce.bonus === "" ? 0 : Number(dlce.bonus);
  const expectedNumeric =
    abilityMod != null && Number.isFinite(abilityMod) && dlceBonus != null
      ? (leftover === "" || leftover === "0" ? 0 : Number(leftover)) + Number(abilityMod)
      : null;
  const matchesDlce =
    expectedNumeric == null || !Number.isFinite(dlceBonus) ? true : expectedNumeric === dlceBonus;

  return { formula, matchesDlce, dlceBonus, expectedNumeric };
}
