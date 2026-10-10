/**
 * hermes-jobs.test.ts — issue #85 slice D, arbiter side: the `hermes_jobs`
 * ADD-key (HERMES' own scheduled jobs — the naming rule is the issue's:
 * Hermes jobs, NOT idlefill's job queue).
 *
 * The ADD-keys-only wire invariants (the acceptance list):
 *   - valid stores: a clean block lands on the client row and echoes on
 *     /api/state (clients row) + the Projects worker rows (the strip data
 *     for the dashboard's "Hermes jobs" card);
 *   - drop-don't-poison sanitize: a non-array drops the whole key, each
 *     member is checked individually (malformed member dropped, row kept),
 *     rows bounded at 100, hostile EXTRA members (prompt/deliver/workdir/
 *     latest_execution) have no landing place and are dropped — the state
 *     file never grows a private member;
 *   - absent never clears: an old-shaped register body (no key), or an
 *     all-garbage/non-array block, leaves the stored block exactly as it
 *     was — and a client that never sent the key has a row that is
 *     byte-for-byte the pre-#85-D shape (no `hermes_jobs` key at all).
 *
 * End-to-end through the REAL Fastify app on an ephemeral loopback port
 * (the hermes-meta.test.ts harness pattern) — no network beyond loopback.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApi, attachWebSocket } from '../src/api.js';
import { Arbiter, cleanHermesJobs } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import type { ServerConfig } from '../src/types.js';

const TOKEN = 'test-token-123';
const T0 = Date.parse('2026-09-25T12:00:00Z');

let dir: string;
let cfg: ServerConfig;
let app: ReturnType<typeof buildApi>;
let arbiter: Arbiter;
let base: string;
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-85d-server-'));
  cfg = {
    listen: 0,
    api_tokens: [TOKEN],
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    log_glob: '',
    idle_seconds: 300,
    poll_ms: 60_000, // tests drive ticks manually
    lease_ttl_seconds: 1800,
    lease_ttl_safety_factor: 2,
    lease_ttl_floor_seconds: 60,
    max_concurrent_leases: 1,
    job_fail_threshold: 5,
    job_cooldown_seconds: 300,
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 10_000 }],
    state_file: join(dir, 'state.json'),
  };
  const store = new StateStore(cfg.state_file);
  arbiter = new Arbiter(store, cfg, {
    poll: async () => ({
      now: T0,
      idle: true,
      idle_for_s: 600,
      last_activity: null,
      last_log_write: null,
      signal_degraded: false,
      degraded_reason: null,
    }),
    signal: () => null,
  } as never);
  app = buildApi({ arbiter, cfg, publicDir: join(dir, 'public') });
  attachWebSocket(app, arbiter, cfg);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

// A live-shaped sanitized block as the CLIENT publishes it (slice D shape).
const JOBS = [
  {
    profile: 'default',
    id: '2855f9357016',
    name: 'infra-watch-nightly',
    schedule: 'every day at 6:00',
    enabled: false,
    state: 'paused',
    last_run: Date.parse('2026-10-08T10:01:17Z'),
    next_run: Date.parse('2026-10-09T10:00:00Z'),
  },
  { profile: 'web-dev', id: 'c166624ac8bf', schedule: 'every day at 2am', enabled: true, state: 'scheduled' },
];

async function register(name: string, extra: Record<string, unknown> = {}) {
  return fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name,
      projects: [{ name: 'career-ops', model: 'm', estimated_seconds: 100, queue_depth: 0 }],
      ...extra,
    }),
  });
}

async function state() {
  const res = await fetch(`${base}/api/state?limit=10&token=${TOKEN}`);
  return (await res.json()) as {
    clients: { name: string; hermes_jobs?: Record<string, unknown>[] }[];
    projects: { name: string; workers: { client: string; hermes_jobs?: Record<string, unknown>[] }[] }[];
  };
}

test('valid stores: hermes_jobs lands on the client row + echoes on /api/state clients AND the Projects workers', async () => {
  const reg = await register('jobs-store-client', { hermes_jobs: JOBS });
  assert.equal(reg.status, 200);
  const st = await state();
  const row = st.clients.find((c) => c.name === 'jobs-store-client');
  assert.ok(row);
  assert.ok(Array.isArray(row.hermes_jobs));
  assert.equal(row.hermes_jobs!.length, 2);
  assert.deepEqual(row.hermes_jobs![0], JOBS[0]);
  // The strip data reaches the worker rows too (the Overview card groups
  // per client; the join is the client row echoed through projectView).
  const worker = st.projects.find((p) => p.name === 'career-ops')?.workers.find((w) => w.client === 'jobs-store-client');
  assert.ok(worker?.hermes_jobs, 'the worker row echoes the block exception-only');
  assert.equal(worker!.hermes_jobs!.length, 2);
});

test("drop-don't-poison: malformed rows dropped individually, hostile EXTRA members have nowhere to land", async () => {
  const poison = [
    'not-a-row',
    null,
    { name: 'no id' }, // id missing ⇒ row dropped whole
    { id: 'ok-1', prompt: 'PRIVATE PROMPT SHOULD NEVER STORE', workdir: '/secret/path', deliver: 'discord:123', latest_execution: { pid: 1 } },
    { id: 'ok-2', name: 'x'.repeat(300), schedule: 's'.repeat(300), state: 'st'.repeat(50), enabled: 'truthy', last_run: 'yesterday', next_run: 5e15 },
  ];
  const reg = await register('jobs-poison-client', { hermes_jobs: poison });
  assert.equal(reg.status, 200, 'a malformed block is never a rejection');
  const st = await state();
  const row = st.clients.find((c) => c.name === 'jobs-poison-client');
  assert.ok(row?.hermes_jobs);
  assert.deepEqual(
    row!.hermes_jobs!.map((r) => r.id),
    ['ok-1', 'ok-2'],
  );
  const r1 = row!.hermes_jobs![0];
  assert.equal(r1.id, 'ok-1');
  for (const forbidden of ['prompt', 'workdir', 'deliver', 'latest_execution', 'PRIVATE', '/secret/path', 'discord:']) {
    assert.ok(!(forbidden in r1), `the state row carries no ${forbidden} member`);
  }
  const r2 = row!.hermes_jobs![1];
  assert.equal(r2.name, undefined, 'an over-long name is DROPPED at the arbiter edge (the client caps at 128; an over-cap member never enters the state file)');
  assert.equal(r2.schedule, undefined, 'an over-long schedule is dropped the same way');
  assert.equal(r2.state, undefined, 'an over-long state is dropped');
  assert.equal(r2.enabled, undefined, 'non-boolean enabled dropped');
  assert.equal(r2.last_run, undefined, 'non-numeric time dropped');
  assert.equal(r2.next_run, undefined, 'out-of-range time dropped');
});

test('absent never clears + old shape stays byte-for-byte: a keyless register leaves stored rows untouched', async () => {
  await register('jobs-old-client'); // never carries the key at all
  let st = await state();
  let row = st.clients.find((c) => c.name === 'jobs-old-client')!;
  const before = JSON.stringify(row);
  assert.ok(!('hermes_jobs' in row), 'a client that never sent the key has a byte-for-byte pre-#85-D row');
  // Re-register still keyless: row unchanged.
  await register('jobs-old-client');
  st = await state();
  row = st.clients.find((c) => c.name === 'jobs-old-client')!;
  assert.equal(JSON.stringify({ ...row, last_seen: 0 }), JSON.stringify({ ...JSON.parse(before), last_seen: 0 }), 'the row is byte-for-byte unchanged by keyless heartbeats');

  // A client WITH a stored block, re-registering WITHOUT the key: the block stands.
  await register('jobs-holdout', { hermes_jobs: JOBS });
  st = await state();
  const stored = (st.clients.find((c) => c.name === 'jobs-holdout')!.hermes_jobs ?? []).length;
  assert.equal(stored, 2);
  await register('jobs-holdout'); // old-shaped heartbeat (gateway outage / pre-#85-D restart)
  st = await state();
  assert.equal((st.clients.find((c) => c.name === 'jobs-holdout')!.hermes_jobs ?? []).length, 2, 'absent NEVER clears the stored block');

  // A non-array block on the wire: treated as ABSENT (stored value stands).
  await register('jobs-holdout', { hermes_jobs: 'nope' as never });
  st = await state();
  assert.equal((st.clients.find((c) => c.name === 'jobs-holdout')!.hermes_jobs ?? []).length, 2, 'a malformed non-array block never clears either');

  // An all-garbage array sanitizes to nothing ⇒ also ABSENT ⇒ stands.
  await register('jobs-holdout', { hermes_jobs: [{ no_id: 1 }, 7, null] });
  st = await state();
  assert.equal((st.clients.find((c) => c.name === 'jobs-holdout')!.hermes_jobs ?? []).length, 2, 'an all-dropped array never clears the stored block');
});

test('cleanHermesJobs unit: caps (100 rows, per-member strings), non-array → undefined, all-dropped → undefined', () => {
  assert.equal(cleanHermesJobs(undefined), undefined);
  assert.equal(cleanHermesJobs('nope'), undefined);
  assert.equal(cleanHermesJobs({ nope: true }), undefined);
  assert.equal(cleanHermesJobs([]), undefined);
  assert.equal(cleanHermesJobs([{ bad: 1 }, 'x']), undefined, 'all-dropped ⇒ absent (never an empty list stored)');
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `j${i}` }));
  const capped = cleanHermesJobs(many)!;
  assert.equal(capped.length, 100, 'bounded hard at 100 rows');
  const mixed = cleanHermesJobs([
    { id: '  spaced  ' },
    { id: 'x'.repeat(65) }, // id over cap ⇒ row dropped (cannot attribute)
    { id: 'ok', profile: '  web-dev ', name: ' n ', state: 'scheduled' },
  ])!;
  assert.deepEqual(mixed.map((r) => r.id), ['spaced', 'ok'], 'ids trimmed; over-long id dropped');
  assert.equal(mixed[1].profile, 'web-dev', 'members trimmed');
});

test('naming invariant: the wire key is exactly `hermes_jobs` — no bare `jobs` key is ever stored or echoed', async () => {
  await register('jobs-naming', { hermes_jobs: JOBS, jobs: [{ id: 'fake-idlefill-job' }] } as never);
  const st = await state();
  const row = st.clients.find((c) => c.name === 'jobs-naming')!;
  assert.ok('hermes_jobs' in row, 'the ADD-key carries the HERMES prefix');
  assert.ok(!('jobs' in row), 'a bare `jobs` key on the register body is NOT consumed into the row — the collision is refused by shape');
});
