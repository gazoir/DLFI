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
import { ensureSessionFolders, setExclusiveSceneNavigation } from "./folders.mjs";

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
    await FilePicker.upload("data", folder, file, { notify: false });
  } catch (error) {
    console.warn(`${MODULE_ID} | upload failed for ${target}`, error);
    return null;
  }
  return target;
}

async function duplicateTemplateScene(settingKey, fallbackName) {
  const id = String(setting(settingKey) || "").trim();
  if (!id) {
    return null;
  }
  const template = game.scenes.get(id);
  if (!template) {
    notify(`DLFI: template scene not found for ${fallbackName} (${id}).`, { type: "warning" });
    return null;
  }
  const data = template.toObject();
  delete data._id;
  data.name = fallbackName;
  data.navigation = false;
  data.navOrder = data.navOrder ?? 0;
  return Scene.create(data);
}

/**
 * Import a loaded Session Package into the world.
 * v0.1: folders, asset upload, location/landing/battlemap/inbox scenes (from templates when set),
 * actors/items from document JSON (basic), MSD journal, exclusive nav.
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
  for (const [path, bytes] of files) {
    if (!path.startsWith("assets/")) {
      continue;
    }
    const worldPath = await uploadAsset(path, bytes, importKey);
    if (worldPath) {
      uploaded.set(path, worldPath);
    }
  }

  /** @type {Map<string, string>} dlce id -> Foundry doc uuid */
  const createdByDlceId = new Map();
  /** @type {string[]} */
  const sessionSceneIds = [];

  // --- Locations as scenes ---
  const locations = (manifest.documents ?? []).filter((entry) => entry.type === "location");
  locations.sort((a, b) => (a.msdOrder ?? 99) - (b.msdOrder ?? 99));

  for (const entry of locations) {
    const order = padOrder(entry.msdOrder);
    const dmName = `${order}. ${entry.name}`;
    let scene =
      (await duplicateTemplateScene(SETTING_TEMPLATE_LOCATION, dmName)) ??
      (await Scene.create({
        name: dmName,
        navigation: true,
        folder: folders.Scene?.id ?? null,
        flags: { [FLAG_SCOPE]: { dlceId: entry.id, kind: "location", importKey } }
      }));

    const bg = entry.portrait ? uploaded.get(entry.portrait) : null;
    const battle = entry.battlemap ? uploaded.get(entry.battlemap) : null;
    const update = {
      name: dmName,
      navName: "",
      navigation: true,
      folder: folders.Scene?.id ?? null,
      flags: { [FLAG_SCOPE]: { dlceId: entry.id, kind: "location", importKey } }
    };
    if (bg) {
      update.background = { src: bg };
    } else if (battle) {
      update.background = { src: battle };
    }
    await scene.update(update);
    sessionSceneIds.push(scene.id);
    createdByDlceId.set(entry.id, scene.uuid);

    // Description → text drawing (random among Description 1-4 if present on template)
    const docBytes = files.get(entry.file);
    const description = docBytes
      ? String(decodeJson(docBytes)?.fields?.description ?? "").trim()
      : "";
    if (description) {
      await placeDescriptionDrawing(scene, description);
    }
  }

  // --- Landing ---
  const landingArt = manifest.sessionArt ? uploaded.get(manifest.sessionArt) : null;
  let landing =
    (await duplicateTemplateScene(SETTING_TEMPLATE_LANDING, `${folderName} — Landing`)) ??
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

  // --- Per-import Inbox ---
  let inbox =
    (await duplicateTemplateScene(SETTING_TEMPLATE_INBOX, `${folderName} — Inbox`)) ??
    (await Scene.create({
      name: `${folderName} — Inbox`,
      navigation: false,
      folder: folders.Scene?.id ?? null
    }));
  await inbox.update({
    name: `${folderName} — Inbox`,
    navName: "",
    navigation: false,
    folder: folders.Scene?.id ?? null,
    flags: { [FLAG_SCOPE]: { kind: "inbox", importKey } }
  });

  // --- Battlemap scenes for combat challenges ---
  const combats = (manifest.documents ?? []).filter((entry) => entry.type === "challenge");
  for (const entry of combats) {
    const docBytes = files.get(entry.file);
    const raw = docBytes ? decodeJson(docBytes) : null;
    const kind = String(raw?.fields?.kind ?? "").toLowerCase();
    if (kind && kind !== "combat") {
      continue;
    }
    const locId = (entry.locationIds ?? [])[0];
    const locEntry = (manifest.documents ?? []).find((d) => d.id === locId && d.type === "location");
    const mapPath = locEntry?.battlemap ? uploaded.get(locEntry.battlemap) : null;
    const sceneName = `Battle — ${entry.name}`;
    let scene =
      (await duplicateTemplateScene(SETTING_TEMPLATE_BATTLEMAP, sceneName)) ??
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
    sessionSceneIds.push(scene.id);
    createdByDlceId.set(entry.id, scene.uuid);
  }

  // --- NPCs / monsters as Actors ---
  for (const entry of (manifest.documents ?? []).filter((d) => d.type === "npc")) {
    const docBytes = files.get(entry.file);
    const raw = docBytes ? decodeJson(docBytes) : {};
    const portrait = entry.portrait ? uploaded.get(entry.portrait) : null;
    const token = entry.token ? uploaded.get(entry.token) : null;
    const actor = await Actor.create({
      name: entry.name,
      type: entry.subtype === "monster" ? "npc" : "npc",
      img: portrait || undefined,
      folder: folders.Actor?.id ?? null,
      prototypeToken: token
        ? { texture: { src: token } }
        : portrait
          ? { texture: { src: portrait } }
          : undefined,
      system: buildBasicNpcSystem(raw?.fields ?? {}),
      flags: {
        [FLAG_SCOPE]: {
          dlceId: entry.id,
          subtype: entry.subtype ?? "person",
          locationIds: entry.locationIds ?? [],
          importKey
        }
      }
    });
    createdByDlceId.set(entry.id, actor.uuid);

    // Place on linked location scenes (centred / first slot stub)
    for (const locationId of entry.locationIds ?? []) {
      const sceneUuid = createdByDlceId.get(locationId);
      const scene = sceneUuid ? fromUuidSync(sceneUuid) : null;
      if (scene?.createEmbeddedDocuments) {
        await scene.createEmbeddedDocuments("Token", [
          {
            name: entry.name,
            actorId: actor.id,
            actorLink: true,
            texture: { src: token || portrait || actor.img },
            x: Math.round((scene.width ?? 4000) / 2),
            y: Math.round((scene.height ?? 3000) / 2)
          }
        ]);
      }
    }
  }

  // --- Items ---
  /** @type {Map<string, string[]>} locationId -> item uuids */
  const itemsByLocation = new Map();
  for (const entry of (manifest.documents ?? []).filter((d) => d.type === "item")) {
    const docBytes = files.get(entry.file);
    const raw = docBytes ? decodeJson(docBytes) : {};
    const portrait = entry.portrait ? uploaded.get(entry.portrait) : null;
    const item = await Item.create({
      name: entry.name,
      type: mapItemType(entry.subtype, raw?.fields ?? {}),
      img: portrait || undefined,
      folder: folders.Item?.id ?? null,
      system: {
        description: {
          value: String(raw?.fields?.description || raw?.fields?.appearance || "")
        }
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
    for (const locationId of entry.locationIds ?? []) {
      const list = itemsByLocation.get(locationId) ?? [];
      list.push(item.uuid);
      itemsByLocation.set(locationId, list);
    }
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
    `Imported ${folderName}: ${locations.length} locations, actors/items created, Landing active.`,
    { type: "info" }
  );

  return {
    importKey,
    folderName,
    sceneIds: sessionSceneIds,
    landingId: landing?.id ?? null
  };
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

function buildBasicNpcSystem(fields) {
  const ac = Number(fields.combat_ac);
  const hp = Number(fields.combat_hp);
  const system = {
    details: {
      biography: { value: String(fields.description || fields.bio || "") }
    },
    attributes: {}
  };
  if (Number.isFinite(ac)) {
    system.attributes.ac = { flat: ac, calc: "flat" };
  }
  if (Number.isFinite(hp)) {
    system.attributes.hp = { value: hp, max: hp };
  }
  return system;
}

async function placeDescriptionDrawing(scene, description) {
  const drawings = scene.drawings?.contents ?? scene.drawings ?? [];
  const candidates = drawings.filter((drawing) =>
    /^Description\s*[1-4]$/i.test(String(drawing.text ?? drawing.name ?? "").trim())
  );
  const pick =
    candidates.length > 0
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : null;

  if (pick) {
    await scene.updateEmbeddedDocuments("Drawing", [
      {
        _id: pick.id,
        text: description,
        hidden: true
      }
    ]);
    return;
  }

  await scene.createEmbeddedDocuments("Drawing", [
    {
      x: 100,
      y: 100,
      shape: { type: "r", width: 800, height: 400 },
      text: description,
      hidden: true,
      fontSize: 48,
      strokeWidth: 0
    }
  ]);
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
