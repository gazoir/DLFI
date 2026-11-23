/**
 * Soft-seat Foundry Users from seated PC Actor flags / package PC entries.
 *
 * On session Activate (and after Import that activates):
 * - Upsert Users matched by flags.dlfi.playerId, else by name
 * - New Users get a one-time temp password (shown once to the GM)
 * - Existing Users: only role / character / ownership — never wipe flags,
 *   password, hotbar, or dice-so-nice settings
 * - Soft-hide: previously managed Users not in this seat list → role NONE
 */

import { FLAG_SCOPE, MODULE_ID, notify } from "../constants.mjs";

/** Foundry CONST.USER_ROLES — numeric so Node selftests work offline. */
export const USER_ROLE = Object.freeze({
  NONE: 0,
  PLAYER: 1,
  TRUSTED: 2,
  ASSISTANT: 3,
  GAMEMASTER: 4
});

/** Foundry CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER */
export const OWNERSHIP_OWNER = 3;

/**
 * @param {number} [length]
 * @returns {string}
 */
export function generateTempPassword(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes =
    typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
      ? crypto.getRandomValues(new Uint8Array(length))
      : Uint8Array.from({ length }, () => Math.floor(Math.random() * 256));
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/**
 * Normalize a seated-PC descriptor from package data and/or Actor flags.
 * @param {{ actor?: object|null, pc?: object|null, playerId?: string|null, playerName?: string|null }} entry
 * @returns {{ actor: object|null, playerId: string|null, playerName: string|null }|null}
 */
export function normalizeSeatEntry(entry) {
  const actor = entry?.actor ?? null;
  const flags = actor?.flags?.[FLAG_SCOPE] ?? {};
  const playerId =
    firstNonEmpty(entry?.playerId, entry?.pc?.playerId, flags.playerId) ?? null;
  const playerName =
    firstNonEmpty(entry?.playerName, entry?.pc?.playerName, flags.playerName) ?? null;
  if (!playerId && !playerName) {
    return null;
  }
  return { actor, playerId, playerName };
}

/**
 * Collect seated PC descriptors from live world character Actors (session docs.pcs).
 * @param {Array<object>} pcs
 * @returns {Array<{ actor: object, playerId: string|null, playerName: string|null }>}
 */
export function seatsFromPcActors(pcs = []) {
  const seats = [];
  for (const actor of pcs) {
    const seat = normalizeSeatEntry({ actor });
    if (seat) {
      seats.push(seat);
    }
  }
  return seats;
}

/**
 * Collect seats from import-time `{ actor, pc }` pairs (package still available).
 * @param {Array<{ actor: object, pc?: object }>} sessionPcs
 */
export function seatsFromSessionPcs(sessionPcs = []) {
  const seats = [];
  for (const row of sessionPcs) {
    const seat = normalizeSeatEntry({ actor: row.actor, pc: row.pc });
    if (seat) {
      seats.push(seat);
    }
  }
  return seats;
}

/**
 * Find an existing User by DLFI playerId flag first, else exact name.
 * @param {Iterable<object>} users
 * @param {{ playerId?: string|null, playerName?: string|null }} seat
 */
export function findUserForSeat(users, seat) {
  const list = [...(users ?? [])];
  const playerId = seat?.playerId ? String(seat.playerId) : "";
  if (playerId) {
    const byId = list.find((user) => String(user.flags?.[FLAG_SCOPE]?.playerId ?? "") === playerId);
    if (byId) {
      return byId;
    }
  }
  const name = seat?.playerName ? String(seat.playerName).trim() : "";
  if (name) {
    return list.find((user) => String(user.name ?? "").trim() === name) ?? null;
  }
  return null;
}

/**
 * Soft-seat Users for the given PC seats.
 *
 * @param {Array<{ actor?: object|null, pc?: object|null, playerId?: string|null, playerName?: string|null }>} seatEntries
 * @param {{ world?: object, UserDocument?: typeof User, showPasswords?: boolean }} [options]
 * @returns {Promise<{
 *   created: Array<{ userId: string, name: string, password: string }>,
 *   updated: Array<{ userId: string, name: string }>,
 *   softHidden: Array<{ userId: string, name: string }>,
 *   seatedUserIds: string[]
 * }>}
 */
export async function softSeatPlayers(seatEntries = [], options = {}) {
  const world = options.world ?? globalThis.game;
  const UserDocument = options.UserDocument ?? globalThis.User;
  const showPasswords = options.showPasswords !== false;
  const seats = seatEntries.map(normalizeSeatEntry).filter(Boolean);

  const result = {
    created: [],
    updated: [],
    softHidden: [],
    seatedUserIds: []
  };

  if (!world?.users) {
    return result;
  }

  const seatedUserIds = new Set();

  for (const seat of seats) {
    const name = String(seat.playerName || "").trim() || `Player ${seat.playerId}`;
    let user = findUserForSeat(world.users, seat);
    if (!user) {
      if (!UserDocument?.create) {
        console.warn(`${MODULE_ID} | User.create unavailable — skip soft-seat for ${name}`);
        continue;
      }
      const password = generateTempPassword();
      const flags = { [FLAG_SCOPE]: { managed: true } };
      if (seat.playerId) {
        flags[FLAG_SCOPE].playerId = String(seat.playerId);
      }
      user = await UserDocument.create({
        name,
        role: USER_ROLE.PLAYER,
        password,
        flags
      });
      result.created.push({
        userId: user.id,
        name: user.name,
        password
      });
    } else {
      const patch = {};
      if (user.role === USER_ROLE.NONE || user.role === USER_ROLE.PLAYER) {
        if (user.role !== USER_ROLE.PLAYER) {
          patch.role = USER_ROLE.PLAYER;
        }
      }
      // Only attach playerId when missing; never wipe other flags.
      // Only attach playerId when missing; never wipe other flags / managed state
      // on pre-existing manual accounts.
      if (seat.playerId && !user.flags?.[FLAG_SCOPE]?.playerId) {
        patch[`flags.${FLAG_SCOPE}.playerId`] = String(seat.playerId);
      }
      if (Object.keys(patch).length) {
        await user.update(patch);
      }
      result.updated.push({ userId: user.id, name: user.name });
    }

    if (!user?.id) {
      continue;
    }
    seatedUserIds.add(user.id);

    if (seat.actor?.id) {
      await grantActorOwnership(seat.actor, user.id);
      if (user.character !== seat.actor.id) {
        await user.update({ character: seat.actor.id });
      }
    }
  }

  // Soft-hide managed Users not in this session's seat list (do not delete).
  for (const user of [...(world.users ?? [])]) {
    if (!user?.flags?.[FLAG_SCOPE]?.managed) {
      continue;
    }
    if (user.isGM || user.role >= USER_ROLE.ASSISTANT) {
      continue;
    }
    if (seatedUserIds.has(user.id)) {
      continue;
    }
    if (user.role !== USER_ROLE.NONE) {
      await user.update({ role: USER_ROLE.NONE });
      result.softHidden.push({ userId: user.id, name: user.name });
    }
  }

  result.seatedUserIds = [...seatedUserIds];

  if (showPasswords && result.created.length) {
    await alertTempPasswords(result.created);
  }

  if (result.created.length || result.softHidden.length || result.updated.length) {
    const parts = [];
    if (result.created.length) {
      parts.push(`created ${result.created.length} player account(s)`);
    }
    if (result.updated.length) {
      parts.push(`updated ${result.updated.length}`);
    }
    if (result.softHidden.length) {
      parts.push(`hid ${result.softHidden.length} unused managed account(s)`);
    }
    const summary = `Soft-seat: ${parts.join(", ")}.`;
    if (globalThis.ui?.notifications) {
      notify(summary);
    } else {
      console.log(`${MODULE_ID} | ${summary}`);
    }
  }

  return result;
}

/**
 * Soft-seat from an already-imported session's PC actors.
 * @param {object} sessionDocs collectSessionDocuments result
 * @param {{ world?: object, showPasswords?: boolean }} [options]
 */
export async function softSeatPlayersFromSessionDocs(sessionDocs, options = {}) {
  return softSeatPlayers(seatsFromPcActors(sessionDocs?.pcs ?? []), options);
}

/**
 * Soft-seat from import-time session PC pairs.
 * @param {Array<{ actor: object, pc?: object }>} sessionPcs
 * @param {{ world?: object, showPasswords?: boolean }} [options]
 */
export async function softSeatPlayersFromImport(sessionPcs, options = {}) {
  return softSeatPlayers(seatsFromSessionPcs(sessionPcs), options);
}

/**
 * @param {object} actor
 * @param {string} userId
 */
export async function grantActorOwnership(actor, userId) {
  if (!actor?.id || !userId) {
    return;
  }
  const ownership = {
    ...(actor.ownership && typeof actor.ownership === "object" ? actor.ownership : {}),
    [userId]: OWNERSHIP_OWNER
  };
  if (actor.ownership?.[userId] === OWNERSHIP_OWNER) {
    return;
  }
  await actor.update({ ownership });
}

/**
 * List Users for the manual Players UI (PLAYER + NONE, plus any DLFI-managed).
 * @param {object} [world]
 */
export function listManageableUsers(world = globalThis.game) {
  const users = [...(world?.users ?? [])];
  return users
    .filter((user) => {
      if (user?.isGM || user?.role >= USER_ROLE.ASSISTANT) {
        return false;
      }
      if (user?.flags?.[FLAG_SCOPE]?.managed) {
        return true;
      }
      return user?.role === USER_ROLE.PLAYER || user?.role === USER_ROLE.NONE;
    })
    .map((user) => ({
      id: user.id,
      name: user.name,
      role: user.role,
      playable: user.role === USER_ROLE.PLAYER || user.role === USER_ROLE.TRUSTED,
      characterId: user.character?.id ?? user.character ?? null,
      managed: Boolean(user.flags?.[FLAG_SCOPE]?.managed),
      playerId: user.flags?.[FLAG_SCOPE]?.playerId ?? null
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * Apply a manual Players-UI change (show/hide and/or assigned PC).
 * @param {string} userId
 * @param {{ playable?: boolean, characterId?: string|null }} patch
 * @param {{ world?: object }} [options]
 */
export async function updateManagedUser(userId, patch = {}, options = {}) {
  const world = options.world ?? globalThis.game;
  const user = world?.users?.get?.(userId) ?? [...(world?.users ?? [])].find((u) => u.id === userId);
  if (!user) {
    throw new Error(`User ${userId} not found.`);
  }
  const update = {};
  if (typeof patch.playable === "boolean") {
    update.role = patch.playable ? USER_ROLE.PLAYER : USER_ROLE.NONE;
  }
  if ("characterId" in patch) {
    update.character = patch.characterId || null;
  }
  if (Object.keys(update).length) {
    await user.update(update);
  }
  if (patch.characterId) {
    const actor =
      world?.actors?.get?.(patch.characterId) ??
      [...(world?.actors ?? [])].find((a) => a.id === patch.characterId);
    if (actor) {
      await grantActorOwnership(actor, user.id);
    }
  }
  return user;
}

/**
 * @param {Array<{ name: string, password: string }>} created
 */
export async function alertTempPasswords(created = []) {
  if (!created.length) {
    return;
  }
  const rows = created
    .map(
      (row) =>
        `<tr><td><strong>${escapeHtml(row.name)}</strong></td><td><code>${escapeHtml(row.password)}</code></td></tr>`
    )
    .join("");
  const content =
    `<p>These player accounts were created with a one-time temporary password. ` +
    `Copy them now — they will not be shown again.</p>` +
    `<table class="dlfi-password-table"><thead><tr><th>Player</th><th>Temp password</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`;

  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (DialogV2?.prompt) {
    await DialogV2.prompt({
      window: { title: "New player passwords" },
      content,
      ok: { label: "Got it" }
    });
    return;
  }
  if (typeof globalThis.Dialog?.prompt === "function") {
    await globalThis.Dialog.prompt({
      title: "New player passwords",
      content,
      label: "Got it",
      callback: () => undefined
    });
    return;
  }
  console.warn(
    `${MODULE_ID} | new player passwords:`,
    created.map((row) => `${row.name}=${row.password}`).join(", ")
  );
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
