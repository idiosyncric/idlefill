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
 * Model aliases (#66, docs/architecture/model-aliases.md): an alias map
 * rides beside `catalogByName`, fed by the `model_aliases` sibling on the
 * SAME /api/state poll. Alias beats bare at routing and at /v1/models
 * (D2/D3). An alias whose `engine_model` differs from the requested name
 * splices the engine's own id into the body at the forward seam — AFTER
 * gate admission, so parked bodies stay unconsumed (the session-gate
 * invariant). The aliased class buffers the full body under a bounded cap
 * (413 over it) and forwards with a recomputed content-length (owner Q3
 * posture, 2026-10-06: the llama.cpp family drops chunked bodies). Every
 * non-aliased route keeps today's `req.pipe` posture byte-for-byte.
 *
 * The #45 trap this walks around: the model is sniffed from the FIRST
 * body chunk, then the chunk is put BACK (`unshift`) and the stream
 * paused, so a parked request keeps its body unconsumed and the
 * forward-on-admission pipes it intact. No standing `data` listener ever
 * attaches to a parked req.
 */

import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { SESSION_ID_HEADER, type ForwardFn, type SessionGate } from './session-gate.js';

/** One catalog row as the arbiter publishes it (the /api/state `catalog` ADD-key). */
export interface AggregateCatalogEntry {
  name: string;
  server_id: string;
  url: string;
  auth_set: boolean;
  catalog_source?: 'probed' | 'declared';
}

/**
 * One published alias as the arbiter resolves it (#66 D3: the
 * `model_aliases` ADD-key sibling of `catalog` on the same poll). The
 * winner pair is ALREADY applied server-side — the router never recomputes
 * it (mesh rule: published, not computed remotely). `engine_model` is the
 * winner row's OWN model id: the string the forward seam splices into the
 * body when the request named the alias.
 */
export interface AggregateAliasEntry {
  name: string;
  server_id: string;
  url: string;
  auth_set: boolean;
  engine_model: string;
  catalog_source: 'probed' | 'declared';
}

/**
 * #66 Q3 (owner-approved 2026-10-06): the aliased forward buffers the FULL
 * body so the splice can recompute a correct content-length — the llama.cpp
 * family drops chunked request bodies (live probe, doc D3 AMENDMENT). The
 * cap is generous (Hermes tool payloads run to megabytes) and an over-cap
 * body is refused with 413 BEFORE any engine sees a byte. Bare-name
 * traffic never buffers: today's `req.pipe` posture byte-for-byte.
 */
export const ALIAS_BODY_BUFFER_CAP = 64 * 1024 * 1024; // 64 MiB

/** One row of GET /api/server-keys (loopback-scoped pull, #64 D2). */
export interface ServerKeyRow {
  id: string;
  name: string;
  url: string;
  auth_token: string;
}

/**
 * #68: the set of AGENT-key digests the arbiter minted (sha256 hex of the
 * plaintext it handed out once). The pull carries DIGESTS only — the
 * router never sees a usable plaintext, and a stolen pull response cannot
 * be replayed: enforcement hashes what the CALLER presents and compares.
 */
export interface ClientKeyHashSet {
  hashes: string[];
}
export interface AggregateRouter {
  server: http.Server;
  port: number;
  base_url: string;
  /** Replace the routing catalog (from the /api/state poll). */
  updateCatalog(entries: AggregateCatalogEntry[]): void;
  /** Replace the routing alias map (#66 D3 — from the `model_aliases` ADD-key on the SAME poll). */
  updateAliases(entries: AggregateAliasEntry[]): void;
  /**
   * Replace the in-memory engine-key table (from GET /api/server-keys)
   * AND the agent-key digest set (#68, same pull — `client_key_hashes`).
   * An omitted/empty digest set = the key plane is OFF: today's posture,
   * any caller on this loopback listener passes.
   */
  updateKeys(rows: ServerKeyRow[], clientKeyHashes?: string[]): void;
  /** Current catalog size (tests + live check). */
  catalogSize(): number;
  /** Current alias size (tests + live check). */
  aliasSize(): number;
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
 * #66 D3 (as amended by the owner's Q3 scoped-buffer decision): splice the
 * quoted `model` value from the requested alias to the engine's OWN id.
 *
 * The regex is the SNIFF's own class, character for character
 * (`peekModelFromFirstChunk` above, `client/src/session-gate.ts:183-187`):
 * rewrite feasibility is therefore identical to routing feasibility — the
 * same find, the same class. Only the FIRST match is replaced, and only
 * when the value equals the requested name exactly. Everything before and
 * after the match rides byte-for-byte; the D1 write-side bound (no `"` no
 * `\`) makes a quote breakage impossible.
 *
 * Returns the buffer unchanged when the name is not found (defensive: the
 * engine then sees what the client sent, exactly like a non-aliased
 * forward of the same bytes).
 */
export function spliceModelName(body: Buffer, fromModel: string, toModel: string): Buffer {
  if (fromModel === toModel) return body;
  const text = body.toString('utf8');
  // Same class as the sniff; the name is escaped into a literal for the
  // find so a stored id with regex metacharacters cannot over-match.
  const needle = new RegExp('("model"\\s*:\\s*")(' + fromModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(")');
  const m = needle.exec(text);
  if (!m) return body;
  const [whole, open, name, close] = m;
  if (whole === undefined || open === undefined || name === undefined || close === undefined) return body;
  const at = text.indexOf(whole, m.index) + open.length;
  return Buffer.from(text.slice(0, at) + toModel + text.slice(at + name.length), 'utf8');
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
  /**
   * Test seam: override the aliased-body buffer cap (default
   * ALIAS_BODY_BUFFER_CAP). Production callers never pass it.
   */
  aliasBodyCapBytes?: number;
}): AggregateRouter {
  const log = opts.log ?? (() => {});
  const bodyCap = opts.aliasBodyCapBytes ?? ALIAS_BODY_BUFFER_CAP;
  const target = new URL(opts.defaultTarget);
  let catalog: AggregateCatalogEntry[] = [];
  const catalogByName = new Map<string, AggregateCatalogEntry>();
  // #66 D2: the alias map rides BESIDE the catalog map, fed by the
  // `model_aliases` sibling on the same poll. At routing it WINS over a
  // bare catalog entry of the same name (alias > bare precedence).
  let aliases: AggregateAliasEntry[] = [];
  const aliasByName = new Map<string, AggregateAliasEntry>();
  /** In-memory engine keys (#64 D2) — never persisted, never logged. */
  let keys = new Map<string, string>();
  /**
   * #68: digests (sha256 hex) of the idlefill-issued AGENT keys, from
   * the same loopback pull. Set non-empty = the plane is ON: every
   * request to this listener — including GET /v1/models — must present
   * `Authorization: Bearer <plaintext>` whose digest is in this set.
   * The router never holds a plaintext: it hashes what the CALLER
   * presents and compares digests, so a stolen pull response cannot be
   * replayed as a credential. Empty set = plane OFF (today's posture:
   * any caller passes).
   */
  let clientKeyDigests = new Set<string>();

  /** The Bearer token a caller presented (null = none / not a Bearer). */
  const bearerOf = (req: http.IncomingMessage): string | null => {
    const h = req.headers['authorization'];
    const v = Array.isArray(h) ? h[0] : h;
    if (typeof v !== 'string') return null;
    const m = /^Bearer\s+(.+)$/i.exec(v.trim());
    return m?.[1] ?? null;
  };

  /**
   * #68 gate: does this caller pass the agent-key check? True (pass) when
   * the plane is OFF. Answers the 401 itself when the plane is ON and the
   * presented digest is unknown — BEFORE the model list, the gate, and
   * any engine byte (no engine ever sees an unauthenticated request).
   */
  const agentAuthOk = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    if (clientKeyDigests.size === 0) return true;
    const presented = bearerOf(req);
    if (presented !== null) {
      const digest = createHash('sha256').update(presented).digest('hex');
      if (clientKeyDigests.has(digest)) return true;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized', hint: 'present an idlefill agent key: Authorization: Bearer idlk_…' }));
    return false;
  };

  /** Request headers minus the per-hop ones (identical posture for both forwards). */
  const copyRequestHeaders = (req: http.IncomingMessage, authToken?: string | null): Record<string, string | string[]> => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host') continue; // rewritten by the request
      if (k === 'connection') continue;
      headers[k] = v as string | string[];
    }
    // The row credential rides per request (#64 D2). No row token: the
    // client's own headers pass through untouched (today's behavior) —
    // UNLESS the #68 key plane is ON, where `null` STRIPS the caller's
    // Authorization entirely: an idlefill agent key is IDLEFILL's
    // credential, never the engine's, so forwarding it upstream is at
    // best useless and at worst an "Invalid API key" 401 from the engine
    // (the exact accounting-agent failure this plane closes).
    if (authToken) headers['authorization'] = `Bearer ${authToken}`;
    else if (authToken === null) delete headers['authorization'];
    return headers;
  };

  const upstreamOpts = (base: URL, req: http.IncomingMessage, headers: Record<string, string | string[]>) => ({
    protocol: base.protocol,
    hostname: base.hostname,
    port: base.port || (base.protocol === 'https:' ? 443 : 80),
    path: '', // filled by the caller (rawUrl, verbatim)
    method: req.method,
    headers,
  });

  /** The upstream-response plumbing, shared by the pipe and the buffered forward. */
  const relayUpstream = (up: http.IncomingMessage, res: http.ServerResponse): void => {
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
  };

  /**
   * #66 Q3 (owner-approved): the ALIASED forward — buffer the full body
   * under the cap, splice the quoted model name to the engine's OWN id,
   * forward with a recomputed `content-length`. Framing normalizes: a
   * chunked client gets a content-length (the llama.cpp family drops
   * chunked bodies — doc D3 AMENDMENT). An over-cap body is a 413; the
   * engine never sees a byte of it. Everything before and after the match
   * rides byte-for-byte (the D1 id bounds keep the JSON quoting intact).
   */
  const forwardBuffered = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawUrl: string,
    base: URL,
    authToken: string | null | undefined,
    fromModel: string,
    toModel: string,
  ): void => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return; // drain-and-discard: memory stays bounded until the client stops
      total += c.length;
      if (total > bodyCap) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'request body failed' }));
      }
    });
    req.on('end', () => {
      if (over) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'aliased request body over the rewrite cap',
            detail: `the alias rewrite buffers the body; cap ${bodyCap} bytes`,
          }),
        );
        return;
      }
      const body = Buffer.concat(chunks);
      const spliced = spliceModelName(body, fromModel, toModel);
      const headers = copyRequestHeaders(req, authToken);
      // The recomputed length replaces whatever the client sent (a
      // content-length of the OLD size would truncate/mangle the spliced
      // body; transfer-encoding must not ride alongside a length).
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      delete headers['Content-Length'];
      delete headers['Transfer-Encoding'];
      headers['content-length'] = String(spliced.length);
      const transport = base.protocol === 'https:' ? https : http;
      const upstream = transport.request(
        { ...upstreamOpts(base, req, headers), path: rawUrl },
        (up) => relayUpstream(up, res),
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
      upstream.end(spliced);
    });
    // The peek paused the stream (the #45 posture); a plain `data`
    // listener does NOT resume a paused stream (only pipe()/resume() do)
    // — so the buffered forward resumes it explicitly.
    req.resume();
  };

  /** Forward `req` to `base` (http/https per protocol), path verbatim, body PIPED untouched. */
  const forwardTo = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    base: URL,
    authToken?: string | null,
  ): void => {
    const headers = copyRequestHeaders(req, authToken);
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
      (up) => relayUpstream(up, res),
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
   * The gate's forward seam for one request. #67 changed WHERE the entry
   * is chosen: the returned ForwardFn resolves its entry AT CALL TIME
   * (via `entryFor`), not when this factory runs. A parked request
   * therefore carries no frozen target: the gate's release path calls
   * this at admission, and an operator engine pin written while the body
   * sat parked picks the pinned engine THEN (the body stays unconsumed —
   * the session-gate invariant, `client/src/session-gate.ts:286`).
   *
   * #66: an ALIAS-routed entry whose engine id differs from the requested
   * name takes the scoped buffered forward (Q3 owner posture). Every other
   * route — bare catalog entry, alias whose engine id EQUALS the name, the
   * default target — keeps today's `req.pipe` posture byte-for-byte.
   */
  const forwardFor =
    (entryFor: () => AggregateCatalogEntry | AggregateAliasEntry | PinEntry | undefined, requestedName?: string): ForwardFn =>
    (req, res, path) => {
      const entry = entryFor();
      if (entry) {
      const base = new URL(engineBase(entry.url) + '/');
      const token = keys.get(entry.server_id);
      // Row credential wins (#64). Keyless row + #68 plane ON: `null`
      // strips the caller's agent key from the upstream hop (idlefill
      // authenticates to the engine with the ROW's credential — or with
      // none; the agent's key never leaves the machine). Keyless row +
      // plane OFF: `undefined` = today's pass-through, byte-for-byte.
      const auth = token !== undefined && token !== '' ? token : clientKeyDigests.size > 0 ? null : undefined;
      const engineModel = 'engine_model' in entry ? entry.engine_model : undefined;
      if (engineModel !== undefined && requestedName !== undefined && engineModel !== requestedName) {
        forwardBuffered(req, res, path, base, auth, requestedName, engineModel);
        return;
      }
      forwardTo(req, res, path, base, auth);
      return;
    }
    // Default target (unknown/absent model): today's posture is the
    // caller's headers pass through. With the #68 plane ON the caller's
    // header is an IDLEFILL key — strip it here too, so it never rides to
    // an engine that never issued it.
    forwardTo(req, res, path, target, clientKeyDigests.size > 0 ? null : undefined);
    };

  /**
   * #67: an operator engine pin as the gate publishes it (the resolved
   * `engine_pin` block on the arbiter's session row — server_id + url +
   * engine_model when the pinned row serves the model under another id).
   * Structurally an aggregate entry minus the alias name/source.
   */
  type PinEntry = { server_id: string; url: string; engine_model?: string };

  /**
   * #67: the entry choice at CALL time for one request's key+model:
   * the session's pin when it holds one, else the catalog/alias dispatch
   * entry. A pin pointing at the SAME row the dispatch already chose is
   * a no-op (zero behavior change on an unpinned fleet — the resolver
   * path stays byte-for-byte). A pin whose `engine_model` differs from
   * the requested name takes the #66 splice: the alias-pair case, the
   * queued-switch brief's item 3 ("the splice lives in the forward seam,
   * and release calls forward").
   */
  const pinnedEntryFor = (
    key: string,
    model: string | undefined,
    fallback: AggregateCatalogEntry | AggregateAliasEntry | undefined,
  ): (() => AggregateCatalogEntry | AggregateAliasEntry | PinEntry | undefined) => {
    const gate = opts.gate;
    if (!gate) return () => fallback;
    return () => {
      const pin = gate.pinFor(key);
      if (!pin) return fallback;
      return { server_id: pin.server_id, url: pin.url, ...(pin.engine_model !== undefined ? { engine_model: pin.engine_model } : {}) };
    };
  };

  const serveModelList = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
    // The router answers from the catalog union — NEVER a passthrough
    // probe (D1). Bare names, first-row pin already applied upstream.
    // #66 D3 dedup: alias winners come FIRST, and a bare entry whose name
    // an alias shadows is skipped — one string still appears ONCE.
    const data = aliases.map((a) => ({ id: a.name, object: 'model', owned_by: a.server_id }));
    for (const e of catalog) {
      if (aliasByName.has(e.name)) continue; // the alias owns this name
      data.push({ id: e.name, object: 'model', owned_by: e.server_id });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data }));
  };

  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0] ?? rawUrl;

    // #68: the agent-key check runs FIRST — before the model list, before
    // the gate, before any body peek and before a single byte reaches an
    // engine. Plane off (no keys minted) = byte-for-byte today's flow.
    if (!agentAuthOk(req, res)) return;

    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      serveModelList(req, res);
      return;
    }

    const headerKey = cleanKey(req.headers[SESSION_ID_HEADER]);

    const dispatch = (model: string | undefined): void => {
      // #66 D2 precedence: the alias map WINS over a bare catalog entry of
      // the same name — at routing as well as at publish. An unknown or
      // absent model leaves the machine `llm_target` untouched (D6 fence).
      const alias = model ? aliasByName.get(model) : undefined;
      const entry = alias ?? (model ? catalogByName.get(model) : undefined);
      const key = headerKey ?? model;
      if (entry && key) opts.onSessionRoute?.(key, entry.server_id);
      // #67: the forward seam resolves its entry AT CALL TIME — at
      // dispatch for an admitted request, at ADMISSION for a parked one
      // (releaseHoldsOf calls the held ForwardFn then). An operator pin
      // written between park and release moves the target; the body was
      // never consumed and rides to the new engine whole.
      if (opts.gate && key) {
        // D5: aggregate traffic is session traffic — same gate, same cap,
        // overrides by derived key, fail-open.
        opts.gate.route(req, res, key, rawUrl, forwardFor(pinnedEntryFor(key, model, entry), model));
        return;
      }
      // Gate off (session_gate=false) or no identity to key on: still
      // model-routed when the catalog knows the model; unknown/absent
      // model falls to the machine's default target (today behavior).
      forwardFor(() => entry, model)(req, res, rawUrl);
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
    updateAliases(entries) {
      // Same defensive posture as updateCatalog: a malformed entry is
      // dropped, a repeated alias name keeps its FIRST entry. An empty /
      // absent block clears the map (the arbiter stopped publishing it —
      // every alias unpublished this tick, not a stale pin).
      aliases = [];
      aliasByName.clear();
      for (const e of Array.isArray(entries) ? entries : []) {
        if (!e || typeof e.name !== 'string' || e.name === '') continue;
        if (typeof e.server_id !== 'string' || e.server_id === '') continue;
        if (typeof e.url !== 'string' || e.url === '') continue;
        if (typeof e.engine_model !== 'string' || e.engine_model === '') continue;
        if (aliasByName.has(e.name)) continue;
        aliasByName.set(e.name, e);
        aliases.push(e);
      }
    },
    updateKeys(rows, clientKeyHashes) {
      keys = new Map<string, string>();
      for (const r of rows ?? []) {
        if (r && typeof r.id === 'string' && typeof r.auth_token === 'string' && r.auth_token !== '') {
          keys.set(r.id, r.auth_token);
        }
      }
      // #68: swap the digest set atomically with the engine keys (one
      // pull answers both). Malformed entries drop; a non-array = empty
      // set = plane OFF.
      clientKeyDigests = new Set<string>(
        Array.isArray(clientKeyHashes) ? clientKeyHashes.filter((h) => typeof h === 'string' && h !== '') : [],
      );
    },
    catalogSize() {
      return catalog.length;
    },
    aliasSize() {
      return aliases.length;
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

