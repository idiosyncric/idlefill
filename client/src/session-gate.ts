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
}

/** One row of GET /apistate → sessions[] as the client sees it. */
export interface SessionStateRow {
  token: string;
  override?: { override: string; until?: number | null } | null;
  /** The client the arbiter attributes this session to (#50 mesh, read
   *  for adoption in #54). Absent = pre-#50 arbiter or a test fixture. */
  client_name?: string;
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
  register: (token: string, gate: SessionGateSnapshot | null, sessionId?: string) => Promise<boolean>;
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
    if (s.holds.length > 0) return { state: 'queued', waiting: s.holds.length };
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
    // The row stays queued (in place) so the unpause releases it FIFO.
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

  /** First-sight bookkeeping: create the row + throttled registration. */
  private touch(token: string, sessionId?: string): Session {
    let s = this.sessions.get(token);
    const fresh = !s;
    if (!s) {
      s = { token, override: null, inflight: 0, holds: [], registered: false, lastRegisterAttempt: 0 };
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
      const ok = await this.deps.register(s.token, this.snapshot(s.token), s.session_id);
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
      if (s.inflight === 0) this.admitLoop();
    };
    // 'close' covers clean finish, upstream error, and client abort.
    res.once('close', settle);
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
    }
    // Rows the arbiter no longer reports (swept/restart): no override —
    // the fail-open direction of last resort.
    for (const s of this.sessions.values()) {
      if (!seen.has(s.token) && s.override !== null) {
        this.log(`session ${s.token} override cleared (absent from arbiter state)`);
        s.override = null;
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
      s = { token, override: null, inflight: 0, holds: [], registered: false, lastRegisterAttempt: 0 };
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

function resSent(res: ServerResponse): boolean {
  return res.headersSent || res.writableEnded;
}
