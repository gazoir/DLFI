import {
  MODULE_ID,
  notify,
  setting,
  SETTING_INBOX
} from "../constants.mjs";
import { importSessionPackage } from "../import/importSession.mjs";
import {
  groupPackagesBySession,
  listInboxCandidates,
  loadPackageFromFolderPath,
  loadPackageFromZipBytes,
  loadPackageFromZipPath
} from "../package/readPackage.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Damned Lucky toolbar modal — Sessions | Import | Pack.
 */
export class DamnedLuckyApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dlfi-damned-lucky",
    classes: ["dlfi-modal"],
    position: { width: 720, height: "auto" },
    window: {
      title: "Damned Lucky",
      resizable: true
    },
    actions: {
      setTab: DamnedLuckyApp.#onSetTab,
      refreshInbox: DamnedLuckyApp.#onRefreshInbox,
      loadVersion: DamnedLuckyApp.#onLoadVersion,
      chooseZip: DamnedLuckyApp.#onChooseZip,
      packLive: DamnedLuckyApp.#onPackLive
    }
  };

  static PARTS = {
    body: {
      template: `modules/${MODULE_ID}/templates/damned-lucky.hbs`
    }
  };

  /** @type {"sessions"|"import"|"pack"} */
  #tab = "import";
  /** @type {ReturnType<typeof groupPackagesBySession>} */
  #sessions = [];
  #busy = false;
  #status = "";

  async _prepareContext() {
    return {
      tab: this.#tab,
      sessions: this.#sessions,
      busy: this.#busy,
      status: this.#status,
      inboxPath: setting(SETTING_INBOX),
      isSessions: this.#tab === "sessions",
      isImport: this.#tab === "import",
      isPack: this.#tab === "pack"
    };
  }

  async refreshInbox() {
    this.#busy = true;
    this.#status = "Scanning inbox…";
    this.render();
    try {
      const inbox = setting(SETTING_INBOX);
      const candidates = await listInboxCandidates(inbox);
      const loaded = [];
      for (const candidate of candidates) {
        try {
          const pkg =
            candidate.kind === "zip"
              ? await loadPackageFromZipPath(candidate.path)
              : await loadPackageFromFolderPath(candidate.path);
          loaded.push({ ...candidate, package: pkg });
        } catch (error) {
          console.warn(`${MODULE_ID} | skip ${candidate.path}`, error);
        }
      }
      this.#sessions = groupPackagesBySession(loaded);
      this.#status = `Found ${this.#sessions.length} session(s), ${loaded.length} package(s).`;
    } catch (error) {
      console.error(error);
      this.#status = error instanceof Error ? error.message : String(error);
      notify(this.#status, { type: "error" });
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  static async #onSetTab(event, target) {
    const tab = target.dataset.tab;
    if (!tab) {
      return;
    }
    this.#tab = tab;
    this.render();
  }

  static async #onRefreshInbox() {
    await this.refreshInbox();
  }

  static async #onLoadVersion(event, target) {
    const code = target.dataset.sessionCode;
    const row = target.closest?.(".dlfi-session-row");
    const select = row?.querySelector?.("select.dlfi-version-select");
    const exportedAt = select?.value || target.dataset.exportedAt;
    const session = this.#sessions.find((entry) => entry.sessionCode === code);
    const version = session?.versions.find(
      (entry) => entry.package.manifest.exportedAt === exportedAt
    );
    if (!version) {
      notify("Could not find that package version.", { type: "error" });
      return;
    }
    this.#busy = true;
    this.#status = `Importing ${session.displayCode} (${exportedAt})…`;
    this.render();
    try {
      await importSessionPackage(version.package);
      this.#status = `Imported ${session.displayCode}.`;
      notify(this.#status);
    } catch (error) {
      console.error(error);
      this.#status = error instanceof Error ? error.message : String(error);
      notify(this.#status, { type: "error" });
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  static async #onChooseZip() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      this.#busy = true;
      this.#status = `Reading ${file.name}…`;
      this.render();
      try {
        const buffer = await file.arrayBuffer();
        const pkg = loadPackageFromZipBytes(buffer, file.name);
        await importSessionPackage(pkg);
        this.#status = `Imported ${pkg.manifest.displayCode} from ${file.name}.`;
        notify(this.#status);
        await this.refreshInbox();
      } catch (error) {
        console.error(error);
        this.#status = error instanceof Error ? error.message : String(error);
        notify(this.#status, { type: "error" });
        this.#busy = false;
        this.render();
      }
    });
    input.click();
  }

  static async #onPackLive() {
    notify("Pack to Archive compendium lands in the next DLFI slice.", { type: "warning" });
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    if (this.#tab === "import" && !this.#sessions.length && !this.#busy && !this.#status) {
      void this.refreshInbox();
    }
  }
}

export function openDamnedLuckyApp() {
  try {
    const existing = foundry.applications?.instances?.get?.("dlfi-damned-lucky");
    if (existing) {
      existing.render({ force: true });
      return existing;
    }
    const app = new DamnedLuckyApp();
    app.render({ force: true });
    return app;
  } catch (error) {
    console.error(`${MODULE_ID} | ApplicationV2 failed, falling back to Dialog`, error);
    openDamnedLuckyDialogFallback();
    return null;
  }
}

function openDamnedLuckyDialogFallback() {
  new Dialog({
    title: "Damned Lucky",
    content: `<p>Import UI needs Foundry ApplicationV2. Check the console, or update Foundry.</p>
      <p>Inbox: <code>Data/${setting(SETTING_INBOX)}</code></p>`,
    buttons: { close: { label: "Close" } }
  }).render(true);
}