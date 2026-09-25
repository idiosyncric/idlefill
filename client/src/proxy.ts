/**
 * Loopback LLM proxy: 127.0.0.1:<proxy_port> → llm_target.
 *
 * career-ops' openai-eval.mjs refuses plain-http NON-loopback endpoints by
 * design (your CV + JD must not go over cleartext to a remote host). The
 * arbiter-gated work runs on THIS machine, so the executor points the eval
 * at http://127.0.0.1:<proxy_port>/v1 and this proxy streams the request to
 * the real LLM target over the tailnet.
 *
 * Contract:
 *   - request-by-request, no buffering: req body is piped straight to the
 *     upstream; the upstream response is piped straight back (chunked/SSE
 *     streaming works — the eval script streams, and so do we).
 *   - target down → clean 502 JSON { error: "llm target down", ... }
 *   - every proxied request's byte counts are recorded (req/resp) for the
 *     usage report the client sends back to the arbiter.
 *
 * Binds 127.0.0.1 ONLY — nothing else on the network reaches it.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ProxyLogEntry {
  ts: number;
  method: string;
  path: string;
  /** Request bytes forwarded upstream. */
  req_bytes: number;
  /** Response bytes streamed back. */
  resp_bytes: number;
  status: number;
  /** Set when the proxy answered 502 (target unreachable). */
  error?: string;
}

export interface LlmProxy {
  server: http.Server;
  port: number;
  base_url: string;
  /** Append-only record of proxied requests (drained by the client loop). */
  log: ProxyLogEntry[];
  /** Drain the log (returns entries seen since the last drain). */
  drainLog(): ProxyLogEntry[];
  stop(): Promise<void>;
}

export function startLlmProxy(opts: {
  port: number;
  target: string;
  host?: string;
}): LlmProxy {
  const target = new URL(opts.target);
  const log: ProxyLogEntry[] = [];

  const server = http.createServer((req, res) => {
    const entry: ProxyLogEntry = {
      ts: Date.now(),
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      req_bytes: 0,
      resp_bytes: 0,
      status: 0,
    };

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host') continue; // rewritten by http.request to the target
      if (k === 'connection') continue;
      headers[k] = v as string | string[];
    }

    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: req.url,
        method: req.method,
        headers,
      },
      (up) => {
        entry.status = up.statusCode ?? 0;
        // Forward the upstream response headers (except hop-by-hop ones).
        // http.pipe copies the BODY but not the headers — a missing
        // content-type would make the eval script's SSE reader misbehave.
        const skip = new Set(['transfer-encoding', 'connection', 'content-length']);
        for (const [k, v] of Object.entries(up.headers)) {
          if (skip.has(k.toLowerCase()) || v === undefined) continue;
          res.setHeader(k, v);
        }
        // Stream the response through untouched (chunked/SSE preserved).
        up.pipe(res);
        up.on('data', (c: Buffer) => (entry.resp_bytes += c.length));
        up.on('error', (err) => {
          entry.error = `upstream: ${err.message}`;
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
        });
      },
    );

    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      log.push(entry);
    };

    upstream.on('error', (err) => {
      entry.error = `target ${target.hostname}:${target.port || 80} unreachable: ${err.message}`;
      entry.status = entry.status || 502;
      if (!res.headersSent) {
        entry.status = 502;
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'llm target down', detail: entry.error }));
      } else {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
      record();
    });

    // Pipe the request body straight through (no buffering, no limits).
    req.on('data', (c: Buffer) => (entry.req_bytes += c.length));
    req.on('error', () => {
      upstream.destroy();
    });
    req.pipe(upstream);
    upstream.on('response', () => {
      record();
    });
    upstream.on('close', () => {
      // Fallback record if response/error didn't push (mid-stream reset).
      record();
    });
  });

  server.on('error', (err) => {
    // Bind failure (port taken) is fatal and must surface loudly.
    console.error(`[proxy] bind error: ${err.message}`);
  });

  // Bind now: 127.0.0.1 only, ephemeral when port is 0. Callers await the
  // 'listening' event (or just use base_url once it has fired).
  server.listen(opts.port, opts.host ?? '127.0.0.1');

  return {
    server,
    get port() {
      const a = server.address();
      return typeof a === 'object' && a ? a.port : opts.port;
    },
    get base_url() {
      const a = server.address();
      const p = typeof a === 'object' && a ? a.port : opts.port;
      return `http://127.0.0.1:${p}`;
    },
    log,
    drainLog() {
      const out = log.splice(0, log.length);
      return out;
    },
    stop() {
      return new Promise<void>((resolveStop) => {
        // Let in-flight requests finish (bounded) before closing.
        server.closeIdleConnections?.();
        server.close(() => resolveStop());
        setTimeout(() => {
          server.closeAllConnections?.();
          resolveStop();
        }, 2000).unref?.();
      });
    },
  };
}

/**
 * Wait until the proxy server is bound (polls `server.listening`).
 * `startLlmProxy` triggers `listen()` synchronously, so a late-attached
 * 'listening' listener can miss the event — polling is race-free.
 */
export function waitProxyReady(server: http.Server, timeoutMs = 10000): Promise<void> {
  return new Promise((resolveP, reject) => {
    const started = Date.now();
    const check = () => {
      if (server.listening) return resolveP();
      if (Date.now() - started > timeoutMs) return reject(new Error(`proxy not listening within ${timeoutMs}ms`));
      setTimeout(check, 10);
    };
    check();
  });
}

export { http };
