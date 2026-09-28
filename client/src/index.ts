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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { loadClientConfig, type ClientConfig, type ClientProjectConfig } from './config.js';
import { startLlmProxy, waitProxyReady, type LlmProxy } from './proxy.js';

const clientDir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Logging (rotate at 10 MB, keep 1)
// ---------------------------------------------------------------------------

class RotatingLog {
  private readonly file: string;
  private readonly max = 10 * 1024 * 1024;

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
    const stream = process.env.IDLEFILL_CLIENT_QUIET ? undefined : process.stdout;
    if (stream) process.stdout.write(stamped);
  }

  /** Console-only line (config dump etc. that duplicates file state). */
  info(msg: string): void {
    this.line(msg);
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
  payload: {
    url: string;
    company: string;
    title: string;
    score: number;
    [k: string]: unknown;
  };
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

export function nextJob(file: string): QueueJob | null {
  return readQueue(file)[0] ?? null;
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
// The daemon
// ---------------------------------------------------------------------------

export interface DaemonHooks {
  /** Poll period for /api/state (tests shorten this). */
  pollMs?: number;
  /** SIGINT grace before SIGKILL on a timeout. Default 10s. */
  killGraceMs?: number;
  log?: RotatingLog;
}

export class ClientDaemon {
  private readonly cfg: ClientConfig;
  private readonly hooks: Required<DaemonHooks>;
  private proxy: LlmProxy | null = null;
  private ws: WebSocket | null = null;
  private clientId: string | null = null;
  private running = false;
  private activeLease: { lease_id: string; project: string; job_id: string } | null = null;
  private closed = false;

  constructor(cfg: ClientConfig, hooks: DaemonHooks = {}) {
    this.cfg = cfg;
    this.hooks = {
      pollMs: hooks.pollMs ?? 20000,
      killGraceMs: hooks.killGraceMs ?? 10000,
      log: hooks.log ?? new RotatingLog(join(clientDir, 'logs')),
    };
  }

  get log(): RotatingLog {
    return this.hooks.log;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log.info(`client starting: server=${this.cfg.server_url} name=${this.cfg.client_name} ip=${this.cfg.ip || '(not set — using observed)'} projects=${this.cfg.projects.map((p) => p.name).join(',')}`);
    await this.register();
    this.log.info(`registered as ${this.clientId}`);
    this.connectWs();
    this.loop();
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
    this.running = false;
    this.ws?.close();
    await this.proxy?.stop();
  }

  // ------------------------------------------------------------------

  private async register(): Promise<void> {
    const { status, body } = await api<{ client_id: string; created?: boolean }>(this.cfg, 'POST', '/api/clients/register', {
      name: this.cfg.client_name,
      ip: this.cfg.ip || undefined,
      // The arbiter stores this per-project view for the dashboard
      // (Projects → workers allocated). Re-registration is a heartbeat:
      // last_seen refreshes and queue depths update on every tick. `stats`
      // are client-published (finished/failed today, last job) — the
      // arbiter shows them, it never computes them.
      projects: this.cfg.projects.map((p) => ({
        name: p.name,
        model: p.model,
        estimated_seconds: p.estimated_seconds ?? 900,
        queue_depth: queueDepth(p.queue_file),
        stats: {
          ...projectStats(p.results_file),
          queue: queueDepth(p.queue_file),
          // Jobs that burned all 3 attempts and were moved to
          // quarantine.jsonl (the operator's eyes go there, not to the queue).
          quarantined: quarantineCount(this.cfg.state_dir),
        },
      })),
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
      }
      await sleep(this.hooks.pollMs);
    }
  }

  private async tickOnce(): Promise<void> {
    // Heartbeat: re-register with fresh queue depths every tick (idempotent
    // by name). Also restores us after a server restart (the re-register
    // returns a new client_id) and reconnects a dropped WS.
    await this.refreshRegistration();
    if (!this.ws) this.connectWs();

    const { status, body } = await api<{
      idle: { idle: boolean; degraded: boolean; reidle_gated: boolean };
      active_leases: { lease_id: string }[];
      clients?: { client_id: string; override?: { override: string } | null }[];
    }>(this.cfg, 'GET', '/api/state');
    if (status !== 200) {
      this.log.info(`state poll HTTP ${status}`);
      return;
    }
    const st = body;

    // If our lease vanished server-side (restart/TTL), tear down locally.
    if (this.activeLease && !st.active_leases.some((l) => l.lease_id === this.activeLease?.lease_id)) {
      this.log.info(`lease ${this.activeLease.lease_id} no longer active server-side — tearing down`);
      await this.teardown('lease_lost', false);
    }

    if (this.activeLease) return; // busy: the executor loop owns the flow

    // A client-pause override stops the daemon asking for work (server-side,
    // a paused client gets client_paused anyway — this just avoids the spam).
    const me = st.clients?.find((c) => c.client_id === this.clientId);
    if (me?.override?.override === 'pause') return;

    // Only ask for work when the arbiter says it is idle — unless the operator
    // has forced THIS client to run anyway (force bypasses the idle verdict and
    // the reidle gate on the server too; degraded signal, busy, project pause,
    // and daily budget still block there).
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
      estimated_seconds: proj.estimated_seconds ?? 900,
    });
    if (res.status === 201 && res.body.lease_id) {
      this.log.info(`GRANT lease ${res.body.lease_id} for ${job.job.job_id}`);
      this.activeLease = { lease_id: res.body.lease_id!, project: proj.name, job_id: job.job.job_id };
      void this.runJob(proj, job.job, res.body.lease_id!);
    } else {
      this.log.info(`lease denied: HTTP ${res.status} ${res.body.reason ?? ''}`);
    }
  }

  // ------------------------------------------------------------------

  /** Next job for any configured project (queue order). */
  private async claimNextJob(): Promise<{ project: ClientProjectConfig; job: QueueJob } | null> {
    for (const proj of this.cfg.projects) {
      const job = nextJob(proj.queue_file);
      if (job) return { project: proj, job };
    }
    return null;
  }

  private async ensureProxy(): Promise<LlmProxy> {
    if (this.proxy) return this.proxy;
    this.proxy = startLlmProxy({ port: this.cfg.proxy_port, target: this.cfg.llm_target });
    await waitProxyReady(this.proxy.server);
    this.log.info(`proxy up: ${this.proxy.base_url} → ${this.cfg.llm_target}`);
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
    const payload = {
      job_id: job.job_id,
      url: job.payload.url,
      company: job.payload.company,
      title: job.payload.title,
      model: proj.model,
      proxy_base_url: `${proxy.base_url}/v1`,
    };
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
      await this.reportUsage(leaseId, { ok: false, error: cause, error_detail: outcome.outputTail.slice(-1000), ...partial });
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
      await this.reportUsage(leaseId, { ok: false, error, error_detail: outcome.outputTail.slice(-1000), ...this.proxyStats() });
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
      // Clean failure (exit 0): the proxy saw what the job did use —
      // report it with the failure (and the child's output tail) so the
      // budget stays honest and the failure's WHY survives on the arbiter.
      await this.reportUsage(leaseId, { ok: false, error, error_detail: outcome.outputTail.slice(-1000), ...partial });
      this.registerFailure(proj, job, error);
      this.activeLease = null;
      return;
    }

    // Success: the LLM-reported tokens win; the proxy estimate is only the
    // fallback when the result lacks them.
    const tokensOut = num(result.tokens_out) > 0 ? num(result.tokens_out) : partial.tokens_out;
    const tokensIn = num(result.tokens_in) > 0 ? num(result.tokens_in) : partial.tokens_in;
    await this.reportUsage(leaseId, { ok: true, tokens_out: tokensOut, tokens_in: tokensIn });
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
          await this.reportUsage(leaseId, { ok: false, error: reason, error_detail: outcome.outputTail.slice(-1000), ...partial });
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
    body: { ok: boolean; error?: string; error_detail?: string; tokens_out?: number; tokens_in?: number },
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
  main().catch((err) => {
    console.error(`[idlefill-client] fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
    process.exit(1);
  });
}
