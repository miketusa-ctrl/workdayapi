// Plain calendar-date helpers. Dates are ISO strings "YYYY-MM-DD" or integer day numbers
// (days since 1970-01-01). No timezones anywhere: a date is a calendar label, not an instant.

const DAY_MS = 86400000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Day number for (year, month 1-12, day). */
export const dn = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);

/** Weekday of a day number: 0 = Sunday ... 6 = Saturday (1970-01-01 was a Thursday). */
export const weekday = (n) => (((n + 4) % 7) + 7) % 7;

export function toIso(n) {
  const d = new Date(n * DAY_MS);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export const yearOf = (n) => new Date(n * DAY_MS).getUTCFullYear();

/** Strict ISO date parse. Returns a day number or null (rejects 2026-02-30, 2026-2-3, etc.). */
export function parseIso(s) {
  if (typeof s !== 'string') return null;
  const m = ISO_RE.exec(s.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const n = dn(y, mo, d);
  const back = new Date(n * DAY_MS);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) return null;
  return n;
}

export const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WD_ABBR = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Parse a weekend override like "sat,sun" / "fri,sat" / "none". Returns sorted weekday numbers or null if invalid. */
export function parseWeekend(s) {
  if (s == null) return null;
  const t = String(s).trim().toLowerCase();
  if (t === 'none' || t === '') return t === 'none' ? [] : null;
  const out = new Set();
  for (const part of t.split(',')) {
    const k = part.trim().slice(0, 3);
    if (!(k in WD_ABBR) || (part.trim().length > 3 && !WEEKDAY_NAMES[WD_ABBR[k]].startsWith(part.trim()))) return null;
    out.add(WD_ABBR[k]);
  }
  if (out.size > 6) return null; // at least one working weekday
  return [...out].sort((a, b) => a - b);
}

export const weekendLabel = (days) => days.map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join(',') || 'none';

// ---- rule helpers (all return day numbers) ----

/** Gregorian Easter Sunday (anonymous Gregorian algorithm / Meeus-Jones-Butcher). */
export function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dn(y, month, day);
}

/** n-th weekday (0=Sun..6=Sat) of month; n = -1 means the last one. */
export function nthWeekday(y, m, wd, n) {
  if (n > 0) {
    const first = dn(y, m, 1);
    return first + ((wd - weekday(first) + 7) % 7) + (n - 1) * 7;
  }
  const last = dn(y, m + 1, 1) - 1; // Date.UTC normalises month 13
  return last - ((weekday(last) - wd + 7) % 7);
}

/** First given weekday on or after y-m-d. */
export function onOrAfter(y, m, d, wd) {
  const n = dn(y, m, d);
  return n + ((wd - weekday(n) + 7) % 7);
}

/** Last given weekday on or before y-m-d. */
export function onOrBefore(y, m, d, wd) {
  const n = dn(y, m, d);
  return n - ((weekday(n) - wd + 7) % 7);
}
