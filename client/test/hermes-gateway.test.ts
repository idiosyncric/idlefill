/**
 * hermes-gateway.test.ts — issue #73: the Hermes Gateway API connector
 * (the OBSERVED complement to the session gate).
 *
 * Two suites:
 *
 *   1. The pure merge/sanitize logic against FAKE gateways (an
 *      in-process stub HTTP server on an ephemeral loopback port — no
 *      live Hermes, no operator keys):
 *        - ledger fetch + profile mirror paths (/p/<profile>/...)
 *        - per-member drop-don't-poison sanitization
 *        - last-known-wins member merge (absent never clears, explicit
 *          null rides)
 *        - health gate: gateway down ⇒ unreachable, no meta, no crash
 *        - auth posture: 401 ⇒ reachable but no rows (last-known stands)
 *        - runs control: dispatch → status/steer/stop/approval verbs on
 *          the STUB, and the scope law — a control verb for a run this
 *          process did not dispatch is refused WITHOUT an HTTP request.
 *
 *   2. FAIL-OPEN / FAIL-QUIET (daemon-level, byte-for-byte): the gate's
 *      register dep is a frozen surface (parallel #47 work), so the
 *      enrichment join lives in the daemon's register callback closure.
 *      A real ClientDaemon + real gate + the fake arbiter prove that with
 *      the env switch unset the session/client heartbeat bodies are
 *      byte-for-byte the pre-#73 shape (no hermes_meta, no gateway host
 *      facts), that a live gateway's ledger + host facts DO ride the
 *      heartbeats, and that a down gateway leaves the session body
 *      unchanged while the exception-only badge rides the client body.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HermesGatewayConnector,
  HermesRunsControl,
  resolveHermesGatewayConfig,
  rowToMeta,
  mergeHermesMeta,
  mergeLedgerRows,
  ledgerPath,
  type GatewaySessionRow,
  type HermesSessionMeta,
} from '../src/hermes-gateway.js';

const here = dirname(fileURLToPath(import.meta.url));
const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

// ---------------------------------------------------------------------------
// Fake gateway (stub)
// ---------------------------------------------------------------------------

interface FakeGatewayOpts {
  health?: { status: number; version?: string } | null;
  defaultRows?: GatewaySessionRow[];
  profileRows?: Record<string, GatewaySessionRow[]>;
  /** Respond with 401 to authed ledger reads when the key does not match. */
  expectKeys?: Record<string, string>;
  /** Runs stub state: verb recording + canned responses. */
  runsState?: {
    create?: (body: unknown) => { run_id: string };
    verbs: { method: string; path: string; body?: unknown }[];
    respond?: (method: string, path: string) => { status: number; body?: unknown } | undefined;
    /** Canned SSE body for `GET /v1/runs/{id}/events` (when present). */
    events?: string;
  };
}

interface FakeGateway {
  base: string;
  requests: { method: string; path: string; auth: string; body?: string }[];
  close: () => Promise<void>;
}

function startFakeGateway(opts: FakeGatewayOpts = {}): Promise<FakeGateway> {
  const requests: { method: string; path: string; auth: string; body?: string }[] = [];
  const server = http.createServer((req, res) => {
    const body: string[] = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      const j = body.join('');
      const url = new URL(req.url ?? '/', 'http://x');
      requests.push({ method: req.method ?? '', path: url.pathname, auth: req.headers.authorization ?? '', ...(j ? { body: j } : {}) });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Health (unauthenticated).
      if (req.method === 'GET' && (url.pathname === '/v1/health' || /^\/p\/[^/]+\/v1\/health$/.test(url.pathname))) {
        if (opts.health === null) return send(500, { error: 'down' });
        return send(opts.health?.status ?? 200, { status: 'ok', version: opts.health?.version ?? '0.21.6' });
      }
      // Ledger reads (authed).
      const m = url.pathname.match(/^\/(?:p\/([^/]+)\/)?api\/sessions$/);
      if (req.method === 'GET' && m) {
        const profile = m[1] ?? 'default';
        const expected = opts.expectKeys?.[profile];
        if (expected && (req.headers.authorization ?? '') !== `Bearer ${expected}`) {
          return send(401, { error: { code: 'gateway_auth_failed' } });
        }
        const rows = profile === 'default' ? (opts.defaultRows ?? []) : (opts.profileRows?.[profile] ?? []);
        return send(200, { object: 'list', data: rows, limit: 200, offset: 0, has_more: false });
      }
      // Runs (the stub answers the seam's verbs).
      const runsState = opts.runsState;
      if (runsState) {
        if (req.method === 'GET' && /\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
          // SSE stream: write the canned frames then close.
          if (runsState.events !== undefined) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(runsState.events);
            return res.end();
          }
          return send(404, { error: 'not found' });
        }
        runsState.verbs.push({ method: req.method ?? '', path: url.pathname, body: j ? JSON.parse(j) : undefined });
        if (req.method === 'POST' && url.pathname === '/v1/runs' && runsState.create) {
          return send(202, runsState.create(j ? JSON.parse(j) : {}));
        }
        if (req.method === 'GET' && /^\/v1\/runs\/[^/]+$/.test(url.pathname)) {
          return send(200, { object: 'hermes.run', run_id: 'run_x', status: 'running', updated_at: 1 });
        }
        const v = runsState.respond?.(req.method ?? '', url.pathname);
        if (v) return send(v.status, v.body ?? { ok: true });
        if (req.method === 'POST' && /^\/v1\/runs\/[^/]+\/(stop|steer|approval)$/.test(url.pathname)) {
          return send(200, { ok: true, path: url.pathname });
        }
        return send(404, { error: 'not found' });
      }
      return send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

function gwCfg(base: string, over: Partial<ReturnType<typeof resolveHermesGatewayConfig>> = {}): ReturnType<typeof resolveHermesGatewayConfig> {
  return {
    enabled: true,
    base_url: base,
    profiles: ['default', 'web-dev'],
    key: 'default-key',
    profileKeys: new Map([['web-dev', 'profile-key']]),
    poll_seconds: 30,
    timeout_ms: 500,
    key_file: '/dev/null',
    ...over,
  };
}

const ROW_A: GatewaySessionRow = {
  id: '20261009_010000_aaaa',
  title: 'Gate research session',
  model: 'Qwen3.8-27B',
  source: 'tui',
  message_count: 12,
  tool_call_count: 3,
  input_tokens: 4200,
  output_tokens: 1800,
  reasoning_tokens: 900,
  estimated_cost_usd: 0.012,
  last_active: 1760000000.5, // epoch SECONDS (the ledger shape)
};
const ROW_B: GatewaySessionRow = {
  id: '20261009_020000_bbbb',
  title: 'A finished one',
  model: 'Qwen3.8-Flash-Next',
  message_count: 4,
  input_tokens: 500,
  output_tokens: 300,
  last_active: 1760003600, // seconds
  ended_at: 1760003700, // seconds
  end_reason: 'user_closed',
};

// ---------------------------------------------------------------------------
// Suite 1a: pure merge/sanitize
// ---------------------------------------------------------------------------

test('rowToMeta: converts ledger rows (epoch-seconds → ms, per-member drop)', () => {
  const a = rowToMeta(ROW_A);
  assert.ok(a);
  assert.equal(a.id, '20261009_010000_aaaa');
  assert.equal(a.meta.title, 'Gate research session');
  assert.equal(a.meta.model, 'Qwen3.8-27B');
  assert.equal(a.meta.message_count, 12);
  assert.equal(a.meta.tool_call_count, 3);
  assert.equal(a.meta.input_tokens, 4200);
  assert.equal(a.meta.output_tokens, 1800);
  assert.equal(a.meta.reasoning_tokens, 900);
  assert.equal(a.meta.estimated_cost_usd, 0.012);
  assert.equal(a.meta.last_active, 1760000000500, 'epoch seconds become epoch ms');
  assert.equal(a.meta.ended_at, undefined, 'no ended_at member = absent (never a fake zero)');
  assert.equal(a.meta.end_reason, undefined);

  const b = rowToMeta(ROW_B);
  assert.ok(b);
  assert.equal(b.meta.ended_at, 1760003700000);
  assert.equal(b.meta.end_reason, 'user_closed');

  // Per-member drop: a malformed member is dropped, the rest are kept.
  const dirty = rowToMeta({ id: 'x', title: 42, message_count: -1, input_tokens: 100, estimated_cost_usd: NaN, ended_at: 'soon' });
  assert.ok(dirty);
  assert.equal(dirty.meta.title, undefined);
  assert.equal(dirty.meta.message_count, undefined);
  assert.equal(dirty.meta.input_tokens, 100);
  assert.equal(dirty.meta.estimated_cost_usd, undefined);
  assert.equal(dirty.meta.ended_at, undefined);

  // No id ⇒ the row cannot join a session row ⇒ dropped whole.
  assert.equal(rowToMeta({ title: 'no id' }), undefined);
  // A row with no usable members at all ⇒ undefined.
  assert.equal(rowToMeta({ id: 'only-id' }), undefined);
});

test('mergeHermesMeta: last-known-wins (absent keeps, present replaces, null rides)', () => {
  const existing: HermesSessionMeta = {
    title: 'old title',
    message_count: 5,
    input_tokens: 100,
    ended_at: 1760003700000,
    end_reason: 'user_closed',
  };
  // An incoming row that LOST members keeps the stored ones.
  const m1 = mergeHermesMeta(existing, { title: 'new title', message_count: 6 });
  assert.equal(m1.title, 'new title');
  assert.equal(m1.message_count, 6);
  assert.equal(m1.input_tokens, 100, 'absent member keeps the stored value');
  assert.equal(m1.ended_at, 1760003700000);
  // Explicit null Rides: the row ended (or un-ended) this poll.
  const m2 = mergeHermesMeta(m1, { ended_at: null, end_reason: null });
  assert.equal(m2.ended_at, null);
  assert.equal(m2.end_reason, null);
  // First-ever merge (no existing).
  const m3 = mergeHermesMeta(undefined, { model: 'X' });
  assert.deepEqual(m3, { model: 'X' });
});

test('mergeLedgerRows: same id across profiles — the newer last_active wins the round', () => {
  let ledger = new Map<string, HermesSessionMeta>();
  const oldRow: GatewaySessionRow = { id: 'dup', title: 'older', last_active: 1760000000 };
  const newRow: GatewaySessionRow = { id: 'dup', title: 'newer', last_active: 1760001000 };
  ledger = mergeLedgerRows(ledger, new Map([['dup', oldRow]]));
  assert.equal(ledger.get('dup')?.title, 'older');
  // The newer row wins the round (and still last-known-wins against stored).
  ledger = mergeLedgerRows(ledger, new Map([['dup', newRow]]));
  assert.equal(ledger.get('dup')?.title, 'newer');
  // A round without the id leaves the stored row standing (never erases).
  ledger = mergeLedgerRows(ledger, new Map());
  assert.equal(ledger.get('dup')?.title, 'newer');
});

test('ledgerPath: default = home ledger, a named profile = the /p/<profile> mirror', () => {
  assert.equal(ledgerPath('default'), '/api/sessions');
  assert.equal(ledgerPath('web-dev'), '/p/web-dev/api/sessions');
  assert.equal(ledgerPath('m365-admin'), '/p/m365-admin/api/sessions');
});

// ---------------------------------------------------------------------------
// Suite 1b: the connector against the fake gateway
// ---------------------------------------------------------------------------

test('connector: fetches health + ledgers, publishes meta only when reachable', async () => {
  const gw = await startFakeGateway({
    health: { status: 200, version: '0.21.6' },
    defaultRows: [ROW_A, ROW_B],
    profileRows: { 'web-dev': [{ id: 'prow', title: 'profile row', message_count: 1 }] },
  });
  cleanup.push(() => gw.close());
  const c = new HermesGatewayConnector(gwCfg(gw.base));
  // Pre-first-round: the connector publishes NOTHING (no false "gateway down").
  assert.equal(c.snapshot(), undefined);
  assert.equal(c.metaFor('20261009_010000_aaaa'), undefined);

  await c.poll();
  const snap = c.snapshot();
  assert.deepEqual(snap, { version: '0.21.6', reachable: true });
  assert.ok(c.metaFor('20261009_010000_aaaa')?.title === 'Gate research session');
  assert.equal(c.metaFor('20261009_020000_bbbb')?.end_reason, 'user_closed');
  assert.equal(c.metaFor('prow')?.title, 'profile row');
  assert.equal(c.metaFor('unknown-id'), undefined, 'unknown id ⇒ publish nothing');
  // The round hit the health + BOTH ledger paths with the RIGHT keys.
  const paths = gw.requests.map((r) => r.path);
  assert.ok(paths.includes('/v1/health'));
  assert.ok(paths.includes('/api/sessions'));
  assert.ok(paths.includes('/p/web-dev/api/sessions'));
  const profileAuth = gw.requests.find((r) => r.path === '/p/web-dev/api/sessions')?.auth;
  assert.equal(profileAuth, 'Bearer profile-key', 'the per-profile key rides the mirror');
});

test('connector: gateway down ⇒ unreachable, no meta, no crash, quiet log', async () => {
  const gw = await startFakeGateway({ health: null });
  cleanup.push(() => gw.close());
  const logs: string[] = [];
  const c = new HermesGatewayConnector(gwCfg(gw.base), { log: (m) => logs.push(m) });
  await c.poll();
  assert.deepEqual(c.snapshot(), { reachable: false }, 'reachable:false = the exception-only badge');
  assert.equal(c.metaFor('anything'), undefined, 'down ⇒ no meta (the gate is byte-for-byte unchanged)');
  // Re-poll stands (the cadence is honored via the fake clock seam).
  let t = 0;
  const c2 = new HermesGatewayConnector(gwCfg(gw.base, { poll_seconds: 5 }), { now: () => (t += 10_000) });
  await c2.poll(); // t=10s
  await c2.poll(); // t=20s → inside the 5s cadence? no: 10s > 5s → runs
  assert.equal(c2.ledgerSize, 0);
  assert.ok(logs.length >= 1, 'one quiet log line, never a crash');
});

test('connector: 401 ⇒ reachable but last-known rows stand (no key provisioned)', async () => {
  const gw = await startFakeGateway({
    health: { status: 200, version: '0.21.6' },
    defaultRows: [ROW_A],
    expectKeys: { default: 'the-operator-key' }, // the connector's key is 'default-key' ⇒ 401
  });
  cleanup.push(() => gw.close());
  const c = new HermesGatewayConnector(gwCfg(gw.base));
  await c.poll();
  assert.deepEqual(c.snapshot(), { version: '0.21.6', reachable: true }, 'up but unauthed ⇒ reachable');
  assert.equal(c.metaFor('20261009_010000_aaaa'), undefined, '401 ⇒ no rows (last-known, empty, stands)');
  // With the RIGHT key the rows flow.
  const c2 = new HermesGatewayConnector(gwCfg(gw.base, { key: 'the-operator-key' }));
  await c2.poll();
  assert.equal(c2.metaFor('20261009_010000_aaaa')?.title, 'Gate research session');
});

test('connector: a profile without a key is skipped; the rest of the round stands', async () => {
  const gw = await startFakeGateway({
    health: { status: 200, version: '0.21.6' },
    defaultRows: [ROW_A],
    profileRows: { 'web-dev': [{ id: 'prow', title: 'profile row' }] },
  });
  cleanup.push(() => gw.close());
  const c = new HermesGatewayConnector(gwCfg(gw.base, { profileKeys: new Map() }));
  await c.poll();
  assert.equal(c.metaFor('20261009_010000_aaaa')?.title, 'Gate research session', 'default fetched with its key');
  assert.equal(c.metaFor('prow'), undefined, 'web-dev skipped (no key) — never fetched');
  assert.ok(!gw.requests.some((r) => r.path === '/p/web-dev/api/sessions'), 'no request to an unkeyed profile');
});

test('config resolution: defaults, explicit list wins, disabled, key file', () => {
  const home = '/tmp/fake-home';
  const cfg = resolveHermesGatewayConfig(undefined, { IDLEFILL_HERMES_GATEWAY_KEY: 'env-key' }, home);
  assert.equal(cfg.enabled, true, 'default enabled');
  assert.equal(cfg.base_url, 'http://127.0.0.1:8642', 'the Hermes default base_url');
  assert.equal(cfg.key, 'env-key', 'the operator env key wins');
  assert.equal(cfg.poll_seconds, 30);
  // A malformed base_url falls back to the default (never a bogus URL).
  const bad = resolveHermesGatewayConfig({ base_url: 'not-a-url' }, {}, home);
  assert.equal(bad.base_url, 'http://127.0.0.1:8642');
  // An explicit profile list wins over auto-discovery.
  const ex = resolveHermesGatewayConfig({ profiles: ['web-dev', 'pr-agent'] }, {}, home);
  assert.deepEqual(ex.profiles, ['web-dev', 'pr-agent']);
  // Disabled.
  assert.equal(resolveHermesGatewayConfig({ enabled: false }, {}, home).enabled, false);
  // Key file.
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-gwkeys-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const kf = join(dir, 'keys.json');
  writeFileSync(kf, JSON.stringify({ default: 'file-key', 'web-dev': 'wk' }));
  const fk = resolveHermesGatewayConfig({ key_file: kf }, {}, home);
  assert.equal(fk.key, 'file-key');
  assert.equal(fk.profileKeys.get('web-dev'), 'wk');
  // A malformed key file ⇒ no keys (fail-quiet).
  writeFileSync(kf, '{nope');
  const badKf = resolveHermesGatewayConfig({ key_file: kf }, {}, home);
  assert.equal(badKf.key, undefined);
});

// ---------------------------------------------------------------------------
// Suite 1c: runs control (the seam) against the stub
// ---------------------------------------------------------------------------

test('runs: dispatch → status/steer/stop/approval verbs reach the stub; foreign runs refused pre-HTTP', async () => {
  const gw = await startFakeGateway({
    health: { status: 200, version: '0.21.6' },
    runsState: {
      create: () => ({ run_id: 'run_stub_1' }),
      verbs: [],
      respond: (method, path) =>
        /\/steer$/.test(path) && method === 'POST' ? { status: 409, body: { error: 'run_not_accepting_steer' } } : undefined,
    },
  });
  cleanup.push(() => gw.close());
  const runs = new HermesRunsControl(gwCfg(gw.base));

  // The scope law FIRST: a run this process did not dispatch is refused
  // WITHOUT an HTTP request (the gateway would refuse it too — the client
  // refuses earlier so a misconfiguration can never steer/stop foreign runs).
  const foreign = await runs.stop('default', 'run_foreign');
  assert.equal(foreign.ok, false);
  assert.match(foreign.error ?? '', /not an idlefill-dispatched run/);
  assert.equal(gw.requests.length, 0, 'refusal happened before any HTTP request');

  // Dispatch (POST /v1/runs with the prompt as `input`).
  const d = await runs.dispatch('default', 'Triage the morning queue', { model: 'Qwen3.8-27B' });
  assert.equal(d.ok, true);
  assert.equal(d.run_id, 'run_stub_1');
  assert.deepEqual(runs.list().map((r) => r.run_id), ['run_stub_1']);
  const createReq = gw.requests.find((r) => r.path === '/v1/runs');
  assert.equal(createReq?.method, 'POST');

  const st = await runs.status('default', 'run_stub_1');
  assert.equal(st.ok, true);
  assert.equal((st.body as { status?: string }).status, 'running');
  const steer = await runs.steer('default', 'run_stub_1', 'focus on the queue');
  assert.equal(steer.ok, false, 'the stub answers 409 (run not accepting steer)');
  assert.equal(steer.status, 409);
  const ap = await runs.approval('default', 'run_stub_1', 'approve');
  assert.equal(ap.ok, true);
  const stop = await runs.stop('default', 'run_stub_1');
  assert.equal(stop.ok, true);
  const createBody = JSON.parse(gw.requests.find((r) => r.path === '/v1/runs')!.body!);
  assert.equal(createBody.input, 'Triage the morning queue', 'the prompt rides as `input` (the gateway contract)');
  assert.equal(createBody.model, 'Qwen3.8-27B');
  const steerBody = JSON.parse(gw.requests.find((r) => /\/steer$/.test(r.path))!.body!);
  assert.equal(steerBody.input, 'focus on the queue');
  // Empty input is refused client-side (no HTTP).
  const before = gw.requests.length;
  const empty = await runs.steer('default', 'run_stub_1', '   ');
  assert.equal(empty.ok, false);
  assert.equal(gw.requests.length, before, 'empty steer never hit the wire');
});

test('runs: a failed dispatch owns nothing; the events stream parses SSE frames', async () => {
  const SSE = ': open\n\nid: 1\nevent: run.created\ndata: {"run_id":"run_stub_3"}\n\nid: 2\nevent: run.finished\ndata: {"status":"finished"}\n\n';
  const gw = await startFakeGateway({
    health: { status: 200, version: '0.21.6' },
    runsState: { create: () => ({ run_id: 'run_stub_3' }), verbs: [], events: SSE },
  });
  cleanup.push(() => gw.close());
  const runs = new HermesRunsControl(gwCfg(gw.base));

  // Empty input is refused client-side: no HTTP, no run owned.
  const before = gw.requests.length;
  const bad = await runs.dispatch('default', '');
  assert.equal(bad.ok, false);
  assert.equal(gw.requests.length, before, 'no dispatch hit the wire');
  assert.equal(runs.list().length, 0, 'no run owned on a failed dispatch');

  // The scope law holds for the events stream too: a run this process did
  // not dispatch is refused WITHOUT an HTTP request.
  const foreignEvents = await runs.events('default', 'run_foreign', () => {});
  assert.equal(foreignEvents.ok, false);
  assert.match(foreignEvents.error ?? '', /not an idlefill-dispatched run/);

  // Happy path: dispatch owns the run, then the SSE stream parses.
  const d = await runs.dispatch('default', 'spike');
  assert.equal(d.ok, true);
  assert.equal(d.run_id, 'run_stub_3');
  assert.deepEqual(runs.list().map((r) => r.run_id), ['run_stub_3']);

  const events: Array<{ seq?: number; name?: string; data: unknown }> = [];
  const ev = await runs.events('default', 'run_stub_3', (e) => events.push(e));
  assert.equal(ev.ok, true, 'the stream resolved');
  assert.equal(events.length, 2, 'both SSE frames parsed (the `: open` comment was ignored)');
  assert.equal(events[0]?.name, 'run.created');
  assert.equal(events[0]?.seq, 1);
  assert.deepEqual(events[0]?.data, { run_id: 'run_stub_3' });
  assert.equal(events[1]?.name, 'run.finished');
  assert.equal(events[1]?.seq, 2);
  assert.deepEqual(events[1]?.data, { status: 'finished' });
});

// ---------------------------------------------------------------------------
// Suite 2: fail-open / fail-quiet — the daemon-level byte-for-byte proof
//
// The proof is at the DAEMON level (real ClientDaemon + real SessionGate +
// the fake arbiter), not the gate level: the gate's register dep is a
// frozen surface (parallel #47 work), so the enrichment join lives in the
// daemon's register callback closure. With the env switch unset the
// connector is not even constructed — the register heartbeat bodies are
// byte-for-byte the pre-#73 shape.
// ---------------------------------------------------------------------------

import { ClientDaemon } from '../src/index.js';
import type { ClientConfig } from '../src/config.js';
import { startFakeArbiter, type FakeArbiter } from './fake-arbiter.js';

function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error(`timeout waiting: ${what}`));
      }
    }, 10);
  });
}

function startHeldUpstream(): Promise<{ url: string; hits: { path: string }[]; release: () => void; close: () => Promise<void> }> {
  const hits: { path: string }[] = [];
  const waiting: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '' });
      waiting.push(res);
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolveP({
        url: `http://127.0.0.1:${port}`,
        hits,
        release() {
          while (waiting.length > 0) {
            const res = waiting.shift()!;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'c1', model: 'resp-model', choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 4 } }));
          }
        },
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

const savedGwEnv: Record<string, string | undefined> = {
  IDLEFILL_HERMES_GATEWAY: process.env.IDLEFILL_HERMES_GATEWAY,
  IDLEFILL_HERMES_GATEWAY_URL: process.env.IDLEFILL_HERMES_GATEWAY_URL,
  IDLEFILL_HERMES_GATEWAY_KEY: process.env.IDLEFILL_HERMES_GATEWAY_KEY,
};

function setGwEnv(vars: Record<string, string | undefined>): void {
  for (const k of Object.keys(savedGwEnv)) {
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function restoreGwEnv(): void {
  for (const [k, v] of Object.entries(savedGwEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function bootDaemon(upUrl: string): Promise<{ daemon: ClientDaemon; arb: FakeArbiter; dir: string }> {
  const arb = await startFakeArbiter();
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-73-'));
  const cfg: ClientConfig = {
    server_url: arb.url,
    token: 't73',
    client_name: '73-test-client',
    ip: '100.94.165.102',
    proxy_port: 0,
    llm_target: upUrl,
    aggregate_port: 0,
    repo_root: here,
    state_dir: join(dir, 'state'),
    state_file: join(dir, 'state.json'),
    projects: [],
  };
  const daemon = new ClientDaemon(cfg, { pollMs: 50, log: { info: () => {} } });
  await daemon.start();
  return { daemon, arb, dir };
}

test('fail-open (env switch unset): the daemon heartbeats are byte-for-byte pre-#73', async () => {
  setGwEnv({ IDLEFILL_HERMES_GATEWAY: undefined, IDLEFILL_HERMES_GATEWAY_URL: undefined, IDLEFILL_HERMES_GATEWAY_KEY: undefined });
  const up = await startHeldUpstream();
  const { daemon, arb, dir } = await bootDaemon(up.url);
  try {
    assert.equal(daemon.hermesConnector, null, 'the connector is not constructed when the switch is unset');
    const resP = fetch(`${daemon.proxyUrl}/s/tok73a/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hermes-session-id': ROW_A.id as string },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await waitFor(() => up.hits.length === 1, 3000, 'the upstream hit');
    up.release();
    await resP;
    await waitFor(() => arb.sessionRegisters.some((b) => b.token === 'tok73a'), 3000, 'the session register heartbeat');
    for (const b of arb.sessionRegisters) {
      assert.ok(!('hermes_meta' in b), 'the session body never carries hermes_meta (byte-for-byte pre-#73 shape)');
    }
    for (const b of arb.registers) {
      assert.ok(!('hermes_version' in b) && !('gateway_reachable' in b), 'the client body never carries the gateway host facts');
    }
  } finally {
    await daemon.stop();
    await arb.close();
    await up.close();
    rmSync(dir, { recursive: true, force: true });
    restoreGwEnv();
  }
});

test('enrichment on the wire (switch on, gateway up): hermes_meta + host facts ride the heartbeats', async () => {
  const gw = await startFakeGateway({
    health: { status: 200, version: '0.21.6' },
    defaultRows: [ROW_A],
  });
  cleanup.push(() => gw.close());
  setGwEnv({ IDLEFILL_HERMES_GATEWAY: '1', IDLEFILL_HERMES_GATEWAY_URL: gw.base, IDLEFILL_HERMES_GATEWAY_KEY: 'test-key' });
  const up = await startHeldUpstream();
  const { daemon, arb, dir } = await bootDaemon(up.url);
  try {
    const sid = ROW_A.id as string;
    // The first poll round must complete before the traffic (deterministic).
    await waitFor(() => daemon.hermesConnector?.snapshot()?.reachable === true, 3000, 'the first gateway poll round (reachable)');
    const resP = fetch(`${daemon.proxyUrl}/s/tok73b/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hermes-session-id': sid },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await waitFor(() => up.hits.length === 1, 3000, 'the upstream hit');
    up.release();
    await resP;
    await waitFor(
      () => arb.sessionRegisters.some((b) => b.token === 'tok73b' && b.hermes_meta),
      3000,
      'the hermes_meta enrichment on the session heartbeat',
    );
    const metaBody = arb.sessionRegisters.find((b) => b.token === 'tok73b' && b.hermes_meta)!;
    assert.equal(metaBody.session_id, sid, 'the join key is the captured session id');
    const meta = metaBody.hermes_meta as { title: string; last_active: number };
    assert.equal(meta.title, 'Gate research session', 'the ledger title rides the heartbeat');
    assert.equal(meta.last_active, 1760000000500, 'epoch-seconds converted to ms');
    await waitFor(
      () => arb.registers.some((b) => b.gateway_reachable === true && b.hermes_version === '0.21.6'),
      3000,
      'the host facts on the client heartbeat',
    );
  } finally {
    await daemon.stop();
    await arb.close();
    await up.close();
    rmSync(dir, { recursive: true, force: true });
    restoreGwEnv();
  }
});

test('fail-open (switch on, gateway down): the session body omits hermes_meta; the exception-only badge rides', async () => {
  // An ephemeral port that is closed again: the gateway is DOWN (refused).
  const dead = http.createServer();
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
  const deadBase = `http://127.0.0.1:${(dead.address() as { port: number }).port}`;
  await new Promise<void>((r) => dead.close(() => r()));
  setGwEnv({ IDLEFILL_HERMES_GATEWAY: '1', IDLEFILL_HERMES_GATEWAY_URL: deadBase, IDLEFILL_HERMES_GATEWAY_KEY: 'test-key' });
  const up = await startHeldUpstream();
  const { daemon, arb, dir } = await bootDaemon(up.url);
  try {
    await waitFor(() => daemon.hermesConnector?.snapshot()?.reachable === false, 3000, 'the first gateway poll round (down)');
    const resP = fetch(`${daemon.proxyUrl}/s/tok73c/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hermes-session-id': ROW_A.id as string },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await waitFor(() => up.hits.length === 1, 3000, 'the upstream hit');
    up.release();
    await resP;
    await waitFor(() => arb.sessionRegisters.some((b) => b.token === 'tok73c'), 3000, 'the session register heartbeat');
    for (const b of arb.sessionRegisters) {
      assert.ok(!('hermes_meta' in b), 'gateway down ⇒ the session body omits hermes_meta (the gate is byte-for-byte unchanged)');
    }
    await waitFor(() => arb.registers.some((b) => b.gateway_reachable === false), 3000, 'the exception-only "gateway down" badge on the client heartbeat');
    for (const b of arb.registers) {
      assert.ok(!('hermes_version' in b), 'no version without a successful health round');
    }
  } finally {
    await daemon.stop();
    await arb.close();
    await up.close();
    rmSync(dir, { recursive: true, force: true });
    restoreGwEnv();
  }
});
