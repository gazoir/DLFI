import {
  FLAG_SCOPE,
  MODULE_ID,
  notify,
  sessionKey,
  setSetting,
  SETTING_IMPORTS,
  SETTING_LIVE_SESSION,
  SETTING_REPLACE_ON_REIMPORT,
  setting,
  SETTING_TEMPLATE_BATTLEMAP,
  SETTING_TEMPLATE_INBOX,
  SETTING_TEMPLATE_LANDING,
  SETTING_TEMPLATE_LOCATION,
  TOKEN_DISPOSITION
} from "../constants.mjs";
import { tokenDisplayHover } from "./tokenArt.mjs";
import { buildNpcNpcActorData } from "./buildNpcActor.mjs";
import { buildPcActorData, resolvePcKnownAs } from "./buildPcActor.mjs";
import { applySceneBackground } from "./applySceneBackground.mjs";
import { markdownToHtml } from "./markdown.mjs";
import {
  buildChallengeHostLocations,
  buildNpcLocationsFromLocationLinks,
  collectChallengeEnemies,
  collectCombatEnemyIds,
  collectNpcLocationIds,
  formatPoisBulletList,
  locationDescriptionText,
  locationPois,
  locationSessionNotesText,
  resolveChallengeHostLocationId,
  resolveColourBattlemapPath
} from "./packageLinks.mjs";
import {
  resolveLocationBackground,
  resolveNpcMedia
} from "./resolvePackageAsset.mjs";
import {
  applyLandingPageTiles,
  resolveLandingPageArt,
  shouldUploadPackagePath
} from "./resolveLandingArt.mjs";
import {
  finalizeBattlemapScene,
  finalizeLandingScene,
  finalizeLeftoversScene,
  finalizeLocationScene
} from "./scenePlacement.mjs";
import {
  buildMsdSceneSequence,
  formatSceneDmName
} from "./sceneOrder.mjs";
import { convertMsdHtmlForFoundry } from "./msdJournal.mjs";
import {
  bundledKindForSetting,
  createSceneFromBundledTemplate
} from "./defaultTemplates.mjs";
import { ensureSessionFolders, setExclusiveSceneNavigation } from "./folders.mjs";
import { purgeSessionAssets, purgeSessionDocuments } from "./sessions.mjs";
import {
  ensureDataFolder,
  normalizeDataPath,
  packageImportRoot,
  uploadDataFile
} from "../package/dataFolders.mjs";
import { resolveScene } from "./resolveDocument.mjs";

function decodeJson(bytes) {
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

function decodeText(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Upload a package asset into the DLFI imports tree, preserving the zip-relative path.
 * e.g. assets/portraits/loc_trader.webp → dlfi-imports/{packageRoot}/assets/portraits/…
 * @param {string} packagePath
 * @param {Uint8Array} bytes
 * @param {string} importsRoot e.g. dlfi-imports/SESSION_014__Name__stamp
 */
async function uploadAsset(packagePath, bytes, importsRoot) {
  const relative = String(packagePath || "").replace(/^\/+/, "").replace(/\\/g, "/");
  const target = `${normalizeDataPath(importsRoot)}/${relative}`;
  const parts = target.split("/");
  const name = parts.pop();
  const folder = parts.join("/");
  try {
    const uploaded = await uploadDataFile(folder, name, bytes);
    return uploaded || target;
  } catch (error) {
    console.warn(`${MODULE_ID} | upload failed for ${target}`, error);
    return null;
  }
}

/**
 * Duplicate a configured template Scene, or fall back to the bundled module template.
 * @param {string} settingKey
 * @param {string} fallbackName
 * @param {{ folderId?: string|null, flags?: object }} [options]
 */
async function duplicateTemplateScene(settingKey, fallbackName, options = {}) {
  const raw = String(setting(settingKey) || "").trim();
  const bundledKind = bundledKindForSetting(settingKey);

  if (raw) {
    const template = await resolveScene(raw);
    if (!template) {
      notify(
        `DLFI: template scene not found for ${fallbackName} (${raw}); using bundled default.`,
        { type: "warning" }
      );
    } else {
      // Prefer Document#clone so embedded drawings/tokens/lights keep structure with fresh ids.
      if (typeof template.clone === "function") {
        try {
          const cloned = await template.clone(
            {
              name: fallbackName,
              navigation: false,
              navName: "",
              active: false,
              folder: options.folderId ?? template.folder ?? null,
              ...(options.flags ? { flags: options.flags } : {})
            },
            { save: true, keepId: false }
          );
          if (cloned) {
            return cloned;
          }
        } catch (error) {
          console.warn(`${MODULE_ID} | scene clone failed, falling back to fromCompendium`, error);
        }
      }

      const data =
        typeof game.scenes.fromCompendium === "function"
          ? game.scenes.fromCompendium(template, { clearFolder: true })
          : (() => {
              const object = template.toObject();
              delete object._id;
              return object;
            })();
      data.name = fallbackName;
      data.navigation = false;
      data.navName = "";
      data.active = false;
      data.navOrder = data.navOrder ?? 0;
      data.folder = options.folderId ?? null;
      if (options.flags) {
        data.flags = { ...(data.flags ?? {}), ...options.flags };
      }
      return Scene.create(data);
    }
  }

  if (bundledKind) {
    const created = await createSceneFromBundledTemplate(bundledKind, fallbackName, {
      folder: options.folderId ?? null,
      flags: options.flags
    });
    if (created) {
      console.log(`${MODULE_ID} | using bundled ${bundledKind} template for ${fallbackName}`);
      return created;
    }
  }
  return null;
}

/**
 * Import a loaded Session Package into the world.
 *
 * @param {import("../package/readPackage.mjs").LoadedPackage} loaded
 * @param {{ packCurrentLive?: boolean, replaceExisting?: boolean }} [options]
 */
export async function importSessionPackage(loaded, options = {}) {
  const { manifest, files } = loaded;
  const importKey = `${manifest.sessionCode}_${String(manifest.exportedAt).replace(/[:.]/g, "-")}`;
  const liveKey = setting(SETTING_LIVE_SESSION);

  if (options.packCurrentLive !== false && liveKey) {
    notify("DLFI: Pack-to-Archive before import is stubbed in 0.1 — continuing with import.", {
      type: "warning"
    });
  }

  const replaceExisting =
    options.replaceExisting ?? setting(SETTING_REPLACE_ON_REIMPORT) !== false;
  if (replaceExisting) {
    try {
      const removed = await purgeSessionDocuments(manifest.sessionCode);
      const assets = await purgeSessionAssets(
        manifest.sessionCode,
        String(setting(SETTING_IMPORTS) || "dlfi-imports").trim() || "dlfi-imports"
      );
      if (removed || assets.dirs.length) {
        console.log(`${MODULE_ID} | replaced previous import of ${manifest.sessionCode}`, {
          removed,
          assets
        });
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | could not remove previous import of ${manifest.sessionCode}`, error);
    }
  }

  const { name: folderName, folders } = await ensureSessionFolders(manifest, importKey);

  /** @type {Map<string, string>} packagePath -> world data path */
  const uploaded = new Map();
  const importsBase = String(setting(SETTING_IMPORTS) || "dlfi-imports").trim() || "dlfi-imports";
  const packageRoot = packageImportRoot(manifest, loaded.sourceLabel);
  const importsRoot = await ensureDataFolder(`${importsBase}/${packageRoot}`);
  console.log(`${MODULE_ID} | importing assets into Data/${importsRoot}`);

  // Create parent folders from whatever uploadable paths the package contains
  // (assets/** plus top-level Landing Page/** slides from DLCE).
  const assetFolders = new Set();
  for (const path of files.keys()) {
    if (!shouldUploadPackagePath(path)) {
      continue;
    }
    const folder = path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    if (folder) {
      assetFolders.add(folder);
    }
  }
  for (const sub of assetFolders) {
    try {
      await ensureDataFolder(`${importsRoot}/${sub}`);
    } catch (error) {
      console.warn(`${MODULE_ID} | precreate ${sub} failed`, error);
    }
  }

  let uploadFailures = 0;
  for (const [path, bytes] of files) {
    if (!shouldUploadPackagePath(path)) {
      continue;
    }
    const worldPath = await uploadAsset(path, bytes, importsRoot);
    if (worldPath) {
      uploaded.set(path, worldPath);
    } else {
      uploadFailures += 1;
    }
  }
  if (uploadFailures) {
    notify(`DLFI: ${uploadFailures} asset upload(s) failed — check console for paths.`, {
      type: "warning"
    });
  }

  const readDocument = (file) => {
    if (!file) {
      return null;
    }
    const bytes = files.get(file);
    if (!bytes) {
      return null;
    }
    try {
      return decodeJson(bytes);
    } catch (error) {
      console.warn(`${MODULE_ID} | failed to parse ${file}`, error);
      return null;
    }
  };

  /** @type {Map<string, string>} dlce id -> Foundry doc uuid */
  const createdByDlceId = new Map();
  /** @type {Map<string, { scene: Scene, description: string, poisText: string, npcs: Array<{actor: Actor, entry: object}> }>} */
  const locationSceneMeta = new Map();
  /** @type {string[]} */
  const sessionSceneIds = [];
  let landingScene = null;
  let leftoversScene = null;

  // --- Locations + combat battlemaps in MSD appearance order (before Landing/Leftovers) ---
  const locations = (manifest.documents ?? []).filter((entry) => entry.type === "location");
  const battlemapAssetPaths = [
    ...(manifest.assets?.battlemaps ?? []),
    ...[...uploaded.keys()].filter(
      (path) =>
        /^assets\/battlemaps\//i.test(path) || /^assets\/location\/battlemaps\//i.test(path)
    )
  ];
  const challengeHostLocations = buildChallengeHostLocations(locations, readDocument);
  /** @type {Array<{ scene: Scene, entry: object, raw: object|null }>} */
  const battlemapMeta = [];
  const sceneSequence = buildMsdSceneSequence(manifest, { readDocument });

  for (const step of sceneSequence) {
    const { kind, entry, order } = step;
    const dmName = formatSceneDmName(kind, entry, order);

    if (kind === "location") {
      let scene =
        (await duplicateTemplateScene(SETTING_TEMPLATE_LOCATION, dmName, {
          folderId: folders.Scene?.id ?? null,
          flags: { [FLAG_SCOPE]: { dlceId: entry.id, kind: "location", importKey } }
        })) ??
        (await Scene.create({
          name: dmName,
          navigation: true,
          folder: folders.Scene?.id ?? null,
          flags: { [FLAG_SCOPE]: { dlceId: entry.id, kind: "location", importKey } }
        }));

      const bg = resolveLocationBackground(entry, uploaded);
      await scene.update({
        name: dmName,
        navName: "",
        navigation: true,
        folder: folders.Scene?.id ?? null,
        flags: { [FLAG_SCOPE]: { dlceId: entry.id, kind: "location", importKey } }
      });
      if (bg) {
        await applySceneBackground(scene, bg);
      } else {
        console.warn(
          `${MODULE_ID} | no location artwork for ${entry.id} (${entry.name}); tried portrait=${entry.portrait ?? "—"}`
        );
      }
      sessionSceneIds.push(scene.id);
      createdByDlceId.set(entry.id, scene.uuid);

      const raw = readDocument(entry.file);
      locationSceneMeta.set(entry.id, {
        scene,
        description: locationDescriptionText(raw),
        poisText: formatPoisBulletList(locationPois(raw)),
        sessionNotes: locationSessionNotesText(raw, manifest),
        npcs: []
      });
      continue;
    }

    // battlemap
    const raw = step.raw ?? readDocument(entry.file);
    const locId = resolveChallengeHostLocationId(entry, raw, challengeHostLocations);
    const locEntry =
      (manifest.documents ?? []).find((d) => d.id === locId && d.type === "location") ?? null;
    const mapPath = resolveColourBattlemapPath({
      entry,
      raw,
      locationEntry: locEntry,
      uploaded,
      assetPaths: battlemapAssetPaths
    });
    let scene =
      (await duplicateTemplateScene(SETTING_TEMPLATE_BATTLEMAP, dmName, {
        folderId: folders.Scene?.id ?? null,
        flags: { [FLAG_SCOPE]: { dlceId: entry.id, kind: "battlemap", importKey } }
      })) ??
      (await Scene.create({
        name: dmName,
        navigation: true,
        folder: folders.Scene?.id ?? null
      }));
    await scene.update({
      name: dmName,
      navName: "",
      navigation: true,
      folder: folders.Scene?.id ?? null,
      flags: { [FLAG_SCOPE]: { dlceId: entry.id, kind: "battlemap", importKey } }
    });
    if (!mapPath) {
      console.warn(`${MODULE_ID} | no colour battlemap found for ${entry.id} (${entry.name})`);
    } else {
      await applySceneBackground(scene, mapPath);
    }
    sessionSceneIds.push(scene.id);
    createdByDlceId.set(entry.id, scene.uuid);
    battlemapMeta.push({ scene, entry, raw });
  }

  // Reverse index: location "Owned by" / similar links → NPC placement
  const reverseNpcLocations = buildNpcLocationsFromLocationLinks(locations, readDocument);

  // --- Landing ---
  // Clean = scene background; Logo Only / Title Only replace named template tiles.
  const landingArt = resolveLandingPageArt(manifest, uploaded);
  let landing =
    (await duplicateTemplateScene(SETTING_TEMPLATE_LANDING, `${folderName} — Landing`, {
      folderId: folders.Scene?.id ?? null,
      flags: { [FLAG_SCOPE]: { kind: "landing", importKey } }
    })) ??
    (await Scene.create({
      name: `${folderName} — Landing`,
      navigation: true,
      folder: folders.Scene?.id ?? null
    }));
  await landing.update({
    name: `${folderName} — Landing`,
    navName: "",
    navigation: true,
    folder: folders.Scene?.id ?? null,
    flags: {
      [FLAG_SCOPE]: {
        kind: "landing",
        importKey,
        landingArt: {
          background: landingArt.background,
          logoBurn: landingArt.logoBurn,
          logoOnly: landingArt.logoOnly,
          titleOnly: landingArt.titleOnly,
          clean: landingArt.clean,
          packagePaths: landingArt.packagePaths
        }
      }
    }
  });
  if (landingArt.background) {
    await applySceneBackground(landing, landingArt.background);
    console.log(
      `${MODULE_ID} | Landing background → ${landingArt.background}` +
        (landingArt.clean ? " (Clean)" : landingArt.logoBurn ? " (Logo_Burn fallback)" : "")
    );
  } else {
    console.warn(`${MODULE_ID} | no Landing Page / session art found for Landing background`);
  }
  const tilesUpdated = await applyLandingPageTiles(landing, {
    logoOnly: landingArt.logoOnly,
    titleOnly: landingArt.titleOnly
  });
  if (tilesUpdated) {
    console.log(
      `${MODULE_ID} | Landing tiles updated: ${tilesUpdated}` +
        ` (logoOnly=${Boolean(landingArt.logoOnly)}, titleOnly=${Boolean(landingArt.titleOnly)})`
    );
  } else if (landingArt.logoOnly || landingArt.titleOnly) {
    console.warn(
      `${MODULE_ID} | Landing has Logo/Title art but no "Logo Only"/"Title Only" tiles on the template`
    );
  }
  if (landingArt.logoOnly || landingArt.titleOnly || landingArt.clean || landingArt.logoBurn) {
    console.log(`${MODULE_ID} | Landing Page slides available:`, {
      clean: landingArt.clean,
      logoBurn: landingArt.logoBurn,
      logoOnly: landingArt.logoOnly,
      titleOnly: landingArt.titleOnly
    });
  }
  sessionSceneIds.push(landing.id);
  landingScene = landing;

  // --- Leftovers (formerly Inbox): catch-all for unplaced NPCs/items ---
  let leftovers =
    (await duplicateTemplateScene(SETTING_TEMPLATE_INBOX, `${folderName} — Leftovers`, {
      folderId: folders.Scene?.id ?? null,
      flags: { [FLAG_SCOPE]: { kind: "leftovers", importKey } }
    })) ??
    (await Scene.create({
      name: `${folderName} — Leftovers`,
      navigation: false,
      folder: folders.Scene?.id ?? null
    }));
  await leftovers.update({
    name: `${folderName} — Leftovers`,
    navName: "",
    navigation: false,
    folder: folders.Scene?.id ?? null,
    flags: { [FLAG_SCOPE]: { kind: "leftovers", importKey } }
  });
  leftoversScene = leftovers;
  sessionSceneIds.push(leftovers.id);

  // --- NPCs / monsters as Actors ---
  /** @type {Map<string, Actor>} */
  const actorsByDlceId = new Map();
  /** @type {Set<string>} NPCs placed on a location or battlemap */
  const placedNpcIds = new Set();
  /** @type {Array<{ entry: object, raw: object, actor: Actor }>} */
  const npcRecords = [];

  const npcEntries = (manifest.documents ?? []).filter((d) => d.type === "npc");
  const npcRawById = new Map(npcEntries.map((entry) => [entry.id, readDocument(entry.file) ?? {}]));
  // Enemies in combat encounters are unlinked on Actor.prototypeToken (Link Actor Data off).
  const combatEnemyIds = collectCombatEnemyIds(
    battlemapMeta,
    npcEntries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      raw: npcRawById.get(entry.id)
    }))
  );

  for (const entry of npcEntries) {
    const raw = npcRawById.get(entry.id) ?? {};
    const { portrait, token, tokenSlots, tokenWildcard } = resolveNpcMedia(entry, uploaded);
    const actorData = buildNpcNpcActorData(raw, entry, {
      portrait,
      token,
      tokenSlots,
      tokenWildcard,
      combatEnemy: combatEnemyIds.has(entry.id),
      tokenScale: entry.tokenScale,
      folderId: folders.Actor?.id ?? null,
      importKey
    });
    const actor = await Actor.create(actorData);
    createdByDlceId.set(entry.id, actor.uuid);
    actorsByDlceId.set(entry.id, actor);
    npcRecords.push({ entry, raw, actor });

    const locationIds = collectNpcLocationIds(
      entry,
      raw,
      reverseNpcLocations.get(entry.id) ?? []
    );
    for (const locationId of locationIds) {
      const meta = locationSceneMeta.get(locationId);
      if (meta) {
        meta.npcs.push({ actor, entry });
        placedNpcIds.add(entry.id);
      }
    }
  }

  // --- PCs (match existing or create DDB-ready stubs) + pets as NPC actors ---
  /** @type {Array<{ actor: Actor, pc: object }>} */
  const sessionPcs = [];
  /** @type {Map<string, Actor>} dlce pc id → actor */
  const pcActorsByDlceId = new Map();
  /** @type {Array<{ actor: Actor, ownerPcId: string, pet: object }>} */
  const sessionPets = [];

  for (const pc of manifest.pcs ?? []) {
    const portrait = pc.portrait ? uploaded.get(pc.portrait) || null : null;
    const token = pc.token ? uploaded.get(pc.token) || null : null;
    let actor = matchExistingPcActor(pc);
    if (actor) {
      const patch = {};
      if (portrait && actor.img !== portrait) {
        patch.img = portrait;
      }
      if (token) {
        patch["prototypeToken.texture.src"] = token;
      }
      if (pc.tokenScale != null && Number(pc.tokenScale) > 0) {
        patch["prototypeToken.texture.scaleX"] = Number(pc.tokenScale);
        patch["prototypeToken.texture.scaleY"] = Number(pc.tokenScale);
      }
      // Re-imports: ensure matched PCs stay Friendly even if a prior stub was Hostile.
      patch["prototypeToken.disposition"] = TOKEN_DISPOSITION.FRIENDLY;
      patch["prototypeToken.displayName"] = tokenDisplayHover();
      const knownAs = resolvePcKnownAs(pc, actor);
      if (knownAs) {
        patch["prototypeToken.name"] = knownAs;
      }
      if (Object.keys(patch).length) {
        await actor.update(patch);
      }
    } else {
      const actorData = buildPcActorData(pc, {
        portrait,
        token,
        tokenScale: pc.tokenScale,
        folderId: folders.Actor?.id ?? null,
        importKey
      });
      actor = await Actor.create(actorData);
      console.log(
        `${MODULE_ID} | created PC stub ${actor.name}` +
          (pc.ddbUrl ? ` (DDB ${pc.ddbId || pc.ddbUrl})` : "")
      );
    }
    if (pc.id) {
      createdByDlceId.set(pc.id, actor.uuid);
      pcActorsByDlceId.set(String(pc.id), actor);
    }
    sessionPcs.push({ actor, pc });

    for (const pet of pc.pets ?? []) {
      const petRaw = readDocument(pet.file) ?? { id: pet.id, name: pet.name, fields: {} };
      const petEntry = {
        id: pet.id,
        name: pet.name,
        type: "npc",
        subtype: "pet",
        portrait: pet.portrait,
        token: pet.token,
        tokenScale: pet.tokenScale
      };
      const petMedia = resolveNpcMedia(petEntry, uploaded);
      const petActorData = buildNpcNpcActorData(petRaw, petEntry, {
        portrait: petMedia.portrait,
        token: petMedia.token,
        tokenSlots: petMedia.tokenSlots,
        tokenWildcard: petMedia.tokenWildcard,
        tokenScale: pet.tokenScale,
        folderId: folders.Actor?.id ?? null,
        importKey
      });
      petActorData.flags = {
        ...(petActorData.flags ?? {}),
        [FLAG_SCOPE]: {
          ...(petActorData.flags?.[FLAG_SCOPE] ?? {}),
          kind: "pet",
          ownerPcId: pet.ownerPcId || pc.id || null,
          dlceId: pet.id
        }
      };
      const petActor = await Actor.create(petActorData);
      createdByDlceId.set(pet.id, petActor.uuid);
      actorsByDlceId.set(pet.id, petActor);
      sessionPets.push({ actor: petActor, ownerPcId: String(pet.ownerPcId || pc.id || ""), pet });
      placedNpcIds.add(pet.id);
    }
  }

  // Bind NPCs into location template slots, fill descriptions, remove unused placeholders
  for (const meta of locationSceneMeta.values()) {
    await finalizeLocationScene(meta.scene, {
      description: meta.description,
      poisText: meta.poisText,
      sessionNotes: meta.sessionNotes,
      npcs: meta.npcs
    });
  }

  // Battlemap: enemies (unlinked) + party PCs/pets (linked) in bottom padding lines
  const npcDocumentsForLinks = npcRecords.map((row) => ({
    id: row.entry.id,
    name: row.entry.name,
    raw: row.raw
  }));
  const partyForBattlemaps = [];
  const manifestPcs = manifest.pcs ?? [];
  for (const { actor, pc } of sessionPcs) {
    if (!actor) {
      console.warn(
        `${MODULE_ID} | battlemap party skip pc ${pc?.id || "(no id)"} (${pc?.name || "?"}): no Foundry actor resolved`
      );
      continue;
    }
    partyForBattlemaps.push({
      actor,
      linked: true,
      kind: "battle-pc",
      dlceId: pc?.id ? String(pc.id) : null,
      label: pc?.name || actor.name,
      tokenName: resolvePcKnownAs(pc, actor)
    });
    for (const petRow of sessionPets) {
      if (String(petRow.ownerPcId) !== String(pc.id || "")) {
        continue;
      }
      if (!petRow.actor) {
        console.warn(
          `${MODULE_ID} | battlemap party skip pet of pc ${pc?.id || "(no id)"} (${petRow.pet?.name || "?"}): no Foundry actor`
        );
        continue;
      }
      partyForBattlemaps.push({
        actor: petRow.actor,
        linked: true,
        kind: "battle-pet",
        dlceId: petRow.pet?.id ? String(petRow.pet.id) : null,
        ownerPcId: String(petRow.ownerPcId || pc.id || ""),
        label: petRow.pet?.name || petRow.actor.name,
        tokenName: petRow.pet?.name || petRow.actor.name
      });
    }
  }
  if (battlemapMeta.length && !partyForBattlemaps.length) {
    if (!manifestPcs.length) {
      console.warn(`${MODULE_ID} | manifest.pcs is empty — battlemaps will have no party tokens`);
    } else {
      const skipped = manifestPcs.map((pc) => `${pc?.id || "(no id)"}:${pc?.name || "?"}`).join(", ");
      console.warn(
        `${MODULE_ID} | manifest.pcs has ${manifestPcs.length} entr${manifestPcs.length === 1 ? "y" : "ies"} but none became battlemap party tokens — skipped: ${skipped}`
      );
    }
  }
  for (const meta of battlemapMeta) {
    const collected = collectChallengeEnemies(meta.entry, meta.raw, {
      npcDocuments: npcDocumentsForLinks
    });
    const sceneLabel = `${meta.scene?.name ?? meta.entry?.name ?? "battlemap"} (${meta.entry?.id ?? "?"})`;
    if (!collected.length) {
      console.warn(
        `${MODULE_ID} | battlemap ${sceneLabel}: collectChallengeEnemies returned 0 enemies — no enemy tokens will be placed`
      );
    } else {
      console.log(
        `${MODULE_ID} | battlemap ${sceneLabel}: collected ${collected.length} enemy entr${collected.length === 1 ? "y" : "ies"}`,
        collected.map(({ npcId, count }) => `${npcId}×${Math.max(1, Number(count) || 1)}`)
      );
    }
    const enemies = collected
      .map(({ npcId, count, disposition }) => {
        const actor = actorsByDlceId.get(npcId);
        if (!actor) {
          console.warn(`${MODULE_ID} | battlemap ${sceneLabel}: enemy missing actor for ${npcId}`);
          return null;
        }
        placedNpcIds.add(npcId);
        return { actor, count, disposition };
      })
      .filter(Boolean);
    if (collected.length && !enemies.length) {
      console.warn(
        `${MODULE_ID} | battlemap ${sceneLabel}: none of the ${collected.length} collected enemies resolved to an actor`
      );
    }
    await finalizeBattlemapScene(meta.scene, { enemies, party: partyForBattlemaps });
  }

  if (landingScene) {
    await finalizeLandingScene(landingScene, sessionPcs);
  }

  // --- Items ---
  /** @type {Map<string, string[]>} locationId -> item uuids */
  const itemsByLocation = new Map();
  /** @type {Array<{ name: string, img?: string, uuid: string, dlceId: string }>} */
  const leftoverItems = [];
  for (const entry of (manifest.documents ?? []).filter((d) => d.type === "item")) {
    const raw = readDocument(entry.file) ?? {};
    const portrait = entry.portrait ? uploaded.get(entry.portrait) : null;
    const fields = raw?.fields ?? {};
    const item = await Item.create({
      name: entry.name,
      type: mapItemType(entry.subtype, fields),
      img: portrait || undefined,
      folder: folders.Item?.id ?? null,
      system: {
        description: {
          value: markdownToHtml(
            fields.description || fields.appearance || fields.effect || fields.text || ""
          )
        },
        rarity: String(fields.rarity || "").toLowerCase() || undefined
      },
      flags: {
        [FLAG_SCOPE]: {
          dlceId: entry.id,
          subtype: entry.subtype ?? "plot",
          locationIds: entry.locationIds ?? [],
          importKey
        }
      }
    });
    createdByDlceId.set(entry.id, item.uuid);
    const locationIds = [
      ...new Set([
        ...(entry.locationIds ?? []),
        ...((raw?.links ?? [])
          .filter((link) => link?.target_type === "location" && link?.target_id)
          .map((link) => String(link.target_id)))
      ])
    ];
    if (locationIds.length) {
      for (const locationId of locationIds) {
        const list = itemsByLocation.get(locationId) ?? [];
        list.push(item.uuid);
        itemsByLocation.set(locationId, list);
      }
    } else {
      leftoverItems.push({
        name: entry.name,
        img: item.img || portrait || undefined,
        uuid: item.uuid,
        dlceId: entry.id
      });
    }
  }

  // Leftovers: NPCs not on any location/battlemap + items without a location
  const leftoverNpcs = npcRecords
    .filter((row) => !placedNpcIds.has(row.entry.id))
    .map((row) => ({ actor: row.actor, entry: row.entry }));
  if (leftoversScene) {
    await finalizeLeftoversScene(leftoversScene, {
      npcs: leftoverNpcs,
      itemNotes: leftoverItems
    });
    console.log(
      `${MODULE_ID} | Leftovers: ${leftoverNpcs.length} NPCs, ${leftoverItems.length} items`
    );
  }

  // --- Items-by-location Journal ---
  const itemPages = [];
  for (const entry of locations) {
    const uuids = itemsByLocation.get(entry.id) ?? [];
    const lines = uuids.length
      ? uuids.map((uuid) => `- @UUID[${uuid}]`)
      : ["_No items linked to this location._"];
    itemPages.push({
      name: entry.name,
      type: "text",
      text: { content: `<h2>${escapeHtml(entry.name)}</h2><p>${lines.join("<br>")}</p>`, format: 1 }
    });
  }
  if (itemPages.length) {
    const journal = await JournalEntry.create({
      name: `${folderName} — Items by location`,
      folder: folders.JournalEntry?.id ?? null,
      pages: itemPages,
      flags: { [FLAG_SCOPE]: { kind: "items-by-location", importKey } }
    });
    createdByDlceId.set("__items_journal__", journal.uuid);
  }

  // --- MSD Journal ---
  const msdPath = manifest.msd || "msd/msd.html";
  const msdBytes = files.get(msdPath);
  if (msdBytes) {
    const html = convertMsdHtmlForFoundry(decodeText(msdBytes), {
      createdByDlceId,
      uploaded,
      documents: manifest.documents ?? []
    });
    await JournalEntry.create({
      name: `${folderName} — MSD`,
      folder: folders.JournalEntry?.id ?? null,
      pages: [
        {
          name: "Master Session Document",
          type: "text",
          text: { content: html, format: 1 }
        }
      ],
      flags: { [FLAG_SCOPE]: { kind: "msd", importKey } }
    });
  }

  await setExclusiveSceneNavigation(new Set(sessionSceneIds));
  if (landing?.id) {
    await landing.activate(true);
  }

  await setSetting(SETTING_LIVE_SESSION, sessionKey(manifest));

  notify(
    `Imported ${folderName}: ${locations.length} locations, ${battlemapMeta.length} battlemaps, actors/items created, Landing active.`,
    { type: "info" }
  );

  return {
    importKey,
    folderName,
    sceneIds: sessionSceneIds,
    landingId: landing?.id ?? null,
    leftoversId: leftoversScene?.id ?? null
  };
}


function matchExistingPcActor(pc) {
  const ddbId = pc?.ddbId != null ? String(pc.ddbId).trim() : "";
  const name = String(pc?.name || "").trim().toLowerCase();
  const actors = [...(game.actors ?? [])];
  if (ddbId) {
    const byDdb = actors.find((actor) => {
      const flags = actor.flags ?? {};
      const candidates = [
        flags?.ddbimporter?.dndbeyond?.characterId,
        flags?.ddbimporter?.id,
        flags?.["ddb-importer"]?.id,
        flags?.[FLAG_SCOPE]?.ddbId
      ];
      return candidates.some((value) => value != null && String(value) === ddbId);
    });
    if (byDdb) {
      return byDdb;
    }
  }
  if (!name) {
    return null;
  }
  return actors.find((actor) => String(actor.name || "").trim().toLowerCase() === name) ?? null;
}

function mapItemType(subtype, fields) {
  if (subtype === "magic" || fields.rarity || fields.category) {
    return "loot";
  }
  if (subtype === "cash_loot" || subtype === "gold_pieces") {
    return "loot";
  }
  return "loot";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
