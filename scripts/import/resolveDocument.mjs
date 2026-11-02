/**
 * Resolve Foundry document references from settings / package data.
 * Accepts bare ids, Document.uuid forms (Scene.xxx), and full UUIDs.
 */

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeDocumentId(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "";
  }
  // World UUID: Scene.ECSpfu699B2uYFeU
  const worldMatch = value.match(/^(?:Actor|Scene|Item|JournalEntry|Folder|RollTable|Playlist|Cards|Macro|Adventure)\.([A-Za-z0-9]{16})$/);
  if (worldMatch) {
    return worldMatch[1];
  }
  // Already a 16-char id
  if (/^[A-Za-z0-9]{16}$/.test(value)) {
    return value;
  }
  // Trailing id after last dot
  const trailing = value.match(/\.([A-Za-z0-9]{16})$/);
  if (trailing) {
    return trailing[1];
  }
  return value;
}

/**
 * Resolve a Scene from a setting value (id or UUID).
 * @param {string} raw
 * @returns {Promise<Scene|null>}
 */
export async function resolveScene(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return null;
  }

  const byId = game.scenes.get(normalizeDocumentId(value));
  if (byId) {
    return byId;
  }

  try {
    if (typeof fromUuid === "function") {
      const doc = await fromUuid(value);
      if (doc?.documentName === "Scene" || doc instanceof Scene) {
        return doc;
      }
    }
  } catch (error) {
    console.warn("dlfi | fromUuid failed for scene ref", value, error);
  }

  try {
    if (typeof fromUuidSync === "function") {
      const doc = fromUuidSync(value);
      if (doc?.documentName === "Scene" || doc instanceof Scene) {
        return doc;
      }
    }
  } catch (_error) {
    // ignore
  }

  return null;
}
