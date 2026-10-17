// Business-day engine: holiday lists with observed (substitute) dates, business-day tests, add and between.
import { COUNTRIES } from './countries.js';
import { toIso, weekday, yearOf } from './dates.js';

export const MIN_YEAR = 2020;
export const MAX_YEAR = 2035;
export const DATA_VERSION = '2026.10.12.1';
export const DEFAULT_TYPES = ['public', 'bank'];
const SAT = 6, SUN = 0;

export class CalendarError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function getCountry(code) {
  const c = COUNTRIES[String(code || '').toUpperCase()];
  if (!c) throw new CalendarError('unknown_country', `Unsupported country "${code}". See GET /v1/countries.`, 404);
  return c;
}

/** Validate a region against the country. Returns the effective region code or null (national). */
export function resolveRegion(countryCode, region) {
  const cc = String(countryCode).toUpperCase();
  const c = getCountry(cc);
  if (region == null || region === '') return c.defaultRegion || null;
  let r = String(region).toUpperCase();
  if (!r.includes('-')) r = `${cc}-${r}`;
  if (!c.regions || !c.regions[r]) {
    const known = c.regions ? Object.keys(c.regions).join(', ') : 'none';
    throw new CalendarError('unknown_region', `Unsupported region "${region}" for ${cc}. Supported: ${known}.`, 404);
  }
  return r;
}

/** Apply substitute-day rules (sub: fri_mon | next | next_sun) for one country/region/year. */
function applyObserved(entries) {
  const taken = new Set();
  // Holidays that stay put occupy their day first (unless flagged chrono, e.g. Scotland's 1-2 January pair).
  for (const h of entries) {
    const wd = weekday(h.n);
    const moves = (h.sub === 'next' || h.sub === 'fri_mon') ? (wd === SAT || wd === SUN) : h.sub === 'next_sun' ? wd === SUN : false;
    h._moves = moves;
    if (!moves && !h.chrono) taken.add(h.n);
  }
  const ordered = [...entries].sort((a, b) => a.n - b.n);
  for (const h of ordered) {
    if (!h._moves && !h.chrono) continue;
    let d = h.n;
    if (h.sub === 'fri_mon' && h._moves) d = weekday(h.n) === SAT ? h.n - 1 : h.n + 1;
    else if (h._moves) {
      d = h.n + 1;
      const isWeekend = (x) => (h.sub === 'next_sun' ? weekday(x) === SUN : weekday(x) === SAT || weekday(x) === SUN);
      while (isWeekend(d) || taken.has(d)) d++;
    } else if (h.chrono) {
      while (taken.has(d) || weekday(d) === SAT || weekday(d) === SUN) d++;
    }
    taken.add(d);
    if (d !== h.n) h.observed = d;
    delete h._moves;
  }
  return entries;
}

const rawCache = new Map();
const buildCache = new Map(); // `${cc}|${y}` -> raw rule output, shared by every region of a country
/** Entries whose actual date is in year y, with observed dates applied, for country/region. */
function yearEntries(cc, region, y) {
  const key = `${cc}|${region || ''}|${y}`;
  let v = rawCache.get(key);
  if (v) return v;
  const c = COUNTRIES[cc];
  const bk = `${cc}|${y}`;
  let raw = buildCache.get(bk);
  if (!raw) { raw = c.build(y); buildCache.set(bk, raw); }
  v = [];
  for (const h of raw) {
    if (h.regions && !(region && h.regions.includes(region))) continue;
    // Explicit copy (no object spread): this runs ~300 times per calendar on a cold isolate.
    const e = { n: h.n, name: h.name, type: h.type || 'public', national: !h.regions };
    if (h.local) e.local = h.local;
    if (h.regions) e.regions = h.regions;
    if (h.sub) e.sub = h.sub;
    if (h.chrono) e.chrono = h.chrono;
    v.push(e);
  }
  v = applyObserved(v);
  if (c.post) v = c.post(v, y);
  v.sort((a, b) => (a.observed ?? a.n) - (b.observed ?? b.n) || a.n - b.n);
  rawCache.set(key, v);
  return v;
}

export function format(h, countryCode) {
  const o = { date: toIso(h.n) };
  if (h.observed != null) o.observed = toIso(h.observed);
  o.name = h.name;
  if (h.local) o.local_name = h.local;
  o.type = h.type;
  o.national = h.national;
  if (!h.national && h.regions) o.regions = h.regions;
  if (h.predicted) { o.predicted = true; o.note = h.note; }
  return o;
}

export function checkYear(y) {
  if (!Number.isInteger(y) || y < MIN_YEAR || y > MAX_YEAR) {
    throw new CalendarError('year_out_of_range', `Supported years are ${MIN_YEAR}-${MAX_YEAR}.`, 422);
  }
}

/** Holidays for a year: entries whose date or observed date falls in that year (so a Saturday 1 Jan observed on 31 Dec shows in both years). */
export function holidays(cc, region, y) {
  checkYear(y);
  cc = cc.toUpperCase();
  const list = [...yearEntries(cc, region, y)];
  for (const yy of [y - 1, y + 1]) {
    for (const h of yearEntries(cc, region, yy)) if (h.observed != null && yearOf(h.observed) === y) list.push(h);
  }
  return list.sort((a, b) => (a.observed ?? a.n) - (b.observed ?? b.n) || a.n - b.n);
}

const closedCache = new Map();
/** Map dayNumber -> holiday entry for every non-business holiday date (actual and observed), years y-1..y+1 covered. */
export function closedMap(cc, region, types = DEFAULT_TYPES) {
  // Canonical (deduped, sorted) type set for the cache key, so public,bank and bank,public share one table, matching
  // the batch cap's batchCalendarKey. Membership is order-independent, so the table is identical.
  types = [...new Set(types)].sort();
  const key = `${cc}|${region || ''}|${types.join(',')}`;
  let m = closedCache.get(key);
  if (m) return m;
  m = new Map();
  for (let y = MIN_YEAR - 1; y <= MAX_YEAR + 1; y++) {
    for (const h of yearEntries(cc, region, y)) {
      if (!types.includes(h.type)) continue;
      if (!m.has(h.n)) m.set(h.n, h);
      if (h.observed != null && !m.has(h.observed)) m.set(h.observed, { ...h, _observedOf: h.n });
    }
  }
  closedCache.set(key, m);
  return m;
}

export function makeCalendar(countryCode, region, { weekend, types } = {}) {
  const cc = String(countryCode).toUpperCase();
  const c = getCountry(cc);
  const r = resolveRegion(cc, region);
  const wk = weekend ?? c.weekend ?? [SAT, SUN];
  const ty = types ?? DEFAULT_TYPES;
  return { cc, region: r, weekend: wk, types: ty, closed: closedMap(cc, r, ty), wkSet: new Set(wk) };
}

/** Why a day is not a business day, or null if it is one. */
export function nonBusinessReason(cal, n) {
  const h = cal.closed.get(n);
  if (h) {
    const name = h._observedOf != null ? `${h.name} (observed)` : h.name;
    return { kind: h._observedOf != null ? 'observed_holiday' : 'holiday', holiday: name, holiday_type: h.type, ...(h._observedOf != null ? { actual_date: toIso(h._observedOf) } : {}), ...(h.predicted && h._observedOf != null ? { predicted: true } : {}) };
  }
  if (cal.wkSet.has(weekday(n))) return { kind: 'weekend' };
  return null;
}

export const MIN_DN = Math.floor(Date.UTC(MIN_YEAR, 0, 1) / 86400000);
export const MAX_DN = Math.floor(Date.UTC(MAX_YEAR, 11, 31) / 86400000);
export const MAX_ADD_DAYS = 2500;

export function checkDate(n, field = 'date') {
  if (n < MIN_DN || n > MAX_DN) throw new CalendarError('date_out_of_range', `${field} must be between ${MIN_YEAR}-01-01 and ${MAX_YEAR}-12-31.`, 422);
}

// Per closed-map (cached per country/region/types) and weekend set: sorted day numbers of every closed date and
// a weekend flag per day; the named list items are materialized lazily (only when a response needs them).
// Module-level so warm isolates reuse them across requests.
const rangeIndexCache = new WeakMap();
function rangeIndex(cal) {
  if (cal._idx) return cal._idx;
  let byWk = rangeIndexCache.get(cal.closed);
  if (!byWk) { byWk = new Map(); rangeIndexCache.set(cal.closed, byWk); }
  const wkKey = [...cal.wkSet].sort().join(',');
  let idx = byWk.get(wkKey);
  if (!idx) {
    const days = Float64Array.from(cal.closed.keys()).sort();
    const onWk = new Uint8Array(days.length);
    for (let i = 0; i < days.length; i++) onWk[i] = cal.wkSet.has(weekday(days[i])) ? 1 : 0;
    idx = { days, onWk, items: null }; // items (named list entries) are built only when a list is requested
    byWk.set(wkKey, idx);
  }
  cal._idx = idx;
  return idx;
}
function rangeItems(cal, idx) {
  if (!idx.items) {
    idx.items = Array.from(idx.days, (d, i) => {
      const r = nonBusinessReason(cal, d);
      return Object.freeze({ date: toIso(d), name: r.holiday, type: r.holiday_type, ...(idx.onWk[i] ? { on_weekend: true } : {}), ...(r.predicted ? { predicted: true } : {}) });
    });
  }
  return idx.items;
}

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Number of days d in [s, e] with weekday(d) === w. */
function countWeekday(s, e, w) {
  if (e < s) return 0;
  const first = s + ((w - weekday(s) + 7) % 7);
  return first > e ? 0 : Math.floor((e - first) / 7) + 1;
}

/**
 * Classify every day in [s, e] (inclusive) without walking day by day: weekends by arithmetic, holidays
 * by binary search in the sorted closed-day list. A holiday on a weekend counts as a holiday (not weekend).
 * O(log H + holidays in range), so a 16-year range costs about the same as one month.
 */
function classifyRange(cal, s, e, lists = true) {
  const out = { business: 0, weekendDays: 0, holidayDays: 0, list: [] };
  if (e < s) return out;
  let weekendCount = 0;
  for (const w of cal.wkSet) weekendCount += countWeekday(s, e, w);
  const idx = rangeIndex(cal);
  const { days, onWk } = idx;
  const i0 = lowerBound(days, s), i1 = lowerBound(days, e + 1);
  let onWeekend = 0;
  for (let i = i0; i < i1; i++) onWeekend += onWk[i];
  out.holidayDays = i1 - i0;
  out.list = lists ? rangeItems(cal, idx).slice(i0, i1) : null;
  out.weekendDays = weekendCount - onWeekend;
  out.business = (e - s + 1) - out.weekendDays - out.holidayDays;
  return out;
}

/**
 * Add business days. days > 0 moves forward, < 0 backward; the start date itself is never counted.
 * days = 0 returns the start date if it is a business day, otherwise the next business day.
 * Large counts jump whole weeks using classifyRange (never overshooting), then finish day by day.
 */
export function addBusinessDays(cal, start, days, { lists = true } = {}) {
  if (cal.weekend.length >= 7) throw new CalendarError('invalid_weekend', 'weekend must leave at least one working day.');
  const step = days < 0 ? -1 : 1;
  let n = start, left = Math.abs(days);
  const skipped = lists ? [] : null;
  let skippedCount = 0;
  const note = (d) => {
    const r = nonBusinessReason(cal, d);
    if (r && r.kind !== 'weekend') {
      skippedCount++;
      if (lists) skipped.push({ date: toIso(d), name: r.holiday, type: r.holiday_type, ...(r.predicted ? { predicted: true } : {}) });
    }
    return r;
  };
  if (left === 0) {
    while (note(n)) { n += 1; if (n > MAX_DN) throw new CalendarError('result_out_of_range', `Result falls after ${MAX_YEAR}-12-31.`, 422); }
    return { result: n, skipped, skippedCount };
  }
  const perWeek = 7 - cal.wkSet.size;
  // Jump k whole weeks while that cannot overshoot: k weeks hold at most k*perWeek business days <= left - 1.
  for (;;) {
    const k = Math.floor((left - 1) / perWeek);
    if (k < 1) break;
    let jump = 7 * k;
    const room = step > 0 ? MAX_DN - n : n - MIN_DN;
    if (jump > room) jump = room - (room % 7);
    if (jump < 7) break;
    const [s, e] = step > 0 ? [n + 1, n + jump] : [n - jump, n - 1];
    const c = classifyRange(cal, s, e, lists);
    skippedCount += c.holidayDays;
    if (lists) for (const h of step > 0 ? c.list : c.list.reverse()) skipped.push({ date: h.date, name: h.name, type: h.type, ...(h.predicted ? { predicted: true } : {}) });
    n += step * jump;
    left -= c.business;
  }
  while (left > 0) {
    n += step;
    if (n < MIN_DN || n > MAX_DN) throw new CalendarError('result_out_of_range', `Result falls outside ${MIN_YEAR}-01-01..${MAX_YEAR}-12-31.`, 422);
    if (!note(n)) left--;
  }
  return { result: n, skipped, skippedCount };
}

/**
 * Count days between two dates. Counts each day AFTER `from` up to and including `to` (so add(from, n) = to
 * gives business_days = n when `to` is a business day). inclusive=true also counts `from` itself.
 * If to < from the counts are negative.
 */
export function between(cal, from, to, inclusive = false, { lists = true } = {}) {
  const sign = to < from ? -1 : 1;
  const [lo, hi] = sign > 0 ? [from, to] : [to, from];
  // Forward: (from, to]. Backward mirrors it: [to, from). inclusive adds the `from` end.
  const s = sign > 0 ? (inclusive ? lo : lo + 1) : lo;
  const e = sign > 0 ? hi : (inclusive ? hi : hi - 1);
  const c = classifyRange(cal, s, e, lists);
  const calendarDays = Math.max(0, e - s + 1);
  return {
    business_days: sign * c.business,
    calendar_days: sign * calendarDays,
    weekend_days: sign * c.weekendDays,
    holiday_days: sign * c.holidayDays,
    holidays: c.list,
  };
}
