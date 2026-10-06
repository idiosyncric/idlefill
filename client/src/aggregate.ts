/**
 * Aggregate inference endpoint (#64, doc D1/D3/D5): the daemon's SECOND
 * loopback listener (default 127.0.0.1:aggregate_port = 8800) inside the
 * SAME process, in front of the SAME SessionGate instance.
 *
 * Every Hermes profile points at `http://127.0.0.1:8800/v1`. This listener:
 *   - answers GET /v1/models from the arbiter-published catalog union
 *     (deduped bare names — NEVER a passthrough probe of one engine);
 *   - routes chat-completions by the body's `model` to the catalog row's
 *     engine, adding that row's Authorization header from the router's
 *     IN-MEMORY key table (pull-scoped loopback route #64 D2 — tokens
 *     are never persisted, never logged, never re-published);
 *   - falls back to the machine's default `llm_target` (exact today
 *     behavior) for an unknown/absent model or an empty catalog;
 *   - runs 8800 traffic through the SAME gate (D5: one shared slot cap —
 *     a second gate instance would double the cap against shared engines).
 *
 * Session identity (D3): the gate key is `X-Hermes-Session-Id` when
 * present, else the body's model name. The register heartbeat carries
 * `server_id` = the catalog-chosen row (D5: wrong row = wrong idle
 * folding/preemption) — the daemon records the pair via `onSessionRoute`
 * before the gate sees the request.
 *
 * The #45 trap this walks around: the model is sniffed from the FIRST
 * body chunk, then the chunk is put BACK (`unshift`) and the stream
 * paused, so a parked request keeps its body unconsumed and the
 * forward-on-admission pipes it intact. No standing `data` listener ever
 * attaches to a parked req.
 */

import http from 'node:http';
import https from 'node:https';
import { SESSION_ID_HEADER, type ForwardFn, type SessionGate } from './session-gate.js';

/** One catalog row as the arbiter publishes it (the /api/state `catalog` ADD-key). */
export interface AggregateCatalogEntry {
  name: string;
  server_id: string;
  url: string;
  auth_set: boolean;
  catalog_source?: 'probed' | 'declared';
}

/** One row of GET /api/server-keys (loopback-scoped pull, #64 D2). */
export interface ServerKeyRow {
  id: string;
  name: string;
  url: string;
  auth_token: string;
}

export interface AggregateRouter {
  server: http.Server;
  port: number;
  base_url: string;
  /** Replace the routing catalog (from the /api/state poll). */
  updateCatalog(entries: AggregateCatalogEntry[]): void;
  /** Replace the in-memory engine-key table (from GET /api/server-keys). */
  updateKeys(rows: ServerKeyRow[]): void;
  /** Current catalog size (tests + live check). */
  catalogSize(): number;
  stop(): Promise<void>;
}

/**
 * Engine base for a catalog url: the URL's ORIGIN with a trailing `/v1`
 * path stripped (operators paste OpenAI-style bases; the forwarded path
 * already starts with /v1/…). Unparseable urls fall back to the string.
 */
export function engineBase(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    const stripped = /\/v1$/i.test(path) ? path.slice(0, -3) : path;
    return `${u.protocol}//${u.host}${stripped}`;
  } catch {
    return url.replace(/\/+$/, '').replace(/\/v1$/i, '');
  }
}

/** Bound + sanitize a header-derived session key (same posture as the gate's cleanSessionId). */
function cleanKey(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.length > 128) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(s)) return undefined;
  return s;
}

/**
 * #45 posture: read the model name out of the body's FIRST chunk without
 * consuming the stream — the chunk goes back via `unshift` and the stream
 * pauses again, so a parked request still pipes its full body on
 * admission (the #45 wedge: a standing `data` listener drains a parked
 * req and the forward-on-admission never finishes).
 */
function peekModelFromFirstChunk(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolvePeek) => {
    let settled = false;
    const settle = (model: string | undefined): void => {
      if (settled) return;
      settled = true;
      req.removeListener('aborted', onEnd);
      req.removeListener('end', onEnd);
      req.removeListener('close', onEnd);
      req.pause(); // stop flowing again; the buffered body pipes on demand
      resolvePeek(model);
    };
    const onChunk = (chunk: Buffer): void => {
      req.removeListener('data', onChunk);
      req.unshift(chunk); // put the bytes BACK — body stays whole
      const text = chunk.toString('utf8');
      const m = /"model"\s*:\s*"([^"\\\x00-\x1f\x7f]{1,80})"/.exec(text);
      settle(m ? m[1] : undefined);
    };
    const onEnd = (): void => {
      req.removeListener('data', onChunk);
      settle(undefined);
    };
    req.once('aborted', onEnd);
    req.once('end', onEnd);
    req.once('close', onEnd);
    req.once('data', onChunk);
  });
}

/**
 * Start the aggregate listener. `gate` is the daemon's SAME SessionGate
 * instance (D5). With no gate (session_gate=false), traffic is routed
 * without admission control — still model-routed + catalog-served.
 */
export function startAggregateRouter(opts: {
  port: number;
  /** Machine default target — unknown/absent model falls here (exact today behavior). */
  defaultTarget: string;
  gate?: SessionGate | null;
  /** Fires when a request is keyed to a catalog row: (gate key, chosen server_id). */
  onSessionRoute?: (key: string, serverId: string) => void;
  log?: (msg: string) => void;
}): AggregateRouter {
  const log = opts.log ?? (() => {});
  const target = new URL(opts.defaultTarget);
  let catalog: AggregateCatalogEntry[] = [];
  const catalogByName = new Map<string, AggregateCatalogEntry>();
  /** In-memory engine keys (#64 D2) — never persisted, never logged. */
  let keys = new Map<string, string>();

  /** Forward `req` to `base` (http/https per protocol), path verbatim. */
  const forwardTo = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    base: URL,
    authToken?: string,
  ): void => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host') continue; // rewritten by the request
      if (k === 'connection') continue;
      headers[k] = v as string | string[];
    }
    // The row credential rides per request (#64 D2). No row token: the
    // client's own headers pass through untouched (today's behavior).
    if (authToken) headers['authorization'] = `Bearer ${authToken}`;

    const transport = base.protocol === 'https:' ? https : http;
    const upstream = transport.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path,
        method: req.method,
        headers,
      },
      (up) => {
        // #65: the engine's STATUS rides through too. Without this the
        // response stays at Node's default 200 while the engine's error
        // body arrives — an SDK sees 200 + no choices and reports an
        // empty stream. Fallback 502 only when the status is absent.
        res.statusCode = up.statusCode ?? 502;
        const skip = new Set(['transfer-encoding', 'connection', 'content-length']);
        for (const [k, v] of Object.entries(up.headers)) {
          if (skip.has(k.toLowerCase()) || v === undefined) continue;
          res.setHeader(k, v);
        }
        up.pipe(res);
        up.on('error', () => {
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
        });
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'llm target down', detail: `${base.hostname}: ${err.message}` }));
      } else {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  };

  /**
   * The gate's forward seam for one request: chosen row (or default
   * target). A parked request arrives here only on admission — its body
   * was never consumed (the peek unshifted its first chunk back).
   */
  const forwardFor = (entry: AggregateCatalogEntry | undefined): ForwardFn => (req, res, path) => {
    if (entry) {
      const base = new URL(engineBase(entry.url) + '/');
      const token = keys.get(entry.server_id);
      forwardTo(req, res, path, base, token !== undefined && token !== '' ? token : undefined);
      return;
    }
    forwardTo(req, res, path, target);
  };

  const serveModelList = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
    // The router answers from the catalog union — NEVER a passthrough
    // probe (D1). Bare names, first-row pin already applied upstream.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: catalog.map((e) => ({ id: e.name, object: 'model', owned_by: e.server_id })),
      }),
    );
  };

  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0] ?? rawUrl;

    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      serveModelList(req, res);
      return;
    }

    const headerKey = cleanKey(req.headers[SESSION_ID_HEADER]);

    const dispatch = (model: string | undefined): void => {
      const entry = model ? catalogByName.get(model) : undefined;
      const key = headerKey ?? model;
      if (entry && key) opts.onSessionRoute?.(key, entry.server_id);
      if (opts.gate && key) {
        // D5: aggregate traffic is session traffic — same gate, same cap,
        // overrides by derived key, fail-open.
        opts.gate.route(req, res, key, rawUrl, forwardFor(entry));
        return;
      }
      // Gate off (session_gate=false) or no identity to key on: still
      // model-routed when the catalog knows the model; unknown/absent
      // model falls to the machine's default target (today behavior).
      forwardFor(entry)(req, res, rawUrl);
    };

    if (headerKey) {
      // Identity from the header — no body peek needed for the key. The
      // target still follows the model when the catalog has one; peek the
      // first chunk (unshift-safe) to choose it.
      void peekModelFromFirstChunk(req).then((model) => dispatch(model));
      return;
    }
    if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') {
      // No body to derive a key from: default target, ungated (a GET has
      // no session body; today's passthrough posture).
      forwardTo(req, res, rawUrl, target);
      return;
    }
    void peekModelFromFirstChunk(req).then((model) => dispatch(model));
  });

  server.on('error', (err) => {
    // A bind failure (port taken) is LOUD but not fatal: the aggregate
    // endpoint is an extra listener — the 11435 proxy and the rest of the
    // daemon keep running without it (the daemon logs the reason and the
    // operator retargets aggregate_port).
    log(`aggregate bind error: ${err.message}`);
    console.error(`[aggregate] bind error: ${err.message}`);
  });

  // Bind 127.0.0.1 ONLY, exactly like the proxy (D1).
  server.listen(opts.port, '127.0.0.1');

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
    updateCatalog(entries) {
      // Defensive dedup on top of the arbiter's own: a bare name keeps its
      // FIRST entry (declaration order pins routing, D4 owner rule).
      catalog = [];
      catalogByName.clear();
      for (const e of Array.isArray(entries) ? entries : []) {
        if (!e || typeof e.name !== 'string' || e.name === '') continue;
        if (catalogByName.has(e.name)) continue;
        catalogByName.set(e.name, e);
        catalog.push(e);
      }
    },
    updateKeys(rows) {
      keys = new Map<string, string>();
      for (const r of rows ?? []) {
        if (r && typeof r.id === 'string' && typeof r.auth_token === 'string' && r.auth_token !== '') {
          keys.set(r.id, r.auth_token);
        }
      }
    },
    catalogSize() {
      return catalog.length;
    },
    stop() {
      return new Promise<void>((resolveStop) => {
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

