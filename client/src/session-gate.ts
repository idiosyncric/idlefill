/**
 * Session gate — the client-as-router admission gate (issue #9 Part A).
 *
 * Interactive Hermes sessions point their base_url at the loopback proxy as
 * `http://127.0.0.1:<proxy_port>/s/<token>`. The gate:
 *
 *   - self-registers a session at the arbiter on FIRST SIGHT of a token
 *     (POST /api/sessions/register, idempotent) and refreshes it at most
 *     once per `heartbeatMs` (traffic is the heartbeat; the daemon also
 *     folds refreshes into its tick);
 *   - admits sessions capacity-first: at most `maxActive` sessions hold
 *     inference slots at once (a session holds a slot while it has an
 *     in-flight request). Admission is FIFO by arrival — no queue-jumping;
 *   - HOLDS (never fails) a queued or paused session's request: the agent's
 *     HTTP client simply waits on the wire. On admission the parked request
 *     is forwarded as-is (Hermes rebuilds the request per attempt, so no
 *     stale-context guard is needed);
 *   - past `holdCapMs` answers a retryable 503 JSON + Retry-After (~15s +
 *     jitter) — the same JSON shape discipline as the proxy's 502. The cap
 *     must sit safely under the client's own request timeout (Hermes:
 *     HERMES_API_TIMEOUT default 1800s; verified 2026-10-01, see the
 *     issue #9 report);
 *   - ENFORCES the operator overrides the arbiter stores (pause ⇒ hold that
 *     session's traffic; force ⇒ bypass the slot cap). Override state is
 *     learned from the daemon's GET /api/state poll, refreshed on demand
 *     when a new session arrives or a request parks;
 *   - FAILS OPEN: arbiter unreachable (registration POST fails, state poll
 *     down) ⇒ every session is admitted and parked requests are released.
 *     A dead arbiter must never wedge a conversation.
 *
 * Plain `/v1/...` traffic (the lease-gated job flow) never enters the gate —
 * the proxy's single-target passthrough contract is untouched.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export type SessionOverrideKind = 'pause' | 'force';

/**
 * The gate-state block the register heartbeat carries (gate-state issue):
 * what the router's queue knows about one session, surfaced verbatim on the
 * arbiter's session rows. `active` = the session holds a slot right now
 * (inflight > 0); `queued` = it has ≥1 parked request waiting for admission.
 * `waiting` = parked requests for that session. A session that is neither
 * reports NO snapshot — the register body then omits the block and the
 * arbiter clears any stored gate for that token.
 */
export interface SessionGateSnapshot {
  state: 'active' | 'queued';
  waiting: number;
  /**
   * #44: the session's 1-based position in the router's FIFO queue, when
   * state is 'queued' (the queue order lives ONLY at the router — the
   * arbiter sees parked counts, not order). Absent when not queued, or
   * with an old arbiter that never echoes it back.
   */
  position?: number;
}

/**
 * #67: the response-phase snapshot the register heartbeat carries as the
 * `phase` ADD-key. What the engine is doing RIGHT NOW on this session,
 * classified from the streamed deltas the router already pipes past:
 * 'thinking' = reasoning deltas (`delta.reasoning_content`), 'output' =
 * content deltas (`delta.content`), 'tools' = tool-call deltas
 * (`delta.tool_calls`). `at` = epoch-ms of the last observed phase chunk
 * (the surface ages/dims the state from it; the arbiter stores it
 * verbatim). null / absent = no live stream — the body omits the block
 * and the arbiter CLEARS any stored phase (the gate block posture).
 */
export interface SessionPhaseSnapshot {
  state: 'thinking' | 'output' | 'tools';
  at: number;
}

/**
 * #67: an operator engine pin as the arbiter publishes it on the
 * `/api/state` sessions[] row (the `engine_pin` ADD-key — resolved
 * server-side like the #66 alias block: the router never recomputes a
 * url). `engine_model` rides only when the pinned row serves the
 * session's model under a DIFFERENT id (the alias-pair case; the same
 * #66 D3 splice rule at forward time).
 */
export interface SessionPinRow {
  server_id: string;
  url: string;
  engine_model?: string;
  set_at: number;
}

/** One row of GET /apistate → sessions[] as the client sees it. */
export interface SessionStateRow {
  token: string;
  override?: { override: string; until?: number | null } | null;
  /** The client the arbiter attributes this session to (#50 mesh, read
   *  for adoption in #54). Absent = pre-#50 arbiter or a test fixture. */
  client_name?: string;
  /** #67: this session's operator engine pin (absent = no pin). */
  engine_pin?: SessionPinRow | null;
}

/** The proxy's forwarder: pipe req → upstream at `path`, stream the reply. */
export type ForwardFn = (req: IncomingMessage, res: ServerResponse, path: string) => void;

export interface SessionGateDeps {
  /**
   * POST /api/sessions/register for a token. `gate` is the gate-state
   * snapshot at call time (null = idle: no slot, no holds — the body then
   * omits the gate block so the arbiter CLEARS any stored gate). Resolves
   * true on 2xx. Rejections/false never block admission (fail-open).
   * `sessionId` (#42 Slice 0) is the REAL Hermes conversation id captured
   * from the X-Hermes-Session-Id header — undefined until a request on the
   * token carried it, then stable; the body omits the key when undefined.
   */
  register: (
    token: string,
    gate: SessionGateSnapshot | null,
    sessionId?: string,
    /** #45: compact per-session request history (10×60s counts + last
     *  model + last token total) — the `history` ADD-Key on the register
     *  body. Absent for a session with no recorded traffic. */
    history?: SessionHistory,
    /** #67: the response-phase snapshot at heartbeat time — the live
     *  stream class (thinking/output/tools) + observation instant. null
     *  = no live phase (the body omits the block, the arbiter CLEARS any
     *  stored phase — the gate block posture). */
    phase?: SessionPhaseSnapshot | null,
  ) => Promise<boolean>;
  /** #54: this client's registered name (client/config.json client_name).
   *  Arbiter session rows naming a DIFFERENT client are not adopted —
   *  see onStatePoll. Unset (tests, odd configs) keeps the old
   *  adopt-everything behavior. */
  clientName?: string;
  /** Ask the daemon to re-poll /api/state now (on-demand override learn). */
  refreshState?: () => void;
  /** max_active_agent_sessions — concurrent sessions holding a slot. */
  maxActive: number;
  /** session_hold_cap_ms — park limit before the retryable 503. */
  holdCapMs: number;
  /** Register/heartbeat throttle window per session. Default 10s. */
  heartbeatMs?: number;
  log?: (msg: string) => void;
  /** Clock seam for tests. Default Date.now. */
  now?: () => number;
}

interface Held {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  /**
   * The forward seam. For the proxy plane this is a fixed target (11435
   * stays byte-for-byte, #64 D6); for the aggregate plane it is a LATE
   * BOUND resolver (#67): the park holds it unconsumed and the release
   * path calling it resolves the engine AT ADMISSION — a pin written
   * while the request sat parked takes effect on this very body.
   */
  forward: ForwardFn;
  parkedAt: number;
  capTimer?: NodeJS.Timeout;
  done: boolean;
}

interface Session {
  token: string;
  override: SessionOverrideKind | null;
  /** In-flight forwarded requests. >0 ⇒ the session holds a slot. */
  inflight: number;
  holds: Held[];
  registered: boolean;
  lastRegisterAttempt: number;
  /**
   * The REAL Hermes conversation id this token carries, captured from the
   * `X-Hermes-Session-Id` request header (#42 Slice 0). A header-free
   * request (curl, other clients) leaves it absent. Published on the
   * register heartbeat as the `session_id` ADD-key — one contract, two
   * sources: the header path and the future middleware path converge on
   * the same stored field.
   */
  session_id?: string;
  /**
   * #45 request ring: epoch-ms of every forwarded/parked request, newest
   * last, capped (RING_MAX). In-memory only — a restart starts empty.
   * Published on the register heartbeat inside the `history` ADD-key as
   * per-minute counts (see sessionHistory).
   */
  ring: number[];
  /** Last model name sniffed from a forwarded chat-completion body (#45). */
  model?: string;
  /** Last token total observed in an upstream usage chunk (#45). */
  tokens?: number;
  /**
   * #67: the live response phase for this session — the class of the last
   * streamed delta observed across its in-flight requests (null/absent =
   * no live stream). Reset to null when the session's last in-flight
   * request settles. The register heartbeat folds it into the `phase`
   * ADD-key; surfaces age it against `at`.
   */
  phase?: { state: 'thinking' | 'output' | 'tools'; at: number } | null;
  /**
   * #67: the operator engine pin as learned from the arbiter's session
   * rows (`engine_pin` ADD-key). Read at RELEASE time by the aggregate
   * router's target resolver; the gate itself never reroutes around the
   * queue — a pin moves the target, not the order.
   */
  pin?: SessionPinRow | null;

}

/** #45: cap on the in-memory request ring (a restart starts empty). */
const RING_MAX = 240;

/** #45: the `history` ADD-key shape published on the register heartbeat. */
export interface SessionHistory {
  /** requests/min counts, 60s buckets, oldest→newest, always 10 entries. */
  rpm: number[];
  /** last model name sniffed from a forwarded chat-completions body. */
  model?: string;
  /** last total_tokens observed in this session's streamed usage. */
  tokens?: number;
}

/** #45: compact request history for the register heartbeat — counts per
 *  60s bucket, oldest→newest, always exactly 10 buckets (10 minutes). */
function sessionHistory(s: Session, now: number): SessionHistory {
  const rpm = new Array<number>(10).fill(0);
  for (const t of s.ring) {
    const age = now - t;
    if (age < 0 || age >= 600_000) continue;
    const idx = 9 - Math.floor(age / 60_000);
    rpm[idx] = (rpm[idx] ?? 0) + 1;
  }
  return { rpm, ...(s.model ? { model: s.model } : {}), ...(s.tokens ? { tokens: s.tokens } : {}) };
}

/**
 * #45: sniff the model name out of a chat-completions body WITHOUT
 * buffering the stream: parse only the first request chunk. A chunk that
 * doesn't end on a complete JSON object just yields the model field if the
 * regex finds one inside it; anything malformed yields nothing
 * (drop-don't-reject, like every other observed field).
 */
function sniffModelChunk(chunk: Buffer | string): string | undefined {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const m = /"model"\s*:\s*"([^"\\\x00-\x1f\x7f]{1,80})"/.exec(text);
  return m ? m[1] : undefined;
}

/** #45: token totals ride the streamed usage chunk ("usage":{...total_tokens:N}). */
function sniffUsageChunk(chunk: Buffer | string): number | undefined {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const m = /"total_tokens"\s*:\s*(\d{1,12})/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * #67: classify one streamed response chunk into the session's response
 * phase — the shape the visual contract names: 'thinking' (reasoning
 * deltas), 'output' (content deltas), 'tools' (tool-call deltas).
 *
 * Posture: regex over the chunk text, no JSON parse, no buffering — the
 * same drop-don't-reject class as every other observed field. A chunk
 * that carries no SSE `delta` row (a non-streaming JSON body, a
 * keep-alive, the `[DONE]` row, a header row) yields NOTHING, so a phase
 * is never invented. When one chunk carries more than one class the
 * order is tools → thinking → output (a chunk that is genuinely a
 * tool-call row has no content to argue with; the tie is rare in
 * practice because engines emit one delta class per row).
 *
 * Honest limit, stated so no surface promises more: the classification
 * reads BYTES, not parsed SSE frames. A chunk boundary that splits a
 * delta row still classifies as long as one of the key substrings lands
 * whole inside some chunk — true for every engine observed (rows are
 * small compared to Node's read chunks). A model that emits the literal
 * text `"tool_calls":` inside its own content could mislabel one pipe
 * color; nothing else rides on this field.
 */
export function sniffPhaseChunk(chunk: Buffer | string): 'thinking' | 'output' | 'tools' | undefined {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  if (!/"delta"\s*:/.test(text)) return undefined;
  if (/"tool_calls"\s*:/.test(text)) return 'tools';
  if (/"reasoning_content"\s*:/.test(text)) return 'thinking';
  if (/"content"\s*:/.test(text)) return 'output';
  return undefined;
}

/** #42 Slice 0: the header Hermes may carry with every provider request. */
export const SESSION_ID_HEADER = 'x-hermes-session-id';

/** Bound + sanitize a reported session id (same drop-don't-reject posture
 *  as the token rule): printable, ≤128 chars, else treated as absent. */
function cleanSessionId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.length > 128) return undefined;
  // Header values with control characters are hostile input; drop them.
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(s)) return undefined;
  return s;
}

/** `/s/<token>/rest…` — the session path contract (token ≤128 chars, arbiter rule). */
export const SESSION_PATH_RE = /^\/s\/([^/]+)(\/.*)?$/;

export class SessionGate {
  private readonly sessions = new Map<string, Session>();
  /** FIFO of queued tokens (arrival order; paused rows stay in place). */
  private readonly queue: string[] = [];
  private linkUp = true;
  private released = false;
  private lastRefreshAt = 0;
  private readonly heartbeatMs: number;

  constructor(private readonly deps: SessionGateDeps) {
    this.heartbeatMs = deps.heartbeatMs ?? 10_000;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }

  /** Sessions currently holding an inference slot. */
  get activeCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.inflight > 0) n++;
    return n;
  }

  /** Queue depth (sessions parked waiting for a slot or an unpause). */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** True when the gate is in fail-open posture (arbiter down / released). */
  get failOpen(): boolean {
    return !this.linkUp || this.released;
  }

  /**
   * #67: the operator engine pin the gate currently holds for a token
   * (null = no pin). Read by the aggregate router's release-time target
   * resolver — the gate OWNS the learned state (it rides the poll), the
   * router only consumes it at admission.
   */
  pinFor(token: string): SessionPinRow | null {
    return this.sessions.get(token)?.pin ?? null;
  }

  /**
   * The gate-state snapshot for one token — what a heartbeat reports to the
   * arbiter. Pure read of the router's queue truth: holding a slot
   * (inflight > 0) ⇒ `active` (the parked-request count still rides as
   * `waiting` — a holder can have requests queued behind its own traffic);
   * parked-only ⇒ `queued`; neither (idle, no traffic) ⇒ null, which the
   * caller folds into an omitted gate block so the arbiter clears the row.
   */
  snapshot(token: string): SessionGateSnapshot | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.inflight > 0) return { state: 'active', waiting: s.holds.length };
    if (s.holds.length > 0) {
      // #44: a queued session also carries its place in line (the queue is
      // router-local truth; surfaces render the number verbatim).
      const pos = this.queue.indexOf(token) + 1;
      return { state: 'queued', waiting: s.holds.length, ...(pos > 0 ? { position: pos } : {}) };
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Request path (called by the proxy for /s/<token>/… hits)
  // ------------------------------------------------------------------

  route(req: IncomingMessage, res: ServerResponse, token: string, path: string, forward: ForwardFn): void {
    // #42 Slice 0: Hermes may carry its REAL conversation id on every
    // provider request. Capture it per request — the row's identity display
    // updates from live traffic, headerless clients leave it untouched.
    const s = this.touch(token, cleanSessionId(req.headers[SESSION_ID_HEADER]));
    // #45 session detail: count the request the moment the router sees it
    // (forwarded OR parked — a parked request is still a request). The
    // body is NEVER touched here: a parked request must keep its body
    // unconsumed for the forward on admission (a req 'data' listener
    // drains it and wedges the park — found by the (c)/(e) gate tests).
    // Model + usage sniff from the upstream RESPONSE instead (below): the
    // engine echoes the model it served in the response body, and
    // observing the piped upstream never steals bytes.
    this.recordRequest(s);

    // #67: `forward` may be a LATE BOUND seam (the aggregate router
    // resolves the engine at CALL time — a pin the operator writes
    // between park and release moves the target at admission). It is
    // NEVER invoked at park time: the parked body stays whole and the
    // resolver only runs when the request actually goes out. The proxy
    // plane passes a fixed target — byte-for-byte today's behavior.

    // Fail-open posture: arbiter down or gate shutting down ⇒ admit.
    if (!this.linkUp || this.released) {
      this.forwardNow(s, req, res, path, forward);
      return;
    }
    // force ⇒ bypass the session-slot cap for that session (#32).
    if (s.override === 'force') {
      this.forwardNow(s, req, res, path, forward);
      return;
    }
    // pause ⇒ hold that session's traffic, even with free slots (#32).
    // The row stays queued (in place) so an unpause releases it FIFO.
    if (s.override === 'pause') {
      this.enqueue(s);
      this.park(s, req, res, path, forward);
      this.maybeRefresh();
      return;
    }
    // A session with traffic in flight already holds its slot.
    if (s.inflight > 0 || this.activeCount < this.deps.maxActive) {
      this.dequeue(s.token);
      this.forwardNow(s, req, res, path, forward);
      return;
    }
    // No slot: strict FIFO park.
    this.enqueue(s);
    this.park(s, req, res, path, forward);
    this.maybeRefresh();
  }

  /** #45: one ring entry per request (capped; in-memory, restart starts empty). */
  private recordRequest(s: Session): void {
    s.ring.push(this.now());
    if (s.ring.length > RING_MAX) s.ring.splice(0, s.ring.length - RING_MAX);
  }

  /** First-sight bookkeeping: create the row + throttled registration. */
  private touch(token: string, sessionId?: string): Session {
    let s = this.sessions.get(token);
    const fresh = !s;
    if (!s) {
      s = { token, override: null, inflight: 0, holds: [], registered: false, lastRegisterAttempt: 0, ring: [] };
      this.sessions.set(token, s);
    }
    // A captured id rides forward from the first request that carried it;
    // a later headerless request never clears it (last-known-wins, the same
    // posture as the client-published display fields).
    if (sessionId) s.session_id = sessionId;
    const target = s;
    if (this.now() - target.lastRegisterAttempt >= this.heartbeatMs) {
      void this.register(target);
    }
    if (fresh) {
      this.log(`session ${token} first sight — gate ${this.linkUp ? 'armed' : 'fail-open (arbiter down)'}`);
      // Learn the operator override for a brand-new session right away.
      this.maybeRefresh();
    }
    return target;
  }

  private async register(s: Session): Promise<void> {
    s.lastRegisterAttempt = this.now();
    try {
      // #45: the compact history only when the session has traffic (an
      // idle row stays exactly as it was — ADD-key posture). #67: the
      // live response phase rides the NEXT positional slot — explicitly
      // null (no live stream) so the arbiter CLEARS a stored phase the
      // same way the gate block clears on the idle report. Positional
      // args stay explicit here: a conditional spread would shift phase
      // into history's slot (the arity the register callback declares).
      const hist = s.ring.length || s.model || s.tokens ? sessionHistory(s, this.now()) : undefined;
      const ok = await this.deps.register(
        s.token,
        this.snapshot(s.token),
        s.session_id,
        hist,
        s.phase ? { state: s.phase.state, at: s.phase.at } : null,
      );
      if (ok) {
        if (!this.linkUp) {
          this.linkUp = true;
          this.log('arbiter reachable again (register ok) — session gate re-armed');
        }
        if (!s.registered) {
          s.registered = true;
          this.log(`session ${s.token} registered at the arbiter`);
        }
      } else {
        this.log(`session ${s.token} register refused — fail-open`);
        this.onLinkDown();
      }
    } catch (err) {
      this.log(`session ${s.token} register failed (${err instanceof Error ? err.message : err}) — fail-open`);
      this.onLinkDown();
    }
  }

  /** Daemon tick: refresh every known session's registration (throttled). */
  heartbeat(): void {
    if (this.released) return;
    for (const s of this.sessions.values()) {
      if (this.now() - s.lastRegisterAttempt >= this.heartbeatMs) void this.register(s);
    }
  }

  // ------------------------------------------------------------------
  // Admission / holds
  // ------------------------------------------------------------------

  private forwardNow(s: Session, req: IncomingMessage, res: ServerResponse, path: string, forward: ForwardFn): void {
    s.inflight++;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      s.inflight--;
      // #67: the session has no live stream any more — its phase clears
      // (the next heartbeat carries the no-phase report, the arbiter
      // CLEARS the stored block). Only the last settling request writes.
      // When a phase WAS live, the clear rides right away: the transition
      // registers already made the surface live mid-stream, and leaving a
      // 'tools'/'output' pipe animating for up to the 10s heartbeat window
      // after the stream ended would render a lie. Bounded by construction
      // (≤1 per stream, only when a phase actually stood).
      if (s.inflight === 0 && s.phase) {
        s.phase = null;
        if (s.registered && this.linkUp && !this.released) void this.register(s);
      }
      if (s.inflight === 0) this.admitLoop();
    };
    // 'close' covers clean finish, upstream error, and client abort.
    res.once('close', settle);
    // #45: the response peek — when the proxy pipes the upstream response
    // into res, the piped source is the upstream stream; an extra data
    // listener there OBSERVES chunks (pipe keeps its own listener; extra
    // listeners see copies, they never steal bytes) and stores the model
    // the engine served + the last total_tokens streamed. Detaches once
    // both facts are known so long-lived streams never keep parsing.
    if (!s.model || !s.tokens) {
      res.once('pipe', (src) => {
        const onChunk = (chunk: Buffer | string) => {
          if (!s.model) {
            const model = sniffModelChunk(chunk);
            if (model) s.model = model;
          }
          if (!s.tokens) {
            const n = sniffUsageChunk(chunk);
            if (n !== undefined) s.tokens = n;
          }
          if (s.model && s.tokens) detach();
        };
        const detach = () => {
          src.removeListener('data', onChunk);
          src.removeListener('end', detach);
          src.removeListener('close', detach);
        };
        src.on('data', onChunk);
        src.once('end', detach);
        src.once('close', detach);
      });
    }
    // #67: the response-phase sniffer — the SAME observe-copies
    // discipline (a listener on the piped source never steals bytes;
    // #45 pinned the wedge the other way causes). Classifies every
    // streamed chunk's SSE delta class: reasoning_content → 'thinking',
    // content → 'output', tool_calls → 'tools'; each classified chunk
    // stamps the session's live phase + observation instant. Unlike the
    // #45 pair this listener stays for the whole stream (the phase IS
    // the stream's live state) and detaches on end/close. An
    // unclassifiable chunk (role row, [DONE], keep-alive) changes
    // nothing — drop-don't-reject, never a fabricated phase.
    res.once('pipe', (src) => {
      const onPhase = (chunk: Buffer | string): void => {
        const state = sniffPhaseChunk(chunk);
        if (!state) return;
        const transitioned = s.phase?.state !== state;
        s.phase = { state, at: this.now() };
        // #67: a phase TRANSITION rides the arbiter right away. The
        // heartbeat throttle (≤1 register per 10s) is for traffic noise;
        // a stream carries only a handful of transitions, and the flow
        // view renders off arbiter truth — waiting up to 10s per step
        // would freeze the surface (live probe, #67 acceptance: a 6s
        // stream reported no phase at all between first-sight and settle).
        // Same-state chunks just refresh the age. The settle clear below
        // carries the matching no-phase report.
        if (transitioned && s.registered && this.linkUp && !this.released) void this.register(s);
      };
      const detachPhase = (): void => {
        src.removeListener('data', onPhase);
        src.removeListener('end', detachPhase);
        src.removeListener('close', detachPhase);
      };
      src.on('data', onPhase);
      src.once('end', detachPhase);
      src.once('close', detachPhase);
    });
    forward(req, res, path);
  }

  private park(s: Session, req: IncomingMessage, res: ServerResponse, path: string, forward: ForwardFn): void {
    const h: Held = { req, res, path, forward, parkedAt: this.now(), done: false };
    s.holds.push(h);
    const drop = () => this.dropHold(s, h);
    // While parked nothing has been answered, so close/aborted = client gone.
    req.once('aborted', drop);
    req.once('close', drop);
    h.capTimer = setTimeout(() => this.expireHold(s, h), this.deps.holdCapMs);
    h.capTimer.unref?.();
  }

  /** Client vanished while parked: forget the hold, free the queue slot. */
  private dropHold(s: Session, h: Held): void {
    if (h.done) return;
    if (resSent(h.res)) {
      // 'close' also fires after a released hold finished normally — ignore.
      return;
    }
    h.done = true;
    if (h.capTimer) clearTimeout(h.capTimer);
    this.forgetHold(s, h);
    this.log(`session ${s.token} parked request aborted by client`);
    this.admitLoop();
  }

  /** Hold cap: retryable 503 + Retry-After (~15s + jitter). */
  private expireHold(s: Session, h: Held): void {
    if (h.done) return;
    h.done = true;
    this.forgetHold(s, h);
    const waitedMs = this.now() - h.parkedAt;
    const retryAfter = 15 + Math.floor(Math.random() * 6);
    this.log(`session ${s.token} hold cap exceeded (${waitedMs}ms) — 503 + Retry-After ${retryAfter}s`);
    if (!h.res.headersSent && !h.res.writableEnded) {
      try {
        h.res.writeHead(503, {
          'content-type': 'application/json',
          'retry-after': String(retryAfter),
        });
        h.res.end(
          JSON.stringify({
            error: 'session queued',
            detail: `held ${waitedMs}ms behind another agent session at the inference box`,
            retry: true,
            retry_after_seconds: retryAfter,
          }),
        );
      } catch {
        /* client already gone */
      }
    }
    // NOTE: no req.destroy() here — res and req share the socket, and
    // destroying right after end() can truncate the 503 in flight. Node
    // closes the (unreusable, body-unread) connection on its own.
  }

  private forgetHold(s: Session, h: Held): void {
    const i = s.holds.indexOf(h);
    if (i >= 0) s.holds.splice(i, 1);
    if (s.holds.length === 0 && s.inflight === 0) this.dequeue(s.token);
  }

  /**
   * Admit queued sessions while slots are free, strict FIFO. A paused
   * head-of-queue is SKIPPED (the operator hold is not a slot wait — it
   * must not starve the rest of the queue) and keeps its position, so an
   * unpause takes the next free slot without queue-jumping.
   */
  private admitLoop(): void {
    if (this.released) {
      this.releaseAllHolds();
      return;
    }
    if (!this.linkUp) {
      // Fail-open: nothing should be parked while the arbiter is unreachable.
      this.releaseAllHolds();
      return;
    }
    for (;;) {
      if (this.activeCount >= this.deps.maxActive || this.queue.length === 0) return;
      let admitted = false;
      for (let i = 0; i < this.queue.length; i++) {
        const tok = this.queue[i];
        const s = tok ? this.sessions.get(tok) : undefined;
        if (!s || (s.holds.length === 0 && s.inflight === 0)) {
          if (tok) this.queue.splice(i, 1);
          admitted = true; // stale row removed — rescan
          break;
        }
        if (s.override === 'pause') continue;
        this.queue.splice(i, 1);
        this.log(`admitting session ${s.token} (${s.holds.length} parked request(s))`);
        this.releaseHoldsOf(s);
        admitted = true;
        break;
      }
      if (!admitted) return; // queue non-empty but every head is paused
    }
  }

  /** Forward every parked request of a session through the gate now. */
  private releaseHoldsOf(s: Session): void {
    while (s.holds.length > 0) {
      const h = s.holds[0]!;
      h.done = true;
      if (h.capTimer) clearTimeout(h.capTimer);
      s.holds.splice(0, 1);
      // #67: the target resolves AT RELEASE for aggregate traffic — the
      // held ForwardFn is late bound there, so a pin the operator wrote
      // (or moved) while this request sat parked takes effect on THIS
      // body, whole and unconsumed.
      this.forwardNow(s, h.req, h.res, h.path, h.forward);
    }
  }

  private enqueue(s: Session): void {
    if (!this.queue.includes(s.token)) this.queue.push(s.token);
  }

  private dequeue(token: string): void {
    const i = this.queue.indexOf(token);
    if (i >= 0) this.queue.splice(i, 1);
  }

  // ------------------------------------------------------------------
  // Arbiter state (fed by the daemon's /api/state poll)
  // ------------------------------------------------------------------

  /** Feed one GET /api/state `sessions[]` result. Marks the link up. */
  onStatePoll(rows: SessionStateRow[]): void {
    if (!this.linkUp) {
      this.linkUp = true;
      this.log('arbiter link back up — session gate re-armed');
    }
    if (this.released) return;
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row.token !== 'string' || !row.token) continue;
      // #54 (fleet): the arbiter row names its owning client. A row owned
      // by ANOTHER client is not ours to adopt — ensure() registers +
      // heartbeats the token, and registerSession is last-writer-wins
      // (arbiter): adopting STEALS attribution, the real owner's rows stop
      // being updated by it, its gate goes dark for the arbiter, and OUR
      // idle snapshots clear the owner's gate tags. Pre-fleet there was
      // exactly one client, so adopting everything was safe. Rows naming
      // no owner (pre-#50 arbiter, fixtures) keep the old behavior.
      if (row.client_name && this.deps.clientName && row.client_name !== this.deps.clientName) continue;
      seen.add(row.token);
      const s = this.ensure(row.token);
      const ov = normalizeOverride(row.override?.override);
      if (ov !== s.override) {
        this.log(`session ${s.token} override: ${s.override ?? 'none'} → ${ov ?? 'none'}`);
        s.override = ov;
        // A force override arriving while requests are parked bypasses the
        // slot cap immediately — no need to wait for a slot to free.
        if (ov === 'force') this.releaseHoldsOf(s);
      }
      // #67: learn the operator engine pin (the arbiter resolves the
      // block; the router stores what it is told). A pin never touches
      // the queue — it moves the forward TARGET at release, not the
      // order. A newly-arriving pin does not release anything by itself
      // (a pinned session still waits for its slot exactly like before;
      // the admission then resolves to the pinned row).
      const pin = normalizePinRow(row.engine_pin);
      const had = s.pin?.server_id ?? null;
      const next = pin?.server_id ?? null;
      // #67 acceptance fix: the splice key rides SEPARATELY from the
      // row. The block resolved while the session had no sniffed model
      // carries url-only; the completed block (same row, now naming the
      // row's OWN engine id) must still replace it — a server_id-only
      // comparison strands the incomplete pin and the alias request
      // reaches the pinned engine un-spliced (live: 404 model_not_found).
      if (had !== next || s.pin?.engine_model !== pin?.engine_model) {
        this.log(`session ${s.token} engine pin: ${had ?? 'none'} → ${next ?? 'none'}`);
        s.pin = pin;
      }
    }
    // Rows the arbiter no longer reports (swept/restart): no override —
    // the fail-open direction of last resort. Same for the pin (#67): a
    // pin the arbiter dropped (swept row, cleared pin) must not keep
    // resolving traffic here.
    for (const s of this.sessions.values()) {
      if (!seen.has(s.token) && s.override !== null) {
        this.log(`session ${s.token} override cleared (absent from arbiter state)`);
        s.override = null;
      }
      if (!seen.has(s.token) && s.pin) {
        this.log(`session ${s.token} engine pin cleared (absent from arbiter state)`);
        s.pin = null;
      }
    }
    this.admitLoop();
  }

  /** The arbiter link is down: admit own traffic, release every parked request. */
  onLinkDown(): void {
    if (this.released) return;
    if (this.linkUp) {
      this.linkUp = false;
      this.log('arbiter link down — session gate FAIL-OPEN (all sessions admitted)');
    }
    this.releaseAllHolds();
  }

  /** Daemon shutdown: release cleanly (parked requests proceed, no 503s). */
  releaseAll(): void {
    if (this.released) return;
    this.released = true;
    this.releaseAllHolds();
  }

  private releaseAllHolds(): void {
    for (const s of this.sessions.values()) this.releaseHoldsOf(s);
    this.queue.length = 0;
  }

  private ensure(token: string): Session {
    let s = this.sessions.get(token);
    if (!s) {
      s = { token, override: null, inflight: 0, holds: [], registered: false, lastRegisterAttempt: 0, ring: [] };
      this.sessions.set(token, s);
    }
    return s;
  }

  /** On-demand /api/state refresh (debounced): learn overrides promptly. */
  private maybeRefresh(): void {
    if (!this.deps.refreshState || this.released) return;
    if (this.now() - this.lastRefreshAt < 2000) return;
    this.lastRefreshAt = this.now();
    this.deps.refreshState();
  }
}

function normalizeOverride(v: unknown): SessionOverrideKind | null {
  return v === 'pause' || v === 'force' ? v : null;
}

/**
 * #67: accept an `engine_pin` block from the arbiter's session row only
 * in its published shape (server_id + url strings; engine_model when
 * present a string; set_at when present a finite number). null/absent →
 * null (no pin). Anything malformed → null too: the pin is the
 * fail-quiet surface — an unparseable block falls back to the
 * dispatch-chosen target, never a half-parsed reroute.
 */
function normalizePinRow(v: unknown): SessionPinRow | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = v as { server_id?: unknown; url?: unknown; engine_model?: unknown; set_at?: unknown };
  if (typeof p.server_id !== 'string' || p.server_id === '') return null;
  if (typeof p.url !== 'string' || p.url === '') return null;
  if (p.engine_model !== undefined && typeof p.engine_model !== 'string') return null;
  if (p.set_at !== undefined && (typeof p.set_at !== 'number' || !Number.isFinite(p.set_at))) return null;
  return {
    server_id: p.server_id,
    url: p.url,
    ...(typeof p.engine_model === 'string' ? { engine_model: p.engine_model } : {}),
    set_at: typeof p.set_at === 'number' ? p.set_at : 0,
  };
}

function resSent(res: ServerResponse): boolean {
  return res.headersSent || res.writableEnded;
}
