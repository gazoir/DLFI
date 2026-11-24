/**
 * Human-readable Session Package export stamps for the Import UI.
 *
 * Example: `24 November 2026 - 2 hours ago`
 */

const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * @param {number} n
 * @param {string} unit singular unit name
 */
function pluralUnit(n, unit) {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Elapsed time since `iso`, rounded to the nearest whole unit
 * (minutes → hours → days → weeks → months → years).
 *
 * @param {string|number|Date|null|undefined} iso
 * @param {number} [nowMs]
 * @returns {string} e.g. `3 hours ago`, `just now`, or `in 2 days`
 */
export function formatElapsedSince(iso, nowMs = Date.now()) {
  const then = iso instanceof Date ? iso.getTime() : Date.parse(String(iso ?? ""));
  if (!Number.isFinite(then)) {
    return "";
  }
  const raw = nowMs - then;
  const future = raw < 0;
  const diff = Math.abs(raw);

  if (diff < 30_000) {
    return "just now";
  }

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  /** @type {string} */
  let phrase;
  const minutes = Math.round(diff / minute);
  if (minutes < 60) {
    phrase = pluralUnit(Math.max(1, minutes), "minute");
  } else {
    const hours = Math.round(diff / hour);
    if (hours < 24) {
      phrase = pluralUnit(Math.max(1, hours), "hour");
    } else {
      const days = Math.round(diff / day);
      if (days < 7) {
        phrase = pluralUnit(Math.max(1, days), "day");
      } else {
        const weeks = Math.round(diff / week);
        if (weeks < 5) {
          phrase = pluralUnit(Math.max(1, weeks), "week");
        } else {
          const months = Math.round(diff / MONTH_MS);
          if (months < 12) {
            phrase = pluralUnit(Math.max(1, months), "month");
          } else {
            phrase = pluralUnit(Math.max(1, Math.round(diff / YEAR_MS)), "year");
          }
        }
      }
    }
  }

  if (future) {
    return `in ${phrase}`;
  }
  return `${phrase} ago`;
}

/**
 * Calendar date in `dd mmmm yyyy` (en-GB), local timezone.
 *
 * @param {string|number|Date|null|undefined} iso
 * @returns {string}
 */
export function formatExportDate(iso) {
  const date = iso instanceof Date ? iso : new Date(String(iso ?? ""));
  if (Number.isNaN(date.getTime())) {
    return String(iso ?? "");
  }
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

/**
 * Full Import-view stamp: `24 November 2026 - 2 hours ago`.
 *
 * @param {string|number|Date|null|undefined} iso
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatExportStamp(iso, nowMs = Date.now()) {
  if (iso == null || iso === "") {
    return "";
  }
  const date = formatExportDate(iso);
  const elapsed = formatElapsedSince(iso, nowMs);
  if (!elapsed) {
    return date || String(iso);
  }
  if (!date || date === String(iso)) {
    return elapsed;
  }
  return `${date} - ${elapsed}`;
}

/**
 * Attach display labels for Import list rows (keeps raw ISO on value/data attrs).
 *
 * @param {Array<object>} sessions
 * @param {number} [nowMs]
 * @returns {typeof sessions}
 */
export function decorateInboxSessionsForDisplay(sessions = [], nowMs = Date.now()) {
  for (const session of sessions ?? []) {
    session.latestExportedAtLabel = formatExportStamp(session.latestExportedAt, nowMs);
    for (const version of session.versions ?? []) {
      const stamp = version?.package?.manifest?.exportedAt;
      version.exportedAtLabel = formatExportStamp(stamp, nowMs);
    }
  }
  return sessions;
}
