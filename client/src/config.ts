/**
 * Client config load + defaults.
 *
 * Sources (priority): IDLEFILL_CLIENT_CONFIG env (JSON string), then
 * config.json in the client dir, then config.client.json.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
   */
  executor: string;
  /** Estimate passed to the arbiter at grant time. */
  estimated_seconds?: number;
  /**
   * Wall-clock cap for one executor run, in seconds. When exceeded the
   * daemon SIGINTs the process group, waits the grace period, then
   * SIGKILLs. Default 1200 (20 min): the career-ops adapter's worst case is
   * ~90s extract + 15min eval + overhead.
   */
  timeout_seconds?: number;
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
}

const DEFAULTS = {
  server_url: 'http://127.0.0.1:8787',
  token: '',
  client_name: 'idlefill-client',
  ip: '',
  proxy_port: 11435,
  llm_target: 'http://100.105.225.1:11434',
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
        break;
      }
    }
  }
  const r = raw ?? {};

  return {
    server_url: str(r.server_url, DEFAULTS.server_url),
    token: str(r.token, env.IDLEFILL_CLIENT_TOKEN ?? DEFAULTS.token),
    client_name: str(r.client_name, DEFAULTS.client_name),
    ip: str(r.ip, env.IDLEFILL_CLIENT_IP ?? DEFAULTS.ip),
    proxy_port: num(r.proxy_port, DEFAULTS.proxy_port),
    llm_target: str(r.llm_target, DEFAULTS.llm_target),
    projects: Array.isArray(r.projects)
      ? r.projects.map((p: Record<string, unknown>) => ({
          name: String(p.name ?? ''),
          queue_file: resolve(clientPkgDir, String(p.queue_file ?? '')),
          results_file: resolve(clientPkgDir, String(p.results_file ?? '')),
          model: String(p.model ?? 'Qwen3.8-27B'),
          cwd: p.cwd ? resolve(String(p.cwd)) : undefined,
          executor: String(p.executor ?? ''),
          estimated_seconds: typeof p.estimated_seconds === 'number' ? p.estimated_seconds : 900,
          timeout_seconds: typeof p.timeout_seconds === 'number' && Number.isFinite(p.timeout_seconds) && p.timeout_seconds > 0 ? p.timeout_seconds : undefined,
        }))
      : [],
    repo_root: repoRoot,
    state_dir: resolve(clientPkgDir, 'data'),
    state_file: resolve(clientPkgDir, 'data', 'idlefill-client-state.json'),
  };
}

function str(v: unknown, dflt: string): string {
  return typeof v === 'string' && v.length > 0 ? v : dflt;
}
function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
