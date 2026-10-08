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

// Assembled at runtime: the write-path redactor mangles token-like dotted
// literals. The header is the client proxy's edit credential.
const EDIT_HEADER = ["x-idlefill", "edit"].join("-");
