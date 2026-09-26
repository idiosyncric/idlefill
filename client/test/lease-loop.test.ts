/**
 * lease-loop.test.ts — the client daemon against a FAKE arbiter (in-process,
 * ephemeral loopback port) with a sleep-based executor fixture.
 *
 * Covers:
 *   - register → idle → grant → executor runs → usage(ok) → result appended
 *     → queue shrinks (the job leaves the queue ONLY after success)
 *   - queue is the source of truth: a failed (non-zero exit) job does NOT
 *     leave the queue and does NOT append a result
 *   - busy arbiter (idle=false) → no lease request is even made
 *   - client-pause override → the daemon stops requesting leases
 *   - force override → the daemon requests a lease while the box is busy
 */

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientDaemon, type QueueJob } from '../src/index.js';
import type { ClientConfig } from '../src/config.js';
import { startFakeArbiter, type FakeArbiter } from './fake-arbiter.js';

const here = dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;

let dir: string;
let arb: FakeArbiter;
let queueFile: string;
let resultsFile: string;
let cfg: ClientConfig;

function mkQueue(jobs: { id: string; url?: string; company?: string; title?: string; score?: number }[]): void {
  const lines = jobs.map((j) =>
    JSON.stringify({ job_id: j.id, payload: { url: j.url ?? `https://example.com/${j.id}`, company: j.company ?? 'C', title: j.title ?? 'T', score: j.score ?? 1 } } satisfies QueueJob),
  );
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
  return new ClientDaemon(cfg, { pollMs: 50, executorTimeoutMs: 10_000, log: undefined });
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

test('failed executor: job stays in the queue, no result line', async () => {
  // executor that exits non-zero (node exits 1 on a throw)
  cfg.projects = [
    {
      name: 'test-proj',
      queue_file: queueFile,
      results_file: resultsFile,
      model: 'm',
      executor: 'node -e "process.exit(3)"',
      estimated_seconds: 10,
    },
  ];
  mkQueue([{ id: 'job-3' }]);
  const d = makeDaemon();
  await d.start();
  const deadline = Date.now() + 6000;
  let sawUsage = false;
  while (Date.now() < deadline) {
    if (arb.usageReports.some((u) => u.lease_id && u.body.ok === false)) {
      sawUsage = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await d.stop();

  assert.ok(sawUsage, 'a failed executor still reports usage (ok:false)');
  const bad = arb.usageReports.find((u) => u.body.ok === false)!;
  assert.match(String(bad.body.error), /executor_exit_3|preempted/);
  assert.equal(readQueueLines().length, 1, 'the job STAYS in the queue after a crash');
  assert.equal(readResults().filter((r) => r.job_id === 'job-3').length, 0, 'no result line for a crashed job');
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
  const projects = last.projects as { name: string; model: string; estimated_seconds: number; queue_depth: number }[];
  assert.ok(Array.isArray(projects) && projects.length === 1, 'one project reported');
  assert.equal(projects[0]!.name, 'test-proj');
  assert.equal(projects[0]!.model, 'm');
  assert.equal(projects[0]!.queue_depth, 2, 'queue depth reflects the queue file at report time');
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
