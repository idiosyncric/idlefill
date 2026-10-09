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
 *
 *   B. HOST FACTS — `GET /v1/health` (unauthenticated) answers
 *      `{status, version}`. The daemon publishes `hermes_version` +
 *      `gateway_reachable` posture on its client register heartbeat,
 *      alongside `gate_posture` (the same ADD-key discipline).
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

/** One raw row of `GET .../api/sessions` (the gateway's `_session_response`). */
export type GatewaySessionRow = Record<string, unknown>;

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
  const id = typeof row.id === 'string' && row.id.trim() !== '' ? row.id.trim().slice(0, 128) : undefined;
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

interface ProfileFetch {
  profile: string;
  status: number;
  rows: GatewaySessionRow[];
}

/**
 * One ledger round against the gateway: health (unauthenticated) + one
 * `GET .../api/sessions` per configured profile, sequential (a round
 * must never overlap the next; the in-flight guard in poll() enforces
 * it). Every failure is a fail-quiet verdict — the round never throws.
 */
async function fetchRound(cfg: HermesGatewayConfig, fetchImpl: FetchImpl, nowMs: number): Promise<{
  reachable: boolean;
  version: string | undefined;
  rows: Map<string, GatewaySessionRow>;
  fetchedAt: number;
}> {
  const rows = new Map<string, GatewaySessionRow>();
  let reachable = false;
  let version: string | undefined;
  const base = cfg.base_url;
  const timeout = () => AbortSignal.timeout(cfg.timeout_ms);

  // Health: the ONE unauthenticated surface — proves the server is up
  // even when every authed route 401s (no key provisioned).
  try {
    const res = await fetchImpl(`${base}/v1/health`, { signal: timeout() });
    if (res.status === 200) {
      reachable = true;
      const body = (await res.json()) as { version?: unknown };
      if (typeof body.version === 'string' && body.version.trim() !== '') version = body.version.trim().slice(0, 64);
    }
  } catch {
    /* unreachable — fail-quiet */
  }
  if (!reachable) return { reachable, version, rows, fetchedAt: nowMs };

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
  return { reachable, version, rows, fetchedAt: nowMs };
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
  /** #82: session id → the (reachable) poll round that last reported it.
   *  Bookkeeping for the ledger evictions; a parallel structure so the
   *  published `HermesSessionMeta` shape never changes. */
  private readonly lastSeenRound = new Map<string, number>();
  /** Reachable-round counter (an unreachable round never advances it). */
  private ageRound = 0;
  private reachable = false;
  private version: string | undefined;
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
      this.ledger = mergeLedgerRows(this.ledger, round.rows);
      // #82: only a REACHABLE round ages the ledger (an outage never evicts).
      if (round.reachable) this.pruneLedger(round.rows);
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
   *  gateway unreachable, or the id is not in the last-known ledger. */
  metaFor(sessionId: string | undefined): HermesSessionMeta | undefined {
    if (!this.cfg.enabled || !sessionId || !this.reachable) return undefined;
    return this.ledger.get(sessionId);
  }

  /** The host facts for the client register heartbeat (ADD-keys).
   *  undefined = publish NOTHING (the pre-#73 heartbeat body): the
   *  connector is disabled, or no poll round has run yet. After a round:
   *  `reachable:false` rides only when the gateway is DOWN (the
   *  exception-only "gateway down" badge); an enabled + reachable
   *  gateway publishes `version` + `reachable:true`. */
  snapshot(): { version?: string; reachable: boolean } | undefined {
    if (!this.cfg.enabled || !this.polled) return undefined;
    return { ...(this.version ? { version: this.version } : {}), reachable: this.reachable };
  }

  /** Test/inspection seam: the last-known ledger size. */
  get ledgerSize(): number {
    return this.ledger.size;
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
