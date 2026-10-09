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
import { SESSION_PATH_RE, type SessionGate } from './session-gate.js';
import { handleClientProjects, type ClientProjectsOpts } from './client-projects.js';

/**
 * #78: `GET /sessions/<token>/transcript` — the read-only surface for the
 * router's per-session request ring (the session viewer's data source). Distinct
 * from the gate's `/s/<token>/...` passthrough (that regex requires `/s/`, so
 * `/sessions/...` can never be mistaken for session traffic). Token ≤128 chars
 * (the arbiter rule), matching the gate's token bound.
 */
const TRANSCRIPT_PATH_RE = /^\/sessions\/([^/]+)\/transcript$/;

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
  /**
   * Session gate (issue #9 Part A). When set, `/s/<token>/...` requests are
   * routed through it (register + admit-or-hold, then forwarded with the
   * `/s/<token>` prefix stripped). ALL other paths keep the exact
   * single-target passthrough below. Without a gate the proxy behaves
   * precisely as before.
   */
  gate?: SessionGate;
  /**
   * Client-config editor routes (#61 step 3 A3): when set, GET/PUT
   * `/client/projects` are answered ON THIS SAME loopback server (never
   * passthrough — the paths are the client's own control surface, guarded
   * Host/Origin/token inside handleClientProjects). Absent = the proxy
   * behaves exactly as before (the path falls to plain passthrough).
   */
  clientProjects?: ClientProjectsOpts;
}): LlmProxy {
  const target = new URL(opts.target);
  const log: ProxyLogEntry[] = [];

  /**
   * Forward `req` to the upstream at `path` (path is req.url for plain
   * passthrough, or the `/s/<token>`-stripped path for admitted session
   * traffic). The gate calls this when it admits a session — a parked
   * request's body was never consumed, so piping it here still works.
   */
  const forward = (req: http.IncomingMessage, res: http.ServerResponse, path: string): void => {
    const entry: ProxyLogEntry = {
      ts: Date.now(),
      method: req.method ?? 'GET',
      path,
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
        path,
        method: req.method,
        headers,
      },
      (up) => {
        entry.status = up.statusCode ?? 0;
        // #65: the engine's STATUS rides through too (entry.status already
        // captured it for the log — now it reaches the caller as well).
        res.statusCode = up.statusCode ?? 502;
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
  };

  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? '/';
    // Client-config editor (#61 step 3 A3): the client's own control
    // surface on this same loopback bind — answered BEFORE the session /
    // passthrough paths so config writes can never reach the LLM target.
    if (opts.clientProjects) {
      let u: URL;
      try {
        u = new URL(rawUrl, 'http://127.0.0.1');
      } catch {
        u = new URL('http://127.0.0.1/');
      }
      if (handleClientProjects(req, res, u, opts.clientProjects)) return;
    }
    const m = opts.gate ? SESSION_PATH_RE.exec(rawUrl) : null;
    // #78: the session viewer's read-only transcript surface. Answered BEFORE
    // the gate's `/s/<token>` dispatch (the path shapes don't collide — this
    // is `/sessions/<token>/transcript`, that is `/s/<token>/...`), and before
    // plain passthrough so the control-surface path never reaches the LLM
    // target. No gate configured ⇒ nothing to read ⇒ the same empty shape
    // (fail-quiet: an operator on a gate-less daemon sees no requests).
    if (req.method === 'GET' || req.method === 'HEAD') {
      const tm = TRANSCRIPT_PATH_RE.exec(rawUrl);
      if (tm) {
        let token = tm[1] ?? '';
        try {
          token = decodeURIComponent(token);
        } catch {
          /* malformed %xx: keep the raw token (the arbiter stores it verbatim) */
        }
        // Unknown / oversized token ⇒ the empty transcript (fail-quiet). An
        // oversized token is the arbiter's 400 rule, but on this READ surface
        // the honest answer is "no recorded requests", not an error — the
        // viewer is never wedged by a bad handle.
        const transcript =
          token && token.length <= 128 && opts.gate
            ? opts.gate.transcriptFor(token)
            : { token, requests: [], buckets: new Array<number>(10).fill(0) };
        const body = JSON.stringify(transcript);
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
    }
    if (opts.gate && m) {
      // Session traffic: /s/<token>/v1/... → gate, forwarded as /v1/...
      let token = m[1] ?? '';
      try {
        token = decodeURIComponent(token);
      } catch {
        /* malformed %xx: keep the raw token (arbiter stores it verbatim) */
      }
      const stripped = m[2] && m[2].length > 0 ? m[2] : '/';
      if (!token || token.length > 128) {
        // Arbiter rule: tokens are ≤128 chars. Reject loudly, don't gate.
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid session token' }));
        return;
      }
      opts.gate.route(req, res, token, stripped, forward);
      return;
    }
    // Everything else (notably plain /v1/... job traffic): exact passthrough.
    forward(req, res, rawUrl);
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
