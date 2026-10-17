// WorkdayAPI request router. No Worker-only imports, so it runs under node:test with fakes.
import {
  CalendarError, DATA_VERSION, DEFAULT_TYPES, MAX_ADD_DAYS, MAX_YEAR, MIN_YEAR,
  addBusinessDays, between, checkDate, checkYear, format, getCountry, holidays, makeCalendar, nonBusinessReason, resolveRegion,
} from './lib/calendar.js';
import { COUNTRIES, COUNTRY_CODES } from './lib/countries.js';
import { WEEKDAY_NAMES, parseIso, parseWeekend, toIso, weekday, weekendLabel } from './lib/dates.js';
import { budgetAllows, budgetRecord, secondsToNextUtcMonth, secondsToUtcMidnight } from './lib/budget.js';
import { extractApiKey, generateApiKey, hashApiKey, isKeyFormat, safeEqual } from './lib/keys.js';
import { utcDay, utcMonth } from './lib/quota.js';
import { VERSION } from './version.js';
import { handleMcp } from './lib/mcp.js';
import { llmsTxt, openApiSpec, serverCard, registryAuthProof } from './lib/agentdocs.js';

export { VERSION };
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_BATCH_OPS = 100;
// Distinct calendars per batch: country + region + types + weekend (each needs its own table/index on a cold isolate).
export const MAX_BATCH_CALENDARS = 10;
// Ops per batch that may return per-day lists ("details": true); bounds response size and serialization CPU.
export const MAX_BATCH_DETAILS = 10;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-api-key',
  'access-control-expose-headers': 'retry-after, x-cache, x-plan, x-quota-limit, x-quota-used, x-quota-remaining, x-workdayapi-version',
  'access-control-max-age': '86400',
};
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const PAGE_HEADERS = { ...SECURITY, 'content-security-policy': CSP, 'x-frame-options': 'DENY', 'cross-origin-opener-policy': 'same-origin' };

export const CACHE_SECONDS = 86400; // client cache 1 day; edge copy 7 days (keys include DATA_VERSION)
const EDGE_SECONDS = 7 * 86400;

// Strict: only /^\d+$/ (after trim) in 1..100000; "1e3", "0x10", "5.0" fall back to the default (v0.2.0 backlog).
const capInt = (v, d) => { const t = String(v ?? '').trim(); const x = /^\d{1,6}$/.test(t) ? Number(t) : NaN; return Number.isInteger(x) && x >= 1 && x <= 100000 ? x : d; };
export function config(env = {}) {
  const n = (v, d) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Number(v) : d);
  return {
    staging: String(env.PUBLIC_LAUNCH || 'false') !== 'true',
    anonPerMin: n(env.ANON_LIMIT_PER_MIN, 30),
    keyPerMin: n(env.KEY_LIMIT_PER_MIN, 120),
    freePerMonth: n(env.FREE_CALLS_PER_MONTH, 1000),
    proPerMonth: n(env.PRO_CALLS_PER_MONTH, 50000),
    callsPerDay: n(env.DAILY_CALL_POOL, 15000),
    anonPerDay: n(env.DAILY_ANON_POOL, 8000),
    mintsPerDay: n(env.DAILY_KEY_MINTS, 200),
    // Signup caps must be integers 1..100000 (the DO's accepted range); anything else falls back to the default
    // instead of turning into DO 400s.
    mintsPerIpPerDay: capInt(env.DAILY_KEY_MINTS_PER_IP, 5),
    mintsPerNet48PerDay: capInt(env.DAILY_KEY_MINTS_PER_IPV6_48, 15),
    authFailsPerMin: n(env.AUTH_FAIL_LIMIT_PER_MIN, 10),
    authFailsPerDay: n(env.DAILY_AUTH_FAIL_POOL, 2000),
    freeSignup: String(env.FREE_KEY_SIGNUP || 'false') === 'true',
    adminEnabled: String(env.ADMIN_ENABLED || 'false') === 'true' && !!env.ADMIN_TOKEN,
    keyEpoch: String(env.KEY_EPOCH || '1').replace(/[^0-9a-z]/gi, '') || '1',
    build: String(env.BUILD_ID || 'dev').slice(0, 40),
    release: /^[0-9A-Za-z.+_-]{1,64}$/.test(String(env.RELEASE || '')) ? String(env.RELEASE) : 'dev',
    // Explicit per-environment edge-cache scope. Unset/invalid -> "dev", never the production scope.
    cacheScope: /^[a-z0-9-]{1,32}$/.test(String(env.CACHE_SCOPE || '')) ? String(env.CACHE_SCOPE) : 'dev',
  };
}

function json(body, status = 200, extra = {}, compact = false) {
  return new Response(compact ? JSON.stringify(body) : JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...SECURITY, 'x-workdayapi-version': VERSION, ...extra },
  });
}
function apiError(status, code, message, extra = {}, details) {
  return json({ error: { code, message, ...(details ? { details } : {}) }, docs: '/docs' }, status, extra);
}
const fromCalErr = (e) => apiError(e.status, e.code, e.message);

// ---------- rate limiting (Workers Rate Limiting bindings, with an in-isolate fallback for tests/local) ----------
const fallback = new Map();
export function _resetForTests() { fallback.clear(); }
async function limited(binding, key, perMin) {
  if (binding && typeof binding.limit === 'function') {
    try { const { success } = await binding.limit({ key }); return !success; } catch { /* fall through to fallback */ }
  }
  const now = Date.now(), win = Math.floor(now / 60000);
  const k = `${key}|${win}`;
  const c = (fallback.get(k) || 0) + 1;
  fallback.set(k, c);
  if (fallback.size > 5000) for (const kk of fallback.keys()) { if (!kk.endsWith(`|${win}`)) fallback.delete(kk); }
  return c > perMin;
}

/** Per-isolate fixed-window counter (MCP discovery cap; recipe §2). true = allowed. */
const memLimits = new Map();
export function memLimit(key, limit, periodMs) {
  const now = Date.now();
  const e = memLimits.get(key);
  if (!e || now - e.start > periodMs) { if (memLimits.size > 5000) memLimits.clear(); memLimits.set(key, { start: now, n: 1 }); return true; }
  e.n += 1;
  return e.n <= limit;
}
export function _resetMemLimitsForTests() { memLimits.clear(); }

// ---------- body cap ----------
export async function readBodyCapped(request, max = MAX_BODY_BYTES) {
  const cl = Number(request.headers.get('content-length') || 0);
  if (cl > max) return { tooLarge: true };
  if (!request.body) return { text: '' };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch { /* ignore */ } return { tooLarge: true }; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return { text: new TextDecoder().decode(buf) };
}

// ---------- parameter parsing ----------
class ParamError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }
const req = (p, name) => {
  const v = p[name];
  if (v === undefined || v === null || String(v).trim() === '') throw new ParamError('missing_parameter', `Missing required parameter "${name}".`);
  return String(v).trim();
};
function dateParam(p, name) {
  const s = req(p, name);
  const n = parseIso(s);
  if (n == null) throw new ParamError('invalid_date', `"${name}" must be a calendar date in YYYY-MM-DD format.`);
  checkDate(n, name);
  return n;
}
function typesParam(v, dflt) {
  if (v == null || v === '') return dflt;
  const t = String(v).toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  if (t.length === 1 && t[0] === 'all') return ['public', 'bank', 'observance'];
  if (!t.length || t.some((x) => !['public', 'bank', 'observance'].includes(x))) throw new ParamError('invalid_types', 'types must be a comma list of public, bank, observance (or "all").');
  return [...new Set(t)];
}
function calendarFrom(p) {
  const cc = req(p, 'country').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) throw new ParamError('invalid_country', 'country must be an ISO 3166-1 alpha-2 code, e.g. US.');
  let weekend;
  if (p.weekend != null && String(p.weekend) !== '') {
    weekend = parseWeekend(p.weekend);
    if (!weekend) throw new ParamError('invalid_weekend', 'weekend must be a comma list of day names like "sat,sun" or "fri,sat", or "none".');
    if (weekend.length >= 7) throw new ParamError('invalid_weekend', 'weekend must leave at least one working day.');
  }
  const types = typesParam(p.types, DEFAULT_TYPES).filter((t) => t !== 'observance');
  if (!types.length) throw new ParamError('invalid_types', 'Observance days never close business days, so types must include public and/or bank for business-day math (e.g. types=public).');
  return makeCalendar(cc, p.region, { weekend, types });
}
const calInfo = (cal) => ({ country: cal.cc, region: cal.region, weekend: weekendLabel(cal.weekend), holiday_types: cal.types });
const bool = (v) => /^(1|true|yes)$/i.test(String(v ?? ''));

// ---------- operations (pure; shared by GET endpoints and /v1/batch) ----------
export function opIsBusinessDay(p) {
  const cal = calendarFrom(p);
  const n = dateParam(p, 'date');
  const r = nonBusinessReason(cal, n);
  // At the edges of the supported range the neighbour may not exist: return null instead of failing the call.
  const near = (d) => { try { return toIso(addBusinessDays(cal, n, d).result); } catch (e) { if (e instanceof CalendarError && e.code === 'result_out_of_range') return null; throw e; } };
  const next = near(1), prev = near(-1);
  return {
    date: toIso(n), weekday: WEEKDAY_NAMES[weekday(n)], ...calInfo(cal),
    business_day: !r,
    reason: r ? r.kind : 'business_day',
    ...(r && r.holiday ? { holiday: { name: r.holiday, type: r.holiday_type, ...(r.actual_date ? { actual_date: r.actual_date } : {}), ...(r.predicted ? { predicted: true } : {}) } } : {}),
    previous_business_day: prev, next_business_day: next,
  };
}
export function opAdd(p, { lists = true } = {}) {
  const cal = calendarFrom(p);
  const n = dateParam(p, 'date');
  const ds = req(p, 'days');
  if (!/^[+-]?\d+$/.test(ds)) throw new ParamError('invalid_days', '"days" must be an integer (negative counts backwards).');
  const days = Number(ds);
  if (Math.abs(days) > MAX_ADD_DAYS) throw new ParamError('days_out_of_range', `|days| must be <= ${MAX_ADD_DAYS}.`, 422);
  const { result, skipped, skippedCount } = addBusinessDays(cal, n, days, { lists });
  return {
    date: toIso(n), days, ...calInfo(cal),
    result: toIso(result), result_weekday: WEEKDAY_NAMES[weekday(result)],
    calendar_days: result - n, ...(lists ? { skipped_holidays: skipped } : { skipped_holidays_count: skippedCount }),
  };
}
export function opBetween(p, { lists = true } = {}) {
  const cal = calendarFrom(p);
  const from = dateParam(p, 'from'), to = dateParam(p, 'to');
  const inclusive = bool(p.inclusive);
  const b = between(cal, from, to, inclusive, { lists });
  if (!lists) { delete b.holidays; b.holidays_count = Math.abs(b.holiday_days); }
  return { from: toIso(from), to: toIso(to), inclusive, ...calInfo(cal), ...b };
}
export function opHolidays(p) {
  const cc = req(p, 'country').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) throw new ParamError('invalid_country', 'country must be an ISO 3166-1 alpha-2 code, e.g. DE.');
  const c = getCountry(cc);
  const ys = req(p, 'year');
  if (!/^\d{4}$/.test(ys)) throw new ParamError('invalid_year', '"year" must be a 4-digit year.');
  const y = Number(ys);
  checkYear(y);
  const region = resolveRegion(cc, p.region);
  const types = typesParam(p.types, ['public', 'bank', 'observance']);
  const list = holidays(cc, region, y).filter((h) => types.includes(h.type)).map((h) => format(h));
  return {
    country: cc, country_name: c.name, region, region_name: region ? c.regions[region] : null, year: y,
    scope: c.scope, count: list.length, holidays: list,
    ...(c.notes ? { notes: c.notes } : {}), sources: c.sources, data_version: DATA_VERSION,
  };
}
export function countriesList() {
  return {
    count: COUNTRY_CODES.length, years: { from: MIN_YEAR, to: MAX_YEAR }, data_version: DATA_VERSION,
    countries: COUNTRY_CODES.map((code) => {
      const c = COUNTRIES[code];
      return {
        code, name: c.name, scope: c.scope, weekend: 'sat,sun',
        regions: c.regions ? Object.entries(c.regions).map(([k, v]) => ({ code: k, name: v })) : [],
        ...(c.defaultRegion ? { default_region: c.defaultRegion } : {}),
        ...(c.notes ? { notes: c.notes } : {}), sources: c.sources,
      };
    }),
  };
}
const OPS = { 'is-business-day': opIsBusinessDay, add: opAdd, between: opBetween };
const DATA_ROUTES = { '/v1/holidays': opHolidays, '/v1/is-business-day': opIsBusinessDay, '/v1/add': opAdd, '/v1/between': opBetween };
const CACHE_PARAMS = ['country', 'region', 'year', 'date', 'days', 'from', 'to', 'weekend', 'types', 'inclusive'];

/**
 * The ONE place GET query params are read. Any repeated param is rejected, and only known params are kept, each
 * via searchParams.get and normalized (trim; country/region upper-case; others lower-case). The op and the
 * edge-cache key are both built from this object, so they cannot disagree.
 */
export function readParams(url) {
  const seen = new Set();
  for (const k of url.searchParams.keys()) {
    if (seen.has(k)) throw new ParamError('duplicate_parameter', `Parameter "${k}" appears more than once; send each parameter once.`);
    seen.add(k);
  }
  const p = {};
  for (const k of CACHE_PARAMS) {
    const v = url.searchParams.get(k);
    if (v == null) continue;
    const t = v.trim();
    p[k] = k === 'country' || k === 'region' ? t.toUpperCase() : t.toLowerCase();
  }
  return p;
}

function runOp(fn, p, opts) {
  try { return { ok: true, body: fn(p, opts) }; } catch (e) {
    if (e instanceof ParamError || e instanceof CalendarError) return { ok: false, status: e.status, code: e.code, message: e.message };
    throw e;
  }
}

// ---------- auth + metering ----------
// Phase 1 (gate): cheap checks, no Durable Object: per-IP limiter (anonymous AND keyed traffic), key format,
// isolate-local block/negative caches, per-key burst limiter, shared daily pools. Phase 2 (charge): only for keyed
// calls that passed validation: one DO request validates the key and counts `units` against the monthly quota.
// Validation errors are never charged. Failed auth (malformed/unknown/revoked keys, bad admin tokens) goes through
// AUTH_LIMITER per IP (~10/min). Once an IP trips it, this isolate refuses that IP's unverified keys for 60 s
// WITHOUT a DO request, and failed keys are remembered for 10 min, so random keys cannot cause unbounded DO
// traffic. A daily "authfail" pool counts only real failed DO lookups that the failure limiter allowed; when it is
// used up, only IPs with a failure in the last minute are refused (503), never clean clients.
const BLOCK_MS = 60_000, BAD_TTL_MS = 10 * 60_000, GOOD_TTL_MS = 10 * 60_000, MAX_ENTRIES = 5000;
const RECENT_FAIL_MS = 60_000;
const authState = { blocked: new Map(), bad: new Map(), good: new Map(), recentFail: new Map(), mintCapped: new Map() }; // ip -> until; hash -> until
export function _resetAuthForTests() { for (const m of Object.values(authState)) m.clear(); }
export const _authStateForTests = authState;
function memo(m, k, now = Date.now()) {
  const t = m.get(k);
  if (t == null) return false;
  if (t < now) { m.delete(k); return false; }
  return true;
}
/**
 * Bounded TTL map insert. Re-inserting moves the key to the end, and every map uses one TTL, so Map order is expiry
 * order. When full: drop expired entries, then evict the OLDEST ~10%.
 */
export function remember(m, k, ttl, max = MAX_ENTRIES) {
  m.delete(k);
  if (m.size >= max) {
    const now = Date.now();
    for (const [kk, t] of m) if (t < now) m.delete(kk);
    if (m.size >= max) {
      let n = m.size - max + 1 + Math.floor(max / 10);
      for (const kk of m.keys()) { if (n-- <= 0) break; m.delete(kk); }
    }
  }
  m.set(k, Date.now() + ttl);
}
const keyDoName = (L, hash) => (L.keyEpoch === '1' ? `key:${hash}` : `key${L.keyEpoch}:${hash}`);
const tooManyFailures = () => apiError(429, 'too_many_auth_failures', 'Too many failed API-key or admin-token attempts from this IP. Retry in a minute.', { 'retry-after': '60' });

/**
 * Record one failed authentication for this IP. Returns a 429 response once the IP is over the limit, else null.
 * Only a real Durable Object lookup (`lookup: true`: unknown/revoked key that reached QUOTA) that the per-IP
 * failure limiter allowed is counted in the daily "authfail" pool. Malformed keys, negative-cache hits and
 * admin-token failures cost no DO request and never touch the pool. Every failure marks the IP as "recently
 * failing" for 60 s; only such IPs are refused when the pool is exhausted (see keyPrecheck).
 */
async function authFailure(env, ctx, L, ip, { lookup = false, limiterChecked = false } = {}) {
  remember(authState.recentFail, ip, RECENT_FAIL_MS);
  // limiterChecked: keyPrecheck already counted this attempt against AUTH_LIMITER before the DO lookup.
  if (!limiterChecked && await limited(env.AUTH_LIMITER, `authfail:${ip}`, L.authFailsPerMin)) {
    remember(authState.blocked, ip, BLOCK_MS);
    return tooManyFailures();
  }
  if (lookup) budgetRecord('authfail', env.QUOTA, ctx);
  return null;
}

/**
 * Cheap pre-checks for a request carrying an API key; no Durable Object request. Returns { hash, limiterChecked } or {
 * res }. For an unverified key from an IP that failed auth in the last minute, AUTH_LIMITER is consulted BEFORE the DO
 * lookup, so an over-limit IP costs no DO request even on an isolate that has no block memo for it. Clean IPs are not
 * affected (no limiter call).
 */
async function keyPrecheck(raw, env, ctx, L, ip, units) {
  let limiterChecked = false;
  const unverified = () => memo(authState.blocked, ip) ? { res: tooManyFailures() } : null;
  if (!isKeyFormat(raw)) {
    const b = unverified(); if (b) return b;
    return { res: (await authFailure(env, ctx, L, ip)) || apiError(401, 'invalid_api_key', 'API key is malformed. Send "Authorization: Bearer wd_live_...".') };
  }
  const hash = await hashApiKey(raw);
  if (!memo(authState.good, hash)) {
    const b = unverified(); if (b) return b;
    if (memo(authState.bad, hash)) return { res: (await authFailure(env, ctx, L, ip)) || apiError(401, 'invalid_api_key', 'Unknown or revoked API key.') };
    // Pool exhausted: refuse unverified keys only from IPs that failed auth in the last minute. A clean IP's
    // never-seen valid key still gets its DO lookup. The mark clears 60 s after the IP's last failure, so
    // Retry-After is 60, not "until midnight".
    if (memo(authState.recentFail, ip)) {
      if (!budgetAllows('authfail', L).ok) return { res: apiError(503, 'daily_capacity_reached', 'API-key verification capacity for clients with recent failed attempts is used up for today. Retry in a minute.', { 'retry-after': '60' }) };
      if (await limited(env.AUTH_LIMITER, `authfail:${ip}`, L.authFailsPerMin)) {
        remember(authState.blocked, ip, BLOCK_MS);
        return { res: tooManyFailures() };
      }
      limiterChecked = true;
    }
  }
  if (await limited(env.KEY_LIMITER, `ip:${ip}`, L.keyPerMin)) {
    return { res: apiError(429, 'rate_limited', `Too many keyed requests from this IP (about ${L.keyPerMin} per minute).`, { 'retry-after': '60' }) };
  }
  if (await limited(env.KEY_LIMITER, `key:${hash.slice(0, 32)}`, L.keyPerMin)) {
    return { res: apiError(429, 'rate_limited', `Too many requests for this API key (about ${L.keyPerMin} per minute).`, { 'retry-after': '60' }) };
  }
  if (!budgetAllows('key', L, units).ok) return { res: apiError(503, 'daily_capacity_reached', 'Service capacity for today is reached. Please retry after 00:00 UTC.', { 'retry-after': String(secondsToUtcMidnight()) }) };
  if (!env.QUOTA) return { res: apiError(503, 'quota_unavailable', 'API key service is not configured.') };
  return { hash, limiterChecked };
}

async function gate(request, env, ctx, L, units, ip) {
  const raw = extractApiKey(request);
  if (!raw) {
    if (await limited(env.CALC_LIMITER, `ip:${ip}`, L.anonPerMin)) {
      return { res: apiError(429, 'rate_limited', `Too many requests: anonymous use is limited to about ${L.anonPerMin} requests per minute per IP. Use an API key for more.`, { 'retry-after': '60' }) };
    }
    if (!budgetAllows('anon', L, units).ok) return { res: apiError(503, 'daily_capacity_reached', 'The free service has reached today’s capacity. Please retry after 00:00 UTC or use an API key.', { 'retry-after': String(secondsToUtcMidnight()) }) };
    return { plan: 'anonymous', charge: async () => { budgetRecord('anon', env.QUOTA, ctx, units); return { headers: {} }; } };
  }
  const k = await keyPrecheck(raw, env, ctx, L, ip, units);
  if (k.res) return k;
  return { plan: 'key', hash: k.hash, charge: (opts) => chargeKey(env, ctx, L, k.hash, units, ip, { ...opts, limiterChecked: k.limiterChecked }) };
}

/** One DO request: validate the key, (optionally) require a plan, and count `units`. */
async function chargeKey(env, ctx, L, hash, units, ip, { require, limiterChecked = false } = {}) {
  let q;
  try {
    const stub = env.QUOTA.get(env.QUOTA.idFromName(keyDoName(L, hash)));
    const r = await stub.fetch(`https://quota/consume?month=${utcMonth()}&units=${units}&free=${L.freePerMonth}&pro=${L.proPerMonth}${require ? `&require=${require}` : ''}`, { method: 'POST' });
    q = await r.json();
  } catch {
    return { res: apiError(503, 'quota_unavailable', 'Could not verify the API key right now. Please retry.', { 'retry-after': '5' }) };
  }
  if (!q.ok && (q.reason === 'unknown_key' || q.reason === 'revoked')) {
    authState.good.delete(hash);
    remember(authState.bad, hash, BAD_TTL_MS);
    return { res: (await authFailure(env, ctx, L, ip, { lookup: true, limiterChecked })) || apiError(401, 'invalid_api_key', 'Unknown or revoked API key.') };
  }
  remember(authState.good, hash, GOOD_TTL_MS);
  if (!q.ok && q.reason === 'plan_required') return { res: apiError(403, 'plan_required', 'POST /v1/batch is a Pro feature (paid plans are coming soon; see /docs#pricing).', { 'x-plan': q.plan }) };
  const headers = q.limit != null ? { 'x-plan': q.plan, 'x-quota-limit': String(q.limit), 'x-quota-used': String(q.used), 'x-quota-remaining': String(Math.max(0, q.limit - q.used)) } : {};
  if (!q.ok) return { res: apiError(429, 'monthly_quota_exceeded', `Monthly quota of ${q.limit} calls for the ${q.plan} plan is used up (resets on the 1st, 00:00 UTC).`, { ...headers, 'retry-after': String(secondsToNextUtcMonth()) }) };
  budgetRecord('key', env.QUOTA, ctx, units);
  return { plan: q.plan, headers };
}

// ---------- edge cache (Workers Cache API) ----------
/**
 * Edge-cache key from the SAME normalized params object the op runs on (see readParams). `scope` keeps staging and
 * production apart: both Workers live on the same workers.dev zone and so share caches.default (found live after the
 * first production deploy: a staging-cached response was a HIT on production). The scope is the explicit CACHE_SCOPE
 * var (wrangler.toml: "staging" / "production"); unset -> "dev".
 */
export function cacheKeyUrl(p, path, scope = 'dev') {
  const u = new URL(`https://${scope}.workdayapi-cache.internal${path}`);
  for (const k of CACHE_PARAMS) if (p[k] != null && p[k] !== '') u.searchParams.set(k, p[k]);
  u.searchParams.set('v', `${VERSION}|${DATA_VERSION}`);
  return u.toString();
}
const cacheKey = (p, path, L) => new Request(cacheKeyUrl(p, path, L.cacheScope), { method: 'GET' });
const edgeCache = () => (typeof caches !== 'undefined' && caches.default ? caches.default : null);

// ---------- router ----------
export function createApp(assets = {}) {
  return async function handle(request, env = {}, ctx = {}) {
    let res;
    try { res = await route(request, env, ctx, assets); } catch (e) {
      res = apiError(500, 'internal_error', 'Unexpected server error. Please retry.');
    }
    if (config(env).staging) res.headers.set('x-robots-tag', 'noindex, nofollow');
    return res;
  };
}

function page(body, type, extra = {}) {
  return new Response(body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=300', ...PAGE_HEADERS, ...extra } });
}

const GLAMA_CLAIM = '{"$schema":"https://glama.ai/mcp/schemas/connector.json","claim":"<GLAMA_CLAIM_TOKEN>"}';

async function route(request, env, ctx, assets) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const L = config(env);
  const rawIp = request.headers.get('cf-connecting-ip') || 'unknown';
  // v0.2.0 (recipe §1): every per-IP limiter / memo key uses ipBucket (IPv4 as is, IPv6 → its /64). Signup caps keep
  // the raw address (mintFreeKey derives its /64 and /48 itself).
  const ip = ipBucket(rawIp);
  const method = request.method.toUpperCase();

  if (path === '/mcp') {
    return handleMcp(request, env, ctx, {
      authenticate, runData, runCountries, ipBucket: ip, memLimit, origin: url.origin, security: SECURITY,
      allowedOrigins: env.MCP_ALLOWED_ORIGINS, limits: L,
    });
  }
  const AGENT_DOCS = { '/llms.txt': 1, '/openapi.json': 1, '/.well-known/mcp/server-card.json': 1 };
  if (AGENT_DOCS[path]) {
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS' } });
    if (method !== 'GET' && method !== 'HEAD') return apiError(405, 'method_not_allowed', `Method ${method} is not allowed here.`, { allow: 'GET, HEAD, OPTIONS' });
    const body = path === '/llms.txt' ? llmsTxt(url.origin, L) : JSON.stringify(path === '/openapi.json' ? openApiSpec(url.origin, L) : serverCard(url.origin), null, 2);
    const type = path === '/llms.txt' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
    return new Response(method === 'HEAD' ? null : body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=3600', ...CORS, ...SECURITY } });
  }
  if (path === '/.well-known/glama.json' && (method === 'GET' || method === 'HEAD')) {
    // Glama connector ownership claim, served at /.well-known/glama.json. Replace the placeholder with your own claim token from glama.ai.
    return new Response(method === 'HEAD' ? null : GLAMA_CLAIM, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', ...SECURITY } });
  }
  if (path === '/.well-known/mcp-registry-auth' && (method === 'GET' || method === 'HEAD')) {
    // Official MCP Registry HTTP-namespace proof: the PUBLIC key record only, 404 unless well-formed (recipe §10).
    const proof = registryAuthProof(env);
    if (!proof) return apiError(404, 'not_found', 'No such endpoint. See /docs.');
    return new Response(method === 'HEAD' ? null : proof, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY } });
  }

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS } });

  // Static pages
  if (method === 'GET' || method === 'HEAD') {
    const origin = url.origin;
    if (path === '/' && assets.html) return page(assets.html.replaceAll('{{ORIGIN}}', origin), 'text/html; charset=utf-8');
    if (path === '/docs' && assets.docs) return page(assets.docs.replaceAll('{{ORIGIN}}', origin), 'text/html; charset=utf-8');
    if (path === '/app.js' && assets.js) return page(assets.js, 'text/javascript; charset=utf-8');
    if (path === '/style.css' && assets.css) return page(assets.css, 'text/css; charset=utf-8');
    if (path === '/robots.txt') {
      const body = L.staging ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nAllow: /\nDisallow: /v1/\n`;
      return page(body, 'text/plain; charset=utf-8');
    }
    if (path === '/health' || path === '/v1/meta') {
      return json({
        status: 'ok', service: 'workdayapi', version: VERSION, release: L.release, build: L.build, data_version: DATA_VERSION,
        years: { from: MIN_YEAR, to: MAX_YEAR }, countries: COUNTRY_CODES.length, staging: L.staging,
        limits: {
          anonymous_per_minute: L.anonPerMin, key_per_minute: L.keyPerMin, free_calls_per_month: L.freePerMonth,
          pro_calls_per_month: L.proPerMonth, max_body_bytes: MAX_BODY_BYTES, max_batch_ops: MAX_BATCH_OPS, max_batch_calendars: MAX_BATCH_CALENDARS,
          max_batch_details: MAX_BATCH_DETAILS, max_add_days: MAX_ADD_DAYS, auth_failures_per_minute: L.authFailsPerMin,
          key_signups_per_minute_per_ip: MINT_PER_MIN, key_signups_per_day_per_ip: L.mintsPerIpPerDay,
          key_signups_per_day_per_ipv6_48: L.mintsPerNet48PerDay,
        },
        quota_store: env.QUOTA ? 'durable_object' : 'unavailable', free_key_signup: L.freeSignup, paid_plans: 'coming_soon',
      }, 200, { 'cache-control': 'no-store' });
    }
    if (path === '/v1/countries') return countriesEndpoint(env, L, ip);
    if (path === '/v1/key') return keyStatus(request, env, ctx, L, ip);
    if (path === '/v1/admin/signup-status' && method === 'GET') return adminRoute(request, env, ctx, L, ip, path);
    const fn = DATA_ROUTES[path];
    if (fn) return dataEndpoint(request, env, ctx, L, ip, url, path, fn);
  }

  if (method === 'POST') {
    if (path === '/v1/batch') return batchEndpoint(request, env, ctx, L, ip);
    if (path === '/v1/keys') return mintFreeKey(request, env, ctx, L, rawIp);
    if (path === '/v1/admin/keys' || path === '/v1/admin/keys/revoke') return adminRoute(request, env, ctx, L, ip, path);
  }

  if (DATA_ROUTES[path] || path === '/v1/countries' || path === '/v1/batch' || path === '/v1/keys') {
    return apiError(405, 'method_not_allowed', `Method ${method} is not allowed here.`, { allow: path === '/v1/batch' || path === '/v1/keys' ? 'POST, OPTIONS' : 'GET, OPTIONS' });
  }
  return apiError(404, 'not_found', 'No such endpoint. See /docs.');
}

async function countriesEndpoint(env, L, ip) {
  if (await limited(env.CALC_LIMITER, `ip:${ip}`, L.anonPerMin)) return apiError(429, 'rate_limited', 'Too many requests.', { 'retry-after': '60' });
  return json(countriesList(), 200, { 'cache-control': `public, max-age=${CACHE_SECONDS}` });
}

// ---------- shared with POST /mcp (recipe §1: one key gate, one set of limits, one cache) ----------
const bucketOf = (request) => ipBucket(request.headers.get('cf-connecting-ip') || 'unknown');
async function resInfo(res) {
  let e = {};
  try { e = (await res.clone().json()).error || {}; } catch { /* keep defaults */ }
  return { ok: false, status: res.status, code: e.code || 'error', message: e.message || 'Request failed.', headers: Object.fromEntries(res.headers) };
}
/**
 * Key gate for POST /mcp, evaluated once per HTTP request (every MCP method, incl. tools/list): no key → anonymous;
 * a malformed, unknown or revoked key → 401 invalid_api_key (or 429 too_many_auth_failures), with the same failure
 * limiter, negative cache and daily authfail pool as /v1/*. A not-yet-verified well-formed key costs one DO status
 * lookup (then cached as good for 10 min in this isolate). Per-minute and monthly counting stays in runData/gate.
 * Returns { ok:true, plan } | { ok:false, status, code, message, headers } and never echoes the key.
 */
export async function authenticate(request, env = {}, ctx = {}) {
  const L = config(env), ip = bucketOf(request);
  const raw = extractApiKey(request);
  if (!raw) return { ok: true, plan: 'anonymous' };
  const fail = async (opts) => resInfo((await authFailure(env, ctx, L, ip, opts)) || apiError(401, 'invalid_api_key', 'Unknown, revoked or malformed API key. Omit it for anonymous use, or get a free key via POST /v1/keys.'));
  const hash = isKeyFormat(raw) ? await hashApiKey(raw) : null;
  if (hash && memo(authState.good, hash)) return { ok: true, plan: 'key' };
  if (memo(authState.blocked, ip)) return resInfo(tooManyFailures());
  if (!hash || memo(authState.bad, hash)) return fail();
  if (!env.QUOTA) return resInfo(apiError(503, 'quota_unavailable', 'API key service is not configured.'));
  let limiterChecked = false;
  if (memo(authState.recentFail, ip)) {
    if (!budgetAllows('authfail', L).ok) return resInfo(apiError(503, 'daily_capacity_reached', 'API-key verification capacity for clients with recent failed attempts is used up for today. Retry in a minute.', { 'retry-after': '60' }));
    if (await limited(env.AUTH_LIMITER, `authfail:${ip}`, L.authFailsPerMin)) { remember(authState.blocked, ip, BLOCK_MS); return resInfo(tooManyFailures()); }
    limiterChecked = true;
  }
  let s;
  try {
    const r = await env.QUOTA.get(env.QUOTA.idFromName(keyDoName(L, hash))).fetch(`https://quota/status?month=${utcMonth()}`, { method: 'POST' });
    s = await r.json();
  } catch {
    return resInfo(apiError(503, 'quota_unavailable', 'Could not verify the API key right now. Please retry.', { 'retry-after': '5' }));
  }
  if (!s || !s.ok || s.status !== 'active') {
    remember(authState.bad, hash, BAD_TTL_MS);
    return fail({ lookup: true, limiterChecked });
  }
  remember(authState.good, hash, GOOD_TTL_MS);
  return { ok: true, plan: 'key' };
}
/** Normalize MCP tool args exactly like readParams() normalizes a query string. */
function normalizeParams(params) {
  const p = {};
  for (const k of CACHE_PARAMS) {
    const v = params[k];
    if (v == null) continue;
    const t = String(v).trim();
    p[k] = k === 'country' || k === 'region' ? t.toUpperCase() : t.toLowerCase();
  }
  return p;
}
/** The calendar data routes as a function: returns the exact Response GET <path> would (used by /mcp tools/call). */
export async function runData({ request, env = {}, ctx = {}, path, params }) {
  const fn = DATA_ROUTES[path];
  if (!fn) throw new Error(`unknown data route ${path}`);
  return dataCore(request, env, ctx, config(env), bucketOf(request), path, fn, () => normalizeParams(params));
}
export async function runCountries({ request, env = {} }) { return countriesEndpoint(env, config(env), bucketOf(request)); }

function dataEndpoint(request, env, ctx, L, ip, url, path, fn) {
  return dataCore(request, env, ctx, L, ip, path, fn, () => readParams(url));
}

async function dataCore(request, env, ctx, L, ip, path, fn, getParams) {
  const g = await gate(request, env, ctx, L, 1, ip);
  if (g.res) return g.res;
  let p;
  try { p = getParams(); } catch (e) { return apiError(e.status, e.code, e.message); } // not charged, not cached
  const cache = edgeCache();
  const ck = cacheKey(p, path, L);
  let cachedText = null;
  if (cache) {
    try { const hit = await cache.match(ck); if (hit) cachedText = await hit.text(); } catch { /* best effort */ }
  }
  let body = null;
  if (cachedText == null) {
    const r = runOp(fn, p);
    if (!r.ok) return apiError(r.status, r.code, r.message); // validation errors: not charged, not cached
    body = r.body;
  }
  const c = await g.charge();
  if (c.res) return c.res;
  const plan = c.plan || g.plan;
  const headers = {
    'content-type': 'application/json; charset=utf-8', ...CORS, ...SECURITY, 'x-workdayapi-version': VERSION, ...c.headers,
    'x-plan': plan, vary: 'Authorization, X-Api-Key',
    'cache-control': plan === 'anonymous' ? `public, max-age=${CACHE_SECONDS}` : `private, max-age=${CACHE_SECONDS}`,
    'x-cache': cachedText != null ? 'HIT' : cache ? 'MISS' : 'BYPASS',
  };
  const text = cachedText ?? JSON.stringify(body, null, 2);
  if (cache && cachedText == null) {
    const put = cache.put(ck, new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${EDGE_SECONDS}` } })).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
  }
  return new Response(text, { status: 200, headers });
}

/** Normalized calendar identity of a batch op (country|region|types|weekend), as used by the 10-calendar cap. */
export function batchCalendarKey(o) {
  if (!o || typeof o !== 'object') return '';
  const s = (v) => (v == null || typeof v === 'object' ? '' : String(v).trim());
  const cc = s(o.country).toUpperCase();
  let region = s(o.region).toUpperCase();
  if (region && !region.includes('-')) region = `${cc}-${region}`;
  const t = s(o.types).toLowerCase();
  const types = !t ? [...DEFAULT_TYPES].sort().join(',') : t === 'all' ? 'bank,public' : [...new Set(t.split(',').map((x) => x.trim()).filter((x) => x && x !== 'observance'))].sort().join(',');
  const w = s(o.weekend);
  const parsed = w ? parseWeekend(w) : (COUNTRIES[cc] && COUNTRIES[cc].weekend) || [6, 0];
  const wk = parsed ? [...new Set(parsed)].sort().join(',') : `raw:${w.toLowerCase()}`;
  return `${cc}|${region}|${types}|${wk}`;
}

async function batchEndpoint(request, env, ctx, L, ip) {
  const body = await readBodyCapped(request);
  if (body.tooLarge) return apiError(413, 'payload_too_large', `Request body exceeds ${MAX_BODY_BYTES} bytes (16 KB).`);
  if (!extractApiKey(request)) return apiError(401, 'api_key_required', 'POST /v1/batch requires a Pro API key (Authorization: Bearer wd_live_...).');
  let data;
  try { data = JSON.parse(body.text || ''); } catch { return apiError(400, 'invalid_json', 'Body must be JSON: {"ops":[{"op":"add",...}]}.'); }
  const ops = data && Array.isArray(data.ops) ? data.ops : null;
  if (!ops || !ops.length) return apiError(400, 'invalid_batch', 'Body must contain a non-empty "ops" array.');
  if (ops.length > MAX_BATCH_OPS) return apiError(422, 'too_many_ops', `A batch may contain at most ${MAX_BATCH_OPS} operations.`);
  const cals = new Set(ops.map(batchCalendarKey));
  if (cals.size > MAX_BATCH_CALENDARS) return apiError(422, 'too_many_calendars', `A batch may use at most ${MAX_BATCH_CALENDARS} distinct calendars (country + region + types + weekend; got ${cals.size}); split it into several batches.`);
  const details = ops.filter((o) => o && o.details === true).length;
  if (details > MAX_BATCH_DETAILS) return apiError(422, 'too_many_details', `At most ${MAX_BATCH_DETAILS} ops per batch may set "details": true (got ${details}).`);
  const g = await gate(request, env, ctx, L, ops.length, ip);
  if (g.res) return g.res;
  const c = await g.charge({ require: 'pro' });
  if (c.res) return c.res;
  const results = ops.map((o, i) => {
    if (!o || typeof o !== 'object' || !OPS[o.op]) return { index: i, ok: false, error: { code: 'invalid_op', message: 'op must be "add", "between" or "is-business-day".' } };
    const p = {};
    for (const [k, v] of Object.entries(o)) if (k !== 'op' && v != null && typeof v !== 'object') p[k] = String(v);
    // Bulk mode: per-day lists (between.holidays, add.skipped_holidays) are only built when the op asks for
    // "details": true; otherwise the op returns holidays_count / skipped_holidays_count (no list materialized).
    const r = runOp(OPS[o.op], p, { lists: o.details === true });
    if (!r.ok) return { index: i, ok: false, error: { code: r.code, message: r.message } };
    return { index: i, ok: true, result: r.body };
  });
  return json({ count: results.length, results }, 200, { ...c.headers, 'x-plan': c.plan }, true);
}

async function keyStatus(request, env, ctx, L, ip) {
  const raw = extractApiKey(request);
  if (!raw) return apiError(401, 'api_key_required', 'Send "Authorization: Bearer wd_live_...".');
  const k = await keyPrecheck(raw, env, ctx, L, ip, 0);
  if (k.res) return k.res;
  let s;
  try {
    const r = await env.QUOTA.get(env.QUOTA.idFromName(keyDoName(L, k.hash))).fetch(`https://quota/status?month=${utcMonth()}`, { method: 'POST' });
    s = await r.json();
  } catch {
    return apiError(503, 'quota_unavailable', 'Could not verify the API key right now. Please retry.', { 'retry-after': '5' });
  }
  if (!s.ok || s.status !== 'active') {
    authState.good.delete(k.hash);
    remember(authState.bad, k.hash, BAD_TTL_MS);
    return (await authFailure(env, ctx, L, ip, { lookup: true, limiterChecked: k.limiterChecked })) || apiError(401, 'invalid_api_key', 'Unknown or revoked API key.');
  }
  remember(authState.good, k.hash, GOOD_TTL_MS);
  const limit = s.plan === 'pro' ? L.proPerMonth : L.freePerMonth;
  return json({ plan: s.plan, status: s.status, month: s.month, used: s.used, limit, remaining: Math.max(0, limit - s.used) });
}

async function createKey(env, L, plan) {
  const key = generateApiKey();
  const hash = await hashApiKey(key);
  const r = await env.QUOTA.get(env.QUOTA.idFromName(keyDoName(L, hash))).fetch('https://quota/create', { method: 'POST', body: JSON.stringify({ plan }) });
  if (!r.ok) throw new Error('create failed');
  return key;
}

export const MINT_PER_MIN = 5;
const SIGNUP_DO_NAME = 'global:signup';
const mintDailyCapped = (net) => apiError(429, 'signup_limit_reached', net
  ? 'This IPv6 network (/48) has created the maximum number of free keys for today. Please retry tomorrow (UTC).'
  : 'This IP has created the maximum number of free keys for today. Please retry tomorrow (UTC).', { 'retry-after': String(secondsToUtcMidnight()) });

/** Expanded, normalized IPv6 hextets (no leading zeros), or null for IPv4 / IPv4-mapped / unparsable input. */
function ipv6Parts(s) {
  if (!s.includes(':') || s.includes('.')) return null;
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? null : (tail ? tail.split(':') : []);
  const parts = t === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return parts.map((x) => x.replace(/^0+(?=.)/, '') || '0');
}
/** Rate-limit bucket for an IP: IPv4 as is; IPv6 by /64 (one subscriber's prefix), so address rotation does not help. */
export function ipBucket(ip) {
  const s = String(ip || 'unknown').trim().toLowerCase();
  if (!s.includes(':')) return s;
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1); // IPv4-mapped (::ffff:a.b.c.d)
  return ipv6Parts(s).slice(0, 4).join(':') + '::/64';
}
/** Coarser IPv6 bucket (/48: a typical site / tunnel-broker / VPS allocation), or null for IPv4. */
export function ipNet48(ip) {
  const p = ipv6Parts(String(ip || '').trim().toLowerCase());
  return p ? p.slice(0, 3).join(':') + '::/48' : null;
}

/** One request to the shared signup counter DO. Bucket strings go in the body (never in a URL) and are hashed there. */
async function signupCounter(env, op, body) {
  const r = await env.QUOTA.get(env.QUOTA.idFromName(SIGNUP_DO_NAME)).fetch(`https://quota/mintip?op=${op}`, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`signup counter HTTP ${r.status}`); // e.g. 400 bad_request: an error, never a cap
  return r.json();
}
/** Only a reply that explicitly names a cap is a cap; anything else is treated as an outage. */
const SIGNUP_CAPS = new Set(['ip', 'net48']);

async function mintFreeKey(request, env, ctx, L, ip) {
  const body = await readBodyCapped(request);
  if (body.tooLarge) return apiError(413, 'payload_too_large', `Request body exceeds ${MAX_BODY_BYTES} bytes (16 KB).`);
  if (!L.freeSignup) return apiError(403, 'signup_closed', 'Self-serve API keys are not open yet. Join the waitlist on /docs.');
  if (!env.QUOTA) return apiError(503, 'quota_unavailable', 'API key service is not configured.');
  const bucket = ipBucket(ip), net48 = ipNet48(ip);
  if (memo(authState.mintCapped, bucket)) return mintDailyCapped(false);
  if (net48 && memo(authState.mintCapped, `n48:${net48}`)) return mintDailyCapped(true);
  // Dedicated MINT_LIMITER binding (5 per 60 s
  if (await limited(env.MINT_LIMITER, `mint:${bucket}`, MINT_PER_MIN)) return apiError(429, 'rate_limited', 'Too many key requests from this IP. Retry in a minute.', { 'retry-after': '60' });
  if (!budgetAllows('mint', L).ok) return apiError(503, 'daily_capacity_reached', 'Today’s new-key allowance is used up. Please retry tomorrow (UTC).', { 'retry-after': String(secondsToUtcMidnight()) });
  if (body.text && body.text.trim()) { try { JSON.parse(body.text); } catch { return apiError(400, 'invalid_json', 'Body must be JSON or empty.'); } }
  // Daily signup caps per IP (IPv6: per /64) and per IPv6 /48, counted exactly in ONE DO instance ("global:signup")
  // under HMAC-SHA-256 with a random per-day key that lives only in that DO. The DO reserves one signup; it is
  // refunded if the key cannot be created (nit). Fails closed with the DO.
  const req = { day: utcDay(), ip: bucket, net48, max: L.mintsPerIpPerDay, max48: L.mintsPerNet48PerDay };
  let d;
  try { d = await signupCounter(env, 'reserve', req); } catch {
    return apiError(503, 'quota_unavailable', 'API key service is unavailable right now. Please retry.', { 'retry-after': '5' });
  }
  if (!d || d.ok !== true) {
    if (!d || !SIGNUP_CAPS.has(d.cap)) return apiError(503, 'quota_unavailable', 'API key service is unavailable right now. Please retry.', { 'retry-after': '5' }); // not memoized
    const net = d.cap === 'net48';
    remember(authState.mintCapped, net ? `n48:${net48}` : bucket, Math.min(10 * 60_000, secondsToUtcMidnight() * 1000));
    return mintDailyCapped(net);
  }
  let key;
  try { key = await createKey(env, L, 'free'); } catch {
    try { await signupCounter(env, 'refund', req); } catch { /* best effort: at worst the client loses one signup today */ }
    return apiError(503, 'quota_unavailable', 'Could not create the API key right now. Please retry.', { 'retry-after': '5' });
  }
  budgetRecord('mint', env.QUOTA, ctx);
  return json({ api_key: key, plan: 'free', monthly_limit: L.freePerMonth, note: 'Store this key now: it is shown only once and cannot be recovered.' }, 201);
}

/** Operator-only routes. Enabled only when ADMIN_ENABLED="true" AND the ADMIN_TOKEN secret is set (staging only). */
async function adminRoute(request, env, ctx, L, ip, path) {
  if (!L.adminEnabled) return apiError(404, 'not_found', 'No such endpoint. See /docs.');
  if (memo(authState.blocked, ip)) return tooManyFailures();
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (!m || !safeEqual(m[1], env.ADMIN_TOKEN)) return (await authFailure(env, ctx, L, ip)) || apiError(401, 'unauthorized', 'Admin token required.');
  if (path === '/v1/admin/signup-status') {
    // Staging-only operator view of the signup counter DO: counts per day and the armed prune alarm.
    if (L.staging !== true || !env.QUOTA) return apiError(404, 'not_found', 'No such endpoint. See /docs.');
    try {
      const r = await env.QUOTA.get(env.QUOTA.idFromName(SIGNUP_DO_NAME)).fetch('https://quota/signupstatus', { method: 'POST' });
      if (!r.ok) throw new Error(String(r.status));
      return json(await r.json());
    } catch { return apiError(503, 'quota_unavailable', 'Signup counter unavailable.', { 'retry-after': '5' }); }
  }
  const body = await readBodyCapped(request);
  if (body.tooLarge) return apiError(413, 'payload_too_large', 'Request body too large.');
  let d = {};
  try { d = body.text ? JSON.parse(body.text) : {}; } catch { return apiError(400, 'invalid_json', 'Body must be JSON.'); }
  if (!d || typeof d !== 'object') d = {};
  if (!env.QUOTA) return apiError(503, 'quota_unavailable', 'API key service is not configured.');
  if (path === '/v1/admin/keys') {
    const plan = d.plan === 'pro' ? 'pro' : 'free';
    return json({ api_key: await createKey(env, L, plan), plan }, 201);
  }
  // Revoke by raw key or by its SHA-256 hash (hex). Takes effect immediately (every keyed call checks the DO).
  let hash = null;
  if (typeof d.api_key === 'string' && isKeyFormat(d.api_key)) hash = await hashApiKey(d.api_key);
  else if (typeof d.key_hash === 'string' && /^[a-f0-9]{64}$/.test(d.key_hash)) hash = d.key_hash;
  if (!hash) return apiError(400, 'invalid_request', 'Send {"api_key":"wd_live_..."} or {"key_hash":"<64 hex>"}.');
  const r = await env.QUOTA.get(env.QUOTA.idFromName(keyDoName(L, hash))).fetch('https://quota/revoke', { method: 'POST' });
  const q = await r.json();
  if (!q.ok) return apiError(404, 'unknown_key', 'No such key.');
  authState.good.delete(hash);
  return json({ revoked: true, plan: q.plan, previous_status: q.previous_status });
}
