// host.test.ts — the coarse host counters (the htop-equivalent slice,
// owner ask 2026-10-11). Covers: collectHostStats reads real machine
// facts from node:os (per-key tolerant); sanitizeHostStats drops garbage
// per key (never a fake zero, never a crash) and yields ABSENT when
// nothing is credible; the MeshSnapshot ADD-key edges — a publisher with
// host stats carries them, a pre-key publisher's snapshot stays
// byte-for-byte unchanged through build AND sanitize.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectHostStats, sanitizeHostStats } from '../src/host.js';
import { buildMeshSnapshot, sanitizeSnapshot } from '../src/mesh.js';

test('collectHostStats: real machine facts, finite and plausible', () => {
  const h = collectHostStats();
  assert.ok(h.cpus !== undefined && h.cpus! >= 1, 'cpu count is collectible here');
  assert.ok(h.mem_total_bytes !== undefined && h.mem_total_bytes! > 0);
  assert.ok(h.mem_free_bytes !== undefined && h.mem_free_bytes! >= 0 && h.mem_free_bytes! <= h.mem_total_bytes!);
  assert.ok(h.uptime_s !== undefined && h.uptime_s! >= 0);
  for (const k of ['load1', 'load5', 'load15'] as const) {
    if (h[k] !== undefined) assert.ok(Number.isFinite(h[k]) && h[k]! >= 0, `${k} finite when present`);
  }
});

test('sanitizeHostStats: garbage drops per KEY, never a fake zero', () => {
  const out = sanitizeHostStats({
    load1: '0.5', // string — dropped
    load5: -3, // negative — dropped
    load15: 1e9, // absurd — dropped
    cpus: 99_999, // beyond any real box — dropped
    mem_total_bytes: 34_359_738_368, // survives
    uptime_s: 12_345, // survives
  });
  assert.deepEqual(out, { mem_total_bytes: 34_359_738_368, uptime_s: 12_345 });
});

test('sanitizeHostStats: nothing credible → the whole block is ABSENT', () => {
  for (const junk of [undefined, null, 'host', [], {}, { load1: NaN }, { cpus: -1 }]) {
    assert.equal(sanitizeHostStats(junk), undefined);
  }
});

test('buildMeshSnapshot: host is an ADD key — absent keeps the snapshot unchanged', () => {
  const bare = buildMeshSnapshot('m-1', 'urza', [], 0, 0, 0, 0, '2');
  assert.equal('host' in bare, false, 'a publisher that passes no host block publishes none');
  const withHost = buildMeshSnapshot('m-1', 'urza', [], 0, 0, 0, 0, '2', undefined, undefined, {
    load1: 1.25,
    cpus: 8,
    mem_total_bytes: 1_000,
    mem_free_bytes: 500,
    uptime_s: 60,
  });
  assert.deepEqual(withHost.host, { load1: 1.25, cpus: 8, mem_total_bytes: 1_000, mem_free_bytes: 500, uptime_s: 60 });
  const { host: _h, ...rest } = withHost;
  assert.deepEqual(rest, bare, 'everything but the host key is byte-for-byte the same');
});

test('sanitizeSnapshot: a peer host block is sanitized per key; absent/old stays absent', () => {
  const base = { instance_id: 'm-2', name: 'peer', ts: 1000, servers: [], queue_depth: 1, sessions: 0, active_leases: 0 };
  const old = sanitizeSnapshot(base);
  assert.ok(old);
  assert.equal('host' in old, false, 'a pre-key peer parses through unchanged');
  const hostile = sanitizeSnapshot({ ...base, host: { load1: 'x', cpus: 3, mem_free_bytes: -5 } });
  assert.ok(hostile);
  assert.deepEqual(hostile.host, { cpus: 3 });
  const junk = sanitizeSnapshot({ ...base, host: 'not-a-block' });
  assert.ok(junk);
  assert.equal('host' in junk, false);
});
