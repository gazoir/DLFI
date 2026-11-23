/**
 * Manual Players soft-seat UI — list Users, toggle Playable/Hidden, assign PC.
 * No delete.
 */

import { FLAG_SCOPE, MODULE_ID, notify } from "../constants.mjs";
import { listManageableUsers, updateManagedUser } from "../import/softSeatPlayers.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PlayersApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dlfi-players",
    classes: ["dlfi-modal", "dlfi-players-modal"],
    position: { width: 720, height: "auto" },
    window: {
      title: "Damned Lucky — Players",
      resizable: true
    },
    actions: {
      refreshPlayers: PlayersApp.#onRefresh,
      togglePlayable: PlayersApp.#onTogglePlayable
    }
  };

  static PARTS = {
    body: {
      template: `modules/${MODULE_ID}/templates/players.hbs`
    }
  };

  #busy = false;
  #status = "";

  async _prepareContext() {
    const characters = [...(game.actors ?? [])]
      .filter((actor) => actor.type === "character")
      .map((actor) => ({
        id: actor.id,
        name: actor.name,
        playerName: actor.flags?.[FLAG_SCOPE]?.playerName ?? null
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const users = listManageableUsers().map((user) => ({
      ...user,
      roleLabel: user.playable ? "Playable" : "Hidden",
      characters: characters.map((pc) => ({
        ...pc,
        selected: pc.id === user.characterId
      }))
    }));

    return {
      users,
      hasUsers: users.length > 0,
      busy: this.#busy,
      status: this.#status
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    for (const select of this.element?.querySelectorAll?.("select.dlfi-player-pc-select") ?? []) {
      select.addEventListener("change", (event) => this.#onAssignPcChange(event));
    }
  }

  static async #onRefresh() {
    this.#status = "";
    this.render();
  }

  static async #onTogglePlayable(_event, target) {
    const userId = target.dataset.userId;
    const playable = target.dataset.playable !== "true";
    if (!userId) {
      return;
    }
    this.#busy = true;
    this.render();
    try {
      await updateManagedUser(userId, { playable });
      this.#status = playable ? "User set to Playable." : "User set to Hidden (role NONE).";
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

  async #onAssignPcChange(event) {
    const select = event.currentTarget;
    const userId = select?.dataset?.userId;
    const characterId = select?.value || null;
    if (!userId) {
      return;
    }
    this.#busy = true;
    try {
      await updateManagedUser(userId, { characterId });
      this.#status = characterId ? "Assigned PC." : "Cleared assigned PC.";
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
}

export function openPlayersApp() {
  try {
    const existing = foundry.applications?.instances?.get?.("dlfi-players");
    if (existing) {
      existing.render({ force: true });
      return existing;
    }
    const app = new PlayersApp();
    app.render({ force: true });
    return app;
  } catch (error) {
    console.error(`${MODULE_ID} | PlayersApp failed`, error);
    notify("Could not open Players UI.", { type: "error" });
    return null;
  }
}
