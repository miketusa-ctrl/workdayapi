/**
 * Agent-discovery documents (since v0.2.0): /llms.txt (llmstxt.org format), /openapi.json (OpenAPI 3.1), the MCP
 * server card (/.well-known/mcp/server-card.json) and the MCP registry proof. Generated from code constants and
 * config(env), so limits / versions / URLs can't drift from what the Worker enforces (test/agent.test.js).
 */
import { VERSION } from '../version.js';
import { MAX_ADD_DAYS, MAX_YEAR, MIN_YEAR } from './calendar.js';
import { COUNTRY_CODES } from './countries.js';
import { PUBLIC_TOOLS, SERVER_INFO, SUPPORTED_VERSIONS, MAX_BODY_BYTES as MCP_MAX_BODY, MAX_BATCH, DISCOVERY_PER_MIN, MAX_LIST } from './mcp.js';

export const CONTACT_EMAIL = 'digitalpromohub.support@gmail.com';
const fmt = (n) => Number(n).toLocaleString('en-US');

export function mcpClientConfig(origin) {
  return { mcpServers: { workdayapi: { type: 'http', url: `${origin}/mcp` } } };
}

/** MCP registry HTTP-namespace proof: only a well-formed PUBLIC key record is ever served (else 404). */
export function registryAuthProof(env) {
  const proof = String((env && env.MCP_REGISTRY_AUTH) || '').trim();
  return /^v=MCPv1; k=(ed25519|ecdsap384); p=[A-Za-z0-9+/=]{20,120}$/.test(proof) ? proof : null;
}

export function llmsTxt(origin, L) {
  return `# WorkdayAPI

> Business-day and public-holiday math for ${COUNTRY_CODES.length} countries (${MIN_YEAR}-${MAX_YEAR}): add business days, count business days between dates, check a date, list holidays. Public JSON API plus a remote MCP server for AI agents.

Holiday rules are transcribed from each country's official sources (listed per country in /v1/countries and on the docs page). Weekends default to Saturday and Sunday and can be overridden per call. Results are not legal, payroll or financial advice.

## For AI agents

- [MCP server](${origin}/mcp): remote MCP over Streamable HTTP at \`${origin}/mcp\` (POST only, stateless, JSON responses, no sessions). Protocol versions: ${SUPPORTED_VERSIONS.join(', ')} (2026-07-28 per-request \`_meta\`; older versions use \`initialize\`). Tools: ${PUBLIC_TOOLS.map((t) => `\`${t.name}\``).join(', ')}. All read-only. Client config (most MCP clients accept this; some use a different format, for example VS Code uses a \`servers\` key): \`${JSON.stringify(mcpClientConfig(origin))}\`
- [OpenAPI 3.1 spec](${origin}/openapi.json): machine-readable description of the JSON API
- [JSON API docs](${origin}/docs): human-readable API reference with examples and per-country sources

## JSON API

- \`GET ${origin}/v1/holidays?country=DE&year=2027\` (optional \`region\`, \`types\`): holidays with local names, types and sources.
- \`GET ${origin}/v1/is-business-day?country=US&date=2027-07-05\`: business day or not, reason, previous/next business day.
- \`GET ${origin}/v1/add?country=GB&date=2027-12-23&days=3\` (|days| <= ${fmt(MAX_ADD_DAYS)}; negative counts back): result date and skipped holidays.
- \`GET ${origin}/v1/between?country=FR&from=2027-12-01&to=2027-12-31\` (optional \`inclusive=true\`): business, weekend and holiday day counts.
- Common optional params: \`region\` (e.g. DE-BY, US-CA), \`weekend\` (e.g. \`fri,sat\` or \`none\`), \`types\` (\`public\`, \`bank\`, \`all\`).
- \`GET ${origin}/v1/countries\`: supported countries, regions and sources. \`GET ${origin}/health\`: status and \`version\` (${VERSION}).
- \`POST ${origin}/v1/keys\` (empty or \`{}\` body): free API key, shown once. \`GET ${origin}/v1/key\` with your key: plan and monthly usage. \`POST ${origin}/v1/batch\`: Pro only (paid plans are coming soon).
- Errors: \`{ "error": { "code", "message" }, "docs": "/docs" }\` with HTTP 400 (\`missing_parameter\`, \`invalid_date\`, \`invalid_country\`, \`invalid_weekend\`, \`invalid_types\`, \`invalid_days\`, \`invalid_year\`, \`duplicate_parameter\`), 401 \`invalid_api_key\`, 404 \`unknown_country\`/\`unknown_region\`/\`not_found\`, 405, 422 (\`date_out_of_range\`, \`year_out_of_range\`, \`days_out_of_range\`, \`result_out_of_range\`), 429 (\`rate_limited\`, \`too_many_auth_failures\`, \`monthly_quota_exceeded\`; see \`Retry-After\`), 503 (\`daily_capacity_reached\`, \`quota_unavailable\`).

## Limits, keys and pricing

- Anonymous (no key): about ${L.anonPerMin} requests per minute per IP (IPv6: per /64), within a shared daily allowance.
- Free API key: about ${L.keyPerMin} requests per minute and ${fmt(L.freePerMonth)} calls per month. Send \`Authorization: Bearer wd_live_…\` or \`X-Api-Key: wd_live_…\`. Pro (${fmt(L.proPerMonth)} calls per month, batch endpoint) is coming soon; there is no paid plan to buy yet.
- The MCP endpoint uses the same keys and the same counters: each \`tools/call\` is one API call. \`initialize\`, \`tools/list\` and other non-call messages don't count as API calls, but are capped at about ${DISCOVERY_PER_MIN} per minute per IP (over it: HTTP 429 with \`Retry-After\`). Over an API limit, the tool result has \`isError: true\` with the reason and \`retryAfterSeconds\`. An invalid key returns HTTP 401.
- MCP request caps: ${fmt(MCP_MAX_BODY)}-byte body; JSON-RPC batches (legacy versions only) of at most ${MAX_BATCH} messages with at most one \`tools/call\`; per-day lists in tool results are cut to ${MAX_LIST} items (the JSON API returns them all).

## Optional

- [Homepage and calculator](${origin}/)
- Contact: ${CONTACT_EMAIL}
`;
}

/** SEP-1649-style server card (Smithery fallback). Generated from the same tools as tools/list. */
export function serverCard(origin) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    version: '1.0',
    protocolVersion: SUPPORTED_VERSIONS[0],
    serverInfo: SERVER_INFO,
    description: `Business-day and public-holiday math for ${COUNTRY_CODES.length} countries: add business days, days between, holidays.`,
    websiteUrl: `${origin}/`,
    transport: { type: 'streamable-http', url: `${origin}/mcp` },
    capabilities: { tools: { listChanged: false } },
    authentication: { required: false, schemes: ['bearer'] },
    tools: PUBLIC_TOOLS,
    resources: [],
    prompts: [],
  };
}

const errorSchema = { $ref: '#/components/schemas/Error' };
const json = (schema) => ({ 'application/json': { schema } });
const errResp = (description, extraHeaders) => ({ description, ...(extraHeaders ? { headers: extraHeaders } : {}), content: json(errorSchema) });
const retryAfter = { 'Retry-After': { description: 'Seconds to wait before retrying', schema: { type: 'integer' } } };
const allow = { Allow: { schema: { type: 'string' } } };
const mcpNotAllowed = (m) => ({
  tags: ['mcp'], operationId: `mcp_${m}_not_allowed`, summary: 'Not supported (stateless server: no SSE stream, no sessions)',
  responses: { 405: { description: 'Always 405 with `Allow: POST, OPTIONS` and a JSON-RPC error body', headers: { Allow: { schema: { type: 'string', const: 'POST, OPTIONS' } } }, content: json({ type: 'object' }) } },
});

export function openApiSpec(origin, L) {
  const dataHeaders = {
    'x-cache': { description: '`HIT`/`MISS` (edge cache) or `BYPASS`', schema: { type: 'string', enum: ['HIT', 'MISS', 'BYPASS'] } },
    'x-plan': { description: '`anonymous`, `free` or `pro`', schema: { type: 'string' } },
    'x-quota-limit': { description: 'Monthly calls for the key\'s plan (keyed calls only)', schema: { type: 'integer' } },
    'x-quota-used': { description: 'Calls used this month (keyed calls only)', schema: { type: 'integer' } },
    'x-quota-remaining': { description: 'Calls left this month (keyed calls only)', schema: { type: 'integer' } },
    'x-workdayapi-version': { description: 'Deployed version', schema: { type: 'string' } },
  };
  const q = (name, required, description, schema, example) => ({ name, in: 'query', required, description, schema, ...(example ? { example } : {}) });
  const country = q('country', true, 'ISO 3166-1 alpha-2 code', { type: 'string', pattern: '^[A-Za-z]{2}$', maxLength: 2 }, 'US');
  const region = q('region', false, 'Region code, e.g. DE-BY or US-CA', { type: 'string', maxLength: 10 });
  const weekend = q('weekend', false, 'Weekend days, e.g. sat,sun (default), fri,sat or none', { type: 'string', maxLength: 40 });
  const types = q('types', false, 'Comma list of public, bank, observance, or all', { type: 'string', maxLength: 40 });
  const date = (n, ex) => q(n, true, `YYYY-MM-DD, ${MIN_YEAR}-01-01..${MAX_YEAR}-12-31`, { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', maxLength: 10 }, ex);
  const sec = [{}, { apiKeyHeader: [] }, { bearerAuth: [] }];
  const dataResponses = (desc) => ({
    200: { description: desc, headers: dataHeaders, content: json({ type: 'object', additionalProperties: true }) },
    400: errResp('`missing_parameter`, `invalid_date`, `invalid_country`, `invalid_weekend`, `invalid_types`, `invalid_days`, `invalid_year` or `duplicate_parameter`'),
    401: errResp('`invalid_api_key`: a key was sent but is malformed, unknown or revoked'),
    404: errResp('`unknown_country` or `unknown_region`'),
    405: errResp('`method_not_allowed`', allow),
    422: errResp('`date_out_of_range`, `year_out_of_range`, `days_out_of_range` or `result_out_of_range`'),
    429: errResp('`rate_limited`, `too_many_auth_failures` or `monthly_quota_exceeded`', retryAfter),
    500: errResp('`internal_error`'),
    503: errResp('`daily_capacity_reached` or `quota_unavailable`', retryAfter),
  });
  const get = (operationId, summary, parameters, desc) => ({ get: { tags: ['calendar'], operationId, summary, security: sec, parameters, responses: dataResponses(desc) } });
  return {
    openapi: '3.1.0',
    info: {
      title: 'WorkdayAPI',
      version: VERSION,
      summary: `Business-day and public-holiday math for ${COUNTRY_CODES.length} countries.`,
      description: `JSON API behind ${origin}. No key needed for light use (about ${L.anonPerMin} requests/min per IP). A free API key (POST /v1/keys) allows about ${L.keyPerMin}/min and ${fmt(L.freePerMonth)} calls/month. There are no X-RateLimit-* headers; a 429 carries Retry-After. AI agents can also use the remote MCP server at ${origin}/mcp (see /llms.txt). Not legal, payroll or financial advice.`,
      contact: { name: 'WorkdayAPI', email: CONTACT_EMAIL, url: `${origin}/` },
    },
    servers: [{ url: origin }],
    externalDocs: { description: 'Human-readable API docs', url: `${origin}/docs` },
    tags: [{ name: 'calendar' }, { name: 'keys' }, { name: 'meta' }, { name: 'mcp' }],
    components: {
      securitySchemes: {
        apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key', description: 'Free key (`wd_live_` + 64 hex). Optional on calendar routes and /mcp.' },
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Same key as `Authorization: Bearer wd_live_…`.' },
      },
      schemas: {
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } }, docs: { type: 'string' } } },
        JsonRpcMessage: { type: 'object', required: ['jsonrpc'], properties: { jsonrpc: { const: '2.0' }, id: { type: ['string', 'integer'] }, method: { type: 'string' }, params: { type: 'object' } } },
      },
    },
    paths: {
      '/v1/holidays': get('getHolidays', 'Holidays for a country and year', [country, q('year', true, `${MIN_YEAR}-${MAX_YEAR}`, { type: 'string', pattern: '^\\d{4}$' }, '2027'), region, types], 'Holiday list'),
      '/v1/is-business-day': get('isBusinessDay', 'Is a date a business day?', [country, date('date', '2027-07-05'), region, weekend, types], 'Business-day check'),
      '/v1/add': get('addBusinessDays', 'Add or subtract business days', [country, date('date', '2027-12-23'), q('days', true, `Integer, |days| <= ${MAX_ADD_DAYS}`, { type: 'string', pattern: '^[+-]?\\d+$', maxLength: 6 }, '3'), region, weekend, types], 'Result date'),
      '/v1/between': get('businessDaysBetween', 'Business days between two dates', [country, date('from', '2027-12-01'), date('to', '2027-12-31'), q('inclusive', false, 'Count the end date (true/false)', { type: 'string', enum: ['true', 'false', '1', '0', 'yes', 'no'] }), region, weekend, types], 'Day counts'),
      '/v1/countries': {
        get: { tags: ['calendar'], operationId: 'listCountries', summary: 'Supported countries, regions and sources', security: [{}],
          responses: { 200: { description: 'Country list', content: json({ type: 'object', additionalProperties: true }) }, 405: errResp('`method_not_allowed`', allow), 429: errResp('`rate_limited`', retryAfter) } },
      },
      '/v1/batch': {
        post: { tags: ['calendar'], operationId: 'batch', summary: 'Many operations in one request (Pro only; paid plans coming soon)', security: [{ apiKeyHeader: [] }, { bearerAuth: [] }],
          requestBody: { required: true, content: json({ type: 'object', required: ['ops'], properties: { ops: { type: 'array', maxItems: 100, items: { type: 'object' } } } }) },
          responses: {
            200: { description: 'Per-op results', content: json({ type: 'object', additionalProperties: true }) },
            400: errResp('`invalid_json` or `invalid_batch`'), 401: errResp('`api_key_required` or `invalid_api_key`'), 403: errResp('`plan_required`'),
            405: errResp('`method_not_allowed`', allow), 413: errResp('`payload_too_large` (16 KB)'),
            422: errResp('`too_many_ops`, `too_many_calendars` or `too_many_details`'),
            429: errResp('`rate_limited`, `too_many_auth_failures` or `monthly_quota_exceeded`', retryAfter), 503: errResp('`daily_capacity_reached` or `quota_unavailable`', retryAfter),
          } },
      },
      '/v1/keys': {
        post: { tags: ['keys'], operationId: 'createKey', summary: 'Get a free API key (shown once)', security: [{}],
          requestBody: { required: false, content: json({ type: 'object' }) },
          responses: {
            201: { description: 'Key created', content: json({ type: 'object', properties: { api_key: { type: 'string', pattern: '^wd_live_[a-f0-9]{64}$' }, plan: { const: 'free' }, monthly_limit: { type: 'integer' }, note: { type: 'string' } } }) },
            400: errResp('`invalid_json`'), 403: errResp('`signup_closed`'), 405: errResp('`method_not_allowed`', allow), 413: errResp('`payload_too_large`'),
            429: errResp('`rate_limited` or `signup_limit_reached`', retryAfter), 503: errResp('`daily_capacity_reached` or `quota_unavailable`', retryAfter),
          } },
      },
      '/v1/key': {
        get: { tags: ['keys'], operationId: 'keyStatus', summary: 'Plan and monthly usage for your key', security: [{ apiKeyHeader: [] }, { bearerAuth: [] }],
          responses: {
            200: { description: 'Usage', content: json({ type: 'object', properties: { plan: { type: 'string' }, status: { type: 'string' }, month: { type: 'string' }, used: { type: 'integer' }, limit: { type: 'integer' }, remaining: { type: 'integer' } } }) },
            401: errResp('`api_key_required` or `invalid_api_key`'), 429: errResp('`rate_limited` or `too_many_auth_failures`', retryAfter), 503: errResp('`daily_capacity_reached` or `quota_unavailable`', retryAfter),
          } },
      },
      '/health': {
        get: { tags: ['meta'], operationId: 'health', summary: 'Service status, version and limits', security: [{}],
          responses: { 200: { description: 'OK', content: json({ type: 'object', required: ['status', 'service', 'version'], properties: { status: { const: 'ok' }, service: { const: 'workdayapi' }, version: { type: 'string', examples: [VERSION] } }, additionalProperties: true }) } } },
      },
      '/mcp': {
        post: {
          tags: ['mcp'], operationId: 'mcp', summary: 'Remote MCP server (Streamable HTTP, JSON-RPC 2.0)',
          description: `Model Context Protocol endpoint. Stateless, JSON responses only (no SSE, no Mcp-Session-Id). Supported protocol versions: ${SUPPORTED_VERSIONS.join(', ')}. Modern (2026-07-28) requests carry params._meta and the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers; legacy clients use initialize. Tools: ${PUBLIC_TOOLS.map((t) => t.name).join(', ')}. Same keys and limits as /v1/*; each tools/call counts as one API call. Body max ${MCP_MAX_BODY} bytes; legacy batches max ${MAX_BATCH} messages with at most one tools/call.`,
          security: sec,
          parameters: [
            { name: 'MCP-Protocol-Version', in: 'header', required: false, schema: { type: 'string', enum: SUPPORTED_VERSIONS } },
            { name: 'Mcp-Method', in: 'header', required: false, description: 'Required for 2026-07-28; must equal the body method', schema: { type: 'string' } },
            { name: 'Mcp-Name', in: 'header', required: false, description: 'Required for 2026-07-28 tools/call; must equal params.name', schema: { type: 'string' } },
          ],
          requestBody: { required: true, content: json({ oneOf: [{ $ref: '#/components/schemas/JsonRpcMessage' }, { type: 'array', maxItems: MAX_BATCH, items: { $ref: '#/components/schemas/JsonRpcMessage' } }] }) },
          responses: {
            200: { description: 'JSON-RPC response (or batch). Tool failures, including rate limits, are results with isError: true.', content: json({ type: ['object', 'array'] }) },
            202: { description: 'Notification(s) accepted; no body' },
            400: { description: 'Parse error (-32700), invalid request (-32600), header mismatch (-32020), unsupported protocol version (-32022) or missing _meta (-32602)', content: json({ type: 'object' }) },
            401: { description: 'Invalid API key (JSON-RPC error, data.code = invalid_api_key)', content: json({ type: 'object' }) },
            403: { description: 'Origin header present but not allowed', content: json({ type: 'object' }) },
            404: { description: 'Unknown method in a 2026-07-28 request (-32601)', content: json({ type: 'object' }) },
            413: { description: 'Body larger than the cap', content: json({ type: 'object' }) },
            429: { description: 'Too many non-call MCP messages from this IP, or too many failed key attempts', headers: retryAfter, content: json({ type: 'object' }) },
            500: errResp('Unexpected internal error (`internal_error`); per-message failures are JSON-RPC -32603 inside a 200 response instead'),
            503: { description: 'Key service unavailable (`quota_unavailable` / `daily_capacity_reached`)', headers: retryAfter, content: json({ type: 'object' }) },
          },
        },
        get: mcpNotAllowed('get'),
        delete: mcpNotAllowed('delete'),
      },
    },
  };
}
