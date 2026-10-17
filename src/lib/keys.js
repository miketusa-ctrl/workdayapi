// API keys: "wd_live_" + 64 hex. Only the SHA-256 hash is stored (as the Durable Object name).
export const KEY_PREFIX = 'wd_live_';
const KEY_RE = /^wd_live_[a-f0-9]{64}$/;

export function generateApiKey() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return KEY_PREFIX + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const isKeyFormat = (raw) => typeof raw === 'string' && KEY_RE.test(raw);

export async function hashApiKey(raw) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Authorization: Bearer <key> (X-Api-Key accepted too). Returns the raw string or null. */
export function extractApiKey(request) {
  const auth = request.headers.get('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(\S+)\s*$/i);
    return m ? m[1] : auth.trim();
  }
  const x = request.headers.get('x-api-key');
  return x ? x.trim() : null;
}

/** Constant-time string compare for the admin token. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
