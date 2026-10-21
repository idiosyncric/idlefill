/**
 * Hermes turn-lease harvester (owner ask 2026-10-21): the OBSERVED answer
 * to "is a Hermes session running a tool RIGHT NOW?".
 *
 * Why a new plane. The three established surfaces can all NOT see it:
 *   - the loopback gate (EGRESS) only sees provider traffic — when the
 *     model finishes streaming the tool-call deltas the request settles,
 *     the #67 phase clears, and a tool executing locally for minutes is
 *     invisible (the mesh row renders `idle` while the agent is working);
 *   - the Gateway API (INBOUND) serves the session LEDGER — historical
 *     facts (title, tokens, end_reason, last_active). It publishes no
 *     live-status field (verified against the route serializer: the row
 *     whitelist names none);
 *   - the arbiter only echoes what clients report.
 * The ONLY local record of "a turn is in flight right now" is Hermes'
 * durable cross-process turn lease: the `session_turn_leases` table in
 * the state DB (hermes_state_common.py schema; agent/turn_facade_lease.py
 * holds it for the WHOLE run_conversation turn — model streaming AND tool
 * execution — refreshed well inside a 300s TTL, released at turn end).
 * Every platform takes it (TUI, desktop, gateway, cron, API children).
 *
 * This module READS that table, read-only, exactly as the arbiter's oMLX
 * usage reader reads that product's sqlite (server/src/omlx.ts): a
 * co-located product's own sqlite IS the truth when no API names it.
 * Fail-quiet like every sibling surface:
 *   - no Hermes home / no lease DB ⇒ `available()` is false ⇒ the daemon
 *     omits the `turn` key entirely (the arbiter keeps its stored value,
 *     the register bodies stay byte-for-byte the pre-feature shape);
 *   - a DB whose table is missing (old Hermes) or whose read fails ⇒ that
 *     DB contributes nothing; the last successful map stands;
 *   - a fact older than the stale horizon (polls stalled) is reported as
 *     NOT held (a live-state surface never keeps claiming "working" on a
 *     dead observation — unlike the last-known-wins ledger);
 *   - a lease row whose holder PID is dead (crashed agent, row inside its
 *     TTL) is treated as not held — the pid the holder string names is
 *     liveness-checked on THIS machine (the same box that owns the DB).
 *
 * What it NEVER does: write anything (PRAGMA query_only, SELECT-only),
 * log row contents, publish raw holder strings, or guess a held state for
 * a session its read never named. The dashboard's read-honestly law holds
 * end to end: `turn` rides only for the session ids the lease table
 * itself names, exact join on the gate's captured session_id.
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The `turn` ADD-key block published on the session register heartbeat.
 * Its PRESENCE (an object) = the lease table named this session with a
 * live, holder-alive row at observation time; the daemon sends explicit
 * `null` for a session the harvester read but did NOT find held (the
 * CLEAR posture, the #67 phase precedent); the key is OMITTED when the
 * harvester is off/unavailable (the ADD-key posture, hermes_meta).
 * `at` = epoch-ms of the poll that observed it (the client's clock — the
 * same box owns the lease DB, so the TTL comparison happened against the
 * right clock; surfaces age the fact from here). `platform`/`pid` are the
 * holder string's own members, reduced (never the raw string).
 */
export interface HermesTurnFact {
  at: number;
  platform?: string;
  pid?: number;
}

/** One raw row of `session_turn_leases` (untrusted until sanitized). */
export interface HermesLeaseRow {
  conversation_id: unknown;
  holder: unknown;
  expires_at: unknown;
}

export interface HermesTurnsDeps {
  log?: (msg: string) => void;
  /** Clock seam for tests. Default Date.now. */
  now?: () => number;
  /** PID liveness seam (default process.kill(pid, 0) — EPERM counts as
   *  alive, ESRCH dead). Injected in tests; NEVER a signal beyond 0. */
  pidAlive?: (pid: number) => boolean;
  /** Lease-read seam (default: open the DB read-only via node:sqlite).
   *  Returns the raw rows, or undefined when the DB/table could not be
   *  READ (the fail-quiet distinction from an empty-but-readable table). */
  readLeases?: (dbPath: string) => HermesLeaseRow[] | undefined;
  /** Poll throttle. Default 20s (the daemon tick's own cadence). */
  pollMs?: number;
  /** A fact older than this is a dead observation: reported NOT held
   *  (clear posture). Default 90s — comfortably above the poll throttle
   *  + the register heartbeat so a healthy poll stream never trips it. */
  staleAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Pure pieces (unit-tested without any file I/O)
// ---------------------------------------------------------------------------

/** Bounded printable id — the server's token-shape sanitizer mirrored on
 *  the client side (a poisoned row contributes no map entry, never a
 *  crash and never a publish). */
function cleanLeaseId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.length > 128) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7e]/.test(s)) return undefined;
  return s;
}

/**
 * Reduce a lease holder string (Hermes' `pid=NNNN:turn=…:platform=tui`)
 * to its two observable members. Missing members are absent, never
 * guessed; values outside their bounds drop the member only.
 */
export function parseHermesHolder(holder: string): { pid?: number; platform?: string } {
  const out: { pid?: number; platform?: string } = {};
  const pid = /(?:^|:)pid=(\d{1,10})(?::|$)/.exec(holder);
  if (pid) {
    const n = Number(pid[1]);
    if (Number.isInteger(n) && n > 0 && n <= 0x7fffffff) out.pid = n;
  }
  const platform = /(?:^|:)platform=([A-Za-z0-9_-]{1,32})(?::|$)/.exec(holder);
  if (platform) out.platform = platform[1];
  return out;
}

/**
 * The held map from raw rows: a row HELDS when its conversation id is a
 * clean printable id, its expires_at is a finite number past `nowMs`, its
 * holder PID (when named) is alive, and the map is not already over cap.
 * Two rows for one id ⇒ the later-expiring one wins. Rows that fail any
 * check drop individually (fail-quiet), never the whole map.
 */
export function heldTurnFacts(
  rows: HermesLeaseRow[],
  nowMs: number,
  pidAlive: (pid: number) => boolean,
  cap = 512,
): Map<string, HermesTurnFact> {
  const out = new Map<string, HermesTurnFact & { _exp?: number }>();
  const nowSec = nowMs / 1000; // the table stores REAL epoch-SECONDS
  for (const r of rows) {
    const id = cleanLeaseId(r.conversation_id);
    if (!id) continue;
    if (typeof r.expires_at !== 'number' || !Number.isFinite(r.expires_at) || r.expires_at <= nowSec) continue;
    const holder = typeof r.holder === 'string' ? r.holder : '';
    const { pid, platform } = parseHermesHolder(holder);
    if (pid !== undefined && !pidAlive(pid)) continue; // crashed holder: the TTL stands, the fact is not held
    const prev = out.get(id);
    if (prev && prev._exp! >= r.expires_at) continue;
    if (!prev && out.size >= cap) continue; // pathological table: bounded publish
    out.set(id, { at: nowMs, ...(platform ? { platform } : {}), ...(pid !== undefined ? { pid } : {}), _exp: r.expires_at });
  }
  for (const v of out.values()) delete v._exp;
  return out as Map<string, HermesTurnFact>;
}

/**
 * The lease DBs to read on this machine: the shared `~/.hermes/state.db`
 * plus every `~/.hermes/profiles/<name>/state.db` (a profile's sessions
 * live in its own DB; the shared one carries the gateway/TUI ledger —
 * both hold `session_turn_leases`). Only files that EXIST are named;
 * the profile scan is capped (a pathological home never explodes the
 * poll). Directory read failures contribute nothing (fail-quiet).
 */
export function hermesLeaseDbs(hermesHome: string, cap = 64): string[] {
  const dbs: string[] = [];
  const shared = join(hermesHome, 'state.db');
  if (existsSync(shared)) dbs.push(shared);
  try {
    for (const ent of readdirSync(join(hermesHome, 'profiles'), { withFileTypes: true }).slice(0, 512)) {
      if (dbs.length >= cap) break;
      if (!ent.isDirectory()) continue;
      const p = join(hermesHome, 'profiles', ent.name, 'state.db');
      if (existsSync(p)) dbs.push(p);
    }
  } catch {
    /* no profiles dir — the shared DB alone stands */
  }
  return dbs;
}

// ---------------------------------------------------------------------------
// The harvester
// ---------------------------------------------------------------------------

/** Read one DB's lease rows read-only. undefined = unreadable (missing
 *  table, lock past the busy timeout, old Hermes) — the fail-quiet seam,
 *  distinct from an EMPTY readable table. */
function readLeaseRows(dbPath: string): HermesLeaseRow[] | undefined {
  try {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      // Guard against any accidental write: this store belongs to Hermes.
      db.exec('PRAGMA query_only = ON');
      db.exec('PRAGMA busy_timeout = 750');
      const stmt = db.prepare('SELECT conversation_id, holder, expires_at FROM session_turn_leases');
      // Untrusted rows → the raw shape, member-by-member (the sanitizers
      // downstream are the gate; nothing here asserts the values).
      return (stmt.all() as Array<Record<string, unknown>>).map((r) => ({
        conversation_id: r['conversation_id'],
        holder: r['holder'],
        expires_at: r['expires_at'],
      }));
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export class HermesTurns {
  private readonly home: string;
  private readonly deps: Required<Pick<HermesTurnsDeps, 'now' | 'pidAlive' | 'readLeases' | 'pollMs' | 'staleAfterMs'>> & {
    log?: (msg: string) => void;
  };
  /** The last successful poll's held map (fail-quiet: a failed poll
   *  leaves the previous one standing; its `at` ages toward the stale
   *  horizon and the facts self-retire from there). */
  private facts = new Map<string, HermesTurnFact>();
  /** True once ≥1 lease DB has been READ successfully — the gate between
   *  "no report" (key omitted) and "confirmed not held" (key null). */
  private hasRead = false;
  private lastPollStart = -Infinity;
  /** The unavailable→available edge is logged once (no poll-stream spam). */
  private loggedUp = false;

  constructor(hermesHome: string, deps: HermesTurnsDeps = {}) {
    this.home = hermesHome;
    this.deps = {
      log: deps.log,
      now: deps.now ?? (() => Date.now()),
      pidAlive: deps.pidAlive ?? defaultPidAlive,
      readLeases: deps.readLeases ?? readLeaseRows,
      pollMs: deps.pollMs ?? 20_000,
      staleAfterMs: deps.staleAfterMs ?? 90_000,
    };
  }

  /**
   * One harvest round (fire-and-forget from the daemon tick, the
   * hermesGateway.poll() posture). Throttled to pollMs; a round that
   * reads no DB successfully is fail-quiet (the last map stands).
   */
  async poll(): Promise<void> {
    const now = this.deps.now();
    if (now - this.lastPollStart < this.deps.pollMs) return;
    this.lastPollStart = now;
    const dbs = hermesLeaseDbs(this.home);
    if (dbs.length === 0) return; // no Hermes lease DB on this box: nothing to report, ever
    const rows: HermesLeaseRow[] = [];
    let readOk = false;
    for (const dbPath of dbs) {
      const r = this.deps.readLeases(dbPath);
      if (r) {
        readOk = true;
        rows.push(...r);
      }
    }
    if (!readOk) return; // every read failed: keep the last map, say nothing
    this.facts = heldTurnFacts(rows, now, this.deps.pidAlive);
    if (!this.hasRead) {
      this.hasRead = true;
      if (!this.loggedUp) {
        this.loggedUp = true;
        this.deps.log?.(`hermes turn leases watched (${dbs.length} state db${dbs.length === 1 ? '' : 's'})`);
      }
    }
  }

  /** True once a lease DB has been read at least once. While false the
   *  daemon omits the `turn` key entirely (ADD-key posture). */
  available(): boolean {
    return this.hasRead;
  }

  /**
   * The register heartbeat's `turn` block for one gate session:
   *   - undefined ⇒ the harvester never read a lease DB (off / no Hermes)
   *     ⇒ the body OMITS the key — the arbiter keeps its stored value;
   *   - null ⇒ a successful read did not name this session as held (or
   *     the fact aged past the stale horizon — a dead observation never
   *     keeps claiming "working") ⇒ the body carries the explicit CLEAR;
   *   - object ⇒ the lease table named it, holder alive, TTL live at
   *     observation time.
   */
  factFor(sessionId: string | undefined): HermesTurnFact | null | undefined {
    if (!this.hasRead || !sessionId) return undefined;
    const f = this.facts.get(sessionId);
    if (!f) return null;
    if (this.deps.now() - f.at > this.deps.staleAfterMs) return null;
    return f;
  }

  /** The gate keep-alive predicate (#76 drop rule must not retire a
   *  session whose tool is running): held RIGHT NOW, per the last
   *  successful read. */
  isHeld(sessionId: string | undefined): boolean {
    return this.factFor(sessionId) != null;
  }
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: existence/permission probe only
    return true;
  } catch (err) {
    // EPERM = exists but not ours; everything else (ESRCH, EINVAL, …) = no.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
