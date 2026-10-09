/**
 * hermes-transcript.test.ts — issue #85 slice A: the ON-DEMAND Hermes
 * transcript for the session viewer, served by the client daemon's loopback
 * route (GET /client/hermes-transcript/<session_id>?offset=…&limit=…) which
 * proxies the gateway's GET /api/sessions/{id}/messages page by page.
 *
 * Suites:
 *   1. The connector walk (fetchTranscript) against a FAKE gateway on an
 *      ephemeral loopback port:
 *        - a bounded page returns sanitized messages (per-member caps,
 *          drop-don't-crash rows);
 *        - a 404 on one profile walks to the next keyed profile (first 200
 *          wins, the #83 probe-walk posture);
 *        - disabled / unkeyed answers the NAMED 503 refusal with ZERO
 *          gateway requests;
 *        - an unreachable gateway: one bounded attempt, the named 503,
 *          no retry storm;
 *        - offset/limit are clamped before the request is ever made.
 *   2. The loopback ROUTE through the REAL proxy (real sockets): Host/Origin/
 *      token guards, the named 503 when the connector is absent, a 200 page
 *      when it is present, and the passthrough-absent posture (no opts ⇒ the
 *      route does not exist).
 *   3. NEVER-ON-WIRE proof (daemon level): a real ClientDaemon + real gate +
 *      the fake arbiter. After the transcript route is hit, EVERY register
 *      heartbeat, session heartbeat, and arbiter /api/state body is scanned
 *      for the transcript's marker bytes: none may appear. The transcript
 *      rides no publish, in any shape.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HermesGatewayConnector,
  clampTranscriptPage,
  sanitizeTranscriptMessage,
  transcriptPath,
  TRANSCRIPT_CONTENT_CAP,
  TRANSCRIPT_PAGE_MAX,
  TRANSCRIPT_TOOL_CALLS_MAX,
  type GatewaySessionRow,
} from '../src/hermes-gateway.js';
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
// Fake gateway with the /messages route (envelope shape pinned live against
// api_server.py `_handle_session_messages`: {object:'list', session_id,
// data:[safe-key rows], pagination:{limit, offset, order, returned}})
// ---------------------------------------------------------------------------

interface FakeMessagesOpts {
  /** Per-profile canned message pages: profile → { rows, [offset]: rows }. */
  pages?: Record<string, { rows: unknown[] }>;
  /** Profiles whose /messages reads 404 (session not in this profile). */
  notFoundProfiles?: string[];
  /** Require an exact key per profile (401 otherwise). */
  expectKeys?: Record<string, string>;
  /** Respond with a non-JSON body for the messages read (malformed). */
  malformed?: boolean;
}

interface FakeGateway {
  base: string;
  requests: { method: string; path: string; query: string; auth: string }[];
  close: () => Promise<void>;
}

function startFakeGateway(opts: FakeMessagesOpts = {}): Promise<FakeGateway> {
  const requests: FakeGateway['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      void body;
      const url = new URL(req.url ?? '/', 'http://x');
      requests.push({
        method: req.method ?? '',
        path: url.pathname,
        query: url.search,
        auth: req.headers.authorization ?? '',
      });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const m = url.pathname.match(/^\/(?:p\/([^/]+)\/)?api\/sessions\/([^/]+)\/messages$/);
      if (req.method !== 'GET' || !m) return send(404, { error: 'not found' });
      const profile = m[1] ?? 'default';
      const expected = opts.expectKeys?.[profile];
      if (expected && (req.headers.authorization ?? '') !== `Bearer ${expected}`) {
        return send(401, { error: { code: 'gateway_auth_failed' } });
      }
      if (opts.notFoundProfiles?.includes(profile)) {
        return send(404, { error: { code: 'session_not_found' } });
      }
      if (opts.malformed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('this is not json');
      }
      const page = opts.pages?.[profile];
      if (!page) return send(404, { error: { code: 'session_not_found' } });
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const data = page.rows.slice(offset, offset + limit);
      return send(200, {
        object: 'list',
        session_id: decodeURIComponent(m[2] ?? ''),
        data,
        pagination: { limit, offset, order: url.searchParams.get('order') ?? 'oldest', returned: data.length },
      });
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
      resolveP({ base: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

function cfg(base: string, over: Partial<{ enabled: boolean; key: string | undefined; profiles: string[]; profileKeys: Map<string, string>; timeout_ms: number }> = {}) {
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

const MSG_ROWS: unknown[] = [
  { id: 1, session_id: 'sess-85', role: 'user', content: 'hello there', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 1760000000.5, token_count: null, finish_reason: null },
  { id: 2, session_id: 'sess-85', role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } }], tool_name: null, timestamp: 1760000100.25, token_count: 42, finish_reason: 'tool_calls' },
  // A row with NO usable role — must be dropped, not crash the page.
  { id: 3, session_id: 'sess-85', role: null, content: 'orphan', timestamp: 1760000101 },
  // Oversized content + oversized tool args — capped with the truncation flag.
  { id: 4, session_id: 'sess-85', role: 'assistant', content: 'x'.repeat(TRANSCRIPT_CONTENT_CAP + 500), tool_calls: Array.from({ length: TRANSCRIPT_TOOL_CALLS_MAX + 5 }, (_, i) => ({ function: { name: `tool_${i}`, arguments: 'a'.repeat(2000) } })), timestamp: 1760000200, token_count: 7, finish_reason: 'stop' },
];

// ---------------------------------------------------------------------------
// 1. The connector walk
// ---------------------------------------------------------------------------

test('bounded page: sanitized messages, caps applied, malformed row dropped', async () => {
  const gw = await startFakeGateway({ pages: { default: { rows: MSG_ROWS } } });
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const res = await conn.fetchTranscript('sess-85', 0, 50);
  assert.equal(res.ok, true, 'the page answers');
  if (!res.ok) return;
  assert.equal(res.profile, 'default', 'first keyed profile that answers 200 wins');
  // The role-less row is dropped (4 raw rows → 3 sanitized).
  assert.equal(res.messages.length, 3, 'the malformed row is dropped, never a crash');
  const user = res.messages[0]!;
  const assistant = res.messages[1]!;
  const capped = res.messages[2]!;
  assert.equal(user.role, 'user');
  assert.equal(user.content, 'hello there');
  assert.equal(user.timestamp, 1760000000500, 'epoch-seconds normalize to epoch-ms');
  assert.equal(assistant.tool_calls?.[0]?.name, 'web_search', 'tool_calls keep the function name');
  assert.equal(assistant.token_count, 42);
  assert.equal(assistant.finish_reason, 'tool_calls');
  assert.equal(capped.content?.length, TRANSCRIPT_CONTENT_CAP, 'content is capped');
  assert.equal(capped.content_truncated, true);
  assert.equal(capped.tool_calls?.length, TRANSCRIPT_TOOL_CALLS_MAX, 'tool_calls are capped');
  assert.equal(capped.tool_calls_truncated, true);
  // The gateway saw the bounded params: exactly one request, limit 50.
  assert.equal(gw.requests.length, 1);
  assert.match(gw.requests[0]!.query, /limit=50/);
  assert.match(gw.requests[0]!.query, /offset=0/);
  assert.equal(gw.requests[0]!.auth, 'Bearer default-key', 'the per-profile Bearer key rides the gateway call');
});

test('404 on the first profile walks to the next keyed profile (the #83 posture)', async () => {
  const gw = await startFakeGateway({
    notFoundProfiles: ['default'],
    pages: { 'web-dev': { rows: MSG_ROWS.slice(0, 2) } },
  });
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const res = await conn.fetchTranscript('sess-85', 0, 10);
  assert.equal(res.ok, true, 'the second profile answers 200');
  if (!res.ok) return;
  assert.equal(res.profile, 'web-dev');
  assert.equal(res.messages.length, 2);
  assert.equal(gw.requests.length, 2, 'default 404ed, web-dev hit — the walk, in order');
  assert.equal(gw.requests[1]!.path, '/p/web-dev/api/sessions/sess-85/messages', 'the per-profile mirror path');
});

test('every keyed profile 404 ⇒ the named session_not_found refusal', async () => {
  const gw = await startFakeGateway({ notFoundProfiles: ['default', 'web-dev'] });
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const res = await conn.fetchTranscript('ghost-session', 0, 50);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 404);
  assert.equal(res.reason, 'session_not_found');
  assert.equal(gw.requests.length, 2, 'both keyed profiles probed, in order');
});

test('ambiguous answers (5xx / malformed body) are NOT reported as not-found', async () => {
  // EVERY keyed profile 500s: nothing said "no such session", so the honest
  // refusal is the named 503 gateway_ambiguous, never a 404.
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  const port = (server.address() as { port: number }).port;
  const conn = new HermesGatewayConnector(cfg(`http://127.0.0.1:${port}`));
  const res = await conn.fetchTranscript('sess-85', 0, 50);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 503);
  assert.equal(res.reason, 'gateway_ambiguous');
});

test('disabled connector: NAMED 503 refusal with ZERO gateway requests', async () => {
  const gw = await startFakeGateway({ pages: { default: { rows: MSG_ROWS } } });
  const conn = new HermesGatewayConnector(cfg(gw.base, { enabled: false }));
  const res = await conn.fetchTranscript('sess-85', 0, 50);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 503);
  assert.equal(res.reason, 'connector_disabled');
  assert.equal(gw.requests.length, 0, 'disabled ⇒ never a single request');
});

test('no profile carries a key: NAMED 503 refusal with ZERO gateway requests', async () => {
  const gw = await startFakeGateway({ pages: { default: { rows: MSG_ROWS } } });
  const conn = new HermesGatewayConnector(cfg(gw.base, { key: undefined, profileKeys: new Map() }));
  const res = await conn.fetchTranscript('sess-85', 0, 50);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 503);
  assert.equal(res.reason, 'no_key');
  assert.equal(gw.requests.length, 0, 'unkeyed ⇒ fail-closed without touching the wire');
});

test('unreachable gateway: one bounded attempt, the named 503, no retry storm', async () => {
  // A port nothing listens on (bind AWAITED, then close, gives a
  // certainly-free port — address() is null until 'listening' fires).
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const conn = new HermesGatewayConnector(cfg(`http://127.0.0.1:${port}`, { timeout_ms: 300 }));
  const res = await conn.fetchTranscript('sess-85', 0, 50);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 503);
  assert.equal(res.reason, 'gateway_unreachable');
});

test('offset/limit are clamped BEFORE the request is made', async () => {
  assert.deepEqual(clampTranscriptPage(undefined, undefined), { offset: 0, limit: 50 });
  assert.deepEqual(clampTranscriptPage('-5', '10000'), { offset: 0, limit: TRANSCRIPT_PAGE_MAX }, 'negatives/absurd limits fall to bounds');
  assert.deepEqual(clampTranscriptPage('abc', '0'), { offset: 0, limit: 50 }, 'garbage params fail-quiet');
  assert.deepEqual(clampTranscriptPage('999999999', '1'), { offset: 100_000, limit: 1 }, 'offset clamped');

  const gw = await startFakeGateway({ pages: { default: { rows: MSG_ROWS } } });
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const res = await conn.fetchTranscript('sess-85', '1000000', '5000');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.limit, TRANSCRIPT_PAGE_MAX, 'the sent limit is the client cap, not the gateway 500');
  assert.equal(res.offset, 100_000);
  assert.match(gw.requests[0]!.query, /offset=100000/, 'the gateway only ever sees the clamped page');
  assert.match(gw.requests[0]!.query, /limit=200/, 'the gateway only ever sees the clamped page');
});

test('has_more heuristic: a full page promises the next page, a short one ends', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: i, role: 'user', content: `m${i}` }));
  const gw = await startFakeGateway({ pages: { default: { rows } } });
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const p1 = await conn.fetchTranscript('sess-85', 0, 50);
  assert.equal(p1.ok, true);
  if (!p1.ok) return;
  assert.equal(p1.has_more, true, '50 of 120 ⇒ more pages exist');
  assert.equal(p1.next_offset, 50);
  const p3 = await conn.fetchTranscript('sess-85', 100, 50);
  assert.equal(p3.ok, true);
  if (!p3.ok) return;
  assert.equal(p3.returned, 20);
  assert.equal(p3.next_offset, 120);
  assert.equal(p3.has_more, false, 'a short page ends the walk');
});

test('sanitizer unit: drop-don\'t-crash per member', () => {
  assert.equal(sanitizeTranscriptMessage(null), undefined);
  assert.equal(sanitizeTranscriptMessage('nope'), undefined);
  assert.equal(sanitizeTranscriptMessage({ role: '', content: 'x' }), undefined, 'no role ⇒ the row is dropped');
  const m = sanitizeTranscriptMessage({ role: 'tool', tool_name: ' execute ', token_count: -3, finish_reason: 5, timestamp: 'junk' });
  assert.deepEqual(m, { role: 'tool', tool_name: 'execute' }, 'bad members dropped, good members kept');
});

test('malformed gateway body: ambiguous, walks on, never crashes', async () => {
  const gw = await startFakeGateway({ malformed: true });
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const res = await conn.fetchTranscript('sess-85', 0, 50);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 503, 'an ambiguous walk is NOT a false 404 — the gateway never said "no such session"');
  assert.equal(res.reason, 'gateway_ambiguous');
  assert.equal(gw.requests.length, 2);
});

test('every keyed profile 401s: the named 503 gateway_ambiguous, never a false 404', async () => {
  const gw = await startFakeGateway({
    expectKeys: { default: 'other-key', 'web-dev': 'other-key' },
    pages: { default: { rows: MSG_ROWS } },
  });
  const conn = new HermesGatewayConnector(cfg(gw.base)); // our keys are the WRONG ones
  const res = await conn.fetchTranscript('sess-85', 0, 50);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 503);
  assert.equal(res.reason, 'gateway_ambiguous', '401s are not definitive misses — honest refusal, not session_not_found');
  assert.equal(gw.requests.length, 2, 'both keyed profiles probed, in order');
});

test('next_offset walks on RAW rows: sanitizer drops never re-show or overlap', async () => {
  // raw page: [valid, roleless (dropped), valid]; limit 2 pages the RAW rows.
  const rows = [
    { id: 1, role: 'user', content: 'first' },
    { id: 2, role: null, content: 'orphan — dropped' },
    { id: 3, role: 'assistant', content: 'second' },
  ];
  const gw = await startFakeGateway({ pages: { default: { rows } } });
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const p1 = await conn.fetchTranscript('sess-85', 0, 2);
  assert.equal(p1.ok, true);
  if (!p1.ok) return;
  assert.equal(p1.returned, 1, 'one row sanitized out of the two raw rows');
  assert.equal(p1.next_offset, 2, 'the walk advances by RAW rows, not sanitized count');
  assert.equal(p1.has_more, true, 'a full RAW page promises the next page even with a drop');
  const p2 = await conn.fetchTranscript('sess-85', p1.next_offset, 2);
  assert.equal(p2.ok, true);
  if (!p2.ok) return;
  assert.deepEqual(
    p2.messages.map((m) => m.content),
    ['second'],
    'the dropped row is not re-fetched, and no message shows twice',
  );
  assert.equal(p2.has_more, false);
});

test('transcriptPath mirrors the #83 probe path shape', () => {
  assert.equal(transcriptPath('default', 'abc-123'), '/api/sessions/abc-123/messages');
  assert.equal(transcriptPath('web-dev', 'abc/123'), '/p/web-dev/api/sessions/abc%2F123/messages');
});

// ---------------------------------------------------------------------------
// 2. The loopback ROUTE through the real proxy
// ---------------------------------------------------------------------------

async function startRouteProxy(opts: { token: string; connector: HermesGatewayConnector | null }): Promise<{ base: string; stop: () => Promise<void> }> {
  const proxy = startLlmProxy({
    port: 0,
    target: 'http://127.0.0.1:9',
    hermesTranscript: { token: opts.token, connector: () => opts.connector },
  });
  await waitProxyReady(proxy.server);
  return { base: proxy.base_url, stop: () => proxy.stop() };
}

test('route: token-guarded GET answers the bounded page; missing token 401s; cross-origin 403s', async () => {
  const gw = await startFakeGateway({ pages: { default: { rows: MSG_ROWS } } });
  const conn = new HermesGatewayConnector(cfg(gw.base));
  const { base, stop } = await startRouteProxy({ token: 'tok85', connector: conn });
  try {
    const ok = await fetch(`${base}/client/hermes-transcript/sess-85?offset=0&limit=10`, {
      headers: { 'x-idlefill-edit': 'tok85' },
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { ok: boolean; messages: unknown[]; returned: number };
    assert.equal(body.ok, true);
    assert.equal(body.returned, 3, 'the page is sanitized on the way out');

    const noAuth = await fetch(`${base}/client/hermes-transcript/sess-85`);
    assert.equal(noAuth.status, 401);
    const badAuth = await fetch(`${base}/client/hermes-transcript/sess-85`, { headers: { 'x-idlefill-edit': 'wrong' } });
    assert.equal(badAuth.status, 401);

    const cross = await fetch(`${base}/client/hermes-transcript/sess-85`, {
      headers: { 'x-idlefill-edit': 'tok85', origin: 'https://evil.example.com' },
    });
    assert.equal(cross.status, 403);

    const badMethod = await fetch(`${base}/client/hermes-transcript/sess-85`, { method: 'POST', headers: { 'x-idlefill-edit': 'tok85' } });
    assert.equal(badMethod.status, 405);
  } finally {
    await stop();
  }
});

test('route: absent connector answers the NAMED 503 (zero gateway requests)', async () => {
  const { base, stop } = await startRouteProxy({ token: 'tok85', connector: null });
  try {
    const res = await fetch(`${base}/client/hermes-transcript/sess-85`, { headers: { 'x-idlefill-edit': 'tok85' } });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'connector_disabled');
  } finally {
    await stop();
  }
});

test('route: with no hermesTranscript opts the path falls through untouched (byte-for-byte prior posture)', async () => {
  const proxy = startLlmProxy({ port: 0, target: 'http://127.0.0.1:9' });
  await waitProxyReady(proxy.server);
  try {
    const res = await fetch(`${proxy.base_url}/client/hermes-transcript/sess-85`);
    // Plain passthrough: the LLM target is down ⇒ the proxy's 502, NOT the
    // transcript surface. The route simply does not exist.
    assert.equal(res.status, 502);
    assert.equal(proxy.log.length, 1, 'the path was treated as passthrough traffic');
  } finally {
    await proxy.stop();
  }
});

// ---------------------------------------------------------------------------
// 3. NEVER-ON-WIRE proof (daemon level): the transcript NEVER rides a
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

const MARKER = 'TOP-SECRET-CONVERSATION-85';

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

test('the transcript NEVER rides any heartbeat or arbiter wire payload', async () => {
  const gw = await startFakeGateway({
    expectKeys: { default: 'key85' },
    pages: {
      default: {
        rows: [
          { id: 1, role: 'user', content: MARKER + ' — this content must NEVER reach the arbiter', timestamp: 1760000000 },
          { id: 2, role: 'assistant', content: 'fine', tool_calls: [{ function: { name: 'web_search', arguments: MARKER } }], token_count: 9, timestamp: 1760000001 },
        ],
      },
    },
  });

  const savedEnv = {
    IDLEFILL_HERMES_GATEWAY: process.env.IDLEFILL_HERMES_GATEWAY,
    IDLEFILL_HERMES_GATEWAY_URL: process.env.IDLEFILL_HERMES_GATEWAY_URL,
    IDLEFILL_HERMES_GATEWAY_KEY: process.env.IDLEFILL_HERMES_GATEWAY_KEY,
  };
  process.env.IDLEFILL_HERMES_GATEWAY = '1';
  process.env.IDLEFILL_HERMES_GATEWAY_URL = gw.base;
  process.env.IDLEFILL_HERMES_GATEWAY_KEY = 'key85';

  const arb: FakeArbiter = await startFakeArbiter();
  const up = await startHeldUpstream();
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-85-'));
  const cfg85: ClientConfig = {
    server_url: arb.url,
    token: 't85',
    client_name: '85-test-client',
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
    const resP = fetch(`${daemon.proxyUrl}/s/tok85a/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hermes-session-id': 'sess-85' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await waitFor(() => arb.sessionRegisters.length > 0, 4000, 'the session register heartbeat');
    up.release();
    await resP;
    await waitFor(() => arb.registers.length > 0, 4000, 'the client register heartbeat');

    // Open the transcript (the viewer's on-demand fetch).
    const tr = await fetch(`${daemon.proxyUrl}/client/hermes-transcript/sess-85?offset=0&limit=50`, {
      headers: { 'x-idlefill-edit': 't85' },
    });
    assert.equal(tr.status, 200, 'the loopback route answers the viewer');
    const page = (await tr.json()) as { ok: boolean; messages: { content?: string }[] };
    assert.equal(page.ok, true);
    assert.ok(page.messages.some((m) => m.content?.includes(MARKER)), 'the transcript really contains the marker (the proof means something)');

    // Nothing on any publish carries it: every register body, every session
    // register body, and the arbiter's state view.
    const scan = (obj: unknown): boolean => JSON.stringify(obj).includes(MARKER);
    for (const body of arb.registers) assert.ok(!scan(body), 'the client register heartbeat never carries transcript bytes');
    for (const body of arb.sessionRegisters) assert.ok(!scan(body), 'the session register heartbeat never carries transcript bytes');
    for (const body of arb.usageReports) assert.ok(!scan(body), 'usage reports never carry transcript bytes');
    const state = await fetch(`${arb.url}/api/state`).then((r) => r.json());
    assert.ok(!scan(state), 'the arbiter /api/state never carries transcript bytes');
    assert.equal(daemon.hermesConnector?.ledgerSize, 0, 'the transcript never entered the enrichment ledger either');
    // The transcript is on-demand only: the gateway saw exactly the viewer's
    // page requests — the poll rounds never touch /messages.
    const messageHits = gw.requests.filter((r) => r.path.endsWith('/messages'));
    assert.equal(messageHits.length, 1, 'zero bulk polling: only the viewer opened the messages route');
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
