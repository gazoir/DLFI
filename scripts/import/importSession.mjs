import {
  FLAG_SCOPE,
  MODULE_ID,
  notify,
  sessionKey,
  setSetting,
  SETTING_LIVE_SESSION,
  setting,
  SETTING_TEMPLATE_BATTLEMAP,
  SETTING_TEMPLATE_INBOX,
  SETTING_TEMPLATE_LANDING,
  SETTING_TEMPLATE_LOCATION
} from "../constants.mjs";
import { buildNpcNpcActorData } from "./buildNpcActor.mjs";
import { markdownToHtml } from "./markdown.mjs";
import {
  buildNpcLocationsFromLocationLinks,
  collectChallengeEnemies,
  collectNpcLocationIds,
  formatPoisBulletList,
  locationDescriptionText,
  locationPois,
  resolveColourBattlemapPath
} from "./packageLinks.mjs";
import {
  finalizeBattlemapScene,
  finalizeLandingScene,
  finalizeLeftoversScene,
  finalizeLocationScene
} from "./scenePlacement.mjs";
import {
  bundledKindForSetting,
  createSceneFromBundledTemplate
} from "./defaultTemplates.mjs";
import { ensureSessionFolders, setExclusiveSceneNavigation } from "./folders.mjs";
import { resolveScene } from "./resolveDocument.mjs";

function decodeJson(bytes) {
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

function decodeText(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

function padOrder(order) {
  const n = Number(order);
  if (!Number.isFinite(n) || n < 1) {
    return "99";
  }
  return String(Math.floor(n)).padStart(2, "0");
}

/**
 * Ensure a Data/ folder path exists (FilePicker.upload does not create parents).
 * @param {string} folderPath e.g. "dlfi/SESSION_…/assets/portraits"
 */
async function ensureDataFolder(folderPath) {
  const normalized = String(folderPath ?? "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!normalized) {
    return;
  }
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await FilePicker.createDirectory("data", current, { notify: false });
    } catch (error) {
      // Directory already exists — Foundry throws variously by version/OS.
      const message = String(error?.message ?? error ?? "");
      if (!/exist|EEXIST|already/i.test(message)) {
        // Browse to confirm; if browse works the folder is fine.
        try {
          await FilePicker.browse("data", current);
        } catch (browseError) {
          console.warn(`${MODULE_ID} | could not ensure folder ${current}`, error, browseError);
          throw error;
        }
      }
    }
  }
}

/**
 * Upload a package asset into Foundry's world data storage.
 * @param {string} packagePath
 * @param {Uint8Array} bytes
 * @param {string} importKey
 */
async function uploadAsset(packagePath, bytes, importKey) {
  const safeKey = importKey.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const target = `dlfi/${safeKey}/${packagePath.replace(/^\/+/, "")}`;
  const folder = target.split("/").slice(0, -1).join("/");
  const name = target.split("/").pop();
  const blob = new Blob([bytes]);
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  try {
    await ensureDataFolder(folder);
    await FilePicker.upload("data", folder, file, {}, { notify: false });
    return target;
  } catch (error) {
    // Older Foundry signatures: upload(source, path, file, options)
    try {
      await ensureDataFolder(folder);
      await FilePicker.upload("data", folder, file, { notify: false });
      return target;
    } catch (retryError) {
      console.warn(`${MODULE_ID} | upload failed for ${target}`, retryError || error);
      return null;
    }
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
 * @param {{ packCurrentLive?: boolean }} [options]
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

  const { name: folderName, folders } = await ensureSessionFolders(manifest, importKey);

  /** @type {Map<string, string>} packagePath -> world data path */
  const uploaded = new Map();
  const safeImportKey = importKey.replace(/[^a-zA-Z0-9_-]+/g, "_");
  // FilePicker.upload requires the target directory to already exist.
  for (const sub of ["assets/portraits", "assets/tokens", "assets/battlemaps", "assets/session"]) {
    try {
      await ensureDataFolder(`dlfi/${safeImportKey}/${sub}`);
    } catch (error) {
      console.warn(`${MODULE_ID} | precreate ${sub} failed`, error);
    }
  }
  let uploadFailures = 0;
  for (const [path, bytes] of files) {
    if (!path.startsWith("assets/")) {
      continue;
    }
    const worldPath = await uploadAsset(path, bytes, importKey);
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

  // --- Locations as scenes ---
  const locations = (manifest.documents ?? []).filter((entry) => entry.type === "location");
  locations.sort((a, b) => (a.msdOrder ?? 99) - (b.msdOrder ?? 99));

  for (const entry of locations) {
    const order = padOrder(entry.msdOrder);
    const dmName = `${order}. ${entry.name}`;
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

    const bg = entry.portrait ? uploaded.get(entry.portrait) : null;
    const update = {
      name: dmName,
      navName: "",
      navigation: true,
      folder: folders.Scene?.id ?? null,
      flags: { [FLAG_SCOPE]: { dlceId: entry.id, kind: "location", importKey } }
    };
    if (bg) {
      update.background = { src: bg };
    }
    await scene.update(update);
    sessionSceneIds.push(scene.id);
    createdByDlceId.set(entry.id, scene.uuid);

    const raw = readDocument(entry.file);
    locationSceneMeta.set(entry.id, {
      scene,
      description: locationDescriptionText(raw),
      poisText: formatPoisBulletList(locationPois(raw)),
      npcs: []
    });
  }

  // Reverse index: location "Owned by" / similar links → NPC placement
  const reverseNpcLocations = buildNpcLocationsFromLocationLinks(locations, readDocument);

  // --- Landing ---
  const landingArt = manifest.sessionArt ? uploaded.get(manifest.sessionArt) : null;
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
    ...(landingArt ? { background: { src: landingArt } } : {}),
    flags: { [FLAG_SCOPE]: { kind: "landing", importKey } }
  });
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

  // --- Battlemap scene shells for combat challenges ---
  const battlemapAssetPaths = [
    ...(manifest.assets?.battlemaps ?? []),
    ...[...uploaded.keys()].filter((path) => /^assets\/battlemaps\//i.test(path))
  ];
  /** @type {Array<{ scene: Scene, entry: object, raw: object|null }>} */
  const battlemapMeta = [];
  const combats = (manifest.documents ?? []).filter((entry) => entry.type === "challenge");
  for (const entry of combats) {
    const raw = readDocument(entry.file);
    const kind = String(raw?.fields?.kind ?? entry.subtype ?? "").toLowerCase();
    if (kind && kind !== "combat") {
      continue;
    }
    const locId = (entry.locationIds ?? [])[0];
    const locEntry =
      (manifest.documents ?? []).find((d) => d.id === locId && d.type === "location") ?? null;
    const mapPath = resolveColourBattlemapPath({
      entry,
      raw,
      locationEntry: locEntry,
      uploaded,
      assetPaths: battlemapAssetPaths
    });
    const sceneName = `Battle — ${entry.name}`;
    let scene =
      (await duplicateTemplateScene(SETTING_TEMPLATE_BATTLEMAP, sceneName, {
        folderId: folders.Scene?.id ?? null,
        flags: { [FLAG_SCOPE]: { dlceId: entry.id, kind: "battlemap", importKey } }
      })) ??
      (await Scene.create({
        name: sceneName,
        navigation: true,
        folder: folders.Scene?.id ?? null
      }));
    await scene.update({
      name: sceneName,
      navName: "",
      navigation: true,
      folder: folders.Scene?.id ?? null,
      ...(mapPath ? { background: { src: mapPath } } : {}),
      flags: { [FLAG_SCOPE]: { dlceId: entry.id, kind: "battlemap", importKey } }
    });
    if (!mapPath) {
      console.warn(`${MODULE_ID} | no colour battlemap found for ${entry.id} (${entry.name})`);
    } else {
      console.log(`${MODULE_ID} | battlemap ${entry.name} background → ${mapPath}`);
    }
    sessionSceneIds.push(scene.id);
    createdByDlceId.set(entry.id, scene.uuid);
    battlemapMeta.push({ scene, entry, raw });
  }

  // --- NPCs / monsters as Actors ---
  /** @type {Map<string, Actor>} */
  const actorsByDlceId = new Map();
  /** @type {Set<string>} NPCs placed on a location or battlemap */
  const placedNpcIds = new Set();
  /** @type {Array<{ entry: object, raw: object, actor: Actor }>} */
  const npcRecords = [];

  for (const entry of (manifest.documents ?? []).filter((d) => d.type === "npc")) {
    const raw = readDocument(entry.file) ?? {};
    const portrait = entry.portrait ? uploaded.get(entry.portrait) : null;
    const token = entry.token ? uploaded.get(entry.token) : null;
    const actorData = buildNpcNpcActorData(raw, entry, {
      portrait,
      token,
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

  // Bind NPCs into location template slots, fill descriptions, remove unused placeholders
  for (const meta of locationSceneMeta.values()) {
    await finalizeLocationScene(meta.scene, {
      description: meta.description,
      poisText: meta.poisText,
      npcs: meta.npcs
    });
  }

  // Battlemap enemy tokens (unlinked)
  const npcDocumentsForLinks = npcRecords.map((row) => ({
    id: row.entry.id,
    raw: row.raw
  }));
  for (const meta of battlemapMeta) {
    const enemies = collectChallengeEnemies(meta.entry, meta.raw, {
      npcDocuments: npcDocumentsForLinks
    })
      .map(({ npcId, count }) => {
        const actor = actorsByDlceId.get(npcId);
        if (!actor) {
          console.warn(`${MODULE_ID} | battlemap enemy missing actor for ${npcId}`);
          return null;
        }
        placedNpcIds.add(npcId);
        return { actor, count };
      })
      .filter(Boolean);
    await finalizeBattlemapScene(meta.scene, enemies);
  }

  // Landing PC slots (match existing world actors by DDB id then name)
  const matchedPcs = [];
  for (const pc of manifest.pcs ?? []) {
    const actor = matchExistingPcActor(pc);
    if (actor) {
      matchedPcs.push({ actor, pc });
    }
  }
  if (landingScene) {
    await finalizeLandingScene(landingScene, matchedPcs);
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
    const html = rewriteMsdLinks(decodeText(msdBytes), createdByDlceId);
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

function rewriteMsdLinks(html, createdByDlceId) {
  // Leave unresolved wiki-style names; replace data-dlce-id when present.
  let next = html;
  for (const [dlceId, uuid] of createdByDlceId) {
    if (dlceId.startsWith("__")) {
      continue;
    }
    next = next.replaceAll(`data-dlce-id="${dlceId}"`, `data-uuid="${uuid}"`);
  }
  return next;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
