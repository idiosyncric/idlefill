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
   * placeholders (plus {repo} for the idlefill repo root). Run via bash -c.
   */
  executor: string;
  /** Estimate passed to the arbiter at grant time. */
  estimated_seconds?: number;
}

export interface ClientConfig {
  server_url: string;
  token: string;
  client_name: string;
  /** Client's tailnet IP, reported to the server for self-traffic exemption. */
  ip: string;
  proxy_port: number;
  /** LLM target the loopback proxy forwards to. */
  llm_target: string;
  projects: ClientProjectConfig[];
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
  const repoRoot = resolve(clientDir, '..');
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
          queue_file: resolve(repoRoot, String(p.queue_file ?? '')),
          results_file: resolve(repoRoot, String(p.results_file ?? '')),
          model: String(p.model ?? 'Qwen3.8-27B'),
          cwd: p.cwd ? resolve(String(p.cwd)) : undefined,
          executor: String(p.executor ?? ''),
          estimated_seconds: typeof p.estimated_seconds === 'number' ? p.estimated_seconds : 900,
        }))
      : [],
    repo_root: repoRoot,
    state_dir: resolve(repoRoot, 'data'),
    state_file: resolve(repoRoot, 'data', 'idlefill-client-state.json'),
  };
}

function str(v: unknown, dflt: string): string {
  return typeof v === 'string' && v.length > 0 ? v : dflt;
}
function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
