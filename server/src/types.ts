/**
 * Shared types for the idlefill arbiter.
 */

export interface ProjectConfig {
  name: string;
  paused: boolean;
  /** Output-token cap per UTC day for this project. */
  daily_token_cap: number;
  /**
   * Per-project overrides of the global grant knobs. Unset = inherit the
   * global value (cfg.idle_seconds / max_concurrent_leases / lease_ttl_seconds).
   * Set via POST /api/projects/:name/settings (persisted in the state file's
   * project row — cfg is the live object the arbiter reads from).
   */
  idle_seconds?: number;
  max_concurrent_leases?: number;
  lease_ttl_seconds?: number;
}

export interface ServerConfig {
  listen: number;
  api_tokens: string[];
  llama_swap_url: string;
  activity_path: string;
  /** Display name for the watched inference server (defaults to the URL's host:port). */
  server_name?: string;
  /** Models that can run concurrently on the watched server (queueable resources). */
  server_models?: string[];
  /** llama-swap `peer:` backends routed behind the single entry point (display metadata). */
  server_peers?: string[];
  /** Glob of NInfer req-*.jsonl logs. Empty string disables the log-mtime signal. */
  log_glob: string;
  idle_seconds: number;
  poll_ms: number;
  lease_ttl_seconds: number;
  /**
   * Adaptive lease TTL (safety factor). When a client reports a per-job
   * `estimated_seconds`, the lease is capped at
   * `estimated_seconds * lease_ttl_safety_factor` (never above the effective
   * `lease_ttl_seconds`, never below `lease_ttl_floor_seconds`). The estimate
   * is a first-run guess, so the factor is never 1 — default 2. A missing or
   * zero estimate leaves the lease at the full `lease_ttl_seconds` (today's
   * behavior), so the adaptive TTL can only expire a lease SOONER, never later.
   */
  lease_ttl_safety_factor: number;
  /** Floor (in seconds) for the adaptive lease TTL — the estimate-driven cap never drops below it. */
  lease_ttl_floor_seconds: number;
  max_concurrent_leases: number;
  /**
   * Anti-thrash (per-job): a job that has reported this many `ok:false`
   * usage results (per project+job_id) is THROTTLED — no further grants for
   * it until the operator unthrottles it (POST /api/projects/:name/jobs/
   * :job_id/unthrottle). The client's 3-attempt quarantine is the first line
   * of defense; this is the arbiter-side backstop for old/buggy clients and
   * multi-client scenarios (a Sep 25-26 incident: 902 re-grants of one
   * crashed job over 17 hours).
   */
  job_fail_threshold: number;
  /**
   * Anti-thrash (per-job): after any failed lease for job X, no new grant
   * for X for this many seconds — even below the failure threshold. This is
   * what breaks the ~20-second re-grant loop between polls.
   */
  job_cooldown_seconds: number;
  projects: ProjectConfig[];
  /** State file path (env IDLEFILL_STATE overrides). */
  state_file: string;
}

/**
 * One queue row as the client publishes it for the dashboard's queue page
 * (`/[project]/[worker]/queue`). The arbiter stores and displays it verbatim
 * — it never reads the client's queue files. Bounded at registration:
 * ≤100 rows, title ≤200 chars, job_id ≤128 chars.
 */
export interface QueuePreviewRow {
  job_id: string;
  /** Display title (payload title, falling back to url or job_id client-side). */
  title: string;
  company: string;
  score: number | null;
  /** Failure-retry count so far (0 = fresh). */
  attempts: number;
}

/**
 * A project allocation as reported by a client at (re)registration. The
 * client knows its own config (model, estimate, queue depth) and reports it;
 * the arbiter only stores and displays it.
 */
export interface ProjectAllocation {
  name: string;
  /** Model id the client's executor uses for this project. */
  model: string;
  /** Estimate the client passes to the arbiter at grant time. */
  estimated_seconds: number;
  /** Jobs currently in the client's local queue for this project. */
  queue_depth: number;
  /**
   * The first rows of the client's queue file (priority order), published
   * with the heartbeat for the dashboard's queue page. Absent on older
   * clients — the page degrades to the depth number.
   */
  queue_preview?: QueuePreviewRow[];
  /**
   * Client-published stats for this project (the heartbeat carries them with
   * every re-registration). String keys; number or short-string values. The
   * arbiter stores and displays them — it never computes them.
   */
  stats?: Record<string, number | string>;
}

/**
 * A declared inference-server connection. The arbiter watches ONE feed
 * (cfg.llama_swap_url + cfg.activity_path); the connection list is the
 * operator-managed inventory of the server(s) behind it — today exactly the
 * watched one, seeded from config, and the `peer:` backends that llama-swap
 * routes behind its single entry point. Multi-feed monitoring is future
 * work; rows carry no live signal until the core catches up.
 */
export interface ServerConnection {
  id: string;
  name: string;
  /** Inference-server (llama-swap) base URL. */
  url: string;
  activity_path: string;
  /** Models that can run concurrently on this server (separate queueable resources). */
  models: string[];
  /** llama-swap `peer:` backends routed behind this entry point (display only). */
  peers: string[];
  configured_at: number;
  updated_at: number;
}

export interface ClientRecord {
  name: string;
  client_id: string;
  /**
   * The client's REAL current IP — the observed connection IP, refreshed on
   * every (re)registration. This is what the self-traffic exemption keys on
   * (it tracks tailnet reassignments; the client's static config value does
   * not). Falls back to the reported value until a valid observed IP arrives.
   */
  ip: string;
  /** The client-reported IP (its static config) — display/audit only. */
  reported_ip?: string;
  /** The observed connection IP, as captured at the most recent registration. */
  observed_ip: string;
  registered_at: string;
  /** Epoch-ms of the most recent successful (re)registration — liveness. */
  last_seen: number;
  /** Projects this client reports it is allocated to (from its own config). */
  projects: ProjectAllocation[];
  /**
   * The client's own version string (root package.json version, sent at
   * registration). Absent on pre-version clients — the dashboard renders
   * it exception-only, and the operator can see which worker revision is
   * connected. Display/audit only; never a gate (yet).
   */
  version?: string;
  /**
   * The wire-protocol revision the client speaks (integer; 1 = the first
   * versioned handshake). Absent on pre-version clients.
   */
  protocol?: number;
}

/**
 * Operator override for a client (set via POST /api/clients/:id/override).
 *
 *   - 'pause' : refuse NEW lease grants for this client (active leases are
 *               not revoked — pausing a client does not tear down running
 *               work).
 *   - 'force' : allow NEW lease grants for this client even when the system
 *               is not idle (bypasses the idle verdict and the post-revocation
 *               reidle gate). Deliberately does NOT bypass: degraded signal
 *               (no reliable activity data ⇒ never grant), the
 *               max-concurrent limit, project pause, or the daily budget.
 *
 * `until: null` means the override stays until cleared; otherwise it expires
 * when now >= until (checked at grant time, trimmed on each tick).
 */
export interface ClientOverride {
  client_id: string;
  override: 'pause' | 'force';
  until: number | null;
  set_at: number;
}

export type LeaseStatus = 'active' | 'finished' | 'revoked' | 'expired';

export interface Lease {
  lease_id: string;
  client_id: string;
  client_name: string;
  /** IP the arbiter exempts from the idle calc while THIS lease is active. */
  exempt_ip: string;
  project: string;
  job_id: string;
  estimated_seconds: number;
  status: LeaseStatus;
  granted_at: number;
  expires_at: number;
  /** Set when revoked/expired. */
  ended_at?: number;
  end_reason?: string;
  tokens_out: number;
  tokens_in: number;
  /** True when the client reported a partial (preempted/failed) result. */
  partial?: boolean;
  /** True once this lease's first usage report has been counted into the budget. */
  usage_counted?: boolean;
  /**
   * Last failure detail reported for this lease (the client's last ≤1000
   * chars of the executor's combined output; empty string when the executor
   * produced no output). Persisted so a failed job's WHY survives in the
   * state file (a crashed executor with no stderr is otherwise
   * indistinguishable from a kill).
   */
  error_detail?: string;
}

export interface ActivityEntry {
  id: number;
  timestamp: string;
  src: string;
  model: string;
  req_path: string;
  resp_status_code: number;
}

export interface LastActivity {
  ts: number;
  model: string;
  src: string;
}

export interface BudgetEntry {
  tokens_out: number;
  tokens_in: number;
}

/** UTC date key, e.g. "2026-09-25". */
export type UtcDate = string;

/**
 * A throttled job (anti-thrash): the job's failures reached
 * `job_fail_threshold`. While this row exists, the arbiter refuses new
 * grants for (project, job_id) with reason `job_throttled`, independent of
 * what any client does. `count` is the failure count at throttle time (it
 * stays at the count when it crossed the threshold; the operator sees the
 * number that triggered the stop).
 */
export interface JobThrottle {
  project: string;
  job_id: string;
  /** Failure count when the threshold was crossed. */
  count: number;
  /** Last reported error string (e.g. `executor_exit_1`). */
  last_error: string;
  /** Last failure detail (client output tail, ≤1000 chars; '' when none). */
  last_error_detail: string;
  /** Epoch-ms of the failed report that crossed the threshold. */
  last_failed_at: number;
}

export interface IdleSignal {
  now: number;
  idle: boolean;
  /** Seconds since the newest (non-exempt) activity, or null when unknown. */
  idle_for_s: number | null;
  last_activity: LastActivity | null;
  last_log_write: number | null;
  signal_degraded: boolean;
  degraded_reason: string | null;
}

export type EventKind =
  | 'lease_granted'
  | 'lease_finished'
  | 'lease_revoked'
  | 'client_registered'
  | 'project_paused'
  | 'project_resumed'
  | 'signal_degraded'
  | 'signal_recovered'
  | 'client_paused'
  | 'client_forced'
  | 'client_override_cleared'
  | 'project_settings_updated'
  | 'server_connection_added'
  | 'server_connection_updated'
  | 'job_throttled'
  | 'job_unthrottled';

export interface EventRecord {
  ts: number;
  kind: EventKind;
  project?: string;
  lease_id?: string;
  detail?: string;
}

/**
 * The persisted project row: the project's operator state (pause + the
 * per-project grant-knob overrides) as of the last write. Config is the
 * declaration; these rows are the live truth and re-hydrate the config
 * objects at boot.
 */
export interface ProjectStateRow {
  name: string;
  paused: boolean;
  idle_seconds?: number;
  max_concurrent_leases?: number;
  lease_ttl_seconds?: number;
  updated_at: number;
}

export interface ArbiterState {
  /** Declared inference-server connections (seeded from config on first load). */
  servers: ServerConnection[];
  /** Persisted operator state for each configured project. */
  projects: ProjectStateRow[];
  clients: ClientRecord[];
  /**
   * Anti-thrash per-(project, job_id) throttle entries. A job reaches this
   * map when its ok:false usage-report count hits `job_fail_threshold`;
   * while present, requestLease for that job is denied `job_throttled`
   * (HTTP 409) until the operator unthrottles it. Persists across restarts
   * (the state file is the only persistence).
   */
  throttled_jobs: Record<string, JobThrottle>;
  /**
   * Operator overrides (pause/force), keyed by client_id. A client that
   * unregisters is re-registered under the SAME name with a NEW client_id,
   * so an override never "sticks" to a different client — and the orphaned
   * entry is trimmed on the next tick (client not found).
   */
  overrides: Record<string, ClientOverride>;
  leases: Lease[];
  /** Project name -> UTC date -> usage. */
  budgets: Record<string, Record<UtcDate, BudgetEntry>>;
  events: EventRecord[];
  last_activity: LastActivity | null;
  last_log_write: number | null;
  signal_degraded: boolean;
  degraded_reason: string | null;
  updated_at: number;
}
