/**
 * arbiter.test.ts — lease state machine with a fake clock and fake detector.
 *
 * Covers:
 *   - grant when idle
 *   - 409 busy on a second concurrent lease
 *   - 409 project_paused
 *   - budget accounting across a UTC-day boundary (fake clock)
 *   - finish idempotency (no double count)
 *   - TTL revocation
 *   - preempt revocation on foreign activity + the "must re-idle before
 *     re-grant" rule
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Arbiter, utcDay } from '../src/arbiter.js';
import { srcKey } from '../src/idle.js';
import { StateStore } from '../src/state.js';
import type { ActivityEntry, IdleSignal, ServerConfig } from '../src/types.js';

const T0 = Date.parse('2026-09-25T12:00:00Z'); // UTC noon

/**
 * Fake detector: implements the exact signal computation of IdleDetector
 * over a mutable entries list — no network, no FS, fake clock via `now`.
 */
class FakeDetector {
  entries: ActivityEntry[] = [];
  logMtime: number | null = null;
  fail = false;
  idleSeconds = 300;

  private compute(now: number, exempt: Set<string>): IdleSignal {
    const e = this.entries.find((x) => !exempt.has(srcKey(x.src)));
    const lastActivity = e
      ? { ts: Date.parse(e.timestamp), model: e.model, src: e.src }
      : null;
    const lastTs = Math.max(lastActivity?.ts ?? 0, this.logMtime ?? 0);
    const idleFor = lastTs > 0 ? now - lastTs : null;
    const idle = !this.fail && idleFor !== null && idleFor >= this.idleSeconds * 1000;
    return {
      now,
      idle,
      idle_for_s: idleFor === null ? null : Math.round(idleFor / 1000),
      last_activity: lastActivity,
      last_log_write: this.logMtime,
      signal_degraded: this.fail,
      degraded_reason: this.fail ? 'feed down' : null,
    };
  }

  async poll(now: number, exempt: Set<string>): Promise<IdleSignal> {
    return this.compute(now, exempt);
  }
  signal(now: number): IdleSignal {
    return this.compute(now, new Set());
  }
}

function mkEntries(secAgo: number[], src = 'ip:10.0.0.9', base = T0): ActivityEntry[] {
  return secAgo.map((s, i) => ({
    id: i + 1,
    timestamp: new Date(base - s * 1000).toISOString(),
    src,
    model: 'Qwen3.8-27B',
    req_path: '/v1/chat/completions',
    resp_status_code: 200,
  }));
}

function makeHarness(opts: { ttl?: number; cap?: number; maxLeases?: number; idleSeconds?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-arbiter-'));
  const store = new StateStore(join(dir, 'state.json'));
  const cfg: ServerConfig = {
    listen: 0,
    api_tokens: ['t'],
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    log_glob: '',
    idle_seconds: opts.idleSeconds ?? 300,
    poll_ms: 15000,
    lease_ttl_seconds: opts.ttl ?? 1800,
    max_concurrent_leases: opts.maxLeases ?? 1,
    projects: [
      { name: 'career-ops', paused: false, daily_token_cap: opts.cap ?? 1000 },
      { name: 'paused-proj', paused: true, daily_token_cap: 100 },
    ],
    state_file: join(dir, 'state.json'),
  };
  const det = new FakeDetector();
  det.idleSeconds = cfg.idle_seconds;
  const arbiter = new Arbiter(store, cfg, det as unknown as ConstructorParameters<typeof Arbiter>[2]);
  arbiter.registerClient('mac', '100.94.165.102', '127.0.0.1');
  return { dir, store, cfg, det, arbiter, client: store.state.clients[0]! };
}

const grant = (a: ReturnType<typeof makeHarness>, now: number, job = 'job-1') =>
  a.arbiter.requestLease({ client_id: a.client.client_id, project: 'career-ops', job_id: job, estimated_seconds: 60, now });

test('grant when idle', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]); // 400s quiet > 300s threshold
  const r = grant(h, T0);
  assert.equal(r.ok, true, `expected grant, got ${JSON.stringify(r)}`);
  assert.ok(r.lease!.lease_id.startsWith('l-'));
  assert.equal(r.lease!.status, 'active');
  assert.equal(h.arbiter.activeLeases(T0).length, 1);
  rmSync(h.dir, { recursive: true, force: true });
});

test('second concurrent lease is busy', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);
  const r1 = grant(h, T0, 'job-1');
  assert.equal(r1.ok, true);
  const r2 = grant(h, T0, 'job-2');
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'busy');
  rmSync(h.dir, { recursive: true, force: true });
});

test('paused project is refused (project_paused)', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);
  const r = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'paused-proj', job_id: 'x', estimated_seconds: 10, now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'project_paused');
  rmSync(h.dir, { recursive: true, force: true });
});

test('unknown project is refused', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);
  const r = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'nope', job_id: 'x', estimated_seconds: 10, now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_project');
  rmSync(h.dir, { recursive: true, force: true });
});

test('budget accounting across a UTC-day boundary (fake clock)', () => {
  const h = makeHarness({ cap: 100 });
  h.det.entries = mkEntries([400]);

  // Day 1: use 80 of 100 → still grantable.
  const g1 = grant(h, T0, 'a');
  assert.equal(g1.ok, true);
  h.arbiter.finishLease({ lease_id: g1.lease!.lease_id, ok: true, tokens_out: 80, tokens_in: 10, now: T0 + 1000 });
  assert.equal(h.arbiter.projectTokensOut('career-ops', utcDay(T0)), 80);

  // Same day, 80+30=110 ≥ 100 → budget_exhausted.
  const g2 = grant(h, T0 + 2000, 'b');
  assert.equal(g2.ok, true, '80 < 100: second job still fits');
  h.arbiter.finishLease({ lease_id: g2.lease!.lease_id, ok: true, tokens_out: 30, tokens_in: 5, now: T0 + 3000 });
  const g3 = grant(h, T0 + 4000, 'c');
  assert.equal(g3.ok, false);
  assert.equal(g3.reason, 'budget_exhausted', `110 ≥ 100 on day ${utcDay(T0)}`);

  // Next UTC day: the counter restarts → grantable again.
  const day2 = T0 + 24 * 3600 * 1000;
  h.det.entries = mkEntries([400], 'ip:10.0.0.9', day2); // quiet at day2
  const g4 = grant(h, day2, 'd');
  assert.equal(g4.ok, true, `fresh day ${utcDay(day2)} has a fresh budget`);
  assert.equal(h.arbiter.projectTokensOut('career-ops', utcDay(day2)), 0);
  assert.equal(h.arbiter.projectTokensOut('career-ops', utcDay(T0)), 110, 'day-1 counter untouched');
  rmSync(h.dir, { recursive: true, force: true });
});

test('finish idempotency: duplicate finishes do not double-count', () => {
  const h = makeHarness({ cap: 1000 });
  h.det.entries = mkEntries([400]);
  const g = grant(h, T0, 'a');
  const lid = g.lease!.lease_id;
  h.arbiter.finishLease({ lease_id: lid, ok: true, tokens_out: 50, tokens_in: 7, now: T0 + 1000 });
  // repeated finish (client retry / race): must not add again
  h.arbiter.finishLease({ lease_id: lid, ok: true, tokens_out: 50, tokens_in: 7, now: T0 + 2000 });
  h.arbiter.finishLease({ lease_id: lid, ok: true, tokens_out: 60, tokens_in: 7, now: T0 + 3000 });
  assert.equal(h.arbiter.projectTokensOut('career-ops', utcDay(T0)), 50, 'counted exactly once');
  assert.equal(h.arbiter.recentLeases().find((l) => l.lease_id === lid)?.tokens_out, 60, 'lease record keeps the max reported');
  rmSync(h.dir, { recursive: true, force: true });
});

test('TTL revocation', async () => {
  const h = makeHarness({ ttl: 60 });
  h.det.entries = mkEntries([400]);
  const g = grant(h, T0, 'a');
  assert.equal(g.ok, true);
  // 61s later: no activity at all (still idle), but the TTL ran out.
  const { revoked } = await h.arbiter.tick(T0 + 61_000);
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0]!.reason, 'ttl_expired');
  const lease = h.store.state.leases.find((l) => l.lease_id === g.lease!.lease_id)!;
  assert.equal(lease.status, 'expired');
  assert.equal(lease.end_reason, 'ttl_expired');
  rmSync(h.dir, { recursive: true, force: true });
});

test('preempt on foreign activity + must re-idle before re-grant', async () => {
  const h = makeHarness({ ttl: 3600 });
  h.det.entries = mkEntries([400]);
  const g = grant(h, T0, 'a');
  assert.equal(g.ok, true);

  // Foreign (non-exempt) activity lands 3s after the grant.
  h.det.entries = [...mkEntries([3], 'ip:10.0.0.9', T0 + 5_000), ...h.det.entries];
  const { revoked } = await h.arbiter.tick(T0 + 5_000);
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0]!.reason, 'preempted');
  const lease = h.store.state.leases.find((l) => l.lease_id === g.lease!.lease_id)!;
  assert.equal(lease.status, 'revoked');
  assert.equal(lease.end_reason, 'preempted');

  // Immediately after (still non-idle): re-grant is refused — the system
  // must go fully idle again first (no burst of re-grants).
  const again = grant(h, T0 + 6_000, 'b');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'not_idle');

  // 301s later the box is quiet again → the reidle gate clears and a grant
  // is possible.
  const t2 = T0 + 5_000 + 301_000;
  await h.arbiter.tick(t2); // detector: idle_for = 301s ≥ 300s
  const g2 = grant(h, t2, 'c');
  assert.equal(g2.ok, true, 'after a full idle, granting resumes');
  rmSync(h.dir, { recursive: true, force: true });
});

test('the lease holder’s OWN traffic does not preempt', async () => {
  const h = makeHarness({ ttl: 3600 });
  h.det.entries = mkEntries([400]);
  const g = grant(h, T0, 'a');
  assert.equal(g.ok, true);
  // The client (100.94.165.102) is hammering the LLM — that's its exempted
  // backfill traffic. It must NOT trigger a preempt.
  h.det.entries = [
    ...mkEntries([2], 'ip:100.94.165.102', T0 + 5_000),
    ...mkEntries([400], 'ip:10.0.0.9'),
  ];
  const { revoked } = await h.arbiter.tick(T0 + 5_000);
  assert.equal(revoked.length, 0, 'exempt (own-lease) traffic cannot preempt');
  const lease = h.store.state.leases.find((l) => l.lease_id === g.lease!.lease_id)!;
  assert.equal(lease.status, 'active');
  rmSync(h.dir, { recursive: true, force: true });
});

test('degraded feed: no grants, no preempts', async () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);
  const g = grant(h, T0, 'a');
  assert.equal(g.ok, true);
  // Feed dies while the lease is active.
  h.det.fail = true;
  const { revoked } = await h.arbiter.tick(T0 + 60_000);
  assert.equal(revoked.length, 0, 'degraded ⇒ never preempt on stale signals');
  const r = grant(h, T0 + 61_000, 'b');
  assert.equal(r.ok, false, 'degraded ⇒ no grants');
  rmSync(h.dir, { recursive: true, force: true });
});
