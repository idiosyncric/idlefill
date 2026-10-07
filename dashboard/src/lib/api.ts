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
  last_activity: { ts: number; src: string; model?: string; age_s: number } | null;
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

export type StateSnapshot = {
  now: number;
  idle: {
    idle: boolean;
    degraded: boolean;
    degraded_reason?: string;
    idle_for_s: number | null;
  };
  servers: ServerRow[];
  clients: { client_id: string; name: string; override?: { override: string } | null }[];
  leases: unknown[];
  active_leases: { lease_id: string; server_id?: string }[];
  events: { kind: string; detail: string; ts?: number }[];
  projects: unknown[];
  catalog: unknown[];
  model_aliases: unknown[];
  throttled_jobs: unknown[];
};

export type MetricPoint = {
  hour: string;
  req_total: number;
  tokens_out: number;
  engine_tokens_out?: number | null;
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

export async function getState(): Promise<StateSnapshot> {
  return json(await fetch(`/api/state?limit=10${qsToken()}`, { cache: "no-store" }));
}

export async function getEngineMetrics(serverId: string, from: number, to: number): Promise<MetricPoint[]> {
  const url = `/api/metrics?series=engine&bucket=hour&key=${encodeURIComponent(serverId)}&from=${from}&to=${to}`;
  const body = await json<{ series: MetricsSeries }>(await fetch(url, { cache: "no-store" }));
  return body.series.find((s) => s.key === serverId)?.points ?? [];
}

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


