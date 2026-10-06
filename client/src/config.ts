/**
 * Client config load + defaults.
 *
 * Sources (priority): IDLEFILL_CLIENT_CONFIG env (JSON string), then
 * config.json in the client dir, then config.client.json.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAdapters } from './adapters.js';

/**
 * Scheduled queue rebuild (issue #3): the daemon runs `command` (a black
 * box — typically the project's own scan → refresh → queue-rebuild chain)
 * on a minimum interval since the last run, checked on the poll tick.
 * Run state persists next to the queue file (`<queue_file>.rebuild.json`),
 * never in the project repo. `daily_at` is a known follow-up; this step is
 * `every_minutes` only.
 */
export interface ScheduledRebuildConfig {
  enabled: boolean;
  /** Black-box command, run via bash -c with the project's cwd (15 min cap). */
  command: string;
  /** Minimum minutes between runs. Default 60 when enabled without it. */
  every_minutes: number;
}

/** Default cadence when `enabled` is set without `every_minutes`. */
export const REBUILD_DEFAULT_EVERY_MINUTES = 60;

/**
 * Parse one project's `scheduled_rebuild` key. Absent/disabled = undefined.
 * `enabled: true` with a missing/blank command is a config error → treated
 * as disabled (the daemon must never invent a command to run).
 */
export function parseScheduledRebuild(raw: unknown): ScheduledRebuildConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return undefined;
  const command = typeof r.command === 'string' ? r.command.trim() : '';
  if (!command) return undefined;
  const every =
    typeof r.every_minutes === 'number' && Number.isFinite(r.every_minutes) && r.every_minutes > 0
      ? r.every_minutes
      : REBUILD_DEFAULT_EVERY_MINUTES;
  return { enabled: true, command, every_minutes: every };
}

export interface ClientProjectConfig {
  name: string;
  /** Path to the job queue file (JSONL, one job per line). */
  queue_file: string;
  /** Path where completed result lines are appended (JSONL). */
  results_file: string;
  /** Model id handed to the executor. */
  model: string;
  /** cwd for the executor command (optional; defaults to repo root). */
  cwd?: string;
  /**
   * Executor command template with {payload_file} and {result_file}
   * placeholders (plus {repo} for the idlefill repo root — expanded to the
   * TRUE repo root in BOTH the dev and dist layouts; see ClientConfig.repo_root).
   * Run via bash -c.
   *
   * Issue #13 precedence: an explicit `executor` here always wins (the
   * escape hatch); otherwise `adapter` resolves through the registry
   * (adapters/<name>/package.json "idlefill" manifest) to the manifest's
   * executor template. When the adapter name is unknown, `adapter_error` is
   * set and this stays empty — the daemon fails fast at startup.
   */
  executor: string;
  /** Adapter name selected instead of hand-writing an executor template. */
  adapter?: string;
  /** Set at load time when `adapter` names nothing in the registry. */
  adapter_error?: string;
  /**
   * Keys of job.payload forwarded into the executor's input file (the core
   * keeps job_id/model/proxy_base_url). Resolved from the adapter manifest;
   * defaults to the career-ops vocabulary for manifest-less configs.
   */
  payload_fields?: string[];
  /** Estimate passed to the arbiter at grant time. */
  estimated_seconds?: number;
  /**
   * Wall-clock cap for one executor run, in seconds. When exceeded the
   * daemon SIGINTs the process group, waits the grace period, then
   * SIGKILLs. Default 1200 (20 min): the career-ops adapter's worst case is
   * ~90s extract + 15min eval + overhead.
   */
  timeout_seconds?: number;
  /**
   * Scheduled queue rebuild (issue #3): when set (and enabled), the daemon
   * runs `command` on a minimum interval since the last run, checked on the
   * poll tick. The command is a BLACK BOX — idlefill never parses its
   * output or the files it touches; the only contract is the exit code.
   */
  scheduled_rebuild?: ScheduledRebuildConfig;
}

export interface ClientConfig {
  server_url: string;
  token: string;
  client_name: string;
  /**
   * Client's tailnet IP. Sent to the server for display/audit only — the
   * arbiter prefers the IP it OBSERVES on the connection (which tracks
   * tailnet reassignments; a stale static value here would break the
   * self-traffic exemption).
   */
  ip: string;
  proxy_port: number;
  /** LLM target the loopback proxy forwards to. */
  llm_target: string;
  /**
   * Aggregate inference endpoint (#64 D1): a SECOND loopback listener
   * (127.0.0.1 only) inside this SAME process, in front of the SAME
   * SessionGate instance. Every Hermes profile points at
   * `http://127.0.0.1:<aggregate_port>/v1`; the router answers /v1/models
   * from the arbiter-published catalog and routes chat traffic by the
   * body's `model` to the catalog row's engine. `0` disables the listener.
   * ADD key (mesh D5 counts processes, not listeners).
   */
  aggregate_port: number;
  /**
   * Session gate (issue #9 Part A): when true (default) the loopback proxy
   * also acts as the per-Mac router/gate for interactive agent traffic on
   * `/s/<token>/v1/...` — self-registration, capacity-limited admission,
   * held (not failed) requests for queued/paused sessions. Optional on the
   * interface so hand-built ClientConfig fixtures stay valid; the loader
   * always sets it.
   */
  session_gate?: boolean;
  /** Admission capacity: concurrent agent sessions allowed at the engine. */
  max_active_agent_sessions?: number;
  /** Max a queued/paused session's request parks at the router before a
   * retryable 503 + Retry-After. Must stay under the client's own request
   * timeout (Hermes: HERMES_API_TIMEOUT default 1800s). */
  session_hold_cap_ms?: number;
  projects: ClientProjectConfig[];
  /**
   * The true idlefill repo root — the `{repo}` expansion target in executor
   * templates: `<root>/adapters/career-ops/eval.mjs`, NOT
   * `<root>/client/adapters/…`. Computed as `../..` from client/src (dev:
   * tsx src/index.ts) or client/dist (packaged) — the client package dir is
   * `..` in both layouts. (Sep 25-26 thrash incident: {repo} resolved to
   * the client package dir and every executor exited 1 with
   * "Cannot find module".)
   */
  repo_root: string;
  state_dir: string;
  /** Crash-safe operator-state file (last lease + overrides); lives outside state_dir. */
  state_file: string;
  /**
   * The config FILE the config was loaded from, or undefined when it came
   * from IDLEFILL_CLIENT_CONFIG (#61 step 3 A3). The /client/projects
   * editor writes back to exactly this file (tmp-then-rename, 0600); no
   * path = no file to write = the routes answer 503 instead of inventing
   * one. ADD-key: optional, so hand-built ClientConfig fixtures stay valid.
   */
  config_path?: string;
}

const DEFAULTS = {
  server_url: 'http://127.0.0.1:8787',
  token: '',
  client_name: 'idlefill-client',
  ip: '',
  proxy_port: 11435,
  llm_target: 'http://100.105.225.1:11434',
  // Aggregate endpoint port (#64 D1, owner decision 4: 8800 fleet-wide).
  aggregate_port: 8800,
  session_gate: true,
  max_active_agent_sessions: 2,
  session_hold_cap_ms: 120_000,
};

export function loadClientConfig(
  clientDir: string = dirname(fileURLToPath(import.meta.url)),
  env: NodeJS.ProcessEnv = process.env,
): ClientConfig {
  // clientDir is client/src (dev: tsx src/index.ts) or client/dist
  // (packaged). In BOTH layouts the client package dir is `..` and the
  // true idlefill repo root is `../..`.
  //
  // Relative config paths (queue_file, results_file, state_dir) resolve
  // against the client package dir: the untracked local config.json uses
  // `../data/...` from there (→ <root>/data). The {repo} placeholder in
  // executor templates expands to the TRUE repo root — the adapters live
  // under <root>/adapters, not <root>/client/adapters.
  const clientPkgDir = resolve(clientDir, '..');
  const repoRoot = resolve(clientDir, '../..');
  // dev (tsx src/index.ts) vs packaged (dist/index.ts): the config lives in
  // the client package dir, which is `clientDir` when running from dist and
  // its PARENT when running the source directly. Check both.
  const pkgDir = clientDir;
  const srcParent = dirname(clientDir);
  let raw: Record<string, unknown> | null = null;
  let configPath: string | undefined;

  if (env.IDLEFILL_CLIENT_CONFIG?.trim()) {
    raw = JSON.parse(env.IDLEFILL_CLIENT_CONFIG);
  } else {
    for (const cand of [
      join(pkgDir, 'config.json'),
      join(pkgDir, 'config.client.json'),
      join(srcParent, 'config.json'),
      join(srcParent, 'config.client.json'),
    ]) {
      if (existsSync(cand)) {
        raw = JSON.parse(readFileSync(cand, 'utf-8'));
        configPath = cand; // the editor (#61 A3) writes back to THIS file
        break;
      }
    }
  }
  const r = raw ?? {};

  // Adapter registry (issue #13): one bounded scan of <repoRoot>/adapters/*/
  // package.json. Resolution precedence per project: explicit `executor`
  // wins (escape hatch) > `adapter` manifest > unknown adapter = FATAL at
  // startup (adapter_error set; the daemon registers but requests no leases).
  const adapters = discoverAdapters(repoRoot);

  return {
    server_url: str(r.server_url, DEFAULTS.server_url),
    token: str(r.token, env.IDLEFILL_CLIENT_TOKEN ?? DEFAULTS.token),
    client_name: str(r.client_name, DEFAULTS.client_name),
    ip: str(r.ip, env.IDLEFILL_CLIENT_IP ?? DEFAULTS.ip),
    proxy_port: num(r.proxy_port, DEFAULTS.proxy_port),
    llm_target: str(r.llm_target, DEFAULTS.llm_target),
    // Aggregate endpoint (#64): `0` disables the second listener; a
    // garbage/negative value falls back to the default.
    aggregate_port: Math.max(0, Math.floor(num(r.aggregate_port, DEFAULTS.aggregate_port))),
    // Session gate (issue #9 Part A). `session_gate` accepts an explicit
    // boolean; anything else falls back to the default (true).
    session_gate: typeof r.session_gate === 'boolean' ? r.session_gate : DEFAULTS.session_gate,
    max_active_agent_sessions: Math.max(1, Math.floor(num(r.max_active_agent_sessions, DEFAULTS.max_active_agent_sessions))),
    session_hold_cap_ms: Math.max(1000, Math.floor(num(r.session_hold_cap_ms, DEFAULTS.session_hold_cap_ms))),
    projects: Array.isArray(r.projects)
      ? r.projects.map((p: Record<string, unknown>) => {
          const explicitExecutor = String(p.executor ?? '');
          const adapterName = typeof p.adapter === 'string' && p.adapter.trim() !== '' ? p.adapter : undefined;
          const manifest = adapterName ? adapters.get(adapterName) : undefined;
          const adapterError =
            adapterName && !manifest
              ? `unknown adapter "${adapterName}" — registry has: ${[...adapters.keys()].join(', ') || '(none)'}`
              : undefined;
          const executor = explicitExecutor || manifest?.executor || '';
          return {
            name: String(p.name ?? ''),
            queue_file: resolve(clientPkgDir, String(p.queue_file ?? '')),
            results_file: resolve(clientPkgDir, String(p.results_file ?? '')),
            model: String(p.model ?? 'Qwen3.8-27B'),
            cwd: p.cwd ? resolve(String(p.cwd)) : undefined,
            executor,
            ...(adapterName ? { adapter: adapterName } : {}),
            ...(adapterError ? { adapter_error: adapterError } : {}),
            // payload_fields / estimates: manifest defaults, config wins.
            ...(manifest?.payload_fields ? { payload_fields: manifest.payload_fields } : {}),
            estimated_seconds:
              typeof p.estimated_seconds === 'number'
                ? p.estimated_seconds
                : manifest?.estimated_seconds ?? 900,
            timeout_seconds:
              typeof p.timeout_seconds === 'number' && Number.isFinite(p.timeout_seconds) && p.timeout_seconds > 0
                ? p.timeout_seconds
                : manifest?.timeout_seconds,
            // Scheduled queue rebuild (issue #3): per-project config key;
            // undefined = the loop never runs for this project.
            ...(parseScheduledRebuild(p.scheduled_rebuild) ? { scheduled_rebuild: parseScheduledRebuild(p.scheduled_rebuild) } : {}),
          };
        })
      : [],
    repo_root: repoRoot,
    state_dir: resolve(clientPkgDir, 'data'),
    state_file: resolve(clientPkgDir, 'data', 'idlefill-client-state.json'),
    ...(configPath ? { config_path: resolve(configPath) } : {}),
  };
}

function str(v: unknown, dflt: string): string {
  return typeof v === 'string' && v.length > 0 ? v : dflt;
}
function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
