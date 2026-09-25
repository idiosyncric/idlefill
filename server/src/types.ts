/**
 * Shared types for the idlefill arbiter.
 */

export interface ProjectConfig {
  name: string;
  paused: boolean;
  /** Output-token cap per UTC day for this project. */
  daily_token_cap: number;
}

export interface ServerConfig {
  listen: number;
  api_tokens: string[];
  llama_swap_url: string;
  activity_path: string;
  /** Glob of NInfer req-*.jsonl logs. Empty string disables the log-mtime signal. */
  log_glob: string;
  idle_seconds: number;
  poll_ms: number;
  lease_ttl_seconds: number;
  max_concurrent_leases: number;
  projects: ProjectConfig[];
  /** State file path (env IDLEFILL_STATE overrides). */
  state_file: string;
}

export interface ClientRecord {
  name: string;
  client_id: string;
  /** Tailnet IP reported by the client at registration (preferred for exemption). */
  ip: string;
  /** Fallback: req.ip seen at registration time, used when the client reported none. */
  observed_ip: string;
  registered_at: string;
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
  | 'signal_recovered';

export interface EventRecord {
  ts: number;
  kind: EventKind;
  project?: string;
  lease_id?: string;
  detail?: string;
}

export interface ArbiterState {
  clients: ClientRecord[];
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
