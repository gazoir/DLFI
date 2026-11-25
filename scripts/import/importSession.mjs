import {
  FLAG_SCOPE,
  ITEM_PILES_FOLDER_NAME,
  MODULE_ID,
  notify,
  PC_ACTOR_FOLDER_NAME,
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
  SETTING_TEMPLATE_OUTRO
} from "../constants.mjs";
import { escapeHtml } from "../util/html.mjs";
import { buildNpcNpcActorData } from "./buildNpcActor.mjs";
import { buildItemCreateData } from "./buildItemData.mjs";
import {
  alertEmptyPcs,
  alertPcStubResults,
  buildExistingPcFillPatch,
  buildPcActorData,
  matchExistingPcActor
} from "./buildPcActor.mjs";
import {
  applySceneBackground,
  refreshSceneThumbnails
} from "./applySceneBackground.mjs";
import {
  buildChallengeHostLocations,
  buildItemLocationsFromLocationLinks,
  buildNpcLocationsFromLocationLinks,
  collectChallengeEnemies,
  collectCombatEnemyIds,
  collectItemLocationIds,
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
  alertItemPilesMissing,
  finalizeBattlemapScene,
  finalizeLandingScene,
  finalizeLeftoversScene,
  finalizeLocationScene,
  isItemPilesActive,
  itemPilesDetectionDebug
} from "./scenePlacement.mjs";
import { populateAllMattSceneNav, sceneArtSrc } from "./mattSceneNav.mjs";
import { softSeatPlayersFromImport } from "./softSeatPlayers.mjs";
import {
  buildMsdSceneSequence,
  formatSceneDmName,
  formatSpecialSceneName
} from "./sceneOrder.mjs";
import { pickTokenTexture } from "./tokenArt.mjs";
import { convertMsdHtmlForFoundry } from "./msdJournal.mjs";
import {
  bundledKindForSetting,
  createSceneFromBundledTemplate,
  loadBundledPcActorTemplate
} from "./defaultTemplates.mjs";
import {
  ensureChildFolder,
  ensurePcActorFolder,
  ensureSessionFolders,
  navSceneIdsFor,
  setExclusiveSceneNavigation
} from "./folders.mjs";
import {
  purgeSessionAssets,
  purgeSnapshot,
  rollbackImport,
  snapshotFolderIds,
  snapshotIds,
  snapshotSessionDocuments
} from "./sessions.mjs";
import {
  ensureDataFolder,
  isSafePackagePath,
  mapWithConcurrency,
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

/** Parallel uploads during import (Foundry handles a few concurrent POSTs well). */
const UPLOAD_CONCURRENCY = 4;
/** Foundry's default sort spacing between sibling documents. */
const SORT_STEP = 100000;

/**
 * Upload a package asset into the DLFI imports tree, preserving the zip-relative path.
 * e.g. assets/portraits/loc_trader.webp → dlfi-imports/{packageRoot}/assets/portraits/…
 * @param {string} packagePath
 * @param {Uint8Array} bytes
 * @param {string} importsRoot e.g. dlfi-imports/SESSION_014__Name__stamp
 * @param {Set<string>} [cache] Data folders already ensured this import
 * @returns {Promise<string|null>} world path, or null when rejected / failed
 */
export async function uploadAsset(packagePath, bytes, importsRoot, cache) {
  const relative = String(packagePath || "").replace(/\\/g, "/");
  const root = normalizeDataPath(importsRoot);
  if (!isSafePackagePath(relative)) {
    console.warn(`${MODULE_ID} | refusing unsafe package path ${JSON.stringify(packagePath)}`);
    return null;
  }
  const target = `${root}/${relative}`;
  if (!root || !target.startsWith(`${root}/`)) {
    return null;
  }
  const parts = target.split("/");
  const name = parts.pop();
  const folder = parts.join("/");
  try {
    const uploaded = await uploadDataFile(folder, name, bytes, { cache });
    if (!uploaded) {
      console.warn(`${MODULE_ID} | upload rejected by Foundry for ${target}`);
    }
    return uploaded;
  } catch (error) {
    console.warn(`${MODULE_ID} | upload failed for ${target}`, error);
    return null;
  }
}

/**
 * Template clone (or bare Scene) with name / nav / folder / flags already set;
 * a follow-up update is sent only for fields the template path did not apply.
 * @param {string} settingKey
 * @param {string} name
 * @param {{ folderId?: string|null, flags: object, navigation: boolean }} options
 */
async function createSessionScene(settingKey, name, { folderId = null, flags, navigation }) {
  const scene =
    (await duplicateTemplateScene(settingKey, name, { folderId, flags })) ??
    (await Scene.create({ name, navigation, folder: folderId, flags }));
  const patch = {};
  if (scene.name !== name) patch.name = name;
  if ((scene.navName ?? "") !== "") patch.navName = "";
  if (Boolean(scene.navigation) !== navigation) patch.navigation = navigation;
  if ((scene.folder?.id ?? scene.folder ?? null) !== folderId) patch.folder = folderId;
  const want = flags?.[FLAG_SCOPE] ?? {};
  const have = scene.flags?.[FLAG_SCOPE] ?? {};
  if (Object.keys(want).some((key) => JSON.stringify(have[key]) !== JSON.stringify(want[key]))) {
    patch.flags = { [FLAG_SCOPE]: want };
  }
  if (Object.keys(patch).length) {
    await scene.update(patch);
  }
  return scene;
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
  const importStartedAt = Date.now();
  let lastProgressAt = importStartedAt;
  let progressStep = 0;

  /**
   * Step-by-step console progress so long imports do not look hung.
   * @param {string} label
   * @param {object|string|null} [detail]
   */
  const progress = (label, detail = null) => {
    progressStep += 1;
    const now = Date.now();
    const sinceStartMs = now - importStartedAt;
    const sinceLastMs = now - lastProgressAt;
    lastProgressAt = now;
    const prefix = `${MODULE_ID} | import ${progressStep}: ${label}`;
    const timing = `(+${(sinceLastMs / 1000).toFixed(1)}s, ${ (sinceStartMs / 1000).toFixed(1)}s total)`;
    if (detail != null && detail !== "") {
      console.log(`${prefix} ${timing}`, detail);
    } else {
      console.log(`${prefix} ${timing}`);
    }
  };

  progress("start", {
    sessionCode: manifest.sessionCode,
    displayCode: manifest.displayCode,
    sessionName: manifest.sessionName,
    exportedAt: manifest.exportedAt,
    source: loaded.sourceLabel,
    fileCount: files?.size ?? 0,
    documentCount: (manifest.documents ?? []).length,
    pcCount: (manifest.pcs ?? []).length,
    partyLevel: manifest.partyLevel ?? null
  });

  if (options.packCurrentLive !== false && liveKey) {
    notify("DLFI: Pack-to-Archive before import is stubbed in 0.1 — continuing with import.", {
      type: "warning"
    });
  }

  const replaceExisting =
    options.replaceExisting ?? setting(SETTING_REPLACE_ON_REIMPORT) !== false;
  // The previous import is only frozen here; it is purged after the new one is live.
  const previous = snapshotSessionDocuments(manifest.sessionCode);
  const previousIds = snapshotIds(previous);
  if (previous) {
    progress(replaceExisting ? "previous import found (replaced on success)" : "previous import kept", {
      scenes: previous.docs.scenes.length,
      actors: previous.docs.actors.length
    });
  }

  progress("ensure session folders");
  const { name: folderName, folders, meta: sessionFolderMeta } = await ensureSessionFolders(
    manifest,
    importKey,
    { excludeIds: replaceExisting ? snapshotFolderIds(previous) : new Set() }
  );
  let committed = false;
  try {
  progress("ensure PC Actor folder", { name: PC_ACTOR_FOLDER_NAME });
  const pcActorFolder = await ensurePcActorFolder();
  progress("ensure Item Piles Actor folder", {
    parent: folderName,
    name: ITEM_PILES_FOLDER_NAME
  });
  const itemPilesFolder = await ensureChildFolder(folders.Actor, ITEM_PILES_FOLDER_NAME, {
    ...sessionFolderMeta,
    kind: "item-piles"
  });

  /** @type {Map<string, string>} packagePath -> world data path */
  const uploaded = new Map();
  const importsBase = String(setting(SETTING_IMPORTS) || "dlfi-imports").trim() || "dlfi-imports";
  const packageRoot = packageImportRoot(manifest, loaded.sourceLabel);
  const ensuredFolders = new Set();
  const importsRoot = await ensureDataFolder(`${importsBase}/${packageRoot}`, { cache: ensuredFolders });
  progress("upload assets", { importsRoot });

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
      await ensureDataFolder(`${importsRoot}/${sub}`, { cache: ensuredFolders });
    } catch (error) {
      console.warn(`${MODULE_ID} | precreate ${sub} failed`, error);
    }
  }

  let uploadFailures = 0;
  let uploadOk = 0;
  const uploadable = [...files.entries()].filter(([path]) => shouldUploadPackagePath(path));
  const uploadTotal = uploadable.length;
  let uploadIndex = 0;
  const uploadResults = await mapWithConcurrency(uploadable, UPLOAD_CONCURRENCY, async ([path, bytes]) => {
    const worldPath = await uploadAsset(path, bytes, importsRoot, ensuredFolders);
    uploadIndex += 1;
    if (uploadIndex === 1 || uploadIndex === uploadTotal || uploadIndex % 25 === 0) {
      progress(`uploaded asset ${uploadIndex}/${uploadTotal}`, path);
    }
    return worldPath;
  });
  uploadable.forEach(([path], index) => {
    const worldPath = uploadResults[index];
    if (worldPath) {
      uploaded.set(path, worldPath);
      uploadOk += 1;
    } else {
      uploadFailures += 1;
    }
  });
  progress("assets uploaded", { ok: uploadOk, failed: uploadFailures, total: uploadTotal });
  if (uploadFailures) {
    notify(`DLFI: ${uploadFailures} asset upload(s) failed — check console for paths.`, {
      type: "warning"
    });
  }

  /** @type {Map<string, object|null>} parsed package JSON, once per file */
  const parsedDocuments = new Map();
  const readDocument = (file) => {
    if (!file) {
      return null;
    }
    if (parsedDocuments.has(file)) {
      return parsedDocuments.get(file);
    }
    const bytes = files.get(file);
    let parsed = null;
    if (bytes) {
      try {
        parsed = decodeJson(bytes);
      } catch (error) {
        console.warn(`${MODULE_ID} | failed to parse ${file}`, error);
      }
    }
    parsedDocuments.set(file, parsed);
    return parsed;
  };

  /** @type {Map<string, string>} dlce id -> Foundry doc uuid */
  const createdByDlceId = new Map();
  /** @type {Map<string, { scene: Scene, description: string, poisText: string, sessionNotes: string, npcs: Array<{actor: Actor, entry: object}>, items: Array<{item: Item, name: string, subtype: string, dlceId: string|null}> }>} */
  const locationSceneMeta = new Map();
  /** @type {string[]} */
  const sessionSceneIds = [];
  let landingScene = null;
  let outroScene = null;
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
  progress("create location + battlemap scenes", {
    locations: locations.length,
    sequenceSteps: sceneSequence.length
  });

  for (const step of sceneSequence) {
    const { kind, entry, order } = step;
    const dmName = formatSceneDmName(kind, entry, order);

    if (kind === "location") {
      const scene = await createSessionScene(SETTING_TEMPLATE_LOCATION, dmName, {
        folderId: folders.Scene?.id ?? null,
        flags: { [FLAG_SCOPE]: { dlceId: entry.id, kind: "location", importKey } },
        navigation: true
      });

      const bg = resolveLocationBackground(entry, uploaded);
      if (bg) {
        await applySceneBackground(scene, bg, { refreshThumb: false });
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
        artwork: bg || sceneArtSrc(scene),
        description: locationDescriptionText(raw),
        poisText: formatPoisBulletList(locationPois(raw)),
        sessionNotes: locationSessionNotesText(raw, manifest),
        npcs: [],
        items: []
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
    const scene = await createSessionScene(SETTING_TEMPLATE_BATTLEMAP, dmName, {
      folderId: folders.Scene?.id ?? null,
      flags: { [FLAG_SCOPE]: { dlceId: entry.id, kind: "battlemap", importKey } },
      navigation: true
    });
    if (!mapPath) {
      console.warn(`${MODULE_ID} | no colour battlemap found for ${entry.id} (${entry.name})`);
    } else {
      await applySceneBackground(scene, mapPath, { refreshThumb: false });
    }
    sessionSceneIds.push(scene.id);
    createdByDlceId.set(entry.id, scene.uuid);
    battlemapMeta.push({
      scene,
      entry,
      raw,
      artwork: mapPath || sceneArtSrc(scene),
      hostLocationId: locId || null
    });
  }

  // Reverse index: location "Owned by" / similar links → NPC placement
  const reverseNpcLocations = buildNpcLocationsFromLocationLinks(locations, readDocument);

  // --- Landing ---
  // Clean = scene background; Logo Only / Title Only replace named template tiles.
  const landingArt = resolveLandingPageArt(manifest, uploaded);
  const lastMsdOrder = sceneSequence.reduce(
    (max, step) => Math.max(max, Number(step.order) || 0),
    0
  );
  const landingName = formatSpecialSceneName("landing", manifest, lastMsdOrder);
  const outroName = formatSpecialSceneName("outro", manifest, lastMsdOrder);
  const leftoversName = formatSpecialSceneName("leftovers", manifest, lastMsdOrder);
  const landing = await createSessionScene(SETTING_TEMPLATE_LANDING, landingName, {
    folderId: folders.Scene?.id ?? null,
    navigation: true,
    flags: {
      [FLAG_SCOPE]: {
        kind: "landing",
        importKey,
        /** Hide Active Effect icons on Landing tokens (sheet/nameplate stay). */
        hideTokenEffects: true,
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
    await applySceneBackground(landing, landingArt.background, { refreshThumb: false });
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

  // --- Outro (Thanks for Playing) — Landing-like; user owns the Thanks tile on the template ---
  const outro = await createSessionScene(SETTING_TEMPLATE_OUTRO, outroName, {
    folderId: folders.Scene?.id ?? null,
    navigation: true,
    flags: {
      [FLAG_SCOPE]: {
        kind: "outro",
        importKey,
        hideTokenEffects: true
      }
    }
  });
  // Same Clean session art as Landing background; do not swap Logo/Title tiles.
  if (landingArt.background) {
    await applySceneBackground(outro, landingArt.background, { refreshThumb: false });
  }
  sessionSceneIds.push(outro.id);
  outroScene = outro;

  // --- Leftovers (formerly Inbox): catch-all for unplaced NPCs/items ---
  const leftovers = await createSessionScene(SETTING_TEMPLATE_INBOX, leftoversName, {
    folderId: folders.Scene?.id ?? null,
    flags: { [FLAG_SCOPE]: { kind: "leftovers", importKey } },
    navigation: false
  });
  leftoversScene = leftovers;
  sessionSceneIds.push(leftovers.id);

  // Nav bar + Scene Directory order: Landing → MSD sequence → Outro → Leftovers.
  {
    const ordered = [
      landing,
      ...sceneSequence
        .map((step) =>
          step.kind === "location"
            ? locationSceneMeta.get(step.entry.id)?.scene
            : battlemapMeta.find((meta) => meta.entry === step.entry)?.scene
        )
        .filter(Boolean),
      outro,
      leftovers
    ].filter((scene, index, list) => scene && list.indexOf(scene) === index);
    await Scene.updateDocuments(
      ordered.map((scene, index) => ({ _id: scene.id, navOrder: index, sort: (index + 1) * SORT_STEP }))
    );
  }

  // --- NPCs / monsters as Actors ---
  /** @type {Map<string, Actor>} */
  const actorsByDlceId = new Map();
  /** @type {Set<string>} NPCs placed on a location or battlemap */
  const placedNpcIds = new Set();
  /** @type {Array<{ entry: object, raw: object, actor: Actor }>} */
  const npcRecords = [];

  const npcEntries = (manifest.documents ?? []).filter((d) => d.type === "npc");
  progress("create NPC actors", { count: npcEntries.length });
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

  const npcIds = new Set([
    ...npcEntries.map((entry) => entry.id),
    ...(manifest.pcs ?? []).flatMap((pc) => (pc.pets ?? []).map((pet) => pet.id))
  ].filter(Boolean));
  const npcActorData = npcEntries.map((entry) => {
    const raw = npcRawById.get(entry.id) ?? {};
    const { portrait, token, tokenSlots, tokenWildcard } = resolveNpcMedia(entry, uploaded, { npcIds });
    return buildNpcNpcActorData(raw, entry, {
      portrait,
      token,
      tokenSlots,
      tokenWildcard,
      combatEnemy: combatEnemyIds.has(entry.id),
      tokenScale: entry.tokenScale,
      folderId: folders.Actor?.id ?? null,
      importKey
    });
  });
  const npcActors = npcActorData.length ? await Actor.createDocuments(npcActorData) : [];
  for (const [index, entry] of npcEntries.entries()) {
    const raw = npcRawById.get(entry.id) ?? {};
    const actor = npcActors[index];
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
  /** @type {Array<{ name: string, knownAs?: string|null, ddbUrl?: string|null, id?: string|null }>} */
  const createdPcStubs = [];
  /** @type {Array<{ name: string, knownAs?: string|null, id?: string|null }>} */
  const pcsMissingDdb = [];

  const manifestPcs = manifest.pcs ?? [];
  progress("PCs from package", {
    count: manifestPcs.length,
    folder: PC_ACTOR_FOLDER_NAME,
    names: manifestPcs.map((pc) => pc.knownAs || pc.name || pc.id)
  });
  if (!manifestPcs.length) {
    await alertEmptyPcs({
      sessionName: manifest.sessionName ?? folderName,
      displayCode: manifest.displayCode ?? manifest.sessionCode,
      partyLevel: manifest.partyLevel ?? null,
      exportedAt: manifest.exportedAt ?? null
    });
  }

  const pcActorTemplate = await loadBundledPcActorTemplate();
  if (!pcActorTemplate) {
    console.warn(
      `${MODULE_ID} | bundled PC actor template missing — falling back to minimal character stub`
    );
  }

  /** @type {Array<{ actor: Actor|null, pc: object, stubData?: object }>} */
  const pcRows = [];
  for (const pc of manifestPcs) {
    const portrait = pc.portrait ? uploaded.get(pc.portrait) || null : null;
    const token = pc.token ? uploaded.get(pc.token) || null : null;
    const actor = matchExistingPcActor(pc);
    if (actor) {
      progress(`match existing PC ${pc.knownAs || pc.name || pc.id}`, actor.uuid);
      const patch = buildExistingPcFillPatch(actor, pc, {
        portrait,
        token,
        tokenScale: pc.tokenScale,
        sessionCode: manifest.sessionCode
      });
      if (Object.keys(patch).length) {
        await actor.update(patch);
      }
      pcRows.push({ actor, pc });
      continue;
    }
    progress(`create PC stub ${pc.knownAs || pc.name || pc.id}`, {
      folder: PC_ACTOR_FOLDER_NAME,
      ddbUrl: pc.ddbUrl ?? null,
      portrait: Boolean(portrait),
      token: Boolean(token)
    });
    pcRows.push({
      actor: null,
      pc,
      stubData: buildPcActorData(pc, {
        portrait,
        token,
        tokenScale: pc.tokenScale,
        folderId: pcActorFolder?.id ?? null,
        importKey,
        sessionCode: manifest.sessionCode,
        template: pcActorTemplate
      })
    });
  }
  const stubRows = pcRows.filter((row) => row.stubData);
  const stubActors = stubRows.length
    ? await Actor.createDocuments(stubRows.map((row) => row.stubData))
    : [];
  stubRows.forEach((row, index) => {
    row.actor = stubActors[index];
    const { pc, actor } = row;
    const stubInfo = {
      name: String(pc.name || actor.name || "").trim() || actor.name,
      knownAs: pc.knownAs ?? null,
      ddbUrl: pc.ddbUrl ?? null,
      id: pc.id ?? null
    };
    createdPcStubs.push(stubInfo);
    if (!String(pc.ddbUrl || "").trim() && !(pc.ddbId != null && String(pc.ddbId).trim())) {
      pcsMissingDdb.push({
        name: stubInfo.name,
        knownAs: stubInfo.knownAs,
        id: stubInfo.id
      });
    }
    console.log(
      `${MODULE_ID} | created PC stub ${actor.name}` +
        (pc.ddbUrl ? ` (DDB ${pc.ddbId || pc.ddbUrl})` : " (no DDB URL)")
    );
  });

  /** @type {Array<{ data: object, ownerPcId: string, pet: object }>} */
  const petRows = [];
  for (const { actor, pc } of pcRows) {
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
      const petMedia = resolveNpcMedia(petEntry, uploaded, { npcIds });
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
      petRows.push({ data: petActorData, ownerPcId: String(pet.ownerPcId || pc.id || ""), pet });
    }
  }
  const petActors = petRows.length ? await Actor.createDocuments(petRows.map((row) => row.data)) : [];
  petRows.forEach(({ ownerPcId, pet }, index) => {
    const petActor = petActors[index];
    createdByDlceId.set(pet.id, petActor.uuid);
    actorsByDlceId.set(pet.id, petActor);
    sessionPets.push({ actor: petActor, ownerPcId, pet });
    placedNpcIds.add(pet.id);
  });

  // --- Items (before location finalize so piles land with NPCs/descriptions) ---
  /** @type {Map<string, string[]>} locationId -> item uuids */
  const itemsByLocation = new Map();
  /** @type {Array<{ name: string, img?: string, uuid: string, dlceId: string }>} */
  const leftoverItems = [];
  const itemEntries = (manifest.documents ?? []).filter((d) => d.type === "item");
  progress("create items", { count: itemEntries.length });
  const reverseItemLocations = buildItemLocationsFromLocationLinks(locations, readDocument);
  const itemRows = itemEntries.map((entry) => {
    const raw = readDocument(entry.file) ?? {};
    const portrait = entry.portrait ? uploaded.get(entry.portrait) : null;
    const fields = raw?.fields ?? {};
    const subtype = entry.subtype ?? fields.subtype ?? "plot";
    return {
      entry,
      raw,
      portrait,
      subtype,
      data: buildItemCreateData({
        entry: { ...entry, subtype },
        fields,
        portraitWorldPath: portrait || null,
        folderId: folders.Item?.id ?? null,
        importKey
      })
    };
  });
  const createdItems = itemRows.length ? await Item.createDocuments(itemRows.map((row) => row.data)) : [];
  for (const [index, { entry, raw, portrait, subtype }] of itemRows.entries()) {
    const item = createdItems[index];
    createdByDlceId.set(entry.id, item.uuid);
    const locationIds = collectItemLocationIds(
      entry,
      raw,
      reverseItemLocations.get(entry.id) ?? []
    );
    if (locationIds.length) {
      for (const locationId of locationIds) {
        const list = itemsByLocation.get(locationId) ?? [];
        list.push(item.uuid);
        itemsByLocation.set(locationId, list);
        const meta = locationSceneMeta.get(locationId);
        if (meta) {
          meta.items.push({
            item,
            name: entry.name,
            subtype,
            dlceId: entry.id
          });
        }
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

  // One modal for the whole import if Item Piles is missing but locations have items.
  const locationItemsFlat = [...locationSceneMeta.values()].flatMap((meta) =>
    (meta.items ?? []).map((row) => ({
      ...row,
      sceneName: meta.scene?.name
    }))
  );
  const itemPilesActive = isItemPilesActive();
  progress("Item Piles check", {
    ...itemPilesDetectionDebug(),
    active: itemPilesActive,
    locationItemCount: locationItemsFlat.length
  });
  if (locationItemsFlat.length && !itemPilesActive) {
    await alertItemPilesMissing({
      scene: { name: `${folderName} (location scenes)` },
      items: locationItemsFlat
    });
  }

  // Bind NPCs into location template slots, fill descriptions, place item piles
  progress("finalize location scenes", {
    count: locationSceneMeta.size,
    placeItemPiles: itemPilesActive
  });
  for (const meta of locationSceneMeta.values()) {
    progress(`finalize location ${meta.scene?.name ?? "?"}`, {
      npcs: meta.npcs?.length ?? 0,
      items: meta.items?.length ?? 0
    });
    await finalizeLocationScene(meta.scene, {
      description: meta.description,
      poisText: meta.poisText,
      sessionNotes: meta.sessionNotes,
      npcs: meta.npcs,
      // Skip per-scene dialogs when we already alerted above.
      items: itemPilesActive ? meta.items : [],
      skipItemPiles: !itemPilesActive,
      itemPilesFolderId: itemPilesFolder?.id ?? null,
      sessionFolderName: folderName,
      importKey,
      sessionCode: manifest.sessionCode
    });
  }

  // Battlemap: enemies (unlinked) + party PCs/pets (linked) in bottom padding lines
  const npcDocumentsForLinks = npcRecords.map((row) => ({
    id: row.entry.id,
    name: row.entry.name,
    raw: row.raw
  }));
  const partyForBattlemaps = [];
  for (const { actor, pc } of sessionPcs) {
    if (!actor) {
      console.warn(
        `${MODULE_ID} | battlemap party skip pc ${pc?.id || "(no id)"} (${pc?.name || "?"}): no Foundry actor resolved`
      );
      continue;
    }
    const knownAs =
      String(pc?.knownAs || "").trim() ||
      String(pc?.name || actor.name || "")
        .trim()
        .split(/\s+/)[0] ||
      actor.name;
    partyForBattlemaps.push({
      actor,
      linked: true,
      kind: "battle-pc",
      dlceId: pc?.id ? String(pc.id) : null,
      label: pc?.name || actor.name,
      tokenName: knownAs
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
  progress("finalize battlemaps", {
    count: battlemapMeta.length,
    partyTokens: partyForBattlemaps.length
  });
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
    progress("finalize Landing", { seatedPcs: sessionPcs.length });
    await finalizeLandingScene(landingScene, sessionPcs);
  }

  if (outroScene) {
    progress("finalize Outro", { seatedPcs: sessionPcs.length });
    // Same PC slot binding as Landing when the Outro template has nPm placeholders.
    await finalizeLandingScene(outroScene, sessionPcs);
  }

  // Leftovers: NPCs not on any location/battlemap + items without a location
  const leftoverNpcs = npcRecords
    .filter((row) => !placedNpcIds.has(row.entry.id))
    .map((row) => ({ actor: row.actor, entry: row.entry }));
  if (leftoversScene) {
    progress("finalize Leftovers", {
      npcs: leftoverNpcs.length,
      items: leftoverItems.length
    });
    await finalizeLeftoversScene(leftoversScene, {
      npcs: leftoverNpcs,
      itemNotes: leftoverItems
    });
  }

  // Monk's Active Tile Triggers: left = Landing → locations → Outro; right = battlemaps.
  // Populate on Location / Landing / Outro only (not battlemaps / leftovers).
  {
    progress("populate MATT scene nav tiles");
    /** @param {object|null|undefined} actor */
    const faceFromActor = (actor) => {
      if (!actor) {
        return null;
      }
      const img =
        pickTokenTexture(actor, undefined, FLAG_SCOPE) ||
        actor?.prototypeToken?.texture?.src ||
        actor?.img ||
        null;
      if (!img) {
        return null;
      }
      return { img: String(img), name: String(actor.name || "").trim() || "NPC" };
    };
    const locationRows = [];
    for (const step of sceneSequence) {
      if (step.kind !== "location") {
        continue;
      }
      const meta = locationSceneMeta.get(step.entry.id);
      if (!meta?.scene) {
        continue;
      }
      const faces = (meta.npcs ?? [])
        .map((row) => faceFromActor(row?.actor))
        .filter(Boolean);
      locationRows.push({
        scene: meta.scene,
        kind: "location",
        dlceId: step.entry.id,
        img: meta.artwork || sceneArtSrc(meta.scene),
        name: meta.scene.name,
        faces
      });
    }
    // Nav thumb: Logo_Burn (logo + title on the session art), not the Clean BG.
    const landingImg =
      landingArt.logoBurn || landingArt.background || sceneArtSrc(landingScene);
    /** @type {Array<{ scene: object, kind: string, dlceId?: string|null, img?: string|null, name?: string }>} */
    const navScenes = [];
    /** @type {Array<{ sceneId: string, name: string, img?: string|null, kind: string, faces?: object[] }>} */
    const leftTargets = [];
    if (landingScene) {
      navScenes.push({
        scene: landingScene,
        kind: "landing",
        dlceId: null,
        img: landingImg,
        name: landingScene.name
      });
      leftTargets.push({
        sceneId: landingScene.id,
        name: landingScene.name,
        img: landingImg,
        kind: "landing",
        faces: []
      });
    }
    for (const row of locationRows) {
      navScenes.push(row);
      leftTargets.push({
        sceneId: row.scene.id,
        name: row.name || row.scene.name,
        img: row.img,
        kind: "location",
        faces: row.faces ?? []
      });
    }
    if (outroScene) {
      const outroImg = landingArt.background || sceneArtSrc(outroScene);
      navScenes.push({
        scene: outroScene,
        kind: "outro",
        dlceId: null,
        img: outroImg,
        name: outroScene.name
      });
      leftTargets.push({
        sceneId: outroScene.id,
        name: outroScene.name,
        img: outroImg,
        kind: "outro",
        faces: []
      });
    }
    const battleNav = battlemapMeta.map((meta) => ({
      sceneId: meta.scene.id,
      name: meta.scene.name,
      img: meta.artwork || sceneArtSrc(meta.scene),
      kind: "battlemap",
      hostLocationId: meta.hostLocationId ?? null
    }));
    await populateAllMattSceneNav({
      navScenes,
      leftTargets,
      battlemaps: battleNav
    });
  }

  // --- Items-by-location Journal ---
  progress("create journals (items-by-location + MSD)");
  const itemPages = [];
  for (const entry of locations) {
    const uuids = itemsByLocation.get(entry.id) ?? [];
    const body = uuids.length
      ? `<ul>${uuids.map((uuid) => `<li>@UUID[${uuid}]</li>`).join("")}</ul>`
      : "<p><em>No items linked to this location.</em></p>";
    itemPages.push({
      name: entry.name,
      type: "text",
      text: { content: `<h2>${escapeHtml(entry.name)}</h2>${body}`, format: 1 }
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

  await setExclusiveSceneNavigation(navSceneIdsFor(sessionSceneIds.map((id) => game.scenes.get(id))));
  if (landing?.id) {
    await landing.activate(true);
  }

  await setSetting(SETTING_LIVE_SESSION, sessionKey(manifest));
  committed = true;

  if (replaceExisting && previous) {
    progress("remove previous import (documents + assets)");
    try {
      const removed = await purgeSnapshot(previous, game, { clearLive: false });
      const assets = await purgeSessionAssets(manifest.sessionCode, importsBase, {
        exceptDirs: [importsRoot]
      });
      progress("removed previous import", { removed, assets });
      if (assets.remainingDirs.length) {
        notify(
          `DLFI: Foundry cannot delete files here — remove old asset folder(s) by hand: ` +
            assets.remainingDirs.map((dir) => `Data/${dir}`).join(", "),
          { type: "warning" }
        );
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | could not remove previous import of ${manifest.sessionCode}`, error);
      notify(`DLFI: imported, but the previous ${manifest.displayCode ?? manifest.sessionCode} import could not be fully removed — see console.`, {
        type: "warning"
      });
    }
  }

  try {
    progress("scene directory thumbnails", { scenes: sessionSceneIds.length });
    // Second pass: ensure every imported scene has a Scene Directory thumb.
    // Mid-import createThumbnail can fail before Level textures are ready;
    // ImageHelper fallback + a late pass fixes empty sidebar / session-nav tiles.
    await refreshSceneThumbnails(sessionSceneIds);
  } catch (error) {
    console.warn(`${MODULE_ID} | scene thumbnail refresh failed`, error);
  }

  try {
    progress("soft-seat player accounts", { seated: sessionPcs.length });
    await softSeatPlayersFromImport(sessionPcs);
  } catch (error) {
    console.warn(`${MODULE_ID} | soft-seat after import failed`, error);
  }

  if (pcsMissingDdb.length) {
    await alertPcStubResults({
      created: createdPcStubs,
      missingDdb: pcsMissingDdb
    });
  }

  progress("done", {
    folderName,
    locations: locations.length,
    battlemaps: battlemapMeta.length,
    npcs: npcEntries.length,
    items: itemEntries.length,
    pcsMatchedOrCreated: sessionPcs.length,
    pcStubsCreated: createdPcStubs.length,
    pcFolder: PC_ACTOR_FOLDER_NAME,
    landingId: landing?.id ?? landingScene?.id ?? null,
    outroId: outroScene?.id ?? null
  });

  notify(
    `Imported ${folderName}: ${locations.length} locations, ${battlemapMeta.length} battlemaps, actors/items created, Landing active.`,
    { type: "info" }
  );

  return {
    importKey,
    folderName,
    sceneIds: sessionSceneIds,
    landingId: landing?.id ?? null,
    outroId: outroScene?.id ?? null,
    leftoversId: leftoversScene?.id ?? null
  };
  } catch (error) {
    if (committed) {
      throw error;
    }
    console.error(`${MODULE_ID} | import of ${manifest.sessionCode} failed — rolling back`, error);
    try {
      const rolledBack = await rollbackImport(importKey, Object.values(folders), { keepIds: previousIds });
      console.warn(`${MODULE_ID} | rolled back partial import`, rolledBack);
    } catch (rollbackError) {
      console.error(`${MODULE_ID} | rollback failed`, rollbackError);
    }
    throw error;
  }
}
