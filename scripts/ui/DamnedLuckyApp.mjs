import {
  DEFAULT_IMPORTS_PATH,
  DEFAULT_INBOX_PATH,
  MODULE_ID,
  notify,
  setting,
  setSetting,
  SETTING_IMPORTS,
  SETTING_INBOX
} from "../constants.mjs";
import { importSessionPackage } from "../import/importSession.mjs";
import {
  activateImportedSession,
  deleteImportedSessions,
  describeDeleteResults,
  listImportedSessions
} from "../import/sessions.mjs";
import { ensureDataFolder, pickDataFolder } from "../package/dataFolders.mjs";
import { ensureInboxRoot, mirrorChosenZipToInbox } from "../package/inbox.mjs";
import {
  groupPackagesBySession,
  listInboxCandidates,
  loadPackageFromZipBytes,
  loadPackageFromZipPath,
  markInboxSessionsNewerThanImported
} from "../package/readPackage.mjs";
import { decorateInboxSessionsForDisplay, formatExportStamp } from "./formatExportStamp.mjs";
import { openPlayersApp } from "./PlayersApp.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Damned Lucky toolbar modal — Sessions | Import | Pack (+ Players).
 */
export class DamnedLuckyApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dlfi-damned-lucky",
    classes: ["dlfi-modal"],
    position: { width: 960, height: "auto" },
    window: {
      title: "Damned Lucky",
      resizable: true
    },
    actions: {
      setTab: DamnedLuckyApp.#onSetTab,
      refreshInbox: DamnedLuckyApp.#onRefreshInbox,
      loadVersion: DamnedLuckyApp.#onLoadVersion,
      chooseZip: DamnedLuckyApp.#onChooseZip,
      pickInbox: DamnedLuckyApp.#onPickInbox,
      pickImports: DamnedLuckyApp.#onPickImports,
      refreshSessions: DamnedLuckyApp.#onRefreshSessions,
      activateSession: DamnedLuckyApp.#onActivateSession,
      deleteSelectedSessions: DamnedLuckyApp.#onDeleteSelectedSessions,
      toggleAllSessions: DamnedLuckyApp.#onToggleAllSessions,
      packLive: DamnedLuckyApp.#onPackLive,
      openPlayers: DamnedLuckyApp.#onOpenPlayers
    }
  };

  static PARTS = {
    body: {
      template: `modules/${MODULE_ID}/templates/damned-lucky.hbs`
    }
  };

  /** @type {"sessions"|"import"|"pack"} */
  #tab = "sessions";
  /** @type {ReturnType<typeof groupPackagesBySession>} */
  #sessions = [];
  /** @type {ReturnType<typeof listImportedSessions>} */
  #imported = [];
  /** @type {string[]} blob URLs created for inbox thumbs */
  #thumbObjectUrls = [];
  #busy = false;
  #status = "";
  #didInitialSessionsRefresh = false;

  async _prepareContext() {
    if (this.#tab === "import" && this.#sessions.length) {
      markInboxSessionsNewerThanImported(this.#sessions, this.#imported);
      decorateInboxSessionsForDisplay(this.#sessions);
    }
    return {
      tab: this.#tab,
      sessions: this.#sessions,
      importedSessions: this.#imported,
      hasImported: this.#imported.length > 0,
      busy: this.#busy,
      status: this.#status,
      inboxPath: setting(SETTING_INBOX) || DEFAULT_INBOX_PATH,
      importsPath: setting(SETTING_IMPORTS) || DEFAULT_IMPORTS_PATH,
      isSessions: this.#tab === "sessions",
      isImport: this.#tab === "import",
      isPack: this.#tab === "pack"
    };
  }

  #revokeThumbUrls() {
    for (const url of this.#thumbObjectUrls) {
      try {
        URL.revokeObjectURL(url);
      } catch (_error) {
        /* ignore */
      }
    }
    this.#thumbObjectUrls = [];
  }

  /**
   * Attach blob: thumb URLs for inbox session rows from in-memory zip bytes.
   * @param {ReturnType<typeof groupPackagesBySession>} sessions
   */
  #attachInboxThumbs(sessions) {
    this.#revokeThumbUrls();
    for (const session of sessions) {
      const version = session.versions?.[0];
      const packagePath = session.thumbPackagePath;
      const bytes = packagePath ? version?.package?.files?.get?.(packagePath) : null;
      if (!bytes) {
        session.thumbUrl = null;
        continue;
      }
      const ext = packagePath.split(".").pop()?.toLowerCase() || "webp";
      const mime =
        ext === "png"
          ? "image/png"
          : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "gif"
              ? "image/gif"
              : ext === "avif"
                ? "image/avif"
                : "image/webp";
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      this.#thumbObjectUrls.push(url);
      session.thumbUrl = url;
    }
  }

  refreshImported() {
    try {
      this.#imported = listImportedSessions();
    } catch (error) {
      console.error(error);
      this.#imported = [];
    }
    this.render();
  }

  async refreshInbox() {
    this.#busy = true;
    this.#status = "Scanning inbox…";
    this.render();
    try {
      await ensureInboxRoot();
      await ensureDataFolder(setting(SETTING_IMPORTS) || DEFAULT_IMPORTS_PATH);
      const inbox = setting(SETTING_INBOX) || DEFAULT_INBOX_PATH;
      const candidates = await listInboxCandidates(inbox);
      const loaded = [];
      for (const candidate of candidates) {
        try {
          if (candidate.kind !== "zip") {
            continue;
          }
          const pkg = await loadPackageFromZipPath(candidate.path);
          loaded.push({ ...candidate, package: pkg });
        } catch (error) {
          console.warn(`${MODULE_ID} | skip ${candidate.path}`, error);
        }
      }
      this.#sessions = groupPackagesBySession(loaded);
      // Cap displayed versions per session to the retention count (newest first).
      for (const session of this.#sessions) {
        session.versions = session.versions.slice(0, 3);
      }
      try {
        this.#imported = listImportedSessions();
      } catch (_error) {
        this.#imported = [];
      }
      markInboxSessionsNewerThanImported(this.#sessions, this.#imported);
      this.#attachInboxThumbs(this.#sessions);
      this.#status = `Found ${this.#sessions.length} session(s), ${loaded.length} zip(s) in Data/${inbox}.`;
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
    if (tab === "sessions") {
      this.refreshImported();
      return;
    }
    if (tab === "import") {
      try {
        this.#imported = listImportedSessions();
      } catch (_error) {
        this.#imported = [];
      }
      markInboxSessionsNewerThanImported(this.#sessions, this.#imported);
      if (!this.#sessions.length && !this.#busy) {
        await this.refreshInbox();
        return;
      }
    }
    this.render();
  }

  static async #onOpenPlayers() {
    openPlayersApp();
  }

  static async #onRefreshSessions() {
    this.refreshImported();
  }

  static async #onActivateSession(event, target) {
    const code = target.dataset.sessionCode;
    const row = this.#imported.find((entry) => entry.sessionCode === code);
    if (!row) {
      notify("Could not find that imported session.", { type: "error" });
      return;
    }
    this.#busy = true;
    this.#status = `Activating ${row.displayCode}…`;
    this.render();
    try {
      await activateImportedSession(code);
      this.#status = `Activated ${row.displayCode}: navigation, Landing scene, soft-seat, and live session updated.`;
      notify(this.#status);
    } catch (error) {
      console.error(error);
      this.#status = error instanceof Error ? error.message : String(error);
      notify(this.#status, { type: "error" });
    } finally {
      this.#busy = false;
      this.refreshImported();
    }
  }

  #selectedSessionCodes() {
    return [...(this.element?.querySelectorAll?.("input.dlfi-session-check:checked") ?? [])]
      .map((input) => input.value)
      .filter(Boolean);
  }

  static async #onToggleAllSessions(event, target) {
    const checked = Boolean(target.checked);
    for (const input of this.element?.querySelectorAll?.("input.dlfi-session-check") ?? []) {
      input.checked = checked;
    }
  }

  static async #onDeleteSelectedSessions() {
    const codes = this.#selectedSessionCodes();
    if (!codes.length) {
      notify("Select one or more imported sessions first.", { type: "warning" });
      return;
    }
    const deleteAssets = Boolean(this.element?.querySelector?.("input.dlfi-delete-assets")?.checked);
    const labels = codes
      .map((code) => this.#imported.find((entry) => entry.sessionCode === code)?.displayCode ?? code)
      .join(", ");
    const confirmed = await confirmDialog(
      "Delete imported sessions",
      `<p>Delete <strong>${foundry.utils.escapeHTML?.(labels) ?? labels}</strong>?</p>` +
        `<p>This removes the session's world folders, scenes, actors, items and journals` +
        `${deleteAssets ? ", plus its Data/dlfi-imports asset folders when Foundry allows it" : ""}. ` +
        `PC actors are kept.</p>`
    );
    if (!confirmed) {
      return;
    }
    this.#busy = true;
    this.#status = `Deleting ${codes.length} session(s)…`;
    this.render();
    try {
      const results = await deleteImportedSessions(codes, { deleteAssets });
      this.#status = describeDeleteResults(results);
      notify(this.#status);
    } catch (error) {
      console.error(error);
      this.#status = error instanceof Error ? error.message : String(error);
      notify(this.#status, { type: "error" });
    } finally {
      this.#busy = false;
      this.refreshImported();
    }
  }

  static async #onRefreshInbox() {
    await this.refreshInbox();
  }

  static async #onPickInbox() {
    const current = setting(SETTING_INBOX) || DEFAULT_INBOX_PATH;
    const chosen = await pickDataFolder(current);
    if (chosen == null) {
      return;
    }
    const path = chosen || DEFAULT_INBOX_PATH;
    await ensureDataFolder(path);
    await setSetting(SETTING_INBOX, path);
    this.#status = `Inbox path set to Data/${path}`;
    notify(this.#status);
    await this.refreshInbox();
  }

  static async #onPickImports() {
    const current = setting(SETTING_IMPORTS) || DEFAULT_IMPORTS_PATH;
    const chosen = await pickDataFolder(current);
    if (chosen == null) {
      return;
    }
    const path = chosen || DEFAULT_IMPORTS_PATH;
    await ensureDataFolder(path);
    await setSetting(SETTING_IMPORTS, path);
    this.#status = `Imports path set to Data/${path}`;
    notify(this.#status);
    this.render();
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
    this.#status = `Importing ${session.displayCode} (${formatExportStamp(exportedAt)})…`;
    this.render();
    try {
      await importSessionPackage(version.package);
      this.#imported = listImportedSessions();
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
        await mirrorChosenZipToInbox(file, buffer);
        await importSessionPackage(pkg);
        this.#imported = listImportedSessions();
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
    if (this.#tab === "sessions" && !this.#didInitialSessionsRefresh && !this.#busy) {
      this.#didInitialSessionsRefresh = true;
      this.refreshImported();
      return;
    }
    if (this.#tab === "import" && !this.#sessions.length && !this.#busy && !this.#status) {
      void this.refreshInbox();
    }
  }

  async close(options = {}) {
    this.#revokeThumbUrls();
    return super.close(options);
  }
}

async function confirmDialog(title, content) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2?.confirm) {
    return DialogV2.confirm({
      window: { title },
      content,
      rejectClose: false,
      modal: true
    });
  }
  return Dialog.confirm({ title, content });
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
      <p>Inbox: <code>Data/${setting(SETTING_INBOX) || DEFAULT_INBOX_PATH}</code></p>
      <p>Imports: <code>Data/${setting(SETTING_IMPORTS) || DEFAULT_IMPORTS_PATH}</code></p>`,
    buttons: { close: { label: "Close" } }
  }).render(true);
}
