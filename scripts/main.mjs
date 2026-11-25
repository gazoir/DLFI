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
  SETTING_PLAYERS_UNLOCKED,
  SETTING_REPLACE_ON_REIMPORT,
  SETTING_SPELL_PACKS,
  SETTING_SUPPRESS_LOADING_BARS,
  SETTING_TEMPLATE_BATTLEMAP,
  SETTING_TEMPLATE_INBOX,
  SETTING_TEMPLATE_LANDING,
  SETTING_TEMPLATE_LOCATION,
  SETTING_TEMPLATE_OUTRO,
  setting
} from "./constants.mjs";
import { registerHideLandingEffectsHooks } from "./canvas/hideLandingEffects.mjs";
import { registerMattNavTooltipHooks } from "./canvas/mattNavTooltip.mjs";
import { registerMattNavViewHooks, registerNavHighlightSettings } from "./canvas/mattNavView.mjs";
import { registerSuppressSceneLoadingBar } from "./canvas/suppressSceneLoadingBar.mjs";
import { ensureDataFolder } from "./package/dataFolders.mjs";
import { ensureInboxRoot } from "./package/inbox.mjs";
import { liveSessionPcActors } from "./import/sessions.mjs";
import {
  isPlayersUnlocked,
  lockPlayersLogin,
  seatsFromPcActors,
  unlockPlayersLogin
} from "./import/softSeatPlayers.mjs";
import { openDamnedLuckyApp } from "./ui/DamnedLuckyApp.mjs";

/** canvasReady handlers registered in init; replayed in ready for the first scene. */
const canvasReadyHandlers = [];

async function unlockLiveSessionPlayers() {
  const seats = seatsFromPcActors(liveSessionPcActors());
  await unlockPlayersLogin({ seats });
}

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

  game.settings.register(MODULE_ID, SETTING_TEMPLATE_OUTRO, {
    name: "Outro page scene template (id or UUID)",
    hint: "Optional. Paste a Scene id or UUID for the end-of-session Outro (Thanks for Playing). Leave blank to create a blank Outro scene.",
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

  game.settings.register(MODULE_ID, SETTING_REPLACE_ON_REIMPORT, {
    name: "Replace previous import of the same session",
    hint: "When loading a session code that is already imported, delete its old folders, scenes, actors, items, journals and asset trees first so re-syncs do not pile up. PC actors are kept.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTING_PLAYERS_UNLOCKED, {
    name: "Player login gate unlocked",
    hint: "When locked (toolbar 🔒), Player-role accounts are set to None with a _ name prefix. Trusted Player / GM are untouched.",
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTING_SUPPRESS_LOADING_BARS, {
    name: "Suppress loading bars for players",
    hint: "Hide Foundry's \"Loading <scene>\" progress bar on player clients when a scene loads. GMs still see it.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  registerNavHighlightSettings();

  // Register canvas hooks before the first canvasReady fires.
  registerSuppressSceneLoadingBar();
  registerMattNavViewHooks();
  canvasReadyHandlers.push(registerHideLandingEffectsHooks().onCanvasReady);
  canvasReadyHandlers.push(registerMattNavTooltipHooks().onCanvasReady);

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
  if (globalThis.canvas?.ready) {
    for (const handler of canvasReadyHandlers) {
      try {
        handler(globalThis.canvas);
      } catch (error) {
        console.warn(`${MODULE_ID} | canvasReady replay failed`, error);
      }
    }
  }
  if (!game.user?.isGM) {
    return;
  }
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

  const isGm = Boolean(game.user?.isGM);
  const unlocked = isPlayersUnlocked();
  const lockTitle = unlocked
    ? "Players unlocked — click to lock (hide Player accounts)"
    : "Players locked — click to unlock session players";
  const lockIcon = unlocked ? "fa-solid fa-lock-open" : "fa-solid fa-lock";

  if (controls.dlfi) {
    // Refresh lock tool title/icon when controls rebuild.
    if (controls.dlfi.tools?.playersLock) {
      controls.dlfi.tools.playersLock.title = lockTitle;
      controls.dlfi.tools.playersLock.icon = lockIcon;
      controls.dlfi.tools.playersLock.active = unlocked;
    }
    return;
  }

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
      },
      playersLock: {
        name: "playersLock",
        title: lockTitle,
        icon: lockIcon,
        order: 1,
        button: true,
        toggle: true,
        active: unlocked,
        visible: isGm,
        onChange: async (_event, active) => {
          // Foundry may pass the new toggle state; drive from desired outcome.
          if (active) {
            await unlockLiveSessionPlayers();
          } else {
            await lockPlayersLogin();
          }
          // Force scene controls to rebuild so the icon/title refresh.
          ui.controls?.initialize?.();
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
  if (!notes?.tools) {
    return;
  }
  if (!notes.tools.some?.((tool) => tool.name === "dlfi")) {
    notes.tools.push({
      name: "dlfi",
      title: "Damned Lucky",
      icon: "fas fa-dungeon",
      button: true,
      onClick: () => openDamnedLuckyApp()
    });
  }
  if (!notes.tools.some?.((tool) => tool.name === "dlfi-players-lock")) {
    notes.tools.push({
      name: "dlfi-players-lock",
      title: "Toggle player login lock",
      icon: isPlayersUnlocked() ? "fas fa-lock-open" : "fas fa-lock",
      button: true,
      onClick: async () => {
        if (isPlayersUnlocked()) {
          await lockPlayersLogin();
        } else {
          await unlockLiveSessionPlayers();
        }
        ui.controls?.initialize?.();
      }
    });
  }
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
