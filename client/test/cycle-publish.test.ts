/**
 * cycle-publish.test.ts — the dashboard cycle strip's CLIENT side (#53 build
 * wave; the strip itself is dashboard work). Rules under test come from
 * docs/architecture/dev-cycles.md D9.3 + D7:
 *
 *   - the register heartbeat's per-project entry GAINS `cycles` (one entry
 *     per row in the cycles file, file order — no merged progress line) and
 *     `cycle_cap` (the effective cycle_max_in_flight; 0 = knob absent),
 *     computed client-side from readCycles + resolveCycleMaxInFlight;
 *   - the block is EXCEPTION-ONLY: absent when the project has no cycles
 *     file, the list is empty, or no row is usable;
 *   - the tallies come from the seeded verdicts map: settled = keys,
 *     passed/quarantined = counts by verdict value; item_index rides the
 *     stored cursor (0-based — the dashboard renders it +1);
 *   - the array caps at 20 entries;
 *   - it never throws: junk rows are skipped, a corrupt file publishes
 *     nothing, and the daemon keeps registering normally (best-effort, like
 *     queuePreview).
 *
 * The daemon integration uses the real ClientDaemon against the fake
 * arbiter (the version-handshake / rebuild-scheduler pattern). The project
 * names are test-only: resolveCycleMaxInFlight finds no knob for them, so
 * the daemon's cycle driver never touches the seeded file and the heartbeat
 * must publish exactly what the file holds (cycle_cap 0 = knob absent).
 */

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientDaemon, publishCycles, cyclesFile, type CycleRow, type CycleStatusRow } from '../src/index.js';
import type { ClientConfig } from '../src/config.js';
import { startFakeArbiter, type FakeArbiter } from './fake-arbiter.js';

let arb: FakeArbiter;
before(async () => {
  arb = await startFakeArbiter();
});
after(async () => {
  await arb.close();
});

/** A minimal cycle row — the publish path only reads these fields. */
function row(cycle_id: string, over: Partial<CycleRow> = {}): CycleRow {
  return {
    cycle_id,
    project: 'cyc-pub',
    status: 'running',
    items: [
      { job_id: `${cycle_id}-i1`, gates: [] },
      { job_id: `${cycle_id}-i2`, gates: [{ name: 'build', job_id: `${cycle_id}-g1`, rule: 'ok' }] },
      { job_id: `${cycle_id}-i3`, gates: [] },
    ],
    cursor: { item: 1, stage: 'gate', gate: 0 },
    verdicts: { [`${cycle_id}-i1`]: 'passed', [`${cycle_id}-i2`]: 'quarantined' },
    ...over,
  };
}

function mkQueueFile(dir: string, name: string): string {
  const qf = join(dir, `${name}.queue.jsonl`);
  writeFileSync(qf, JSON.stringify({ job_id: 'seed-1', payload: { url: 'u' } }) + '\n');
  return qf;
}

// ---------------------------------------------------------------------------
// publishCycles — the pure block builder
// ---------------------------------------------------------------------------

test('publishCycles: one entry per row in file order, tallies from the verdicts map, cap from the config knob', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-cycpub-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const qf = mkQueueFile(dir, 'p1');
  writeFileSync(
    cyclesFile(qf),
    JSON.stringify([
      row('cyc-a'),
      row('cyc-b', { status: 'planned', cursor: { item: 0, stage: 'item', gate: 0 }, verdicts: {} }),
    ]),
  );
  // The knob lives in the raw config, not the typed loader (resolveCycleMaxInFlight).
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ projects: [{ name: 'cyc-pub', cycle_max_in_flight: 2 }] }));

  const block = publishCycles(qf, 'cyc-pub', dir);
  assert.ok(block, 'a cycles file with usable rows publishes a block');
  assert.equal(block!.cycle_cap, 2, 'cycle_cap = the effective cycle_max_in_flight');
  assert.equal(block!.cycles.length, 2, 'one entry per row — no merged line (D9.3)');

  const a = block!.cycles[0]!;
  assert.deepEqual(
    a,
    {
      cycle_id: 'cyc-a',
      status: 'running',
      items_total: 3,
      item_index: 1, // the stored cursor, 0-based — the dashboard renders +1
      settled: 2,
      passed: 1,
      quarantined: 1,
      stage: 'gate',
    } as CycleStatusRow,
    'row A: tallies from the seeded verdicts map, cursor + stage verbatim',
  );
  assert.deepEqual(
    block!.cycles[1]!,
    {
      cycle_id: 'cyc-b',
      status: 'planned',
      items_total: 3,
      item_index: 0,
      settled: 0,
      passed: 0,
      quarantined: 0,
      stage: 'item',
    } as CycleStatusRow,
    'row B: an empty verdicts map still publishes (settled/passed/quarantined 0)',
  );
});

test('publishCycles: absent knob publishes cycle_cap 0; a present-but-invalid knob falls to 1', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-cycpub-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const qf = mkQueueFile(dir, 'p2');
  writeFileSync(cyclesFile(qf), JSON.stringify([row('cyc-x')]));

  writeFileSync(join(dir, 'config.json'), JSON.stringify({ projects: [{ name: 'cyc-pub' }] }));
  assert.equal(publishCycles(qf, 'cyc-pub', dir)!.cycle_cap, 0, 'knob absent = 0 (the card shape: 0 = knob absent)');

  writeFileSync(join(dir, 'config.json'), JSON.stringify({ projects: [{ name: 'cyc-pub', cycle_max_in_flight: 'nope' }] }));
  assert.equal(publishCycles(qf, 'cyc-pub', dir)!.cycle_cap, 1, 'present but invalid falls to the owner default 1');
});

test('publishCycles: exception-only — no file, an empty list, a corrupt file, or only-junk rows publish nothing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-cycpub-abs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const noFile = mkQueueFile(dir, 'none');
  assert.equal(publishCycles(noFile, 'p', dir), null, 'no cycles file → no block (never an empty array on the wire)');

  const empty = mkQueueFile(dir, 'empty');
  writeFileSync(cyclesFile(empty), '[]');
  assert.equal(publishCycles(empty, 'p', dir), null, 'empty list → no block');

  const corrupt = mkQueueFile(dir, 'corrupt');
  writeFileSync(cyclesFile(corrupt), 'not json at all');
  assert.equal(publishCycles(corrupt, 'p', dir), null, 'corrupt file → no block (fail-closed, D4) — and never throws');

  const junk = mkQueueFile(dir, 'junk');
  writeFileSync(cyclesFile(junk), JSON.stringify([null, 42, 'str', {}, { cycle_id: '', status: 'running' }, { cycle_id: 'ok-but-bad-status', status: 'exploded' }]));
  assert.equal(publishCycles(junk, 'p', dir), null, 'a valid-JSON array of unusable rows publishes nothing (per-row guards)');
});

test('publishCycles: junk rows are skipped but GOOD rows still publish; the array caps at 20 entries', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-cycpub-cap20-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const qf = mkQueueFile(dir, 'mix');
  writeFileSync(cyclesFile(qf), JSON.stringify([{ nope: true }, row('cyc-good')]));
  const mixed = publishCycles(qf, 'p', dir);
  assert.deepEqual(mixed!.cycles.map((c) => c.cycle_id), ['cyc-good'], 'the unusable row is skipped, the good one rides');

  const qf2 = mkQueueFile(dir, 'many');
  writeFileSync(cyclesFile(qf2), JSON.stringify(Array.from({ length: 25 }, (_, i) => row(`cyc-${i}`))));
  const many = publishCycles(qf2, 'p', dir);
  assert.equal(many!.cycles.length, 20, 'the published array caps at 20 rows');
  assert.deepEqual(many!.cycles.map((c) => c.cycle_id), Array.from({ length: 20 }, (_, i) => `cyc-${i}`), 'file order kept');
});

// ---------------------------------------------------------------------------
// The register heartbeat (real ClientDaemon → fake arbiter)
// ---------------------------------------------------------------------------

async function waitFor(pred: () => boolean, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

interface RegisterProject {
  name: string;
  cycles?: CycleStatusRow[];
  cycle_cap?: number;
  stats?: Record<string, number | string>;
}

test('the register heartbeat carries cycles + cycle_cap on the project entry, and the keys are ABSENT without a cycles file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-cycpub-daemon-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const qf = mkQueueFile(dir, 'live');
  writeFileSync(cyclesFile(qf), JSON.stringify([row('cyc-live'), row('cyc-paused', { status: 'paused' })]));
  const qfNoCycles = mkQueueFile(dir, 'nocyc');

  // Test-only project names: no knob in any candidate config → the daemon's
  // cycle driver never touches these files (publish only), and cycle_cap
  // publishes 0 (knob absent).
  const cfg: ClientConfig = {
    server_url: arb.url,
    token: 't',
    client_name: 'cycle-publish-client',
    ip: '',
    proxy_port: 0,
    llm_target: 'http://127.0.0.1:1',
    repo_root: dir,
    state_dir: join(dir, 'state'),
    state_file: join(dir, 'state.json'),
    projects: [
      { name: 'cyc-live-proj', queue_file: qf, results_file: join(dir, 'results.jsonl'), model: 'm', executor: 'node -e ""', estimated_seconds: 10 },
      { name: 'cyc-nocyc-proj', queue_file: qfNoCycles, results_file: join(dir, 'results2.jsonl'), model: 'm', executor: 'node -e ""', estimated_seconds: 10 },
    ],
  };
  mkdirSync(cfg.state_dir, { recursive: true });
  arb.idle = false; // the lease loop stays out — this test watches the heartbeat payload only

  const d = new ClientDaemon(cfg, { pollMs: 50, log: { info: () => {} } });
  await d.start();
  const ok = await waitFor(() =>
    arb.registers.some((r) => (r.projects as RegisterProject[] | undefined)?.some((p) => p.name === 'cyc-live-proj' && p.cycles)),
  );
  await d.stop();

  assert.ok(ok, 'a heartbeat carried the cycles block (start() registers immediately)');
  const reg = arb.registers[arb.registers.length - 1]!;
  const projects = reg.projects as RegisterProject[];
  const withCycles = projects.find((p) => p.name === 'cyc-live-proj')!;
  assert.equal(withCycles.cycle_cap, 0, 'cycle_cap present as 0 (knob absent) — a number, not a missing key');
  assert.equal(withCycles.cycles!.length, 2, 'one entry per cycles-file row');
  assert.deepEqual(withCycles.cycles![0]!, {
    cycle_id: 'cyc-live',
    status: 'running',
    items_total: 3,
    item_index: 1,
    settled: 2,
    passed: 1,
    quarantined: 1,
    stage: 'gate',
  });
  assert.deepEqual(
    { ...withCycles.cycles![1]! },
    { cycle_id: 'cyc-paused', status: 'paused', items_total: 3, item_index: 1, settled: 2, passed: 1, quarantined: 1, stage: 'gate' },
  );

  const plain = projects.find((p) => p.name === 'cyc-nocyc-proj')!;
  assert.ok(!('cycles' in plain) && !('cycle_cap' in plain), 'no cycles file → both keys ABSENT (exception-only, like last_rebuild)');
  assert.ok('stats' in plain, 'the rest of the project entry is untouched');
});
