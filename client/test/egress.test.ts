/**
 * egress.test.ts — the egress self-diagnosis + self-test (the 2026-10-18
 * firewall-blindness fix: a local firewall silently DENIED every outbound
 * connect of the client daemon while every dashboard tile stayed green,
 * because engine rows are green from the ENGINES' registrations and the
 * forwarding machine itself said nothing).
 *
 * Two halves, real sockets (same posture as aggregate.test.ts):
 *
 *  A. the aggregate router's RECORDING seam —
 *   - a connection-level forward failure against a catalog ROW records
 *     (server_id, errno, host, at) in egressFailures();
 *   - the next successful forward to that row CLEARS it (headers = proof);
 *   - the default-target fall-through records NOTHING (no row identity);
 *   - HTTP error statuses (401) record nothing (they PROVE egress);
 *   - engineRows() lists catalog + alias + fallback rows, deduped by
 *     server_id (first url wins).
 *
 *  B. the loopback /client/egress-test surface (handleClientSelfTest) —
 *   - guards fail closed like the sibling surfaces: Host, Origin, token,
 *     method (POST-only — a stray GET never fires sockets);
 *   - a real run answers ok:true for a live engine (ANY status = path),
 *     ok:false + the errno for a dead one, and the run-level verdict;
 *   - probeTarget: live → {ok, status}; dead port → ECONNREFUSED; silent
 *     server → ETIMEDOUT inside the window.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startAggregateRouter, type AggregateRouter, type AggregateCatalogEntry, type AggregateAliasEntry } from '../src/aggregate.js';
import { waitProxyReady } from '../src/proxy.js';
import { handleClientSelfTest, probeTarget, probeUrlFor, SELF_TEST_PATH } from '../src/client-self-test.js';

const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function startEngineOn(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl-1', model: 'x', choices: [{ message: { content: 'ok' } }] }));
  });
  return new Promise((resolveP) => {
    server.listen(port, '127.0.0.1', () => {
      const p = (server.address() as AddressInfo).port;
      resolveP({
        url: `http://127.0.0.1:${p}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

/** A server that ACCEPTS but never answers (the firewall-blackhole shape). */
function startSilentServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(() => {
    /* deliberately never respond */
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const p = (server.address() as AddressInfo).port;
      resolveP({
        url: `http://127.0.0.1:${p}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

async function startRouterOn(port: number, defaultTarget: string): Promise<AggregateRouter> {
  // routeHoldMs=0: these tests pin the FORWARD ledger, never the hold; an
  // unroutable name answers its named 503 at once instead of waiting.
  const r = startAggregateRouter({ port, defaultTarget, routeHoldMs: 0 });
  cleanup.push(() => r.stop());
  await waitProxyReady(r.server);
  return r;
}

function postChat(base: string, model: string): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

async function pickDeadPort(): Promise<number> {
  const e = await startEngineOn(0);
  const p = new URL(e.url).port;
  await e.close();
  return Number(p);
}

// ---------------------------------------------------------------------------
// A. the recording seam on the aggregate router
// ---------------------------------------------------------------------------

test('a connection-level forward failure to a row records (server_id, errno, host); a later success clears it', async () => {
  const dead = await pickDeadPort();
  const def = await startEngineOn(0);
  cleanup.push(() => def.close());
  const r = await startRouterOn(0, def.url);
  r.updateCatalog([{ name: 'DeadModel', server_id: 'srv-dead', url: `http://127.0.0.1:${dead}/v1`, auth_set: false }]);

  const first = r.egressFailures();
  assert.deepEqual(first, [], 'no traffic → no ledger');

  const res = await postChat(r.base_url, 'DeadModel');
  assert.equal(res.status, 502, 'the caller still gets the honest 502');
  const ledger = r.egressFailures();
  assert.equal(ledger.length, 1, 'the machine recorded its own broken socket');
  assert.equal(ledger[0]!.server_id, 'srv-dead');
  assert.equal(ledger[0]!.code, 'ECONNREFUSED');
  assert.equal(ledger[0]!.host, '127.0.0.1');
  assert.ok(ledger[0]!.at > 0 && ledger[0]!.at <= Date.now());

  // Recover: an engine answers on the SAME port → the next forward's headers
  // clear the row (an HTTP answer is proof the socket works).
  const revived = await startEngineOn(dead);
  cleanup.push(() => revived.close());
  const again = await postChat(r.base_url, 'DeadModel');
  assert.equal(again.status, 200);
  assert.deepEqual(r.egressFailures(), [], 'the successful forward cleared the row');
});

test('route-hold: an unroutable name NEVER reaches the default target — the named 503 is local, the ledger stays empty', async () => {
  const dead = await pickDeadPort();
  const r = await startRouterOn(0, `http://127.0.0.1:${dead}`);
  const res = await postChat(r.base_url, 'UnknownModel');
  assert.equal(res.status, 503, 'route-hold (0ms) answers the named 503 — the dead default target is never contacted');
  assert.equal(((await res.json()) as { error: { type: string } }).error.type, 'model_unavailable');
  assert.deepEqual(r.egressFailures(), [], 'no forward ever ran → the ledger stays empty');
});

test('an HTTP error STATUS records nothing (401 from the engine PROVES egress)', async () => {
  const guarded = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'authentication_error' }));
  });
  await new Promise<void>((r) => guarded.listen(0, '127.0.0.1', () => r()));
  const port = (guarded.address() as AddressInfo).port;
  cleanup.push(() => new Promise<void>((r) => guarded.close(() => r())));
  const def = await startEngineOn(0);
  cleanup.push(() => def.close());
  const r = await startRouterOn(0, def.url);
  r.updateCatalog([{ name: 'Guarded', server_id: 'srv-guarded', url: `http://127.0.0.1:${port}/v1`, auth_set: true }]);

  const res = await postChat(r.base_url, 'Guarded');
  assert.equal(res.status, 401, "the engine's status rides through (#65)");
  assert.deepEqual(r.egressFailures(), [], 'a refused CREDENTIAL is not a broken PATH — nothing recorded');
});

test('engineRows lists catalog + alias + fallback rows, deduped by server_id (first url wins)', () => {
  const catalog: AggregateCatalogEntry[] = [
    { name: 'A', server_id: 'srv-a', url: 'http://a:1/v1', auth_set: false },
    { name: 'B', server_id: 'srv-b', url: 'http://b:1/v1', auth_set: false },
  ];
  const aliases: AggregateAliasEntry[] = [
    {
      name: 'Alias',
      server_id: 'srv-a',
      url: 'http://a-OTHER:9/v1', // deduped: srv-a keeps its FIRST (catalog) url
      auth_set: false,
      engine_model: 'A',
      catalog_source: 'probed',
      fallback_targets: [
        { server_id: 'srv-c', url: 'http://c:1/v1', engine_model: 'C' },
        { server_id: 'srv-b', url: 'http://b-other:9/v1', engine_model: 'B' },
      ],
    },
  ];
  const router = startAggregateRouter({ port: 0, defaultTarget: 'http://127.0.0.1:1' });
  cleanup.push(() => router.stop());
  router.updateCatalog(catalog);
  router.updateAliases(aliases);
  const rows = router.engineRows();
  assert.deepEqual(rows, [
    { server_id: 'srv-a', url: 'http://a:1/v1' },
    { server_id: 'srv-b', url: 'http://b:1/v1' },
    { server_id: 'srv-c', url: 'http://c:1/v1' },
  ]);
});

// ---------------------------------------------------------------------------
// B. the loopback self-test surface
// ---------------------------------------------------------------------------

function startSelfTestHost(opts: Parameters<typeof handleClientSelfTest>[3]): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let u: URL;
    try {
      u = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      u = new URL('http://127.0.0.1/');
    }
    if (!handleClientSelfTest(req, res, u, opts)) {
      res.writeHead(501);
      res.end();
    }
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolveP({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

test('self-test guards fail closed: token (401), method (405 GET — a stray GET never probes), Origin (403), Host (400)', async () => {
  let probed = 0;
  const host = await startSelfTestHost({
    token: 'tok-egress',
    targets: () => {
      probed++;
      return { arbiter: 'http://127.0.0.1:1', engines: [] };
    },
  });
  cleanup.push(() => host.close());

  const noToken = await fetch(`${host.base}${SELF_TEST_PATH}`, { method: 'POST' });
  assert.equal(noToken.status, 401, 'no edit token → refused BEFORE any socket');
  const get = await fetch(`${host.base}${SELF_TEST_PATH}`, { headers: { 'x-idlefill-edit': 'tok-egress' } });
  assert.equal(get.status, 405, 'GET is refused — the probe is an explicit POST verb');
  const badOrigin = await fetch(`${host.base}${SELF_TEST_PATH}`, {
    method: 'POST',
    headers: { 'x-idlefill-edit': 'tok-egress', origin: 'https://evil.example' },
  });
  assert.equal(badOrigin.status, 403, 'a non-loopback Origin is refused');
  // A non-loopback Host header cannot be sent via fetch (forbidden header) —
  // raw http.request sends exactly what it is given.
  const raw = await new Promise<number>((resolveRaw, rejectRaw) => {
    const req = http.request(
      { host: '127.0.0.1', port: new URL(host.base).port, path: SELF_TEST_PATH, method: 'POST', headers: { host: 'example.com', 'x-idlefill-edit': 'tok-egress' } },
      (res) => {
        res.resume();
        resolveRaw(res.statusCode ?? 0);
      },
    );
    req.on('error', rejectRaw);
    req.end();
  });
  assert.equal(raw, 400, 'a non-loopback Host is refused');
  assert.equal(probed, 0, 'NOT ONE guard-passing call was made — targets() never ran');
});

test('self-test run: live engine answers ok with its HTTP status, dead row names its errno, verdict is the conjunction', async () => {
  const live = await startEngineOn(0);
  cleanup.push(() => live.close());
  const dead = await pickDeadPort();
  const host = await startSelfTestHost({
    token: 'tok-egress',
    targets: () => ({
      arbiter: live.url,
      default_target: live.url,
      engines: [
        { server_id: 'srv-live', url: `${live.url}/v1` },
        { server_id: 'srv-dead', url: `http://127.0.0.1:${dead}` },
      ],
    }),
  });
  cleanup.push(() => host.close());

  const res = await fetch(`${host.base}${SELF_TEST_PATH}`, {
    method: 'POST',
    headers: { 'x-idlefill-edit': 'tok-egress' },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { at: number; ok: boolean; results: { kind: string; label: string; ok: boolean; status?: number; code?: string; url: string }[] };
  assert.equal(body.ok, false, 'one dead row makes the run NOT ok');
  const arbiterLine = body.results.find((x) => x.kind === 'arbiter')!;
  assert.equal(arbiterLine.ok, true);
  assert.equal(arbiterLine.status, 200);
  const liveLine = body.results.find((x) => x.label === 'srv-live')!;
  assert.equal(liveLine.ok, true, 'a 200 from /v1/models proves the path');
  assert.match(liveLine.url, /\/v1\/models$/, 'engine probes hit the models read, never a chat');
  const deadLine = body.results.find((x) => x.label === 'srv-dead')!;
  assert.equal(deadLine.ok, false);
  assert.equal(deadLine.code, 'ECONNREFUSED', 'the errno names the failure honestly');
});

test('self-test arbiter 401 still counts ok — ANY HTTP response proves the egress path', async () => {
  const guarded = http.createServer((_req, res) => {
    res.writeHead(401);
    res.end('{"error":"unauthorized"}');
  });
  await new Promise<void>((r) => guarded.listen(0, '127.0.0.1', () => r()));
  const port = (guarded.address() as AddressInfo).port;
  cleanup.push(() => new Promise<void>((r) => guarded.close(() => r())));
  const host = await startSelfTestHost({
    token: 'tok-egress',
    targets: () => ({ arbiter: `http://127.0.0.1:${port}`, engines: [] }),
  });
  cleanup.push(() => host.close());
  const res = await fetch(`${host.base}${SELF_TEST_PATH}`, { method: 'POST', headers: { 'x-idlefill-edit': 'tok-egress' } });
  const body = (await res.json()) as { ok: boolean; results: { ok: boolean; status?: number }[] };
  assert.equal(body.ok, true);
  assert.equal(body.results[0]!.status, 401, 'the status is shown; the VERDICT is egress-ok');
});

// ---------------------------------------------------------------------------
// probeTarget + probeUrlFor units
// ---------------------------------------------------------------------------

test('probeUrlFor normalizes an engine url to the /v1/models read', () => {
  assert.equal(probeUrlFor('http://h:8080'), 'http://h:8080/v1/models');
  assert.equal(probeUrlFor('http://h:8080/v1'), 'http://h:8080/v1/models');
  assert.equal(probeUrlFor('https://e.example/v1'), 'https://e.example/v1/models');
});

test('probeTarget: live answers with the status, dead names ECONNREFUSED, silent answers ETIMEDOUT', async () => {
  const live = await startEngineOn(0);
  cleanup.push(() => live.close());
  const dead = await pickDeadPort();
  const silent = await startSilentServer();
  cleanup.push(() => silent.close());

  const okRes = await probeTarget(live.url, 4000);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.status, 200);

  const deadRes = await probeTarget(`http://127.0.0.1:${dead}`, 4000);
  assert.equal(deadRes.ok, false);
  assert.equal(deadRes.code, 'ECONNREFUSED');

  const t0 = Date.now();
  const silentRes = await probeTarget(silent.url, 150);
  assert.equal(silentRes.ok, false);
  assert.equal(silentRes.code, 'ETIMEDOUT', 'a blackhole answers ETIMEDOUT inside the window');
  assert.ok(Date.now() - t0 < 4000, 'the timeout actually bounded the wait');
});
