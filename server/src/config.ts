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
import { defaultActivityPathFor } from './idle.js';
import type { ServerConfig, ServerProvider } from './types.js';
import { PROVIDER_KINDS } from './types.js';

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
  server_auth_token: '',
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
  // Cross-mesh telemetry (#79 D3): the ephemeral remote-pull cache TTL in
  // seconds. 60 = the locked default; 0 disables the cache (pull live on
  // every expand). In-memory only — never persisted anywhere.
  mesh_metrics_cache_s: 60,
  // Load-axis freshness window (#52 slice 1, D3): three polls at the
  // 15-second poll_ms.
  metrics_load_stale_s: 45,
  // llama-swap busy threshold (#52 slice 3, D4): a number on
  // `gpu_util_percent` (0-100) above which a FRESH read vetoes a grant.
  // NO default — the owner has not set a number (a fixed number on a
  // spiky gauge cuts both ways). Absent = the kind has no busy
  // predicate: `load_busy` is absent and the verdict reads exactly as
  // pre-#52. Setting a number is the owner's switch to turn the
  // llama-swap veto ON.
  metrics_llamaswap_busy_gpu_percent: undefined,

  // Fleet roster pull (#55 D3, PROPOSED). fleet_url default is ABSENT
  // (undefined): with no fleet service the roster pull never happens and
  // the peer set is the static mesh_peers config, byte-for-byte. The pull
  // interval default is PROPOSED — the D3 owner choice 3: 15 s, the poll tick.
  fleet_url: undefined,
  fleet_roster_pull_ms: 15000,
  // Fleet heartbeat (#55 D3 owner choice 1, PROPOSED — slice 8): the
  // cadence at which the arbiter publishes its own live urls + coarse
  // presence to the fleet service. PROPOSED default 60 s (the D3 draft:
  // "a heartbeat every 60 s is quieter") — quieter than the 15 s poll
  // tick. A heartbeat happens AT MOST ONCE PER INTERVAL and rides the
  // existing poll tick (no second network loop). Any of fleet_url /
  // fleet_instance_id / fleet_enrollment_token absent = no heartbeat at
  // all (byte-for-byte the pre-slice-8 behavior).
  fleet_heartbeat_ms: 60000,
  // Fleet heartbeat urls (#55 D3, PROPOSED — slice 8): the operator's
  // declaration of where THIS arbiter is reachable (its tailnet
  // address(es) / any published route). ADD key: ABSENT (undefined) = the
  // heartbeat publishes an empty urls[] (the roster row stays
  // unreachable until the operator declares a url). Trusted operator
  // input (the mesh_peers posture — the fleet service sanitizes it
  // server-side anyway).
  fleet_own_urls: undefined,
  // Fleet enrollment (#55 D2, PROPOSED, slice 7): the instance identity +
  // the one-time enrollment token. BOTH default to ABSENT (undefined):
  // the token is a SECRET the operator supplies (config.json is
  // gitignored — a real token is never committed, never logged), and the
  // instance id is the fleet-issued id persisted in
  // fleet_enrollment.json after the first successful enroll. Any one of
  // fleet_url / fleet_instance_id / fleet_enrollment_token absent = the
  // signed roster pull is inert (the pull is a no-op, byte-for-byte — the
  // pre-slice-7 behavior stands).
  fleet_instance_id: undefined,
  fleet_enrollment_token: undefined,
};

/** Coerce a raw (partial) config object into a full ServerConfig, applying defaults per field. */
export function applyDefaults(raw: Partial<ServerConfig> | null | undefined): ServerConfig {
  const r = raw ?? {};
  return {
    listen: num(r.listen, DEFAULTS.listen),
    api_tokens: Array.isArray(r.api_tokens) ? r.api_tokens.filter((t) => typeof t === 'string') : [],
    llama_swap_url: str(r.llama_swap_url, DEFAULTS.llama_swap_url),
    // An EXPLICIT empty string is the feed-off declaration (#60 A1) and
    // must survive; an absent/garbage key falls back to the kind's
    // default feed shape (#62: llama-swap contract, strata /metrics,
    // omlx feed-off) — the kind selects the shape, path included.
    activity_path:
      typeof r.activity_path === 'string'
        ? r.activity_path
        : defaultActivityPathFor(
            typeof r.server_provider === 'string' && (PROVIDER_KINDS as string[]).includes(r.server_provider.trim())
              ? (r.server_provider.trim() as ServerProvider)
              : undefined,
          ),
    server_name: str(r.server_name, DEFAULTS.server_name),
    server_models: Array.isArray(r.server_models)
      ? r.server_models.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      : DEFAULTS.server_models,
    server_peers: Array.isArray(r.server_peers)
      ? r.server_peers.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      : DEFAULTS.server_peers,
    // Per-server credential seed (#60 B): a string sticks verbatim (no
    // trim — tokens can carry significant whitespace edges? No: tokens
    // never do, but the config file is the operator's input; trim here so
    // a trailing newline from an editor paste does not poison the header).
    server_auth_token: typeof r.server_auth_token === 'string' ? r.server_auth_token.trim() : DEFAULTS.server_auth_token,
    // Provider kind for the watched row (#60 B): validated; garbage falls
    // back to undefined (= llama-swap, the pre-#60-B behavior).
    server_provider: typeof r.server_provider === 'string' && (PROVIDER_KINDS as string[]).includes(r.server_provider.trim())
      ? (r.server_provider.trim() as ServerConfig['server_provider'])
      : undefined,
    // oMLX usage-store path for the 'omlx' kind's metrics sampler (#62).
    omlx_usage_db: typeof r.omlx_usage_db === 'string' && r.omlx_usage_db.trim() !== '' ? r.omlx_usage_db.trim() : undefined,
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
    // Fleet membership label (#55 D5, locked): the multi-tenant seam. A
    // display label only — never a credential. Absent/blank = unset; the
    // arbiter's fleetId() falls back to its persisted row, then `home`.
    fleet_id: typeof r.fleet_id === 'string' && r.fleet_id.trim() !== '' ? r.fleet_id.trim() : '',
    // Fleet roster pull (#55 D3, PROPOSED — docs/architecture/fleet-service.md).
    // ADD keys: ABSENT means unset. fleet_url absent/blank = no fleet service
    // = the roster pull never happens (the peer set stays the static
    // mesh_peers config, byte-for-byte). fleet_roster_pull_ms absent/garbage
    // falls back to the PROPOSED default (15 s, the poll tick); non-positive
    // is nonsense (the guard is the metrics_load_stale_s precedent).
    fleet_url: typeof r.fleet_url === 'string' && r.fleet_url.trim() !== '' ? r.fleet_url.trim() : undefined,
    fleet_roster_pull_ms: (() => {
      const v = num(r.fleet_roster_pull_ms, DEFAULTS.fleet_roster_pull_ms ?? 15_000);
      return v > 0 ? v : (DEFAULTS.fleet_roster_pull_ms ?? 15_000);
    })(),
    // Fleet heartbeat (#55 D3 owner choice 1, PROPOSED — slice 8). The
    // cadence default is 60 s (the D3 PROPOSED value: quieter than the
    // 15 s poll tick). Non-positive/garbage falls back to the PROPOSED
    // default (the same guard as fleet_roster_pull_ms).
    fleet_heartbeat_ms: (() => {
      const v = num(r.fleet_heartbeat_ms, DEFAULTS.fleet_heartbeat_ms ?? 60_000);
      return v > 0 ? v : (DEFAULTS.fleet_heartbeat_ms ?? 60_000);
    })(),
    // Fleet heartbeat urls (#55 D3, PROPOSED — slice 8): the operator's
    // own-reachability declaration. ADD key: ABSENT = unset (the
    // heartbeat publishes an empty urls[]). Entries are trimmed,
    // blank ones dropped (the mesh_peers url posture). No http(s)
    // scheme requirement here: the tailnet url is what the operator
    // writes (the fleet service re-sanitizes server-side).
    fleet_own_urls: Array.isArray(r.fleet_own_urls)
      ? r.fleet_own_urls.filter((u): u is string => typeof u === 'string').map((u) => u.trim()).filter((u) => u !== '')
      : undefined,
    // Fleet enrollment (#55 D2, PROPOSED, slice 7). ADD keys: ABSENT means
    // unset. fleet_instance_id is the fleet-issued identity (persisted in
    // fleet_enrollment.json after the first enroll — the config value is
    // the declaration seam, the file is the source of truth).
    // fleet_enrollment_token is a SECRET: the operator supplies it
    // (config.json is gitignored) and a real token is NEVER committed or
    // logged. A blank/garbage value falls back to absent (undefined) — an
    // empty token string would only spend the enroll call on a 400/401.
    // Any one of fleet_url / fleet_instance_id / fleet_enrollment_token
    // absent = the signed roster pull is inert (a no-op, byte-for-byte).
    fleet_instance_id:
      typeof r.fleet_instance_id === 'string' && r.fleet_instance_id.trim() !== '' ? r.fleet_instance_id.trim() : undefined,
    fleet_enrollment_token:
      typeof r.fleet_enrollment_token === 'string' && r.fleet_enrollment_token.trim() !== ''
        ? r.fleet_enrollment_token.trim()
        : undefined,
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
    // Cross-mesh telemetry (#79 D3): the pull-cache TTL in seconds. 0 is a
    // LEGAL value (disable the cache, pull live); negative/garbage falls
    // back to the 60 s default.
    mesh_metrics_cache_s: (() => {
      const v = num(r.mesh_metrics_cache_s, DEFAULTS.mesh_metrics_cache_s ?? 60);
      return v >= 0 ? v : (DEFAULTS.mesh_metrics_cache_s ?? 60);
    })(),
    // Load-axis freshness window (#52 slice 1, D3): bounds the veto.
    // Non-positive/garbage falls back to the default (45 s) — a
    // window of -1 s is nonsense (same guard as rawWindowHours).
    metrics_load_stale_s: (() => {
      const v = num(r.metrics_load_stale_s, DEFAULTS.metrics_load_stale_s ?? 45);
      return v > 0 ? v : (DEFAULTS.metrics_load_stale_s ?? 45);
    })(),
    // llama-swap busy threshold (#52 slice 3, D4): the owner's knob.
    // NO default — unset means NO predicate for the kind (load_busy
    // absent, the verdict reads as pre-#52). Only a finite, positive
    // number sticks (0 or below would veto on every reading; garbage
    // is refused, never coerced).
    metrics_llamaswap_busy_gpu_percent: (() => {
      const v = r.metrics_llamaswap_busy_gpu_percent;
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
    })(),
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
