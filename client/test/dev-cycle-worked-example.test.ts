/**
 * dev-cycle-worked-example.test.ts — the issue #53 cycle state machine SPIKE.
 *
 * This is a SPIKE, not a feature. It proves the cycle design in
 * `docs/architecture/dev-cycles.md` maps onto the primitives that already
 * exist. It changes NOTHING under client/src or server: the proposed cycle
 * driver is written HERE, in the test, and drives the REAL ClientDaemon
 * against the REAL noop adapter (adapters/noop/eval.mjs) through the fake
 * arbiter. If this spike needed src changes to run, that would be the
 * finding — it did not.
 *
 * The worked example: "resolve open issues in repo X" — three items, each
 * followed by two gates (build, review). Item 2's build gate returns a
 * FAILING verdict. The gate failure quarantines item 2 and the cycle
 * continues to item 3.
 *
 * How the spike models the design (decision refs in dev-cycles.md):
 *   - D1/D3: every stage — item attempt AND gate — is one queue.jsonl line
 *     leased through the normal lease loop. The driver never spawns an
 *     executor itself.
 *   - D2/D4: the cycle row (cursor + items + gate rules) persists to
 *     `<queue_file>.cycles.json` with the tmp+rename discipline of
 *     writeQueue/writeRebuildState. A restart rebuilds a driver from that
 *     file plus the queue/results ground truth.
 *   - D6: the driver advances ONLY on a settled, known verdict. An
 *     unresolved stage parks the cursor — the cycle waits, it does not
 *     guess.
 *
 * The gate verdict: the noop adapter is a stand-in gate executor. The gate
 * job's payload declares the fact it will report (`verdict=pass` /
 * `verdict=fail` in `note`); the noop result line echoes the declared
 * fields; the driver's gate RULE reads that echo and decides pass/fail.
 * That split is the design's: the executor says "the check ran", the rule
 * says "the check passed".
 *
 * Covers:
 *   - full cycle end-to-end on the noop adapter: 3 items x 2 gates, every
 *     stage leased through the arbiter
 *   - one gate failure quarantines ONE item (quarantine.jsonl, reason
 *     gate_build_failed) while the cycle runs on to the next item
 *   - cycle metadata (cycle_id/stage) rides the queue line but never
 *     reaches the executor contract (the noop echo carries only the
 *     declared payload_fields)
 *   - resumability: a driver rebuilt from the persisted cycles file +
 *     ground truth resumes mid-series and never re-leases a settled stage
 *   - fail-closed on an unknown verdict: an unsettled gate parks the
 *     cursor; no later item is enqueued until the gate settles
 *   - corrupt cycles file reads as null (fail-closed for cycles, queue
 *     unaffected)
 *   - multi-cycle concurrency (issue #56, D9.1/D9.3): two cycles on one
 *     project against one daemon — with cap 1 cycle B's first stage never
 *     enters the queue while cycle A holds a stage; with cap 2 both first
 *     stages sit in the queue and both cycles lease through the arbiter;
 *     a gate failure quarantines ONE cycle's item while the other cycle's
 *     verdicts stay clean
 */

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClientDaemon,
  readQueue,
  writeQueue,
  quarantineJob,
  queueDepth,
  type QueueJob,
} from '../src/index.js';
import type { ClientConfig } from '../src/config.js';
import { startFakeArbiter, type FakeArbiter } from './fake-arbiter.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const noopExecutor = `node ${join(repoRoot, 'adapters', 'noop', 'eval.mjs')} {payload_file} {result_file}`;

// ---------------------------------------------------------------------------
// The proposed cycle row shape (dev-cycles.md D4) — defined HERE because
// this is a spike; the build wave moves it into client/src.
// ---------------------------------------------------------------------------

interface GateSpec {
  name: string;
  job_id: string;
  /** The gate rule, stored verbatim (the Phase 2 seam, D8). */
  rule: string;
}
interface ItemSpec {
  job_id: string;
  gates: GateSpec[];
}
interface CycleCursor {
  item: number;
  stage: 'item' | 'gate';
  gate: number;
}
interface CycleRow {
  cycle_id: string;
  project: string;
  status: 'planned' | 'running' | 'paused' | 'done';
  items: ItemSpec[];
  cursor: CycleCursor;
  verdicts: Record<string, 'passed' | 'quarantined'>;
}

/** `<queue_file>.cycles.json` — the rebuildStateFile pattern (D4). */
function cyclesFile(queueFile: string): string {
  return `${queueFile}.cycles.json`;
}

function readCycles(queueFile: string): CycleRow[] | null {
  const f = cyclesFile(queueFile);
  if (!existsSync(f)) return null;
  try {
    const raw = JSON.parse(readFileSync(f, 'utf-8'));
    if (!Array.isArray(raw)) return null;
    return raw as CycleRow[];
  } catch {
    return null; // corrupt = fail-closed for cycles (state.json posture)
  }
}

function writeCycles(queueFile: string, rows: CycleRow[]): void {
  const f = cyclesFile(queueFile);
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2) + '\n');
  // renameSync is the atomic half of the pattern; the write above is the tmp half.
  renameSync(tmp, f);
}

// ---------------------------------------------------------------------------
// Ground-truth readers + payload builders shared by both spike drivers.
// ---------------------------------------------------------------------------

/** The LAST result line for a job_id, or null when it never settled. */
function lastResultLine(resultsFile: string, jobId: string): Record<string, unknown> | null {
  if (!existsSync(resultsFile)) return null;
  let hit: Record<string, unknown> | null = null;
  for (const l of readFileSync(resultsFile, 'utf-8').split('\n')) {
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
function quarantinedJob(stateDir: string, jobId: string): boolean {
  const f = join(stateDir, 'quarantine.jsonl');
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

/** The gate rule (D3): the executor's ok says the check RAN; the rule
 *  decides whether it PASSED. The noop stand-in reports the verdict in
 *  its echoed `note`. */
function verdictNotePassed(gate: GateSpec, result: Record<string, unknown>): boolean {
  const echo = result.echo as Record<string, unknown> | undefined;
  const note = String(echo?.note ?? '');
  if (gate.rule === 'note contains verdict=pass') return note.includes('verdict=pass');
  return false; // an unrecognized rule never passes (fail-closed, D6)
}

/** Item stage payload. cycle_id/stage are queue-line metadata; the project's
 *  payload_fields decide what reaches the executor — these must NOT (asserted). */
function itemPayloadFor(cycleId: string, item: ItemSpec): QueueJob['payload'] {
  return {
    target: 'repo-X',
    note: `issue:${item.job_id}`,
    cycle_id: cycleId,
    stage: 'item',
  };
}

function gatePayloadFor(cycleId: string, gate: GateSpec, verdict: 'pass' | 'fail'): QueueJob['payload'] {
  return {
    target: 'repo-X',
    note: `gate:${gate.name}:verdict=${verdict}`,
    cycle_id: cycleId,
    stage: `gate:${gate.name}`,
  };
}

// ---------------------------------------------------------------------------
// The proposed cycle driver (dev-cycles.md D1) — written HERE for the spike.
// ---------------------------------------------------------------------------

class CycleDriver {
  readonly queueFile: string;
  readonly resultsFile: string;
  readonly stateDir: string;
  row: CycleRow;
  /** Which verdict each item's stand-in gate executor will report. */
  readonly verdictPlan: Record<string, 'pass' | 'fail'>;
  /** Gate verdicts the driver applied, in order (audit for the assertions). */
  readonly gateVerdicts: { gate: string; item: string; passed: boolean }[] = [];

  constructor(queueFile: string, resultsFile: string, stateDir: string, row: CycleRow, verdictPlan: Record<string, 'pass' | 'fail'> = {}) {
    this.queueFile = queueFile;
    this.resultsFile = resultsFile;
    this.stateDir = stateDir;
    this.row = row;
    this.verdictPlan = verdictPlan;
  }

  /** Persist the row atomically (tmp + rename, like writeQueue). */
  save(): void {
    writeCycles(this.queueFile, [this.row]);
  }

  /** The LAST result line for a job_id, or null when it never settled. */
  private lastResult(jobId: string): Record<string, unknown> | null {
    return lastResultLine(this.resultsFile, jobId);
  }

  /** The gate rule (D3): the executor's ok says the check RAN; the rule
   *  decides whether it PASSED. The noop stand-in reports the verdict in
   *  its echoed `note`. */
  private gatePassed(gate: GateSpec, result: Record<string, unknown>): boolean {
    return verdictNotePassed(gate, result);
  }

  private enqueue(job: QueueJob): void {
    writeQueue(this.queueFile, [...readQueue(this.queueFile), job]);
  }

  itemPayload(item: ItemSpec, stage: string): QueueJob['payload'] {
    // cycle_id/stage are queue-line metadata. The project's payload_fields
    // decide what reaches the executor — these two must NOT (asserted).
    return {
      target: 'repo-X',
      note: `issue:${item.job_id}`,
      cycle_id: this.row.cycle_id,
      stage,
    };
  }

  private gatePayload(item: ItemSpec, gate: GateSpec, verdict: 'pass' | 'fail'): QueueJob['payload'] {
    return {
      target: 'repo-X',
      note: `gate:${gate.name}:verdict=${verdict}`,
      cycle_id: this.row.cycle_id,
      stage: `gate:${gate.name}`,
    };
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

  /**
   * One driver step (the build wave fires this from the poll tick, the
   * maybeRunScheduledRebuilds shape). It re-reads queue + results every
   * step: the cursor never trusts memory (D4).
   */
  tick(): void {
    if (this.row.status !== 'running') return;
    const item = this.row.items[this.row.cursor.item];
    if (!item) {
      this.row.status = 'done';
      this.save();
      return;
    }

    if (this.row.cursor.stage === 'item') {
      if (readQueue(this.queueFile).some((j) => j.job_id === item.job_id)) return; // queued/running: the daemon owns it
      if (this.quarantined(item.job_id)) {
        // the retry path exhausted the item (MAX_ATTEMPTS) — no verdict needed
        this.verdicts(item.job_id, 'quarantined');
        this.advance();
        return;
      }
      const res = this.lastResult(item.job_id);
      if (!res) {
        // never started (fresh cursor, or a restart mid-series): enqueue it
        this.enqueue({ job_id: item.job_id, payload: this.itemPayload(item, 'item') });
        this.save();
        return;
      }
      if (res.ok !== true) return; // failed: the daemon re-queued it, wait
      if (item.gates.length === 0) {
        this.verdicts(item.job_id, 'passed');
        this.advance();
        return;
      }
      this.row.cursor.stage = 'gate';
      this.row.cursor.gate = 0;
      this.enqueue({ job_id: item.gates[0]!.job_id, payload: this.gatePayload(item, item.gates[0]!, this.verdictPlan[item.job_id] ?? 'pass') });
      this.save();
      return;
    }

    // stage === 'gate'
    const gate = item.gates[this.row.cursor.gate];
    if (!gate) {
      this.verdicts(item.job_id, 'passed');
      this.advance();
      return;
    }
    if (readQueue(this.queueFile).some((j) => j.job_id === gate.job_id)) return; // queued/running: park (D6 rule 1)
    if (this.quarantined(gate.job_id)) {
      // the gate job itself exhausted its attempts: fail CLOSED for the item
      quarantineJob(this.stateDir, this.queueFile, { job_id: item.job_id, payload: this.itemPayload(item, 'item') }, `gate_${gate.name}_exhausted`);
      this.gateVerdicts.push({ gate: gate.name, item: item.job_id, passed: false });
      this.verdicts(item.job_id, 'quarantined');
      this.advance();
      return;
    }
    const res = this.lastResult(gate.job_id);
    if (!res) {
      // never started (fresh stage, or a restart mid-series): enqueue it
      this.enqueue({ job_id: gate.job_id, payload: this.gatePayload(item, gate, this.verdictPlan[item.job_id] ?? 'pass') });
      this.save();
      return;
    }
    if (res.ok !== true) return; // the gate job itself failed: retry path owns it
    const passed = this.gatePassed(gate, res);
    this.gateVerdicts.push({ gate: gate.name, item: item.job_id, passed });
    if (!passed) {
      // D3: the gate quarantines the ITEM, not the cycle. The item already
      // left the queue on its own success, so this append is the audit line.
      quarantineJob(this.stateDir, this.queueFile, { job_id: item.job_id, payload: this.itemPayload(item, 'item') }, `gate_${gate.name}_failed`);
      this.verdicts(item.job_id, 'quarantined');
      this.advance();
      return;
    }
    this.row.cursor.gate += 1;
    const next = item.gates[this.row.cursor.gate];
    if (next) {
      this.enqueue({ job_id: next.job_id, payload: this.gatePayload(item, next, this.verdictPlan[item.job_id] ?? 'pass') });
    } else {
      this.verdicts(item.job_id, 'passed');
      this.advance();
    }
    this.save();
  }

  private verdicts(jobId: string, v: 'passed' | 'quarantined'): void {
    this.row.verdicts[jobId] = v;
  }

  private advance(): void {
    this.row.cursor.item += 1;
    this.row.cursor.stage = 'item';
    this.row.cursor.gate = 0;
    if (this.row.cursor.item >= this.row.items.length) this.row.status = 'done';
    this.save();
  }
}

// ---------------------------------------------------------------------------
// The issue #56 spike driver: N cycle rows in ONE project, capped by
// maxInFlight (D9.1). It mirrors the shipped CycleDriver.tick() shape —
// admission counts the rows that HOLD a stage job in the queue — but lives
// HERE because this spike proves the design, and the shipped unit tests
// (test/cycle-driver.test.ts) already cover the cap itself.
// ---------------------------------------------------------------------------

class MultiCycleDriver {
  readonly queueFile: string;
  readonly resultsFile: string;
  readonly stateDir: string;
  readonly maxInFlight: number;
  /** Which verdict each item's stand-in gate executor reports. */
  readonly verdictPlan: Record<string, 'pass' | 'fail'>;

  constructor(queueFile: string, resultsFile: string, stateDir: string, maxInFlight: number, verdictPlan: Record<string, 'pass' | 'fail'> = {}) {
    this.queueFile = queueFile;
    this.resultsFile = resultsFile;
    this.stateDir = stateDir;
    this.maxInFlight = Number.isFinite(maxInFlight) && maxInFlight >= 1 ? Math.floor(maxInFlight) : 1;
    this.verdictPlan = verdictPlan;
  }

  /** The stage job the cursor points at, or null past the item list. */
  private stageJobOf(row: CycleRow): string | null {
    const item = row.items[row.cursor.item];
    if (!item) return null;
    if (row.cursor.stage === 'item') return item.job_id;
    return item.gates[row.cursor.gate]?.job_id ?? null;
  }

  /**
   * D9.1: a row HOLDS a stage when its current stage job sits in the queue
   * file. The cap counts holding rows — queued-or-leased, because the daemon
   * keeps a leased job in the queue until it settles.
   */
  private inFlight(rows: CycleRow[], queued: Set<string>): number {
    return rows.reduce((n, r) => {
      if (r.status !== 'running') return n;
      const s = this.stageJobOf(r);
      return s !== null && queued.has(s) ? n + 1 : n;
    }, 0);
  }

  /** One driver step over every row in the project's cycles file. */
  tick(): void {
    const rows = readCycles(this.queueFile);
    if (!rows || rows.length === 0) return; // no cycles file: fail closed
    const queued = new Set(readQueue(this.queueFile).map((j) => j.job_id));

    for (const row of rows) {
      if (row.status === 'done' || row.status === 'paused') continue;
      const stage = this.stageJobOf(row);
      const holds = stage !== null && queued.has(stage);
      if (!holds && this.inFlight(rows, queued) >= this.maxInFlight) continue; // D9.1 admission cap
      this.stepRow(row, queued);
    }
    writeCycles(this.queueFile, rows);
  }

  private stepRow(row: CycleRow, queued: Set<string>): void {
    if (row.status === 'planned') row.status = 'running'; // admitted: it starts
    const item = row.items[row.cursor.item];
    if (!item) {
      row.status = 'done';
      return;
    }

    if (row.cursor.stage === 'item') {
      if (queued.has(item.job_id)) return; // queued/running: the daemon owns it
      if (quarantinedJob(this.stateDir, item.job_id)) {
        row.verdicts[item.job_id] = 'quarantined';
        this.advance(row);
        return;
      }
      const res = lastResultLine(this.resultsFile, item.job_id);
      if (!res) {
        this.enqueue({ job_id: item.job_id, payload: itemPayloadFor(row.cycle_id, item) });
        queued.add(item.job_id);
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
      this.enqueue({ job_id: first.job_id, payload: gatePayloadFor(row.cycle_id, first, this.verdictPlan[item.job_id] ?? 'pass') });
      queued.add(first.job_id);
      return;
    }

    const gate = item.gates[row.cursor.gate];
    if (!gate) {
      row.verdicts[item.job_id] = 'passed';
      this.advance(row);
      return;
    }
    if (queued.has(gate.job_id)) return; // queued/running: park (D6 rule 1)
    if (quarantinedJob(this.stateDir, gate.job_id)) {
      quarantineJob(this.stateDir, this.queueFile, { job_id: item.job_id, payload: itemPayloadFor(row.cycle_id, item) }, `gate_${gate.name}_exhausted`);
      row.verdicts[item.job_id] = 'quarantined';
      this.advance(row);
      return;
    }
    const res = lastResultLine(this.resultsFile, gate.job_id);
    if (!res) {
      this.enqueue({ job_id: gate.job_id, payload: gatePayloadFor(row.cycle_id, gate, this.verdictPlan[item.job_id] ?? 'pass') });
      queued.add(gate.job_id);
      return;
    }
    if (res.ok !== true) return;
    if (!verdictNotePassed(gate, res)) {
      quarantineJob(this.stateDir, this.queueFile, { job_id: item.job_id, payload: itemPayloadFor(row.cycle_id, item) }, `gate_${gate.name}_failed`);
      row.verdicts[item.job_id] = 'quarantined';
      this.advance(row); // owner decision 3: skip the item's remaining gates
      return;
    }
    row.cursor.gate += 1;
    const next = item.gates[row.cursor.gate];
    if (next) {
      this.enqueue({ job_id: next.job_id, payload: gatePayloadFor(row.cycle_id, next, this.verdictPlan[item.job_id] ?? 'pass') });
      queued.add(next.job_id);
    } else {
      row.verdicts[item.job_id] = 'passed';
      this.advance(row);
    }
  }

  private enqueue(job: QueueJob): void {
    writeQueue(this.queueFile, [...readQueue(this.queueFile), job]);
  }

  private advance(row: CycleRow): void {
    row.cursor.item += 1;
    row.cursor.stage = 'item';
    row.cursor.gate = 0;
    if (row.cursor.item >= row.items.length) row.status = 'done';
  }
}

// ---------------------------------------------------------------------------
// Harness: real daemon + real noop adapter + fake arbiter
// ---------------------------------------------------------------------------

let dir: string;
let arb: FakeArbiter;
let queueFile: string;
let resultsFile: string;
let stateDir: string;
let cfg: ClientConfig;

function mkCycle(verdictPlan: Record<string, 'pass' | 'fail'> = {}): CycleDriver {
  const mk = (id: string): ItemSpec => ({
    job_id: id,
    gates: [
      { name: 'build', job_id: `gate-build-${id}`, rule: 'note contains verdict=pass' },
      { name: 'review', job_id: `gate-review-${id}`, rule: 'note contains verdict=pass' },
    ],
  });
  const row: CycleRow = {
    cycle_id: 'resolve-open-issues-repo-X',
    project: 'dev-cycle',
    status: 'running',
    items: [mk('issue-1'), mk('issue-2'), mk('issue-3')],
    cursor: { item: 0, stage: 'item', gate: 0 },
    verdicts: {},
  };
  const d = new CycleDriver(queueFile, resultsFile, stateDir, row, verdictPlan);
  d.save();
  // The queue starts EMPTY: the driver enqueues the first item on its
  // first tick and appends each next stage when the previous one settles
  // (the ordered-series model, D1).
  writeQueue(queueFile, []);
  return d;
}

function resetFiles(): void {
  for (const f of [queueFile, resultsFile, cyclesFile(queueFile), join(stateDir, 'quarantine.jsonl')]) {
    try {
      rmSync(f);
    } catch {
      /* absent */
    }
  }
}

function readQuarantine(): Record<string, unknown>[] {
  const f = join(stateDir, 'quarantine.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function readResults(): Record<string, unknown>[] {
  if (!existsSync(resultsFile)) return [];
  return readFileSync(resultsFile, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function makeDaemon(): ClientDaemon {
  return new ClientDaemon(cfg, { pollMs: 40, log: undefined });
}

/** Run the daemon + driver together until `done()` or the deadline. */
async function runUntil(d: CycleDriver, done: () => boolean, ms = 25_000): Promise<void> {
  const daemon = makeDaemon();
  await daemon.start();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    d.tick();
    if (done()) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await daemon.stop();
  if (!done()) throw new Error('cycle did not settle before the deadline');
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-cycle-'));
  arb = await startFakeArbiter();
  queueFile = join(dir, 'queue.jsonl');
  resultsFile = join(dir, 'results.jsonl');
  stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  cfg = {
    server_url: arb.url,
    token: 't',
    client_name: 'cycle-client',
    ip: '100.94.165.102',
    proxy_port: 0,
    llm_target: 'http://127.0.0.1:1',
    aggregate_port: 0,
    repo_root: repoRoot,
    state_dir: stateDir,
    state_file: join(dir, 'state.json'),
    projects: [
      {
        name: 'dev-cycle',
        queue_file: queueFile,
        results_file: resultsFile,
        model: 'm',
        executor: noopExecutor,
        // The noop manifest vocabulary: cycle metadata must stay out.
        payload_fields: ['target', 'note'],
        estimated_seconds: 10,
      },
    ],
  };
});

after(async () => {
  await arb.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test('worked example: 3 items x 2 gates on the noop adapter; one gate failure quarantines one item and the cycle continues', async () => {
  resetFiles();
  arb.leaseRequests.length = 0;
  arb.usageReports.length = 0;
  arb.idle = true;

  // The gate verdict plan: item-2's gates report verdict=fail. The driver
  // enqueues gate payloads from this plan, so the stand-in executor reports
  // the failing fact and the driver's RULE decides.
  const d = mkCycle({ 'issue-2': 'fail' });

  await runUntil(d, () => d.row.status === 'done');

  // Every stage ran as a real lease through the arbiter — items AND gates.
  const leased = arb.leaseRequests.map((r) => r.job_id);
  for (const id of ['issue-1', 'issue-2', 'issue-3']) {
    assert.ok(leased.includes(id), `item ${id} was leased (a cycle stage is a job, D3)`);
  }
  for (const id of ['gate-build-issue-1', 'gate-review-issue-1', 'gate-build-issue-2', 'gate-build-issue-3', 'gate-review-issue-3']) {
    assert.ok(leased.includes(id), `gate ${id} was leased through the normal lease loop`);
  }
  // D3 short-circuit: item-2's review gate never ran (the build gate already
  // decided the item).
  assert.ok(!leased.includes('gate-review-issue-2'), 'a failing gate short-circuits the item’s remaining gates');

  // The gate failure quarantined exactly ONE item, with the gate named.
  const q = readQuarantine();
  assert.equal(q.length, 1, 'exactly one quarantine line (the cycle is not poisoned)');
  assert.equal(q[0]!.job_id, 'issue-2');
  assert.equal(q[0]!.error, 'gate_build_failed');

  // The cycle ran on: items 1 and 3 passed, item 2 quarantined.
  assert.deepEqual(d.row.verdicts, {
    'issue-1': 'passed',
    'issue-2': 'quarantined',
    'issue-3': 'passed',
  });
  assert.equal(d.row.status, 'done');
  assert.equal(d.row.cursor.item, 3, 'the cursor walked the whole series');

  // Ground truth: the queue drained, every stage left a result line.
  assert.equal(queueDepth(queueFile), 0, 'the queue is empty when the cycle is done');
  const results = readResults();
  const okCount = results.filter((r) => r.ok === true).length;
  assert.equal(okCount, 3 + 5, '3 items + 5 gates (item-2 review skipped) all reported ok:true');

  // Explicit split (D7): cycle metadata rode the queue line but never
  // reached the executor contract — the noop echo carries only the
  // declared payload_fields.
  const item1 = results.find((r) => r.job_id === 'issue-1')!;
  const echo = item1.echo as Record<string, unknown>;
  assert.deepEqual(Object.keys(echo).sort(), ['note', 'target'], 'undeclared payload keys never reach the executor');
  assert.equal(echo.target, 'repo-X');
});

test('resumability: a driver rebuilt from the persisted cycles file resumes mid-series and never re-leases a settled stage', async () => {
  resetFiles();
  arb.leaseRequests.length = 0;
  arb.idle = true;

  const d = mkCycle();
  // Run only up to item-1's FIRST gate settling, then "restart".
  const daemon1 = makeDaemon();
  await daemon1.start();
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    d.tick();
    if (readResults().some((r) => r.job_id === 'gate-build-issue-1')) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await daemon1.stop();
  assert.ok(readResults().some((r) => r.job_id === 'gate-build-issue-1'), 'item-1 build gate settled before the restart');

  // The restart: a fresh driver from the persisted row + ground truth. No
  // memory of the previous process (D2/D4).
  const persisted = readCycles(queueFile);
  assert.ok(persisted && persisted.length === 1, 'the cycles file survived the restart');
  const d2 = new CycleDriver(queueFile, resultsFile, stateDir, persisted[0]!);
  const leasedBefore = arb.leaseRequests.length;
  await runUntil(d2, () => d2.row.status === 'done');

  const after = arb.leaseRequests.slice(leasedBefore).map((r) => r.job_id);
  assert.ok(!after.includes('issue-1'), 'the resumed driver did NOT re-lease the settled item');
  assert.ok(!after.includes('gate-build-issue-1'), 'the resumed driver did NOT re-lease the settled gate');
  assert.ok(after.includes('gate-review-issue-1'), 'it resumed exactly at the next unresolved stage');
  assert.deepEqual(d2.row.verdicts, { 'issue-1': 'passed', 'issue-2': 'passed', 'issue-3': 'passed' }, 'the whole series completed across the restart');
});

test('fail-closed on an unknown verdict: an unsettled gate parks the cursor; no later item is enqueued until it settles', async () => {
  resetFiles();
  arb.leaseRequests.length = 0;
  arb.idle = true;

  const d = mkCycle();
  // Deny every grant for item-1's build gate: the stage stays unresolved
  // (the arbiter's grant refusal is the deterministic stand-in for a
  // preempted/timed-out gate that never reported).
  arb.denyLeaseAfter.set('gate-build-issue-1', 0);

  const daemon = makeDaemon();
  await daemon.start();
  // Let item-1 run and settle, then park on the unresolved gate.
  const settle = Date.now() + 25_000;
  while (Date.now() < settle) {
    d.tick();
    if (readResults().some((r) => r.job_id === 'issue-1')) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(readResults().some((r) => r.job_id === 'issue-1'), 'item-1 settled');
  // Park: many ticks on an unresolved gate must not advance the cursor.
  for (let i = 0; i < 12; i++) {
    d.tick();
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(d.row.cursor.item, 0, 'the cursor does not advance on an unknown verdict (D6 rule 1)');
  assert.equal(queueDepth(queueFile), 1, 'no later cycle item was enqueued behind the unresolved gate');
  assert.deepEqual(Object.keys(d.row.verdicts), [], 'no verdict was guessed');

  // Release the denial: the cycle resumes and finishes.
  arb.denyLeaseAfter.delete('gate-build-issue-1');
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    d.tick();
    if (d.row.status === 'done') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await daemon.stop();
  assert.equal(d.row.status, 'done', 'the cycle completed once the gate reported');
  assert.deepEqual(d.row.verdicts, { 'issue-1': 'passed', 'issue-2': 'passed', 'issue-3': 'passed' });
});

test('corrupt cycles file reads as null: cycles fail closed, the queue is unaffected', () => {
  resetFiles();
  writeFileSync(cyclesFile(queueFile), '{not json at all');
  assert.equal(readCycles(queueFile), null, 'a corrupt cycles file reads as null (state.json posture, D4)');
  // The queue family is independent: a plain queue line still reads.
  writeQueue(queueFile, [{ job_id: 'plain-job', payload: { target: 'repo-X', note: 'n' } }]);
  assert.equal(queueDepth(queueFile), 1, 'queue truth is untouched by a corrupt cycles file');
});

// ---------------------------------------------------------------------------
// Issue #56 spike: two cycles, one project, ONE set of ground-truth files.
// Two cycle rows share the same queue/results/state files and each carries
// its own cursor. The MultiCycleDriver applies the D9.1 admission rule in
// the shipped CycleDriver.tick() shape: a row may start a stage only while
// the number of rows HOLDING a stage job in the queue is under the cap.
// ---------------------------------------------------------------------------

function mkMultiRows(): CycleRow[] {
  const mk = (id: string, gates: string[]): ItemSpec => ({
    job_id: id,
    gates: gates.map((g) => ({ name: g, job_id: `gate-${g}-${id}`, rule: 'note contains verdict=pass' })),
  });
  const a: CycleRow = {
    cycle_id: 'cycle-A',
    project: 'dev-cycle',
    status: 'planned',
    items: [mk('a1', ['build', 'review']), mk('a2', [])],
    cursor: { item: 0, stage: 'item', gate: 0 },
    verdicts: {},
  };
  const b: CycleRow = {
    cycle_id: 'cycle-B',
    project: 'dev-cycle',
    status: 'planned',
    items: [mk('b1', ['build', 'review']), mk('b2', [])],
    cursor: { item: 0, stage: 'item', gate: 0 },
    verdicts: {},
  };
  return [a, b];
}

function multiDone(): boolean {
  const rows = readCycles(queueFile);
  return !!rows && rows.length === 2 && rows.every((r) => r.status === 'done');
}

function rowById(cycleId: string): CycleRow {
  return readCycles(queueFile)!.find((r) => r.cycle_id === cycleId)!;
}

test('multi-cycle concurrency (D9.1/D9.3): cap 1 admits one holder at a time; cap 2 runs both cycles; a gate failure quarantines one cycle\'s item and leaves the other untouched', async () => {
  // --- phase 1: cap 1 ------------------------------------------------------
  resetFiles();
  arb.leaseRequests.length = 0;
  arb.usageReports.length = 0;
  arb.denyLeaseAfter.clear();
  arb.idle = true;

  writeCycles(queueFile, mkMultiRows());
  writeQueue(queueFile, []);
  const d1 = new MultiCycleDriver(queueFile, resultsFile, stateDir, 1);

  // Park cycle A's first stage in the queue: grants for a1 are denied (the
  // line stays queued, the hold persists). The deterministic proof of the
  // admission rule: a second row cannot enter while one row holds.
  arb.denyLeaseAfter.set('a1', 0);

  const daemon1 = makeDaemon();
  await daemon1.start();
  try {
    for (let i = 0; i < 12; i++) {
      d1.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    const q1 = readQueue(queueFile).map((j) => j.job_id);
    assert.deepEqual(q1, ['a1'], 'cap 1: the queue holds ONLY cycle A\'s parked stage');
    assert.ok(!q1.includes('b1'), 'cap 1: cycle B\'s first stage never enters the queue while cycle A holds a stage');
    assert.equal(rowById('cycle-B').status, 'planned', 'cap 1: the second row stays planned (admission cap)');

    // Release the park: both cycles must run to completion under cap 1.
    arb.denyLeaseAfter.delete('a1');
    let overCap = false;
    const deadline1 = Date.now() + 25_000;
    while (Date.now() < deadline1) {
      d1.tick();
      // Every queue line here is some row's cursor stage: more than one
      // line means two rows held a stage at once — over the cap.
      if (readQueue(queueFile).length > 1) overCap = true;
      if (multiDone()) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(multiDone(), 'cap 1: both cycles complete (the cap interleaves, never wedges — D6 rule 2)');
    assert.ok(!overCap, 'cap 1: never two cycle stages queued at once (one holder at a time)');
    const leased1 = arb.leaseRequests.map((r) => r.job_id);
    for (const id of ['a1', 'gate-build-a1', 'gate-review-a1', 'a2', 'b1', 'gate-build-b1', 'gate-review-b1', 'b2']) {
      assert.ok(leased1.includes(id), `cap 1: ${id} leased through the arbiter`);
    }
  } finally {
    await daemon1.stop();
  }

  // --- phase 2: cap 2, both cycles live at once ----------------------------
  resetFiles();
  arb.leaseRequests.length = 0;
  arb.usageReports.length = 0;
  arb.denyLeaseAfter.clear();
  arb.idle = true;

  writeCycles(queueFile, mkMultiRows());
  writeQueue(queueFile, []);
  const d2 = new MultiCycleDriver(queueFile, resultsFile, stateDir, 2);
  const daemon2 = makeDaemon();
  await daemon2.start();
  try {
    d2.tick();
    const admitted = readQueue(queueFile).map((j) => j.job_id).sort();
    assert.deepEqual(admitted, ['a1', 'b1'], 'cap 2: BOTH cycles\' first stages are admitted to the queue on the first tick');
    assert.equal(rowById('cycle-A').status, 'running');
    assert.equal(rowById('cycle-B').status, 'running', 'cap 2: two independent cursors run concurrently');

    const deadline2 = Date.now() + 25_000;
    while (Date.now() < deadline2) {
      d2.tick();
      if (multiDone()) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(multiDone(), 'cap 2: both cycles finish');
    const leased2 = arb.leaseRequests.map((r) => r.job_id);
    for (const id of ['a1', 'gate-build-a1', 'gate-review-a1', 'a2', 'b1', 'gate-build-b1', 'gate-review-b1', 'b2']) {
      assert.ok(leased2.includes(id), `cap 2: ${id} leased through the arbiter`);
    }
    assert.deepEqual(rowById('cycle-A').verdicts, { a1: 'passed', a2: 'passed' });
    assert.deepEqual(rowById('cycle-B').verdicts, { b1: 'passed', b2: 'passed' });
  } finally {
    await daemon2.stop();
  }

  // --- phase 3: independence — a failing gate quarantines ONE cycle's item --
  resetFiles();
  arb.leaseRequests.length = 0;
  arb.usageReports.length = 0;
  arb.denyLeaseAfter.clear();
  arb.idle = true;

  writeCycles(queueFile, mkMultiRows());
  writeQueue(queueFile, []);
  // Only cycle A's a1 gate reports verdict=fail; cycle B's items all pass.
  const d3 = new MultiCycleDriver(queueFile, resultsFile, stateDir, 2, { a1: 'fail' });
  const daemon3 = makeDaemon();
  await daemon3.start();
  try {
    const deadline3 = Date.now() + 25_000;
    while (Date.now() < deadline3) {
      d3.tick();
      if (multiDone()) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(multiDone(), 'a failing gate does not wedge either cycle (D6 rule 2)');

    // The quarantine file is project-wide: exactly ONE line, and it names
    // cycle A's item — cycle B contributed nothing.
    const q = readQuarantine();
    assert.equal(q.length, 1, 'exactly one quarantine line across BOTH cycles');
    assert.equal(q[0]!.job_id, 'a1');
    assert.equal(q[0]!.error, 'gate_build_failed');

    // Verdicts are per-row: cycle B is untouched by cycle A's failure.
    assert.deepEqual(rowById('cycle-A').verdicts, { a1: 'quarantined', a2: 'passed' });
    assert.deepEqual(rowById('cycle-B').verdicts, { b1: 'passed', b2: 'passed' });

    // Short-circuit stays per-item: A's review gate never ran, B's did.
    const leased3 = arb.leaseRequests.map((r) => r.job_id);
    assert.ok(!leased3.includes('gate-review-a1'), 'the failing gate skips ONLY that item\'s remaining gates');
    assert.ok(leased3.includes('gate-review-b1'), 'the other cycle runs its full gate series');
  } finally {
    await daemon3.stop();
  }
});
