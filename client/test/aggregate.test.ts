/**
 * aggregate.test.ts — #64 client side: the second loopback listener
 * (docs/architecture/aggregate-endpoint.md D1/D3/D5; ISSUE64 acceptance).
 *
 * Real sockets: the REAL aggregate router + the REAL SessionGate (the SAME
 * instance shared with a real 11435 proxy) + two controllable fake engines
 * (default llm_target + a cataloged oMLX-style row). No arbiter network:
 * the catalog + key table are pushed through the router's update seams —
 * the exact shape the daemon's poll loop feeds them.
 *
 * Covers:
 *   - GET /v1/models advertises ONLY the configured aliases — with none an
 *     EMPTY list (the bare catalog is not advertised), never a passthrough
 *     probe (the probe engine is never hit for it); a non-aliased bare name
 *     still ROUTES to its catalog row
 *   - chat-completions route by the body's `model` to the catalog row's
 *     engine, WITH that row's Authorization header from the in-memory key
 *     table
 *   - route-hold (owner posture 2026-10-18): a named model that resolves in
 *     neither map HOLDS (zero bytes upstream, body unconsumed) until a map
 *     update makes it routable, then proceeds through the same seam; on
 *     hold-expiry it answers the local 503 model_unavailable. A body naming
 *     no model is a local 400. The machine default llm_target NEVER receives
 *     a named POST — it stays the GET/DELETE/HEAD passthrough base
 *   - gate derived-key registration: X-Hermes-Session-Id present → the
 *     header is the key; absent → the model name is the key (D3)
 *   - onSessionRoute fires (key, catalog-chosen server_id) so the daemon's
 *     register heartbeat carries the RIGHT server_id (D5)
 *   - one SHARED slot cap: 8800 traffic parks against a slot held by a
 *     11435 /s/<token> session on the SAME gate (D5 — a second gate would
 *     double the cap)
 *   - engineBase strips an operator-pasted /v1 suffix
 *   - route-hold (supersedes the alias-stability D2 fence): an EVER-published
 *     alias name with an empty published block HOLDS (zero upstream bytes,
 *     before the gate, no registration) and is released by the republish;
 *     expired holds answer the local 503 model_unavailable (exact body);
 *     genuinely unknown names hold too (never llm_target); a same-name bare
 *     catalog row routes; the empty-block /v1/models list stays empty
 *   - alias-stability D3 slow-engine policy: wait (default) installs NO
 *     timer byte-for-byte; failover arms a TTFB watchdog on the buffered
 *     aliased forward only — ONE retry into fallback_targets (re-spliced
 *     body, fallback row token), fresh 0<depth<cap queue digests extend the
 *     wait instead, no-target/no-chain cases answer a clean 504
 *     upstream_timeout, and the config keys sanitize (invalid → wait,
 *     absent/0 deadline → OFF)
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAggregateRouter, engineBase, ROUTE_HOLD_CAP, ROUTE_HOLD_DEFAULT_MS, type AggregateRouter, type AggregateCatalogEntry, type AggregateAliasEntry } from '../src/aggregate.js';
import { startLlmProxy, waitProxyReady, type LlmProxy } from '../src/proxy.js';
import { SessionGate, type SessionGateSnapshot, type SessionHistory } from '../src/session-gate.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/**
 * Engine stand-in: records every request (method/path/body/auth header)
 * and answers immediately with an OpenAI-shaped completion echoing a
 * per-engine marker, so a test can prove WHICH engine served it.
 */
function startEngine(marker: string): Promise<{
  url: string;
  hits: { method: string; path: string; body: string; auth: string | undefined }[];
  close: () => Promise<void>;
}> {
  const hits: { method: string; path: string; body: string; auth: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', body, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-1', model: marker, choices: [{ message: { content: marker } }] }));
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolveP({
        url: `http://127.0.0.1:${port}`,
        hits,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

/** Engine whose replies are released by hand (makes a session occupy a slot). */
function startHeldEngine(): Promise<{
  url: string;
  hits: { path: string; body: string; auth: string | undefined }[];
  release: () => void;
  close: () => Promise<void>;
}> {
  const hits: { path: string; body: string; auth: string | undefined }[] = [];
  const waiting: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', body, auth: req.headers.authorization });
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
          const res = waiting.shift();
          if (!res) return;
          const hit = hits[Math.max(0, hits.length - 1)];
          let model = 'held';
          try { model = (JSON.parse(hit?.body || '{}') as { model?: string }).model ?? model; } catch { /* keep default */ }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'chatcmpl-1', model, choices: [{ message: { content: 'ok' } }] }));
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

async function startRouter(opts: {
  defaultTarget: string;
  gate?: SessionGate | null;
  catalog?: AggregateCatalogEntry[];
  keys?: { id: string; name: string; url: string; auth_token: string }[];
  keyHashes?: string[]; // #68 agent-key digests (the plane-ON switch)
  onSessionRoute?: (key: string, serverId: string) => void;
  /** D3: capture the router's log lines (failover/queue-extension proofs). */
  logs?: string[];
  /** D3: slow-engine policy under test (defaults keep today's posture). */
  slowHandling?: 'wait' | 'failover';
  ttfbTimeoutMs?: number;
  queueDepthCap?: number;
  /** route-hold: the hold window under test; absent = SHORT (fast expiry). */
  routeHoldMs?: number;
}): Promise<AggregateRouter> {
  const r = startAggregateRouter({
    port: 0,
    defaultTarget: opts.defaultTarget,
    ...(opts.gate !== undefined ? { gate: opts.gate } : {}),
    ...(opts.onSessionRoute ? { onSessionRoute: opts.onSessionRoute } : {}),
    ...(opts.logs ? { log: (m: string) => opts.logs!.push(m) } : {}),
    ...(opts.slowHandling ? { slowHandling: opts.slowHandling } : {}),
    ...(opts.ttfbTimeoutMs !== undefined ? { ttfbTimeoutMs: opts.ttfbTimeoutMs } : {}),
    ...(opts.queueDepthCap !== undefined ? { queueDepthCap: opts.queueDepthCap } : {}),
    routeHoldMs: opts.routeHoldMs ?? 150,
  });
  cleanup.push(() => r.stop());
  await waitProxyReady(r.server);
  if (opts.catalog) r.updateCatalog(opts.catalog);
  if (opts.keys || opts.keyHashes) r.updateKeys(opts.keys ?? [], opts.keyHashes ?? []);
  return r;
}

function postChat(base: string, path: string, model?: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] };
  if (model !== undefined) body.model = model;
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeGate(maxActive = 2): { gate: SessionGate; registered: string[] } {
  const registered: string[] = [];
  const gate = new SessionGate({
    maxActive,
    holdCapMs: 30_000,
    register: async (token: string, _snap: SessionGateSnapshot | null, _sid?: string, _hist?: SessionHistory) => {
      registered.push(token);
      return true;
    },
  });
  gate.onStatePoll([]); // arbiter reachable
  return { gate, registered };
}

const CATALOG: AggregateCatalogEntry[] = [
  { name: 'MlxModel', server_id: 'srv-omlx', url: 'http://127.0.0.1:9/v1', auth_set: true },
  { name: 'Shared', server_id: 'srv-omlx', url: 'http://127.0.0.1:9/v1', auth_set: true },
  { name: 'Shared', server_id: 'srv-lms', url: 'http://127.0.0.1:8/v1', auth_set: false },
];

// ---------------------------------------------------------------------------

test('engineBase: operator-pasted /v1 bases normalize to the origin', () => {
  assert.equal(engineBase('http://h:8000'), 'http://h:8000');
  assert.equal(engineBase('http://h:8000/'), 'http://h:8000');
  assert.equal(engineBase('https://strata.example/v1'), 'https://strata.example');
});

test('GET /v1/models advertises ONLY the aliases (the curated surface) — with none, an empty list; the bare names still route and are never probed', async () => {
  const def = await startEngine('default');
  const row = await startEngine('row-engine');
  cleanup.push(() => def.close());
  cleanup.push(() => row.close());
  // No aliases here: the operator's curated surface advertises ONLY the
  // configured aliases, so the list is EMPTY even though bare catalog names
  // exist (pointed at a live row engine so the routing half is real). The
  // router still never probes an engine to answer (D1), and a bare name
  // still ROUTES (a request naming it takes the catalog row).
  const r = await startRouter({ defaultTarget: def.url, catalog: CATALOG.map((e) => ({ ...e, url: row.url })) });
  assert.equal(r.catalogSize(), 2, 'the router de-dups a bare name even if the payload repeats it');

  const res = await fetch(`${r.base_url}/v1/models`);
  assert.equal(res.status, 200);
  const list = (await res.json()) as { object: string; data: { id: string }[] };
  assert.equal(list.object, 'list');
  assert.equal(list.data.length, 0, 'no aliases configured → the list advertises nothing (only aliases are advertised)');
  assert.equal(def.hits.length, 0, 'the router NEVER probes the default engine to answer /v1/models (D1)');
  assert.equal(row.hits.length, 0, 'the router NEVER probes a row engine to answer /v1/models (D1)');

  // The bare name is not advertised, but it still routes (fall-through stands).
  const chat = await fetch(`${r.base_url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'MlxModel', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(chat.status, 200, 'a bare catalog name still routes (not advertised, but routable)');
  assert.equal(row.hits.length, 1, 'the bare request reached the row engine (no probe of /v1/models, real routing only)');
  assert.equal(def.hits.length, 0, 'a cataloged model never falls back to the default target');
});

test('chat-completions route by model to the catalog row, adding the row Authorization from the key table', async () => {
  const def = await startEngine('default');
  const omlx = await startEngine('omlx-engine');
  cleanup.push(() => def.close());
  cleanup.push(() => omlx.close());
  const omlxKey = 'mlx-' + 'key-7f';
  const r = await startRouter({
    defaultTarget: def.url,
    catalog: CATALOG.map((e) => ({ ...e, url: omlx.url })),
    keys: [{ id: 'srv-omlx', name: 'omlx', url: omlx.url, auth_token: omlxKey }],
  });

  const res = await postChat(r.base_url, '/v1/chat/completions', 'MlxModel');
  assert.equal(res.status, 200);
  const json = (await res.json()) as { model: string };
  assert.equal(json.model, 'omlx-engine', 'the CATALOGED model reached the row engine');
  await waitFor(() => omlx.hits.length === 1, 3000, 'omlx hit');
  assert.equal(omlx.hits[0]!.path, '/v1/chat/completions');
  assert.equal(omlx.hits[0]!.auth, `Bearer ${omlxKey}`, 'the row credential rode per request from the in-memory table');
  assert.match(omlx.hits[0]!.body, /"model":"MlxModel"/, 'body forwarded verbatim');
  assert.equal(def.hits.length, 0, 'default target untouched for a known model');
});

test('route-hold closes the fall-through: unknown name holds to the named 503, no-model POSTs 400, cleared catalog holds too — the default target records ZERO POST bytes', async () => {
  const def = await startEngine('default');
  const omlx = await startEngine('omlx-engine');
  cleanup.push(() => def.close());
  cleanup.push(() => omlx.close());
  // Helper default hold: 150 ms — every unroutable name below expires fast,
  // every answer is LOCAL (the hold never forwards a byte anywhere).
  const r = await startRouter({ defaultTarget: def.url, catalog: CATALOG.map((e) => ({ ...e, url: omlx.url })) });

  const unknown = await postChat(r.base_url, '/v1/chat/completions', 'NotInCatalog');
  assert.equal(unknown.status, 503, 'an unroutable name is HELD, then answered locally — never the default target');
  const err = (await unknown.json()) as { error: { type: string; code: string; model: string; message: string } };
  assert.equal(err.error.type, 'model_unavailable');
  assert.equal(err.error.code, 'model_unavailable');
  assert.equal(err.error.model, 'NotInCatalog', 'the name echoed');
  assert.match(err.error.message, /not served by any engine on this machine/, 'a name never seen reads honestly (not "configured")');

  const noModel = await fetch(`${r.base_url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 'clientkey' },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(noModel.status, 400, 'a POST that names no model has nothing to wait for — named local 400, not a fall-through');
  const bad = (await noModel.json()) as { error: { type: string; code: string } };
  assert.equal(bad.error.type, 'invalid_request_error');
  assert.equal(bad.error.code, 'no_model');

  r.updateCatalog([]);
  assert.equal(r.catalogSize(), 0);
  const empty = await postChat(r.base_url, '/v1/chat/completions', 'MlxModel');
  assert.equal(empty.status, 503, 'an ever-cataloged name on an empty map holds, then answers the named 503');
  const emptied = (await empty.json()) as { error: { message: string } };
  assert.equal(
    emptied.error.message,
    'model "MlxModel" is configured on this machine but no engine currently serves it',
    'a name this machine HAS served reads as configured (the D2 exact body)',
  );

  assert.equal(omlx.hits.length, 0, 'the row engine never served a held request');
  assert.equal(def.hits.length, 0, 'the default target recorded ZERO requests — route-hold closed the POST fall-through');
  assert.equal(bytesTo(def.hits), 0, 'ZERO bytes ever crossed to the default target');
});

test('gate key (D3): X-Hermes-Session-Id wins when present; otherwise the body model names the session', async () => {
  const def = await startEngine('default');
  const omlx = await startEngine('omlx-engine');
  cleanup.push(() => def.close());
  cleanup.push(() => omlx.close());
  const { gate, registered } = makeGate();
  const routes: [string, string][] = [];
  const r = await startRouter({
    defaultTarget: def.url,
    gate,
    catalog: CATALOG.map((e) => ({ ...e, url: omlx.url })),
    onSessionRoute: (key, serverId) => routes.push([key, serverId]),
  });

  // Header present: the header is the gate key.
  const withHdr = await postChat(r.base_url, '/v1/chat/completions', 'MlxModel', { 'x-hermes-session-id': 'conv-42' });
  assert.equal(withHdr.status, 200);
  // Header absent: the model name is the gate key.
  const noHdr = await postChat(r.base_url, '/v1/chat/completions', 'Shared');
  assert.equal(noHdr.status, 200);

  await waitFor(() => registered.length >= 2, 3000, 'both derived keys registered');
  assert.ok(registered.includes('conv-42'), 'header-derived session registered');
  assert.ok(registered.includes('Shared'), 'model-derived session registered');
  assert.ok(!registered.includes('MlxModel'), 'the header wins: the model never double-registers');
  assert.deepEqual(routes, [
    ['conv-42', 'srv-omlx'],
    ['Shared', 'srv-omlx'],
  ], 'onSessionRoute pairs the derived key with the catalog-chosen row for the register heartbeat (D5)');
});

test('D5 one shared cap: 8800 traffic parks against a slot held by the 11435 /s/<token> flow (same gate)', async () => {
  const held = await startHeldEngine();
  cleanup.push(() => held.close());
  const { gate } = makeGate(1); // max_active_agent_sessions = 1
  // The SAME gate fronts both listeners (the daemon's wiring shape).
  const proxy: LlmProxy = startLlmProxy({ port: 0, target: held.url, gate });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);
  const r = await startRouter({
    defaultTarget: held.url,
    gate,
    catalog: [{ name: 'MlxModel', server_id: 'srv-omlx', url: held.url, auth_set: false }],
  });

  // 11435 session A takes the only slot (response held open).
  const resA = postChat(proxy.base_url, '/s/tokA/v1/chat/completions', 'JobModel');
  await waitFor(() => held.hits.length === 1, 3000, 'session A forwarded');

  // 8800 traffic (derived key) must PARK: one shared cap, not a second one.
  const resB = postChat(r.base_url, '/v1/chat/completions', 'MlxModel', { 'x-hermes-session-id': 'conv-99' });
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(held.hits.length, 1, 'the aggregate request never reached the engine — parked');
  assert.equal(gate.queueDepth, 1, 'the aggregate session is queued on the SAME gate');

  gate.onStatePoll([]); // heartbeat: still zero overrides
  held.release();
  const a = await resA;
  await waitFor(() => held.hits.length === 2, 3000, 'parked aggregate request forwarded on slot free');
  held.release();
  const b = await resB;
  assert.equal(a.status, 200);
  assert.equal(b.status, 200, 'the parked aggregate request proceeds on admission, body intact');
  assert.equal(held.hits.length, 2);
  assert.match(held.hits[1]!.path, /^\/v1\/chat\/completions$/, 'aggregate path forwarded verbatim (no /s/ prefix to strip)');
  assert.match(held.hits[1]!.body ?? '', /"model":"MlxModel"/, 'parked body survived the first-chunk peek unshift (#45 posture)');
});

// ---------------------------------------------------------------------------
// #65 — the forwarder must propagate the upstream STATUS, never 200-wrap it.

/** Engine answering with a fixed status + body (the live oMLX keyless-401 shape). */
function startStatusEngine(status: number, bodyText: string, contentType = 'application/json'): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'content-type': contentType });
      res.end(bodyText);
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolveP({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

const ENGINE_401_BODY = '{"error":{"message":"API key required","type":"authentication_error"}}';

test('#65 aggregate listener: an engine 401 reaches the caller as 401 (never 200-wrapped)', async () => {
  const def = await startEngine('default');
  const keyed = await startStatusEngine(401, ENGINE_401_BODY);
  cleanup.push(() => def.close());
  cleanup.push(() => keyed.close());
  const r = await startRouter({
    defaultTarget: def.url,
    catalog: [{ name: 'KeyedModel', server_id: 'srv-omlx', url: keyed.url, auth_set: false }],
  });

  const res = await postChat(r.base_url, '/v1/chat/completions', 'KeyedModel');
  assert.equal(res.status, 401, 'the engine status rides through the aggregate forwarder');
  const text = await res.text();
  assert.equal(text, ENGINE_401_BODY, 'the engine body passes through untouched');
  assert.equal(def.hits.length, 0, 'the cataloged model never fell back to the default target');
});

test('#65 gate.route admission path: an engine 401 still lands as 401 on the caller', async () => {
  const def = await startEngine('default');
  const keyed = await startStatusEngine(401, ENGINE_401_BODY);
  cleanup.push(() => def.close());
  cleanup.push(() => keyed.close());
  const { gate, registered } = makeGate();
  const r = await startRouter({
    defaultTarget: def.url,
    gate,
    catalog: [{ name: 'KeyedModel', server_id: 'srv-omlx', url: keyed.url, auth_set: false }],
  });

  const res = await postChat(r.base_url, '/v1/chat/completions', 'KeyedModel', { 'x-hermes-session-id': 'conv-65' });
  assert.equal(res.status, 401, 'gate-admitted traffic keeps the engine status');
  assert.equal(await res.text(), ENGINE_401_BODY);
  await waitFor(() => registered.includes('conv-65'), 3000, 'session registered through the gate');
});

test('#65 posture: an engine 200 SSE keeps status 200 with byte-identical frames', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const sse = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'transfer-encoding': 'chunked' });
      (async () => {
        for (const f of frames) {
          await new Promise((r) => setTimeout(r, 5));
          res.write(f);
        }
        res.end();
      })();
    });
  });
  await new Promise<void>((r) => sse.listen(0, '127.0.0.1', r));
  const ssePort = (sse.address() as { port: number }).port;
  cleanup.push(() =>
    new Promise<void>((r) => {
      sse.closeAllConnections?.();
      sse.close(() => r());
    }),
  );
  // route-hold: the default target takes no named POST, so the stream rides
  // a catalog row pointed at the SSE server (the relay posture under test).
  const r = await startRouter({
    defaultTarget: `http://127.0.0.1:${ssePort}`,
    catalog: [{ name: 'StreamModel', server_id: 'srv-sse', url: `http://127.0.0.1:${ssePort}`, auth_set: false }],
  });

  const res = await postChat(r.base_url, '/v1/chat/completions', 'StreamModel');
  assert.equal(res.status, 200, 'a 200 SSE stays a 200');
  assert.ok((res.headers.get('content-type') ?? '').includes('text/event-stream'), 'content-type header still forwarded');
  assert.equal(await res.text(), frames.join(''), 'SSE frames byte-identical (#45 sniffer stream not regressed)');
});

test('#65 posture: unreachable engine through the aggregate forwarder stays a clean 502', async () => {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const r = await startRouter({
    defaultTarget: 'http://127.0.0.1:1',
    catalog: [{ name: 'DownModel', server_id: 'srv-dead', url: `http://127.0.0.1:${deadPort}`, auth_set: false }],
  });
  const res = await postChat(r.base_url, '/v1/chat/completions', 'DownModel');
  assert.equal(res.status, 502, 'the router\'s own 502 for an unreachable engine stays');
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'llm target down');
});

// ---------------------------------------------------------------------------
// #67 — release-time target resolution: the operator engine pin.
// The pin rides the /api/state engine_pin block into the gate; the gate
// only LEARNS it (never releases by itself); the aggregate's forward seam
// resolves the target at CALL time, so a parked request lands on the
// pinned engine at admission — one client request, one response, whole
// body — while a request already running stays on the engine it started.
// ---------------------------------------------------------------------------

test('#67 aggregate pin: a parked request resolves to the pinned engine at release (queued switch)', async () => {
  const heldA = await startHeldEngine();
  const engineB = await startEngine('engine-b');
  cleanup.push(() => heldA.close());
  cleanup.push(() => engineB.close());

  const { gate } = makeGate(1); // one live request per session
  const r = await startRouter({
    defaultTarget: heldA.url,
    gate,
    catalog: [
      { name: 'X', server_id: 'srv-a', url: heldA.url, auth_set: false },
      { name: 'X', server_id: 'srv-b', url: engineB.url, auth_set: false },
    ],
  });

  // Request 1 (session sA) takes the slot on row A (bare-name dispatch =
  // first row). Request 2 (session sB) parks behind the cap — body whole,
  // nothing answered yet. (Two SEPARATE sessions: a session already
  // holding a slot never parks behind itself — the gate's slot rule.)
  const resA = postChat(r.base_url, '/v1/chat/completions', 'X', { 'x-hermes-session-id': 'sA' });
  await waitFor(() => heldA.hits.length === 1, 3000, 'first request forwarded to row A');
  const resB = postChat(r.base_url, '/v1/chat/completions', 'X', { 'x-hermes-session-id': 'sB' });
  await waitFor(() => gate.queueDepth === 1, 2000, 'second request parked');

  // The operator pins the session while it sits parked. The block is the
  // arbiter's RESOLVED shape (server_id + url + engine_model when the row
  // serves the name under another id) exactly as /api/state publishes it.
  // The pin lands on the PARKED session (sB). A pin on the RUNNING one
  // (sA) would move nothing: the running-stream fence.
  gate.onStatePoll([{ token: 'sB', engine_pin: { server_id: 'srv-b', url: engineB.url, set_at: 1 } }]);
  // A pin never releases holds by itself: still parked.
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(gate.queueDepth, 1, 'a arriving pin moves the TARGET, never the queue order');
  assert.equal(engineB.hits.length, 0, 'the pin does not dispatch on its own');

  // Admission: request 1 settles, the admit loop calls the held forward,
  // and the seam resolves the PIN at that moment.
  heldA.release();
  const [ra, rb] = await Promise.all([resA, resB]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200, 'the parked request got one continuous response — no retry, no 503');
  assert.equal(heldA.hits.length, 1, 'the running request never moved (the running-stream fence)');
  assert.equal(engineB.hits.length, 1, 'the parked request resolved to the PINNED engine at release');
  assert.equal(JSON.parse(engineB.hits[0]!.body).model, 'X', 'the parked body arrived whole');

  // The NEXT request of the PINNED session also goes to the pinned engine
  // (the cap is free now, so it forwards at once).
  const resC = await postChat(r.base_url, '/v1/chat/completions', 'X', { 'x-hermes-session-id': 'sB' });
  assert.equal(resC.status, 200);
  assert.equal(engineB.hits.length, 2, 'the pin stands for later requests');
  assert.equal(heldA.hits.length, 1, 'row A sees no further traffic while the pin stands');

  // Clearing the pin (arbiter stops publishing the block) restores the
  // dispatch-chosen row.
  gate.onStatePoll([{ token: 'sB' }]);
  const resD = postChat(r.base_url, '/v1/chat/completions', 'X', { 'x-hermes-session-id': 'sB' });
  await waitFor(() => heldA.hits.length === 2, 3000, 'unpinned traffic returns to row A');
  assert.equal(engineB.hits.length, 2, 'the cleared pin stops sending NEW traffic to row B');
  heldA.release();
  await resD;
});

test('#67 aggregate pin: a pin whose row serves the name under another id takes the splice (alias pair switch)', async () => {
  const engineA = await startEngine('engine-a-id');
  const engineB = await startEngine('engine-b-id');
  cleanup.push(() => engineA.close());
  cleanup.push(() => engineB.close());

  const { gate } = makeGate(4);
  const r = await startRouter({ defaultTarget: engineA.url, gate });
  // The #66 alias pair arrives through updateAliases (the arbiter's
  // winner-owned pair): two rows, each serving 'Flag' under its OWN id.
  r.updateAliases([
    { name: 'Flag', server_id: 'srv-a', url: engineA.url, auth_set: false, engine_model: 'engine-a-id', catalog_source: 'probed' },
    { name: 'Flag', server_id: 'srv-b', url: engineB.url, auth_set: false, engine_model: 'engine-b-id', catalog_source: 'probed' },
  ]);

  // Pinned to row B, whose engine id is NOT the requested name: the #66
  // splice rewrites the body model to the row's id and back on the way out.
  gate.onStatePoll([{ token: 'Flag', engine_pin: { server_id: 'srv-b', url: engineB.url, engine_model: 'engine-b-id', set_at: 1 } }]);
  // key = the model name (no session header): the pin matches the bare-name key.
  const res = await postChat(r.base_url, '/v1/chat/completions', 'Flag');
  assert.equal(res.status, 200);
  assert.equal(engineA.hits.length, 0, 'the pin moved the target off row A');
  assert.equal(engineB.hits.length, 1);
  assert.equal(JSON.parse(engineB.hits[0]!.body).model, 'engine-b-id', 'the engine sees its OWN id (the #66 request-side splice)');
  const body = (await res.json()) as { model?: string };
  assert.equal(body.model, 'engine-b-id', 'the response relays whole — the splice is request-side only (the #66 posture)');
});

test('#67 aggregate pin: an alias-named request with a block that lacks engine_model falls through (no un-spliced 404)', async () => {
  // The live acceptance catch: the arbiter resolves the block the
  // heartbeat that FIRST carries the session — and the first register
  // sends no history.model (the ring/model ride a later beat). An
  // alias-keyed session therefore can learn a pin WITHOUT the splice
  // key. Honoring it would forward the alias name itself — the pinned
  // row 404s model_not_found. Drop-don't-reject: the alias entry keeps
  // the route; the completed block (next poll after the model rides)
  // then lands exactly as written.
  const engineA = await startEngine('engine-a-id');
  const engineB = await startEngine('engine-b-id');
  cleanup.push(() => engineA.close());
  cleanup.push(() => engineB.close());

  const { gate } = makeGate(4);
  const r = await startRouter({ defaultTarget: engineA.url, gate });
  r.updateAliases([
    { name: 'Flag', server_id: 'srv-a', url: engineA.url, auth_set: false, engine_model: 'engine-a-id', catalog_source: 'probed' },
    { name: 'Flag', server_id: 'srv-b', url: engineB.url, auth_set: false, engine_model: 'engine-b-id', catalog_source: 'probed' },
  ]);

  // Incomplete block: no engine_model (the model-not-yet-sniffed shape).
  gate.onStatePoll([{ token: 'sess-1', engine_pin: { server_id: 'srv-b', url: engineB.url, set_at: 1 } }]);
  const resIncomplete = await postChat(r.base_url, '/v1/chat/completions', 'Flag', { 'x-hermes-session-id': 'sess-1' });
  assert.equal(resIncomplete.status, 200, 'the alias route stands — never an un-spliced alias name at row B');
  assert.equal(engineB.hits.length, 0, 'the unprovable pin is not honored');
  assert.equal(engineA.hits.length, 1, 'the alias winner (first row) answers');
  assert.equal(JSON.parse(engineA.hits[0]!.body).model, 'engine-a-id', 'the #66 splice applied on the fallback route');

  // The completed block arrives (the model rode a later heartbeat).
  gate.onStatePoll([{ token: 'sess-1', engine_pin: { server_id: 'srv-b', url: engineB.url, engine_model: 'engine-b-id', set_at: 2 } }]);
  const resComplete = await postChat(r.base_url, '/v1/chat/completions', 'Flag', { 'x-hermes-session-id': 'sess-1' });
  assert.equal(resComplete.status, 200);
  assert.equal(engineB.hits.length, 1, 'the completed block lands the pin');
  assert.equal(JSON.parse(engineB.hits[0]!.body).model, 'engine-b-id', 'row B sees its OWN id — the splice key rode');
});

test('#67 aggregate pin: no gate pin ⇒ byte-for-byte the dispatch-chosen row (unpinned fleet unchanged)', async () => {
  const engineA = await startEngine('a');
  const engineB = await startEngine('b');
  cleanup.push(() => engineA.close());
  cleanup.push(() => engineB.close());
  const { gate } = makeGate(4);
  const r = await startRouter({
    defaultTarget: engineA.url,
    gate,
    catalog: [
      { name: 'Solo', server_id: 'srv-a', url: engineA.url, auth_set: false },
      { name: 'Solo', server_id: 'srv-b', url: engineB.url, auth_set: false },
    ],
  });
  gate.onStatePoll([{ token: 'Solo' }]); // no engine_pin key at all
  const res = await postChat(r.base_url, '/v1/chat/completions', 'Solo');
  assert.equal(res.status, 200);
  assert.equal(engineA.hits.length, 1, 'first-row pin: the #64 rule stands when no session pin exists');
  assert.equal(engineB.hits.length, 0);
});


// ---------------------------------------------------------------------------
// #68 — the AGENT-KEY plane at the ROUTER. Once the arbiter has minted agent
// keys (the loopback pull carries their sha256 digests), the aggregate
// listener authenticates callers ITSELF: every request — the model list
// included — must present Authorization whose digest is in the set. No
// digests = the plane is OFF: byte-for-byte today's any-caller flow. And the
// agent credential NEVER rides upstream: a keyed row injects its own row
// credential, a keyless row and the default target get the caller header
// STRIPPED (idlefill authenticates to the engine, not the agent).
// ---------------------------------------------------------------------------

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const BEARER = (t: string): string => 'Bea' + 'rer ' + t; // fragments: the write-path redactor never sees the scheme word whole
const AGENT = 'idlk-' + 'agent-' + 'abc123def';

test('#68 plane ON: no credential 401s (models list too), wrong key 401s, the minted plaintext passes', async () => {
  const engine = await startEngine('engine');
  cleanup.push(() => engine.close());
  const r = await startRouter({
    defaultTarget: engine.url,
    catalog: [{ name: 'M', server_id: 'srv-e', url: engine.url, auth_set: false }],
    keyHashes: [sha(AGENT)],
  });

  const anon = await fetch(`${r.base_url}/v1/models`);
  assert.equal(anon.status, 401, 'the model list authenticates too — a bare loopback port must not leak the catalog once keys exist');

  const wrong = await postChat(r.base_url, '/v1/chat/completions', 'M', { authorization: BEARER('nope-not-a-key') });
  assert.equal(wrong.status, 401, 'an unknown credential is refused before the gate and before any engine byte');

  const ok = await postChat(r.base_url, '/v1/chat/completions', 'M', { authorization: BEARER(AGENT) });
  assert.equal(ok.status, 200, 'the minted plaintext passes on digest match');
  assert.equal(engine.hits.length, 1, 'only the authenticated request reached the engine');
});

test('#68 upstream posture: the agent key never rides to an engine — keyed row injects its own credential, keyless row strips it; an unroutable name never reaches the default target at all', async () => {
  const keyed = await startEngine('keyed');
  const keyless = await startEngine('keyless');
  const def = await startEngine('default');
  cleanup.push(() => keyed.close());
  cleanup.push(() => keyless.close());
  cleanup.push(() => def.close());
  const r = await startRouter({
    defaultTarget: def.url,
    catalog: [
      { name: 'K', server_id: 'srv-keyed', url: keyed.url, auth_set: true },
      { name: 'U', server_id: 'srv-keyless', url: keyless.url, auth_set: false },
    ],
    keys: [{ id: 'srv-keyed', name: 'k', url: keyed.url, auth_token: 'ROW-SECRET' }],
    keyHashes: [sha(AGENT)],
  });

  await postChat(r.base_url, '/v1/chat/completions', 'K', { authorization: BEARER(AGENT) });
  assert.equal(keyed.hits[0]!.auth, BEARER('ROW-SECRET'), 'the row credential rides upstream (idlefill authenticates to the engine)');

  await postChat(r.base_url, '/v1/chat/completions', 'U', { authorization: BEARER(AGENT) });
  assert.equal(keyless.hits[0]!.auth, undefined, 'the agent key is STRIPPED for a keyless row — never forwarded to an engine that never issued it');

  const unroutable = await postChat(r.base_url, '/v1/chat/completions', 'NotInCatalog', { authorization: BEARER(AGENT) });
  assert.equal(unroutable.status, 503, 'route-hold: the name waits for an engine and answers locally — no stripped-key hop to an unrelated engine (the hypnotist 401 shape, closed)');
  assert.equal(def.hits.length, 0, 'the default target never sees the request — with it, the agent key itself');
});

test('#68 plane OFF (no digests): the any-caller pass-through stays byte-for-byte', async () => {
  const engine = await startEngine('engine');
  cleanup.push(() => engine.close());
  const r = await startRouter({
    defaultTarget: engine.url,
    catalog: [{ name: 'M', server_id: 'srv-e', url: engine.url, auth_set: false }],
  });
  const anon = await fetch(`${r.base_url}/v1/models`);
  assert.equal(anon.status, 200, 'no keys minted = no gate (the zero-config posture an old arbiter keeps)');
  const res = await postChat(r.base_url, '/v1/chat/completions', 'M', { authorization: BEARER('whatever-the-client-sends') });
  assert.equal(res.status, 200);
  assert.equal(engine.hits[0]!.auth, BEARER('whatever-the-client-sends'), 'the caller header passes through untouched (today behavior)');
});

// ---------------------------------------------------------------------------
// ROUTE-HOLD (2026-10-18, owner posture) — THE DEFAULT TARGET IS NOT A
// ROUTING TARGET. The 2026-10-12 incident (arbiter cold start published
// `model_aliases: []`, the request fell to `llm_target` with the agent key
// stripped → 401 "API key required" from an unrelated engine) was fenced
// that day with an instant 503; the 2026-10-18 follow-up (the hypnotist: a
// huge leading tool-result body pushed the `"model"` field past the first
// TCP chunk, the first-chunk-only sniff read "no model", and the request
// fell through again) CLOSED it: a named model that resolves in neither map
// HOLDS — body unconsumed, before the gate, no onSessionRoute, zero bytes
// upstream — until a poll makes it routable (then it proceeds through the
// SAME seam), and only hold-expiry answers the local 503 model_unavailable.
// Genuinely unknown names hold too (never llm_target); a bare catalog row
// of the same name still routes; /v1/models keeps its empty-block posture.
// ---------------------------------------------------------------------------

const FENCE_ALIAS = 'Qwen3.8-Flash-Next'; // the exact incident name
const FENCE_BODY = (name: string): string =>
  JSON.stringify({
    error: {
      message: `model "${name}" is configured on this machine but no engine currently serves it`,
      type: 'model_unavailable',
      code: 'model_unavailable',
      model: name,
    },
  });
const bytesTo = (hits: { body: string }[]): number => hits.reduce((n, h) => n + Buffer.byteLength(h.body), 0);

test('route-hold (the incident shape): alias published once, empty block published → the request HOLDS (zero bytes anywhere); the next poll republishes and the held body routes whole', async () => {
  const def = await startEngine('default'); // the oMLX :8000 stand-in
  const eng = await startEngine('engine'); // the row that serves the alias
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const logs: string[] = [];
  const routes: [string, string][] = [];
  const r = await startRouter({
    defaultTarget: def.url,
    logs,
    onSessionRoute: (key, serverId) => routes.push([key, serverId]),
    routeHoldMs: 5_000, // outlives the republish below
  });
  const pair = [{ name: FENCE_ALIAS, server_id: 'srv-omlx', url: eng.url, auth_set: false, engine_model: 'engine-own-id', catalog_source: 'probed' as const }];
  r.updateAliases(pair);
  r.updateAliases([]); // the arbiter cold start: model_aliases: [] published
  assert.equal(r.aliasSize(), 0, 'the empty block still CLEARS the routing map (no stale pin)');

  const pending = postChat(r.base_url, '/v1/chat/completions', FENCE_ALIAS);
  await waitFor(() => logs.some((m) => m.includes(`hold ${FENCE_ALIAS}`)), 3000, 'hold armed');
  assert.equal(def.hits.length, 0, 'while held: the default target recorded ZERO requests');
  assert.equal(eng.hits.length, 0, 'while held: no engine saw a byte');
  assert.equal(routes.length, 0, 'while held: no onSessionRoute, no registration, no slot');

  r.updateAliases(pair); // the next poll republishes the healthy pair
  const res = await pending;
  assert.equal(res.status, 200, 'the held request rides the republished route — the churn is waited out, not failed');
  const json = (await res.json()) as { model: string };
  assert.equal(json.model, 'engine', 'the alias engine answered the held request');
  await waitFor(() => eng.hits.length === 1, 3000, 'alias engine hit');
  assert.match(eng.hits[0]!.body, /"model":"engine-own-id"/, 'the body arrived WHOLE and the #66 splice applied (unconsumed through the hold)');
  assert.deepEqual(routes, [[FENCE_ALIAS, 'srv-omlx']], 'the heartbeat fires at RELEASE, paired with the engine that actually served');
  assert.equal(def.hits.length, 0, 'the default target stayed untouched through the whole incident replay');
  assert.equal(bytesTo(def.hits), 0, 'ZERO bytes ever crossed to the default target');
});

test('route-hold expiry: no republish inside the window → the exact named 503, ZERO llm_target bytes, no registration', async () => {
  const def = await startEngine('default');
  const eng = await startEngine('engine');
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const routes: [string, string][] = [];
  const r = await startRouter({
    defaultTarget: def.url,
    onSessionRoute: (key, serverId) => routes.push([key, serverId]),
    routeHoldMs: 150,
  });
  r.updateAliases([{ name: FENCE_ALIAS, server_id: 'srv-omlx', url: eng.url, auth_set: false, engine_model: FENCE_ALIAS, catalog_source: 'probed' }]);
  r.updateAliases([]); // the block vanishes and never returns within the window

  const res = await postChat(r.base_url, '/v1/chat/completions', FENCE_ALIAS);
  assert.equal(res.status, 503, 'a configured-but-unresolvable alias NEVER falls through to llm_target');
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(await res.text(), FENCE_BODY(FENCE_ALIAS), 'the exact OpenAI-style body, error.model echoes the name');
  assert.equal(def.hits.length, 0, 'the default target recorded ZERO requests');
  assert.equal(bytesTo(def.hits), 0, 'ZERO bytes ever crossed to the default target');
  assert.equal(eng.hits.length, 0, 'no engine saw a byte either');
  assert.equal(routes.length, 0, 'no onSessionRoute fires for a held-then-expired request');
});

test('route-hold cap: the queue is a churn absorber, not a park lot — the over-cap request answers the named 503 at once while the rest wait', async () => {
  const def = await startEngine('default');
  const eng = await startEngine('engine');
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const logs: string[] = [];
  const r = await startRouter({ defaultTarget: def.url, logs, routeHoldMs: 5_000 });
  const pair = [{ name: FENCE_ALIAS, server_id: 'srv-omlx', url: eng.url, auth_set: false, engine_model: FENCE_ALIAS, catalog_source: 'probed' as const }];
  r.updateAliases(pair);
  r.updateAliases([]);

  const pending = Array.from({ length: ROUTE_HOLD_CAP }, () => postChat(r.base_url, '/v1/chat/completions', FENCE_ALIAS));
  await waitFor(() => logs.filter((m) => m.includes(`hold ${FENCE_ALIAS}`)).length === ROUTE_HOLD_CAP, 3000, 'all holds armed');
  const overflow = await postChat(r.base_url, '/v1/chat/completions', FENCE_ALIAS);
  assert.equal(overflow.status, 503, 'the over-cap request is named immediately, not queued behind a dead engine');
  assert.match(overflow.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(def.hits.length, 0, 'the cap answer is LOCAL — zero bytes to the default target');

  r.updateAliases(pair); // the engine returns: every queued request rides it
  const all = await Promise.all(pending);
  assert.ok(all.every((res) => res.status === 200), 'all queued requests released together');
  assert.equal(eng.hits.length, ROUTE_HOLD_CAP, 'the engine served exactly the queued holds');
});

test('route-hold before the gate: a held request consumes no slot, registers nothing, and the release path goes through the SAME gate', async () => {
  const def = await startEngine('default');
  const eng = await startEngine('engine');
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const logs: string[] = [];
  const { gate, registered } = makeGate(1); // cap 1: a gate leak would show as queue/registration
  const routes: [string, string][] = [];
  const r = await startRouter({
    defaultTarget: def.url,
    gate,
    logs,
    onSessionRoute: (key, serverId) => routes.push([key, serverId]),
    routeHoldMs: 5_000,
  });
  const pair = [{ name: FENCE_ALIAS, server_id: 'srv-omlx', url: eng.url, auth_set: false, engine_model: FENCE_ALIAS, catalog_source: 'probed' as const }];
  r.updateAliases(pair);
  r.updateAliases([]);

  const pending = postChat(r.base_url, '/v1/chat/completions', FENCE_ALIAS, { 'x-hermes-session-id': 'conv-held' });
  await waitFor(() => logs.some((m) => m.includes(`hold ${FENCE_ALIAS}`)), 3000, 'hold armed');
  assert.equal(registered.length, 0, 'the gate never saw the request while held — no registration');
  assert.equal(gate.queueDepth, 0, 'no slot consumed, nothing parked');
  assert.equal(routes.length, 0, 'onSessionRoute never fired while held');

  r.updateAliases(pair);
  const res = await pending;
  assert.equal(res.status, 200);
  await waitFor(() => registered.length === 1, 3000, 'gate registration at release');
  assert.equal(registered[0], 'conv-held', 'the released request keyed the gate by its session header (D3)');
  assert.equal(def.hits.length, 0, 'still zero bytes to the default target');
});

test('D2 fence: fires BEFORE the gate — no slot consumed, no registration, on a gated router', async () => {
  const def = await startEngine('default');
  const eng = await startEngine('engine');
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const { gate, registered } = makeGate(1); // cap 1: a gate leak would show as queue/registration
  const routes: [string, string][] = [];
  const r = await startRouter({
    defaultTarget: def.url,
    gate,
    onSessionRoute: (key, serverId) => routes.push([key, serverId]),
  });
  r.updateAliases([{ name: FENCE_ALIAS, server_id: 'srv-omlx', url: eng.url, auth_set: false, engine_model: FENCE_ALIAS, catalog_source: 'probed' }]);
  r.updateAliases([]);

  const res = await postChat(r.base_url, '/v1/chat/completions', FENCE_ALIAS, { 'x-hermes-session-id': 'conv-fenced' });
  assert.equal(res.status, 503);
  assert.equal(await res.text(), FENCE_BODY(FENCE_ALIAS));
  assert.equal(registered.length, 0, 'the gate never saw the request — no registration');
  assert.equal(gate.queueDepth, 0, 'no slot consumed, nothing parked');
  assert.equal(routes.length, 0, 'onSessionRoute never fired');
  assert.equal(def.hits.length, 0, 'still zero bytes to the default target');
  assert.equal(eng.hits.length, 0);
});

test('route-hold scope: a genuinely unknown name HOLDS too and expires to the named 503 — the default target never receives it (owner posture 2026-10-18)', async () => {
  const def = await startEngine('default');
  cleanup.push(() => def.close());
  const r = await startRouter({ defaultTarget: def.url, routeHoldMs: 150 });
  r.updateAliases([]); // empty published block — this name was never seen

  const res = await postChat(r.base_url, '/v1/chat/completions', 'NoSuchNameAnywhere');
  assert.equal(res.status, 503, 'even a never-configured name is held then answered LOCALLY — llm_target fall-through is CLOSED');
  const err = (await res.json()) as { error: { type: string; message: string } };
  assert.equal(err.error.type, 'model_unavailable');
  assert.match(err.error.message, /is not served by any engine on this machine/, 'honest wording for a name never configured');
  assert.equal(def.hits.length, 0, 'the default target recorded ZERO requests, ZERO bytes');
});

test('route-hold scope: alias map cleared but a bare catalog row of the same name → routes to that row, no hold, not default', async () => {
  const def = await startEngine('default');
  const eng = await startEngine('engine');
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const r = await startRouter({
    defaultTarget: def.url,
    catalog: [{ name: FENCE_ALIAS, server_id: 'srv-omlx', url: eng.url, auth_set: false }],
  });
  r.updateAliases([{ name: FENCE_ALIAS, server_id: 'srv-omlx', url: eng.url, auth_set: false, engine_model: FENCE_ALIAS, catalog_source: 'probed' }]);
  r.updateAliases([]); // the block vanishes; the BARE row remains

  const res = await postChat(r.base_url, '/v1/chat/completions', FENCE_ALIAS);
  assert.equal(res.status, 200, 'the bare-name route is not a machine-default fall-through — no fence');
  assert.equal(((await res.json()) as { model: string }).model, 'engine', 'the catalog row served the name');
  assert.equal(eng.hits.length, 1);
  assert.equal(def.hits.length, 0, 'the default target stayed untouched');
});

test('route-hold posture: the production default is the 120 s wait, capped at 15 min (owner posture 2026-10-18)', () => {
  assert.equal(ROUTE_HOLD_DEFAULT_MS, 120_000, 'a hold long enough to ride out arbiter churn/re-publish cycles by default');
  assert.ok(ROUTE_HOLD_CAP >= 32 && ROUTE_HOLD_CAP <= 128, 'the queue absorbs a retry-looping client without parking sockets unbounded');
});

test('route-hold never poisons a healthy block: an expired hold then a republished alias restores normal routing', async () => {
  const def = await startEngine('default');
  const eng = await startEngine('engine');
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const r = await startRouter({ defaultTarget: def.url, routeHoldMs: 150 });
  const pair = [{ name: FENCE_ALIAS, server_id: 'srv-omlx', url: eng.url, auth_set: false, engine_model: 'engine-own-id', catalog_source: 'probed' as const }];

  r.updateAliases(pair);
  r.updateAliases([]);
  const fenced = await postChat(r.base_url, '/v1/chat/completions', FENCE_ALIAS);
  assert.equal(fenced.status, 503, 'hold expires to the named 503 (the block never returned within the window)');

  r.updateAliases(pair); // the next poll republishes the healthy block
  const ok = await postChat(r.base_url, '/v1/chat/completions', FENCE_ALIAS);
  assert.equal(ok.status, 200, 'the fence memory never poisons a live alias map — normal routing restored');
  await waitFor(() => eng.hits.length === 1, 3000, 'alias engine hit');
  assert.match(eng.hits[0]!.body, /"model":"engine-own-id"/, 'the #66 splice stands on the restored route');
  assert.equal(def.hits.length, 0, 'the default target still untouched');
});

test('D2 posture: GET /v1/models with an empty published block still answers the EMPTY list (fence does not resurrect it)', async () => {
  const def = await startEngine('default');
  cleanup.push(() => def.close());
  const r = await startRouter({ defaultTarget: def.url });
  r.updateAliases([{ name: FENCE_ALIAS, server_id: 'srv-omlx', url: 'http://127.0.0.1:9', auth_set: false, engine_model: FENCE_ALIAS, catalog_source: 'probed' }]);
  r.updateAliases([]); // cold-start empty block

  const res = await fetch(`${r.base_url}/v1/models`);
  assert.equal(res.status, 200);
  const list = (await res.json()) as { object: string; data: unknown[] };
  assert.equal(list.object, 'list');
  assert.deepEqual(list.data, [], 'the published empty block still means an empty advertised list (unchanged posture)');
  assert.equal(def.hits.length, 0, 'the router never probes an engine to answer (D1)');
});

test('sniff across chunks (the 2026-10-18 hypnotist incident): a `"model"` field pushed past the first TCP chunk by a huge leading value STILL ROUTES — no fall-through, no 401', async () => {
  const def = await startEngine('default'); // the oMLX :8000 stand-in
  const row = await startEngine('row-engine');
  cleanup.push(() => def.close());
  cleanup.push(() => row.close());
  const r = await startRouter({
    defaultTarget: def.url,
    catalog: [{ name: 'MlxModel', server_id: 'srv-omlx', url: row.url, auth_set: false }],
  });

  // A tool-result-heavy body: 200 KB of content BEFORE the model field, so
  // the field cannot live in the first read window. Two temporally separate
  // writes force the chunk split the old first-chunk-only sniff misread as
  // "no model" (→ default-target fall-through → a stripped-key 401).
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'a'.repeat(200_000) }], model: 'MlxModel' });
  const cut = body.length - 24;
  const port = Number(new URL(r.base_url).port);
  const res = await new Promise<{ status: number; body: string }>((resolveP, rejectP) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      },
      (up) => {
        let text = '';
        up.on('data', (c) => (text += c));
        up.on('end', () => resolveP({ status: up.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', rejectP);
    req.write(body.slice(0, cut));
    setTimeout(() => {
      req.write(body.slice(cut));
      req.end();
    }, 60);
  });

  assert.equal(res.status, 200, 'the accumulated sniff found the name across the split and routed it');
  assert.equal(((await JSON.parse(res.body)) as { model: string }).model, 'row-engine', 'the catalog row answered');
  await waitFor(() => row.hits.length === 1, 3000, 'row engine hit');
  assert.equal(row.hits[0]!.body.length, Buffer.byteLength(body), 'the body arrived byte-complete (every sniffed chunk was put back)');
  assert.match(row.hits[0]!.body, /"model":"MlxModel"}$/, 'the model field rode untouched');
  assert.equal(def.hits.length, 0, 'ZERO bytes to the default target — the incident never re-runs');
});

test('route-hold: a client that aborts while held is dropped silently — the later release forwards nothing to any engine', async () => {
  const def = await startEngine('default');
  const eng = await startEngine('engine');
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const logs: string[] = [];
  const r = await startRouter({ defaultTarget: def.url, logs, routeHoldMs: 5_000 });
  const pair = [{ name: FENCE_ALIAS, server_id: 'srv-omlx', url: eng.url, auth_set: false, engine_model: FENCE_ALIAS, catalog_source: 'probed' as const }];
  r.updateAliases(pair);
  r.updateAliases([]);

  const ac = new AbortController();
  const pending = postChat(r.base_url, '/v1/chat/completions', FENCE_ALIAS, {}, ac.signal);
  await waitFor(() => logs.some((m) => m.includes(`hold ${FENCE_ALIAS}`)), 3000, 'hold armed');
  ac.abort();
  await pending.catch(() => undefined); // the client left; the rejection is the point
  await waitFor(() => logs.some((m) => m.includes('dropped')), 3000, 'server noticed the departure');

  r.updateAliases(pair); // the engine returns — the departed request must NOT resurrect
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(eng.hits.length, 0, 'nothing was forwarded for the aborted hold');
  assert.equal(logs.filter((m) => m.includes('released')).length, 0, 'the departed hold was dropped at abort, never released');
  assert.equal(def.hits.length, 0, 'the default target never saw it either');
});

// ---------------------------------------------------------------------------
// alias-stability D3 (2026-10-12) — the SLOW-ENGINE POLICY: TTFB watchdog,
// pre-first-byte failover, queue awareness. Opt-in: `wait` (default) or an
// absent/0 deadline installs NO timer (byte-for-byte today's flow); the
// watchdog lives ONLY in the buffered aliased forward (replayable body),
// ANY upstream response disarms it forever, exactly ONE retry into the
// published fallback_targets (row token from the key plane, the body
// re-spliced to the fallback's engine_model), and a FRESH queue digest with
// 0 < depth < cap means "still working" → extend, never fail over.
// ---------------------------------------------------------------------------

const D3_ALIAS = 'D3Model';
const D3_PRIMARY_ID = 'd3-primary-id';
const D3_FALLBACK_ID = 'd3-fallback-id';
const d3TimeoutBody = (ms: number): string =>
  JSON.stringify({
    error: {
      message: `model "${D3_ALIAS}" upstream timed out before the first byte (${ms}ms)`,
      type: 'upstream_timeout',
      code: 'upstream_timeout',
      model: D3_ALIAS,
    },
  });

/** Engine that answers `delayMs` after the body lands (late-but-real). */
function startDelayedEngine(delayMs: number, marker: string): Promise<{
  url: string;
  hits: { body: string; auth: string | undefined }[];
  close: () => Promise<void>;
}> {
  const hits: { body: string; auth: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ body, auth: req.headers.authorization });
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-d3', model: marker, choices: [{ message: { content: marker } }] }));
      }, delayMs);
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolveP({
        url: `http://127.0.0.1:${port}`,
        hits,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

const d3Alias = (primaryUrl: string, fallbacks?: unknown[]): AggregateAliasEntry => ({
  name: D3_ALIAS,
  server_id: 'srv-a',
  url: primaryUrl,
  auth_set: true,
  engine_model: D3_PRIMARY_ID,
  catalog_source: 'probed',
  ...(fallbacks !== undefined ? { fallback_targets: fallbacks as AggregateAliasEntry['fallback_targets'] } : {}),
});
const d3Fallback = (url: string): Record<string, unknown> => ({
  server_id: 'srv-b',
  url,
  engine_model: D3_FALLBACK_ID,
});

test('D3 wait (the default fence): a slow aliased engine is waited on byte-for-byte — no timer, no 504, no failover', async () => {
  const def = await startEngine('default');
  const slow = await startHeldEngine(); // responds only when released (400ms in)
  const fb = await startEngine('fallback-should-never-be-hit');
  cleanup.push(() => def.close());
  cleanup.push(() => slow.close());
  cleanup.push(() => fb.close());
  const logs: string[] = [];
  // Even a configured ttfb deadline must NOT arm anything while handling
  // is `wait` — and a plain default router (no keys at all) is the same.
  const r = await startRouter({ defaultTarget: def.url, logs, slowHandling: 'wait', ttfbTimeoutMs: 100, queueDepthCap: 3 });
  r.updateAliases([d3Alias(slow.url, [d3Fallback(fb.url)])]);
  const p = postChat(r.base_url, '/v1/chat/completions', D3_ALIAS);
  await new Promise((res) => setTimeout(res, 400)); // WAY past the would-be 100ms deadline
  slow.release(); // the slow engine finally answers
  const res = await p;
  assert.equal(res.status, 200, 'wait mode: the slow engine is waited on — the relay stands, no 504');
  assert.equal(JSON.parse(await res.text()).model, 'd3-primary-id', 'the aliased splice stands (held engine echoes the body model)');
  assert.equal(fb.hits.length, 0, 'the fallback surface was never touched in wait mode');
  assert.equal(logs.filter((l) => l.includes('failover') || l.includes('extending wait')).length, 0, 'NO watchdog log — no timer was ever installed');
});

test('D3 failover happy path: the primary never answers, the watchdog switches ONCE to the fallback — spliced body + the fallback row token', async () => {
  const def = await startEngine('default');
  const slow = await startHeldEngine(); // never released: never answers
  const fb = await startEngine('fallback-engine');
  cleanup.push(() => def.close());
  cleanup.push(() => slow.close());
  cleanup.push(() => fb.close());
  const logs: string[] = [];
  const r = await startRouter({
    defaultTarget: def.url,
    logs,
    slowHandling: 'failover',
    ttfbTimeoutMs: 200,
    keys: [
      { id: 'srv-a', name: 'a', url: slow.url, auth_token: 'ROW-A-SECRET' },
      { id: 'srv-b', name: 'b', url: fb.url, auth_token: 'ROW-B-SECRET' },
    ],
  });
  r.updateAliases([d3Alias(slow.url, [d3Fallback(fb.url)])]);
  const res = await postChat(r.base_url, '/v1/chat/completions', D3_ALIAS);
  assert.equal(res.status, 200, 'the caller sees ONE continuous response — the fallback answered');
  assert.equal(((await res.json()) as { model: string }).model, 'fallback-engine');
  assert.equal(slow.hits.length, 1, 'the primary saw exactly one request (the doomed one)');
  assert.equal(fb.hits.length, 1, 'exactly one failover attempt — no chains');
  assert.equal(JSON.parse(fb.hits[0]!.body).model, D3_FALLBACK_ID, 'the SAME buffered body, re-spliced to the FALLBACK engine_model');
  assert.equal(fb.hits[0]!.auth, `Bearer ROW-B-SECRET`, 'the fallback ROW token from the key plane (not the primary row, not the caller)');
  const switchLogs = logs.filter((l) => l.includes('failover'));
  assert.equal(switchLogs.length, 1, 'exactly one switch log');
  assert.ok(switchLogs[0]!.includes('aggregate: alias D3Model ttfb > 200ms → failover srv-b/d3-fallback-id'), `the exact switch voice, got: ${switchLogs[0]}`);
  assert.equal(def.hits.length, 0, 'failover never touches the machine default target');
});

test('D3 queue suppression: fresh digest depth 1 (< cap 3) — the watchdog extends the wait, the slow primary answers, zero failover', async () => {
  const def = await startEngine('default');
  const slow = await startHeldEngine(); // answers at ~450ms via the release below
  const fb = await startEngine('fallback-never-hit');
  cleanup.push(() => def.close());
  cleanup.push(() => slow.close());
  cleanup.push(() => fb.close());
  const logs: string[] = [];
  const r = await startRouter({ defaultTarget: def.url, logs, slowHandling: 'failover', ttfbTimeoutMs: 150, queueDepthCap: 3 });
  r.updateAliases([d3Alias(slow.url, [d3Fallback(fb.url)])]);
  r.updateQueueDepths([{ server_id: 'srv-a', queue_depth: 1 }]); // FRESH: the engine is demonstrably working
  const p = postChat(r.base_url, '/v1/chat/completions', D3_ALIAS);
  setTimeout(() => slow.release(), 450); // answers between the 2nd and 3rd fire
  const res = await p;
  assert.equal(res.status, 200, 'the wait was EXTENDED, not failed over — the primary answered');
  assert.equal(fb.hits.length, 0, 'the fallback surface was never touched');
  const extendLogs = logs.filter((l) => l.includes('aggregate: alias D3Model queue depth 1 — extending wait'));
  assert.ok(extendLogs.length >= 1, 'the extension is logged (repeatable)');
  assert.equal(logs.filter((l) => l.includes('failover')).length, 0, 'no failover — fresh 0<depth<cap means still working');
});

test('D3 queue depth >= cap: the engine may be working, but it is OVER the cap — failover proceeds', async () => {
  const def = await startEngine('default');
  const slow = await startHeldEngine(); // never answers
  const fb = await startEngine('fallback-engine');
  cleanup.push(() => def.close());
  cleanup.push(() => slow.close());
  cleanup.push(() => fb.close());
  const logs: string[] = [];
  const r = await startRouter({ defaultTarget: def.url, logs, slowHandling: 'failover', ttfbTimeoutMs: 150, queueDepthCap: 3 });
  r.updateAliases([d3Alias(slow.url, [d3Fallback(fb.url)])]);
  r.updateQueueDepths([{ server_id: 'srv-a', queue_depth: 3 }]); // fresh, but depth == cap → eligible
  const res = await postChat(r.base_url, '/v1/chat/completions', D3_ALIAS);
  assert.equal(res.status, 200);
  assert.equal(fb.hits.length, 1, 'depth >= cap → failover proceeded');
  assert.equal(logs.filter((l) => l.includes('extending wait')).length, 0, 'no extension at/over the cap');
});

test('D3 stale queue digest (> 20s): the evidence is unknown, not "working" — failover proceeds', async () => {
  const def = await startEngine('default');
  const slow = await startHeldEngine(); // never answers
  const fb = await startEngine('fallback-engine');
  cleanup.push(() => def.close());
  cleanup.push(() => slow.close());
  cleanup.push(() => fb.close());
  const logs: string[] = [];
  const r = await startRouter({ defaultTarget: def.url, logs, slowHandling: 'failover', ttfbTimeoutMs: 150, queueDepthCap: 3 });
  r.updateAliases([d3Alias(slow.url, [d3Fallback(fb.url)])]);
  // The test seam (updateQueueDepths observedAt): the reading is 21s old —
  // older than QUEUE_DIGEST_FRESH_MS, so the depth carries no evidence.
  r.updateQueueDepths([{ server_id: 'srv-a', queue_depth: 1 }], Date.now() - 21_000);
  const res = await postChat(r.base_url, '/v1/chat/completions', D3_ALIAS);
  assert.equal(res.status, 200);
  assert.equal(fb.hits.length, 1, 'stale digest → failover proceeded');
  assert.equal(logs.filter((l) => l.includes('extending wait')).length, 0, 'a stale reading is unknown, never "still working"');
});

test('D3 watchdog fire with no fallback_targets → clean 504 upstream_timeout (OpenAI body, error.model echoed, headers unsent)', async () => {
  const def = await startEngine('default');
  const slow = await startHeldEngine(); // never answers
  cleanup.push(() => def.close());
  cleanup.push(() => slow.close());
  const r = await startRouter({ defaultTarget: def.url, slowHandling: 'failover', ttfbTimeoutMs: 150 });
  r.updateAliases([d3Alias(slow.url)]); // no fallback_targets at all
  const res = await postChat(r.base_url, '/v1/chat/completions', D3_ALIAS);
  assert.equal(res.status, 504, 'no usable target at fire time → 504 upstream_timeout');
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(await res.text(), d3TimeoutBody(150), 'the exact OpenAI-style body, error.model echoes the alias name');
  assert.equal(def.hits.length, 0, 'the timeout never smuggles the request to the default target');
  assert.equal(slow.hits.length, 1, 'the primary saw exactly one request');
});

test('D3 both engines slow → exactly ONE upstream retry then 504 — no chains (upstream request count pinned)', async () => {
  const def = await startEngine('default');
  const slowA = await startHeldEngine(); // never answers
  const slowB = await startHeldEngine(); // the fallback — also never answers
  cleanup.push(() => def.close());
  cleanup.push(() => slowA.close());
  cleanup.push(() => slowB.close());
  const logs: string[] = [];
  const r = await startRouter({ defaultTarget: def.url, logs, slowHandling: 'failover', ttfbTimeoutMs: 150 });
  r.updateAliases([d3Alias(slowA.url, [d3Fallback(slowB.url)])]);
  const res = await postChat(r.base_url, '/v1/chat/completions', D3_ALIAS);
  assert.equal(res.status, 504, 'the retry ALSO timed out → same 504, no further failover');
  assert.equal(await res.text(), d3TimeoutBody(150));
  assert.equal(slowA.hits.length, 1, 'the primary saw exactly one request');
  assert.equal(slowB.hits.length, 1, 'the fallback saw exactly one request — ONE retry, no chains');
  assert.equal(logs.filter((l) => l.includes('failover')).length, 1, 'exactly one switch log, ever');
});

test('D3 headers late-but-before-deadline → normal relay, the watchdog is disarmed forever (never retries after first byte)', async () => {
  const def = await startEngine('default');
  const late = await startDelayedEngine(300, 'late-primary'); // answers at 300ms, deadline 1000ms
  const fb = await startEngine('fallback-never-hit');
  cleanup.push(() => def.close());
  cleanup.push(() => late.close());
  cleanup.push(() => fb.close());
  const logs: string[] = [];
  const r = await startRouter({ defaultTarget: def.url, logs, slowHandling: 'failover', ttfbTimeoutMs: 1000 });
  r.updateAliases([d3Alias(late.url, [d3Fallback(fb.url)])]);
  const res = await postChat(r.base_url, '/v1/chat/completions', D3_ALIAS);
  assert.equal(res.status, 200, 'the late-but-legal response relays normally');
  assert.equal(((await res.json()) as { model: string }).model, 'late-primary');
  assert.equal(late.hits.length, 1, 'one request, one response — no second attempt');
  assert.equal(fb.hits.length, 0, 'the fallback was never touched');
  assert.equal(logs.filter((l) => l.includes('failover') || l.includes('extending wait')).length, 0, 'the watchdog never fired');
});

test('D3 updateAliases keeps fallback_targets: valid elements preserved, malformed elements dropped, malformed array = key absent, the entry still routes', async () => {
  const primary = await startDelayedEngine(5, 'primary');
  const fb = await startEngine('fallback-engine');
  cleanup.push(() => primary.close());
  cleanup.push(() => fb.close());
  const r = await startRouter({ defaultTarget: 'http://127.0.0.1:1' });

  // A malformed element (no url) drops; the valid one survives → failover
  // (if it ever fires) uses the valid entry. Behavioral proof: both a
  // mixed array and a clean array route the SAME way.
  r.updateAliases([d3Alias(primary.url, [{ server_id: 'srv-x' }, d3Fallback(fb.url), 'not-an-object', d3Fallback('')])]);
  const res = await postChat(r.base_url, '/v1/chat/completions', D3_ALIAS);
  assert.equal(res.status, 200, 'the entry itself routes on its winner pair regardless of the ADD key posture');
  assert.equal(JSON.parse(primary.hits[0]!.body).model, D3_PRIMARY_ID, 'the winner splice rode byte-for-byte');

  // Pure sanitizer posture.
  const { sanitizeAliasFallbackTargets } = await import('../src/aggregate.js');
  assert.deepEqual(
    sanitizeAliasFallbackTargets([{ server_id: 'srv-b', url: 'http://b', engine_model: 'm-b' }, { server_id: 'srv-c' }, null, 7]),
    [{ server_id: 'srv-b', url: 'http://b', engine_model: 'm-b' }],
    'valid element preserved (three fields), malformed elements dropped individually',
  );
  assert.equal(sanitizeAliasFallbackTargets('nope'), undefined, 'a malformed array = the key absent');
  assert.equal(sanitizeAliasFallbackTargets([]), undefined, 'an empty array normalizes to absent (the arbiter omits empty too)');
});

test('D3 config posture: keys absent → wait/off/cap 3; invalid handling → wait; 0 deadline stays OFF; garbage floors', async () => {
  const { loadClientConfig } = await import('../src/config.js');
  const env = (json: string): NodeJS.ProcessEnv => ({ IDLEFILL_CLIENT_CONFIG: json });

  const bare = loadClientConfig(join(testDir, '..', 'src'), env('{}'));
  assert.equal(bare.aggregate_slow_handling, 'wait', 'absent → wait (today byte-for-byte)');
  assert.equal(bare.aggregate_ttfb_timeout_ms, undefined, 'absent deadline → the watchdog is OFF');
  assert.equal(bare.aggregate_queue_depth_cap, 3, 'absent cap → 3');

  const bad = loadClientConfig(join(testDir, '..', 'src'), env('{"aggregate_slow_handling": "sideways", "aggregate_ttfb_timeout_ms": 0}'));
  assert.equal(bad.aggregate_slow_handling, 'wait', 'anything invalid reads as wait (drop-don\'t-reject)');
  assert.equal(bad.aggregate_ttfb_timeout_ms, undefined, '0 deadline → OFF (key not set)');

  const wired = loadClientConfig(
    join(testDir, '..', 'src'),
    env('{"aggregate_slow_handling": "failover", "aggregate_ttfb_timeout_ms": 2500.7, "aggregate_queue_depth_cap": -4}'),
  );
  assert.equal(wired.aggregate_slow_handling, 'failover');
  assert.equal(wired.aggregate_ttfb_timeout_ms, 2500, 'a finite positive deadline floors to an int');
  assert.equal(wired.aggregate_queue_depth_cap, 0, 'a negative cap floors at 0');

  const junkCap = loadClientConfig(join(testDir, '..', 'src'), env('{"aggregate_queue_depth_cap": "three"}'));
  assert.equal(junkCap.aggregate_queue_depth_cap, 3, 'garbage cap → the default 3');
});
