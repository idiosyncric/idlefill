/**
 * engine-groups.test.ts — the engine-health-routing + mutual-exclusion
 * build wave (docs/architecture/engine-health-routing.md D1–D5).
 *
 * Covers, against a controllable probe fetcher + injectable detectors +
 * real stored state (no network):
 *   - D2 winner chain: healthy pin wins (step 1); a dead pin re-routes to
 *     the first healthy pair (step 2, the 21:41 fix) with fallback=true;
 *     every-healthy-option-gone keeps the pin (step 3); no pin = first
 *     survivor (step 4, today's fall-through).
 *   - D2 hysteresis: one failed probe demotes, one good probe re-promotes.
 *   - D2 fallback ADD-key: present only when a stored pin exists and the
 *     winner is not it; absent on a pin-match and on a pinless alias.
 *   - D3 group veto: an engaged group peer filters chain steps 1-2 only —
 *     it NEVER vetoes the pin/first-survivor at steps 3-4.
 *   - D3 engaged determination: an active lease or a gate-'active' session
 *     engages a row; a gate-'queued' session does NOT.
 *   - D3 lease-plane group cap: a grant on a row in group G is refused
 *     group_busy when the group's active-lease count reaches max_concurrent.
 *   - D3 no-group byte-parity: with zero groups the lease path is unchanged
 *     (two different servers each get a lease under the per-server cap).
 *   - D5 group write validation: the alias authoring posture (unknown
 *     server 400, in-group dupe 400, one-row-per-group 400, positive-int
 *     cap, unknown delete 404).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Arbiter } from '../src/arbiter.js';
import { srcKey } from '../src/idle.js';
import { StateStore } from '../src/state.js';
import type { ActivityEntry, IdleSignal, ServerConfig } from '../src/types.js';

const T0 = Date.parse('2026-09-25T12:00:00Z');

/** Fake detector — the IdleDetector signal shape over a mutable entries list. */
class FakeDetector {
  entries: ActivityEntry[] = [];
  logMtime: number | null = null;
  fail = false;
  idleSeconds = 300;

  private compute(now: number, exempt: Set<string>): IdleSignal {
    const e = this.entries.find((x) => !exempt.has(srcKey(x.src)));
    const lastActivity = e ? { ts: Date.parse(e.timestamp), model: e.model, src: e.src } : null;
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
      feed_enabled: false,
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
    model: 'engine-a-id',
    req_path: '/v1/chat/completions',
    resp_status_code: 200,
  }));
}

/**
 * Two declared rows (alpha + beta), each with an injected detector, plus a
 * probe fetcher the test drives per row via `probe`. `probe(lists)` runs ONE
 * probeCatalog cycle with the given per-row model lists (an entry omitted or
 * null = that row's probe FAILS → the row's pairs publish 'declared').
 */
function makeGroupHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-groups-'));
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
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 100000 }],
    state_file: join(dir, 'state.json'),
  };
  const probeMap: Record<string, string[] | null> = {};
  const arbiter = new Arbiter(store, cfg, new FakeDetector() as never, {
    modelsFetcher: async (url) => {
      const key = url.includes('alpha') ? 'alpha' : url.includes('beta') ? 'beta' : url.includes('gamma') ? 'gamma' : 'none';
      const list = probeMap[key];
      if (list === undefined || list === null) throw new Error('probe refused');
      return list;
    },
  });
  arbiter.registerClient('mac', undefined, '100.94.165.102');
  const detA = new FakeDetector();
  const detB = new FakeDetector();
  const detG = new FakeDetector();
  detA.idleSeconds = 300;
  detB.idleSeconds = 300;
  detG.idleSeconds = 300;
  const a = arbiter.upsertServerConnection({ name: 'alpha', url: 'http://alpha.local:8080', activity_path: '', models: ['engine-a-id'] });
  const b = arbiter.upsertServerConnection({ name: 'beta', url: 'http://beta.local:9090', activity_path: '', models: ['engine-b-id'] });
  const g = arbiter.upsertServerConnection({ name: 'gamma', url: 'http://gamma.local:9100', activity_path: '', models: ['engine-g-id'] });
  assert.ok(a.ok && b.ok && g.ok);
  const idA = a.server!.id;
  const idB = b.server!.id;
  const idG = g.server!.id;
  (arbiter as unknown as { detectors: Map<string, unknown> }).detectors.set(idA, detA);
  (arbiter as unknown as { detectors: Map<string, unknown> }).detectors.set(idB, detB);
  (arbiter as unknown as { detectors: Map<string, unknown> }).detectors.set(idG, detG);
  const client = store.state.clients[0]!;

  function probe(lists: Record<string, string[] | null>) {
    for (const k of ['alpha', 'beta', 'gamma']) delete probeMap[k];
    Object.assign(probeMap, lists);
    return arbiter.probeCatalog();
  }
  return { dir, store, cfg, arbiter, detA, detB, detG, idA, idB, idG, client, probe };
}

// ---------------------------------------------------------------------------
// D2 winner chain
// ---------------------------------------------------------------------------

test('D2 step 1: a healthy pin wins; fallback is absent', async () => {
  const h = makeGroupHarness();
  try {
    h.arbiter.putModelAlias({
      alias: 'Flag',
      pairs: [
        { server_id: h.idA, model: 'engine-a-id' },
        { server_id: h.idB, model: 'engine-b-id' },
      ],
      pin: h.idA,
    });
    // Both rows probe healthy: the stored pin (alpha) wins.
    await h.probe({ alpha: ['engine-a-id'], beta: ['engine-b-id'] });
    const e = h.arbiter.modelAliases()[0]!;
    assert.equal(e.server_id, h.idA, 'the healthy pin wins (step 1)');
    assert.equal(e.catalog_source, 'probed');
    assert.equal('fallback' in e, false, 'no re-route → the fallback key is absent');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('D2 step 2: a dead pin re-routes to the first healthy pair (the 21:41 fix), fallback=true', async () => {
  const h = makeGroupHarness();
  try {
    h.arbiter.putModelAlias({
      alias: 'Flag',
      pairs: [
        { server_id: h.idA, model: 'engine-a-id' },
        { server_id: h.idB, model: 'engine-b-id' },
      ],
      pin: h.idA,
    });
    // alpha's probe FAILS (the pinned engine answers non-2xx); beta is healthy.
    await h.probe({ alpha: null, beta: ['engine-b-id'] });
    const e = h.arbiter.modelAliases()[0]!;
    assert.equal(e.server_id, h.idB, 'traffic moves to the next-best option (step 2)');
    assert.equal(e.catalog_source, 'probed');
    assert.equal(e.fallback, true, 'the winner is not the stored pin → fallback marks the re-route');
    assert.ok(!JSON.stringify(h.arbiter.modelAliases()).includes('alpha.local'), 'the dead pin never enters the winner fields');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('D2 step 3: every healthy option gone → the pin still names the engine (honest degrade)', async () => {
  const h = makeGroupHarness();
  try {
    h.arbiter.putModelAlias({
      alias: 'Flag',
      pairs: [
        { server_id: h.idA, model: 'engine-a-id' },
        { server_id: h.idB, model: 'engine-b-id' },
      ],
      pin: h.idA,
    });
    // BOTH rows fail their probe: both pairs survive as 'declared', none is healthy.
    await h.probe({ alpha: null, beta: null });
    const e = h.arbiter.modelAliases()[0]!;
    assert.equal(e.server_id, h.idA, 'the pin still wins (step 3) — the request fails there as today');
    assert.equal(e.catalog_source, 'declared', 'a probe-failed row is never falsely probed');
    assert.equal('fallback' in e, false, 'winner == pin → no fallback');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('D2 step 4: no pin → first surviving pair (today\u2019s fall-through)', async () => {
  const h = makeGroupHarness();
  try {
    h.arbiter.putModelAlias({
      alias: 'Flag',
      pairs: [
        { server_id: h.idA, model: 'engine-a-id' },
        { server_id: h.idB, model: 'engine-b-id' },
      ],
    });
    // alpha dead, beta healthy, no pin.
    await h.probe({ alpha: null, beta: ['engine-b-id'] });
    const e = h.arbiter.modelAliases()[0]!;
    assert.equal(e.server_id, h.idB, 'the surviving healthy pair carries the alias');
    assert.equal('fallback' in e, false, 'no stored pin → no fallback key');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('D2 hysteresis: one failed probe demotes, one good probe re-promotes', async () => {
  const h = makeGroupHarness();
  try {
    h.arbiter.putModelAlias({
      alias: 'Flag',
      pairs: [
        { server_id: h.idA, model: 'engine-a-id' },
        { server_id: h.idB, model: 'engine-b-id' },
      ],
      pin: h.idA,
    });
    // tick 1: pin healthy → pin.
    await h.probe({ alpha: ['engine-a-id'], beta: ['engine-b-id'] });
    assert.equal(h.arbiter.modelAliases()[0]!.server_id, h.idA, 'healthy pin wins');
    // tick 2: pin fails, beta healthy → re-route (fallback).
    await h.probe({ alpha: null, beta: ['engine-b-id'] });
    assert.equal(h.arbiter.modelAliases()[0]!.server_id, h.idB, 'one bad tick demotes the pin');
    assert.equal(h.arbiter.modelAliases()[0]!.fallback, true);
    // tick 3: pin healthy again → restored (fallback absent).
    await h.probe({ alpha: ['engine-a-id'], beta: ['engine-b-id'] });
    assert.equal(h.arbiter.modelAliases()[0]!.server_id, h.idA, 'one good tick re-promotes the pin');
    assert.equal('fallback' in h.arbiter.modelAliases()[0]!, false, 'restored → no fallback');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D3 group veto (chain filter, steps 1-2 only)
// ---------------------------------------------------------------------------

test('D3 group veto: an engaged group peer filters steps 1-2 (re-routes past the pin)', async () => {
  const h = makeGroupHarness();
  try {
    // One group over both rows; alpha is the pin.
    h.arbiter.putEngineGroup({ group_id: 'host-urza', server_ids: [h.idA, h.idB] });
    h.arbiter.putModelAlias({
      alias: 'Flag',
      pairs: [
        { server_id: h.idA, model: 'engine-a-id' },
        { server_id: h.idB, model: 'engine-b-id' },
      ],
      pin: h.idA,
    });
    // ENGAGE beta (the pin's group peer) with an active session.
    h.arbiter.registerSession('s-live', { server_id: h.idB, gate: { state: 'active', waiting: 0 }, now: T0 });
    // Both rows probe healthy. Step 1 (the pin) is group-blocked because its
    // peer (beta) is engaged → step 2 lands beta... but beta is engaged and is
    // the candidate's own row (not a peer), so peerFree(beta) is true.
    await h.probe({ alpha: ['engine-a-id'], beta: ['engine-b-id'] });
    const e = h.arbiter.modelAliases()[0]!;
    assert.equal(e.server_id, h.idB, 'the engaged peer re-routes the pin to the next-best option');
    assert.equal(e.fallback, true, 'winner is not the pin → fallback');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('D3 group veto: an engaged peer NEVER vetoes the pin at steps 3-4 (the only option wins)', async () => {
  const h = makeGroupHarness();
  try {
    h.arbiter.putEngineGroup({ group_id: 'host-urza', server_ids: [h.idA, h.idB] });
    h.arbiter.putModelAlias({
      alias: 'Flag',
      pairs: [
        { server_id: h.idA, model: 'engine-a-id' },
        { server_id: h.idB, model: 'engine-b-id' },
      ],
      pin: h.idA,
    });
    // ENGAGE beta, then make BOTH rows un-healthy (both pairs survive as 'declared').
    h.arbiter.registerSession('s-live', { server_id: h.idB, gate: { state: 'active', waiting: 0 }, now: T0 });
    await h.probe({ alpha: null, beta: null });
    const e = h.arbiter.modelAliases()[0]!;
    assert.equal(e.server_id, h.idA, 'the pin still wins (step 3) — an engaged peer is a preference, never a veto on the only option');
    assert.equal(e.catalog_source, 'declared');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('D3 engaged: a gate-active session engages; a gate-queued session does NOT', async () => {
  const h = makeGroupHarness();
  try {
    assert.equal(h.arbiter.rowEngaged(h.idA, T0), false, 'a fresh row is not engaged');
    // queued (parked) consumes no engine slot → not engaged.
    h.arbiter.registerSession('s-q', { server_id: h.idA, gate: { state: 'queued', waiting: 1 }, now: T0 });
    assert.equal(h.arbiter.rowEngaged(h.idA, T0), false, 'queued is not engaged');
    // active (holds a slot) → engaged.
    h.arbiter.registerSession('s-a', { server_id: h.idA, gate: { state: 'active', waiting: 0 }, now: T0 });
    assert.equal(h.arbiter.rowEngaged(h.idA, T0), true, 'an active session engages the row');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('D3 engaged: an active lease engages its row', async () => {
  const h = makeGroupHarness();
  try {
    h.detA.entries = mkEntries([400]); // alpha idle
    const g = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-1', estimated_seconds: 60, now: T0, server_id: h.idA });
    assert.equal(g.ok, true, `grant expected, got ${JSON.stringify(g)}`);
    assert.equal(h.arbiter.rowEngaged(h.idA, T0), true, 'an active lease engages its row');
    assert.equal(h.arbiter.rowEngaged(h.idB, T0), false, 'the other row stays un-engaged');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D3 lease-plane group cap
// ---------------------------------------------------------------------------

test('D3 lease cap: a group with max_concurrent=1 refuses the second member (group_busy)', async () => {
  const h = makeGroupHarness();
  try {
    h.arbiter.putEngineGroup({ group_id: 'host-urza', server_ids: [h.idA, h.idB] }); // default cap 1
    h.detA.entries = mkEntries([400]);
    h.detB.entries = mkEntries([400], 'ip:10.0.0.8');
    const r1 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-a', estimated_seconds: 60, now: T0, server_id: h.idA });
    assert.equal(r1.ok, true, `alpha grant expected, got ${JSON.stringify(r1)}`);
    const r2 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-b', estimated_seconds: 60, now: T0, server_id: h.idB });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'group_busy', 'the group already holds one active lease (its max_concurrent)');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('D3 lease cap: max_concurrent=2 admits two group members, refuses the third', async () => {
  const h = makeGroupHarness();
  try {
    // THREE members: the per-server cap (1) would let each row hold one
    // lease, so only the GROUP cap can refuse the third grant.
    h.arbiter.putEngineGroup({ group_id: 'host-urza', server_ids: [h.idA, h.idB, h.idG], max_concurrent: 2 });
    h.detA.entries = mkEntries([400]);
    h.detB.entries = mkEntries([400], 'ip:10.0.0.8');
    h.detG.entries = mkEntries([400], 'ip:10.0.0.7');
    assert.equal(h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-a', estimated_seconds: 60, now: T0, server_id: h.idA }).ok, true);
    assert.equal(h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-b', estimated_seconds: 60, now: T0, server_id: h.idB }).ok, true, 'the second member is admitted (cap 2)');
    const r3 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-c', estimated_seconds: 60, now: T0, server_id: h.idG });
    assert.equal(r3.ok, false);
    assert.equal(r3.reason, 'group_busy', 'the group already holds two active leases (its max_concurrent)');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('D3 no-group byte-parity: with zero groups, two different servers each get a lease (per-server cap)', async () => {
  const h = makeGroupHarness();
  try {
    // NO group is written. The per-server cap (max_concurrent_leases: 1) is the
    // only bound — two DIFFERENT servers each admit a lease, exactly as today.
    h.detA.entries = mkEntries([400]);
    h.detB.entries = mkEntries([400], 'ip:10.0.0.8');
    const rA = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-a', estimated_seconds: 60, now: T0, server_id: h.idA });
    assert.equal(rA.ok, true, `alpha grant expected, got ${JSON.stringify(rA)}`);
    const rB = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-b', estimated_seconds: 60, now: T0, server_id: h.idB });
    assert.equal(rB.ok, true, `beta grant expected (per-server cap, no group), got ${JSON.stringify(rB)}`);
    // A second lease on the SAME server is still 'busy' (the per-server path).
    const rA2 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-a2', estimated_seconds: 60, now: T0, server_id: h.idA });
    assert.equal(rA2.reason, 'busy', 'the per-server cap still bounds a single server');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D5 group write validation
// ---------------------------------------------------------------------------

test('D5 group write: create, re-write, and the validation posture', async () => {
  const h = makeGroupHarness();
  try {
    const up = h.arbiter.putEngineGroup({ group_id: 'host-urza', name: 'urza', server_ids: [h.idA] });
    assert.equal(up.ok, true, JSON.stringify(up));
    assert.equal(up.created, true);
    assert.equal(up.group!.max_concurrent, 1, 'absent cap defaults to 1 (hard exclusion)');
    assert.equal(up.group!.name, 'urza');
    assert.equal(h.arbiter.groupOf(h.idA)?.group_id, 'host-urza');

    // Re-write the same member is a no-op write, not a violation.
    const again = h.arbiter.putEngineGroup({ group_id: 'host-urza', server_ids: [h.idA], max_concurrent: 2 });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.created, false);
    assert.equal(again.group!.max_concurrent, 2);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('D5 group write: a single-member group is accepted (a no-op cap, no peer to vet)', async () => {
  const h = makeGroupHarness();
  try {
    const single = h.arbiter.putEngineGroup({ group_id: 'lone', server_ids: [h.idB] });
    assert.equal(single.ok, true, `single-member group accepted, got ${JSON.stringify(single)}`);
    assert.equal(single.group!.max_concurrent, 1);
    assert.equal(h.arbiter.groupOf(h.idB)?.group_id, 'lone');
    // A single-member group has no peer → the D3 chain filter is always free.
    assert.equal((h.arbiter as unknown as { groupEngagedPeer(id: string, now: number): boolean }).groupEngagedPeer(h.idB, T0), false, 'a lone row has no engaged peer');
    // It is still subject to the lease-plane cap (a self-exclusion is a no-op
    // cap: only this row counts, so one lease is admitted, the next group_busy).
    h.detB.entries = mkEntries([400], 'ip:10.0.0.8');
    assert.equal(h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-b', estimated_seconds: 60, now: T0, server_id: h.idB }).ok, true);
    const r2 = h.arbiter.requestLease({ client_id: h.client.client_id, project: 'career-ops', job_id: 'j-b2', estimated_seconds: 60, now: T0, server_id: h.idB });
    assert.equal(r2.ok, false, `the second same-row lease is bounded, got ${JSON.stringify(r2)}`);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('D5 group write: unknown server_id, in-group dupe, and one-row-per-group are refused (400 told)', async () => {
  const h = makeGroupHarness();
  try {
    assert.equal(h.arbiter.putEngineGroup({ group_id: 'g1', server_ids: ['srv-nope'] }).ok, false, 'unknown server_id refused');
    assert.equal(
      h.arbiter.putEngineGroup({ group_id: 'g1', server_ids: [h.idA, h.idA] }).ok,
      false,
      'a duplicated member inside one group is refused',
    );
    // One row per group: alpha is claimed by gA; a second group cannot claim it.
    assert.equal(h.arbiter.putEngineGroup({ group_id: 'gA', server_ids: [h.idA] }).ok, true);
    const cross = h.arbiter.putEngineGroup({ group_id: 'gB', server_ids: [h.idA, h.idB] });
    assert.equal(cross.ok, false, 'a row already in another group is refused');
    assert.match(cross.reason ?? '', /already belongs/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('D5 group write: max_concurrent must be a positive integer; delete of an unknown group is refused', async () => {
  const h = makeGroupHarness();
  try {
    assert.equal(h.arbiter.putEngineGroup({ group_id: 'g1', server_ids: [h.idA], max_concurrent: 0 }).ok, false, 'zero cap refused');
    assert.equal(h.arbiter.putEngineGroup({ group_id: 'g1', server_ids: [h.idA], max_concurrent: 1.5 }).ok, false, 'a fractional cap is refused');
    assert.equal(h.arbiter.putEngineGroup({ group_id: 'g1', server_ids: [h.idA], max_concurrent: -3 }).ok, false, 'a negative cap is refused');
    // Valid: the cap is stored.
    const up = h.arbiter.putEngineGroup({ group_id: 'g1', server_ids: [h.idA], max_concurrent: 4 });
    assert.equal(up.ok, true);
    assert.equal(up.group!.max_concurrent, 4);
    // Delete of the stored group works; a second delete is unknown_group.
    assert.equal(h.arbiter.putEngineGroup({ group_id: 'g1', delete: true }).ok, true);
    assert.equal(h.arbiter.putEngineGroup({ group_id: 'g1', delete: true }).reason, 'unknown_group');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
