/**
 * aliases.test.ts — #66 client side: the model-alias plane on the :8800
 * aggregate listener (docs/architecture/model-aliases.md D2/D3/D4/D6 +
 * the owner's 2026-10-06 Q3 scoped-buffer decision).
 *
 * Real sockets + echo/fake engines, the aggregate.test.ts pattern: the
 * REAL aggregate router; the alias map pushed through updateAliases — the
 * exact shape the daemon's /api/state poll feeds it.
 *
 * Covers:
 *   - /v1/models: advertises ONLY the configured aliases, in their PRIORITY
 *     order (the publish block order) — a shadowed name appears once, a
 *     non-aliased bare name is absent (the operator's curated surface)
 *   - routing: the alias name reaches the WINNER row's engine with that
 *     row's Authorization header; the alias BEATS a bare catalog entry of
 *     the same name (D2 precedence); onSessionRoute reports the WINNER
 *     row id, never an alias placeholder (D6 heartbeat truthfulness)
 *   - the BYTE family (echo upstream recording exact received bytes):
 *     aliased request → the engine sees `engine_model`, the alias string
 *     appears NOWHERE, every other byte is identical, content-length
 *     equals the received byte count, the JSON parses
 *   - chunked client (curl -T - shape) → forwarded with a VALID
 *     content-length (the scoped buffer normalizes framing — the Q3
 *     posture the llama.cpp family demands)
 *   - NON-aliased traffic byte-identical to today: splice never happens,
 *     the pipe posture keeps a chunked client chunked
 *   - chunk-boundary name spanning: the sniff misses → default-target
 *     fallback PARITY (the fix is deferred to #67; this pins it)
 *   - over-cap aliased body → 413 before any engine byte (bounded cap)
 *   - re-pin propagation: updateAliases (simulating the next poll) → the
 *     next request serves the OTHER winner row
 *   - unknown/absent model: the machine default target untouched (D6)
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  startAggregateRouter,
  spliceModelName,
  type AggregateRouter,
  type AggregateCatalogEntry,
  type AggregateAliasEntry,
} from '../src/aggregate.js';

const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/**
 * Echo engine: records EVERY request as exact bytes + the content-length
 * header it received, and answers echoing a per-engine marker, so a test
 * proves which engine served it AND what arrived byte-exact.
 */
interface EchoHit {
  method: string;
  path: string;
  raw: Buffer;
  auth: string | undefined;
  contentLength: string | undefined;
  transferEncoding: string | undefined;
}
function startEcho(marker: string): Promise<{
  url: string;
  hits: EchoHit[];
  close: () => Promise<void>;
}> {
  const hits: EchoHit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      hits.push({
        method: req.method ?? '',
        path: req.url ?? '',
        raw,
        auth: req.headers.authorization,
        contentLength: req.headers['content-length'] as string | undefined,
        transferEncoding: req.headers['transfer-encoding'] as string | undefined,
      });
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

async function startRouter(opts: {
  defaultTarget: string;
  catalog?: AggregateCatalogEntry[];
  aliases?: AggregateAliasEntry[];
  keys?: { id: string; name: string; url: string; auth_token: string }[];
  onSessionRoute?: (key: string, serverId: string) => void;
  aliasBodyCapBytes?: number;
}): Promise<AggregateRouter> {
  const r = startAggregateRouter({
    port: 0,
    defaultTarget: opts.defaultTarget,
    ...(opts.onSessionRoute ? { onSessionRoute: opts.onSessionRoute } : {}),
    ...(opts.aliasBodyCapBytes !== undefined ? { aliasBodyCapBytes: opts.aliasBodyCapBytes } : {}),
  });
  cleanup.push(() => r.stop());
  if (!r.server.listening) await new Promise<void>((r2) => r.server.once('listening', r2));
  if (opts.catalog) r.updateCatalog(opts.catalog);
  if (opts.aliases) r.updateAliases(opts.aliases);
  if (opts.keys) r.updateKeys(opts.keys);
  return r;
}

async function waitFor(pred: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Content-length client — the normal SDK posture (Node fetch, string body). */
function postChat(base: string, bodyText: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: bodyText,
  });
}

/**
 * Chunked client — the `curl -T -` shape: no content-length, Node's http
 * client frames the body chunked (two writes so the framing is real).
 */
function postChunked(port: number, chunks: string[]): Promise<{ status: number; body: string }> {
  return new Promise((resolveP, rejectP) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolveP({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', rejectP);
    for (const c of chunks) req.write(c);
    req.end();
  });
}

// A chat body where the requested model name appears ONLY inside the
// quoted model field, so "no alias string anywhere" is a meaningful claim.
function chatBody(model: string): string {
  return JSON.stringify({ model, messages: [{ role: 'user', content: 'hello alias plane' }] });
}

const ALIAS_NAME = 'Qwen3.Alias-Flagship'; // distinct from every engine id in the file
const ENGINE_ID_A = 'engine-a-real-id';
const ENGINE_ID_B = 'engine-b-real-id';

// ---------------------------------------------------------------------------

test('spliceModelName: only the model value changes, quotes intact, no-match leaves bytes untouched', () => {
  const body = Buffer.from(chatBody(ALIAS_NAME));
  const out = spliceModelName(body, ALIAS_NAME, ENGINE_ID_A);
  assert.notEqual(out, body);
  assert.ok(out.toString('utf8').includes(`"model":"${ENGINE_ID_A}"`));
  assert.ok(!out.toString('utf8').includes(ALIAS_NAME));
  assert.deepEqual(JSON.parse(out.toString('utf8')).messages, [{ role: 'user', content: 'hello alias plane' }]);
  // No match (the name lives elsewhere or never appears): byte-identical.
  const other = Buffer.from(chatBody('SomethingElse'));
  assert.equal(spliceModelName(other, ALIAS_NAME, ENGINE_ID_A), other);
  // Equal names: untouched, no rebuild.
  assert.equal(spliceModelName(body, ALIAS_NAME, ALIAS_NAME), body);
});

test('#66 /v1/models: advertises ONLY the aliases (in priority order) — a shadowed name appears once, a non-aliased bare name is absent', async () => {
  const def = await startEcho('default');
  cleanup.push(() => def.close());
  const r = await startRouter({
    defaultTarget: def.url,
    catalog: [
      { name: ALIAS_NAME, server_id: 'srv-shadow', url: 'http://127.0.0.1:9', auth_set: false, catalog_source: 'declared' },
      { name: 'BareOther', server_id: 'srv-bare', url: 'http://127.0.0.1:8', auth_set: false },
    ],
    aliases: [{ name: ALIAS_NAME, server_id: 'srv-win', url: 'http://127.0.0.1:7', auth_set: true, engine_model: ENGINE_ID_A, catalog_source: 'probed' }],
  });
  assert.equal(r.aliasSize(), 1);

  const res = await fetch(`${r.base_url}/v1/models`);
  assert.equal(res.status, 200);
  const list = (await res.json()) as { object: string; data: { id: string; owned_by: string }[] };
  const ids = list.data.map((d) => d.id);
  assert.deepEqual(ids, [ALIAS_NAME], 'only the alias is advertised — the shadowed bare entry AND the non-aliased BareOther are both absent');
  assert.equal(list.data[0]!.id, ALIAS_NAME, 'the alias is the first advertised name');
  assert.equal(list.data[0]!.owned_by, 'srv-win', 'owned_by = the winner row, not the shadowed bare row');
  assert.equal(def.hits.length, 0, 'the router still never probes an engine for /v1/models');
});

test('#66 /v1/models: the alias list order is the PRIORITY order (first alias first)', async () => {
  const def = await startEcho('default');
  cleanup.push(() => def.close());
  // Two aliases; the operator's priority puts B before A (A was created first,
  // but the publish block — the operator's reordered view — leads with B).
  const r = await startRouter({
    defaultTarget: def.url,
    catalog: [
      { name: 'AliasA', server_id: 'srv-a', url: 'http://127.0.0.1:5', auth_set: true, catalog_source: 'probed' },
      { name: 'AliasB', server_id: 'srv-b', url: 'http://127.0.0.1:6', auth_set: true, catalog_source: 'probed' },
    ],
    aliases: [
      { name: 'AliasB', server_id: 'srv-b', url: 'http://127.0.0.1:6', auth_set: true, engine_model: 'engine-b', catalog_source: 'probed' },
      { name: 'AliasA', server_id: 'srv-a', url: 'http://127.0.0.1:5', auth_set: true, engine_model: 'engine-a', catalog_source: 'probed' },
    ],
  });
  const res = await fetch(`${r.base_url}/v1/models`);
  const list = (await res.json()) as { data: { id: string }[] };
  assert.deepEqual(list.data.map((d) => d.id), ['AliasB', 'AliasA'], 'the advertised order is the publish block order, not the creation order');
});

test('#66 routing: the alias name reaches the WINNER engine with the row Authorization; the alias beats a bare entry of the same name', async () => {
  const def = await startEcho('default');
  const win = await startEcho('engine-A');
  const shadow = await startEcho('engine-shadow');
  cleanup.push(() => def.close());
  cleanup.push(() => win.close());
  cleanup.push(() => shadow.close());
  const aliasKey = 'win-' + 'key-9f';
  const routes: [string, string][] = [];
  const r = await startRouter({
    defaultTarget: def.url,
    // The SAME name on a bare entry pointing at the shadow engine — the
    // alias must win at routing (D2 precedence), not just at publish.
    catalog: [{ name: ALIAS_NAME, server_id: 'srv-shadow', url: shadow.url, auth_set: false }],
    aliases: [{ name: ALIAS_NAME, server_id: 'srv-win', url: win.url, auth_set: true, engine_model: ENGINE_ID_A, catalog_source: 'probed' }],
    keys: [{ id: 'srv-win', name: 'winner', url: win.url, auth_token: aliasKey }],
    onSessionRoute: (key, serverId) => routes.push([key, serverId]),
  });

  const res = await postChat(r.base_url, chatBody(ALIAS_NAME));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { model: string }).model, 'engine-A', 'the winner engine served the alias');
  await waitFor(() => win.hits.length === 1, 3000, 'winner engine hit');
  assert.equal(win.hits[0]!.auth, `Bearer ${aliasKey}`, "the winner ROW's credential rode from the key table");
  assert.equal(shadow.hits.length, 0, 'the shadowed bare entry never served');
  assert.equal(def.hits.length, 0, 'no fallback for a known alias');
  // D6: the register heartbeat pairs the derived key with the WINNER row id.
  assert.deepEqual(routes, [[ALIAS_NAME, 'srv-win']], 'onSessionRoute reports the winner row id, never an alias placeholder');
});

test('#66 bytes: aliased request — engine sees engine_model, NO alias string, every other byte identical, content-length exact, JSON parses', async () => {
  const def = await startEcho('default');
  const eng = await startEcho('engine-A');
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const r = await startRouter({
    defaultTarget: def.url,
    aliases: [{ name: ALIAS_NAME, server_id: 'srv-win', url: eng.url, auth_set: false, engine_model: ENGINE_ID_A, catalog_source: 'probed' }],
  });

  const sent = chatBody(ALIAS_NAME);
  const res = await postChat(r.base_url, sent);
  assert.equal(res.status, 200);
  await waitFor(() => eng.hits.length === 1, 3000, 'echo hit');
  const hit = eng.hits[0]!;
  const received = hit.raw.toString('utf8');
  // The engine sees the winner pair's OWN id, and nowhere the alias.
  assert.ok(received.includes(`"model":"${ENGINE_ID_A}"`), 'the spliced engine id arrived');
  assert.ok(!received.includes(ALIAS_NAME), 'the alias string appears NOWHERE in the received bytes');
  // Every OTHER byte is identical: the splice touched only the model value.
  const expected = Buffer.from(sent.replace(`"${ALIAS_NAME}"`, `"${ENGINE_ID_A}"`), 'utf8');
  assert.ok(hit.raw.equals(expected), 'every byte outside the model value is identical');
  // content-length equals the received byte count (the recomputed length).
  assert.equal(hit.contentLength, String(hit.raw.length), 'content-length matches the received byte count');
  assert.equal(hit.transferEncoding, undefined, 'the forwarded request is content-length framed, not chunked');
  // The JSON still parses with the rest intact.
  const parsed = JSON.parse(received) as { model: string; messages: { role: string; content: string }[] };
  assert.equal(parsed.model, ENGINE_ID_A);
  assert.equal(parsed.messages[0]!.content, 'hello alias plane');
  assert.equal(hit.path, '/v1/chat/completions', 'path forwarded verbatim');
});

test('#66 bytes: chunked client (curl -T - shape) through an alias → forwarded with a valid content-length (framing normalized)', async () => {
  const def = await startEcho('default');
  const eng = await startEcho('engine-A');
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const r = await startRouter({
    defaultTarget: def.url,
    aliases: [{ name: ALIAS_NAME, server_id: 'srv-win', url: eng.url, auth_set: false, engine_model: ENGINE_ID_A, catalog_source: 'probed' }],
  });
  await new Promise<void>((res) => setTimeout(res, 0));

  const body = chatBody(ALIAS_NAME);
  const port = new URL(r.base_url).port;
  // Two writes so the CLIENT framing is genuinely chunked; the split sits
  // AFTER the quoted name so routing still SEES the alias (the spanning
  // case is its own parity test below).
  const out = await postChunked(Number(port), [body.slice(0, 40), body.slice(40)]);
  assert.equal(out.status, 200);
  await waitFor(() => eng.hits.length === 1, 3000, 'echo hit');
  const hit = eng.hits[0]!;
  assert.ok(hit.raw.toString('utf8').includes(`"model":"${ENGINE_ID_A}"`), 'the alias was spliced for the chunked client too');
  assert.ok(!hit.raw.toString('utf8').includes(ALIAS_NAME), 'no alias string anywhere');
  assert.equal(hit.transferEncoding, undefined, 'the engine sees NO chunked framing (the llama.cpp family drops it — Q3)');
  assert.equal(hit.contentLength, String(hit.raw.length), 'forwarded with a valid, exact content-length');
  JSON.parse(hit.raw.toString('utf8')); // parses
});

test('#66 bytes: NON-aliased traffic byte-identical — bare name pipes untouched; a chunked client STAYS chunked (today posture)', async () => {
  const def = await startEcho('default');
  const bare = await startEcho('engine-bare');
  cleanup.push(() => def.close());
  cleanup.push(() => bare.close());
  const r = await startRouter({
    defaultTarget: def.url,
    catalog: [{ name: 'BareName', server_id: 'srv-bare', url: bare.url, auth_set: false, catalog_source: 'probed' }],
  });

  const sent = chatBody('BareName');
  const res = await postChat(r.base_url, sent);
  assert.equal(res.status, 200);
  await waitFor(() => bare.hits.length === 1, 3000, 'bare engine hit');
  assert.ok(bare.hits[0]!.raw.equals(Buffer.from(sent, 'utf8')), 'the bare body piped byte-for-byte (no splice)');
  assert.equal(bare.hits[0]!.contentLength, String(sent.length), 'the client content-length rode untouched');

  // The chunked NON-aliased client keeps today behavior: forwarded chunked.
  // (Split after the quoted name: routing still resolves the bare entry.)
  const port = new URL(r.base_url).port;
  const out = await postChunked(Number(port), [sent.slice(0, 40), sent.slice(40)]);
  assert.equal(out.status, 200);
  await waitFor(() => bare.hits.length === 2, 3000, 'chunked bare hit');
  assert.equal(bare.hits[1]!.transferEncoding, 'chunked', 'non-aliased traffic never buffers: the pipe posture stands');
  assert.ok(bare.hits[1]!.raw.equals(Buffer.from(sent, 'utf8')), 'chunked non-aliased bytes still identical');
});

test('#66 parity: model name spanning the chunk boundary — the sniff misses, the request falls to the DEFAULT target (fix deferred to #67)', async () => {
  const def = await startEcho('default');
  const eng = await startEcho('engine-A');
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const r = await startRouter({
    defaultTarget: def.url,
    aliases: [{ name: ALIAS_NAME, server_id: 'srv-win', url: eng.url, auth_set: false, engine_model: ENGINE_ID_A, catalog_source: 'probed' }],
  });

  const body = chatBody(ALIAS_NAME);
  const cut = body.indexOf(ALIAS_NAME) + 3; // first chunk ends INSIDE the name: the quoted-name regex cannot match
  const port = new URL(r.base_url).port;
  const out = await postChunked(Number(port), [body.slice(0, cut), body.slice(cut)]);
  assert.equal(out.status, 200);
  await waitFor(() => def.hits.length === 1, 3000, 'default target hit');
  assert.equal(eng.hits.length, 0, 'the alias engine was NOT chosen — routing could not see the name (same as an unknown model today)');
  assert.ok(def.hits[0]!.raw.equals(Buffer.from(body, 'utf8')), 'the default target got the bytes untouched (fallback posture unchanged)');
  // PARITY claim: same shape an unknown model takes today. NOT a fix —
  // the bounded multi-chunk peek lands in #67.
});

test('#66 413: an aliased body over the bounded cap is refused before the engine sees a byte', async () => {
  const def = await startEcho('default');
  const eng = await startEcho('engine-A');
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const r = await startRouter({
    defaultTarget: def.url,
    aliases: [{ name: ALIAS_NAME, server_id: 'srv-win', url: eng.url, auth_set: false, engine_model: ENGINE_ID_A, catalog_source: 'probed' }],
    aliasBodyCapBytes: 128, // test seam; production cap is ALIAS_BODY_BUFFER_CAP (>= 32 MiB)
  });
  const big = JSON.stringify({ model: ALIAS_NAME, messages: [{ role: 'user', content: 'x'.repeat(4096) }] });
  const res = await postChat(r.base_url, big);
  assert.equal(res.status, 413, 'over-cap aliased body → 413');
  const err = (await res.json()) as { error: string };
  assert.match(err.error, /over the rewrite cap/);
  assert.equal(eng.hits.length, 0, 'the engine never saw a byte');
  assert.equal(def.hits.length, 0, 'an over-cap alias body never falls through to the default target either');

  // Under-cap on the same router: forwarded fine.
  const small = chatBody(ALIAS_NAME);
  const ok = await postChat(r.base_url, small);
  assert.equal(ok.status, 200);
  await waitFor(() => eng.hits.length === 1, 3000, 'under-cap alias forwarded');
});

test('#66 re-pin propagation: updateAliases (the next poll lands) → the next request serves the OTHER winner row', async () => {
  const def = await startEcho('default');
  const a = await startEcho('engine-A');
  const b = await startEcho('engine-B');
  cleanup.push(() => def.close());
  cleanup.push(() => a.close());
  cleanup.push(() => b.close());
  const routes: [string, string][] = [];
  const r = await startRouter({
    defaultTarget: def.url,
    aliases: [{ name: ALIAS_NAME, server_id: 'srv-a', url: a.url, auth_set: false, engine_model: ENGINE_ID_A, catalog_source: 'probed' }],
    keys: [
      { id: 'srv-a', name: 'A', url: a.url, auth_token: 'key-a-1' },
      { id: 'srv-b', name: 'B', url: b.url, auth_token: 'key-b-2' },
    ],
    onSessionRoute: (key, serverId) => routes.push([key, serverId]),
  });

  let res = await postChat(r.base_url, chatBody(ALIAS_NAME));
  assert.equal(((await res.json()) as { model: string }).model, 'engine-A', 'first pin: engine A answers');

  // The dashboard POST re-pins server-side; the router learns it on the
  // NEXT /api/state poll — updateAliases simulates exactly that.
  r.updateAliases([{ name: ALIAS_NAME, server_id: 'srv-b', url: b.url, auth_set: true, engine_model: ENGINE_ID_B, catalog_source: 'probed' }]);

  res = await postChat(r.base_url, chatBody(ALIAS_NAME));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { model: string }).model, 'engine-B', 'the re-pin rides the poll: engine B now answers');
  await waitFor(() => b.hits.length === 1, 3000, 're-pinned engine hit');
  assert.equal(b.hits[0]!.auth, 'Bearer key-b-2', 'the NEW winner row credential rides');
  assert.ok(b.hits[0]!.raw.toString('utf8').includes(`"model":"${ENGINE_ID_B}"`), 'the new winner engine id spliced');
  assert.deepEqual(routes, [[ALIAS_NAME, 'srv-a'], [ALIAS_NAME, 'srv-b']], 'heartbeats follow the new engine honestly (D6)');
});

test('#66 D6 fence: unknown model + absent model + cleared aliases all fall to the machine default target untouched', async () => {
  const def = await startEcho('default');
  const eng = await startEcho('engine-A');
  cleanup.push(() => def.close());
  cleanup.push(() => eng.close());
  const r = await startRouter({
    defaultTarget: def.url,
    aliases: [{ name: ALIAS_NAME, server_id: 'srv-win', url: eng.url, auth_set: false, engine_model: ENGINE_ID_A, catalog_source: 'probed' }],
  });

  const unknown = await postChat(r.base_url, chatBody('NoSuchAlias'));
  assert.equal(((await unknown.json()) as { model: string }).model, 'default', 'unknown model → llm_target (untouched fence)');
  assert.ok(def.hits[0]!.raw.toString('utf8').includes('NoSuchAlias'), 'the unknown body forwarded untouched');

  r.updateAliases([]); // the arbiter published no aliases this tick
  assert.equal(r.aliasSize(), 0, 'an empty block CLEARS the alias map (no stale pin)');
  const nowBare = await postChat(r.base_url, chatBody(ALIAS_NAME));
  assert.equal(((await nowBare.json()) as { model: string }).model, 'default', 'a vanished alias is not routed (all-pairs-dead posture)');
  assert.equal(eng.hits.length, 0, 'the alias engine never served after the block cleared');
});

test('#66 updateAliases defensive posture: malformed entries dropped, a repeated name keeps the first', () => {
  const r = startAggregateRouter({ port: 0, defaultTarget: 'http://127.0.0.1:1' });
  cleanup.push(() => r.stop());
  r.updateAliases([
    { name: 'Good', server_id: 'srv-1', url: 'http://127.0.0.1:2', auth_set: false, engine_model: 'real-id', catalog_source: 'probed' },
    { name: 'Good', server_id: 'srv-2', url: 'http://127.0.0.1:3', auth_set: false, engine_model: 'other-id', catalog_source: 'probed' },
    { name: '', server_id: 'srv-3', url: 'http://127.0.0.1:4', auth_set: false, engine_model: 'x', catalog_source: 'probed' },
    { name: 'NoUrl', server_id: 'srv-4', url: '', auth_set: false, engine_model: 'x', catalog_source: 'probed' },
    { name: 'NoEngine', server_id: 'srv-5', url: 'http://127.0.0.1:5', auth_set: false, engine_model: '', catalog_source: 'probed' },
    null as never,
  ]);
  assert.equal(r.aliasSize(), 1, 'only the first well-formed entry stands');
});
