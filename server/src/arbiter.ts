/**
 * Arbiter — the lease state machine on top of per-server IdleDetectors.
 *
 * PER-ENGINE ADMISSION (#38/#35): every lease belongs to a server row
 * (`server_id`; absent on pre-per-engine leases = the watched server).
 * The idle verdict, the post-revocation reidle gate, the concurrency cap,
 * and preemption are all evaluated against THAT server's signal — two
 * engines never gate each other. A server row with no detector is
 * fail-closed for grants (no signal = idle cannot be proven); the
 * client-side fail-open lives in the router, not here.
 *
 * SESSIONS (#32): session rows (self-registered by the router on first
 * sight of a /s/<token> path) are INTERACTIVE traffic. Their reported
 * activity folds into the server's idle verdict and preempts background
 * leases on that server — even when the session belongs to a
 * lease-holding client (the IP exemption never covers session traffic).
 * Session admission itself is capacity-only (the router admits directly);
 * the arbiter tracks sessions + operator overrides for visibility/control.
 *
 * States per lease: active → finished | revoked | expired.
 *
 * Grant (requestLease):
 *   - server known (else 'unknown_server')
 *   - that server idle (detector verdict; the detector never reports idle
 *     while degraded, so "no grants while degraded" falls out of the same
 *     check) AND no session active on it within idle_seconds
 *   - active lease count ON THAT SERVER < max_concurrent_leases
 *   - project exists, not paused
 *   - project's UTC-day output tokens < daily_token_cap
 *   - no post-revocation reidle gate armed ON THAT SERVER (see below)
 *
 * Revoke (on each idle poll, per server):
 *   - TTL expiry (status expired, reason ttl_expired)
 *   - preempt: NOT idle, and the newest NON-EXEMPT activity on the lease's
 *     server post-dates the lease's grant. Exempt = the active leases'
 *     owner IPs, so the lease holder's own traffic can never preempt it —
 *     EXCEPT session traffic, which always counts (see above).
 *
 * After ANY revocation the SERVER must go idle again (full idle_seconds)
 * before its next grant: a per-server `reidleAfter` arms on revocation and
 * disarms only when a later poll reports that server fully idle — no burst
 * of re-grants.
 *
 * Usage accounting: the FIRST usage/finish report for a lease adds the
 * reported tokens to the project's UTC-day counter (day = the report day);
 * later reports keep the max on the lease record but never add again. A
 * preempted lease's teardown report therefore still counts its partial
 * tokens exactly once.
 */

import { randomBytes } from 'node:crypto';
import type { IdleDetector } from './idle.js';
import { activeLeaseExemptIps, defaultActivityPathFor } from './idle.js';
import { buildCatalog, modelsProbeUrl, type CatalogEntry, type ModelsFetcher } from './catalog.js';
import { mintInstanceId } from './mesh.js';
import type { IdleSignal, JobResultRow, JobThrottle, SessionOverride, SessionRecord } from './types.js';
import type { StateStore } from './state.js';
import type { ClientOverride, Lease, ProjectAllocation, ServerConfig, ServerConnection, ServerProvider, UtcDate } from './types.js';
import { PROVIDER_KINDS } from './types.js';

/**
 * The id of the seeded watched-server row (cfg.llama_swap_url). Leases and
 * sessions without an explicit server_id belong to it — that is the only
 * server that existed before the per-engine core, so old state files load
 * unchanged.
 */
export const WATCHED_SERVER_ID = 'srv-watched';

/** Feed path on strata engines (#60 B): /metrics on the service origin. */
export const STRATA_FEED_PATH = '/metrics';

/**
 * The scheme://host[:port] origin of a server URL. strata operators paste
 * the OpenAI-style base (`https://host/v1`); its /metrics feed lives on
 * the ORIGIN, so strata rows normalize the url to origin and keep the
 * feed path separate. Unparseable urls pass through untouched.
 */
export function feedOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** The server a lease belongs to (absent server_id = the watched server). */
export function leaseServerId(lease: { server_id?: string }): string {
  return lease.server_id ?? WATCHED_SERVER_ID;
}

/**
 * Validate a register heartbeat's gate block (gate-state). Three verdicts:
 *   - a valid { state: 'active'|'queued', waiting: finite int ≥0 } → stored;
 *   - null/absent → null: the idle report, the stored gate CLEARS;
 *   - anything else → undefined: INVALID, the field is DROPPED (never a
 *     rejected registration) and the stored value stands.
 */
function normalizeSessionGate(v: unknown): { state: 'active' | 'queued'; waiting: number; position?: number } | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const g = v as { state?: unknown; waiting?: unknown; position?: unknown };
  if (g.state !== 'active' && g.state !== 'queued') return undefined;
  if (typeof g.waiting !== 'number' || !Number.isFinite(g.waiting) || !Number.isInteger(g.waiting) || g.waiting < 0) return undefined;
  // #44 add-key: 1-based queue position, only meaningful while queued.
  // Malformed = dropped (the block still rides, minus the key) — never a
  // rejected registration; absent = an old router (the row keeps no key).
  const position =
    typeof g.position === 'number' && Number.isInteger(g.position) && g.position >= 1
      ? g.position
      : undefined;
  return { state: g.state, waiting: g.waiting, ...(position !== undefined ? { position } : {}) };
}

/**
 * Sanitize a reported Hermes conversation id (#42 Slice 0). Token-style
 * posture: bounded printable string, or undefined — an invalid value is
 * DROPPED (the registration is never rejected for it, and a stored id
 * never clears).
 */
function cleanReportedId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.length > 128) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(s)) return undefined;
  return s;
}

/**
 * #45: sanitize a reported request-history block (#45). Per-key
 * drop-don't-reject: rpm must be an array of integers 0..1e6 (truncated
 * to the newest 10); model rides the id sanitizer; tokens an integer
 * 0..1e12. A block with NOTHING valid is treated as absent (undefined).
 */
function cleanReportedHistory(
  v: unknown,
  now: number,
): { rpm: number[]; model?: string; tokens?: number; reported_at: number } | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const h = v as { rpm?: unknown; model?: unknown; tokens?: unknown };
  const out: { rpm: number[]; model?: string; tokens?: number; reported_at: number } = {
    rpm: [],
    reported_at: now,
  };
  if (Array.isArray(h.rpm)) {
    const clean = h.rpm
      .filter((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 1_000_000)
      .slice(-10);
    out.rpm = clean;
  }
  const model = cleanReportedId(h.model);
  if (model) out.model = model;
  if (typeof h.tokens === 'number' && Number.isInteger(h.tokens) && h.tokens >= 0 && h.tokens <= 1e12) {
    out.tokens = h.tokens;
  }
  // Nothing survived sanitization: treat the whole block as absent.
  if (!out.rpm.length && !out.model && out.tokens === undefined) return undefined;
  return out;
}

export type LeaseRejectionReason =
  | 'not_idle'
  | 'busy'
  | 'project_paused'
  | 'budget_exhausted'
  | 'unknown_project'
  | 'unknown_client'
  | 'unknown_server'
  | 'client_paused'
  | 'job_throttled'
  | 'job_cooldown';

export interface LeaseGrantResult {
  ok: boolean;
  lease?: Lease;
  reason?: LeaseRejectionReason;
}

export interface TickResult {
  /** Leases revoked/expired this tick — push WS events for these. */
  revoked: { lease: Lease; reason: string }[];
  signal: IdleSignal;
}

export class Arbiter {
  private readonly store: StateStore;
  private readonly cfg: ServerConfig;
  /**
   * Per-server idle detectors, keyed by server_id (the watched server is
   * WATCHED_SERVER_ID). A server row with no detector is fail-closed for
   * grants: no signal means idle cannot be proven.
   */
  private detectors: Map<string, IdleDetector>;
  /** Optional factory so servers added via the API get a detector too. */
  private readonly detectorFactory?: (row: ServerConnection) => IdleDetector;
  /**
   * #64 D4: per-row `/v1/models` probe fetcher (credentialed per row, the
   * #60 B fetcher family). Absent = NO probe runs (tests + arbiter builds
   * without the wiring): the catalog then carries the declared union with
   * catalog_source 'declared' — never a false 'probed'.
   */
  private modelsFetcher?: ModelsFetcher;
  /**
   * #64: the catalog published to the router on the LAST probe cycle
   * (in-memory, ephemeral — never persisted; the token NEVER enters it).
   * `/api/state` echoes it as the `catalog` ADD-key.
   */
  private catalogPublished: CatalogEntry[] = [];
  /**
   * Per-server post-revocation reidle gates: server_id -> armed-at epoch-ms.
   * Armed when a lease on that server is revoked/expired; disarmed when a
   * later poll reports THAT server fully idle. One engine's preempt never
   * gates another engine's grants (#35: queues and gates are per-engine).
   */
  private reidleAfter = new Map<string, number>();
  /**
   * Per-(project, job_id) ok:false usage-report counts (anti-thrash).
   * In-memory: TTL expirations never count here (a dead client is an
   * unknown outcome, not a job failure — see endLease), and a restart
   * resets them; the persisted `throttled_jobs` map plus the client's
   * own quarantine are the restart-surviving backstops.
   */
  private jobFailCounts = new Map<string, number>();
  /**
   * Per-(project, job_id) grant cooldown: epoch-ms until which new grants
   * for that job are refused (`job_cooldown`). Set on EVERY failed usage
   * report (even below the threshold) — this is what breaks the ~20-second
   * re-grant loop between client polls. In-memory (it is a burst gate, not
   * operator state); the persisted throttle map survives restarts.
   */
  private jobCooldownUntil = new Map<string, number>();

  /** Stale-session sweep window: rows not seen for an hour are dropped. */
  private static readonly SESSION_STALE_MS = 3_600_000;

  constructor(
    store: StateStore,
    cfg: ServerConfig,
    detectors: IdleDetector | Map<string, IdleDetector>,
    opts?: { detectorFactory?: (row: ServerConnection) => IdleDetector; modelsFetcher?: ModelsFetcher },
  ) {
    this.store = store;
    this.cfg = cfg;
    this.detectors = detectors instanceof Map ? detectors : new Map([[WATCHED_SERVER_ID, detectors]]);
    this.detectorFactory = opts?.detectorFactory;
    this.modelsFetcher = opts?.modelsFetcher;
    // A fresh Arbiter must see the seeded server inventory, not just one
    // that went through index.ts: the API/tests construct the arbiter
    // directly. Idempotent — a non-empty state file is left untouched.
    this.ensureServersSeeded();
    // Hydrate a detector for every declared server row that lacks one
    // (state file loaded at boot; rows added while the arbiter was down).
    if (this.detectorFactory) {
      for (const row of this.store.state.servers) {
        if (!this.detectors.has(row.id)) this.detectors.set(row.id, this.detectorFactory(row));
      }
    }
  }

  // ------------------------------------------------------------------
  // Clients
  // ------------------------------------------------------------------

  /**
   * Register (idempotent on name). Re-registration refreshes `last_seen`
   * (the client's liveness heartbeat — the dashboard shows it) and replaces
   * the reported project allocations (the client re-sends its queue depths
   * every poll tick, so the dashboard's per-project worker view stays fresh).
   *
   * `info` (optional) carries the client's own version string + wire-protocol
   * revision (the version handshake — a pre-version client sends neither and
   * keeps working; the fields stay absent on the row, never a rejection).
   *
   * IP rule (self-traffic exemption): the OBSERVED connection IP wins over
   * the client-reported one. The client's config carries a static tailnet
   * IP that goes stale when Tailscale reassigns addresses — a stale
   * exemption key silently breaks the correctness story. The reported
   * value is kept on `reported_ip` for display/audit only.
   */
  registerClient(
    name: string,
    reportedIp: string | undefined,
    observedIp: string,
    projects?: ProjectAllocation[],
    now?: number,
    info?: { version?: string; protocol?: number; revision?: string; gate_posture?: 'armed' | 'fail_open'; proxy_port?: number; daemon_behind?: boolean; client_log?: string[] },
  ): { client_id: string; created: boolean } {
    const s = this.store.state;
    const seen = now ?? Date.now();
    // Version handshake facts, sanitized at the edge (display-only; never a
    // gate). Malformed values are dropped, like any other bad report field
    // (same rule as stats: version is a string ≤64 chars, else absent).
    const version =
      typeof info?.version === 'string' && info.version.trim() !== '' && info.version.trim().length <= 64
        ? info.version.trim()
        : undefined;
    const protocol =
      typeof info?.protocol === 'number' && Number.isInteger(info.protocol) && info.protocol >= 0 && info.protocol <= 1000
        ? info.protocol
        : undefined;
    // Code-staleness (issue #49): the commit the client's running process
    // loaded its code from. Same sanitize rule as version (string ≤64
    // chars — a full SHA is 40, malformed → dropped, never a rejection).
    // The arbiter stores + echoes it; the comparison against the
    // operator's checkout lives in the surfaces (the arbiter has no view
    // of any client's repo tree).
    const revision =
      typeof info?.revision === 'string' && info.revision.trim() !== '' && info.revision.trim().length <= 64
        ? info.revision.trim()
        : undefined;
    // Gate posture (#41): an exact-value enum, everything else dropped
    // (same drop-don't-reject posture as every other reported display
    // field). Stored VERBATIM as the client last reported it — the posture
    // lives inside the router and the arbiter cannot observe it.
    const gatePosture =
      info?.gate_posture === 'armed' || info?.gate_posture === 'fail_open' ? info.gate_posture : undefined;
    // Session launcher (#43): the port the proxy actually bound. Sanitized
    // the same edge way — an integer in the real-port range, else dropped
    // (never a rejection). Stored on a valid report; an absent report
    // leaves the row as-is (the daemon registers before the proxy binds,
    // and old clients never send the key at all).
    const proxyPort =
      typeof info?.proxy_port === 'number' && Number.isInteger(info.proxy_port) && info.proxy_port >= 1 && info.proxy_port <= 65535
        ? info.proxy_port
        : undefined;
    // Code-staleness verdict (#61 step 3 A1): a plain boolean, computed
    // WHERE THE FACTS LIVE (the client runs from the checkout; the arbiter
    // cannot see any client's repo tree). Drop-don't-reject like every
    // other reported display field: a non-boolean is dropped. A `true`
    // report stores the marker; `false` CLEARS it (the explicit
    // no-exception report clears the stored exception — the same posture
    // as the session gate block: an absent report leaves the row as-is, so
    // a pre-#61-step-3 client's row never changes).
    const daemonBehind = typeof info?.daemon_behind === 'boolean' ? info.daemon_behind : undefined;
    // Client log tail (#61 step 3 A2): client-published display data —
    // bounded hard like the queue preview (state-file bloat is the same
    // risk): ≤120 lines, each line trimmed and capped at 300 chars,
    // non-string entries dropped. A non-array drops the whole key
    // (malformed → absent, never a rejection); an EMPTY (or all-dropped)
    // array clears the stored tail — a daemon that stops publishing lines
    // must not leave stale lines on the row forever.
    let clientLog: string[] | undefined;
    let clientLogPresent = false;
    if (Array.isArray(info?.client_log)) {
      clientLogPresent = true;
      clientLog = [];
      for (const l of info!.client_log as unknown[]) {
        if (clientLog.length >= 120) break;
        if (typeof l !== 'string') continue;
        const t = l.trim();
        if (t !== '') clientLog.push(t.slice(0, 300));
      }
    }
    const existing = s.clients.find((c) => c.name === name);
    if (existing) {
      if (validIp(observedIp)) existing.ip = observedIp; // observed wins
      if (reportedIp) existing.reported_ip = reportedIp;
      if (observedIp) existing.observed_ip = observedIp;
      existing.last_seen = seen;
      // Scheduled rebuild event (issue #3): derived from the heartbeat's
      // last_rebuild — when a project reports a NEW run (last_run_ts moved),
      // log `queue 445 → 512 (exit 0)` so the operator sees the queue
      // refilling in the dashboard without opening the client log. Purely
      // client-published data; the arbiter never runs or parses rebuilds.
      if (projects) this.noteRebuilds(existing.projects, projects);
      if (projects) existing.projects = projects;
      // Re-registration is a heartbeat: the version handshake facts track
      // the latest report (a restart from an older/newer checkout updates
      // the row; an older client that never sends them leaves the row as-is).
      if (version) existing.version = version;
      if (protocol !== undefined) existing.protocol = protocol;
      // Code-staleness: same heartbeat rule — a daemon restart reports its
      // new boot commit and updates the row within one tick (the surfaces'
      // `daemon behind` tag clears on that heartbeat); a client that never
      // sends the field leaves the row exactly as it was.
      if (revision) existing.revision = revision;
      // Gate posture (#41): the same heartbeat rule as version/revision —
      // a present, valid report updates the row; absent leaves it as-is.
      // A gate-bearing daemon re-registers `armed` on the first tick after
      // its link returns, so a recovered gate overwrites the stale
      // `fail_open` within one poll (the surfaces render only fail_open).
      if (gatePosture) existing.gate_posture = gatePosture;
      // Proxy port (#43): same heartbeat rule — a valid report updates the
      // row (the proxy rebind on restart is reflected within one tick);
      // absent leaves it as-is.
      if (proxyPort) existing.proxy_port = proxyPort;
      // Code-staleness verdict (#61 step 3 A1): present updates (true
      // stores, false clears — the restart clears the tag inside one
      // heartbeat); absent (a pre-#61-step-3 client) leaves the row exactly
      // as it was.
      if (daemonBehind === true) existing.daemon_behind = true;
      else if (daemonBehind === false) delete existing.daemon_behind;
      // Client log tail (#61 step 3 A2): a present (array) report replaces
      // the stored tail — a cleaned empty tail deletes the key (no
      // exception, no row key); absent leaves it as-is.
      if (clientLogPresent) {
        if (clientLog && clientLog.length > 0) existing.client_log = clientLog;
        else delete existing.client_log;
      }
      this.store.save();
      return { client_id: existing.client_id, created: false };
    }
    const client_id = `c-${randomBytes(4).toString('hex')}`;
    s.clients.push({
      name,
      client_id,
      // Observed wins on first contact too; the reported value is the
      // fallback for an older client that never shows a real IP.
      ip: validIp(observedIp) ? observedIp : (reportedIp ?? observedIp),
      ...(reportedIp ? { reported_ip: reportedIp } : {}),
      observed_ip: observedIp,
      registered_at: new Date(seen).toISOString(),
      last_seen: seen,
      projects: projects ?? [],
      ...(version ? { version } : {}),
      ...(protocol !== undefined ? { protocol } : {}),
      ...(revision ? { revision } : {}),
      ...(gatePosture ? { gate_posture: gatePosture } : {}),
      ...(proxyPort ? { proxy_port: proxyPort } : {}),
      // Same store rule as the heartbeat path: only an EXCEPTION key lands
      // on the row (daemon_behind false = no exception = no key; an empty
      // log tail = no key).
      ...(daemonBehind === true ? { daemon_behind: true } : {}),
      ...(clientLog && clientLog.length > 0 ? { client_log: clientLog } : {}),
    });
    this.store.appendEvent({ kind: 'client_registered', detail: `${name} (${client_id})` });
    // A fresh registration that already carries rebuild state (client
    // restarted mid-cadence) surfaces the last run too — no prior row to
    // compare against, so every reported run counts as new.
    if (projects) this.noteRebuilds([], projects);
    this.store.trim();
    this.store.save();
    return { client_id, created: true };
  }

  /**
   * Emit a `rebuild` event for every project whose heartbeat-reported
   * `last_rebuild` is NEWER than what the stored row carries (issue #3).
   * The comparison is on last_run_ts, so the same run never double-logs
   * across the 20s re-registration heartbeat, and a client restart that
   * re-reports its persisted state stays quiet.
   */
  private noteRebuilds(prev: ProjectAllocation[], next: ProjectAllocation[]): void {
    for (const p of next) {
      const rb = p.last_rebuild;
      if (!rb) continue;
      const before = prev.find((x) => x.name === p.name)?.last_rebuild;
      if (before && before.last_run_ts >= rb.last_run_ts) continue;
      this.store.appendEvent({
        kind: 'rebuild',
        project: p.name,
        detail: `queue ${rb.queue_before} → ${rb.queue_after} (exit ${rb.exit_code}, ${rb.duration_ms}ms)`,
      });
    }
  }

  clientIp(clientId: string): string | null {
    const c = this.store.state.clients.find((x) => x.client_id === clientId);
    return c ? c.ip : null;
  }

  // ------------------------------------------------------------------
  // Client overrides (pause / force)
  // ------------------------------------------------------------------

  /**
   * The override that is in force for a client at `now`, or null:
   *   - no override stored
   *   - override expired (until !== null && now >= until)
   *   - client no longer registered (defensive; tick trims these)
   */
  activeOverride(clientId: string, now?: number): ClientOverride | null {
    const n = now ?? Date.now();
    const o = this.store.state.overrides[clientId];
    if (!o) return null;
    if (o.until !== null && n >= o.until) return null;
    if (!this.store.state.clients.some((c) => c.client_id === clientId)) return null;
    return o;
  }

  /**
   * Set (replace) or clear (override: null) the override for a client,
   * addressed by name or client_id. Persists + records an event.
   */
  setClientOverride(
    ref: string,
    override: 'pause' | 'force' | null,
    until?: number,
  ): { ok: boolean; reason?: string; override?: ClientOverride | null; client_name?: string } {
    const s = this.store.state;
    const client = s.clients.find((c) => c.client_id === ref || c.name === ref);
    if (!client) return { ok: false, reason: 'unknown_client' };
    if (override !== null && until !== undefined) {
      const n = Date.now();
      if (!Number.isFinite(until) || until <= n) return { ok: false, reason: 'until_must_be_in_the_future' };
    }

    if (override === null) {
      const had = s.overrides[client.client_id];
      delete s.overrides[client.client_id];
      if (had) {
        this.store.appendEvent({
          kind: 'client_override_cleared',
          detail: `${client.name}: ${had.override} cleared`,
        });
      }
      this.store.trim();
      this.store.save();
      return { ok: true, override: null, client_name: client.name };
    }

    const o: ClientOverride = {
      client_id: client.client_id,
      override,
      until: until ?? null,
      set_at: Date.now(),
    };
    s.overrides[client.client_id] = o;
    this.store.appendEvent({
      kind: override === 'pause' ? 'client_paused' : 'client_forced',
      detail: `${client.name}${o.until ? ` (until ${new Date(o.until).toISOString().slice(11, 16)}Z)` : ''}`,
    });
    this.store.trim();
    this.store.save();
    return { ok: true, override: o, client_name: client.name };
  }

  // ------------------------------------------------------------------
  // Grants
  // ------------------------------------------------------------------

  requestLease(params: {
    client_id: string;
    project: string;
    job_id: string;
    estimated_seconds: number;
    /** Engine to run on; absent = the watched server (single-engine legacy). */
    server_id?: string;
    now?: number;
    /** Explicit signal override (tests / single-server callers). */
    signal?: IdleSignal;
  }): LeaseGrantResult {
    const now = params.now ?? Date.now();
    const s = this.store.state;

    const client = s.clients.find((c) => c.client_id === params.client_id);
    if (!client) return { ok: false, reason: 'unknown_client' };

    // Per-engine admission: the lease belongs to a declared server row.
    const serverId = params.server_id ?? WATCHED_SERVER_ID;
    const server = s.servers.find((x) => x.id === serverId);
    if (!server) return { ok: false, reason: 'unknown_server' };

    // The server's own idle verdict. An explicit `signal` applies only to
    // the watched server (legacy single-signal callers/tests); every other
    // server is judged by its own detector — and a server with no detector
    // is fail-closed: idle cannot be proven, so no grants.
    const det = this.detectors.get(serverId);
    if (!det && params.signal === undefined && serverId !== WATCHED_SERVER_ID) {
      return { ok: false, reason: 'not_idle' };
    }
    const sig = params.signal ?? det?.signal(now);
    if (!sig) return { ok: false, reason: 'not_idle' };

    // A 'pause' override is a hard stop for that client — it is reported
    // preferentially (before idle/busy) so the operator's decision is the
    // reason a denied lease gets. It does not touch an already-active lease
    // (the client is mid-run; revocation is driven by idle/preempt/TTL only).
    if (this.activeOverride(params.client_id, now)?.override === 'pause') {
      return { ok: false, reason: 'client_paused' };
    }

    // Anti-thrash (per-job): a job the operator must unthrottle is refused
    // before the idle/busy checks — its denial reason must be the throttle,
    // not a coincidental busy box. Then the per-job cooldown: after any
    // failed lease for this job no new grant until the cooldown elapses
    // (even below the throttle threshold) — this breaks the ~20-second
    // re-grant loop of a client that keeps re-asking for the same crashed
    // job. Both are independent of what the client does.
    const jkey = this.jobKey(params.project, params.job_id);
    if (this.store.state.throttled_jobs[jkey]) {
      return { ok: false, reason: 'job_throttled' };
    }
    const cd = this.jobCooldownUntil.get(jkey);
    if (cd !== undefined && now < cd) {
      return { ok: false, reason: 'job_cooldown' };
    }

    // `sig.idle` is false while degraded (detector invariant), so this single
    // check enforces both "system idle" and "no grants while degraded".
    // An active 'force' override bypasses ONLY the idle verdict and the
    // post-revocation reidle gate — never a degraded signal, because a
    // degraded signal means the activity data itself is unreliable and a
    // forced grant on stale data is exactly the interactive-traffic
    // collision the arbiter exists to prevent.
    //
    // SESSION FOLDING (#32): a session active on this server within
    // idle_seconds is interactive traffic — it defeats idle JUST LIKE a feed
    // entry does, and a 'force' override does NOT bypass it (force bypasses
    // the detector's idle verdict for BACKGROUND pressure; live interactive
    // sessions are the exact collision force must never create). Reidle is
    // per-server: one engine's revocation never gates another's grants.
    const sessionBusy = this.sessionActivityOn(serverId, now);
    const forced = this.activeOverride(params.client_id, now)?.override === 'force';
    if (!forced) {
      if (!sig.idle) return { ok: false, reason: 'not_idle' };
      if (sessionBusy !== null && now - sessionBusy < this.effectiveIdleSeconds(params.project) * 1000) {
        return { ok: false, reason: 'not_idle' };
      }
      // Post-revocation reidle rule (per server): after any revocation on
      // THIS server, require a fresh full idle before its next grant (a
      // regrant in the same poll would let a burst of backfill follow a
      // preempt).
      if (this.reidleAfter.has(serverId)) return { ok: false, reason: 'not_idle' };
    } else if (sig.signal_degraded || sessionBusy !== null) {
      // Force ≠ "grant on stale data" (degraded) and ≠ "collide with a live
      // session" (sessionBusy within the idle window blocks even force).
      return { ok: false, reason: 'not_idle' };
    }

    const active = this.activeLeases(now);
    const project = this.cfg.projects.find((p) => p.name === params.project);
    if (!project) return { ok: false, reason: 'unknown_project' };
    if (project.paused) return { ok: false, reason: 'project_paused' };

    // Per-project grant knobs override the globals (unset = inherit).
    // The concurrency cap is PER SERVER: leases on another engine never
    // occupy this engine's slot.
    const maxLeases = project.max_concurrent_leases ?? this.cfg.max_concurrent_leases;
    const activeHere = active.filter((l) => leaseServerId(l) === serverId);
    if (activeHere.length >= maxLeases) return { ok: false, reason: 'busy' };

    const used = this.projectTokensOut(params.project, utcDay(now));
    if (used >= project.daily_token_cap) return { ok: false, reason: 'budget_exhausted' };

    const ttlSeconds = project.lease_ttl_seconds ?? this.cfg.lease_ttl_seconds;
    // Adaptive lease TTL: when the client reports a positive per-job estimate,
    // the lease is capped at estimate × safety factor — floored at the
    // lease_ttl_floor and capped at the effective global TTL, so it can only
    // expire SOONER than today's behavior, never later. No/zero estimate ⇒
    // the full TTL (today's behavior). The estimate is a first-run guess, so
    // the factor is a config knob (default 2), never 1.
    const est = Math.max(0, params.estimated_seconds || 0);
    const leaseTtl = computeLeaseTtl(
      est,
      ttlSeconds,
      this.cfg.lease_ttl_safety_factor,
      this.cfg.lease_ttl_floor_seconds,
    );
    const lease: Lease = {
      lease_id: `l-${randomBytes(4).toString('hex')}`,
      client_id: client.client_id,
      client_name: client.name,
      exempt_ip: client.ip,
      server_id: serverId,
      project: project.name,
      job_id: String(params.job_id ?? ''),
      estimated_seconds: est,
      status: 'active',
      granted_at: now,
      expires_at: now + leaseTtl * 1000,
      tokens_out: 0,
      tokens_in: 0,
    };
    s.leases.push(lease);
    // The event detail records the effective TTL only when it differs from the
    // global — so the dashboard's event feed shows WHY a lease expired early.
    const ttlNote =
      leaseTtl !== ttlSeconds ? ` (ttl ${leaseTtl}s from est ${est}s*${fmtNum(this.cfg.lease_ttl_safety_factor)})` : '';
    this.store.appendEvent({ kind: 'lease_granted', project: lease.project, lease_id: lease.lease_id, detail: `${client.name}: ${lease.job_id}${ttlNote}` });
    this.store.trim();
    this.store.save();
    return { ok: true, lease };
  }

  // ------------------------------------------------------------------
  // Tick (called once per idle poll by the main loop)
  // ------------------------------------------------------------------

  /**
   * One poll cycle across ALL watched servers. Each server's detector is
   * polled with the shared lease-IP exemption set; revocation decisions
   * (TTL, preempt) are made per lease against ITS server's signal. The
   * returned `signal` is the watched server's (the legacy single-signal
   * view the boot log and TickResult consumers use).
   */
  async tick(now?: number): Promise<TickResult> {
    const nowMs = now ?? Date.now();
    const s = this.store.state;
    const exempt = activeLeaseExemptIps(s.leases, nowMs);

    // Poll every server's detector. A poll error is contained: that server
    // simply has no fresh signal this round (its leases are not judged from
    // stale data, and grants there stay fail-closed).
    const signals = new Map<string, IdleSignal>();
    for (const [serverId, det] of this.detectors) {
      try {
        signals.set(serverId, await det.poll(nowMs, exempt));
      } catch {
        /* no signal this round for this server */
      }
    }

    // Mirror the WATCHED server's degraded transition into the top-level
    // state fields + events (those fields predate multi-engine and are the
    // dashboard header's watched-server view; per-server detail rides
    // serverView).
    const watched = signals.get(WATCHED_SERVER_ID);
    if (watched && watched.signal_degraded !== s.signal_degraded) {
      s.signal_degraded = watched.signal_degraded;
      s.degraded_reason = watched.degraded_reason;
      this.store.appendEvent({
        kind: watched.signal_degraded ? 'signal_degraded' : 'signal_recovered',
        detail: watched.degraded_reason ?? undefined,
      });
    }
    if (watched) {
      s.last_activity = watched.last_activity;
      s.last_log_write = watched.last_log_write;
    }

    const revoked: { lease: Lease; reason: string }[] = [];
    /** Servers that had a lease end this round (per-server reidle arming). */
    const endedOn = new Set<string>();

    for (const lease of s.leases) {
      if (lease.status !== 'active') continue;
      const serverId = leaseServerId(lease);

      // 1. TTL expiry.
      if (nowMs >= lease.expires_at) {
        this.endLease(lease, 'expired', 'ttl_expired', nowMs);
        revoked.push({ lease, reason: 'ttl_expired' });
        endedOn.add(serverId);
        continue;
      }

      // 2. Session preempt (#32): a session's own activity on THIS server
      //    post-dating the grant preempts the lease — even when the feed
      //    exempts it (the router shares the lease holder's IP) and even
      //    when the feed is degraded (a session row is direct evidence of
      //    interactive traffic, not stale data).
      const sessAct = this.sessionActivityOn(serverId);
      if (sessAct !== null && sessAct >= lease.granted_at) {
        this.endLease(lease, 'revoked', 'preempted', nowMs);
        revoked.push({ lease, reason: 'preempted' });
        endedOn.add(serverId);
        continue;
      }

      // 3. Feed preempt: the server is NOT idle because of FOREIGN
      //    (non-exempt) activity that appeared after this lease was
      //    granted. No signal for this server: don't judge from stale
      //    signals (skip). A non-exempt entry OLDER than the grant does
      //    not revoke.
      const sig = signals.get(serverId);
      if (sig && !sig.signal_degraded && !sig.idle && sig.last_activity) {
        if (sig.last_activity.ts >= lease.granted_at) {
          this.endLease(lease, 'revoked', 'preempted', nowMs);
          revoked.push({ lease, reason: 'preempted' });
          endedOn.add(serverId);
        }
      }
    }

    // Sweep client overrides: drop expired ones (now >= until) and orphans
    // (client no longer registered) so state stays clean between writes.
    for (const [cid, o] of Object.entries(s.overrides)) {
      const gone =
        !s.clients.some((c) => c.client_id === cid) ||
        (o.until !== null && nowMs >= o.until);
      if (gone) delete s.overrides[cid];
    }

    // Sweep session overrides (expired) and stale session rows (a router
    // that stopped heartbeating; the row's last_activity already stops
    // folding once it ages past idle_seconds, the sweep just bounds state).
    for (const [tok, o] of Object.entries(s.session_overrides)) {
      if (o.until !== null && nowMs >= o.until) delete s.session_overrides[tok];
    }
    const before = s.sessions.length;
    s.sessions = s.sessions.filter((sess) => nowMs - sess.last_seen < Arbiter.SESSION_STALE_MS);
    if (s.sessions.length !== before) this.store.appendEvent({ kind: 'session_swept', detail: `${before - s.sessions.length} stale session row(s) swept` });

    // Reidle bookkeeping (PER SERVER): any lease end on a server arms that
    // server's gate; a later poll where THAT server is fully idle — feed
    // idle AND no session activity within idle_seconds — disarms it.
    for (const serverId of endedOn) this.reidleAfter.set(serverId, nowMs);
    for (const serverId of [...this.reidleAfter.keys()]) {
      // Never disarm on the same round it armed (a TTL expiry on an idle
      // server must still wait for the NEXT poll's full-idle verdict).
      if (endedOn.has(serverId)) continue;
      const sig = signals.get(serverId);
      const sessAct = this.sessionActivityOn(serverId, nowMs);
      const sessQuiet = sessAct === null || nowMs - sessAct >= this.cfg.idle_seconds * 1000;
      if (sig && sig.idle && sessQuiet) this.reidleAfter.delete(serverId);
    }

    this.store.trim();
    this.store.save();
    return {
      revoked,
      signal:
        watched ??
        signals.values().next().value ?? {
          now: nowMs,
          idle: false,
          idle_for_s: null,
          last_activity: null,
          last_log_write: null,
          signal_degraded: true,
          degraded_reason: 'no detectors',
          feed_enabled: true,
        },
    };
  }

  /**
   * True when a grant is currently blocked by the post-revocation reidle
   * rule. Per-server: pass the server_id (default: the watched server).
   */
  reidleGated(serverId: string = WATCHED_SERVER_ID): boolean {
    return this.reidleAfter.has(serverId);
  }

  /** The live idle signal for one server (null when it has no detector). */
  serverSignal(serverId: string, now?: number): IdleSignal | null {
    return this.detectors.get(serverId)?.signal(now ?? Date.now()) ?? null;
  }

  // ------------------------------------------------------------------
  // Catalog (aggregate endpoint #64 D4 — arbiter-built, router-published)
  // ------------------------------------------------------------------

  /**
   * One catalog cycle: probe every declared row's `/v1/models` WITH the
   * row's `auth_token` (the credentialed fetcher family, #60 B), merge
   * probe results over the declared lists, and publish the deduped
   * catalog in memory for `/api/state`'s `catalog` ADD-key.
   *
   * Rules honored (doc D4): a probe success REPLACES that row's declared
   * list; a probe failure keeps it (the row lands 'declared', never
   * falsely 'probed'); a bare name on N rows renders ONCE and pins to the
   * FIRST row in declaration order. The published block NEVER carries a
   * token — `auth_set` only. Never throws: a fetcher blip just means that
   * row keeps its declared inventory this round.
   */
  async probeCatalog(): Promise<CatalogEntry[]> {
    const rows = this.store.state.servers;
    const probed = new Map<string, string[]>();
    if (this.modelsFetcher) {
      const fetcher = this.modelsFetcher;
      await Promise.all(
        rows.map(async (row) => {
          try {
            const names = await fetcher(modelsProbeUrl(row.url), row.auth_token);
            if (Array.isArray(names) && names.length > 0) probed.set(row.id, names);
          } catch {
            /* probe-blocked: the declared list stands (drop-don't-reject) */
          }
        }),
      );
    }
    this.catalogPublished = buildCatalog(rows, probed);
    return this.catalogPublished;
  }

  /** The catalog the last probe cycle published (never contains tokens). */
  catalog(): CatalogEntry[] {
    return this.catalogPublished;
  }

  // ------------------------------------------------------------------
  // Sessions (router-self-registered interactive traffic — #32/#33)
  // ------------------------------------------------------------------

  /**
   * Register/heartbeat a session (idempotent on token). The router calls
   * this on first sight of a /s/<token> path and refreshes it with each
   * heartbeat; `last_activity` is the newest request the router saw on the
   * session (kept as the max — never rewound).
   *
   * `gate` (gate-state): the router's queue truth for the session —
   * { state: 'active' | 'queued', waiting: int ≥0 }. Stored verbatim on
   * every heartbeat (last-write-wins). The KEY BEING ABSENT (or null) is
   * the idle report: the stored gate CLEARS to null, so a session that
   * stopped waiting never stays tagged. An invalid block is DROPPED (the
   * registration is never rejected for it; the stored value stands).
   */
  registerSession(
    token: string,
    opts: { client_id?: string; client_name?: string; server_id?: string; last_activity?: number; gate?: unknown; session_id?: unknown; history?: unknown; now?: number },
  ): { ok: boolean; reason?: string; created: boolean; session?: SessionRecord } {
    const t = typeof token === 'string' ? token.trim() : '';
    if (!t || t.length > 128) return { ok: false, reason: 'token required (≤128 chars)', created: false };
    const nowMs = opts.now ?? Date.now();
    const gateVerdict = normalizeSessionGate(opts.gate);
    // #42 Slice 0: the Hermes conversation id, sanitized the token way —
    // bounded printable, and an invalid value is DROPPED (never a rejection,
    // never a clear of a stored id).
    const sessionId = cleanReportedId(opts.session_id);
    // #45: the compact request history. Valid block replaces; absent
    // leaves the stored block (ADD-key posture — heartbeats with traffic
    // refresh it; an old client simply never sends it).
    const history = cleanReportedHistory(opts.history, nowMs);
    const s = this.store.state;
    const existing = s.sessions.find((x) => x.token === t);
    if (existing) {
      existing.last_seen = nowMs;
      if (opts.client_id) existing.client_id = opts.client_id;
      if (opts.client_name) existing.client_name = opts.client_name;
      if (opts.server_id) existing.server_id = opts.server_id;
      if (typeof opts.last_activity === 'number' && Number.isFinite(opts.last_activity)) {
        existing.last_activity = Math.max(existing.last_activity ?? 0, opts.last_activity);
      }
      // gate-state, last-write-wins: valid ⇒ store; null/absent ⇒ CLEAR
      // (idle report); invalid (undefined) ⇒ dropped, stored value stands.
      if (gateVerdict !== undefined) existing.gate = gateVerdict;
      // session_id (#42), last-known-wins: a valid report updates; an
      // absent one never clears a stored id (headerless requests on the
      // same token are routine).
      if (sessionId) existing.session_id = sessionId;
      if (history) existing.history = history;
      this.store.save();
      return { ok: true, created: false, session: existing };
    }
    const session: SessionRecord = {
      token: t,
      ...(opts.client_id ? { client_id: opts.client_id } : {}),
      ...(opts.client_name ? { client_name: opts.client_name } : {}),
      ...(opts.server_id ? { server_id: opts.server_id } : {}),
      registered_at: nowMs,
      last_seen: nowMs,
      last_activity: typeof opts.last_activity === 'number' && Number.isFinite(opts.last_activity) ? opts.last_activity : null,
      // On create: valid or explicit-null ride; invalid is dropped whole
      // (the row starts gate-less, exactly like an absent block).
      ...(gateVerdict !== undefined ? { gate: gateVerdict } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(history ? { history } : {}),
    };
    s.sessions.push(session);
    this.store.appendEvent({ kind: 'session_registered', detail: `${t}${session.client_name ? ` (${session.client_name})` : ''}${session.server_id ? ` → ${session.server_id}` : ''}` });
    this.store.trim();
    this.store.save();
    return { ok: true, created: true, session };
  }

  /** All session rows, newest registration last — for /api/state. */
  listSessions(): SessionRecord[] {
    return [...this.store.state.sessions].sort((a, b) => a.registered_at - b.registered_at);
  }

  /**
   * The newest session activity (epoch-ms) on a server, or null. Feeds the
   * idle folding (#32): session traffic defeats idle and preempts leases
   * even when the engine feed exempts it (same-IP router).
   */
  sessionActivityOn(serverId: string, _now?: number): number | null {
    let newest: number | null = null;
    for (const sess of this.store.state.sessions) {
      if (leaseServerId(sess) !== serverId) continue;
      if (sess.last_activity !== null && (newest === null || sess.last_activity > newest)) newest = sess.last_activity;
    }
    return newest;
  }

  /** The session override in force for a token at `now`, or null (expired → null). */
  activeSessionOverride(token: string, now?: number): SessionOverride | null {
    const n = now ?? Date.now();
    const o = this.store.state.session_overrides[token];
    if (!o) return null;
    if (o.until !== null && n >= o.until) return null;
    return o;
  }

  /**
   * Set (replace) or clear (override: null) the operator override for a
   * session token. Same shape/semantics as client overrides (#32): 'pause'
   * asks the router to hold that session's traffic; 'force' is the
   * operator's explicit go-ahead. Persists + records an event.
   */
  setSessionOverride(
    token: string,
    override: 'pause' | 'force' | null,
    until?: number,
  ): { ok: boolean; reason?: string; override?: SessionOverride | null } {
    const s = this.store.state;
    const session = s.sessions.find((x) => x.token === token);
    if (!session) return { ok: false, reason: 'unknown_session' };
    if (override !== null && until !== undefined) {
      const n = Date.now();
      if (!Number.isFinite(until) || until <= n) return { ok: false, reason: 'until_must_be_in_the_future' };
    }
    if (override === null) {
      const had = s.session_overrides[session.token];
      delete s.session_overrides[session.token];
      if (had) {
        this.store.appendEvent({ kind: 'session_override_cleared', detail: `${session.token}: ${had.override} cleared` });
      }
      this.store.trim();
      this.store.save();
      return { ok: true, override: null };
    }
    const o: SessionOverride = { token: session.token, override, until: until ?? null, set_at: Date.now() };
    s.session_overrides[session.token] = o;
    this.store.appendEvent({
      kind: override === 'pause' ? 'session_paused' : 'session_forced',
      detail: `${session.token}${o.until ? ` (until ${new Date(o.until).toISOString().slice(11, 16)}Z)` : ''}`,
    });
    this.store.trim();
    this.store.save();
    return { ok: true, override: o };
  }

  /** Effective idle threshold for a project (per-project override wins). */
  private effectiveIdleSeconds(project: string): number {
    return this.cfg.projects.find((p) => p.name === project)?.idle_seconds ?? this.cfg.idle_seconds;
  }

  // ------------------------------------------------------------------
  // Finishing + usage
  // ------------------------------------------------------------------

  /**
   * Finish a lease with reported usage.
   *
   * Idempotency is per-lease, not per-status: the FIRST usage report adds
   * the reported tokens to the project's UTC-day counter (day of the
   * report); repeated finishes keep the max on the lease record and add
   * nothing (no double count). A preempted lease therefore counts its
   * partial teardown report exactly once — at the moment the client sends
   * it, which is the "client reports partial usage at teardown" path.
   */
  finishLease(params: {
    lease_id: string;
    tokens_out?: number;
    tokens_in?: number;
    ok: boolean;
    error?: string;
    /**
     * Client-reported failure detail (last ≤1000 chars of the executor's
     * combined output; '' when it produced none). Stored on the lease
     * record and rides the `lease_finished` event (truncated).
     */
    error_detail?: string;
    /**
     * Client-reported score from the result line (issue #4). number|null;
     * anything else (missing, garbage) stores as null.
     */
    score?: number | null;
    now?: number;
  }): { ok: boolean; reason?: string; lease?: Lease } {
    const nowMs = params.now ?? Date.now();
    const s = this.store.state;
    const lease = s.leases.find((l) => l.lease_id === params.lease_id);
    if (!lease) return { ok: false, reason: 'unknown_lease' };

    const to = Math.max(0, params.tokens_out ?? 0);
    const ti = Math.max(0, params.tokens_in ?? 0);

    // Keep the max ever reported (duplicate/partial reports never shrink it).
    lease.tokens_out = Math.max(lease.tokens_out, to);
    lease.tokens_in = Math.max(lease.tokens_in, ti);
    lease.partial = params.ok === false;
    if (params.error_detail !== undefined) {
      lease.error_detail = String(params.error_detail).slice(0, 1000);
    }

    if (!lease.usage_counted) {
      this.addBudget(lease.project, utcDay(nowMs), lease.tokens_out, lease.tokens_in);
      lease.usage_counted = true;
    }

    // Per-job outcome row (issue #4): the LAST reported outcome for
    // (project, job_id), written on EVERY usage report — a later report
    // (re-grant, or a duplicate finish with fresher numbers) REPLACES the
    // row. ts is the server receive time, so the fake-clock tests stay
    // deterministic and the eviction order is the arbiter's own timeline.
    this.recordJobResult(lease.project, lease.job_id, params.ok, params.score, lease.tokens_out, lease.tokens_in, params.ok ? null : params.error ?? 'failed', nowMs);

    if (lease.status === 'active') {
      // First terminal transition.
      lease.status = params.ok ? 'finished' : 'revoked';
      if (!params.ok) lease.end_reason = params.error ?? 'failed';
      lease.ended_at = nowMs;
      const detailShort =
        lease.error_detail && lease.error_detail.length > 300
          ? `…${lease.error_detail.slice(-300)}`
          : lease.error_detail;
      this.store.appendEvent({
        kind: 'lease_finished',
        project: lease.project,
        lease_id: lease.lease_id,
        detail: `${lease.client_name}: ${lease.job_id} ok=${params.ok} out=${lease.tokens_out}${params.error ? ` err=${params.error}` : ''}${detailShort ? ` detail=${detailShort}` : ''}`,
      });
      // Anti-thrash bookkeeping (first terminal transition only — a
      // duplicate report must not re-count the job).
      if (params.ok) {
        this.recordJobSuccess(lease.project, lease.job_id, nowMs);
      } else {
        this.recordJobFailure(
          lease.project,
          lease.job_id,
          params.error ?? 'failed',
          lease.error_detail ?? '',
          nowMs,
        );
      }
    }
    // (already terminal: usage recorded above; status/end_reason stay as-is)

    this.store.trim();
    this.store.save();
    return { ok: true, lease };
  }

  // ------------------------------------------------------------------
  // Anti-thrash (per-job failure tracking)
  // ------------------------------------------------------------------

  private jobKey(project: string, jobId: string): string {
    return `${project}::${jobId}`;
  }

  /**
   * A successful (ok:true) report for (project, job_id): the failure count
   * resets to 0 and the grant cooldown is cleared — the job is proven
   * healthy again and the next idle poll may re-grant it.
   */
  private recordJobSuccess(project: string, jobId: string, nowMs: number): void {
    const jkey = this.jobKey(project, jobId);
    this.jobFailCounts.delete(jkey);
    this.jobCooldownUntil.delete(jkey);
    void nowMs;
  }

  /**
   * A failed (ok:false) usage report for (project, job_id):
   *   1. per-job grant cooldown arms (job_cooldown_seconds from now) —
   *      refuses re-grants of the same job between polls even when the
   *      count is far below the threshold;
   *   2. the failure count bumps; when it reaches `job_fail_threshold` the
   *      job is THROTTLED: a persisted `throttled_jobs` row (project,
   *      job_id, count, last_error, last_error_detail ≤1000,
   *      last_failed_at) — survives restarts and blocks every grant for
   *      that job until the operator unthrottles it.
   * TTL expirations never call this (see endLease) — a dead client is an
   * unknown outcome, not a job failure.
   */
  private recordJobFailure(project: string, jobId: string, error: string, errorDetail: string, nowMs: number): void {
    const jkey = this.jobKey(project, jobId);
    const cooldownMs = Math.max(0, this.cfg.job_cooldown_seconds) * 1000;
    this.jobCooldownUntil.set(jkey, nowMs + cooldownMs);
    const count = (this.jobFailCounts.get(jkey) ?? 0) + 1;
    this.jobFailCounts.set(jkey, count);
    const threshold = Math.max(1, this.cfg.job_fail_threshold);
    if (count >= threshold) {
      const row: JobThrottle = {
        project,
        job_id: jobId,
        count,
        last_error: error,
        last_error_detail: String(errorDetail).slice(0, 1000),
        last_failed_at: nowMs,
      };
      this.store.state.throttled_jobs[jkey] = row;
      this.store.appendEvent({
        kind: 'job_throttled',
        project,
        detail: `${jobId}: ${count} failures (last: ${error}) — no more grants until unthrottled`,
      });
    }
  }

  /**
   * Per-job outcome row (issue #4): store the LAST reported outcome for
   * (project, job_id) — the same `project::job_id` key shape as the
   * throttle rows. Latest-only: a newer report replaces the row. After the
   * write, evict the oldest-by-ts rows beyond `resultsPerProjectCap` for
   * that project so the state file stays bounded.
   */
  private recordJobResult(
    project: string,
    jobId: string,
    ok: boolean,
    score: number | null | undefined,
    tokensOut: number,
    tokensIn: number,
    error: string | null,
    nowMs: number,
  ): void {
    const s = this.store.state;
    const row: JobResultRow = {
      project,
      job_id: jobId,
      ok,
      score: typeof score === 'number' && Number.isFinite(score) ? score : null,
      tokens_out: tokensOut,
      tokens_in: tokensIn,
      error: error ?? null,
      ts: new Date(nowMs).toISOString(),
    };
    s.results[this.jobKey(project, jobId)] = row;
    // Cap per project: keep the newest `resultsPerProjectCap` rows by ts.
    const cap = this.store.resultsPerProjectCap;
    const mine = Object.entries(s.results).filter(([, r]) => r.project === project);
    if (mine.length > cap) {
      mine.sort((a, b) => Date.parse(a[1].ts) - Date.parse(b[1].ts));
      for (const [key] of mine.slice(0, mine.length - cap)) delete s.results[key];
    }
  }

  /**
   * Result rows for a project (issue #4), NEWEST FIRST. `jobId` filters to
   * one job; `limit` caps the page. The GET /api/projects/:name/results
   * route is the only consumer — rows are deliberately NOT embedded in
   * /api/state.
   */
  projectResults(project: string, opts: { limit?: number; job_id?: string } = {}): JobResultRow[] {
    const rows = Object.values(this.store.state.results).filter(
      (r) => r.project === project && (!opts.job_id || r.job_id === opts.job_id),
    );
    rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const limit = opts.limit ?? 20;
    return rows.slice(0, Math.max(1, limit));
  }

  /**
   * Operator recovery: clear the job's throttle row (if any), its failure
   * count, and its grant cooldown. Idempotent — clearing an unthrottled
   * job succeeds. Unknown projects are 404-able; unknown (project, job)
   * pairs that were never throttled still clear (a no-op that also resets
   * the in-memory counters).
   */
  unthrottleJob(project: string, jobId: string): { ok: boolean; reason?: string; was_throttled: boolean } {
    const p = this.cfg.projects.find((x) => x.name === project);
    if (!p) return { ok: false, reason: 'unknown_project', was_throttled: false };
    const jkey = this.jobKey(project, jobId);
    const wasThrottled = Boolean(this.store.state.throttled_jobs[jkey]);
    if (wasThrottled) {
      const row = this.store.state.throttled_jobs[jkey]!;
      delete this.store.state.throttled_jobs[jkey];
      this.store.appendEvent({
        kind: 'job_unthrottled',
        project,
        detail: `${jobId}: throttle cleared by operator (was ${row.count} failures, last: ${row.last_error})`,
      });
    }
    this.jobFailCounts.delete(jkey);
    this.jobCooldownUntil.delete(jkey);
    this.store.trim();
    this.store.save();
    return { ok: true, was_throttled: wasThrottled };
  }

  /** All throttled jobs (persisted rows), newest last — for /api/state + the dashboard. */
  throttledJobs(): JobThrottle[] {
    return Object.values(this.store.state.throttled_jobs).sort((a, b) => a.last_failed_at - b.last_failed_at);
  }

  // ------------------------------------------------------------------
  // Projects
  // ------------------------------------------------------------------

  setProjectPaused(name: string, paused: boolean): { ok: boolean; reason?: string } {
    const p = this.cfg.projects.find((x) => x.name === name);
    if (!p) return { ok: false, reason: 'unknown_project' };
    p.paused = paused;
    this.store.appendEvent({ kind: paused ? 'project_paused' : 'project_resumed', project: name });
    this.syncProjectRows();
    this.store.trim();
    this.store.save();
    return { ok: true };
  }

  /**
   * Project-level grant settings (idle_seconds / max_concurrent_leases /
   * lease_ttl_seconds). A value of null CLEARS the per-project override —
   * the project inherits the global knob again. Persisted on the live project
   * config object (survives restarts via the state file's project rows).
   */
  setProjectSettings(
    name: string,
    settings: { idle_seconds?: number | null; max_concurrent_leases?: number | null; lease_ttl_seconds?: number | null },
  ): { ok: boolean; reason?: string } {
    const p = this.cfg.projects.find((x) => x.name === name);
    if (!p) return { ok: false, reason: 'unknown_project' };
    const setKnob = (key: 'idle_seconds' | 'max_concurrent_leases' | 'lease_ttl_seconds', v: number | null | undefined) => {
      if (v === null) delete p[key];
      else if (typeof v === 'number' && Number.isFinite(v) && v > 0) p[key] = v;
    };
    setKnob('idle_seconds', settings.idle_seconds);
    setKnob('max_concurrent_leases', settings.max_concurrent_leases);
    setKnob('lease_ttl_seconds', settings.lease_ttl_seconds);
    const changed =
      settings.idle_seconds !== undefined ||
      settings.max_concurrent_leases !== undefined ||
      settings.lease_ttl_seconds !== undefined;
    if (!changed) return { ok: true };
    this.store.appendEvent({
      kind: 'project_settings_updated',
      project: name,
      detail: [
        p.idle_seconds != null ? `idle≥${p.idle_seconds}s` : '',
        p.max_concurrent_leases != null ? `max ${p.max_concurrent_leases}` : '',
        p.lease_ttl_seconds != null ? `ttl ${p.lease_ttl_seconds}s` : '',
      ]
        .filter(Boolean)
        .join(' · ') || 'inheriting globals',
    });
    this.syncProjectRows();
    this.store.trim();
    this.store.save();
    return { ok: true };
  }

  /**
   * Mirror the live project config rows (pause + per-project knobs) into the
   * state file's persisted project rows; rows for projects removed from
   * config are dropped. Called after every project mutation and once at
   * boot (after the re-hydration) so the persisted rows are truth.
   */
  syncProjectRows(): void {
    const nowMs = Date.now();
    const prev = new Map(this.store.state.projects.map((r) => [r.name, r]));
    this.store.state.projects = this.cfg.projects.map((p) => ({
      name: p.name,
      paused: p.paused,
      idle_seconds: p.idle_seconds,
      max_concurrent_leases: p.max_concurrent_leases,
      lease_ttl_seconds: p.lease_ttl_seconds,
      updated_at: prev.get(p.name)?.updated_at ?? nowMs,
    }));
  }

  // ------------------------------------------------------------------
  // Inference-server connections
  // ------------------------------------------------------------------

  /**
   * Seed the declared-server inventory from config on first load (old state
   * files have no `servers` key). Once rows exist they are operator-managed
   * via the API and are NOT re-seeded — config is the initial declaration,
   * the state file is the live truth.
   */
  ensureServersSeeded(): void {
    const s = this.store.state;
    if (s.servers.length > 0) return;
    const nowMs = Date.now();
    s.servers.push({
      id: WATCHED_SERVER_ID,
      name: this.cfg.server_name ?? 'llama-swap',
      // strata rows normalize to the service origin (#60 B): the feed
      // lives at origin+/metrics; operators paste the OpenAI base /v1.
      url: this.cfg.server_provider === 'strata' ? feedOrigin(this.cfg.llama_swap_url) : this.cfg.llama_swap_url,
      activity_path: this.cfg.activity_path,
      ...(this.cfg.server_provider ? { provider: this.cfg.server_provider } : {}),
      ...(this.cfg.log_glob ? { log_glob: this.cfg.log_glob } : {}),
      ...(this.cfg.server_auth_token ? { auth_token: this.cfg.server_auth_token } : {}),
      models: [...(this.cfg.server_models ?? [])],
      peers: [...(this.cfg.server_peers ?? [])],
      configured_at: nowMs,
      updated_at: nowMs,
    });
    this.store.save();
  }

  /**
   * Add (no `id`) or patch-update (with `id`) a declared server connection.
   * Create requires name + url; an update patches only the fields provided
   * (at least one must change). A created row gets its OWN idle detector
   * when the arbiter was built with a detectorFactory (per-engine
   * admission, #38): the arbiter now watches EVERY declared server, and a
   * row without a detector (factory absent) is fail-closed for grants.
   */
  upsertServerConnection(input: {
    id?: string;
    name?: string;
    url?: string;
    activity_path?: string;
    log_glob?: string;
    provider?: string;
    auth_token?: string;
    models?: string[];
    peers?: string[];
  }): { ok: boolean; reason?: string; created: boolean; server?: ServerConnection } {
    const s = this.store.state;
    const strList = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined;
    const models = strList(input.models);
    const peers = strList(input.peers);
    // Provider kind (#60 B): the feed SHAPE this row answers. Invalid
    // values are rejected rather than silently defaulted — a wrong kind
    // silently mis-parses the feed and lands the row degraded.
    let provider: ServerProvider | undefined;
    if (typeof input.provider === 'string' && input.provider.trim() !== '') {
      const p = input.provider.trim();
      if (!(PROVIDER_KINDS as string[]).includes(p))
        return { ok: false, reason: `unknown provider kind: ${p} (expected ${PROVIDER_KINDS.join(' or ')})`, created: false };
      provider = p as ServerProvider;
    }
    const nowMs = Date.now();
    if (typeof input.id === 'string' && input.id.trim() !== '') {
      const row = s.servers.find((x) => x.id === input.id!.trim());
      if (!row) return { ok: false, reason: 'unknown_server', created: false };
      let changed = false;
      const touch = (apply: () => void) => {
        apply();
        changed = true;
      };
      if (typeof input.name === 'string' && input.name.trim() !== '') touch(() => void (row.name = input.name!.trim()));
      if (typeof input.url === 'string' && input.url.trim() !== '') touch(() => void (row.url = input.url!.trim()));
      // An EXPLICIT empty activity_path = feed-off declaration (#60 A1):
      // the key being PRESENT with an empty string disables the feed
      // signal; an absent key leaves the row untouched (patch semantics).
      if (typeof input.activity_path === 'string')
        touch(() => void (row.activity_path = input.activity_path!.trim()));
      if (typeof input.log_glob === 'string') touch(() => void (row.log_glob = input.log_glob!.trim()));
      // Kind change (#60 B, #62): switching kinds re-derives the feed
      // defaults UNLESS this same body sets activity_path explicitly —
      // the operator picking a kind in the form is a one-save fix for a
      // row that was pointing at the wrong feed shape. 'strata' also
      // normalizes the url to the service origin (its feed lives at
      // origin+/metrics); 'omlx' declares feed-off (no HTTP feed exists).
      if (provider !== undefined && provider !== (row.provider ?? 'llama-swap')) {
        touch(() => void (row.provider = provider));
        if (typeof input.activity_path !== 'string') {
          touch(() => void (row.activity_path = defaultActivityPathFor(provider)));
        }
        if (provider === 'strata') touch(() => void (row.url = feedOrigin(row.url)));
      }
      // Per-server credential (#60 B): WRITE-ONLY. A non-empty string sets
      // it; the sentinel null/empty string REMOVES it (explicit clear —
      // an absent key leaves the stored token untouched, so a read-modify
      // patch round-trip of the other fields can never drop the secret).
      if (typeof input.auth_token === 'string') {
        const t = input.auth_token.trim();
        touch(() => void (t === '' ? delete row.auth_token : (row.auth_token = t)));
      }
      if (models) touch(() => void (row.models = models));
      if (peers) touch(() => void (row.peers = peers));
      if (!changed) return { ok: false, reason: 'nothing to update (provide name, url, activity_path, log_glob, auth_token, models, or peers)', created: false };
      row.updated_at = nowMs;
      // A url/activity/log_glob change moves the signal source: rebuild the
      // detector so the watcher follows the row (cheap; detectors are
      // stateless pollers over injected sources).
      if (this.detectorFactory) this.detectors.set(row.id, this.detectorFactory(row));
      this.store.appendEvent({ kind: 'server_connection_updated', detail: `${row.name} (${row.url})` });
      this.store.trim();
      this.store.save();
      return { ok: true, created: false, server: row };
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!name || !url) return { ok: false, reason: 'name and url required', created: false };
    if (!/^https?:\/\//.test(url)) return { ok: false, reason: 'url must be an http(s) address', created: false };
    // Create: an absent activity_path falls back to the kind's default
    // feed shape (#62: llama-swap contract, strata /metrics, omlx
    // feed-off); an EXPLICIT empty string declares a feed-off provider
    // (#60 A1) and sticks.
    // 'strata' also normalizes the url to the service ORIGIN: the feed
    // lives at origin+/metrics, and operators paste the OpenAI-style base
    // (.../v1) — concatenating that with the feed path 404s.
    const createUrl = provider === 'strata' ? feedOrigin(url) : url;
    const activityPath =
      typeof input.activity_path === 'string' ? input.activity_path.trim() : defaultActivityPathFor(provider);
    const dupe = s.servers.find((x) => x.url === createUrl && x.activity_path === activityPath);
    if (dupe) return { ok: false, reason: `duplicate connection: ${dupe.name} already declared at this url + activity path`, created: false };
    const server: ServerConnection = {
      id: `srv-${randomBytes(4).toString('hex')}`,
      name,
      url: createUrl,
      ...(provider ? { provider } : {}),
      activity_path: activityPath,
      ...(typeof input.log_glob === 'string' && input.log_glob.trim() !== '' ? { log_glob: input.log_glob.trim() } : {}),
      ...(typeof input.auth_token === 'string' && input.auth_token.trim() !== '' ? { auth_token: input.auth_token.trim() } : {}),
      models: models ?? [],
      peers: peers ?? [],
      configured_at: nowMs,
      updated_at: nowMs,
    };
    s.servers.push(server);
    // Per-engine watching: the new row gets its own idle detector when a
    // factory is wired. Without one the row stays signal-less and grants
    // there are fail-closed until a detector exists.
    if (this.detectorFactory) this.detectors.set(server.id, this.detectorFactory(server));
    this.store.appendEvent({ kind: 'server_connection_added', detail: `${name} (${url})` });
    this.store.trim();
    this.store.save();
    return { ok: true, created: true, server };
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /**
   * This instance's stable mesh identity (#50 D2): minted on first boot
   * and persisted in the state file. Tailnet IPs move; this id is the
   * identity. The ONLY mesh data that touches state.json — peer snapshots
   * stay ephemeral by design.
   */
  instanceId(): string {
    const s = this.store.state;
    if (typeof s.instance_id === 'string' && s.instance_id.trim() !== '') return s.instance_id;
    s.instance_id = mintInstanceId();
    this.store.save();
    return s.instance_id;
  }

  /** Sum of queue depths across every registered client (the mesh's coarse depth). */
  totalQueueDepth(): number {
    let n = 0;
    for (const c of this.store.state.clients) {
      for (const p of c.projects ?? []) n += Number.isFinite(p.queue_depth) ? p.queue_depth : 0;
    }
    return n;
  }

  activeLeases(now?: number): Lease[] {
    const n = now ?? Date.now();
    return this.store.state.leases.filter((l) => l.status === 'active' && l.expires_at > n);
  }

  /** Active leases + the last `limit` finished/revoked/expired, newest last. */
  recentLeases(limit = 50): Lease[] {
    const active = this.activeLeases();
    const terminal = this.store.state.leases.filter((l) => l.status !== 'active');
    return [...terminal.slice(terminal.length > limit ? terminal.length - limit : 0), ...active];
  }

  /** Output tokens consumed by a project on a UTC day. */
  projectTokensOut(project: string, day: UtcDate): number {
    return this.store.state.budgets[project]?.[day]?.tokens_out ?? 0;
  }

  /**
   * Effective grant knobs for a project (per-project overrides win; unset
   * = inherit the globals). Also exposed on the state view's `scheduling`.
   */
  projectEffectiveSettings(name: string): { idle_seconds: number; max_concurrent_leases: number; lease_ttl_seconds: number } {
    const p = this.cfg.projects.find((x) => x.name === name);
    return {
      idle_seconds: p?.idle_seconds ?? this.cfg.idle_seconds,
      max_concurrent_leases: p?.max_concurrent_leases ?? this.cfg.max_concurrent_leases,
      lease_ttl_seconds: p?.lease_ttl_seconds ?? this.cfg.lease_ttl_seconds,
    };
  }

  projectBudget(project: string, day: UtcDate) {
    const e = this.store.state.budgets[project]?.[day] ?? { tokens_out: 0, tokens_in: 0 };
    const cap = this.cfg.projects.find((p) => p.name === project)?.daily_token_cap ?? 0;
    return { ...e, cap };
  }

  // ------------------------------------------------------------------

  private addBudget(project: string, day: UtcDate, tokensOut: number, tokensIn: number): void {
    const per = (this.store.state.budgets[project] ??= {});
    const e = (per[day] ??= { tokens_out: 0, tokens_in: 0 });
    e.tokens_out += tokensOut;
    e.tokens_in += tokensIn;
  }

  private endLease(lease: Lease, status: 'revoked' | 'expired', reason: string, now: number): void {
    lease.status = status;
    lease.end_reason = reason;
    lease.ended_at = now;
    this.store.appendEvent({
      kind: 'lease_revoked',
      project: lease.project,
      lease_id: lease.lease_id,
      detail: `${lease.client_name}: ${reason} (job ${lease.job_id})`,
    });
  }
}

/** UTC day key for an epoch-ms timestamp: "2026-09-25". */
export function utcDay(ms: number): UtcDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * True when an observed-IP value is usable as the exemption key: non-empty
 * and not the `unknown` placeholder api.ts substitutes when the request
 * carries no readable IP.
 */
export function validIp(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.trim() !== 'unknown';
}

/**
 * Adaptive lease TTL (seconds).
 *
 *   - no estimate (est ≤ 0)  → the full `ttlSeconds` (today's behavior);
 *   - est > 0                → `est * safetyFactor`, floored at `floorSeconds`
 *                              and capped at `ttlSeconds`.
 *
 * The cap at the effective `ttlSeconds` means an estimate can only make a
 * lease expire SOONER than the static TTL, never later — so preemption,
 * budget, and anti-thrash see strictly less staleness, never more. The
 * safety factor (default 2) never runs the lease below 2× the estimate
 * because the client's `estimated_seconds` is a first-run guess.
 */
export function computeLeaseTtl(estSeconds: number, ttlSeconds: number, safetyFactor: number, floorSeconds: number): number {
  const est = Number.isFinite(estSeconds) ? Math.max(0, estSeconds) : 0;
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 1800;
  if (est <= 0) return ttl;
  const factor = Number.isFinite(safetyFactor) && safetyFactor > 0 ? safetyFactor : 2;
  const floor = Number.isFinite(floorSeconds) && floorSeconds > 0 ? floorSeconds : 0;
  const capped = Math.floor(est * factor);
  return Math.min(Math.max(capped, floor), ttl);
}

/** Render a config number for event detail without trailing noise (2, 1.5). */
function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}
