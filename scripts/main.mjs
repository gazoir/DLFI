/**
 * Damned Lucky Foundry Import
 * Loads DLCE Session Packages into the world.
 */

import {
  DEFAULT_IMPORTS_PATH,
  DEFAULT_INBOX_PATH,
  MODULE_ID,
  PACKAGE_FORMAT_VERSION,
  SETTING_IMPORTS,
  SETTING_INBOX,
  SETTING_LIVE_SESSION,
  SETTING_SPELL_PACKS,
  SETTING_TEMPLATE_BATTLEMAP,
  SETTING_TEMPLATE_INBOX,
  SETTING_TEMPLATE_LANDING,
  SETTING_TEMPLATE_LOCATION,
  setting
} from "./constants.mjs";
import { ensureDataFolder } from "./package/dataFolders.mjs";
import { ensureInboxRoot } from "./package/inbox.mjs";
import { openDamnedLuckyApp } from "./ui/DamnedLuckyApp.mjs";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_INBOX, {
    name: "DLCE Session Package inbox path",
    hint: "Data/ folder for DLCE zip packages only (nested as Session Code · Session Name). Created automatically if missing. Prefer Browse… in the Damned Lucky Import tab.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_INBOX_PATH
  });

  game.settings.register(MODULE_ID, SETTING_IMPORTS, {
    name: "DLFI imports path",
    hint: "Data/ folder for imported package trees (mirrors the zip layout under assets/). Separate from the DLCE inbox.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_IMPORTS_PATH
  });

  game.settings.register(MODULE_ID, SETTING_TEMPLATE_LOCATION, {
    name: "Location scene template (id or UUID)",
    hint: "Optional. Paste a Scene id or UUID. Leave blank to use the bundled Expo Scene Template.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTING_TEMPLATE_BATTLEMAP, {
    name: "Battlemap scene template (id or UUID)",
    hint: "Optional. Paste a Scene id or UUID. Leave blank to use the bundled Battlemap Template.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTING_TEMPLATE_LANDING, {
    name: "Landing page scene template (id or UUID)",
    hint: "Optional. Paste a Scene id or UUID. Leave blank to use the bundled Landing Page Template.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTING_TEMPLATE_INBOX, {
    name: "Leftovers scene template (id or UUID)",
    hint: "Optional. Paste a Scene id or UUID. Leave blank to use the bundled Leftovers template.",
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

  game.settings.registerMenu(MODULE_ID, "openDamnedLucky", {
    name: "Damned Lucky",
    label: "Open Damned Lucky",
    hint: "Open the Sessions / Import / Pack UI.",
    icon: "fas fa-dungeon",
    type: DamnedLuckySettingsMenu,
    restricted: true
  });
});

Hooks.once("ready", () => {
  console.log(
    `${MODULE_ID} | ready (packageFormatVersion ${PACKAGE_FORMAT_VERSION}). Open Damned Lucky from scene controls or Configure Settings.`
  );
  // Create storage roots so Refresh / Import do not fail on a missing folder.
  void (async () => {
    try {
      await ensureInboxRoot(setting(SETTING_INBOX) || DEFAULT_INBOX_PATH);
      await ensureDataFolder(setting(SETTING_IMPORTS) || DEFAULT_IMPORTS_PATH);
      console.log(
        `${MODULE_ID} | storage ready — inbox Data/${setting(SETTING_INBOX) || DEFAULT_INBOX_PATH}, imports Data/${setting(SETTING_IMPORTS) || DEFAULT_IMPORTS_PATH}`
      );
    } catch (error) {
      console.warn(`${MODULE_ID} | could not pre-create storage folders`, error);
    }
  })();
});

Hooks.on("getSceneControlButtons", (controls) => {
  // Foundry v13+: controls is a Record keyed by control name.
  if (!controls || Array.isArray(controls)) {
    registerLegacySceneControl(controls);
    return;
  }

  if (controls.dlfi) {
    return;
  }

  const isGm = Boolean(game.user?.isGM);
  controls.dlfi = {
    name: "dlfi",
    title: "Damned Lucky",
    icon: "fa-solid fa-dungeon",
    order: Object.keys(controls).length,
    activeTool: "open",
    visible: isGm,
    onChange: (_event, active) => {
      if (active) {
        openDamnedLuckyApp();
      }
    },
    tools: {
      open: {
        name: "open",
        title: "Open Damned Lucky",
        icon: "fa-solid fa-dungeon",
        order: 0,
        button: true,
        visible: isGm,
        onChange: (_event, active) => {
          if (active === false) {
            return;
          }
          openDamnedLuckyApp();
        }
      }
    }
  };
});

function registerLegacySceneControl(controls) {
  if (!Array.isArray(controls)) {
    return;
  }
  const notes = controls.find((control) => control.name === "notes") ?? controls[0];
  if (!notes?.tools || notes.tools.some?.((tool) => tool.name === "dlfi")) {
    return;
  }
  notes.tools.push({
    name: "dlfi",
    title: "Damned Lucky",
    icon: "fas fa-dungeon",
    button: true,
    onClick: () => openDamnedLuckyApp()
  });
}




/**
 * Settings menu shim: Configure Settings -> Damned Lucky -> Open.
 * Keep this tiny; the real UI is DamnedLuckyApp.
 */
class DamnedLuckySettingsMenu extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "dlfi-settings-menu",
    window: { title: "Damned Lucky", frame: false },
    position: { width: 1, height: 1 }
  };

  async _renderHTML() {
    return document.createElement("div");
  }

  _replaceHTML() {}

  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    queueMicrotask(() => {
      this.close({ animate: false });
      openDamnedLuckyApp();
    });
  }
}
