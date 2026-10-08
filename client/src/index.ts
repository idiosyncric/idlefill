/**
 * idlefill client daemon.
 *
 * Loop:
 *   1. register (idempotent) with the arbiter — name, tailnet IP, token.
 *   2. open a WS to /api/leases/events (token as a query parameter) for live `revoked` events
 *      (the arbiter pushes {type:"revoked", lease_id, project, reason}).
 *   3. poll GET /api/state every 20s. When the system is idle (and not
 *      degraded/re-idle-gated) take the NEXT job from the project queue and
 *      POST /api/leases.
 *   4. on grant: ensure the loopback proxy is up, write the payload file,
 *      spawn the executor (bash -c, DETACHED — the child becomes the leader
 *      of its own process group, cwd from project config), and watch.
 *      The adapter spawns node grandchildren (Playwright, the eval), so
 *      every kill targets the WHOLE process group (`process.kill(-pid)`):
 *      a signal to the bash pid alone would orphan the grandchildren, and
 *      an orphaned eval's LLM traffic looks like interactive activity —
 *      it wedges the idle signal after a preemption revokes the lease.
 *      - revoked (WS or poll mismatch) → SIGINT the group, killGraceMs
 *        grace, SIGKILL the group, then POST usage {ok:false,
 *        error:"preempted"} with the tokens the proxy saw. The job stays in
 *        the queue (no finish on a revoked lease is a terminal success —
 *        the arbiter keeps it for a future grant).
 *      - timeout (per-project `timeout_seconds`, default 1200s) → the SAME
 *        escalation as preemption: SIGINT, grace, SIGKILL the group.
 *        `timedOut` stays true whenever WE initiated the kill for a
 *        timeout.
 *      - crash (exit ≠ 0): report usage {ok:false, error:executor_exit_N,
 *        error_detail:<last ≤1000 chars of the child's combined output>}
 *        AND append a failed result line (the crash is findable in
 *        results.jsonl with the child's stderr, like a clean failure); the
 *        job goes through the retry path.
 *      - clean failure: the executor exits 0 but its result line says
 *      `ok:false` (e.g. a transient extract_failed) — or exits 0 with no
 *      result file at all. Both are FAILED jobs: report
 *      usage {ok:false, error:<the result's error|no_result_file>,
 *      error_detail}, append the result line, and keep the job queued. A
 *      job is only reported ok:true and removed from the queue when the
 *      result line says ok:true.
 *      Every ok:false usage report (crash, preempt, timeout, clean
 *      failure, no_result_file) carries error_detail — the last ≤1000
 *      chars of the executor's combined output ('' when it produced none)
 *      — so a failed job's WHY survives on the arbiter.
 *      - retry policy: every failed job (clean failure, crash/exit≠0,
 *        preempt, timeout) goes back to the queue with `attempts: 1 + the
 *        attempts it already had`. When `attempts` reaches 3 the job is
 *        moved to <state_dir>/quarantine.jsonl (with its last error) and
 *        removed from the queue — it never runs again until the operator
 *        edits the files by hand.
 *
 * Usage tokens: on a SUCCESSFUL finish the result file's `tokens_out` /
 * `tokens_in` (LLM-reported) are authoritative and win; the proxy byte
 * count (bytes/4, an overestimate) is only the FALLBACK for a result that
 * lacks them. For preempted/killed jobs there is no result file — the
 * proxy estimate is the only signal and is reported as-is.
 *
 * Crash safety: the queue file is the source of truth. A restart re-registers
 * (idempotent) and resumes from the queue; a dead holder's lease is revoked
 * by the arbiter's TTL so a dead client cannot hold the box hostage.
 *
 * Logging: <client_dir>/logs/client.log, rotated at 10 MB (keep 1).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync, openSync } from 'node:fs';
import * as path from 'node:path';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { loadClientConfig, type ClientConfig, type ClientProjectConfig, type ScheduledRebuildConfig } from './config.js';
import { startLlmProxy, waitProxyReady, type LlmProxy } from './proxy.js';
import { startAggregateRouter, type AggregateAliasEntry, type AggregateCatalogEntry, type AggregateRouter, type ServerKeyRow } from './aggregate.js';
import { SessionGate, type SessionStateRow } from './session-gate.js';
import { resolveVersion } from './version.js';
import { resolveRevision } from './revision.js';

const clientDir = dirname(fileURLToPath(import.meta.url));

/**
 * Wire-protocol revision this client speaks (the version handshake). 1 =
 * the first versioned registration (name + ip + projects + version +
 * protocol). Named constant — there is no protocol history yet, and the
 * arbiter stores whatever revision the client reports (an operator can
 * refuse grants to a worker predating a required capability later; the
 * enforcement rule itself is out of scope).
 */
export const WIRE_PROTOCOL = 1;

/** This checkout's version (root package.json) — `--version` + handshake. */
const clientVersion = resolveVersion(clientDir);

/**
 * The commit this process's code was loaded from (issue #49) — computed
 * ONCE at startup, so it stays the boot identity even after the working
 * tree moves ahead (the exact staleness this reports). Undefined for a
 * non-git checkout / missing git: the field is then simply omitted from
 * the handshake (a pre-revision client stays a pre-revision client).
 */
const clientRevision = resolveRevision(clientDir);

/**
 * True when a URL's hostname is loopback (localhost, 127.0.0.0/8, ::1).
 * #61 step 3 A2 gates the client-log publication on this: log payloads
 * must never cross the mesh. Malformed URL = not loopback (fail closed).
 */
export function isLoopbackUrl(url: string): boolean {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host.startsWith('[')) host = host.slice(1, -1); // IPv6 literal [::1]
  return host === 'localhost' || host.startsWith('127.') || host === '::1';
}

// ---------------------------------------------------------------------------
// Logging (rotate at 10 MB, keep 1)
// ---------------------------------------------------------------------------

class RotatingLog {
  private readonly file: string;
  private readonly max = 10 * 1024 * 1024;
  /**
   * In-memory tail of the formatted lines this process wrote (#61 step 3
   * A2): the page's Client log dock reads it from the register heartbeat,
   * so the daemon never re-reads its own log file. Bounded (oldest dropped)
   * — the same shape the Swift LogViewer kept, minus the file offset.
   */
  private readonly ring: string[] = [];
  private static readonly RING_MAX = 120;
  private static readonly LINE_CAP = 300;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'client.log');
  }

  private maybeRotate(): void {
    try {
      if (statSync(this.file).size > this.max && existsSync(this.file)) {
        renameSync(this.file, `${this.file}.1`);
      }
    } catch {
      /* first write */
    }
  }

  line(msg: string): void {
    const stamped = `[${new Date().toISOString()}] ${msg}\n`;
    this.maybeRotate();
    try {
      appendFileSync(this.file, stamped);
    } catch {
      /* logging must never kill the daemon */
    }
    // The ring holds the formatted line (minus the trailing newline),
    // capped like the wire field, oldest-first, newest at the end.
    this.ring.push(stamped.slice(0, -1).slice(0, RotatingLog.LINE_CAP));
    if (this.ring.length > RotatingLog.RING_MAX) this.ring.splice(0, this.ring.length - RotatingLog.RING_MAX);
    const stream = process.env.IDLEFILL_CLIENT_QUIET ? undefined : process.stdout;
    if (stream) process.stdout.write(stamped);
  }

  /** Console-only line (config dump etc. that duplicates file state). */
  info(msg: string): void {
    this.line(msg);
  }

  /** A copy of the in-memory tail, oldest first (empty before any write). */
  tail(): string[] {
    return [...this.ring];
  }
}

// ---------------------------------------------------------------------------
// Queue + results file helpers (atomic writes)
// ---------------------------------------------------------------------------

export interface QueueJob {
  job_id: string;
  /**
   * How many times this job has already failed (retry policy). Absent = 0.
   * The line round-trips through readQueue/writeQueue with the field intact
   * (whole-line JSON), so a queue rebuilt by the adapter starts fresh at 0
   * while an in-flight queue accumulates the count.
   */
  attempts?: number;
  /**
   * The job's payload. The vocabulary is the adapter's: the adapter manifest
   * declares which keys reach the executor (payload_fields, issue #13). The
   * career-ops keys stay typed as optional conveniences (display fallbacks,
   * queue preview); adapters with their own vocabulary carry any keys.
   */
  payload: {
    url?: string;
    company?: string;
    title?: string;
    score?: number;
    /**
     * Per-job lease-TTL estimate in seconds (issue #6). Only a finite
     * number > 0 counts; anything else falls back to the project's
     * `estimated_seconds`. The arbiter clamps the resulting TTL to
     * [lease_ttl_floor, effective lease_ttl_seconds], so this can only
     * make a lease expire SOONER than the project default, never later.
     */
    estimated_seconds?: number;
    [k: string]: unknown;
  };
}

/**
 * The job-level TTL estimate for a lease request (issue #6): the queue
 * line's `payload.estimated_seconds` when it is a finite number > 0.
 * Strings, negatives, NaN, null, missing — all ignored (undefined), so
 * the caller falls back to the project estimate.
 */
export function jobEstimatedSeconds(job: QueueJob): number | undefined {
  const e = job.payload?.estimated_seconds;
  return typeof e === 'number' && Number.isFinite(e) && e > 0 ? e : undefined;
}

/** Preview row the client publishes for the dashboard's queue page. */
export interface QueuePreviewRow {
  job_id: string;
  /** Display title (payload.title or url when the job carries neither). */
  title: string;
  company: string;
  score: number | null;
  /** Failure-retry count so far (0 = fresh). */
  attempts: number;
}

/**
 * The first N jobs in DISPATCH order as display rows. Dispatch order is
 * priorityOrder (highest score first, ties in file order) — the same helper
 * nextJob uses — so what the dashboard's queue page shows IS the "next up"
 * list, even when the queue file's on-disk order is not score-sorted
 * (add_jobs appends to the tail). Best-effort: a missing/corrupt file
 * yields [] — the preview is display data and must never break registration.
 */
export function queuePreview(file: string, limit = 50): QueuePreviewRow[] {
  try {
    const jobs = priorityOrder(readQueue(file)).slice(0, Math.max(1, Math.min(500, limit)));
    return jobs.map((j) => {
      const pl = (j.payload ?? {}) as Record<string, unknown>;
      const title = typeof pl.title === 'string' && pl.title.trim() !== ''
        ? pl.title
        : typeof pl.url === 'string' && pl.url !== '' ? pl.url : j.job_id;
      return {
        job_id: j.job_id,
        title: title.slice(0, 200),
        company: typeof pl.company === 'string' && pl.company.trim() !== '' ? pl.company : 'unknown',
        score: typeof pl.score === 'number' && Number.isFinite(pl.score) ? pl.score : null,
        attempts: typeof j.attempts === 'number' ? j.attempts : 0,
      };
    });
  } catch {
    return [];
  }
}

/** Retry cap: a job that fails this many times is quarantined. */
export const MAX_ATTEMPTS = 3;

export function readQueue(file: string): QueueJob[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim());
  const jobs: QueueJob[] = [];
  for (const l of lines) {
    try {
      const j = JSON.parse(l) as QueueJob;
      if (j && typeof j.job_id === 'string') jobs.push(j);
    } catch {
      /* skip corrupt line */
    }
  }
  return jobs;
}

/** Atomically rewrite the queue (tmp + rename). */
export function writeQueue(file: string, jobs: QueueJob[]): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, jobs.map((j) => JSON.stringify(j)).join('\n') + (jobs.length ? '\n' : ''));
  renameSync(tmp, file);
}

/**
 * Dispatch order for a batch of queue jobs: highest payload.score first,
 * ties keep file order (FIFO tiebreak — Array.prototype.sort is stable).
 * A null/undefined/non-number score sorts last (treated as -Infinity).
 * Pure: returns a NEW array and never mutates the input — the queue file's
 * on-disk order is never rewritten (issue #2: add_jobs appends to the tail,
 * so file order alone would make `score` do nothing).
 */
export function priorityOrder(jobs: QueueJob[]): QueueJob[] {
  const scoreOf = (j: QueueJob): number => {
    const s = j.payload?.score;
    return typeof s === 'number' && Number.isFinite(s) ? s : -Infinity;
  };
  return [...jobs].sort((a, b) => {
    const sa = scoreOf(a);
    const sb = scoreOf(b);
    if (sa === sb) return 0;
    return sa > sb ? -1 : 1;
  });
}

export function nextJob(file: string): QueueJob | null {
  return priorityOrder(readQueue(file))[0] ?? null;
}

/** Number of jobs currently in the queue file (0 when missing/corrupt-free empty). */
export function queueDepth(file: string): number {
  return readQueue(file).length;
}

export function removeJob(file: string, jobId: string): boolean {
  const jobs = readQueue(file);
  const next = jobs.filter((j) => j.job_id !== jobId);
  if (next.length === jobs.length) return false;
  writeQueue(file, next);
  return true;
}

/**
 * Keep a failed job in the queue with its attempt counter bumped by one.
 * Rewrites the queue file atomically (tmp + rename), preserving line order
 * and every field on every line. Returns the new attempts count.
 */
export function bumpJobAttempts(file: string, jobId: string): number {
  const jobs = readQueue(file);
  const hit = jobs.find((j) => j.job_id === jobId);
  if (!hit) return 0;
  const attempts = (typeof hit.attempts === 'number' ? hit.attempts : 0) + 1;
  writeQueue(
    file,
    jobs.map((j) => (j.job_id === jobId ? { ...j, attempts } : j)),
  );
  return attempts;
}

/**
 * Move a job out of the queue into the quarantine file (one JSON line per
 * quarantined job: job_id, attempts, error, ts). The queue rewrite and the
 * quarantine append are both atomic enough for this use (single writer: the
 * daemon, one job at a time). Returns the attempts count the job reached.
 */
export function quarantineJob(stateDir: string, queueFile: string, job: QueueJob, error: string): number {
  const attempts = typeof job.attempts === 'number' ? job.attempts : 0;
  writeQueue(
    queueFile,
    readQueue(queueFile).filter((j) => j.job_id !== job.job_id),
  );
  appendResult(join(stateDir, 'quarantine.jsonl'), {
    job_id: job.job_id,
    attempts,
    error,
    ts: new Date().toISOString(),
  });
  return attempts;
}

/** Line count of the quarantine file (0 when missing) — published in stats. */
export function quarantineCount(stateDir: string): number {
  const f = join(stateDir, 'quarantine.jsonl');
  if (!existsSync(f)) return 0;
  return readFileSync(f, 'utf-8').split('\n').filter((l) => l.trim()).length;
}

/**
 * Today's (UTC) published stats for a project, computed by the CLIENT from
 * its own ground truth (the results file it appends to on every success).
 * The arbiter displays these verbatim — it never computes them. A result
 * line with ts on the UTC day and ok=true counts finished; any other line
 * counts failed (a failed job keeps its line for audit).
 */
export function projectStats(resultsFile: string, now = Date.now()): { finished: number; failed: number; last_job: string } {
  const day = new Date(now).toISOString().slice(0, 10);
  let finished = 0;
  let failed = 0;
  let lastJob = '';
  if (existsSync(resultsFile)) {
    const lines = readFileSync(resultsFile, 'utf-8').split('\n').filter((l) => l.trim());
    for (const l of lines) {
      try {
        const r = JSON.parse(l) as { ok?: boolean; job_id?: string; ts?: string };
        if (r && typeof r.job_id === 'string' && r.job_id) lastJob = r.job_id;
        if (typeof r.ts === 'string' && r.ts.slice(0, 10) === day) {
          if (r.ok === true) finished += 1;
          else failed += 1;
        }
      } catch {
        /* skip corrupt line */
      }
    }
  }
  return { finished, failed, last_job: lastJob };
}

export function appendResult(file: string, line: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + '\n');
}

// ---------------------------------------------------------------------------
// Scheduled queue rebuild (issue #3)
// ---------------------------------------------------------------------------

/**
 * Wall-clock cap for one scheduled rebuild command (issue #3 settled
 * decision 3): 15 min, reusing runExecutor's timeout machinery (SIGINT the
 * group, grace, SIGKILL). The command is a BLACK BOX — idlefill never
 * parses its output or the files it touches; the only contract is the exit
 * code. A timed-out rebuild records exit_code: -1 (killed by us).
 */
export const REBUILD_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The persisted run-state shape (issue #3 settled decision 5): auditable,
 * survives restarts, lives next to the queue file — never in the project
 * repo. queue_before/after are the depth counts the daemon already knows
 * (queueDepth); it never parses the rebuild command's output.
 */
export interface RebuildRunState {
  /** Epoch-ms when the run STARTED. */
  last_run_ts: number;
  /** Process exit code; -1 = killed by the daemon's timeout. */
  exit_code: number;
  duration_ms: number;
  queue_before: number;
  queue_after: number;
}

/** Run-state file path: `<queue_file>.rebuild.json` (next to the queue). */
export function rebuildStateFile(queueFile: string): string {
  return `${queueFile}.rebuild.json`;
}

/** Read the persisted rebuild state (null when missing/corrupt). */
export function readRebuildState(queueFile: string): RebuildRunState | null {
  const f = rebuildStateFile(queueFile);
  if (!existsSync(f)) return null;
  try {
    const r = JSON.parse(readFileSync(f, 'utf-8')) as Partial<RebuildRunState>;
    if (!r || typeof r !== 'object') return null;
    if (typeof r.last_run_ts !== 'number' || !Number.isFinite(r.last_run_ts)) return null;
    return {
      last_run_ts: r.last_run_ts,
      exit_code: typeof r.exit_code === 'number' && Number.isFinite(r.exit_code) ? r.exit_code : 0,
      duration_ms: typeof r.duration_ms === 'number' && Number.isFinite(r.duration_ms) ? r.duration_ms : 0,
      queue_before: typeof r.queue_before === 'number' && Number.isFinite(r.queue_before) ? r.queue_before : 0,
      queue_after: typeof r.queue_after === 'number' && Number.isFinite(r.queue_after) ? r.queue_after : 0,
    };
  } catch {
    return null;
  }
}

/** Persist the rebuild run state atomically (tmp + rename, like writeQueue). */
export function writeRebuildState(queueFile: string, st: RebuildRunState): void {
  const f = rebuildStateFile(queueFile);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n');
  renameSync(tmp, f);
}

/**
 * Cadence = MINIMUM interval since the last run (issue #3 settled decision
 * 2), evaluated against the persisted state so it survives restarts. No
 * state file (never run) = due. `daily_at` is a known follow-up.
 */
export function rebuildDue(state: RebuildRunState | null, everyMinutes: number, now: number): boolean {
  if (!state) return true;
  return now - state.last_run_ts >= everyMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// Dev cycles (issue #58): the cycles file + the cycle driver
// (docs/architecture/dev-cycles.md D1-D7 — the spike proved the machine)
// ---------------------------------------------------------------------------

/** One gate inside a cycle item: its own queue job + the rule the driver
 *  applies to the job's result line. The rule is stored VERBATIM (the Phase 2
 *  self-improvement seam, D8); an unrecognized rule never passes (D6). */
export interface CycleGateSpec {
  name: string;
  job_id: string;
  rule: string;
  /** Payload keys for the gate's queue line (merged with cycle_id + stage). */
  payload?: Record<string, unknown>;
}

/** One work item inside a cycle: its queue job + the gates that follow it. */
export interface CycleItemSpec {
  job_id: string;
  gates: CycleGateSpec[];
  /** Payload keys for the item's queue line (merged with cycle_id + stage). */
  payload?: Record<string, unknown>;
}

/** The persisted cursor: current item index + current stage within the item. */
export interface CycleCursor {
  item: number;
  stage: 'item' | 'gate';
  gate: number;
}

/** One cycle row in the cycles file (D4 — the minimum for a restart to
 *  resume mid-series; the driver rebuilds everything else from ground truth). */
export interface CycleRow {
  cycle_id: string;
  project: string;
  status: 'planned' | 'running' | 'paused' | 'done';
  items: CycleItemSpec[];
  cursor: CycleCursor;
  verdicts: Record<string, 'passed' | 'quarantined'>;
}

/** `<queue_file>.cycles.json` — one file per project, next to the queue,
 *  exactly the rebuildStateFile shape (D4). */
export function cyclesFile(queueFile: string): string {
  return `${queueFile}.cycles.json`;
}

/** Read the cycle rows. Missing / corrupt / non-array = null: cycles fail
 *  closed (the state.json + readRebuildState posture) and the daemon keeps
 *  draining the queue normally. */
export function readCycles(queueFile: string): CycleRow[] | null {
  const f = cyclesFile(queueFile);
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(readFileSync(f, 'utf-8')) as unknown;
    if (!Array.isArray(raw)) return null;
    return raw as CycleRow[];
  } catch {
    return null;
  }
}

/** Persist the cycle rows atomically (tmp + rename in the same directory —
 *  the writeQueue / writeRebuildState discipline). */
export function writeCycles(queueFile: string, rows: CycleRow[]): void {
  const f = cyclesFile(queueFile);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2) + '\n');
  renameSync(tmp, f);
}

/**
 * One cycle row as the register heartbeat publishes it for the dashboard's
 * cycle strip (#53 D9.3: one entry per cycle, no merged progress line).
 * Computed CLIENT-side from the project's cycles file; the arbiter stores
 * and displays it verbatim, it never computes (the last_rebuild discipline,
 * D7). `item_index` is the row's cursor.item as stored (0-based) — the
 * dashboard renders it +1 / items_total.
 */
export interface CycleStatusRow {
  cycle_id: string;
  status: 'planned' | 'running' | 'paused' | 'done';
  items_total: number;
  item_index: number;
  settled: number;
  passed: number;
  quarantined: number;
  stage: 'item' | 'gate';
}

/** Cap for the published strip: the strip is display data, not a dump. */
export const CYCLE_PUBLISH_MAX_ROWS = 20;

/**
 * The per-project cycles block for the register heartbeat (#53 D9.3 + D7
 * add-keys rule): `cycles` holds one entry per row in the cycles file, in
 * file order, and `cycle_cap` the EFFECTIVE cycle_max_in_flight (0 = the
 * knob is absent). Exception-only: null = publish NOTHING (no cycles file,
 * an empty list, or every row unusable) — exactly the queuePreview /
 * last_rebuild shape. Best-effort: this NEVER throws, whatever the file
 * holds (the cycles file reads unvalidated — readCycles fail-closes for the
 * DRIVER by returning null on a corrupt file, but a valid-JSON array of
 * junk rows still reaches here, so the row shape is guarded per row).
 */
export function publishCycles(
  queueFile: string,
  projectName: string,
  fromDir: string = clientDir,
): { cycles: CycleStatusRow[]; cycle_cap: number } | null {
  try {
    const rows = readCycles(queueFile);
    if (!rows || rows.length === 0) return null;
    const out: CycleStatusRow[] = [];
    for (const row of rows as unknown as Partial<CycleRow>[]) {
      if (out.length >= CYCLE_PUBLISH_MAX_ROWS) break;
      if (!row || typeof row !== 'object') continue;
      const cycle_id = typeof row.cycle_id === 'string' && row.cycle_id.trim() !== '' ? row.cycle_id.trim() : '';
      if (!cycle_id) continue;
      const status =
        row.status === 'planned' || row.status === 'running' || row.status === 'paused' || row.status === 'done'
          ? row.status
          : null;
      if (!status) continue;
      const itemsTotal = Array.isArray(row.items) ? row.items.length : 0;
      const cursorItem =
        typeof row.cursor?.item === 'number' && Number.isInteger(row.cursor.item) && row.cursor.item >= 0
          ? row.cursor.item
          : 0;
      const verdicts = row.verdicts && typeof row.verdicts === 'object' && !Array.isArray(row.verdicts) ? row.verdicts : {};
      let passed = 0;
      let quarantined = 0;
      for (const v of Object.values(verdicts)) {
        if (v === 'passed') passed += 1;
        else if (v === 'quarantined') quarantined += 1;
      }
      out.push({
        cycle_id,
        status,
        items_total: itemsTotal,
        item_index: cursorItem,
        settled: Object.keys(verdicts).length,
        passed,
        quarantined,
        stage: row.cursor?.stage === 'gate' ? 'gate' : 'item',
      });
    }
    if (out.length === 0) return null;
    const cap = resolveCycleMaxInFlight(projectName, fromDir);
    return { cycles: out, cycle_cap: cap ?? 0 };
  } catch {
    return null; // best-effort, like queuePreview: a bad file never breaks the heartbeat
  }
}

/**
 * The per-project `cycle_max_in_flight` knob (owner decision 1: configurable,
 * default 1). Resolved at call time from the raw client config — the typed
 * loader shape does not carry it, and the driver must never bake it.
 *
 * The key's PRESENCE is also the project's opt-in to the cycle driver — the
 * exact `scheduled_rebuild.enabled` gate shape (the maybeRunScheduledRebuilds
 * pattern): a project without the knob never has its cycles file touched by
 * the daemon. Absent = null (off). Present but not a finite number ≥ 1 = 1
 * (the owner's default cap).
 */
export function resolveCycleMaxInFlight(projectName: string, fromDir: string = clientDir): number | null {
  for (const cand of [
    join(fromDir, 'config.json'),
    join(fromDir, 'config.client.json'),
    join(dirname(fromDir), 'config.json'),
    join(dirname(fromDir), 'config.client.json'),
  ]) {
    try {
      const raw = JSON.parse(readFileSync(cand, 'utf-8')) as { projects?: unknown };
      const list = Array.isArray(raw.projects) ? (raw.projects as Record<string, unknown>[]) : [];
      const entry = list.find((p) => p && typeof p === 'object' && p.name === projectName);
      if (!entry || !('cycle_max_in_flight' in entry)) continue;
      const v = entry.cycle_max_in_flight;
      return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
    } catch {
      /* candidate missing or unreadable — try the next */
    }
  }
  return null;
}

/** Resolve a dot-path against a result line ('echo.note' → result.echo.note). */
function resolveResultPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * The gate rule (D3): the executor's ok says the check RAN; the rule decides
 * whether it PASSED. Supported forms (anything else fails closed, D6):
 *   "<path> contains <text>"  — String(value at the dot-path) includes text
 *   "<path> == <value>"       — strict string equality
 *   "ok"                      — the result line's ok === true
 */
function gatePassed(gate: CycleGateSpec, result: Record<string, unknown>): boolean {
  const rule = gate.rule.trim();
  const contains = /^(.+?)\s+contains\s+(.+)$/.exec(rule);
  if (contains) {
    const v = resolveResultPath(result, contains[1]!.trim());
    return v !== undefined && v !== null && String(v).includes(contains[2]!);
  }
  const eq = /^(.+?)\s*==\s*(.+)$/.exec(rule);
  if (eq) {
    const v = resolveResultPath(result, eq[1]!.trim());
    return String(v ?? '') === eq[2]!.trim();
  }
  if (rule === 'ok') return result.ok === true;
  return false; // an unrecognized rule never passes (fail-closed, D6)
}

/**
 * The cycle driver (D1/D7): a cursor over the existing queue / results /
 * quarantine family. One step per project per poll tick (the
 * maybeRunScheduledRebuilds pattern). Hard rules:
 *   - it NEVER spawns an executor — every stage is a queue job the lease
 *     loop runs under the normal grant path (D3);
 *   - it re-reads the cycles, queue, results, and quarantine files every
 *     step: the cursor never trusts memory (D4);
 *   - a failing gate verdict quarantines the ITEM (reason gate_<name>_failed)
 *     and skips that item's remaining gates (owner decision 3); the cursor
 *     advances and the cycle never stops (D3/D6 rule 2);
 *   - an unknown verdict parks the cursor — never advance on unknown; the
 *     retry path quarantines the stage job at MAX_ATTEMPTS and the driver
 *     records the fact and moves on (D6 rule 1);
 *   - `maxInFlight` caps how many cycle rows may hold a running (queued or
 *     leased) stage at once — a client-side driver rule (owner decision 1).
 */
export class CycleDriver {
  private readonly queueFile: string;
  private readonly resultsFile: string;
  private readonly stateDir: string;
  private readonly maxInFlight: number;

  constructor(queueFile: string, resultsFile: string, stateDir: string, maxInFlight = 1) {
    this.queueFile = queueFile;
    this.resultsFile = resultsFile;
    this.stateDir = stateDir;
    this.maxInFlight = Number.isFinite(maxInFlight) && maxInFlight >= 1 ? Math.floor(maxInFlight) : 1;
  }

  /** One driver step over every row in the project's cycles file. */
  tick(): void {
    const rows = readCycles(this.queueFile);
    if (!rows || rows.length === 0) return; // no cycles file (or corrupt): fail closed
    const queued = new Set(readQueue(this.queueFile).map((j) => j.job_id));

    const stageJobOf = (row: CycleRow): string | null => {
      const item = row.items[row.cursor.item];
      if (!item) return null;
      if (row.cursor.stage === 'item') return item.job_id;
      return item.gates[row.cursor.gate]?.job_id ?? null;
    };
    const inFlight = (): number =>
      rows.reduce((n, r) => {
        if (r.status !== 'running') return n;
        const s = stageJobOf(r);
        return s !== null && queued.has(s) ? n + 1 : n;
      }, 0);

    for (const row of rows) {
      if (row.status === 'done' || row.status === 'paused') continue;
      const stage = stageJobOf(row);
      const holds = stage !== null && queued.has(stage);
      if (!holds && inFlight() >= this.maxInFlight) continue; // admission cap
      this.stepRow(row, queued);
    }
    writeCycles(this.queueFile, rows);
  }

  /** Advance one row by reading ground truth for its current stage. */
  private stepRow(row: CycleRow, queued: Set<string>): void {
    if (row.status === 'planned') row.status = 'running'; // admitted: it starts
    const item = row.items[row.cursor.item];
    if (!item) {
      row.status = 'done';
      return;
    }

    if (row.cursor.stage === 'item') {
      if (queued.has(item.job_id)) return; // queued/running: the daemon owns it
      if (this.quarantined(item.job_id)) {
        // the retry path exhausted the item (MAX_ATTEMPTS) — no verdict needed
        row.verdicts[item.job_id] = 'quarantined';
        this.advance(row);
        return;
      }
      const res = this.lastResult(item.job_id);
      if (!res) {
        // never started (fresh cursor, or a restart mid-series): enqueue it
        this.enqueue(row, item.job_id, item.payload, 'item', queued);
        return;
      }
      if (res.ok !== true) return; // failed: the daemon re-queued it, wait
      if (item.gates.length === 0) {
        row.verdicts[item.job_id] = 'passed';
        this.advance(row);
        return;
      }
      row.cursor.stage = 'gate';
      row.cursor.gate = 0;
      const first = item.gates[0]!;
      this.enqueue(row, first.job_id, first.payload, `gate:${first.name}`, queued);
      return;
    }

    // stage === 'gate'
    const gate = item.gates[row.cursor.gate];
    if (!gate) {
      row.verdicts[item.job_id] = 'passed';
      this.advance(row);
      return;
    }
    if (queued.has(gate.job_id)) return; // queued/running: park (D6 rule 1)
    if (this.quarantined(gate.job_id)) {
      // the gate job itself exhausted its attempts: fail CLOSED for the item
      quarantineJob(this.stateDir, this.queueFile, this.itemJob(row, item), `gate_${gate.name}_exhausted`);
      row.verdicts[item.job_id] = 'quarantined';
      this.advance(row);
      return;
    }
    const res = this.lastResult(gate.job_id);
    if (!res) {
      this.enqueue(row, gate.job_id, gate.payload, `gate:${gate.name}`, queued);
      return;
    }
    if (res.ok !== true) return; // the gate job itself failed: retry path owns it
    if (!gatePassed(gate, res)) {
      // D3: the gate quarantines the ITEM, not the cycle. The item already
      // left the queue on its own success, so this append is the audit line.
      quarantineJob(this.stateDir, this.queueFile, this.itemJob(row, item), `gate_${gate.name}_failed`);
      row.verdicts[item.job_id] = 'quarantined';
      // Owner decision 3: skip the item's remaining gates. The cursor
      // advances; the cycle never stops (D6 rule 2).
      this.advance(row);
      return;
    }
    row.cursor.gate += 1;
    const next = item.gates[row.cursor.gate];
    if (next) {
      this.enqueue(row, next.job_id, next.payload, `gate:${next.name}`, queued);
    } else {
      row.verdicts[item.job_id] = 'passed';
      this.advance(row);
    }
  }

  /** The item's queue job as the quarantine audit line needs it. */
  private itemJob(row: CycleRow, item: CycleItemSpec): QueueJob {
    return { job_id: item.job_id, payload: { ...(item.payload ?? {}), cycle_id: row.cycle_id, stage: 'item' } };
  }

  /** Queue one stage's job. The payload GAINS cycle_id + stage (D7): the
   *  payload vocabulary is open ([k: string]: unknown), so this is no schema
   *  change and no wire change. */
  private enqueue(row: CycleRow, jobId: string, payload: Record<string, unknown> | undefined, stage: string, queued: Set<string>): void {
    writeQueue(this.queueFile, [...readQueue(this.queueFile), { job_id: jobId, payload: { ...(payload ?? {}), cycle_id: row.cycle_id, stage } }]);
    queued.add(jobId);
  }

  private advance(row: CycleRow): void {
    row.cursor.item += 1;
    row.cursor.stage = 'item';
    row.cursor.gate = 0;
    if (row.cursor.item >= row.items.length) row.status = 'done';
  }

  /** The LAST result line for a job_id, or null when it never settled. */
  private lastResult(jobId: string): Record<string, unknown> | null {
    if (!existsSync(this.resultsFile)) return null;
    let hit: Record<string, unknown> | null = null;
    for (const l of readFileSync(this.resultsFile, 'utf-8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l) as Record<string, unknown>;
        if (r && r.job_id === jobId) hit = r;
      } catch {
        /* skip corrupt line */
      }
    }
    return hit;
  }

  /** True when the job sits in quarantine.jsonl (retry-path exhaustion). */
  private quarantined(jobId: string): boolean {
    const f = join(this.stateDir, 'quarantine.jsonl');
    if (!existsSync(f)) return false;
    for (const l of readFileSync(f, 'utf-8').split('\n')) {
      if (!l.trim()) continue;
      try {
        if ((JSON.parse(l) as Record<string, unknown>).job_id === jobId) return true;
      } catch {
        /* skip corrupt line */
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers against the arbiter
// ---------------------------------------------------------------------------

async function api<T>(cfg: ClientConfig, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${cfg.server_url.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: T;
  try {
    parsed = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    parsed = { error: `non-JSON response: ${text.slice(0, 200)}` } as T;
  }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Executor supervision
// ---------------------------------------------------------------------------

export interface ExecOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /**
   * Last ~4000 chars of the child's combined stdout+stderr (the two streams
   * are joined with a separator when BOTH produced output). Persisted to
   * the client log for every job; the tail's last ≤1000 chars ride along as
   * `error_detail` on failure result lines.
   */
  outputTail: string;
}

/**
 * Run the executor command (bash -c) with the given cwd. `onSignal` is
 * called with 'SIGINT'/'SIGTERM' when the monitor asks the child to stop.
 * Returns when the child exits (grace period handling is the caller's
 * concern).
 *
 * The child is spawned DETACHED so it leads its own process group: the
 * adapter command (`bash -c "node eval.mjs …"`) forks node grandchildren
 * (Playwright, the eval), and a signal to the bash pid alone never reaches
 * them. Every kill here therefore targets the WHOLE group —
 * `process.kill(-pid)` — so a preemption or timeout cannot orphan a running
 * eval whose LLM traffic would then wedge the idle signal.
 *
 * On `timeoutMs` the SAME escalation as preemption runs: SIGINT to the
 * group, then `timeoutGraceMs` (default 10s), then SIGKILL to the group.
 * `timedOut` is true whenever WE initiated the kill due to the timeout.
 */
export function runExecutor(opts: {
  command: string;
  cwd?: string;
  timeoutMs: number;
  /** SIGINT grace before SIGKILL on a timeout. Default 10s. */
  timeoutGraceMs?: number;
  onExit: (o: ExecOutcome) => void;
}): {
  child: import('node:child_process').ChildProcess;
  kill: (sig: 'SIGINT' | 'SIGTERM' | 'SIGKILL') => void;
  promise: Promise<ExecOutcome>;
} {
  const graceMs = opts.timeoutGraceMs ?? 10000;
  // detached: the child becomes the leader of its own process group, so
  // process.kill(-pid) reaches it AND everything it spawned.
  const child = spawn('bash', ['-c', opts.command], {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    detached: true,
  });

  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let timedOut = false;

  // Forward child output to our log (tail, so a long eval doesn't flood).
  // Both streams are captured; the tail is returned in the outcome.
  const out = { stdout: '', stderr: '' };
  let both = false;
  const fwd = (key: 'stdout' | 'stderr') => (data: Buffer) => {
    const s = data.toString();
    if (!s) return;
    out[key] = (out[key] + s).slice(-4000);
    both = out.stdout !== '' && out.stderr !== '';
  };
  const tailText = () =>
    both ? `${out.stdout}\n----- stderr -----\n${out.stderr}` : out.stdout + out.stderr;

  const promise = new Promise<ExecOutcome>((resolveP) => {
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      // Same escalation as preemption: SIGINT the group, wait the grace,
      // then SIGKILL the group (no instant kill on timeout).
      kill('SIGINT');
      killTimer = setTimeout(() => {
        kill('SIGKILL');
      }, graceMs);
      killTimer.unref?.();
    }, opts.timeoutMs);
    timer.unref?.();

    child.on('exit', (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const o = { exitCode: code, signal: sig, timedOut, outputTail: tailText() };
      opts.onExit(o);
      resolveP(o);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const o = { exitCode: null, signal: null, timedOut: false, outputTail: tailText() };
      opts.onExit(o);
      resolveP(o);
    });

    child.stdout?.on('data', fwd('stdout'));
    child.stderr?.on('data', fwd('stderr'));
  });

  const kill = (sig: 'SIGINT' | 'SIGTERM' | 'SIGKILL') => {
    // Kill the WHOLE process group (-pid): the bash wrapper and its node
    // grandchildren alike. Already-dead groups throw ESRCH — ignore.
    try {
      process.kill(-child.pid!, sig);
    } catch {
      /* already dead */
    }
  };

  return { child, kill, promise };
}

// ---------------------------------------------------------------------------
// Fail fast on a broken executor config
// ---------------------------------------------------------------------------

/**
 * The script path an executor template expands to, or null when the template
 * has no script to check (bare builtins like `node -e`, no `node` at all,
 * empty). The first token is the interpreter; for a `node`/`deno` command the
 * script is the next argument (relative to cwd when not absolute).
 */
export function executorScriptPath(template: string, cwd?: string): string | null {
  const tokens = template.trim().split(/\s+/);
  const interp = tokens[0];
  if (!interp) return null;
  const base = interp.split(/[\\/]/).pop();
  if (base !== 'node' && base !== 'deno') return null;
  const arg = tokens[1];
  if (!arg || arg.startsWith('-')) return null;
  if (path.isAbsolute(arg)) return arg;
  if (cwd) return resolve(cwd, arg);
  return arg;
}

// ---------------------------------------------------------------------------
// The daemon
// ---------------------------------------------------------------------------

export interface DaemonHooks {
  /** Poll period for /api/state (tests shorten this). */
  pollMs?: number;
  /** SIGINT grace before SIGKILL on a timeout. Default 10s. */
  killGraceMs?: number;
  /**
   * Log sink (any `info(msg)` — RotatingLog in production, a capture
   * stub in tests). Defaults to the rotating <client_dir>/logs/client.log.
   */
  log?: { info: (msg: string) => void };
}

export class ClientDaemon {
  private readonly cfg: ClientConfig;
  private readonly hooks: { pollMs: number; killGraceMs: number; log: { info: (msg: string) => void } };
  private proxy: LlmProxy | null = null;
  /**
   * Aggregate endpoint (#64 D1): the daemon's SECOND loopback listener
   * (default :8800), in front of the SAME SessionGate instance. Null when
   * `aggregate_port` is 0 (disabled).
   */
  private aggregate: AggregateRouter | null = null;
  /**
   * #64 D5: derived session key → catalog-chosen server_id for aggregate
   * traffic. The register heartbeat carries it as `server_id` so the
   * arbiter's idle folding + preemption land on the RIGHT engine row
   * (absent it, the row falls back to the watched server via
   * leaseServerId — wrong for an off-watched-row engine).
   */
  private readonly aggregateServers = new Map<string, string>();
  /**
   * Session gate (issue #9 Part A): the router/gate for /s/<token>/ traffic,
   * live inside the loopback proxy. Null only when session_gate=false.
   */
  private gate: SessionGate | null = null;
  /** Set by the gate to wake the poll loop early (on-demand /api/state). */
  private stateWake = false;
  private ws: WebSocket | null = null;
  private clientId: string | null = null;
  private running = false;
  private activeLease: { lease_id: string; project: string; job_id: string } | null = null;
  private closed = false;
  /**
   * The poll loop's promise (set by start(), awaited by stop()). A tick
   * parked at an await keeps running past closed=true; stop() must settle
   * it before returning, or the tick can GRANT + spawn a child afterwards
   * (the shared-queue cross-talk the lease-loop tests kept catching).
   */
  private loopDone: Promise<void> | null = null;
  /** The in-flight runJob tail (executor child + usage report), awaited by stop(). */
  private jobDone: Promise<void> | null = null;
  /** True when an executor template's script path is missing (see checkExecutorScript). */
  private executorBroken = false;

  constructor(cfg: ClientConfig, hooks: DaemonHooks = {}) {
    this.cfg = cfg;
    this.hooks = {
      pollMs: hooks.pollMs ?? 20000,
      killGraceMs: hooks.killGraceMs ?? 10000,
      log: hooks.log ?? new RotatingLog(join(clientDir, 'logs')),
    };
    this.checkExecutorScript();
  }

  /**
   * Fail fast on a broken executor config: when the script an executor
   * template expands to does not exist, the client must NOT request any
   * leases — a broken executor config is a client fault, not a per-job
   * failure: it must not burn job attempts or hit the arbiter at all (the
   * Sep 25-26 thrash loop was a mis-expanded {repo} placeholder). The
   * registration/heartbeat still runs so the operator sees the client
   * online-but-inactive, with the reason in the log.
   */
  private checkExecutorScript(): void {
    for (const proj of this.cfg.projects) {
      // Unknown adapter name (issue #13): FATAL, same posture as a missing
      // script — the client stays registered/online-but-inactive.
      if (proj.adapter_error) {
        this.executorBroken = true;
        this.log.info(`FATAL: ${proj.adapter_error}`);
        return;
      }
      if (!proj.executor) {
        this.executorBroken = true;
        this.log.info(`FATAL: project "${proj.name}" has no executor (set projects[].executor or a valid projects[].adapter)`);
        return;
      }
      const expanded = proj.executor.replaceAll('{repo}', this.cfg.repo_root);
      const script = executorScriptPath(expanded, proj.cwd);
      if (!script) continue; // no script to check (builtin command, non-node, …)
      if (!existsSync(script)) {
        this.executorBroken = true;
        this.log.info(`FATAL: executor script not found: ${script} — check the {repo} placeholder and your executor template`);
        return;
      }
    }
    this.executorBroken = false;
  }

  get log(): RotatingLog {
    return this.hooks.log as RotatingLog;
  }

  /**
   * The code-staleness verdict for this heartbeat (#61 step 3 A1): this
   * process's boot revision (computed once at startup, `clientRevision`)
   * vs the LIVE `git rev-parse HEAD` of the same checkout — re-read every
   * heartbeat so a merge/pull is visible on the dashboard within one tick.
   * Best-effort by contract (revision.ts rule): no git / not a repo / any
   * failure yields undefined and the register body OMITS the key. `true`
   * only when both sides resolve and differ — prefix-tolerant, so a short
   * boot identity still matches the full live HEAD when they agree.
   */
  private daemonBehind(): boolean | undefined {
    if (!clientRevision) return undefined;
    const live = resolveRevision(clientDir);
    if (!live) return undefined;
    const a = clientRevision.toLowerCase();
    const b = live.toLowerCase();
    return a === b || a.startsWith(b) || b.startsWith(a) ? false : true;
  }

  /** Loopback proxy base URL once up (tests / operators); null before boot. */
  get proxyUrl(): string | null {
    return this.proxy?.base_url ?? null;
  }

  /** The session gate (issue #9 Part A); null when session_gate=false. */
  get sessionGate(): SessionGate | null {
    return this.gate;
  }

  /** Aggregate endpoint base URL once up (#64); null when disabled/not booted. */
  get aggregateUrl(): string | null {
    return this.aggregate?.base_url ?? null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log.info(`client starting: server=${this.cfg.server_url} name=${this.cfg.client_name} ip=${this.cfg.ip || '(not set — using observed)'} projects=${this.cfg.projects.map((p) => p.name).join(',')}`);
    await this.register();
    this.log.info(`registered as ${this.clientId}`);
    // The session gate must be live from boot — interactive sessions point at
    // the router whether or not a lease job ever runs. (runJob's ensureProxy
    // stays as the idempotent path.)
    await this.ensureProxy();
    this.connectWs();
    this.loopDone = this.loop();
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.log.info('client stopping');
    // If we hold a lease and a child is running, tear it down cleanly and
    // report the partial usage so the arbiter's budget stays honest.
    if (this.activeLease) {
      await this.teardown('shutting down', true);
    }
    // Kill any in-flight scheduled rebuild commands (runExecutor children
    // are detached process groups — they would otherwise outlive the daemon).
    for (const ex of this.rebuildExecs.values()) ex.kill('SIGKILL');
    this.running = false;
    this.stateWake = true; // wake a parked poll sleep so the loop settles fast
    // A tick parked at an `await` (state poll, lease POST) when stop() began
    // keeps running to its next await and used to be able to GRANT + spawn a
    // child AFTER stop() returned: the orphaned executor then mutated queue /
    // results files belonging to whatever ran next (lost read-modify-writes,
    // double-counted proxy bytes), and a process exit skipped its usage
    // report. Wait for the loop and any in-flight job to fully settle before
    // closing the plumbing (the job tail still needs the proxy to drain).
    await this.loopDone;
    this.loopDone = null;
    await this.jobDone;
    this.jobDone = null;
    this.ws?.close();
    // Release the session gate cleanly: parked requests proceed rather than
    // dying with the daemon.
    this.gate?.releaseAll();
    await this.aggregate?.stop();
    await this.proxy?.stop();
  }

  // ------------------------------------------------------------------

  private async register(): Promise<void> {
    // The staleness + log-tail blocks computed once per heartbeat (each
    // also feeds the register body below exactly once).
    const behind = this.daemonBehind();
    const logTail = typeof this.log.tail === 'function' ? this.log.tail() : undefined;
    const { status, body } = await api<{ client_id: string; created?: boolean }>(this.cfg, 'POST', '/api/clients/register', {
      name: this.cfg.client_name,
      ip: this.cfg.ip || undefined,
      // Version handshake: this checkout's version + the wire-protocol
      // revision. The arbiter stores it on the client row and echoes it on
      // /api/state, so the operator can see which worker revision is
      // connected (pre-version clients send neither and keep working).
      version: clientVersion,
      protocol: WIRE_PROTOCOL,
      // Code-staleness (issue #49): the commit this process's code was
      // loaded from, computed once at startup. The surfaces compare it
      // against their own checkout HEAD and flag `daemon behind` when the
      // tree moved ahead of the running process. undefined (non-git
      // checkout) drops the key from the JSON body — the arbiter treats
      // the field exactly like the version handshake: absent is normal,
      // never a rejection.
      ...(clientRevision ? { revision: clientRevision } : {}),
      // Gate posture (#41): the router's OWN admission posture, published so
      // the arbiter can say whether the slot cap + operator overrides are
      // actually in force. `armed` = the arbiter is reachable and gating;
      // `fail_open` = it is unreachable, so every session is admitted and
      // the cap is off. Derived from the gate's single `failOpen` flag — no
      // second source of truth. Exception-only: a daemon running WITHOUT a
      // session gate reports nothing (there is no gate to be armed), and an
      // old arbiter ignores the key and keeps working.
      ...(this.gate ? { gate_posture: this.gate.failOpen ? 'fail_open' : 'armed' } : {}),
      // Session launcher (#43): the port the session-gate proxy ACTUALLY
      // bound (cfg proxy_port may be 0 = ephemeral). The arbiter echoes it,
      // so the Sessions surface can hand the operator the exact
      // `/model http://127.0.0.1:<port>/s/<token>` line for this machine.
      // ADD-key: an old arbiter ignores it; a daemon whose proxy never came
      // up reports nothing.
      ...(this.proxy ? { proxy_port: this.proxy.port } : {}),
      // Agent-key plane (#68): the port the aggregate listener ACTUALLY
      // bound — the agent base URL (`http://127.0.0.1:<port>/v1`) the
      // dashboard's Add-agent flow hands an agent config. Same
      // bound-port rule as proxy_port (cfg aggregate_port may be 0 =
      // ephemeral). ADD-key: an old arbiter ignores it; a daemon whose
      // aggregate listener never came up (or aggregate_port=0) reports
      // nothing, and the Add-agent flow says so instead of guessing.
      ...(this.aggregate ? { aggregate_port: this.aggregate.port } : {}),
      // Code-staleness verdict (#61 step 3 A1): the client is the ONLY
      // process holding both facts — the boot revision it loaded code from
      // and the live HEAD of the same checkout (it runs FROM that tree).
      // `true` only when both resolve and differ; the key is OMITTED when
      // either side cannot resolve (no git / not a repo / any git failure —
      // resolveRevision is best-effort by contract), and `false` says the
      // daemon is current, which CLEARS the arbiter's stored marker. A
      // false report is what clears the surfaces' `daemon behind` tag
      // within one heartbeat of a daemon restart.
      ...(behind !== undefined ? { daemon_behind: behind } : {}),
      // Client log tail (#61 step 3 A2): the in-memory ring the logger
      // already feeds (no file re-read). Published ONLY when the arbiter
      // this daemon talks to is loopback — the mesh must not carry log
      // payloads, so a remote arbiter gets the key omitted entirely.
      ...(logTail !== undefined && isLoopbackUrl(this.cfg.server_url) ? { client_log: logTail } : {}),
      // The arbiter stores this per-project view for the dashboard
      // (Projects → workers allocated). Re-registration is a heartbeat:
      // last_seen refreshes and queue depths update on every tick. `stats`
      // are client-published (finished/failed today, last job) — the
      // arbiter shows them, it never computes them.
      projects: this.cfg.projects.map((p) => {
        // Scheduled rebuild run state (issue #3): the arbiter stores it and
        // echoes it on /api/state (same client-published discipline as
        // `stats` — it never computes or parses anything). Absent when the
        // project has no scheduled_rebuild or it has never run.
        const lastRebuild = readRebuildState(p.queue_file);
        // Dev cycles (#53 D9.3): the per-cycle status rows for the
        // dashboard's cycle strip — computed HERE from the project's
        // cycles file, published like everything else: the arbiter stores
        // and displays verbatim, it never computes (D7). Exception-only:
        // absent when the project has no cycles file or the list is empty.
        const cycleBlock = publishCycles(p.queue_file, p.name);
        return {
          name: p.name,
          model: p.model,
          estimated_seconds: p.estimated_seconds ?? 900,
          queue_depth: queueDepth(p.queue_file),
          // The first queue rows (priority order) — the arbiter displays them
          // verbatim on the dashboard's queue page ([project]/[worker]/queue);
          // it never reads the queue file itself. Best-effort: never throws.
          queue_preview: queuePreview(p.queue_file, 100),
          stats: {
            ...projectStats(p.results_file),
            queue: queueDepth(p.queue_file),
            // Jobs that burned all 3 attempts and were moved to
            // quarantine.jsonl (the operator's eyes go there, not to the queue).
            quarantined: quarantineCount(this.cfg.state_dir),
          },
          ...(lastRebuild ? { last_rebuild: lastRebuild } : {}),
          // One entry per cycle row (D9.3 — no merged progress line) plus the
          // effective cycle_max_in_flight cap (0 = the knob is absent).
          ...(cycleBlock ? { cycles: cycleBlock.cycles, cycle_cap: cycleBlock.cycle_cap } : {}),
        };
      }),
    });
    if (status !== 200 || !body.client_id) {
      throw new Error(`register failed: HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
    }
    this.clientId = body.client_id;
    // Log once per client (first registration) — the daemon re-registers on
    // every poll tick as a heartbeat, and that would flood the visible log.
    if (body.created) this.log.info(`registered as ${this.clientId}`);
  }

  /**
   * Re-send the registration (idempotent by name) with fresh queue depths.
   * Keeps the dashboard's `last_seen` liveness and per-project backlog views
   * current without a second API surface. Never throws — a failure just
   * means the next tick's register/health path retries.
   */
  private async refreshRegistration(): Promise<void> {
    try {
      await this.register();
    } catch (err) {
      this.log.info(`registration refresh failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private connectWs(): void {
    try {
      const url = `${this.cfg.server_url.replace(/\/$/, '')}/api/leases/events?token=${encodeURIComponent(this.cfg.token)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on('message', (data) => {
        let msg: { type?: string; lease_id?: string; reason?: string; project?: string };
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        this.log.info(`ws event: ${JSON.stringify(msg)}`);
        if (msg.type === 'revoked' && msg.lease_id) this.onRevoked(msg.lease_id, msg.reason ?? 'preempted');
      });
      ws.on('open', () => this.log.info('ws connected'));
      ws.on('error', () => {
        /* fetch loop + poll fallback cover us; reconnected below */
      });
      ws.on('close', () => {
        if (this.closed) return;
        this.ws = null;
        setTimeout(() => this.connectWs(), 5000).unref?.();
      });
    } catch {
      /* reconnected on next poll tick */
    }
  }

  private async loop(): Promise<void> {
    while (this.running && !this.closed) {
      try {
        await this.tickOnce();
      } catch (err) {
        this.log.info(`tick error: ${err instanceof Error ? err.message : err}`);
        // Arbiter unreachable (fetch threw): the session gate must fail-open
        // so interactive traffic never wedges on a dead arbiter.
        this.gate?.onLinkDown();
      }
      if (this.closed) return;
      // The gate can wake the loop early (new session / parked request needs
      // fresh override state); otherwise sleep the poll period. stop() also
      // flips stateWake so a parked sleep returns at once; the loop then
      // sees closed and exits instead of starting another tick.
      const wake = this.stateWake;
      this.stateWake = false;
      await sleep(wake ? Math.min(50, this.hooks.pollMs) : this.hooks.pollMs);
    }
  }

  private async tickOnce(): Promise<void> {
    // Heartbeat: re-register with fresh queue depths every tick (idempotent
    // by name). Also restores us after a server restart (the re-register
    // returns a new client_id) and reconnects a dropped WS.
    await this.refreshRegistration();
    if (!this.ws) this.connectWs();

    // Scheduled queue rebuild (issue #3): cadence is checked on every tick,
    // independent of the lease loop — a rebuild must run even while a job
    // holds a lease or the box is busy (the queue refills for the NEXT
    // grant). Fire-and-forget: the tick never waits on the command.
    void this.maybeRunScheduledRebuilds();

    // Dev cycles (issue #58): one driver step per project per tick, the same
    // fire-and-forget cadence — the tick never waits on the driver, and a
    // project with no cycles file does nothing (cycles fail closed, D4).
    void this.maybeRunCycleDrivers();

    const { status, body } = await api<{
      idle: { idle: boolean; degraded: boolean; reidle_gated: boolean };
      active_leases: { lease_id: string }[];
      clients?: { client_id: string; override?: { override: string } | null }[];
      sessions?: SessionStateRow[];
      // #64 D4: the arbiter-built catalog (ADD-key; absent on an old arbiter).
      catalog?: AggregateCatalogEntry[];
      // #66 D3: the arbiter-resolved alias block (ADD-key sibling of
      // `catalog`; absent on an old arbiter — an old arbiter simply has no
      // aliases, so clearing on absence is the correct reading).
      model_aliases?: AggregateAliasEntry[];
    }>(this.cfg, 'GET', '/api/state');
    if (status !== 200) {
      this.log.info(`state poll HTTP ${status}`);
      // A non-200 state poll means the arbiter is not serving us (auth is
      // stable; 5xx/downtime is what lands here): the gate fails open.
      this.gate?.onLinkDown();
      return;
    }
    const st = body;

    // Aggregate endpoint refresh (#64): the catalog rides THIS poll (an
    // ADD-key the arbiter publishes every tick); the engine keys come from
    // the dedicated loopback route on the SAME cadence. Tokens stay in
    // the router's memory — never persisted, never logged, never re-
    // published (D2). A poll failure leaves the last catalog + keys in
    // place: the endpoint degrades to routing with what it last knew,
    // never wedges.
    if (this.aggregate) {
      if (Array.isArray(st.catalog)) this.aggregate.updateCatalog(st.catalog);
      // #66 D3: the alias block rides the SAME poll as its catalog
      // sibling (pull posture — the router never recomputes the winner).
      // An absent block clears the map (an old arbiter has no aliases; a
      // re-pin lands the same way a pause/force override does).
      this.aggregate.updateAliases(st.model_aliases ?? []);
      void this.refreshServerKeys();
    }

    // Session gate (issue #9 Part A): the arbiter is reachable — re-arm the
    // gate, feed it the operator overrides, and fold the session
    // heartbeat/refresh into this tick (traffic throttles it to ≤1/10s).
    if (this.gate) {
      this.gate.onStatePoll(st.sessions ?? []);
      this.gate.heartbeat();
    }

    // If our lease vanished server-side (restart/TTL), tear down locally.
    if (this.activeLease && !st.active_leases.some((l) => l.lease_id === this.activeLease?.lease_id)) {
      this.log.info(`lease ${this.activeLease.lease_id} no longer active server-side — tearing down`);
      await this.teardown('lease_lost', false);
    }

    if (this.activeLease) return; // busy: the executor loop owns the flow

    // Broken executor config: stay online (the heartbeat above ran) but
    // request NO leases — see checkExecutorScript().
    if (this.executorBroken) return;

    // A client-pause override stops the daemon asking for work (server-side,
    // a paused client gets client_paused anyway — this just avoids the spam).
    const me = st.clients?.find((c) => c.client_id === this.clientId);
    if (me?.override?.override === 'pause') return;

    // Only ask for work when the arbiter says it is idle — unless the operator
    // has forced THIS client to run anyway (force bypasses the idle verdict and
    // the reidle gate on the server too; degraded signal, busy, project pause,
    // and daily budget still block there).
    if (this.closed) return;
    if (st.idle.degraded) return;
    const forced = me?.override?.override === 'force';
    if (!forced && (!st.idle.idle || st.idle.reidle_gated)) return;

    const job = await this.claimNextJob();
    if (!job) {
      this.log.info('queue empty — nothing to do');
      return;
    }
    const proj = job.project;
    this.log.info(`requesting lease for ${proj.name}/${job.job.job_id}`);
    const res = await api<{ lease_id?: string; reason?: string }>(this.cfg, 'POST', '/api/leases', {
      client_id: this.clientId,
      project: proj.name,
      job_id: job.job.job_id,
      // Per-job TTL (issue #6): the queue line's payload.estimated_seconds
      // wins when it's a finite number > 0; otherwise the project estimate.
      // The arbiter clamps the TTL to [floor, effective lease_ttl_seconds].
      estimated_seconds: jobEstimatedSeconds(job.job) ?? proj.estimated_seconds ?? 900,
    });
    if (res.status === 201 && res.body.lease_id) {
      // stop() can land while the lease POST is in flight. Spawning a child
      // now leaves it outside stop()'s reach: the daemon process is gone but
      // the executor keeps mutating shared files. Release the grant instead
      // (ok:false partial usage) and let the job retry next boot.
      if (this.closed) {
        this.log.info(`shutting down — releasing grant ${res.body.lease_id} without running`);
        await this.reportUsage(res.body.lease_id!, {
          ok: false,
          error: 'shutting_down',
          error_detail: 'the client stopped while the lease was being granted',
          score: null,
          ...this.proxyStats(),
        });
        return;
      }
      this.log.info(`GRANT lease ${res.body.lease_id} for ${job.job.job_id}`);
      this.activeLease = { lease_id: res.body.lease_id!, project: proj.name, job_id: job.job.job_id };
      // runJob must never take the daemon down (D6 rule 2): the rejection is
      // logged here instead of surfacing as an unhandledRejection or throwing
      // through stop()'s await.
      this.jobDone = this.runJob(proj, job.job, res.body.lease_id!).catch((err) => {
        this.log.info(`runJob error: ${err instanceof Error ? err.message : err}`);
      });
    } else {
      this.log.info(`lease denied: HTTP ${res.status} ${res.body.reason ?? ''}`);
    }
  }

  // ------------------------------------------------------------------

  /** Next job for any configured project (priority order: highest score first). */
  private async claimNextJob(): Promise<{ project: ClientProjectConfig; job: QueueJob } | null> {
    for (const proj of this.cfg.projects) {
      const job = nextJob(proj.queue_file);
      if (job) return { project: proj, job };
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Scheduled queue rebuild (issue #3)
  // ------------------------------------------------------------------

  /**
   * Projects with a rebuild command currently in flight. The ONLY overlap
   * guard idlefill applies (settled decision 4): one rebuild per project at
   * a time. Empty-source refusal / queue-clobber defense belongs to the
   * rebuild command itself (queue-builder-generic, not career-ops-specific).
   */
  private readonly rebuildInFlight = new Set<string>();
  private readonly rebuildExecs = new Map<string, ReturnType<typeof runExecutor>>();

  /**
   * Cadence check on every poll tick: for each project with
   * `scheduled_rebuild.enabled`, run the configured command when the
   * minimum interval since the last run has elapsed (state read from the
   * run-state file, so the cadence survives restarts). Fire-and-forget —
   * the tick never blocks on the command, and a rebuild runs regardless of
   * lease activity.
   */
  private async maybeRunScheduledRebuilds(): Promise<void> {
    for (const proj of this.cfg.projects) {
      const sr = proj.scheduled_rebuild;
      if (!sr || !sr.enabled) continue;
      if (this.rebuildInFlight.has(proj.name)) continue; // overlap guard
      if (!rebuildDue(readRebuildState(proj.queue_file), sr.every_minutes, Date.now())) continue;
      void this.runScheduledRebuild(proj, sr);
    }
  }

  /**
   * Run one rebuild: black-box command via bash -c (runExecutor machinery,
   * 15 min cap, cwd = the project's cwd like the executor), then persist
   * the run state next to the queue. The daemon NEVER parses the command's
   * output or touches the queue itself — on a nonzero exit the queue is
   * left exactly as the command left it and the failure is recorded in the
   * run state (exit_code ≠ 0). exit_code -1 = killed by our timeout.
   */
  private async runScheduledRebuild(proj: ClientProjectConfig, sr: ScheduledRebuildConfig): Promise<void> {
    this.rebuildInFlight.add(proj.name);
    const started = Date.now();
    const queueBefore = queueDepth(proj.queue_file);
    this.log.info(`scheduled rebuild (${proj.name}): running configured command (cwd=${proj.cwd ?? process.cwd()}, cap ${REBUILD_TIMEOUT_MS / 60000}min)`);
    try {
      const ex = runExecutor({
        command: sr.command,
        cwd: proj.cwd,
        timeoutMs: REBUILD_TIMEOUT_MS,
        onExit: () => {},
      });
      this.rebuildExecs.set(proj.name, ex);
      const outcome = await ex.promise;
      const exitCode = outcome.timedOut || outcome.signal !== null ? -1 : (outcome.exitCode ?? -1);
      const queueAfter = queueDepth(proj.queue_file);
      writeRebuildState(proj.queue_file, {
        last_run_ts: started,
        exit_code: exitCode,
        duration_ms: Date.now() - started,
        queue_before: queueBefore,
        queue_after: queueAfter,
      });
      if (exitCode === 0) {
        this.log.info(`scheduled rebuild (${proj.name}): queue ${queueBefore} → ${queueAfter} (exit 0, ${Date.now() - started}ms)`);
      } else {
        this.log.info(`scheduled rebuild (${proj.name}) FAILED (exit ${exitCode}) — daemon did not touch the queue (${queueBefore} → ${queueAfter}); failure recorded in ${rebuildStateFile(proj.queue_file)}`);
      }
      // Operator audit: the command's output tail (the rebuild chain's own
      // log lines — kept for the log only; the daemon never parses them).
      const tail = outcome.outputTail.trim();
      if (tail) {
        for (const line of tail.split('\n').slice(-10)) {
          this.log.info(`scheduled rebuild output (${proj.name}): ${line}`);
        }
      }
      // A successful rebuild rides to the dashboard on the NEXT heartbeat
      // (register reads the run-state file); no extra API surface.
    } catch (err) {
      // runExecutor must not throw, but a rebuild failure must never take
      // the daemon down with it.
      this.log.info(`scheduled rebuild (${proj.name}) error: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.rebuildInFlight.delete(proj.name);
      this.rebuildExecs.delete(proj.name);
    }
  }

  // ------------------------------------------------------------------
  // Dev cycles (issue #58)
  // ------------------------------------------------------------------

  private readonly cycleTickInFlight = new Set<string>();

  /**
   * Cadence = every poll tick (the maybeRunScheduledRebuilds pattern): one
   * CycleDriver step per project, fire-and-forget — the step is bounded file
   * I/O and never blocks the tick. The driver instance is built fresh each
   * tick from the files: the cursor never trusts memory (D4). A cycle
   * failure must never take the daemon down (D6 rule 2).
   */
  private async maybeRunCycleDrivers(): Promise<void> {
    for (const proj of this.cfg.projects) {
      if (this.cycleTickInFlight.has(proj.name)) continue; // overlap guard
      // Opt-in gate (the scheduled_rebuild.enabled shape): the project must
      // carry cycle_max_in_flight in its config entry. Absent = the daemon
      // never touches that project's cycles file.
      const cap = resolveCycleMaxInFlight(proj.name);
      if (cap === null) continue;
      if (!existsSync(cyclesFile(proj.queue_file))) continue;
      this.cycleTickInFlight.add(proj.name);
      try {
        const driver = new CycleDriver(proj.queue_file, proj.results_file, this.cfg.state_dir, cap);
        driver.tick();
      } catch (err) {
        this.log.info(`cycle driver (${proj.name}) error: ${err instanceof Error ? err.message : err}`);
      } finally {
        this.cycleTickInFlight.delete(proj.name);
      }
    }
  }

  /**
   * Pull the engine keys for the aggregate router (#64 D2): the ONE
   * authenticated request to the loopback-scoped GET /api/server-keys,
   * on the same cadence as the state poll. Tokens live ONLY in the
   * router's memory — never written to disk, never logged, never put on
   * any other surface. A failure keeps the last table in place.
   */
  private async refreshServerKeys(): Promise<void> {
    if (!this.aggregate) return;
    try {
      const { status, body } = await api<{ server_keys?: ServerKeyRow[]; client_key_hashes?: string[] }>(this.cfg, 'GET', '/api/server-keys');
      if (status === 200 && Array.isArray(body.server_keys)) {
        // #68: the agent-key digests ride the SAME pull (the route gained
        // the `client_key_hashes` ADD-key). Absent = plane OFF: an old
        // arbiter keeps today's any-caller posture.
        this.aggregate.updateKeys(body.server_keys, Array.isArray(body.client_key_hashes) ? body.client_key_hashes : []);
      }
    } catch {
      /* keep the last-known key table; the next tick retries */
    }
  }

  private async ensureProxy(): Promise<LlmProxy> {
    if (this.proxy) return this.proxy;
    if (this.cfg.session_gate !== false) {
      this.gate = new SessionGate({
        maxActive: this.cfg.max_active_agent_sessions ?? 2,
        holdCapMs: this.cfg.session_hold_cap_ms ?? 120_000,
        clientName: this.cfg.client_name,
        log: (m) => this.log.info(m),
        register: async (token, gate, sessionId, history, phase, lastActivity) => {
          // #64 D5: an aggregate-derived session key (model name / header
          // id) carries the catalog-chosen row as `server_id` — idle
          // folding + preemption then land on the engine the request
          // actually hits, not the leaseServerId watched-row fallback. A
          // `/s/<token>` key never enters that map, so its heartbeat body
          // stays exactly as before (D6).
          const aggregateServerId = this.aggregateServers.get(token);
          const { status } = await api(this.cfg, 'POST', '/api/sessions/register', {
            token,
            ...(this.clientId ? { client_id: this.clientId } : {}),
            client_name: this.cfg.client_name,
            ...(aggregateServerId ? { server_id: aggregateServerId } : {}),
            // #76: the NEWEST REQUEST the router saw on this session (the
            // ring's last entry) — a 10s liveness tick is not a request, so
            // the heartbeat never stamps its own tick (the old
            // Date.now() pinned every arbiter row to "now": the max-keep
            // rule at the arbiter never rewinds, idle folding stayed
            // defeated, and grants were blocked for dead sessions).
            // Ring-less rows (the router has not seen the token yet)
            // report the tick time — the pre-#76 posture for those.
            last_activity: lastActivity ?? Date.now(),
            // Gate-state visibility: the router's queue truth for this
            // session at heartbeat time. null (idle) ⇒ NO gate block — the
            // arbiter then CLEARS any stored gate for the token. An old
            // arbiter ignores the extra field (back-compat).
            ...(gate ? { gate } : {}),
            // #42 Slice 0: the REAL Hermes conversation id, captured from
            // the X-Hermes-Session-Id request header. ADD-key: absent until
            // some request on this token carried the header; an old arbiter
            // ignores it (back-compat).
            ...(sessionId ? { session_id: sessionId } : {}),
            // #45 session detail: the compact request history the router
            // keeps per session (10×60s request counts + last model +
            // last streamed token total). ADD-key: absent for a session
            // with no recorded traffic; an old arbiter ignores it.
            ...(history ? { history } : {}),
            // #67 response phase: what the engine is doing RIGHT NOW on
            // this session (thinking/output/tools + observation instant).
            // Verbatim like the gate block: null (no live stream) rides
            // as the explicit CLEAR so a finished stream never stays
            // tagged; an old arbiter ignores the extra key (back-compat).
            ...(phase !== undefined ? { phase } : {}),
          });
          return status === 200 || status === 201;
        },
        // The gate learned something that needs fresh override state (new
        // session arrived / a request parked): wake the poll loop early.
        refreshState: () => {
          this.stateWake = true;
        },
      });
    }
    this.proxy = startLlmProxy({
      port: this.cfg.proxy_port,
      target: this.cfg.llm_target,
      ...(this.gate ? { gate: this.gate } : {}),
      // Client-config editor (#61 step 3 A3): the page's local-config
      // editor talks to THIS loopback bind. The token compared here is the
      // one this daemon already holds (config.json `token`) — the same
      // credential the desktop webview injects into the page, so zero
      // pasting holds. No config FILE (env-config launch) = routes answer
      // 503 rather than inventing a file to write.
      clientProjects: { token: this.cfg.token, configPath: this.cfg.config_path ?? null },
    });
    await waitProxyReady(this.proxy.server);
    this.log.info(
      `proxy up: ${this.proxy.base_url} → ${this.cfg.llm_target}${this.gate ? ` (session gate on: max ${this.cfg.max_active_agent_sessions ?? 2} sessions, hold cap ${this.cfg.session_hold_cap_ms ?? 120000}ms)` : ' (session gate off)'}`,
    );
    // Aggregate endpoint (#64 D1): the SECOND loopback listener inside
    // this SAME process (mesh D5 counts processes, not listeners), in
    // front of the SAME SessionGate instance — one shared slot cap. 11435
    // stays byte-for-byte untouched (D6).
    if (this.cfg.aggregate_port !== 0) {
      this.aggregate = startAggregateRouter({
        port: this.cfg.aggregate_port,
        defaultTarget: this.cfg.llm_target,
        gate: this.gate,
        // D5: remember the catalog-chosen row per derived key so the
        // register heartbeat reports the CORRECT server_id (idle folding
        // + preemption land on the engine the request actually hits).
        onSessionRoute: (key, serverId) => {
          this.aggregateServers.set(key, serverId);
        },
        log: (m) => this.log.info(m),
      });
      try {
        await waitProxyReady(this.aggregate.server);
        this.log.info(`aggregate endpoint up: ${this.aggregate.base_url}/v1 → catalog-routed (default ${this.cfg.llm_target})`);
      } catch {
        // Port taken / bind never completed: the aggregate endpoint is
        // OFF this run. It never wedges the daemon — 11435 + leases stand.
        this.log.info(
          `aggregate endpoint NOT listening on :${this.cfg.aggregate_port} (port busy?) — running without it; set aggregate_port in client/config.json to retarget`,
        );
        await this.aggregate.stop().catch(() => {});
        this.aggregate = null;
      }
    }
    return this.proxy;
  }

  /**
   * One granted job: write the payload, run the executor, and settle.
   *
   * Token accounting (Fix 4): on a SUCCESSFUL finish the result file's
   * `tokens_out` / `tokens_in` (LLM-reported) are authoritative and win;
   * the proxy byte estimate (bytes/4 — an overcount from SSE framing and
   * JSON wrapping) is only the FALLBACK for a result that lacks them.
   * Preempted/killed jobs have no result file: the proxy estimate is the
   * only signal and is reported as-is.
   *
   * Failure handling (Fix 2/3): a job is a SUCCESS only when the executor
   * exits 0 AND its result line says `ok:true` (missing result line =
   * failure `no_result_file`). Every other outcome — clean `ok:false`
   * result, crash (exit ≠ 0), preempt, timeout — is a FAILED job: usage is
   * reported ok:false with the cause, and the job goes through the retry
   * path (attempts + 1 in the queue; at MAX_ATTEMPTS it is quarantined and
   * never runs again until the operator edits the files by hand).
   */
  private async runJob(proj: ClientProjectConfig, job: QueueJob, leaseId: string): Promise<void> {
    const dir = this.cfg.state_dir;
    mkdirSync(dir, { recursive: true });
    const payloadFile = join(dir, `payload-${job.job_id}.json`);
    const resultFile = join(dir, `result-${job.job_id}.json`);
    for (const f of [payloadFile, resultFile]) {
      try {
        writeFileSync(f, '');
      } catch {
        /* ignore */
      }
    }
    const proxy = await this.ensureProxy();
    // Payload vocabulary (issue #13): the core owns job_id/model/proxy_base_url;
    // the adapter manifest's payload_fields declares which job.payload keys are
    // forwarded, in order. Default = the career-ops trio, keeping the payload
    // byte-identical for manifest-less configs.
    const fields = proj.payload_fields ?? ['url', 'company', 'title'];
    const payload: Record<string, unknown> = { job_id: job.job_id };
    for (const f of fields) payload[f] = (job.payload as Record<string, unknown>)[f];
    payload.model = proj.model;
    payload.proxy_base_url = `${proxy.base_url}/v1`;
    writeFileSync(payloadFile, JSON.stringify(payload));

    const command = proj.executor
      .replaceAll('{payload_file}', payloadFile)
      .replaceAll('{result_file}', resultFile)
      .replaceAll('{repo}', this.cfg.repo_root);

    this.log.info(`executing: ${command} (cwd=${proj.cwd ?? process.cwd()})`);
    const ex = runExecutor({
      command,
      cwd: proj.cwd,
      // Per-project cap (config `timeout_seconds`, default 1200s = the
      // adapter's worst case) mapped to the runExecutor hook.
      timeoutMs: (proj.timeout_seconds ?? 1200) * 1000,
      onExit: () => {},
    });
    this.executor = ex;

    const outcome = await ex.promise;
    this.logExecutorTail(job.job_id, outcome.outputTail);

    // Preempted (or killed/timeout): the job stays in the queue. Report the
    // partial usage the proxy saw so the arbiter's budget reflects reality
    // (no result file exists — the byte estimate is the only signal).
    if (outcome.signal === 'SIGINT' || outcome.signal === 'SIGTERM' || outcome.signal === 'SIGKILL' || outcome.timedOut) {
      const partial = this.proxyStats();
      const cause = outcome.timedOut ? 'timeout' : 'preempted';
      this.log.info(`executor stopped (${cause}) — reporting partial usage out=${partial.tokens_out}`);
      await this.reportUsage(leaseId, { ok: false, error: cause, error_detail: outcome.outputTail.slice(-1000), score: null, ...partial });
      this.registerFailure(proj, job, cause);
      this.activeLease = null;
      return;
    }

    // A crashed executor is NOT a successful finish: report the error (with
    // the child's output tail as error_detail) and append a failed result
    // line — a crash is findable in results.jsonl like any other failure.
    // Let the retry path decide (attempts+1, or quarantine at the cap).
    if (outcome.exitCode !== 0) {
      const error = `executor_exit_${outcome.exitCode}`;
      this.log.info(`executor exit ${outcome.exitCode} — job failed: ${error}`);
      await this.reportUsage(leaseId, { ok: false, error, error_detail: outcome.outputTail.slice(-1000), score: null, ...this.proxyStats() });
      const attempts = this.registerFailure(proj, job, error);
      appendResult(proj.results_file, {
        ok: false,
        job_id: job.job_id,
        error,
        error_detail: outcome.outputTail.slice(-1000),
        attempts,
        ts: new Date().toISOString(),
      });
      this.activeLease = null;
      return;
    }

    // Exit 0: the result line is the verdict. ok:true → success (report
    // ok:true, append the line, remove the job). ok:false (or a missing
    // line) → a FAILED job that goes through the retry path.
    const result = this.readResultLine(resultFile);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const partial = this.proxyStats();

    if (!result || result.ok !== true) {
      const error = !result ? 'no_result_file' : typeof result.error === 'string' && result.error ? result.error : 'executor_reported_failure';
      if (!result) {
        this.log.info(`WARNING: exit 0 but no result line at ${resultFile} — recording a failed job (${error})`);
      }
      const line = result ?? { ok: false, error: 'no_result_file' };
      appendResult(proj.results_file, {
        ...line,
        job_id: job.job_id,
        error: line.error ?? error,
        error_detail: outcome.outputTail.slice(-1000),
        ts: new Date().toISOString(),
      });
      // Retry bookkeeping BEFORE the network report: attempts +1 / quarantine
      // are local file writes, so the queue is in its final state the moment
      // the result line exists. The old order put the usage `await` in the
      // middle — a process exit in that window left the failed line recorded
      // while the job still sat in the queue at the cap, free to run a 4th
      // time (and it made the lease-loop retry test sample a half-applied
      // state).
      this.registerFailure(proj, job, error);
      // Clean failure (exit 0): the proxy saw what the job did use —
      // report it with the failure (and the child's output tail) so the
      // budget stays honest and the failure's WHY survives on the arbiter.
      await this.reportUsage(leaseId, { ok: false, error, error_detail: outcome.outputTail.slice(-1000), score: null, ...partial });
      this.activeLease = null;
      return;
    }

    // Success: the LLM-reported tokens win; the proxy estimate is only the
    // fallback when the result lacks them.
    const tokensOut = num(result.tokens_out) > 0 ? num(result.tokens_out) : partial.tokens_out;
    const tokensIn = num(result.tokens_in) > 0 ? num(result.tokens_in) : partial.tokens_in;
    // Score (issue #4): the result line's score rides the usage body so the
    // arbiter can store the per-job outcome row. null when the executor's
    // line lacks one.
    const score = typeof result.score === 'number' && Number.isFinite(result.score) ? result.score : null;
    await this.reportUsage(leaseId, { ok: true, tokens_out: tokensOut, tokens_in: tokensIn, score });
    appendResult(proj.results_file, { ...result, job_id: job.job_id, ts: new Date().toISOString() });
    removeJob(proj.queue_file, job.job_id);
    this.log.info(`finished ${job.job_id} (score=${result.score ?? 'n/a'}, out=${tokensOut}) — queue now ${readQueue(proj.queue_file).length} jobs`);
    this.activeLease = null;
  }

  /**
   * Retry path for a FAILED job: attempts + 1 in the queue (line rewritten
   * atomically, order and all fields preserved); when the count reaches
   * MAX_ATTEMPTS the job is moved to quarantine.jsonl and logged loudly.
   * Returns the attempts count the job reached (the next-attempts value
   * recorded on the failure's result line).
   */
  private registerFailure(proj: ClientProjectConfig, job: QueueJob, error: string): number {
    const attempts = bumpJobAttempts(proj.queue_file, job.job_id);
    if (attempts >= MAX_ATTEMPTS) {
      const moved = quarantineJob(this.cfg.state_dir, proj.queue_file, { ...job, attempts }, error);
      this.log.info(`QUARANTINED ${job.job_id} after ${moved} failed attempts (last error: ${error}) — job removed from the queue; see ${join(this.cfg.state_dir, 'quarantine.jsonl')}`);
    } else {
      this.log.info(`${job.job_id} failed (attempt ${attempts}/${MAX_ATTEMPTS}, ${error}) — stays in the queue for a retry`);
    }
    return attempts;
  }

  /**
   * Persist the executor's output tail to the client log for EVERY job
   * (success, clean failure, crash, preempt, timeout) — findable as the
   * `executor output tail` block right after the outcome log line.
   */
  private logExecutorTail(jobId: string, tail: string): void {
    const t = tail.trim();
    if (!t) {
      this.log.info(`executor output tail (${jobId}): <none>`);
      return;
    }
    for (const line of t.split('\n')) {
      this.log.info(`executor output tail (${jobId}): ${line}`);
    }
  }

  // ------------------------------------------------------------------

  private onRevoked(leaseId: string, reason: string): void {
    if (!this.activeLease || this.activeLease.lease_id !== leaseId) return;
    this.log.info(`REVOKED lease ${leaseId} reason=${reason} — SIGINT executor (grace ${this.hooks.killGraceMs}ms)`);
    void this.teardown(reason, true);
  }

  private teardown(reason: string, preempt: boolean): Promise<void> {
    return new Promise((resolveP) => {
      const leaseId = this.activeLease?.lease_id;
      if (!leaseId) return resolveP();
      const ex = this.executor;
      if (!ex) {
        this.activeLease = null;
        return resolveP();
      }
      ex.kill('SIGINT');
      const done = ex.promise.then(async (outcome) => {
        if (!outcome.exitCode && !outcome.signal) {
          // still running after grace: escalate
          this.log.info(`executor did not stop in grace — SIGKILL`);
          ex.kill('SIGKILL');
        }
        const partial = this.proxyStats();
        if (preempt) {
          this.log.info(`teardown complete (${reason}) — reporting usage {ok:false, error:"${reason}"} out=${partial.tokens_out}`);
          await this.reportUsage(leaseId, { ok: false, error: reason, error_detail: outcome.outputTail.slice(-1000), score: null, ...partial });
        }
        this.activeLease = null;
        this.executor = null;
        resolveP();
      });
      // Hard cap: if the grace never resolves, escalate and finish anyway.
      const t = setTimeout(() => {
        ex.kill('SIGKILL');
      }, this.hooks.killGraceMs);
      t.unref?.();
      void done.finally(() => clearTimeout(t));
    });
  }

  /** Proxy byte counts since the last job, expressed as a usage estimate. */
  private proxyStats(): { tokens_out: number; tokens_in: number } {
    if (!this.proxy) return { tokens_out: 0, tokens_in: 0 };
    const entries = this.proxy.drainLog();
    // We cannot recover exact token counts from byte counts — report the
    // proxy-observed request/response bytes as a conservative token proxy
    // (the executor's own result file carries the LLM-reported numbers,
    // which we MAX against these on success).
    const inBytes = entries.reduce((s, e) => s + e.req_bytes, 0);
    const outBytes = entries.reduce((s, e) => s + e.resp_bytes, 0);
    return {
      tokens_out: Math.round(outBytes / 4),
      tokens_in: Math.round(inBytes / 4),
    };
  }

  private async reportUsage(
    leaseId: string,
    body: { ok: boolean; error?: string; error_detail?: string; tokens_out?: number; tokens_in?: number; score?: number | null },
  ): Promise<void> {
    try {
      const res = await api<{ ok?: boolean }>(this.cfg, 'POST', `/api/leases/${leaseId}/usage`, body);
      this.log.info(`usage reported for ${leaseId}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    } catch (err) {
      this.log.info(`usage report failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private readResultLine(file: string): Record<string, unknown> | null {
    if (!existsSync(file)) return null;
    try {
      const text = readFileSync(file, 'utf-8').trim();
      if (!text) return null;
      // The executor writes ONE JSON line; be lenient about surrounding noise.
      const line = text.split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{'));
      if (!line) return null;
      return JSON.parse(line);
    } catch (err) {
      this.log.info(`could not parse result file ${file}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // keep a reference so teardown can reach the live executor
  private executor: ReturnType<typeof runExecutor> | null = null;
}

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function once(emitter: import('node:events').EventEmitter, ev: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    emitter.once(ev, () => resolveP());
    emitter.once('error', reject);
  });
}

// --- main ---

async function main(): Promise<void> {
  const cfg = loadClientConfig(clientDir);
  const daemon = new ClientDaemon(cfg);
  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('unhandledRejection', (err) => {
    daemon.log.info(`unhandledRejection: ${err instanceof Error ? err.message : err}`);
  });
  await daemon.start();
}

// Only run when invoked directly (tests import the classes).
const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('/index.ts'));
if (isMain) {
  // --version / -v: print the release this checkout was built from (root
  // package.json) and exit BEFORE any daemon work — no config read, no
  // register, no sockets. Same on the dev path (tsx src/index.ts) and the
  // built path (node dist/index.js).
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(clientVersion);
    process.exit(0);
  }
  main().catch((err) => {
    console.error(`[idlefill-client] fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
    process.exit(1);
  });
}
