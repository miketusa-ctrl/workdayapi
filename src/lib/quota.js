// WorkdayQuota: SQLite-backed Durable Object (same pattern as dnsguard's KeyQuota). One instance per API key
// ("key:<sha256>", or "key<EPOCH>:<sha256>" when KEY_EPOCH != 1) holds the key record and its monthly usage counter.
// One shared instance ("global:budget") holds the approximate daily request pools (see budget.js). One shared
// instance ("global:signup") counts free-key signups per client per UTC day: per IP bucket (IPv4, or IPv6 /64) and
// per IPv6 /48. Counter names are HMAC-SHA-256(dayKey, bucket) truncated to 128 bits, where dayKey is 256 random
// bits generated inside this instance for each UTC day (stored as "s:<day>"). Raw IPs and buckets arrive only in the
// request body and are never stored. Counters AND day keys of UTC day D are deleted at 00:00 UTC on day D+2 at the
// latest, by a Durable Object alarm: every granted signup makes sure an alarm is armed for the next 00:00 UTC, and
// the alarm re-arms daily while any signup data remains (pruning also runs on the first signup of a new day). Once a
// day key is gone, that day's counter names can no longer be linked to an IP by anyone. While a day key exists,
// someone able to read this instance's storage could test candidate IPs against it (the key sits next to the
// counters), so this is pseudonymous storage with a 2-day lifetime, not anonymization. Other stored data: plan,
// status, creation date and usage counters. No labels, no request contents (the API key itself is never stored; key
// instances are named by its SHA-256 hash).

export const POOL_FIELDS = ['calls', 'anon', 'mints', 'authfail'];
export const MONTHS_KEPT = 3;

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
export const utcMonth = (d = new Date()) => d.toISOString().slice(0, 7);

const j = (body, status = 200) => Response.json(body, { status });
/** Strict decimal parse (v0.2.0): absent → default; anything but /^\d+$/ ("1e3", "0x10", " 5", "-1", "1.0") → NaN. */
export const digits = (v, d) => (v == null || v === '' ? d : /^\d+$/.test(v) && v.length <= 9 ? Number(v) : NaN);

export class WorkdayQuota {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (request.method !== 'POST') return j({ error: 'not_found' }, 404);
    if (p === '/create') {
      const body = await request.json().catch(() => null);
      if (!body || !/^(free|pro)$/.test(body.plan || '')) return j({ error: 'bad_request' }, 400);
      if (await this.storage.get('key')) return j({ error: 'exists' }, 409);
      const rec = { plan: body.plan, created: new Date().toISOString().slice(0, 10), status: 'active' };
      await this.storage.put('key', rec);
      return j({ ok: true, ...rec });
    }
    if (p === '/consume') {
      const month = url.searchParams.get('month') || utcMonth();
      const units = digits(url.searchParams.get('units'), 1);
      const limits = { free: digits(url.searchParams.get('free'), 1000), pro: digits(url.searchParams.get('pro'), 50000) };
      if (!/^\d{4}-\d{2}$/.test(month) || !Number.isInteger(units) || units < 1 || units > 1000) return j({ error: 'bad_request' }, 400);
      return j(await this.consume(month, units, limits, url.searchParams.get('require')));
    }
    if (p === '/revoke') {
      const rec = await this.storage.get('key');
      if (!rec) return j({ ok: false, reason: 'unknown_key' });
      const previous = rec.status;
      if (rec.status !== 'revoked') await this.storage.put('key', { ...rec, status: 'revoked', revoked: new Date().toISOString().slice(0, 10) });
      return j({ ok: true, plan: rec.plan, previous_status: previous, status: 'revoked' });
    }
    if (p === '/status') {
      const rec = await this.storage.get('key');
      if (!rec) return j({ ok: false, reason: 'unknown_key' });
      const month = url.searchParams.get('month') || utcMonth();
      return j({ ok: true, plan: rec.plan, status: rec.status, used: (await this.storage.get(`m:${month}`)) || 0, month });
    }
    if (p === '/add') {
      const day = url.searchParams.get('day') || utcDay();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return j({ error: 'bad_request' }, 400);
      const inc = {};
      for (const f of POOL_FIELDS) {
        const n = digits(url.searchParams.get(f), 0);
        if (!Number.isInteger(n) || n < 0 || n > 100000) return j({ error: 'bad_request' }, 400);
        inc[f] = n;
      }
      return j(await this.add(day, inc));
    }
    if (p === '/signupstatus') return j(await this.signupStatus()); // staging-only admin view (v0.2.0); counts only, no hashes
    if (p === '/mintip') {
      const op = url.searchParams.get('op') || 'reserve';
      const b = await request.json().catch(() => null);
      const okBucket = (x) => typeof x === 'string' && /^[0-9a-f:./]{1,64}$/.test(x);
      const intIn = (x) => Number.isInteger(x) && x >= 1 && x <= 100000;
      if (!b || !/^(reserve|refund)$/.test(op) || !/^\d{4}-\d{2}-\d{2}$/.test(b.day || '') || !okBucket(b.ip) || !(b.net48 == null || okBucket(b.net48)) || !intIn(b.max) || !intIn(b.max48 ?? 1)) return j({ error: 'bad_request' }, 400);
      return j(op === 'refund' ? await this.mintRefund(b) : await this.mintReserve(b));
    }
    return j({ error: 'not_found' }, 404);
  }

  /** HMAC-SHA-256 under this day's random key (created on first use of the day), hex, truncated to 128 bits. */
  async dayHash(day, label) {
    let k = await this.storage.get(`s:${day}`);
    if (!k) {
      k = [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, '0')).join('');
      await this.storage.put(`s:${day}`, k);
      await this.pruneSignup(day);
    }
    const raw = new Uint8Array(k.match(/../g).map((x) => parseInt(x, 16)));
    const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(label)));
    return [...sig.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  /** Keep today + yesterday only: counters ("i:" per IP bucket, "n:" per /48), day keys ("s:"), rc2 leftovers. */
  async pruneSignup(day) {
    const y = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    if ((await this.storage.get('i_day')) != null) await this.storage.delete('i_day'); // v0.1.1 marker, unused now
    for (const prefix of ['i:', 'n:', 's:']) {
      const old = [...(await this.storage.list({ prefix })).keys()].filter((x) => x.slice(2, 12) < y);
      for (let i = 0; i < old.length; i += 128) await this.storage.delete(old.slice(i, i + 128));
    }
  }

  /** Ensure an alarm at the next 00:00 UTC (+5 s) after `day`, so pruning happens even without signups. */
  async armSignupAlarm(day) {
    if (typeof this.storage.setAlarm !== 'function') return;
    const next = Date.parse(`${day}T00:00:00Z`) + 86400000 + 5000;
    const cur = typeof this.storage.getAlarm === 'function' ? await this.storage.getAlarm() : null;
    if (cur == null || cur > next || cur < Date.now()) await this.storage.setAlarm(next);
  }

  /** Daily alarm (only the "global:signup" instance arms one): prune, then re-arm while signup data remains. */
  async alarm() { return this.pruneAt(utcDay()); }

  /** Alarm body for a given UTC day (separate so tests can drive the calendar). */
  // Only after a successful prune that left no signup data is the alarm cleared.
  async pruneAt(today) {
    if (typeof this.storage.setAlarm === 'function') await this.storage.setAlarm(Date.parse(`${today}T00:00:00Z`) + 86400000 + 5000);
    await this.pruneSignup(today);
    if ((await this.signupLeft()) === 0 && typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();
  }

  async signupLeft() {
    let left = 0;
    for (const prefix of ['i:', 'n:', 's:']) left += (await this.storage.list({ prefix, limit: 1 })).size;
    return left;
  }

  /** Counts per prefix and day, plus the armed alarm (ISO or null). Never returns hashed buckets or day keys. */
  async signupStatus() {
    const counts = {};
    for (const prefix of ['i:', 'n:', 's:']) {
      for (const k of (await this.storage.list({ prefix })).keys()) {
        const day = k.slice(2, 12);
        counts[day] = counts[day] || { ip_buckets: 0, net48_buckets: 0, day_key: false };
        if (prefix === 'i:') counts[day].ip_buckets++; else if (prefix === 'n:') counts[day].net48_buckets++; else counts[day].day_key = true;
      }
    }
    const a = typeof this.storage.getAlarm === 'function' ? await this.storage.getAlarm() : null;
    return { ok: true, today: utcDay(), alarm: a == null ? null : new Date(a).toISOString(), days: counts };
  }

  /** Reserve one signup for this IP bucket (and its IPv6 /48). Denied attempts write no counter. */
  async mintReserve({ day, ip, net48, max, max48 }) {
    const ki = `i:${day}:${await this.dayHash(day, `ip|${ip}`)}`;
    const kn = net48 ? `n:${day}:${await this.dayHash(day, `n48|${net48}`)}` : null;
    const used = (await this.storage.get(ki)) || 0;
    if (used >= max) return { ok: false, cap: 'ip', used, max };
    const usedNet = kn ? (await this.storage.get(kn)) || 0 : 0;
    if (kn && usedNet >= max48) return { ok: false, cap: 'net48', used: usedNet, max: max48 };
    await this.storage.put(ki, used + 1);
    if (kn) await this.storage.put(kn, usedNet + 1);
    await this.armSignupAlarm(day); // every granted signup (cheap getAlarm): also covers data written before v0.1.2-rc2
    return { ok: true, used: used + 1, max, ...(kn ? { used48: usedNet + 1, max48 } : {}) };
  }

  /** Give back a reservation whose key could not be created. */
  async mintRefund({ day, ip, net48 }) {
    if (!(await this.storage.get(`s:${day}`))) return { ok: true, refunded: false };
    for (const k of [`i:${day}:${await this.dayHash(day, `ip|${ip}`)}`, ...(net48 ? [`n:${day}:${await this.dayHash(day, `n48|${net48}`)}`] : [])]) {
      const c = (await this.storage.get(k)) || 0;
      if (c > 0) await this.storage.put(k, c - 1);
    }
    return { ok: true, refunded: true };
  }

  /** Validate the key and count `units` against this month's plan limit. Denied requests write nothing.
   *  require='pro' refuses (without charging) keys on another plan, so /v1/batch needs one DO request. */
  async consume(month, units, limits, require = null) {
    const rec = await this.storage.get('key');
    if (!rec) return { ok: false, reason: 'unknown_key' };
    if (rec.status !== 'active') return { ok: false, reason: 'revoked' };
    if (require && rec.plan !== require) return { ok: false, reason: 'plan_required', plan: rec.plan };
    const limit = limits[rec.plan] ?? limits.free;
    const k = `m:${month}`;
    const used = (await this.storage.get(k)) || 0;
    if (used + units > limit) return { ok: false, reason: 'quota_exceeded', plan: rec.plan, used, limit, month };
    await this.storage.put(k, used + units);
    if (used === 0) await this.prune(month);
    return { ok: true, plan: rec.plan, used: used + units, limit, month };
  }

  /** Keep only the last MONTHS_KEPT monthly counters. */
  async prune(month) {
    const all = await this.storage.list({ prefix: 'm:' });
    const keys = [...all.keys()].sort();
    const old = keys.filter((k) => k < `m:${month}`).slice(0, Math.max(0, keys.length - MONTHS_KEPT));
    if (old.length) await this.storage.delete(old);
  }

  /** Shared daily pools: add batched increments, return totals; keeps today + yesterday only. */
  async add(day, inc) {
    const totals = { day };
    let first = false;
    for (const f of POOL_FIELDS) {
      const key = `d:${day}:${f}`;
      const cur = (await this.storage.get(key)) || 0;
      if (inc[f] > 0) {
        if (cur === 0) first = true;
        await this.storage.put(key, cur + inc[f]);
      }
      totals[f] = cur + inc[f];
    }
    if (first) {
      const all = await this.storage.list({ prefix: 'd:' });
      const y = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const old = [...all.keys()].filter((k) => k.slice(2, 12) < y);
      if (old.length) await this.storage.delete(old);
    }
    return totals;
  }
}
