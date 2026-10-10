/**
 * Hermes Gateway API connector (issue #73) — the OBSERVED COMPLEMENT to the
 * session gate, never an alternative gate.
 *
 * Plane map (docs/reports/ISSUE9-RESEARCH-HERMES-SURFACES.md): the loopback
 * proxy is the EGRESS plane (the gate's chokepoint — it holds a provider
 * call already in flight); the arbiter is the control plane; the Hermes
 * Gateway API server (`127.0.0.1:8642`, one listener serves every profile,
 * native routes mirrored under `/p/<profile>/...`) is the INBOUND plane.
 * It can never hold a provider call already in flight, so it is a
 * complement the gate observes, not a second gate. This module harvests
 * the two surfaces that earn their place:
 *
 *   A. SESSION ENRICHMENT — `GET /api/sessions` per profile returns the
 *      Hermes session ledger: titles, token/cost totals, `end_reason`,
 *      `last_active` — facts the router can NEVER observe. Rows join to
 *      the gate's session rows on the `session_id` the router already
 *      captured from the `X-Hermes-Session-Id` header (#42 slice 0). The
 *      merged facts ride the existing register-heartbeat ADD-key pattern
 *      as ONE new key, `hermes_meta`: ABSENT = unset (the key is omitted,
 *      the arbiter keeps its stored value — never a fake zero).
 *      #83 complement: delegate/subagent children (`model_config.
 *      _delegate_from`) are DELIBERATELY absent from that listing, so a
 *      ledger miss schedules ONE bounded `GET .../api/sessions/{id}` probe
 *      (throttled, capped attempts, keyed profiles only, never while down).
 *
 *   B. HOST FACTS — `GET /v1/health` (unauthenticated) answers
 *      `{status, version}`. The daemon publishes `hermes_version` +
 *      `gateway_reachable` posture on its client register heartbeat,
 *      alongside `gate_posture` (the same ADD-key discipline).
 *      #85 slice E extends the block ONLY when the authenticated
 *      `GET /health/detailed` payload earns it: ONE extra request per
 *      REACHABLE round, reduced to a bounded summary (`hermes_host_facts`:
 *      readiness status + whitelisted check statuses + two integer
 *      counts). The raw body's `used_percent`/`free_bytes`, platform
 *      NAMES, pids, timestamps and metrics are dropped by the sanitizer —
 *      never published, never stored. If the detailed body carries nothing
 *      beyond what /v1/health already reported (status/version), the
 *      round skips it silently: zero extra keys on the wire.
 *
 *   C. RUNS CONTROL (the seam) — `POST /v1/runs` dispatches agent-shaped
 *      work INTO Hermes; `GET /v1/runs/{id}`, `POST /v1/runs/{id}/stop`,
 *      `/steer`, `/approval` control a run THIS process created. The
 *      gateway only exposes these verbs for runs created through the API
 *      (it never addresses an unrelated TUI session), and this class
 *      enforces the same rule client-side: a control verb for a run id
 *      this process did not dispatch is refused WITHOUT an HTTP request.
 *      Scope warning (recorded, not solved here): a run's provider calls
 *      do NOT pass the loopback gate unless the run's profile routes
 *      through the idlefill aggregate endpoint — dispatching production
 *      work through this seam before that is verified is a capacity gap.
 *
 * FAIL-OPEN / FAIL-QUIET — the connector is strictly additive:
 *   - gateway down (connection refused / timeout) → `reachable=false`,
 *     no meta published, the gate behaves byte-for-byte as before;
 *   - a profile with no operator key / a 401 → the server is UP
 *     (reachable=true) but that profile's rows stay last-known;
 *   - a malformed row or member → dropped individually (the ledger
 *     sanitizer below), never a crash, never a poisoned heartbeat;
 *   - the key is read at runtime from env / an operator-provisioned
 *     key file; it is NEVER logged, NEVER published, never written.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The `hermes_meta` ADD-key block published on the session register
 * heartbeat — ONE ledger row for the session, the facts the router can
 * never observe. Every member is optional: the block carries only what
 * the ledger row actually had (absent = unset, never a fake zero).
 * `last_active`/`ended_at` are epoch-ms.
 */
export interface HermesSessionMeta {
  title?: string;
  model?: string;
  message_count?: number;
  tool_call_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  estimated_cost_usd?: number;
  last_active?: number;
  /** Absent = the ledger row has no end; null = the row ended with no
   *  reason; number = epoch-ms of the end. */
  ended_at?: number | null;
  end_reason?: string | null;
}

/**
 * The connector's resolved config. `key` is the DEFAULT-home API key
 * (operator-provisioned via `key_env` / the key file's `default` entry);
 * `profileKeys` maps a named profile to its own key (the gateway serves
 * every profile from ONE listener, each with a per-profile-scoped
 * `API_SERVER_KEY`; a profile with no key is simply not fetchable).
 */
export interface HermesGatewayConfig {
  enabled: boolean;
  /** Gateway base URL, default `http://127.0.0.1:8642` (the Hermes default). */
  base_url: string;
  /** Profiles to fetch: `'default'` = the home ledger (no prefix); a named
   *  profile = `/p/<profile>/...`. Auto-discovered from `~/.hermes/profiles`
   *  (plus `default`) when the dir exists; an explicit config list wins. */
  profiles: string[];
  key: string | undefined;
  profileKeys: Map<string, string>;
  /** Ledger poll cadence (seconds), default 30. */
  poll_seconds: number;
  /** Per-request timeout (ms), default 2500. */
  timeout_ms: number;
  /** Key file path (operator-provisioned, profile→key JSON map). */
  key_file: string;
}

/** A raw row of `GET .../api/sessions` (the gateway's `_session_response`). */
export type GatewaySessionRow = Record<string, unknown>;

/**
 * #85 slice E: the bounded host-facts summary harvested from the
 * authenticated `GET /health/detailed` round. Deliberately TINY — a
 * readiness verdict, per-check statuses from a fixed whitelist, and two
 * integer counts. Everything the raw body carries that is not here is
 * dropped by construction: `used_percent`/`free_bytes` (raw disk numbers
 * are a privacy/scale question, not a display fact), platform NAMES,
 * pids, timestamps, listener URLs, and the metrics block. Every member is
 * optional: absent = the round did not earn that fact (never a fake zero).
 */
export interface HermesHostFacts {
  /** The gateway's own readiness verdict (`readiness.status`, falling back
   *  to the top-level `status`). Normalized to the four known verdicts. */
  readiness?: HostFactStatus;
  /** check name → status, from READINESS_CHECKS only (≤7 entries). */
  checks?: Record<string, HostFactStatus>;
  /** `readiness.checks.gateway.connected_platforms` (a COUNT — the
   *  platform names are never published). */
  connected_platforms?: number;
  /** `readiness.checks.background_queues.active_api_runs`. */
  active_api_runs?: number;
}

/** The known readiness verdicts. Anything the gateway reports outside this
 *  set normalizes to `unknown` (never a crash, never a fabricated `ok`). */
export type HostFactStatus = 'ok' | 'degraded' | 'down' | 'unknown';

/**
 * The ONLY readiness checks the summary may carry: a fixed whitelist, so a
 * future gateway check cannot smuggle an unbounded payload onto the wire.
 * Names mirror the live gateway (`state_db`, `session_store`, `config`,
 * `model`, `disk`, `gateway`, `background_queues`).
 */
export const READINESS_CHECKS: readonly string[] = [
  'state_db',
  'session_store',
  'config',
  'model',
  'disk',
  'gateway',
  'background_queues',
];
const STATUS_SET = new Set<HostFactStatus>(['ok', 'degraded', 'down', 'unknown']);

function normalizeStatus(v: unknown): HostFactStatus | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (s === '') return undefined;
  return STATUS_SET.has(s as HostFactStatus) ? (s as HostFactStatus) : 'unknown';
}

/** Integer, non-negative, bounded — else undefined (absent, never a zero). */
function boundedInt(v: unknown, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) return undefined;
  return v;
}

/**
 * Turn ONE raw `/health/detailed` body into the bounded summary. Returns
 * undefined when the payload earns NOTHING beyond what `/v1/health` already
 * gave (the "skip silently" rule of issue #85 slice E): no readiness block,
 * no whitelisted check statuses, and no counts → no key on the wire. A
 * malformed body is never a crash — each member is checked individually and
 * a bad member is dropped while the rest stand.
 *
 * `healthStatus` is the verdict the same round already got from
 * `/v1/health`; when the detailed body's top-level status matches it AND
 * the readiness block adds nothing, the round earns nothing.
 */
export function sanitizeHostFacts(raw: unknown, healthStatus?: string): HermesHostFacts | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  const out: HermesHostFacts = {};

  const readiness = body.readiness;
  const readinessObj = typeof readiness === 'object' && readiness !== null && !Array.isArray(readiness)
    ? (readiness as Record<string, unknown>)
    : undefined;

  const readinessStatus = normalizeStatus(readinessObj?.status) ?? normalizeStatus(body.status);
  if (readinessStatus !== undefined) out.readiness = readinessStatus;

  const checks = readinessObj?.checks;
  if (typeof checks === 'object' && checks !== null && !Array.isArray(checks)) {
    const held: Record<string, HostFactStatus> = {};
    for (const name of READINESS_CHECKS) {
      const entry = (checks as Record<string, unknown>)[name];
      // A check may be a bare status string or an object with a `status`
      // member (the live shape); anything else earns nothing.
      const status = typeof entry === 'string' ? normalizeStatus(entry) : normalizeStatus((entry as Record<string, unknown> | undefined)?.status);
      if (status === undefined) continue;
      held[name] = status;
      if (Object.keys(held).length >= READINESS_CHECKS.length) break;
    }
    if (Object.keys(held).length > 0) out.checks = held;

    const gw = (checks as Record<string, unknown>)['gateway'];
    const platforms = boundedInt((gw as Record<string, unknown> | undefined)?.connected_platforms, 100);
    if (platforms !== undefined) out.connected_platforms = platforms;
    const bq = (checks as Record<string, unknown>)['background_queues'];
    const runs = boundedInt((bq as Record<string, unknown> | undefined)?.active_api_runs, 10_000);
    if (runs !== undefined) out.active_api_runs = runs;
  }

  // The earnings test: a detailed body that carries nothing past the
  // plain health verdict (no readiness block, no check statuses, no
  // counts) is not worth a wire key.
  if (out.readiness === undefined && out.checks === undefined && out.connected_platforms === undefined && out.active_api_runs === undefined) {
    return undefined;
  }
  if (out.readiness !== undefined && out.checks === undefined && out.connected_platforms === undefined && out.active_api_runs === undefined) {
    // Only a status verdict: if it is the SAME verdict the health round
    // already reported, the payload earned nothing new.
    const knownHealth = normalizeStatus(healthStatus);
    if (knownHealth !== undefined && knownHealth === out.readiness) return undefined;
  }
  return out;
}

/** The URL for the detailed health surface (#85 slice E) — the default-home
 *  listener only (native routes are unprofiled for health). */
export const DETAILED_HEALTH_PATH = '/health/detailed';

/** One dispatched run (the runs-control seam keeps ONLY its own runs). */
export interface HermesRun {
  run_id: string;
  profile: string;
  /** The prompt that started the run (for the operator's audit, not re-sent). */
  input: string;
  created_at: number;
}

/** A runs-control verdict. `ok:false` + `error` is the fail-quiet shape:
 *  the caller never throws, the job/adapter sees a plain result. */
export interface RunResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

/**
 * #85 slice G: the operator-driven session LIFECYCLE verb's field set.
 * Exactly the gateway's client-safe flags MINUS `end_reason`: ending a
 * LIVE row while its agent still runs is a footgun the gate cannot
 * arbitrate, so `end_reason` — and `model`, and every other field — is
 * refused BY NAME before a single byte reaches the gateway. The verb
 * fires ONLY on a deliberate operator gesture (the Sessions-row rename /
 * pin click); no cycle, lease, or automatic path may call it, and the
 * verb's payload is NEVER published to the arbiter (it never rides a
 * heartbeat or /api/state).
 */
export const LIFECYCLE_FIELDS = ['title', 'pinned', 'archived', 'hidden', 'unread'] as const;

/** A validated lifecycle patch: `title: null` restores the derived title
 *  (the gateway's documented restore semantics); flags are booleans. */
export type HermesLifecyclePatch = {
  title?: string | null;
  pinned?: boolean;
  archived?: boolean;
  hidden?: boolean;
  unread?: boolean;
};

/**
 * Validate a lifecycle body (fail closed, whole body — the sibling
 * surfaces' discipline). Returns the sanitized patch or a NAMED error
 * that lists every offending field (end_reason gets its own explicit
 * reason so the operator learns why it is off the table this issue).
 */
export function validateLifecyclePatch(body: unknown): { ok: true; patch: HermesLifecyclePatch } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object carrying lifecycle fields (title/pinned/archived/hidden/unread)' };
  }
  const r = body as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => !LIFECYCLE_FIELDS.includes(k as (typeof LIFECYCLE_FIELDS)[number])).sort();
  if (unknown.length > 0) {
    const hint = unknown.includes('end_reason')
      ? ' — end_reason is deliberately NOT exposed this issue (ending a live row while its agent runs is a footgun the gate cannot arbitrate)'
      : '';
    return { ok: false, error: `Unsupported lifecycle field(s): ${unknown.join(', ')}${hint}` };
  }
  const patch: HermesLifecyclePatch = {};
  if (r.title !== undefined) {
    if (r.title === null) patch.title = null;
    else if (typeof r.title === 'string' && r.title.trim() !== '') patch.title = r.title.trim().slice(0, 256);
    else return { ok: false, error: "'title' must be a non-empty string or null (null restores the derived title)" };
  }
  for (const flag of ['pinned', 'archived', 'hidden', 'unread'] as const) {
    if (r[flag] !== undefined) {
      if (typeof r[flag] !== 'boolean') return { ok: false, error: `'${flag}' must be a boolean` };
      patch[flag] = r[flag];
    }
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to patch — carry at least one of title/pinned/archived/hidden/unread' };
  return { ok: true, patch };
}

/**
 * A lifecycle verdict — the slice-A posture applied to a control verb:
 * either the patch landed on the owning profile, or the refusal carries
 * the HTTP status the loopback route answers plus a NAMED reason. The
 * verb's payload never appears in the verdict (only the field NAMES that
 * were applied), so a refusal/echo can never carry conversation-adjacent
 * content outward.
 */
export type LifecycleResult =
  | { ok: true; profile: string; session_id: string; patched: string[] }
  | { ok: false; status: number; error: string; reason: string };

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://127.0.0.1:8642';
const DEFAULT_KEY_ENV = 'IDLEFILL_HERMES_GATEWAY_KEY';
const DEFAULT_KEY_FILE = '~/.idlefill/hermes-gateway-keys.json';
const DEFAULT_PROFILES_DIR = '~/.hermes/profiles';

/**
 * #81: the gateway clamps `limit` to 200 (`_handle_list_sessions` parses it
 * with `maximum=200`, v0.21.6), so 200 is the largest page obtainable. The
 * list envelope carries `has_more`; a profile whose recency window is deeper
 * than one page must not silently enrich only the freshest 200 rows (the
 * last-known-wins merge would keep publishing the stale tail forever).
 * `LEDGER_MAX_PAGES` bounds the round: a hostile or buggy `has_more` can
 * never make a profile's round unbounded.
 */
const LEDGER_PAGE_SIZE = 200;
const LEDGER_MAX_PAGES = 5;

/**
 * #82: the last-known ledger only ever grows — Hermes session ids
 * accumulate for the daemon's whole uptime (LaunchAgent / systemd lifetime).
 * Two bounded evictions, the same fail-quiet direction as the gate's
 * `SESSION_ID_INDEX_MAX` (an evicted id resolves to nothing; `hermes_meta`
 * then rides the heartbeat as ABSENT, and an absent key never clears the
 * arbiter's stored block — so client-side eviction cannot erase what a
 * better poll already published):
 *   1. an entry whose Hermes row ENDED (`ended_at` present — a number or an
 *      explicit null, both mean ended) that has not appeared in
 *      LEDGER_EVICTION_GRACE_ROUNDS consecutive REACHABLE rounds is dropped
 *      (20 rounds ≈ 10 min at the 30s cadence);
 *   2. a hard size cap drops the least-recently-seen entries first.
 * An unreachable round stamps nothing: a down gateway never ages the ledger.
 */
const LEDGER_EVICTION_GRACE_ROUNDS = 20;
const LEDGER_MAX_ENTRIES = 5000;

/**
 * #83: a session whose `model_config._delegate_from` is set (a `delegate_task`
 * subagent, a desktop agent-close child) is DELIBERATELY absent from the
 * default `GET /api/sessions` listing (`_session_filter_where` excludes those
 * rows unless `include_children` — which the API never passes), so the gate's
 * captured `X-Hermes-Session-Id` joins against nothing in the ledger and
 * `hermes_meta` stays absent. The single-session route (`GET
 * .../api/sessions/{id}`, capability `session`, per-profile Bearer) resolves
 * ANY exact id — children included (`_get_existing_session_or_404` →
 * `db.get_session`; `_session_response` publishes the same safe-keys the
 * listing row carries, plus `is_internal_child`). So a ledger MISS schedules
 * ONE bounded per-id lookup: at most `SINGLE_LOOKUPS_PER_ROUND` distinct ids
 * scheduled per poll round, at most `SINGLE_MAX_ATTEMPTS` walks per id, at
 * least `SINGLE_RETRY_MS` apart, only while the gateway is reachable and the
 * profile has a key, deduped by the in-flight set. The walk RESULT is cached:
 * a walk in which EVERY keyed profile answered an explicit 404 marks the id
 * NOT FOUND (negative cache) — the same id is then NEVER fetched again; only
 * ambiguous walks (transport failure, 401s, malformed bodies) may retry,
 * bounded by the attempt cap and the throttle. The attempts bookkeeping and
 * the negative cache are each size-capped (oldest record dropped) so a
 * hostile id stream cannot grow them. Fail-open unchanged: nothing is
 * scheduled while unreachable / unkeyed / disabled — a down gateway still
 * sees zero extra requests, byte-for-byte the pre-#73 wire.
 */
const SINGLE_MAX_ATTEMPTS = 2;
const SINGLE_RETRY_MS = 300_000;
const SINGLE_TRACKED_MAX = 1000;
const SINGLE_LOOKUPS_PER_ROUND = 8;

/** Expand a leading `~` against the OS home (test seam via `home`). */
function expandHome(p: string, home: string): string {
  return p === '~' || p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

function autoDiscoverProfiles(profilesDir: string): string[] {
  try {
    const entries = readdirSync(profilesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => n.trim() !== '' && n !== '.' && n !== '..' && !n.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read an operator-provisioned key file (JSON: `{ "<profile>": "<key>" }`).
 * The file may not exist (the operator has not provisioned one) — that is
 * the NORMAL case on a fresh machine: every fetch is then unauthenticated
 * and the ledger stays last-known (fail-quiet). The key value is never
 * logged and never returned in an error message.
 */
function readKeyFile(path: string, home: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const p = expandHome(path, home);
    if (!existsSync(p)) return out;
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim() !== '') out.set(k, v);
    }
  } catch {
    /* malformed key file = no keys (fail-quiet; never a crash) */
  }
  return out;
}

/**
 * Resolve the connector config from the client config's `hermes_gateway`
 * block (shape per issue #73 slice A). Defaults: enabled true, the Hermes
 * default base_url, profiles auto-discovered from the local Hermes home
 * (`default` + every `~/.hermes/profiles/*` dir), key from the operator
 * env var / key file. `enabled: false` (or a malformed base_url) disables
 * the connector entirely — the daemon then publishes NO hermes keys and
 * the heartbeat is byte-for-byte the pre-#73 shape.
 */
export function resolveHermesGatewayConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): HermesGatewayConfig {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const enabled = typeof r.enabled === 'boolean' ? r.enabled : true;
  const base_url =
    typeof r.base_url === 'string' && /^https?:\/\/[^\s]+$/.test(r.base_url.trim())
      ? r.base_url.trim().replace(/\/$/, '')
      : DEFAULT_BASE_URL;
  const keyFile = typeof r.key_file === 'string' && r.key_file.trim() !== '' ? r.key_file : DEFAULT_KEY_FILE;
  const keyEnv = typeof r.key_env === 'string' && r.key_env.trim() !== '' ? r.key_env : DEFAULT_KEY_ENV;
  const profilesDir =
    typeof r.profiles_dir === 'string' && r.profiles_dir.trim() !== '' ? r.profiles_dir : DEFAULT_PROFILES_DIR;

  const profiles =
    Array.isArray(r.profiles) && r.profiles.length > 0 && r.profiles.every((p) => typeof p === 'string' && p.trim() !== '')
      ? r.profiles.map((p) => (p as string).trim())
      : (autoDiscoverProfiles(expandHome(profilesDir, home)).length > 0 ? ['default', ...autoDiscoverProfiles(expandHome(profilesDir, home))] : ['default']);

  const keys = readKeyFile(keyFile, home);
  const envKey = typeof env[keyEnv] === 'string' ? env[keyEnv].trim() : '';
  const key = envKey !== '' ? envKey : (keys.get('default') ?? undefined);

  return {
    enabled,
    base_url,
    profiles,
    key,
    profileKeys: keys,
    poll_seconds:
      typeof r.poll_seconds === 'number' && Number.isFinite(r.poll_seconds) && r.poll_seconds >= 5
        ? Math.floor(r.poll_seconds)
        : 30,
    timeout_ms:
      typeof r.timeout_ms === 'number' && Number.isFinite(r.timeout_ms) && r.timeout_ms >= 250
        ? Math.floor(r.timeout_ms)
        : 2500,
    key_file: keyFile,
  };
}

// ---------------------------------------------------------------------------
// Ledger fetch + merge (the enrichment core)
// ---------------------------------------------------------------------------

/** The URL path for a profile's ledger: `default` = the home ledger (no
 *  prefix); a named profile = the gateway's per-profile mirror. */
export function ledgerPath(profile: string): string {
  return profile === 'default' ? '/api/sessions' : `/p/${encodeURIComponent(profile)}/api/sessions`;
}

/** #83: the URL path for ONE session by exact id (the `session` capability —
 *  resolves children the listing hides, per-profile mirror included). */
export function sessionPath(profile: string, sessionId: string): string {
  const id = encodeURIComponent(sessionId);
  return profile === 'default' ? `/api/sessions/${id}` : `/p/${encodeURIComponent(profile)}/api/sessions/${id}`;
}

/**
 * #85 slice A: the URL path for ONE session's MESSAGES (the `session_messages`
 *  capability, per-profile mirror included). Verified live against
 *  `gateway/platforms/api_server.py` `_handle_session_messages`: the envelope is
 *  `{object:'list', session_id, data:[_message_response rows…], pagination:{limit, offset, order, returned}}`
 *  and the gateway itself clamps `limit` to 500.
 */
export function transcriptPath(profile: string, sessionId: string): string {
  const id = encodeURIComponent(sessionId);
  return profile === 'default'
    ? `/api/sessions/${id}/messages`
    : `/p/${encodeURIComponent(profile)}/api/sessions/${id}/messages`;
}

// ---------------------------------------------------------------------------
// #85 slice A: the on-demand transcript (viewer-only, NEVER bulk-polled,
// NEVER published to the arbiter — it rides no heartbeat, no /api/state).
// ---------------------------------------------------------------------------

/** Page bounds: the viewer asks page by page; a request can NEVER pull more
 *  than TRANSCRIPT_PAGE_MAX rows. A missing/invalid limit falls to the
 *  default (50) — the gateway's own 500 cap is deliberately tightened here
 *  so one viewer click moves a bounded, renderable page. */
export const TRANSCRIPT_PAGE_DEFAULT = 50;
export const TRANSCRIPT_PAGE_MAX = 200;
/** Offsets are clamped so a hostile/typo offset cannot walk the ledger into
 *  absurd deep pages (one bounded fetch stays one bounded fetch). */
export const TRANSCRIPT_OFFSET_MAX = 100_000;
/** Per-member caps (drop-don't-crash sanitizers, same posture as rowToMeta). */
export const TRANSCRIPT_CONTENT_CAP = 4000;
export const TRANSCRIPT_TOOL_NAME_CAP = 128;
export const TRANSCRIPT_TOOL_CALLS_MAX = 20;
export const TRANSCRIPT_TOOL_ARGS_CAP = 500;
export const TRANSCRIPT_FINISH_REASON_CAP = 64;

/** A sanitized transcript row: exactly the `_message_response` safe-keys the
 *  viewer needs, each member individually checked/capped. Malformed members
 *  are dropped, never crash. `timestamp` is epoch-ms (the ledger stores
 *  epoch-seconds; toEpochMs normalizes both). */
export interface TranscriptMessage {
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

/** A transcript verdict: either a bounded sanitized page, or a refusal with
 *  the HTTP status the loopback route answers (503-class for disabled /
 *  unkeyed / unreachable / ambiguous-only walk; 404 ONLY when every keyed
 *  profile answered an explicit 404; 400 for a malformed id). `reason` is
 *  the NAMED refusal. */
export type TranscriptResult =
  | {
      ok: true;
      profile: string;
      session_id: string;
      offset: number;
      limit: number;
      /** Sanitized rows actually rendered (a dropped malformed row counts
       *  against this, NOT against the paging bookkeeping). */
      returned: number;
      /** Where the NEXT page starts: offset + the RAW gateway rows this
       *  page consumed. Never derived from the sanitized count — rows the
       *  sanitizer dropped must never re-show or overlap on the next fetch. */
      next_offset: number;
      /** Heuristic: a full RAW page means a next page may exist (the
       *  gateway's pagination envelope carries no has_more for messages). */
      has_more: boolean;
      messages: TranscriptMessage[];
    }
  | { ok: false; status: number; error: string; reason: string };

/** Clamp the viewer's raw offset/limit query params to the bounded range.
 *  Anything non-integer/negative falls to 0/default (fail-quiet, never an
 *  error page for a typo in the URL). */
export function clampTranscriptPage(offsetRaw: unknown, limitRaw: unknown): { offset: number; limit: number } {
  const o = Number(offsetRaw);
  const offset = Number.isInteger(o) && o >= 0 ? Math.min(o, TRANSCRIPT_OFFSET_MAX) : 0;
  const l = Number(limitRaw);
  const limit = Number.isInteger(l) && l >= 1 ? Math.min(l, TRANSCRIPT_PAGE_MAX) : TRANSCRIPT_PAGE_DEFAULT;
  return { offset, limit };
}

/**
 * Sanitize ONE gateway message row (the `_message_response` safe-keys). A
 * row without a usable role is dropped whole — it cannot render, and a
 * dropped row never poisons the page. Every other member is checked
 * individually: bad member → dropped, rest kept.
 */
export function sanitizeTranscriptMessage(raw: unknown): TranscriptMessage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  const role = typeof m.role === 'string' ? m.role.trim().slice(0, 64) : '';
  if (!role) return undefined;
  const out: TranscriptMessage = { role };
  if (typeof m.id === 'number' && Number.isInteger(m.id) && m.id >= 0) out.id = m.id;
  if (typeof m.content === 'string' && m.content !== '') {
    if (m.content.length > TRANSCRIPT_CONTENT_CAP) {
      out.content = m.content.slice(0, TRANSCRIPT_CONTENT_CAP);
      out.content_truncated = true;
    } else {
      out.content = m.content;
    }
  }
  if (typeof m.tool_name === 'string' && m.tool_name.trim() !== '') {
    out.tool_name = m.tool_name.trim().slice(0, TRANSCRIPT_TOOL_NAME_CAP);
  }
  if (Array.isArray(m.tool_calls)) {
    const calls: { name: string; arguments?: string }[] = [];
    for (const c of m.tool_calls.slice(0, TRANSCRIPT_TOOL_CALLS_MAX)) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
      const fn = (c as { function?: unknown }).function;
      const name =
        fn && typeof fn === 'object' && typeof (fn as { name?: unknown }).name === 'string'
          ? (fn as { name: string }).name.trim().slice(0, TRANSCRIPT_TOOL_NAME_CAP)
          : '';
      if (!name) continue;
      const args = (fn as { arguments?: unknown }).arguments;
      const entry: { name: string; arguments?: string } = { name };
      if (typeof args === 'string' && args !== '') entry.arguments = args.slice(0, TRANSCRIPT_TOOL_ARGS_CAP);
      calls.push(entry);
    }
    if (calls.length > 0) out.tool_calls = calls;
    if (m.tool_calls.length > TRANSCRIPT_TOOL_CALLS_MAX) out.tool_calls_truncated = true;
  }
  if (typeof m.token_count === 'number' && Number.isInteger(m.token_count) && m.token_count >= 0) {
    out.token_count = m.token_count;
  }
  if (typeof m.finish_reason === 'string' && m.finish_reason.trim() !== '') {
    out.finish_reason = m.finish_reason.trim().slice(0, TRANSCRIPT_FINISH_REASON_CAP);
  }
  const ts = toEpochMs(m.timestamp);
  if (ts !== undefined) out.timestamp = ts;
  return out;
}

// ---------------------------------------------------------------------------
// #85 slice D: HERMES JOBS — Hermes' OWN scheduled jobs (`GET /api/jobs`),
// the read-plane visibility strip so the operator sees Hermes cron beside
// idlefill's cycles. NAMING (the hard rule): these are HERMES jobs
// everywhere — the wire key is `hermes_jobs`, every identifier here says
// Hermes — idlefill has its own job concept (queue/lease jobs) and the
// collision is the named hazard. READ-ONLY: the connector NEVER touches the
// gateway's POST/PATCH/DELETE or pause/resume/run verbs (they stay outside
// this issue). Fetch: at most ONE bounded `GET /api/jobs?include_disabled=
// true` per profile per connector round (inside the existing poll round —
// never per page render, never bulk-polled); zero requests while the
// gateway is down or the profile is unkeyed/disabled. include_disabled so
// PAUSED jobs stay visible (the enabled/state bits carry the pause; the
// default listing hides them — an operator strip must not lose the frozen
// cron).
//
// Live shape (verified at build, gateway 0.21.x, read-only curl with the
// operator's default-profile key): `GET /api/jobs` → `{jobs:[record…]}`;
// a record carries id (`[a-f0-9]{12}`), name, prompt (HUNDREDS of chars —
// NEVER published), schedule (object `{kind,expr,display}`; legacy records
// may carry a bare cron string), schedule_display (derived display string),
// repeat `{times,completed}`, enabled (bool), state (`scheduled|paused|
// completed|error`), created_at/next_run_at/last_run_at (ISO-8601 with
// offset), last_status, deliver, workdir, script, and a latest_execution
// record (pids, process ids, error text). The sanitizer projects ONLY the
// safe display members (names-only style caps — the slice-B discipline):
// id, profile, name, schedule text, enabled, state, last_run/next_run
// (epoch-ms). The prompt, deliver target, workdir/script, error texts and
// execution records NEVER ride the wire.
// ---------------------------------------------------------------------------

/** Count caps: per-profile rows (the cron store is small; a hostile/buggy
 *  list cannot bloat a heartbeat) and the total published rows. */
export const JOBS_MAX_PER_PROFILE = 50;
export const JOBS_MAX_TOTAL = 100;
/** Per-member string caps (drop-don't-poison, rowToMeta posture). */
export const JOB_PROFILE_CAP = 64;
export const JOB_ID_CAP = 64; // the live gateway id class is 12 hex chars
export const JOB_NAME_CAP = 128;
export const JOB_SCHEDULE_CAP = 128;
export const JOB_STATE_CAP = 32;

/** One sanitized Hermes job row — ONLY the safe display members. `profile`
 *  carries the owning Hermes profile (the strip attributes rows by it);
 *  `last_run`/`next_run` are epoch-ms (the gateway stores ISO-8601). */
export interface HermesJobRow {
  profile?: string;
  id: string;
  name?: string;
  schedule?: string;
  enabled?: boolean;
  state?: string;
  last_run?: number;
  next_run?: number;
}

/** The URL path for a profile's Hermes jobs: `default` = the home store
 *  (no prefix); a named profile = the gateway's per-profile mirror
 *  (verified live: unkeyed mirrors 401, the per-profile key rule holds). */
export function jobsPath(profile: string): string {
  return profile === 'default' ? '/api/jobs' : `/p/${encodeURIComponent(profile)}/api/jobs`;
}

/** The gateway stores job timestamps as ISO-8601 strings (with offset);
 *  legacy/other shapes may carry epoch numbers. Anything unparsable or
 *  out of a sane epoch range is dropped (never a fake zero on the strip). */
function isoToEpochMs(v: unknown): number | undefined {
  if (typeof v === 'number') return toEpochMs(v);
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const t = Date.parse(v.trim());
  if (!Number.isFinite(t) || t <= 0) return undefined;
  return t;
}

/**
 * Sanitize ONE Hermes job record into a published row. A record without a
 * usable id is dropped whole (it cannot be attributed). Every member is
 * checked individually — a malformed member is DROPPED, the rest are kept.
 * The prompt, deliver target, workdir/script, error texts and the
 * latest_execution record are NEVER projected: this is a names-only strip,
 * not a job dump.
 */
export function sanitizeHermesJob(raw: unknown, profile: string): HermesJobRow | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const j = raw as Record<string, unknown>;
  const id = typeof j.id === 'string' ? j.id.trim().slice(0, JOB_ID_CAP) : '';
  if (id === '') return undefined;
  const out: HermesJobRow = { id };
  const prof = typeof profile === 'string' ? profile.trim().slice(0, JOB_PROFILE_CAP) : '';
  if (prof !== '') out.profile = prof;
  if (typeof j.name === 'string' && j.name.trim() !== '') out.name = j.name.trim().slice(0, JOB_NAME_CAP);
  // Schedule text: the derived `schedule_display` wins (the gateway's own
  // human form); fall back schedule.display → schedule.expr → a legacy
  // bare-string schedule.
  let sched: string | undefined;
  if (typeof j.schedule_display === 'string' && j.schedule_display.trim() !== '') sched = j.schedule_display.trim();
  else if (j.schedule && typeof j.schedule === 'object' && !Array.isArray(j.schedule)) {
    const s = j.schedule as Record<string, unknown>;
    if (typeof s.display === 'string' && s.display.trim() !== '') sched = s.display.trim();
    else if (typeof s.expr === 'string' && s.expr.trim() !== '') sched = s.expr.trim();
  } else if (typeof j.schedule === 'string' && j.schedule.trim() !== '') sched = j.schedule.trim();
  if (sched !== undefined) out.schedule = sched.slice(0, JOB_SCHEDULE_CAP);
  if (typeof j.enabled === 'boolean') out.enabled = j.enabled;
  if (typeof j.state === 'string' && j.state.trim() !== '') out.state = j.state.trim().slice(0, JOB_STATE_CAP);
  const lastRun = isoToEpochMs(j.last_run_at);
  if (lastRun !== undefined) out.last_run = lastRun;
  const nextRun = isoToEpochMs(j.next_run_at);
  if (nextRun !== undefined) out.next_run = nextRun;
  return out;
}

/** The ledger join key's canonical shape (same rule `rowToMeta` applies to a
 *  row's id): trim, cap. A gate-captured header id is normalized the same way
 *  so a whitespace/padding difference never mis-joins. */
function normalizeSessionId(v: string | undefined): string {
  return typeof v === 'string' ? v.trim().slice(0, 128) : '';
}

const INT_META_KEYS = ['message_count', 'tool_call_count', 'input_tokens', 'output_tokens', 'reasoning_tokens'] as const;

/**
 * Convert a ledger timestamp to epoch-ms. The Hermes ledger stores
 * epoch-SECONDS (float) in its rows; the heuristic keeps both shapes
 * honest: a value ≥ 1e12 is already ms, a value < 1e12 is seconds.
 */
function toEpochMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v >= 1e12 ? Math.round(v) : Math.round(v * 1000);
}

/**
 * Turn ONE raw ledger row into a sanitized `hermes_meta` block. A row
 * without a usable `id` is dropped whole (it cannot join a session row).
 * Each member is checked individually — a malformed member is DROPPED,
 * the rest are kept (the drop-don't-poison rule of every other
 * client-published block in this codebase). Returns undefined for a
 * row that yields no members at all.
 */
export function rowToMeta(row: GatewaySessionRow): { id: string; meta: HermesSessionMeta } | undefined {
  const id = normalizeSessionId(typeof row.id === 'string' ? row.id : undefined);
  if (!id) return undefined;
  const meta: HermesSessionMeta = {};
  const str = (k: 'title' | 'model', cap: number): void => {
    if (typeof row[k] === 'string' && (row[k] as string).trim() !== '') meta[k] = (row[k] as string).trim().slice(0, cap);
  };
  str('title', 256);
  str('model', 128);
  for (const k of INT_META_KEYS) {
    const v = row[k];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) meta[k] = v;
  }
  const cost = row.estimated_cost_usd;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) meta.estimated_cost_usd = cost;
  const lastActive = toEpochMs(row.last_active);
  if (lastActive !== undefined) meta.last_active = lastActive;
  if (row.ended_at !== undefined) {
    if (row.ended_at === null) meta.ended_at = null;
    else {
      const t = toEpochMs(row.ended_at);
      if (t !== undefined) meta.ended_at = t;
    }
  }
  if (typeof row.end_reason === 'string' && row.end_reason.trim() !== '') meta.end_reason = row.end_reason.trim().slice(0, 64);
  if (Object.keys(meta).length === 0) return undefined;
  return { id, meta };
}

const META_KEYS: (keyof HermesSessionMeta)[] = [
  'title',
  'model',
  'message_count',
  'tool_call_count',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'estimated_cost_usd',
  'last_active',
  'ended_at',
  'end_reason',
];

/**
 * Last-known-wins member merge: an incoming member REPLACES the stored
 * one (including explicit `null` for `ended_at`/`end_reason` — the row
 * ended); an ABSENT incoming member (undefined) keeps the stored value
 * (the ledger row did not carry it this poll). This is the merge the
 * connector applies per session id across profiles and across polls —
 * a poll that loses a row never erases what a better poll reported.
 */
export function mergeHermesMeta(existing: HermesSessionMeta | undefined, incoming: HermesSessionMeta): HermesSessionMeta {
  const out: HermesSessionMeta = { ...(existing ?? {}) };
  for (const k of META_KEYS) {
    const v = incoming[k];
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Merge one fetch round into the last-known ledger map. `rows` maps
 * session id → the freshest row seen THIS round (multiple profiles can
 * carry the same id — the one with the newer `last_active` wins the
 * round). Malformed rows are dropped. Returns the updated map (a new
 * object; the caller swaps the reference).
 */
export function mergeLedgerRows(last: Map<string, HermesSessionMeta>, rows: Map<string, GatewaySessionRow>): Map<string, HermesSessionMeta> {
  const out = new Map(last);
  for (const [id, row] of rows) {
    const m = rowToMeta(row);
    if (!m) continue;
    out.set(id, mergeHermesMeta(out.get(id), m.meta));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The connector (daemon-side)
// ---------------------------------------------------------------------------

type FetchImpl = typeof fetch;

/** The gateway's error envelope (`_error_response`: `{error:{message,code,
 *  type}}`, or a bare string on some paths) → one bounded complaint string
 *  for the operator's toast. Malformed/absent ⇒ '' (the caller falls back
 *  to the status). */
function gatewayErrorMessage(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const e = (parsed as { error?: unknown }).error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim() !== '') return m;
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string' && c.trim() !== '') return c;
  }
  return '';
}

interface ProfileFetch {
  profile: string;
  status: number;
  rows: GatewaySessionRow[];
}

/**
 * One ledger round against the gateway: health (unauthenticated) + ONE
 * `GET /health/detailed` per REACHABLE round (#85 slice E) + one
 * `GET .../api/sessions` per configured profile, sequential (a round
 * must never overlap the next; the in-flight guard in poll() enforces
 * it). Every failure is a fail-quiet verdict — the round never throws.
 *
 * #85 slice E: the detailed health probe runs ONLY after the health round
 * proved the server reachable, and ONLY when at least one profile carries a
 * key (the surface is authenticated). It never runs while the gateway is
 * down, so a down gateway still sees zero extra requests — byte-for-byte
 * the pre-#73 wire. A 401/403/5xx/transport failure on the detailed route
 * earns nothing: the round stands on the plain health facts alone.
 */
async function fetchRound(cfg: HermesGatewayConfig, fetchImpl: FetchImpl, nowMs: number): Promise<{
  reachable: boolean;
  version: string | undefined;
  hostFacts: HermesHostFacts | undefined;
  rows: Map<string, GatewaySessionRow>;
  /** #85 slice D: profile → the sanitized Hermes job list THIS round answered
   *  (ONLY for profiles whose GET 200'd with a well-formed envelope — a
   *  failed/401/malformed profile round adds NOTHING, the connector keeps
   *  that profile's last-known list). */
  jobs: Map<string, HermesJobRow[]>;
  fetchedAt: number;
}> {
  const rows = new Map<string, GatewaySessionRow>();
  const jobs = new Map<string, HermesJobRow[]>();
  let reachable = false;
  let version: string | undefined;
  let healthStatus: string | undefined;
  let hostFacts: HermesHostFacts | undefined;
  const base = cfg.base_url;
  const timeout = () => AbortSignal.timeout(cfg.timeout_ms);

  // Health: the ONE unauthenticated surface — proves the server is up
  // even when every authed route 401s (no key provisioned).
  try {
    const res = await fetchImpl(`${base}/v1/health`, { signal: timeout() });
    if (res.status === 200) {
      reachable = true;
      const body = (await res.json()) as { version?: unknown; status?: unknown };
      if (typeof body.version === 'string' && body.version.trim() !== '') version = body.version.trim().slice(0, 64);
      if (typeof body.status === 'string' && body.status.trim() !== '') healthStatus = body.status.trim().toLowerCase();
    }
  } catch {
    /* unreachable — fail-quiet */
  }
  if (!reachable) return { reachable, version, hostFacts, rows, jobs, fetchedAt: nowMs };

  // #85 slice E: the richer host facts, ONE request per reachable round.
  // Requires an operator key (the route is authenticated) and a key is
  // exactly what the ledger reads need too — no key ⇒ no probe (zero
  // extra requests). Any failure here is silent: the round stands on the
  // health facts alone, and an unearned summary never reaches the wire.
  const anyKey = cfg.key ?? [...cfg.profileKeys.values()][0];
  if (anyKey) {
    try {
      const res = await fetchImpl(`${base}${DETAILED_HEALTH_PATH}`, {
        headers: { authorization: `Bearer ${anyKey}` },
        signal: timeout(),
      });
      if (res.status === 200) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined; // malformed detailed body: skip silently
        }
        hostFacts = sanitizeHostFacts(body, healthStatus);
      }
    } catch {
      /* detailed probe failed (timeout/refused) — skip silently */
    }
  }

  for (const profile of cfg.profiles) {
    // A named profile uses ONLY its own key (no fallback to the default
    // home key — the keys are per-profile-scoped; a profile with no key
    // is simply not fetchable, its rows stay last-known).
    const key = profile === 'default' ? cfg.key : cfg.profileKeys.get(profile);
    if (!key) continue; // no operator key for this profile: rows stay last-known
    // #81: page the ledger. One request is capped at the gateway's own
    // 200-row maximum; follow `has_more` up to LEDGER_MAX_PAGES so a deep
    // recency window enriches every listed session, not just the freshest
    // page. A failed/short page ends THIS profile's round (fail-quiet —
    // the pages already merged stand; the rest of the round stands).
    for (let page = 0; page < LEDGER_MAX_PAGES; page++) {
      const offset = page * LEDGER_PAGE_SIZE;
      let res: Response;
      try {
        res = await fetchImpl(
          `${base}${ledgerPath(profile)}?limit=${LEDGER_PAGE_SIZE}&offset=${offset}`,
          { headers: { authorization: `Bearer ${key}` }, signal: timeout() },
        );
      } catch {
        break; // profile fetch failed (timeout/refused): the rest of the round stands
      }
      // 401: the server IS up (reachable already set from health) but this
      // key is wrong/foreign — keep the last-known rows, no meta this round.
      if (res.status === 401 || res.status === 403) break;
      if (res.status !== 200) break;
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        break;
      }
      const env = body as { data?: unknown; has_more?: unknown };
      if (!Array.isArray(env.data)) break; // malformed envelope: the round stands as-is
      for (const raw of env.data) {
        if (typeof raw !== 'object' || raw === null) continue;
        const row = raw as GatewaySessionRow;
        const m = rowToMeta(row);
        if (!m) continue;
        // Same id from two profiles (or two shifted pages): the newer `last_active` wins the round.
        const prev = rows.get(m.id);
        const prevTs = toEpochMs(prev?.last_active) ?? 0;
        const nextTs = m.meta.last_active ?? 0;
        if (!prev || nextTs >= prevTs) rows.set(m.id, row);
      }
      if (env.has_more !== true) break; // the list envelope decides: absent/false ⇒ last page
    }
  }

  // #85 slice D: HERMES JOBS — one bounded GET per keyed profile per round
  // (inside THIS round: at most once per connector cadence, never per page
  // render, never bulk-polled; zero requests while down — the unreachable
  // round returned above). GET only: the read plane never touches the
  // gateway's create/update/pause/resume/run/delete verbs (out of scope).
  for (const profile of cfg.profiles) {
    const key = profile === 'default' ? cfg.key : cfg.profileKeys.get(profile);
    if (!key) continue; // unkeyed profile ⇒ zero requests; its rows stay last-known
    let res: Response;
    try {
      res = await fetchImpl(`${base}${jobsPath(profile)}?include_disabled=true`, {
        headers: { authorization: `Bearer ${key}` },
        signal: timeout(),
      });
    } catch {
      continue; // transport failure: this profile's Hermes jobs stay last-known
    }
    if (res.status !== 200) continue; // 401/403/404/5xx: stay last-known (an unregistered mirror 404s — verified live)
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      continue;
    }
    const env = body as { jobs?: unknown };
    if (!Array.isArray(env.jobs)) continue; // malformed envelope: this profile stands as-is
    const list: HermesJobRow[] = [];
    for (const raw of env.jobs) {
      if (list.length >= JOBS_MAX_PER_PROFILE) break;
      const row = sanitizeHermesJob(raw, profile);
      if (row) list.push(row); // drop-don't-poison: one bad record never poisons the list
    }
    // A 200 with a well-formed envelope is the COMPLETE truth for THIS
    // profile (the gateway's list_jobs is unpaginated — verified live), so
    // it REPLACES that profile's last-known list: a deleted Hermes job
    // leaves the strip within one round instead of haunting it forever.
    // A round that did not answer leaves the stored list standing
    // (last-known-wins across rounds, merge-on-arrival per profile).
    jobs.set(profile, list);
  }
  return { reachable, version, hostFacts, rows, jobs, fetchedAt: nowMs };
}

/**
 * The daemon-side connector: holds the last-known ledger (session id →
 * meta), polls on the daemon's tick cadence, and answers the two
 * questions the heartbeat asks: `metaFor(sessionId)` (the enrichment)
 * and `snapshot()` (the host facts). `fetchImpl`/`now` are test seams.
 */
export class HermesGatewayConnector {
  private cfg: HermesGatewayConfig;
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private ledger = new Map<string, HermesSessionMeta>();
  /** #85 slice D: the last-known HERMES job list per profile (see the
   *  slice-D section + `fetchRound` for the replace-on-answer /
   *  stand-on-failure discipline). */
  private jobsByProfile = new Map<string, HermesJobRow[]>();
  /** #82: session id → the (reachable) poll round that last reported it.
   *  Bookkeeping for the ledger evictions; a parallel structure so the
   *  published `HermesSessionMeta` shape never changes. */
  private readonly lastSeenRound = new Map<string, number>();
  /** Reachable-round counter (an unreachable round never advances it). */
  private ageRound = 0;
  private reachable = false;
  private version: string | undefined;
  /** #85 slice E: the last earned host-facts summary (undefined = never
   *  earned: no detailed request, a non-200, or a body that adds nothing
   *  beyond the plain health facts). */
  private hostFacts: HermesHostFacts | undefined;
  private fetchedAt: number | null = null;
  private inFlight = false;
  private lastError: string | undefined;
  private lastPollAt = 0;
  /** False until the first poll round has run: before that the
   *  connector publishes NOTHING (a not-yet-polled connector must not
   *  report `reachable: false` — that is the exception-only "gateway
   *  down" badge, and only a poll that found it down may set it). */
  private polled = false;

  constructor(cfg: HermesGatewayConfig, opts: { fetchImpl?: FetchImpl; now?: () => number; log?: (msg: string) => void } = {}) {
    this.cfg = cfg;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** One poll round (the daemon's tick fires it fire-and-forget). Never
   *  throws; overlapping rounds are skipped, and the ledger poll honors
   *  the configured `poll_seconds` cadence (the daemon tick is shorter). */
  async poll(): Promise<void> {
    if (!this.cfg.enabled || this.inFlight) return;
    const nowMs = this.now();
    if (nowMs - this.lastPollAt < this.cfg.poll_seconds * 1000 - 500) return;
    this.lastPollAt = nowMs;
    this.inFlight = true;
    try {
      const round = await fetchRound(this.cfg, this.fetchImpl, this.now());
      this.polled = true;
      this.reachable = round.reachable;
      if (round.version) this.version = round.version;
      // #85 slice E: a round that earned nothing publishes nothing (the
      // arbiter's stored block stands — absent never clears), so keeping
      // the last summary is only meaningful while the gateway is up; the
      // snapshot gate (`reachable && hostFacts`) is the real wire guard.
      this.hostFacts = round.hostFacts;
      this.ledger = mergeLedgerRows(this.ledger, round.rows);
      // #85 slice D: apply this round's HERMES job answers (only profiles
      // that answered are in the map — see `fetchRound`; a profile that
      // failed/401'd/malformed this round keeps its last-known list).
      for (const [profile, list] of round.jobs) this.jobsByProfile.set(profile, list);
      // #82: only a REACHABLE round ages the ledger (an outage never evicts).
      if (round.reachable) this.pruneLedger(round.rows);
      // #83: a fresh REACHABLE round reopens the per-round lookup budget. An
      // unreachable round changes nothing (no lookups are scheduled while
      // down, and the budget spent before the outage is not the concern).
      if (round.reachable) this.roundMissIds = new Set();
      this.fetchedAt = round.fetchedAt;
      if (!round.reachable && this.lastError !== 'unreachable') {
        this.lastError = 'unreachable';
        this.log('hermes gateway unreachable — enrichment off (gate untouched, fail-quiet)');
      } else if (round.reachable && this.lastError === 'unreachable') {
        this.lastError = undefined;
        this.log(`hermes gateway reachable again (v${this.version ?? '?'}, ${this.ledger.size} session rows known)`);
      }
    } catch (err) {
      // Contractually unreachable (fetchRound never throws), but a seam
      // surprise must not break the tick either way.
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * #82: bound the last-known ledger, called after a REACHABLE round only.
   * Stamps the round every id the round actually reported (rows that yield
   * no meta stamp nothing — same drop rule as `mergeLedgerRows`), then:
   *   1. drops entries whose stored meta carries `ended_at` (a number or an
   *      explicit null — both mean the Hermes row ended; an ended session
   *      can never re-activate its ledger row) AND which have not been
   *      seen for LEDGER_EVICTION_GRACE_ROUNDS consecutive reachable
   *      rounds — a transient page miss inside the grace never evicts;
   *   2. if the map is still over LEDGER_MAX_ENTRIES, drops the
   *      least-recently-seen entries to the cap (oldest-`lastSeen` first,
   *      the SESSION_ID_INDEX_MAX posture).
   * Fail-quiet direction: an evicted id makes `metaFor` answer undefined,
   * `hermes_meta` rides the heartbeat ABSENT, and an absent key never
   * clears the arbiter's stored block — eviction cannot erase history.
   */
  private pruneLedger(seenRows: Map<string, GatewaySessionRow>): void {
    const round = ++this.ageRound;
    for (const [id, row] of seenRows) {
      if (rowToMeta(row)) this.lastSeenRound.set(id, round);
    }
    for (const [id, meta] of this.ledger) {
      const seen = this.lastSeenRound.get(id) ?? 0;
      const ended = meta.ended_at !== undefined; // number OR explicit null
      if (ended && round - seen >= LEDGER_EVICTION_GRACE_ROUNDS) {
        this.ledger.delete(id);
        this.lastSeenRound.delete(id);
      }
    }
    if (this.ledger.size > LEDGER_MAX_ENTRIES) {
      const oldestFirst = [...this.lastSeenRound.keys()].sort(
        (a, b) => (this.lastSeenRound.get(a) ?? 0) - (this.lastSeenRound.get(b) ?? 0),
      );
      let excess = this.ledger.size - LEDGER_MAX_ENTRIES;
      for (const id of oldestFirst) {
        if (excess <= 0) break;
        if (this.ledger.delete(id)) {
          this.lastSeenRound.delete(id);
          excess--;
        }
      }
    }
  }

  /** The enrichment for one gate session (its captured `session_id`).
   *  undefined = publish NOTHING (absent = unset): connector disabled,
   *  gateway unreachable, or the id is not in the last-known ledger.
   *  #83: a MISS (reachable + enabled) also schedules ONE bounded
   *  single-session lookup — delegate/subagent children never appear in the
   *  default listing, so their ids could otherwise never enrich. The lookup
   *  never changes THIS answer (still undefined until a later heartbeat
   *  finds the merged row); the publish stays last-known-wins. */
  metaFor(sessionId: string | undefined): HermesSessionMeta | undefined {
    if (!this.cfg.enabled || !sessionId || !this.reachable) return undefined;
    const id = normalizeSessionId(sessionId);
    if (!id) return undefined;
    const hit = this.ledger.get(id);
    if (hit) return hit;
    this.missEnrich(id);
    return undefined;
  }

  /**
   * #83 bookkeeping for the per-id miss lookups: session id → attempts spent
   * + the attempt clock (throttle), and the in-flight dedup set. The
   * bookkeeping map is size-capped (oldest record evicted first — the
   * SESSION_ID_INDEX_MAX posture) so a flood of unknown ids cannot grow it.
   */
  private readonly singleAttempts = new Map<string, { attempts: number; lastAt: number }>();
  private readonly singleInFlight = new Set<string>();
  /** #83 negative cache: ids whose walk found an EXPLICIT 404 from every
   *  keyed profile — the gateway answered definitively "no such session", so
   *  the same id is never fetched again (insertion-ordered Set, size-capped
   *  with the oldest entry dropped, the SESSION_ID_INDEX_MAX posture). Only
   *  an ambiguous walk (transport failure, 401, malformed body) leaves an id
   *  out of this cache so it can retry under the throttle. */
  private readonly singleNotFound = new Set<string>();
  /** #83 per-round cap: the distinct ids scheduled for a single-session
   *  lookup since the last REACHABLE poll round (reset every round, so a
   *  flood of unknown ids can never exceed SINGLE_LOOKUPS_PER_ROUND
   *  lookups per cadence). */
  private roundMissIds = new Set<string>();

  /** Schedule one bounded single-session lookup for a ledger miss (fire and
   *  forget; never throws outward). Guards, in order: negative cache (a
   *  cached 404 is never re-fetched), in-flight dedup, per-round cap, then
   *  the per-id throttle (≤ SINGLE_MAX_ATTEMPTS walks, ≥ SINGLE_RETRY_MS
   *  apart). */
  private missEnrich(id: string): void {
    if (this.singleNotFound.has(id)) return; // cached miss ⇒ zero HTTP, ever
    if (this.singleInFlight.has(id)) return;
    if (this.roundMissIds.size >= SINGLE_LOOKUPS_PER_ROUND && !this.roundMissIds.has(id)) return;
    const nowMs = this.now();
    const rec = this.singleAttempts.get(id);
    if (rec && (rec.attempts >= SINGLE_MAX_ATTEMPTS || nowMs - rec.lastAt < SINGLE_RETRY_MS)) return;
    this.roundMissIds.add(id);
    this.singleAttempts.set(id, { attempts: (rec?.attempts ?? 0) + 1, lastAt: nowMs });
    if (this.singleAttempts.size > SINGLE_TRACKED_MAX) {
      const oldest = this.singleAttempts.keys().next();
      if (!oldest.done) this.singleAttempts.delete(oldest.value);
    }
    this.singleInFlight.add(id);
    void this.lookupSingle(id);
  }

  /** Probe the single-session route per KEYED profile (the gate header
   *  carries the session id only, so the owning profile is unknown; profiles
   *  are probed in config order, first exact hit wins). Every failure is
   *  fail-quiet: a transport error ends the probe, a 401/404/non-200/malformed
   *  answer moves to the next profile; the attempt already stands against
   *  the throttle either way.
   *  #83 result cache: if EVERY keyed profile answered an explicit 404 the id
   *  is cached NOT FOUND (never re-fetched — the gateway gave a definitive
   *  answer). An ambiguous walk (transport failure, a 401/403, a malformed
   *  body, a foreign id in the answer) does NOT cache: the id stays eligible
   *  for its remaining bounded attempt. */
  private async lookupSingle(id: string): Promise<void> {
    let everyKeyedProfileSaidNotFound = true;
    let keyedProfileCount = 0;
    try {
      for (const profile of this.cfg.profiles) {
        const key = profile === 'default' ? this.cfg.key : this.cfg.profileKeys.get(profile);
        if (!key) continue; // unkeyed profile: not addressable, no request
        keyedProfileCount++;
        let res: Response;
        try {
          res = await this.fetchImpl(`${this.cfg.base_url}${sessionPath(profile, id)}`, {
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(this.cfg.timeout_ms),
          });
        } catch {
          return; // transport failure: fail-quiet, ambiguous — never cached
        }
        if (res.status === 404) continue; // definitive miss for THIS profile
        everyKeyedProfileSaidNotFound = false;
        if (res.status !== 200) continue; // 401/403/5xx: try the next keyed profile
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          continue;
        }
        // Payload shape (verified in api_server.py `_handle_get_session`):
        // `{object:'hermes.session', session:{…safe-keys…}}` — the same
        // sanitizer the listing rows pass, so `rowToMeta` applies verbatim.
        const session = (body as { session?: unknown } | undefined)?.session;
        if (typeof session !== 'object' || session === null) continue;
        const m = rowToMeta(session as GatewaySessionRow);
        if (!m || m.id !== id) continue; // answered a different row: drop
        this.ledger.set(id, mergeHermesMeta(this.ledger.get(id), m.meta));
        // Stamp the eviction bookkeeping with the CURRENT reachable-round so
        // the single-sourced row ages like any other (#82 posture: an ended
        // child evicts after the grace; the hard cap can still LRU it).
        this.lastSeenRound.set(id, this.ageRound);
        this.log(`hermes single-session lookup enriched ${id} (profile ${profile})`);
        return;
      }
      if (keyedProfileCount > 0 && everyKeyedProfileSaidNotFound) {
        this.singleNotFound.add(id);
        if (this.singleNotFound.size > SINGLE_TRACKED_MAX) {
          const oldest = this.singleNotFound.keys().next();
          if (!oldest.done) this.singleNotFound.delete(oldest.value);
        }
        this.log(`hermes single-session lookup: ${id} not found (cached, no re-fetch)`);
      }
    } finally {
      this.singleInFlight.delete(id);
    }
  }

  /**
   * #85 slice A: the ON-DEMAND transcript page for one exact session id.
   *
   * Walk posture (the #83 probe walk, applied to the messages route): the
   * profiles are tried in config order and the FIRST profile that answers
   * 200 wins; an explicit 404 from one profile ("not in THIS profile's
   * ledger") moves to the next keyed profile; a 401/403/5xx or a malformed
   * body is ambiguous and also moves on; a transport failure (refused /
   * timeout) ends the walk with a 503-class refusal.
   *
   * Refusal honesty (the #83 walk verdicts): the named 404 `session_not_found`
   * is answered ONLY when EVERY keyed profile gave an explicit 404 (a
   * definitive "not in this profile"). A walk that met only 401/403/5xx or
   * malformed bodies is ambiguous — the gateway never said "no such session" —
   * and answers the named 503-class `gateway_ambiguous` instead of a false 404.
   *
   * Zero-request guarantees (the fail-open rule): the connector is disabled,
   * the session id is malformed, or NO profile carries a key ⇒ the walk
   * never issues a single HTTP request. Nothing here is ever polled, cached
   * into the ledger, or published: the answer is returned straight to the
   * loopback viewer and goes nowhere else.
   */
  async fetchTranscript(sessionId: string | undefined, offsetRaw: unknown, limitRaw: unknown): Promise<TranscriptResult> {
    const id = normalizeSessionId(sessionId);
    if (!id) return { ok: false, status: 400, error: 'session id required', reason: 'invalid_session_id' };
    if (!this.cfg.enabled) {
      return { ok: false, status: 503, error: 'hermes gateway connector is disabled', reason: 'connector_disabled' };
    }
    const { offset, limit } = clampTranscriptPage(offsetRaw, limitRaw);
    const keyed: { profile: string; key: string }[] = [];
    for (const profile of this.cfg.profiles) {
      const key = profile === 'default' ? this.cfg.key : this.cfg.profileKeys.get(profile);
      if (key) keyed.push({ profile, key });
    }
    if (keyed.length === 0) {
      return {
        ok: false,
        status: 503,
        error: 'no hermes profile carries an API key — the gateway cannot be addressed',
        reason: 'no_key',
      };
    }
    let transportFailed = false;
    // #83 walk-verdict discipline: the honest 404 is reserved for a walk in
    // which EVERY keyed profile answered an explicit 404 (a definitive miss).
    // Any other posture the walk met (401/403/5xx, malformed body) is
    // ambiguous and poisons that verdict → the named 503-class refusal.
    let everyKeyedProfileSaidNotFound = true;
    for (const { profile, key } of keyed) {
      let res: Response;
      try {
        res = await this.fetchImpl(
          `${this.cfg.base_url}${transcriptPath(profile, id)}?offset=${offset}&limit=${limit}&order=oldest`,
          { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(this.cfg.timeout_ms) },
        );
      } catch {
        transportFailed = true;
        break; // gateway down: one bounded attempt per profile walk, no retry storm
      }
      if (res.status === 404) continue; // definitive miss for THIS profile: walk on
      everyKeyedProfileSaidNotFound = false; // this profile never said "no such session"
      if (res.status !== 200) continue; // 401/403/5xx: ambiguous, walk on
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        continue; // malformed envelope: ambiguous, walk on
      }
      const env = body as { session_id?: unknown; data?: unknown } | undefined;
      if (!env || !Array.isArray(env.data)) continue; // not the envelope: ambiguous, walk on
      // Paging bookkeeping rides the RAW rows the gateway answered (a
      // sanitizer drop must never overlap or re-show on the next fetch).
      const consumed = Math.min(env.data.length, TRANSCRIPT_PAGE_MAX);
      const messages: TranscriptMessage[] = [];
      for (const raw of env.data.slice(0, TRANSCRIPT_PAGE_MAX)) {
        const m = sanitizeTranscriptMessage(raw);
        if (m) messages.push(m); // drop-don't-crash: a bad row never poisons the page
      }
      const saidId = typeof env.session_id === 'string' ? env.session_id.trim().slice(0, 128) : '';
      return {
        ok: true,
        profile,
        session_id: saidId !== '' ? saidId : id,
        offset,
        limit,
        returned: messages.length,
        next_offset: offset + consumed,
        has_more: consumed >= limit,
        messages,
      };
    }
    if (transportFailed) {
      return {
        ok: false,
        status: 503,
        error: 'hermes gateway unreachable — transcript unavailable',
        reason: 'gateway_unreachable',
      };
    }
    if (everyKeyedProfileSaidNotFound) {
      return {
        ok: false,
        status: 404,
        error: `no hermes profile holds session ${id} — every keyed profile answered 404`,
        reason: 'session_not_found',
      };
    }
    return {
      ok: false,
      status: 503,
      error: 'no keyed profile answered the transcript definitively — 401/403/5xx or malformed bodies only',
      reason: 'gateway_ambiguous',
    };
  }

  /** The host facts for the client register heartbeat (ADD-keys).
   *  undefined = publish NOTHING (the pre-#73 heartbeat body): the
   *  connector is disabled, or no poll round has run yet. After a round:
   *  `reachable:false` rides only when the gateway is DOWN (the
   *  exception-only "gateway down" badge); an enabled + reachable
   *  gateway publishes `version` + `reachable:true`, plus `hostFacts`
   *  (#85 slice E) ONLY when the `/health/detailed` payload earned a
   *  summary — otherwise the snapshot is exactly the pre-#85 shape. */
  snapshot(): { version?: string; reachable: boolean; hostFacts?: HermesHostFacts } | undefined {
    if (!this.cfg.enabled || !this.polled) return undefined;
    return {
      ...(this.version ? { version: this.version } : {}),
      reachable: this.reachable,
      ...(this.reachable && this.hostFacts ? { hostFacts: this.hostFacts } : {}),
    };
  }

  /**
   * #85 slice D: the HERMES jobs block for the client register heartbeat
   * (ADD-key `hermes_jobs`). undefined = publish NOTHING (the key is
   * omitted — the arbiter keeps its stored list, and an old arbiter never
   * saw this key at all): connector disabled, no poll round run yet, or
   * every profile answered empty/nothing. Rows iterate in config order
   * (stable profile attribution) and are capped at JOBS_MAX_TOTAL.
   */
  jobsSnapshot(): HermesJobRow[] | undefined {
    if (!this.cfg.enabled || !this.polled) return undefined;
    const out: HermesJobRow[] = [];
    for (const profile of this.cfg.profiles) {
      const list = this.jobsByProfile.get(profile);
      if (!list) continue;
      for (const row of list) {
        if (out.length >= JOBS_MAX_TOTAL) return out;
        out.push(row);
      }
    }
    return out.length > 0 ? out : undefined;
  }

  /** Test/inspection seam: the last-known ledger size. */
  get ledgerSize(): number {
    return this.ledger.size;
  }

  /**
   * #85 slice G: the operator-driven session LIFECYCLE verb. PATCH
   * `.../api/sessions/{id}` with ONLY the client-safe flags (title /
   * pinned / archived / hidden / unread). `end_reason` and every other
   * field are refused BY NAME here — before any HTTP request leaves the
   * process (the gateway would itself 400 `unsupported_session_field`;
   * verified in api_server.py `_handle_patch_session` — we refuse earlier,
   * and `end_reason` never gets the chance to end a live row).
   *
   * Owning-profile resolution is the #83 probe walk — the exact slice-A
   * `fetchTranscript` posture: keyed profiles are tried in config order,
   * the FIRST whose exact-id GET answers 200 owns the row, and the PATCH
   * lands on that SAME profile exactly ONCE per call (the verb never
   * retries — one deliberate click, one PATCH). A transport failure ends
   * the walk immediately: one bounded attempt, no retry storm.
   *
   * Refusal honesty (the slice-A walk verdicts): the named 404
   * `session_not_found` answers ONLY when EVERY keyed profile gave an
   * explicit 404 (a definitive "not in this profile"). A walk that met only
   * 401/403/5xx is ambiguous — the gateway never said "no such session" —
   * and answers the named 503 `gateway_ambiguous`, never a false not-found.
   * A 2xx probe whose PATCH the gateway itself rejects answers the named
   * `gateway_rejected` with the gateway's status (never retried — the row
   * was HERE, and a blind retry against a rejected write is how double
   * patches happen).
   *
   * Zero-request guarantees (the fail-open rule): disabled connector,
   * malformed id, disallowed body, or NO profile carrying a key ⇒ the walk
   * never issues a single HTTP request.
   *
   * Scope law (the #85 control-slice decision): invoked ONLY from an
   * explicit dashboard gesture — there is no automatic caller (no cycle,
   * lease, or poll path references this method). It is logged LOCALLY
   * (field NAMES only, never values — a title is conversation-adjacent)
   * and its payload is NEVER published: the verdict carries no session
   * echo, and NOTHING here touches the enrichment ledger. Writing the
   * patch into the ledger would let the new title ride the `hermes_meta`
   * heartbeat — that WOULD be publishing the verb's payload; the next
   * natural poll refreshes the row instead.
   */
  async patchLifecycle(sessionId: string, body: unknown): Promise<LifecycleResult> {
    const id = normalizeSessionId(sessionId);
    if (!id) return this.lifecycleRefuse(id, 400, 'session id required', 'invalid_session_id');
    if (!this.cfg.enabled) {
      return this.lifecycleRefuse(id, 503, 'hermes gateway connector is disabled — lifecycle unavailable', 'connector_disabled');
    }
    const v = validateLifecyclePatch(body);
    if (!v.ok) return this.lifecycleRefuse(id, 400, v.error, 'invalid_body'); // refused BEFORE any HTTP request

    const keyed: { profile: string; key: string }[] = [];
    for (const profile of this.cfg.profiles) {
      const key = profile === 'default' ? this.cfg.key : this.cfg.profileKeys.get(profile);
      if (key) keyed.push({ profile, key });
    }
    if (keyed.length === 0) {
      return this.lifecycleRefuse(id, 503, 'no hermes profile carries an API key — the gateway cannot be addressed', 'no_key');
    }

    // #83 walk-verdict discipline: the honest 404 is reserved for a walk in
    // which EVERY keyed profile answered an explicit 404 (a definitive
    // miss). Any other posture (401/403/5xx) is ambiguous and poisons that
    // verdict → the named 503-class refusal.
    let everyKeyedProfileSaidNotFound = true;
    for (const { profile, key } of keyed) {
      const url = `${this.cfg.base_url}${sessionPath(profile, id)}`;
      let probe: Response;
      try {
        probe = await this.fetchImpl(url, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(this.cfg.timeout_ms),
        });
      } catch {
        return this.lifecycleRefuse(id, 503, 'hermes gateway unreachable — the lifecycle verb made no patch', 'gateway_unreachable');
      }
      if (probe.status === 404) continue; // definitive miss for THIS profile: walk on
      everyKeyedProfileSaidNotFound = false; // this profile never said "no such session"
      if (probe.status !== 200) continue; // 401/403/5xx: ambiguous, walk on

      // The row exists in THIS profile — the PATCH lands HERE, exactly once.
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'PATCH',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(v.patch),
          signal: AbortSignal.timeout(this.cfg.timeout_ms),
        });
      } catch {
        return this.lifecycleRefuse(id, 503, 'hermes gateway became unreachable during the patch — nothing was retried', 'gateway_unreachable');
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined;
      }
      if (res.status >= 200 && res.status < 300) {
        // Local log only, and only the FIELD NAMES — the values never reach
        // the log line, the verdict, or any publish.
        this.log(`hermes lifecycle patch applied to ${id} (profile ${profile}): ${Object.keys(v.patch).join(', ')}`);
        return { ok: true, profile, session_id: id, patched: Object.keys(v.patch) };
      }
      // The gateway answered the patch non-2xx: surface its complaint
      // verbatim (bounded), never retry, never walk on (the row was HERE).
      const gwErr = gatewayErrorMessage(parsed);
      return this.lifecycleRefuse(
        id,
        res.status,
        `gateway refused the patch: ${(gwErr !== '' ? gwErr : `HTTP ${res.status}`).slice(0, 256)}`,
        'gateway_rejected',
      );
    }
    if (everyKeyedProfileSaidNotFound) {
      return this.lifecycleRefuse(id, 404, `no hermes profile holds session ${id} — every keyed profile answered 404`, 'session_not_found');
    }
    return this.lifecycleRefuse(id, 503, 'no keyed profile resolved the session definitively — 401/403/5xx answers only', 'gateway_ambiguous');
  }

  /** Refusal bookend: log LOCALLY (reason only — never the patch payload),
   *  return the named verdict the loopback route answers verbatim. */
  private lifecycleRefuse(id: string, status: number, error: string, reason: string): LifecycleResult {
    this.log(`hermes lifecycle verb refused for ${id !== '' ? id : '(no id)'}: ${reason}`);
    return { ok: false, status, error, reason };
  }

  /** Runs control (the seam, slice C) — see `HermesRunsControl`. */
  runs(): HermesRunsControl {
    return new HermesRunsControl(this.cfg, {
      fetchImpl: this.fetchImpl,
      now: this.now,
      log: this.log,
    });
  }
}

// ---------------------------------------------------------------------------
// Runs control (the seam)
// ---------------------------------------------------------------------------

/**
 * The gateway's runs surface (issue #73 slice C): `POST /v1/runs`
 * dispatches agent-shaped work INTO Hermes; the control verbs address
 * runs created through that verb. Registered routes verified in
 * `gateway/platforms/api_server_runs.py` (0.21.x): create, status,
 * events (SSE), approval, steer, stop. The seam's scope law: a control
 * verb may only address a run THIS process dispatched — the gateway
 * would refuse foreign runs anyway (ownership check), but the client
 * refuses EARLIER, without an HTTP request, so a misconfiguration can
 * never steer/stop something idlefill did not create.
 *
 * GATE NOTE (recorded, not solved): a run's provider calls pass the
 * loopback gate ONLY when the run's profile routes its session runtime
 * through the idlefill aggregate endpoint. Dispatching production work
 * before that is verified is a capacity gap — the adapter decision
 * lives with the caller, and the finding is recorded in the #73 report.
 */
export class HermesRunsControl {
  private readonly cfg: HermesGatewayConfig;
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  /** The runs THIS process created — the ONLY runs the verbs may touch. */
  private readonly owned = new Map<string, HermesRun>();

  constructor(cfg: HermesGatewayConfig, opts: { fetchImpl?: FetchImpl; now?: () => number; log?: (msg: string) => void } = {}) {
    this.cfg = cfg;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** The runs this process dispatched (audit surface; the arbiter later
   *  stores the run ids on the job/cycle record so it can address them). */
  list(): HermesRun[] {
    return [...this.owned.values()];
  }

  private prefix(profile: string): string {
    return profile === 'default' ? '' : `/p/${encodeURIComponent(profile)}`;
  }

  private async http(method: string, url: string, body?: unknown): Promise<RunResult> {
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeout_ms),
      });
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined;
      }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, body: parsed };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Dispatch a run: `POST {prefix}/v1/runs` with the prompt as `input`
   * (the gateway's contract — verified in `_handle_runs`). Returns the
   * gateway's `run_id` on success. A failed dispatch owns nothing.
   */
  async dispatch(profile: string, input: string, opts: { model?: string; session_id?: string } = {}): Promise<RunResult & { run_id?: string }> {
    const text = typeof input === 'string' ? input.trim() : '';
    if (text === '') return { ok: false, error: 'input required' };
    const body: Record<string, unknown> = { input: text };
    if (typeof opts.model === 'string' && opts.model.trim() !== '') body.model = opts.model.trim().slice(0, 128);
    if (typeof opts.session_id === 'string' && opts.session_id.trim() !== '') body.session_id = opts.session_id.trim().slice(0, 128);
    const res = await this.http('POST', `${this.cfg.base_url}${this.prefix(profile)}/v1/runs`, body);
    if (!res.ok) return { ...res, error: res.error ?? `dispatch failed (HTTP ${res.status})` };
    const runId = (res.body as { run_id?: unknown } | undefined)?.run_id;
    if (typeof runId !== 'string' || runId.trim() === '') return { ...res, error: 'dispatch returned no run_id' };
    this.owned.set(runId, { run_id: runId, profile, input: text, created_at: this.now() });
    this.log(`hermes run dispatched: ${runId} (profile ${profile})`);
    return { ...res, run_id: runId };
  }

  /** Poll a run's status: `GET {prefix}/v1/runs/{id}` (the gateway's
   *  pollable status object: `{object:'hermes.run', run_id, status, …}`). */
  async status(profile: string, runId: string): Promise<RunResult> {
    const guard = this.own(profile, runId);
    if (guard) return guard;
    return this.http('GET', `${this.cfg.base_url}${this.prefix(profile)}/v1/runs/${encodeURIComponent(runId)}`);
  }

  /** Interrupt a run: `POST {prefix}/v1/runs/{id}/stop` (a true
   *  interrupt — the turn's partial state is finalized). */
  async stop(profile: string, runId: string): Promise<RunResult> {
    const guard = this.own(profile, runId);
    if (guard) return guard;
    return this.http('POST', `${this.cfg.base_url}${this.prefix(profile)}/v1/runs/${encodeURIComponent(runId)}/stop`);
  }

  /** Steer a running run mid-turn: `POST {prefix}/v1/runs/{id}/steer`
   *  with the guidance as `input` (the gateway also accepts
   *  `message`/`text`; `input` is the create-time shape and is kept for
   *  consistency). 409 when the run is not accepting steer input. */
  async steer(profile: string, runId: string, text: string): Promise<RunResult> {
    const guard = this.own(profile, runId);
    if (guard) return guard;
    const t = typeof text === 'string' ? text.trim() : '';
    if (t === '') return { ok: false, error: 'input required' };
    return this.http('POST', `${this.cfg.base_url}${this.prefix(profile)}/v1/runs/${encodeURIComponent(runId)}/steer`, { input: t });
  }

  /** Answer a parked approval: `POST {prefix}/v1/runs/{id}/approval`
   *  with `{choice}` (the gateway normalizes aliases: approve/allow/
   *  yes/true → approve; deny/reject/no/false → deny). */
  async approval(profile: string, runId: string, choice: 'approve' | 'deny'): Promise<RunResult> {
    const guard = this.own(profile, runId);
    if (guard) return guard;
    return this.http('POST', `${this.cfg.base_url}${this.prefix(profile)}/v1/runs/${encodeURIComponent(runId)}/approval`, { choice });
  }

  /**
   * Stream a run's lifecycle events: `GET {prefix}/v1/runs/{id}/events`
   * (SSE frames: `id: N` / `event: <name>` / `data: <json>`). Resolves
   * when the stream closes (the run reached a terminal state or the
   * gateway dropped it); `onEvent` gets each parsed frame. Never throws.
   */
  async events(profile: string, runId: string, onEvent: (event: { seq?: number; name?: string; data: unknown }) => void): Promise<RunResult> {
    const guard = this.own(profile, runId);
    if (guard) return guard;
    try {
      const res = await this.fetchImpl(
        `${this.cfg.base_url}${this.prefix(profile)}/v1/runs/${encodeURIComponent(runId)}/events`,
        { signal: AbortSignal.timeout(Math.max(this.cfg.timeout_ms * 4, 30_000)) },
      );
      if (!res.ok || !res.body) return { ok: false, status: res.status, error: res.ok ? undefined : `events failed (HTTP ${res.status})` };
      const reader = res.body.getReader();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let seq: number | undefined;
          let name: string | undefined;
          const dataLines: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('id: ')) seq = Number(line.slice(4).trim());
            else if (line.startsWith('event: ')) name = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
            // `: open` comment frames and other fields are ignored
          }
          if (dataLines.length === 0) continue;
          let data: unknown;
          try {
            data = JSON.parse(dataLines.join('\n'));
          } catch {
            data = dataLines.join('\n');
          }
          onEvent({ ...(seq !== undefined && Number.isFinite(seq) ? { seq } : {}), ...(name ? { name } : {}), data });
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The scope law: refuse (no HTTP request) when the run id was not
   *  dispatched by THIS process. */
  private own(profile: string, runId: string): RunResult | undefined {
    void profile;
    if (!this.owned.has(runId)) return { ok: false, error: 'not an idlefill-dispatched run (refused without a request)' };
    return undefined;
  }
}
