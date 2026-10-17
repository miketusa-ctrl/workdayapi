// Global daily soft cap (shared across all users), batched like dnsguard's budget.js:
// each isolate counts locally and flushes to ONE WorkdayQuota instance ("global:budget") every
// FLUSH_EVERY_N events or FLUSH_EVERY_MS, so the pool costs ~1 DO request per 25 calls.
// Approximate on purpose (overshoot <= active isolates x FLUSH_EVERY_N). Fails open if the DO is down
// (per-IP / per-key limiters and monthly key quotas still apply).
import { utcDay, POOL_FIELDS } from './quota.js';

export const BUDGET_DO_NAME = 'global:budget';
export const FLUSH_EVERY_N = 25;
export const FLUSH_EVERY_MS = 60_000;

const zero = () => Object.fromEntries(POOL_FIELDS.map((f) => [f, 0]));
const state = { day: null, seen: zero(), pending: zero(), lastFlush: 0, inflight: null };

export function resetBudgetState() { Object.assign(state, { day: null, seen: zero(), pending: zero(), lastFlush: 0, inflight: null }); }
export function budgetSnapshot() { return { day: state.day, seen: { ...state.seen }, pending: { ...state.pending } }; }

function roll(day) { if (state.day !== day) Object.assign(state, { day, seen: zero(), pending: zero(), lastFlush: 0 }); }
const used = (f) => state.seen[f] + state.pending[f];

export function secondsToUtcMidnight(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** kind: 'anon' | 'key' | 'mint' | 'authfail'. limits: { callsPerDay, anonPerDay, mintsPerDay, authFailsPerDay } */
export function budgetAllows(kind, limits, units = 1, now = new Date()) {
  roll(utcDay(now));
  if (kind === 'mint') return used('mints') < limits.mintsPerDay ? { ok: true } : { ok: false, pool: 'mints' };
  if (kind === 'authfail') return used('authfail') < limits.authFailsPerDay ? { ok: true } : { ok: false, pool: 'authfail' };
  if (used('calls') + units > limits.callsPerDay) return { ok: false, pool: 'calls' };
  if (kind === 'anon' && used('anon') + units > limits.anonPerDay) return { ok: false, pool: 'anon' };
  return { ok: true };
}

export function budgetRecord(kind, ns, ctx, units = 1, now = new Date()) {
  roll(utcDay(now));
  if (kind === 'mint') state.pending.mints += 1;
  else if (kind === 'authfail') state.pending.authfail += 1;
  else {
    state.pending.calls += units;
    if (kind === 'anon') state.pending.anon += units;
  }
  const n = state.pending.calls + state.pending.mints + state.pending.authfail;
  const due = n >= FLUSH_EVERY_N || now.getTime() - state.lastFlush >= FLUSH_EVERY_MS;
  if (!ns || !due || state.inflight) return null;
  const p = flushBudget(ns, now);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  return p;
}

export async function flushBudget(ns, now = new Date()) {
  const day = utcDay(now);
  roll(day);
  const batch = { ...state.pending };
  state.pending = zero();
  state.lastFlush = now.getTime();
  const qs = POOL_FIELDS.map((f) => `${f}=${batch[f]}`).join('&');
  const p = (async () => {
    try {
      const stub = ns.get(ns.idFromName(BUDGET_DO_NAME));
      const res = await stub.fetch(`https://quota/add?day=${day}&${qs}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const t = await res.json();
      if (state.day === day) for (const f of POOL_FIELDS) state.seen[f] = Math.max(state.seen[f], Number(t[f]) || 0);
      return t;
    } catch {
      if (state.day === day) for (const f of POOL_FIELDS) state.pending[f] += batch[f];
      return null;
    }
  })();
  state.inflight = p;
  p.finally(() => { if (state.inflight === p) state.inflight = null; });
  return p;
}

/** Seconds until 00:00 UTC on the 1st of next month (monthly quotas reset then). */
export function secondsToNextUtcMonth(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
