/**
 * Aggregate inference endpoint (#64, doc D1/D3/D5): the daemon's SECOND
 * loopback listener (default 127.0.0.1:aggregate_port = 8800) inside the
 * SAME process, in front of the SAME SessionGate instance.
 *
 * Every Hermes profile points at `http://127.0.0.1:8800/v1`. This listener:
 *   - answers GET /v1/models with the CONFIGURED ALIASES only, in their
 *     priority order (the operator's curated surface — bare engine names an
 *     alias does not name are NOT advertised, though they still route);
 *   - routes chat-completions by the body's `model` to the catalog row's
 *     engine, adding that row's Authorization header from the router's
 *     IN-MEMORY key table (pull-scoped loopback route #64 D2 — tokens
 *     are never persisted, never logged, never re-published);
 *   - NEVER routes a named model to the machine's default `llm_target` —
 *     route-hold (owner posture 2026-10-18): a model name that resolves in
 *     neither map HOLDS (body unconsumed, before the gate, zero upstream
 *     bytes) until a poll makes it routable, then proceeds exactly like a
 *     request dispatched after the update; on hold-expiry it answers local
 *     503 `model_unavailable` (OpenAI body). A POST naming no model answers
 *     local 400 `invalid_request_error`. `llm_target` remains the
 *     GET/DELETE/HEAD passthrough base only (it never receives POST bytes);
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
 * The #45 trap this walks around: the model is sniffed from the body
 * WITHOUT consuming it — the sniffed chunks go back (`unshift`) and the
 * stream pauses again, so a parked request keeps its body unconsumed and
 * the forward-on-admission pipes it intact. No standing `data` listener
 * ever attaches to a parked req. Since 2026-10-18 the sniff ACCUMULATES
 * chunks until the `"model"` field matches (the first-chunk-only sniff
 * could miss the field when a huge leading value pushed it past the first
 * TCP chunk — that miss is the 2026-10-18 hypnotist incident).
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
  /** #87 D2: observed capabilities, ADD keys, omitted when unknown. */
  context_length?: number;
  input_modalities?: string[];
  output_modalities?: string[];
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
  /**
   * #87 D2/D3: winner-pair capabilities as the arbiter observed them,
   * ADD keys, omitted when unknown. The advertised /v1/models entry
   * carries them; the winner's variant id stays dashboard-only (D3).
   */
  context_length?: number;
  input_modalities?: string[];
  output_modalities?: string[];
   /**
    * Health-ordered fall-through (docs/architecture/engine-health-routing.md
    * D2): present (true) when the published winner is NOT the stored pin.
    * The router ignores it; it rides the same poll for the dashboard.
    */
  fallback?: boolean;
  /**
   * alias-stability D1/D3: the arbiter-published failover surface — the
   * OTHER alias pairs (stored order, winner excluded), each exactly
   * `{server_id, url, engine_model}` and NO token by construction (the
   * client already pulls per-row tokens via /api/server-keys). The D3
   * watchdog failover consumes this; `updateAliases` validates every
   * element (malformed elements drop; a malformed array = the key is
   * absent — the entry itself still routes on its winner pair).
   */
  fallback_targets?: AggregateAliasFallbackTarget[];
}

/** One published failover target (alias-stability D1 shape; token never). */
export interface AggregateAliasFallbackTarget {
  server_id: string;
  url: string;
  engine_model: string;
}

/**
 * Egress self-diagnosis: one recent connection-level forward failure against
 * a catalog row. The silent-failure case this exists for: an engine-local
 * view (arbiter state, peer snapshots) can stay green while THIS process
 * cannot open a single socket to the engine (firewall block, dead route —
 * the 2026-10-18 Little Snitch incident: every hypnotist request died as a
 * 502 `llm target down` while every dashboard tile looked healthy). The
 * router answers the 502 either way; the difference now is that the pair
 * (server_id, errno) is RECORDED here, aged out on recovery, published on
 * the register heartbeat as `egress_failures`, and rendered by the
 * dashboard — the machine itself testifies when its own egress is broken.
 */
export interface AggregateEgressFailure {
  server_id: string;
  /** The Node errno code of the failed connect (EHOSTUNREACH, EACCES, …). */
  code: string;
  /** The engine host the connect attempted (hostname only — no path, no token). */
  host: string;
  /** Epoch-ms of the failed connect. */
  at: number;
}

/**
 * Egress self-diagnosis: which errno codes count as "this process could not
 * reach the row". The set is connection-level on purpose: HTTP statuses
 * (even 401/500) PROVE egress and record nothing; these codes mean the
 * socket itself failed — refused/reset (row down), unreachable/un-net/
 * timeout (route or firewall), EACCES (a local policy DENIED the connect —
 * the exact firewall signature), DNS (ENOENT/EAI_AGAIN). EPIPE (mid-stream
 * reset after bytes flowed) is NOT egress failure and records nothing.
 */
const EGRESS_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ENETHOSTDOWN',
  'ETIMEDOUT',
  'EACCES',
  'ENOENT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** Egress self-diagnosis: how long a recorded failure stays publishable.
 *  A row that answers again clears its entry at the response seam, so the
 *  TTL only ages out entries no one exercised (a quiet row is not proof of
 *  recovery — but 15 min without traffic is not worth a badge either). */
export const EGRESS_FAILURE_TTL_MS = 15 * 60_000;

/** Egress self-diagnosis: heartbeat publish cap (rows per machine). */
export const EGRESS_FAILURE_CAP = 8;

/**
 * alias-stability D3: validate the published `fallback_targets` array
 * (drop-don't-reject, the established posture): a non-array = undefined
 * (the key is absent); a malformed element drops individually; an empty
 * result normalizes to absent (the arbiter omits empty too).
 */
export function sanitizeAliasFallbackTargets(v: unknown): AggregateAliasFallbackTarget[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AggregateAliasFallbackTarget[] = [];
  for (const t of v) {
    if (!t || typeof t !== 'object') continue;
    const e = t as Record<string, unknown>;
    if (typeof e.server_id !== 'string' || e.server_id === '') continue;
    if (typeof e.url !== 'string' || e.url === '') continue;
    if (typeof e.engine_model !== 'string' || e.engine_model === '') continue;
    out.push({ server_id: e.server_id, url: e.url, engine_model: e.engine_model });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * alias-stability D3: how fresh a queue digest entry may be to count as
 * live evidence ("the engine is demonstrably still working"). Older =
 * unknown = the failover decision ignores it.
 */
export const QUEUE_DIGEST_FRESH_MS = 20_000;

/**
 * #66 Q3 (owner-approved 2026-10-06): the aliased forward buffers the FULL
 * body so the splice can recompute a correct content-length — the llama.cpp
 * family drops chunked request bodies (live probe, doc D3 AMENDMENT). The
 * cap is generous (Hermes tool payloads run to megabytes) and an over-cap
 * body is refused with 413 BEFORE any engine sees a byte. Bare-name
 * traffic never buffers: today's `req.pipe` posture byte-for-byte.
 */
export const ALIAS_BODY_BUFFER_CAP = 64 * 1024 * 1024; // 64 MiB

/**
 * route-hold (owner posture 2026-10-18): the default hold window — how long
 * a request naming an unresolvable model waits for a serving engine to
 * appear before the named 503. 120 s mirrors the session gate's hold cap
 * (the arbiter re-publishes every ~15 s, so one poll cycle is minutes away
 * from a whole window). Configurable via `aggregate_route_wait_ms`; `0`
 * means "no hold — answer the named 503 at once".
 */
export const ROUTE_HOLD_DEFAULT_MS = 120_000;

/** route-hold: the hard ceiling on `aggregate_route_wait_ms` (garbage-proof). */
export const ROUTE_HOLD_MAX_MS = 15 * 60_000;

/**
 * route-hold: how many requests may wait on unresolvable names at once.
 * Beyond the cap a request answers the named 503 immediately (the queue is
 * a churn absorber, not an unbounded park lot — a dead engine for minutes
 * with a retry-looping client must not pile up unbounded held sockets).
 */
export const ROUTE_HOLD_CAP = 64;

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
  /**
   * alias-stability D3: replace the per-server queue-depth digest
   * (`server_id → {depth, observed_at}`), fed from the arbiter's published
   * load row on the SAME /api/state poll. A row whose `queue_depth` is
   * absent (non-oMLX engines) stores NO entry; a poll FAILURE leaves the
   * last digest in place — staleness is handled by AGE (≤ QUEUE_DIGEST_FRESH_MS
   * counts as live evidence), never by clearing. `observedAt` is a test
   * seam (the digest stamp defaults to Date.now()); production never passes it.
   */
  updateQueueDepths(rows: { server_id: string; queue_depth?: number }[], observedAt?: number): void;
  /** Current catalog size (tests + live check). */
  catalogSize(): number;
  /** Current alias size (tests + live check). */
  aliasSize(): number;
  /**
   * Egress self-diagnosis: the recent connection-level forward failures this
   * process observed, per row (freshest first, ≤ EGRESS_FAILURE_CAP, aged at
   * EGRESS_FAILURE_TTL_MS). The register heartbeat publishes this verbatim as
   * `egress_failures` — an EMPTY array is still returned (and published)
   * when nothing is failing: the explicit empty report is what CLEARS the
   * arbiter's stored exception (the client_log rule).
   */
  egressFailures(): AggregateEgressFailure[];
  /**
   * Egress self-test: the engine rows this router routes to (catalog +
   * aliases + published failover targets, deduped by server_id, first url
   * wins) — the probe list the loopback `/client/egress-test` surface walks.
   */
  engineRows(): { server_id: string; url: string }[];
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
 * (`peekModelName` above, `client/src/session-gate.ts:183-187`):
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
 * How far into a body the model sniff reads before it gives up. A JSON body
 * that carries no `"model"` field within this prefix is treated as naming no
 * model. 1 MiB is far past every real chat body's sniff horizon while staying
 * cheap (the bytes stay in the stream, never copied out of it).
 */
export const MODEL_PEEK_SCAN_CAP = 1024 * 1024;

/**
 * #45 posture: read the model name out of the body WITHOUT consuming it —
 * the sniffed chunks go back via `unshift` and the stream pauses again, so a
 * parked request keeps its body unconsumed and the forward-on-admission pipes
 * it intact (the #45 wedge: a standing `data` listener drains a parked req
 * and the forward-on-admission never finishes).
 *
 * SNIFF 2.0 (2026-10-18): the sniff ACCUMULATES chunks until the `"model"`
 * field matches — reading ONLY the first TCP chunk misses the field whenever
 * a huge leading value (a tool-result-heavy conversation) pushes it past that
 * chunk. That miss is the 2026-10-18 hypnotist incident: the unnamed request
 * fell to the machine default target, arrived at a keyed oMLX with the agent
 * key stripped, and died as a baffling 401. Settles `undefined` only when the
 * body ENDS (or aborts/closes) without the field inside the scan window —
 * never just because the first chunk lacked it.
 */
function peekModelName(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolvePeek) => {
    let settled = false;
    let scanned = 0;
    const chunks: Buffer[] = [];
    const settle = (model: string | undefined): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onChunk);
      req.removeListener('aborted', onEnd);
      req.removeListener('end', onEnd);
      req.removeListener('close', onEnd);
      if (chunks.length > 0) req.unshift(Buffer.concat(chunks)); // put the bytes BACK — body stays whole
      req.pause(); // stop flowing again; the buffered body pipes on demand
      resolvePeek(model);
    };
    const onChunk = (chunk: Buffer): void => {
      chunks.push(chunk);
      scanned += chunk.length;
      const text = Buffer.concat(chunks).toString('utf8');
      const m = /"model"\s*:\s*"([^"\\\x00-\x1f\x7f]{1,80})"/.exec(text);
      // Only the field itself can settle a MATCH; absence settles only at
      // the end of the body or the scan window (a split field must not read
      // as "no model" — the incident shape).
      if (m) settle(m[1]);
      else if (scanned >= MODEL_PEEK_SCAN_CAP) settle(undefined);
    };
    const onEnd = (): void => settle(undefined);
    req.on('aborted', onEnd);
    req.on('end', onEnd);
    req.on('close', onEnd);
    req.on('data', onChunk);
  });
}

/**
 * Start the aggregate listener. `gate` is the daemon's SAME SessionGate
 * instance (D5). With no gate (session_gate=false), traffic is routed
 * without admission control — still model-routed + catalog-served.
 */
export function startAggregateRouter(opts: {
  port: number;
  /** Machine default target — since route-hold (2026-10-18) ONLY the
   *  GET/DELETE/HEAD no-body passthrough lands here; a named POST never
   *  does (it routes by name or holds). */
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
  /**
   * alias-stability D3: slow-engine policy from the client config
   * (`aggregate_slow_handling`). `'wait'` (default) = today's flow
   * byte-for-byte — NO timer is ever installed. `'failover'` arms the
   * TTFB watchdog on the BUFFERED aliased forward only.
   */
  slowHandling?: 'wait' | 'failover';
  /**
   * alias-stability D3: `aggregate_ttfb_timeout_ms` — time to first
   * upstream response headers before the watchdog fires. Absent/0/garbage
   * = the watchdog is OFF (even in `failover` mode: both keys must agree).
   */
  ttfbTimeoutMs?: number;
  /**
   * alias-stability D3: `aggregate_queue_depth_cap` — queue-suppression
   * cap; a FRESH digest with 0 < depth < cap means the engine is
   * demonstrably still working → extend the wait, never fail over.
   */
  queueDepthCap?: number;
  /**
   * route-hold (owner posture 2026-10-18): `aggregate_route_wait_ms` — how
   * long a request naming a model with NO resolvable engine waits for one to
   * appear (a republished alias/catalog pair, a mesh row returning) before
   * the named 503. Absent = ROUTE_HOLD_DEFAULT_MS; `0` disables the hold
   * (immediate named 503). The machine default target never receives a
   * named POST at either setting.
   */
  routeHoldMs?: number;
}): AggregateRouter {
  const log = opts.log ?? (() => {});
  const bodyCap = opts.aliasBodyCapBytes ?? ALIAS_BODY_BUFFER_CAP;
  const slowHandling: 'wait' | 'failover' = opts.slowHandling === 'failover' ? 'failover' : 'wait';
  const ttfbTimeoutMs =
    typeof opts.ttfbTimeoutMs === 'number' && Number.isFinite(opts.ttfbTimeoutMs) && opts.ttfbTimeoutMs > 0
      ? Math.floor(opts.ttfbTimeoutMs)
      : 0;
  const queueDepthCap =
    typeof opts.queueDepthCap === 'number' && Number.isFinite(opts.queueDepthCap)
      ? Math.max(0, Math.floor(opts.queueDepthCap))
      : 3;
  /** D3: the watchdog runs only when BOTH knobs agree (failover + a real deadline). */
  const watchdogActive = slowHandling === 'failover' && ttfbTimeoutMs > 0;
  const target = new URL(opts.defaultTarget);
  /**
   * Egress self-diagnosis: server_id → the last connection-level forward
   * failure this process saw against that row. One entry per row (the
   * latest), replaced on every new failure, DELETED the moment a forward
   * to that row gets ANY upstream response (headers are proof the socket
   * works). Never persisted, never logged with a token — the entry is
   * (server_id, errno, host, at), nothing else.
   */
  const egressFailures = new Map<string, AggregateEgressFailure>();
  const noteForwardError = (serverId: string | undefined, base: URL, err: Error): void => {
    if (serverId === undefined || serverId === '') return;
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code !== 'string' || !EGRESS_CODES.has(code)) return;
    egressFailures.set(serverId, { server_id: serverId, code, host: base.hostname, at: Date.now() });
  };
  const noteForwardOk = (serverId: string | undefined): void => {
    if (serverId !== undefined && egressFailures.delete(serverId)) {
      log(`aggregate: egress recovered for ${serverId}`);
    }
  };
  let catalog: AggregateCatalogEntry[] = [];
  const catalogByName = new Map<string, AggregateCatalogEntry>();
  // #66 D2: the alias map rides BESIDE the catalog map, fed by the
  // `model_aliases` sibling on the same poll. At routing it WINS over a
  // bare catalog entry of the same name (alias > bare precedence).
  let aliases: AggregateAliasEntry[] = [];
  const aliasByName = new Map<string, AggregateAliasEntry>();
  /**
   * alias-stability D2 (2026-10-12): every alias name EVER accepted into
   * the routing map, process-lifetime, MONOTONIC — never removed. An
   * empty/absent publish block still CLEARS the routing map (no stale pin),
   * but it must not wipe the memory that this name is CONFIGURED on the
   * machine. Since route-hold (2026-10-18) closes the `llm_target`
   * fall-through for EVERY named request, this set no longer gates routing
   * — it only feeds the named 503's wording (a name EVER configured reads
   * "configured … no engine currently serves it").
   */
  const configuredAliasNames = new Set<string>();
  /**
   * route-hold (2026-10-18): the same monotonic memory for BARE catalog
   * names — every name EVER accepted into the catalog, process-lifetime.
   * Feeds the 503 wording only (a name this machine has ever served reads
   * "configured … no engine currently serves it"; one it never knew reads
   * "not served by any engine on this machine"). Routing never consults it:
   * route-hold holds EVERY unresolvable named request, seen or not.
   */
  const configuredCatalogNames = new Set<string>();
  /**
   * route-hold (owner posture 2026-10-18): requests naming a model that
   * resolves in NEITHER map wait HERE — never at `llm_target`. Each hold
   * carries the dispatch continuation closed over an UNCONSUMED body (the
   * #45 sniff posture), so a release forwards exactly what a post-update
   * dispatch would have: same precedence, same gate, same splice, same
   * `onSessionRoute`. `updateCatalog`/`updateAliases` flush after every map
   * swap; a hold-expiry answers the named 503; a client abort drops it.
   */
  interface RouteHold {
    model: string;
    req: http.IncomingMessage;
    res: http.ServerResponse;
    rawUrl: string;
    headerKey: string | undefined;
    since: number;
    timer: ReturnType<typeof setTimeout>;
    /** Remove this hold from the queue (once — the second call is a no-op).
     *  True = THIS call removed it; false = someone else already did. */
    drop: () => boolean;
  }
  const routeHolds: RouteHold[] = [];
  /** Sanitized `aggregate_route_wait_ms` (absent/garbage → the default; `0` = hold OFF). */
  const routeHoldMs = (() => {
    const v = opts.routeHoldMs;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.min(Math.floor(v), ROUTE_HOLD_MAX_MS);
    return ROUTE_HOLD_DEFAULT_MS;
  })();
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

  /**
   * alias-stability D3: the per-server queue-depth digest
   * (`server_id → {depth, at}`), fed from the arbiter's published load row
   * on the same /api/state poll. A poll FAILURE leaves the last digest —
   * staleness is handled by AGE (`at`, fresh ≤ QUEUE_DIGEST_FRESH_MS). Read
   * only by the watchdog's queue-suppression decision (failover mode).
   */
  let queueDigest = new Map<string, { depth: number; at: number }>();

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

  /**
   * The upstream credential for one server row (#64 D2 + #68): row
   * credential wins; keyless row + agent-key plane ON = `null` (STRIP the
   * caller's idlefill key — it is IDLEFILL's credential, never the
   * engine's); keyless row + plane OFF = `undefined` (pass-through,
   * today's posture). Shared by the dispatch seam and the D3 failover
   * rebuild — the retry authenticates EXACTLY like the primary would.
   */
  const authFor = (serverId: string): string | null | undefined => {
    const token = keys.get(serverId);
    return token !== undefined && token !== '' ? token : clientKeyDigests.size > 0 ? null : undefined;
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
  /**
   * One buffered dispatch: recomputed content-length (a length of the OLD
   * size would truncate/mangle a spliced body; transfer-encoding must not
   * ride alongside a length), transport per protocol, body written whole.
   * Shared by today's plain forward AND the D3 watchdog retry — the
   * replay rebuilds with the SAME machinery, only a different base/body/
   * credential.
   */
  const sendBuffered = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawUrl: string,
    base: URL,
    authToken: string | null | undefined,
    body: Buffer,
    onResponse?: (up: http.IncomingMessage) => void,
    onError?: (err: Error) => void,
    /** Egress self-diagnosis: the row this dispatch targets (undefined = the
     *  machine default target — no row, nothing to record). */
    serverId?: string,
  ): http.ClientRequest => {
    const headers = copyRequestHeaders(req, authToken);
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    delete headers['Content-Length'];
    delete headers['Transfer-Encoding'];
    headers['content-length'] = String(body.length);
    const transport = base.protocol === 'https:' ? https : http;
    const upstream = transport.request(
      { ...upstreamOpts(base, req, headers), path: rawUrl },
      (up) => {
        noteForwardOk(serverId); // any response = the socket works
        (onResponse ?? ((u: http.IncomingMessage) => relayUpstream(u, res)))(up);
      },
    );
    upstream.on('error', (err) => {
      noteForwardError(serverId, base, err);
      if (onError) {
        onError(err);
        return;
      }
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
    upstream.end(body);
    return upstream;
  };

  const forwardBuffered = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawUrl: string,
    base: URL,
    authToken: string | null | undefined,
    fromModel: string,
    toModel: string,
    /**
     * alias-stability D3: the failover context for this dispatch — the
     * chosen row's server_id (queue-digest lookup) and, for an ALIAS entry,
     * its published `fallback_targets`. Absent = the watchdog may still
     * WATCH (the body is replayable) but there is nothing to fail over to.
     */
    failoverCtx?: { serverId: string; fallbackTargets?: AggregateAliasFallbackTarget[] },
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
      if (!watchdogActive) {
        // BYTE-FOR-BYTE fence (D3 rule 6): `wait` mode or watchdog-off
        // installs NO timer — today's flow exactly, socket errors only.
        // (Egress self-diagnosis rides the seams: recording adds no byte and
        // no timer — the fence holds.)
        sendBuffered(req, res, rawUrl, base, authToken, spliced, undefined, undefined, failoverCtx?.serverId);
        return;
      }
      // alias-stability D3 — the TTFB watchdog, THIS forward only (the
      // aliased body is fully buffered, so it is replayable; `forwardTo`
      // pipes bytes that are not). The timer starts at dispatch and is
      // cleared FOREVER once ANY upstream response (even an error status)
      // arrives: never retry after the first byte.
      let timer: NodeJS.Timeout | undefined;
      let failoverUsed = 0; // exactly ONE retry, no chains
      // Identity, not a flag: replacing the object silences every callback
      // of an abandoned dispatch (its error must not answer a 502 mid-
      // failover, its response must not relay over a newer attempt).
      let ctx: { serverId?: string } = failoverCtx ? { serverId: failoverCtx.serverId } : {};
      let current: http.ClientRequest | undefined;

      const clearTimer = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      const timeoutBody = (): string =>
        JSON.stringify({
          error: {
            message: `model "${fromModel}" upstream timed out before the first byte (${ttfbTimeoutMs}ms)`,
            type: 'upstream_timeout',
            code: 'upstream_timeout',
            model: fromModel,
          },
        });
      const dispatch = (b: URL, sentBody: Buffer, auth: string | null | undefined, serverId?: string): void => {
        ctx = serverId !== undefined ? { serverId } : {};
        const self = ctx;
        current = sendBuffered(
          req,
          res,
          rawUrl,
          b,
          auth,
          sentBody,
          (up) => {
            if (ctx !== self) return; // an abandoned dispatch never relays over a newer one
            noteForwardOk(serverId); // egress self-diagnosis: THIS attempt got a response
            clearTimer(); // response headers — the watchdog is DISARMED forever, the relay stands
            relayUpstream(up, res);
          },
          (err) => {
            if (ctx !== self) return; // destroyed by failover: its error is silence, not our event
            noteForwardError(serverId, b, err); // egress self-diagnosis: only the CURRENT attempt's socket truth
            clearTimer();
            if (!res.headersSent) {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'llm target down', detail: `${b.hostname}: ${err.message}` }));
            } else {
              try {
                res.destroy();
              } catch {
                /* ignore */
              }
            }
          },
        );
        timer = setTimeout(onFire, ttfbTimeoutMs);
        timer.unref?.();
      };
      const onFire = (): void => {
        // Queue suppression FIRST: a FRESH digest with 0 < depth < cap
        // proves the engine is demonstrably working — extend the wait,
        // repeatable, never fail over. Stale/zero/over-cap → failover
        // eligible.
        const d = ctx.serverId ? queueDigest.get(ctx.serverId) : undefined;
        if (d && Date.now() - d.at <= QUEUE_DIGEST_FRESH_MS && d.depth > 0 && d.depth < queueDepthCap) {
          log(`aggregate: alias ${fromModel} queue depth ${d.depth} — extending wait`);
          timer = setTimeout(onFire, ttfbTimeoutMs);
          timer.unref?.();
          return;
        }
        const fb = (failoverCtx?.fallbackTargets ?? []).find((t) => typeof t.url === 'string' && t.url !== '');
        if (current) {
          ctx = {}; // identity swap: every callback of the doomed dispatch goes silent
          try {
            current.destroy();
          } catch {
            /* ignore */
          }
        }
        if (!fb || failoverUsed >= 1) {
          // No usable target at fire time (or the ONE retry already spent):
          // a clean local 504 — headers not yet sent, nothing consumed.
          if (!res.headersSent) {
            res.writeHead(504, { 'content-type': 'application/json' });
            res.end(timeoutBody());
          } else {
            try {
              res.destroy();
            } catch {
              /* ignore */
            }
          }
          return;
        }
        failoverUsed += 1;
        log(`aggregate: alias ${fromModel} ttfb > ${ttfbTimeoutMs}ms → failover ${fb.server_id}/${fb.engine_model}`);
        // The SAME already-buffered body, spliced from the requested name
        // to THAT entry's engine_model, authenticated exactly like the
        // primary (row token > #68 null-strip > pass-through).
        dispatch(new URL(engineBase(fb.url) + '/'), spliceModelName(body, fromModel, fb.engine_model), authFor(fb.server_id), fb.server_id);
      };
      dispatch(base, spliced, authToken, failoverCtx?.serverId);
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
    /** Egress self-diagnosis: the row this forward targets (undefined = the
     *  machine default target — no row, nothing to record). */
    serverId?: string,
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
      (up) => {
        noteForwardOk(serverId); // egress self-diagnosis: any response = the socket works
        relayUpstream(up, res);
      },
    );
    upstream.on('error', (err) => {
      noteForwardError(serverId, base, err);
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
   * route — bare catalog entry, alias whose engine id EQUALS the name —
   * keeps today's `req.pipe` posture byte-for-byte. (The old default-target
   * route through here is gone: route-hold holds named traffic, and the
   * GET/DELETE/HEAD passthrough uses `forwardTo` directly.)
   */
  const forwardFor =
    (entryFor: () => AggregateCatalogEntry | AggregateAliasEntry | PinEntry | undefined, requestedName?: string): ForwardFn =>
    (req, res, path) => {
      const entry = entryFor();
      if (entry) {
      const base = new URL(engineBase(entry.url) + '/');
      // Row credential wins (#64). Keyless row + #68 plane ON: `null`
      // strips the caller's agent key from the upstream hop (idlefill
      // authenticates to the engine with the ROW's credential — or with
      // none; the agent's key never leaves the machine). Keyless row +
      // plane OFF: `undefined` = today's pass-through, byte-for-byte.
      const auth = authFor(entry.server_id);
      const engineModel = 'engine_model' in entry ? entry.engine_model : undefined;
      if (engineModel !== undefined && requestedName !== undefined && engineModel !== requestedName) {
        // alias-stability D3: the buffered forward carries the row's
        // failover context — an ALIAS entry its published `fallback_targets`
        // (a PIN entry watched only: its pin IS the operator's override,
        // the alias's other pairs are not its fallback surface).
        // (Catalog rows and pin blocks never carry the key — only an
        // alias entry can, so the cast reads an absent key as undefined.)
        const targets = (entry as AggregateAliasEntry).fallback_targets;
        forwardBuffered(req, res, path, base, auth, requestedName, engineModel, {
          serverId: entry.server_id,
          ...(targets ? { fallbackTargets: targets } : {}),
        });
        return;
      }
      forwardTo(req, res, path, base, auth, entry.server_id);
      return;
    }
    // route-hold (owner posture 2026-10-18): UNREACHABLE by construction —
    // dispatch holds an unresolvable name until it resolves, so every entry
    // reaching the forward seam exists. Kept as a LOUD local answer rather
    // than the old `llm_target` fall-through: the fall-through is closed at
    // every seam, so no future slip can resurrect the 2026-10-12/2026-10-18
    // shape (a named request stripped to an unrelated keyed engine).
    log(`aggregate: unreachable no-entry forward for ${requestedName ?? '<no model>'} — answered locally, llm_target untouched`);
    if (!res.headersSent) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message:
              requestedName !== undefined
                ? `model "${requestedName}" is configured on this machine but no engine currently serves it`
                : 'request names no model and idlefill never routes to the machine default target',
            type: 'model_unavailable',
            code: 'model_unavailable',
            model: requestedName ?? null,
          },
        }),
      );
    }
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
      // route-hold made `fallback` total for NAMED traffic (dispatch holds
      // until an entry exists); an undefined fall-through here would be a
      // bug, and forwardFor answers it LOCALLY — never to `llm_target`.
      // #67 acceptance guard (drop-don't-reject, the documented posture
      // for an unprovable pin): an ALIAS-named request needs the pinned
      // row's OWN engine id for the splice. A block without
      // `engine_model` cannot name it — the session's model was not
      // sniffed yet when the arbiter resolved the block (first
      // heartbeats carry no history.model). Honoring such a pin blindly
      // forwards the alias name to an engine that does not serve it
      // (live: 404 model_not_found at the pinned row). Fall through to
      // the alias entry; the block re-publishes complete once the model
      // is known and the pin then lands exactly as written.
      if (model && aliasByName.has(model) && !('engine_model' in pin)) return fallback;
      return { server_id: pin.server_id, url: pin.url, ...(pin.engine_model !== undefined ? { engine_model: pin.engine_model } : {}) };
    };
  };

  /** Route precedence (#66 D2): the alias map WINS over a bare catalog row of
   *  the same name — at routing as well as at publish. */
  const resolveEntry = (model: string | undefined): AggregateCatalogEntry | AggregateAliasEntry | undefined =>
    model === undefined ? undefined : aliasByName.get(model) ?? catalogByName.get(model);

  /** The ONE seam a RESOLVED request proceeds through: heartbeat → gate
   *  (D5, same slot cap) → forward (#67: the entry is re-resolved at call
   *  time so an operator pin written between park and release moves it).
   *  A released hold enters HERE — byte-identical to a post-update dispatch. */
  const proceed = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawUrl: string,
    headerKey: string | undefined,
    model: string,
    entry: AggregateCatalogEntry | AggregateAliasEntry,
  ): void => {
    const key = headerKey ?? model;
    if (key) opts.onSessionRoute?.(key, entry.server_id);
    if (opts.gate && key) {
      opts.gate.route(req, res, key, rawUrl, forwardFor(pinnedEntryFor(key, model, entry), model));
      return;
    }
    forwardFor(() => entry, model)(req, res, rawUrl);
  };

  /** route-hold: the named 503. The exact OpenAI-style body, error.model
   *  echoes the name; a name this machine has EVER served (alias or catalog)
   *  reads as configured. ZERO bytes upstream — `llm_target` never sees it. */
  const answerUnavailable = (res: http.ServerResponse, model: string): void => {
    if (res.writableEnded || res.destroyed) return;
    const known = configuredAliasNames.has(model) || configuredCatalogNames.has(model);
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: known
            ? `model "${model}" is configured on this machine but no engine currently serves it`
            : `model "${model}" is not served by any engine on this machine`,
          type: 'model_unavailable',
          code: 'model_unavailable',
          model,
        },
      }),
    );
  };

  /** A POST body that names no model: nothing to route, nothing to wait
   *  for (a hold exists to await a SERVING engine for a NAMED model). Local
   *  400 — never the default target. (GET/DELETE/HEAD are the untouched
   *  admin passthrough and never reach this seam.) */
  const answerNoModel = (res: http.ServerResponse): void => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: 'chat request names no model — the aggregate routes by name and never falls through to the machine default target',
          type: 'invalid_request_error',
          code: 'no_model',
          param: 'model',
        },
      }),
    );
  };

  /** route-hold: park one named request until its engine appears (or the
   *  hold expires with the named 503, or the client goes away). Body stays
   *  UNCONSUMED (the #45 sniff posture), no gate slot, no registration. */
  const armHold = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawUrl: string,
    headerKey: string | undefined,
    model: string,
  ): void => {
    if (routeHoldMs === 0) {
      log(`aggregate: unroutable ${model} — hold off (aggregate_route_wait_ms=0), 503 model_unavailable`);
      answerUnavailable(res, model);
      return;
    }
    if (routeHolds.length >= ROUTE_HOLD_CAP) {
      log(`aggregate: unroutable ${model} — ${routeHolds.length} holds already waiting, 503 model_unavailable (cap ${ROUTE_HOLD_CAP})`);
      answerUnavailable(res, model);
      return;
    }
    const held: Omit<RouteHold, 'timer' | 'drop'> = { model, req, res, rawUrl, headerKey, since: Date.now() };
    let spliced = false;
    const spliceOut = (): boolean => {
      if (spliced) return false;
      const at = routeHolds.findIndex((h) => h.req === req);
      if (at === -1) return false;
      spliced = true;
      routeHolds.splice(at, 1);
      return true;
    };
    const detach = (): void => {
      req.removeListener('aborted', onGone);
      res.removeListener('close', onGone);
    };
    const onGone = (): void => {
      if (!spliceOut()) return;
      clearTimeout(timer);
      detach();
      log(`aggregate: hold ${model} dropped — the client left before any answer`);
    };
    const timer = setTimeout(() => {
      if (!spliceOut()) return; // client left / released first — the expiry is moot
      detach();
      log(`aggregate: hold ${model} expired after ${routeHoldMs}ms (503 model_unavailable)`);
      answerUnavailable(res, model);
    }, routeHoldMs);
    timer.unref?.();
    const hold: RouteHold = {
      ...held,
      timer,
      drop: () => {
        if (!spliceOut()) return false;
        detach();
        return true;
      },
    };
    req.on('aborted', onGone);
    res.on('close', onGone); // client left before any answer: the hold is moot
    routeHolds.push(hold);
    log(`aggregate: hold ${model} — no engine serves it yet, waiting up to ${routeHoldMs}ms (route-hold)`);
  };

  /** route-hold: called after EVERY routing-map swap. A held name that now
   *  resolves proceeds through the SAME seam a fresh dispatch would. */
  const flushHolds = (): void => {
    for (const hold of [...routeHolds]) {
      const entry = resolveEntry(hold.model);
      if (!entry) continue;
      if (!hold.drop()) continue; // vanished mid-flush (client left): its own path answered nothing
      clearTimeout(hold.timer);
      log(`aggregate: hold ${hold.model} released → ${entry.server_id} (waited ${Date.now() - hold.since}ms)`);
      if (hold.res.writableEnded || hold.res.destroyed || hold.req.destroyed) continue;
      proceed(hold.req, hold.res, hold.rawUrl, hold.headerKey, hold.model, entry);
    }
  };

  const serveModelList = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
    // The operator's ask (2026-10-08): /v1/models advertises ONLY the
    // configured aliases, in their priority order (the publish block's order,
    // first = the default model). A bare engine name an alias does not name
    // is NOT advertised — it still routes (a request naming it takes the
    // catalog row exactly as before); the list is the operator's curated
    // surface, not the raw catalog union. With no alias the list is empty:
    // the machine advertises nothing (a chat request still routes by name,
    // and the unknown-model fallback stands). The router still NEVER probes
    // an engine to answer (D1).
    // #87 D3: winner-pair capabilities ride as ADD keys when the arbiter
    // observed them; the variant id the alias routes to stays dashboard-only.
    const data = aliases.map((a) => ({
      id: a.name,
      object: 'model',
      owned_by: a.server_id,
      ...(a.context_length !== undefined ? { context_length: a.context_length } : {}),
      ...(a.input_modalities !== undefined ? { input_modalities: a.input_modalities } : {}),
      ...(a.output_modalities !== undefined ? { output_modalities: a.output_modalities } : {}),
    }));
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

    // route-hold (owner posture 2026-10-18) — THE DEFAULT TARGET IS DEAD
    // TRAFFIC for named requests. A named model resolves (alias > bare
    // precedence, #66 D2) and proceeds, or HOLDS here — body unconsumed,
    // no gate slot, zero bytes to any upstream — until a poll makes it
    // routable, then it proceeds through the identical seam. Hold-expiry
    // answers the named 503; a body naming no model is a local 400. This
    // closes BOTH historical shapes: the 2026-10-12 fall-through (stripped
    // key → unrelated keyed engine's 401) AND its D2 narrowing (instant
    // 503 during a publish gap) — a cold start or arbiter churn now WAITS
    // the gap out instead of failing or misrouting.
    const dispatch = (model: string | undefined): void => {
      if (model === undefined) {
        answerNoModel(res);
        return;
      }
      const entry = resolveEntry(model);
      if (entry) {
        proceed(req, res, rawUrl, headerKey, model, entry);
        return;
      }
      armHold(req, res, rawUrl, headerKey, model);
    };

    if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') {
      // No body to derive a key from: default target, ungated (a GET has
      // no session body; today's passthrough posture — the admin plane,
      // never chat traffic; `llm_target` is ONLY this surface and the
      // 11435 proxy, never a chat-routing decision).
      forwardTo(req, res, rawUrl, target);
      return;
    }
    // Body method: sniff the model (unshift-safe, accumulating across
    // chunks), then route / hold on the name. Identity: the session header
    // when present, else the model name (D3) — applied in `proceed`.
    void peekModelName(req).then((model) => dispatch(model));
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
        configuredCatalogNames.add(e.name); // route-hold memory (monotonic, never cleared)
      }
      flushHolds(); // route-hold: a pair this poll made routable releases its holds
    },
    updateAliases(entries) {
      // Same defensive posture as updateCatalog: a malformed entry is
      // dropped, a repeated alias name keeps its FIRST entry. An empty /
      // absent block clears the map (the arbiter stopped publishing it —
      // every alias unpublished this tick, not a stale pin). The D2 fence
      // memory is MONOTONIC: every name ACCEPTED into the map (malformed
      // entries dropped → never named) is remembered for the process
      // lifetime; clearing the map never clears the fence.
      aliases = [];
      aliasByName.clear();
      for (const e of Array.isArray(entries) ? entries : []) {
        if (!e || typeof e.name !== 'string' || e.name === '') continue;
        if (typeof e.server_id !== 'string' || e.server_id === '') continue;
        if (typeof e.url !== 'string' || e.url === '') continue;
        if (typeof e.engine_model !== 'string' || e.engine_model === '') continue;
        if (aliasByName.has(e.name)) continue;
        // alias-stability D3 (as published by D1): the failover surface is
        // validated INDEPENDENTLY of the entry — a malformed element drops,
        // a malformed array makes the KEY absent, and either way the entry
        // itself still routes on its winner pair (the fence never turns a
        // corrupt ADD key into an un-published alias).
        const targets = sanitizeAliasFallbackTargets(e.fallback_targets);
        const kept: AggregateAliasEntry = targets ? { ...e, fallback_targets: targets } : { ...e };
        if (!targets) delete kept.fallback_targets;
        aliasByName.set(kept.name, kept);
        aliases.push(kept);
        configuredAliasNames.add(kept.name);
      }
      flushHolds(); // route-hold: a pair this poll made routable releases its holds
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
    updateQueueDepths(rows, observedAt) {
      // alias-stability D3: whole-digest swap on every successful poll
      // (same posture as the key table). A row with an absent/garbage
      // queue_depth stores NO entry (the arbiter only carries the count
      // for kinds that expose one — oMLX today); staleness of an ABSENT
      // digest is the age of the last swap, judged at fire time. A poll
      // FAILURE never calls this — the last digest stands.
      const at = typeof observedAt === 'number' && Number.isFinite(observedAt) ? observedAt : Date.now();
      const next = new Map<string, { depth: number; at: number }>();
      for (const r of Array.isArray(rows) ? rows : []) {
        if (!r || typeof r.server_id !== 'string' || r.server_id === '') continue;
        if (typeof r.queue_depth !== 'number' || !Number.isFinite(r.queue_depth) || r.queue_depth < 0) continue;
        next.set(r.server_id, { depth: Math.floor(r.queue_depth), at });
      }
      queueDigest = next;
    },
    catalogSize() {
      return catalog.length;
    },
    aliasSize() {
      return aliases.length;
    },
    egressFailures() {
      // Fresh entries only (a quiet row is not a live exception), freshest
      // first, capped. An empty array is the explicit no-exception report —
      // the register heartbeat publishes it and the arbiter CLEARS the
      // stored list on it (the client_log rule).
      const now = Date.now();
      return [...egressFailures.values()]
        .filter((f) => now - f.at <= EGRESS_FAILURE_TTL_MS)
        .sort((a, b) => b.at - a.at)
        .slice(0, EGRESS_FAILURE_CAP);
    },
    engineRows() {
      // Every row this router can forward to: catalog entries, alias winner
      // pairs, published failover targets. Deduped by server_id (first url
      // seen wins — the self-test probes the ROW's reachability, and one
      // connect per row is the row).
      const seen = new Map<string, string>();
      const add = (serverId: unknown, url: unknown): void => {
        if (typeof serverId !== 'string' || serverId === '') return;
        if (typeof url !== 'string' || url === '') return;
        if (!seen.has(serverId)) seen.set(serverId, url);
      };
      for (const e of catalog) add(e.server_id, e.url);
      for (const a of aliases) {
        add(a.server_id, a.url);
        for (const t of a.fallback_targets ?? []) add(t.server_id, t.url);
      }
      return [...seen.entries()].map(([server_id, url]) => ({ server_id, url }));
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

