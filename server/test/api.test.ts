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

test('dashboard HTML serves', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<html/);
  assert.match(html, /idlefill/);
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
