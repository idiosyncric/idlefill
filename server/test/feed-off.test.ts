/**
 * feed-off.test.ts — the #60 A1 blocker fix: a server row that declares NO
 * activity feed (empty `activity_path`) DISABLES the feed signal instead of
 * degrading it, so a feed-less provider (oMLX) stays watchable via log mtime.
 *
 * Covers:
 *   - feed off + stale log  → idle, NOT degraded, fetch never attempted
 *   - feed off + fresh log  → not idle (the log signal still carries it)
 *   - feed off + glob matches nothing → idle_for_s null → never idle
 *     (the fail-closed posture is unchanged)
 *   - back-compat: a row WITH a path still degrades on a failed fetch
 *   - the config loader: an explicit empty activity_path survives; an
 *     absent key falls back to the llama-swap default
 *   - upsertServerConnection: create + patch honor an explicit empty path
 *   - end-to-end admission: the Arbiter grants against a real feed-off
 *     IdleDetector on a log-only signal
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdleDetector } from '../src/idle.js';
import { applyDefaults } from '../src/config.js';
import { Arbiter, WATCHED_SERVER_ID } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import type { ServerConfig } from '../src/types.js';

const T0 = Date.parse('2026-10-05T12:00:00Z');

function feedOffDetector(opts: { logMtimeMs?: number | null; logGlob?: string; idleSeconds?: number } = {}) {
  let fetchCalls = 0;
  const d = new IdleDetector({
    fetchActivity: async () => {
      fetchCalls += 1;
      throw new Error('feed fetch attempted for a feed-off row');
    },
    logMtime: () => opts.logMtimeMs ?? null,
    llama_swap_url: 'http://omlx.local:8000',
    activity_path: '', // the feed-off declaration (#60 A1)
    log_glob: opts.logGlob ?? '/logs/server.log',
    idle_seconds: opts.idleSeconds ?? 300,
  });
  return { d, fetchCalls: () => fetchCalls };
}

test('feed off + stale log: idle verdict from log mtime alone, no fetch, no degrade', async () => {
  const { d, fetchCalls } = feedOffDetector({ logMtimeMs: T0 - 400_000, idleSeconds: 300 });
  const sig = await d.poll(T0, new Set());
  assert.equal(fetchCalls(), 0, 'a feed-off row must never fetch a feed');
  assert.equal(sig.signal_degraded, false, 'no feed is a declaration, not a failure');
  assert.equal(sig.degraded_reason, null);
  assert.equal(sig.idle, true, '400s of log silence with a 300s threshold is idle');
  assert.equal(sig.idle_for_s, 400, 'a real idle_for_s rides the signal (dashboard countdown)');
  assert.equal(sig.feed_enabled, false, 'the signal says the feed is off');
  assert.equal(sig.last_activity, null);
  assert.equal(sig.last_log_write, T0 - 400_000);
});

test('feed off + fresh log write: the log signal still defeats idle', async () => {
  const { d } = feedOffDetector({ logMtimeMs: T0 - 5_000, idleSeconds: 300 });
  const sig = await d.poll(T0, new Set());
  assert.equal(sig.idle, false, 'a request line written 5s ago breaks idle');
  assert.equal(sig.idle_for_s, 5);
  assert.equal(sig.signal_degraded, false);
});

test('feed off + glob matches nothing: fail-closed (idle_for_s null, never idle)', async () => {
  const { d } = feedOffDetector({ logMtimeMs: null });
  const sig = await d.poll(T0, new Set());
  assert.equal(sig.idle_for_s, null, 'no signal resolves ⇒ unknown, same as a degraded feed');
  assert.equal(sig.idle, false, 'unknown is NEVER idle — the fail-closed posture is unchanged');
  assert.equal(sig.signal_degraded, false, 'fail-closed via null idle_for_s, not via degrade');
});

test('back-compat: a row WITH a path still degrades on a failed fetch', async () => {
  const d = new IdleDetector({
    fetchActivity: async () => {
      throw new Error('ECONNREFUSED');
    },
    logMtime: () => T0 - 400_000,
    llama_swap_url: 'http://llama.local:11434',
    activity_path: '/api/metrics/activity',
    log_glob: '/logs/req-*.jsonl',
    idle_seconds: 300,
  });
  const sig = await d.poll(T0, new Set());
  assert.equal(sig.signal_degraded, true, 'a declared feed that fails still degrades');
  assert.equal(sig.idle, false, 'degraded ⇒ never idle');
  assert.equal(sig.feed_enabled, true);
});

// ---------------------------------------------------------------------------
// Config + API surface honoring the declaration
// ---------------------------------------------------------------------------

test('config: explicit empty activity_path survives; absent key keeps the default', () => {
  const off = applyDefaults({ activity_path: '' });
  assert.equal(off.activity_path, '', 'the feed-off declaration must not be defaulted away');
  const absent = applyDefaults({});
  assert.equal(absent.activity_path, '/api/metrics/activity', 'an absent key keeps the llama-swap default (back-compat)');
});

test('upsertServerConnection: explicit empty activity_path sticks on create and patch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefeed-off-'));
  const store = new StateStore(join(dir, 'state.json'));
  const cfg: ServerConfig = {
    ...applyDefaults({ state_file: join(dir, 'state.json') }),
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 1000 }],
  };
  const arbiter = new Arbiter(store, cfg, new Map());
  const created = arbiter.upsertServerConnection({ name: 'omlx', url: 'http://127.0.0.1:8000', activity_path: '', log_glob: '/logs/server.log' });
  assert.equal(created.ok, true);
  assert.equal(created.server!.activity_path, '', 'create honors the explicit empty path');
  // A second feed-off row at the SAME url is not a duplicate of the first's
  // (url + activity path pair) only when the path differs — same pair = dupe.
  const dupe = arbiter.upsertServerConnection({ name: 'omlx2', url: 'http://127.0.0.1:8000', activity_path: '' });
  assert.equal(dupe.ok, false, 'url + empty path pair still dedupes');
  // Patch: turning a feed-on row off by presenting an explicit empty path.
  const watched = store.state.servers.find((s) => s.id === WATCHED_SERVER_ID)!;
  assert.ok(watched.activity_path, 'the seeded watched row carries the default path');
  const patched = arbiter.upsertServerConnection({ id: WATCHED_SERVER_ID, activity_path: '' });
  assert.equal(patched.ok, true, 'an explicit empty path is a change, not "nothing to update"');
  assert.equal(patched.server!.activity_path, '');
  const noop = arbiter.upsertServerConnection({ id: WATCHED_SERVER_ID });
  assert.equal(noop.ok, false, 'an absent key still leaves the row untouched');
  rmSync(dir, { recursive: true, force: true });
});

test('admission end-to-end: the Arbiter grants on a log-only feed-off detector', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-feedoff-'));
  const store = new StateStore(join(dir, 'state.json'));
  const cfg: ServerConfig = {
    ...applyDefaults({ state_file: join(dir, 'state.json'), llama_swap_url: 'http://omlx.local:8000', activity_path: '', log_glob: '/logs/server.log', idle_seconds: 300 }),
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 100_000 }],
  };
  let fetchCalls = 0;
  const det = new IdleDetector({
    fetchActivity: async () => {
      fetchCalls += 1;
      throw new Error('must not fetch');
    },
    logMtime: () => T0 - 400_000,
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: cfg.log_glob,
    idle_seconds: cfg.idle_seconds,
  });
  const arbiter = new Arbiter(store, cfg, det);
  const reg = arbiter.registerClient('mac', undefined, '127.0.0.1');
  // One tick so the detector's signal is fresh.
  await arbiter.tick(T0);
  assert.equal(fetchCalls, 0, 'the tick never touched a feed for the feed-off row');
  const sig = arbiter.serverSignal(WATCHED_SERVER_ID, T0);
  assert.equal(sig?.signal_degraded, false, 'the watched feed-off row is NOT degraded');
  const r = arbiter.requestLease({ client_id: reg.client_id, project: 'career-ops', job_id: 'j1', estimated_seconds: 60, now: T0 });
  assert.equal(r.ok, true, `log-only idle must grant, got ${JSON.stringify(r)}`);
  rmSync(dir, { recursive: true, force: true });
});
