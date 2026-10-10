/**
 * hermes-meta.test.ts — issue #73, arbiter side: the `hermes_meta` ADD-key
 * (session enrichment) and the gateway host facts (slice B) on the client
 * rows.
 *
 * The sanitizer trio (the acceptance list):
 *   - valid stores: a clean block lands on the session row + echoes on
 *     /api/sessions + /api/state;
 *   - malformed drops the key only: a garbage block is dropped, the
 *     registration succeeds, the stored block stands (last-known-wins —
 *     NEVER a clear, the ledger is not ephemeral state like the gate
 *     block);
 *   - absent never clears: a heartbeat without the key leaves the stored
 *     block (old routers / gateway outages / a poll that lost the row).
 *
 * Slice B: `hermes_version` + `gateway_reachable` on the client register
 * heartbeat — exact-value sanitize (string ≤64 / exact boolean), stored +
 * echoed on /api/state, and ABSENT leaves the row exactly as-is (an old
 * client's row is byte-for-byte unchanged).
 *
 * End-to-end through the REAL Fastify app on an ephemeral loopback port
 * (the api.test.ts harness pattern) — no network beyond loopback.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApi, attachWebSocket } from '../src/api.js';
import { Arbiter, cleanHostFacts } from '../src/arbiter.js';
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
  dir = mkdtempSync(join(tmpdir(), 'idlefill-hermes-'));
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

const META = {
  title: 'Gate research',
  model: 'Qwen3.8-27B',
  message_count: 12,
  tool_call_count: 3,
  input_tokens: 4200,
  output_tokens: 1800,
  reasoning_tokens: 900,
  estimated_cost_usd: 0.012,
  last_active: 1760000000500,
};

test('hermes_meta: valid stores — the block lands on the row + echoes', async () => {
  const reg = await fetch(`${base}/api/sessions/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ token: 'hm-1', client_name: 'mac', session_id: '20261009_010000_aaaa', hermes_meta: META }),
  });
  assert.equal(reg.status, 201);
  const res = (await reg.json()) as { session: { hermes_meta?: unknown } };
  assert.deepEqual(res.session.hermes_meta, META, 'the sanitized block lands on the row');

  // /api/sessions echoes it.
  const list = (await (await fetch(`${base}/api/sessions`, { headers: auth })).json()) as {
    sessions: Array<{ token: string; hermes_meta?: unknown }>;
  };
  const row = list.sessions.find((s) => s.token === 'hm-1');
  assert.ok(row);
  assert.deepEqual(row.hermes_meta, META);
});

test('hermes_meta: malformed drops the key only — the stored block stands (never a clear)', async () => {
  // First a valid report so there IS a stored block.
  await fetch(`${base}/api/sessions/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ token: 'hm-2', session_id: 'x', hermes_meta: { title: 'kept', message_count: 1 } }),
  });
  // A garbage block: per-member drop ⇒ nothing survives ⇒ dropped whole.
  const bad = await fetch(`${base}/api/sessions/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ token: 'hm-2', hermes_meta: { title: 42, message_count: -1, input_tokens: 'many', estimated_cost_usd: NaN } }),
  });
  assert.equal(bad.status, 200, 'the registration is NEVER rejected for a malformed block');
  // Absent: no key at all (old router / gateway down / poll lost the row).
  const absent = await fetch(`${base}/api/sessions/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ token: 'hm-2' }),
  });
  assert.equal(absent.status, 200);

  const list = (await (await fetch(`${base}/api/sessions`, { headers: auth })).json()) as {
    sessions: Array<{ token: string; hermes_meta?: { title?: string; message_count?: number } }>;
  };
  const row = list.sessions.find((s) => s.token === 'hm-2');
  assert.deepEqual(row?.hermes_meta, { title: 'kept', message_count: 1 }, 'absent/malformed never clears the stored ledger (last-known-wins)');
});

test('hermes_meta: partial member drop — a bad member drops only itself', async () => {
  await fetch(`${base}/api/sessions/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      token: 'hm-3',
      hermes_meta: {
        title: '  spaced  ',
        model: 7, // dropped (non-string)
        message_count: 5,
        input_tokens: -3, // dropped (negative)
        estimated_cost_usd: 0.5,
        ended_at: null, // explicit null rides
        end_reason: 'user_closed',
        last_active: 1760000000000,
      },
    }),
  });
  const list = (await (await fetch(`${base}/api/sessions`, { headers: auth })).json()) as {
    sessions: Array<{ token: string; hermes_meta?: Record<string, unknown> }>;
  };
  const row = list.sessions.find((s) => s.token === 'hm-3');
  assert.equal(row?.hermes_meta?.title, 'spaced', 'trimmed');
  assert.equal(row?.hermes_meta?.model, undefined, 'non-string member dropped');
  assert.equal(row?.hermes_meta?.message_count, 5);
  assert.equal(row?.hermes_meta?.input_tokens, undefined, 'negative counter dropped');
  assert.equal(row?.hermes_meta?.estimated_cost_usd, 0.5);
  assert.equal(row?.hermes_meta?.ended_at, null, 'explicit null rides');
  assert.equal(row?.hermes_meta?.end_reason, 'user_closed');
  assert.equal(row?.hermes_meta?.last_active, 1760000000000);
});

test('hermes_meta: a fresh row with an all-invalid block starts WITHOUT the key', async () => {
  await fetch(`${base}/api/sessions/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ token: 'hm-4', hermes_meta: { title: '' } }),
  });
  const list = (await (await fetch(`${base}/api/sessions`, { headers: auth })).json()) as {
    sessions: Array<{ token: string; hermes_meta?: unknown }>;
  };
  const row = list.sessions.find((s) => s.token === 'hm-4');
  assert.equal(row?.hermes_meta, undefined, 'nothing valid ⇒ the key is absent, never a fake block');
});

test('slice B: hermes_version + gateway_reachable — exact-value sanitize, stored + echoed', async () => {
  // First registration: no hermes keys (old-client shape) ⇒ the row has none.
  const r1 = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'gw-mac', ip: '100.94.165.102' }),
  });
  assert.equal(r1.status, 200);

  // A heartbeat WITH the host facts.
  await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'gw-mac',
      ip: '100.94.165.102',
      hermes_version: '0.21.6',
      gateway_reachable: true,
    }),
  });
  let state = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: Array<{ name: string; hermes_version?: string; gateway_reachable?: boolean }>;
  };
  let row = state.clients.find((c) => c.name === 'gw-mac');
  assert.equal(row?.hermes_version, '0.21.6');
  assert.equal(row?.gateway_reachable, true);

  // The exception report: gateway down ⇒ reachable:false rides (badge).
  await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'gw-mac', ip: '100.94.165.102', hermes_version: '0.21.6', gateway_reachable: false }),
  });
  state = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: Array<{ name: string; hermes_version?: string; gateway_reachable?: boolean }>;
  };
  row = state.clients.find((c) => c.name === 'gw-mac');
  assert.equal(row?.gateway_reachable, false, 'the exception report updates the row (the dashboard badges on false)');

  // Malformed values are dropped, never a rejection.
  await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'gw-mac', ip: '100.94.165.102', hermes_version: 'x'.repeat(100), gateway_reachable: 'yes' }),
  });
  state = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: Array<{ name: string; hermes_version?: string; gateway_reachable?: boolean }>;
  };
  row = state.clients.find((c) => c.name === 'gw-mac');
  assert.equal(row?.hermes_version, '0.21.6', 'an oversized version is dropped (the stored one stands)');
  assert.equal(row?.gateway_reachable, false, 'a non-boolean is dropped (the stored one stands)');
});

test('slice B: absent never touches a client row (old client byte-for-byte)', async () => {
  // A client that never sends the keys: two heartbeats, the row shape is
  // identical (no hermes_version / gateway_reachable keys at all).
  const body = { name: 'legacy-mac', ip: '100.94.165.102' };
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  const s1 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: Array<{ name: string } & Record<string, unknown>>;
  };
  const row1 = s1.clients.find((c) => c.name === 'legacy-mac');
  assert.ok(row1);
  assert.ok(!('hermes_version' in row1), 'absent key: never on the row');
  assert.ok(!('gateway_reachable' in row1), 'absent key: never on the row');
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  const s2 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: Array<{ name: string } & Record<string, unknown>>;
  };
  const row2 = s2.clients.find((c) => c.name === 'legacy-mac');
  assert.deepEqual(Object.keys(row2!).sort(), Object.keys(row1!).sort(), 'a key-less heartbeat changes nothing on the row');
});

// ---------------------------------------------------------------------------
// #85 slice E: the richer host facts (`hermes_host_facts`) on the client row
// ---------------------------------------------------------------------------

test('#85E: a valid host-facts block (degraded disk NAMED) stores + echoes; raw numbers never land', async () => {
  await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'hf-mac',
      ip: '100.94.165.102',
      hermes_version: '0.21.6',
      gateway_reachable: true,
      hermes_host_facts: {
        readiness: 'degraded',
        checks: { state_db: 'ok', session_store: 'ok', config: 'ok', model: 'ok', disk: 'degraded', gateway: 'ok', background_queues: 'ok' },
        connected_platforms: 4,
        active_api_runs: 0,
      },
    }),
  });
  let state = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: Array<{ name: string; hermes_host_facts?: Record<string, unknown> }>;
  };
  const row = state.clients.find((c) => c.name === 'hf-mac');
  assert.equal(row?.hermes_host_facts?.readiness, 'degraded');
  assert.equal((row?.hermes_host_facts as Record<string, unknown>)?.checks?.disk, 'degraded', 'the degraded disk rides as a NAMED check');
  assert.equal((row?.hermes_host_facts as Record<string, unknown>)?.connected_platforms, 4);
  assert.equal((row?.hermes_host_facts as Record<string, unknown>)?.active_api_runs, 0, 'a real zero is a fact: it stores');
});

test('#85E: a malformed/oversized block is dropped silently — the stored block stands (never cleared)', async () => {
  await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'hf-mac', ip: '100.94.165.102', hermes_host_facts: 'not-an-object' }),
  });
  let state = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: Array<{ name: string; hermes_host_facts?: Record<string, unknown> }>;
  };
  let row = state.clients.find((c) => c.name === 'hf-mac');
  assert.equal(row?.hermes_host_facts?.readiness, 'degraded', 'a garbage block never clears the stored one');

  // Junk members: unknown check names + absurd counts dropped individually,
  // the valid members still land (a fresh replacement of the stored block).
  await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'hf-mac',
      ip: '100.94.165.102',
      hermes_host_facts: { readiness: 'ok', checks: { disk: 'degraded', quantum_flux: 'degraded' }, connected_platforms: 99999 },
    }),
  });
  state = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: Array<{ name: string; hermes_host_facts?: Record<string, unknown> }>;
  };
  row = state.clients.find((c) => c.name === 'hf-mac');
  const facts = row?.hermes_host_facts as Record<string, unknown>;
  assert.equal(facts.readiness, 'ok');
  assert.equal(facts.checks?.disk, 'degraded', 'the valid member stands');
  assert.ok(!('quantum_flux' in (facts.checks as Record<string, unknown>)), 'a non-whitelisted check name is dropped');
  assert.ok(!('connected_platforms' in facts), 'an oversized count is dropped');
});

test('#85E: an ABSENT key leaves the stored block byte-for-byte (old client / gateway down)', async () => {
  const before = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: Array<{ name: string; hermes_host_facts?: unknown }>;
  };
  const stored = before.clients.find((c) => c.name === 'hf-mac')?.hermes_host_facts;
  assert.ok(stored !== undefined, 'the block is stored before the legacy heartbeat');
  // The OLD payload shape: slice-B keys only, no hermes_host_facts key at all.
  await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'hf-mac', ip: '100.94.165.102', hermes_version: '0.21.6', gateway_reachable: true }),
  });
  const after = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: Array<{ name: string; hermes_host_facts?: unknown }>;
  };
  const row = after.clients.find((c) => c.name === 'hf-mac');
  assert.deepEqual(row?.hermes_host_facts, stored, 'absent never clears: the stored block survives byte-for-byte');
});

test('#85E: an OLD client payload (no slice-B or slice-E keys) still registers and never gains the key', async () => {
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'legacy-no-facts', ip: '10.0.0.1' }) });
  const state = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: Array<{ name: string } & Record<string, unknown>>;
  };
  const row = state.clients.find((c) => c.name === 'legacy-no-facts');
  assert.ok(row, 'the old shape registers fine');
  assert.ok(!('hermes_host_facts' in row), 'a key-less heartbeat never adds the block');
  await fetch(`${base}/api/clients/register`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'legacy-no-facts', ip: '10.0.0.1', version: '1.2.3' }) });
  const s2 = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: Array<{ name: string } & Record<string, unknown>>;
  };
  const r2 = s2.clients.find((c) => c.name === 'legacy-no-facts');
  assert.ok(!('hermes_host_facts' in r2), 'still absent after a second legacy heartbeat');
});

test('#85E cleanHostFacts: the edge sanitizer bounds the block directly', () => {
  assert.equal(cleanHostFacts(undefined), undefined);
  assert.equal(cleanHostFacts(null), undefined);
  assert.equal(cleanHostFacts([]), undefined);
  assert.equal(cleanHostFacts('degraded'), undefined);
  assert.equal(cleanHostFacts({ checks: { nope: 'ok' } }), undefined, 'nothing valid survived ⇒ absent');
  const ok = cleanHostFacts({ readiness: 'OK', checks: { disk: 'degraded', model: 'weird', intruder: 'ok' }, connected_platforms: 4, active_api_runs: 3, used_percent: 98.1, free_bytes: 76318728192 });
  assert.deepEqual(ok, { readiness: 'ok', checks: { disk: 'degraded', model: 'unknown' }, connected_platforms: 4, active_api_runs: 3 }, 'lowercase-normalized verdicts; unknown status → unknown; unknown names and raw numbers dropped');
  assert.equal(cleanHostFacts({ connected_platforms: 101 }), undefined, 'over-cap counts alone earn no block');
  assert.equal(cleanHostFacts({ active_api_runs: 10_001 }), undefined);
});
