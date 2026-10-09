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
  /**
   * Activity-feed path on the watched server. EMPTY = the watched server
   * declares NO feed (#60 A1, e.g. oMLX): the feed signal is disabled
   * rather than degraded, and log_glob alone carries the idle verdict.
   * An ABSENT key keeps the default `/api/metrics/activity` (back-compat).
   */
  activity_path: string;
  /** Display name for the watched inference server (defaults to the URL's host:port). */
  server_name?: string;
  /** Models that can run concurrently on the watched server (queueable resources). */
  server_models?: string[];
  /** llama-swap `peer:` backends routed behind the single entry point (display metadata). */
  server_peers?: string[];
  /** Provider kind for the watched server (#60 B): 'llama-swap' (default) or 'strata'. */
  server_provider?: ServerProvider;
  /**
   * oMLX usage-store sqlite path for the 'omlx' kind (#62). Default:
   * ~/.omlx/usage.sqlite3. Read-only; co-located kinds only.
   */
  omlx_usage_db?: string;
  /**
   * Credential for the watched server (#60 B): seeded onto the watched
   * row at boot and sent as `Authorization: Bearer <token>` on its feed
   * fetches. Config-only input — never echoed by any read surface.
   */
  server_auth_token?: string;
  /**
   * Mesh federation read plane (#50 D1). The peer registry: other
   * idlefill arbiters to pull coarse snapshots from. NOT `server_peers`
   * (that key means llama-swap backends). Each arbiter pulls on the
   * poll cadence; snapshots are ephemeral (never written to state.json).
   */
  mesh_peers?: { url: string; name?: string }[];
  /**
   * Fleet read-only token (#50 D2). Presented by peer arbiters at
   * GET /api/mesh. Empty = the mesh read plane is closed to peers
   * (the endpoint still answers local admin tokens).
   */
  peer_token?: string;
  /** This instance's mesh display name (default: the OS hostname). */
  mesh_name?: string;
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
  /**
   * Metrics retention store (#51 D5): how long the raw JSONL day-files
   * survive. Past this window only the hour buckets remain. Default 48.
   */
  metrics_raw_window_hours?: number;
  /**
   * Metrics retention store (#51 D5): how long the hour-bucket day-files
   * survive. Default 400 (the 30-day acceptance bar, with room).
   */
  metrics_retention_days?: number;
  /**
   * Load-axis freshness window (#52 slice 1, D3): seconds after which a
   * captured load reading is labelled STALE by `load_age_s` (display and
   * sample only). In this wave it labels age ONLY — it does not veto
   * anything and the verdict never reads it (the busy veto is D4, not
   * built). Default 45 (three polls at the 15-second `poll_ms`).
   */
  metrics_load_stale_s?: number;
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
 * One dev-cycle row as the client publishes it for the dashboard's cycle
 * strip (#53 D9.3: one entry per cycle, no merged progress line). Computed
 * CLIENT-side from the project's cycles file; the arbiter stores and
 * displays it verbatim, it never computes (the last_rebuild discipline,
 * D7). Sanitized at registration: cycle_id string trim ≤128, status in
 * planned|running|paused|done, numeric fields finite integers ≥ 0, stage
 * in item|gate; rows failing shape checks are dropped, never stored.
 */
export interface CycleStatusRow {
  cycle_id: string;
  status: 'planned' | 'running' | 'paused' | 'done';
  items_total: number;
  /** The row's cursor.item as stored (0-based); the dashboard renders +1. */
  item_index: number;
  settled: number;
  passed: number;
  quarantined: number;
  stage: 'item' | 'gate';
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
  /**
   * Scheduled queue rebuild run state (issue #3), published by the client
   * with the heartbeat when its project has `scheduled_rebuild` enabled and
   * has run at least once. The arbiter stores + echoes it on /api/state —
   * it never computes or parses it. Sanitized at registration: finite
   * numbers only; malformed → dropped.
   */
  last_rebuild?: RebuildRunState;
  /**
   * Dev-cycle status rows (#53 D9.3), published by the client with the
   * heartbeat when its project has a cycles file with at least one usable
   * row. One entry per cycle, file order — no merged progress line. The
   * arbiter stores + echoes them on /api/state verbatim; it never computes.
   * Sanitized at registration (cleanCycles): ≤20 rows, malformed rows
   * dropped. Absent on older clients and on projects with no cycles.
   */
  cycles?: CycleStatusRow[];
  /**
   * The EFFECTIVE cycle_max_in_flight the client's driver runs with
   * (0 = the knob is absent). Client-published display data like the rows
   * above; finite integer ≥ 0 or the key is dropped.
   */
  cycle_cap?: number;
}

/**
 * The client's persisted scheduled-rebuild state (issue #3): when the
 * configured rebuild command last ran, how it ended, and the queue depth
 * before/after. The client owns the file (`<queue_file>.rebuild.json`);
 * the arbiter only carries the echo for the dashboard.
 */
export interface RebuildRunState {
  /** Epoch-ms when the run STARTED. */
  last_run_ts: number;
  /** Process exit code; -1 = killed by the client's timeout. */
  exit_code: number;
  duration_ms: number;
  queue_before: number;
  queue_after: number;
}

/**
 * Provider kind (#60 B, #62): the dialect a server answers — selects the
 * idle-signal implementation AND the metrics sampler.
 * 'llama-swap' (default) = the activity-feed contract ({data:[{id,
 * timestamp, src, model, ...}]}), request counts as feed-id deltas.
 * 'strata' = strata's /metrics JSON (engine/live/requests/totals),
 * adapted into feed entries by parseStrataMetrics; request + token
 * truth from the totals counters (HTTP only — works remote).
 * 'omlx' = co-located oMLX: idle = log mtime (feed-off), metrics =
 * model_usage_hourly rows from the oMLX usage sqlite store.
 */
export type ServerProvider = 'llama-swap' | 'strata' | 'omlx';
export const PROVIDER_KINDS: ServerProvider[] = ['llama-swap', 'strata', 'omlx'];

/**
 * Engine-reported cumulative counters (#62): monotonic since engine boot
 * (strata /metrics totals) or since install (oMLX usage store sums).
 * Diffs between consecutive samples ride the engine sample line; a
 * backwards counter (engine restart) reads unknown, never negative.
 */
export interface EngineCounters {
  requests: number;
  tokens_in: number;
  tokens_out: number;
}

/** Where a sample's request/token numbers came from (ADD key). */
export type RequestsSource = 'feed-delta' | 'metrics-counter' | 'sqlite';

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
  /**
   * Activity-feed path. EMPTY = this server declares NO feed (#60 A1):
   * its detector disables the feed signal instead of degrading; log_glob
   * alone then carries the verdict. Rows created before #60 A1 always
   * carry a path and behave exactly as before.
   */
  activity_path: string;
  /**
   * Per-server log-mtime glob (the second idle signal; see IdleDetector).
   * Absent = the log signal is disabled for this server. The watched
   * server's row inherits cfg.log_glob at boot.
   */
  log_glob?: string;
  /** Models that can run concurrently on this server (separate queueable resources). */
  models: string[];
  /** llama-swap `peer:` backends routed behind this entry point (display only). */
  peers: string[];
  /**
   * Provider kind (#60 B): selects the feed SHAPE, not just the path.
   * Absent or 'llama-swap' = the activity-feed contract ({data:[{id,
   * timestamp, src, model, ...}]}). 'strata' = strata's /metrics JSON
   * (engine/live/requests), adapted into feed entries by
   * parseStrataMetrics. ADD key: existing rows carry no field and behave
   * exactly as before.
   */
  provider?: ServerProvider;
  /**
   * Per-server credential for key-gated engines (#60 B): when set, the
   * arbiter sends it as `Authorization: Bearer <token>` on this server's
   * activity-feed fetches. WRITE-ONLY over the API: the row is STRIPPED
   * of this field on every read surface (/api/state — including the
   * anonymous view — /api/servers, POST responses, mesh snapshots, the
   * dashboard). Only the arbiter's own state file holds the value.
   */
  auth_token?: string;
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
  /**
   * The git commit the client's RUNNING process loaded its code from
   * (`git rev-parse HEAD` at daemon startup — issue #49). Unlike
   * `version` (a release number that only bumps on a tag), this reveals
   * a daemon that predates the working tree it runs from. The surfaces
   * compare it against their own checkout HEAD and flag the mismatch;
   * the arbiter only stores and echoes it (it has no view of any
   * client's repo tree). Sanitized like version (string ≤64 chars,
   * malformed → dropped); absent on pre-#49 clients — never a rejection.
   */
  revision?: string;
  /**
   * The client router's session-gate posture (#41), published on every
   * register heartbeat: `armed` = the arbiter is reachable and the slot cap
   * + operator overrides are in force; `fail_open` = the arbiter was
   * unreachable from the router's side, so every session was admitted and
   * the cap is OFF. A silently fail-open gate is the failure this issue
   * exists to close. The arbiter stores + echoes the LAST report verbatim
   * (client-truth discipline: the posture lives inside the router, the
   * arbiter cannot observe it); surfaces render it exception-only — an
   * absent key (old client, or a daemon running without a session gate)
   * renders exactly as before, and `armed` renders nothing (no tag is the
   * healthy state).
   */
  gate_posture?: 'armed' | 'fail_open';
  /**
   * The port the client's session-gate proxy ACTUALLY bound (#43 session
   * launcher), published on the register heartbeat — the config value may
   * be 0 (ephemeral), so only the daemon knows. The Sessions surface uses
   * it to hand over the exact `/model http://127.0.0.1:<port>/s/<token>`
   * line for this machine. ADD-key: stored on a valid report (integer in
   * 1..65535, else dropped), absent on old clients and gate-less daemons.
   */
  proxy_port?: number;
  /**
   * The port the client's AGGREGATE listener (#64) ACTUALLY bound,
   * published on the register heartbeat — the agent base URL
   * (`http://127.0.0.1:<port>/v1`) an agent config points at when it
   * authenticates with an idlefill agent key (#68). ADD-key: stored on a
   * valid report (integer 1..65535, else dropped), absent on old clients
   * and on daemons running with aggregate_port=0 or a failed bind.
   */
  aggregate_port?: number;
  /**
   * Code-staleness verdict computed WHERE THE FACTS LIVE (#61 step 3, A1):
   * the client compares its own boot revision against the live
   * `git rev-parse HEAD` of the checkout it runs from, and publishes the
   * boolean on the register heartbeat. `true` only when BOTH sides resolve
   * and differ; the key is omitted when either side cannot resolve (no git,
   * not a repo). A `true` report stores the marker; a `false` report
   * CLEARS it (same precedent as the session gate block: an explicit
   * no-exception report clears the stored exception, an absent report
   * leaves the row as-is) — so the surfaces' `daemon behind` tag clears
   * within one heartbeat of a daemon restart. Surfaces render it
   * exception-only: no tag is the healthy state. The arbiter stores the
   * verdict verbatim — it has no view of any client's repo tree.
   */
  daemon_behind?: boolean;
  /**
   * The client daemon's own log tail (#61 step 3, A2): the last ~120
   * formatted lines from client.log, published on the register heartbeat
   * ONLY when the arbiter it reports to is loopback (the mesh must not
   * carry log payloads; a remote arbiter gets the key omitted). Lines are
   * display data — capped per line, oldest first, stored verbatim. An
   * empty array CLEARS the stored tail (a daemon that moved to a remote
   * arbiter stops leaking lines). Absent on old clients.
   */
  client_log?: string[];
  /**
   * The client daemon's LOCAL Hermes profile roster (#80), published on
   * the register heartbeat: which Hermes profiles exist on THIS machine
   * and which of them already route through idlefill (adopted). The
   * dashboard's Agents pane joins these rows to the minted agent keys by
   * EXACT profile-name = key-label match (never fuzzy). ADD-key: stored on
   * a valid report (a sanitized array of ≤24 rows; a malformed member
   * drops only that row), an all-malformed / non-array report is treated as
   * absent (drops the whole key), and absent NEVER clears the stored value
   * — a daemon without a Hermes home (the Linux daemons) omits the key and
   * the roster pane hides, it does not show an empty list. The arbiter
   * stores + echoes it verbatim (client-truth discipline: it has no view of
   * any client's ~/.hermes). Display/audit only; never a gate.
   */
  agent_roster?: AgentRosterRow[];
}

/**
 * One row of a client's local Hermes profile roster (#80). The daemon
 * classifies each `~/.hermes/profiles/<name>` directory from its
 * config.yaml (`model.provider` + endpoint URLs only — it never follows a
 * `key_env` reference, never reads a profile `.env`). `posture`:
 * `adopted` = an endpoint names this machine's own aggregate port (routes
 * through idlefill); `external` = a model block present but routing
 * elsewhere; `unset` = no config.yaml / no model block. `provider` +
 * `base_url` are display-only (absent when not known).
 */
export interface AgentRosterRow {
  /** The profile directory name (one name per row, used consistently). */
  profile: string;
  /** `adopted` | `external` | `unset`. */
  posture: 'adopted' | 'external' | 'unset';
  /** model.provider — display only; absent when the model block lacks it. */
  provider?: string;
  /** The endpoint URL justifying the posture (absent for unset / userinfo). */
  base_url?: string;
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

/**
 * A router-self-registered interactive session (#33): the router creates
 * the row on first sight of a `/s/<token>` path and refreshes it with
 * heartbeats. Sessions are INTERACTIVE traffic (#32): `last_activity`
 * folds into the server's idle verdict and preempts background leases on
 * that server — the lease-holder IP exemption never covers session
 * traffic. Session admission itself is capacity-only (the router admits
 * directly); the arbiter tracks the rows for visibility, idle folding, and
 * operator overrides.
 */
export interface SessionRecord {
  /** The /s/<token> path token (minted by the desktop app / router). */
  token: string;
  /** The client (router) that registered it, when it identified itself. */
  client_id?: string;
  client_name?: string;
  /** Engine it routes to. Absent = the watched server. */
  server_id?: string;
  registered_at: number;
  /** Epoch-ms of the most recent heartbeat — liveness. */
  last_seen: number;
  /** Epoch-ms of the newest request seen on this session (null = none yet). */
  last_activity: number | null;
  /**
   * The router's queue truth for this session, carried on every register
   * heartbeat (gate-state). 'active' = the session holds an inference slot
   * right now; 'queued' = it has ≥1 parked request waiting for admission;
   * `waiting` = parked-request count. null = the router reported no gate
   * (idle session) — a session that stopped waiting never stays tagged.
   * Absent on rows persisted before gate-state.
   */
  gate?: { state: 'active' | 'queued'; waiting: number; position?: number } | null;
  /**
   * The REAL Hermes conversation id (#42 Slice 0), captured by the router
   * from the `X-Hermes-Session-Id` request header and published on the
   * register heartbeat as an ADD-key. The plugin path (middleware
   * `llm_execution`) and the header path converge on THIS field — one
   * contract, two sources. Absent = the session never carried the header
   * (curl, non-Hermes clients, pre-slice rows): surfaces render unchanged.
   * Sanitizer posture: bounded printable string, drop-don't-reject.
   */
  session_id?: string;
  /**
   * #45 session detail: the compact request history the router keeps per
   * session, carried on the register heartbeat as the `history` ADD-key.
   * `rpm`: requests/min counts, 60s buckets, oldest→newest, exactly 10
   * entries (10 minutes) — computed by the ROUTER at report time (the
   * router sees every request; the arbiter only echoes). `model`: last
   * model name sniffed from a forwarded chat-completions body. `tokens`:
   * last total_tokens observed in the session's streamed usage.
   * `reported_at`: when the arbiter received this snapshot (rpm ages only
   * while heartbeats keep flowing; a stale row dims via last_seen).
   * Absent = pre-slice row or a session with no recorded traffic — the
   * surfaces render unchanged. Sanitizer posture: drop-don't-reject.
   */
  history?: { rpm: number[]; model?: string; tokens?: number; reported_at: number };
  /**
   * #67 response phase: what the engine is doing RIGHT NOW for this
   * session, carried on every register heartbeat as the `phase` ADD-key.
   * 'thinking' = reasoning deltas streaming, 'output' = content deltas,
   * 'tools' = tool_calls deltas. `at` = epoch-ms of the last observed
   * phase chunk (the surface dims the state when it ages past the stream).
   * null = the router reported no live stream (the idle report CLEARS any
   * stored phase, the gate block precedent). Absent on rows persisted
   * before #67 and on old routers. Sanitizer posture: drop-don't-reject.
   */
  phase?: { state: 'thinking' | 'output' | 'tools'; at: number } | null;
}

/**
 * #67: operator engine pin for a session — the sibling of the pause/force
 * override plane, NOT a new kind inside it (pause/force carry a temporary
 * 'until'; a pin is a standing routing choice). Keyed by the session's
 * derived token, arbiter-stored, published on the session row as the
 * `engine_pin` ADD-key, and learned by the router on the /api/state poll
 * (D4 posture: same channel, same one-tick latency as pause/force).
 * The pin moves where the session's traffic RESOLVES at forward time —
 * queued and next-request traffic only; running streams never move.
 */
export interface SessionPin {
  token: string;
  server_id: string;
  set_at: number;
}

/**
 * Operator override for a session — the same shape as ClientOverride
 * (#32: the override vocabulary generalizes). 'pause' tells the router to
 * hold that session's traffic (the router enforces; the arbiter stores +
 * exposes). 'until' auto-expires like the client override.
 */
export interface SessionOverride {
  token: string;
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
  /**
   * The inference-server (engine) this lease runs on — the per-engine
   * admission dimension (#38/#35): idle verdicts, the post-revocation
   * reidle gate, the concurrency cap, and preemption are all evaluated
   * against THIS server's signal, not a global one. Absent on leases
   * persisted before the per-engine core: they belong to the watched
   * server (the only one that existed then).
   */
  server_id?: string;
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
  /**
   * Per-request token block from the llama-swap activity feed (#52 slice 1,
   * ADD keys — the wire carried them all along; the type dropped them).
   * Absent on entries that carry no block (strata-adapted entries, older
   * engine builds). Never a fake zero: absent stays absent.
   */
  tokens?: {
    cache_tokens?: number;
    draft_tokens?: number;
    draft_acc_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    prompt_per_second?: number;
    tokens_per_second?: number;
  };
  /** Per-request engine duration in ms (ADD key, absent when the feed omits it). */
  duration_ms?: number;
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

/**
 * The LAST reported outcome for a (project, job_id) pair (issue #4). Written
 * by `finishLease` from the client's usage report — the arbiter previously
 * counted usage into the budget but kept no per-job verdict, so the
 * dashboard and remote MCP clients could not see what actually happened to
 * the work. Latest-only per job (a newer report REPLACES the row); capped at
 * the newest 200 rows per project so state.json stays bounded.
 */
export interface JobResultRow {
  project: string;
  job_id: string;
  ok: boolean;
  /** Client-reported score from the result line (usage payload `score`); null when absent. */
  score: number | null;
  tokens_out: number;
  tokens_in: number;
  /** Failure cause on ok:false (e.g. `executor_exit_1`); null on success. */
  error: string | null;
  /** Server receive time (ISO) — the arbiter's clock, not the client's. */
  ts: string;
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
  /**
   * True when the server row declares an activity feed (non-empty
   * `activity_path`). False = feed-off provider (#60 A1): the log-mtime
   * signal alone carries the verdict and the row is never degraded by a
   * feed failure. ADD key — the /api/state shape contract (add, never
   * rename).
   */
  feed_enabled: boolean;
  /**
   * Honest fail-closed reason when NO signal can resolve (#62): a feed-less
   * row whose log glob matches nothing. The kind gap is named instead of a
   * fetch that never happened. null when a signal resolves. ADD key.
   */
  no_signal_reason?: string | null;

  // --------------------------------------------------------------------
  // Load axis (#52 slice 1 — DATA ONLY).
  //
  // The collector (server/src/load.ts) reads the engine's own load
  // surface inside the existing poll tick. This wave CAPTURES only:
  // every key below is display-and-sample, and NOTHING in this block is
  // read by the verdict. The `idle`, `idle_for_s`, and degraded fields
  // above are computed exactly as before, with no input from here (D4:
  // the llama-swap busy threshold is OFF until the owner sets a number).
  // Absent = no reading since boot (or no collector for the kind); a
  // stale reading is never faked and never zero-filled.
  // ------------------------------------------------------------------

  /** Which load surface produced the reading (design doc D5): `llamaswap-metrics` | `omlx-health` | `strata-metrics`. Absent = no load collector wired for the kind. ADD key. */
  load_source?: string;
  /** Seconds since the last successful load read (the `metrics_load_stale_s` window labels it, it does not veto anything yet). Absent = no reading since boot. ADD key. */
  load_age_s?: number;
  /** llama-swap `/metrics` GPU utilization gauge (0-100). Absent = no reading. ADD key. */
  gpu_util_percent?: number;
  /** llama-swap `/metrics` GPU memory used (bytes). ADD key. */
  gpu_mem_used_bytes?: number;
  /** llama-swap `/metrics` GPU memory total (bytes). ADD key. */
  gpu_mem_total_bytes?: number;
  /** The newest feed entry's engine-reported rate (llama-swap feed `tokens` block, #52 slice 1). Display and sample only, never a veto input. Absent = no reading. ADD key. */
  tokens_per_second?: number;
  /** In-flight generation count. No engine exposes one today (llama-swap: none; strata: one slot, wired in the D4 wave; oMLX: none) — absent when the kind's engine exposes nothing. ADD key. */
  in_flight?: number;
  /**
   * oMLX `/health` identity: the default model name — ABSENT when the
   * payload names none (design doc D8: the payload names the default,
   * not the loaded; `loaded_count` 0 means nothing is resident).
   * ADD key.
   */
  model_loaded?: string;
  /** Best-effort quant identity parsed from `model_loaded` (D5: absent when not parseable). ADD key. */
  model_quant?: string;
  /** oMLX `/health` pool residency: models loaded in memory (counts models, NOT requests). Display and sample only. Absent = no reading. ADD key. */
  omlx_loaded_count?: number;
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
  | 'server_connection_removed'
  | 'server_connection_updated'
  /**
   * Model aliases (#66 D4): an operator alias write (upsert / re-pin) and
   * an alias removal. Detail carries the alias name.
   */
  | 'model_alias_updated'
  | 'model_alias_removed'
  | 'model_alias_reordered'
  /**
   * Engine groups (docs/architecture/engine-health-routing.md D3/D5): an
   * operator group write (upsert) and a group removal. Detail carries the
   * `group_id`. A group carries no secret, so nothing is redacted.
   */
  | 'engine_group_updated'
  | 'engine_group_removed'
  /**
   * Agent keys (#68): an operator mint (detail carries the label, NEVER
   * the plaintext) and a revoke (detail carries id + label).
   */
  | 'client_key_minted'
  | 'client_key_revoked'
  | 'session_registered'
  | 'session_paused'
  | 'session_forced'
  | 'session_override_cleared'
  | 'session_pinned'
  | 'session_pin_cleared'
  | 'session_swept'
  | 'job_throttled'
  | 'job_unthrottled'
  /**
   * Theme colors (#68): an operator theme write (POST /api/theme). Detail
   * carries the number of tokens the write applied. The values themselves
   * are never logged (they ride the state file + the /api/state ADD key).
   */
  | 'theme_updated'
  /**
   * Scheduled queue rebuild (issue #3): the client's rebuild loop ran since
   * the last heartbeat and reported fresh run state. The arbiter derives the
   * event from the registration payload (no new API surface) so the operator
   * sees the queue refilling — `queue 445 → 512 (exit 0)` — without opening
   * the client log.
   */
  | 'rebuild';

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

/**
 * Model aliases (#66 D1): one operator-declared name mapped to concrete
 * engine-model pairs. An alias is a CROSS-ROW entity — it lives at the top
 * of the state file, beside `servers`, never inside a row.
 */

/** One engine-model pair: the row plus that engine's OWN model id. */
export interface ModelAliasPair {
  server_id: string;
  model: string;
}

/** One operator-declared alias. Key of the map is the alias name. */
export interface ModelAlias {
  alias: string; // the name the catalog publishes
  pairs: ModelAliasPair[]; // insertion order = default pin order
  pinned_server_id?: string; // the winner the drag writes; absent = first pair
  updated_at: number;
}

/**
 * One operator-declared engine group (same-host mutual exclusion)
 * (docs/architecture/engine-health-routing.md D3). A CROSS-ROW entity like
 * an alias: it lives at the top of the state file, beside `servers`, and a
 * row belongs to AT MOST one group (enforced at write time). The group
 * carries NO secret — `server_id` slugs + a number only — so the write-only
 * token posture is untouched by construction.
 */
export interface EngineGroup {
  /** Stable slug (the sanitizer class of alias names); the write handle. */
  group_id: string;
  /** Display label. Absent = the group renders by its `group_id`. */
  name?: string;
  /** Member rows. A row belongs to at most one group (write-time 400). */
  server_ids: string[];
  /**
   * Group-wide admission cap for the lease plane. Default 1 = hard mutual
   * exclusion (at most one background job across the whole group/host).
   * Configurable per group (owner decision 2026-10-08); absent = 1.
   */
  max_concurrent: number;
  /** Epoch-ms of the last write (the audit/echo, like `ModelAlias`). */
  updated_at: number;
}

/**
 * An idlefill-issued AGENT key (#68): the credential an agent (a Hermes
 * profile, any OpenAI-compatible client) presents to the aggregate
 * endpoint (:8800) so it authenticates to IDLEFILL — never to the engine.
 * The plaintext is handed to the operator ONCE at mint (the mint response)
 * and is NEVER stored: this row carries only the SHA-256 hex digest, the
 * same write-only posture as a server row's auth_token (#60 B). The
 * router pulls digests (never plaintexts) over the loopback-scoped key
 * route and answers a caller by digesting what IT presented.
 */
export interface ClientKeyRow {
  id: string; // `key-<hex8>` — the revoke handle
  label: string; // operator naming ("accounting-agent")
  hash: string; // sha256(plaintext) hex — never served to any read surface
  created_at: number;
}

/**
 * The dashboard CSS tokens the theme plane may set (#68) — the nine :root
 * custom properties the dashboard renders with. The sanitizer accepts ONLY
 * these keys (an unknown key drops); the value must pass the hex grammar
 * below. Order matches dashboard/src/index.css :root (the source of truth the
 * dashboard reads its DEFAULT_THEME from).
 */
export const THEME_TOKEN_KEYS = ['bg', 'panel', 'border', 'text', 'dim', 'ok', 'warn', 'err', 'accent'] as const;
export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];

/** Hex grammar the theme sanitizer enforces (#68): #rgb or #rrggbb, nothing else. */
export const THEME_HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The :root defaults the theme seeds with (#68) — an exact mirror of
 * dashboard/src/index.css :root (read from the file, not guessed). A key the
 * operator has not set keeps its default; the dashboard falls back to the
 * same :root values in the browser, so the two surfaces agree.
 */
export const THEME_DEFAULTS: Record<string, string> = {
  bg: '#0d1117',
  panel: '#161b22',
  border: '#30363d',
  text: '#c9d1d9',
  dim: '#8b949e',
  ok: '#3fb950',
  warn: '#d29922',
  err: '#f85149',
  accent: '#58a6ff',
};

/**
 * The operator-tuned dashboard color scheme (#68). A pure color map over the
 * dashboard's nine CSS tokens (`--bg`, `--panel`, `--border`, `--text`,
 * `--dim`, `--ok`, `--warn`, `--err`, `--accent`). Every value is a CSS hex
 * color — the sanitizer enforces the hex grammar and drops every key that is
 * not one of the nine. A pure color carries NO token or secret, so the map is
 * anonymous-readable on /api/state (cosmetic, the ADD key is absent when
 * unset). Written by setTheme (sanitize, then persist — same save shape as
 * the project-settings plane); never a token.
 */
export interface ThemeColors {
  colors: Record<string, string>;
  updated_at: string;
}

export interface ArbiterState {
  /** Declared inference-server connections (seeded from config on first load). */
  servers: ServerConnection[];
  /**
   * The operator-tuned dashboard color scheme (#68). ADD-key sibling of
   * `servers`: a state file from before #68 carries none. `null` = unset
   * (the /api/state view omits the key entirely — the dashboard falls back
   * to its :root defaults). Cosmetic values only: a pure hex color per
   * token, never a secret.
   */
  theme?: ThemeColors | null;
  /**
   * Operator-declared model aliases (#66 D1), keyed by alias name. ADD-key
   * sibling of `servers`. An alias carries NO secret — `server_id` + engine
   * model name only — so the write-only token posture is untouched by
   * construction.
   */
  model_aliases: Record<string, ModelAlias>;
  /**
   * Operator-declared engine groups (same-host mutual exclusion,
   * docs/architecture/engine-health-routing.md D3), keyed by `group_id`.
   * ADD-key sibling of `model_aliases` — a state file from before the plane
   * carries none (the state loader tolerates the missing key, the
   * `session_pins` pattern). A row belongs to at most one group (write-time
   * 400). A group carries NO secret by construction.
   */
  engine_groups: Record<string, EngineGroup>;
  /**
   * Idlefill-issued AGENT keys (#68), keyed by nothing — an array like
   * `servers`, id is the handle. ADD-key: state files from before #68
   * carry none. The rows hold ONLY the sha256 digest of the minted
   * plaintext (write-only posture, #60 B): the plaintext is shown once at
   * mint and no read surface ever carries it — not /api/state, not the
   * list route, not the router's loopback pull (which hands digests, not
   * plaintexts).
   */
  client_keys: ClientKeyRow[];
  /**
   * Stable mesh instance identity (#50 D2): random hex, minted at first
   * boot and persisted. Tailnet IPs move; this id is the identity. The
   * ONLY mesh data in the state file — peer snapshots stay ephemeral.
   */
  instance_id?: string;
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
   * Last reported outcome per (project, job_id) (issue #4), keyed like
   * `throttled_jobs` (`project::job_id`). Written on every usage report in
   * finishLease; latest-only per job, newest 200 rows per project kept.
   * Served by GET /api/projects/:name/results — deliberately NOT embedded
   * in /api/state (that endpoint stays lean).
   */
  results: Record<string, JobResultRow>;
  /**
   * Operator overrides (pause/force), keyed by client_id. A client that
   * unregisters is re-registered under the SAME name with a NEW client_id,
   * so an override never "sticks" to a different client — and the orphaned
   * entry is trimmed on the next tick (client not found).
   */
  overrides: Record<string, ClientOverride>;
  /**
   * Router-self-registered interactive sessions (#33). Sessions are
   * interactive traffic (#32): their last_activity folds into the server
   * idle verdict and preempts background leases.
   */
  sessions: SessionRecord[];
  /** Operator overrides for sessions, keyed by token (same shape as client overrides). */
  session_overrides: Record<string, SessionOverride>;
  /**
   * #67 operator engine pins for sessions, keyed by token — the SIBLING of
   * `session_overrides` (a pin is a standing routing choice, not a timed
   * override). Arbiter-stored; published resolved on the session row as
   * the `engine_pin` ADD-key; the router learns it on the /api/state poll.
   * ADD-key: state files from before #67 carry none.
   */
  session_pins: Record<string, SessionPin>;
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
