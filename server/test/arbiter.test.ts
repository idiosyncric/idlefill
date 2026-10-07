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
import { Arbiter, utcDay, computeLeaseTtl } from '../src/arbiter.js';
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

function makeHarness(opts: { ttl?: number; cap?: number; maxLeases?: number; idleSeconds?: number; jobFailThreshold?: number; jobCooldownSeconds?: number; safetyFactor?: number; floorSeconds?: number; resultsCap?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-arbiter-'));
  const store = new StateStore(join(dir, 'state.json'), opts.resultsCap !== undefined ? { resultsPerProjectCap: opts.resultsCap } : {});
  const cfg: ServerConfig = {
    listen: 0,
    api_tokens: ['t'],
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    log_glob: '',
    idle_seconds: opts.idleSeconds ?? 300,
    poll_ms: 15000,
    lease_ttl_seconds: opts.ttl ?? 1800,
    lease_ttl_safety_factor: opts.safetyFactor ?? 2,
    lease_ttl_floor_seconds: opts.floorSeconds ?? 60,
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

// ---------------------------------------------------------------------------
// Adaptive lease TTL: the per-job estimate caps the lease — and can only
// shorten it (never extend beyond the effective global TTL).
// ---------------------------------------------------------------------------

test('computeLeaseTtl: no/zero estimate keeps the full TTL; est*2 floors and caps at the global', () => {
  // No estimate (0 or absent/NaN) → today's behavior exactly.
  assert.equal(computeLeaseTtl(0, 1800, 2, 60), 1800, 'est 0 → full TTL');
  assert.equal(computeLeaseTtl(600, 1800, 2, 60), 1200, 'est 600 → 600*2 = 1200');
  assert.equal(computeLeaseTtl(900, 1800, 2, 60), 1800, 'est 900 → 900*2 = 1800 = cap at the global (never extends beyond it)');
  assert.equal(computeLeaseTtl(1200, 1800, 2, 60), 1800, 'est 1200 → 2400 capped at the global 1800');
  assert.equal(computeLeaseTtl(20, 1800, 2, 60), 60, 'est 20 → 20*2 = 40 floored at lease_ttl_floor_seconds (60)');
  assert.equal(computeLeaseTtl(30, 1800, 2, 60), 60, 'est 30 → 60, exactly the floor (not floored up)');
  // A per-project (effective) TTL that is LOWER than the global is the cap —
  // the estimate can never extend past it.
  assert.equal(computeLeaseTtl(900, 300, 2, 60), 300, 'cap is the EFFECTIVE ttl (300), not the global');
  // Non-default safety factor (1.5) is honored.
  assert.equal(computeLeaseTtl(100, 1800, 1.5, 60), 150, 'safetyFactor 1.5 → 100*1.5 = 150');
  // Non-positive estimates (negative input) behave like no estimate.
  assert.equal(computeLeaseTtl(-5, 1800, 2, 60), 1800, 'negative estimate → full TTL');
});

test('lease grant: est 0/absent → expires_at = grant + lease_ttl_seconds (today\u2019s behavior)', () => {
  const h = makeHarness(); // ttl 1800, factor 2, floor 60
  h.det.entries = mkEntries([400]);
  // est 0 → no adaptive shortening.
  const r0 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j0', estimated_seconds: 0, now: T0 });
  assert.equal(r0.ok, true);
  assert.equal(r0.lease!.expires_at, T0 + 1800 * 1000, 'est 0 → full TTL');
  assert.equal(r0.lease!.estimated_seconds, 0);
  // No estimate detail note on the grant event (effective TTL == global).
  const ev0 = h.store.state.events.find((e) => e.kind === 'lease_granted' && e.lease_id === r0.lease!.lease_id)!;
  assert.ok(ev0.detail === `mac: j0`, `no ttl note when the effective TTL equals the global (detail: ${JSON.stringify(ev0.detail)})`);
  h.arbiter.finishLease({ lease_id: r0.lease!.lease_id, ok: true, now: T0 + 1000 });

  // Absent (undefined) estimate → same: full TTL, no note.
  const rAbs = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-abs', estimated_seconds: undefined as unknown as number, now: T0 + 2000 });
  assert.equal(rAbs.ok, true);
  assert.equal(rAbs.lease!.expires_at, T0 + 2000 + 1800 * 1000, 'absent est → full TTL');
  const evAbs = h.store.state.events.find((e) => e.kind === 'lease_granted' && e.lease_id === rAbs.lease!.lease_id)!;
  assert.ok(!/ttl \d+s from est/.test(evAbs.detail ?? ''), 'absent est → no ttl note');
  rmSync(h.dir, { recursive: true, force: true });
});

test('lease grant: est 600 with TTL 1800 → expires_at = grant + 1200s; the grant event carries the ttl note', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);
  const r = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j600', estimated_seconds: 600, now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.lease!.estimated_seconds, 600);
  assert.equal(r.lease!.expires_at, T0 + 1200 * 1000, 'est 600 → 600*2 = 1200s lease');
  const ev = h.store.state.events.find((e) => e.kind === 'lease_granted' && e.lease_id === r.lease!.lease_id)!;
  assert.equal(ev.detail, 'mac: j600 (ttl 1200s from est 600s*2)', 'the event detail records the effective TTL and why');
  rmSync(h.dir, { recursive: true, force: true });
});

test('lease grant: est 900 → capped at the global 1800 (the adaptive TTL never extends a lease)', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);
  const r = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j900', estimated_seconds: 900, now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.lease!.expires_at, T0 + 1800 * 1000, 'est 900 → 900*2 = 1800 = the global cap (zero behavior change at the default estimate)');
  const ev = h.store.state.events.find((e) => e.kind === 'lease_granted' && e.lease_id === r.lease!.lease_id)!;
  assert.ok(!/from est/.test(ev.detail ?? ''), 'no ttl note when the cap equals the global (indistinguishable from today)');
  rmSync(h.dir, { recursive: true, force: true });
});

test('lease grant: est 20 → floored at lease_ttl_floor_seconds (20*2 = 40 → 60)', () => {
  const h = makeHarness(); // floor 60
  h.det.entries = mkEntries([400]);
  const r = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j20', estimated_seconds: 20, now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.lease!.expires_at, T0 + 60 * 1000, 'est 20 → 20*2 = 40 < floor 60 → floored to 60s');
  const ev = h.store.state.events.find((e) => e.kind === 'lease_granted' && e.lease_id === r.lease!.lease_id)!;
  assert.equal(ev.detail, 'mac: j20 (ttl 60s from est 20s*2)', 'the note shows the floored TTL');
  rmSync(h.dir, { recursive: true, force: true });
});

test('lease grant: lease_ttl_safety_factor: 1.5 config is honored (est 100 → 150s)', () => {
  const h = makeHarness({ safetyFactor: 1.5 });
  h.det.entries = mkEntries([400]);
  const r = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j150', estimated_seconds: 100, now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.lease!.expires_at, T0 + 150 * 1000, 'est 100 * 1.5 = 150s');
  const ev = h.store.state.events.find((e) => e.kind === 'lease_granted' && e.lease_id === r.lease!.lease_id)!;
  assert.equal(ev.detail, 'mac: j150 (ttl 150s from est 100s*1.5)', 'the note carries the non-integer factor');
  rmSync(h.dir, { recursive: true, force: true });
});

test('lease grant: an early (estimate-driven) TTL expiry does NOT count as a job failure', async () => {
  // est 30 → 30*2 = 60s adaptive TTL (== the floor), so the lease expires at
  // +60s even though the (global) lease_ttl_seconds is 1800.
  const h = makeHarness({ ttl: 1800 });
  h.det.entries = mkEntries([400]);

  const g = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'job-e', estimated_seconds: 30, now: T0 });
  assert.equal(g.ok, true);
  assert.equal(g.lease!.expires_at, T0 + 60 * 1000, 'adaptive TTL: 30*2 = 60s');

  // The lease expires early — the holder reported nothing.
  const { revoked } = await h.arbiter.tick(T0 + 61_000);
  assert.equal(revoked.length, 1, 'the adaptive TTL expired the lease');
  assert.equal(revoked[0]!.reason, 'ttl_expired');

  // Failure attribution is client-reported usage only: a ttl_expired never
  // bumps the failure count and never arms job_throttled / job_cooldown.
  assert.equal(Object.keys(h.store.state.throttled_jobs).length, 0, 'ttl_expired does not arm a throttle');
  assert.ok(
    !h.store.state.events.some((e) => e.kind === 'job_throttled'),
    'no job_throttled event from a ttl_expired',
  );
  // The revocation arms the post-revocation reidle gate (unrelated to failure
  // attribution); a later fully-idle tick disarms it…
  await h.arbiter.tick(T0 + 120_000);
  // …then the job is re-grantable. If the ttl_expired had armed the per-job
  // grant cooldown (300s from the failure), this grant would be refused
  // `job_cooldown` — it is not (the holder died: unknown outcome, not a
  // failure).
  const again = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'job-e', estimated_seconds: 30, now: T0 + 130_000 });
  assert.equal(again.ok, true, `no job_cooldown after an early TTL expiry, got ${JSON.stringify(again)}`);
  rmSync(h.dir, { recursive: true, force: true });
});

test('lease grant: a per-project lease_ttl_seconds override is the cap (estimate never extends past it)', () => {
  const h = makeHarness(); // global ttl 1800
  h.det.entries = mkEntries([400]);
  // Operator sets a tighter per-project TTL (600s).
  h.arbiter.setProjectSettings('career-ops', { lease_ttl_seconds: 600 });

  // est 900 would be 900*2 = 1800s at the global — the per-project 600s is
  // the cap: the lease expires at grant+600s, never extended by the estimate.
  const r1 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-cap', estimated_seconds: 900, now: T0 });
  assert.equal(r1.ok, true);
  assert.equal(r1.lease!.expires_at, T0 + 600 * 1000, 'cap is the per-project (effective) TTL, never extended by the estimate');
  const ev1 = h.store.state.events.find((e) => e.kind === 'lease_granted' && e.lease_id === r1.lease!.lease_id)!;
  assert.ok(!/from est/.test(ev1.detail ?? ''), 'cap == effective TTL ⇒ no note (indistinguishable from today for this project)');
  h.arbiter.finishLease({ lease_id: r1.lease!.lease_id, ok: true, now: T0 + 1000 });

  // est 200 → 200*2 = 400s < the effective 600s: the estimate shortens the
  // lease, and the note records the effective TTL.
  const r2 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-short', estimated_seconds: 200, now: T0 + 2000 });
  assert.equal(r2.ok, true);
  assert.equal(r2.lease!.expires_at, T0 + 2000 + 400 * 1000, 'est 200 → 400s under the per-project cap of 600s');
  const ev2 = h.store.state.events.find((e) => e.kind === 'lease_granted' && e.lease_id === r2.lease!.lease_id)!;
  assert.equal(ev2.detail, 'mac: j-short (ttl 400s from est 200s*2)', 'the note reflects the effective (per-project) TTL');
  rmSync(h.dir, { recursive: true, force: true });
});

test('/api/state lease rows still carry expires_at + estimated_seconds (shape unchanged)', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);
  const r = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-shape', estimated_seconds: 600, now: T0 });
  assert.equal(r.ok, true);
  const lease = h.store.state.leases.find((l) => l.lease_id === r.lease!.lease_id)!;
  // The /api/state lease view passes lease records through verbatim — the
  // adaptive TTL must not change their shape.
  assert.equal(typeof lease.expires_at, 'number');
  assert.equal(typeof lease.estimated_seconds, 'number');
  assert.equal(lease.estimated_seconds, 600);
  assert.equal(lease.expires_at - lease.granted_at, 1200 * 1000);
  // The state file round-trips the same fields.
  const raw = JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8'));
  const rawLease = raw.leases.find((l: { lease_id: string }) => l.lease_id === r.lease!.lease_id)!;
  assert.equal(rawLease.estimated_seconds, 600, 'estimated_seconds persists');
  assert.equal(rawLease.expires_at, lease.expires_at, 'expires_at persists (the adaptive value)');
  assert.ok(rawLease.granted_at && rawLease.granted_at < rawLease.expires_at, 'granted_at < expires_at');
  rmSync(h.dir, { recursive: true, force: true });
});


// ==================================================================
// Per-engine admission + sessions (#38/#32/#33)
// ==================================================================

/**
 * Multi-server harness: two declared servers, each with its own fake
 * detector. Server A is the watched one (WATCHED_SERVER_ID); B is added
 * via upsertServerConnection (the API path).
 */
function makeMultiHarness(opts: { maxLeases?: number; idleSeconds?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-multi-'));
  const store = new StateStore(join(dir, 'state.json'));
  const cfg: ServerConfig = {
    listen: 0,
    api_tokens: ['t'],
    llama_swap_url: 'http://fake-a',
    activity_path: '/api/metrics/activity',
    log_glob: '',
    idle_seconds: opts.idleSeconds ?? 300,
    poll_ms: 15000,
    lease_ttl_seconds: 1800,
    lease_ttl_safety_factor: 2,
    lease_ttl_floor_seconds: 60,
    max_concurrent_leases: opts.maxLeases ?? 1,
    job_fail_threshold: 5,
    job_cooldown_seconds: 300,
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 100000 }],
    state_file: join(dir, 'state.json'),
  };
  const detA = new FakeDetector();
  detA.idleSeconds = cfg.idle_seconds;
  const arbiter = new Arbiter(store, cfg, detA as unknown as ConstructorParameters<typeof Arbiter>[2]);
  arbiter.registerClient('mac', undefined, '100.94.165.102');
  const up = arbiter.upsertServerConnection({ name: 'gpu-box', url: 'http://fake-b' });
  const serverB = up.server!.id;
  const detB = new FakeDetector();
  detB.idleSeconds = cfg.idle_seconds;
  // Inject B's detector (a production arbiter builds it via detectorFactory).
  (arbiter as unknown as { detectors: Map<string, unknown> }).detectors.set(serverB, detB);
  return { dir, store, cfg, arbiter, detA, detB, serverB, client: store.state.clients[0]! };
}

test('per-engine: a lease on server A does not consume server B\u2019s slot', () => {
  const h = makeMultiHarness();
  h.detA.entries = mkEntries([400]);
  h.detB.entries = mkEntries([400], 'ip:10.0.0.8');
  const rA = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-a', estimated_seconds: 60, now: T0 });
  assert.equal(rA.ok, true, `A grant expected, got ${JSON.stringify(rA)}`);
  assert.equal(rA.lease!.server_id, 'srv-watched', 'lease records its engine');
  const rB = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-b', estimated_seconds: 60, now: T0, server_id: h.serverB });
  assert.equal(rB.ok, true, `B grant expected (per-engine cap), got ${JSON.stringify(rB)}`);
  // A second lease on A is busy; on B it is busy too — the cap is per server.
  const rA2 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-a2', estimated_seconds: 60, now: T0 });
  assert.equal(rA2.reason, 'busy');
  const rB2 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-b2', estimated_seconds: 60, now: T0, server_id: h.serverB });
  assert.equal(rB2.reason, 'busy');
  rmSync(h.dir, { recursive: true, force: true });
});

test('per-engine: unknown server_id is refused (unknown_server)', () => {
  const h = makeMultiHarness();
  h.detA.entries = mkEntries([400]);
  const r = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-x', estimated_seconds: 60, now: T0, server_id: 'srv-nope' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_server');
  rmSync(h.dir, { recursive: true, force: true });
});

test('per-engine: a server with no detector is fail-closed for grants', () => {
  const h = makeMultiHarness();
  h.detA.entries = mkEntries([400]);
  // Remove B\u2019s detector: the row exists but has no signal source.
  (h.arbiter as unknown as { detectors: Map<string, unknown> }).detectors.delete(h.serverB);
  const r = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-x', estimated_seconds: 60, now: T0, server_id: h.serverB });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_idle', 'no signal = idle cannot be proven');
  rmSync(h.dir, { recursive: true, force: true });
});

test('per-engine: a preempt on A arms A\u2019s reidle gate but never B\u2019s', async () => {
  const h = makeMultiHarness();
  h.detA.entries = mkEntries([400]);
  h.detB.entries = mkEntries([400], 'ip:10.0.0.8');
  const rA = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-a', estimated_seconds: 60, now: T0 });
  assert.equal(rA.ok, true);
  // Foreign activity on A post-grant → preempt on the next tick.
  h.detA.entries = mkEntries([0], 'ip:10.0.0.9');
  await h.arbiter.tick(T0 + 1000);
  assert.ok(h.arbiter.reidleGated('srv-watched'), 'A gate armed');
  assert.ok(!h.arbiter.reidleGated(h.serverB), 'B gate untouched');
  // B can still grant while A is gated.
  const rB = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-b', estimated_seconds: 60, now: T0 + 1000, server_id: h.serverB });
  assert.equal(rB.ok, true, `B grants while A is reidle-gated, got ${JSON.stringify(rB)}`);
  // A stays gated until a full-idle verdict on A.
  const rA2 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-a2', estimated_seconds: 60, now: T0 + 2000 });
  assert.equal(rA2.reason, 'not_idle');
  h.detA.entries = mkEntries([400]); // A quiet again
  await h.arbiter.tick(T0 + 301_000);
  const rA3 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-a3', estimated_seconds: 60, now: T0 + 301_000 });
  assert.equal(rA3.ok, true, 'A re-grants after its own full idle');
  rmSync(h.dir, { recursive: true, force: true });
});

test('legacy lease without server_id belongs to the watched server', () => {
  const h = makeMultiHarness();
  h.detA.entries = mkEntries([400]);
  h.detB.entries = mkEntries([400], 'ip:10.0.0.8');
  // Simulate a pre-per-engine state file: strip server_id from the lease.
  const r = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-old', estimated_seconds: 60, now: T0 });
  assert.equal(r.ok, true);
  delete r.lease!.server_id;
  // The cap on the watched server sees it; B does not.
  const rA2 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-a2', estimated_seconds: 60, now: T0 });
  assert.equal(rA2.reason, 'busy');
  const rB = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-b', estimated_seconds: 60, now: T0, server_id: h.serverB });
  assert.equal(rB.ok, true);
  rmSync(h.dir, { recursive: true, force: true });
});

test('sessions: a live session on a server defeats idle for grants (#32)', () => {
  const h = makeMultiHarness();
  h.detA.entries = mkEntries([400]); // feed says idle
  h.detB.entries = mkEntries([400], 'ip:10.0.0.8');
  h.arbiter.registerSession('s-abc', { client_id: h.client.client_id, last_activity: T0 - 60_000, now: T0 });
  const r = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-1', estimated_seconds: 60, now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_idle', 'session activity within idle_seconds is interactive traffic');
  // A session on B does NOT block A.
  const rB = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-b', estimated_seconds: 60, now: T0, server_id: h.serverB });
  assert.equal(rB.ok, true, 'session on the watched server never gates B');
  // force does not bypass a live session either.
  h.arbiter.setClientOverride('mac', 'force');
  const rf = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-f', estimated_seconds: 60, now: T0 });
  assert.equal(rf.ok, false);
  assert.equal(rf.reason, 'not_idle', 'force never collides with a live session');
  rmSync(h.dir, { recursive: true, force: true });
});

test('sessions: session activity post-grant preempts the lease even when the feed exempts it (#32)', async () => {
  const h = makeMultiHarness();
  h.detA.entries = mkEntries([400]);
  const r = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-1', estimated_seconds: 600, now: T0 });
  assert.equal(r.ok, true);
  // The router shares the lease holder\u2019s IP — the feed exempts session
  // traffic. The session row is direct evidence and preempts anyway.
  h.arbiter.registerSession('s-live', { client_id: h.client.client_id, last_activity: T0 + 5_000, now: T0 + 5_000 });
  const { revoked } = await h.arbiter.tick(T0 + 6_000);
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0]!.reason, 'preempted');
  assert.equal(revoked[0]!.lease.lease_id, r.lease!.lease_id);
  rmSync(h.dir, { recursive: true, force: true });
});

test('sessions: register is idempotent on token; last_activity keeps the max', () => {
  const h = makeMultiHarness();
  const r1 = h.arbiter.registerSession('s-tok', { client_name: 'mac', last_activity: T0, now: T0 });
  assert.equal(r1.created, true);
  const r2 = h.arbiter.registerSession('s-tok', { last_activity: T0 - 10_000, now: T0 + 1000 });
  assert.equal(r2.created, false);
  assert.equal(r2.session!.last_activity, T0, 'never rewinds');
  const r3 = h.arbiter.registerSession('s-tok', { last_activity: T0 + 500, now: T0 + 2000 });
  assert.equal(r3.session!.last_activity, T0 + 500);
  assert.equal(h.arbiter.listSessions().length, 1);
  rmSync(h.dir, { recursive: true, force: true });
});

// gate-state: the register heartbeat's gate block rides the row verbatim.
// Valid ⇒ store (last-write-wins); absent/null ⇒ CLEAR; invalid ⇒ DROP
// (never a rejected registration).
test('sessions: gate block — stored on register, cleared on the idle report, invalid dropped', () => {
  const h = makeMultiHarness();
  // Create with a gate block.
  const r1 = h.arbiter.registerSession('s-gate', { gate: { state: 'queued', waiting: 2 }, now: T0 });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.session!.gate, { state: 'queued', waiting: 2 });
  // Heartbeat refreshes it (last-write-wins).
  const r2 = h.arbiter.registerSession('s-gate', { gate: { state: 'active', waiting: 0 }, now: T0 + 1000 });
  assert.deepEqual(r2.session!.gate, { state: 'active', waiting: 0 });
  // Invalid blocks are DROPPED, not rejected — the stored value stands.
  for (const bad of [
    { state: 'bogus', waiting: 1 },
    { state: 'queued', waiting: -1 },
    { state: 'queued', waiting: 1.5 },
    { state: 'queued', waiting: 'x' },
    { state: 'queued' },
    'queued',
    [1, 2],
  ]) {
    const r = h.arbiter.registerSession('s-gate', { gate: bad, now: T0 + 2000 });
    assert.equal(r.ok, true, `invalid gate ${JSON.stringify(bad)} never rejects the registration`);
    assert.deepEqual(r.session!.gate, { state: 'active', waiting: 0 }, 'invalid block leaves the stored gate untouched');
  }
  // The idle report (gate absent) CLEARS the stored gate.
  const r3 = h.arbiter.registerSession('s-gate', { now: T0 + 3000 });
  assert.equal(r3.session!.gate, null, 'absent gate clears to null');
  // Re-set, then explicit null also clears.
  h.arbiter.registerSession('s-gate', { gate: { state: 'queued', waiting: 1 }, now: T0 + 4000 });
  const r4 = h.arbiter.registerSession('s-gate', { gate: null, now: T0 + 5000 });
  assert.equal(r4.session!.gate, null);
  // A row created WITHOUT a gate block carries gate = null (never tagged).
  const r5 = h.arbiter.registerSession('s-plain', { now: T0 });
  assert.equal(r5.session!.gate, null);
  rmSync(h.dir, { recursive: true, force: true });
});

test('sessions: operator override set/clear/expiry (same shape as client overrides)', () => {
  const h = makeMultiHarness();
  const NOW = Date.now();
  h.arbiter.registerSession('s-ovr', { now: NOW });
  assert.equal(h.arbiter.setSessionOverride('s-nope', 'pause').ok, false);
  const set = h.arbiter.setSessionOverride('s-ovr', 'pause', NOW + 10_000);
  assert.equal(set.ok, true);
  assert.equal(h.arbiter.activeSessionOverride('s-ovr', NOW + 5_000)?.override, 'pause');
  assert.equal(h.arbiter.activeSessionOverride('s-ovr', NOW + 10_000), null, 'until auto-expires');
  h.arbiter.setSessionOverride('s-ovr', 'force');
  assert.equal(h.arbiter.activeSessionOverride('s-ovr', NOW + 20_000)?.override, 'force');
  h.arbiter.setSessionOverride('s-ovr', null);
  assert.equal(h.arbiter.activeSessionOverride('s-ovr', NOW + 20_000), null);
  rmSync(h.dir, { recursive: true, force: true });
});

test('sessions: stale rows are swept on tick; fresh rows survive', async () => {
  const h = makeMultiHarness();
  h.arbiter.registerSession('s-old', { now: T0 });
  h.arbiter.registerSession('s-new', { now: T0 });
  // Two hours later: the old row (last_seen T0) is stale; refresh s-new first.
  h.arbiter.registerSession('s-new', { now: T0 + 2 * 3_600_000 });
  await h.arbiter.tick(T0 + 2 * 3_600_000);
  const toks = h.arbiter.listSessions().map((s) => s.token);
  assert.ok(!toks.includes('s-old'), 'stale session swept');
  assert.ok(toks.includes('s-new'), 'heartbeat keeps the row');
  rmSync(h.dir, { recursive: true, force: true });
});

test('upsertServerConnection: created rows inherit log_glob support + duplicate guard', () => {
  const h = makeMultiHarness();
  const up = h.arbiter.upsertServerConnection({ name: 'vllm', url: 'http://fake-c', log_glob: '/logs/req-*.jsonl' });
  assert.equal(up.ok, true);
  assert.equal(up.server!.log_glob, '/logs/req-*.jsonl');
  const dupe = h.arbiter.upsertServerConnection({ name: 'vllm2', url: 'http://fake-c' });
  assert.equal(dupe.ok, false);
  const patch = h.arbiter.upsertServerConnection({ id: up.server!.id, models: ['llama-3'] });
  assert.equal(patch.ok, true);
  assert.deepEqual(patch.server!.models, ['llama-3']);
  rmSync(h.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Per-job results (issue #4): the arbiter stores the LAST reported outcome
// per (project, job_id) from usage reports — the verdict the budget counters
// never carried. Latest-only per job, newest 200 rows per project kept.
// ---------------------------------------------------------------------------

test('results: a usage report with score stores the outcome row (ok, score, tokens, ts)', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);
  const g = grant(h, T0, 'job-r1');
  assert.ok(g.ok, `grant: ${JSON.stringify(g)}`);
  h.arbiter.finishLease({ lease_id: g.lease!.lease_id, ok: true, tokens_out: 120, tokens_in: 40, score: 7.5, now: T0 + 1000 });

  const row = h.store.state.results['career-ops::job-r1'];
  assert.ok(row, 'the result row is stored under the project::job_id key');
  assert.equal(row.project, 'career-ops');
  assert.equal(row.job_id, 'job-r1');
  assert.equal(row.ok, true);
  assert.equal(row.score, 7.5, 'the usage payload score lands on the row');
  assert.equal(row.tokens_out, 120);
  assert.equal(row.tokens_in, 40);
  assert.equal(row.error, null, 'a success row carries no error');
  assert.equal(row.ts, new Date(T0 + 1000).toISOString(), 'ts = server receive time (ISO)');
  rmSync(h.dir, { recursive: true, force: true });
});

test('results: a failed report stores ok:false + error; a missing or garbage score stores null', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);

  const g1 = grant(h, T0, 'job-rf');
  assert.ok(g1.ok);
  h.arbiter.finishLease({ lease_id: g1.lease!.lease_id, ok: false, error: 'executor_exit_1', tokens_out: 5, now: T0 + 1000 });
  const fail = h.store.state.results['career-ops::job-rf']!;
  assert.equal(fail.ok, false);
  assert.equal(fail.error, 'executor_exit_1');
  assert.equal(fail.score, null, 'no score in the payload ⇒ null');

  // A garbage (non-number) score is stored as null, never rejected.
  const g2 = grant(h, T0 + 60_000, 'job-rg');
  assert.ok(g2.ok);
  h.arbiter.finishLease({ lease_id: g2.lease!.lease_id, ok: true, score: 'high' as unknown as number, now: T0 + 61_000 });
  assert.equal(h.store.state.results['career-ops::job-rg']!.score, null, 'garbage score ⇒ null');
  rmSync(h.dir, { recursive: true, force: true });
});

test('results: a second report for the same (project, job) REPLACES the row (latest-only)', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);

  const g1 = grant(h, T0, 'job-re');
  assert.ok(g1.ok);
  h.arbiter.finishLease({ lease_id: g1.lease!.lease_id, ok: false, error: 'executor_exit_1', score: null, now: T0 + 1000 });
  const first = h.store.state.results['career-ops::job-re']!;
  assert.equal(first.ok, false);

  // The retry succeeds: the row is REPLACED, not appended (latest-only).
  // Spaced past the 300s failure cooldown.
  const g2 = grant(h, T0 + 400_000, 'job-re');
  assert.ok(g2.ok, `re-grant after a failure past the cooldown: ${JSON.stringify(g2)}`);
  h.arbiter.finishLease({ lease_id: g2.lease!.lease_id, ok: true, tokens_out: 90, score: 6.1, now: T0 + 401_000 });

  const rows = Object.values(h.store.state.results).filter((r) => r.job_id === 'job-re');
  assert.equal(rows.length, 1, 'one row per (project, job_id) — the second report replaced the first');
  assert.equal(rows[0]!.ok, true);
  assert.equal(rows[0]!.score, 6.1);
  assert.equal(rows[0]!.ts, new Date(T0 + 401_000).toISOString(), 'the row carries the NEW report time');
  rmSync(h.dir, { recursive: true, force: true });
});

test('results: cap eviction keeps the newest 200 rows per project (oldest by ts evicted)', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);
  assert.equal(h.store.resultsPerProjectCap, 200, 'the default per-project cap is 200');

  // 205 distinct jobs, each granted + finished (0 tokens so the daily budget
  // never gates the next grant).
  for (let i = 0; i < 205; i++) {
    const at = T0 + i * 1000;
    const g = grant(h, at, `job-cap-${i}`);
    assert.ok(g.ok, `grant ${i}: ${JSON.stringify(g)}`);
    h.arbiter.finishLease({ lease_id: g.lease!.lease_id, ok: true, score: i, now: at + 500 });
  }

  const rows = Object.values(h.store.state.results);
  assert.equal(rows.length, 200, 'capped at 200 rows for the project');
  const ids = new Set(rows.map((r) => r.job_id));
  for (let i = 0; i < 5; i++) assert.ok(!ids.has(`job-cap-${i}`), `the oldest row (job-cap-${i}) was evicted`);
  for (let i = 5; i < 205; i++) assert.ok(ids.has(`job-cap-${i}`), `the newest 200 rows survive (job-cap-${i})`);
  rmSync(h.dir, { recursive: true, force: true });
});

test('results: projectResults orders newest-first and honors limit + job_id filter', () => {
  const h = makeHarness();
  h.det.entries = mkEntries([400]);
  for (const [job, at] of [['job-a', 1000], ['job-b', 2000], ['job-c', 3000]] as const) {
    const g = grant(h, T0, job);
    assert.ok(g.ok);
    h.arbiter.finishLease({ lease_id: g.lease!.lease_id, ok: true, score: 1, now: T0 + at });
  }

  const all = h.arbiter.projectResults('career-ops');
  assert.deepEqual(all.map((r) => r.job_id), ['job-c', 'job-b', 'job-a'], 'newest first');
  assert.deepEqual(h.arbiter.projectResults('career-ops', { limit: 2 }).map((r) => r.job_id), ['job-c', 'job-b'], 'limit takes the newest N');
  assert.deepEqual(h.arbiter.projectResults('career-ops', { job_id: 'job-b' }).map((r) => r.job_id), ['job-b'], 'job_id filters to one job');
  assert.deepEqual(h.arbiter.projectResults('nope-proj'), [], 'a project with no rows returns empty (the ROUTE 404s on unknown project)');
  rmSync(h.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Model aliases (#66) — the arbiter-side alias pass: per-pair confirmation
// over the SAME probe map, the D4 winner rule with pin fall-through, and
// the drop-don't-reject publish posture. Fake fetcher steers the probe per
// row; no network.
// ---------------------------------------------------------------------------

/**
 * Harness for the alias pass: two declared rows (one credentialed), a
 * fetcher the test drives per row. `probe(lists)` runs ONE probeCatalog
 * cycle with the given per-row model lists (an entry omitted or null = the
 * probe FAILS for that row).
 */
function makeAliasHarness(probeMap: Record<string, string[] | null> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-alias-'));
  const store = new StateStore(join(dir, 'state.json'));
  const cfg: ServerConfig = {
    listen: 0,
    api_tokens: ['t'],
    llama_swap_url: 'http://fake',
    activity_path: '',
    log_glob: '',
    idle_seconds: 300,
    poll_ms: 15000,
    lease_ttl_seconds: 1800,
    lease_ttl_safety_factor: 2,
    lease_ttl_floor_seconds: 60,
    max_concurrent_leases: 1,
    job_fail_threshold: 5,
    job_cooldown_seconds: 300,
    projects: [],
    state_file: join(dir, 'state.json'),
  };
  const arbiter = new Arbiter(store, cfg, new FakeDetector() as never, {
    modelsFetcher: async (url) => {
      const key = url.includes('alpha') ? 'alpha' : url.includes('beta') ? 'beta' : 'watched';
      const list = probeMap[key];
      if (list === undefined || list === null) throw new Error('probe refused');
      return list;
    },
  });
  const a = arbiter.upsertServerConnection({ name: 'alpha', url: 'http://alpha.local:8080', activity_path: '', auth_token: 'tok-alpha', models: ['engine-a-id'] });
  const b = arbiter.upsertServerConnection({ name: 'beta', url: 'http://beta.local:9090', activity_path: '', models: ['engine-b-id'] });
  assert.ok(a.ok && b.ok);
  const idA = a.server!.id;
  const idB = b.server!.id;
  return { dir, store, arbiter, idA, idB };
}

// probeCatalog takes no argument; this alias helper drives the shared map.
function aliasProbe(arbiter: Arbiter, lists: Record<string, string[] | null>, map: Record<string, string[] | null>) {
  for (const k of ['alpha', 'beta', 'watched']) delete map[k];
  Object.assign(map, lists);
  return arbiter.probeCatalog();
}

test('#66 alias pass: pair CONFIRMED by the probe publishes probed; a probe-FALSED pair publishes declared (never falsely probed)', async () => {
  const map: Record<string, string[] | null> = {};
  const h = makeAliasHarness(map);
  try {
    const put = h.arbiter.putModelAlias({ alias: 'Flagship', pairs: [{ server_id: h.idA, model: 'engine-a-id' }, { server_id: h.idB, model: 'engine-b-id' }] });
    assert.ok(put.ok, JSON.stringify(put));

    // Row alpha answers with the pair id; row beta's probe FAILS (401 shape).
    await aliasProbe(h.arbiter, { alpha: ['engine-a-id'] }, map);
    const block = h.arbiter.modelAliases();
    assert.equal(block.length, 1);
    const entry = block[0]!;
    assert.equal(entry.name, 'Flagship');
    assert.equal(entry.server_id, h.idA, 'alpha confirmed → it owns the alias (first surviving pair)');
    assert.equal(entry.engine_model, 'engine-a-id', 'the winner pair engine-OWN id publishes');
    assert.equal(entry.catalog_source, 'probed', 'a probe-confirmed pair is honest-probed');
    assert.equal(entry.auth_set, true, 'auth_set rides from the row; the token never does');
    assert.ok(!JSON.stringify(block).includes('tok-alpha'), 'the row token NEVER enters the publish block');

    // alpha now refuses the probe: its pair is UNCONFIRMED-but-not-refuted
    // → it publishes 'declared' (the honest #64 reading).
    await aliasProbe(h.arbiter, {}, map);
    const second = h.arbiter.modelAliases()[0]!;
    assert.ok(second, 'the alias survives a fully-failed probe (pairs stand, publish filters)');
    assert.equal(second.catalog_source, 'declared', 'a probe-failed row is never falsely probed');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('#66 alias pass: a probe-succeeded row that lacks the id DROPS the pair for the tick — the alias survives on the other pair', async () => {
  const map: Record<string, string[] | null> = {};
  const h = makeAliasHarness(map);
  try {
    h.arbiter.putModelAlias({ alias: 'Flagship', pairs: [{ server_id: h.idA, model: 'engine-a-id' }, { server_id: h.idB, model: 'engine-b-id' }] });

    // alpha probes successfully WITHOUT the pair id; beta fails (declared).
    await aliasProbe(h.arbiter, { alpha: ['something-else'] }, map);
    let block = h.arbiter.modelAliases();
    assert.equal(block.length, 1, 'the alias survives (the alias never drops — the pair does)');
    assert.equal(block[0]!.server_id, h.idB, 'the dead alpha pair is gone this tick; beta carries the alias');
    assert.equal(block[0]!.catalog_source, 'declared');

    // alpha lists it again: the pair returns (stored pairs stand).
    await aliasProbe(h.arbiter, { alpha: ['engine-a-id'] }, map);
    block = h.arbiter.modelAliases();
    assert.equal(block[0]!.server_id, h.idA, 'the pair is back for the next tick');
    assert.equal(block[0]!.catalog_source, 'probed');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('#66 alias pass: ALL pairs dead for a tick → the alias is not published at all (never a silent half-name)', async () => {
  const map: Record<string, string[] | null> = {};
  const h = makeAliasHarness(map);
  try {
    h.arbiter.putModelAlias({ alias: 'Flagship', pairs: [{ server_id: h.idA, model: 'engine-a-id' }, { server_id: h.idB, model: 'engine-b-id' }] });
    // Both rows probe SUCCESSFULLY and neither lists the pair id.
    await aliasProbe(h.arbiter, { alpha: ['not-it'], beta: ['not-it-either'] }, map);
    assert.deepEqual(h.arbiter.modelAliases(), [], 'no surviving pair → the alias is not offered this tick');

    // The stored pairs stand: alpha recovers its probe but WITHOUT the id
    // (its pair stays dropped), beta lists the id → beta carries the alias.
    await aliasProbe(h.arbiter, { alpha: ['not-it'], beta: ['engine-b-id'] }, map);
    const block = h.arbiter.modelAliases();
    assert.equal(block.length, 1);
    assert.equal(block[0]!.server_id, h.idB, 'stored pairs were never mutated by the drop');
    assert.equal(block[0]!.catalog_source, 'probed');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('#66 winner rule (D4): stored pin wins; absent pin / pin row gone / pin pair unconfirmed → first SURVIVING pair', async () => {
  const map: Record<string, string[] | null> = {};
  const h = makeAliasHarness(map);
  try {
    h.arbiter.putModelAlias({
      alias: 'Flagship',
      pairs: [{ server_id: h.idA, model: 'engine-a-id' }, { server_id: h.idB, model: 'engine-b-id' }],
      pin: h.idB,
    });

    // Both pairs confirmed: the stored pin (beta, the SECOND pair) wins.
    await aliasProbe(h.arbiter, { alpha: ['engine-a-id'], beta: ['engine-b-id'] }, map);
    assert.equal(h.arbiter.modelAliases()[0]!.server_id, h.idB, 'the explicit pin beats insertion order');

    // Pin pair unconfirmed (beta probes without the id): falls through to alpha.
    await aliasProbe(h.arbiter, { alpha: ['engine-a-id'], beta: ['gone'] }, map);
    assert.equal(h.arbiter.modelAliases()[0]!.server_id, h.idA, 'an unconfirmed pin pair falls through to the first surviving pair');

    // Pin cleared: insertion order decides.
    h.arbiter.putModelAlias({ alias: 'Flagship', pin: null });
    await aliasProbe(h.arbiter, { alpha: ['engine-a-id'], beta: ['engine-b-id'] }, map);
    assert.equal(h.arbiter.modelAliases()[0]!.server_id, h.idA, 'absent pin = first pair in insertion order');

    // Pin row deleted entirely: fall through, and the alias stays publishable.
    const rows = h.store.state.servers;
    h.store.state.servers = rows.filter((r) => r.id !== h.idA);
    h.arbiter.putModelAlias({ alias: 'Flagship', pin: h.idA });
    await aliasProbe(h.arbiter, { beta: ['engine-b-id'] }, map);
    const block = h.arbiter.modelAliases();
    assert.equal(block.length, 1, 'the alias survives the dead pin');
    assert.equal(block[0]!.server_id, h.idB, 'a pin pointing at a GONE row falls through to the surviving pair');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("#66 publish-path sanitizers are drop-don't-reject: a hostile stored key publishes nothing but never throws", async () => {
  const map: Record<string, string[] | null> = {};
  const h = makeAliasHarness(map);
  try {
    // A pre-#66 / hand-edited state file can hold a hostile key: publish
    // drops it (the entry), the loader and the arbiter stay alive.
    h.store.state.model_aliases['bad\nname'] = {
      alias: 'bad\nname',
      pairs: [{ server_id: h.idA, model: 'engine-a-id' }],
      updated_at: Date.now(),
    };
    await aliasProbe(h.arbiter, { alpha: ['engine-a-id'] }, map);
    assert.deepEqual(h.arbiter.modelAliases(), [], 'the hostile alias is not published');
    assert.ok(h.store.state.model_aliases['bad\nname'], 'the stored row is untouched (publish filters, never rewrites)');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('#66 aliasRows: per-pair source markers for the dashboard (probed / declared / dropped / unprobed)', async () => {
  const map: Record<string, string[] | null> = {};
  const h = makeAliasHarness(map);
  try {
    h.arbiter.putModelAlias({
      alias: 'Flagship',
      pairs: [{ server_id: h.idA, model: 'engine-a-id' }, { server_id: h.idB, model: 'engine-b-id' }],
    });
    // Before any cycle: unprobed.
    assert.deepEqual(h.arbiter.aliasRows()[0]!.pairs.map((p) => p.source), ['unprobed', 'unprobed']);
    // Beta's ROW is deleted after the write (putModelAlias 400s an unknown
    // server_id at authoring; a row vanishing later is the live case).
    h.store.state.servers = h.store.state.servers.filter((r) => r.id !== h.idB);
    await aliasProbe(h.arbiter, { alpha: ['engine-a-id'], beta: ['nope'] }, map);
    const rows = h.arbiter.aliasRows();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.pairs.map((p) => p.source), ['probed', 'dropped'], 'confirmed pair / gone-row pair both render their marker');
    assert.ok(rows[0]!.pairs.every((p) => !('auth_token' in p)), 'the dashboard read carries no secret by construction');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// #67 — response phase sanitizer + the session engine-pin plane
// ---------------------------------------------------------------------------

test('#67 sessions: phase block — stored on register, cleared on the no-phase report, invalid dropped', () => {
  const h = makeMultiHarness();
  const r1 = h.arbiter.registerSession('s-phase', { phase: { state: 'thinking', at: T0 }, now: T0 });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.session!.phase, { state: 'thinking', at: T0 });
  // Last-write-wins.
  const r2 = h.arbiter.registerSession('s-phase', { phase: { state: 'tools', at: T0 + 500 }, now: T0 + 1000 });
  assert.deepEqual(r2.session!.phase, { state: 'tools', at: T0 + 500 });
  // Invalid blocks are DROPPED (never a rejected registration); the stored value stands.
  for (const bad of [
    { state: 'bogus', at: T0 },
    { state: 'output', at: -1 },
    { state: 'output', at: 1.5 },
    { state: 'output', at: 'x' },
    { state: 'output' },
    'output',
    [1, 2],
  ]) {
    const r = h.arbiter.registerSession('s-phase', { phase: bad, now: T0 + 2000 });
    assert.equal(r.ok, true, `invalid phase ${JSON.stringify(bad)} never rejects the registration`);
    assert.deepEqual(r.session!.phase, { state: 'tools', at: T0 + 500 }, 'invalid block leaves the stored phase untouched');
  }
  // ABSENT is the no-phase report (the gate-block posture): the stored phase CLEARS.
  const r3 = h.arbiter.registerSession('s-phase', { now: T0 + 3000 });
  assert.equal(r3.session!.phase, null, 'absent phase clears to null');
  // Re-set, then explicit null also clears.
  h.arbiter.registerSession('s-phase', { phase: { state: 'output', at: T0 + 4000 }, now: T0 + 4000 });
  const r4 = h.arbiter.registerSession('s-phase', { phase: null, now: T0 + 5000 });
  assert.equal(r4.session!.phase, null);
  // A row created WITHOUT a phase block carries phase = null (never tagged).
  const r5 = h.arbiter.registerSession('s-plain-67', { now: T0 });
  assert.equal(r5.session!.phase, null);
  rmSync(h.dir, { recursive: true, force: true });
});

test('#67 pins: set/clear a bare-name session pin — the row must carry the model (probed, else declared)', async () => {
  const map: Record<string, string[] | null> = {};
  const h = makeAliasHarness(map);
  const NOW = Date.now();
  // A session whose sniffed model is the shared name 'X' (both rows serve it).
  h.arbiter.registerSession('s-pin1', { now: NOW, history: { rpm: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1], model: 'X' } });
  // Row A serves X per the probe; row B does NOT (its probe lists only Y).
  await aliasProbe(h.arbiter, { alpha: ['X'], beta: ['Y'], watched: [] }, map);
  const good = h.arbiter.setSessionPin('s-pin1', h.idA);
  assert.equal(good.ok, true, 'a row whose probe carries the model is a legal target');
  assert.equal(good.pin!.server_id, h.idA);
  const bad = h.arbiter.setSessionPin('s-pin1', h.idB);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'row_lacks_model', 'the target row must actually serve the session model');
  // The bad write left the stored pin standing (drop-don't-reject at the write boundary: told AND no mutation).
  assert.equal(h.arbiter.sessionPinBlock('s-pin1', 'X')!.server_id, h.idA);
  // Probe-blocked rows fall back to the DECLARED list ONLY while the row
  // has no last-good probe: in THIS harness beta's probe answered ['Y']
  // earlier, so its inventory is ['Y'] and engine-b-id is refused.
  h.arbiter.registerSession('s-pin2', { now: NOW, history: { rpm: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1], model: 'engine-b-id' } });
  const staleList = h.arbiter.setSessionPin('s-pin2', h.idB);
  assert.equal(staleList.ok, false, 'a row with a last-good probe answers legality with THAT list, not the declared one');
  rmSync(h.dir, { recursive: true, force: true });
  // A never-successfully-probed row falls back to its declared inventory.
  const h2 = makeAliasHarness({ alpha: null, beta: null, watched: null });
  h2.arbiter.registerSession('s-pin3', { now: NOW, history: { rpm: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1], model: 'engine-b-id' } });
  const declaredOk = h2.arbiter.setSessionPin('s-pin3', h2.idB);
  assert.equal(declaredOk.ok, true, 'a row that never answered a probe falls back to its declared inventory');
  // Unknown session / unknown server / garbage server_id.
  assert.equal(h2.arbiter.setSessionPin('s-nope', h2.idA).reason, 'unknown_session');
  assert.equal(h2.arbiter.setSessionPin('s-pin3', 'srv-gone').reason, 'unknown_server');
  assert.equal(h2.arbiter.setSessionPin('s-pin3', '').reason, 'server_id required (\u2264128 chars)');
  // Clear.
  const clr = h2.arbiter.setSessionPin('s-pin3', null);
  assert.equal(clr.ok, true);
  assert.equal(clr.pin, null);
  assert.equal(h2.arbiter.sessionPinBlock('s-pin3', 'engine-b-id'), undefined, 'a cleared pin publishes nothing');
  rmSync(h2.dir, { recursive: true, force: true });
});

test('#67 pins: an alias session may only pin one of the alias pair rows', async () => {
  const map: Record<string, string[] | null> = {};
  const h = makeAliasHarness(map);
  const NOW = Date.now();
  // Alias 'Flag' pairs alpha:engine-a-id + beta:engine-b-id.
  const up = h.arbiter.putModelAlias({ alias: 'Flag', pairs: [{ server_id: h.idA, model: 'engine-a-id' }, { server_id: h.idB, model: 'engine-b-id' }] });
  assert.equal(up.ok, true);
  const g = h.arbiter.upsertServerConnection({ name: 'gamma', url: 'http://gamma.local:7070', activity_path: '', models: ['engine-g-id'] });
  assert.ok(g.ok);
  await aliasProbe(h.arbiter, { alpha: ['engine-a-id'], beta: ['engine-b-id'], watched: [] }, map);
  h.arbiter.registerSession('s-alias', { now: NOW, history: { rpm: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1], model: 'Flag' } });
  // Both pair rows legal.
  assert.equal(h.arbiter.setSessionPin('s-alias', h.idB).ok, true);
  // A third row (gamma, exists, serves nothing of this alias) is NOT a pair → refused.
  assert.equal(h.arbiter.setSessionPin('s-alias', g.server!.id).reason, 'not_an_alias_pair');
  // Resolution: pin at beta → the beta pair's engine id rides for the splice.
  const blk = h.arbiter.sessionPinBlock('s-alias', 'Flag')!;
  assert.equal(blk.server_id, h.idB);
  assert.equal(blk.engine_model, 'engine-b-id', 'the pinned row serves the alias under ITS OWN id — the splice key rides published');
  assert.ok(blk.url.includes('beta.local'));
  // Pin back at alpha: that row serves the alias under 'engine-a-id'.
  h.arbiter.setSessionPin('s-alias', h.idA);
  assert.equal(h.arbiter.sessionPinBlock('s-alias', 'Flag')!.engine_model, 'engine-a-id');
  rmSync(h.dir, { recursive: true, force: true });
});

test('#67 pins: a session with no sniffed model still pins by row existence; the block resolves url-only', () => {
  const map: Record<string, string[] | null> = {};
  const h = makeAliasHarness(map);
  const NOW = Date.now();
  h.arbiter.registerSession('s-nomodel', { now: NOW });
  const res = h.arbiter.setSessionPin('s-nomodel', h.idA);
  assert.equal(res.ok, true, 'no known model ⇒ legality cannot be proven; the row-exists check still applies');
  const blk = h.arbiter.sessionPinBlock('s-nomodel', undefined)!;
  assert.equal(blk.server_id, h.idA);
  assert.equal('engine_model' in blk, false, 'no model ⇒ no splice key');
  rmSync(h.dir, { recursive: true, force: true });
});

test('#67 pins: sweep orphans a pin with its session row', async () => {
  const h = makeMultiHarness();
  const NOW = Date.now();
  h.arbiter.registerSession('s-sweep', { now: NOW });
  h.arbiter.setSessionPin('s-sweep', h.serverB);
  assert.ok(h.store.state.session_pins['s-sweep']);
  // Push the row past the stale window and tick.
  const st = h.store.state;
  st.sessions[0]!.last_seen = NOW - Arbiter.SESSION_STALE_MS - 1000;
  await h.arbiter.tick(NOW + 10_000);
  assert.equal(st.sessions.length, 0, 'the stale row swept');
  assert.equal(st.session_pins['s-sweep'], undefined, 'the pin went with it — a standing choice never outlives its session');
  rmSync(h.dir, { recursive: true, force: true });
});
