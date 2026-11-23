/**
 * Soft-seat Foundry Users from seated PC Actor flags / package PC entries.
 *
 * On session Activate / Import:
 * - Upsert Users matched by flags.dlfi.playerId, else by name (with optional `_` prefix)
 * - New Users get a blank password (GM sets passwords in User Config)
 * - Existing Users: only character / ownership / flags.playerId — never wipe
 *   password, hotbar, or dice-so-nice settings
 * - Login visibility is gated by the toolbar 🔒/🔓 lock (not auto-hidden on activate)
 */

import { FLAG_SCOPE, MODULE_ID, notify, SETTING_PLAYERS_UNLOCKED, setSetting, setting } from "../constants.mjs";

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

/** Prefix applied to Player-role names when the login gate is locked. */
export const LOCKED_NAME_PREFIX = "_";

/**
 * @param {string|null|undefined} name
 * @returns {string}
 */
export function stripLockedNamePrefix(name) {
  const text = String(name ?? "").trim();
  if (text.startsWith(LOCKED_NAME_PREFIX) && text.length > 1) {
    return text.slice(1);
  }
  return text;
}

/**
 * @param {string|null|undefined} name
 * @returns {string}
 */
export function withLockedNamePrefix(name) {
  const text = String(name ?? "").trim();
  if (!text || text.startsWith(LOCKED_NAME_PREFIX)) {
    return text;
  }
  return `${LOCKED_NAME_PREFIX}${text}`;
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
 * Find an existing User by DLFI playerId flag first, else exact name (with/without `_`).
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
  if (!name) {
    return null;
  }
  const locked = withLockedNamePrefix(name);
  return (
    list.find((user) => {
      const userName = String(user.name ?? "").trim();
      return userName === name || userName === locked || stripLockedNamePrefix(userName) === name;
    }) ?? null
  );
}

/**
 * Soft-seat Users for the given PC seats (ownership + character; create if missing).
 * Does not change login visibility — use lockPlayersLogin / unlockPlayersLogin for that.
 *
 * @param {Array<{ actor?: object|null, pc?: object|null, playerId?: string|null, playerName?: string|null }>} seatEntries
 * @param {{ world?: object, UserDocument?: typeof User, unlockSessionPlayers?: boolean }} [options]
 * @returns {Promise<{
 *   created: Array<{ userId: string, name: string }>,
 *   updated: Array<{ userId: string, name: string }>,
 *   seatedUserIds: string[]
 * }>}
 */
export async function softSeatPlayers(seatEntries = [], options = {}) {
  const world = options.world ?? globalThis.game;
  const UserDocument = options.UserDocument ?? globalThis.User;
  const unlockSessionPlayers = options.unlockSessionPlayers === true;
  const seats = seatEntries.map(normalizeSeatEntry).filter(Boolean);

  const result = {
    created: [],
    updated: [],
    seatedUserIds: []
  };

  if (!world?.users) {
    return result;
  }

  const seatedUserIds = new Set();

  for (const seat of seats) {
    const displayName = String(seat.playerName || "").trim() || `Player ${seat.playerId}`;
    let user = findUserForSeat(world.users, seat);
    if (!user) {
      if (!UserDocument?.create) {
        console.warn(`${MODULE_ID} | User.create unavailable — skip soft-seat for ${displayName}`);
        continue;
      }
      const flags = { [FLAG_SCOPE]: { managed: true } };
      if (seat.playerId) {
        flags[FLAG_SCOPE].playerId = String(seat.playerId);
      }
      // Blank password — GM sets passwords in User Config. Role follows lock state.
      const unlocked = unlockSessionPlayers || isPlayersUnlocked(world);
      user = await UserDocument.create({
        name: unlocked ? displayName : withLockedNamePrefix(displayName),
        role: unlocked ? USER_ROLE.PLAYER : USER_ROLE.NONE,
        password: "",
        flags
      });
      result.created.push({
        userId: user.id,
        name: user.name
      });
    } else {
      const patch = {};
      if (seat.playerId && !user.flags?.[FLAG_SCOPE]?.playerId) {
        patch[`flags.${FLAG_SCOPE}.playerId`] = String(seat.playerId);
      }
      if (!user.flags?.[FLAG_SCOPE]?.managed) {
        patch[`flags.${FLAG_SCOPE}.managed`] = true;
      }
      if (unlockSessionPlayers || isPlayersUnlocked(world)) {
        if (user.role === USER_ROLE.NONE || user.role === USER_ROLE.PLAYER) {
          if (user.role !== USER_ROLE.PLAYER) {
            patch.role = USER_ROLE.PLAYER;
          }
          const stripped = stripLockedNamePrefix(user.name);
          if (stripped !== user.name) {
            patch.name = stripped;
          }
        }
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
      const characterId = user.character?.id ?? user.character ?? null;
      if (characterId !== seat.actor.id) {
        await user.update({ character: seat.actor.id });
      }
    }
  }

  result.seatedUserIds = [...seatedUserIds];

  if (result.created.length || result.updated.length) {
    const parts = [];
    if (result.created.length) {
      parts.push(`created ${result.created.length} player account(s)`);
    }
    if (result.updated.length) {
      parts.push(`updated ${result.updated.length}`);
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
 * @param {{ world?: object, unlockSessionPlayers?: boolean }} [options]
 */
export async function softSeatPlayersFromSessionDocs(sessionDocs, options = {}) {
  return softSeatPlayers(seatsFromPcActors(sessionDocs?.pcs ?? []), options);
}

/**
 * Soft-seat from import-time session PC pairs.
 * @param {Array<{ actor: object, pc?: object }>} sessionPcs
 * @param {{ world?: object, unlockSessionPlayers?: boolean }} [options]
 */
export async function softSeatPlayersFromImport(sessionPcs, options = {}) {
  return softSeatPlayers(seatsFromSessionPcs(sessionPcs), options);
}

/**
 * @param {object} [world]
 * @returns {boolean}
 */
export function isPlayersUnlocked(world = globalThis.game) {
  try {
    if (typeof setting === "function") {
      return setting(SETTING_PLAYERS_UNLOCKED) === true;
    }
  } catch (_error) {
    /* settings unavailable in Node selftests */
  }
  try {
    return world?.settings?.get?.(MODULE_ID, SETTING_PLAYERS_UNLOCKED) === true;
  } catch (_error) {
    return false;
  }
}

/**
 * Lock the login gate: every USER_ROLES.PLAYER → NONE + `_` name prefix.
 * Does not touch TRUSTED / ASSISTANT / GM.
 *
 * @param {{ world?: object }} [options]
 */
export async function lockPlayersLogin(options = {}) {
  const world = options.world ?? globalThis.game;
  const locked = [];
  for (const user of [...(world?.users ?? [])]) {
    if (user?.isGM || user?.role !== USER_ROLE.PLAYER) {
      continue;
    }
    const patch = { role: USER_ROLE.NONE };
    const nextName = withLockedNamePrefix(user.name);
    if (nextName !== user.name) {
      patch.name = nextName;
    }
    await user.update(patch);
    locked.push({ userId: user.id, name: nextName });
  }
  try {
    await setSetting(SETTING_PLAYERS_UNLOCKED, false);
  } catch (_error) {
    /* Node selftests */
  }
  const summary = locked.length
    ? `Players locked: hid ${locked.length} Player account(s) (role None, _ name).`
    : "Players locked (no Player-role accounts to hide).";
  if (globalThis.ui?.notifications) {
    notify(summary);
  } else {
    console.log(`${MODULE_ID} | ${summary}`);
  }
  return { locked };
}

/**
 * Unlock the login gate: session-linked Users → PLAYER and strip leading `_`.
 *
 * Pass `options.seats` for the live session when available; otherwise any
 * character Actor with playerId/playerName flags (Damned Lucky party).
 *
 * @param {{ world?: object, seats?: Array<object> }} [options]
 */
export async function unlockPlayersLogin(options = {}) {
  const world = options.world ?? globalThis.game;
  const seats =
    options.seats ??
    seatsFromPcActors(
      [...(world?.actors ?? [])].filter((actor) => actor?.type === "character")
    );
  const unlocked = [];
  const seatedIds = new Set();

  for (const seat of seats.map(normalizeSeatEntry).filter(Boolean)) {
    const user = findUserForSeat(world?.users ?? [], seat);
    if (!user) {
      continue;
    }
    if (user.isGM || user.role >= USER_ROLE.TRUSTED) {
      continue;
    }
    seatedIds.add(user.id);
    const patch = { role: USER_ROLE.PLAYER };
    const stripped = stripLockedNamePrefix(user.name);
    if (stripped !== user.name) {
      patch.name = stripped;
    }
    await user.update(patch);
    unlocked.push({ userId: user.id, name: patch.name ?? user.name });
  }

  try {
    await setSetting(SETTING_PLAYERS_UNLOCKED, true);
  } catch (_error) {
    /* Node selftests */
  }
  const summary = unlocked.length
    ? `Players unlocked: ${unlocked.length} session account(s) set to Player.`
    : "Players unlocked (no session-linked accounts found).";
  if (globalThis.ui?.notifications) {
    notify(summary);
  } else {
    console.log(`${MODULE_ID} | ${summary}`);
  }
  return { unlocked, seatedUserIds: [...seatedIds] };
}

/**
 * Toggle the login gate. Returns the new unlocked state.
 * @param {{ world?: object }} [options]
 */
export async function togglePlayersLoginLock(options = {}) {
  if (isPlayersUnlocked(options.world)) {
    await lockPlayersLogin(options);
    return false;
  }
  await unlockPlayersLogin(options);
  return true;
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
    if (patch.playable) {
      const stripped = stripLockedNamePrefix(user.name);
      if (stripped !== user.name) {
        update.name = stripped;
      }
    } else {
      const locked = withLockedNamePrefix(user.name);
      if (locked !== user.name) {
        update.name = locked;
      }
    }
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
