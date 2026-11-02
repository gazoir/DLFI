/**
 * Offline selftest for DLCE → dnd5e actor mapping (no Foundry runtime required).
 * Run: node scripts/import/selftest.mjs [path-to-npc.json ...]
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

globalThis.foundry = {
  utils: {
    duplicate: (o) => structuredClone(o),
    mergeObject: (a, b, opts = {}) => {
      const out = opts.inplace === false ? structuredClone(a) : a;
      for (const [k, v] of Object.entries(b ?? {})) {
        if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") {
          foundry.utils.mergeObject(out[k], v, { inplace: true });
        } else {
          out[k] = v;
        }
      }
      return out;
    },
    randomID: (n = 16) => "x".repeat(n)
  }
};

globalThis.CONFIG = {
  DND5E: {
    creatureTypes: Object.fromEntries(
      [
        "aberration",
        "beast",
        "celestial",
        "construct",
        "dragon",
        "elemental",
        "fey",
        "fiend",
        "giant",
        "humanoid",
        "monstrosity",
        "ooze",
        "plant",
        "undead"
      ].map((k) => [k, {}])
    )
  }
};

const {
  buildNpcNpcActorData,
  collectNpcLocationIds,
  parseHitDamageParts
} = await import("./buildNpcActor.mjs");
const { parseWeaponBaseDamage, abilityModifier, predictFoundryBaseDamage } = await import(
  "./damageFormula.mjs"
);

const DEFAULT_SAMPLES = [
  "/home/ubuntu/.cursor/projects/workspace/uploads/npc_wyvern_025d.json",
  "/home/ubuntu/.cursor/projects/workspace/uploads/npc_head_priest_175a.json"
];

const paths = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SAMPLES)
  .map((p) => resolve(p))
  .filter((p) => existsSync(p));

if (!paths.length) {
  console.error("No sample NPC JSON files found.");
  process.exit(1);
}

let failures = 0;

function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok: ${message}`);
  }
}

// Unit: @mod strip
{
  const strMod = abilityModifier(19);
  const bite = parseWeaponBaseDamage("2d8 + 4", { abilityMod: strMod });
  assert(bite.number === 2 && bite.denomination === 8 && bite.bonus === "", "Wyvern Bite stores 2d8 with empty bonus");
  const pred = predictFoundryBaseDamage(bite, { abilityMod: strMod, dlceFormula: "2d8 + 4" });
  assert(pred.matchesDlce, `Foundry prediction matches DLCE (${pred.formula})`);
  assert(pred.formula.includes("@mod"), "prediction includes @mod");
}

// Unit: multi-part Hit parsing
{
  const parts = parseHitDamageParts(
    "Hit: 11 (2d6 + 4) Piercing damage plus 24 (7d6) Poison damage, and the target has the Poisoned condition."
  );
  assert(parts.length === 2, `Sting hit parses 2 damage parts (got ${parts.length})`);
  assert(parts[0]?.dice === "2d6 + 4" && /piercing/i.test(parts[0]?.type), "Sting primary piercing");
  assert(parts[1]?.dice === "7d6" && /poison/i.test(parts[1]?.type), "Sting secondary poison");
}

for (const path of paths) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const entry = {
    id: raw.id,
    name: raw.name,
    locationIds: [],
    type: "npc"
  };
  const actor = buildNpcNpcActorData(raw, entry, {});
  const fields = raw.fields ?? {};
  console.log(`\n=== ${actor.name} (${path}) ===`);

  for (const key of ["str", "dex", "con", "int", "wis", "cha"]) {
    const expected = Number(fields[`check_${key}`]);
    if (Number.isFinite(expected)) {
      assert(actor.system.abilities[key]?.value === expected, `${key}=${expected}`);
    }
  }

  if (fields.creature_size) {
    const sizeMap = { Tiny: "tiny", Small: "sm", Medium: "med", Large: "lg", Huge: "huge", Gargantuan: "grg" };
    assert(
      actor.system.traits.size === sizeMap[fields.creature_size],
      `size ${fields.creature_size} → ${actor.system.traits.size}`
    );
  }

  if (String(fields._npc_subtype).toLowerCase() === "monster" || /dragon|beast|monstrosity/i.test(fields.creature_type)) {
    assert(
      !actor.system.details.type.subtype || actor.system.details.type.subtype === fields.combat_subtype,
      `monster subtype not polluted by species (got "${actor.system.details.type.subtype}")`
    );
  }

  const weapons = actor.items.filter((i) => i.type === "weapon");
  assert(weapons.length > 0, `has weapon attacks (${weapons.map((w) => w.name).join(", ") || "none"})`);
  for (const weapon of weapons) {
    const base = weapon.system.damage.base;
    const mod = abilityModifier(fields.check_str);
    if (base.number && base.denomination && mod != null) {
      const pred = predictFoundryBaseDamage(base, {
        abilityMod: mod,
        dlceFormula: weapon.flags?.dlfi?.dlceDamage || ""
      });
      assert(pred.matchesDlce || !weapon.flags?.dlfi?.dlceDamage, `${weapon.name} damage prediction ok (${pred.formula})`);
      assert(base.bonus === "" || base.bonus === "0" || Number(base.bonus) !== mod, `${weapon.name} did not keep raw STR in bonus`);
    }
  }

  const locs = collectNpcLocationIds(entry, raw);
  const linked = (raw.links ?? []).filter((l) => l.target_type === "location").map((l) => l.target_id);
  assert(
    linked.every((id) => locs.includes(id)),
    `location links collected (${locs.join(", ") || "none"})`
  );
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll selftests passed.");
