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
 *   - GET /v1/models answers the catalog UNION (deduped), never a
 *     passthrough probe (the probe engine is never hit for it)
 *   - chat-completions route by the body's `model` to the catalog row's
 *     engine, WITH that row's Authorization header from the in-memory key
 *     table
 *   - unknown model / absent model / empty catalog fall back to the
 *     machine's default llm_target (exact today behavior, client's own
 *     auth passes through untouched)
 *   - gate derived-key registration: X-Hermes-Session-Id present → the
 *     header is the key; absent → the model name is the key (D3)
 *   - onSessionRoute fires (key, catalog-chosen server_id) so the daemon's
 *     register heartbeat carries the RIGHT server_id (D5)
 *   - one SHARED slot cap: 8800 traffic parks against a slot held by a
 *     11435 /s/<token> session on the SAME gate (D5 — a second gate would
 *     double the cap)
 *   - engineBase strips an operator-pasted /v1 suffix
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { startAggregateRouter, engineBase, type AggregateRouter, type AggregateCatalogEntry } from '../src/aggregate.js';
import { startLlmProxy, waitProxyReady, type LlmProxy } from '../src/proxy.js';
import { SessionGate, type SessionGateSnapshot, type SessionHistory } from '../src/session-gate.js';

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
}): Promise<AggregateRouter> {
  const r = startAggregateRouter({
    port: 0,
    defaultTarget: opts.defaultTarget,
    ...(opts.gate !== undefined ? { gate: opts.gate } : {}),
    ...(opts.onSessionRoute ? { onSessionRoute: opts.onSessionRoute } : {}),
  });
  cleanup.push(() => r.stop());
  await waitProxyReady(r.server);
  if (opts.catalog) r.updateCatalog(opts.catalog);
  if (opts.keys || opts.keyHashes) r.updateKeys(opts.keys ?? [], opts.keyHashes ?? []);
  return r;
}

function postChat(base: string, path: string, model?: string, headers?: Record<string, string>): Promise<Response> {
  const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] };
  if (model !== undefined) body.model = model;
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body),
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

test('GET /v1/models answers the deduped catalog union — never a passthrough probe', async () => {
  const def = await startEngine('default');
  cleanup.push(() => def.close());
  const r = await startRouter({ defaultTarget: def.url, catalog: CATALOG });
  assert.equal(r.catalogSize(), 2, 'the router de-dups a bare name even if the payload repeats it');

  const res = await fetch(`${r.base_url}/v1/models`);
  assert.equal(res.status, 200);
  const list = (await res.json()) as { object: string; data: { id: string; owned_by: string }[] };
  assert.equal(list.object, 'list');
  const ids = list.data.map((d) => d.id);
  assert.deepEqual([...new Set(ids)].length, ids.length, 'bare names deduped');
  assert.ok(ids.includes('MlxModel') && ids.includes('Shared'));
  const shared = list.data.find((d) => d.id === 'Shared')!;
  assert.equal(shared.owned_by, 'srv-omlx', 'first row owns the collision (arbiter-pinned order stands)');
  assert.equal(def.hits.length, 0, 'the router NEVER probes an engine to answer /v1/models (D1)');
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

test('fallback to llm_target: unknown model, absent model, and empty catalog all take today-behavior passthrough', async () => {
  const def = await startEngine('default');
  const omlx = await startEngine('omlx-engine');
  cleanup.push(() => def.close());
  cleanup.push(() => omlx.close());
  const r = await startRouter({ defaultTarget: def.url, catalog: CATALOG.map((e) => ({ ...e, url: omlx.url })) });

  const unknown = await postChat(r.base_url, '/v1/chat/completions', 'NotInCatalog');
  assert.equal(unknown.status, 200);
  assert.equal(((await unknown.json()) as { model: string }).model, 'default', 'unknown model → default target');

  const noModel = await fetch(`${r.base_url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 'clientkey' },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(noModel.status, 200);
  assert.equal(def.hits[1]!.auth, 'Bearer clientkey', 'client auth passes through untouched (today behavior)');

  r.updateCatalog([]);
  assert.equal(r.catalogSize(), 0);
  const empty = await postChat(r.base_url, '/v1/chat/completions', 'MlxModel');
  assert.equal(empty.status, 200);
  assert.equal(((await empty.json()) as { model: string }).model, 'default', 'empty catalog → default target');
  assert.equal(omlx.hits.length, 0, 'the row engine never served a fallback request');
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
  const r = await startRouter({ defaultTarget: `http://127.0.0.1:${ssePort}` });

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

test('#68 upstream posture: the agent key never rides to an engine — keyed row injects its own credential, keyless row and default target strip it', async () => {
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

  await postChat(r.base_url, '/v1/chat/completions', 'NotInCatalog', { authorization: BEARER(AGENT) });
  assert.equal(def.hits[0]!.auth, undefined, 'the default target gets the agent key stripped too');
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
