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
 *      spawn the executor (bash -c, cwd from project config), and watch.
 *      - revoked (WS or poll mismatch) → SIGINT, 10s grace, SIGKILL, then
 *        POST usage {ok:false, error:"preempted"} with the tokens the proxy
 *        saw. The job stays in the queue (no finish on a revoked lease is a
 *        terminal success — the arbiter keeps it for a future grant).
 *      - normal exit 0 → read the result file (one JSON line), POST usage
 *        {ok:true, tokens_out, tokens_in}, append the result line to the
 *        project's results_file, and atomically remove the job from the
 *        queue file. A job only leaves the queue after a successful finish.
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
  payload: {
    url: string;
    company: string;
    title: string;
    score: number;
    [k: string]: unknown;
  };
}

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

export function removeJob(file: string, jobId: string): boolean {
  const jobs = readQueue(file);
  const next = jobs.filter((j) => j.job_id !== jobId);
  if (next.length === jobs.length) return false;
  writeQueue(file, next);
  return true;
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
}

/**
 * Run the executor command (bash -c) with the given cwd. `onSignal` is called
 * with 'SIGINT'/'SIGTERM' when the monitor asks the child to stop. Returns
 * when the child exits (grace period handling is the caller's concern).
 */
export function runExecutor(opts: {
  command: string;
  cwd?: string;
  timeoutMs: number;
  onExit: (o: ExecOutcome) => void;
}): {
  child: import('node:child_process').ChildProcess;
  kill: (sig: 'SIGINT' | 'SIGTERM' | 'SIGKILL') => void;
  promise: Promise<ExecOutcome>;
} {
  const child = spawn('bash', ['-c', opts.command], {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let killedByUs: NodeJS.Signals | null = null;

  const promise = new Promise<ExecOutcome>((resolveP) => {
    timer = setTimeout(() => {
      if (!settled) {
        kill('SIGKILL');
      }
    }, opts.timeoutMs);
    timer.unref?.();

    child.on('exit', (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.onExit({ exitCode: code, signal: sig, timedOut: killedByUs === 'SIGKILL' });
      resolveP({ exitCode: code, signal: sig, timedOut: killedByUs === 'SIGKILL' });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = { exitCode: null, signal: null, timedOut: false };
      opts.onExit(out);
      resolveP(out);
    });

    // Forward child output to our log (tail, so a long eval doesn't flood).
    let tail = '';
    const fwd = (data: Buffer) => {
      tail = (tail + data.toString()).slice(-4000);
    };
    child.stdout?.on('data', fwd);
    child.stderr?.on('data', fwd);
  });

  const kill = (sig: 'SIGINT' | 'SIGTERM' | 'SIGKILL') => {
    killedByUs = sig;
    try {
      child.kill(sig);
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
  /** Executor wall-clock timeout (tests shorten this). Default 15 min. */
  executorTimeoutMs?: number;
  /** SIGINT grace before SIGKILL. Default 10s. */
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
      executorTimeoutMs: hooks.executorTimeoutMs ?? 15 * 60 * 1000,
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
    const { status, body } = await api<{ client_id: string }>(this.cfg, 'POST', '/api/clients/register', {
      name: this.cfg.client_name,
      ip: this.cfg.ip || undefined,
    });
    if (status !== 200 || !body.client_id) {
      throw new Error(`register failed: HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`);
    }
    this.clientId = body.client_id;
    this.log.info(`registered as ${this.clientId}`);
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
    // Re-register lazily if we lost the server (restart on the other side).
    if (!this.clientId || !this.ws) {
      try {
        await this.register();
        this.connectWs();
      } catch (err) {
        this.log.info(`register failed: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }

    const { status, body } = await api<{
      idle: { idle: boolean; degraded: boolean; reidle_gated: boolean };
      active_leases: { lease_id: string }[];
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

    // Only ask for work when the arbiter says it is idle.
    if (!st.idle.idle || st.idle.degraded || st.idle.reidle_gated) return;

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
      timeoutMs: this.hooks.executorTimeoutMs,
      onExit: () => {},
    });
    this.executor = ex;

    const outcome = await ex.promise;

    if (outcome.signal === 'SIGINT' || outcome.signal === 'SIGTERM' || outcome.signal === 'SIGKILL' || outcome.timedOut) {
      // Preempted (or killed): the job stays in the queue. Report the partial
      // usage the proxy saw so the arbiter's budget reflects reality.
      const partial = this.proxyStats();
      this.log.info(`executor stopped (preempted/killed) — reporting partial usage out=${partial.tokens_out}`);
      await this.reportUsage(leaseId, { ok: false, error: 'preempted', ...partial });
      this.activeLease = null;
      return;
    }

    if (outcome.exitCode !== 0) {
      // A crashed executor is NOT a successful finish: report the error,
      // keep the job in the queue (a crash is retryable next grant).
      this.log.info(`executor exit ${outcome.exitCode} — job stays in queue`);
      await this.reportUsage(leaseId, { ok: false, error: `executor_exit_${outcome.exitCode}`, ...this.proxyStats() });
      this.activeLease = null;
      return;
    }

    // Success path: read the result line, report usage, append result, shrink queue.
    const result = this.readResultLine(resultFile);
    const partial = this.proxyStats();
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const tokensOut = Math.max(num(result?.tokens_out), partial.tokens_out);
    const tokensIn = Math.max(num(result?.tokens_in), partial.tokens_in);

    await this.reportUsage(leaseId, { ok: true, tokens_out: tokensOut, tokens_in: tokensIn });
    if (result) {
      appendResult(proj.results_file, { ...result, job_id: job.job_id, ts: new Date().toISOString() });
    } else {
      this.log.info(`WARNING: no result file at ${resultFile} — recording a bare success`);
      appendResult(proj.results_file, { ok: false, error: 'no_result_file', job_id: job.job_id, ts: new Date().toISOString() });
    }
    removeJob(proj.queue_file, job.job_id);
    this.log.info(`finished ${job.job_id} (score=${result?.score ?? 'n/a'}, out=${tokensOut}) — queue now ${readQueue(proj.queue_file).length} jobs`);
    this.activeLease = null;
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
          await this.reportUsage(leaseId, { ok: false, error: reason, ...partial });
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
    body: { ok: boolean; error?: string; tokens_out?: number; tokens_in?: number },
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
