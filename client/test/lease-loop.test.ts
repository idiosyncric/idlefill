/**
 * lease-loop.test.ts — the client daemon against a FAKE arbiter (in-process,
 * ephemeral loopback port) with a sleep-based executor fixture.
 *
 * Covers:
 *   - register → idle → grant → executor runs → usage(ok) → result appended
 *     → queue shrinks (the job leaves the queue ONLY after success)
 *   - queue is the source of truth: a failed (non-zero exit) job does NOT
 *     leave the queue; it DOES append a failed result line (with the
 *     child's stderr tail as error_detail) and the usage report carries
 *     error_detail
 *   - busy arbiter (idle=false) → no lease request is even made
 *   - client-pause override → the daemon stops requesting leases
 *   - force override → the daemon requests a lease while the box is busy
 *   - per-job lease TTL (issue #6): payload.estimated_seconds on the queue
 *     line rides on the lease POST; missing/garbage falls back to the
 *     project estimate
 *   - clean failure (exit 0, result ok:false) → usage ok:false, job KEPT in
 *     the queue with attempts: 1
 *   - retry policy: attempts 1 → 2 → 3; on the 3rd failure the job leaves
 *     the queue and lands in quarantine.jsonl (published in stats too)
 *   - tokens: the result file's LLM-reported counts WIN over the proxy byte
 *     estimate; a result without them falls back to the estimate
 *   - every ok:false usage report (crash, preempt, timeout, clean failure,
 *     no_result_file) carries error_detail
 *   - fail fast: a missing executor script ⇒ FATAL logged, NO lease
 *     requests (the client stays registered/heartbeating, online-but-
 *     inactive)
 *   - the {repo} placeholder resolves to the TRUE repo root in both the
 *     source layout and the dist layout (the Sep 25-26 incident: it used
 *     to resolve to the client package dir and every executor exited 1)
 */

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientDaemon, type QueueJob } from '../src/index.js';
import { loadClientConfig, type ClientConfig } from '../src/config.js';
import { startFakeArbiter, type FakeArbiter } from './fake-arbiter.js';

const here = dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;

let dir: string;
let arb: FakeArbiter;
let queueFile: string;
let resultsFile: string;
let cfg: ClientConfig;

function mkQueue(jobs: { id: string; url?: string; company?: string; title?: string; score?: number; est?: unknown }[]): void {
  const lines = jobs.map((j) => {
    const payload: QueueJob['payload'] = { url: j.url ?? `https://example.com/${j.id}`, company: j.company ?? 'C', title: j.title ?? 'T', score: j.score ?? 1 };
    // `est` is deliberately `unknown`: tests feed garbage (string/negative)
    // through the JSON round-trip to prove the client's fallback.
    if (j.est !== undefined) payload.estimated_seconds = j.est as number;
    return JSON.stringify({ job_id: j.id, payload } satisfies QueueJob);
  });
  writeFileSync(queueFile, lines.join('\n') + (lines.length ? '\n' : ''));
}

function readQueueLines(): string[] {
  if (!existsSync(queueFile)) return [];
  return readFileSync(queueFile, 'utf-8').split('\n').filter((l) => l.trim());
}

function readResults(): Record<string, unknown>[] {
  if (!existsSync(resultsFile)) return [];
  return readFileSync(resultsFile, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-client-'));
  arb = await startFakeArbiter();
  queueFile = join(dir, 'queue.jsonl');
  resultsFile = join(dir, 'results.jsonl');
  mkdirSync(join(dir, 'state'), { recursive: true });
  cfg = {
    server_url: arb.url,
    token: 't',
    client_name: 'test-client',
    ip: '100.94.165.102',
    proxy_port: 0, // not used by the daemon unless a job runs the real proxy
    llm_target: 'http://127.0.0.1:1',
    repo_root: here,
    state_dir: join(dir, 'state'),
    state_file: join(dir, 'state.json'),
    projects: [
      {
        name: 'test-proj',
        queue_file: queueFile,
        results_file: resultsFile,
        model: 'm',
        executor: `${nodeBin} ${join(here, 'fixtures', 'sleep-exec.mjs')} {payload_file} {result_file}`,
        estimated_seconds: 10,
      },
    ],
  };
});

after(async () => {
  await arb.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeDaemon(): ClientDaemon {
  process.env.IDLEFILL_TEST_SLEEP_MS = '150';
  return new ClientDaemon(cfg, { pollMs: 50, log: undefined });
}

/** Swap in a different executor command for the test project. */
function setExecutor(executor: string, timeoutSeconds?: number): void {
  cfg.projects = [
    {
      name: 'test-proj',
      queue_file: queueFile,
      results_file: resultsFile,
      model: 'm',
      executor,
      estimated_seconds: 10,
      ...(timeoutSeconds ? { timeout_seconds: timeoutSeconds } : {}),
    },
  ];
}

test('grant → run → success → usage(ok) → result appended → queue shrinks', async () => {
  mkQueue([{ id: 'job-1', company: 'Alpha', score: 9 }, { id: 'job-2', company: 'Beta', score: 8 }]);
  const d = makeDaemon();
  await d.start();

  // wait for the success path to complete (result file + queue shrink)
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (readResults().length >= 1 && readQueueLines().length === 1) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await d.stop();

  assert.ok(arb.leaseRequests.length >= 1, 'client requested a lease');
  assert.equal(arb.leaseRequests[0]!.project, 'test-proj');
  assert.equal(arb.leaseRequests[0]!.job_id, 'job-1', 'queue order: highest-score job first');
  assert.ok(arb.usageReports.length >= 1, 'usage reported');
  const use = arb.usageReports[0]!.body;
  assert.equal(use.ok, true, `usage ok=true, got ${JSON.stringify(use)}`);
  assert.equal(use.tokens_out, 100, 'executor-reported tokens flow through');

  const results = readResults();
  assert.equal(results.length, 1, 'one result line appended');
  assert.equal(results[0]!.job_id, 'job-1');
  assert.equal(results[0]!.score, 4.2);
  assert.equal(readQueueLines().length, 1, 'queue shrank by exactly one (only after success)');
  assert.match(readQueueLines()[0]!, /job-2/);
});

test('failed executor: job stays in the queue; a failed result line + error_detail are appended', async () => {
  // executor that exits non-zero (node exits 1 on a throw) and prints a
  // marker to stderr — the marker must ride along as error_detail.
  cfg.projects = [
    {
      name: 'test-proj',
      queue_file: queueFile,
      results_file: resultsFile,
      model: 'm',
      executor: 'node -e "console.error(\'CRASH-TAIL-MARKER\'); process.exit(3)"',
      estimated_seconds: 10,
    },
  ];
  mkQueue([{ id: 'job-3' }]);
  const before = arb.usageReports.length; // usageReports is cumulative across tests
  const d = makeDaemon();
  await d.start();
  const deadline = Date.now() + 6000;
  let rep: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const hit = arb.usageReports.slice(before).find((u) => u.lease_id && u.body.ok === false && /executor_exit_3/.test(String(u.body.error)));
    if (hit) {
      rep = hit.body;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await d.stop();

  assert.ok(rep, 'a failed executor still reports usage (ok:false, executor_exit_3)');
  const bad = rep!;
  assert.match(String(bad.error), /executor_exit_3|preempted/);
  assert.equal(typeof bad.error_detail, 'string', 'the usage report carries error_detail (the child output tail)');
  assert.ok(String(bad.error_detail).includes('CRASH-TAIL-MARKER'), 'error_detail is the child stderr tail');
  assert.equal(readQueueLines().length, 1, 'the job STAYS in the queue after a crash');

  // The crash is findable in results.jsonl too (like a clean failure):
  // the failed result line carries the child's stderr and the attempts
  // count the retry path assigned.
  const res = readResults().find((r) => r.job_id === 'job-3');
  assert.ok(res, 'a failed result line is appended for a crashed job (audit trail)');
  assert.equal(res!.ok, false);
  assert.match(String(res!.error), /executor_exit_3/);
  assert.ok(String(res!.error_detail).includes('CRASH-TAIL-MARKER'), 'the result line carries the stderr tail');
  assert.equal(typeof res!.attempts, 'number', 'the result line carries the attempts count');
  assert.equal(typeof res!.ts, 'string', 'the result line carries a timestamp');
});

test('busy arbiter: no lease request is made', async () => {
  cfg.projects = [
    {
      name: 'test-proj',
      queue_file: queueFile,
      results_file: resultsFile,
      model: 'm',
      executor: `${nodeBin} ${join(here, 'fixtures', 'sleep-exec.mjs')} {payload_file} {result_file}`,
    },
  ];
  mkQueue([{ id: 'job-4' }]);
  arb.idle = false;
  const d = makeDaemon();
  await d.start();
  const before = arb.leaseRequests.length;
  await new Promise((r) => setTimeout(r, 300)); // a few poll cycles
  await d.stop();
  assert.equal(arb.leaseRequests.length, before, 'while busy, the client must not ask for leases');
  assert.equal(readQueueLines().length, 1);
});

test('client-pause override: daemon stops requesting leases', async () => {
  cfg.projects = [
    {
      name: 'test-proj',
      queue_file: queueFile,
      results_file: resultsFile,
      model: 'm',
      executor: `${nodeBin} ${join(here, 'fixtures', 'sleep-exec.mjs')} {payload_file} {result_file}`,
    },
  ];
  mkQueue([{ id: 'job-5' }]);
  arb.idle = true; // box idle, but…
  arb.setOverride('pause'); // …the operator paused THIS client.
  const d = makeDaemon();
  await d.start();
  const before = arb.leaseRequests.length;
  await new Promise((r) => setTimeout(r, 300));
  await d.stop();
  assert.equal(arb.leaseRequests.length, before, 'a paused client must not ask for leases even when idle');
  arb.setOverride(null);
});

test('registration heartbeat: reports project allocations with live queue depths', async () => {
  mkQueue([{ id: 'job-h1' }, { id: 'job-h2' }]);
  const before = arb.registers.length;
  const d = makeDaemon();
  await d.start();
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (arb.registers.length > before + 1) break; // start() + at least one tick refresh
    await new Promise((r) => setTimeout(r, 50));
  }
  await d.stop();

  assert.ok(arb.registers.length >= 2, `daemon heartbeats: start() + ≥1 tick, got ${arb.registers.length} registers`);
  const last = arb.lastRegister;
  assert.equal(last.name, 'test-client');
  const projects = last.projects as {
    name: string;
    model: string;
    estimated_seconds: number;
    queue_depth: number;
    queue_preview: { job_id: string; title: string; company: string; score: number | null; attempts: number }[];
  }[];
  assert.ok(Array.isArray(projects) && projects.length === 1, 'one project reported');
  assert.equal(projects[0]!.name, 'test-proj');
  assert.equal(projects[0]!.model, 'm');
  assert.equal(projects[0]!.queue_depth, 2, 'queue depth reflects the queue file at report time');
  // The queue preview (the dashboard's queue page data) is client-published
  // in priority order (file order) and best-effort — here, two rows.
  const prev = projects[0]!.queue_preview;
  assert.ok(Array.isArray(prev) && prev.length === 2, `queue_preview published: ${JSON.stringify(prev)}`);
  assert.equal(prev[0]!.job_id, 'job-h1');
  assert.equal(prev[0]!.title, 'T');
  assert.equal(prev[0]!.company, 'C');
  assert.equal(prev[0]!.score, 1);
  assert.equal(prev[0]!.attempts, 0);
  assert.equal(prev[1]!.job_id, 'job-h2');
});

test('heartbeat publishes client-computed project stats (finished/failed/last_job/queue), not arbiter-computed', async () => {
  mkQueue([{ id: 'job-s1' }, { id: 'job-s2' }]);
  const d = makeDaemon();
  await d.start();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const s = (arb.lastRegister?.projects as { stats?: Record<string, unknown> }[] | undefined)?.[0]?.stats;
    if (s && typeof s.queue === 'number') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await d.stop();

  const projects = arb.lastRegister.projects as {
    name: string;
    stats?: Record<string, unknown>;
  }[];
  assert.ok(Array.isArray(projects) && projects.length === 1, 'one project reported');
  const st = projects[0]!.stats;
  assert.ok(st && typeof st === 'object', 'the client publishes a per-project stats object');
  assert.equal(st!.queue, 2, 'queue depth is computed by the CLIENT from its queue file');
  assert.equal(typeof st!.finished, 'number', 'finished is client-computed from its results file');
  assert.equal(typeof st!.failed, 'number', 'failed is client-computed from its results file');
  assert.equal(typeof st!.last_job, 'string', 'last_job is the client\'s most recent result job');
});

test('force override: daemon requests a lease while the box is busy', async () => {
  cfg.projects = [
    {
      name: 'test-proj',
      queue_file: queueFile,
      results_file: resultsFile,
      model: 'm',
      executor: `${nodeBin} ${join(here, 'fixtures', 'sleep-exec.mjs')} {payload_file} {result_file}`,
    },
  ];
  mkQueue([{ id: 'job-6' }]);
  arb.idle = false; // box busy —
  arb.setOverride('force'); // — but the operator forced this client through.
  const d = makeDaemon();
  await d.start();
  const before = arb.leaseRequests.length;
  const deadline = Date.now() + 3000;
  let requested = false;
  while (Date.now() < deadline) {
    if (arb.leaseRequests.length > before) {
      requested = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await d.stop();
  assert.ok(requested, 'force ⇒ the daemon asks for a lease despite a busy box (server is the final arbiter)');
  arb.setOverride(null);
});

// ---------------------------------------------------------------------------
// Per-job lease TTL (issue #6): payload.estimated_seconds on the queue line
// ---------------------------------------------------------------------------

test('per-job TTL: payload.estimated_seconds drives the lease POST; garbage falls back to the project value', async () => {
  arb.idle = true;
  setExecutor(`${nodeBin} ${join(here, 'fixtures', 'sleep-exec.mjs')} {payload_file} {result_file}`); // project est = 10
  mkQueue([
    { id: 'job-est-ok', est: 120 }, // finite > 0 ⇒ wins
    { id: 'job-est-none' }, // missing ⇒ project value
    { id: 'job-est-str', est: '300' }, // string ⇒ project value
    { id: 'job-est-neg', est: -5 }, // negative ⇒ project value
  ]);
  const d = makeDaemon();
  await d.start();
  // All four jobs run sequentially (success path shrinks the queue each time).
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (readQueueLines().length === 0 && arb.leaseRequests.filter((r) => r.job_id.startsWith('job-est-')).length >= 4) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await d.stop();

  const req = (id: string) => arb.leaseRequests.find((r) => r.job_id === id);
  assert.ok(req('job-est-ok') && req('job-est-none') && req('job-est-str') && req('job-est-neg'), 'all four jobs requested leases');
  assert.equal(req('job-est-ok')!.estimated_seconds, 120, 'queue line payload.estimated_seconds rides on the lease POST');
  assert.equal(req('job-est-none')!.estimated_seconds, 10, 'no job-level estimate ⇒ project estimated_seconds');
  assert.equal(req('job-est-str')!.estimated_seconds, 10, 'string estimate is garbage ⇒ project value');
  assert.equal(req('job-est-neg')!.estimated_seconds, 10, 'negative estimate is garbage ⇒ project value');
});

// ---------------------------------------------------------------------------
// Clean failures, retry policy, token accounting
// ---------------------------------------------------------------------------

test('clean failure (exit 0, result ok:false): usage ok:false, job KEPT in queue with attempts: 1', async () => {
  arb.idle = true; // (the force test leaves it busy)
  setExecutor(`${nodeBin} ${join(here, 'fixtures', 'fail-exec.mjs')} {payload_file} {result_file}`);
  mkQueue([{ id: 'job-cf' }]);
  // Deterministic single attempt: the fake arbiter denies any SECOND grant
  // for this job (the old "flip idle=false when the failure report lands"
  // raced the daemon's 50ms re-poll and occasionally burned attempts: 2).
  arb.denyLeaseAfter.set('job-cf', 1);
  const before = arb.usageReports.length; // usageReports is cumulative across tests
  const d = makeDaemon();
  await d.start();
  const deadline = Date.now() + 8000;
  let line: string | null = null;
  let rep: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    rep = arb.usageReports.slice(before).find((u) => u.body.ok === false)?.body ?? null;
    if (rep) {
      await new Promise((r) => setTimeout(r, 30)); // let the attempts bump land
      line = readQueueLines().find((l) => l.includes('job-cf')) ?? null;
      if (line) break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  await d.stop();
  arb.denyLeaseAfter.delete('job-cf');
  assert.ok(line && rep, 'clean failure: usage reported and job still queued');
  assert.equal(rep.ok, false);
  assert.equal(rep.error, 'extract_failed', 'the result line\'s error rides along');
  assert.equal(JSON.parse(line!).attempts, 1, 'job KEPT in the queue with attempts: 1');
  const res = readResults().find((r) => r.job_id === 'job-cf');
  assert.equal(res!.ok, false, 'the failed result line is appended (audit trail)');
  assert.equal(res!.error, 'extract_failed');
  assert.equal(typeof res!.error_detail, 'string', 'error_detail carries the output tail');
  arb.idle = true;
});

test('retry policy: attempts 1 → 2 → 3, then the job is quarantined and leaves the queue', async () => {
  arb.idle = true;
  setExecutor(`${nodeBin} ${join(here, 'fixtures', 'fail-exec.mjs')} {payload_file} {result_file}`);
  mkQueue([{ id: 'job-r1' }]);
  const d = makeDaemon();
  await d.start();
  // Three clean failures = three appended result lines for the job. Each
  // failure goes back to the queue (attempts 1, 2) and the 3rd quarantines
  // it — after which the queue is empty and the daemon stands down.
  const deadline = Date.now() + 15000;
  let lines = 0;
  while (Date.now() < deadline) {
    lines = readResults().filter((r) => r.job_id === 'job-r1').length;
    if (lines >= 3) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(lines, 3, `three attempts recorded, got ${lines}`);
  assert.equal(readQueueLines().filter((l) => l.includes('job-r1')).length, 0, 'after the 3rd failure the job is OUT of the queue');
  const qFile = join(dir, 'state', 'quarantine.jsonl');
  assert.ok(existsSync(qFile), 'quarantine.jsonl exists in the state dir');
  const q = JSON.parse(readFileSync(qFile, 'utf-8').split('\n').filter((l) => l.trim()).pop()!);
  assert.equal(q.job_id, 'job-r1');
  assert.equal(q.attempts, 3, 'quarantine line carries the attempts count it reached');
  assert.equal(q.error, 'extract_failed', 'quarantine line carries the last error');

  // Let one heartbeat land AFTER the quarantine, then read its published
  // stats: quarantined rides next to the queue depth.
  const hbDeadline = Date.now() + 2000;
  while (Date.now() < hbDeadline) {
    const st = (arb.lastRegister.projects as { stats?: Record<string, unknown> }[])[0]?.stats;
    if (st && st.quarantined === 1) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await d.stop();
  const st = (arb.lastRegister.projects as { stats?: Record<string, unknown> }[])[0]!.stats;
  assert.equal(st!.quarantined, 1, 'stats carry quarantined: <count> alongside queue');
});

test('tokens: the result file\'s LLM-reported counts WIN over the proxy byte estimate', async () => {
  arb.idle = true;
  // token-exec pushes 8 KiB through the daemon's loopback proxy (byte
  // estimate ≈ 8192/4 = 2048) but reports tokens_out: 777 — the reported
  // number must win.
  setExecutor(`${nodeBin} ${join(here, 'fixtures', 'token-exec.mjs')} {payload_file} {result_file}`);
  mkQueue([{ id: 'job-tok' }]);
  const d = makeDaemon();
  await d.start();
  // wait until the result line + queue shrink confirm the success path ran
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (readResults().some((r) => r.job_id === 'job-tok') && readQueueLines().length === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await d.stop();

  const use = arb.usageReports.find((u) => u.body.ok === true && u.body.tokens_out === 777);
  assert.ok(use, `reported tokens_out 777 wins (below the ~2048 byte estimate); got ${JSON.stringify(arb.usageReports.map((u) => u.body))}`);
  assert.equal(use!.body.tokens_in, 33, 'reported tokens_in wins too');
});

test('tokens: a result WITHOUT token counts falls back to the proxy estimate', async () => {
  arb.idle = true;
  // no-tokens-exec sends an 8 KiB body to the payload's proxy_base_url (the
  // daemon's loopback proxy; the LLM target is down in the test, so the
  // proxy answers 502 locally — the REQUEST bytes are still counted) and
  // writes a success result with NO token fields: the proxy estimate is
  // what flows through — tokens_in = round(8192/4) = 2048 exactly.
  setExecutor(`${nodeBin} ${join(here, 'fixtures', 'no-tokens-exec.mjs')} {payload_file} {result_file}`);
  mkQueue([{ id: 'job-tok2' }]);
  const d = makeDaemon();
  await d.start();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (readResults().some((r) => r.job_id === 'job-tok2') && readQueueLines().length === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await d.stop();
  const use = arb.usageReports.filter((u) => u.body.ok === true).pop();
  assert.ok(use, 'a success usage report landed');
  assert.equal(use!.body.tokens_in, 2048, 'no reported counts ⇒ the proxy byte estimate (8192 req bytes / 4) is used');
  assert.equal(use!.body.tokens_out, 0, 'response bytes were never counted (local 502) ⇒ estimate 0');
});

// ---------------------------------------------------------------------------
// Fail fast on a broken executor config (the {repo} placeholder incident)
// ---------------------------------------------------------------------------

class CaptureLog {
  lines: string[] = [];
  info(msg: string): void {
    this.lines.push(msg);
  }
}

test('missing executor script: FATAL logged at startup, no lease requests, registration still runs', async () => {
  const log = new CaptureLog();
  cfg.projects = [
    {
      name: 'test-proj',
      queue_file: queueFile,
      results_file: resultsFile,
      model: 'm',
      executor: `${nodeBin} ${join(dir, 'no-such-script.mjs')} {payload_file} {result_file}`,
      estimated_seconds: 10,
    },
  ];
  mkQueue([{ id: 'job-miss' }]);
  arb.idle = true;
  const regsBefore = arb.registers.length;
  const d = new ClientDaemon(cfg, { pollMs: 50, log });
  await d.start();
  // A few poll cycles: every tick must skip the lease request (executor
  // broken) while the heartbeat keeps running.
  await new Promise((r) => setTimeout(r, 400));
  const leaseReqs = arb.leaseRequests.filter((x) => x.job_id === 'job-miss');
  assert.equal(leaseReqs.length, 0, 'a broken executor config must not request any leases');
  await d.stop();

  assert.ok(
    log.lines.some((l) => l.startsWith('FATAL: executor script not found:')),
    `FATAL logged with the missing path: ${JSON.stringify(log.lines)}`,
  );
  assert.ok(
    log.lines.some((l) => l.includes('check the {repo} placeholder and your executor template')),
    'the FATAL line points at the {repo} placeholder',
  );
  assert.ok(arb.registers.length > regsBefore, 'registration/heartbeat still runs (online-but-inactive)');
  assert.equal(readQueueLines().length, 1, 'the job was never taken (no attempts burned)');
});

test('{repo} resolves to the TRUE repo root in the source layout (client/src → <root>)', async () => {
  const repoRoot = resolve(here, '../..');
  const devCfg = loadClientConfig(join(here, '..', 'src'));
  assert.equal(devCfg.repo_root, repoRoot, 'dev layout: repo_root = the true repo root');
  // The career-ops adapter path that {repo} expands to exists at the root.
  assert.ok(existsSync(join(repoRoot, 'adapters', 'career-ops', 'eval.mjs')), 'the expanded executor script exists at <root>/adapters/career-ops/eval.mjs');
  // Relative paths (state etc.) STILL resolve against the client package
  // dir — the untracked config uses `../data/...` from there (unchanged).
  assert.equal(devCfg.state_dir, join(repoRoot, 'client', 'data'), 'state_dir is unchanged (<client pkg dir>/data)');
});

test('{repo} resolves to the TRUE repo root in the dist layout (client/dist → <root>)', async () => {
  const repoRoot = resolve(here, '../..');
  const distCfg = loadClientConfig(join(here, '..', 'dist'));
  assert.equal(distCfg.repo_root, repoRoot, 'dist layout: repo_root = the true repo root');
  assert.equal(distCfg.state_dir, join(repoRoot, 'client', 'data'), 'state_dir is unchanged (<client pkg dir>/data)');
});
