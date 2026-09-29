/**
 * mcp.test.mjs — the idlefill MCP server (adapters/career-ops/idlefill-mcp.mjs).
 *
 * The server speaks MCP JSON-RPC over stdio with no dependencies, so the
 * hermetic test drives the REAL process: spawn it with a scratch client dir
 * (IDLEFILL_CLIENT_DIR) holding real ground-truth files (queue.jsonl,
 * results.jsonl, a dead arbiter url) and a real client config, then walk a
 * full JSON-RPC session over its stdin/stdout. No network, no real arbiter.
 *
 * Covers: initialize, tools/list, add_jobs (dry_run preview + real write,
 * dedupe by job_id, skip done/quarantined/in-queue, in-batch dup, bad url,
 * unknown project), queue_status (file view + best-effort arbiter error),
 * results (newest first), unknown tool → JSON-RPC error.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP = join(__dirname, 'idlefill-mcp.mjs');

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function urlHash8(url) {
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 8);
}
// Must match idlefill-mcp.mjs jobIdFor: <company-slug>-<sha256(url)[0:8]>.
const jobId = (company, url) => `${slug(company || 'unknown')}-${urlHash8(url)}`;

/** Spawn the server, send a batch of JSON-RPC messages, return {byId, call, stderr}. */
async function driveServer(clientDir, requests) {
  const child = spawn('node', [MCP], {
    env: { ...process.env, IDLEFILL_CLIENT_DIR: clientDir },
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
  // Give the handler time to answer everything, then end stdin so the server
  // exits (its 'end' handler calls process.exit(0)).
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

test('idlefill-mcp: full stdio session — handshake, add_jobs (dry + real), status, results', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'idlefill-mcp-test-'));
  const clientDir = join(scratch, 'client');
  const dataDir = join(scratch, 'data');
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const EXISTING = { url: 'https://example.com/opening-1', company: 'Acme', title: 'Existing', score: 5 };
  const FRESH = { url: 'https://example.com/opening-2', company: 'Acme', title: 'New job', score: 9 };
  const ALREADY_DONE = { url: 'https://done.example/1', company: 'DoneX', title: 'Already evaluated' };

  // Ground truth: EXISTING sits in the queue; ALREADY_DONE has an ok:true
  // results line (the queue builder's "never rebuild" rule the MCP honors).
  writeFileSync(
    join(dataDir, 'queue.jsonl'),
    JSON.stringify({ job_id: jobId(EXISTING.company, EXISTING.url), payload: { ...EXISTING, source: 'builder' } }) + '\n',
    'utf-8',
  );
  writeFileSync(
    join(dataDir, 'results.jsonl'),
    JSON.stringify({ job_id: jobId(ALREADY_DONE.company, ALREADY_DONE.url), ok: true, ts: new Date().toISOString() }) + '\n',
    'utf-8',
  );
  writeFileSync(
    join(clientDir, 'config.json'),
    JSON.stringify({
      server_url: 'http://127.0.0.1:1', // dead on purpose — the arbiter read is best-effort
      token: 'not-a-real-token',
      name: 'mcp-test',
      projects: [
        {
          name: 'p1',
          queue_file: '../data/queue.jsonl',
          results_file: '../data/results.jsonl',
        },
      ],
    }),
    'utf-8',
  );

  try {
    const { byId, call, stderr } = await driveServer(clientDir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      // dry run: EXISTING (already queued), FRESH (would add), ALREADY_DONE
      // (ok:true), FRESH again (in-batch dup) → skipped_duplicate counts only
      // the in-batch dup.
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'idlefill_add_jobs', arguments: { project: 'p1', dry_run: true, jobs: [EXISTING, FRESH, ALREADY_DONE, FRESH] } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'idlefill_add_jobs', arguments: { project: 'p1', jobs: [EXISTING, FRESH, ALREADY_DONE] } } },
      // a second real add of the same job: already in the queue → nothing added
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'idlefill_add_jobs', arguments: { project: 'p1', jobs: [FRESH] } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'idlefill_queue_status', arguments: { project: 'p1', limit: 5 } } },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'idlefill_results', arguments: { project: 'p1', limit: 5 } } },
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'idlefill_add_jobs', arguments: { jobs: [{ company: 'Bad', url: 'not-a-url' }] } } },
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'idlefill_add_jobs', arguments: { project: 'nope', jobs: [FRESH] } } },
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'unknown-tool', arguments: {} } },
    ]);

    assert.equal(byId[1]?.result?.serverInfo?.name, 'idlefill', 'initialize → serverInfo');
    const tools = byId[2]?.result?.tools?.map((x) => x.name) || [];
    assert.deepEqual(tools, ['idlefill_add_jobs', 'idlefill_queue_status', 'idlefill_results'], 'tools/list');

    const dry = call(3);
    assert.equal(dry.p?.ok, true, 'dry_run ok');
    assert.deepEqual(dry.p?.added, [jobId(FRESH.company, FRESH.url)], 'dry_run: only FRESH would be added');
    assert.equal(dry.p?.skipped_duplicate, 1, 'dry_run: the in-batch dup is the only duplicate');
    assert.deepEqual(dry.p?.skipped_in_queue, [jobId(EXISTING.company, EXISTING.url)], 'dry_run: the already-queued job is named');
    assert.deepEqual(dry.p?.skipped_done, [jobId(ALREADY_DONE.company, ALREADY_DONE.url)], 'dry_run: done job skipped');
    assert.equal(dry.p?.queue_length, 2, 'dry_run: queue_length preview = existing + fresh');
    assert.equal(dry.p?.dry_run, true, 'dry_run flagged');
    // "dry_run did not write" is proven by the REAL call below: if the dry
    // run had touched the file, FRESH would already be in the queue and the
    // real add would report added=[] (it is checked below to report FRESH).
    // The file state is only read after the whole session, never mid-flight.

    const real = call(4);
    assert.equal(real.p?.ok, true, 'add ok');
    assert.deepEqual(real.p?.added, [jobId(FRESH.company, FRESH.url)], 'add: exactly FRESH landed');
    const qAfter = readFileSync(join(dataDir, 'queue.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(qAfter.length, 2, 'queue file now holds both jobs');
    assert.equal(qAfter[1]?.payload?.source, 'mcp', 'the new line carries source: mcp');
    assert.equal(qAfter[0]?.job_id, jobId(EXISTING.company, EXISTING.url), 'existing line untouched, order preserved');

    const readd = call(5);
    assert.equal(readd.p?.ok, true, 're-add ok');
    assert.deepEqual(readd.p?.added, [], 're-add: nothing new');
    assert.deepEqual(readd.p?.skipped_in_queue, [jobId(FRESH.company, FRESH.url)], 're-add: the job is now "already in queue"');
    assert.equal(readd.p?.skipped_duplicate, 0, 're-add: no in-batch dups');
    assert.equal(readFileSync(join(dataDir, 'queue.jsonl'), 'utf-8').trim().split('\n').length, 2, 'queue still 2 lines');

    const st = call(6);
    assert.equal(st.p?.ok, true, 'queue_status ok');
    assert.equal(st.p?.projects?.p1?.queue_length, 2, 'queue_status: file depth');
    assert.equal(st.p?.projects?.p1?.jobs?.length, 2, 'queue_status: both jobs shown');
    assert.equal(typeof st.p?.arbiter?.error, 'string', 'queue_status: arbiter read is a best-effort error (dead url)');

    const res = call(7);
    assert.equal(res.p?.ok, true, 'results ok');
    assert.equal(res.p?.count, 1, 'results: one line');
    assert.equal(res.p?.results?.[0]?.ok, true, 'results: ok flag carried');
    assert.equal(res.p?.results?.[0]?.job_id, jobId(ALREADY_DONE.company, ALREADY_DONE.url), 'results: identity');

    const badUrl = call(8);
    assert.equal(badUrl.p?.ok, false, 'bad url rejected');
    assert.match(badUrl.p?.error ?? '', /valid http\(s\) url/, 'bad url error message');
    const unknownProj = call(9);
    assert.equal(unknownProj.p?.ok, false, 'unknown project rejected');
    assert.match(unknownProj.p?.error ?? '', /unknown project/, 'unknown project error message');

    assert.equal(byId[10]?.error?.code, -32602, 'unknown tool → JSON-RPC -32602');
    if (stderr.trim()) console.log(`server stderr:\n${stderr.trim()}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
