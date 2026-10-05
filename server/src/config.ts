/**
 * Config loading + defaults for the arbiter.
 *
 * Sources, in priority order:
 *   1. IDLEFILL_CONFIG env — a JSON string (used by the container).
 *   2. config.json next to the entry point (src/config.json for tsx dev,
 *      dist/config.json when run from dist).
 *
 * Every field has a default so a bare dev run works out of the box.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from './types.js';

export const DEFAULTS: Omit<ServerConfig, 'state_file'> & {
  state_file: string;
  server_name: string;
  server_models: string[];
  server_peers: string[];
} = {
  listen: 8787,
  api_tokens: [],
  llama_swap_url: 'http://100.105.225.1:11434',
  activity_path: '/api/metrics/activity',
  server_name: 'llama-swap',
  server_models: [],
  server_peers: [],
  log_glob: '',
  idle_seconds: 300,
  poll_ms: 15000,
  lease_ttl_seconds: 1800,
  lease_ttl_safety_factor: 2,
  lease_ttl_floor_seconds: 60,
  max_concurrent_leases: 1,
  job_fail_threshold: 5,
  job_cooldown_seconds: 300,
  projects: [],
  state_file: './state.json',
  // Metrics retention store (#51 D5).
  metrics_raw_window_hours: 48,
  metrics_retention_days: 400,
};

/** Coerce a raw (partial) config object into a full ServerConfig, applying defaults per field. */
export function applyDefaults(raw: Partial<ServerConfig> | null | undefined): ServerConfig {
  const r = raw ?? {};
  return {
    listen: num(r.listen, DEFAULTS.listen),
    api_tokens: Array.isArray(r.api_tokens) ? r.api_tokens.filter((t) => typeof t === 'string') : [],
    llama_swap_url: str(r.llama_swap_url, DEFAULTS.llama_swap_url),
    activity_path: str(r.activity_path, DEFAULTS.activity_path),
    server_name: str(r.server_name, DEFAULTS.server_name),
    server_models: Array.isArray(r.server_models)
      ? r.server_models.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      : DEFAULTS.server_models,
    server_peers: Array.isArray(r.server_peers)
      ? r.server_peers.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      : DEFAULTS.server_peers,
    // Mesh federation read plane (#50). mesh_peers is the peer registry —
    // deliberately NOT server_peers (llama-swap backends). Entries are
    // {url, name?}; a blank url is dropped (a peer with no url cannot be
    // pulled from).
    mesh_peers: Array.isArray(r.mesh_peers)
      ? (r.mesh_peers as Record<string, unknown>[])
          .map((p) => ({
            url: typeof p?.url === 'string' ? p.url.trim() : '',
            ...(typeof p?.name === 'string' && p.name.trim() !== '' ? { name: p.name.trim() } : {}),
          }))
          .filter((p) => p.url !== '')
      : [],
    peer_token: typeof r.peer_token === 'string' ? r.peer_token : '',
    mesh_name: typeof r.mesh_name === 'string' && r.mesh_name.trim() !== '' ? r.mesh_name.trim() : '',
    log_glob: str(r.log_glob, DEFAULTS.log_glob),
    idle_seconds: num(r.idle_seconds, DEFAULTS.idle_seconds),
    poll_ms: num(r.poll_ms, DEFAULTS.poll_ms),
    lease_ttl_seconds: num(r.lease_ttl_seconds, DEFAULTS.lease_ttl_seconds),
    lease_ttl_safety_factor: num(r.lease_ttl_safety_factor, DEFAULTS.lease_ttl_safety_factor),
    lease_ttl_floor_seconds: num(r.lease_ttl_floor_seconds, DEFAULTS.lease_ttl_floor_seconds),
    max_concurrent_leases: num(r.max_concurrent_leases, DEFAULTS.max_concurrent_leases),
    job_fail_threshold: num(r.job_fail_threshold, DEFAULTS.job_fail_threshold),
    job_cooldown_seconds: num(r.job_cooldown_seconds, DEFAULTS.job_cooldown_seconds),
    projects: Array.isArray(r.projects)
      ? r.projects.map((p) => ({
          name: String(p.name ?? ''),
          paused: p.paused === true,
          daily_token_cap: num(p.daily_token_cap, Number.MAX_SAFE_INTEGER),
        }))
      : [],
    state_file: str(r.state_file, process.env.IDLEFILL_STATE || DEFAULTS.state_file),
    // Metrics retention store (#51 D5): raw window in hours, hour-bucket
    // retention in days. Non-positive/garbage falls back to the default.
    metrics_raw_window_hours: num(r.metrics_raw_window_hours, DEFAULTS.metrics_raw_window_hours ?? 48),
    metrics_retention_days: num(r.metrics_retention_days, DEFAULTS.metrics_retention_days ?? 400),
  };
}

export function loadConfig(
  entryDir: string = dirname(fileURLToPath(import.meta.url)),
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  let raw: Record<string, unknown> | null = null;

  const envJson = env.IDLEFILL_CONFIG;
  if (envJson && envJson.trim()) {
    try {
      raw = JSON.parse(envJson);
    } catch (err) {
      throw new Error(`IDLEFILL_CONFIG is not valid JSON: ${err}`);
    }
  } else {
    for (const candidate of [join(entryDir, 'config.json'), join(entryDir, '..', 'config.json')]) {
      if (existsSync(candidate)) {
        try {
          raw = JSON.parse(readFileSync(candidate, 'utf-8'));
        } catch (err) {
          throw new Error(`failed to parse config ${candidate}: ${err}`);
        }
        break;
      }
    }
  }

  return applyDefaults(raw);
}

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
function str(v: unknown, dflt: string): string {
  return typeof v === 'string' && v.length > 0 ? v : dflt;
}
