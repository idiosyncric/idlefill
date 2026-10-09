/**
 * session-transcript.test.ts — #78: the router's read-only transcript surface
 * (GET /sessions/<token>/transcript on the loopback proxy), end-to-end against
 * the REAL proxy + REAL SessionGate + a fake upstream on an ephemeral port
 * (real sockets).
 *
 * Covers the issue's three cases:
 *   - a KNOWN token (with observed traffic) → the per-request entries
 *     (request time + the model + streamed token total the router sniffed)
 *     newest-first, plus the #45 60s buckets; the transcript GET never
 *     reaches the upstream (a read surface, not proxied traffic);
 *   - an UNKNOWN token → fail-quiet: 200 + the empty shape (no requests,
 *     zero buckets), never an error and never 404;
 *   - an EMPTY ring (a fresh router with no recorded traffic) → the same
 *     empty shape at the gate read (the unit-level view of "known but idle").
 *
 * Posture under test: the transcript is the ROUTER's view — timing + a sniffed
 * model + a token total. It is NOT a chat reader; the response body of the
 * requests is never surfaced.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startLlmProxy, waitProxyReady } from '../src/proxy.js';
import { SessionGate } from '../src/session-gate.js';

const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/**
 * Fake upstream that records every hit and answers immediately with a
 * model-echo + a usage block (the shape the gate's response-side peek reads
 * for the model + token total). Unlike the controllable upstream in
 * session-gate.test.ts this releases on its own — a transcript request must
 * SETTLE for the response peek to have run, so nothing stays parked.
 */
function startUpstream(): Promise<{ port: number; hits: { method: string; path: string; body: string }[] }> {
  const hits: { method: string; path: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', body });
      // Echo the requested model (postChat sends model:'m') + a usage total —
      // the gate's response peek sniffs `model` + `total_tokens` from THIS.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: JSON.parse(body || '{}').model ?? 'resp-model',
          choices: [{ message: { content: 'hi' } }],
          usage: { total_tokens: 42 },
        }),
      );
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
      resolveP({ port, hits });
    });
  });
}

/** Drive one chat-completion request at the gate's session path. */
function postChat(baseUrl: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/s/${token}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });
}

/** The transcript read as the proxy serves it. */
type Transcript = { token: string; requests: { at: number; model?: string; tokens?: number }[]; buckets: number[] };
async function getTranscript(base: string, token: string): Promise<{ status: number; body: Transcript }> {
  const res = await fetch(`${base}/sessions/${encodeURIComponent(token)}/transcript`);
  const body = (await res.json()) as Transcript;
  return { status: res.status, body };
}

test('known token: the transcript lists the router-observed requests (time + model + tokens) + buckets, newest-first', async () => {
  const up = await startUpstream();
  const gate = new SessionGate({
    maxActive: 3,
    holdCapMs: 30_000,
    register: async () => true, // no arbiter in this test — fail-open is fine
  });
  const proxy = startLlmProxy({ port: 0, target: `http://127.0.0.1:${up.port}`, gate });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);

  // Three observed requests on the same token (all admitted: maxActive=3).
  const r1 = postChat(proxy.base_url, 'known-tok');
  const r2 = postChat(proxy.base_url, 'known-tok');
  const r3 = postChat(proxy.base_url, 'known-tok');
  for (const r of [r1, r2, r3]) assert.equal((await r).status, 200);
  // Give the response-side peek a beat to settle the model/tokens facts.
  await new Promise((r) => setTimeout(r, 25));

  const hitsBefore = up.hits.length;
  const { status, body } = await getTranscript(proxy.base_url, 'known-tok');
  assert.equal(status, 200);
  assert.equal(body.token, 'known-tok');
  // The router saw all three requests.
  assert.equal(body.requests.length, 3);
  // Newest-first: the ring is stored oldest-first, the transcript reverses it.
  assert.ok(
    body.requests[0]!.at >= body.requests[1]!.at && body.requests[1]!.at >= body.requests[2]!.at,
    'requests are newest-first',
  );
  // Each entry carries the router's OBSERVED model + token total (sniffed
  // from the upstream echo — `model:'m'` from the request body, 42 tokens).
  for (const req of body.requests) {
    assert.equal(req.model, 'm', 'the model the router sniffed rides the entry');
    assert.equal(req.tokens, 42, 'the streamed token total the router saw rides the entry');
    assert.ok(typeof req.at === 'number' && req.at > 0, 'each entry has a request time');
  }
  // The #45 buckets: exactly 10 (60s windows), all three fall in the newest.
  assert.equal(body.buckets.length, 10);
  assert.equal(body.buckets.reduce((a, b) => a + b, 0), 3);
  assert.equal(body.buckets[9], 3, 'the newest bucket holds all three (same minute)');
  // The transcript is a READ surface: it never proxied traffic upstream.
  assert.equal(up.hits.length, hitsBefore, 'a transcript GET never reaches the upstream');
});

test('unknown token: fail-quiet empty transcript (200, no requests, zero buckets) — never 404 / never an error', async () => {
  const up = await startUpstream();
  const gate = new SessionGate({
    maxActive: 1,
    holdCapMs: 30_000,
    register: async () => true,
  });
  const proxy = startLlmProxy({ port: 0, target: `http://127.0.0.1:${up.port}`, gate });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);

  const { status, body } = await getTranscript(proxy.base_url, 'never-seen-token');
  assert.equal(status, 200, 'an unknown token is fail-quiet, not a 404/5xx');
  assert.equal(body.token, 'never-seen-token');
  assert.deepEqual(body.requests, [], 'no recorded requests');
  assert.deepEqual(body.buckets, new Array<number>(10).fill(0), 'zero buckets');
});

test('empty ring: a fresh router (no recorded traffic) answers the empty shape at the gate read', async () => {
  // The unit-level view of "known but idle": a pristine gate with no traffic
  // has an empty ring for every token — the read answers the empty shape
  // (the honest "the router has recorded no requests", same shape as the
  // unknown-token fail-quiet above).
  const gate = new SessionGate({
    maxActive: 1,
    holdCapMs: 30_000,
    register: async () => true,
  });
  const t = gate.transcriptFor('idle-token');
  assert.equal(t.token, 'idle-token');
  assert.deepEqual(t.requests, [], 'empty ring → no requests');
  assert.deepEqual(t.buckets, new Array<number>(10).fill(0), 'empty ring → zero buckets');
});
