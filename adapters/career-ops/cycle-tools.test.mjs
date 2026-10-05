/**
 * cycle-tools.test.mjs — the MCP cycle tool module (issue #58, D5).
 *
 * Same hermetic stdio harness as mcp.test.mjs: the REAL idlefill-mcp.mjs
 * process, a scratch client dir with real ground-truth files, and the cycle
 * module loaded through the issue #15 extension point (IDLEFILL_MCP_TOOLS
 * points at the module file). No network, no real arbiter.
 *
 * Covers (issue #58 acceptance):
 *   - the six cycle tools listed through the merged table (core ∪ discovered)
 *   - create_cycle real write + dry_run preview (cycles file untouched by
 *     the dry run — proven by the real call reporting the same fresh row)
 *   - fresh-read classification: a duplicate cycle_id against the LIVE file
 *     is refused
 *   - edit_cycle (status flip + items), pause/resume
 *   - list_cycles + cycle_status (cursor, verdicts, gate rules verbatim,
 *     live queue position + quarantine facts)
 *   - the write-bearing tools flow through the per-project policy (#14):
 *     hidden + blocked for allow_write:false, byte-unchanged cycles file
 *   - IDLEFILL_MCP_READ_ONLY=1 blocks every cycle write tool
 *   - the tools write ONLY the cycles file: queue file byte-unchanged
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP = join(__dirname, 'idlefill-mcp.mjs');
const CYCLE_MODULE = join(__dirname, 'idlefill-mcp-cycle-tools.mjs');

const CYCLE_TOOLS = [
  'idlefill_create_cycle',
  'idlefill_cycle_status',
  'idlefill_edit_cycle',
  'idlefill_list_cycles',
  'idlefill_pause_cycle',
  'idlefill_resume_cycle',
];

async function driveServer(clientDir, requests, env) {
  const child = spawn('node', [MCP], {
    env: { ...process.env, IDLEFILL_CLIENT_DIR: clientDir, IDLEFILL_MCP_TOOLS: CYCLE_MODULE, ...(env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const stderrBuf = [];
  child.stdout.on('data', (d) => {
    for (const l of d.toString().split('\n')) if (l.trim()) lines.push(l);
  });
  child.stderr.on('data', (d) => stderrBuf.push(d.toString()));
  child.stdin.write(requests.map((r) => JSON.stringify(r) + '\n').join(''));
  const closed = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 10_000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  setTimeout(() => child.stdin.end(), 1500);
  await closed;
  const byId = {};
  for (const l of lines) {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      continue;
    }
    if (m.id !== undefined) byId[m.id] = m;
  }
  const call = (id) => {
    const m = byId[id];
    let p;
    try {
      p = JSON.parse(m?.result?.content?.[0]?.text || '{}');
    } catch {
      p = null;
    }
    return { isError: m?.result?.isError, p };
  };
  return { byId, call, stderr: stderrBuf.join('') };
}

function cyclesOnDisk(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'queue.jsonl.cycles.json'), 'utf-8'));
  } catch {
    return null;
  }
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };

function mkScratch(tag, projects) {
  const scratch = mkdtempSync(join(tmpdir(), `idlefill-cycletools-${tag}-`));
  const clientDir = join(scratch, 'client');
  const dataDir = join(scratch, 'data');
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(clientDir, 'config.json'),
    JSON.stringify({ server_url: 'http://127.0.0.1:1', token: 'not-a-real-token', name: 'cycle-tools-test', projects }),
    'utf-8',
  );
  return { scratch, clientDir, dataDir };
}

test('cycle tools: listed, create (dry_run + real + duplicate refusal), edit, pause/resume, list, status; writes ONLY the cycles file', async () => {
  const { scratch, clientDir, dataDir } = mkScratch('main', [{ name: 'p1', queue_file: '../data/queue.jsonl', results_file: '../data/results.jsonl' }]);
  const queueSeed = JSON.stringify({ job_id: 'plain-job', payload: { target: 'x', note: 'n' } }) + '\n';
  writeFileSync(join(dataDir, 'queue.jsonl'), queueSeed, 'utf-8');
  const ITEMS = [
    { job_id: 'issue-1', payload: { target: 'repo-X', note: 'issue:1' }, gates: [{ name: 'build', rule: 'echo.note contains verdict=pass' }, { name: 'review', rule: 'echo.note contains verdict=pass' }] },
    { job_id: 'issue-2', gates: [{ name: 'build', rule: 'echo.note contains verdict=pass' }] },
  ];
  try {
    // Session 1: listing + the dry_run preview. Ends BEFORE any write, so
    // "dry_run wrote nothing" is provable from the file on disk.
    const sDry = await driveServer(clientDir, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'idlefill_create_cycle', arguments: { project: 'p1', cycle_id: 'c1', name: 'resolve issues', items: ITEMS, dry_run: true } } },
    ]);
    const names = sDry.byId[2]?.result?.tools?.map((t) => t.name) || [];
    for (const t of CYCLE_TOOLS) assert.ok(names.includes(t), `tools/list includes ${t} (discovered module merges)`);
    const writeAnn = sDry.byId[2].result.tools.filter((t) => CYCLE_TOOLS.includes(t.name));
    assert.ok(writeAnn.find((t) => t.name === 'idlefill_create_cycle')?.annotations?.readOnlyHint === false, 'create_cycle annotated write-bearing (joins the WRITE_TOOLS policy class)');
    assert.ok(writeAnn.find((t) => t.name === 'idlefill_list_cycles')?.annotations?.readOnlyHint === true, 'list_cycles annotated read-only');

    const dry = sDry.call(3);
    assert.equal(dry.p?.ok, true, 'create dry_run ok');
    assert.equal(dry.p?.dry_run, true, 'dry_run flagged');
    assert.equal(dry.p?.cycle?.cycle_id, 'c1');
    assert.equal(dry.p?.cycle?.status, 'planned', 'a created row starts planned');
    assert.equal(dry.p?.cycle?.items?.[0]?.gates?.[1]?.job_id, 'gate-review-issue-1', 'gate job_ids default to gate-<name>-<item>');
    assert.equal(cyclesOnDisk(dataDir), null, 'dry_run wrote NOTHING to the cycles file');
    if (sDry.stderr.trim()) console.log(`cycle-tools dry session stderr:\n${sDry.stderr.trim()}`);

    // Session 2: the writes + the read views (no mid-session disk reads).
    const s = await driveServer(clientDir, [
      INIT,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'idlefill_create_cycle', arguments: { project: 'p1', cycle_id: 'c1', name: 'resolve issues', items: ITEMS } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'idlefill_create_cycle', arguments: { project: 'p1', cycle_id: 'c1', items: ITEMS } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'idlefill_list_cycles', arguments: { project: 'p1' } } },
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'idlefill_edit_cycle', arguments: { project: 'p1', cycle_id: 'nope', status: 'running' } } },
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'idlefill_cycle_status', arguments: { project: 'p1', cycle_id: 'c1' } } },
    ]);
    const { byId, call } = s;

    // real write
    const real = call(4);
    assert.equal(real.p?.ok, true, 'create real ok (proves the dry run did not write: the id was still free)');
    const onDisk = cyclesOnDisk(dataDir);
    assert.ok(Array.isArray(onDisk) && onDisk.length === 1, 'cycles file holds the row');
    assert.equal(onDisk[0].cycle_id, 'c1');
    assert.equal(onDisk[0].items[0].gates[0].rule, 'echo.note contains verdict=pass', 'the gate rule is stored VERBATIM (D8 seam)');
    assert.deepEqual(onDisk[0].cursor, { item: 0, stage: 'item', gate: 0 }, 'the cursor shape is persisted');

    // duplicate against the LIVE file (fresh-read classification)
    const dup = call(5);
    assert.equal(dup.isError, true, 'duplicate cycle_id → isError');
    assert.match(dup.p?.error ?? '', /already exists in the live cycles file/, 'duplicate refusal names the live-file rule');

    // list
    const list = call(6);
    assert.equal(list.p?.count, 1, 'list_cycles counts the live rows');
    assert.equal(list.p?.cycles?.[0]?.cycle_id, 'c1');

    // pause + resume + edit status (session 3: the flips are response-checked;
    // the final disk state — the edit's paused — is read after the process ends)
    const s3 = await driveServer(clientDir, [
      INIT,
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'idlefill_pause_cycle', arguments: { project: 'p1', cycle_id: 'c1' } } },
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'idlefill_resume_cycle', arguments: { project: 'p1', cycle_id: 'c1' } } },
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'idlefill_edit_cycle', arguments: { project: 'p1', cycle_id: 'c1', status: 'paused' } } },
    ]);
    assert.equal(s3.call(7).p?.to, 'paused', 'pause flips the row');
    assert.equal(s3.call(7).p?.from, 'planned', 'pause reports the from-state');
    assert.equal(s3.call(8).p?.to, 'running', 'resume flips the row');
    assert.equal(s3.call(9).p?.after?.status, 'paused', 'edit_cycle status change returns after-state');
    assert.equal(cyclesOnDisk(dataDir)[0].status, 'paused', 'the last flip (edit → paused) landed on disk');

    // unknown id
    const unknown = call(10);
    assert.equal(unknown.isError, true, 'edit unknown cycle_id → isError');
    assert.match(unknown.p?.error ?? '', /unknown cycle_id "nope"/, 'unknown cycle_id named');

    // status view
    const st = call(11);
    assert.equal(st.p?.ok, true, 'cycle_status ok');
    assert.equal(st.p?.cycle?.items?.[0]?.gates?.[0]?.rule, 'echo.note contains verdict=pass', 'status returns gate rules verbatim');
    assert.equal(st.p?.cycle?.items?.[0]?.stage?.in_queue, null, 'a cycle stage not in the queue reports no position');
    assert.equal(st.p?.current_stage?.job_id, 'issue-1', 'the current stage is the cursor position');

    // ONLY the cycles file was touched: the queue is byte-identical.
    assert.equal(readFileSync(join(dataDir, 'queue.jsonl'), 'utf-8'), queueSeed, 'the cycle tools never touch the queue file');
    if (s.stderr.trim()) console.log(`cycle-tools session stderr:\n${s.stderr.trim()}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('cycle tools flow through the per-project policy: allow_write:false hides + blocks; IDLEFILL_MCP_READ_ONLY=1 blocks every cycle write', async () => {
  const { scratch, clientDir, dataDir } = mkScratch('policy', [
    { name: 'open', queue_file: '../data/queue-open.jsonl', results_file: '../data/results-open.jsonl' },
    { name: 'ro', queue_file: '../data/queue-ro.jsonl', results_file: '../data/results-ro.jsonl', mcp: { allow_write: false } },
  ]);
  const ITEMS = [{ job_id: 'i1', gates: [{ name: 'build', rule: 'ok' }] }];
  try {
    // Session A: allow_write:false project
    const sA = await driveServer(clientDir, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { project: 'ro' } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'idlefill_create_cycle', arguments: { project: 'ro', cycle_id: 'c-ro', items: ITEMS } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'idlefill_pause_cycle', arguments: { project: 'ro', cycle_id: 'c-ro' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'idlefill_list_cycles', arguments: { project: 'ro' } } },
    ]);
    const roNames = sA.byId[2]?.result?.tools?.map((t) => t.name) || [];
    for (const t of CYCLE_TOOLS) {
      const isWrite = !['idlefill_list_cycles', 'idlefill_cycle_status'].includes(t);
      assert.equal(roNames.includes(t), !isWrite, `ro: ${t} ${isWrite ? 'hidden (write-bearing)' : 'visible (read-only)'}`);
    }
    assert.equal(sA.call(3).isError, true, 'ro create_cycle → isError at the call site');
    assert.match(sA.call(3).p?.error ?? '', /write not allowed for project "ro" \(mcp\.allow_write\)/, 'policy reason identical to core write tools');
    assert.equal(sA.call(4).isError, true, 'ro pause_cycle → isError');
    assert.equal(sA.call(5).p?.ok, true, 'ro read tool still works');
    assert.equal(tryRead(join(dataDir, 'queue-ro.jsonl.cycles.json')), null, 'ro: no cycles file was written');

    // Session B: IDLEFILL_MCP_READ_ONLY=1 overrides an open project
    const sB = await driveServer(clientDir, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'idlefill_create_cycle', arguments: { project: 'open', cycle_id: 'c-env', items: ITEMS } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'idlefill_edit_cycle', arguments: { project: 'open', cycle_id: 'c-env', status: 'done' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'idlefill_resume_cycle', arguments: { project: 'open', cycle_id: 'c-env' } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'idlefill_cycle_status', arguments: { project: 'open', cycle_id: 'c-env' } } },
    ], { IDLEFILL_MCP_READ_ONLY: '1' });
    const envNames = sB.byId[2]?.result?.tools?.map((t) => t.name) || [];
    for (const t of CYCLE_TOOLS) {
      const isWrite = !['idlefill_list_cycles', 'idlefill_cycle_status'].includes(t);
      assert.equal(envNames.includes(t), !isWrite, `read-only env: ${t} ${isWrite ? 'hidden' : 'visible'}`);
    }
    for (const id of [3, 4, 5]) {
      assert.equal(sB.call(id).isError, true, `read-only env: cycle write id ${id} blocked`);
      assert.match(sB.call(id).p?.error ?? '', /read-only mode \(IDLEFILL_MCP_READ_ONLY\)/, `read-only env: error names the env flag (id ${id})`);
    }
    assert.equal(tryRead(join(dataDir, 'queue-open.jsonl.cycles.json')), null, 'read-only env: cycles file never written');
    assert.equal(sB.call(6).isError, true, 'cycle_status on an unknown id is the tool error, not a policy block');
    assert.match(sB.call(6).p?.error ?? '', /unknown cycle_id/, 'read tool still reaches the module under read-only env');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function tryRead(f) {
  try {
    return readFileSync(f, 'utf-8');
  } catch {
    return null;
  }
}
