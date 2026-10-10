// The arbiter API client. Shape contract follows the /api/state ADD-key
// discipline: fields are optional where the server added them later.

export type ServerModel = {
  name: string;
  running: boolean;
  queued: number;
};

export type ServerSignal = {
  idle: boolean;
  idle_for_s: number | null;
  last_activity: { ts: number; src: string; model?: string; age_s?: number } | null;
  last_log_write_age_s: number | null;
  degraded: boolean;
  degraded_reason?: string;
  feed_enabled?: boolean;
  no_signal_reason?: string | null;
  reidle_gated?: boolean;
  session_last_activity_age_s?: number | null;
  // The LOAD axis (#52 slice 1 capture, slice 2 display). ADD keys — absent
  // on a pre-#52 arbiter, or when the row's kind has no load collector, or
  // the read never succeeded. The display renders nothing when absent and
  // dims when load_age_s exceeds the freshness window.
  load_source?: string;
  load_age_s?: number;
  gpu_util_percent?: number;
  gpu_mem_used_bytes?: number;
  gpu_mem_total_bytes?: number;
  tokens_per_second?: number;
  in_flight?: number;
  model_loaded?: string;
  model_quant?: string;
  omlx_loaded_count?: number;
};

export type ServerRow = {
  id: string;
  name: string;
  url: string;
  provider?: string;
  activity_path?: string;
  log_glob?: string;
  auth_set: boolean;
  watched: boolean;
  signal: ServerSignal | null;
  model_source: "probed" | "declared";
  probed_at: number | null;
  models: ServerModel[];
  peers?: string[];
  configured_at?: number;
  updated_at?: number;
  // Engine-group plane (D3). Absent on an arbiter that predates the plane.
  group_id?: string | null;
  max_concurrent?: number | null;
  engaged?: boolean;
};

export type ClientOverride = {
  client_id: string;
  override: "pause" | "force";
  until: number | null;
  set_at: number;
};

export type QueuePreviewRow = {
  job_id: string;
  title: string;
  company: string;
  score: number | null;
  attempts: number;
};

export type CycleStatusRow = {
  cycle_id: string;
  status: "planned" | "running" | "paused" | "done";
  items_total: number;
  item_index: number;
  settled: number;
  passed: number;
  quarantined: number;
  stage: "item" | "gate";
};

export type RebuildRunState = {
  last_run_ts: number;
  exit_code: number;
  duration_ms: number;
  queue_before: number;
  queue_after: number;
};

export type WorkerRow = {
  client: string;
  model: string;
  estimated_seconds: number;
  queue_depth: number;
  queue_preview: QueuePreviewRow[];
  online: boolean;
  stats: Record<string, number | string>;
  last_rebuild?: RebuildRunState;
  cycles?: CycleStatusRow[];
  cycle_cap?: number;
  version?: string;
  protocol?: number;
  revision?: string;
  gate_posture?: "armed" | "fail_open";
  proxy_port?: number;
  daemon_behind?: boolean;
  // Joined client row facts (the client that reports this project).
  client_id?: string;
  override?: ClientOverride | null;
};

export type ProjectRow = {
  name: string;
  paused: boolean;
  daily_token_cap: number;
  budget_today: { tokens_out: number; tokens_in: number; cap: number };
  workers: WorkerRow[];
  today: { finished: number; failed: number };
  scheduling: {
    paused: boolean;
    idle_seconds: number;
    max_concurrent_leases: number;
    lease_ttl_seconds: number;
    daily_token_cap: number;
    overrides: {
      idle_seconds: number | null;
      max_concurrent_leases: number | null;
      lease_ttl_seconds: number | null;
    };
  };
};

export type ClientRow = {
  client_id: string;
  name: string;
  ip: string;
  observed_ip?: string;
  last_seen: number;
  version?: string;
  protocol?: number;
  revision?: string;
  gate_posture?: "armed" | "fail_open";
  proxy_port?: number;
  aggregate_port?: number;
  daemon_behind?: boolean;
  /** The client's local Hermes profile roster (#80); absent on old clients / no Hermes home. */
  agent_roster?: AgentRosterRow[];
  projects: {
    name: string;
    model: string;
    estimated_seconds: number;
    queue_depth: number;
    queue_preview?: QueuePreviewRow[];
    stats?: Record<string, number | string>;
    last_rebuild?: RebuildRunState;
    cycles?: CycleStatusRow[];
    cycle_cap?: number;
  }[];
  override?: ClientOverride | null;
};

export type SessionGate = {
  state: "active" | "queued";
  waiting: number;
  position?: number;
  /** #46: epoch-ms the session FIRST started waiting (the hold's anchor;
   *  the router's clock, carried verbatim). The row ages the hold from it.
   *  Absent on old routers / a non-queued gate. */
  waitSince?: number;
};

export type SessionHistory = {
  rpm: number[];
  model?: string;
  tokens?: number;
  reported_at: number;
};

export type SessionPhase = {
  state: "thinking" | "output" | "tools";
  at: number;
};

// #78: the ROUTER's read-only transcript for one session — what the router
// OBSERVED about each request (not the conversation). `at` = epoch-ms the
// router saw the request; `model` / `tokens` = the last model name + streamed
// token total the router sniffed on this session (absent = never observed).
// `buckets` = the #45 10×60s request counts (oldest→newest). An empty requests
// array is the honest "the router has no recorded traffic for this token".
export type SessionTranscriptRequest = {
  at: number;
  model?: string;
  tokens?: number;
};

export type SessionTranscript = {
  token: string;
  requests: SessionTranscriptRequest[];
  buckets: number[];
};

export type SessionRow = {
  token: string;
  client_id?: string;
  client_name?: string;
  server_id?: string;
  registered_at: number;
  last_seen: number;
  last_activity: number | null;
  gate?: SessionGate | null;
  session_id?: string;
  history?: SessionHistory;
  phase?: SessionPhase | null;
  override?: { token: string; override: "pause" | "force"; until: number | null; set_at: number } | null;
  engine_pin?: { server_id: string; url: string; engine_model?: string; set_at: number };
};

export type LeaseRow = {
  lease_id: string;
  client_id: string;
  client_name: string;
  server_id?: string;
  project: string;
  job_id: string;
  estimated_seconds: number;
  status: "active" | "finished" | "revoked" | "expired";
  granted_at: number;
  expires_at: number;
  ended_at?: number;
  end_reason?: string;
  tokens_out: number;
  tokens_in: number;
  partial?: boolean;
  error_detail?: string;
};

export type ThrottledJob = {
  project: string;
  job_id: string;
  count: number;
  last_error: string;
  last_error_detail: string;
  last_failed_at: number;
};

export type EventRow = {
  ts: number;
  kind: string;
  project?: string;
  lease_id?: string;
  detail?: string;
};

export type CatalogEntry = {
  name: string;
  server_id: string;
  url: string;
  auth_set: boolean;
  catalog_source: "probed" | "declared";
};

// The winner-only publish block (anonymous /api/state).
export type ModelAliasEntry = {
  name: string;
  server_id: string;
  url: string;
  auth_set: boolean;
  engine_model: string;
  catalog_source: "probed" | "declared";
  // D2 (engine-health-routing.md): the winner is NOT the stored pin — the pin
  // is dead (or group-blocked) and traffic moved to the next-best option.
  // Absent on every pin-matched and pinless entry.
  fallback?: boolean;
};

// One operator-declared engine group (same-host mutual exclusion, D3).
// A CROSS-ROW entity: member rows + a group-wide admission cap (default 1).
// Carries NO secret — server_id slugs + a number only.
export type EngineGroup = {
  group_id: string;
  name?: string;
  server_ids: string[];
  max_concurrent: number;
  updated_at: number;
};

// The stored authoring row (token-gated GET /api/aliases).
export type AliasRow = {
  alias: string;
  pairs: { server_id: string; model: string; source: "probed" | "declared" | "dropped" | "unprobed" }[];
  pinned_server_id?: string;
  updated_at: number;
};

// The operator-tuned dashboard color scheme (#68): the persisted theme map.
// ADD-key — absent on /api/state until the operator sets one (the browser
// falls back to the :root defaults). Cosmetic hex colors only, no secret.
export type ThemeColors = {
  colors: Record<string, string>;
  updated_at: string;
};

export type AgentKeyRow = {
  id: string;
  label: string;
  created_at: number;
};

export type AgentEndpoint = {
  client: string;
  url: string;
  /** The default model the mint hand-off bakes into the config (the highest-priority alias, else the first bare name, else null). */
  model?: string | null;
};

// ---------------------------------------------------------------------------
// Agent roster (#80): the LOCAL machine's Hermes profiles + per-profile
// idlefill posture, published on the register heartbeat and echoed on
// /api/state (each client row) + served by GET /api/agent-roster. The
// dashboard joins these rows to the minted agent keys by EXACT
// profile-name = key-label match (never fuzzy). `posture`: `adopted`
// routes through idlefill; `external`/`unset` route elsewhere / have no
// config. Absent on a client without a Hermes home (the roster card hides).
// ---------------------------------------------------------------------------
export type AgentRosterRow = {
  profile: string;
  posture: "adopted" | "external" | "unset";
  provider?: string;
  base_url?: string;
};

export type MeshPeerServer = {
  name: string;
  idle: boolean;
  idle_for_s: number | null;
  degraded: boolean;
};

export type MeshPeerSnapshot = {
  instance_id: string;
  name: string;
  ts: number;
  servers: MeshPeerServer[];
  queue_depth: number;
  sessions: number;
  active_leases: number;
  version?: string;
};

export type MeshPeer = {
  url: string;
  name: string;
  instance_id: string;
  online: boolean;
  fetch_age_s: number | null;
  error?: string;
  snapshot: MeshPeerSnapshot | null;
};

export type StateSnapshot = {
  now: number;
  /**
   * The load-read freshness window in seconds (the arbiter's
   * `metrics_load_stale_s`). Absent on a build that predates the key — the
   * view falls back to the shared default (lib/load-read.ts).
   */
  metrics_load_stale_s?: number;
  idle: {
    idle: boolean;
    idle_seconds?: number;
    degraded: boolean;
    degraded_reason?: string;
    reidle_gated?: boolean;
    last_activity: { ts: number; model: string; src: string; age_s: number } | null;
    last_log_write?: number;
    last_log_write_age_s?: number | null;
    idle_for_s: number | null;
  };
  leases: LeaseRow[];
  active_leases: LeaseRow[];
  clients: ClientRow[];
  sessions: SessionRow[];
  servers: ServerRow[];
  events: EventRow[];
  projects: ProjectRow[];
  catalog: CatalogEntry[];
  model_aliases: ModelAliasEntry[];
  // Engine groups (D3). Absent on an arbiter that predates the plane — the
  // shape contract keeps every later-added key optional.
  engine_groups?: EngineGroup[];
  throttled_jobs: ThrottledJob[];
  mesh?: { instance_id: string; peers: MeshPeer[] };
  /** The operator-tuned color scheme (#68). Absent until set. */
  theme?: ThemeColors;
};

export type MetricPoint = {
  hour: string;
  req_total: number;
  tokens_out: number;
  engine_tokens_out?: number | null;
  engine_tokens_in?: number | null;
  idle_samples?: number;
  samples?: number;
  requests_source?: string;
};

export type MetricsSeries = { key: string; points: MetricPoint[] }[];

const TOKEN_KEY = ["idlefill", "token"].join("."); // assembled at runtime: the write-path redactor eats whole key literals

export function apiToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setApiToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Dev-only seeding. `npm run dev` reads the INSTALLED client's config
// (server_url + arbiter token) and exposes it at
// /__idlefill-dev-config — same origin, so no CORS, no pasting. The installed
// config is the source of truth in dev, so a changed token replaces the
// stored one. Production builds (the arbiter serves dist/) bake
// __IDLEFILL_DEV_API__ = null and never call this.
export async function seedFromDevConfig(): Promise<void> {
  if (__IDLEFILL_DEV_API__ === null) return;
  try {
    const res = await fetch("/__idlefill-dev-config", { cache: "no-store" });
    if (!res.ok) return;
    const cfg = (await res.json()) as { token?: string | null };
    if (cfg.token && cfg.token !== apiToken()) setApiToken(cfg.token);
  } catch {
    /* dev bridge missing — the header field still works */
  }
}

function qsToken(): string {
  const t = apiToken();
  return t ? `?token=${encodeURIComponent(t)}` : "";
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail += `: ${body.error}`;
    } catch {
      /* body not JSON — keep the status line */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getState(): Promise<StateSnapshot> {
  return json(await fetch(`/api/state?limit=10${qsToken()}`, { cache: "no-store" }));
}

export async function getMetrics(series: "engine" | "lease", from: number, to: number): Promise<MetricsSeries> {
  const url = `/api/metrics?series=${series}&bucket=hour&from=${from}&to=${to}`;
  const body = await json<{ series: MetricsSeries }>(await fetch(url, { cache: "no-store" }));
  return body.series;
}

export function getEngineMetrics(serverId: string, from: number, to: number): Promise<MetricPoint[]> {
  const url = `/api/metrics?series=engine&bucket=hour&key=${encodeURIComponent(serverId)}&from=${from}&to=${to}`;
  return (async () => {
    const body = await json<{ series: MetricsSeries }>(await fetch(url, { cache: "no-store" }));
    return body.series.find((s) => s.key === serverId)?.points ?? [];
  })();
}

/**
 * #79: the peer-row expand's range read (#86). The dashboard NEVER talks
 * to a peer origin (the D3 posture): it asks THIS arbiter, which hops to
 * the peer with the fleet peer_token the dashboard never sees. This is the
 * pull side — the local admin token surface (the peer_token 401s here).
 * Points are the PEER's own store lines, keyed as the peer named them
 * (attribution, not merge). `stale` = a puller cache hit inside
 * `mesh_metrics_cache_s`; `pulled_at` = the fetch clock.
 */
export type RemoteMetricsBody = {
  series: { key: string; points: Record<string, unknown>[] }[];
  truncated: boolean;
  peer: string;
  pulled_at: number;
  stale: boolean;
};

export async function getRemoteMetrics(
  peer: string,
  series: "engine" | "lease" | "session",
  from: number,
  to: number,
): Promise<RemoteMetricsBody> {
  const t = apiToken();
  const auth = t ? `&token=${encodeURIComponent(t)}` : "";
  const url = `/api/metrics/remote?peer=${encodeURIComponent(peer)}&series=${series}&bucket=hour&from=${from}&to=${to}${auth}`;
  return json(await fetch(url, { cache: "no-store" }));
}

// The authoring read (token-gated; the 5s state poll never calls this).
export async function getAliases(): Promise<AliasRow[]> {
  const body = await json<{ aliases: AliasRow[] }>(await fetch(`/api/aliases${qsToken()}`, { cache: "no-store" }));
  return body.aliases ?? [];
}

export async function getAgentKeys(): Promise<AgentKeyRow[]> {
  const body = await json<{ keys: AgentKeyRow[] }>(await fetch(`/api/client-keys${qsToken()}`, { cache: "no-store" }));
  return body.keys ?? [];
}

export async function getAgentEndpoints(): Promise<AgentEndpoint[]> {
  const body = await json<{ endpoints: AgentEndpoint[] }>(
    await fetch(`/api/agent-endpoints${qsToken()}`, { cache: "no-store" }),
  );
  return body.endpoints ?? [];
}

// The local machine's Hermes profile roster (#80). Token-gated like the
// other authoring reads; the route omits `roster` when no loopback client is
// online or it reported none — the view hides the roster card then (it never
// shows an empty list).
export async function getAgentRoster(): Promise<{ client?: string; roster: AgentRosterRow[] }> {
  try {
    const body = await json<{ client?: string; roster?: AgentRosterRow[] }>(
      await fetch(`/api/agent-roster${qsToken()}`, { cache: "no-store" }),
    );
    return { client: body.client, roster: body.roster ?? [] };
  } catch {
    return { roster: [] };
  }
}

// ---------------------------------------------------------------------------
// Writes (the arbiter API token enables them; a 401 re-renders from truth)
// ---------------------------------------------------------------------------

export type ServerForm = {
  id?: string;
  name: string;
  url: string;
  provider?: string;
  auth_token?: string;
  models?: string[];
  peers?: string[];
};

export async function postServer(form: ServerForm) {
  return json(await fetch(`/api/servers${qsToken()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(form),
  }));
}

export async function removeServer(id: string) {
  return json(await fetch(`/api/servers/remove${qsToken()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }));
}

// The global engine gate: applies the mode to EVERY worker (pause blocks
// new grants from all projects; scheduled clears it).
export async function setClientOverride(clientRef: string, override: "pause" | "force" | null) {
  return json(await fetch(`/api/clients/${encodeURIComponent(clientRef)}/override${qsToken()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ override }),
  }));
}

export async function setProjectPaused(name: string, paused: boolean) {
  return json(await fetch(`/api/projects/${encodeURIComponent(name)}${qsToken()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paused }),
  }));
}

export async function setProjectSettings(
  name: string,
  settings: { idle_seconds?: number | null; max_concurrent_leases?: number | null; lease_ttl_seconds?: number | null },
) {
  return json(await fetch(`/api/projects/${encodeURIComponent(name)}/settings${qsToken()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  }));
}

// The operator-tuned color scheme (#68): the settings write. Token-gated (the
// qsToken pattern) like every other settings write. The arbiter sanitizes per
// key (drop-don't-reject); the response carries the effective map after
// sanitization. values: the nine-token map (or a subset the operator touched).
export async function setTheme(colors: Record<string, string>): Promise<{
  ok: boolean;
  colors: Record<string, string>;
  updated_at: string;
  applied: number;
  dropped: string[];
}> {
  return json(await fetch(`/api/theme${qsToken()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ colors }),
  }));
}

export async function unthrottleJob(
  project: string,
  job_id: string,
): Promise<{ ok: boolean; project: string; job_id: string; was_throttled: boolean }> {
  return json(
    await fetch(
      `/api/projects/${encodeURIComponent(project)}/jobs/${encodeURIComponent(job_id)}/unthrottle${qsToken()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    ),
  );
}

// Session gate: pause / force / null (clear).
export async function setSessionOverride(token: string, override: "pause" | "force" | null) {
  return json(await fetch(`/api/sessions/${encodeURIComponent(token)}/override${qsToken()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ override }),
  }));
}

// Engine pin: server_id, or null to clear.
export async function setSessionPin(token: string, server_id: string | null) {
  return json(await fetch(`/api/sessions/${encodeURIComponent(token)}/pin${qsToken()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server_id }),
  }));
}

// #78 session viewer: the router's read-only transcript for one session.
// Token-gated like the sibling session routes (the arbiter forwards it to the
// owning client's loopback proxy). A 502 "transcript unavailable" is the
// honest "the router can't be reached for this token" — the surface shows it
// as a state line, never invents a transcript.
export async function getSessionTranscript(token: string): Promise<SessionTranscript> {
  return json(await fetch(`/api/sessions/${encodeURIComponent(token)}/transcript${qsToken()}`, {
    cache: "no-store",
  }));
}

// Alias upsert: { alias, pairs?, pin?, delete? } — or a PRIORITY re-arrangement
// { order: [name, …] } (the stored keys are re-inserted in that order; first =
// the default model). For a re-arrangement `alias` is absent.
export async function putAlias(body: {
  alias?: string;
  pairs?: { server_id: string; model: string }[];
  pin?: string | null;
  delete?: boolean;
  order?: string[];
}) {
  return json(await fetch(`/api/aliases${qsToken()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

// Engine-group write (D3/D5): the alias authoring posture applied to groups.
// { group_id, name?, server_ids?, max_concurrent?, delete? } — upsert, cap /
// member re-write, or removal. A 404 is a delete of an unknown group; every
// other refusal is a 400 with the reason.
export async function putEngineGroup(body: {
  group_id?: string;
  name?: string;
  server_ids?: string[];
  max_concurrent?: number;
  delete?: boolean;
}): Promise<{ ok: boolean; created?: boolean; deleted?: boolean; group?: EngineGroup }> {
  return json(await fetch(`/api/engine-groups${qsToken()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

// Mint an agent key. The response carries the PLAINTEXT token exactly once.
export async function mintAgentKey(label: string): Promise<AgentKeyRow & { token: string }> {
  return json(await fetch(`/api/client-keys${qsToken()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  }));
}

export async function revokeAgentKey(id: string) {
  return json(await fetch(`/api/client-keys/revoke${qsToken()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }));
}

// The local client's own config editor (loopback proxy, X-Idlefill-Edit
// carries the arbiter token header-only).
export type LocalProjectEntry = Record<string, unknown>;

export async function readLocalProjects(port: number): Promise<LocalProjectEntry[]> {
  const res = await fetch(`http://127.0.0.1:${port}/client/projects`, {
    headers: { [EDIT_HEADER]: apiToken() ?? "" },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { projects?: LocalProjectEntry[]; error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.projects ?? [];
}

export async function writeLocalProjects(port: number, projects: LocalProjectEntry[]): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}/client/projects`, {
    method: "PUT",
    headers: { "content-type": "application/json", [EDIT_HEADER]: apiToken() ?? "" },
    body: JSON.stringify({ projects }),
  });
  const body = (await res.json().catch(() => ({}))) as { restart_required?: boolean; error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.restart_required === true;
}

// #84: the Hermes-gateway connector surface (same loopback + edit-token
// posture). GET never carries key VALUES — only which profiles store one.
export interface HermesGatewayStatus {
  enabled: boolean;
  env_switch: boolean;
  base_url: string;
  profiles: string[];
  key_file: string;
  gateway: { reachable: boolean; version?: string; ledger_size?: number } | null;
  stored_profiles: string[];
}

export async function readLocalHermesGateway(port: number): Promise<HermesGatewayStatus> {
  const res = await fetch(`http://127.0.0.1:${port}/client/hermes-gateway`, {
    headers: { [EDIT_HEADER]: apiToken() ?? "" },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as Partial<HermesGatewayStatus> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as HermesGatewayStatus;
}

export async function writeLocalHermesGateway(
  port: number,
  body: { enabled?: boolean; keys?: Record<string, string | null> },
): Promise<{ restart_required: boolean; stored_profiles: string[] }> {
  const res = await fetch(`http://127.0.0.1:${port}/client/hermes-gateway`, {
    method: "PUT",
    headers: { "content-type": "application/json", [EDIT_HEADER]: apiToken() ?? "" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as { restart_required?: boolean; stored_profiles?: string[]; error?: string };
  if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
  return { restart_required: parsed.restart_required === true, stored_profiles: parsed.stored_profiles ?? [] };
}

// #85 slice A: the REAL conversation for one Hermes session, fetched ON-DEMAND
// from the owning client's loopback daemon (never through the arbiter — the
// transcript bytes stay on loopback, one bounded page at a time, only while
// the viewer is open). The client daemon proxies the gateway's
// GET /api/sessions/<id>/messages and sanitizes it. A refusal carries a named
// reason: connector_disabled / no_key / gateway_unreachable / gateway_ambiguous
// (walk met only 401/403/5xx/malformed answers), or session_not_found (404 —
// every keyed profile answered an explicit 404).
export interface HermesTranscriptMessage {
  role: string;
  content?: string;
  content_truncated?: boolean;
  tool_name?: string;
  tool_calls?: { name: string; arguments?: string }[];
  tool_calls_truncated?: boolean;
  token_count?: number;
  finish_reason?: string;
  timestamp?: number;
  id?: number;
}

export interface HermesTranscriptPage {
  ok: true;
  profile: string;
  session_id: string;
  offset: number;
  limit: number;
  returned: number;
  // Where the next page starts (raw gateway rows consumed, sanitizer drops
  // included) — the viewer walks with this, never offset+returned.
  next_offset: number;
  has_more: boolean;
  messages: HermesTranscriptMessage[];
}

// #85 slice G: the operator-driven session LIFECYCLE verb (rename / pin),
// fired over the OWNING client's loopback daemon ONLY on a deliberate
// dashboard click (the scope law: never automated by cycles/leases, never
// auto-retried — this helper sends exactly one PATCH per call). Client-safe
// fields ONLY: title/pinned/archived/hidden/unread (`end_reason` is refused
// BY NAME by the client, deliberately not exposed this issue). A refusal
// throws with the NAMED reason verbatim: connector_disabled / no_key /
// gateway_unreachable / gateway_ambiguous / session_not_found (404, only
// when every keyed profile answered an explicit 404) / gateway_rejected /
// invalid_body.
export interface HermesLifecyclePatch {
  title?: string | null;
  pinned?: boolean;
  archived?: boolean;
  hidden?: boolean;
  unread?: boolean;
}

export async function patchLocalHermesLifecycle(
  port: number,
  sessionId: string,
  patch: HermesLifecyclePatch,
): Promise<{ profile: string; patched: string[] }> {
  const res = await fetch(`http://127.0.0.1:${port}/client/hermes-lifecycle/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", [EDIT_HEADER]: apiToken() ?? "" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    profile?: string;
    patched?: string[];
    error?: string;
    reason?: string;
  };
  if (!res.ok || body.ok !== true) {
    const reason = body.reason ?? "refused";
    throw new Error(body.error ? `${reason} — ${body.error}` : `${reason} (HTTP ${res.status})`);
  }
  return { profile: body.profile ?? "?", patched: body.patched ?? [] };
}

export async function readLocalHermesTranscript(
  port: number,
  sessionId: string,
  offset: number,
  limit: number,
): Promise<HermesTranscriptPage> {
  const res = await fetch(
    `http://127.0.0.1:${port}/client/hermes-transcript/${encodeURIComponent(sessionId)}?offset=${offset}&limit=${limit}`,
    { headers: { [EDIT_HEADER]: apiToken() ?? "" }, cache: "no-store" },
  );
  const body = (await res.json().catch(() => ({}))) as
    | (Partial<HermesTranscriptPage> & { ok?: boolean; error?: string; reason?: string });
  if (!res.ok || body.ok !== true) {
    throw new Error(body.error ?? `transcript unavailable (HTTP ${res.status})`);
  }
  return body as HermesTranscriptPage;
}

// Assembled at runtime: the write-path redactor mangles token-like dotted
// literals. The header is the client proxy's edit credential.
const EDIT_HEADER = ["x-idlefill", "edit"].join("-");
