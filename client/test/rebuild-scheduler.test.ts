/**
 * rebuild-scheduler.test.ts — the scheduled queue rebuild loop (issue #3).
 *
 * Covers:
 *   - cadence unit rules: due/not-due by last_run_ts (no state = due;
 *     minimum interval since last run; exact boundary is due)
 *   - config parsing: every_minutes default 60 when enabled without it;
 *     disabled/blank-command/garbage shapes → no loop
 *   - run-state file: written next to the queue with the right shape;
 *     corrupt file reads as null
 *   - daemon integration (fake arbiter, stub commands — NEVER career-ops
 *     files):
 *       * due rebuild runs the configured command, the queue grows, the
 *         run-state file records exit 0 + queue_before/after, and the next
 *         registration heartbeat carries last_rebuild
 *       * failed command (exit 2) → the daemon does NOT touch the queue and
 *         records the exit code in the run state
 *       * not-due (fresh last_run_ts) → the command never runs
 *       * overlapping rebuilds refused: one command in flight per project
 *         survives many poll ticks
 */

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClientDaemon,
  readRebuildState,
  writeRebuildState,
  rebuildDue,
  rebuildStateFile,
  queueDepth,
  type RebuildRunState,
} from '../src/index.js';
import { parseScheduledRebuild, REBUILD_DEFAULT_EVERY_MINUTES, type ClientConfig } from '../src/config.js';
import { startFakeArbiter, type FakeArbiter } from './fake-arbiter.js';

const here = dirname(fileURLToPath(import.meta.url));
const addFixture = join(here, 'fixtures', 'rebuild-add.sh');
const sleepFixture = join(here, 'fixtures', 'rebuild-sleep.sh');

// ---------------------------------------------------------------------------
// Pure cadence + state + config rules
// ---------------------------------------------------------------------------

test('rebuildDue: no state = due; recent run = not due; older than every_minutes = due; exact boundary = due', () => {
  const now = 1_800_000_000_000;
  assert.equal(rebuildDue(null, 60, now), true, 'never run → due');
  const recent: RebuildRunState = { last_run_ts: now - 59 * 60_000, exit_code: 0, duration_ms: 1, queue_before: 0, queue_after: 0 };
  assert.equal(rebuildDue(recent, 60, now), false, '59 min ago with every_minutes 60 → not due');
  const old: RebuildRunState = { last_run_ts: now - 61 * 60_000, exit_code: 0, duration_ms: 1, queue_before: 0, queue_after: 0 };
  assert.equal(rebuildDue(old, 60, now), true, '61 min ago → due');
  const exact: RebuildRunState = { last_run_ts: now - 60 * 60_000, exit_code: 0, duration_ms: 1, queue_before: 0, queue_after: 0 };
  assert.equal(rebuildDue(exact, 60, now), true, 'exactly every_minutes → due (minimum interval)');
});

test('parseScheduledRebuild: default 60 when enabled without every_minutes; disabled/blank/garbage → undefined', () => {
  assert.deepEqual(parseScheduledRebuild({ enabled: true, command: 'echo kept 3' }), {
    enabled: true,
    command: 'echo kept 3',
    every_minutes: REBUILD_DEFAULT_EVERY_MINUTES,
  });
  assert.equal(REBUILD_DEFAULT_EVERY_MINUTES, 60, 'the settled default is 60 minutes');
  assert.deepEqual(parseScheduledRebuild({ enabled: true, command: 'x', every_minutes: 15 }), {
    enabled: true,
    command: 'x',
    every_minutes: 15,
  });
  // Garbage every_minutes falls back to the default (cadence must never be
  // 0/negative/NaN — that would spin the loop).
  assert.equal(parseScheduledRebuild({ enabled: true, command: 'x', every_minutes: -5 })?.every_minutes, 60);
  assert.equal(parseScheduledRebuild({ enabled: true, command: 'x', every_minutes: 'nope' })?.every_minutes, 60);
  // Disabled / absent / malformed → no loop.
  assert.equal(parseScheduledRebuild({ enabled: false, command: 'x' }), undefined);
  assert.equal(parseScheduledRebuild({ command: 'x' }), undefined, 'enabled must be exactly true');
  assert.equal(parseScheduledRebuild({ enabled: true }), undefined, 'enabled without a command is a config error → disabled');
  assert.equal(parseScheduledRebuild({ enabled: true, command: '   ' }), undefined, 'blank command → disabled');
  assert.equal(parseScheduledRebuild(null), undefined);
  assert.equal(parseScheduledRebuild('nope'), undefined);
});

test('run-state file: written next to the queue with the right shape; corrupt reads as null', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-rbstate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const qf = join(dir, 'queue.jsonl');
  writeFileSync(qf, '');
  assert.equal(rebuildStateFile(qf), join(dir, 'queue.jsonl.rebuild.json'), 'state lives next to the queue file');
  assert.equal(readRebuildState(qf), null, 'no state file yet → null (due)');

  const st: RebuildRunState = { last_run_ts: 123, exit_code: 0, duration_ms: 4500, queue_before: 445, queue_after: 512 };
  writeRebuildState(qf, st);
  assert.deepEqual(readRebuildState(qf), st, 'round-trips with the exact shape');

  writeFileSync(rebuildStateFile(qf), 'not json at all');
  assert.equal(readRebuildState(qf), null, 'corrupt state file → null (never throws)');
  writeFileSync(rebuildStateFile(qf), JSON.stringify({ exit_code: 0 }));
  assert.equal(readRebuildState(qf), null, 'missing last_run_ts → null (unusable for cadence)');
});

// ---------------------------------------------------------------------------
// Daemon integration (fake arbiter + stub commands)
// ---------------------------------------------------------------------------

let arb: FakeArbiter;

before(async () => {
  arb = await startFakeArbiter();
});
after(async () => {
  await arb.close();
});

/**
 * A fresh tmp workspace + config per integration test (cadence state lives
 * in the queue dir, so tests must not share it). idle=false on the fake
 * arbiter keeps the LEASE loop out of the queue — these tests watch the
 * rebuild loop only.
 */
function mkWorkspace(): { dir: string; queueFile: string; cfg: ClientConfig } {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-rebuild-'));
  const queueFile = join(dir, 'queue.jsonl');
  writeFileSync(queueFile, JSON.stringify({ job_id: 'seed-1', payload: { url: 'u', company: 'c', title: 't', score: 5 } }) + '\n');
  const cfg: ClientConfig = {
    server_url: arb.url,
    token: 't',
    client_name: 'rebuild-test-client',
    ip: '',
    proxy_port: 0,
    llm_target: 'http://127.0.0.1:1',
    aggregate_port: 0,
    repo_root: here,
    state_dir: join(dir, 'state'),
    state_file: join(dir, 'state.json'),
    projects: [
      {
        name: 'rb-proj',
        queue_file: queueFile,
        results_file: join(dir, 'results.jsonl'),
        model: 'm',
        // Never used: the fake arbiter reports idle=false, so no lease is
        // ever granted and the executor never runs in these tests.
        executor: 'node -e ""',
        estimated_seconds: 10,
      },
    ],
  };
  mkdirSync(cfg.state_dir, { recursive: true });
  return { dir, queueFile, cfg };
}

function mkDaemon(cfg: ClientConfig, logLines: string[]): ClientDaemon {
  return new ClientDaemon(cfg, { pollMs: 50, log: { info: (m: string) => logLines.push(m) } });
}

async function waitFor(pred: () => boolean, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

test('due rebuild: command runs, queue grows, run state records exit 0 + depths, heartbeat carries last_rebuild', async () => {
  const { dir, queueFile, cfg } = mkWorkspace();
  cfg.projects[0]!.scheduled_rebuild = { enabled: true, command: `bash ${addFixture} ${queueFile}`, every_minutes: 60 };
  arb.idle = false; // lease loop stays out; rebuild loop is independent of it
  const logs: string[] = [];
  const d = mkDaemon(cfg, logs);
  await d.start();
  // The heartbeat that carries last_rebuild is the tick AFTER the rebuild
  // finished (register builds its payload at tick start) — wait for both.
  const ok = await waitFor(
    () =>
      readRebuildState(queueFile) !== null &&
      arb.registers.some(
        (r) => (r.projects as { name: string; last_rebuild?: RebuildRunState }[] | undefined)?.some((p) => p.name === 'rb-proj' && p.last_rebuild),
      ),
  );
  await d.stop();

  try {
    assert.ok(ok, 'the rebuild ran on the first tick (no prior state = due)');
    const st = readRebuildState(queueFile)!;
    assert.equal(st.exit_code, 0, 'exit 0 recorded');
    assert.equal(st.queue_before, 1, 'depth before (daemon-measured, not parsed from output)');
    assert.equal(st.queue_after, 2, 'depth after — the fixture appended one job');
    assert.equal(queueDepth(queueFile), 2, 'the queue really grew');
    assert.ok(st.duration_ms >= 0 && st.last_run_ts > 0, 'timestamp + duration recorded');

    // The heartbeat (register payload) carries the run state for the dashboard.
    const withRb = arb.registers
      .map((r) => (r.projects as { name: string; last_rebuild?: RebuildRunState }[] | undefined)?.find((p) => p.name === 'rb-proj'))
      .filter((p) => p?.last_rebuild);
    assert.ok(withRb.length >= 1, 'a registration heartbeat carried last_rebuild');
    assert.deepEqual(withRb[withRb.length - 1]!.last_rebuild, st, 'the heartbeat echoes the persisted run state');
    assert.ok(logs.some((l) => /scheduled rebuild \(rb-proj\): queue 1 → 2/.test(l)), 'the log shows the refill');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed rebuild command: queue untouched by the daemon, exit code recorded in run state', async () => {
  const { dir, queueFile, cfg } = mkWorkspace();
  // Black-box failure: exit 2, and the command does NOT touch the queue.
  cfg.projects[0]!.scheduled_rebuild = { enabled: true, command: 'node -e "process.exit(2)"', every_minutes: 60 };
  arb.idle = false;
  const logs: string[] = [];
  const d = mkDaemon(cfg, logs);
  await d.start();
  const ok = await waitFor(() => readRebuildState(queueFile) !== null);
  await d.stop();

  try {
    assert.ok(ok, 'the failed run still persisted run state');
    const st = readRebuildState(queueFile)!;
    assert.equal(st.exit_code, 2, 'the failure exit code is recorded');
    assert.equal(st.queue_before, 1);
    assert.equal(st.queue_after, 1, 'depth unchanged — the daemon never touched the queue');
    assert.equal(queueDepth(queueFile), 1, 'the live queue is intact after a failed rebuild');
    assert.ok(logs.some((l) => /FAILED \(exit 2\)/.test(l)), 'the failure is logged loudly');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('not-due: a fresh last_run_ts keeps the command from running (cadence survives restart)', async () => {
  const { dir, queueFile, cfg } = mkWorkspace();
  const marker = join(dir, 'ran.marker');
  cfg.projects[0]!.scheduled_rebuild = { enabled: true, command: `touch ${marker}`, every_minutes: 60 };
  // Persisted state from "59 minutes ago" — a restarted daemon must NOT
  // re-run until the minimum interval has passed.
  writeRebuildState(queueFile, { last_run_ts: Date.now() - 59 * 60_000, exit_code: 0, duration_ms: 10, queue_before: 1, queue_after: 1 });
  arb.idle = false;
  const d = mkDaemon(cfg, []);
  await d.start();
  await new Promise((r) => setTimeout(r, 800)); // many poll ticks
  await d.stop();
  try {
    assert.ok(!existsSync(marker), 'the command never ran while the cadence said not-due');
    assert.equal(queueDepth(queueFile), 1, 'queue untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlapping rebuilds refused: one in flight per project across many ticks', async () => {
  const { dir, queueFile, cfg } = mkWorkspace();
  const counter = join(dir, 'runs.count');
  // The fixture bumps the counter once per invocation, then sleeps 1.5s —
  // ~30 poll ticks pass while it is in flight. The guard must keep it at 1.
  cfg.projects[0]!.scheduled_rebuild = { enabled: true, command: `bash ${sleepFixture} ${counter}`, every_minutes: 60 };
  arb.idle = false;
  const d = mkDaemon(cfg, []);
  await d.start();
  const started = await waitFor(() => existsSync(counter), 3000);
  assert.ok(started, 'the first rebuild started');
  await new Promise((r) => setTimeout(r, 1000)); // still in flight, many ticks
  const midCount = existsSync(counter) ? readFileSync(counter, 'utf-8').length : 0;
  assert.equal(midCount, 1, `only ONE rebuild in flight (counter=${midCount} after ~20 ticks)`);
  const done = await waitFor(() => readRebuildState(queueFile) !== null, 5000);
  await d.stop();
  try {
    assert.ok(done, 'the run finished and persisted state');
    assert.equal(readFileSync(counter, 'utf-8').length, 1, 'still exactly one invocation total');
    assert.equal(readRebuildState(queueFile)!.exit_code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
