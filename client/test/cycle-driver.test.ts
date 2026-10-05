/**
 * cycle-driver.test.ts — the built cycle driver + cycles-file helpers
 * (issue #58, docs/architecture/dev-cycles.md D1-D7).
 *
 * The spike (dev-cycle-worked-example.test.ts) proved the state machine on
 * the real daemon; THIS file tests the shipped driver in client/src against
 * the same real primitives (queue.jsonl, results.jsonl, quarantine.jsonl,
 * <queue_file>.cycles.json). The executor stand-in is a file-level settle
 * helper: it removes the stage's queue line and appends its result line —
 * exactly what the daemon's success path does — so the assertions are
 * deterministic. The driver never spawns an executor (D3); nothing here
 * needs an arbiter.
 *
 * Covers (issue #58 acceptance):
 *   - cursor advance after an item passes; a gate job queued AFTER its item
 *   - queue payloads GAIN cycle_id + stage (D7)
 *   - gate-failure quarantine (reason gate_<name>_failed) + skip of the
 *     item's remaining gates (owner decision 3); the cycle keeps going
 *   - cycle_max_in_flight=1 admission: a second cycle does not start
 *   - resume across a simulated restart: a fresh driver instance reading
 *     the same files never re-queues a settled stage
 *   - an unknown verdict parks the cursor (D6 rule 1)
 *   - a corrupt cycles file fails closed: the driver does nothing, the
 *     queue is untouched
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CycleDriver,
  cyclesFile,
  readCycles,
  writeCycles,
  readQueue,
  writeQueue,
  queueDepth,
  appendResult,
  type CycleRow,
  type CycleItemSpec,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Scratch harness: real files, no arbiter, no executor.
// ---------------------------------------------------------------------------

interface Scratch {
  dir: string;
  queueFile: string;
  resultsFile: string;
  stateDir: string;
}

function mkScratch(tag: string): Scratch {
  const dir = mkdtempSync(join(tmpdir(), `idlefill-cyc-${tag}-`));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  return { dir, queueFile: join(dir, 'queue.jsonl'), resultsFile: join(dir, 'results.jsonl'), stateDir };
}

const PASS_RULE = 'echo.note contains verdict=pass';

function mkItem(jobId: string, gateNames: string[]): CycleItemSpec {
  return {
    job_id: jobId,
    payload: { target: 'repo-X', note: `issue:${jobId}` },
    gates: gateNames.map((g) => ({
      name: g,
      job_id: `gate-${g}-${jobId}`,
      rule: PASS_RULE,
      payload: { target: 'repo-X', note: `gate:${g}` },
    })),
  };
}

function mkRow(cycleId: string, items: CycleItemSpec[], status: CycleRow['status'] = 'planned'): CycleRow {
  return { cycle_id: cycleId, project: 'dev-cycle', status, items, cursor: { item: 0, stage: 'item', gate: 0 }, verdicts: {} };
}

/** Stand-in for the daemon's success path: the stage's queue line leaves the
 *  queue and its result line lands in results.jsonl (ok:true = the check
 *  RAN; the gate RULE decides whether it passed — D3's verdict split). */
function settle(s: Scratch, jobId: string, note: string): void {
  writeQueue(s.queueFile, readQueue(s.queueFile).filter((j) => j.job_id !== jobId));
  appendResult(s.resultsFile, { ok: true, job_id: jobId, echo: { target: 'repo-X', note }, ts: new Date().toISOString() });
}

function readQuarantine(s: Scratch): Record<string, unknown>[] {
  const f = join(s.stateDir, 'quarantine.jsonl');
  try {
    return readFileSync(f, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function driver(s: Scratch, maxInFlight = 1): CycleDriver {
  return new CycleDriver(s.queueFile, s.resultsFile, s.stateDir, maxInFlight);
}

// ---------------------------------------------------------------------------

test('cursor advances after an item passes; each gate job is queued only after its item settled; payloads gain cycle_id + stage', () => {
  const s = mkScratch('advance');
  try {
    writeCycles(s.queueFile, [mkRow('c-adv', [mkItem('i1', ['build', 'review']), mkItem('i2', ['build', 'review'])])]);
    writeQueue(s.queueFile, []);
    const d = driver(s);

    d.tick();
    let q = readQueue(s.queueFile);
    assert.deepEqual(q.map((j) => j.job_id), ['i1'], 'the driver enqueues the first item on its first tick');
    assert.equal(q[0]!.payload.cycle_id, 'c-adv', 'queue payload GAINS cycle_id (D7)');
    assert.equal(q[0]!.payload.stage, 'item', 'queue payload GAINS stage (D7)');
    assert.equal(q[0]!.payload.target, 'repo-X', 'the item payload keys ride along');

    // The gate must NOT be queued while the item is still in flight.
    settle(s, 'i1', 'worked');
    d.tick();
    q = readQueue(s.queueFile);
    assert.deepEqual(q.map((j) => j.job_id), ['gate-build-i1'], 'the first gate is queued only after the item settled');
    assert.equal(q[0]!.payload.stage, 'gate:build', 'gate stage names the gate');

    settle(s, 'gate-build-i1', 'verdict=pass');
    d.tick();
    assert.deepEqual(readQueue(s.queueFile).map((j) => j.job_id), ['gate-review-i1'], 'the second gate queues after the first passed');

    settle(s, 'gate-review-i1', 'verdict=pass');
    d.tick();
    const rows = readCycles(s.queueFile)!;
    assert.equal(rows[0]!.cursor.item, 1, 'the cursor advanced to the next item after all gates passed');
    assert.deepEqual(rows[0]!.verdicts, { i1: 'passed' });
    assert.equal(queueDepth(s.queueFile), 0, 'the advance itself queues nothing — the next tick admits the next item');
    d.tick();
    assert.deepEqual(readQueue(s.queueFile).map((j) => j.job_id), ['i2'], 'the next item is queued on the tick after the advance');

    settle(s, 'i2', 'worked');
    d.tick();
    settle(s, 'gate-build-i2', 'verdict=pass');
    d.tick();
    settle(s, 'gate-review-i2', 'verdict=pass');
    d.tick();
    const done = readCycles(s.queueFile)!;
    assert.equal(done[0]!.status, 'done', 'the cycle finishes when the cursor walks the whole series');
    assert.equal(done[0]!.cursor.item, 2);
    assert.deepEqual(done[0]!.verdicts, { i1: 'passed', i2: 'passed' });
    assert.equal(queueDepth(s.queueFile), 0, 'the queue drained through the driver + settle path');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a failing gate verdict quarantines the ITEM (gate_<name>_failed) and skips the item\'s remaining gates; the cycle keeps going', () => {
  const s = mkScratch('gatefail');
  try {
    writeCycles(s.queueFile, [mkRow('c-gf', [mkItem('i1', ['build', 'review']), mkItem('i2', [])])]);
    writeQueue(s.queueFile, []);
    const d = driver(s);

    d.tick();
    settle(s, 'i1', 'worked');
    d.tick();
    // The check RAN (ok:true) but reported the failing fact — the RULE decides.
    settle(s, 'gate-build-i1', 'verdict=fail');
    d.tick();

    const q = readQuarantine(s);
    assert.equal(q.length, 1, 'exactly one quarantine line (the cycle is not poisoned)');
    assert.equal(q[0]!.job_id, 'i1');
    assert.equal(q[0]!.error, 'gate_build_failed', 'the reason names the failing gate');

    const rows = readCycles(s.queueFile)!;
    assert.deepEqual(rows[0]!.verdicts, { i1: 'quarantined' });
    assert.equal(rows[0]!.cursor.item, 1, 'the cursor advanced to the next item — the cycle never stops (D6 rule 2)');
    d.tick();
    assert.deepEqual(readQueue(s.queueFile).map((j) => j.job_id), ['i2'], 'the next item runs on');

    // Short-circuit (owner decision 3): the review gate was NEVER queued.
    const results = readFileSync(s.resultsFile, 'utf-8');
    assert.ok(!results.includes('gate-review-i1'), 'the remaining gate was skipped — no result line for it');
    assert.ok(!readQueue(s.queueFile).some((j) => j.job_id === 'gate-review-i1'), 'the remaining gate was never queued');

    settle(s, 'i2', 'worked');
    d.tick();
    assert.equal(readCycles(s.queueFile)![0]!.status, 'done');
    assert.deepEqual(readCycles(s.queueFile)![0]!.verdicts, { i1: 'quarantined', i2: 'passed' });
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('cycle_max_in_flight=1: a second cycle does not start while the first holds a running stage; 2 admits both', () => {
  const s = mkScratch('inflight');
  try {
    const rows = [mkRow('cA', [mkItem('a1', [])]), mkRow('cB', [mkItem('b1', [])])];
    writeCycles(s.queueFile, rows);
    writeQueue(s.queueFile, []);
    const d = driver(s, 1);

    d.tick();
    assert.deepEqual(readQueue(s.queueFile).map((j) => j.job_id), ['a1'], 'only the first cycle was admitted');
    let persisted = readCycles(s.queueFile)!;
    assert.equal(persisted[0]!.status, 'running', 'the admitted row flipped planned → running');
    assert.equal(persisted[1]!.status, 'planned', 'the second row stays planned (admission cap)');

    d.tick();
    d.tick();
    assert.equal(queueDepth(s.queueFile), 1, 'repeated ticks do not admit the second cycle while the first stage is queued');

    // The cap is a driver rule: with max 2 both rows start.
    const s2 = mkScratch('inflight2');
    try {
      writeCycles(s2.queueFile, [mkRow('cA', [mkItem('a1', [])]), mkRow('cB', [mkItem('b1', [])])]);
      writeQueue(s2.queueFile, []);
      driver(s2, 2).tick();
      assert.deepEqual(readQueue(s2.queueFile).map((j) => j.job_id).sort(), ['a1', 'b1'], 'max_in_flight=2 admits both cycles');
    } finally {
      rmSync(s2.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('resume across a simulated restart: a fresh driver reading the same files resumes mid-series and never re-queues a settled stage', () => {
  const s = mkScratch('resume');
  try {
    writeCycles(s.queueFile, [mkRow('c-rs', [mkItem('i1', ['build', 'review']), mkItem('i2', [])])]);
    writeQueue(s.queueFile, []);
    const d1 = driver(s);
    d1.tick();
    settle(s, 'i1', 'worked');
    d1.tick();
    settle(s, 'gate-build-i1', 'verdict=pass');
    // "Restart": nothing from d1's memory survives; the files are the truth.
    const persisted = readCycles(s.queueFile);
    assert.ok(persisted && persisted.length === 1, 'the cycles file survived the restart');
    assert.equal(persisted[0]!.cursor.stage, 'gate', 'the persisted cursor sat on the gate stage');

    const d2 = driver(s);
    d2.tick();
    assert.deepEqual(readQueue(s.queueFile).map((j) => j.job_id), ['gate-review-i1'], 'the resumed driver queued exactly the next unresolved stage');

    settle(s, 'gate-review-i1', 'verdict=pass');
    d2.tick();
    d2.tick();
    assert.deepEqual(readQueue(s.queueFile).map((j) => j.job_id), ['i2'], 'the series continued across the restart');
    settle(s, 'i2', 'worked');
    d2.tick();
    const rows = readCycles(s.queueFile)!;
    assert.equal(rows[0]!.status, 'done');
    assert.deepEqual(rows[0]!.verdicts, { i1: 'passed', i2: 'passed' });
    const results = readFileSync(s.resultsFile, 'utf-8');
    assert.equal(results.split('\n').filter((l) => l.includes('"i1"')).length, 1, 'the settled item was NOT re-run after the restart');
    assert.equal(results.split('\n').filter((l) => l.includes('gate-build-i1')).length, 1, 'the settled gate was NOT re-run after the restart');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('an unknown verdict parks the cursor: an unsettled stage never advances and never queues a later item', () => {
  const s = mkScratch('park');
  try {
    writeCycles(s.queueFile, [mkRow('c-pk', [mkItem('i1', ['build']), mkItem('i2', [])])]);
    writeQueue(s.queueFile, []);
    const d = driver(s);
    d.tick();
    settle(s, 'i1', 'worked');
    d.tick();
    // The build gate sits in the queue, unsettled (the stand-in for a
    // preempted/timed-out/lost-lease stage that never reported).
    for (let i = 0; i < 10; i++) d.tick();
    const rows = readCycles(s.queueFile)!;
    assert.equal(rows[0]!.cursor.item, 0, 'the cursor does not advance on an unknown verdict (D6 rule 1)');
    assert.equal(rows[0]!.cursor.stage, 'gate', 'the cursor stays parked on the unresolved gate');
    assert.deepEqual(readQueue(s.queueFile).map((j) => j.job_id), ['gate-build-i1'], 'no later cycle item was enqueued behind the unresolved gate');
    assert.deepEqual(rows[0]!.verdicts, {}, 'no verdict was guessed');

    // The stage settles: the cycle resumes and finishes.
    settle(s, 'gate-build-i1', 'verdict=pass');
    d.tick();
    assert.equal(readCycles(s.queueFile)![0]!.cursor.item, 1, 'the cursor advanced once the verdict was known');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a corrupt cycles file fails closed: the driver does nothing and the queue drains normally', () => {
  const s = mkScratch('corrupt');
  try {
    writeFileSync(cyclesFile(s.queueFile), '{not json at all');
    writeQueue(s.queueFile, [{ job_id: 'plain-job', payload: { target: 'repo-X', note: 'n' } }]);
    const d = driver(s);
    d.tick();
    d.tick();
    assert.equal(readCycles(s.queueFile), null, 'a corrupt cycles file reads as null (state.json posture, D4)');
    assert.equal(queueDepth(s.queueFile), 1, 'queue truth is untouched by a corrupt cycles file');
    assert.equal(readQueue(s.queueFile)[0]!.job_id, 'plain-job', 'the plain queue line is intact — the daemon drains normally');
    assert.equal(readFileSync(cyclesFile(s.queueFile), 'utf-8'), '{not json at all', 'the driver never rewrote the corrupt file');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
