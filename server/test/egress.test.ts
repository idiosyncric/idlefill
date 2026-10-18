/**
 * egress.test.ts — the server half of the egress self-diagnosis (the
 * 2026-10-18 firewall-blindness fix: the client publishes the connection
 * failures of its OWN forwarding sockets; the arbiter stores/echoes them
 * so the dashboard can finally say "THIS machine cannot reach that engine"
 * while every engine-side view stays green).
 *
 * Covers (following the agent-roster.test.ts style — real Fastify app on an
 * ephemeral loopback port):
 *   - the `cleanEgressFailures` sanitizer: valid rows verbatim; malformed
 *     MEMBERS drop individually; errno CODES only take the uppercase errno
 *     shape; `at` must be a finite epoch-ms; rows bounded at 8;
 *     a NON-ARRAY → undefined (absent); an EMPTY array stays EMPTY (it is
 *     the explicit recovered report — distinct from absent, by design);
 *   - the register heartbeat ledger (the CLIENT_LOG rule, not the roster
 *     rule): a non-empty list stores and echoes on /api/state AND rides the
 *     /api/projects worker row (exception-only); an ABSENT report NEVER
 *     clears; an explicit empty report DELETES the key (recovery clears
 *     within one heartbeat); a present-but-all-malformed array cleans to
 *     empty → also a delete (the client meant "no exception").
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApi, attachWebSocket } from '../src/api.js';
import { Arbiter, cleanEgressFailures } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import type { ServerConfig } from '../src/types.js';

const TOKEN = 'egress-token-123';
const __dirname = dirname(fileURLToPath(import.meta.url));

let dir: string;
let app: ReturnType<typeof buildApi>;
let arbiter: Arbiter;
let cfg: ServerConfig;
let base: string;
let det: IdleDetector;

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-egress-'));
  cfg = {
    listen: 0,
    api_tokens: [TOKEN],
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    server_name: 'llama-swap',
    server_models: ['Qwen3.8-27B'],
    server_peers: [],
    log_glob: '',
    idle_seconds: 300,
    poll_ms: 60_000,
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
  det = new IdleDetector({
    fetchActivity: async () => [],
    logMtime: () => null,
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: '',
    idle_seconds: cfg.idle_seconds,
  });
  arbiter = new Arbiter(store, cfg, det);
  app = buildApi({ arbiter, cfg, publicDir: join(__dirname, 'fixtures', 'dashboard') });
  attachWebSocket(app, arbiter, cfg);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// cleanEgressFailures — the sanitizer
// ---------------------------------------------------------------------------

const T = Date.parse('2026-10-18T13:00:00Z');

test('cleanEgressFailures: valid rows pass through (at floored)', () => {
  const rows = cleanEgressFailures([
    { server_id: 'srv-f1c85327', code: 'EHOSTUNREACH', host: '10.10.10.6', at: T + 0.9 },
    { server_id: 'srv-x', code: 'EACCES', host: 'scanbot.lan', at: T },
  ]);
  assert.deepEqual(rows, [
    { server_id: 'srv-f1c85327', code: 'EHOSTUNREACH', host: '10.10.10.6', at: T },
    { server_id: 'srv-x', code: 'EACCES', host: 'scanbot.lan', at: T },
  ]);
});

test('cleanEgressFailures: malformed members drop individually (drop-don\'t-reject)', () => {
  const rows = cleanEgressFailures([
    { server_id: 'srv-ok', code: 'ETIMEDOUT', host: 'h', at: T },
    { server_id: '', code: 'EACCES', host: 'h', at: T }, // empty server_id → dropped
    { server_id: 's'.repeat(65), code: 'EACCES', host: 'h', at: T }, // over 64 → dropped
    { server_id: 'srv-b1', code: 'boom', host: 'h', at: T }, // lowercase code → dropped
    { server_id: 'srv-b2', code: 'E'.repeat(33), host: 'h', at: T }, // over 32 → dropped
    { server_id: 'srv-b3', code: 'EACCES', host: '', at: T }, // empty host → dropped
    { server_id: 'srv-b4', code: 'EACCES', host: 'h', at: 'now' }, // non-number at → dropped
    { server_id: 'srv-b5', code: 'EACCES', host: 'h', at: -1 }, // negative at → dropped
    { server_id: 'srv-b6', code: 'EACCES', host: 'h', at: 1e18 }, // beyond epoch-ms → dropped
    'garbage', // non-object → dropped
  ]);
  assert.ok(rows);
  assert.equal(rows!.length, 1);
  assert.equal(rows![0]!.server_id, 'srv-ok');
});

test('cleanEgressFailures: rows are bounded at 8 (first 8 kept, client contract is freshest-first)', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ server_id: `srv-${i}`, code: 'EHOSTUNREACH', host: 'h', at: T - i }));
  const rows = cleanEgressFailures(many);
  assert.equal(rows!.length, 8);
  assert.equal(rows![7]!.server_id, 'srv-7');
});

test('cleanEgressFailures: a NON-ARRAY is absent (undefined); an EMPTY array stays EMPTY', () => {
  assert.equal(cleanEgressFailures(undefined), undefined);
  assert.equal(cleanEgressFailures('nope'), undefined);
  assert.equal(cleanEgressFailures({ server_id: 'srv' }), undefined);
  assert.deepEqual(cleanEgressFailures([]), [], 'the explicit recovered report survives as an empty array');
  assert.deepEqual(cleanEgressFailures(['garbage']), [], 'an all-malformed array cleans to empty (also a clear-report)');
});

// ---------------------------------------------------------------------------
// Register heartbeat: the ledger over the real endpoint
// ---------------------------------------------------------------------------

type StateClients = { clients: { name: string; egress_failures?: { server_id: string; code: string }[] }[] };
type ProjectsView = { projects: { name: string; workers: { client: string; egress_failures?: unknown[] }[] }[] };

async function state(): Promise<StateClients> {
  return (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as StateClients;
}

async function register(body: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  return res.status;
}

test('register: a non-empty egress_failures stores, echoes on /api/state, AND rides the projects worker row', async () => {
  const failures = [{ server_id: 'srv-f1c85327', code: 'EHOSTUNREACH', host: '10.10.10.6', at: T }];
  assert.equal(await register({ name: 'egress-broken', ip: '100.94.165.102', projects: [{ name: 'career-ops', model: 'M', queue_depth: 0 }], egress_failures: failures }), 200);
  const st = await state();
  const row = st.clients.find((c) => c.name === 'egress-broken')!;
  assert.deepEqual(row.egress_failures, failures, 'the client row carries the ledger verbatim');
  const pv = (await (await fetch(`${base}/api/projects`, { headers: auth })).json()) as ProjectsView;
  const worker = pv.projects.find((p) => p.name === 'career-ops')!.workers.find((w) => w.client === 'egress-broken')!;
  assert.deepEqual(worker.egress_failures, failures, 'the worker row carries it too (the Projects badge data source)');
});

test('register: an ABSENT report NEVER clears the stored ledger (the ADD-key half)', async () => {
  assert.equal(await register({ name: 'egress-persist', egress_failures: [{ server_id: 'srv-a', code: 'EACCES', host: 'h', at: T }] }), 200);
  assert.equal(await register({ name: 'egress-persist' }), 200, 'a later heartbeat without the key (old client, no aggregate)');
  const row = (await state()).clients.find((c) => c.name === 'egress-persist')!;
  assert.equal(row.egress_failures?.length, 1, 'the absent report left the stored exception exactly as it was');
});

test('register: an explicit EMPTY report CLEARS the stored ledger within one heartbeat (recovery)', async () => {
  assert.equal(await register({ name: 'egress-recover', projects: [{ name: 'career-ops', model: 'M', queue_depth: 0 }], egress_failures: [{ server_id: 'srv-a', code: 'EHOSTUNREACH', host: 'h', at: T }] }), 200);
  assert.equal(await register({ name: 'egress-recover', projects: [{ name: 'career-ops', model: 'M', queue_depth: 0 }], egress_failures: [] }), 200, 'the client publishes [] on every clean tick');
  const row = (await state()).clients.find((c) => c.name === 'egress-recover')!;
  assert.equal(row.egress_failures, undefined, 'the recovered report DELETED the key (client_log rule)');
  const pv = (await (await fetch(`${base}/api/projects`, { headers: auth })).json()) as ProjectsView;
  const worker = pv.projects.find((p) => p.name === 'career-ops')!.workers.find((w) => w.client === 'egress-recover')!;
  assert.equal(worker.egress_failures, undefined, 'the worker row stops carrying the badge too');
});

test('register: a present-but-all-malformed array also clears (a clean report is a clean report)', async () => {
  assert.equal(await register({ name: 'egress-allbad', egress_failures: [{ server_id: 'srv-a', code: 'boom', host: 'h', at: T }] }), 200, 'lowercase code → cleaned to empty…');
  const seeded = (await state()).clients.find((c) => c.name === 'egress-allbad')!;
  assert.equal(seeded.egress_failures, undefined, '…so nothing stored on the fresh row');
  assert.equal(await register({ name: 'egress-allbad', egress_failures: [{ server_id: 'srv-a', code: 'EACCES', host: 'h', at: T }] }), 200, 'seed a real exception');
  assert.equal(await register({ name: 'egress-allbad', egress_failures: [{ server_id: '', code: 'EACCES', host: 'h', at: T }] }), 200, 'then a present array that cleans empty');
  assert.equal((await state()).clients.find((c) => c.name === 'egress-allbad')!.egress_failures, undefined, 'the empty-clean deletes the key');
});

test('register: a non-array egress_failures is absent, never a rejection and never a clear', async () => {
  assert.equal(await register({ name: 'egress-shape', egress_failures: [{ server_id: 'srv-a', code: 'EACCES', host: 'h', at: T }] }), 200);
  assert.equal(await register({ name: 'egress-shape', egress_failures: 'not-an-array' }), 200, 'malformed shape never rejects the heartbeat');
  const row = (await state()).clients.find((c) => c.name === 'egress-shape')!;
  assert.equal(row.egress_failures?.length, 1, 'the non-array was treated as ABSENT — the stored ledger stands');
});
