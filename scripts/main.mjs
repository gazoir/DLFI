/**
 * Damned Lucky Foundry Import
 * Loads DLCE Session Packages into the world.
 */

import {
  MODULE_ID,
  PACKAGE_FORMAT_VERSION,
  SETTING_INBOX,
  SETTING_LIVE_SESSION,
  SETTING_SPELL_PACKS,
  SETTING_TEMPLATE_BATTLEMAP,
  SETTING_TEMPLATE_INBOX,
  SETTING_TEMPLATE_LANDING,
  SETTING_TEMPLATE_LOCATION
} from "./constants.mjs";
import { openDamnedLuckyApp } from "./ui/DamnedLuckyApp.mjs";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_INBOX, {
    name: "Session Package inbox path",
    hint: "Folder under Foundry Data where DLCE zips/folders land (relative to Data/).",
    scope: "world",
    config: true,
    type: String,
    default: "dlce-inbox"
  });

  game.settings.register(MODULE_ID, SETTING_TEMPLATE_LOCATION, {
    name: "Location scene template (id)",
    hint: "Paste a Scene id used as the template for location scenes.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTING_TEMPLATE_BATTLEMAP, {
    name: "Battlemap scene template (id)",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTING_TEMPLATE_LANDING, {
    name: "Landing page scene template (id)",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTING_TEMPLATE_INBOX, {
    name: "Inbox scene template (id)",
    hint: "Template for the per-import Inbox scene (unplaced actors/items).",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTING_SPELL_PACKS, {
    name: "Spell / magic item compendium packs",
    hint: "Comma-separated pack ids to search before creating stub items (e.g. MrPrimate packs).",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTING_LIVE_SESSION, {
    name: "Live session key",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });
});

Hooks.once("ready", () => {
  console.log(
    `${MODULE_ID} | ready (packageFormatVersion ${PACKAGE_FORMAT_VERSION}). Open Damned Lucky from scene controls.`
  );
});

Hooks.on("getSceneControlButtons", (controls) => {
  const controlList = Array.isArray(controls) ? controls : Object.values(controls ?? {});
  const notes = Array.isArray(controls)
    ? controlList.find((control) => control.name === "notes")
    : controls.notes;
  const targetControl = notes ?? controlList.find((control) => control.name === "tokens") ?? controlList[0];
  if (!targetControl?.tools) {
    return;
  }

  const tools = targetControl.tools;
  if (Array.isArray(tools)) {
    if (tools.some((tool) => tool.name === "dlfi")) {
      return;
    }
    tools.push(buildSceneControlTool(tools.length));
    return;
  }

  if (tools.dlfi) {
    return;
  }
  tools.dlfi = buildSceneControlTool(Object.keys(tools).length);
});

function buildSceneControlTool(order) {
  return {
    name: "dlfi",
    title: "Damned Lucky",
    icon: "fa-solid fa-dungeon",
    order,
    button: true,
    visible: game.user?.isGM ?? false,
    onChange: () => openDamnedLuckyApp(),
    onClick: () => openDamnedLuckyApp()
  };
}
