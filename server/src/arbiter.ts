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

import { createHash, randomBytes } from 'node:crypto';
import type { IdleDetector } from './idle.js';
import { activeLeaseExemptIps, defaultActivityPathFor } from './idle.js';
import { buildCatalog, modelsProbeUrl, type CatalogEntry, type ModelsFetcher } from './catalog.js';
import { mintInstanceId } from './mesh.js';
import type {
  ClientKeyRow,
  EngineGroup,
  IdleSignal,
  JobResultRow,
  JobThrottle,
  ModelAlias,
  ModelAliasPair,
  SessionOverride,
  SessionPin,
  SessionRecord,
  ThemeColors,
} from './types.js';
import type { StateStore } from './state.js';
import type { ClientOverride, Lease, ProjectAllocation, ServerConfig, ServerConnection, ServerProvider, UtcDate, AgentRosterRow } from './types.js';
import { PROVIDER_KINDS, THEME_DEFAULTS, THEME_HEX_RE, THEME_TOKEN_KEYS } from './types.js';

/**
 * Sanitize a reported agent roster (#80) for storage on the client row.
 *
 * Edge posture (the gate_posture / client_log pattern):
 *   - a non-array (or a missing report) → undefined, so the caller treats it
 *     as ABSENT (a malformed report never poisons the state file, and absent
 *     never clears the stored value);
 *   - each member is checked INDIVIDUALLY and a malformed member is dropped
 *     while the rest are kept: `profile` a non-empty string ≤64 chars,
 *     `posture` an exact enum value (adopted|external|unset), `provider` /
 *     `base_url` optional strings (≤512, a URL can be long) — anything else
 *     (non-object, bad posture, empty profile, over-long string) drops just
 *     that row;
 *   - bounded hard at 24 rows (a display list, not a dump — the profiles dir
 *     is small; a hostile/buggy client can't bloat the state file).
 *
 * Returns undefined for a non-array or an all-dropped array (no empty list is
 * stored, and the caller leaves the stored roster untouched in that case).
 */
export function cleanAgentRoster(raw: unknown): AgentRosterRow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const POSTURES: ReadonlySet<string> = new Set(['adopted', 'external', 'unset']);
  const out: AgentRosterRow[] = [];
  for (const r of raw as unknown[]) {
    if (out.length >= 24) break;
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const o = r as Record<string, unknown>;
    const profile = typeof o.profile === 'string' ? o.profile.trim() : '';
    if (profile === '' || profile.length > 64) continue;
    if (typeof o.posture !== 'string' || !POSTURES.has(o.posture)) continue;
    const row: AgentRosterRow = { profile, posture: o.posture as AgentRosterRow['posture'] };
    if (typeof o.provider === 'string') {
      const p = o.provider.trim();
      if (p !== '' && p.length <= 512) row.provider = p;
    }
    if (typeof o.base_url === 'string') {
      const u = o.base_url.trim();
      if (u !== '' && u.length <= 512) row.base_url = u;
    }
    out.push(row);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * #66 D3: one published alias entry — the alias name with the WINNER pair
 * already applied. The shape `docs/architecture/model-aliases.md` locks:
 * name, server_id, url, auth_set, engine_model, catalog_source. Never a
 * token (write-only posture; this block rides the anonymous /api/state).
 */
export interface ModelAliasEntry {
  name: string;
  server_id: string;
  url: string;
  auth_set: boolean;
  /** The winner pair's engine-OWN model id the router splices into the body. */
  engine_model: string;
  catalog_source: 'probed' | 'declared';
  /**
   * Health-ordered fall-through (docs/architecture/engine-health-routing.md
   * D2): TRUE when the published winner is NOT the stored pin — the pin is
   * dead (or group-blocked) and traffic moved to the next-best option.
   * ADD-key, absent on every entry that resolves to its pin (the router
   * ignores the key; the dashboard renders "re-routed from <pin>").
   */
  fallback?: boolean;
}

/**
 * #66 D1 sanitizer bounds. Alias names take the router `cleanKey` class
 * (printable 0x20–0x7e, at most 128 — `client/src/aggregate.ts:82-89`).
 * Engine model ids take the body-sniff regex's own class (printable except
 * quote and backslash, at most 80 — `client/src/aggregate.ts:114`), so a
 * stored id can never break the first-chunk splice's JSON quoting.
 */
const ALIAS_NAME_RE = /^[\x20-\x7e]{1,128}$/;
const ENGINE_MODEL_RE = /^[^\x00-\x1f"\\]{1,80}$/;

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
function normalizeSessionGate(v: unknown): { state: 'active' | 'queued'; waiting: number; position?: number; waitSince?: number } | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const g = v as { state?: unknown; waiting?: unknown; position?: unknown; waitSince?: unknown };
  if (g.state !== 'active' && g.state !== 'queued') return undefined;
  if (typeof g.waiting !== 'number' || !Number.isFinite(g.waiting) || !Number.isInteger(g.waiting) || g.waiting < 0) return undefined;
  // #44 add-key: 1-based queue position, only meaningful while queued.
  // Malformed = dropped (the block still rides, minus the key) — never a
  // rejected registration; absent = an old router (the row keeps no key).
  const position =
    typeof g.position === 'number' && Number.isInteger(g.position) && g.position >= 1
      ? g.position
      : undefined;
  // #46 add-key: the hold's anchor instant (epoch-ms the session FIRST
  // started waiting), only meaningful while queued. Same ADD-key posture
  // as position: a malformed value is dropped (the block still rides),
  // absent = an old router. The arbiter keeps it VERBATIM (the router's
  // clock, the `phase.at` precedent) — it never re-derives the age.
  const waitSince =
    typeof g.waitSince === 'number' && Number.isFinite(g.waitSince) && g.waitSince >= 0
      ? g.waitSince
      : undefined;
  return {
    state: g.state,
    waiting: g.waiting,
    ...(position !== undefined ? { position } : {}),
    ...(waitSince !== undefined ? { waitSince } : {}),
  };
}

/**
 * #67: validate a register heartbeat's `phase` ADD-key (the router's
 * response-phase truth). The block follows the GATE block's posture
 * exactly — ephemeral stream state, not accumulated history:
 *   - a valid { state: 'thinking'|'output'|'tools', at: finite int ≥0 } → stored;
 *   - null/absent → null: the no-live-phase report, the stored phase
 *     CLEARS (an old router never sends the key; its rows simply stay
 *     phase-less, exactly like the gate block);
 *   - anything else → undefined: INVALID, the field is DROPPED (never a
 *     rejected registration) and the stored value stands.
 * `at` is the ROUTER's clock (the phase observation instant); the arbiter
 * keeps it verbatim — the surface ages the state against it, never by a
 * rewrite.
 */
function normalizeSessionPhase(
  v: unknown,
): { state: 'thinking' | 'output' | 'tools'; at: number } | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const p = v as { state?: unknown; at?: unknown };
  if (p.state !== 'thinking' && p.state !== 'output' && p.state !== 'tools') return undefined;
  if (typeof p.at !== 'number' || !Number.isFinite(p.at) || !Number.isInteger(p.at) || p.at < 0) return undefined;
  return { state: p.state, at: p.at };
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
  | 'group_busy'
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
   * #66 D3: the alias block published to the router on the LAST probe
   * cycle (in-memory, ephemeral — never persisted; one entry per alias with
   * the winner pair resolved). `/api/state` echoes it as the
   * `model_aliases` ADD-key beside `catalog`.
   */
  private aliasPublished: ModelAliasEntry[] = [];
  /**
   * #66: the LAST probe cycle's per-alias pair verdicts (alias -> pairs
   * with 'probed' | 'declared' | 'dropped'). In-memory like
   * `aliasPublished`; read by `aliasRows()` for the dashboard's
   * exception-only markers. 'unprobed' renders when the tick never saw the
   * pair (no cycle run yet).
   */
  private aliasPairStates = new Map<string, { server_id: string; model: string; source: 'probed' | 'declared' | 'dropped' }[]>();
  /**
   * #67: the per-row model inventory as of the LAST SUCCESSFUL probe of
   * that row (row id -> names; a probe-blocked row keeps its older list,
   * and falls back to its declared list at read). Kept ACROSS cycles per
   * row — pins are standing choices, and a probe blip on one row must
   * never retroactively invalidate a stored pin the way a whole-map
   * replace would. The catalog/alias publishes stay per-tick (their
   * drop-for-the-tick rules are deliberate; this one is not).
   */
  private lastProbed = new Map<string, string[]>();
  /** When each row's /v1/models probe last answered (epoch-ms). In-memory,
   *  like lastProbed — the dashboard's "last seen" for a row's inventory. */
  private lastProbedAt = new Map<string, number>();
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
    info?: { version?: string; protocol?: number; revision?: string; gate_posture?: 'armed' | 'fail_open'; proxy_port?: number; aggregate_port?: number; daemon_behind?: boolean; client_log?: string[]; agent_roster?: unknown },
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
    // Aggregate listener port (#68): same edge rule as proxy_port (an
    // integer in the real-port range, else dropped). The Add-agent flow
    // renders the agent base URL from it; absent = no listener, and the
    // flow says so instead of guessing a port.
    const aggregatePort =
      typeof info?.aggregate_port === 'number' && Number.isInteger(info.aggregate_port) && info.aggregate_port >= 1 && info.aggregate_port <= 65535
        ? info.aggregate_port
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
    // Agent roster (#80): the client's LOCAL Hermes profiles + posture.
    // Sanitized the edge way (the gate_posture/client_log pattern):
    //   - non-array → the key is absent (a malformed report never poisons
    //     the state file);
    //   - each member is checked individually: `profile` a non-empty
    //     string ≤64 chars (trim), `posture` an exact enum value
    //     (adopted|external|unset), `provider`/`base_url` optional strings
    //     (≤512 — a URL with a long query; display-only). A member failing
    //     its shape check is DROPPED individually, the rest are kept;
    //   - a present array stores (an all-dropped array → undefined, treated
    //     as absent — no empty list is stored, and absent NEVER clears the
    //     stored value: a daemon without a Hermes home omits the key, so an
    //     old client's roster survives a mixed-version re-registration).
    const roster = cleanAgentRoster(info?.agent_roster);
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
      // Aggregate port (#68): same heartbeat rule as proxy_port.
      if (aggregatePort) existing.aggregate_port = aggregatePort;
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
      // Agent roster (#80): same ADD-key rule — a present, valid roster
      // updates the row; absent (old client / no Hermes home) leaves it
      // exactly as it was (never cleared). A cleaned empty roster is
      // undefined, so a re-register carrying an all-malformed roster does
      // NOT wipe the previously stored one.
      if (roster !== undefined) existing.agent_roster = roster;
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
      ...(aggregatePort ? { aggregate_port: aggregatePort } : {}),
      // Same store rule as the heartbeat path: only an EXCEPTION key lands
      // on the row (daemon_behind false = no exception = no key; an empty
      // log tail = no key).
      ...(daemonBehind === true ? { daemon_behind: true } : {}),
      ...(clientLog && clientLog.length > 0 ? { client_log: clientLog } : {}),
      // Agent roster (#80): lands only when a valid (non-empty) roster was
      // reported — same ADD-key store rule as the heartbeat path.
      ...(roster !== undefined ? { agent_roster: roster } : {}),
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

    // Engine-group cap (docs/architecture/engine-health-routing.md D3):
    // a grant on a row in group G is admitted only when the count of ACTIVE
    // LEASES across ALL rows of G is below the group's `max_concurrent`
    // (default 1 = at most one background job across the whole host — the
    // same-host mutual exclusion the owner named). The check joins the
    // per-server evaluation as one more per-server condition. No group (or a
    // single-member group) = byte-for-byte unchanged, and the per-server
    // cap above already bounds that case.
    const grp = this.groupOf(serverId);
    if (grp && grp.server_ids.length > 1) {
      const cap = Number.isFinite(grp.max_concurrent) && grp.max_concurrent > 0
        ? Math.floor(grp.max_concurrent)
        : 1;
      const activeInGroup = active.filter((l) => grp.server_ids.includes(leaseServerId(l)));
      if (activeInGroup.length >= cap) return { ok: false, reason: 'group_busy' };
    }

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
    // #67: pins have no 'until' (a standing choice), so orphan them with
    // their row — a swept token's pin must not outlive the session.
    for (const tok of Object.keys(s.session_pins)) {
      if (!s.sessions.some((sess) => sess.token === tok)) delete s.session_pins[tok];
    }

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
    const nowMs = Date.now();
    if (this.modelsFetcher) {
      const fetcher = this.modelsFetcher;
      await Promise.all(
        rows.map(async (row) => {
          try {
            const names = await fetcher(modelsProbeUrl(row.url), row.auth_token);
            // Keep an EMPTY successful list in the map: the alias pass
            // (#66 D2) must tell "probe succeeded, listed nothing" from
            // "probe failed" — a pair on a probe-succeeded row that lacks
            // the id DROPS for the tick, a pair on a probe-FAILED row
            // publishes 'declared'. buildCatalog ignores empty lists (its
            // `length > 0` gate), so the bare-name block is byte-identical.
            if (Array.isArray(names)) {
              probed.set(row.id, names);
              this.lastProbedAt.set(row.id, nowMs);
            }
          } catch {
            /* probe-blocked: the declared list stands (drop-don't-reject) */
          }
        }),
      );
    }
    this.catalogPublished = buildCatalog(rows, probed);
    // #67: merge per-row (a row whose probe failed THIS cycle keeps its
    // last good list — see lastProbed). The per-tick `probed` map the
    // alias pass uses stays byte-for-byte.
    for (const [id, names] of probed) this.lastProbed.set(id, names);
    // #66 D2: the alias pass runs in THIS cycle over the SAME probe map —
    // per-pair confirmation, the D2 health-ordered winner chain (the `now`
    // feeds the D3 group engaged check), the published block.
    this.buildAliasBlock(rows, probed, nowMs);
    return this.catalogPublished;
  }

  /** The catalog the last probe cycle published (never contains tokens). */
  catalog(): CatalogEntry[] {
    return this.catalogPublished;
  }

  // ------------------------------------------------------------------
  // Model aliases (#66 — docs/architecture/model-aliases.md D1–D4)
  // ------------------------------------------------------------------

  /**
   * Engine groups (docs/architecture/engine-health-routing.md D3): the
   * group (if any) a row belongs to. A row is in at most one group, so a
   * linear scan over the stored groups is the whole lookup.
   */
  groupOf(serverId: string): EngineGroup | null {
    const groups = this.store.state.engine_groups;
    if (!groups) return null;
    for (const g of Object.values(groups)) {
      if (Array.isArray(g?.server_ids) && g.server_ids.includes(serverId)) return g;
    }
    return null;
  }

  /**
   * A row is ENGAGED (D3) when the arbiter observes an active inference on
   * it: an ACTIVE LEASE names it, OR a session row points at it with gate
   * state 'active' (a parked 'queued' session consumes no engine slot and is
   * NOT engaged). Both feeds are already stored arbiter state.
   */
  rowEngaged(serverId: string, now: number): boolean {
    if (this.activeLeases(now).some((l) => leaseServerId(l) === serverId)) return true;
    return this.store.state.sessions.some(
      (sess) => leaseServerId(sess) === serverId && sess.gate?.state === 'active',
    );
  }

  /**
   * The D3 chain filter input: TRUE when a row in `serverId`'s group OTHER
   * than `serverId` is ENGAGED. The chain's steps 1-2 use this — a candidate
   * is eligible only when no OTHER row in its group is engaged. Step 3/4
   * never consult it. A row with no group (or a single-member group) has no
   * peer, so this is always false and the path is byte-for-byte unchanged.
   */
  private groupEngagedPeer(serverId: string, now: number): boolean {
    const g = this.groupOf(serverId);
    if (!g || g.server_ids.length === 0) return false;
    for (const peer of g.server_ids) {
      if (peer === serverId) continue;
      if (this.rowEngaged(peer, now)) return true;
    }
    return false;
  }

  /**
   * #66 D2/D3: per-pair confirmation against the same probe map, winner
   * selection (D4), and the resolved `model_aliases` publish block.
   *
   * - A pair is CONFIRMED when the row's probed list contains its model id
   *   (confirmation is per pair, never per alias).
   * - A pair on a probe-FAILED (or never-probed) row stays publishable
   *   with catalog_source 'declared' — never falsely 'probed'.
   * - A pair on a probe-SUCCEEDED row that does not list the id is dropped
   *   for the tick. The alias itself never drops — stored pairs stand,
   *   publish filters. All pairs dead = the alias is not published at all
   *   that tick (exception-only, never a silent half-name).
   * - Winner (D4, AMENDED by docs/architecture/engine-health-routing.md
   *   D2): the health-ordered chain over the surviving pairs, in order —
   *   (1) the pinned pair when it survives AND its row is healthy this tick
   *   AND its group has no engaged peer; (2) the FIRST non-pinned pair
   *   (insertion order) whose row is healthy this tick and whose group has
   *   no engaged peer — the pin is dead or group-blocked, traffic moves to
   *   the next-best option in the operator's declared priority; (3) the
   *   pinned pair when it survives but its row is not healthy (every healthy
   *   option is gone — the pin still names the engine; honest degradation,
   *   no silent re-pin); (4) the first surviving pair (no pin applies —
   *   absent or its pair dropped; today's fall-through). Steps 1-2 consult
   *   the D3 group filter; steps 3-4 NEVER do (mutual exclusion is a
   *   preference between live options, never a veto on the only option).
   *   The chain never unpublishes an alias today publishes: when at least
   *   one pair survives (a probe failure keeps a pair a survivor), the alias
   *   still publishes, possibly from a different row. The `fallback` ADD-key
   *   is TRUE when the published winner is not the stored pin.
   * - Publish-path sanitizers are drop-don't-reject (D1): a malformed name,
   *   id, or row reference drops the entry for the tick, never rejects the
   *   stored row.
   *
   * The per-tick pair verdicts also land in `aliasPairStates` for the
   * dashboard read (`GET /api/aliases`) — exception-only markers.
   */
  private buildAliasBlock(rows: readonly ServerConnection[], probed: ReadonlyMap<string, string[]>, now: number): void {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: ModelAliasEntry[] = [];
    const pairStates = new Map<string, { server_id: string; model: string; source: 'probed' | 'declared' | 'dropped' }[]>();
    const stored = this.store.state.model_aliases;
    for (const name of Object.keys(stored ?? {})) {
      if (!ALIAS_NAME_RE.test(name)) continue; // hostile key: unpublished (drop-don't-reject)
      const row = stored[name];
      const pairs = Array.isArray(row?.pairs) ? row.pairs : [];
      const survivors: { server_id: string; model: string; source: 'probed' | 'declared' }[] = [];
      const states: { server_id: string; model: string; source: 'probed' | 'declared' | 'dropped' }[] = [];
      for (const p of pairs) {
        const sid = typeof p?.server_id === 'string' ? p.server_id : '';
        const model = typeof p?.model === 'string' ? p.model : '';
        if (!ALIAS_NAME_RE.test(sid) || !ENGINE_MODEL_RE.test(model)) {
          states.push({ server_id: sid, model, source: 'dropped' });
          continue;
        }
        const srv = byId.get(sid);
        if (!srv) {
          states.push({ server_id: sid, model, source: 'dropped' }); // the row is gone
          continue;
        }
        if (probed.has(sid)) {
          if (!probed.get(sid)!.includes(model)) {
            states.push({ server_id: sid, model, source: 'dropped' }); // probed row, id vanished
            continue;
          }
          survivors.push({ server_id: sid, model, source: 'probed' });
        } else {
          survivors.push({ server_id: sid, model, source: 'declared' }); // probe-blocked: the operator's claim stands
        }
        states.push({ server_id: sid, model, source: survivors[survivors.length - 1]!.source });
      }
      pairStates.set(name, states);
      if (survivors.length === 0) continue; // all pairs dead this tick: not offered, not routed
      const pin = typeof row?.pinned_server_id === 'string' ? row.pinned_server_id : '';
      // D2 health-ordered chain (docs/architecture/engine-health-routing.md).
      // A row is HEALTHY this tick when the probe answered for it (`probed`
      // present); the D3 group filter (steps 1-2 only) asks whether another
      // row in the same group is ENGAGED.
      const healthy = (sid: string) => probed.has(sid);
      const peerFree = (sid: string) => !this.groupEngagedPeer(sid, now);
      const pinned = pin !== '' ? survivors.find((p) => p.server_id === pin) : undefined;
      // Step 1: the pin, when it survives AND is healthy AND its group is free.
      const step1 = pinned && healthy(pinned.server_id) && peerFree(pinned.server_id) ? pinned : undefined;
      // Step 2: the first non-pinned healthy, group-free pair (the next-best
      // option in the operator's declared priority — the 21:41 fix).
      const step2 = !step1
        ? survivors.find((p) => p.server_id !== pin && healthy(p.server_id) && peerFree(p.server_id))
        : undefined;
      // Step 3: the pin when it survives but is not healthy (honest degrade).
      const step3 = !step1 && !step2 && pinned ? pinned : undefined;
      // Step 4: the first survivor (no pin applies — today's fall-through).
      const winner = step1 ?? step2 ?? step3 ?? survivors[0]!;
      const srv = byId.get(winner.server_id)!;
      if (typeof srv.url !== 'string' || srv.url.trim() === '') continue;
      out.push({
        name,
        server_id: winner.server_id,
        url: srv.url,
        auth_set: srv.auth_token !== undefined && srv.auth_token !== '',
        engine_model: winner.model,
        catalog_source: winner.source,
        // D2 ADD-key: present (true) only when a stored pin exists and the
        // published winner is not it (re-routed). Absent on every pin-matched
        // and pinless entry — the router ignores the key, the dashboard reads
        // it.
        ...(pin !== '' && winner.server_id !== pin ? { fallback: true } : {}),
      });
    }
    this.aliasPublished = out;
    this.aliasPairStates = pairStates;
  }

  /**
   * The alias block the last probe cycle published, one RESOLVED entry per
   * alias with the winner pair applied (D3 shape: name, server_id, url,
   * auth_set, engine_model, catalog_source). Ephemeral like `catalog`; a
   * token NEVER enters it. `/api/state` echoes it as the `model_aliases`
   * ADD-key beside `catalog`.
   */
  modelAliases(): ModelAliasEntry[] {
    return this.aliasPublished;
  }

  /**
   * The stored engine groups (docs/architecture/engine-health-routing.md
   * D3) for the dashboard read (`GET /api/engine-groups`) — verbatim (a
   * group carries no secret by construction). Ephemeral like `aliasRows`.
   */
  engineGroups(): EngineGroup[] {
    return Object.values(this.store.state.engine_groups ?? {});
  }

  /**
   * The stored alias rows for the dashboard read (`GET /api/aliases`):
   * pairs verbatim + this-tick per-pair source markers ('probed' renders
   * nothing; 'declared' / 'dropped' / 'unprobed' mark the exception).
   * Carries no secret by construction (D1: server_id + engine ids only).
   */
  aliasRows(): {
    alias: string;
    pairs: { server_id: string; model: string; source: 'probed' | 'declared' | 'dropped' | 'unprobed' }[];
    pinned_server_id?: string;
    updated_at: number;
  }[] {
    const s = this.store.state.model_aliases;
    return Object.keys(s ?? {}).map((name) => {
      const row = s[name];
      const tick = this.aliasPairStates.get(name) ?? [];
      return {
        alias: name,
        pairs: (Array.isArray(row?.pairs) ? row.pairs : []).map((p) => {
          const found = tick.find((q) => q.server_id === p?.server_id && q.model === p?.model);
          return {
            server_id: typeof p?.server_id === 'string' ? p.server_id : '',
            model: typeof p?.model === 'string' ? p.model : '',
            source: found?.source ?? 'unprobed',
          };
        }),
        ...(typeof row?.pinned_server_id === 'string' && row.pinned_server_id !== '' ? { pinned_server_id: row.pinned_server_id } : {}),
        updated_at: typeof row?.updated_at === 'number' ? row.updated_at : 0,
      };
    });
  }

  /**
   * #66 D1/D2: the alias write route's engine. Upsert = `alias` + `pairs`
   * (optional `pin`); removal = `{ alias, delete: true }`. WHOLE-ENTRY
   * validation → a rejection is told, not swallowed (operator form input
   * is not telemetry): an over-bound/hostile alias name or engine id, empty
   * pairs, an unknown `server_id`, a duplicate pair, and a malformed pin
   * all return a reason (the route maps it to 400; a delete of an unknown
   * alias maps to 404). A POST for an UNPROBED pair is ACCEPTED here — the
   * form is the constraint, not the API (D5): such a pair publishes
   * 'declared' with the exception marker.
   *
   * Re-pin (the drag's write path): `pin` alone updates an existing alias.
   * An alias whose stored pin no longer matches a surviving pair is legal
   * — publish falls through to the first surviving pair (D4).
   */
  putModelAlias(input: { alias?: unknown; pairs?: unknown; pin?: unknown; delete?: unknown; order?: unknown }): {
    ok: boolean;
    reason?: string;
    created?: boolean;
    deleted?: boolean;
    reordered?: boolean;
    alias?: ModelAlias;
  } {
    const s = this.store.state;
    const key = typeof input.alias === 'string' ? input.alias.trim() : '';
    // An ABSENT name is legal (the pure re-arrangement write needs no alias);
    // a PRESENT name is validated as always.
    if (key !== '' && !ALIAS_NAME_RE.test(key)) return { ok: false, reason: 'alias name must be printable and at most 128 chars' };

    // Priority re-arrangement (no alias write in the same call): rewrite the
    // stored keys in the given order. The object-key insertion order is the
    // priority the publish pass and the /v1/models advertisement follow
    // (first = the default model).
    if (Array.isArray(input.order) && input.pairs === undefined && input.pin === undefined && input.delete !== true) {
      return this.reorderAliases(input.order);
    }

    if (input.delete === true) {
      if (!s.model_aliases[key]) return { ok: false, reason: 'unknown_alias' };
      delete s.model_aliases[key];
      this.store.appendEvent({ kind: 'model_alias_removed', detail: key });
      this.store.trim();
      this.store.save();
      return { ok: true, deleted: true };
    }

    const existing = s.model_aliases[key];
    const hasPairs = input.pairs !== undefined;
    const hasPin = input.pin !== undefined;
    if (!hasPairs && !hasPin)
      return { ok: false, reason: existing ? 'nothing to update (provide pairs or pin, or delete: true)' : 'pairs required (non-empty)' };

    let pairs: ModelAliasPair[] | undefined;
    if (hasPairs) {
      if (!Array.isArray(input.pairs)) return { ok: false, reason: 'pairs must be an array' };
      if (input.pairs.length === 0) return { ok: false, reason: 'pairs must not be empty' };
      const rowIds = new Set(s.servers.map((r) => r.id));
      const seen = new Set<string>();
      pairs = [];
      for (const p of input.pairs as unknown[]) {
        const sid = p && typeof p === 'object' && typeof (p as ModelAliasPair).server_id === 'string' ? (p as ModelAliasPair).server_id.trim() : '';
        const model = p && typeof p === 'object' && typeof (p as ModelAliasPair).model === 'string' ? (p as ModelAliasPair).model.trim() : '';
        if (!ALIAS_NAME_RE.test(sid)) return { ok: false, reason: 'pair server_id must be printable and at most 128 chars' };
        if (!ENGINE_MODEL_RE.test(model))
          return { ok: false, reason: 'engine model id must be printable except " and \\, at most 80 chars' };
        const dupeKey = `${sid}::${model}`;
        if (seen.has(dupeKey)) return { ok: false, reason: `duplicate pair: ${sid} / ${model} appears twice` };
        seen.add(dupeKey);
        if (!rowIds.has(sid)) return { ok: false, reason: `unknown server_id: ${sid}` };
        pairs.push({ server_id: sid, model });
      }
    }

    let pin: string | undefined;
    if (hasPin) {
      if (input.pin === null) pin = ''; // explicit clear → default = first pair
      else if (typeof input.pin === 'string' && input.pin.trim() !== '') pin = input.pin.trim();
      else return { ok: false, reason: 'pin must be a server_id string (or null to clear)' };
      if (pin && !ALIAS_NAME_RE.test(pin)) return { ok: false, reason: 'pin server_id must be printable and at most 128 chars' };
    }

    const nowMs = Date.now();
    if (!existing) {
      if (!pairs) return { ok: false, reason: 'pairs required (non-empty)' };
      const row: ModelAlias = { alias: key, pairs, ...(pin ? { pinned_server_id: pin } : {}), updated_at: nowMs };
      s.model_aliases[key] = row;
      this.store.appendEvent({ kind: 'model_alias_updated', detail: `${key} (${pairs.length} pair(s))` });
      this.store.trim();
      this.store.save();
      return { ok: true, created: true, alias: row };
    }
    if (pairs) existing.pairs = pairs;
    if (hasPin) {
      if (pin) existing.pinned_server_id = pin;
      else delete existing.pinned_server_id;
    }
    existing.updated_at = nowMs;
    this.store.appendEvent({ kind: 'model_alias_updated', detail: key });
    this.store.trim();
    this.store.save();
    return { ok: true, created: false, alias: existing };
  }

  /**
   * Engine-group write (docs/architecture/engine-health-routing.md D3/D5) —
   * the alias authoring posture applied to groups: whole-entry validation,
   * 400 told not swallowed, one `engine_group_updated` event, state saved
   * with the existing 0600 posture. Body: `{ group_id, name?,
   * server_ids?, max_concurrent?, delete? }`.
   *
   * Rules: `group_id` is the ALIAS_NAME class (the sanitizer class of alias
   * names). `server_ids` must be a NON-EMPTY array of KNOWN row ids, with no
   * duplicate inside the group. A row belongs to AT MOST one group — if any
   * member is already claimed by another group the write is a 400 (told).
   * `max_concurrent` (owner decision 2026-10-08: configurable per group)
   * must be a positive integer when present; absent = the default 1. A
   * single-member group is accepted (a no-op cap; it survives a row
   * re-add without a rewrite). `delete: true` of an unknown group is a 404.
   */
  putEngineGroup(input: {
    group_id?: unknown;
    name?: unknown;
    server_ids?: unknown;
    max_concurrent?: unknown;
    delete?: unknown;
  }): { ok: boolean; reason?: string; created?: boolean; deleted?: boolean; group?: EngineGroup } {
    const s = this.store.state;
    const key = typeof input.group_id === 'string' ? input.group_id.trim() : '';
    if (!ALIAS_NAME_RE.test(key)) {
      return { ok: false, reason: 'group_id must be printable and at most 128 chars' };
    }
    if (input.delete === true) {
      if (!s.engine_groups[key]) return { ok: false, reason: 'unknown_group' };
      delete s.engine_groups[key];
      this.store.appendEvent({ kind: 'engine_group_removed', detail: key });
      this.store.trim();
      this.store.save();
      return { ok: true, deleted: true };
    }
    const existing = s.engine_groups[key];
    const hasMembers = input.server_ids !== undefined;
    const hasCap = input.max_concurrent !== undefined;
    if (!hasMembers && !hasCap) {
      return {
        ok: false,
        reason: existing
          ? 'nothing to update (provide server_ids or max_concurrent, or delete: true)'
          : 'server_ids required (non-empty)',
      };
    }
    let members: string[] | undefined;
    if (hasMembers) {
      if (!Array.isArray(input.server_ids)) return { ok: false, reason: 'server_ids must be an array' };
      if (input.server_ids.length === 0) return { ok: false, reason: 'server_ids must not be empty' };
      const rowIds = new Set(s.servers.map((r) => r.id));
      const seen = new Set<string>();
      members = [];
      for (const sid of input.server_ids) {
        const id = typeof sid === 'string' ? sid.trim() : '';
        if (!ALIAS_NAME_RE.test(id)) return { ok: false, reason: 'server_id must be printable and at most 128 chars' };
        if (!rowIds.has(id)) return { ok: false, reason: `unknown server_id: ${id}` };
        if (seen.has(id)) return { ok: false, reason: `duplicate server_id: ${id} appears twice` };
        seen.add(id);
        members.push(id);
      }
    }
    // One group per row (D3): a member already claimed by ANOTHER group is a
    // 400 at write time (told, not swallowed). The group's own current
    // members are exempt (re-writing the same set is a no-op, not a
    // violation).
    const claimedElsewhere = (sid: string) =>
      Object.values(s.engine_groups).some(
        (g) => g.group_id !== key && Array.isArray(g.server_ids) && g.server_ids.includes(sid),
      );
    if (members) {
      const dup = members.find((sid) => claimedElsewhere(sid));
      if (dup) return { ok: false, reason: `server ${dup} already belongs to another group` };
    }
    let maxConcurrent: number | undefined;
    if (hasCap) {
      if (typeof input.max_concurrent !== 'number' || !Number.isInteger(input.max_concurrent) || input.max_concurrent < 1) {
        return { ok: false, reason: 'max_concurrent must be a positive integer' };
      }
      maxConcurrent = input.max_concurrent;
    }
    const nowMs = Date.now();
    if (!existing) {
      if (!members) return { ok: false, reason: 'server_ids required (non-empty)' };
      const row: EngineGroup = {
        group_id: key,
        ...(typeof input.name === 'string' && input.name.trim() !== '' ? { name: input.name.trim() } : {}),
        server_ids: members,
        max_concurrent: maxConcurrent ?? 1,
        updated_at: nowMs,
      };
      s.engine_groups[key] = row;
      this.store.appendEvent({ kind: 'engine_group_updated', detail: `${key} (${members.length} member(s))` });
      this.store.trim();
      this.store.save();
      return { ok: true, created: true, group: row };
    }
    if (members) existing.server_ids = members;
    if (maxConcurrent !== undefined) existing.max_concurrent = maxConcurrent;
    if (typeof input.name === 'string' && input.name.trim() !== '') existing.name = input.name.trim();
    existing.updated_at = nowMs;
    this.store.appendEvent({ kind: 'engine_group_updated', detail: key });
    this.store.trim();
    this.store.save();
    return { ok: true, created: false, group: existing };
  }

  /**
   * Priority re-arrangement (the Models tab's re-order write). The stored
   * keys are re-inserted in the given order — the object-key insertion order
   * IS the priority (first = the default model the mint hand-off offers, the
   * order /v1/models advertises, the publish pass's first-survivor fallback).
   *
   * Rules: every listed name must be a STORED alias (an unknown name is a 400,
   * told not swallowed). The union of the list and the stored set must agree —
   * every stored alias appears exactly once in the list. A list with gaps,
   * dupes, or stray names is refused whole (no partial reorder).
   */
  private reorderAliases(order: unknown[]): { ok: boolean; reason?: string; reordered?: boolean } {
    const s = this.store.state;
    const names = order.map((x) => (typeof x === 'string' ? x.trim() : ''));
    if (names.some((n) => n === '' || !ALIAS_NAME_RE.test(n))) {
      return { ok: false, reason: 'order must be a list of stored alias names (printable, at most 128 chars)' };
    }
    if (new Set(names).size !== names.length) return { ok: false, reason: 'order names must be unique' };
    const stored = Object.keys(s.model_aliases ?? {});
    if (stored.length === 0) return { ok: false, reason: 'no aliases to reorder' };
    if (names.length !== stored.length) return { ok: false, reason: 'order must name every stored alias exactly once' };
    for (const n of names) if (!s.model_aliases[n]) return { ok: false, reason: `order names an unknown alias: ${n}` };
    // An unchanged order is a no-op (no event, no save churn).
    if (names.every((n, i) => stored[i] === n)) return { ok: true, reordered: false };
    // Rebuild the object in the new order (the rows are untouched; only the
    // key insertion order — the priority — changes).
    const reordered: Record<string, ModelAlias> = {};
    for (const n of names) reordered[n] = s.model_aliases[n]!;
    s.model_aliases = reordered;
    this.store.appendEvent({ kind: 'model_alias_reordered', detail: names.join(' → ') });
    this.store.trim();
    this.store.save();
    return { ok: true, reordered: true };
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
    opts: { client_id?: string; client_name?: string; server_id?: string; last_activity?: number; gate?: unknown; session_id?: unknown; history?: unknown; phase?: unknown; now?: number },
  ): { ok: boolean; reason?: string; created: boolean; session?: SessionRecord } {
    const t = typeof token === 'string' ? token.trim() : '';
    if (!t || t.length > 128) return { ok: false, reason: 'token required (≤128 chars)', created: false };
    const nowMs = opts.now ?? Date.now();
    const gateVerdict = normalizeSessionGate(opts.gate);
    // #67: the response-phase block, sanitized with the same three
    // verdicts (valid → store; explicit null → CLEAR; invalid/absent →
    // dropped, stored value stands — an old router never sends it).
    const phaseVerdict = normalizeSessionPhase(opts.phase);
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
      // #67 phase, three verdicts: valid ⇒ store; explicit null ⇒ CLEAR
      // (no live stream); invalid/absent (undefined) ⇒ dropped, the stored
      // phase stands (an old router simply never sends the key).
      if (phaseVerdict !== undefined) existing.phase = phaseVerdict;
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
      ...(phaseVerdict !== undefined ? { phase: phaseVerdict } : {}),
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
   * #78: the client that OWNS a session token (for the transcript forward).
   * Resolves by `client_id` first (the register heartbeat names it), then by
   * `client_name` (a row whose client_id predates that key). Returns null when
   * the session names no owner, or the owner is not a registered client (an
   * offline/swept row) — the caller then answers the honest "unavailable".
   */
  clientRouteForSession(token: string): { ip: string; proxy_port?: number } | null {
    const s = this.store.state;
    const sess = s.sessions.find((x) => x.token === token);
    if (!sess) return null;
    const client =
      (sess.client_id ? s.clients.find((c) => c.client_id === sess.client_id) : undefined) ??
      (sess.client_name ? s.clients.find((c) => c.name === sess.client_name) : undefined);
    if (!client) return null;
    return { ip: client.ip, proxy_port: client.proxy_port };
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

  /**
   * #67 acceptance fix: WHICH alias a session's model belongs to. The
   * router sniffs `history.model` from the RESPONSE — for an alias
   * session that is the winner pair's ENGINE id, never the alias name
   * (docs/architecture/model-aliases.md: the sniff seam sees the
   * resolved engine model). A name-only lookup therefore never finds the
   * alias for real alias traffic, and the pin legality fell to the bare
   * branch and refused the legal cross-pair switch. Resolution order:
   *   1. the name itself IS an alias (name-shape session; the fixture
   *      path + engines that echo the REQUESTED model);
   *   2. an alias carrying the exact pair (session's current row,
   *      sniffed engine id) — the precise live shape. A pair match
   *      WITHOUT the row constraint is never consulted: a bare-name
   *      session that happens to share an id with some alias pair must
   *      keep the bare inventory rule, not alias legality.
   */
  private aliasForSessionModel(model: string, sessionServerId?: string): ModelAlias | undefined {
    const aliases = this.store.state.model_aliases;
    if (!aliases) return undefined;
    const byName = aliases[model];
    if (byName) return byName;
    if (sessionServerId) {
      for (const a of Object.values(aliases)) {
        const pairs = Array.isArray(a.pairs) ? a.pairs : [];
        if (pairs.some((p) => p && p.server_id === sessionServerId && p.model === model)) return a;
      }
    }
    return undefined;
  }

  /**
   * Set (replace) or clear (server_id: null) the operator engine pin for
   * a session token — #67, the SIBLING of the pause/force override plane
   * (same write shape, same poll-learned channel, one-tick latency —
   * #66 D4 precedent). A pin says: resolve this session's traffic to THIS
   * engine row at forward time (queued + next-request traffic only; a
   * running stream never moves).
   *
   * Truth constrains the write (brief: "valid targets are engines that
   * actually serve the session's model"). The session's model is the
   * #45 `history.model` (the router sniffed it from real traffic):
   *   - the target row must exist and be listed in the published catalog;
   *   - when the session's model is an ALIAS, the target must be one of
   *     that alias's surviving pair rows (drag target = "the other
   *     pair's engine" — the same plane);
   *   - for a bare-name model, the target row must carry the name in its
   *     inventory (last successful probe, else the declared list);
   *   - when the session has NO known model (no sniffed traffic yet), the
   *     row-exists check still applies — legality cannot be proven, so
   *     the pin rides and the ROUTER's own guard decides at release time
   *     (drop-don't-reject: an unprovable pin is never silently honored
   *     against an engine that lacks the model, it just falls through).
   * A rejection is TOLD (400 family at the route), like the alias write
   * route — operator input is not telemetry.
   */
  setSessionPin(
    token: string,
    serverId: string | null,
  ): { ok: boolean; reason?: string; pin?: SessionPin | null } {
    const s = this.store.state;
    const session = s.sessions.find((x) => x.token === token);
    if (!session) return { ok: false, reason: 'unknown_session' };
    if (serverId === null) {
      const had = s.session_pins[session.token];
      delete s.session_pins[session.token];
      if (had) {
        this.store.appendEvent({ kind: 'session_pin_cleared', detail: `${session.token}: engine pin cleared` });
      }
      this.store.trim();
      this.store.save();
      return { ok: true, pin: null };
    }
    if (typeof serverId !== 'string' || !serverId || serverId.length > 128) {
      return { ok: false, reason: 'server_id required (≤128 chars)' };
    }
    const row = s.servers.find((r) => r.id === serverId);
    if (!row) return { ok: false, reason: 'unknown_server' };
    const model = typeof session.history?.model === 'string' ? session.history.model : undefined;
    if (model) {
      const alias = this.aliasForSessionModel(model, session.server_id);
      if (alias) {
        // Alias session: legal target = one of the alias's pair rows.
        const pairs = Array.isArray(alias.pairs) ? alias.pairs : [];
        if (!pairs.some((p) => p && p.server_id === serverId)) {
          return { ok: false, reason: 'not_an_alias_pair' };
        }
      } else {
        // Bare-name session: the row must carry the name in its inventory
        // (last successful probe; probe-blocked falls back to declared).
        const inventory = this.lastProbed.get(row.id) ?? row.models ?? [];
        if (!inventory.includes(model)) {
          return { ok: false, reason: 'row_lacks_model' };
        }
      }
    }
    const pin: SessionPin = { token: session.token, server_id: serverId, set_at: Date.now() };
    s.session_pins[session.token] = pin;
    this.store.appendEvent({ kind: 'session_pinned', detail: `${session.token} → ${serverId}` });
    this.store.trim();
    this.store.save();
    return { ok: true, pin };
  }

  /**
   * #67: the engine_pin block published for one session row (resolved,
   * like the #66 alias block — the router NEVER recomputes urls). The
   * pin's row url + that row's engine id for the session's model ride
   * along, because the published catalog dedupes a bare name onto ONE
   * row: the router cannot resolve the second pair's row itself.
   * `engine_model` is set only when the pin's row serves the session's
   * model under a DIFFERENT id (the alias pair case — the same splice
   * rule as #66 D3 at forward time). Absent pin or a pin whose row went
   * missing: no key (the router falls back to the dispatch-chosen row).
   */
  sessionPinBlock(token: string, model: string | undefined, sessionServerId?: string): { server_id: string; url: string; engine_model?: string; set_at: number } | undefined {
    const pin = this.store.state.session_pins[token];
    if (!pin || typeof pin.server_id !== 'string' || pin.server_id === '') return undefined;
    const row = this.store.state.servers.find((r) => r.id === pin.server_id);
    if (!row || typeof row.url !== 'string' || row.url.trim() === '') return undefined;
    let engineModel: string | undefined;
    if (model) {
      const alias = this.aliasForSessionModel(model, sessionServerId);
      const pair = alias && Array.isArray(alias.pairs) ? alias.pairs.find((p) => p && p.server_id === pin.server_id) : undefined;
      if (pair && typeof pair.model === 'string' && pair.model !== model) engineModel = pair.model;
    }
    return {
      server_id: pin.server_id,
      url: row.url,
      ...(engineModel !== undefined ? { engine_model: engineModel } : {}),
      set_at: pin.set_at,
    };
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
  // Theme colors (#68) — the operator-tuned dashboard color scheme
  // ------------------------------------------------------------------

  /**
   * The theme write engine (#68). Sanitize, then persist — the SAME write
   * shape as the project-settings plane (appendEvent + trim + save).
   *
   * Sanitizer (drop-don't-reject, the arbiter's standing posture for
   * operator input):
   *   - hex grammar only (THEME_HEX_RE): a non-conforming value drops THAT
   *     key and keeps its prior value — a bad value never 400s the write and
   *     never breaks the map.
   *   - known keys only (the nine THEME_TOKEN_KEYS): an unknown key drops
   *     silently — it never enters the map.
   *   - a key the operator never set keeps its prior value (an absent key is
   *     a no-op, not a clear); an all-bad payload therefore keeps the prior
   *     map (it never clears to empty).
   *   - a brand-new write (no prior map) seeds from THEME_DEFAULTS first so
   *     the persisted map always carries the full nine-token shape.
   *
   * The values are pure CSS colors. A theme value never carries a token or
   * secret (the hex grammar admits only hex), so the map is anonymous-readable
   * on /api/state — the ADD key, present when set, absent when unset.
   */
  setTheme(colors: Record<string, unknown>): {
    ok: true;
    theme: ThemeColors;
    /** The tokens this write actually applied (0 = the whole payload dropped). */
    applied: number;
    /** The tokens dropped as unknown keys. */
    dropped: string[];
  } {
    const prior = this.store.state.theme?.colors ?? { ...THEME_DEFAULTS };
    const next: Record<string, string> = { ...prior };
    let applied = 0;
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(colors ?? {})) {
      const known = (THEME_TOKEN_KEYS as readonly string[]).includes(k);
      if (!known) {
        dropped.push(k);
        continue;
      }
      if (typeof v === 'string' && THEME_HEX_RE.test(v)) {
        next[k] = v;
        applied += 1;
      }
      // else: a non-conforming value drops this key, keeps the prior value.
    }
    const nowIso = new Date().toISOString();
    this.store.state.theme = { colors: next, updated_at: nowIso };
    if (applied > 0) {
      this.store.appendEvent({ kind: 'theme_updated', detail: `${applied} token(s) set` });
    }
    this.store.trim();
    this.store.save();
    return { ok: true, theme: this.store.state.theme, applied, dropped };
  }

  /** The persisted theme map, or null when unset (the /api/state ADD key omits it). */
  theme(): ThemeColors | null {
    return this.store.state.theme ?? null;
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

  /**
   * Remove a declared server row (the operator's inventory control).
   * Guard rails: unknown id → 'unknown_server'; a row with LIVE leases is
   * refused ('leases_active') — removal never pulls an engine out from
   * under a running job. The detector, probe memory, and reidle gate for
   * the row are dropped with it; the events note the removal.
   */
  removeServerConnection(id: string): { ok: boolean; reason?: string; removed?: string } {
    const s = this.store.state;
    const row = s.servers.find((x) => x.id === id);
    if (!row) return { ok: false, reason: 'unknown_server' };
    const busy = this.activeLeases(Date.now()).some((l) => leaseServerId(l) === id);
    if (busy) return { ok: false, reason: 'leases_active (let them finish or revoke them first)' };
    s.servers = s.servers.filter((x) => x.id !== id);
    this.detectors.delete(id);
    this.lastProbed.delete(id);
    this.lastProbedAt.delete(id);
    this.reidleAfter.delete(id);
    this.store.appendEvent({ kind: 'server_connection_removed', detail: `${row.name} (${row.url})` });
    this.store.trim();
    this.store.save();
    return { ok: true, removed: id };
  }

  // ------------------------------------------------------------------
  // Agent keys (#68): idlefill-issued credentials for aggregate callers
  // ------------------------------------------------------------------

  /**
   * Mint an agent key. The PLAINTEXT is returned exactly once (the mint
   * response) and stored nowhere: the row keeps only the sha256 hex
   * digest of it. Write-only posture (#60 B) — no read surface ever
   * carries a plaintext or a digest except the loopback-scoped pull,
   * which hands DIGESTS (the router matches by hashing what the caller
   * presented; even a stolen pull response cannot replay a usable key).
   */
  mintClientKey(label: string): { key: ClientKeyRow; token: string } {
    const s = this.store.state;
    const token = `idlk_${randomBytes(18).toString('hex')}`;
    const key: ClientKeyRow = {
      id: `key-${randomBytes(4).toString('hex')}`,
      label,
      hash: createHash('sha256').update(token).digest('hex'),
      created_at: Date.now(),
    };
    s.client_keys.push(key);
    this.store.appendEvent({ kind: 'client_key_minted', detail: label });
    this.store.trim();
    this.store.save();
    return { key, token };
  }

  /** Public list rows (id/label/created_at) — hash stripped, like auth_token on servers. */
  clientKeys(): { id: string; label: string; created_at: number }[] {
    return this.store.state.client_keys.map(({ id, label, created_at }) => ({ id, label, created_at }));
  }

  /**
   * The LOCAL machine's agent roster (#80): the roster row of the ONLINE
   * loopback client (the daemon that reported to THIS arbiter from its own
   * machine — observed IP is loopback). The roster is local-truth (the
   * dashboard is served by this machine's own arbiter), so only that
   * client's roster is honest here; a remote client's roster would name
   * a different box's profiles. Returns undefined when no loopback client
   * is online or that client reported no roster (the read route then says
   * so rather than showing an empty list).
   */
  localAgentRoster(now?: number): { client: string; roster: AgentRosterRow[] } | undefined {
    const n = now ?? Date.now();
    // Pick the online loopback client with the newest last_seen (the live local
    // daemon); a tie falls to the later row (deterministic). In practice there
    // is exactly one online loopback client per machine (its own daemon).
    let best: (typeof this.store.state.clients)[number] | undefined;
    for (const c of this.store.state.clients) {
      if (c.last_seen === undefined || n - c.last_seen >= 90_000) continue;
      if (!isLoopbackIp(c.observed_ip || c.ip)) continue;
      if (!c.agent_roster || c.agent_roster.length === 0) continue;
      if (!best || c.last_seen >= best.last_seen) best = c;
    }
    if (!best) return undefined;
    return { client: best.name, roster: best.agent_roster! };
  }

  /** The digests the machine's own router enforces (loopback route only). */
  clientKeyDigests(): string[] {
    return this.store.state.client_keys.map((k) => k.hash);
  }

  /** Revoke by id. Unknown id → 'unknown_key' (404 at the route). */
  revokeClientKey(id: string): { ok: boolean; reason?: string; revoked?: string } {
    const s = this.store.state;
    const row = s.client_keys.find((k) => k.id === id);
    if (!row) return { ok: false, reason: 'unknown_key' };
    s.client_keys = s.client_keys.filter((k) => k.id !== id);
    this.store.appendEvent({ kind: 'client_key_revoked', detail: `${row.id} (${row.label})` });
    this.store.trim();
    this.store.save();
    return { ok: true, revoked: id };
  }

  /** The last probe-confirmed model list for a row (null = never probed). */
  probedModels(id: string): string[] | null {
    return this.lastProbed.get(id) ?? null;
  }

  /** Epoch-ms the row's /v1/models probe last answered (null = never). */
  probedAt(id: string): number | null {
    return this.lastProbedAt.get(id) ?? null;
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
 * True when the observed client IP is loopback (localhost / 127.0.0.0/8 /
 * ::1). The #80 agent roster is LOCAL-truth (the dashboard is served by this
 * machine's own arbiter), so the read surface returns only the ONLINE
 * loopback client's roster — the daemon reporting from its own box. A
 * remote (tailnet) client's roster would name a DIFFERENT machine's profiles
 * and is not honest here (cross-machine is the #55 fleet plane).
 */
export function isLoopbackIp(v: string | undefined): boolean {
  if (typeof v !== 'string') return false;
  const host = v.trim();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
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
