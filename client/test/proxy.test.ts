/**
 * proxy.test.ts — the loopback LLM proxy, end-to-end against a REAL fake
 * upstream on an ephemeral 127.0.0.1 port (real sockets, streaming).
 *
 * Covers:
 *   - a streaming (chunked SSE) response is proxied through intact
 *   - request body is forwarded verbatim
 *   - byte counts are recorded in the proxy log
 *   - target down → clean 502 JSON
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startLlmProxy, waitProxyReady } from '../src/proxy.js';

const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** Start a fake upstream that streams a few SSE chunks. Returns its port. */
function startFakeUpstream(opts: { sse?: boolean; delayMs?: number } = {}): Promise<{
  port: number;
  hits: { method: string; path: string; body: string }[];
}> {
  const hits: { method: string; path: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', body });
      if (opts.sse) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'transfer-encoding': 'chunked',
        });
        const chunks = ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo "}}]}\n\n', 'data: {"choices":[{"delta":{"content":"world"}}]}\n\n', 'data: [DONE]\n\n'];
        (async () => {
          for (const c of chunks) {
            await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
            res.write(c);
          }
          res.end();
        })();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
      resolveP({ port, hits });
    });
  });
}

test('proxies a streaming response end-to-end (real sockets)', async () => {
  const up = await startFakeUpstream({ sse: true });
  const proxy = startLlmProxy({ port: 0, target: `http://127.0.0.1:${up.port}` });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);

  const res = await fetch(`${proxy.base_url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') ?? '').includes('text/event-stream'));

  const text = await res.text();
  assert.match(text, /data: \[DONE\]/);
  assert.match(text, /"content":"Hel"/);
  assert.match(text, /"content":"world"/);
  // ordering preserved (streaming, not buffered-and-reordered)
  assert.ok(text.indexOf('Hel') < text.indexOf('world'), 'chunks arrive in order');

  // upstream saw the body verbatim
  assert.equal(up.hits.length, 1);
  assert.equal(up.hits[0]!.method, 'POST');
  assert.equal(up.hits[0]!.path, '/v1/chat/completions');
  const sent = JSON.parse(up.hits[0]!.body);
  assert.equal(sent.model, 'm');

  // proxy recorded the request
  const log = proxy.drainLog();
  assert.equal(log.length, 1);
  assert.equal(log[0]!.status, 200);
  assert.ok(log[0]!.req_bytes > 0, 'request bytes counted');
  assert.ok(log[0]!.resp_bytes > 0, 'response bytes counted');
});

test('502 with a clean JSON body when the target is down', async () => {
  // Nothing is listening on this port (it was closed at cleanup of a
  // previous ephemeral bind — pick one via a probe).
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const proxy = startLlmProxy({ port: 0, target: `http://127.0.0.1:${deadPort}` });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);

  const res = await fetch(`${proxy.base_url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm' }),
  });
  assert.equal(res.status, 502, 'dead target must yield a clean 502');
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'llm target down');
  assert.ok(proxy.drainLog().some((e) => e.status === 502 && e.error));
});

test('non-streaming JSON round-trip', async () => {
  const up = await startFakeUpstream({ sse: false });
  const proxy = startLlmProxy({ port: 0, target: `http://127.0.0.1:${up.port}` });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);

  const res = await fetch(`${proxy.base_url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string; usage?: { prompt_tokens: number } };
  assert.equal(body.id, 'chatcmpl-1');
  assert.equal(body.usage?.prompt_tokens, 10);
});

// ---------------------------------------------------------------------------
// #65 — the 11435 passthrough must propagate the upstream STATUS too.

const ENGINE_401_BODY = '{"error":{"message":"API key required","type":"authentication_error"}}';

/** Upstream answering with a fixed status + body (the live oMLX keyless-401 shape). */
function startStatusUpstream(status: number, bodyText: string): Promise<{ port: number }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(bodyText);
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      cleanup.push(() => new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }));
      resolveP({ port });
    });
  });
}

test('#65 passthrough: an engine 401 reaches the job caller as 401 with the engine body', async () => {
  const up = await startStatusUpstream(401, ENGINE_401_BODY);
  const proxy = startLlmProxy({ port: 0, target: `http://127.0.0.1:${up.port}` });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);

  const res = await fetch(`${proxy.base_url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm' }),
  });
  assert.equal(res.status, 401, 'the engine status rides through the passthrough (no 200-wrap)');
  assert.equal(await res.text(), ENGINE_401_BODY, 'the engine body passes through untouched');

  const entries = proxy.drainLog();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.status, 401, 'the request log still records the upstream status');
});
