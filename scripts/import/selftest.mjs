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
  ensureNpcSkillsAndCr,
  parseChallengeRating,
  parseHitDamageParts,
  resolveNpcHitPoints
} = await import("./buildNpcActor.mjs");
const { resolveLocationBackground, resolveNpcMedia } = await import("./resolvePackageAsset.mjs");
const {
  classifyLandingFileName,
  classifyLandingTile,
  resolveImportedSessionThumbUrl,
  resolveLandingPageArt,
  resolveSessionThumbPackagePath,
  shouldUploadPackagePath
} = await import("./resolveLandingArt.mjs");
const {
  findUserForSeat,
  normalizeSeatEntry,
  seatsFromSessionPcs,
  softSeatPlayers,
  USER_ROLE
} = await import("./softSeatPlayers.mjs");

const {
  parseWeaponBaseDamage,
  abilityModifier,
  attackBonusBandForCr,
  buildAttackConfig,
  predictFoundryAttackBonus,
  predictFoundryBaseDamage,
  proficiencyBonusFromCr,
  resolveAttackAbility
} = await import("./damageFormula.mjs");
const {
  buildChallengeHostLocations,
  buildItemLocationsFromLocationLinks,
  buildNpcLocationsFromLocationLinks,
  collectChallengeEnemies,
  collectItemLocationIds,
  formatPoisBulletList,
  locationDescriptionText,
  locationPois,
  locationSessionNotesText,
  stripWikiLinks,
  resolveChallengeHostLocationId,
  resolveColourBattlemapPath,
  collectNpcLocationIds: collectNpcLocationIdsFromLinks
} = await import("./packageLinks.mjs");
const {
  buildItemPileTokenData,
  classifyLocationFieldDrawings,
  classifyLocationFieldLabel,
  compareItemsForPilePlacement,
  finalizeItemPileActor,
  ITEM_PILE_COLUMNS,
  ITEM_PILE_SCALE,
  ITEM_PILE_PLACEHOLDER_NAME_RE,
  ITEM_PILES_MODULE_ID,
  ITEM_PILES_MODULE_ID_LEGACY,
  isDlfiItemPileActor,
  isItemPilesActive,
  isLocationItemPilePlaceholderToken,
  itemPileEntriesMatch,
  itemPileSortKey,
  layoutBattlemapRosterLines,
  layoutLocationItemPilePositions,
  pileActorItemsList,
  sceneCanvasMetrics,
  selectLandingPcSlots,
  tokenActorId,
  tokenPlacementSpec
} = await import("./scenePlacement.mjs");
const { ITEM_PILES_FOLDER_NAME, PC_ACTOR_FOLDER_NAME } = await import("../constants.mjs");
const {
  buildMsdSceneSequence,
  formatSceneDmName,
  isCombatChallengeEntry,
  padSceneOrder
} = await import("./sceneOrder.mjs");
const {
  actorHasDdbLink,
  buildExistingPcFillPatch,
  buildPcActorData,
  DEFAULT_PC_ART,
  isMissingPcArt,
  parseDdbCharacterId
} = await import("./buildPcActor.mjs");
const { fileURLToPath } = await import("node:url");
const { dirname, join } = await import("node:path");
const PC_TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../templates/actors/player-character.json"
);
const pcActorTemplate = JSON.parse(readFileSync(PC_TEMPLATE_PATH, "utf8"));
const { convertMsdHtmlForFoundry } = await import("./msdJournal.mjs");
const {
  packageImportRoot,
  sessionInboxFolderName,
  normalizeDataPath
} = await import("../package/dataFolders.mjs");

const DEFAULT_SAMPLES = [
  "/home/ubuntu/.cursor/projects/workspace/uploads/npc_wyvern_025d.json",
  "/home/ubuntu/.cursor/projects/workspace/uploads/npc_head_priest_175a.json"
];

const paths = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SAMPLES)
  .map((p) => resolve(p))
  .filter((p) => existsSync(p));

let failures = 0;

if (!paths.length) {
  console.warn("No sample NPC JSON files found — skipping actor sample assertions.");
}

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

// Unit: Imp Sting — melee to-hit uses DEX when stated matches DEX+prof (not STR)
{
  assert(proficiencyBonusFromCr(1) === 2, "CR1 proficiency +2");
  const strMod = abilityModifier(6); // -2
  const dexMod = abilityModifier(17); // +3
  const resolved = resolveAttackAbility({
    attackType: "melee",
    strMod,
    dexMod,
    statedBonus: "+5",
    proficiencyBonus: 2,
    damageBonus: 3
  });
  assert(resolved.ability === "dex" && resolved.mod === 3, "Imp Sting resolves to DEX");

  // Regression: old STR-only path stored bonus "5" with flat:false → Foundry +10
  const wrong = buildAttackConfig({
    attackBonus: "+5",
    abilityMod: strMod,
    proficiencyBonus: 2,
    attackType: "melee",
    ability: "str"
  });
  assert(wrong.bonus === "5" && wrong.flat === false, "STR-only path still produces residual +5");
  assert(
    predictFoundryAttackBonus(wrong, { abilityMod: dexMod, proficiencyBonus: 2 }) === 10,
    "wrong path predicts +10 when Foundry uses DEX"
  );

  const right = buildAttackConfig({
    attackBonus: "+5",
    abilityMod: resolved.mod,
    proficiencyBonus: 2,
    attackType: "melee",
    ability: resolved.ability
  });
  assert(right.flat === false && right.bonus === "" && right.ability === "dex", "DEX path stores empty bonus");
  assert(
    predictFoundryAttackBonus(right, { abilityMod: resolved.mod, proficiencyBonus: 2 }) === 5,
    "DEX path predicts +5"
  );

  const band = attackBonusBandForCr(1, { maxAbilityMod: 3 });
  assert(band.max === 8, "CR1 band max is PB+ability+3");
  assert(10 > band.max, "+10 exceeds CR1 band");

  // End-to-end Imp-like NPC build
  const imp = buildNpcNpcActorData(
    {
      fields: {
        name: "Imp",
        check_str: 6,
        check_dex: 17,
        check_con: 13,
        check_int: 11,
        check_wis: 12,
        check_cha: 14,
        check_prof: 2,
        combat_cr: 1,
        combat_attacks: JSON.stringify([
          {
            name: "Sting",
            bonus: "+5",
            damage: [
              { dice: "1d6 + 3", type: "piercing" },
              { dice: "2d6", type: "poison" }
            ]
          }
        ])
      }
    },
    { id: "npc_imp", name: "Imp", type: "npc" },
    {}
  );
  const sting = imp.items.find((i) => i.name === "Sting");
  assert(sting, "Imp has Sting weapon");
  const activity = Object.values(sting.system.activities ?? {})[0];
  assert(activity?.attack?.ability === "dex", "Sting activity ability is dex");
  assert(activity?.attack?.flat === false, "Sting uses mod+prof");
  assert(!activity?.attack?.bonus || activity.attack.bonus === "", "Sting has no residual attack bonus");
  assert(sting.system.damage.base.bonus === "" || sting.system.damage.base.bonus === "0", "Sting damage strips DEX");
  assert(sting.flags?.dlfi?.predictedAttackBonus === 5, "Sting predicted to-hit +5");
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

// Kira: location → NPC reverse link (Owned by), empty NPC links
{
  const locPath = "/home/ubuntu/.cursor/projects/workspace/uploads/loc_trader_fd35.json";
  const npcPath = "/home/ubuntu/.cursor/projects/workspace/uploads/npc_kira_brannardor_df64.json";
  if (existsSync(locPath) && existsSync(npcPath)) {
    const loc = JSON.parse(readFileSync(locPath, "utf8"));
    const npc = JSON.parse(readFileSync(npcPath, "utf8"));
    const reverse = buildNpcLocationsFromLocationLinks([{ id: loc.id, file: "documents/loc_trader.json" }], (file) =>
      file ? loc : null
    );
    assert(
      (reverse.get("npc_kira_brannardor") || []).includes("loc_trader"),
      "reverse index maps Kira ← loc_trader"
    );
    const withoutReverse = collectNpcLocationIdsFromLinks(
      { id: npc.id, locationIds: [] },
      npc,
      []
    );
    assert(withoutReverse.length === 0, "Kira has no forward location links");
    const withReverse = collectNpcLocationIdsFromLinks(
      { id: npc.id, locationIds: [] },
      npc,
      reverse.get(npc.id) ?? []
    );
    assert(withReverse.includes("loc_trader"), "Kira places on loc_trader via reverse link");
    assert(
      locationDescriptionText(loc).includes("trader"),
      "location description falls back to appearance"
    );
  } else {
    console.log("skip: Kira/trader samples not present");
  }
}

// Skills use correct ability + proficiency; CR defaults to 1
{
  const bareen = buildNpcNpcActorData(
    {
      fields: {
        name: "Bareen Muradhgan",
        check_str: 10,
        check_dex: 6,
        check_con: 14,
        check_int: 15,
        check_wis: 18,
        check_cha: 17,
        check_skills: ["Acrobatics", "Athletics", "Insight", "Medicine", "Stealth"]
      }
    },
    { id: "npc_bareen", name: "Bareen Muradhgan" },
    {}
  );
  assert(bareen.system.details.cr === 1, "default CR is 1 when unset");
  assert(bareen.system.skills.ath?.ability === "str", "Athletics uses STR");
  assert(bareen.system.skills.ins?.ability === "wis", "Insight uses WIS");
  assert(bareen.system.skills.med?.ability === "wis", "Medicine uses WIS");
  assert(bareen.system.skills.acr?.ability === "dex", "Acrobatics uses DEX");
  assert(bareen.system.skills.ath?.value >= 1, "Athletics is proficient");
  assert(bareen.system.skills.med?.value >= 1, "Medicine is proficient");

  // Embedded actor with empty ability must be corrected (dnd5e DEX fallback).
  const broken = { skills: { his: { value: 1, ability: "" }, inv: { value: 1 } }, details: { cr: null } };
  ensureNpcSkillsAndCr(broken, { check_skills: "History, Investigation, Religion" });
  assert(broken.details.cr === 1, "ensureNpcSkillsAndCr defaults CR");
  assert(broken.skills.his.ability === "int", "History ability repaired to INT");
  assert(broken.skills.inv.ability === "int", "Investigation ability repaired to INT");
  assert(broken.skills.rel?.ability === "int" && broken.skills.rel.value >= 1, "Religion proficient + INT");
}

// Landing Page slides: Clean for background; Logo/Title Only for tiles
{
  assert(classifyLandingFileName("SESSION_014_Logo_Burn.webp") === "logoBurn", "classify Logo_Burn");
  assert(classifyLandingFileName("Mist_Opportunity_Logo Only.png") === "logoOnly", "classify Logo Only");
  assert(classifyLandingFileName("title-only.webp") === "titleOnly", "classify title-only");
  assert(classifyLandingFileName("session_Clean.jpg") === "clean", "classify Clean");
  assert(shouldUploadPackagePath("Landing Page/x_Logo_Burn.webp"), "upload top-level Landing Page/");
  assert(shouldUploadPackagePath("assets/npc/foo.webp"), "upload assets/");
  assert(!shouldUploadPackagePath("documents/npc_kira.json"), "skip documents/");

  assert(classifyLandingTile({ name: "Logo Only" }) === "logoOnly", "tile name Logo Only");
  assert(classifyLandingTile({ name: "Title Only" }) === "titleOnly", "tile name Title Only");
  assert(
    classifyLandingTile({
      name: "",
      texture: { src: "dlfi-imports/x/assets/Landing%20Page/Logo_Only.png" }
    }) === "logoOnly",
    "tile src Logo_Only"
  );

  const uploaded = new Map([
    ["Landing Page/SESSION_Logo_Burn.webp", "world/Landing Page/SESSION_Logo_Burn.webp"],
    ["Landing Page/SESSION_Clean.webp", "world/Landing Page/SESSION_Clean.webp"],
    ["Landing Page/SESSION_Logo_Only.webp", "world/Landing Page/SESSION_Logo_Only.webp"],
    ["Landing Page/SESSION_Title_Only.webp", "world/Landing Page/SESSION_Title_Only.webp"],
    ["assets/session/old.webp", "world/assets/session/old.webp"]
  ]);
  const art = resolveLandingPageArt({ sessionArt: "assets/session/old.webp" }, uploaded);
  assert(
    art.background === "world/Landing Page/SESSION_Clean.webp",
    `Clean preferred for Landing BG (got ${art.background})`
  );
  assert(art.logoOnly?.endsWith("Logo_Only.webp"), "logoOnly resolved");
  assert(art.titleOnly?.endsWith("Title_Only.webp"), "titleOnly resolved");
  assert(art.clean?.endsWith("Clean.webp"), "clean resolved");

  const named = resolveLandingPageArt(
    {
      landingPage: {
        logoBurn: "assets/Landing Page/burn.webp",
        clean: "assets/Landing Page/clean.webp"
      }
    },
    new Map([
      ["assets/Landing Page/burn.webp", "world/burn.webp"],
      ["assets/Landing Page/clean.webp", "world/clean.webp"]
    ])
  );
  assert(named.background === "world/clean.webp", "manifest clean wins over logoBurn for BG");

  const burnOnly = resolveLandingPageArt(
    { landingPage: { logoBurn: "assets/Landing Page/burn.webp" } },
    new Map([["assets/Landing Page/burn.webp", "world/burn.webp"]])
  );
  assert(burnOnly.background === "world/burn.webp", "Logo_Burn fallback when Clean missing");

  const legacy = resolveLandingPageArt(
    { sessionArt: "assets/session/cover.webp" },
    new Map([["assets/session/cover.webp", "world/cover.webp"]])
  );
  assert(legacy.background === "world/cover.webp", "legacy sessionArt still works");

  const thumbPath = resolveSessionThumbPackagePath(
    { sessionArt: "assets/session/old.webp" },
    uploaded.keys()
  );
  assert(
    thumbPath === "Landing Page/SESSION_Clean.webp",
    `inbox thumb prefers Clean (got ${thumbPath})`
  );
  assert(
    resolveImportedSessionThumbUrl({
      background: { src: "dlfi-imports/x/Landing Page/Clean.webp" }
    }) === "dlfi-imports/x/Landing Page/Clean.webp",
    "imported session thumb from Landing background"
  );
}

{
  const {
    buildItemCreateData,
    buildItemPrice,
    resolveItemGpValue
  } = await import("./buildItemData.mjs");
  assert(resolveItemGpValue({ gp_value: "393" }) === 393, "gp_value 393");
  assert(resolveItemGpValue({ gp_value: "1,200 GP" }) === 1200, "gp_value with GP suffix");
  assert(resolveItemGpValue({ value: "50" }) === 50, "value alias");
  assert(resolveItemGpValue({}) == null, "missing gp_value");
  assert(
    JSON.stringify(buildItemPrice({ gp_value: "393" })) ===
      JSON.stringify({ value: 393, denomination: "gp" }),
    "price object for dnd5e loot"
  );
  const epergne = buildItemCreateData({
    entry: {
      id: "item_white_metal_epergne",
      name: "White metal Epergne",
      subtype: "cash_loot",
      locationIds: ["loc_trader"]
    },
    fields: {
      description:
        "A white metal epergne, set with a large spinel and finished with flat inset pieces of lapis lazuli.",
      gp_value: "393"
    },
    importKey: "SESSION_014_test"
  });
  assert(epergne.type === "loot", "cash_loot → loot");
  assert(epergne.system.price?.value === 393, "epergne price.value 393");
  assert(epergne.system.price?.denomination === "gp", "epergne denomination gp");
  assert(epergne.flags.dlfi.gpValue === 393, "flag mirrors gp");

  const { mapItemRarity } = await import("./buildItemData.mjs");
  assert(resolveItemGpValue({ gp_value: "0.5" }) === 0.5, "gp keeps fractional value");
  assert(resolveItemGpValue({ gp_value: "12.345" }) === 12.35, "gp rounds to 0.01");
  assert(mapItemRarity("Very Rare") === "veryRare", "rarity Very Rare → veryRare");
  assert(mapItemRarity("very_rare") === "veryRare", "rarity very_rare → veryRare");
  assert(mapItemRarity("nonsense") === null, "unknown rarity → null");
  const ring = buildItemCreateData({
    entry: { id: "item_ring", name: "Ring", subtype: "magic_item" },
    fields: { rarity: "Uncommon", gp_value: "0.5" },
    importKey: "SESSION_014_test"
  });
  assert(ring.system.rarity === "uncommon", "item create data carries rarity");
  assert(ring.system.price?.value === 0.5, "item create data keeps 0.5 gp");
}

{
  const { buildItemsFromFields, parseRechargeFromNameOrBody, parseDamagePartsFromText } =
    await import("./buildNpcActor.mjs");
  const [claw] = buildItemsFromFields({
    combat_level: "20",
    combat_str: "16",
    combat_dex: "10",
    combat_attacks: JSON.stringify([{ name: "Claw", bonus: "+6", damage: [{ dice: "1d8 + 3", type: "slashing" }] }])
  });
  assert(claw.flags.dlfi.predictedAttackBonus === 6, "weapon prof uses combat_level CR (level 20 → +3)");
  assert(Object.values(claw.system.activities)[0].attack.bonus === "", "no residual to-hit bonus");

  const breath = parseRechargeFromNameOrBody("Fire Breath (Recharge 5–6)", "Cone.");
  assert(breath.itemUses.max === "1" && breath.itemUses.recovery[0].formula === "5", "recharge 5–6 → item uses, formula 5");
  assert(breath.uses.max === "" && !breath.uses.recovery.length, "recharge: activity has no own uses");
  assert(breath.consumptionTargets[0]?.type === "itemUses", "recharge: activity consumes item uses");
  const rally = parseRechargeFromNameOrBody("Rally", "Recharges after a short rest.");
  assert(rally.itemUses.recovery[0]?.period === "sr", "short rest recovery");
  const lr = parseRechargeFromNameOrBody("Roar", "Recharges after a long rest.");
  assert(lr.itemUses.recovery[0]?.period === "lr", "long rest recovery");
  assert(!parseRechargeFromNameOrBody("Bite", "Hits.").consumptionTargets.length, "unlimited action: no consumption");

  const parts = parseDamagePartsFromText(
    "DC 13 Dexterity saving throw, taking 22 (5d8) fire damage and 7 (2d6) poison damage on a failed save, or half as much on a success."
  );
  assert(parts.length === 2 && parts[0].number === 5 && parts[0].types[0] === "fire", "save damage part 5d8 fire");
  assert(parts[1].types[0] === "poison", "second save damage part poison");
  const [breathFeat] = buildItemsFromFields({
    combat_actions:
      "**Fire Breath (Recharge 5–6).** Each creature in a 15-foot cone must make a DC 13 Dexterity saving throw, taking 22 (5d8) fire damage on a failed save, or half as much on a success."
  });
  const saveActivity = Object.values(breathFeat.system.activities)[0];
  assert(saveActivity.type === "save" && saveActivity.damage.parts.length === 1, "save activity gets damage parts");
  assert(saveActivity.damage.onSave === "half", "save activity half on save");
  assert(breathFeat.system.uses.max === "1", "breath item uses max 1");

  const multi = parseWeaponBaseDamage("2d6 + 1d4 + 3", { abilityMod: 3 });
  assert(multi.custom.enabled && multi.custom.formula === "2d6 + 1d4", "custom formula strips ability mod");
  const multiPred = predictFoundryBaseDamage(multi, { abilityMod: 3, dlceFormula: "2d6 + 1d4 + 3" });
  assert(multiPred.matchesDlce && multiPred.formula === "2d6 + 1d4 + @mod", "custom formula prediction matches");
  const noConst = parseWeaponBaseDamage("2d6 + 1d4", { abilityMod: 2 });
  assert(noConst.custom.formula === "2d6 + 1d4 - 2", "custom formula without constant offsets @mod");
  const weird = parseWeaponBaseDamage("2d6 + @prof", { abilityMod: 2 });
  assert(
    !predictFoundryBaseDamage(weird, { abilityMod: 2, dlceFormula: "2d6 + @prof" }).matchesDlce,
    "unparseable custom formula flagged as mismatch"
  );
  assert(abilityModifier(null) === null && abilityModifier("") === null, "missing score → null mod");
}

{
  const {
    formatElapsedSince,
    formatExportDate,
    formatExportStamp,
    decorateInboxSessionsForDisplay
  } = await import("../ui/formatExportStamp.mjs");
  const now = Date.parse("2026-11-24T18:10:35.914Z");
  const stamp = "2026-11-24T16:10:35.914Z";
  assert(formatExportDate(stamp).includes("2026"), "export date has year");
  assert(formatExportDate(stamp).includes("November"), "export date has month name");
  assert(formatElapsedSince(stamp, now) === "2 hours ago", "2 hours ago");
  assert(
    formatElapsedSince("2026-11-24T17:11:35.914Z", now) === "59 minutes ago",
    "59 minutes ago"
  );
  assert(
    formatElapsedSince("2026-11-21T18:10:35.914Z", now) === "3 days ago",
    "3 days ago"
  );
  assert(
    formatElapsedSince("2026-11-10T18:10:35.914Z", now) === "2 weeks ago",
    "2 weeks ago"
  );
  assert(
    formatElapsedSince("2026-08-24T18:10:35.914Z", now) === "3 months ago",
    "3 months ago"
  );
  assert(
    formatElapsedSince("2025-11-24T18:10:35.914Z", now) === "1 year ago",
    "1 year ago"
  );
  assert(
    formatExportStamp(stamp, now).endsWith(" - 2 hours ago"),
    "stamp joins date and elapsed"
  );
  const rows = decorateInboxSessionsForDisplay(
    [
      {
        latestExportedAt: stamp,
        versions: [{ package: { manifest: { exportedAt: stamp } } }]
      }
    ],
    now
  );
  assert(
    rows[0].latestExportedAtLabel === formatExportStamp(stamp, now),
    "decorates session label"
  );
  assert(
    rows[0].versions[0].exportedAtLabel === formatExportStamp(stamp, now),
    "decorates version label"
  );
}

{
  const {
    applySceneBackground,
    refreshSceneThumbnail,
    refreshSceneThumbnails,
    resolveSceneBackgroundSrc,
    createThumbnailFromSrc
  } = await import("./applySceneBackground.mjs");
  /** @type {object[]} */
  const calls = [];
  const scene = {
    name: "01. 📍 Test",
    thumb: null,
    background: { src: null },
    levels: { contents: [] },
    async update(patch) {
      calls.push(["update", patch]);
      if (patch.background) {
        this.background = { ...this.background, ...patch.background };
      }
      if (patch.thumb) {
        this.thumb = patch.thumb;
      }
    },
    async createThumbnail(opts = {}) {
      calls.push(["createThumbnail", opts]);
      return { thumb: "data:image/webp;base64,THUMB" };
    }
  };
  assert(
    (await applySceneBackground(scene, "world/maps/dock.webp")) === true,
    "applySceneBackground returns true"
  );
  assert(
    calls.some((c) => c[0] === "update" && c[1]?.background?.src === "world/maps/dock.webp"),
    "background src written"
  );
  assert(
    calls.some((c) => c[0] === "createThumbnail"),
    "createThumbnail called after background set"
  );
  assert(scene.thumb === "data:image/webp;base64,THUMB", "scene.thumb stored for Scene Directory");

  const again = await refreshSceneThumbnail(scene, { img: "world/maps/dock.webp" });
  assert(again === "data:image/webp;base64,THUMB", "refreshSceneThumbnail returns thumb");

  assert(
    resolveSceneBackgroundSrc({
      background: { src: null },
      levels: {
        contents: [{ id: "L1", background: { src: "maps/level.webp" } }],
        get(id) {
          return this.contents.find((l) => l.id === id);
        }
      },
      initialLevel: "L1"
    }) === "maps/level.webp",
    "resolveSceneBackgroundSrc reads Level collection"
  );

  // ImageHelper fallback when Scene#createThumbnail throws
  globalThis.foundry = globalThis.foundry || { utils: globalThis.foundry?.utils };
  globalThis.foundry.helpers = {
    media: {
      ImageHelper: {
        async createThumbnail(src) {
          return { thumb: `data:image/webp;base64,IH:${src}` };
        }
      }
    }
  };
  const broken = {
    name: "Broken",
    thumb: null,
    background: { src: "maps/x.webp" },
    levels: { contents: [] },
    async createThumbnail() {
      throw new Error("nope");
    },
    async update(patch) {
      if (patch.thumb) this.thumb = patch.thumb;
    }
  };
  const viaHelper = await refreshSceneThumbnail(broken, { img: "maps/x.webp" });
  assert(viaHelper === "data:image/webp;base64,IH:maps/x.webp", "ImageHelper fallback thumb");
  assert(broken.thumb === viaHelper, "fallback thumb persisted");
  assert(
    (await createThumbnailFromSrc("maps/y.webp")) === "data:image/webp;base64,IH:maps/y.webp",
    "createThumbnailFromSrc uses ImageHelper"
  );

  const batch = await refreshSceneThumbnails([scene, broken]);
  assert(batch.attempted === 2, "batch refresh attempts both");
}

{
  const { sceneArtSrc } = await import("./mattSceneNav.mjs");
  assert(
    sceneArtSrc({
      background: { src: null },
      levels: {
        contents: [{ id: "a", background: { src: "loc.webp" } }],
        get(id) {
          return this.contents.find((l) => l.id === id);
        }
      },
      initialLevel: "a"
    }) === "loc.webp",
    "sceneArtSrc reads EmbeddedCollection levels"
  );
}

// Location artwork resolves under assets/location/ (DLCE v2 layout)
{
  const uploaded = new Map([
    [
      "assets/location/loc_ancient_ruin.webp",
      "dlfi-imports/pkg/assets/location/loc_ancient_ruin.webp"
    ]
  ]);
  const bg = resolveLocationBackground(
    { id: "loc_ancient_ruin", name: "Fallen Temple", portrait: "assets/portraits/loc_ancient_ruin.webp" },
    uploaded
  );
  assert(
    bg === "dlfi-imports/pkg/assets/location/loc_ancient_ruin.webp",
    `location bg from assets/location (got ${bg})`
  );
  const media = resolveNpcMedia(
    { id: "npc_kira", portrait: "assets/portraits/npc_kira.webp" },
    new Map([["assets/npc/npc_kira.webp", "world/kira.webp"]])
  );
  assert(media.portrait === "world/kira.webp", "NPC portrait falls back to assets/npc/");
}

// Colour battlemap preference
{
  const uploaded = new Map([
    ["assets/battlemaps/ch_ambush_grid.webp", "world/grid.webp"],
    ["assets/battlemaps/ch_ambush_colour.webp", "world/colour.webp"],
    ["assets/battlemaps/ch_ambush_color.png", "world/color.png"]
  ]);
  const path = resolveColourBattlemapPath({
    entry: { id: "ch_ambush", name: "Ambush", battlemap: null },
    raw: { fields: { kind: "combat" } },
    locationEntry: null,
    uploaded,
    assetPaths: [...uploaded.keys()]
  });
  assert(path === "world/colour.webp" || path === "world/color.png", `prefer colour battlemap (got ${path})`);
  assert(!String(path).includes("grid"), "do not use grid overlay art");
}

// DLCE v2: battlemaps live under assets/location/battlemaps/{locationId}
{
  const uploaded = new Map([
    [
      "assets/location/battlemaps/loc_village_approach.webp",
      "dlfi-imports/pkg/assets/location/battlemaps/loc_village_approach.webp"
    ],
    [
      "assets/location/loc_village_approach.webp",
      "dlfi-imports/pkg/assets/location/loc_village_approach.webp"
    ]
  ]);
  const path = resolveColourBattlemapPath({
    entry: { id: "ch_s000_challenge", name: "Invisible Whispers", battlemap: null, locationIds: [] },
    raw: { fields: { kind: "combat" }, links: [] },
    locationEntry: {
      id: "loc_village_approach",
      battlemap: "assets/location/battlemaps/loc_village_approach.webp"
    },
    uploaded,
    assetPaths: [...uploaded.keys()]
  });
  assert(
    path === "dlfi-imports/pkg/assets/location/battlemaps/loc_village_approach.webp",
    `location battlemap folder (got ${path})`
  );

  const hosts = buildChallengeHostLocations(
    [{ id: "loc_village_approach", file: "documents/loc_village_approach.json" }],
    (file) =>
      file === "documents/loc_village_approach.json"
        ? {
            links: [
              {
                relation: "hosts",
                target_id: "ch_s000_challenge",
                target_type: "challenge"
              }
            ]
          }
        : null
  );
  assert(
    hosts.get("ch_s000_challenge")?.[0] === "loc_village_approach",
    "reverse host location from location→challenge link"
  );
  assert(
    resolveChallengeHostLocationId(
      { id: "ch_s000_challenge", locationIds: [] },
      { links: [] },
      hosts
    ) === "loc_village_approach",
    "resolveChallengeHostLocationId uses reverse hosts"
  );
}

// Storage path helpers
{
  const manifest = {
    sessionCode: "SESSION_014",
    displayCode: "SESSION_014",
    sessionName: "Misty Lake",
    exportedAt: "2026-11-09T17:00:06.864Z"
  };
  assert(
    sessionInboxFolderName(manifest) === "SESSION_014 · Misty Lake",
    `inbox folder name (${sessionInboxFolderName(manifest)})`
  );
  const root = packageImportRoot(manifest);
  assert(root.startsWith("SESSION_014__Misty_Lake__"), `import root (${root})`);
  assert(
    normalizeDataPath("\\dlfi-imports\\foo\\") === "dlfi-imports/foo",
    "normalizeDataPath strips slashes"
  );
}

// Monk's Active Tile Triggers — scene nav rolling window
{
  const {
    LEFT_NAV_SLOTS,
    RIGHT_NAV_SLOTS,
    classifyMattNavSide,
    leftNavWindow,
    listMattNavTiles,
    mattTileUpdate,
    rightNavWindow
  } = await import("./mattSceneNav.mjs");

  assert(LEFT_NAV_SLOTS === 22 && RIGHT_NAV_SLOTS === 6, "nav slot counts");
  const many = Array.from({ length: 28 }, (_, i) => ({ id: `s${i}`, name: `Scene ${i + 1}` }));
  const w0 = leftNavWindow(many, 0);
  assert(w0.length === 22 && w0[0].id === "s0" && w0[21].id === "s21", "scenes 1–9 keep Landing…22");
  const w9 = leftNavWindow(many, 9);
  assert(w9[0].id === "s1" && w9[21].id === "s22", "scene 10 drops Landing, gains scene 23");
  const w10 = leftNavWindow(many, 10);
  assert(w10[0].id === "s2" && w10[21].id === "s23", "scene 11 drops Landing+1, gains 23–24");
  const few = many.slice(0, 5);
  assert(leftNavWindow(few, 0).length === 5, "fewer than 22 keeps all");

  const maps = [
    { sceneId: "b1", hostLocationId: "loc_a" },
    { sceneId: "b2", hostLocationId: "loc_a" },
    { sceneId: "b3", hostLocationId: "loc_b" },
    { sceneId: "b4", hostLocationId: "loc_b" },
    { sceneId: "b5", hostLocationId: "loc_b" },
    { sceneId: "b6", hostLocationId: "loc_c" },
    { sceneId: "b7", hostLocationId: "loc_c" }
  ];
  assert(
    rightNavWindow(maps, { kind: "location", dlceId: "loc_a" }).map((r) => r.sceneId).join(",") ===
      "b1,b2,b3,b4,b5,b6",
    "location right nav shows all maps (linked first)"
  );
  assert(
    rightNavWindow(maps, { kind: "location", dlceId: "loc_a" })[0].sceneId === "b1" &&
      rightNavWindow(maps, { kind: "location", dlceId: "loc_a" })[2].sceneId === "b3",
    "linked maps listed before the rest"
  );
  assert(
    rightNavWindow(maps, { kind: "landing" }).map((r) => r.sceneId).join(",") ===
      "b1,b2,b3,b4,b5,b6",
    "landing right nav takes first 6"
  );

  const metrics = { sceneX: 960, sceneWidth: 1920, sceneY: 540, sceneHeight: 1080 };
  assert(
    classifyMattNavSide(
      { x: 240, y: 180, width: 448, height: 252, flags: { "monks-active-tiles": { active: true } } },
      metrics
    ) === "left",
    "left padding tile classified left"
  );
  assert(
    classifyMattNavSide(
      {
        x: 1680,
        y: 1860,
        width: 448,
        height: 252,
        flags: { "monks-active-tiles": { active: true } }
      },
      metrics
    ) === "left",
    "bottom-row landscape under map still left nav"
  );
  assert(
    classifyMattNavSide(
      {
        x: 3300,
        y: 840,
        width: 320,
        height: 440,
        flags: { "monks-active-tiles": { active: true } }
      },
      metrics
    ) === "right",
    "right padding tile classified right"
  );
  assert(
    classifyMattNavSide({ x: 240, y: 180, width: 448, height: 252, flags: {} }, metrics) === null,
    "non-MATT tile ignored"
  );

  const {
    isMattNavSlotTile,
    isProtectedArtTile,
    NAV_TILE_MAX_EDGE
  } = await import("./mattSceneNav.mjs");
  assert(NAV_TILE_MAX_EDGE === 700, "nav max edge");
  assert(
    isProtectedArtTile({ name: "Title Only", width: 1600, height: 900 }) === true,
    "Title Only is protected art"
  );
  assert(
    isProtectedArtTile({
      name: "Scene",
      texture: { src: "DM/Title Cards/Thanks for Playing.webp" }
    }) === true,
    "Thanks for Playing src is protected"
  );
  assert(
    classifyMattNavSide(
      {
        id: "thanks",
        name: "Title Only",
        x: 1920,
        y: 1180,
        width: 1600,
        height: 900,
        flags: {
          "monks-active-tiles": { active: false, actions: [] }
        },
        texture: { src: "DM/Title Cards/Thanks for Playing.webp" }
      },
      metrics
    ) === null,
    "Outro Title Only / Thanks for Playing is not a nav tile"
  );
  assert(
    isMattNavSlotTile({
      name: "Title Only",
      width: 1600,
      height: 900,
      flags: { "monks-active-tiles": { active: true, actions: [] } }
    }) === false,
    "large Title Only excluded even if MATT active"
  );
  assert(
    isMattNavSlotTile({
      name: "Stubborn Cream",
      width: 72,
      height: 72,
      flags: {
        "monks-active-tiles": { active: false },
        dlfi: { kind: "matt-nav-face" }
      }
    }) === false,
    "nav face tiles excluded"
  );

  const listed = listMattNavTiles({
    width: 1920,
    height: 1080,
    dimensions: { width: 3840, height: 2160, sceneWidth: 1920, sceneHeight: 1080, sceneX: 960, sceneY: 540 },
    tiles: {
      contents: [
        {
          id: "L1",
          x: 240,
          y: 480,
          width: 448,
          height: 252,
          flags: { "monks-active-tiles": { active: true, actions: [] } }
        },
        {
          id: "R1",
          x: 3120,
          y: 1020,
          width: 320,
          height: 540,
          flags: { "monks-active-tiles": { active: true, actions: [] } }
        },
        {
          id: "thanks",
          name: "Title Only",
          x: 1920,
          y: 1180,
          width: 1600,
          height: 900,
          flags: { "monks-active-tiles": { active: false, actions: [] } },
          texture: { src: "DM/Title Cards/Thanks for Playing.webp" }
        },
        { id: "logo", x: 1000, y: 100, width: 400, height: 200, flags: {} }
      ]
    }
  });
  assert(listed.left.map((t) => t.id).join(",") === "L1", "lists one left nav tile");
  assert(listed.right.map((t) => t.id).join(",") === "R1", "lists one right nav tile");
  assert(!listed.left.some((t) => t.id === "thanks"), "Thanks for Playing excluded from left nav");

  const update = mattTileUpdate(
    {
      id: "L1",
      flags: { "monks-active-tiles": { active: true, restriction: "gm", trigger: ["click"] } }
    },
    { sceneId: "abc", name: "01. 📍 Dock", img: "world/dock.webp", kind: "location" },
    "left"
  );
  assert(update["texture.src"] === "world/dock.webp", "nav tile texture set");
  assert(update.name === "01. 📍 Dock", "nav tile named for hover/HUD");
  assert(update.flags["monks-active-tiles"].pointer === true, "nav tile pointer cursor");
  assert(update.flags["monks-active-tiles"].actions[0].action === "scene", "scene action");
  assert(
    update.flags["monks-active-tiles"].actions[0].data.sceneid.id === "Scene.abc",
    "scene id uuid-style"
  );
  assert(update.flags.dlfi?.kind === "matt-nav-left", "dlfi nav kind");

  const { buildNavFaceTiles } = await import("./mattSceneNav.mjs");
  const faces = buildNavFaceTiles(
    { id: "L1", x: 100, y: 200, width: 448, height: 252 },
    [
      { img: "tokens/a.webp", name: "A" },
      { img: "tokens/b.webp", name: "B" },
      { img: "tokens/c.webp", name: "C" }
    ]
  );
  assert(faces.length === 3, "three face tiles under thumb");
  assert(faces[0].flags.dlfi.kind === "matt-nav-face", "face tile flagged");
  assert(faces[0].width === 72 && faces[0].texture.scaleX === 1.2, "face 72px @ 1.2× scale");
  assert(faces[0].texture.anchorX === 0.5 && faces[0].texture.fit === "fill", "face centre-anchored fill");
  // Parent plain object without anchor → defaults to 0.5 centre origin.
  // face.y = parent.y + (ph - size) / 2 ; face centres spaced 120 apart around parent.x
  const expectedFaceY = Math.round(200 + (252 - 72) / 2);
  assert(faces[0].y === expectedFaceY, `faces bottom-aligned via centre origin (got ${faces[0].y}, want ${expectedFaceY})`);
  assert(faces[0].texture.src === "tokens/a.webp", "face uses token art");
  assert(faces[1].x - faces[0].x === 120, "face centres spaced 120px");
  assert(faces[1].x === 100, "middle face shares parent centre x");

  // Hand-tuned Korbane fixture: parent centre-origin + single face.
  const korbaneParent = {
    id: "gOdN7lFloSawyqkG",
    toObject() {
      return {
        x: 720,
        y: 300,
        width: 448,
        height: 252,
        sort: 0,
        texture: { anchorX: 0.5, anchorY: 0.5 },
        flags: { dlfi: { kind: "matt-nav-left", targetSceneId: "Scene.x" } }
      };
    },
    flags: { dlfi: { kind: "matt-nav-left", targetSceneId: "Scene.x" } }
  };
  const { navTileGeometry, navTileAxisBounds } = await import("./mattSceneNav.mjs");
  const geom = navTileGeometry(korbaneParent);
  assert(geom.left === 720 - 224 && geom.top === 300 - 126, "centre-origin bounds from anchor 0.5");
  assert(geom.right === 720 + 224 && geom.bottom === 300 + 126, "centre-origin right/bottom");
  const one = buildNavFaceTiles(korbaneParent, [{ img: "tokens/cream.webp", name: "Stubborn Cream" }]);
  assert(one[0].x === 720, "single face shares parent centre x");
  assert(one[0].y === Math.round(300 + (252 - 72) / 2), "single face y matches hand-tuned +90");
  const two = buildNavFaceTiles(korbaneParent, [
    { img: "a.webp", name: "A" },
    { img: "b.webp", name: "B" }
  ]);
  assert(two[0].x === 720 - 60 && two[1].x === 720 + 60, "pair centres at ±60 from parent");
  assert(tokenActorId({ actorId: "abc" }) === "abc", "tokenActorId reads actorId");

  const {
    findMattNavTileAt,
    mattNavTileBounds
  } = await import("../canvas/mattNavTooltip.mjs");
  // Centre-origin tile at (720,300) 448×252 → visual box [496,174]–[944,426]
  const tipTile = {
    document: {
      name: "01. 📍 Korbane Village Approach",
      sort: 1,
      flags: { dlfi: { kind: "matt-nav-left" } },
      _source: {
        x: 720,
        y: 300,
        width: 448,
        height: 252,
        texture: { anchorX: 0.5, anchorY: 0.5 },
        flags: { dlfi: { kind: "matt-nav-left" } }
      }
    },
    // Inflated/wrong placeable bounds must be ignored.
    bounds: { x: 720, y: 300, width: 896, height: 504 }
  };
  const box = mattNavTileBounds(tipTile);
  assert(box?.x === 496 && box?.y === 174 && box?.x2 === 944 && box?.y2 === 426, "hover uses anchor-aware bounds");
  assert(
    findMattNavTileAt({ tiles: { placeables: [tipTile] } }, 720, 300)?.document?.name ===
      "01. 📍 Korbane Village Approach",
    "hit-test finds nav tile at centre"
  );
  assert(
    findMattNavTileAt({ tiles: { placeables: [tipTile] } }, 1000, 500) == null,
    "hit-test misses area to the right/below (old top-left bug zone)"
  );
  assert(
    findMattNavTileAt({ tiles: { placeables: [tipTile] } }, 500, 180)?.document?.name ===
      "01. 📍 Korbane Village Approach",
    "hit-test still hits visible top-left of thumb"
  );
  assert(navTileAxisBounds(korbaneParent).x === 496, "navTileAxisBounds left edge");
  const decoyCanvas = {
    tiles: { placeables: [tipTile] },
    scene: { tiles: { contents: [{ ...tipTile.document, name: "stale doc" }] } }
  };
  assert(findMattNavTileAt(decoyCanvas, 1000, 500) == null, "no document fallback scan when placeables exist");
  const midDraw = { tiles: { placeables: [] }, scene: { tiles: { contents: [tipTile.document] } } };
  assert(findMattNavTileAt(midDraw, 720, 300)?.name === tipTile.document.name, "document fallback while placeables empty");

  const { mattNavTooltipText } = await import("../canvas/mattNavTooltip.mjs");
  assert(
    mattNavTooltipText({
      name: "01. 📍 Dock",
      flags: { dlfi: { kind: "matt-nav-left" } }
    }) === "01. 📍 Dock",
    "tooltip text from nav tile"
  );
  assert(
    mattNavTooltipText({ name: "Nope", flags: { dlfi: { kind: "matt-nav-face" } } }) === "",
    "face tiles have no tooltip"
  );
}

// Location POIs → emoji list (strip wikilinks, blank lines between)
{
  assert(stripWikiLinks("[[npc_kira|Kira]]") === "Kira", "wikilink alias kept");
  assert(stripWikiLinks("[[Hidden Cave]]") === "Hidden Cave", "wikilink target kept");
  assert(stripWikiLinks("Near [[loc_a|the altar]]") === "Near the altar", "inline wikilink stripped");

  const pois = locationPois({
    fields: {
      pois: [
        { name: "[[npc_guard|Counter]]" },
        { title: "[[Back room]]" },
        "Window ledge"
      ]
    }
  });
  assert(pois.length === 3, `parse POI objects/strings (got ${pois.length})`);
  const text = formatPoisBulletList(pois);
  assert(text.startsWith("📍 "), "POI lines use 📍 emoji");
  assert(!text.includes("[["), "POI drawing text has no wikilink brackets");
  assert(text.includes("📍 Counter"), "alias text after strip");
  assert(text.includes("📍 Back room"), "bare wikilink becomes label");
  assert(text.split("\n\n").length === 3, "blank line between each POI");
  assert(!text.includes("•"), "no classic bullet characters");
  assert(locationPois({ fields: { appearance: "only appearance" } }).length === 0, "no POIs when absent");
}

// Location field drawings: classify Description / POIs / Session Notes (+ legacy)
{
  assert(classifyLocationFieldLabel("Description") === "description", "label Description");
  assert(classifyLocationFieldLabel("Description 1") === "description", "legacy Description 1");
  assert(classifyLocationFieldLabel("POIs") === "pois", "label POIs");
  assert(classifyLocationFieldLabel("Points of Interest") === "pois", "label Points of Interest");
  assert(classifyLocationFieldLabel("Description 2") === "pois", "legacy Description 2");
  assert(classifyLocationFieldLabel("Session Notes") === "sessionNotes", "label Session Notes");
  assert(classifyLocationFieldLabel("Session Notes…") === "sessionNotes", "label Session Notes…");
  assert(classifyLocationFieldLabel("Description 3") === "sessionNotes", "legacy Description 3");
  assert(classifyLocationFieldLabel("Description 4") === "leftover", "legacy Description 4 is leftover");

  const classified = classifyLocationFieldDrawings([
    { id: "d1", text: "Description" },
    { id: "d2", text: "POIs" },
    { id: "d3", text: "Session Notes" },
    { id: "d4", text: "Description 4" },
    { id: "other", text: "Title card" }
  ]);
  assert(classified.description?.id === "d1", "classify picks Description box");
  assert(classified.pois?.id === "d2", "classify picks POIs box");
  assert(classified.sessionNotes?.id === "d3", "classify picks Session Notes box");
  assert(
    classified.leftovers.map((d) => d.id).join(",") === "d4",
    "Description 4 goes to leftovers"
  );
  assert(classified.managed.length === 4, "managed count excludes unrelated drawings");

  const legacy = classifyLocationFieldDrawings([
    { id: "a", text: "Description 1" },
    { id: "b", name: "Description 2" },
    { id: "c", text: "Description 3" }
  ]);
  assert(legacy.description?.id === "a" && legacy.pois?.id === "b" && legacy.sessionNotes?.id === "c", "legacy 1/2/3 map");
}

// Landing PC slots: party-size layouts ({n}P{m})
{
  const mk = (name) => ({ id: name, name });
  const all = [
    ...[1, 2, 3].map((i) => mk(`3P${i}`)),
    ...[1, 2, 3, 4].map((i) => mk(`4P${i}`)),
    ...[1, 2, 3, 4, 5].map((i) => mk(`5P${i}`)),
    ...[1, 2, 3, 4, 5, 6].map((i) => mk(`6P${i}`)),
    mk("Ibby"),
    mk("Player Character"),
    mk("1A1")
  ];
  const names = (n) => selectLandingPcSlots(all, n).map((t) => t.name);
  assert(names(0).join(",") === "", "0 PCs → no slots");
  assert(names(1).join(",") === "3P2", "1 PC → centred 3P2");
  assert(names(2).join(",") === "4P2,4P3", "2 PCs → centred 4P2+4P3");
  assert(names(3).join(",") === "3P1,3P2,3P3", "3 PCs → 3P row");
  assert(names(4).join(",") === "4P1,4P2,4P3,4P4", "4 PCs → 4P row");
  assert(names(5).join(",") === "5P1,5P2,5P3,5P4,5P5", "5 PCs → 5P row");
  assert(names(6).join(",") === "6P1,6P2,6P3,6P4,6P5,6P6", "6 PCs → 6P row");
  assert(names(8).join(",") === "6P1,6P2,6P3,6P4,6P5,6P6", "7+ PCs → 6P row (overflow elsewhere)");
  assert(
    selectLandingPcSlots(all, 5).every((t) => /^5P\d$/i.test(t.name)),
    "5-seat pick never mixes other party-size rows"
  );
}

// Description vs session notes helpers
{
  assert(
    locationDescriptionText({ fields: { notes: "GM only", appearance: "A dusty hall" } }) ===
      "A dusty hall",
    "description uses appearance, not notes"
  );
  assert(
    locationDescriptionText({ fields: { notes: "GM only" } }) === "",
    "description ignores fields.notes when description/appearance absent"
  );
  assert(
    locationSessionNotesText({ fields: { session_notes: "Watch the door" } }) === "Watch the door",
    "session notes from fields.session_notes"
  );
  assert(
    locationSessionNotesText({ fields: { session_note: "Quiet night" } }) === "Quiet night",
    "session notes from fields.session_note"
  );
  assert(
    locationSessionNotesText({}, { sessionNotes: "From manifest" }) === "From manifest",
    "session notes fall back to manifest.sessionNotes"
  );
  assert(
    locationSessionNotesText({ fields: { sessionNotes: "Doc wins" } }, { sessionNotes: "Manifest" }) ===
      "Doc wins",
    "document session notes beat manifest"
  );
}

// Challenge enemies from links + fields + reverse NPC links
{
  const enemies = collectChallengeEnemies(
    { id: "ch_fight" },
    {
      links: [{ target_type: "npc", target_id: "npc_a", count: 2 }],
      fields: { enemies: [{ id: "npc_b", quantity: 3 }] }
    },
    {
      npcDocuments: [
        {
          id: "npc_c",
          raw: { links: [{ target_type: "challenge", target_id: "ch_fight" }] }
        }
      ]
    }
  );
  const byId = Object.fromEntries(enemies.map((e) => [e.npcId, e.count]));
  assert(byId.npc_a === 2, "enemy count from challenge link");
  assert(byId.npc_b === 3, "enemy count from fields.enemies");
  assert(byId.npc_c === 1, "enemy from NPC→challenge link");
}

// DLCE-shaped enemy rows: world_document_id wins over name; count honored; no double count with link
{
  const npcDocuments = [
    { id: "npc_imp", name: "Imp", raw: { id: "npc_imp", name: "Imp" } },
    { id: "npc_devil", name: "Devil", raw: { id: "npc_devil", name: "Devil" } }
  ];
  const enemies = collectChallengeEnemies(
    { id: "ch_fight" },
    {
      links: [{ target_type: "npc", target_id: "npc_imp" }],
      fields: {
        enemies: [
          {
            world_document_id: "npc_imp",
            name: "Imp",
            level: 1,
            count: 2,
            disposition: "hostile"
          },
          { world_document_id: "npc_devil", name: "Devil", level: 3, count: 1, disposition: "hostile" }
        ]
      }
    },
    { npcDocuments }
  );
  const byId = Object.fromEntries(enemies.map((e) => [e.npcId, e]));
  assert(byId.npc_imp?.count === 2, "world_document_id row count honored (link not double-counted)");
  assert(byId.npc_devil?.count === 1, "second DLCE enemy row");
  assert(!byId.Imp && !byId.Devil, "no name-keyed enemy ids when world_document_id present");
  assert(byId.npc_imp.disposition === -1, "hostile disposition mapped to -1");

  // JSON-string field (DLCE sometimes stores fields as strings)
  const fromString = collectChallengeEnemies(
    { id: "ch_x" },
    { fields: { enemies: JSON.stringify([{ world_document_id: "npc_imp", name: "Imp", count: 3 }]) } },
    { npcDocuments }
  );
  assert(fromString[0]?.npcId === "npc_imp" && fromString[0].count === 3, "JSON string enemies");

  // Name-only row resolves to NPC id through npcDocuments
  const byName = collectChallengeEnemies(
    { id: "ch_y" },
    { fields: { enemies: [{ name: "Imp", count: 2 }] } },
    { npcDocuments }
  );
  assert(byName[0]?.npcId === "npc_imp" && byName[0].count === 2, "name fallback resolves to NPC id");

  const { tokenDispositionFromPackage } = await import("./packageLinks.mjs");
  assert(tokenDispositionFromPackage("hostile") === -1, "hostile → -1");
  assert(tokenDispositionFromPackage("friendly") === 1, "friendly → 1");
  assert(tokenDispositionFromPackage("neutral") === 0, "neutral → 0");
  assert(tokenDispositionFromPackage(undefined) === undefined, "missing disposition");

  const spec = tokenPlacementSpec({
    actor: { id: "a", uuid: "Actor.a", name: "Imp", prototypeToken: {} },
    linked: false,
    kind: "battle-enemy",
    disposition: byId.npc_imp.disposition
  });
  const layout = layoutBattlemapRosterLines({
    metrics: { width: 4000, height: 3000, sceneWidth: 4000, sceneHeight: 2000, sceneX: 0, sceneY: 0, mapBottom: 2000, canvasBottom: 3000, gridSize: 100 },
    grid: 100,
    enemySpecs: [spec],
    partySpecs: [
      { name: "Ibby", actorId: "pc", actorUuid: "Actor.pc", linked: true, kind: "battle-pc", width: 1, height: 1 }
    ]
  });
  assert(layout.enemyTokens[0].disposition === -1, "enemy token disposition hostile");
  assert(layout.enemyTokens[0].actorLink === false, "enemy token unlinked");
  assert(layout.partyTokens[0].actorLink === true, "PC token linked");
  assert(layout.partyTokens[0].disposition === 1, "PC token disposition Friendly");
  assert(layout.partyTokens[0].displayName === 30, "party token Hovered by Anyone");
  assert(
    layout.enemyTokens[0].flags?.healthEstimate?.hideHealthEstimate === false,
    "battlemap enemy Estimates visible"
  );
  assert(
    layout.partyTokens[0].flags?.healthEstimate?.hideHealthEstimate === false,
    "battlemap party Estimates visible"
  );
}

// Health Estimate visibility by scene kind
{
  const { healthEstimateTokenFlags } = await import("./tokenArt.mjs");
  assert(
    healthEstimateTokenFlags(true).healthEstimate.hideHealthEstimate === true,
    "hide flag for location/landing"
  );
  assert(
    healthEstimateTokenFlags(false).healthEstimate.hideHealthEstimate === false,
    "show flag for battlemap"
  );

  // Location NPC placement writes hide=true onto the token flags.
  const npcUpdates = [];
  const stubLoc = {
    name: "📍 Loc",
    width: 2000,
    height: 1500,
    drawings: { contents: [] },
    tokens: {
      contents: [
        {
          id: "tok1",
          name: "1A1",
          flags: { healthEstimate: { hideHealthEstimate: false } }
        }
      ]
    },
    async updateEmbeddedDocuments(type, docs) {
      if (type === "Token") {
        npcUpdates.push(...docs);
      }
    },
    async deleteEmbeddedDocuments() {},
    async createEmbeddedDocuments() {
      return [];
    }
  };
  // Re-use listNpcSlots via finalizeLocationScene
  const { finalizeLocationScene } = await import("./scenePlacement.mjs");
  await finalizeLocationScene(stubLoc, {
    npcs: [{ actor: { id: "npc1", uuid: "Actor.npc1", name: "Garquillax", prototypeToken: {} } }],
    skipItemPiles: true
  });
  assert(npcUpdates.length === 1, "location NPC token updated");
  assert(npcUpdates[0].actorLink === true, "non-combat location NPC stays linked");
  npcUpdates.length = 0;
  stubLoc.tokens.contents.forEach((t) => (t.flags = {}));
  await finalizeLocationScene(stubLoc, {
    npcs: [{ actor: { id: "npc2", uuid: "Actor.npc2", name: "Bandit", prototypeToken: { actorLink: false } } }],
    skipItemPiles: true
  });
  assert(
    npcUpdates[0]?.actorLink === false,
    "combat enemy on a location follows its unlinked prototype (base actor untouched)"
  );
  assert(
    npcUpdates[0].flags?.healthEstimate?.hideHealthEstimate === true,
    "location NPC Health Estimate hidden"
  );

  const pcUpdates = [];
  const stubLanding = {
    name: "Landing",
    width: 1920,
    height: 1080,
    grid: { size: 100 },
    drawings: { contents: [] },
    tokens: {
      contents: [
        { id: "p1", name: "3P1", x: 10, y: 10, width: 1, height: 1, flags: {} },
        { id: "p2", name: "3P2", x: 20, y: 10, width: 1, height: 1, flags: {} },
        { id: "p3", name: "3P3", x: 30, y: 10, width: 1, height: 1, flags: {} }
      ]
    },
    async updateEmbeddedDocuments(type, docs) {
      if (type === "Token") {
        pcUpdates.push(...docs);
      }
    },
    async deleteEmbeddedDocuments() {},
    async createEmbeddedDocuments() {
      return [];
    }
  };
  const { finalizeLandingScene } = await import("./scenePlacement.mjs");
  await finalizeLandingScene(stubLanding, [
    { actor: { id: "pc1", uuid: "Actor.pc1", name: "Ibby", prototypeToken: {} } }
  ]);
  assert(pcUpdates.length === 1, "landing PC token updated");
  assert(
    pcUpdates[0].flags?.healthEstimate?.hideHealthEstimate === true,
    "landing PC Health Estimate hidden"
  );
}

// Battlemap PC token uses knownAs, not full actor name
{
  const spec = tokenPlacementSpec({
    actor: { id: "pc", uuid: "Actor.pc", name: "Isabella Brightblade", prototypeToken: {} },
    linked: true,
    kind: "battle-pc",
    tokenName: "Ibby"
  });
  assert(spec.name === "Ibby", "battlemap PC token name is knownAs");
}

// Scene sequence: LocA → combat@A → LocB → LocC; dialogue combat excluded
{
  assert(padSceneOrder(1) === "01" && padSceneOrder(12) === "12", "padSceneOrder");
  assert(
    formatSceneDmName("location", { name: "Dock" }, 1) === "01. 📍 Dock",
    "location DM name"
  );
  {
    const { formatSpecialSceneName } = await import("./sceneOrder.mjs");
    const manifest = { displayCode: "DL304", sessionCode: "SESSION_012" };
    assert(
      formatSpecialSceneName("landing", manifest, 12) === "00. DL304 Landing Page",
      "landing scene name"
    );
    assert(
      formatSpecialSceneName("outro", manifest, 12) === "13. DL304 Outro Page",
      "outro scene name"
    );
    assert(
      formatSpecialSceneName("leftovers", manifest, 12) === "14. DL304 Leftovers",
      "leftovers scene name"
    );
  }
  assert(
    formatSceneDmName("battlemap", { name: "Ambush" }, 2) === "02. ⚔️ Ambush",
    "battlemap DM name"
  );
  assert(
    formatSceneDmName("battlemap", { name: "Invisible Whispers" }, 2) ===
      "02. ⚔️ Invisible Whispers",
    "battlemap emoji name format"
  );
  assert(
    isCombatChallengeEntry({ type: "challenge", subtype: "combat" }, { fields: { kind: "combat" } }),
    "combat challenge detected"
  );
  assert(
    !isCombatChallengeEntry(
      { type: "challenge", subtype: "dialogue" },
      { fields: { kind: "dialogue" } }
    ),
    "dialogue challenge excluded"
  );

  const docs = {
    "documents/ch_ambush.json": { fields: { kind: "combat" } },
    "documents/ch_talk.json": { fields: { kind: "dialogue" } },
    "documents/ch_brawl.json": { fields: { kind: "combat" } }
  };
  const readDocument = (file) => docs[file] ?? null;
  const fallbackManifest = {
    documents: [
      { id: "loc_a", type: "location", name: "LocA", file: "documents/loc_a.json", msdOrder: 1 },
      { id: "loc_b", type: "location", name: "LocB", file: "documents/loc_b.json", msdOrder: 2 },
      { id: "loc_c", type: "location", name: "LocC", file: "documents/loc_c.json", msdOrder: 3 },
      {
        id: "ch_ambush",
        type: "challenge",
        name: "Ambush",
        file: "documents/ch_ambush.json",
        locationIds: ["loc_a"]
      },
      {
        id: "ch_talk",
        type: "challenge",
        name: "Talk",
        file: "documents/ch_talk.json",
        locationIds: ["loc_a"],
        subtype: "dialogue"
      },
      {
        id: "ch_brawl",
        type: "challenge",
        name: "Brawl",
        file: "documents/ch_brawl.json",
        locationIds: ["loc_b"]
      }
    ]
  };
  const seq = buildMsdSceneSequence(fallbackManifest, { readDocument });
  assert(
    seq.map((row) => row.entry.id).join(",") === "loc_a,ch_ambush,loc_b,ch_brawl,loc_c",
    `fallback sequence LocA→combat@A→LocB→combat@B→LocC (got ${seq.map((r) => r.entry.id).join(",")})`
  );
  assert(!seq.some((row) => row.entry.id === "ch_talk"), "dialogue combat excluded from sequence");
  assert(seq[0].order === 1 && seq[1].kind === "battlemap", "orders start at 1; combat is battlemap");

  // Unified msdOrder path (locations + combat challenges all ordered)
  const unifiedManifest = {
    documents: [
      { id: "loc_c", type: "location", name: "LocC", file: "documents/loc_c.json", msdOrder: 4 },
      { id: "loc_a", type: "location", name: "LocA", file: "documents/loc_a.json", msdOrder: 1 },
      {
        id: "ch_ambush",
        type: "challenge",
        name: "Ambush",
        file: "documents/ch_ambush.json",
        locationIds: ["loc_a"],
        msdOrder: 2
      },
      { id: "loc_b", type: "location", name: "LocB", file: "documents/loc_b.json", msdOrder: 3 },
      {
        id: "ch_talk",
        type: "challenge",
        name: "Talk",
        file: "documents/ch_talk.json",
        locationIds: ["loc_b"],
        subtype: "dialogue",
        msdOrder: 99
      }
    ]
  };
  const unified = buildMsdSceneSequence(unifiedManifest, { readDocument });
  assert(
    unified.map((row) => row.entry.id).join(",") === "loc_a,ch_ambush,loc_b,loc_c",
    `unified msdOrder sequence (got ${unified.map((r) => r.entry.id).join(",")})`
  );
  assert(
    formatSceneDmName(unified[1].kind, unified[1].entry, unified[1].order) ===
      "02. ⚔️ Ambush",
    "unified battlemap keeps sequential DM name"
  );

  // Reverse hosts: combat with empty locationIds still interleaves after host location
  const reverseHostDocs = {
    "documents/loc_a.json": {
      links: [{ target_type: "challenge", target_id: "ch_ambush", relation: "hosts" }]
    },
    "documents/ch_ambush.json": { fields: { kind: "combat" } },
    "documents/ch_talk.json": { fields: { kind: "dialogue" } },
    "documents/ch_brawl.json": { fields: { kind: "combat" } }
  };
  const reverseSeq = buildMsdSceneSequence(
    {
      documents: [
        { id: "loc_a", type: "location", name: "LocA", file: "documents/loc_a.json", msdOrder: 1 },
        { id: "loc_b", type: "location", name: "LocB", file: "documents/loc_b.json", msdOrder: 2 },
        {
          id: "ch_ambush",
          type: "challenge",
          name: "Ambush",
          file: "documents/ch_ambush.json",
          locationIds: []
        },
        {
          id: "ch_talk",
          type: "challenge",
          name: "Talk",
          file: "documents/ch_talk.json",
          locationIds: [],
          subtype: "dialogue"
        }
      ]
    },
    { readDocument: (file) => reverseHostDocs[file] ?? null }
  );
  assert(
    reverseSeq.map((row) => row.entry.id).join(",") === "loc_a,ch_ambush,loc_b",
    `reverse-host sequence (got ${reverseSeq.map((r) => r.entry.id).join(",")})`
  );
}

// MSD → Foundry journal: title/h2 UUID links + ../assets rewrite + challenge h2
{
  const msdHtml = `<!doctype html>
<article class="dlce-v2-msd-page dlce-v2-msd-title-page" data-msd-session-title="Misty Lake">
  <div class="dlce-v2-msd-title-logo" role="img" aria-label="the Damned Lucky"></div>
  <div class="dlce-v2-msd-title-session-name" data-msd-title="Misty Lake">Misty Lake</div>
  <div class="dlce-v2-msd-h1" role="heading" aria-level="1">Contents</div>
</article>
<div class="dlce-v2-msd-flow-source" hidden aria-hidden="true">
  <section class="dlce-v2-msd-location" data-msd-location-id="loc_a" data-msd-host-id="loc_a" data-msd-label="LocA" draggable="true">
    <div class="dlce-v2-msd-h2" role="heading" aria-level="2"><h2>📍 LocA</h2></div>
    <img class="dlce-v2-msd-art is-location" src="../assets/location/loc_a.webp" alt="LocA">
    <p class="dlce-v2-msd-body">See <span data-msd-related-id="npc_kira">Kira</span>.</p>
    <section class="dlce-v2-msd-child is-challenge" data-msd-wd-id="ch_ambush" data-msd-label="Ambush" draggable="true">
      <div class="dlce-v2-msd-h3" role="heading" aria-level="3"><p>⚔️ Ambush</p></div>
      <img src="../assets/location/battlemaps/loc_a.webp" alt="Ambush map">
    </section>
  </section>
</div>
<div class="dlce-v2-msd-appendix-source" hidden aria-hidden="true"><p>Appendix maps</p></div>`;

  const createdByDlceId = new Map([
    ["loc_a", "Scene.locA"],
    ["ch_ambush", "Scene.ambush"],
    ["npc_kira", "Actor.kira"]
  ]);
  const uploaded = new Map([
    ["assets/location/loc_a.webp", "dlfi-imports/pkg/assets/location/loc_a.webp"],
    [
      "assets/location/battlemaps/loc_a.webp",
      "dlfi-imports/pkg/assets/location/battlemaps/loc_a.webp"
    ]
  ]);
  const documents = [
    { id: "loc_a", type: "location", name: "LocA", portrait: "assets/location/loc_a.webp" },
    { id: "ch_ambush", type: "challenge", name: "Ambush" }
  ];
  const journal = convertMsdHtmlForFoundry(msdHtml, { createdByDlceId, uploaded, documents });
  assert(/<h1\b[^>]*>Misty Lake<\/h1>/.test(journal), "title session name promoted to h1");
  assert(/<h1\b[^>]*>Contents<\/h1>/.test(journal), "msd h1 div promoted");
  assert(!/<h2><h2>/.test(journal), "nested location h2 flattened");
  assert(
    journal.includes("@UUID[Scene.locA]{LocA}"),
    "location h2 linked to scene UUID"
  );
  assert(
    /<h2\b[^>]*>@UUID\[Scene\.ambush\]\{Ambush\}<\/h2>/.test(journal),
    "challenge heading promoted to h2 with UUID"
  );
  assert(journal.includes("@UUID[Actor.kira]{Kira}"), "related-id span → @UUID");
  assert(
    /src="dlfi-imports\/pkg\/assets\/location\/loc_a\.webp"/.test(journal),
    "../assets location art rewritten"
  );
  assert(
    /src="dlfi-imports\/pkg\/assets\/location\/battlemaps\/loc_a\.webp"/.test(journal),
    "../assets battlemap art rewritten"
  );
  assert(!/\.\.\/assets\//.test(journal), "no leftover ../assets paths");
  assert(!/dlce-v2-msd-title-logo/.test(journal), "logo overlay stripped");
  assert(!/\bdraggable=/.test(journal), "draggable attrs stripped");
  assert(!/\bhidden\b/.test(journal) || !/flow-source/.test(journal), "flow chrome unwrapped");
  assert(journal.includes("Appendix maps"), "appendix content included");
}

// PC actor stub for DDB importer + battlemap roster layout
{
  assert(parseDdbCharacterId("https://www.dndbeyond.com/characters/118758199") === "118758199", "parse DDB id");
  assert(pcActorTemplate.type === "character", "bundled PC template is character");
  assert(pcActorTemplate.system?.abilities, "bundled PC template keeps dnd5e system scaffold");
  assert(isMissingPcArt(DEFAULT_PC_ART), "default system icon counts as missing art");
  assert(!isMissingPcArt("world/ibby.webp"), "package art is present");

  const stub = buildPcActorData(
    {
      id: "pc_ibby",
      name: "Isabella Brightblade",
      knownAs: "Ibby",
      playerName: "Alex",
      playerId: "player_alex",
      ddbUrl: "https://www.dndbeyond.com/characters/118758199",
      ddbId: "118758199"
    },
    {
      portrait: "world/ibby.webp",
      token: "world/ibby_token.webp",
      tokenScale: 1.1,
      template: pcActorTemplate
    }
  );
  assert(stub.type === "character", "PC stub is character");
  assert(stub.name === "Ibby", "PC actor name is knownAs");
  assert(stub.flags?.dlfi?.fullName === "Isabella Brightblade", "PC flags keep full name");
  assert(stub.flags?.dlfi?.knownAs === "Ibby", "PC flags keep knownAs");
  assert(stub.flags?.dlfi?.playerName === "Alex", "PC flags keep playerName");
  assert(stub.flags?.dlfi?.playerId === "player_alex", "PC flags keep playerId");
  assert(stub.system?.abilities, "PC stub clones template system");
  assert(stub.flags?.ddbimporter?.dndbeyond?.url?.includes("118758199"), "DDB url flag");
  assert(stub.flags?.ddbimporter?.dndbeyond?.characterId === "118758199", "DDB characterId flag");
  assert(stub.prototypeToken?.actorLink === true, "PC prototype linked");
  assert(stub.prototypeToken?.disposition === 1, "PC prototype Friendly");
  assert(stub.prototypeToken?.name === "Ibby", "PC default token uses knownAs");
  assert(stub.prototypeToken?.displayName === 30, "PC default token Hovered by Anyone");
  assert(stub.prototypeToken?.texture?.src === "world/ibby_token.webp", "PC token art");
  assert(stub.prototypeToken?.texture?.scaleX === 1.1, "PC VTTTT scale");
  assert(stub.img === "world/ibby.webp", "PC portrait from package");

  const noDdb = buildPcActorData(
    { id: "pc_raw", name: "Raw PC", knownAs: "Raw" },
    { template: pcActorTemplate }
  );
  assert(!noDdb.flags?.ddbimporter?.dndbeyond?.url, "missing DDB leaves url empty");
  assert(!noDdb.flags?.ddbimporter?.dndbeyond?.characterId, "missing DDB leaves characterId empty");

  const existing = {
    name: "Isabella Brightblade",
    img: "world/existing.webp",
    prototypeToken: {
      name: "Ibby",
      texture: { src: "world/existing_token.webp", scaleX: 1, scaleY: 1 }
    },
    flags: {
      ddbimporter: {
        dndbeyond: {
          url: "https://www.dndbeyond.com/characters/118758199",
          characterId: "118758199"
        }
      }
    }
  };
  assert(actorHasDdbLink(existing), "existing actor reports DDB link");
  const fillKeep = buildExistingPcFillPatch(
    existing,
    {
      name: "Isabella Brightblade",
      knownAs: "Ibby2",
      playerName: "Alex",
      playerId: "player_alex",
      ddbUrl: "https://www.dndbeyond.com/characters/999",
      ddbId: "999",
      tokenScale: 2
    },
    { portrait: "world/new.webp", token: "world/new_token.webp", tokenScale: 2 }
  );
  assert(fillKeep.img === "world/new.webp", "fill-only applies package portrait over DDB/existing");
  assert(
    fillKeep["prototypeToken.texture.src"] === "world/new_token.webp",
    "fill-only applies package token over DDB/existing"
  );
  assert(fillKeep["prototypeToken.texture.scaleX"] === 2, "fill-only applies package token scale");
  assert(fillKeep.name === "Ibby2", "fill-only refreshes actor name to knownAs");
  assert(fillKeep["prototypeToken.name"] === "Ibby2", "fill-only refreshes Known as on token");
  assert(fillKeep["flags.dlfi.fullName"] === "Isabella Brightblade", "fill-only stores full name flag");
  assert(fillKeep["flags.dlfi.playerName"] === "Alex", "fill-only stores playerName");
  assert(fillKeep["flags.dlfi.playerId"] === "player_alex", "fill-only stores playerId");
  assert(!fillKeep["flags.ddbimporter.dndbeyond"], "fill-only does not overwrite existing DDB");

  const emptyish = {
    name: "New PC",
    img: DEFAULT_PC_ART,
    prototypeToken: { name: "", texture: { src: DEFAULT_PC_ART } },
    flags: {}
  };
  const fillMissing = buildExistingPcFillPatch(
    emptyish,
    {
      name: "New PC",
      knownAs: "Newbie",
      ddbUrl: "https://www.dndbeyond.com/characters/42",
      ddbId: "42",
      tokenScale: 1.25
    },
    { portrait: "world/new.webp", token: "world/new_token.webp", tokenScale: 1.25 }
  );
  assert(fillMissing.img === "world/new.webp", "fill-only sets missing portrait");
  assert(fillMissing["prototypeToken.texture.src"] === "world/new_token.webp", "fill-only sets missing token");
  assert(fillMissing.name === "Newbie", "fill-only sets actor name to knownAs");
  assert(fillMissing["prototypeToken.name"] === "Newbie", "fill-only sets missing Known as");
  assert(fillMissing["flags.ddbimporter.dndbeyond"]?.characterId === "42", "fill-only sets missing DDB");

  const metrics = {
    width: 4800,
    height: 6600,
    sceneWidth: 3200,
    sceneHeight: 4400,
    sceneX: 800,
    sceneY: 1100,
    mapBottom: 5500,
    canvasBottom: 6600,
    gridSize: 200
  };
  const enemySpecs = [
    {
      name: "Imp 1",
      actorId: "a1",
      actorUuid: "Actor.a1",
      linked: false,
      kind: "battle-enemy",
      width: 1,
      height: 1,
      textureSrc: "imp.webp"
    },
    {
      name: "Imp 2",
      actorId: "a1",
      actorUuid: "Actor.a1",
      linked: false,
      kind: "battle-enemy",
      width: 1,
      height: 1,
      textureSrc: "imp.webp"
    },
    {
      name: "Devil",
      actorId: "a2",
      actorUuid: "Actor.a2",
      linked: false,
      kind: "battle-enemy",
      width: 2,
      height: 2,
      textureSrc: "devil.webp"
    }
  ];
  const partySpecs = [
    {
      name: "Ibby",
      actorId: "pc1",
      actorUuid: "Actor.pc1",
      linked: true,
      kind: "battle-pc",
      width: 1,
      height: 1,
      textureSrc: "ibby.webp"
    },
    {
      name: "Owl",
      actorId: "pet1",
      actorUuid: "Actor.pet1",
      linked: true,
      kind: "battle-pet",
      width: 0.5,
      height: 0.5,
      textureSrc: "owl.webp"
    }
  ];
  const layout = layoutBattlemapRosterLines({
    metrics,
    grid: 200,
    enemySpecs,
    partySpecs
  });
  assert(layout.partyTokens.length === 2, "party tokens created");
  assert(layout.enemyTokens.length === 3, "enemy tokens created");
  assert(layout.partyBaseline === 6600, "party flush to canvas bottom");
  // Large devil (2sq) sits lower than mediums on same baseline.
  const devil = layout.enemyTokens.find((t) => t.name === "Devil");
  const imp = layout.enemyTokens.find((t) => t.name === "Imp 1");
  assert(devil && imp, "devil and imp present");
  assert(devil.width === 2 && devil.height === 2, "enemy footprint copied");
  // Same baseline at canvas bottom: Large tokens have smaller y (extend further up).
  assert(devil.y < imp.y, "large enemy extends upward from shared baseline");
  assert(devil.actorLink === false, "enemies unlinked");
  assert(devil.disposition === -1, "enemies Hostile");
  assert(layout.partyTokens[0].actorLink === true, "PCs linked");
  assert(layout.partyTokens[0].disposition === 1, "party Friendly");
  assert(layout.partyTokens[1].disposition === 1, "pets Friendly");
  // Footprint spacing: devil starts after two 1-square imps + gaps
  assert(devil.x > imp.x, "enemies spaced left-to-right by footprint");
  // Enemy tops should sit at/below map bottom when padding allows
  assert(imp.y >= metrics.mapBottom || devil.y >= metrics.mapBottom, "roster below map art when possible");

  const fakeActor = {
    id: "x",
    uuid: "Actor.x",
    name: "Ogre",
    img: "ogre.png",
    prototypeToken: { width: 2, height: 2, texture: { src: "ogre_token.png" } }
  };
  const spec = tokenPlacementSpec({ actor: fakeActor, linked: false, kind: "battle-enemy" });
  assert(spec.width === 2 && spec.textureSrc === "ogre_token.png", "tokenPlacementSpec from prototype");

  // 1080p map, 0.25 padding, grid 120: Large enemy must not overlap the party row.
  {
    const m1080 = { width: 2880, height: 1620, sceneWidth: 1920, sceneHeight: 1080, sceneX: 480, sceneY: 270, mapBottom: 1350, canvasBottom: 1620, gridSize: 120 };
    const large = { name: "Ogre", actorId: "o", actorUuid: "Actor.o", linked: false, kind: "battle-enemy", width: 2, height: 2 };
    const pcRow = { name: "Ibby", actorId: "pc", actorUuid: "Actor.pc", linked: true, kind: "battle-pc", width: 1, height: 1 };
    const tight = layoutBattlemapRosterLines({ metrics: m1080, grid: 120, enemySpecs: [large], partySpecs: [pcRow] });
    const ogre = tight.enemyTokens[0];
    const ibby = tight.partyTokens[0];
    assert(ogre.y + ogre.height * 120 <= ibby.y, "Large enemy bottom stays above the party row (no overlap)");
  }
  {
    const { withPrototypeTokenData } = await import("./scenePlacement.mjs");
    const savedGame = globalThis.game;
    globalThis.game = {
      actors: {
        get: (id) =>
          id === "proto"
            ? {
                async getTokenDocument(data) {
                  const merged = { _id: "tmp", sight: { enabled: true, range: 60 }, bar1: { attribute: "attributes.hp" }, ...data };
                  return { toObject: () => merged };
                }
              }
            : null
      }
    };
    const [merged, bare] = await withPrototypeTokenData([
      { actorId: "proto", name: "Ibby", x: 1 },
      { actorId: "missing", name: "Ghost" }
    ]);
    assert(
      merged.sight?.enabled === true && merged.bar1?.attribute === "attributes.hp" && merged.x === 1 && !("_id" in merged),
      "created tokens inherit prototype sight/bars"
    );
    assert(bare.name === "Ghost" && !bare.sight, "token without a world actor keeps its payload");
    globalThis.game = savedGame;
  }

  // sceneCanvasMetrics falls back when dimensions missing
  const m = sceneCanvasMetrics({ width: 1000, height: 2000, grid: { size: 100 } });
  assert(m.canvasBottom === 2000 && m.gridSize === 100, "sceneCanvasMetrics fallback");

  const { finalizeBattlemapScene } = await import("./scenePlacement.mjs");
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(" "));
  try {
    const stubScene = {
      name: "Ambush",
      width: 4000,
      height: 3000,
      grid: { size: 100 },
      dimensions: { width: 4000, height: 3000, sceneWidth: 4000, sceneHeight: 3000, sceneX: 0, sceneY: 0 },
      tokens: [],
      drawings: [],
      async deleteEmbeddedDocuments() {
        return [];
      },
      async createEmbeddedDocuments() {
        return [];
      }
    };
    await finalizeBattlemapScene(stubScene, {
      enemies: [],
      party: [{ actor: null, dlceId: "pc_ibby", label: "Ibby", kind: "battle-pc" }]
    });
  } finally {
    console.warn = originalWarn;
  }
  assert(
    warns.some((line) => /skipped party token pc_ibby/.test(line) && /no actor/.test(line)),
    "party skip logs pc id and reason"
  );
}

// Prototype tokens: lock rotation, hover names, combat unlink, wildcard art
{
  const { collectCombatEnemyIds } = await import("./packageLinks.mjs");
  const {
    buildTokenWildcard,
    discoverTokenSlotPaths,
    isWildcardPath,
    pickTokenTexture,
    resolveNpcTokenSlots,
    wildcardToRegExp
  } = await import("./tokenArt.mjs");

  const baseRaw = { fields: { name: "Goblin", creature_size: "Small" } };
  const baseEntry = { id: "npc_goblin", name: "Goblin", type: "npc" };

  const friendly = buildNpcNpcActorData(baseRaw, baseEntry, { token: "w/goblin.webp" });
  assert(friendly.prototypeToken.actorLink === true, "non-combat NPC stays linked");
  assert(friendly.prototypeToken.disposition === 0, "non-combat NPC prototype Neutral");
  assert(friendly.prototypeToken.lockRotation === true, "NPC lockRotation on");
  assert(friendly.prototypeToken.displayName === 30, "NPC displayName is Hovered by Anyone (30)");

  const enemy = buildNpcNpcActorData(baseRaw, baseEntry, { token: "w/goblin.webp", combatEnemy: true });
  assert(enemy.prototypeToken.actorLink === false, "combat enemy prototype unlinked");
  assert(enemy.prototypeToken.disposition === -1, "combat enemy prototype Hostile");
  assert(enemy.prototypeToken.lockRotation === true, "combat enemy lockRotation on");
  assert(enemy.prototypeToken.displayName === 30, "combat enemy displayName hover");
  assert(!enemy.prototypeToken.randomImg, "single token does not randomise");

  const uploaded = new Map(
    [
      "assets/npc/npc_goblin.webp",
      "assets/npc/tokens/npc_goblin_2.webp",
      "assets/npc/tokens/npc_goblin_10.webp",
      "assets/npc/tokens/npc_goblin_1.webp",
      "assets/npc/tokens/npc_orc_1.webp",
      "assets/npc/tokens/npc_orc_2.webp"
    ].map((path) => [path, `dlfi-imports/S1__x__stamp/${path}`])
  );
  assert(
    discoverTokenSlotPaths("npc_goblin", uploaded).join(",") ===
      [1, 2, 10].map((n) => `assets/npc/tokens/npc_goblin_${n}.webp`).join(","),
    "discover sequential token slots (numeric order)"
  );
  assert(
    buildTokenWildcard(["a/n_1.webp", "a/n_2.webp"]) === "a/n_*.webp",
    "wildcard from sequential slots"
  );
  assert(wildcardToRegExp("a/n_*.webp").test("a/n_3.webp"), "wildcard regexp matches");

  const media = resolveNpcMedia(baseEntry, uploaded);
  assert(media.tokenSlots.length === 3, "resolveNpcMedia finds 3 token slots");
  assert(
    media.tokenWildcard === "dlfi-imports/S1__x__stamp/assets/npc/tokens/npc_goblin_*.webp",
    "world wildcard path rooted in imports tree"
  );
  assert(media.token === media.tokenSlots[0], "token falls back to first slot");
  assert(
    resolveNpcMedia({ id: "npc_solo" }, new Map([["assets/npc/tokens/npc_solo_1.webp", "w/s1.webp"]]))
      .tokenSlots.length === 0,
    "single numbered token is not a wildcard"
  );

  const declared = resolveNpcTokenSlots(
    {
      id: "npc_x",
      tokens: ["assets/npc/tokens/z_b.webp", "assets/npc/tokens/z_a.webp"]
    },
    new Map([
      ["assets/npc/tokens/z_a.webp", "w/z_a.webp"],
      ["assets/npc/tokens/z_b.webp", "w/z_b.webp"]
    ])
  );
  assert(declared.slots.length === 2 && declared.wildcard === "w/z_*.webp", "declared tokens[] wildcard");

  const explicit = resolveNpcTokenSlots(
    { id: "npc_goblin", tokenWildcard: "assets/npc/tokens/npc_goblin_*.webp" },
    uploaded
  );
  assert(explicit.slots.length === 3, "explicit tokenWildcard expands uploaded matches");

  const guards = new Map(
    ["assets/npc/tokens/npc_guard1.webp", "assets/npc/tokens/npc_guard2.webp"].map((p) => [p, `w/${p}`])
  );
  assert(
    discoverTokenSlotPaths("npc_guard", guards).length === 0,
    "npc_guard1 / npc_guard2 (no separator) are not slots of npc_guard"
  );
  const captainClash = new Map(
    [
      "assets/npc/tokens/npc_guard_1.webp",
      "assets/npc/tokens/npc_guard_2.webp",
      "assets/npc/tokens/npc_guard_captain_1.webp"
    ].map((p) => [p, `w/${p}`])
  );
  const clash = resolveNpcTokenSlots({ id: "npc_guard" }, captainClash);
  assert(
    clash.wildcard === null && clash.firstSlot === "w/assets/npc/tokens/npc_guard_1.webp",
    "wildcard that would also match another NPC's token is dropped (first slot used)"
  );
  assert(
    resolveNpcMedia({ id: "npc_guard" }, captainClash).token === "w/assets/npc/tokens/npc_guard_1.webp",
    "resolveNpcMedia uses first slot when no safe wildcard"
  );
  assert(
    discoverTokenSlotPaths("npc_guard", new Map([["assets/npc/tokens/npc_guard_1.webp", "a"], ["assets/npc/tokens/npc_guard_2.webp", "b"]]), {
      npcIds: ["npc_guard", "npc_guard_2"]
    }).length === 1,
    "slot stem that is another manifest NPC id is skipped"
  );
  const staleWildcard = resolveNpcTokenSlots(
    { id: "npc_goblin", tokenWildcard: "assets/npc/tokens/missing_*.webp" },
    uploaded
  );
  assert(
    staleWildcard.wildcard === "dlfi-imports/S1__x__stamp/assets/npc/tokens/npc_goblin_*.webp",
    "declared wildcard that matched nothing is not used as texture.src"
  );
  assert(
    buildTokenWildcard(["assets/npc/tokens/a_1.webp", "assets/npc/tokens/b_2.webp"]) === null,
    "no folder-wide wildcard for unrelated slot names"
  );

  const multi = buildNpcNpcActorData(baseRaw, baseEntry, {
    token: media.token,
    tokenSlots: media.tokenSlots,
    tokenWildcard: media.tokenWildcard,
    combatEnemy: true,
    tokenScale: 1.1
  });
  assert(multi.prototypeToken.randomImg === true, "multi-slot NPC randomImg");
  assert(isWildcardPath(multi.prototypeToken.texture.src), "multi-slot texture.src contains *");
  assert(multi.prototypeToken.texture.scaleX === 1.1, "token scale preserved with wildcard");
  assert(multi.flags.dlfi.tokenSlots.length === 3, "token slots kept in flags for placement");

  const fakeMulti = { img: "p.webp", prototypeToken: multi.prototypeToken, flags: multi.flags };
  assert(!isWildcardPath(pickTokenTexture(fakeMulti, 4)), "placement picks concrete slot");
  assert(pickTokenTexture(fakeMulti, 1) === media.tokenSlots[1], "placement cycles slots");
  assert(
    pickTokenTexture({ img: "p.webp", prototypeToken: { texture: { src: "a_*.webp" } } }) === "p.webp",
    "wildcard without slots falls back to portrait"
  );
  assert(
    tokenPlacementSpec({ actor: { id: "a", uuid: "Actor.a", name: "G", ...fakeMulti } }).textureSrc.includes("*") === false,
    "tokenPlacementSpec avoids wildcard src"
  );

  const ids = collectCombatEnemyIds(
    [{ entry: { id: "chal_1" }, raw: { links: [{ target_type: "npc", target_id: "npc_a", count: 2 }] } }],
    [
      { id: "npc_a", raw: {} },
      { id: "npc_b", raw: { links: [{ target_type: "challenge", target_id: "chal_1" }] } },
      { id: "npc_c", raw: {} }
    ]
  );
  assert(ids.has("npc_a") && ids.has("npc_b") && !ids.has("npc_c"), "combat enemy ids from battlemaps");
}

// Imported session management (mocked Foundry world)
{
  const sessions = await import("./sessions.mjs");
  const calls = { deleted: [], activated: [], settings: {}, nav: [] };

  const mkCollection = (docs) => {
    const list = [...docs];
    list.get = (id) => list.find((doc) => doc.id === id);
    return list;
  };
  const folderFlags = (code, exportedAt, importedAt) => ({
    dlfi: {
      sessionCode: code,
      displayCode: code.replace("SESSION_", "S"),
      sessionName: `Name ${code}`,
      exportedAt,
      importKey: `${code}_${exportedAt.replace(/[:.]/g, "-")}`,
      importedAt
    }
  });
  const mkFolders = (code, exportedAt, importedAt) =>
    ["Actor", "Item", "Scene", "JournalEntry"].map((type) => ({
      id: `f_${code}_${type}`,
      type,
      name: code,
      flags: folderFlags(code, exportedAt, importedAt),
      folder: null,
      async delete() {
        calls.deleted.push(`folder:${this.id}`);
        const index = game.folders.findIndex((f) => f.id === this.id);
        if (index >= 0) game.folders.splice(index, 1);
      }
    }));
  const scene = (id, code, kind, nav = false) => ({
    id,
    folder: { id: `f_${code}_Scene` },
    navigation: nav,
    flags: { dlfi: { kind } },
    async activate() {
      calls.activated.push(id);
    }
  });
  const actor = (id, code, type = "npc") => ({
    id,
    type,
    folder: { id: `f_${code}_Actor` },
    flags: { dlfi: { importKey: `${code}_2026-01-01T00-00-00-000Z` } }
  });

  const folders = [
    ...mkFolders("SESSION_014", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
    ...mkFolders("SESSION_01", "2025-12-01T00:00:00.000Z", "2025-12-02T00:00:00.000Z"),
    { id: "other", type: "Actor", name: "Mine", flags: {}, folder: null }
  ];
  globalThis.game = {
    folders: mkCollection(folders),
    scenes: mkCollection([
      scene("sc_land", "SESSION_014", "landing"),
      scene("sc_loc", "SESSION_014", "location"),
      scene("sc_old", "SESSION_01", "landing", true),
      { id: "sc_user", folder: null, navigation: true, flags: {}, async activate() {} }
    ]),
    actors: mkCollection([
      actor("a_npc", "SESSION_014"),
      actor("a_pc", "SESSION_014", "character"),
      { id: "a_moved", type: "npc", folder: null, flags: { dlfi: { importKey: "SESSION_014_2026-01-01T00-00-00-000Z" } } },
      // Item pile typed as character (Item Piles actorClassType) + orphan outside folder.
      {
        id: "a_pile_char",
        type: "character",
        folder: null,
        flags: {
          dlfi: { kind: "item-pile", importKey: "SESSION_014_2026-01-01T00-00-00-000Z", sessionCode: "SESSION_014" },
          "item-piles": { data: { type: "pile", enabled: true } }
        }
      },
      {
        id: "a_pile_folder",
        type: "npc",
        folder: { id: "f_SESSION_014_Actor" },
        flags: { dlfi: { kind: "item-pile", sessionCode: "SESSION_014" }, "item-piles": { data: { type: "pile" } } }
      },
      actor("a_other", "SESSION_01"),
      { id: "a_user", type: "npc", folder: null, flags: {} }
    ]),
    items: mkCollection([]),
    journal: mkCollection([
      { id: "j1", folder: { id: "f_SESSION_014_JournalEntry" }, flags: {} }
    ]),
    settings: {
      get: (_module, key) => calls.settings[key] ?? (key === "liveSessionKey" ? "SESSION_014::2026-01-01T00:00:00.000Z" : ""),
      set: async (_module, key, value) => {
        calls.settings[key] = value;
      }
    }
  };
  const mkDocClass = (name) => ({
    async deleteDocuments(ids) {
      calls.deleted.push(`${name}:${ids.join(",")}`);
    }
  });
  globalThis.Scene = {
    ...mkDocClass("Scene"),
    async updateDocuments(updates) {
      calls.nav = updates;
    }
  };
  globalThis.Actor = mkDocClass("Actor");
  globalThis.Item = mkDocClass("Item");
  globalThis.JournalEntry = mkDocClass("Journal");

  assert(sessions.importKeyBelongsToSession("SESSION_014_2026-01-01T00-00-00-000Z", "SESSION_014"), "importKey matches session");
  assert(!sessions.importKeyBelongsToSession("SESSION_014_2026-01-01T00-00-00-000Z", "SESSION_01"), "importKey prefix is not ambiguous");
  assert(sessions.isSessionAssetDir("dlfi-imports/SESSION_014__Name__stamp", "SESSION_014"), "asset dir matches {code}__*");
  assert(!sessions.isSessionAssetDir("dlfi-imports/SESSION_0141__x", "SESSION_014"), "asset dir prefix is exact");

  const listed = sessions.listImportedSessions();
  assert(listed.length === 2, "lists two imported sessions");
  assert(listed[0].sessionCode === "SESSION_014", "newest import first");
  assert(listed[0].isLive === true && listed[1].isLive === false, "live flag from setting");
  assert(
    listed[0].counts.scenes === 2 &&
      listed[0].counts.actors === 4 &&
      listed[0].counts.pcs === 1,
    "counts include folder docs + flagged docs + item piles; PCs separate"
  );
  assert(isDlfiItemPileActor(game.actors.get("a_pile_char")), "character-typed pile still a pile");
  assert(
    !sessions.isSessionProtectedPc(game.actors.get("a_pile_char")),
    "item pile actors are never protected PCs"
  );

  const activated = await sessions.activateImportedSession("SESSION_01");
  assert(calls.activated.join(",") === "sc_old", "activate flips Landing scene");
  assert(
    calls.nav.some((u) => u._id === "sc_user" && u.navigation === false) && calls.settings.liveSessionKey === "SESSION_01::2025-12-01T00:00:00.000Z",
    "activate sets exclusive nav + live key"
  );
  assert(activated.landingId === "sc_old", "activate returns landing id");

  FilePickerCalls: {
    const tree = {
      "dlfi-imports": { dirs: ["dlfi-imports/SESSION_014__Name__a", "dlfi-imports/SESSION_01__Other__b", "dlfi-imports/keep"], files: [] },
      "dlfi-imports/SESSION_014__Name__a": { dirs: ["dlfi-imports/SESSION_014__Name__a/assets"], files: [] },
      "dlfi-imports/SESSION_014__Name__a/assets": { dirs: [], files: ["dlfi-imports/SESSION_014__Name__a/assets/x.webp"] }
    };
    const removed = new Set();
    globalThis.FilePicker = {
      async browse(_source, path) {
        if (!tree[path] || removed.has(path)) throw new Error("missing");
        return tree[path];
      },
      async deletePath(_source, path) {
        removed.add(path);
        return true;
      }
    };
    const results = await sessions.deleteImportedSessions(["SESSION_014"], { deleteAssets: true, importsPath: "dlfi-imports" });
    const docs = results[0].docs;
    assert(
      docs.scenes === 2 && docs.actors === 4 && docs.journals === 1 && docs.keptPcs === 1,
      "bulk delete removes session docs + item piles, keeps PCs"
    );
    const actorDelete = calls.deleted.find((d) => d.startsWith("Actor:")) || "";
    assert(actorDelete.includes("a_npc") && actorDelete.includes("a_moved"), "bulk delete includes flagged moved actor");
    assert(
      actorDelete.includes("a_pile_char") && actorDelete.includes("a_pile_folder"),
      "bulk delete removes item-pile actors (even character-typed / folderless)"
    );
    assert(!calls.deleted.some((d) => d.includes("a_pc") || d.includes("a_user") || d.includes("sc_user")), "bulk delete spares PCs and user docs");
    assert(game.folders.every((f) => f.flags?.dlfi?.sessionCode !== "SESSION_014"), "session folders deleted");
    assert(
      calls.settings.liveSessionKey === "SESSION_01::2025-12-01T00:00:00.000Z",
      "live key untouched when deleting a non-live session"
    );
    assert(
      results[0].assets.dirs.length === 1 && removed.has("dlfi-imports/SESSION_014__Name__a/assets/x.webp"),
      "asset tree for {code}__* removed (other sessions untouched)"
    );
    assert(!removed.has("dlfi-imports/SESSION_01__Other__b"), "other session assets untouched");
    assert(/Deleted 1 session/.test(sessions.describeDeleteResults(results)), "delete summary text");
    await sessions.deleteImportedSessions(["SESSION_01"], { deleteAssets: false });
    assert(calls.settings.liveSessionKey === "", "live key cleared when live session deleted");
  }
}

{
  const { PACKAGE_FORMAT_VERSIONS } = await import("../constants.mjs");
  assert([1, 2, 3].every((v) => PACKAGE_FORMAT_VERSIONS.has(v)), "package format versions 1-3 supported");

  const { getFilePicker, isNotFoundError } = await import("../package/filePicker.mjs");
  const { deleteDataFile: delFile } = await import("../package/dataFolders.mjs");
  assert(isNotFoundError(new Error("404 Not Found")) && isNotFoundError({ status: 404 }), "404 errors detected");
  assert(!isNotFoundError(new Error("permission denied")), "non-404 errors not treated as missing");

  // V14-style FilePicker: no deletePath and no /filesystem fallback.
  let fetchCalls = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (..._args) => {
    fetchCalls += 1;
    return { ok: false, status: 404 };
  };
  globalThis.FilePicker = { browse: async () => ({ dirs: [], files: [] }) };
  assert((await delFile("dlfi-imports/SESSION_014/assets/x.webp")) === false, "V14 without deletePath returns false");
  assert((await delFile("dlfi-imports/SESSION_014/assets/y.webp")) === false, "second unsupported delete still false");
  assert(fetchCalls === 0, "deleteDataFile must not POST /filesystem");
  globalThis.fetch = prevFetch;

  // purgeSessionAssets short-circuits after the first failed delete (no network spam).
  {
    const sessions = await import("./sessions.mjs");
    const tree = {
      "dlfi-imports": { dirs: ["dlfi-imports/SESSION_099__Name__a"], files: [] },
      "dlfi-imports/SESSION_099__Name__a": {
        dirs: [],
        files: [
          "dlfi-imports/SESSION_099__Name__a/a.webp",
          "dlfi-imports/SESSION_099__Name__a/b.webp",
          "dlfi-imports/SESSION_099__Name__a/c.webp"
        ]
      }
    };
    let purgeFetchCalls = 0;
    globalThis.fetch = async (..._args) => {
      purgeFetchCalls += 1;
      return { ok: false, status: 404 };
    };
    globalThis.FilePicker = {
      async browse(_source, path) {
        if (!tree[path]) throw new Error("missing");
        return tree[path];
      }
      // no deletePath → deleteDataFile returns false quietly
    };
    const assets = await sessions.purgeSessionAssets("SESSION_099", "dlfi-imports");
    assert(assets.filesDeleted === 0, "V14 purge deletes nothing without deletePath");
    assert(
      assets.deleteUnsupported === true &&
        assets.filesSkipped === 0 &&
        assets.remainingDirs.join(",") === "dlfi-imports/SESSION_099__Name__a",
      "V14 purge returns early and reports leftover folders"
    );
    assert(
      sessions.describeDeleteResults([{ docs: null, assets }]).includes("Data/dlfi-imports/SESSION_099__Name__a"),
      "delete summary names leftover asset folders"
    );
    assert(purgeFetchCalls === 0, "V14 purge does not call /filesystem");
    globalThis.fetch = prevFetch;
  }

  const modern = {
    async deletePath() {
      throw new Error("File not found (404)");
    }
  };
  globalThis.foundry.applications = { apps: { FilePicker: { implementation: modern } } };
  globalThis.FilePicker = undefined;
  assert(getFilePicker() === modern, "FilePicker resolved via foundry.applications.apps.FilePicker.implementation");
  assert((await delFile("assets/battlemaps/old.webp")) === true, "deletePath 404 treated as already removed");
  delete globalThis.foundry.applications;
}

// Item Piles module id + Damned Lucky PC folder
{
  assert(ITEM_PILES_MODULE_ID === "item-piles", "Item Piles module id is hyphenated");
  assert(ITEM_PILES_MODULE_ID_LEGACY === "itempiles", "legacy Item Piles id retained");
  assert(PC_ACTOR_FOLDER_NAME === "Damned Lucky", "PC stubs use Damned Lucky folder");
  assert(ITEM_PILES_FOLDER_NAME === "Item Piles", "session Item Piles subfolder name");
  assert(ITEM_PILE_PLACEHOLDER_NAME_RE.test("Item 1"), "Item 1 is a placeholder name");
  assert(ITEM_PILE_PLACEHOLDER_NAME_RE.test("Item 5"), "Item 5 is a placeholder name");
  assert(!ITEM_PILE_PLACEHOLDER_NAME_RE.test("Sentinel Shield"), "real item name is not placeholder");
  assert(
    isLocationItemPilePlaceholderToken({ name: "Item 3", flags: {} }),
    "Item 3 token is cleared as placeholder"
  );
  assert(
    !isLocationItemPilePlaceholderToken({
      name: "Merchant",
      flags: { "item-piles": { data: { type: "merchant" } } }
    }),
    "GM-placed Item Piles token (no DLFI flag) is kept"
  );
  assert(
    isLocationItemPilePlaceholderToken({
      name: "Sentinel Shield",
      flags: { dlfi: { kind: "item-pile" }, "item-piles": { data: { type: "pile" } } }
    }),
    "DLFI pile token is cleared"
  );
  assert(
    !isLocationItemPilePlaceholderToken({ name: "1A1", flags: {} }),
    "NPC slot is not an item-pile placeholder"
  );
  globalThis.game = {
    modules: {
      get: (id) => (id === "item-piles" ? { active: true } : undefined)
    }
  };
  assert(isItemPilesActive() === true, "detects item-piles active");
  globalThis.game = {
    modules: { get: () => undefined },
    itempiles: { API: { createItemPile: async () => null } }
  };
  assert(isItemPilesActive() === true, "detects Item Piles via game.itempiles.API");
  globalThis.game = {
    modules: {
      get: (id) => (id === "itempiles" ? { active: true } : undefined)
    }
  };
  assert(isItemPilesActive() === true, "detects legacy itempiles id");
  globalThis.game = { modules: { get: () => undefined } };
  assert(isItemPilesActive() === false, "inactive when module and API absent");
  delete globalThis.game;
}

// Location Item Pile sort order + layout (Expo template geometry)
{
  assert(itemPileSortKey("plot") === 1, "plot sort key");
  assert(itemPileSortKey("magic") === 2, "magic sort key");
  assert(itemPileSortKey("consumable") === 3, "consumable sort key");
  assert(itemPileSortKey("cash_loot") === 4, "cash_loot sort key");
  assert(itemPileSortKey("gold_pieces") === 5, "gold_pieces sort key");
  assert(itemPileSortKey("mundane") === 6, "mundane sort key");
  assert(itemPileSortKey("weird_unknown") === 7, "unknown sorts after mundane");
  assert(itemPileSortKey("PLOT") === 1, "subtype case-insensitive");

  const shuffled = [
    { name: "Z Coin", subtype: "gold_pieces" },
    { name: "Alpha Ring", subtype: "magic" },
    { name: "Beta Potion", subtype: "consumable" },
    { name: "Quest Letter", subtype: "plot" },
    { name: "Loose Gems", subtype: "cash_loot" },
    { name: "Rope", subtype: "mundane" },
    { name: "Alpha Amulet", subtype: "magic" },
    { name: "Mystery Blob", subtype: "custom_kind" }
  ];
  const ordered = [...shuffled].sort(compareItemsForPilePlacement).map((r) => r.name);
  assert(
    ordered.join("|") ===
      "Quest Letter|Alpha Amulet|Alpha Ring|Beta Potion|Loose Gems|Z Coin|Rope|Mystery Blob",
    `item pile sort order (got ${ordered.join("|")})`
  );

  // Expo reference: 1920×1080, padding 0.25, grid 120 → Foundry rounds padY to 360.
  const metrics = {
    width: 2880,
    height: 1800,
    sceneWidth: 1920,
    sceneHeight: 1080,
    sceneX: 480,
    sceneY: 360,
    mapBottom: 1440,
    canvasBottom: 1800,
    gridSize: 120
  };
  const positions = layoutLocationItemPilePositions({
    metrics,
    grid: 120,
    count: 7,
    columns: ITEM_PILE_COLUMNS
  });
  assert(positions.length === 7, "7 pile positions");
  assert(positions[0].x === 1800 && positions[0].y === 1440, "Item 1 at 1800,1440");
  assert(positions[1].x === 1920 && positions[1].y === 1440, "Item 2 +1 grid x");
  assert(positions[4].x === 2280 && positions[4].y === 1440, "Item 5 end of row");
  assert(positions[5].x === 1800 && positions[5].y === 1560, "row 2 wraps +1 grid y");
  assert(positions[6].x === 1920 && positions[6].y === 1560, "row 2 second slot");

  const token = buildItemPileTokenData({
    name: "Signet Ring",
    x: 1800,
    y: 1440,
    img: "icons/svg/item-bag.svg",
    itemUuid: "Item.abc",
    dlceId: "itm_signet"
  });
  assert(token.name === "Signet Ring", "pile token uses item name");
  assert(token.displayName === 50, "pile displayName ALWAYS");
  assert(token.disposition === 1, "pile disposition friendly");
  assert(token.width === 1 && token.height === 1, "pile footprint 1×1");
  assert(token.texture.scaleX === ITEM_PILE_SCALE && token.texture.fit === "contain", "pile scale/fit");
  assert(token.sight?.enabled === false && !("vision" in token), "pile token sight disabled (no legacy vision field)");
  assert(token.sight?.enabled === false, "pile token sight.enabled false");
  assert(token.flags.itempiles == null, "item piles flag uses hyphenated scope");
  assert(token.flags["item-piles"]?.data?.type === "pile", "item-piles data.type=pile");
  assert(token.flags["item-piles"]?.data?.singleItemScale === 0.75, "singleItemScale 0.75");
  assert(token.flags.dlfi?.kind === "item-pile", "dlfi kind item-pile");

  assert(
    itemPileEntriesMatch({ name: "Shaped Red Coral Book Binding", id: "a" }, {
      name: "shaped red coral book binding",
      _id: "b"
    }),
    "pile entry match is case-insensitive by name"
  );
  assert(
    pileActorItemsList({ items: [{ name: "Ring" }, { name: "Cup" }] }).length === 2,
    "pileActorItemsList reads array-like items"
  );

  // finalize must not re-add when the pile already has the item (createItemPile path).
  let addCalls = 0;
  const existingPile = {
    name: "Pile",
    img: null,
    folder: null,
    items: [{ name: "Shaped Red Coral Book Binding", id: "itm1" }],
    async update() {},
    async createEmbeddedDocuments() {
      addCalls += 1;
    }
  };
  globalThis.fromUuid = async () => existingPile;
  globalThis.game = {
    ...(globalThis.game || {}),
    itempiles: {
      API: {
        async addItems() {
          addCalls += 1;
        }
      }
    }
  };
  await finalizeItemPileActor("Actor.pile", {
    name: "Shaped Red Coral Book Binding",
    img: "icons/book.svg"
  });
  assert(addCalls === 0, "finalize does not duplicate an existing pile item");
  delete globalThis.fromUuid;
}

// NPC HP house rule: (8 + Con mod) × CR for non-published
{
  assert(parseChallengeRating({ combat_cr: "1/4" }) === 0.25, "parses fractional CR 1/4");
  assert(parseChallengeRating({ combat_cr: "1/8" }) === 0.125, "parses fractional CR 1/8");
  assert(parseChallengeRating({ combat_level: 8 }) === 2, "GG level 8 → CR 2");
  assert(
    resolveNpcHitPoints(
      { combat_enabled: "true", check_con: "16", combat_level: 8, combat_stat_source: "gg" },
      2
    ) === 22,
    "GG HP = (8+3)×2"
  );
  assert(
    resolveNpcHitPoints(
      { combat_stat_source: "pb", combat_hp: "256", check_con: "16", combat_cr: "17" },
      17
    ) === 256,
    "published HP stays official"
  );
  const ggActor = buildNpcNpcActorData(
    {
      name: "Guard",
      fields: {
        combat_enabled: "true",
        combat_stat_source: "gg",
        combat_level: "4",
        check_con: "10",
        combat_hp: "99"
      }
    },
    { id: "npc_guard", name: "Guard" }
  );
  assert(ggActor.system.attributes.hp.value === 8, "Foundry GG HP overrides stored combat_hp");
  assert(ggActor.system.details.cr === 1, "Foundry CR from GG level/4");
}

// Bidirectional item ↔ location relationship collection
{
  const reverse = buildItemLocationsFromLocationLinks(
    [{ id: "loc_trader", file: "documents/loc_trader.json" }],
    () => ({
      id: "loc_trader",
      links: [
        { target_type: "item", target_id: "itm_ring" },
        { target_type: "npc", target_id: "npc_kira" }
      ]
    })
  );
  assert(
    (reverse.get("itm_ring") || []).includes("loc_trader"),
    "reverse index maps item ← location"
  );
  assert(!reverse.has("npc_kira"), "NPC links ignored in item reverse map");

  const forwardOnly = collectItemLocationIds(
    { id: "itm_a", locationIds: ["loc_a"] },
    { links: [{ target_type: "location", target_id: "loc_b" }] },
    []
  );
  assert(forwardOnly.includes("loc_a") && forwardOnly.includes("loc_b"), "forward locationIds + links");

  const viaReverse = collectItemLocationIds(
    { id: "itm_ring", locationIds: [] },
    { links: [] },
    reverse.get("itm_ring") ?? []
  );
  assert(viaReverse.includes("loc_trader"), "item places via reverse location→item link");

  const both = collectItemLocationIds(
    { id: "itm_ring", locationIds: ["loc_other"] },
    { links: [{ target_type: "location", target_id: "loc_trader" }] },
    reverse.get("itm_ring") ?? []
  );
  assert(
    both.includes("loc_other") && both.includes("loc_trader") && both.length === 2,
    "deduped bidirectional item locations"
  );
}

// Soft-seat player accounts
{
  assert(
    normalizeSeatEntry({
      actor: { flags: { dlfi: { playerName: "Alex", playerId: "p1" } } }
    })?.playerId === "p1",
    "normalizeSeatEntry reads actor flags"
  );
  assert(
    normalizeSeatEntry({ actor: { flags: {} }, pc: { playerName: "Sam" } })?.playerName === "Sam",
    "normalizeSeatEntry falls back to package playerName"
  );
  assert(normalizeSeatEntry({ actor: { flags: {} }, pc: {} }) === null, "seat needs player identity");

  const users = [
    {
      id: "u_old",
      name: "OldPlayer",
      role: USER_ROLE.PLAYER,
      character: null,
      flags: { dlfi: { managed: true, playerId: "p_old" } },
      async update(patch) {
        Object.assign(this, patch);
        if (patch["flags.dlfi.playerId"]) {
          this.flags.dlfi.playerId = patch["flags.dlfi.playerId"];
        }
      }
    },
    {
      id: "u_hide",
      name: "HiddenSoon",
      role: USER_ROLE.PLAYER,
      character: null,
      flags: { dlfi: { managed: true, playerId: "p_hide" } },
      async update(patch) {
        Object.assign(this, patch);
      }
    }
  ];
  const mkUsers = () => {
    const list = [...users];
    list.get = (id) => list.find((u) => u.id === id);
    return list;
  };
  const actor = {
    id: "a_pc1",
    ownership: { default: 0 },
    flags: { dlfi: { playerName: "Alex", playerId: "p_alex" } },
    async update(patch) {
      if (patch.ownership) {
        this.ownership = patch.ownership;
      }
    }
  };
  let createdPayload = null;
  const FakeUser = {
    async create(data) {
      createdPayload = data;
      const user = {
        id: "u_new",
        name: data.name,
        role: data.role,
        character: null,
        flags: data.flags,
        async update(patch) {
          Object.assign(this, patch);
        }
      };
      users.push(user);
      return user;
    }
  };
  const world = { users: mkUsers(), actors: [actor] };
  const matched = findUserForSeat(users, { playerId: "p_old", playerName: "Nope" });
  assert(matched?.id === "u_old", "findUserForSeat prefers playerId");

  const seats = seatsFromSessionPcs([{ actor, pc: { playerName: "Alex", playerId: "p_alex" } }]);
  const result = await softSeatPlayers(seats, {
    world,
    UserDocument: FakeUser
  });
  assert(result.created.length === 1, "creates missing user");
  assert(createdPayload?.flags?.dlfi?.managed === true, "new user is managed");
  assert(createdPayload?.flags?.dlfi?.playerId === "p_alex", "new user stores playerId");
  assert(createdPayload?.password === "", "new user gets blank password");
  assert(createdPayload?.role === USER_ROLE.NONE, "new user starts locked (None) by default");
  assert(String(createdPayload?.name ?? "").startsWith("_"), "new locked user gets _ name prefix");
  assert(actor.ownership.u_new === 3, "grants OWNER ownership");
  assert(users.find((u) => u.id === "u_new")?.character === "a_pc1", "sets user.character");

  // Existing user: never wipe flags / password — only character / playerId.
  const existingFlags = structuredClone(users[0].flags);
  await softSeatPlayers(
    [{ actor, playerName: "OldPlayer", playerId: "p_old" }],
    { world, UserDocument: FakeUser }
  );
  assert(
    JSON.stringify(users[0].flags) === JSON.stringify(existingFlags),
    "existing user flags preserved on re-seat"
  );

  const {
    lockPlayersLogin,
    unlockPlayersLogin,
    withLockedNamePrefix,
    stripLockedNamePrefix
  } = await import("./softSeatPlayers.mjs");
  assert(withLockedNamePrefix("Sam") === "_Sam", "lock prefix adds underscore");
  assert(stripLockedNamePrefix("_Sam") === "Sam", "strip lock prefix");
  assert(stripLockedNamePrefix("Sam") === "Sam", "strip no-op without prefix");

  // Seed a Player-role user to lock.
  users.push({
    id: "u_player",
    name: "Sam",
    role: USER_ROLE.PLAYER,
    isGM: false,
    character: null,
    flags: { dlfi: { managed: true, playerId: "p_sam" } },
    async update(patch) {
      Object.assign(this, patch);
    }
  });
  const lockWorld = {
    users,
    actors: [
      {
        id: "a_pc1",
        type: "character",
        flags: { dlfi: { playerId: "p_sam", playerName: "Sam" } }
      }
    ]
  };
  await lockPlayersLogin({ world: lockWorld });
  assert(users.find((u) => u.id === "u_player")?.role === USER_ROLE.NONE, "lock sets Player → None");
  assert(users.find((u) => u.id === "u_player")?.name === "_Sam", "lock prepends _");
  await unlockPlayersLogin({ world: lockWorld });
  assert(users.find((u) => u.id === "u_player")?.role === USER_ROLE.PLAYER, "unlock restores Player");
  assert(users.find((u) => u.id === "u_player")?.name === "Sam", "unlock strips _");
}

{
  const { shouldSuppressLoadingBar, isSceneLoadingMessage, registerSuppressSceneLoadingBar } = await import(
    "../canvas/suppressSceneLoadingBar.mjs"
  );
  assert(shouldSuppressLoadingBar({ isGM: false }, () => true), "players: suppressed when setting on");
  assert(!shouldSuppressLoadingBar({ isGM: false }, () => false), "players: shown when setting off");
  assert(!shouldSuppressLoadingBar({ isGM: true }, () => true), "GM always sees loading bars");
  assert(isSceneLoadingMessage("Loading Korbane", "Loading {name}"), "scene loading message recognised");
  assert(!isSceneLoadingMessage("Loading modules", "SCENE.Loading"), "untranslated key never matches");

  const calls = [];
  class FakeLoader {
    load(sources, options = {}) {
      calls.push(options.displayProgress);
      return Promise.resolve();
    }
    static loader = new FakeLoader();
    static loadSceneTextures() {
      return this.loader.load([], { message: "x" });
    }
  }
  const savedGame = globalThis.game;
  globalThis.game = { user: { isGM: false }, settings: { get: () => true }, i18n: { localize: (k) => k } };
  registerSuppressSceneLoadingBar(FakeLoader);
  await FakeLoader.loadSceneTextures();
  await FakeLoader.loader.load([], {});
  assert(calls[0] === false, "scene texture load hides progress for players");
  assert(calls[1] === undefined, "non-scene load keeps its progress bar");
  globalThis.game = savedGame;

  const { protectedArtMattStripUpdates } = await import("./mattSceneNav.mjs");
  const armed = { actions: [{ action: "scene" }], active: true };
  const stripScene = {
    tiles: [
      { id: "t_bg", name: "Backdrop", width: 1920, height: 1080, flags: { "monks-active-tiles": armed } },
      { id: "t_nav", name: "Nav", width: 448, height: 252, flags: { "monks-active-tiles": armed } },
      {
        id: "t_done",
        name: "Old",
        width: 1600,
        height: 900,
        flags: { "monks-active-tiles": { active: false, actions: [] } }
      }
    ]
  };
  const stripIds = protectedArtMattStripUpdates(stripScene).map((u) => u._id);
  assert(stripIds.includes("t_bg"), "oversized MATT tile disarmed");
  assert(!stripIds.includes("t_nav"), "nav-sized MATT tile left armed");
  assert(!stripIds.includes("t_done"), "already-disarmed tile not re-updated");

  const { clearTokenEffectIcons } = await import("../canvas/hideLandingEffects.mjs");
  let removed = false;
  const token = { effects: { visible: true, removeChildren: () => (removed = true) } };
  clearTokenEffectIcons(token);
  assert(token.effects.visible === false && !removed, "landing effects hidden without detaching sprites");
}

{
  const {
    findUserForSeat,
    softSeatPlayers,
    lockPlayersLogin,
    listManageableUsers,
    updateManagedUser,
    USER_ROLE
  } = await import("./softSeatPlayers.mjs");
  const mk = (id, name, role, flags = {}, extra = {}) => ({
    id,
    name,
    role,
    isGM: role >= USER_ROLE.GAMEMASTER,
    character: null,
    flags,
    async update(patch) {
      Object.assign(this, patch);
    },
    ...extra
  });
  const trusted = mk("u_tr", "Robin", USER_ROLE.TRUSTED, { dlfi: { playerId: "p_robin" } });
  const gm = mk("u_gm", "Gamemaster", USER_ROLE.GAMEMASTER);
  const other = mk("u_other", "Kim", USER_ROLE.PLAYER, { dlfi: { playerId: "p_kim_a" } });
  const users = [trusted, gm, other];
  users.get = (id) => users.find((u) => u.id === id);

  assert(findUserForSeat(users, { playerName: "Gamemaster" }) == null, "name match skips GM");
  assert(findUserForSeat(users, { playerName: "Robin" }) == null, "name match skips Trusted");
  assert(findUserForSeat(users, { playerId: "p_kim_b", playerName: "Kim" }) == null, "name match skips other playerId");
  assert(findUserForSeat(users, { playerId: "p_robin" })?.id === "u_tr", "playerId still finds Trusted");

  const actor = {
    id: "a_robin",
    ownership: {},
    async update(patch) {
      Object.assign(this, patch);
    }
  };
  let created = 0;
  const FakeUser = {
    async create() {
      created += 1;
      return mk("u_dup", "dup", USER_ROLE.NONE);
    }
  };
  await softSeatPlayers([{ actor, playerId: "p_robin", playerName: "Robin" }], {
    world: { users },
    UserDocument: FakeUser
  });
  assert(trusted.role === USER_ROLE.TRUSTED && trusted.name === "Robin", "soft-seat leaves Trusted role/name");
  assert(!trusted.flags.dlfi.managed, "soft-seat does not mark Trusted managed");
  assert(trusted.character === "a_robin" && actor.ownership.u_tr === 3, "Trusted still gets their PC");
  await softSeatPlayers([{ actor, playerId: "p_kim_b", playerName: "Kim" }], { world: { users }, UserDocument: FakeUser });
  assert(created === 0, "no duplicate-name user created when the name is taken");

  const listed = listManageableUsers({ users }).map((u) => u.id);
  assert(!listed.includes("u_tr") && !listed.includes("u_gm"), "Players UI hides Trusted / GM");
  let threw = false;
  try {
    await updateManagedUser("u_tr", { playable: false }, { world: { users, actors: [] } });
  } catch (_error) {
    threw = true;
  }
  assert(threw && trusted.role === USER_ROLE.TRUSTED, "updateManagedUser refuses Trusted");

  const broken = mk("u_broken", "Lee", USER_ROLE.PLAYER, {}, {
    async update() {
      throw new Error("rename clash");
    }
  });
  const lockUsers = [broken, mk("u_ok", "Pat", USER_ROLE.PLAYER)];
  const lockResult = await lockPlayersLogin({ world: { users: lockUsers } });
  assert(lockResult.failed.length === 1 && lockResult.locked.length === 1, "lock continues past a failed user");
  assert(lockUsers[1].role === USER_ROLE.NONE, "other users still locked");
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll selftests passed.");
