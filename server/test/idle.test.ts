/**
 * idle.test.ts — IdleDetector behavior with fake activity fetcher + fake
 * mtime source (no network, no FS).
 *
 * Covers:
 *   - idle after threshold
 *   - non-idle on fresh activity
 *   - self-traffic exemption: a client-IP entry while its lease is ACTIVE
 *     does NOT break idle; the SAME entry after the lease finished DOES
 *   - degraded state on fetch failure blocks idle (and thus grants)
 *   - log-mtime signal dominates when it's newer than the activity feed
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdleDetector } from '../src/idle.js';
import type { ActivityEntry } from '../src/types.js';

const T0 = Date.parse('2026-09-25T12:00:00Z');

function entry(id: number, tsSecAgo: number, src = 'ip:10.0.0.5', model = 'Qwen3.8-27B'): ActivityEntry {
  return {
    id,
    timestamp: new Date(T0 - tsSecAgo * 1000).toISOString(),
    src,
    model,
    req_path: '/v1/chat/completions',
    resp_status_code: 200,
  };
}

function makeDetector(opts: {
  entries?: ActivityEntry[];
  logMtimeMs?: number | null;
  logGlob?: string;
  idleSeconds?: number;
  failFetch?: boolean;
} = {}) {
  const entries = opts.entries ?? [];
  const fetcher = async () => {
    if (opts.failFetch) throw new Error('connection refused');
    return entries;
  };
  const mtime = () => (opts.logGlob ? opts.logMtimeMs ?? null : null);
  return new IdleDetector({
    fetchActivity: fetcher,
    logMtime: mtime,
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    log_glob: opts.logGlob ?? '',
    idle_seconds: opts.idleSeconds ?? 300,
  });
}

test('idle after threshold', async () => {
  const d = makeDetector({ entries: [entry(1, 400)], idleSeconds: 300 });
  const sig = await d.poll(T0, new Set());
  assert.equal(sig.idle, true, '400s of quiet with a 300s threshold is idle');
  assert.equal(sig.idle_for_s, 400);
});

test('non-idle on fresh activity', async () => {
  const d = makeDetector({ entries: [entry(1, 10), entry(2, 500)], idleSeconds: 300 });
  const sig = await d.poll(T0, new Set());
  assert.equal(sig.idle, false);
  assert.equal(sig.idle_for_s, 10, 'newest (non-exempt) entry dominates');
});

test('self-traffic exemption: active lease → client IP does not break idle', async () => {
  // Feed: newest entry is the backfill client's own traffic (10s old),
  // older entries are 10 min old. With the lease active, the exempt entry is
  // skipped and the system is still idle.
  const d = makeDetector({
    entries: [entry(1, 10, 'ip:100.94.165.102'), entry(2, 600, 'ip:10.0.0.5')],
    idleSeconds: 300,
  });
  const sig = await d.poll(T0, new Set(['100.94.165.102']));
  assert.equal(sig.idle, true, 'exempt (active lease) traffic must not break idle');
  assert.equal(sig.last_activity?.src, 'ip:10.0.0.5', 'last activity falls back to the non-exempt entry');
});

test('self-traffic: SAME entry after lease finished DOES break idle', async () => {
  const d = makeDetector({
    entries: [entry(1, 10, 'ip:100.94.165.102'), entry(2, 600, 'ip:10.0.0.5')],
    idleSeconds: 300,
  });
  // No exempt set (lease finished) → the client's entry counts.
  const sig = await d.poll(T0, new Set());
  assert.equal(sig.idle, false, 'lease ended → client traffic now counts against idle');
  assert.equal(sig.last_activity?.src, 'ip:100.94.165.102');
});

test('degraded on fetch failure: keeps last-known signals and blocks idle', async () => {
  const seed = new IdleDetector({
    fetchActivity: async () => [entry(1, 1000)],
    logMtime: () => null,
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    log_glob: '',
    idle_seconds: 300,
  });
  // first poll: 1000s quiet → idle, healthy
  const first = await seed.poll(T0, new Set());
  assert.equal(first.idle, true, '1000s quiet with a 300s threshold is idle');
  assert.equal(seed.isDegraded, false);
  // now the feed dies
  (seed as unknown as { o: { fetchActivity: unknown } }).o.fetchActivity = async () => {
    throw new Error('ECONNRESET');
  };
  const sig = await seed.poll(T0 + 60_000, new Set());
  assert.equal(sig.signal_degraded, true);
  assert.equal(sig.idle, false, 'degraded ⇒ never idle ⇒ no grants');
  assert.equal(sig.last_activity?.src, 'ip:10.0.0.5', 'last-known activity preserved, not wiped');
});

test('log-mtime signal dominates when newer than activity', async () => {
  // Activity says 10 min quiet; the NInfer log was written 5s ago (a
  // request in flight). The log mtime must win.
  const d = makeDetector({
    entries: [entry(1, 600, 'ip:10.0.0.5')],
    logGlob: '/mnt/docker/llama-swap/ninfer/logs/req-*.jsonl',
    logMtimeMs: T0 - 5 * 1000,
    idleSeconds: 300,
  });
  const sig = await d.poll(T0, new Set());
  assert.equal(sig.idle, false, 'recent log write breaks idle even with a quiet feed');
  assert.equal(sig.last_log_write, T0 - 5 * 1000);
});

test('log-mtime disabled with empty glob', async () => {
  const d = makeDetector({
    entries: [entry(1, 600)],
    logGlob: '',
    logMtimeMs: T0,
    idleSeconds: 300,
  });
  const sig = await d.poll(T0, new Set());
  assert.equal(sig.last_log_write, null, 'empty glob disables the signal');
  assert.equal(sig.idle, true);
});

test('exemption matching is format-agnostic (ip: prefix vs bare)', async () => {
  const d = makeDetector({
    entries: [entry(1, 5, 'ip:100.94.165.102'), entry(2, 600, 'ip:10.0.0.5')],
    idleSeconds: 300,
  });
  // exempt set carries the bare IP (as the client reports it) while the feed
  // uses the `ip:` prefix — the backfill entry is skipped either way.
  const sig = await d.poll(T0, new Set(['100.94.165.102']));
  assert.equal(sig.idle, true, 'bare-IP exempt set matches the ip: prefixed feed src');
  assert.equal(sig.last_activity?.src, 'ip:10.0.0.5');
});

test('all-exempt feed is conservative: never claims idle', async () => {
  // If the ONLY traffic in the feed is from lease-holders, we cannot prove
  // the box is quiet (it is running backfill by definition). The detector
  // keeps its previous last-activity and reports not-idle: a grant is gated
  // (and preempts cannot fire from exempt traffic).
  const d = makeDetector({ entries: [entry(1, 2, 'ip:100.94.165.102')], idleSeconds: 300 });
  const sig = await d.poll(T0, new Set(['100.94.165.102']));
  assert.equal(sig.idle, false, 'exhaustively-exempt feed ⇒ not-idle (conservative)');
});
