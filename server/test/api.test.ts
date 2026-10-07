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
    ['POST', '/api/projects/career-ops/jobs/job-x/unthrottle'],
    ['GET', '/api/projects/career-ops/results'],
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
  // Adaptive lease TTL: the client's estimate caps the lease — est 60 *
  // safety(2) = 120s, capped at the global 1800 (and floored at 60). So the
  // lease now expires in 120s, not the full static 1800s. (A no/zero estimate
  // would still yield the full 1800s — today's behavior.)
  assert.ok(leaseBody.ttl_seconds === 120, `adaptive ttl est60*2=120, got ${leaseBody.ttl_seconds}`);

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

test('dashboard HTML serves (the route returns the dashboard document)', async () => {
  // Route + document contract ONLY — never markup minutiae. Markup string
  // tests broke on every UI redesign (the Resources consolidation, the
  // server-card redesign) while catching no behavior; by owner decision
  // (2026-10-07) the dashboard is verified by eye + the probes, not by
  // string-matching its HTML.
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<html/);
  assert.match(html, /\/api\/state/);
  assert.ok((res.headers.get('content-type') ?? '').includes('text/html'));
});

test('dashboard carries the view-tab structure (Resources consolidation: four surfaces + Resources sub-tabs)', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  // The tab bar + the four surfaces, and every section assigned to one.
  assert.match(html, /id="view-tabs"/, 'the view-tab bar is on the page');
  for (const v of ['overview', 'resources', 'sessions', 'usage']) {
    assert.match(html, new RegExp(`data-view="${v}"`), `sections assigned to the ${v} view`);
    assert.match(html, new RegExp(`vtab-${v}`), `the ${v} tab button exists`);
  }
  // The Resources sub-tab row: every inventory section carries a data-subview.
  assert.match(html, /id="res-subtabs"/, 'the Resources sub-tab row is on the page');
  for (const s of ['servers', 'machines', 'projects', 'models']) {
    assert.match(html, new RegExp(`data-subview="${s}"`), `sections assigned to the ${s} sub-view`);
    assert.match(html, new RegExp(`rtab-${s}`), `the ${s} sub-tab button exists`);
  }
  // The view switch is a class flip, not inline style (inline display is
  // owned by the exception-only sections themselves). The sub-view switch
  // is the same mechanism (subhide), and the sub-tab bar shows only inside
  // Resources via the body.view-resources class.
  // Mechanism presence, tolerant of restyling (the exact CSS text churns
  // with every redesign; the CONTRACT is the class-flip mechanism).
  assert.match(html, /section\.vthide\s*\{[^}]*display:\s*none/, 'the hide mechanism is the vthide class');
  assert.match(html, /section\.subhide\s*\{[^}]*display:\s*none/, 'the sub-view mechanism is the subhide class');
  assert.match(html, /body\.view-resources[^{]*#res-subtabs[^{]*\{[^}]*display:\s*flex/, 'the sub-tab bar shows inside Resources');
  // The queue route keeps its own single-section layout (tab bar hidden).
  assert.match(html, /body\.queuepage[^{]*#view-tabs[^{]*\{[^}]*display:\s*none/, 'the queue route hides the tab bar');
});

// ---------------------------------------------------------------------------
// The Resources → Inference Servers surface, BEHAVIOR side: the card grid
// reads /api/state's per-row catalog keys (model_source, probed_at) and
// writes through POST /api/servers + POST /api/servers/remove. Markup is
// verified by eye; this covers the wiring the cards depend on.
// ---------------------------------------------------------------------------

test('queue detail page serves the same dashboard at /[project]/[worker]/queue', async () => {
  // The queue page is the SAME single-file dashboard (the inline script
  // switches views on location.pathname). Public read, like `/` (phase 1).
  for (const path of ['/career-ops/mac-sam/queue', '/career-ops/any-worker/queue']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} → 200`);
    const html = await res.text();
    assert.match(html, /queue-section/, 'queue section present');
    assert.match(html, /api\/state/);
    assert.ok((res.headers.get('content-type') ?? '').includes('text/html'));
  }
  // A non-queue two-segment path is NOT the dashboard (falls to 404).
  const res404 = await fetch(`${base}/career-ops/mac-sam/other`);
  assert.equal(res404.status, 404, 'only the /queue segment maps to the dashboard');
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
  // A client that reports project allocations (incl. a queue preview — the
  // data the dashboard's /[project]/[worker]/queue page renders).
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'worker-b',
      ip: '100.94.165.200',
      projects: [
        {
          name: 'career-ops',
          model: 'Qwen3.8-27B',
          estimated_seconds: 900,
          queue_depth: 4,
          queue_preview: [
            { job_id: 'acme-1', title: 'Staff Engineer', company: 'Acme', score: 9, attempts: 0 },
            { job_id: 'globex-2', title: 'Backend', company: 'Globex', score: 7, attempts: 1 },
            // malformed row (no job_id) — dropped by cleanPreview
            { title: 'no id' },
            { job_id: 'x'.repeat(500), title: 'y'.repeat(500), company: 'z'.repeat(500), score: NaN, attempts: -3 },
          ],
        },
      ],
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
      workers: {
        client: string;
        model: string;
        estimated_seconds: number;
        queue_depth: number;
        queue_preview: { job_id: string; title: string; company: string; score: number | null; attempts: number }[];
        online: boolean;
      }[];
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
  // The queue preview (the /[project]/[worker]/queue page data) is stored
  // verbatim, sanitized: malformed rows dropped, long fields truncated,
  // bad score/attempts coerced.
  const prev = proj.workers[0]!.queue_preview;
  assert.equal(prev.length, 3, `cleanPreview kept the 3 valid rows, got ${prev.length}`);
  assert.deepEqual(prev[0], { job_id: 'acme-1', title: 'Staff Engineer', company: 'Acme', score: 9, attempts: 0 });
  assert.equal(prev[1]!.attempts, 1);
  assert.equal(prev[2]!.job_id.length, 128, 'job_id truncated to 128 chars');
  assert.equal(prev[2]!.title.length, 200, 'title truncated to 200 chars');
  assert.equal(prev[2]!.company.length, 64, 'company truncated to 64 chars');
  assert.equal(prev[2]!.score, null, 'NaN score coerced to null');
  assert.equal(prev[2]!.attempts, 0, 'negative attempts coerced to 0');

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

test('client IP: the observed connection IP wins over the reported one; reported_ip surfaces in /api/state', async () => {
  // The real Fastify app sees the client at 127.0.0.1 (loopback test). The
  // client REPORTS a (stale) static tailnet IP — the observed one must win,
  // because the self-traffic exemption keys on it.
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'worker-ip', ip: '100.94.165.99' }),
  });
  assert.equal(reg.status, 200);

  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; ip: string; reported_ip?: string; observed_ip: string }[];
  };
  const row = st.clients.find((c) => c.name === 'worker-ip')!;
  assert.equal(row.ip, '127.0.0.1', 'the OBSERVED connection IP is the exemption key');
  assert.equal(row.reported_ip, '100.94.165.99', 'the reported IP is kept for display/audit');
  assert.equal(row.observed_ip, '127.0.0.1');

  // A re-registration (heartbeat) with the same stale reported value must
  // not clobber the observed IP.
  await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'worker-ip', ip: '100.94.165.99' }),
  });
  const st2 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; ip: string; reported_ip?: string }[];
  };
  const row2 = st2.clients.find((c) => c.name === 'worker-ip')!;
  assert.equal(row2.ip, '127.0.0.1', 're-registration keeps the observed IP');
  assert.equal(row2.reported_ip, '100.94.165.99');
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


test('servers surface: add -> probed list replaces declared -> remove works; a leased row refuses', async () => {
  // Add a row with a DECLARED fallback list (the probe has not answered).
  const add = await fetch(`${base}/api/servers`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'cardtest', url: 'http://cardtest.local:9', models: ['Fallback-A'] }),
  });
  assert.equal(add.status, 200);
  const added = (await add.json()) as { ok: boolean; server: { id: string } };
  assert.ok(added.ok && added.server.id);
  const sid = added.server.id;

  let st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    servers: { id: string; model_source?: string; probed_at?: number | null; models?: { name: string }[] }[];
  };
  let row = st.servers.find((s) => s.id === sid)!;
  assert.equal(row.model_source, 'declared', 'a never-probed row says declared (the card shows the declared-list honesty note)');
  assert.equal(row.probed_at ?? null, null, 'no probe timestamp yet (the card shows "probe never answered")');
  assert.deepEqual(row.models!.map((m) => m.name), ['Fallback-A'], 'the declared fallback still lists (the card never goes blank without cause)');

  // Remove: unknown -> 404, missing id -> 400, real row -> 200 and gone.
  const bad = await fetch(`${base}/api/servers/remove`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'srv-nope' }) });
  assert.equal(bad.status, 404, 'unknown id is a 404, not a silent success');
  const noId = await fetch(`${base}/api/servers/remove`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(noId.status, 400, 'a remove with no id is rejected');
  const noTok = await fetch(`${base}/api/servers/remove`, { method: 'POST', body: JSON.stringify({ id: sid }) });
  assert.equal(noTok.status, 401, 'the write is token-gated like every settings route');
  const rm = await fetch(`${base}/api/servers/remove`, { method: 'POST', headers: auth, body: JSON.stringify({ id: sid }) });
  assert.equal(rm.status, 200);
  st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as typeof st;
  assert.ok(!st.servers.some((s) => s.id === sid), 'the row is gone from /api/state (the grid drops the card on the next tick)');

  // A row a live lease holds is refused (409) — removal cannot orphan a job.
  // Quiet the feed (the prior test left it busy) + clear any lease an
  // earlier test left active (max_concurrent=1).
  entries.length = 0;
  entries.push(...mkEntries([400], "ip:10.0.0.9", Date.now()));
  await det.poll(Date.now(), new Set());
  const openLeases = (await (await fetch(`${base}/api/leases`, { headers: auth })).json()) as { leases: { lease_id: string; status: string }[] };
  for (const l of openLeases.leases.filter((x) => x.status === 'active')) {
    // zero-token finish: closes the lease without moving any budget total
    await fetch(`${base}/api/leases/${l.lease_id}/usage`, { method: 'POST', headers: auth, body: JSON.stringify({ ok: true, tokens_out: 0, tokens_in: 0 }) });
  }
  const lease = await fetch(`${base}/api/leases`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: 'job-rmguard', estimated_seconds: 60 }),
  });
  assert.equal(lease.status, 201, 'fixture lease granted: ' + await lease.clone().text());
  const busy = await fetch(`${base}/api/servers/remove`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'srv-watched' }) });
  assert.equal(busy.status, 409, 'a row with a live lease refuses removal');
  const body = (await busy.json()) as { error: string };
  assert.match(body.error, /leases_active/, 'the refusal names the reason the card flashes');
  const leaseId = (await lease.json() as { lease_id: string }).lease_id;
  const fin = await fetch(`${base}/api/leases/${leaseId}/usage`, {
    method: 'POST', headers: auth, body: JSON.stringify({ ok: true, tokens_out: 1, tokens_in: 1 }),
  });
  assert.equal(fin.status, 200, 'fixture lease closed (no side effects left behind)');
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

// ---------------------------------------------------------------------------
// Anti-thrash HTTP surface: error_detail round-trip, the unthrottle API,
// and the throttled_jobs / lease error_detail exposure in /api/state.
// (The arbiter-level throttle/cooldown logic is covered in arbiter.test.ts;
// this block is the wire contract.)
// ---------------------------------------------------------------------------

test('usage error_detail round-trips: POST usage → lease record → /api/state lease + lease_finished event', async () => {
  // Quiet the feed so the grant is clean.
  entries.length = 0;
  entries.push(...mkEntries([400], 'ip:10.0.0.9', Date.now()));
  await det.poll(Date.now(), new Set());

  const lease = await fetch(`${base}/api/leases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: 'job-edhttp' }),
  });
  assert.equal(lease.status, 201);
  const leaseId = ((await lease.json()) as { lease_id: string }).lease_id;

  const longDetail = 'x'.repeat(400) + 'CRASH-MARKER';
  const use = await fetch(`${base}/api/leases/${leaseId}/usage`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ ok: false, error: 'executor_exit_1', error_detail: longDetail, tokens_out: 10 }),
  });
  assert.equal(use.status, 200, `the usage route accepts error_detail, got ${await use.clone().text()}`);

  // /api/state: the lease record carries the full error_detail.
  const st = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    leases: { lease_id: string; error_detail?: string; end_reason?: string }[];
    events: { kind: string; detail?: string; lease_id?: string }[];
  };
  const row = st.leases.find((l) => l.lease_id === leaseId)!;
  assert.equal(row.error_detail, longDetail, '/api/state lease record carries the full error_detail');
  assert.equal(row.end_reason, 'executor_exit_1');

  // The lease_finished event shows the LAST 300 chars with an ellipsis.
  const ev = st.events.find((e) => e.kind === 'lease_finished' && e.lease_id === leaseId);
  assert.ok(ev, 'the lease_finished event is in the event log');
  assert.ok(ev!.detail?.includes('…'), 'the event detail is truncated (last 300 chars + ellipsis)');
  assert.ok(ev!.detail?.includes('CRASH-MARKER'), 'the event keeps the END of the detail');
  assert.ok(!(ev!.detail ?? '').includes(longDetail), 'the full detail is NOT in the event line');

  // A usage report WITHOUT error_detail leaves the field absent (no
  // undefined riding the wire).
  const lease2 = await fetch(`${base}/api/leases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: 'job-ednone' }),
  });
  assert.equal(lease2.status, 201);
  const leaseId2 = ((await lease2.json()) as { lease_id: string }).lease_id;
  await fetch(`${base}/api/leases/${leaseId2}/usage`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ ok: false, error: 'no_result_file' }),
  });
  const st2 = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    leases: { lease_id: string; error_detail?: string }[];
  };
  assert.equal(st2.leases.find((l) => l.lease_id === leaseId2)!.error_detail, undefined, 'no error_detail ⇒ the field is absent');
});

test('unthrottle API: clears the throttle (was_throttled), is idempotent, 404s on unknown project', async () => {
  // 5 failed usage reports for the same job, each on its own grant. The
  // per-job grant cooldown (300s) would otherwise block attempts 2-5; zero
  // it out for the loop (restored after) so the 5 failures land back-to-back
  // and the failure count climbs 1..5.
  entries.length = 0;
  entries.push(...mkEntries([400], 'ip:10.0.0.9', Date.now()));
  await det.poll(Date.now(), new Set());
  const savedCooldown = cfg.job_cooldown_seconds;
  cfg.job_cooldown_seconds = 0;
  try {
    for (let i = 0; i < 5; i++) {
      const lease = await fetch(`${base}/api/leases`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: 'job-unthrottle' }),
      });
      assert.equal(lease.status, 201, `attempt ${i} grant, got ${lease.status} ${await lease.clone().text()}`);
      const leaseId = ((await lease.json()) as { lease_id: string }).lease_id;
      const use = await fetch(`${base}/api/leases/${leaseId}/usage`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ok: false, error: 'executor_exit_1', error_detail: `attempt ${i}` }),
      });
      assert.equal(use.status, 200, `attempt ${i} usage report`);
    }
  } finally {
    cfg.job_cooldown_seconds = savedCooldown;
  }

  // Now the job is throttled (5th failure): /api/state shows it, and a new
  // grant for it is denied job_throttled over HTTP.
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    throttled_jobs: { project: string; job_id: string; count: number; last_error: string; last_error_detail: string; last_failed_at: number }[];
  };
  const row = st.throttled_jobs.find((x) => x.job_id === 'job-unthrottle');
  assert.ok(row, 'the throttled job is in /api/state throttled_jobs');
  assert.equal(row!.project, 'career-ops');
  assert.equal(row!.count, 5);
  assert.equal(row!.last_error, 'executor_exit_1');
  assert.equal(row!.last_error_detail, 'attempt 4');
  assert.ok(row!.last_failed_at > 0);

  const denied = await fetch(`${base}/api/leases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: 'job-unthrottle' }),
  });
  assert.equal(denied.status, 409, 'a throttled job gets HTTP 409 like the other rejections');
  assert.equal(((await denied.json()) as { reason: string }).reason, 'job_throttled');

  // Unthrottle over HTTP: clears the throttle + count + cooldown.
  const un = await fetch(`${base}/api/projects/career-ops/jobs/job-unthrottle/unthrottle`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(un.status, 200);
  const unBody = (await un.json()) as { ok: boolean; project: string; job_id: string; was_throttled: boolean };
  assert.equal(unBody.ok, true);
  assert.equal(unBody.was_throttled, true, 'it reports the job WAS throttled');

  const st2 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as { throttled_jobs: { job_id: string }[] };
  assert.equal(st2.throttled_jobs.find((x) => x.job_id === 'job-unthrottle'), undefined, 'the throttle row is gone from /api/state');

  // The grant works again (idle, no throttle, no cooldown).
  const again = await fetch(`${base}/api/leases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: 'job-unthrottle' }),
  });
  assert.equal(again.status, 201, `unthrottled job is grantable again, got ${again.status} ${await again.clone().text()}`);
  // Tidy up: finish that lease ok (it also proves the count reset — no
  // immediate re-throttle on one success).
  const againId = ((await again.json()) as { lease_id: string }).lease_id;
  await fetch(`${base}/api/leases/${againId}/usage`, { method: 'POST', headers: auth, body: JSON.stringify({ ok: true, tokens_out: 5 }) });

  // Idempotent: unthrottling an unthrottled job still succeeds.
  const un2 = await fetch(`${base}/api/projects/career-ops/jobs/job-unthrottle/unthrottle`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(un2.status, 200);
  assert.equal(((await un2.json()) as { was_throttled: boolean }).was_throttled, false, 'no throttle left to clear');

  // Unknown project → 404.
  const bad = await fetch(`${base}/api/projects/nope/jobs/job-x/unthrottle`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(bad.status, 404);
});

// ---------------------------------------------------------------------------
// Version handshake: registration carries the client's version + wire-
// protocol revision; the arbiter sanitizes (version: string ≤64, protocol:
// integer 0..1000), stores, and echoes both per client row. Missing fields
// are fine — pre-version clients keep working, their rows carry no keys.
// (Placed LAST: the handshake-v1 client reports career-ops and would be
// counted by the earlier per-project worker-count assertion.)

test('version handshake: a register WITH version + protocol echoes both on /api/state', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'handshake-v1',
      version: '1.2.3',
      protocol: 1,
      projects: [{ name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 0 }],
    }),
  });
  assert.equal(reg.status, 200);
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; version?: string; protocol?: number }[];
    projects: { name: string; workers: { client: string; version?: string; protocol?: number }[] }[];
  };
  const row = st.clients.find((c) => c.name === 'handshake-v1')!;
  assert.equal(row.version, '1.2.3', 'the client row carries version');
  assert.equal(row.protocol, 1, 'the client row carries protocol');
  const w = st.projects.find((p) => p.name === 'career-ops')!.workers.find((x) => x.client === 'handshake-v1')!;
  assert.equal(w.version, '1.2.3', 'the per-project worker row carries version (the dashboard renders it)');
  assert.equal(w.protocol, 1, 'the per-project worker row carries protocol');
});

test('version handshake: a register WITHOUT them still 200s with no version/protocol keys (old clients)', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'handshake-legacy' }),
  });
  assert.equal(reg.status, 200, 'pre-version clients keep registering');
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; version?: string; protocol?: number }[];
  };
  const row = st.clients.find((c) => c.name === 'handshake-legacy')!;
  assert.ok(!('version' in row), 'no version key on a pre-version client row');
  assert.ok(!('protocol' in row), 'no protocol key on a pre-version client row');
});

test('version handshake: malformed version/protocol values are dropped, never rejected', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'handshake-bad', version: 'x'.repeat(65), protocol: 99999 }),
  });
  assert.equal(reg.status, 200, 'malformed handshake facts never reject a registration');
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; version?: string; protocol?: number }[];
  };
  const row = st.clients.find((c) => c.name === 'handshake-bad')!;
  assert.ok(!('version' in row), 'a >64-char version is dropped');
  assert.ok(!('protocol' in row), 'an out-of-range protocol is dropped');

  // A later re-registration with valid values updates the row (protocol 0
  // is in range and must be kept — not treated as "absent").
  const reg2 = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'handshake-bad', version: '9.9.9', protocol: 0 }),
  });
  assert.equal(reg2.status, 200);
  const st2 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; version?: string; protocol?: number }[];
  };
  const row2 = st2.clients.find((c) => c.name === 'handshake-bad')!;
  assert.equal(row2.version, '9.9.9', 'a later valid report updates the row');
  assert.equal(row2.protocol, 0, 'protocol 0 is in range and kept');
});


// ---------------------------------------------------------------------------
// Code-staleness (issue #49): registration carries the daemon's boot
// `revision` (the git commit its running code loaded from); the arbiter
// sanitizes it like version (string ≤64, malformed → dropped), stores it,
// and echoes it on the client row + the per-project worker row. Absent is
// normal (pre-#49 daemons), never a rejection. The arbiter only stores +
// echoes — the behind-check lives in the surfaces (no view of client
// repo trees). (No projects[] rows here: these clients never enter a
// per-project worker count.)

test('code-staleness: a register WITH revision echoes it on the client row + worker rows', async () => {
  const sha = 'a'.repeat(40);
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'rev-v1',
      version: '2',
      protocol: 1,
      revision: sha,
      projects: [{ name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 0 }],
    }),
  });
  assert.equal(reg.status, 200);
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; revision?: string }[];
    projects: { name: string; workers: { client: string; revision?: string }[] }[];
  };
  const row = st.clients.find((c) => c.name === 'rev-v1')!;
  assert.equal(row.revision, sha, 'the client row carries the boot revision');
  const w = st.projects.find((p) => p.name === 'career-ops')!.workers.find((x) => x.client === 'rev-v1')!;
  assert.equal(w.revision, sha, 'the per-project worker row carries it too (the surfaces read either)');
});

test('code-staleness: a register WITHOUT revision keeps registering with no revision key (old daemon)', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'rev-legacy' }),
  });
  assert.equal(reg.status, 200, 'pre-#49 clients keep registering');
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; revision?: string }[];
  };
  const row = st.clients.find((c) => c.name === 'rev-legacy')!;
  assert.ok(!('revision' in row), 'no revision key on a pre-#49 client row (surfaces render as before)');
});

test('code-staleness: malformed revision values are dropped, never rejected; a later valid report updates the row', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'rev-bad', revision: 'x'.repeat(65) }),
  });
  assert.equal(reg.status, 200, 'a malformed revision never rejects a registration');
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; revision?: string }[];
  };
  const row = st.clients.find((c) => c.name === 'rev-bad')!;
  assert.ok(!('revision' in row), 'a >64-char revision is dropped');

  // A non-string type is dropped the same way.
  await fetch(`${base}/api/clients/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'rev-bad2', revision: 12345 }),
  });
  const st2 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; revision?: string }[];
  };
  assert.ok(!('revision' in st2.clients.find((c) => c.name === 'rev-bad2')!), 'a non-string revision is dropped');

  // The heartbeat rule: a later report with a valid revision updates the
  // row (this is how a daemon restart clears the surfaces' tag within one
  // heartbeat). An omitted field leaves the stored row as-is.
  const sha2 = 'b'.repeat(40);
  await fetch(`${base}/api/clients/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'rev-bad', revision: sha2 }),
  });
  const st3 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; revision?: string }[];
  };
  assert.equal(st3.clients.find((c) => c.name === 'rev-bad')!.revision, sha2, 'a later valid report updates the row');
  await fetch(`${base}/api/clients/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'rev-bad' }),
  });
  const st4 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; revision?: string }[];
  };
  assert.equal(st4.clients.find((c) => c.name === 'rev-bad')!.revision, sha2, 'an omitted field leaves the stored row untouched');
});


// ---------------------------------------------------------------------------
// Scheduled rebuild (issue #3): last_rebuild rides register → /api/state,
// and a NEW run emits a `rebuild` event (queue 445 → 512 style detail).
// ---------------------------------------------------------------------------

test('scheduled rebuild: last_rebuild rides register → /api/state; a new run emits a rebuild event', async () => {
  const rb = { last_run_ts: 1_780_000_000_000, exit_code: 0, duration_ms: 4200, queue_before: 445, queue_after: 512 };
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'worker-rb',
      projects: [{ name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 512, last_rebuild: rb }],
    }),
  });
  assert.equal(reg.status, 200);

  const st = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    projects: { name: string; workers: { client: string; last_rebuild?: typeof rb }[] }[];
    clients: { name: string; projects: { name: string; last_rebuild?: typeof rb }[] }[];
    events: { kind: string; project?: string; detail?: string }[];
  };

  // The run state rides BOTH views: the raw client row and the dashboard's
  // per-project worker row (the panel row is a follow-up; the data must be
  // on /api/state).
  const row = st.clients.find((c) => c.name === 'worker-rb')!;
  assert.deepEqual(row.projects[0]!.last_rebuild, rb, 'client row echoes last_rebuild verbatim');
  const proj = st.projects.find((p) => p.name === 'career-ops')!;
  const w = proj.workers.find((x) => x.client === 'worker-rb')!;
  assert.deepEqual(w.last_rebuild, rb, 'projectView worker carries last_rebuild');

  // The fresh registration emitted exactly one rebuild event with the
  // operator-readable depth transition.
  const rbEvents = st.events.filter((e) => e.kind === 'rebuild' && e.project === 'career-ops');
  assert.equal(rbEvents.length, 1, 'one rebuild event for the new run');
  assert.match(rbEvents[0]!.detail!, /queue 445 → 512 \(exit 0/, `rebuild detail shows the refill, got: ${rbEvents[0]!.detail}`);

  // Heartbeat with the SAME last_run_ts: stored, but NO second event (the
  // 20s re-registration must not spam the log).
  await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'worker-rb', projects: [{ name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 512, last_rebuild: rb }] }),
  });
  const st2 = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    events: { kind: string; project?: string }[];
  };
  assert.equal(st2.events.filter((e) => e.kind === 'rebuild' && e.project === 'career-ops').length, 1, 'the same run never double-logs across heartbeats');

  // A NEWER run (last_run_ts moved) emits a second event.
  const rb2 = { ...rb, last_run_ts: rb.last_run_ts + 3_600_000, queue_before: 512, queue_after: 600 };
  await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'worker-rb', projects: [{ name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 600, last_rebuild: rb2 }] }),
  });
  const st3 = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    events: { kind: string; project?: string; detail?: string }[];
  };
  const rbEvents3 = st3.events.filter((e) => e.kind === 'rebuild' && e.project === 'career-ops');
  assert.equal(rbEvents3.length, 2, 'a newer run logs a new event');
  assert.match(rbEvents3[0]!.detail!, /queue 512 → 600/, 'newest event first');

  // Malformed last_rebuild (non-numeric fields) is dropped, never rejected.
  const regBad = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'worker-rb-bad',
      projects: [{ name: 'career-ops', model: 'm', estimated_seconds: 1, queue_depth: 1, last_rebuild: { last_run_ts: 'yesterday', exit_code: 0, duration_ms: 0, queue_before: 0, queue_after: 0 } }],
    }),
  });
  assert.equal(regBad.status, 200, 'a malformed last_rebuild never rejects the register');
  const st4 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; projects: Record<string, unknown>[] }[];
  };
  const badRow = st4.clients.find((c) => c.name === 'worker-rb-bad')!;
  assert.ok(!('last_rebuild' in badRow.projects[0]!), 'malformed last_rebuild is dropped');
});


// ---------------------------------------------------------------------------
// Dashboard cycle strip (#53 D9.3): the client-published cycles block rides
// register → /api/state VERBATIM on both views; malformed rows/keys are
// dropped, never stored, never a rejection. The arbiter stores + displays —
// it never computes anything about cycles.
// ---------------------------------------------------------------------------

const CYC_A = { cycle_id: 'cyc-a', status: 'running', items_total: 3, item_index: 1, settled: 2, passed: 1, quarantined: 1, stage: 'gate' };
const CYC_B = { cycle_id: 'cyc-b', status: 'planned', items_total: 3, item_index: 0, settled: 0, passed: 0, quarantined: 0, stage: 'item' };

test('cycles: a published block echoes verbatim through /api/state (client row + projectView worker row)', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'worker-cyc',
      projects: [{ name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 4, cycles: [CYC_A, CYC_B], cycle_cap: 2 }],
    }),
  });
  assert.equal(reg.status, 200);

  const st = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    clients: { name: string; projects: Record<string, unknown>[] }[];
    projects: { name: string; workers: Record<string, unknown>[] }[];
  };

  const row = st.clients.find((c) => c.name === 'worker-cyc')!;
  assert.deepEqual(row.projects[0]!.cycles, [CYC_A, CYC_B], 'the client row echoes cycles verbatim, file order kept');
  assert.equal(row.projects[0]!.cycle_cap, 2, 'cycle_cap echoes verbatim');

  const proj = st.projects.find((p) => p.name === 'career-ops')!;
  const w = proj.workers.find((x) => x.client === 'worker-cyc')!;
  assert.deepEqual(w.cycles, [CYC_A, CYC_B], 'projectView carries cycles exactly like last_rebuild');
  assert.equal(w.cycle_cap, 2, 'projectView carries cycle_cap');

  // A heartbeat with NO cycles block replaces the row: the keys drop with it
  // (the register payload is the whole per-project view, same as last_rebuild).
  await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'worker-cyc', projects: [{ name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 4 }] }),
  });
  const st2 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; projects: Record<string, unknown>[] }[];
  };
  const row2 = st2.clients.find((c) => c.name === 'worker-cyc')!;
  assert.ok(!('cycles' in row2.projects[0]!) && !('cycle_cap' in row2.projects[0]!), 'a heartbeat without the block drops the keys (no stale rows)');
});

test('cycles: malformed blocks are dropped — never stored, never a rejection', async () => {
  const cases: { name: string; projects: Record<string, unknown>[]; wantKeys: boolean; wantCycleIds?: string[]; wantCap?: number }[] = [
    // Non-array cycles: key dropped.
    { name: 'cyc-nonarray', projects: [{ name: 'career-ops', model: 'm', estimated_seconds: 1, queue_depth: 1, cycles: { cycle_id: 'nope' } }], wantKeys: false },
    // Every row malformed (bad status / NaN count / missing stage / empty id): key dropped.
    {
      name: 'cyc-allbad',
      projects: [{
        name: 'career-ops', model: 'm', estimated_seconds: 1, queue_depth: 1,
        cycles: [
          { ...CYC_A, cycle_id: '' },
          { ...CYC_A, cycle_id: 'bad-status', status: 'exploded' },
          { ...CYC_A, cycle_id: 'nan-count', settled: Number.NaN },
          { ...CYC_A, cycle_id: 'float-count', passed: 1.5 },
          { ...CYC_A, cycle_id: 'neg-index', item_index: -1 },
          { ...CYC_A, cycle_id: 'bad-stage', stage: 'verdict' },
          null, 42, 'row', [],
        ],
      }],
      wantKeys: false,
    },
    // Mixed: bad rows dropped, the good row survives; a malformed cycle_cap
    // (NaN) drops only its key.
    {
      name: 'cyc-mixed',
      projects: [{
        name: 'career-ops', model: 'm', estimated_seconds: 1, queue_depth: 1,
        cycles: [null, CYC_B],
        cycle_cap: Number.NaN,
      }],
      wantKeys: true,
      wantCycleIds: ['cyc-b'],
      wantCap: undefined,
    },
    // >20 rows: capped at the first 20; oversized cycle_id trimmed to 128.
    {
      name: 'cyc-many',
      projects: [{
        name: 'career-ops', model: 'm', estimated_seconds: 1, queue_depth: 1,
        cycles: [...Array.from({ length: 25 }, (_, i) => ({ ...CYC_B, cycle_id: `cyc-${i}` })), { ...CYC_B, cycle_id: 'x'.repeat(200) }],
        cycle_cap: 0,
      }],
      wantKeys: true,
      wantCycleIds: Array.from({ length: 20 }, (_, i) => `cyc-${i}`),
      wantCap: 0,
    },
  ];

  for (const c of cases) {
    const res = await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify({ name: c.name, projects: c.projects }) });
    assert.equal(res.status, 200, `${c.name}: a malformed cycles block never rejects the register`);
  }

  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; projects: Record<string, unknown>[] }[];
  };
  for (const c of cases) {
    const row = st.clients.find((x) => x.name === c.name)!;
    const p = row.projects[0]!;
    if (!c.wantKeys) {
      assert.ok(!('cycles' in p), `${c.name}: malformed cycles dropped, never stored`);
      assert.ok(!('cycle_cap' in p), `${c.name}: no cycle_cap leaked`);
      continue;
    }
    assert.deepEqual((p.cycles as { cycle_id: string }[]).map((r) => r.cycle_id), c.wantCycleIds, `${c.name}: bad rows dropped, good rows survive in order`);
    if ('cycle_cap' in c && c.wantCap === undefined) assert.ok(!('cycle_cap' in p), `${c.name}: a malformed cycle_cap is dropped`);
    else if ('wantCap' in c) assert.equal(p.cycle_cap, c.wantCap, `${c.name}: cycle_cap stored`);
    for (const r of (p.cycles as Record<string, unknown>[]) ?? []) {
      assert.ok(typeof r.cycle_id === 'string' && (r.cycle_id as string).length <= 128, `${c.name}: cycle_id trimmed to ≤128`);
    }
  }
});


// ---------------------------------------------------------------------------
// Sessions (#32/#33): HTTP surface — register/heartbeat, /api/state rows,
// operator override.
// ---------------------------------------------------------------------------

test('sessions: register creates (201), heartbeat updates (200), /api/state lists with override', async () => {
  const reg = await fetch(`${base}/api/sessions/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ token: 's-http-1', client_id: clientId, last_activity: Date.now() - 5000 }),
  });
  assert.equal(reg.status, 201, 'first sight creates the row');
  const created = (await reg.json()) as { created: boolean; session: { token: string } };
  assert.equal(created.created, true);
  assert.equal(created.session.token, 's-http-1');

  const hb = await fetch(`${base}/api/sessions/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ token: 's-http-1' }),
  });
  assert.equal(hb.status, 200, 'heartbeat is idempotent');

  const st = (await (await fetch(`${base}/api/state?limit=5`, { headers: auth })).json()) as {
    sessions: { token: string; override: unknown }[];
  };
  const row = st.sessions.find((x) => x.token === 's-http-1');
  assert.ok(row, 'session rides /api/state');
  assert.equal(row.override, null);

  const bad = await fetch(`${base}/api/sessions/register`, { method: 'POST', headers: auth, body: JSON.stringify({}) });
  assert.equal(bad.status, 400, 'token required');
});

// gate-state over REST: the register body's gate block stores on the row,
// /api/state + /api/sessions carry it verbatim, the idle report (absent
// block) clears it, an invalid block is dropped without rejecting the
// registration.
test('sessions: gate block over REST — stored, carried by /api/state + /api/sessions, cleared on idle, invalid dropped', async () => {
  const reg = await fetch(`${base}/api/sessions/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ token: 's-gate-1', gate: { state: 'queued', waiting: 2 } }),
  });
  assert.equal(reg.status, 201);
  const created = (await reg.json()) as { session: { gate: unknown } };
  assert.deepEqual(created.session.gate, { state: 'queued', waiting: 2 }, 'create response carries the gate');

  const st = (await (await fetch(`${base}/api/state?limit=5`, { headers: auth })).json()) as {
    sessions: { token: string; gate?: { state: string; waiting: number } | null }[];
  };
  assert.deepEqual(st.sessions.find((x) => x.token === 's-gate-1')?.gate, { state: 'queued', waiting: 2 }, '/api/state carries it');
  const list = (await (await fetch(`${base}/api/sessions`, { headers: auth })).json()) as {
    sessions: { token: string; gate?: { state: string; waiting: number } | null }[];
  };
  assert.deepEqual(list.sessions.find((x) => x.token === 's-gate-1')?.gate, { state: 'queued', waiting: 2 }, '/api/sessions carries it');

  // Invalid block: 2xx (never rejected), stored value untouched.
  const bad = await fetch(`${base}/api/sessions/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ token: 's-gate-1', gate: { state: 'nope', waiting: 1 } }),
  });
  assert.equal(bad.status, 200, 'invalid gate never rejects the heartbeat');
  const stBad = (await (await fetch(`${base}/api/state?limit=5`, { headers: auth })).json()) as {
    sessions: { token: string; gate?: { state: string; waiting: number } | null }[];
  };
  assert.deepEqual(stBad.sessions.find((x) => x.token === 's-gate-1')?.gate, { state: 'queued', waiting: 2 }, 'invalid block dropped');

  // Idle report (no gate key): the stored gate CLEARS.
  await fetch(`${base}/api/sessions/register`, { method: 'POST', headers: auth, body: JSON.stringify({ token: 's-gate-1' }) });
  const stClr = (await (await fetch(`${base}/api/state?limit=5`, { headers: auth })).json()) as {
    sessions: { token: string; gate?: unknown }[];
  };
  assert.equal(stClr.sessions.find((x) => x.token === 's-gate-1')?.gate, null, 'absent gate clears to null');

  // Back-compat: a body without the gate key is a plain heartbeat (200).
  const plain = await fetch(`${base}/api/sessions/register`, { method: 'POST', headers: auth, body: JSON.stringify({ token: 's-gate-1' }) });
  assert.equal(plain.status, 200);
});

test('sessions: operator override via API — set, expose, clear; 404 unknown token', async () => {
  await fetch(`${base}/api/sessions/register`, { method: 'POST', headers: auth, body: JSON.stringify({ token: 's-http-2' }) });

  const set = await fetch(`${base}/api/sessions/s-http-2/override`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ override: 'pause' }),
  });
  assert.equal(set.status, 200);

  const list = (await (await fetch(`${base}/api/sessions`, { headers: auth })).json()) as {
    sessions: { token: string; override: { override: string } | null }[];
  };
  assert.equal(list.sessions.find((x) => x.token === 's-http-2')?.override?.override, 'pause');

  const st = (await (await fetch(`${base}/api/state?limit=5`, { headers: auth })).json()) as {
    sessions: { token: string; override: { override: string } | null }[];
  };
  assert.equal(st.sessions.find((x) => x.token === 's-http-2')?.override?.override, 'pause', 'state view carries it too');

  const bad = await fetch(`${base}/api/sessions/s-nope/override`, { method: 'POST', headers: auth, body: JSON.stringify({ override: 'pause' }) });
  assert.equal(bad.status, 404, 'unknown session token');

  const invalid = await fetch(`${base}/api/sessions/s-http-2/override`, { method: 'POST', headers: auth, body: JSON.stringify({ override: 'bogus' }) });
  assert.equal(invalid.status, 400);

  const clr = await fetch(`${base}/api/sessions/s-http-2/override`, { method: 'POST', headers: auth, body: JSON.stringify({ override: null }) });
  assert.equal(clr.status, 200);
  const st2 = (await (await fetch(`${base}/api/state?limit=5`, { headers: auth })).json()) as {
    sessions: { token: string; override: unknown }[];
  };
  assert.equal(st2.sessions.find((x) => x.token === 's-http-2')?.override, null);
});

test('leases: server_id round-trips through POST /api/leases (unknown engine = 409)', async () => {
  const bad = await fetch(`${base}/api/leases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: 'j-srv', estimated_seconds: 60, server_id: 'srv-nope' }),
  });
  assert.equal(bad.status, 409);
  assert.equal(((await bad.json()) as { reason: string }).reason, 'unknown_server');
});

// ---------------------------------------------------------------------------
// Per-job results over REST (issue #4): usage reports store the last outcome
// per (project, job_id); GET /api/projects/:name/results serves it newest
// first. (The storage semantics — replace, cap — are covered in
// arbiter.test.ts; this block is the wire contract.)
// ---------------------------------------------------------------------------

/** Grant + finish one job over HTTP; returns the lease id. */
async function finishJob(jobId: string, usage: Record<string, unknown>): Promise<string> {
  const lease = await fetch(`${base}/api/leases`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: clientId, project: 'career-ops', job_id: jobId, estimated_seconds: 60 }),
  });
  assert.equal(lease.status, 201, `grant for ${jobId}: ${await lease.clone().text()}`);
  const leaseId = ((await lease.json()) as { lease_id: string }).lease_id;
  const use = await fetch(`${base}/api/leases/${leaseId}/usage`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(usage),
  });
  assert.equal(use.status, 200, `usage for ${jobId}`);
  // ts is server-receive time at ms resolution; pace the reports so the
  // newest-first assertions can't collide on one millisecond.
  await new Promise((r) => setTimeout(r, 5));
  return leaseId;
}


// ---------------------------------------------------------------------------
// Gate posture (#41): the client router publishes its OWN armed-vs-fail_open
// state on the register heartbeat. The arbiter sanitizes (exact enum, else
// dropped), stores + echoes it on the client row AND the per-project worker
// row (surfaces read either), and a later `armed` report overwrites a stale
// `fail_open` within one heartbeat. Absent = old client / gate-less daemon:
// the row carries no key and the surfaces render exactly as before.
// ---------------------------------------------------------------------------

test('gate posture: an armed report stores + echoes on the client row and the worker row', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'posture-armed',
      gate_posture: 'armed',
      projects: [{ name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 0 }],
    }),
  });
  assert.equal(reg.status, 200);
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; gate_posture?: string }[];
    projects: { name: string; workers: { client: string; gate_posture?: string }[] }[];
  };
  assert.equal(st.clients.find((c) => c.name === 'posture-armed')!.gate_posture, 'armed', 'the client row carries the posture');
  const w = st.projects.find((p) => p.name === 'career-ops')!.workers.find((x) => x.client === 'posture-armed')!;
  assert.equal(w.gate_posture, 'armed', 'the worker row carries it too (the dashboard badge reads this)');
});

test('gate posture: a fail_open report stores; the next armed heartbeat overwrites it', async () => {
  await fetch(`${base}/api/clients/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'posture-flip', gate_posture: 'fail_open' }),
  });
  let st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; gate_posture?: string }[];
  };
  assert.equal(st.clients.find((c) => c.name === 'posture-flip')!.gate_posture, 'fail_open', 'the badge state is stored while the link is down');

  // The recovery path: the link returns, the daemon re-registers armed, and
  // the stale fail_open is gone within one heartbeat (the badge clears).
  await fetch(`${base}/api/clients/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'posture-flip', gate_posture: 'armed' }),
  });
  st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; gate_posture?: string }[];
  };
  assert.equal(st.clients.find((c) => c.name === 'posture-flip')!.gate_posture, 'armed', 'a recovered gate overwrites the stale fail_open');
});

test('gate posture: a register WITHOUT the key keeps registering with no key (old client / gate-less daemon)', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'posture-legacy' }),
  });
  assert.equal(reg.status, 200, 'pre-#41 clients keep registering');
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; gate_posture?: string }[];
  };
  assert.ok(!('gate_posture' in st.clients.find((c) => c.name === 'posture-legacy')!), 'no posture key on an old client row (surfaces render as before)');
});

test('gate posture: a malformed posture value is dropped, never rejected', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'posture-bad', gate_posture: 'yes-please' }),
  });
  assert.equal(reg.status, 200, 'a malformed posture never rejects a registration');
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; gate_posture?: string }[];
  };
  assert.ok(!('gate_posture' in st.clients.find((c) => c.name === 'posture-bad')!), 'a value outside the enum is dropped');
});

test('results endpoint: score rides the usage body → row stored; newest-first, limit, job_id filter, 404, auth gate', async () => {
  // Quiet feed so the grants are clean.
  entries.length = 0;
  entries.push(...mkEntries([400], 'ip:10.0.0.9', Date.now()));
  await det.poll(Date.now(), new Set());
  // The sessions test above left s-http-1 with fresh last_activity on the
  // WATCHED server — session activity within idle_seconds defeats the idle
  // verdict, and last_activity only ever moves forward (Math.max), so the
  // only lever is the heartbeat's server_id reassignment: move the session
  // row off the watched engine (a supported register field) so its activity
  // no longer folds into this server's idle calc.
  await fetch(`${base}/api/sessions/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ token: 's-http-1', server_id: 'srv-unwatched' }),
  });

  // Three jobs, finished in order (small token counts — the project's daily
  // cap is 10k and earlier tests already spent some).
  await finishJob('res-1', { ok: true, tokens_out: 10, tokens_in: 20, score: 3.5 });
  await finishJob('res-2', { ok: false, error: 'executor_exit_1', tokens_out: 5 });
  await finishJob('res-3', { ok: true, tokens_out: 7, score: 9.25 });

  const res = await fetch(`${base}/api/projects/career-ops/results`, { headers: auth });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { project: string; count: number; results: Record<string, unknown>[] };
  assert.equal(body.project, 'career-ops');
  assert.ok(Array.isArray(body.results), 'results is an array');
  assert.equal(body.count, body.results.length, 'count mirrors the page length');

  // The three new rows are the newest; order is newest-first.
  const mine = body.results.filter((r) => String(r.job_id).startsWith('res-'));
  assert.deepEqual(mine.map((r) => r.job_id), ['res-3', 'res-2', 'res-1'], 'newest first');
  const r3 = mine[0]!;
  assert.equal(r3.ok, true);
  assert.equal(r3.score, 9.25, 'the usage-body score is stored on the row');
  assert.equal(r3.tokens_out, 7);
  assert.equal(r3.error, null, 'success row: error null');
  assert.equal(typeof r3.ts, 'string', 'ts is an ISO string');
  const r2 = mine[1]!;
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'executor_exit_1', 'failure row carries the error');
  assert.equal(r2.score, null, 'failure path without score ⇒ null');

  // A SECOND report for the same job replaces the row (latest-only).
  await finishJob('res-1', { ok: true, tokens_out: 11, score: 8 });
  const res2 = await fetch(`${base}/api/projects/career-ops/results?job_id=res-1`, { headers: auth });
  const b2 = (await res2.json()) as { count: number; results: Record<string, unknown>[] };
  assert.equal(b2.count, 1, 'job_id filter: exactly one row for the job');
  assert.equal(b2.results[0]!.job_id, 'res-1');
  assert.equal(b2.results[0]!.score, 8, 'the second report REPLACED the row (latest-only)');

  // limit: the newest N only.
  const lim = (await (await fetch(`${base}/api/projects/career-ops/results?limit=2`, { headers: auth })).json()) as { count: number; results: { job_id: string }[] };
  assert.equal(lim.count, 2, 'limit=2 returns two rows');
  assert.deepEqual(lim.results.map((r) => r.job_id), ['res-1', 'res-3'], 'limit takes the newest rows (res-1 was just re-reported)');

  // Unknown project → 404 like sibling project routes.
  const nf = await fetch(`${base}/api/projects/nope-project/results`, { headers: auth });
  assert.equal(nf.status, 404);

  // Auth gate: the anonymous /api/state exception does NOT extend here.
  const anon = await fetch(`${base}/api/projects/career-ops/results`);
  assert.equal(anon.status, 401, 'results are token-gated (no anonymous read)');
});

// ---------------------------------------------------------------------------
// #42 Slice 0 — session_id ADD-key on the register heartbeat (the router
// captured it from X-Hermes-Session-Id). Storage posture mirrors the token
// rule: bounded printable, drop-don't-reject, last-known-wins (an absent
// report never clears a stored id — headerless follow-ups are routine).
// ---------------------------------------------------------------------------

test('session_id (#42): a valid report stores on the row and rides /api/state + /api/sessions', async () => {
  const reg = await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's42-valid', client_name: 'mac-mini', session_id: '20261005_172826_f38167' }),
  });
  assert.equal(reg.status, 201);
  const body = await reg.json() as { session: { session_id?: string } };
  assert.equal(body.session.session_id, '20261005_172826_f38167', 'the create response carries it');

  const list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as { sessions: { token: string; session_id?: string }[] };
  assert.equal(list.sessions.find((s) => s.token === 's42-valid')!.session_id, '20261005_172826_f38167');
});

test('session_id (#42): a later heartbeat WITHOUT the key keeps the stored id (last-known-wins)', async () => {
  await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's42-keep', session_id: 'sess-keep-me' }),
  });
  const hb = await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's42-keep', last_activity: Date.now() }),
  });
  assert.equal(hb.status, 200);
  const body = await hb.json() as { session: { session_id?: string } };
  assert.equal(body.session.session_id, 'sess-keep-me', 'a headerless heartbeat never clears the id');
});

test('session_id (#42): an invalid report is DROPPED — registration succeeds, stored value stands', async () => {
  await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's42-bad', session_id: 'good-id' }),
  });
  for (const bad of ['x'.repeat(129), 'has\u0007control', '   ', 42, { nested: true }]) {
    const r = await fetch(`${base}/api/sessions/register`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ token: 's42-bad', session_id: bad }),
    });
    assert.equal(r.status, 200, 'a malformed session_id never rejects the heartbeat');
  }
  const list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as { sessions: { token: string; session_id?: string }[] };
  assert.equal(list.sessions.find((s) => s.token === 's42-bad')!.session_id, 'good-id', 'the stored id survives malformed reports');

  // A brand-new row with only a malformed id starts WITHOUT the key.
  const fresh = await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's42-freshbad', session_id: 'x'.repeat(129) }),
  });
  assert.equal(fresh.status, 201);
  const fb = await fresh.json() as { session: Record<string, unknown> };
  assert.ok(!('session_id' in fb.session), 'the fresh row starts id-less');
});

test('session_id (#42): two concurrent sessions on one client keep distinct ids (the one-row complaint)', async () => {
  // The observable win from the brief: two Hermes chats on one profile are
  // two rows distinguished by id even before the plugin lands.
  for (const [tok, id] of [['s42-chatA', 'chat-a-111'], ['s42-chatB', 'chat-b-222']] as const) {
    await fetch(`${base}/api/sessions/register`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ token: tok, client_name: 'mac-mini', session_id: id }),
    });
  }
  const list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as { sessions: { token: string; session_id?: string; client_name?: string }[] };
  const mine = list.sessions.filter((s) => s.client_name === 'mac-mini' && s.token.startsWith('s42-chat'));
  assert.equal(mine.length, 2, 'two rows, not one');
  assert.deepEqual(new Set(mine.map((s) => s.session_id)), new Set(['chat-a-111', 'chat-b-222']), 'each row keeps its own conversation id');
});

// ---------------------------------------------------------------------------
// #43 session launcher — the register heartbeat's proxy_port ADD-key: the
// port the router's proxy actually bound. Sanitized integer 1..65535,
// stored on valid reports (same heartbeat rule as version/revision),
// echoed exception-only on the client row and the per-project worker row.
// ---------------------------------------------------------------------------

test('proxy_port (#43): a valid report stores + echoes on the client row and the worker row', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      name: 'launcher-client',
      proxy_port: 11435,
      projects: [{ name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 0 }],
    }),
  });
  assert.equal(reg.status, 200);
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; proxy_port?: number }[];
    projects: { name: string; workers: { client: string; proxy_port?: number }[] }[];
  };
  assert.equal(st.clients.find((c) => c.name === 'launcher-client')!.proxy_port, 11435, 'the client row carries the bound port');
  const w = st.projects.find((p) => p.name === 'career-ops')!.workers.find((x) => x.client === 'launcher-client')!;
  assert.equal(w.proxy_port, 11435, 'the worker row carries it too (the launcher lists rows from this)');
});

test('proxy_port (#43): malformed values are dropped, never rejected; absent = no key (old client)', async () => {
  for (const bad of [0, -5, 70000, 12.5, '11435', null]) {
    const r = await fetch(`${base}/api/clients/register`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'launcher-bad', proxy_port: bad }),
    });
    assert.equal(r.status, 200, 'a malformed proxy_port never rejects the registration');
  }
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; proxy_port?: number }[];
  };
  assert.ok(!('proxy_port' in st.clients.find((c) => c.name === 'launcher-bad')!), 'every malformed value is dropped');

  const legacy = await fetch(`${base}/api/clients/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'launcher-legacy' }),
  });
  assert.equal(legacy.status, 200);
  const st2 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; proxy_port?: number }[];
  };
  assert.ok(!('proxy_port' in st2.clients.find((c) => c.name === 'launcher-legacy')!), 'an old client row carries no port (the launcher stays hidden for it)');
});

test('proxy_port (#43): a later heartbeat without the key keeps the stored port', async () => {
  await fetch(`${base}/api/clients/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'launcher-keep', proxy_port: 44000 }),
  });
  await fetch(`${base}/api/clients/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'launcher-keep' }),
  });
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; proxy_port?: number }[];
  };
  assert.equal(st.clients.find((c) => c.name === 'launcher-keep')!.proxy_port, 44000, 'the port rides the row until the next valid report (the daemon registers before the proxy binds on boot)');
});

test('queue position (#44): a valid position stores + echoes; malformed drops only the key', async () => {
  await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's44-pos', gate: { state: 'queued', waiting: 2, position: 3 } }),
  });
  let list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as { sessions: { token: string; gate?: { state: string; waiting: number; position?: number } }[] };
  assert.deepEqual(list.sessions.find((s) => s.token === 's44-pos')!.gate, { state: 'queued', waiting: 2, position: 3 }, 'the queued row carries its place in line');

  // A malformed position drops ONLY the key — the queued state still rides
  // (drop-don't-reject, per-key, inside the gate block).
  await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's44-pos', gate: { state: 'queued', waiting: 1, position: 0 } }),
  });
  list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as typeof list;
  assert.deepEqual(list.sessions.find((s) => s.token === 's44-pos')!.gate, { state: 'queued', waiting: 1 }, 'position=0 is dropped; the block minus the key stores');

  // An old router (no key): the block stores without position, unchanged.
  await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's44-old', gate: { state: 'queued', waiting: 1 } }),
  });
  list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as typeof list;
  assert.deepEqual(list.sessions.find((s) => s.token === 's44-old')!.gate, { state: 'queued', waiting: 1 }, 'old routers keep the exact old shape');
});

test('force on a session row (#44): the override stores, state echoes it, clear removes it', async () => {
  await fetch(`${base}/api/sessions/register`, { method: 'POST', headers: auth, body: JSON.stringify({ token: 's44-force' }) });
  const set = await fetch(`${base}/api/sessions/s44-force/override`, {
    method: 'POST', headers: auth, body: JSON.stringify({ override: 'force' }),
  });
  assert.equal(set.status, 200, 'the API accepts force for a session (it always did — #44 exposes the control)');
  let st = (await (await fetch(`${base}/api/state?limit=1`, { headers: auth })).json()) as { sessions: { token: string; override: { override: string } | null }[] };
  assert.equal(st.sessions.find((s) => s.token === 's44-force')!.override!.override, 'force');
  await fetch(`${base}/api/sessions/s44-force/override`, { method: 'POST', headers: auth, body: JSON.stringify({ override: null }) });
  st = (await (await fetch(`${base}/api/state?limit=1`, { headers: auth })).json()) as typeof st;
  assert.equal(st.sessions.find((s) => s.token === 's44-force')!.override, null, 'clear returns the row to the cap');
});

test('session history (#45): valid block stores + echoes; malformed keys drop; empty block is absent', async () => {
  const rpm = [0, 0, 0, 1, 2, 0, 0, 0, 3, 5];
  const a = await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's45-a', history: { rpm, model: 'qwen3.8-27b', tokens: 1234 } }),
  });
  assert.equal(a.status, 201);
  let list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as { sessions: { token: string; history?: { rpm: number[]; model?: string; tokens?: number; reported_at: number } }[] };
  const ha = list.sessions.find((s) => s.token === 's45-a')!.history!;
  assert.deepEqual(ha.rpm, rpm, 'the per-minute series rides verbatim');
  assert.equal(ha.model, 'qwen3.8-27b');
  assert.equal(ha.tokens, 1234);
  assert.ok(ha.reported_at > 0, 'the arbiter stamps when the snapshot arrived');

  // Malformed keys drop per-key; the valid ones survive.
  await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's45-b', history: { rpm: [1, -5, 'x', 2], model: '', tokens: 1e15 } }),
  });
  list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as typeof list;
  const hb = list.sessions.find((s) => s.token === 's45-b')!.history!;
  assert.deepEqual(hb.rpm, [1, 2], 'negative/non-integer counts dropped');
  assert.equal(hb.model, undefined, 'empty model dropped');
  assert.equal(hb.tokens, undefined, 'out-of-range tokens dropped');

  // A block with NOTHING valid is treated as absent — the row has no key.
  const c = await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's45-c', history: { rpm: [] } }),
  });
  assert.equal(c.status, 201);
  list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as typeof list;
  assert.equal(list.sessions.find((s) => s.token === 's45-c')!.history, undefined, 'empty history = absent');

  // Absent leaves the stored block standing (ADD-key posture).
  await fetch(`${base}/api/sessions/register`, { method: 'POST', headers: auth, body: JSON.stringify({ token: 's45-a' }) });
  list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json() as typeof list;
  assert.deepEqual(list.sessions.find((s) => s.token === 's45-a')!.history!.rpm, rpm, 'no report never clears the block');
});

// ---------------------------------------------------------------------------
// Aggregate endpoint server plane (#64): the arbiter-built catalog published
// as the `catalog` ADD-key + the loopback-scoped GET /api/server-keys.
// Self-contained: its own Arbiter + Fastify app driven by app.inject, so the
// custom `remoteAddress` (the loopback test seam) is exact and the tests
// above stay untouched. No network.
// ---------------------------------------------------------------------------

import { buildCatalog, isLoopbackAddress, modelsProbeUrl, parseModelsPayload } from '../src/catalog.js';

const AGG_TOKEN = 'agg-' + 'test-' + 'tk7c';

test('#64 catalog merge rules (buildCatalog): probe replaces, dedup pins row order, token never rides', () => {
  const now = Date.now();
  const mk = (id: string, url: string, models: string[], auth?: string) => ({
    id, name: id, url, activity_path: '', ...(auth ? { auth_token: auth } : {}),
    models, peers: [], configured_at: now, updated_at: now,
  });
  const rows = [mk('row-a', 'http://a.local:8000', ['Shared', 'AOnly'], 'tok-a'), mk('row-b', 'http://b.local:8080', ['Shared', 'BOnly'])];
  const cat = buildCatalog(rows, new Map([['row-a', ['NewOnly', 'Shared']]]));
  const byName = new Map(cat.map((e) => [e.name, e]));
  assert.deepEqual([...byName.keys()].sort(), ['BOnly', 'NewOnly', 'Shared'], 'bare names dedup');
  assert.equal(byName.get('Shared')!.server_id, 'row-a', 'first row in declaration order owns the collision');
  assert.ok(!byName.has('AOnly'), 'probe success REPLACES the row declared list');
  assert.equal(byName.get('NewOnly')!.catalog_source, 'probed');
  assert.equal(byName.get('BOnly')!.catalog_source, 'declared', 'an unprobed row is never falsely probed');
  assert.equal(byName.get('NewOnly')!.auth_set, true);
  assert.equal(byName.get('BOnly')!.auth_set, false);
  for (const e of cat) assert.ok(!('auth_token' in e), 'no catalog entry carries the token');
});

test('#64 modelsProbeUrl / parseModelsPayload / isLoopbackAddress helpers', () => {
  assert.equal(modelsProbeUrl('http://h:8000'), 'http://h:8000/v1/models');
  assert.equal(modelsProbeUrl('http://h:8000/'), 'http://h:8000/v1/models');
  assert.equal(modelsProbeUrl('https://strata.example/v1'), 'https://strata.example/v1/models');
  assert.deepEqual(parseModelsPayload({ data: [{ id: 'a' }, { name: 'c' }, null, 3] }), ['a', 'c']);
  assert.deepEqual(parseModelsPayload({ models: ['x', 'x', ' y '] }), ['x', 'y']);
  assert.deepEqual(parseModelsPayload(['p', 'q']), ['p', 'q']);
  assert.deepEqual(parseModelsPayload(null), []);
  for (const loop of ['127.0.0.1', '127.42.1.7', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopbackAddress(loop), `${loop} is loopback`);
  for (const away of ['100.105.225.1', '10.10.10.241', '::ffff:10.10.10.241', undefined]) assert.ok(!isLoopbackAddress(away), `${away} is not loopback`);
});

test('#64 probeCatalog: blocked probe keeps the declared list (never falsely probed); probe is credentialed per row', async () => {
  const aggDir = mkdtempSync(join(tmpdir(), 'idlefill-agg-'));
  try {
    const aggCfg: ServerConfig = { ...cfg, state_file: join(aggDir, 'state.json') };
    const seen: { url: string; auth: string | undefined }[] = [];
    const aggArbiter = new Arbiter(new StateStore(aggCfg.state_file), aggCfg, det, {
      modelsFetcher: async (url, auth) => {
        seen.push({ url, auth });
        if (url.includes('omlx')) throw new Error('probe HTTP 401');
        return ['WatchedProbed'];
      },
    });
    const up = aggArbiter.upsertServerConnection({
      name: 'omlx', url: 'http://omlx.local:8000', models: ['MlxDeclared'], activity_path: '', auth_token: 'sekret-omlx-token',
    });
    assert.ok(up.ok && up.created);
    const cat = await aggArbiter.probeCatalog();
    const watched = seen.find((s) => s.url.includes('fake'));
    const omlx = seen.find((s) => s.url.includes('omlx'));
    assert.ok(watched && omlx, 'every declared row gets a probe');
    assert.equal(omlx!.auth, 'sekret-omlx-token', 'the row token reaches the fetcher (credentialed probe)');
    assert.equal(watched!.auth, undefined, 'a keyless row sends no credential');
    const mlx = cat.find((e) => e.name === 'MlxDeclared');
    assert.ok(mlx, 'a blocked probe NEVER loses the declared inventory');
    assert.equal(mlx!.catalog_source, 'declared', 'probe-blocked row stays declared');
    assert.equal(mlx!.auth_set, true, 'auth_set rides; the token does not');
    assert.ok(cat.some((e) => e.name === 'WatchedProbed' && e.catalog_source === 'probed'));
  } finally {
    rmSync(aggDir, { recursive: true, force: true });
  }
});

test('#64 /api/state catalog ADD-key: shape + auth_set, and no token anywhere (anonymous AND authed)', async () => {
  const aggDir = mkdtempSync(join(tmpdir(), 'idlefill-agg2-'));
  try {
    const aggCfg: ServerConfig = { ...cfg, api_tokens: [AGG_TOKEN], state_file: join(aggDir, 'state.json') };
    const aggArbiter = new Arbiter(new StateStore(aggCfg.state_file), aggCfg, det, {
      modelsFetcher: async (url) => {
        if (url.includes('omlx')) throw new Error('probe HTTP 401');
        return ['WatchedProbed'];
      },
    });
    aggArbiter.upsertServerConnection({ name: 'omlx', url: 'http://omlx.local:8000', models: ['MlxDeclared'], activity_path: '', auth_token: 'sekret-omlx-token' });
    await aggArbiter.probeCatalog();
    const aggApp = buildApi({ arbiter: aggArbiter, cfg: aggCfg, publicDir: join(__dirname, '..', 'public') });
    await aggApp.ready();
    try {
      for (const inject of [
        { method: 'GET' as const, url: '/api/state' },
        { method: 'GET' as const, url: '/api/state', headers: { authorization: `Bearer ${AGG_TOKEN}` } },
      ]) {
        const res = await aggApp.inject(inject);
        assert.equal(res.statusCode, 200);
        const st = res.json() as { catalog?: { name: string; server_id: string; url: string; auth_set: boolean; catalog_source: string }[] };
        assert.ok(Array.isArray(st.catalog), 'catalog block present on /api/state');
        assert.ok(st.catalog!.some((e) => e.name === 'WatchedProbed' && e.catalog_source === 'probed'));
        const mlx = st.catalog!.find((e) => e.name === 'MlxDeclared');
        assert.ok(mlx && mlx.auth_set === true && mlx.catalog_source === 'declared');
        for (const e of st.catalog!) {
          assert.equal(typeof e.name, 'string');
          assert.equal(typeof e.server_id, 'string');
          assert.equal(typeof e.url, 'string');
          assert.equal(typeof e.auth_set, 'boolean');
        }
        assert.ok(!res.body.includes('auth_token'), 'the field name auth_token never appears in the state view');
        assert.ok(!res.body.includes('sekret-omlx-token'), 'the token VALUE never appears in the state view');
      }
    } finally {
      await aggApp.close();
    }
  } finally {
    rmSync(aggDir, { recursive: true, force: true });
  }
});

test('#64 GET /api/server-keys: loopback + admin token answers keyed rows; non-loopback is 403 even with a valid admin token; no token never passes', async () => {
  const aggDir = mkdtempSync(join(tmpdir(), 'idlefill-keys-'));
  try {
    const aggCfg: ServerConfig = { ...cfg, api_tokens: [AGG_TOKEN], state_file: join(aggDir, 'state.json') };
    const aggArbiter = new Arbiter(new StateStore(aggCfg.state_file), aggCfg, det);
    aggArbiter.upsertServerConnection({ name: 'omlx', url: 'http://omlx.local:8000', models: [], activity_path: '', auth_token: 'sekret-omlx-token' });
    aggArbiter.upsertServerConnection({ name: 'lmstudio', url: 'http://lms.local:1234', models: [], activity_path: '' });
    const aggApp = buildApi({ arbiter: aggArbiter, cfg: aggCfg, publicDir: join(__dirname, '..', 'public') });
    await aggApp.ready();
    try {
      const ok = await aggApp.inject({ method: 'GET', url: '/api/server-keys', remoteAddress: '127.0.0.1', headers: { authorization: `Bearer ${AGG_TOKEN}` } });
      assert.equal(ok.statusCode, 200);
      const body = ok.json() as { server_keys: { id: string; name: string; url: string; auth_token: string }[] };
      assert.ok(Array.isArray(body.server_keys));
      const omlx = body.server_keys.find((r) => r.name === 'omlx');
      assert.ok(omlx, 'the keyed row is handed to the machine own router');
      assert.equal(omlx!.auth_token, 'sekret-omlx-token');
      assert.equal(omlx!.url, 'http://omlx.local:8000');
      assert.ok(!body.server_keys.some((r) => r.name === 'lmstudio'), 'a keyless row is not returned');
      assert.ok(body.server_keys.every((r) => r.auth_token !== ''));

      for (const remote of ['100.105.225.1', '10.10.10.241', '100.94.165.103']) {
        const denied = await aggApp.inject({ method: 'GET', url: '/api/server-keys', remoteAddress: remote, headers: { authorization: `Bearer ${AGG_TOKEN}` } });
        assert.equal(denied.statusCode, 403, `non-loopback ${remote} refused despite a valid admin token`);
        assert.ok(!denied.body.includes('sekret-omlx-token'), 'the refusal body carries no token');
      }
      const anon = await aggApp.inject({ method: 'GET', url: '/api/server-keys', remoteAddress: '127.0.0.1' });
      assert.equal(anon.statusCode, 401, 'the key route is NOT an anonymous exception');
      const wrong = await aggApp.inject({ method: 'GET', url: '/api/server-keys', remoteAddress: '127.0.0.1', headers: { authorization: 'Bearer ' + 'no-pe-9' } });
      assert.equal(wrong.statusCode, 401, 'the loopback check never loosens auth');
      const peer = await aggApp.inject({ method: 'GET', url: '/api/server-keys', remoteAddress: '127.0.0.1', headers: { authorization: 'Bearer nope' } });
      assert.equal(peer.statusCode, 401);
    } finally {
      await aggApp.close();
    }
  } finally {
    rmSync(aggDir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// #61 step 3 A1 — `daemon behind` in the page: the client computes the
// verdict where the facts live (boot revision vs the live HEAD of ITS OWN
// checkout) and publishes the boolean on the register heartbeat. Posture:
// exact boolean or dropped (drop-don't-reject); `true` stores the marker,
// `false` CLEARS it (the explicit no-exception report clears the stored
// exception — the surfaces' tag must clear within one heartbeat of a
// restart); ABSENT (old client) leaves the row exactly as it was.
// ---------------------------------------------------------------------------

test('daemon_behind (#61 A1): true stores and echoes on the client + worker rows; false clears', async () => {
  await fetch(`${base}/api/clients/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'behind-true', projects: [{ name: 'career-ops', model: 'm', estimated_seconds: 1, queue_depth: 0 }] }),
  });
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'behind-true', daemon_behind: true }) });
  let st = (await (await fetch(`${base}/api/state?limit=1`, { headers: auth })).json()) as {
    clients: { name: string; daemon_behind?: boolean }[];
    projects: { name: string; workers: { client: string; daemon_behind?: boolean }[] }[];
  };
  assert.equal(st.clients.find((c) => c.name === 'behind-true')!.daemon_behind, true, 'the client row carries the verdict');
  assert.equal(st.projects.find((p) => p.name === 'career-ops')!.workers.find((w) => w.client === 'behind-true')!.daemon_behind, true, 'the worker row carries it too (the tag renders from this)');

  // A current daemon reports false: the marker CLEARS within one heartbeat.
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'behind-true', daemon_behind: false }) });
  st = (await (await fetch(`${base}/api/state?limit=1`, { headers: auth })).json()) as typeof st;
  assert.ok(!('daemon_behind' in st.clients.find((c) => c.name === 'behind-true')!), 'false clears the stored marker (no exception, no key)');
});

test('daemon_behind (#61 A1): non-booleans drop without rejecting; absent leaves the row as-is', async () => {
  for (const bad of ['yes', 1, null, {}, 'true']) {
    const r = await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'behind-bad', daemon_behind: bad }) });
    assert.equal(r.status, 200, 'a malformed verdict never rejects the heartbeat');
  }
  let st = (await (await fetch(`${base}/api/state?limit=1`, { headers: auth })).json()) as { clients: { name: string; daemon_behind?: boolean }[] };
  assert.ok(!('daemon_behind' in st.clients.find((c) => c.name === 'behind-bad')!), 'every malformed value is dropped');

  // A stored true survives a LATER heartbeat that omits the key (a
  // pre-#61-step-3 client never changes the row).
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'behind-keep', daemon_behind: true }) });
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'behind-keep' }) });
  st = (await (await fetch(`${base}/api/state?limit=1`, { headers: auth })).json()) as typeof st;
  assert.equal(st.clients.find((c) => c.name === 'behind-keep')!.daemon_behind, true, 'an absent report leaves the stored verdict as-is');
});

// ---------------------------------------------------------------------------
// #61 step 3 A2 — the client log tail: an array of short strings published
// ONLY to a loopback arbiter. Bounded hard (state-file discipline): ≤120
// lines, per-line cap ~300, non-strings dropped; a malformed (non-array)
// report drops the whole key; an empty array CLEARS the tail; an absent
// report leaves the row untouched. A legacy register leaves rows
// byte-identical.
// ---------------------------------------------------------------------------

test('client_log (#61 A2): stores verbatim, bounds lines/count, clears on empty, absent leaves rows as-is', async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(400)}`);
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'clog-a', client_log: [...lines, 42, null, '  '] }) });
  let st = (await (await fetch(`${base}/api/state?limit=1`, { headers: auth })).json()) as { clients: { name: string; client_log?: string[] }[] };
  const row = st.clients.find((c) => c.name === 'clog-a')!;
  assert.equal(row.client_log!.length, 120, 'the tail is capped at 120 lines');
  assert.ok(row.client_log!.every((l) => l.length <= 300), 'every line is capped at 300 chars');
  assert.equal(row.client_log![0]!.slice(0, 6), 'line 0', 'oldest-first order preserved');
  assert.ok(!row.client_log!.some((l) => l === '' || l === 'null' || l === '42'), 'non-string / blank entries dropped');

  // Malformed: a non-array drops the whole key (the previously stored tail
  // stays — a garbage report never rewrites it).
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'clog-a', client_log: 'tail -f' }) });
  st = (await (await fetch(`${base}/api/state?limit=1`, { headers: auth })).json()) as typeof st;
  assert.equal(st.clients.find((c) => c.name === 'clog-a')!.client_log!.length, 120, 'a non-array leaves the stored tail untouched');

  // An empty array CLEARS (a daemon that moved to a remote arbiter stops
  // publishing lines; stale lines must not sit on the row forever).
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'clog-a', client_log: [] }) });
  st = (await (await fetch(`${base}/api/state?limit=1`, { headers: auth })).json()) as typeof st;
  assert.ok(!('client_log' in st.clients.find((c) => c.name === 'clog-a')!), 'empty tail deletes the key');
});

test('legacy register (#61): a client sending neither new key leaves rows byte-identical', async () => {
  const body = { name: 'legacy-61', ip: '10.9.9.9', projects: [{ name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 60, queue_depth: 3 }] };
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  const before = await (await fetch(`${base}/api/state?limit=1`, { headers: auth })).json() as { clients: any[]; projects: any[] };
  const rowBefore = JSON.stringify(before.clients.find((c) => c.name === 'legacy-61')!);
  assert.ok(!('daemon_behind' in before.clients.find((c) => c.name === 'legacy-61')!) && !('client_log' in before.clients.find((c) => c.name === 'legacy-61')!), 'no new keys appear on a legacy row');

  // A second legacy heartbeat: the row is byte-identical apart from the
  // liveness timestamp (last_seen moves — liveness is its purpose).
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  const after = await (await fetch(`${base}/api/state?limit=1`, { headers: auth })).json() as typeof before;
  const rowAfter = after.clients.find((c) => c.name === 'legacy-61')!;
  const strip = (r: any) => { const { last_seen, ...rest } = r; return JSON.stringify(rest); };
  assert.equal(strip(rowAfter), strip(before.clients.find((c) => c.name === 'legacy-61')!), 'every field except last_seen is byte-identical across legacy heartbeats');
  assert.ok(rowAfter.last_seen >= before.clients.find((c) => c.name === 'legacy-61')!.last_seen, 'last_seen still moves (the heartbeat stays a heartbeat)');
});

// ---------------------------------------------------------------------------
// #61 step 3 — the page carries the three new surfaces: the exception-only
// `daemon behind` tag, the Client log dock tab, and the loopback-only
// local client-config editor section.
// ---------------------------------------------------------------------------

test('#66 alias beats bare AT PUBLISH: the alias resolves to the paired row; the bare catalog keeps its row-order pin', async () => {
  // Alias beats bare AT PUBLISH: an alias over a name a bare row also
  // declares publishes in model_aliases with the WINNER applied, while the
  // catalog block keeps its bare entry untouched (the client dedups).
  const aggDir = mkdtempSync(join(tmpdir(), 'idlefill-alias-beat-'));
  try {
    const aggCfg: ServerConfig = { ...cfg, api_tokens: [AGG_TOKEN], state_file: join(aggDir, 'state.json') };
    const aggArbiter = new Arbiter(new StateStore(aggCfg.state_file), aggCfg, det, {
      modelsFetcher: async (url) => (url.includes('omlx') ? ['Shared-Name'] : ['Shared-Name']),
    });
    const watched = aggArbiter.upsertServerConnection({ name: 'watched', url: 'http://fake', models: ['Shared-Name'], activity_path: '' });
    const omlx = aggArbiter.upsertServerConnection({ name: 'omlx', url: 'http://omlx.local:8000', models: ['Shared-Name'], activity_path: '', auth_token: 'sekret-omlx-token' });
    assert.ok(watched.ok && omlx.ok);
    // Alias whose ONLY pair is the CREDENTIALED omlx row — row order would
    // otherwise pin the bare name to `watched`.
    aggArbiter.putModelAlias({ alias: 'Shared-Name', pairs: [{ server_id: omlx.server!.id, model: 'Shared-Name' }] });
    await aggArbiter.probeCatalog();
    const aggApp = buildApi({ arbiter: aggArbiter, cfg: aggCfg, publicDir: join(__dirname, '..', 'public') });
    await aggApp.ready();
    try {
      const res = await aggApp.inject({ method: 'GET', url: '/api/state' });
      const st = res.json() as { catalog: { name: string; server_id: string }[]; model_aliases: { name: string; server_id: string }[] };
      assert.equal(st.model_aliases.length, 1, 'the alias publishes under the shared name');
      assert.equal(st.model_aliases[0]!.server_id, omlx.server!.id, 'the alias entry resolves to the PAIRED row, not the row-order winner');
      const bare = st.catalog.filter((e) => e.name === 'Shared-Name');
      assert.equal(bare.length, 1, 'the bare catalog keeps its single entry (row-order pin, untouched — the CLIENT applies alias precedence)');
      assert.notEqual(bare[0]!.server_id, omlx.server!.id, 'the bare block keeps its ROW-ORDER pin — the alias plane does not move it (#63 semantics intact)');
    } finally {
      await aggApp.close();
    }
  } finally {
    rmSync(aggDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #66 — model aliases on the API plane: the /api/state `model_aliases`
// ADD-key (catalog untouched, no token ever), the authoring read
// GET /api/aliases (token-gated, per-pair markers), and the POST
// validation matrix (400 family + 404 unknown delete + accepted unprobed
// pair + events on every write).
// ---------------------------------------------------------------------------

test('#66 /api/state model_aliases ADD-key: present beside an untouched catalog block; no token anywhere (anonymous AND authed)', async () => {
  const aggDir = mkdtempSync(join(tmpdir(), 'idlefill-alias-state-'));
  try {
    const aggCfg: ServerConfig = { ...cfg, api_tokens: [AGG_TOKEN], state_file: join(aggDir, 'state.json') };
    const aggArbiter = new Arbiter(new StateStore(aggCfg.state_file), aggCfg, det, {
      modelsFetcher: async (url) => {
        // omlx's probe FAILS (401 shape): its pair stands as 'declared'.
        if (url.includes('omlx')) throw new Error('probe HTTP 401');
        return ['Qwen3.8-27B'];
      },
    });
    const up = aggArbiter.upsertServerConnection({ name: 'omlx', url: 'http://omlx.local:8000', models: ['MlxDeclared'], activity_path: '', auth_token: 'sekret-omlx-token' });
    assert.ok(up.ok);
    const put = aggArbiter.putModelAlias({ alias: 'Flagship', pairs: [{ server_id: up.server!.id, model: 'MlxDeclared' }] });
    assert.ok(put.ok, JSON.stringify(put));
    await aggArbiter.probeCatalog();
    const aggApp = buildApi({ arbiter: aggArbiter, cfg: aggCfg, publicDir: join(__dirname, '..', 'public') });
    await aggApp.ready();
    try {
      for (const inject of [
        { method: 'GET' as const, url: '/api/state' },
        { method: 'GET' as const, url: '/api/state', headers: { authorization: `Bearer ${AGG_TOKEN}` } },
      ]) {
        const res = await aggApp.inject(inject);
        assert.equal(res.statusCode, 200);
        const st = res.json() as {
          catalog?: { name: string; catalog_source?: string }[];
          model_aliases?: { name: string; server_id: string; url: string; auth_set: boolean; engine_model: string; catalog_source: string }[];
        };
        assert.ok(Array.isArray(st.model_aliases), 'model_aliases rides /api/state as an ADD-key sibling');
        assert.ok(Array.isArray(st.catalog), 'the catalog block still rides (add, never rename)');
        const alias = st.model_aliases!.find((e) => e.name === 'Flagship');
        assert.ok(alias, 'the alias publishes once resolved');
        assert.equal(alias!.server_id, up.server!.id, 'resolved to the winner ROW');
        assert.equal(alias!.engine_model, 'MlxDeclared', 'the winner pair engine-OWN id, not the alias name');
        assert.equal(typeof alias!.auth_set, 'boolean', 'auth_set boolean, never a token');
        assert.ok(['probed', 'declared'].includes(alias!.catalog_source));
        assert.ok(st.catalog!.some((e) => e.name === 'MlxDeclared'), 'the bare catalog still carries the declared name (additive, not moved)');
        assert.ok(!res.body.includes('sekret-omlx-token'), 'the row token VALUE never enters the anonymous state view');
        assert.ok(!res.body.includes('auth_token'), 'the field name auth_token never appears');
      }
    } finally {
      await aggApp.close();
    }
  } finally {
    rmSync(aggDir, { recursive: true, force: true });
  }
});

test('#66 GET /api/aliases: the authoring read is token-gated (never the anonymous exception) and carries per-pair markers with no secret', async () => {
  const aggDir = mkdtempSync(join(tmpdir(), 'idlefill-alias-read-'));
  try {
    const aggCfg: ServerConfig = { ...cfg, api_tokens: [AGG_TOKEN], state_file: join(aggDir, 'state.json') };
    const aggArbiter = new Arbiter(new StateStore(aggCfg.state_file), aggCfg, det, {
      modelsFetcher: async () => {
        throw new Error('probe refused');
      },
    });
    const up = aggArbiter.upsertServerConnection({ name: 'omlx', url: 'http://omlx.local:8000', models: ['MlxDeclared'], activity_path: '', auth_token: 'sekret-omlx-token' });
    aggArbiter.putModelAlias({ alias: 'Flagship', pairs: [{ server_id: up.server!.id, model: 'MlxDeclared' }], pin: up.server!.id });
    const aggApp = buildApi({ arbiter: aggArbiter, cfg: aggCfg, publicDir: join(__dirname, '..', 'public') });
    await aggApp.ready();
    try {
      const anon = await aggApp.inject({ method: 'GET', url: '/api/aliases' });
      assert.equal(anon.statusCode, 401, 'the authoring read is NOT part of the anonymous /api/state exception');
      const ok = await aggApp.inject({ method: 'GET', url: '/api/aliases', headers: { authorization: `Bearer ${AGG_TOKEN}` } });
      assert.equal(ok.statusCode, 200);
      const body = ok.json() as { aliases: { alias: string; pinned_server_id?: string; pairs: { server_id: string; model: string; source: string }[] }[] };
      assert.equal(body.aliases.length, 1);
      const row = body.aliases[0]!;
      assert.equal(row.alias, 'Flagship');
      assert.equal(row.pinned_server_id, up.server!.id, 'the pin rides for the drag affordance');
      assert.deepEqual(row.pairs, [{ server_id: up.server!.id, model: 'MlxDeclared', source: 'unprobed' }], 'a never-cycled pair renders the unprobed marker');
      assert.ok(!ok.body.includes('sekret-omlx-token') && !ok.body.includes('auth_token'), 'no secret by construction (D1: server_id + engine ids only)');
    } finally {
      await aggApp.close();
    }
  } finally {
    rmSync(aggDir, { recursive: true, force: true });
  }
});

test('#66 POST /api/aliases: the whole-entry validation matrix — 400 family, 404 unknown delete, unprobed pair ACCEPTED, re-pin alone, events on every write', async () => {
  const aggDir = mkdtempSync(join(tmpdir(), 'idlefill-alias-post-'));
  try {
    const aggCfg: ServerConfig = { ...cfg, api_tokens: [AGG_TOKEN], state_file: join(aggDir, 'state.json') };
    const store = new StateStore(join(aggDir, 'state.json'));
    const aggArbiter = new Arbiter(store, aggCfg, det);
    const up = aggArbiter.upsertServerConnection({ name: 'omlx', url: 'http://omlx.local:8000', models: ['MlxDeclared'], activity_path: '' });
    const other = aggArbiter.upsertServerConnection({ name: 'alpha', url: 'http://alpha.local:9090', models: ['engine-a-id'], activity_path: '' });
    assert.ok(up.ok && other.ok);
    const aggApp = buildApi({ arbiter: aggArbiter, cfg: aggCfg, publicDir: join(__dirname, '..', 'public') });
    await aggApp.ready();
    const H = { authorization: `Bearer ${AGG_TOKEN}`, 'content-type': 'application/json' };
    try {
      const post = (body: unknown) => aggApp.inject({ method: 'POST', url: '/api/aliases', headers: H, body: JSON.stringify(body) });

      // Anonymous write: rejected like every /api/* write.
      assert.equal((await aggApp.inject({ method: 'POST', url: '/api/aliases', headers: { 'content-type': 'application/json' }, body: '{}' })).statusCode, 401);

      // The 400 family, each with its reason in the body.
      const hostile = await post({ alias: 'bad\nname', pairs: [{ server_id: up.server!.id, model: 'MlxDeclared' }] });
      assert.equal(hostile.statusCode, 400);
      assert.match(hostile.json().error, /printable/);
      const overlong = await post({ alias: 'x'.repeat(129), pairs: [{ server_id: up.server!.id, model: 'MlxDeclared' }] });
      assert.equal(overlong.statusCode, 400, 'alias name bounded to 128');
      const quoteModel = await post({ alias: 'Flagship', pairs: [{ server_id: up.server!.id, model: 'has"quote' }] });
      assert.equal(quoteModel.statusCode, 400, 'a " or \\ in the ENGINE ID would corrupt the body splice — refused at the door');
      const bslashModel = await post({ alias: 'Flagship', pairs: [{ server_id: up.server!.id, model: 'back\\slash' }] });
      assert.equal(bslashModel.statusCode, 400, 'backslash refused in the engine id too');
      const emptyPairs = await post({ alias: 'Flagship', pairs: [] });
      assert.equal(emptyPairs.statusCode, 400);
      assert.match(emptyPairs.json().error, /pairs/);
      const unknownRow = await post({ alias: 'Flagship', pairs: [{ server_id: 'srv-does-not-exist', model: 'MlxDeclared' }] });
      assert.equal(unknownRow.statusCode, 400);
      assert.match(unknownRow.json().error, /unknown server_id/);
      const dupe = await post({ alias: 'Flagship', pairs: [{ server_id: up.server!.id, model: 'MlxDeclared' }, { server_id: up.server!.id, model: 'MlxDeclared' }] });
      assert.equal(dupe.statusCode, 400);
      assert.match(dupe.json().error, /duplicate pair/);

      // A pair the probe never confirmed is ACCEPTED at authoring (D5):
      // confirmation is publish-time, per pair, not write-time.
      const okWrite = await post({ alias: 'Flagship', pairs: [{ server_id: up.server!.id, model: 'MlxDeclared' }, { server_id: other.server!.id, model: 'engine-a-id' }] });
      assert.equal(okWrite.statusCode, 200);
      assert.equal(okWrite.json().created, true);

      // A malformed pin is refused; re-pin ALONE updates (the drag path).
      // A pin at a NOT-present row is legal (D4: a pin that no longer
      // matches a surviving pair falls through at publish — a row can be
      // deleted after the write, so the authoring door cannot require it).
      assert.equal((await post({ alias: 'Flagship', pin: '' })).statusCode, 400);
      assert.equal((await post({ alias: 'Flagship', pin: up.server!.id })).statusCode, 200);
      const repin = await post({ alias: 'Flagship', pin: other.server!.id });
      assert.equal(repin.statusCode, 200, 'alias + pin alone = re-pin (no pairs in the body)');
      assert.equal(repin.json().created, false);
      assert.equal(repin.json().alias.pinned_server_id, other.server!.id);

      // Every write appended an event (the Sessions view + log dock see it).
      const kinds = store.state.events.filter((e) => e.kind === 'model_alias_updated');
      assert.ok(kinds.length >= 2, `updated events appended (${kinds.length})`);

      // Delete: happy path + its event; unknown alias 404.
      const gone = await post({ alias: 'Flagship', delete: true });
      assert.equal(gone.statusCode, 200);
      assert.equal(gone.json().deleted, true);
      assert.ok(store.state.events.some((e) => e.kind === 'model_alias_removed'), 'the removal appended an event');
      const again = await post({ alias: 'Flagship', delete: true });
      assert.equal(again.statusCode, 404, 'deleting an unknown alias is a 404, not a silent 200');
      assert.equal(again.json().error, 'unknown_alias');

      // A deleted alias no longer publishes to the client.
      await aggArbiter.probeCatalog();
      assert.deepEqual(aggArbiter.modelAliases(), [], 'the delete lands on the publish block next cycle');
    } finally {
      await aggApp.close();
    }
  } finally {
    rmSync(aggDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #67 — the engine-pin REST plane: POST /api/sessions/:token/pin (sibling
// of the override route), and the resolved engine_pin block /api/state +
// /api/sessions publish for the router to learn.
// ---------------------------------------------------------------------------

test('#67 pin REST: write resolves, /api/state + /api/sessions publish the block, illegal targets are told, null clears', async () => {
  // A row + a legal target (the declared inventory carries the session model).
  await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's-pin-http', history: { rpm: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1], model: 'Qwen3.8-27B' } }),
  });
  const srv = arbiter.upsertServerConnection({ name: 'pin-target', url: 'http://pin.local:7070', activity_path: '', models: ['Qwen3.8-27B'] });
  assert.ok(srv.ok);

  // No pin yet: no engine_pin key on the row.
  const before = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    sessions: { token: string; engine_pin?: unknown; phase?: unknown }[];
  };
  const b0 = before.sessions.find((x) => x.token === 's-pin-http')!;
  assert.equal('engine_pin' in b0, false, 'an unpinned session carries NO engine_pin key (byte-for-byte old shape)');

  // Write.
  const w = await fetch(`${base}/api/sessions/s-pin-http/pin`, {
    method: 'POST', headers: auth, body: JSON.stringify({ server_id: srv.server!.id }),
  });
  assert.equal(w.status, 200);
  const written = (await w.json()) as { ok: boolean; pin: { server_id: string; set_at: number } };
  assert.equal(written.ok, true);
  assert.equal(written.pin.server_id, srv.server!.id);
  assert.ok(typeof written.pin.set_at === 'number', 'the write response echoes the stored pin; the RESOLVED block (url) rides the reads below');

  // Published on both read surfaces, resolved (url rides — the router never learns server URLs otherwise).
  const st = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    sessions: { token: string; engine_pin?: { server_id: string; url: string } }[];
  };
  assert.equal(st.sessions.find((x) => x.token === 's-pin-http')!.engine_pin!.server_id, srv.server!.id, '/api/state publishes the resolved block');
  const list = (await (await fetch(`${base}/api/sessions`, { headers: auth })).json()) as {
    sessions: { token: string; engine_pin?: { server_id: string } }[];
  };
  assert.equal(list.sessions.find((x) => x.token === 's-pin-http')!.engine_pin!.server_id, srv.server!.id, '/api/sessions too');

  // Illegal target (the row does not serve the session model): 400 + reason.
  const badRow = arbiter.upsertServerConnection({ name: 'wrong-row', url: 'http://wrong.local:7071', activity_path: '', models: ['SomeOtherModel'] });
  assert.ok(badRow.ok);
  const bad = await fetch(`${base}/api/sessions/s-pin-http/pin`, {
    method: 'POST', headers: auth, body: JSON.stringify({ server_id: badRow.server!.id }),
  });
  assert.equal(bad.status, 400, 'a wrong write is told, not swallowed');
  assert.equal((await bad.json()).error, 'row_lacks_model');
  // The standing pin survives the refused write.
  const st2 = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    sessions: { token: string; engine_pin?: { server_id: string } }[];
  };
  assert.equal(st2.sessions.find((x) => x.token === 's-pin-http')!.engine_pin!.server_id, srv.server!.id, 'the refused write changed nothing');

  // Unknown session: 404. Missing server_id: 400.
  const nf = await fetch(`${base}/api/sessions/s-nobody/pin`, { method: 'POST', headers: auth, body: JSON.stringify({ server_id: srv.server!.id }) });
  assert.equal(nf.status, 404);
  const noBody = await fetch(`${base}/api/sessions/s-pin-http/pin`, { method: 'POST', headers: auth, body: JSON.stringify({}) });
  assert.equal(noBody.status, 400, 'server_id must be present (null clears)');

  // Clear.
  const clr = await fetch(`${base}/api/sessions/s-pin-http/pin`, { method: 'POST', headers: auth, body: JSON.stringify({ server_id: null }) });
  assert.equal(clr.status, 200);
  assert.equal((await clr.json()).pin, null);
  const st3 = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    sessions: { token: string; engine_pin?: unknown }[];
  };
  assert.equal('engine_pin' in st3.sessions.find((x) => x.token === 's-pin-http')!, false, 'cleared pins stop publishing');
});

test('#67 phase over REST: the register body carries the block, the row stores it, the no-phase report clears it', async () => {
  const reg = await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ token: 's-phase-http', phase: { state: 'tools', at: Date.now() } }),
  });
  assert.equal(reg.status, 201);
  const created = (await reg.json()) as { session: { phase: { state: string } | null } };
  assert.equal(created.session.phase!.state, 'tools', 'the create response carries the phase');

  const st = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    sessions: { token: string; phase?: { state: string } | null }[];
  };
  assert.equal(st.sessions.find((x) => x.token === 's-phase-http')!.phase!.state, 'tools', '/api/state carries it');

  // Invalid block: registration still 200 (drop-don't-reject), stored value stands.
  const bad = await fetch(`${base}/api/sessions/register`, {
    method: 'POST', headers: auth, body: JSON.stringify({ token: 's-phase-http', phase: { state: 'vibes', at: 1 } }),
  });
  assert.equal(bad.status, 200);
  const st2 = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    sessions: { token: string; phase?: { state: string } | null }[];
  };
  assert.equal(st2.sessions.find((x) => x.token === 's-phase-http')!.phase!.state, 'tools', 'invalid block dropped, stored value stands');

  // The no-phase report (absent key) clears the row.
  await fetch(`${base}/api/sessions/register`, { method: 'POST', headers: auth, body: JSON.stringify({ token: 's-phase-http' }) });
  const st3 = (await (await fetch(`${base}/api/state?limit=50`, { headers: auth })).json()) as {
    sessions: { token: string; phase?: { state: string } | null }[];
  };
  assert.equal(st3.sessions.find((x) => x.token === 's-phase-http')!.phase, null, 'the absent block clears the stored phase');
});
