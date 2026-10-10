/**
 * hermes-lifecycle.test.ts — issue #85 slice G: the operator-driven Hermes
 * session LIFECYCLE verb (PATCH /api/sessions/{id}, client-safe fields ONLY),
 * served by the client daemon's loopback route
 * (PATCH /client/hermes-lifecycle/<session_id>).
 *
 * Suites:
 *   1. The connector verb (patchLifecycle) against a FAKE gateway on an
 *      ephemeral loopback port:
 *        - allow-list enforcement: end_reason / unknown fields / bad types /
 *          empty patch are refused BY NAME with ZERO gateway requests;
 *        - the #83 probe walk resolves the owning profile (first 200 wins)
 *          and the PATCH lands there EXACTLY ONCE (no automatic retry);
 *        - every-keyed-profile-404 ⇒ the named 404; an all-ambiguous walk ⇒
 *          the named 503 gateway_ambiguous (never a false not-found);
 *        - disabled / unkeyed / malformed id ⇒ named refusal, zero requests;
 *        - unreachable ⇒ one bounded attempt, the named 503;
 *        - a gateway-refused write ⇒ gateway_rejected with the gateway's
 *          status, exactly one PATCH;
 *        - the verb NEVER touches the enrichment ledger (so it can never
 *          reach the hermes_meta heartbeat).
 *   2. The loopback ROUTE through the REAL proxy (real sockets): Host/Origin/
 *      token guards, method restriction (PATCH/OPTIONS only), the named 503
 *      when the connector is absent, body refusal before any gateway call,
 *      and the passthrough-absent posture (no opts ⇒ the route does not
 *      exist, byte-for-byte prior posture).
 *   3. NEVER-ON-WIRE proof (daemon level): a real ClientDaemon + real gate +
 *      the fake arbiter. After the lifecycle route lands a title MARKER,
 *      EVERY register heartbeat, session register, usage report, and arbiter
 *      /api/state body is scanned: none may carry it. The gateway saw exactly
 *      ONE PATCH (one click, one verb, no automation, no retry).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HermesGatewayConnector, validateLifecyclePatch } from '../src/hermes-gateway.js';
import { startLlmProxy, waitProxyReady } from '../src/proxy.js';
import { ClientDaemon } from '../src/index.js';
import type { ClientConfig } from '../src/config.js';
import { startFakeArbiter, type FakeArbiter } from './fake-arbiter.js';

const here = dirname(fileURLToPath(import.meta.url));
const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

// ---------------------------------------------------------------------------
// Fake gateway with the session GET + PATCH routes. PATCH posture verified
// live against api_server.py `_handle_patch_session` (0.21.x): allowed fields
// {title,end_reason,pinned,archived,hidden,unread} (unknown ⇒ 400
// `unsupported_session_field`); flags boolean-only; success answers
// {object:'hermes.session', session:{…}}; the id resolves through
// `_get_existing_session_or_404` ⇒ a foreign id 400s nothing, it 404s.
// ---------------------------------------------------------------------------

interface FakeLifecycleOpts {
  /** Profiles that HOLD the session (GET 200); everyone else answers 404. */
  holderProfiles?: string[];
  /** Require an exact key per profile (401 otherwise). */
  expectKeys?: Record<string, string>;
  /** Answer the GET probe with a 5xx (ambiguous). */
  probeStatus?: number;
  /** Answer an owned PATCH with this status + gateway error envelope. */
  patchStatus?: number;
  patchError?: { message?: string; code?: string };
  /** Echo the session id on a successful PATCH (the real gateway does). */
}

interface FakeGateway {
  base: string;
  requests: { method: string; path: string; auth: string; body: string }[];
  close: () => Promise<void>;
}

function startFakeGateway(opts: FakeLifecycleOpts = {}): Promise<FakeGateway> {
  const requests: FakeGateway['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      requests.push({
        method: req.method ?? '',
        path: url.pathname,
        auth: req.headers.authorization ?? '',
        body,
      });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const m = url.pathname.match(/^\/(?:p\/([^/]+)\/)?api\/sessions\/([^/]+)$/);
      if (!m) return send(404, { error: { message: 'not found', code: 'not_found' } });
      const profile = m[1] ?? 'default';
      const sessionId = decodeURIComponent(m[2] ?? '');
      const expected = opts.expectKeys?.[profile];
      if (expected && (req.headers.authorization ?? '') !== `Bearer ${expected}`) {
        return send(401, { error: { message: 'Invalid gateway API key', code: 'gateway_auth_failed' } });
      }
      const holds = (opts.holderProfiles ?? ['default']).includes(profile);
      if (req.method === 'GET') {
        if (!holds) return send(404, { error: { message: 'session not found', code: 'session_not_found' } });
        if (opts.probeStatus && opts.probeStatus !== 200) {
          return send(opts.probeStatus, { error: { message: 'boom', code: 'server_error' } });
        }
        return send(200, { object: 'hermes.session', session: { id: sessionId, title: 'stored title' } });
      }
      if (req.method === 'PATCH') {
        if (!holds) return send(404, { error: { message: 'session not found', code: 'session_not_found' } });
        if (opts.patchStatus && opts.patchStatus !== 200) {
          return send(opts.patchStatus, { error: opts.patchError ?? { message: 'refused', code: 'invalid_title' } });
        }
        let patched: Record<string, unknown> = {};
        try {
          const p = JSON.parse(body) as Record<string, unknown>;
          if (p && typeof p === 'object' && !Array.isArray(p)) patched = p;
        } catch {
          /* the connector always sends valid JSON; an echoed empty is fine */
        }
        return send(200, { object: 'hermes.session', session: { id: sessionId, ...patched } });
      }
      return send(405, { error: { message: 'method not allowed', code: 'method_not_allowed' } });
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      cleanup.push(() =>
        new Promise<void>((r) => {
          server.closeAllConnections?.();
          server.close(() => r());
        }),
      );
      resolveP({
        base: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function cfg(
  base: string,
  over: Partial<{ enabled: boolean; key: string | undefined; profiles: string[]; profileKeys: Map<string, string>; timeout_ms: number }> = {},
) {
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

// ---------------------------------------------------------------------------
// 1. The connector verb + allow-list enforcement
// ---------------------------------------------------------------------------

test('allow-list: end_reason refused BY NAME before any HTTP request', async () => {
  const gw = await startFakeGateway();
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const res = await conn.patchLifecycle('sess-85', { end_reason: 'user_ended' });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 400);
  assert.equal(res.reason, 'invalid_body');
  assert.match(res.error, /end_reason/, 'the refusal names the field');
  assert.match(res.error, /deliberately NOT exposed/, 'and says why it is off the table this issue');
  assert.equal(gw.requests.length, 0, 'refused BEFORE a single byte reached the gateway');
});

test('allow-list: unknown field / bad type / empty patch refused with ZERO requests; the unit sanitizer is honest', async () => {
  const gw = await startFakeGateway();
  const conn = new HermesGatewayConnector(cfg(gw.base));
  for (const body of [{ model: 'gpt-x' }, { pinned: 'yes' }, {}, { title: '   ' }, { title: 5 }]) {
    const res = await conn.patchLifecycle('sess-85', body);
    assert.equal(res.ok, false, `${JSON.stringify(body)} is refused`);
    if (res.ok) return;
    assert.equal(res.reason, 'invalid_body');
  }
  assert.equal(gw.requests.length, 0, 'no body shape ever touched the wire');

  const okPatch = validateLifecyclePatch({ title: '  hello  ', pinned: true, archived: false, hidden: false, unread: true });
  assert.ok(okPatch.ok);
  if (!okPatch.ok) return;
  assert.deepEqual(okPatch.patch, { title: 'hello', pinned: true, archived: false, hidden: false, unread: true }, 'trimmed + typed');
  assert.equal(validateLifecyclePatch({ title: 'x'.repeat(300) }).ok && (validateLifecyclePatch({ title: 'x'.repeat(300) }) as { patch: { title: string } }).patch.title.length, 256, 'title capped');
  const restored = validateLifecyclePatch({ title: null });
  assert.ok(restored.ok && restored.patch.title === null, 'title:null = the gateway restore path');
});

test('the #83 probe walk resolves the owner and the PATCH lands there EXACTLY ONCE', async () => {
  const gw = await startFakeGateway({ holderProfiles: ['web-dev'] });
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const res = await conn.patchLifecycle('sess-85', { title: 'renamed', pinned: true });
  assert.equal(res.ok, true, 'the walk found the owner and the patch landed');
  if (!res.ok) return;
  assert.equal(res.profile, 'web-dev', 'first keyed profile answering 200 owns the row');
  assert.deepEqual(res.patched.sort(), ['pinned', 'title'], 'the verdict names the fields — never the values');
  assert.deepEqual(
    gw.requests.map((r) => `${r.method} ${r.path}`),
    ['GET /api/sessions/sess-85', 'GET /p/web-dev/api/sessions/sess-85', 'PATCH /p/web-dev/api/sessions/sess-85'],
    'default 404ed, web-dev resolved, the PATCH landed on the SAME profile',
  );
  assert.equal(gw.requests.filter((r) => r.method === 'PATCH').length, 1, 'exactly-once per call — no retry');
  assert.equal(gw.requests[2]!.auth, 'Bearer profile-key', 'the per-profile Bearer key rides the verb');
  const sent = JSON.parse(gw.requests[2]!.body) as Record<string, unknown>;
  assert.deepEqual(sent, { title: 'renamed', pinned: true }, 'only the allow-listed fields ride the wire');
});

test('title:null reaches the gateway verbatim (the documented restore path)', async () => {
  const gw = await startFakeGateway();
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const res = await conn.patchLifecycle('sess-85', { title: null });
  assert.equal(res.ok, true);
  const patchReq = gw.requests.find((r) => r.method === 'PATCH');
  assert.ok(patchReq);
  const sent = JSON.parse(patchReq.body) as { title?: unknown };
  assert.equal(sent.title, null, 'null passes through — the gateway restores the derived title');
});

test('every keyed profile 404 ⇒ the named session_not_found refusal, ZERO PATCHes', async () => {
  const gw = await startFakeGateway({ holderProfiles: [] });
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const res = await conn.patchLifecycle('ghost-85', { pinned: true });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 404);
  assert.equal(res.reason, 'session_not_found');
  assert.equal(gw.requests.length, 2, 'both keyed profiles probed, in order');
  assert.equal(gw.requests.filter((r) => r.method === 'PATCH').length, 0, 'never a blind write against an unresolved id');
});

test('every keyed profile 401s: the named 503 gateway_ambiguous, NEVER a false 404', async () => {
  const gw = await startFakeGateway({
    expectKeys: { default: 'other-key', 'web-dev': 'other-key' },
  });
  const conn = new HermesGatewayConnector(cfg(gw.base)); // our keys are the WRONG ones
  const res = await conn.patchLifecycle('sess-85', { pinned: true });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 503);
  assert.equal(res.reason, 'gateway_ambiguous', '401s are not definitive misses — honest refusal, not session_not_found');
  assert.equal(gw.requests.length, 2);
  assert.equal(gw.requests.filter((r) => r.method === 'PATCH').length, 0, 'a control verb never fires against an unresolved profile');
});

test('disabled connector / no key / malformed id: NAMED refusal with ZERO gateway requests', async () => {
  const gw = await startFakeGateway();
  const disabled = new HermesGatewayConnector(cfg(gw.base, { enabled: false }));
  const a = await disabled.patchLifecycle('sess-85', { pinned: true });
  assert.equal(a.ok, false);
  if (a.ok) return;
  assert.equal(a.status, 503);
  assert.equal(a.reason, 'connector_disabled');

  const unkeyed = new HermesGatewayConnector(cfg(gw.base, { key: undefined, profileKeys: new Map() }));
  const b = await unkeyed.patchLifecycle('sess-85', { pinned: true });
  assert.equal(b.ok, false);
  if (b.ok) return;
  assert.equal(b.status, 503);
  assert.equal(b.reason, 'no_key');

  const conn = new HermesGatewayConnector(cfg(gw.base));
  const c = await conn.patchLifecycle('   ', { pinned: true });
  assert.equal(c.ok, false);
  if (c.ok) return;
  assert.equal(c.status, 400);
  assert.equal(c.reason, 'invalid_session_id');

  assert.equal(gw.requests.length, 0, 'every refusal answered WITHOUT touching the wire');
});

test('unreachable gateway: one bounded attempt, the named 503, no retry storm', async () => {
  // A port nothing listens on (bind AWAITED, then closed — address() is null
  // until 'listening' fires).
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const conn = new HermesGatewayConnector(cfg(`http://127.0.0.1:${port}`, { timeout_ms: 300 }));
  const res = await conn.patchLifecycle('sess-85', { pinned: true });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 503);
  assert.equal(res.reason, 'gateway_unreachable');
});

test('gateway refuses the PATCH: gateway_rejected with its status, exactly ONE PATCH (no retry)', async () => {
  const gw = await startFakeGateway({
    patchStatus: 400,
    patchError: { message: "'title' must be a non-empty string", code: 'invalid_title' },
  });
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const res = await conn.patchLifecycle('sess-85', { title: 'ok title' });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 400, "the gateway's own status rides the verdict");
  assert.equal(res.reason, 'gateway_rejected');
  assert.match(res.error, /must be a non-empty string/, 'the gateway complaint surfaces verbatim');
  assert.equal(gw.requests.filter((r) => r.method === 'PATCH').length, 1, 'a refused write is never retried automatically');
});

test('the verb never touches the enrichment ledger (nothing can ride the heartbeat)', async () => {
  const gw = await startFakeGateway();
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const res = await conn.patchLifecycle('sess-85', { title: 'MUST-NOT-PUBLISH' });
  assert.equal(res.ok, true);
  assert.equal(conn.ledgerSize, 0, 'the patch (nor the probe echo) entered the last-known ledger');
  assert.equal(gw.requests.filter((r) => r.method === 'GET').length, 1, 'exactly one probe GET — no polling, no re-resolve');
  assert.equal(gw.requests.filter((r) => r.method === 'PATCH').length, 1);
});

// ---------------------------------------------------------------------------
// 2. The loopback ROUTE through the real proxy
// ---------------------------------------------------------------------------

async function startRouteProxy(opts: { token: string; connector: HermesGatewayConnector | null }): Promise<{ base: string; stop: () => Promise<void> }> {
  const proxy = startLlmProxy({
    port: 0,
    target: 'http://127.0.0.1:9',
    hermesLifecycle: { token: opts.token, connector: () => opts.connector },
  });
  await waitProxyReady(proxy.server);
  return { base: proxy.base_url, stop: () => proxy.stop() };
}

test('route: token-guarded PATCH lands once; missing token 401s; cross-origin 403s; GET 405s', async () => {
  const gw = await startFakeGateway();
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const { base, stop } = await startRouteProxy({ token: 'tok85g', connector: conn });
  try {
    const ok = await fetch(`${base}/client/hermes-lifecycle/sess-85`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-idlefill-edit': 'tok85g' },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { ok: boolean; profile: string; patched: string[] };
    assert.equal(body.ok, true);
    assert.equal(body.profile, 'default');
    assert.deepEqual(body.patched, ['pinned']);
    assert.equal(gw.requests.filter((r) => r.method === 'PATCH').length, 1, 'one click, one PATCH');

    const noAuth = await fetch(`${base}/client/hermes-lifecycle/sess-85`, { method: 'PATCH', body: '{}' });
    assert.equal(noAuth.status, 401);
    const badAuth = await fetch(`${base}/client/hermes-lifecycle/sess-85`, {
      method: 'PATCH',
      headers: { 'x-idlefill-edit': 'wrong' },
      body: '{}',
    });
    assert.equal(badAuth.status, 401);

    const cross = await fetch(`${base}/client/hermes-lifecycle/sess-85`, {
      method: 'PATCH',
      headers: { 'x-idlefill-edit': 'tok85g', origin: 'https://evil.example.com' },
      body: '{}',
    });
    assert.equal(cross.status, 403);

    const badMethod = await fetch(`${base}/client/hermes-lifecycle/sess-85`, {
      headers: { 'x-idlefill-edit': 'tok85g' },
    });
    assert.equal(badMethod.status, 405);

    const preflight = await fetch(`${base}/client/hermes-lifecycle/sess-85`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /PATCH/);
  } finally {
    await stop();
  }
});

test('route: a disallowed body answers the named 400 BEFORE any gateway request', async () => {
  const gw = await startFakeGateway();
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const { base, stop } = await startRouteProxy({ token: 'tok85g', connector: conn });
  try {
    const res = await fetch(`${base}/client/hermes-lifecycle/sess-85`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-idlefill-edit': 'tok85g' },
      body: JSON.stringify({ end_reason: 'user_ended' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; reason: string; error: string };
    assert.equal(body.reason, 'invalid_body');
    assert.match(body.error, /end_reason/);
    assert.equal(gw.requests.length, 0, 'zero gateway requests for a refused body');

    const junk = await fetch(`${base}/client/hermes-lifecycle/sess-85`, {
      method: 'PATCH',
      headers: { 'x-idlefill-edit': 'tok85g' },
      body: 'not json',
    });
    assert.equal(junk.status, 400);
    assert.equal(gw.requests.length, 0, 'still zero — a malformed body never reaches the walk');
  } finally {
    await stop();
  }
});

test('route: a gateway-refused write surfaces verbatim, still exactly one PATCH', async () => {
  const gw = await startFakeGateway({ patchStatus: 409, patchError: { message: 'session is live', code: 'session_active_turn' } });
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const { base, stop } = await startRouteProxy({ token: 'tok85g', connector: conn });
  try {
    const res = await fetch(`${base}/client/hermes-lifecycle/sess-85`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-idlefill-edit': 'tok85g' },
      body: JSON.stringify({ title: 'rename a live row' }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { ok: boolean; reason: string; error: string };
    assert.equal(body.reason, 'gateway_rejected');
    assert.match(body.error, /session is live/, 'the refusal reason rides to the toast verbatim');
    assert.equal(gw.requests.filter((r) => r.method === 'PATCH').length, 1, 'the route never resubmitted after the failure');
  } finally {
    await stop();
  }
});

test('route: absent connector answers the NAMED 503 (zero gateway requests)', async () => {
  const { base, stop } = await startRouteProxy({ token: 'tok85g', connector: null });
  try {
    const res = await fetch(`${base}/client/hermes-lifecycle/sess-85`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-idlefill-edit': 'tok85g' },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'connector_disabled');
  } finally {
    await stop();
  }
});

test('route: with no hermesLifecycle opts the path falls through untouched (byte-for-byte prior posture)', async () => {
  const proxy = startLlmProxy({ port: 0, target: 'http://127.0.0.1:9' });
  await waitProxyReady(proxy.server);
  try {
    const res = await fetch(`${proxy.base_url}/client/hermes-lifecycle/sess-85`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    // Plain passthrough: the LLM target is down ⇒ the proxy's 502, NOT the
    // lifecycle surface. The route simply does not exist.
    assert.equal(res.status, 502);
    assert.equal(proxy.log.length, 1, 'the path was treated as passthrough traffic');
  } finally {
    await proxy.stop();
  }
});

// ---------------------------------------------------------------------------
// 3. NEVER-ON-WIRE proof (daemon level): the verb's payload NEVER rides a
// heartbeat, a register body, or the arbiter's state.
// ---------------------------------------------------------------------------

function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolveP();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error(`timeout waiting: ${what}`));
      }
    }, 10);
  });
}

const MARKER = 'TOP-SECRET-RENAME-85G';

async function startHeldUpstream(): Promise<{ url: string; release: () => void; close: () => Promise<void> }> {
  const waiting: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      void b;
      waiting.push(res);
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolveP({
        url: `http://127.0.0.1:${port}`,
        release() {
          while (waiting.length > 0) {
            const res = waiting.shift()!;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 'c1', model: 'm', choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 4 } }));
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

test('the lifecycle verb NEVER rides any heartbeat or arbiter wire payload', async () => {
  // The default profile holds the session (the daemon connector's profile is
  // 'default', its key comes from the env var set below).
  const gw = await startFakeGateway({ holderProfiles: ['default'] });

  const savedEnv = {
    IDLEFILL_HERMES_GATEWAY: process.env.IDLEFILL_HERMES_GATEWAY,
    IDLEFILL_HERMES_GATEWAY_URL: process.env.IDLEFILL_HERMES_GATEWAY_URL,
    IDLEFILL_HERMES_GATEWAY_KEY: process.env.IDLEFILL_HERMES_GATEWAY_KEY,
  };
  process.env.IDLEFILL_HERMES_GATEWAY = '1';
  process.env.IDLEFILL_HERMES_GATEWAY_URL = gw.base;
  process.env.IDLEFILL_HERMES_GATEWAY_KEY = 'key85g';

  const arb: FakeArbiter = await startFakeArbiter();
  const up = await startHeldUpstream();
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-85g-'));
  const cfg85: ClientConfig = {
    server_url: arb.url,
    token: 't85g',
    client_name: '85g-test-client',
    ip: '100.94.165.102',
    proxy_port: 0,
    llm_target: up.url,
    aggregate_port: 0,
    repo_root: here,
    state_dir: join(dir, 'state'),
    state_file: join(dir, 'state.json'),
    projects: [],
    hermes_gateway: { enabled: true },
  } as ClientConfig;
  const daemon = new ClientDaemon(cfg85, { pollMs: 50, log: { info: () => {} } });
  try {
    await daemon.start();

    // Drive one session request so the gate registers a session heartbeat.
    const resP = fetch(`${daemon.proxyUrl}/s/tok85ga/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hermes-session-id': 'sess-85g' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await waitFor(() => arb.sessionRegisters.length > 0, 4000, 'the session register heartbeat');
    up.release();
    await resP;
    await waitFor(() => arb.registers.length > 0, 4000, 'the client register heartbeat');

    // The operator's deliberate click: rename over the loopback route.
    const pr = await fetch(`${daemon.proxyUrl}/client/hermes-lifecycle/sess-85g`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-idlefill-edit': 't85g' },
      body: JSON.stringify({ title: MARKER }),
    });
    assert.equal(pr.status, 200, 'the loopback route answers the click');
    const verdict = (await pr.json()) as { ok: boolean; patched: string[] };
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.patched, ['title']);
    const patchReq = gw.requests.filter((r) => r.method === 'PATCH');
    assert.equal(patchReq.length, 1, 'exactly one PATCH reached the gateway for one click — no automation, no retry');
    assert.ok(patchReq[0]!.body.includes(MARKER), 'the PATCH really carried the marker (the proof means something)');

    // Nothing on any publish carries it: every register body, every session
    // register body, usage reports, and the arbiter's state view.
    const scan = (obj: unknown): boolean => JSON.stringify(obj).includes(MARKER);
    for (const body of arb.registers) assert.ok(!scan(body), 'the client register heartbeat never carries the verb payload');
    for (const body of arb.sessionRegisters) assert.ok(!scan(body), 'the session register heartbeat never carries the verb payload');
    for (const body of arb.usageReports) assert.ok(!scan(body), 'usage reports never carry the verb payload');
    const state = await fetch(`${arb.url}/api/state`).then((r) => r.json());
    assert.ok(!scan(state), 'the arbiter /api/state never carries the verb payload');
    assert.equal(daemon.hermesConnector?.ledgerSize, 0, 'the verb payload never entered the enrichment ledger either');

    // No automation fired the verb again afterwards: the poll rounds touch
    // health/listing only — the PATCH count stays at the one click.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(gw.requests.filter((r) => r.method === 'PATCH').length, 1, 'zero automated lifecycle verbs — the click is the only caller');
  } finally {
    await daemon.stop().catch(() => {});
    await arb.close().catch(() => {});
    await up.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
