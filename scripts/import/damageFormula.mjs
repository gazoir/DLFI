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

export function normalizeDamageType(value) {
  const type = String(value ?? "").toLowerCase().trim();
  return type || "bludgeoning";
}

/**
 * Decide attack activity configuration so to-hit matches the DLCE bonus when possible.
 * Prefer Foundry's normal mod+prof calculation (flat:false), matching SRD monsters.
 */
export function buildAttackConfig({
  attackBonus,
  abilityMod,
  proficiencyBonus,
  attackType = "melee"
}) {
  const stated = Number(String(attackBonus ?? "").replace(/^\+/, ""));
  const mod = Number(abilityMod);
  const prof = Number(proficiencyBonus);
  const computed =
    Number.isFinite(mod) && Number.isFinite(prof) ? mod + prof : null;

  if (Number.isFinite(stated) && computed != null && stated === computed) {
    return {
      flat: false,
      ability: "",
      bonus: "",
      type: { value: attackType, classification: "weapon" }
    };
  }

  if (Number.isFinite(stated) && computed != null) {
    const delta = stated - computed;
    return {
      flat: false,
      ability: "",
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
    ability: "",
    bonus: "",
    type: { value: attackType, classification: "weapon" }
  };
}
