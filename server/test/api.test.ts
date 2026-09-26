/**
 * api.test.ts — end-to-end HTTP/WS against a real Fastify app on an
 * ephemeral loopback port, with a steerable fake feed (in the fetcher
 * closure) — NO network access to urza or career-ops.
 *
 * Covers:
 *   - token auth: bad/missing token rejected on every API route (401),
 *     including the WS handshake
 *   - register → lease → usage round-trip (idempotent register, busy 409,
 *     duplicate finish, unknown lease 404)
 *   - busy system → 409 not_idle
 *   - dashboard HTML serves
 *   - /api/state shape
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { buildApi, attachWebSocket } from '../src/api.js';
import { Arbiter } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import type { ActivityEntry, ServerConfig } from '../src/types.js';

const T0 = Date.parse('2026-09-25T12:00:00Z');
const TOKEN = 'test-token-123';
const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Mutable feed the fake fetcher reads — tests steer it.
const entries: ActivityEntry[] = mkEntries([400]); // quiet → idle

let dir: string;
let app: ReturnType<typeof buildApi>;
let arbiter: Arbiter;
let cfg: ServerConfig;
let base: string;
let det: IdleDetector;
let clientId: string;

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-api-'));
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
    poll_ms: 60_000, // tests drive ticks manually; no background polling surprises
    lease_ttl_seconds: 1800,
    max_concurrent_leases: 1,
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 10_000 }],
    state_file: join(dir, 'state.json'),
  };
  const store = new StateStore(cfg.state_file);
  det = new IdleDetector({
    fetchActivity: async () => entries,
    logMtime: () => null,
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: '',
    idle_seconds: cfg.idle_seconds,
  });
  arbiter = new Arbiter(store, cfg, det);
  app = buildApi({ arbiter, cfg, publicDir: join(__dirname, '..', 'public') });
  attachWebSocket(app, arbiter, cfg);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;

  // register a client (also gives us an id for the not_idle test)
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'mac-test', ip: '100.94.165.102' }),
  });
  clientId = ((await reg.json()) as { client_id: string }).client_id;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test('bad token is rejected on every API route (401)', async () => {
  for (const [method, path] of [
    ['POST', '/api/clients/register'],
    ['POST', '/api/clients/mac-test/override'],
    ['POST', '/api/leases'],
    ['GET', '/api/leases'],
    ['POST', '/api/leases/l-x/usage'],
    ['GET', '/api/projects'],
    ['POST', '/api/projects/career-ops'],
    ['GET', '/api/state'],
  ] as const) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: 'Bearer WRONG', 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({}),
    });
    assert.equal(res.status, 401, `expected 401 on ${method} ${path} with a bad token`);
  }
  // query-string token variant (wrong value -> 401)
  const qs = new URLSearchParams({ token: "wrong" }).toString();
  const res = await fetch(`${base}/api/leases?${qs}`);
  assert.equal(res.status, 401, 'wrong query-string token also 401');
});

test('anonymous GET /api/state is the documented public read; wrong token is not', async () => {
  const anon = await fetch(`${base}/api/state`);
  assert.equal(anon.status, 200, 'anonymous state read is the phase-1 documented exception');
  // The dashboard appends ?limit=N — with a query string the anonymous read
  // must still be 200 (req.url carries the query; the exact-path check needs
  // it stripped or the dashboard would silently go "state unreachable").
  const anonQs = await fetch(`${base}/api/state?limit=5`);
  assert.equal(anonQs.status, 200, 'anonymous /api/state?limit=N stays a public read');
  const bad = await fetch(`${base}/api/state`, { headers: { authorization: 'Bearer NOPE' } });
  assert.equal(bad.status, 401, 'but if a token IS presented, it must be a good one');
});

test('register → lease → usage round-trip', async () => {
  // re-register: idempotent
  const reg2 = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'mac-test', ip: '100.94.165.102' }),
  });
  const reg2Body = (await reg2.json()) as { client_id: string; created: boolean };
  assert.equal(reg2Body.client_id, clientId, 'register is idempotent on name');
  assert.equal(reg2Body.created, false);

  // feed is quiet (400s) → grant succeeds
  await det.poll(Date.now(), new Set());
  const lease = await fetch(`${base}/api/leases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: 'job-abc', estimated_seconds: 60 }),
  });
  assert.equal(lease.status, 201, `expected 201, got ${lease.status} ${await lease.clone().text()}`);
  const leaseBody = (await lease.json()) as { lease_id: string; expires_at: number; ttl_seconds: number };
  assert.ok(leaseBody.lease_id.startsWith('l-'));
  assert.ok(leaseBody.ttl_seconds === 1800);

  // second concurrent lease → 409 busy
  const busy = await fetch(`${base}/api/leases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: 'job-xyz', estimated_seconds: 60 }),
  });
  assert.equal(busy.status, 409);
  assert.equal(((await busy.json()) as { reason: string }).reason, 'busy');

  // usage report (finish)
  const use = await fetch(`${base}/api/leases/${leaseBody.lease_id}/usage`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ ok: true, tokens_out: 1200, tokens_in: 40000 }),
  });
  assert.equal(use.status, 200);
  const useBody = (await use.json()) as { ok: boolean; lease?: { status: string } };
  assert.equal(useBody.ok, true);
  assert.equal(useBody.lease?.status, 'finished');

  // duplicate finish: 200, no double count (budget stays 1200)
  const use2 = await fetch(`${base}/api/leases/${leaseBody.lease_id}/usage`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ ok: true, tokens_out: 1200, tokens_in: 40000 }),
  });
  assert.equal(use2.status, 200);
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    projects: { name: string; budget_today: { tokens_out: number } }[];
  };
  assert.equal(st.projects.find((p) => p.name === 'career-ops')!.budget_today.tokens_out, 1200, 'no double count');

  // unknown lease → 404
  const miss = await fetch(`${base}/api/leases/l-nope/usage`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(miss.status, 404);
});

test('busy system returns 409 not_idle; unknown client 409 unknown_client', async () => {
  // Make the feed fresh (5s old) → not idle. Anchor timestamps to the REAL
  // clock, because det.poll(Date.now()) compares against it.
  entries.length = 0;
  entries.push(...mkEntries([5], 'ip:10.0.0.9', Date.now()));
  await det.poll(Date.now(), new Set());

  const res = await fetch(`${base}/api/leases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: 'x' }),
  });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { reason: string }).reason, 'not_idle');

  // unknown client (checked first)
  const res2 = await fetch(`${base}/api/leases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: 'c-nope', project: 'career-ops', job_id: 'x' }),
  });
  assert.equal(res2.status, 409);
  assert.equal(((await res2.json()) as { reason: string }).reason, 'unknown_client');
});

test('dashboard HTML serves (two-pane dashboard: Inference Servers + Projects)', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<html/);
  assert.match(html, /idlefill/);
  assert.match(html, /Inference Servers/);
  assert.match(html, /Projects/);
  assert.match(html, /api\/state/);
  assert.ok((res.headers.get('content-type') ?? '').includes('text/html'));
});

test('/api/state shape', async () => {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  const st = (await res.json()) as Record<string, unknown>;
  for (const key of ['now', 'idle', 'leases', 'active_leases', 'clients', 'projects', 'events']) {
    assert.ok(key in st, `state has ${key}`);
  }
  const idle = st.idle as Record<string, unknown>;
  for (const key of ['idle', 'degraded', 'reidle_gated', 'last_activity', 'last_log_write', 'idle_for_s']) {
    assert.ok(key in idle, `idle has ${key}`);
  }
  const proj = (st.projects as { name: string; budget_today: Record<string, number> }[]).find((p) => p.name === 'career-ops')!;
  assert.equal(typeof proj.budget_today.tokens_out, 'number');
  assert.ok('cap' in proj.budget_today);
  assert.ok((st.clients as unknown[]).length >= 1, 'registered client visible');
  const clientRow = (st.clients as { name: string; override: unknown }[]).find((c) => c.name === 'mac-test')!;
  assert.ok('override' in clientRow, 'client rows carry their (active or null) override');
});

test('per-project grant knobs: override + effective values + persistence', async () => {
  const get = () =>
    fetch(`${base}/api/state`, { headers: auth }).then((r) =>
      r.json() as Promise<{
        projects: {
          name: string;
          scheduling: {
            idle_seconds: number;
            max_concurrent_leases: number;
            lease_ttl_seconds: number;
            overrides: { idle_seconds: number | null; max_concurrent_leases: number | null; lease_ttl_seconds: number | null };
            global: { idle_seconds: number; max_concurrent_leases: number; lease_ttl_seconds: number };
          };
        }[];
      }>,
    );

  const set = (body: Record<string, unknown>) =>
    fetch(`${base}/api/projects/career-ops/settings`, { method: 'POST', headers: auth, body: JSON.stringify(body) }).then(async (r) => ({
      status: r.status,
      body: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    }));

  // bad shapes are rejected
  assert.equal((await set({ idle_seconds: 'soon' })).status, 400, 'non-numeric idle_seconds rejected');
  assert.equal((await set({ lease_ttl_seconds: -5 })).status, 400, 'non-positive ttl rejected');

  // a partial override updates only what is provided
  const upd = await set({ idle_seconds: 600, lease_ttl_seconds: 900 });
  assert.equal(upd.status, 200);
  assert.ok('overrides' in upd.body, 'the response echoes the raw overrides');

  const st1 = await get();
  const p1 = st1.projects.find((p) => p.name === 'career-ops')!;
  assert.equal(p1.scheduling.idle_seconds, 600, 'effective idle = the override');
  assert.equal(p1.scheduling.max_concurrent_leases, cfg.max_concurrent_leases, 'unset knob inherits the global');
  assert.equal(p1.scheduling.lease_ttl_seconds, 900);
  assert.deepEqual(p1.scheduling.overrides, { idle_seconds: 600, max_concurrent_leases: null, lease_ttl_seconds: 900 }, 'the raw overrides are visible');
  assert.deepEqual(p1.scheduling.global, { idle_seconds: cfg.idle_seconds, max_concurrent_leases: cfg.max_concurrent_leases, lease_ttl_seconds: cfg.lease_ttl_seconds }, 'the globals an unset knob falls back to are exposed (the dashboard settings editor shows them as placeholders)');

  // clear removes them all
  const clr = await set({ clear: true });
  assert.equal(clr.status, 200);
  const st2 = await get();
  const p2 = st2.projects.find((p) => p.name === 'career-ops')!;
  assert.deepEqual(p2.scheduling.overrides, { idle_seconds: null, max_concurrent_leases: null, lease_ttl_seconds: null });
  assert.equal(p2.scheduling.idle_seconds, cfg.idle_seconds, 'effective back to the global');

  // unknown project → 404
  const bad = await fetch(`${base}/api/projects/nope/settings`, { method: 'POST', headers: auth, body: JSON.stringify({ idle_seconds: 60 }) });
  assert.equal(bad.status, 404);
});

test('server connections: seeded from config; add / update / guard rails', async () => {
  type ServerRow = {
    id: string;
    name: string;
    url: string;
    models: { name: string; running: boolean; queued: number }[];
    peers: string[];
    watched: boolean;
    signal: Record<string, unknown> | null;
  };
  const getState = () =>
    fetch(`${base}/api/state`, { headers: auth }).then((r) => r.json() as Promise<{ servers: ServerRow[] }>);

  const st0 = await getState();
  // The arbiter seeds the config-declared connection on construction.
  assert.equal(st0.servers.length, 1, 'exactly one connection seeded from config');
  assert.equal(st0.servers[0]!.name, 'llama-swap');
  assert.equal(st0.servers[0]!.watched, true, 'the seeded row is the watched feed');
  assert.ok(st0.servers[0]!.signal, 'the watched row carries the live signal');
  assert.equal(st0.servers[0]!.models.length, 1);
  assert.equal(st0.servers[0]!.models[0]!.name, 'Qwen3.8-27B', 'models from config');
  assert.equal(st0.servers[0]!.models[0]!.running, false, 'nothing is running yet');

  // guard rails
  const badUrl = await fetch(`${base}/api/servers`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'x', url: 'not a url' }) });
  assert.equal(badUrl.status, 400, 'non-http url rejected');
  const dup = await fetch(`${base}/api/servers`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'same', url: cfg.llama_swap_url, activity_path: cfg.activity_path }) });
  assert.equal(dup.status, 400, 'duplicate connection (same url + path) rejected');

  const add = await fetch(`${base}/api/servers`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'box-two', url: 'http://192.168.9.9:11434', models: ['a', 'b'], peers: ['peer:gpu2'] }) });
  assert.equal(add.status, 200, 'add a declared (unwatched) connection');
  const added = (await add.json()) as { ok: boolean; created: boolean; server: { id: string } };
  assert.equal(added.created, true);

  const st1 = await getState();
  assert.equal(st1.servers.length, 2);
  const two = st1.servers.find((s) => s.id === added.server.id)!;
  assert.equal(two.watched, false, 'a declared (unwatched) connection is not the live feed');
  assert.equal(two.signal, null, 'unwatched rows carry no live signal');
  assert.deepEqual(two.models.map((m) => m.name), ['a', 'b']);
  assert.ok(two.models.every((m) => m.running === false), 'declared models are not running');

  // update by id (patch semantics)
  const upd = await fetch(`${base}/api/servers`, { method: 'POST', headers: auth, body: JSON.stringify({ id: added.server.id, peers: [] }) });
  assert.equal(upd.status, 200);
  const st2 = await getState();
  assert.deepEqual(st2.servers.find((s) => s.id === added.server.id)!.peers, [], 'patch updates only the provided fields');

  // unknown id → 404
  const miss = await fetch(`${base}/api/servers`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'srv-nope', name: 'x' }) });
  assert.equal(miss.status, 404);
});

test('projects in /api/state carry allocated workers + scheduling; register validates project rows', async () => {
  // A client that reports project allocations.
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'worker-b',
      ip: '100.94.165.200',
      projects: [{ name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 4 }],
    }),
  });
  assert.equal(reg.status, 200);

  // A client with malformed project entries (garbage rows are filtered out).
  const regBad = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'worker-c',
      projects: [{ model: 'no-name' }, { name: '', queue_depth: 1 }, 'not-an-object'],
    }),
  });
  assert.equal(regBad.status, 200, 'malformed project rows are dropped, not rejected');

  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    projects: {
      name: string;
      workers: { client: string; model: string; estimated_seconds: number; queue_depth: number; online: boolean }[];
      scheduling: { paused: boolean; idle_seconds: number; max_concurrent_leases: number; lease_ttl_seconds: number; daily_token_cap: number };
    }[];
    clients: { name: string; last_seen: number; projects: Record<string, unknown>[] }[];
  };

  const proj = st.projects.find((p) => p.name === 'career-ops')!;
  assert.equal(proj.workers.length, 1, 'only a client that REPORTS the project is a worker');
  assert.equal(proj.workers[0]!.client, 'worker-b');
  assert.equal(proj.workers[0]!.model, 'Qwen3.8-27B');
  assert.equal(proj.workers[0]!.estimated_seconds, 900);
  assert.equal(proj.workers[0]!.queue_depth, 4);
  assert.equal(proj.workers[0]!.online, true, 'a client that just registered is online');

  assert.equal(proj.scheduling.paused, false);
  assert.equal(proj.scheduling.idle_seconds, cfg.idle_seconds);
  assert.equal(proj.scheduling.max_concurrent_leases, cfg.max_concurrent_leases);
  assert.equal(proj.scheduling.lease_ttl_seconds, cfg.lease_ttl_seconds);

  // Client rows expose last_seen + the stored allocations.
  const rowB = st.clients.find((c) => c.name === "worker-b")!;
  assert.equal(typeof rowB.last_seen, "number");
  assert.equal(rowB.projects.length, 1);
  assert.equal(rowB.projects[0]!.name, "career-ops");
  const rowC = st.clients.find((c) => c.name === "worker-c")!;
  assert.deepEqual(rowC.projects, [], "malformed rows filtered to an empty list");
});

test("projects in /api/state carry today's results (finished/failed from lease end-records)", async () => {
  // The round-trip test finished one lease (ok=true → status 'finished').
  const get = async () =>
    (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
      projects: { name: string; today: { finished: number; failed: number } }[];
    };

  let st = await get();
  assert.equal(st.projects[0]!.today.finished, 1, "the finished lease counts finished today");
  assert.equal(st.projects[0]!.today.failed, 0, "no failed lease yet");

  // A client-reported failure terminates as 'revoked' (end_reason 'failed')
  // — it must count as failed, not finished. Quiet the feed so the grant is
  // not rejected not_idle (the grant is the thing under test, not the box).
  entries.length = 0;
  entries.push(...mkEntries([400], "ip:10.0.0.9", Date.now()));
  await det.poll(Date.now(), new Set());
  const lease = await fetch(`${base}/api/leases`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ client_id: clientId, project: "career-ops", job_id: "job-fail" }),
  });
  assert.equal(lease.status, 201);
  const leaseId = ((await lease.json()) as { lease_id: string }).lease_id;
  const use = await fetch(`${base}/api/leases/${leaseId}/usage`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ ok: false, error: "boom", tokens_out: 10 }),
  });
  assert.equal(use.status, 200);
  st = await get();
  assert.equal(st.projects[0]!.today.failed, 1, "a client-reported failure counts failed today");
  assert.equal(st.projects[0]!.today.finished, 1, "the finished count is unchanged");

  // The /api/projects endpoint (token-authed) carries the same row.
  const pj = await (await fetch(`${base}/api/projects`, { headers: auth })).json() as {
    projects: { name: string; today: { finished: number; failed: number } }[];
  };
  assert.deepEqual(pj.projects[0]!.today, { finished: 1, failed: 1 });
});

test('/api/state limit: window is honored (default 10, explicit wins, clamped to >=1)', async () => {
  type Shaped = { events: unknown[]; leases: unknown[] };
  const get = async (qs?: string) =>
    (await (await fetch(`${base}/api/state${qs ?? ''}`, { headers: auth })).json()) as Shaped;

  const def = await get();
  assert.ok(def.events.length <= 10, `default window is 10, got ${def.events.length}`);

  const big = await get('?limit=500');
  assert.ok(big.events.length >= def.events.length, 'bigger window returns no fewer events');

  const small = await get('?limit=1');
  assert.equal(small.events.length, Math.min(1, big.events.length), 'limit=1 shows exactly one event when any exist');

  const bad = await get('?limit=banana');
  assert.ok(bad.events.length <= 10, 'invalid limit falls back to the default window');
});

test('client override: pause blocks new grants (client_paused); clear restores', async () => {
  // Make the feed fresh (busy) so the only question is the client's override.
  entries.length = 0;
  entries.push(...mkEntries([5], 'ip:10.0.0.9', Date.now()));
  await det.poll(Date.now(), new Set());

  const setRes = await fetch(`${base}/api/clients/mac-test/override`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ override: 'pause' }),
  });
  assert.equal(setRes.status, 200);
  const setBody = (await setRes.json()) as { ok: boolean; client: string; override: { override: string } };
  assert.equal(setBody.ok, true);
  assert.equal(setBody.client, 'mac-test');

  // /api/state exposes the override on the client row.
  const st1 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; override: { override: string } | null }[];
  };
  assert.equal(st1.clients.find((c) => c.name === 'mac-test')!.override?.override, 'pause');

  // A paused client's lease request → 409 client_paused.
  const res = await fetch(`${base}/api/leases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: 'y' }),
  });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { reason: string }).reason, 'client_paused');

  // Clear (override: null) → state shows null again.
  const clearRes = await fetch(`${base}/api/clients/mac-test/override`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ override: null }),
  });
  assert.equal(clearRes.status, 200);
  const st2 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; override: { override: string } | null }[];
  };
  assert.equal(st2.clients.find((c) => c.name === 'mac-test')!.override, null);
});

test('client override: force grants while the box is busy; 404/400 validation', async () => {
  // Feed is fresh (busy) from the previous test; re-anchor just in case.
  entries.length = 0;
  entries.push(...mkEntries([5], 'ip:10.0.0.9', Date.now()));
  await det.poll(Date.now(), new Set());

  const setRes = await fetch(`${base}/api/clients/mac-test/override`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ override: 'force' }),
  });
  assert.equal(setRes.status, 200);

  // Forced client gets a lease despite the busy box.
  const res = await fetch(`${base}/api/leases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: 'forced-job' }),
  });
  assert.equal(res.status, 201, `force grants a lease despite a busy box, got ${await res.clone().text()}`);
  const leaseBody = (await res.json()) as { lease_id: string };

  // Tidy up: finish the forced lease + clear the override so later tests
  // see a clean slate.
  const use = await fetch(`${base}/api/leases/${leaseBody.lease_id}/usage`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ ok: true, tokens_out: 100 }),
  });
  assert.equal(use.status, 200);
  const clear = await fetch(`${base}/api/clients/mac-test/override`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ override: null }),
  });
  assert.equal(clear.status, 200);

  // Unknown client → 404; invalid override → 400.
  const bad = await fetch(`${base}/api/clients/nope/override`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ override: 'pause' }),
  });
  assert.equal(bad.status, 404);
  const bad2 = await fetch(`${base}/api/clients/mac-test/override`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ override: 'banana' }),
  });
  assert.equal(bad2.status, 400);
});

test('WS handshake: good token connects, bad token is 401', async () => {
  // good
  const okWs = new WebSocket(`${base}/api/leases/events?token=${TOKEN}`);
  await new Promise<void>((resolveP, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), 5000);
    okWs.once('open', () => {
      clearTimeout(t);
      resolveP();
    });
    okWs.once('error', reject);
  });
  okWs.close();

  // bad
  const badUrl = new URL(`${base}/api/leases/events`);
  badUrl.searchParams.set('token', 'wrong');
  const badWs = new WebSocket(badUrl.toString());
  const resp = await new Promise<{ statusCode: number }>((resolveP, reject) => {
    const t = setTimeout(() => reject(new Error('bad ws: no response within 5s')), 5000);
    badWs.once('unexpected-response', (_req, res) => {
      clearTimeout(t);
      resolveP({ statusCode: res.statusCode ?? 0 });
    });
    badWs.once('open', () => {
      clearTimeout(t);
      resolveP({ statusCode: 101 }); // would mean auth was NOT enforced
    });
    badWs.once('error', () => {
      clearTimeout(t);
      resolveP({ statusCode: 0 });
    });
  });
  assert.notEqual(resp.statusCode, 101, 'bad token must not complete the WS handshake');
  assert.equal(resp.statusCode, 401);
  try {
    badWs.close();
  } catch {
    /* already destroyed */
  }
});
