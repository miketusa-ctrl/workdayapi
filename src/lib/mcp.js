/**
 * WorkdayAPI remote MCP server (since v0.2.0). Hand-rolled JSON-RPC 2.0 over Streamable HTTP; no SDK, no dependencies.
 * Adapted from CertGuard src/mcp.js (incl. commit c2606ed: modern tool errors keep _meta["workdayapi/error"]), itself
 * from DnsGuard src/lib/mcp.js (shared agent-ready recipe r2).
 *
 * Dual-era and stateless:
 *  - Modern (MCP 2026-07-28): every request carries params._meta["io.modelcontextprotocol/protocolVersion"] plus the
 *    MCP-Protocol-Version / Mcp-Method / Mcp-Name headers. Methods: server/discover, tools/list, tools/call.
 *  - Legacy (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05): initialize, notifications/initialized, ping,
 *    tools/list, tools/call. JSON-RPC batches (max 10 messages, at most one tools/call) for legacy clients.
 *  - No sessions, no SSE: GET/DELETE → 405; responses are application/json.
 *
 * Auth + limits are NOT implemented here: the router passes in authenticate(), runData() and runCountries() from
 * app.js, the exact code behind GET /v1/holidays, /v1/is-business-day, /v1/add, /v1/between and /v1/countries, so key
 * handling, the edge cache and every per-minute / daily / monthly counter are identical. One tools/call = one API
 * call (1 unit). initialize / tools/list / ping / server/discover never touch quota; they have a light per-isolate
 * cap per IP bucket (DISCOVERY_PER_MIN; IPv6 → its /64).
 */
import { VERSION } from '../version.js';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 10;
export const MAX_CHECKS_PER_REQUEST = 1; // bounds CPU per invocation and keeps 1 HTTP request ≈ 1 API call
export const DISCOVERY_PER_MIN = 120; // per IP bucket per isolate, for non-call messages (initialize, tools/list, ping, …)
export const MAX_LIST = 50; // per-day lists in structuredContent are sliced to this (full list: the JSON API)
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
const ERROR_META = 'workdayapi/error';
export const PASS_HEADERS = ['retry-after', 'x-cache', 'x-plan', 'x-quota-limit', 'x-quota-used', 'x-quota-remaining']; // what /v1/* sends

export const E = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  SERVER: -32000, HEADER_MISMATCH: -32020, UNSUPPORTED_VERSION: -32022,
};

export const MCP_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, x-api-key, mcp-protocol-version, mcp-method, mcp-name',
  'access-control-expose-headers': ['mcp-protocol-version', ...PASS_HEADERS].join(', '),
  'access-control-max-age': '86400',
};

export const SERVER_INFO = { name: 'workdayapi', title: 'WorkdayAPI', version: VERSION };
export const instructions = (L = { anonPerMin: 30, keyPerMin: 120, freePerMonth: 1000 }) => 'WorkdayAPI does business-day and public-holiday math for 29 countries (2020-2035): list holidays, check whether a date is a business day, add or subtract business days, and count business days between two dates. Countries are ISO 3166-1 alpha-2 codes (call list_countries for codes and regions such as DE-BY or US-CA); dates are YYYY-MM-DD. Weekends default to sat,sun and can be overridden (e.g. "fri,sat"). Holiday data is transcribed from official sources; it is not legal or payroll advice. Anonymous use is limited to about ' + L.anonPerMin + ' calls per minute per IP; send "Authorization: Bearer <key>" or "X-API-Key: <key>" with a free wd_live_ key (POST /v1/keys) for about ' + L.keyPerMin + ' per minute and ' + L.freePerMonth + ' calls per month. Each tools/call counts as one API call.';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const COUNTRY = S('ISO 3166-1 alpha-2 country code, e.g. US, DE, GB. See list_countries.', { pattern: '^[A-Za-z]{2}$', minLength: 2, maxLength: 2 });
const REGION = S('Optional region/state code for countries with regional holidays, e.g. DE-BY, US-CA (or just BY).', { maxLength: 10 });
const DATE = (d) => S(d, { pattern: '^\\d{4}-\\d{2}-\\d{2}$', maxLength: 10 });
const WEEKEND = S('Optional weekend days, comma list of day names like "sat,sun" (default) or "fri,sat", or "none".', { maxLength: 40 });
const TYPES = S('Optional holiday types that close business days: comma list of public, bank (default: public; "all" = public,bank).', { maxLength: 40 });
const holidaySchema = { type: 'object', properties: { date: { type: 'string' }, name: { type: 'string' }, local_name: { type: 'string' }, type: { type: 'string' } } };
const calProps = { country: { type: 'string' }, region: { type: 'string' }, weekend: { type: 'string' }, holiday_types: { type: 'array', items: { type: 'string' } } };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: 'get_holidays',
    title: 'List public holidays for a country and year',
    description: 'List the public (and optionally bank/observance) holidays for one country (and region) in one year, 2020-2035, with local names, types and official source links. Read-only. Same data, cache and limits as GET /v1/holidays.',
    inputSchema: { type: 'object', properties: {
      country: COUNTRY, year: { type: 'integer', minimum: 2020, maximum: 2035, description: 'Year, 2020-2035.' }, region: REGION,
      types: S('Optional comma list of public, bank, observance, or "all" (default: all).', { maxLength: 40 }),
    }, required: ['country', 'year'], additionalProperties: false },
    outputSchema: { type: 'object', properties: {
      country: { type: 'string' }, country_name: { type: 'string' }, region: { type: 'string' }, region_name: { type: 'string' }, year: { type: 'integer' },
      scope: { type: 'string' }, count: { type: 'integer' }, holidays: { type: 'array', items: holidaySchema }, notes: { type: 'string' },
      sources: { type: 'array', items: { type: 'string' } }, data_version: { type: 'string' },
    }, required: ['country', 'year', 'count', 'holidays'] },
    annotations: { title: 'Get holidays', ...RO },
    route: '/v1/holidays',
  },
  {
    name: 'is_business_day',
    title: 'Check whether a date is a business day',
    description: 'Check whether a date is a business day in a country (and region), considering weekends and public holidays. Returns the reason (weekend or holiday name) plus the previous and next business days. Read-only. Same engine, cache and limits as GET /v1/is-business-day.',
    inputSchema: { type: 'object', properties: { country: COUNTRY, date: DATE('Date to check, YYYY-MM-DD (2020-2035).'), region: REGION, weekend: WEEKEND, types: TYPES }, required: ['country', 'date'], additionalProperties: false },
    outputSchema: { type: 'object', properties: {
      date: { type: 'string' }, weekday: { type: 'string' }, ...calProps, business_day: { type: 'boolean' }, reason: { type: 'string' },
      holiday: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, actual_date: { type: 'string' }, predicted: { type: 'boolean' } } },
      previous_business_day: { type: 'string' }, next_business_day: { type: 'string' },
    }, required: ['date', 'business_day', 'reason'] },
    annotations: { title: 'Is business day', ...RO },
    route: '/v1/is-business-day',
  },
  {
    name: 'add_business_days',
    title: 'Add or subtract business days from a date',
    description: 'Add (or, with a negative number, subtract) business days to a date, skipping weekends and public holidays of the country (and region). Returns the result date and the holidays skipped. Read-only. Same engine, cache and limits as GET /v1/add.',
    inputSchema: { type: 'object', properties: {
      country: COUNTRY, date: DATE('Start date, YYYY-MM-DD (2020-2035).'),
      days: { type: 'integer', minimum: -2500, maximum: 2500, description: 'Business days to add; negative counts backwards.' },
      region: REGION, weekend: WEEKEND, types: TYPES,
    }, required: ['country', 'date', 'days'], additionalProperties: false },
    outputSchema: { type: 'object', properties: {
      date: { type: 'string' }, days: { type: 'integer' }, ...calProps, result: { type: 'string' }, result_weekday: { type: 'string' },
      calendar_days: { type: 'integer' }, skipped_holidays: { type: 'array', items: holidaySchema }, skipped_holidays_truncated: { type: 'boolean' },
    }, required: ['date', 'days', 'result'] },
    annotations: { title: 'Add business days', ...RO },
    route: '/v1/add',
  },
  {
    name: 'business_days_between',
    title: 'Count business days between two dates',
    description: 'Count business days between two dates in a country (and region), excluding weekends and public holidays. The end date is excluded unless inclusive is true. Returns business, weekend and holiday day counts and the holidays in the range. Read-only. Same engine, cache and limits as GET /v1/between.',
    inputSchema: { type: 'object', properties: {
      country: COUNTRY, from: DATE('Start date, YYYY-MM-DD (2020-2035).'), to: DATE('End date, YYYY-MM-DD (2020-2035).'),
      inclusive: { type: 'boolean', default: false, description: 'Count the end date too (default false).' },
      region: REGION, weekend: WEEKEND, types: TYPES,
    }, required: ['country', 'from', 'to'], additionalProperties: false },
    outputSchema: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }, inclusive: { type: 'boolean' }, ...calProps,
      business_days: { type: 'integer' }, calendar_days: { type: 'integer' }, weekend_days: { type: 'integer' }, holiday_days: { type: 'integer' },
      holidays: { type: 'array', items: holidaySchema }, holidays_truncated: { type: 'boolean' },
    }, required: ['from', 'to', 'business_days'] },
    annotations: { title: 'Business days between', ...RO },
    route: '/v1/between',
  },
  {
    name: 'list_countries',
    title: 'List supported countries and regions',
    description: 'List the supported countries (ISO codes), their regions and the supported year range. Read-only. Same data and limits as GET /v1/countries.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: {
      count: { type: 'integer' }, years: { type: 'object', properties: { from: { type: 'integer' }, to: { type: 'integer' } } }, data_version: { type: 'string' },
      countries: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' }, regions: { type: 'array', items: { type: 'string' } } } } },
    }, required: ['count', 'countries'] },
    annotations: { title: 'List countries', ...RO },
  },
];
const ROUTE = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
/** tools/list payload: MCP fields only (`route` is internal). */
export const PUBLIC_TOOLS = TOOLS.map(({ route, ...t }) => t);

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Recursively drop null/undefined so structuredContent never carries a null where the outputSchema expects a type. */
const compact = (v) => {
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== null).map(([k, x]) => [k, compact(x)]));
  return v;
};
const slice = (out, key) => {
  if (Array.isArray(out[key]) && out[key].length > MAX_LIST) { out[key] = out[key].slice(0, MAX_LIST); out[`${key}_truncated`] = true; }
};

/** Human/LLM-readable text for a successful call (content[0]). */
export function summaryText(name, b) {
  const where = `${b.country || ''}${b.region ? ` (${b.region})` : ''}`;
  const hl = (h) => `${h.date} ${h.name}${h.type && h.type !== 'public' ? ` [${h.type}]` : ''}`;
  if (name === 'get_holidays') return [`${b.count} holidays for ${b.country_name || b.country}${b.region ? ` (${b.region_name || b.region})` : ''} in ${b.year}:`, ...b.holidays.map((h) => `- ${hl(h)}`)].join('\n');
  if (name === 'is_business_day') return `${b.date} (${b.weekday}) in ${where} is ${b.business_day ? 'a business day' : `not a business day: ${b.holiday ? b.holiday.name : b.reason}`}. Previous business day: ${b.previous_business_day ?? 'n/a'}; next: ${b.next_business_day ?? 'n/a'}.`;
  if (name === 'add_business_days') return `${b.date} ${b.days >= 0 ? '+' : ''}${b.days} business days in ${where} = ${b.result} (${b.result_weekday}), ${b.calendar_days} calendar days.${(b.skipped_holidays || []).length ? ` Holidays skipped: ${b.skipped_holidays.map(hl).join('; ')}${b.skipped_holidays_truncated ? '; …' : ''}.` : ''}`;
  if (name === 'business_days_between') return `${b.business_days} business days in ${where} from ${b.from} to ${b.to}${b.inclusive ? ' (inclusive)' : ' (end date excluded)'}; ${b.weekend_days} weekend days, ${b.holiday_days} holiday days.`;
  return `${b.count} countries (years ${b.years.from}-${b.years.to}): ${b.countries.map((c) => c.code).join(', ')}.`;
}

function toolError(message, data, extra = {}) {
  return { content: [{ type: 'text', text: message }], isError: true, ...(data ? { _meta: { [ERROR_META]: data } } : {}), ...extra };
}

/** Validate tool arguments against the inputSchema; returns { code, msg } or null. Own-property checks only. */
function checkArgs(tool, args) {
  const props = tool.inputSchema.properties;
  const unknown = Object.keys(args).filter((k) => !Object.prototype.hasOwnProperty.call(props, k));
  if (unknown.length) return { code: 'invalid_arguments', msg: `Unknown argument(s): ${clip(unknown.slice(0, 5).join(', '), 80)}. Allowed: ${Object.keys(props).join(', ') || '(none)'}.` };
  for (const k of tool.inputSchema.required || []) if (args[k] === undefined || args[k] === null) return { code: 'missing_parameter', msg: `Missing required argument "${k}".` };
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    const s = props[k];
    if (s.type === 'string' && (typeof v !== 'string' || v.length > s.maxLength)) return { code: 'invalid_arguments', msg: `"${k}" must be a string of at most ${s.maxLength} characters.` };
    if (s.type === 'integer' && !Number.isInteger(v)) return { code: 'invalid_arguments', msg: `"${k}" must be an integer.` };
    if (s.type === 'boolean' && typeof v !== 'boolean') return { code: 'invalid_arguments', msg: `"${k}" must be true or false.` };
  }
  return null;
}

/** tools/call. Returns { result } or { error } (protocol error), plus HTTP headers to surface. */
async function callTool(params, deps) {
  const { name } = params;
  const args = params.arguments === undefined ? {} : params.arguments;
  const tool = typeof name === 'string' && Object.prototype.hasOwnProperty.call(ROUTE, name) ? ROUTE[name] : null;
  if (!tool) return { error: { code: E.INVALID_PARAMS, message: `Unknown tool: ${clip(String(name), 80)}` } };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: { code: E.INVALID_PARAMS, message: 'arguments must be an object' } };
  // Input problems are tool-execution errors (isError) so the model can correct itself; no limiter/DO/cache touched.
  const bad = checkArgs(tool, args);
  if (bad) return { result: toolError(bad.msg, { code: bad.code, httpStatus: 400 }) };
  const p = {};
  for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) p[k] = String(v);
  // Same function as the REST route (gate → params → cache → op → charge); returns that route's exact Response.
  const res = tool.route
    ? await deps.runData({ request: deps.request, env: deps.env, ctx: deps.ctx, path: tool.route, params: p })
    : await deps.runCountries({ request: deps.request, env: deps.env });
  const headers = Object.fromEntries(res.headers);
  let body;
  try { body = JSON.parse(await res.text()); } catch { body = {}; }
  if (res.status !== 200) {
    const retry = headers['retry-after'] ? Number(headers['retry-after']) : undefined;
    const e = (body && body.error) || {};
    const msg = clip(String(e.message || 'The call could not be completed.'), 600) + (retry ? ` (retry after ${retry} seconds)` : '');
    return { result: toolError(msg, compact({ code: String(e.code || 'error'), httpStatus: res.status, retryAfterSeconds: retry })), headers };
  }
  let out;
  if (!tool.route) {
    out = { count: body.count, years: body.years, data_version: body.data_version, countries: body.countries.map((c) => ({ code: c.code, name: c.name, regions: c.regions.map((r) => r.code) })) };
  } else {
    out = compact(body);
    slice(out, 'holidays');
    slice(out, 'skipped_holidays');
  }
  return { result: { content: [{ type: 'text', text: clip(summaryText(name, out), 4000) }], structuredContent: out, isError: false }, headers };
}

// ---------- transport helpers ----------

/** Origin policy: absent = OK (CLI / server-side clients). Present: must be a bare https origin or an http loopback
 * origin, or (if MCP_ALLOWED_ORIGINS is set) same-origin / listed. Malformed, "null" and plain-http remote → 403. */
export function originAllowed(origin, selfOrigin, allowList) {
  if (origin === null || origin === undefined) return true;
  if (origin === selfOrigin) return true;
  if (allowList) return String(allowList).split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

async function readCapped(request, cap) {
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > cap) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function decodeHeaderValue(v) {
  if (v == null) return v;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0))); } catch { return null; }
}

const isId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * Handle one JSON-RPC message. Returns { response?, status?, headers?, isCheck? }.
 * `response` undefined = notification accepted (202 when it's the whole request).
 */
async function handleMessage(msg, { modern, request, deps, auth, checkBudget }) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request'), status: 400 };
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (msg.jsonrpc !== '2.0') return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"'), status: 400 };
  if (typeof msg.method !== 'string') {
    // A JSON-RPC response or garbage. Legacy clients may POST responses → accept like a notification.
    if (!modern && hasId && ('result' in msg || 'error' in msg)) return {};
    return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: method is required'), status: 400 };
  }
  if (!hasId) return {}; // notification (notifications/initialized, cancelled, …): accepted, nothing to do
  if (!isId(msg.id)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request: id must be a string or number'), status: 400 };
  const { id, method } = msg;
  const params = msg.params === undefined ? {} : msg.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { response: rpcError(id, E.INVALID_PARAMS, 'params must be an object') };

  // Modern results carry serverInfo in _meta; merge so a tool error's _meta["workdayapi/error"] is kept.
  const done = (result) => ({ response: rpcResult(id, modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), [META_SERVER]: SERVER_INFO } } : result) });
  const notFound = () => ({ response: rpcError(id, E.METHOD_NOT_FOUND, `Method not found: ${clip(method, 80)}`), status: modern ? 404 : 200 });
  const instr = instructions(deps.limits);

  if (modern) {
    // MCP 2026-07-28 per-request validation (version, capabilities, mirrored headers).
    const hName = decodeHeaderValue(request.headers.get('mcp-name'));
    if (request.headers.get('mcp-method') !== method) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is missing or does not match the body method'), status: 400 };
    if (!params._meta || typeof params._meta[META_CAPS] !== 'object' || params._meta[META_CAPS] === null) {
      return { response: rpcError(id, E.INVALID_PARAMS, `Missing required _meta field ${META_CAPS}`), status: 400 };
    }
    if (method === 'tools/call' && hName !== params.name) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is missing or does not match params.name'), status: 400 };
    if (method === 'server/discover') {
      return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, instructions: instr, ttlMs: 3_600_000, cacheScope: 'public' });
    }
    if (method === 'tools/list') return done({ tools: PUBLIC_TOOLS, ttlMs: 3_600_000, cacheScope: 'public' });
    if (method !== 'tools/call') return notFound(); // includes initialize and ping (removed in 2026-07-28)
  } else {
    if (method === 'initialize') {
      const req = params.protocolVersion;
      const protocolVersion = LEGACY_VERSIONS.includes(req) ? req : LEGACY_VERSIONS[0];
      return done({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instr });
    }
    if (method === 'ping') return done({});
    if (method === 'tools/list') return done({ tools: PUBLIC_TOOLS });
    if (method === 'server/discover') return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instr });
    if (method !== 'tools/call') return notFound();
  }

  // tools/call
  if (typeof params.name !== 'string') return { response: rpcError(id, E.INVALID_PARAMS, 'params.name (tool name) is required') };
  if (checkBudget.used >= MAX_CHECKS_PER_REQUEST) {
    return { response: rpcError(id, E.INVALID_REQUEST, `At most ${MAX_CHECKS_PER_REQUEST} tools/call per HTTP request; send each call as its own request.`) };
  }
  checkBudget.used++;
  const r = await callTool(params, { ...deps, request });
  if (r.error) return { response: rpcError(id, r.error.code, r.error.message), isCheck: true };
  return { ...done(r.result), headers: r.headers, isCheck: true };
}

/** Entry point from the router for every request to /mcp. */
export async function handleMcp(request, env, ctx, deps) {
  const base = { ...MCP_CORS, ...deps.security };
  const reply = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { 'content-type': 'application/json; charset=utf-8' }), 'cache-control': 'no-store', ...base, ...extra },
  });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...MCP_CORS, ...deps.security } });
  if (!originAllowed(request.headers.get('origin'), deps.origin, deps.allowedOrigins)) {
    return reply(403, rpcError(undefined, E.SERVER, 'Forbidden: Origin not allowed'));
  }
  if (request.method !== 'POST') {
    return reply(405, rpcError(undefined, E.SERVER, 'Method not allowed. This MCP endpoint is stateless: POST JSON-RPC messages (no SSE stream, no sessions). Docs: /llms.txt'), { allow: 'POST, OPTIONS' });
  }
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, rpcError(undefined, E.INVALID_REQUEST, `Request body too large (max ${MAX_BODY_BYTES} bytes)`));
  let payload;
  try { payload = JSON.parse(text); } catch { return reply(400, rpcError(null, E.PARSE, 'Parse error: body must be valid JSON')); }

  // Era detection. Modern = per-request _meta version or a modern MCP-Protocol-Version header.
  const hVer = request.headers.get('mcp-protocol-version');
  const single = !Array.isArray(payload);
  const metaVer = single && payload && typeof payload === 'object' && payload.params && typeof payload.params === 'object'
    && payload.params._meta && typeof payload.params._meta === 'object' ? payload.params._meta[META_VERSION] : undefined;
  const modern = metaVer !== undefined || MODERN_VERSIONS.includes(hVer);
  const idOf = (p) => (p && typeof p === 'object' && isId(p.id) ? p.id : null);
  if (modern) {
    if (!single) return reply(400, rpcError(null, E.INVALID_REQUEST, 'JSON-RPC batches are not supported in protocol 2026-07-28; send one message per POST'));
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'id')) {
      if (metaVer === undefined && typeof payload.method === 'string') {
        return reply(400, rpcError(idOf(payload), E.INVALID_PARAMS, `Missing required _meta field ${META_VERSION}`));
      }
      if (metaVer !== undefined && !SUPPORTED_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(String(metaVer), 40) }));
      }
      if (metaVer !== undefined && !MODERN_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, `Protocol version ${metaVer} uses the initialize handshake; per-request _meta requires one of: ${MODERN_VERSIONS.join(', ')}`, { supported: SUPPORTED_VERSIONS, requested: metaVer }));
      }
      if (hVer !== metaVer) return reply(400, rpcError(idOf(payload), E.HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is missing or does not match _meta protocolVersion'));
    }
  } else if (hVer && !LEGACY_VERSIONS.includes(hVer)) {
    return reply(400, rpcError(single ? idOf(payload) : null, E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(hVer, 40) }));
  }

  const msgs = single ? [payload] : payload;
  if (!msgs.length) return reply(400, rpcError(null, E.INVALID_REQUEST, 'Invalid Request: empty batch'));
  if (msgs.length > MAX_BATCH) return reply(400, rpcError(null, E.INVALID_REQUEST, `Batch too large (max ${MAX_BATCH} messages)`));

  // Light per-IP-bucket cap on non-check messages (calls are governed by the /v1/* limits inside runData).
  const nonCheck = msgs.filter((m) => !(m && m.method === 'tools/call')).length;
  for (let i = 0; i < nonCheck; i++) {
    if (!deps.memLimit(`mcp:${deps.ipBucket}`, DISCOVERY_PER_MIN, 60_000)) {
      return reply(429, rpcError(single ? idOf(payload) : null, E.SERVER, `Too many MCP requests from your IP (about ${DISCOVERY_PER_MIN} per minute). Retry in a minute.`, { code: 'rate_limited', retryAfterSeconds: 60 }), { 'retry-after': '60' });
    }
  }

  // Same key gate as /v1/*, evaluated once per HTTP request (bad key → 401 for every method).
  const auth = await deps.authenticate(request, env, ctx);
  if (!auth.ok) {
    // No WWW-Authenticate on /mcp: MCP clients treat a 401 Bearer challenge as "start OAuth discovery", which this
    // server doesn't offer; the JSON-RPC error body (data.code = invalid_api_key) is the useful signal.
    return reply(auth.status, rpcError(single ? idOf(payload) : null, E.SERVER, auth.message, { code: auth.code, httpStatus: auth.status }), { ...(auth.headers || {}) });
  }

  const mdeps = { ...deps, env, ctx };
  const checkBudget = { used: 0 };
  const responses = [];
  let status = 200;
  let headers = {};
  for (const m of msgs) {
    let out;
    try {
      out = await handleMessage(m, { modern, request, deps: mdeps, auth, checkBudget });
    } catch {
      out = { response: rpcError(idOf(m), E.INTERNAL, 'Internal error') };
    }
    if (out.response) responses.push(out.response);
    if (single) status = out.status || 200;
    if (out.headers) headers = out.headers; // the (single) tools/call's /api headers, for batches too
  }
  if (!responses.length) return reply(202, null);
  const exposed = {};
  for (const h of PASS_HEADERS) if (headers[h]) exposed[h] = headers[h];
  return reply(status, single ? responses[0] : responses, exposed);
}
