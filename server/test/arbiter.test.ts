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
 *   - client overrides: pause blocks new grants (active lease untouched);
 *     force grants while busy / behind the reidle gate; force NEVER grants
 *     while degraded; `until` auto-expiry + the tick sweep
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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

function makeHarness(opts: { ttl?: number; cap?: number; maxLeases?: number; idleSeconds?: number; jobFailThreshold?: number; jobCooldownSeconds?: number } = {}) {
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
    job_fail_threshold: opts.jobFailThreshold ?? 5,
    job_cooldown_seconds: opts.jobCooldownSeconds ?? 300,
    projects: [
      { name: 'career-ops', paused: false, daily_token_cap: opts.cap ?? 1000 },
      { name: 'paused-proj', paused: true, daily_token_cap: 100 },
    ],
    state_file: join(dir, 'state.json'),
  };
  const det = new FakeDetector();
  det.idleSeconds = cfg.idle_seconds;
  const arbiter = new Arbiter(store, cfg, det as unknown as ConstructorParameters<typeof Arbiter>[2]);
  // The client's REAL current IP is the OBSERVED connection IP (what the
  // self-traffic exemption keys on). `127.0.0.1` stands in for the client's
  // stale static config value — the old code trusted that one, which is
  // exactly the bug Fix 5 removes.
  arbiter.registerClient('mac', '127.0.0.1', '100.94.165.102');
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

test('per-project grant knobs: overrides the global knobs for that project only', () => {
  const h = makeHarness({ maxLeases: 1 });
  h.det.entries = mkEntries([400]);

  const career = h.cfg.projects.find((p) => p.name === 'career-ops')!;

  // Per-project max_concurrent_leases: career-ops allowed 2 concurrent while
  // the global cap is 1.
  h.arbiter.setProjectSettings('career-ops', { max_concurrent_leases: 2 });
  assert.equal(
    h.arbiter.projectEffectiveSettings('career-ops').max_concurrent_leases,
    2,
    'effective = the per-project override',
  );
  assert.equal(h.arbiter.projectEffectiveSettings('paused-proj').max_concurrent_leases, 1, 'other projects keep the global');

  const g1 = grant(h, T0, 'a');
  assert.equal(g1.ok, true);
  const g2 = grant(h, T0 + 1000, 'b');
  assert.equal(g2.ok, true, 'per-project max 2: a second concurrent lease fits');
  const g3 = grant(h, T0 + 2000, 'c');
  assert.equal(g3.ok, false);
  assert.equal(g3.reason, 'busy');

  // Per-project idle_seconds: the GLOBAL idle threshold still gates the
  // signal (one watched feed), but the EFFECTIVE settings expose the
  // per-project value.
  h.arbiter.setProjectSettings('career-ops', { idle_seconds: 600 });
  assert.equal(h.arbiter.projectEffectiveSettings('career-ops').idle_seconds, 600);
  assert.equal(career.idle_seconds, 600, 'the live config row carries the override');

  // clear → back to the globals (explicit nulls clear each override)
  const cleared = h.arbiter.setProjectSettings('career-ops', { idle_seconds: null, max_concurrent_leases: null, lease_ttl_seconds: null });
  assert.equal(cleared.ok, true);
  const eff = h.arbiter.projectEffectiveSettings('career-ops');
  assert.equal(eff.max_concurrent_leases, h.cfg.max_concurrent_leases, 'cleared → global');
  assert.equal(eff.idle_seconds, h.cfg.idle_seconds, 'cleared → global');
  assert.equal(career.max_concurrent_leases, undefined, 'the config row no longer carries overrides');

  // persistence: the state file carries the project rows
  h.arbiter.setProjectSettings('career-ops', { lease_ttl_seconds: 300 });
  assert.equal(h.store.state.projects.length, 2, 'one persisted row per config project');
  const row = h.store.state.projects.find((r) => r.name === 'career-ops')!;
  assert.equal(row.lease_ttl_seconds, 300);
  assert.equal(row.paused, false);

  // unknown project
  assert.equal(h.arbiter.setProjectSettings('nope', { idle_seconds: 60 }).ok, false);

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

// ---------------------------------------------------------------------------
// Client overrides (pause / force)
// ---------------------------------------------------------------------------

test('pause override: new grants refused (client_paused), active lease untouched', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);
  const g = grant(h, T0, 'a');
  assert.equal(g.ok, true);

  const set = h.arbiter.setClientOverride(h.client.client_id, 'pause');
  assert.equal(set.ok, true);
  assert.equal(h.arbiter.activeOverride(h.client.client_id, T0)?.override, 'pause');

  // A second job for the SAME paused client is refused…
  const paused = grant(h, T0 + 1000, 'b');
  assert.equal(paused.ok, false);
  assert.equal(paused.reason, 'client_paused', `expected client_paused, got ${JSON.stringify(paused)}`);

  // …but the lease already running for the paused client keeps running.
  assert.equal(h.arbiter.activeLeases(T0 + 1000).length, 1, 'pause does not revoke a running lease');

  // A DIFFERENT client is unaffected by the pause.
  h.arbiter.registerClient('other', '10.0.0.5', '127.0.0.1');
  const otherClient = h.store.state.clients[1]!;
  h.arbiter.finishLease({ lease_id: g.lease!.lease_id, ok: true, now: T0 + 2000 });
  const g2 = h.arbiter.requestLease({ client_id: otherClient.client_id, project: 'career-ops', job_id: 'c', estimated_seconds: 10, now: T0 + 3000 });
  assert.equal(g2.ok, true, 'unpaused client still gets a grant');

  // Clear → the paused client can be granted again.
  const clear = h.arbiter.setClientOverride('mac', null); // addressed by NAME
  assert.equal(clear.ok, true);
  assert.equal(h.arbiter.activeOverride(h.client.client_id, T0 + 4000), null);
  h.arbiter.finishLease({ lease_id: g2.lease!.lease_id, ok: true, now: T0 + 4000 });
  const g3 = grant(h, T0 + 5000, 'd');
  assert.equal(g3.ok, true, 'cleared override ⇒ grants resume');
  rmSync(h.dir, { recursive: true, force: true });
});

test('force override: grants while the box is busy', () => {
  const h = makeHarness({ maxLeases: 1 });
  // Fresh activity → NOT idle.
  h.det.entries = mkEntries([5], 'ip:10.0.0.9', Date.now());
  const detNow = Date.now();
  h.det.entries = mkEntries([5], 'ip:10.0.0.9', detNow);

  // No override: busy box refuses.
  const refused = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'x', estimated_seconds: 10, now: detNow });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'not_idle');

  // Force: same busy box now grants.
  h.arbiter.setClientOverride(h.client.client_id, 'force');
  const forced = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'x', estimated_seconds: 10, now: detNow + 1000 });
  assert.equal(forced.ok, true, `force grants despite busy box, got ${JSON.stringify(forced)}`);
  assert.equal(h.arbiter.activeLeases(detNow + 1000).length, 1);
  rmSync(h.dir, { recursive: true, force: true });
});

test('force override: grants behind the post-revocation reidle gate', async () => {
  const h = makeHarness({ ttl: 3600 });
  h.det.entries = mkEntries([400]);
  const g = grant(h, T0, 'a');
  assert.equal(g.ok, true);

  // External activity lands → preempt → reidle gate arms.
  h.det.entries = [...mkEntries([3], 'ip:10.0.0.9', T0 + 5_000), ...h.det.entries];
  const { revoked } = await h.arbiter.tick(T0 + 5_000);
  assert.equal(revoked.length, 1);
  const plain = grant(h, T0 + 6_000, 'b');
  assert.equal(plain.ok, false, 'reidle gate blocks a normal grant');

  // Force slips through the gate even while still not idle.
  h.arbiter.setClientOverride(h.client.client_id, 'force');
  const forced = grant(h, T0 + 6_000, 'c');
  assert.equal(forced.ok, true, `force bypasses the reidle gate, got ${JSON.stringify(forced)}`);
  rmSync(h.dir, { recursive: true, force: true });
});

test('force override does NOT grant while the signal is degraded', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);
  h.det.fail = true; // feed down ⇒ degraded ⇒ idle=false with stale data
  h.arbiter.setClientOverride(h.client.client_id, 'force');
  const r = grant(h, T0, 'a');
  assert.equal(r.ok, false, 'degraded ⇒ no grants, even forced');
  assert.equal(r.reason, 'not_idle');
  rmSync(h.dir, { recursive: true, force: true });
});

test('force still honors busy (max concurrent) and project pause', () => {
  const h = makeHarness({ maxLeases: 1 });
  h.det.entries = mkEntries([400]);
  h.arbiter.setClientOverride(h.client.client_id, 'force');
  const g1 = grant(h, T0, 'a');
  assert.equal(g1.ok, true);
  const g2 = grant(h, T0 + 1000, 'b');
  assert.equal(g2.ok, false);
  assert.equal(g2.reason, 'busy', 'force does not bypass max_concurrent_leases');

  // Free the slot, then check the project check (busy is evaluated first).
  h.arbiter.finishLease({ lease_id: g1.lease!.lease_id, ok: true, now: T0 + 2000 });
  const g3 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'paused-proj', job_id: 'c', estimated_seconds: 10, now: T0 + 2000 });
  assert.equal(g3.ok, false);
  assert.equal(g3.reason, 'project_paused', 'force does not bypass a paused project');
  rmSync(h.dir, { recursive: true, force: true });
});

test('override `until` auto-expires (grant time + tick sweep)', async () => {
  const h = makeHarness();
  // `until` is validated against the REAL clock (setClientOverride uses
  // Date.now()), so anchor the whole test to real time and drive the
  // detector entries to match.
  const realNow = Date.now();
  const until = realNow + 10_000; // future ⇒ accepted
  const before = realNow + 1_000; // < until ⇒ override still active
  const after = realNow + 20_000; // > until ⇒ expired

  h.det.entries = mkEntries([400], 'ip:10.0.0.9', before);
  const set = h.arbiter.setClientOverride(h.client.client_id, 'pause', until);
  assert.equal(set.ok, true);
  assert.equal(h.arbiter.activeOverride(h.client.client_id, before)?.override, 'pause', 'active before `until`');

  // Before expiry: refused (the reason is client_paused, not not_idle).
  const blocked = grant(h, before, 'a');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'client_paused');

  // After expiry: granted.
  h.det.entries = mkEntries([400], 'ip:10.0.0.9', after);
  const afterGrant = grant(h, after, 'b');
  assert.equal(afterGrant.ok, true, `expired override no longer blocks, got ${JSON.stringify(afterGrant)}`);

  // The tick sweep drops the expired entry from state entirely.
  h.arbiter.finishLease({ lease_id: afterGrant.lease!.lease_id, ok: true, now: after + 1_000 });
  h.det.entries = mkEntries([400], 'ip:10.0.0.9', after + 10_000);
  await h.arbiter.tick(after + 10_000);
  assert.equal(h.store.state.overrides[h.client.client_id], undefined, 'expired override swept from state');

  // And setClientOverride rejects a non-future `until`.
  const bad = h.arbiter.setClientOverride(h.client.client_id, 'pause', Date.now() - 1000);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'until_must_be_in_the_future');
  rmSync(h.dir, { recursive: true, force: true });
});

test('setClientOverride: unknown client rejected; idempotent re-registration keeps the override', () => {
  const h = makeHarness();
  const bad = h.arbiter.setClientOverride('c-nope', 'force');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unknown_client');
  const byName = h.arbiter.setClientOverride('mac', 'force');
  assert.equal(byName.ok, true, 'addressable by name');

  // Simulate a restart: the client re-registers under the SAME name.
  // (Idempotent register keeps the same id → the override survives on purpose.)
  const re = h.arbiter.registerClient('mac', '100.94.165.102', '127.0.0.1');
  assert.equal(re.created, false);
  assert.equal(h.arbiter.activeOverride(h.client.client_id)?.override, 'force', 'idempotent re-register keeps the same client_id ⇒ override persists');
  rmSync(h.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Client IP rule (self-traffic exemption): the OBSERVED connection IP wins
// over the client-reported one (a static config value goes stale when
// Tailscale reassigns addresses); the reported value is kept for audit.
// ---------------------------------------------------------------------------

test('registerClient: observed IP wins over reported; reported-only fallback still works; reported_ip surfaces in state', () => {
  const h = makeHarness();

  // 1. First registration: reported AND observed are both present — the
  // OBSERVED value is the exemption key; the reported one rides along.
  h.arbiter.registerClient('worker-obs', '10.0.0.7', '10.10.99.44');
  const obs = h.store.state.clients.find((c) => c.name === 'worker-obs')!;
  assert.equal(obs.ip, '10.10.99.44', 'the OBSERVED IP is what the exemption keys on');
  assert.equal(obs.reported_ip, '10.0.0.7', 'the reported IP is stored for display/audit');
  assert.equal(obs.observed_ip, '10.10.99.44');

  // 2. Re-registration: tailscale reassigned the address. The stale static
  // value (10.0.0.7) must NOT clobber the exemption — observed wins again.
  h.arbiter.registerClient('worker-obs', '10.0.0.7', '10.10.99.45');
  const obs2 = h.store.state.clients.find((c) => c.name === 'worker-obs')!;
  assert.equal(obs2.ip, '10.10.99.45', 're-registration refreshes the exemption to the NEW observed IP');
  assert.equal(obs2.reported_ip, '10.0.0.7', 'reported_ip keeps the (stale) static value for audit');

  // 3. A registration where the observed IP is the `unknown` placeholder
  // (no readable request IP): the reported value is the fallback — the
  // old reported-only behavior still works.
  h.arbiter.registerClient('worker-fallback', '10.0.0.8', 'unknown');
  const fb = h.store.state.clients.find((c) => c.name === 'worker-fallback')!;
  assert.equal(fb.ip, '10.0.0.8', 'observed=unknown ⇒ the reported IP is used (older servers still work)');
  assert.equal(fb.reported_ip, '10.0.0.8');

  // 4. `reported_ip` is surfaced in the persisted state (the dashboard and
  // /api/state expose the whole client row).
  const raw = JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8'));
  const row = raw.clients.find((c) => c.name === 'worker-obs');
  assert.equal(row.ip, '10.10.99.45', 'state file: ip = the observed value');
  assert.equal(row.reported_ip, '10.0.0.7', 'state file: reported_ip surfaces for audit');
  rmSync(h.dir, { recursive: true, force: true });
});

test('registerClient: first registration records allocations + last_seen; re-registration refreshes both', () => {
  const h = makeHarness();
  const allocs = [
    { name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 12 },
    { name: 'other', model: 'Qwen3.8-27B', estimated_seconds: 600, queue_depth: 0 },
  ];

  // A new client with allocations.
  const r1 = h.arbiter.registerClient('worker-b', '10.0.0.7', '127.0.0.1', allocs, T0);
  assert.equal(r1.created, true);
  const b = h.store.state.clients.find((c) => c.name === 'worker-b')!;
  assert.deepEqual(b.projects, allocs, 'reported allocations stored');
  assert.equal(b.last_seen, T0, 'last_seen recorded at first registration');
  assert.equal(b.registered_at, new Date(T0).toISOString());

  // Re-registration (heartbeat): same id, refreshed last_seen + updated depths.
  const allocs2 = [
    { name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 7 },
    { name: 'other', model: 'Qwen3.8-27B', estimated_seconds: 600, queue_depth: 3 },
  ];
  const r2 = h.arbiter.registerClient('worker-b', '10.0.0.7', '127.0.0.1', allocs2, T0 + 60_000);
  assert.equal(r2.created, false);
  assert.equal(r2.client_id, b.client_id, 'idempotent on name');
  const b2 = h.store.state.clients.find((c) => c.name === 'worker-b')!;
  assert.equal(b2.last_seen, T0 + 60_000, 'last_seen advanced on re-registration');
  assert.deepEqual(b2.projects, allocs2, 'allocations replaced (queue depths are live)');
  assert.equal(b2.registered_at, new Date(T0).toISOString(), 'registered_at stays at first registration');

  // A re-registration WITHOUT projects keeps the stored ones (no clobber).
  const r3 = h.arbiter.registerClient('worker-b', undefined, '127.0.0.1', undefined, T0 + 120_000);
  assert.equal(r3.created, false);
  const b3 = h.store.state.clients.find((c) => c.name === 'worker-b')!;
  assert.deepEqual(b3.projects, allocs2, 'no projects ⇒ stored allocations untouched');
  assert.equal(b3.last_seen, T0 + 120_000, 'last_seen still advances');

  // Legacy client registered without allocations gets an empty list.
  h.arbiter.registerClient('legacy', undefined, '127.0.0.1');
  const legacy = h.store.state.clients.find((c) => c.name === 'legacy')!;
  assert.deepEqual(legacy.projects, []);
  rmSync(h.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Anti-thrash (per-job failure tracking, throttle + cooldown)
//
// The Sep 25-26 incident: one crashed job (broken executor template) was
// re-granted ~902 times over 17 hours because the arbiter had no
// job-level failure knowledge — a buggy/old client could always thrash.
// These tests cover the backstop: per-(project, job_id) failure counts,
// the throttle at job_fail_threshold, the per-job grant cooldown after
// EVERY failure, ok:true resets, operator unthrottle, and restart
// persistence of the throttle state.
// ---------------------------------------------------------------------------

const failLease = (h: ReturnType<typeof makeHarness>, job: string, at: number, error = 'executor_exit_1') => {
  const g = grant(h, at, job);
  if (!g.ok) throw new Error(`grant for ${job} at ${at} refused: ${JSON.stringify(g)}`);
  h.arbiter.finishLease({ lease_id: g.lease!.lease_id, ok: false, error, now: at + 1000 });
};

test('anti-thrash: N ok:false reports for one job reach the threshold ⇒ subsequent grants denied job_throttled', () => {
  const h = makeHarness({ jobCooldownSeconds: 50 });
  h.det.entries = mkEntries([400]); // idle the whole time

  // Four failures (spaced past the 50s cooldown): below the threshold (5) —
  // the job may still be granted.
  for (let i = 0; i < 4; i++) failLease(h, 'job-t', T0 + i * 60_000);
  assert.equal(Object.keys(h.store.state.throttled_jobs).length, 0, 'no throttle below the threshold');

  // The 5th failure crosses the threshold → throttled (persisted row).
  failLease(h, 'job-t', T0 + 4 * 60_000);
  const row = h.store.state.throttled_jobs['career-ops::job-t'];
  assert.ok(row, 'the throttle row is persisted on threshold');
  assert.equal(row.count, 5, 'count = the number of failures that crossed the threshold');
  assert.equal(row.project, 'career-ops');
  assert.equal(row.job_id, 'job-t');
  assert.equal(row.last_error, 'executor_exit_1');
  assert.ok(row.last_failed_at >= T0 + 4 * 60_000);
  assert.ok(
    h.store.state.events.some((e) => e.kind === 'job_throttled' && e.project === 'career-ops'),
    'a job_throttled event is recorded',
  );

  // The box is idle and the last failure's cooldown has elapsed — yet the
  // SAME job is denied job_throttled (the throttle, not the cooldown or a
  // busy box) while another job still grants.
  const denied = grant(h, T0 + 6 * 60_000, 'job-t');
  assert.equal(denied.ok, false, `throttled job denied: ${JSON.stringify(denied)}`);
  assert.equal(denied.reason, 'job_throttled');
  const other = grant(h, T0 + 6 * 60_000, 'job-other');
  assert.equal(other.ok, true, 'a different job is unaffected by the throttle');
  rmSync(h.dir, { recursive: true, force: true });
});

test('anti-thrash cooldown: right after a failed lease the same job is denied job_cooldown (even idle, even below threshold); other jobs grant; the cooldown elapses', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);

  // One failure: far below the threshold (5) — no throttle…
  failLease(h, 'job-c', T0);
  assert.equal(Object.keys(h.store.state.throttled_jobs).length, 0, 'one failure does not throttle');

  // …but the per-job cooldown (300s) is armed: the SAME job is denied
  // job_cooldown even though the signal is fully idle — this is what
  // breaks the ~20-second re-grant loop.
  const blocked = grant(h, T0 + 1_000, 'job-c');
  assert.equal(blocked.ok, false, `cooldown blocks the immediate re-grant: ${JSON.stringify(blocked)}`);
  assert.equal(blocked.reason, 'job_cooldown', 'the denial reason is the cooldown, not not_idle');

  // A DIFFERENT job is not cooled down.
  const other = grant(h, T0 + 1_000, 'job-c2');
  assert.equal(other.ok, true, 'the cooldown is per-job');
  h.arbiter.finishLease({ lease_id: other.lease!.lease_id, ok: true, now: T0 + 2_000 });

  // After the cooldown elapses (300s) the job is grantable again.
  const later = grant(h, T0 + 301_000, 'job-c');
  assert.equal(later.ok, true, 'after the cooldown elapses, the job can be granted again');
  rmSync(h.dir, { recursive: true, force: true });
});

test('anti-thrash: a successful ok:true report for a job resets its failure count and cooldown', () => {
  const h = makeHarness({ jobCooldownSeconds: 50 });
  h.det.entries = mkEntries([400]);

  // Two failures for job-r (count at 2 < threshold 5).
  failLease(h, 'job-r', T0); // finish T0+1s ⇒ cooldown to T0+51s
  failLease(h, 'job-r', T0 + 60_000); // ⇒ cooldown to T0+111s
  const blocked = grant(h, T0 + 62_000, 'job-r');
  assert.equal(blocked.reason, 'job_cooldown', 'the job is in cooldown after its failures');

  // After the cooldown elapses the job runs again; it FAILS (count 3) and
  // then SUCCEEDS — the success resets the failure streak: the next
  // failure sequence must need the FULL threshold again to throttle.
  const g3 = grant(h, T0 + 112_000, 'job-r');
  assert.equal(g3.ok, true, 'job-r is grantable after its cooldown');
  h.arbiter.finishLease({ lease_id: g3.lease!.lease_id, ok: false, error: 'executor_exit_1', now: T0 + 113_000 }); // count 3
  const g4 = grant(h, T0 + 164_000, 'job-r');
  assert.equal(g4.ok, true, 'job-r is grantable after its second cooldown');
  const fin4 = h.arbiter.finishLease({ lease_id: g4.lease!.lease_id, ok: true, now: T0 + 165_000 });
  assert.equal(fin4.ok, true, 'the job SUCCEEDS this time');
  // 4 more failures (each spaced past the cooldown) stay unthrottled —
  // the count is 1..4 after the reset, not 4..5.
  for (let i = 0; i < 4; i++) failLease(h, 'job-r', T0 + 220_000 + i * 60_000);
  assert.equal(Object.keys(h.store.state.throttled_jobs).length, 0, 'a success reset the count: 4 fresh failures do not re-throttle');
  rmSync(h.dir, { recursive: true, force: true });
});

test('anti-thrash: unthrottleJob clears the throttle + cooldown + failure count (operator recovery)', () => {
  const h = makeHarness({ jobCooldownSeconds: 50 });
  h.det.entries = mkEntries([400]);
  for (let i = 0; i < 5; i++) failLease(h, 'job-u', T0 + i * 60_000);
  assert.ok(h.store.state.throttled_jobs['career-ops::job-u'], 'throttled at 5 failures');
  assert.equal(grant(h, T0 + 5 * 60_000, 'job-u').reason, 'job_throttled');

  const res = h.arbiter.unthrottleJob('career-ops', 'job-u');
  assert.equal(res.ok, true);
  assert.equal(res.was_throttled, true, 'it reports the job WAS throttled');
  assert.equal(Object.keys(h.store.state.throttled_jobs).length, 0, 'the throttle row is gone');
  assert.ok(h.store.state.events.some((e) => e.kind === 'job_unthrottled' && e.project === 'career-ops'), 'a job_unthrottled event is recorded');

  // The cooldown is cleared too: the job is grantable immediately (idle,
  // no active lease), not after another cooldown.
  const g = grant(h, T0 + 5 * 60_000, 'job-u');
  assert.equal(g.ok, true, `unthrottle clears the cooldown: immediate re-grant, got ${JSON.stringify(g)}`);
  // Finish it ok:true (frees the box AND resets the count — the loop below
  // then proves 4 fresh failures stay below the threshold).
  h.arbiter.finishLease({ lease_id: g.lease!.lease_id, ok: true, now: T0 + 5 * 60_000 + 1000 });

  // And the failure count is reset: 4 more failures stay below threshold.
  for (let i = 0; i < 4; i++) failLease(h, 'job-u', T0 + 6 * 60_000 + i * 60_000);
  assert.equal(Object.keys(h.store.state.throttled_jobs).length, 0, 'failure count reset by unthrottle');

  // Idempotent: unthrottling again is a success (was_throttled=false).
  const again = h.arbiter.unthrottleJob('career-ops', 'job-u');
  assert.equal(again.ok, true);
  assert.equal(again.was_throttled, false);
  // Unknown project → not ok (the API maps this to 404).
  const bad = h.arbiter.unthrottleJob('nope', 'job-u');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unknown_project');
  rmSync(h.dir, { recursive: true, force: true });
});

test('anti-thrash: TTL expirations do NOT count as job failures (a dead client is an unknown outcome)', async () => {
  const h = makeHarness({ ttl: 60 });
  h.det.entries = mkEntries([400]);

  // Five leases for the same job, each TTL-expired (the holder died without
  // reporting usage). Grant one, tick past its TTL (60s), repeat.
  let revokedTotal = 0;
  for (let i = 0; i < 5; i++) {
    const at = T0 + i * 200_000;
    const g = grant(h, at, 'job-d');
    assert.equal(g.ok, true, `grant ${i} for job-d (ttl 60s)`);
    const { revoked } = await h.arbiter.tick(at + 61_000);
    assert.equal(revoked.length, 1, `the tick expires lease ${i} by TTL`);
    assert.equal(revoked[0]!.reason, 'ttl_expired');
    revokedTotal += revoked.length;
    // The revocation arms the post-revocation reidle gate; the NEXT tick
    // (still fully idle) disarms it so the following grant can proceed.
    await h.arbiter.tick(at + 120_000);
  }
  assert.equal(revokedTotal, 5, 'all five leases expired by TTL');
  assert.equal(Object.keys(h.store.state.throttled_jobs).length, 0, 'TTL expirations never count as job failures');
  // No cooldown was armed either (the holder died — the outcome is
  // unknown): the job is immediately re-grantable.
  const g = grant(h, T0 + 1000_000, 'job-d');
  assert.equal(g.ok, true, 'no cooldown after TTL expirations');
  rmSync(h.dir, { recursive: true, force: true });
});

test('anti-thrash: throttle state survives a state-file reload (server restart)', () => {
  const h = makeHarness({ jobCooldownSeconds: 50 });
  h.det.entries = mkEntries([400]);
  for (let i = 0; i < 5; i++) failLease(h, 'job-s', T0 + i * 60_000);
  assert.ok(h.store.state.throttled_jobs['career-ops::job-s'], 'throttled before the restart');

  // Simulate a restart: a FRESH store + arbiter over the SAME state file
  // (state.save() already wrote it after each finishLease).
  const freshStore = new StateStore(join(h.dir, 'state.json'));
  const freshArbiter = new Arbiter(freshStore, h.cfg, h.det as unknown as ConstructorParameters<typeof Arbiter>[2]);
  assert.ok(freshStore.state.throttled_jobs['career-ops::job-s'], 'the throttle row is in the reloaded state');
  const denied = freshArbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'job-s', estimated_seconds: 60, now: T0 + 60_000 });
  assert.equal(denied.ok, false, `the reloaded arbiter still denies the job: ${JSON.stringify(denied)}`);
  assert.equal(denied.reason, 'job_throttled', 'throttling persists across a server restart (the persisted row, not the in-memory cooldown)');
  rmSync(h.dir, { recursive: true, force: true });
});

test('anti-thrash: error_detail round-trips usage → lease record → state file and appears in the lease_finished event (truncated)', () => {
  const h = makeHarness({ jobCooldownSeconds: 50 });
  h.det.entries = mkEntries([400]);
  const g = grant(h, T0, 'job-ed');
  assert.equal(g.ok, true);
  const longDetail = 'x'.repeat(500) + 'MARKER-END';
  h.arbiter.finishLease({ lease_id: g.lease!.lease_id, ok: false, error: 'executor_exit_1', error_detail: longDetail, now: T0 + 1000 });

  const lease = h.store.state.leases.find((l) => l.lease_id === g.lease!.lease_id)!;
  assert.equal(lease.error_detail, longDetail, 'the lease record carries the full (≤1000) error_detail');

  // The state file carries it too (the dashboard /api/state reads the same
  // records).
  const raw = JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8'));
  const rawLease = raw.leases.find((l: { lease_id: string }) => l.lease_id === g.lease!.lease_id)!;
  assert.equal(rawLease.error_detail, longDetail, 'error_detail persists in the state file');

  // The lease_finished event shows the LAST 300 chars, truncated with an
  // ellipsis — not the full 524-char blob.
  const ev = h.store.state.events.find((e) => e.kind === 'lease_finished' && e.lease_id === g.lease!.lease_id)!;
  assert.ok(ev.detail?.includes('…') , 'the event detail is truncated with an ellipsis');
  assert.ok(ev.detail?.includes('MARKER-END'), 'the event keeps the END of the detail (last 300 chars)');
  assert.ok(!(ev.detail ?? '').includes(longDetail), 'the full detail is NOT in the event line');

  // Short details ride through verbatim (no ellipsis for short strings).
  const g2 = grant(h, T0 + 60_000, 'job-ed2');
  assert.equal(g2.ok, true);
  h.arbiter.finishLease({ lease_id: g2.lease!.lease_id, ok: false, error: 'executor_exit_1', error_detail: 'boom', now: T0 + 61_000 });
  const ev2 = h.store.state.events.find((e) => e.kind === 'lease_finished' && e.lease_id === g2.lease!.lease_id)!;
  assert.ok(ev2.detail?.includes('detail=boom'), 'short detail rides the event verbatim');
  assert.ok(!(ev2.detail ?? '').includes('…'), 'no ellipsis for a short detail');
  rmSync(h.dir, { recursive: true, force: true });
});
