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
  const notes = controls.find((control) => control.name === "notes") ?? controls[0];
  if (!notes?.tools) {
    return;
  }
  // Avoid duplicates on re-render
  if (notes.tools.some?.((tool) => tool.name === "dlfi") || notes.tools.dlfi) {
    return;
  }
  const tool = {
    name: "dlfi",
    title: "Damned Lucky",
    icon: "fas fa-dungeon",
    button: true,
    onClick: () => openDamnedLuckyApp()
  };
  if (Array.isArray(notes.tools)) {
    notes.tools.push(tool);
  } else {
    notes.tools.dlfi = tool;
  }
});
