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
  parseHitDamageParts
} = await import("./buildNpcActor.mjs");
const { resolveLocationBackground, resolveNpcMedia } = await import("./resolvePackageAsset.mjs");
const {
  classifyLandingFileName,
  resolveLandingPageArt,
  shouldUploadPackagePath
} = await import("./resolveLandingArt.mjs");

const { parseWeaponBaseDamage, abilityModifier, predictFoundryBaseDamage } = await import(
  "./damageFormula.mjs"
);
const {
  buildChallengeHostLocations,
  buildNpcLocationsFromLocationLinks,
  collectChallengeEnemies,
  formatPoisBulletList,
  locationDescriptionText,
  locationPois,
  locationSessionNotesText,
  resolveChallengeHostLocationId,
  resolveColourBattlemapPath,
  collectNpcLocationIds: collectNpcLocationIdsFromLinks
} = await import("./packageLinks.mjs");
const {
  classifyLocationFieldDrawings,
  classifyLocationFieldLabel,
  layoutBattlemapRosterLines,
  sceneCanvasMetrics,
  tokenPlacementSpec
} = await import("./scenePlacement.mjs");
const {
  buildMsdSceneSequence,
  formatSceneDmName,
  isCombatChallengeEntry,
  padSceneOrder
} = await import("./sceneOrder.mjs");
const { buildPcActorData, parseDdbCharacterId } = await import("./buildPcActor.mjs");
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

// Landing Page slides: Logo_Burn for background; upload Landing Page/ folder
{
  assert(classifyLandingFileName("SESSION_014_Logo_Burn.webp") === "logoBurn", "classify Logo_Burn");
  assert(classifyLandingFileName("Mist_Opportunity_Logo Only.png") === "logoOnly", "classify Logo Only");
  assert(classifyLandingFileName("title-only.webp") === "titleOnly", "classify title-only");
  assert(classifyLandingFileName("session_Clean.jpg") === "clean", "classify Clean");
  assert(shouldUploadPackagePath("Landing Page/x_Logo_Burn.webp"), "upload top-level Landing Page/");
  assert(shouldUploadPackagePath("assets/npc/foo.webp"), "upload assets/");
  assert(!shouldUploadPackagePath("documents/npc_kira.json"), "skip documents/");

  const uploaded = new Map([
    ["Landing Page/SESSION_Logo_Burn.webp", "world/Landing Page/SESSION_Logo_Burn.webp"],
    ["Landing Page/SESSION_Clean.webp", "world/Landing Page/SESSION_Clean.webp"],
    ["Landing Page/SESSION_Logo_Only.webp", "world/Landing Page/SESSION_Logo_Only.webp"],
    ["Landing Page/SESSION_Title_Only.webp", "world/Landing Page/SESSION_Title_Only.webp"],
    ["assets/session/old.webp", "world/assets/session/old.webp"]
  ]);
  const art = resolveLandingPageArt({ sessionArt: "assets/session/old.webp" }, uploaded);
  assert(
    art.background === "world/Landing Page/SESSION_Logo_Burn.webp",
    `Logo_Burn preferred for Landing BG (got ${art.background})`
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
  assert(named.background === "world/burn.webp", "manifest.landingPage.logoBurn wins");

  const legacy = resolveLandingPageArt(
    { sessionArt: "assets/session/cover.webp" },
    new Map([["assets/session/cover.webp", "world/cover.webp"]])
  );
  assert(legacy.background === "world/cover.webp", "legacy sessionArt still works");
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

// Location POIs → bullet list
{
  const pois = locationPois({
    fields: {
      pois: [{ name: "Counter" }, { title: "Back room" }, "Window ledge"]
    }
  });
  assert(pois.length === 3, `parse POI objects/strings (got ${pois.length})`);
  const text = formatPoisBulletList(pois);
  assert(text.split("\n").length === 3, "POI bullet list has one line per POI");
  assert(text.startsWith("• "), "POI lines are bullets");
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

// Scene sequence: LocA → combat@A → LocB → LocC; dialogue combat excluded
{
  assert(padSceneOrder(1) === "01" && padSceneOrder(12) === "12", "padSceneOrder");
  assert(
    formatSceneDmName("location", { name: "Dock" }, 1) === "01. 📍 Dock",
    "location DM name"
  );
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
  const stub = buildPcActorData(
    {
      id: "pc_ibby",
      name: "Ibby",
      ddbUrl: "https://www.dndbeyond.com/characters/118758199",
      ddbId: "118758199"
    },
    { portrait: "world/ibby.webp", token: "world/ibby_token.webp", tokenScale: 1.1 }
  );
  assert(stub.type === "character", "PC stub is character");
  assert(stub.flags?.ddbimporter?.dndbeyond?.url?.includes("118758199"), "DDB url flag");
  assert(stub.flags?.ddbimporter?.dndbeyond?.characterId === "118758199", "DDB characterId flag");
  assert(stub.prototypeToken?.actorLink === true, "PC prototype linked");
  assert(stub.prototypeToken?.texture?.src === "world/ibby_token.webp", "PC token art");
  assert(stub.prototypeToken?.texture?.scaleX === 1.1, "PC VTTTT scale");

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
  assert(layout.partyTokens[0].actorLink === true, "PCs linked");
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

  // sceneCanvasMetrics falls back when dimensions missing
  const m = sceneCanvasMetrics({ width: 1000, height: 2000, grid: { size: 100 } });
  assert(m.canvasBottom === 2000 && m.gridSize === 100, "sceneCanvasMetrics fallback");
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll selftests passed.");
