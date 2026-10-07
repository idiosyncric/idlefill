/**
 * mcp.test.mjs — the idlefill MCP server (adapters/career-ops/idlefill-mcp.mjs).
 *
 * The server speaks MCP JSON-RPC over stdio with no dependencies, so the
 * hermetic test drives the REAL process: spawn it with a scratch client dir
 * (IDLEFILL_CLIENT_DIR) holding real ground-truth files (queue.jsonl,
 * results.jsonl, quarantine.jsonl, a dead arbiter url) and a real client
 * config, then walk a full JSON-RPC session over its stdin/stdout. No
 * network, no real arbiter. Two sessions against the SAME ground truth:
 * session 1 exercises add/status/results/lookup-in-queue (and ends with the
 * queue still holding what the add wrote, so the FILE state is assertable);
 * session 2 exercises the mutations (remove/clear) + the lookup facts and
 * ends with the queue emptied.
 *
 * Covers: initialize, tools/list, add_jobs (dry_run preview + real write,
 * dedupe by job_id, skip done/quarantined/in-queue, in-batch dup, bad url,
 * unknown project), queue_status (file view + best-effort arbiter error),
 * results (newest first; company/title echo — rows WITH and WITHOUT the
 * keys), remove_jobs (present + absent job ids, dry_run no-write, missing
 * job_ids error), clear_queue (dry_run + real), job_lookup (in-queue with
 * position + payload, done, quarantined, never-seen; best-effort arbiter
 * error), unknown tool → JSON-RPC error.
 *
 * Issue #14 adds two policy sessions: per-project mcp block (allow_write:false
 * hides + blocks with byte-unchanged queue; tools subset in policy order with
 * unknown names warned once on stderr; enabled:false excluded from every
 * enumeration), no-param tools/list union with most-restrictive annotations,
 * notifications/tools/list_changed on set change, and IDLEFILL_MCP_READ_ONLY=1
 * blocking every write tool for every project.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
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

/** Spawn the server, send a batch of JSON-RPC messages, return {byId, notes, call, stderr}.
 *  `env` (optional) merges extra environment for the child (issue #14 tests). */
async function driveServer(clientDir, requests, env) {
  const child = spawn('node', [MCP], {
    env: { ...process.env, IDLEFILL_CLIENT_DIR: clientDir, ...(env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const stderrBuf = [];
  // Fast path: end stdin the instant every request that expects a response
  // (has an id) has been answered, instead of a fixed 1500ms sleep per test.
  // A notification (no id) never awaits a response, so it is excluded. The
  // 3s fallback below still ends stdin if an expected answer never lands, so
  // the server's stdin 'end' handler exits the child either way.
  const requestIds = requests.filter((r) => r && r.id !== undefined).map((r) => r.id);
  const answered = new Set();
  let stdinEnded = false;
  const endStdin = () => {
    if (!stdinEnded) {
      stdinEnded = true;
      child.stdin.end();
    }
  };
  child.stdout.on('data', (d) => {
    for (const l of d.toString().split('\n')) {
      if (!l.trim()) continue;
      lines.push(l);
      try {
        const m = JSON.parse(l);
        if (m.id !== undefined) answered.add(m.id);
      } catch {
        /* non-JSON line: ignore for id tracking */
      }
    }
    if (requestIds.every((id) => answered.has(id))) endStdin();
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
  // Fallback: end stdin if some expected answer never lands so the child
  // still exits. The fast path above normally ends it a few hundred ms in.
  setTimeout(endStdin, 3000);
  await closed;

  const byId = {};
  const notes = [];
  for (const l of lines) {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      continue;
    }
    if (m.id !== undefined) byId[m.id] = m;
    else if (m.method) notes.push(m);
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
  return { byId, notes, call, stderr: stderrBuf.join('') };
}

/** The queue file's live lines (empty when missing or empty). */
function queueLines(dataDir) {
  try {
    return readFileSync(join(dataDir, 'queue.jsonl'), 'utf-8').split('\n').filter((l) => l.trim());
  } catch {
    return [];
  }
}

test('idlefill-mcp: stdio sessions — add/status/results(echo)/lookup + remove/clear/lookup facts', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'idlefill-mcp-test-'));
  const clientDir = join(scratch, 'client');
  const dataDir = join(scratch, 'data');
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const EXISTING = { url: 'https://example.com/opening-1', company: 'Acme', title: 'Existing', score: 5 };
  const FRESH = { url: 'https://example.com/opening-2', company: 'Acme', title: 'New job', score: 9 };
  const ALREADY_DONE = { url: 'https://done.example/1', company: 'DoneX', title: 'Already evaluated' };
  const OTHER = { url: 'https://other.example/1', company: 'OtherX', title: 'Legacy row' };
  const RETRIED = { url: 'https://retry.example/1', company: 'RetryCo', title: 'Retried until ok' };
  const QUARANTINED = { url: 'https://dead.example/1', company: 'DeadCo', title: 'Burned all attempts' };
  const GHOST = 'ghost-12345678'; // never in queue/results/quarantine

  // Ground truth:
  //  - EXISTING sits in the queue (position 1)
  //  - results.jsonl: ALREADY_DONE ok:true (the career-ops executor shape —
  //    company/title present), OTHER without company/title (another
  //    executor), RETRIED a failure then an ok:true (retry history),
  //    QUARANTINED a stale failure
  //  - quarantine.jsonl: QUARANTINED (burned all 3 attempts)
  writeFileSync(
    join(dataDir, 'queue.jsonl'),
    JSON.stringify({ job_id: jobId(EXISTING.company, EXISTING.url), payload: { ...EXISTING, source: 'builder' } }) + '\n',
    'utf-8',
  );
  const resultsLines = [
    // the real executor result shape (eval.mjs writeResult) as the client
    // appends it: {...result, job_id, ts}
    { job_id: jobId(ALREADY_DONE.company, ALREADY_DONE.url), ok: true, tokens_out: 1200, tokens_in: 300, score: 4.2, report_path: '/reports/done-1.md', url: ALREADY_DONE.url, company: 'DoneX', title: 'Already evaluated', ts: '2026-09-28T10:00:00.000Z' },
    // another executor: no company/title at all
    { job_id: jobId(OTHER.company, OTHER.url), ok: false, error: 'extract_failed', tokens_out: 200, ts: '2026-09-28T11:00:00.000Z' },
    { job_id: jobId(RETRIED.company, RETRIED.url), ok: false, error: 'extract_failed', company: 'RetryCo', title: 'Retried until ok', tokens_out: 150, ts: '2026-09-28T12:00:00.000Z' },
    { job_id: jobId(RETRIED.company, RETRIED.url), ok: true, tokens_out: 900, tokens_in: 250, score: 3.8, report_path: '/reports/retry.md', url: RETRIED.url, company: 'RetryCo', title: 'Retried until ok', ts: '2026-09-28T13:00:00.000Z' },
    { job_id: jobId(QUARANTINED.company, QUARANTINED.url), ok: false, error: 'executor_exit_1', company: 'DeadCo', title: 'Burned all attempts', ts: '2026-09-27T09:00:00.000Z' },
  ];
  writeFileSync(
    join(dataDir, 'results.jsonl'),
    resultsLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf-8',
  );
  writeFileSync(
    join(dataDir, 'quarantine.jsonl'),
    JSON.stringify({ job_id: jobId(QUARANTINED.company, QUARANTINED.url), attempts: 3, error: 'executor_exit_1', ts: '2026-09-27T10:00:00.000Z' }) + '\n',
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

  const id = (j) => jobId(j.company, j.url);

  try {
    // ---------------------------------------------------------------------
    // Session 1: the read/add surface. Ends with the queue holding
    // [EXISTING, FRESH] — the file state is readable afterwards.
    // ---------------------------------------------------------------------
    const s1 = await driveServer(clientDir, [
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
      // job_lookup BEFORE the queue mutation (in-queue positions)
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'idlefill_job_lookup', arguments: { project: 'p1', job_id: id(FRESH) } } },
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'idlefill_job_lookup', arguments: { project: 'p1', job_id: id(EXISTING) } } },
    ]);
    const { byId } = s1;
    const call = s1.call;

    assert.equal(byId[1]?.result?.serverInfo?.name, 'idlefill', 'initialize → serverInfo');
    const tools = byId[2]?.result?.tools?.map((x) => x.name) || [];
    assert.deepEqual(
      tools,
      ['idlefill_add_jobs', 'idlefill_queue_status', 'idlefill_results', 'idlefill_remove_jobs', 'idlefill_clear_queue', 'idlefill_job_lookup'],
      'tools/list: all six tools',
    );

    // --- add_jobs ---
    const dry = call(3);
    assert.equal(dry.p?.ok, true, 'dry_run ok');
    // Gap 3 (issue #2): `added` echoes the STORED job — {job_id, url, company,
    // title} — not bare ids, so the caller can verify what landed.
    assert.deepEqual(
      dry.p?.added,
      [{ job_id: id(FRESH), url: FRESH.url, company: FRESH.company, title: FRESH.title }],
      'dry_run: only FRESH would be added, echoed with its stored fields',
    );
    assert.equal(dry.p?.skipped_duplicate, 1, 'dry_run: the in-batch dup is the only duplicate');
    assert.deepEqual(dry.p?.skipped_in_queue, [id(EXISTING)], 'dry_run: the already-queued job is named');
    assert.deepEqual(dry.p?.skipped_done, [id(ALREADY_DONE)], 'dry_run: done job skipped');
    assert.equal(dry.p?.queue_length, 2, 'dry_run: queue_length preview = existing + fresh');
    assert.equal(dry.p?.dry_run, true, 'dry_run flagged');
    // "dry_run did not write" is proven by the REAL call below: if the dry
    // run had touched the file, FRESH would already be in the queue and the
    // real add would report added=[] (it is checked below to report FRESH).

    const real = call(4);
    assert.equal(real.p?.ok, true, 'add ok');
    assert.deepEqual(
      real.p?.added,
      [{ job_id: id(FRESH), url: FRESH.url, company: FRESH.company, title: FRESH.title }],
      'add: exactly FRESH landed, echoed with its stored fields',
    );
    assert.equal(real.p?.queue_length, 2, 'add: queue depth reported');

    const readd = call(5);
    assert.equal(readd.p?.ok, true, 're-add ok');
    assert.deepEqual(readd.p?.added, [], 're-add: nothing new');
    assert.deepEqual(readd.p?.skipped_in_queue, [id(FRESH)], 're-add: the job is now "already in queue"');
    assert.equal(readd.p?.skipped_duplicate, 0, 're-add: no in-batch dups');

    // The FILE state after the add (session 1 ended before any mutation):
    // exactly two lines, the pre-existing line untouched and in order, the
    // new line carrying source: mcp.
    const qAfter = queueLines(dataDir).map((l) => JSON.parse(l));
    assert.equal(qAfter.length, 2, 'queue file now holds both jobs');
    assert.equal(qAfter[0]?.job_id, id(EXISTING), 'existing line untouched, order preserved');
    assert.equal(qAfter[1]?.job_id, id(FRESH), 'the added line is second (appended)');
    assert.equal(qAfter[1]?.payload?.source, 'mcp', 'the new line carries source: mcp');

    // Gap 3 (issue #2): the `added` echo must match what ACTUALLY landed in
    // the queue file — byte-compare every echoed field against the stored
    // line (the phantom-job guard: a typo'd identity is visible here).
    const echo = real.p?.added;
    assert.ok(Array.isArray(echo) && echo.length === 1, 'added is an array of stored-job objects');
    const storedFresh = qAfter.find((j) => j.job_id === id(FRESH));
    assert.ok(storedFresh, 'the echoed job_id exists in the queue file');
    assert.equal(echo[0].job_id, storedFresh.job_id, 'echo job_id === stored job_id');
    assert.equal(echo[0].url, storedFresh.payload.url, 'echo url === stored payload.url');
    assert.equal(echo[0].company, storedFresh.payload.company, 'echo company === stored payload.company');
    assert.equal(echo[0].title, storedFresh.payload.title, 'echo title === stored payload.title');
    // The dry_run echo (same batch) matches the same stored line — the
    // preview promised exactly what the real write stored.
    assert.deepEqual(dry.p?.added, echo, 'dry_run echo === real echo === stored values');

    // --- queue_status (file view + best-effort arbiter error) ---
    const st = call(6);
    assert.equal(st.p?.ok, true, 'queue_status ok');
    assert.equal(st.p?.projects?.p1?.queue_length, 2, 'queue_status: file depth');
    assert.equal(st.p?.projects?.p1?.jobs?.length, 2, 'queue_status: both jobs shown');
    assert.equal(st.p?.projects?.p1?.jobs?.[0]?.job_id, id(EXISTING), 'queue_status: file order (preview = priority order)');
    assert.equal(st.p?.projects?.p1?.jobs?.[1]?.job_id, id(FRESH), 'queue_status: appended job is second');
    assert.equal(typeof st.p?.arbiter?.error, 'string', 'queue_status: arbiter read is a best-effort error (dead url)');

    // --- results: newest first + company/title echo (present + absent) ---
    const res = call(7);
    assert.equal(res.p?.ok, true, 'results ok');
    assert.equal(res.p?.count, 5, 'results: five lines, all shown');
    assert.equal(res.p?.results?.[0]?.job_id, id(QUARANTINED), 'results: newest first');
    const doneRow = res.p?.results?.find((r) => r.job_id === id(ALREADY_DONE));
    assert.equal(doneRow?.ok, true, 'results: ok flag carried');
    assert.equal(doneRow?.company, 'DoneX', 'results: company echoed (executor row)');
    assert.equal(doneRow?.title, 'Already evaluated', 'results: title echoed (executor row)');
    assert.equal(doneRow?.score, 4.2, 'results: score carried');
    assert.equal(doneRow?.report_path, '/reports/done-1.md', 'results: report_path carried');
    const otherRow = res.p?.results?.find((r) => r.job_id === id(OTHER));
    assert.equal(otherRow?.company, null, 'results: company null when the row lacks it');
    assert.equal(otherRow?.title, null, 'results: title null when the row lacks it');
    assert.equal(otherRow?.error, 'extract_failed', 'results: error carried on the failure row');

    // --- job_lookup: in-queue (positions) ---
    const lkFresh = call(8);
    assert.equal(lkFresh.p?.ok, true, 'lookup ok');
    assert.equal(lkFresh.p?.found, true, 'lookup: FRESH found');
    assert.equal(lkFresh.p?.in_queue, true, 'lookup: FRESH in queue');
    assert.equal(lkFresh.p?.position, 2, 'lookup: 1-based position (after EXISTING)');
    assert.equal(lkFresh.p?.queue_length, 2, 'lookup: queue length at call time');
    assert.equal(lkFresh.p?.payload?.url, FRESH.url, 'lookup: payload url');
    assert.equal(lkFresh.p?.payload?.company, 'Acme', 'lookup: payload company');
    assert.equal(lkFresh.p?.payload?.title, 'New job', 'lookup: payload title');
    assert.equal(lkFresh.p?.payload?.score, 9, 'lookup: payload score');
    assert.equal(lkFresh.p?.payload?.attempts, 0, 'lookup: attempts defaults to 0');
    assert.equal(lkFresh.p?.done, false, 'lookup: not done');
    assert.equal(lkFresh.p?.quarantined, false, 'lookup: not quarantined');
    assert.equal(typeof lkFresh.p?.arbiter?.error, 'string', 'lookup: arbiter best-effort error (dead url)');
    const lkExisting = call(9);
    assert.equal(lkExisting.p?.in_queue, true, 'lookup: EXISTING in queue');
    assert.equal(lkExisting.p?.position, 1, 'lookup: EXISTING is first');
    if (s1.stderr.trim()) console.log(`session 1 stderr:\n${s1.stderr.trim()}`);

    // ---------------------------------------------------------------------
    // Session 2: the mutations + the lookup facts. Ends with the queue
    // empty (clear_queue), so the post-session file read asserts emptiness.
    // The post-remove file state (1 line, EXISTING) is asserted via the
    // server's OWN live queue_status read (id 15) — no test-side mid-flight
    // file reads.
    // ---------------------------------------------------------------------
    const s2 = await driveServer(clientDir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      // --- remove_jobs ---
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'idlefill_remove_jobs', arguments: { project: 'p1', dry_run: true, job_ids: [id(FRESH), GHOST] } } },
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'idlefill_remove_jobs', arguments: { project: 'p1', job_ids: [id(FRESH), GHOST] } } },
      { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'idlefill_remove_jobs', arguments: { project: 'p1' } } },
      // the server's live read of the post-remove file state
      { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'idlefill_queue_status', arguments: { project: 'p1', limit: 5 } } },
      // --- clear_queue ---
      { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'idlefill_clear_queue', arguments: { project: 'p1', dry_run: true } } },
      { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'idlefill_clear_queue', arguments: { project: 'p1' } } },
      // --- job_lookup against the ground-truth files (queue now empty) ---
      { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'idlefill_job_lookup', arguments: { project: 'p1', job_id: id(ALREADY_DONE) } } },
      { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'idlefill_job_lookup', arguments: { project: 'p1', job_id: id(QUARANTINED) } } },
      { jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'idlefill_job_lookup', arguments: { project: 'p1', job_id: GHOST } } },
      // --- pre-existing error surfaces ---
      { jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'idlefill_add_jobs', arguments: { jobs: [{ company: 'Bad', url: 'not-a-url' }] } } },
      { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'idlefill_add_jobs', arguments: { project: 'nope', jobs: [FRESH] } } },
      { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'unknown-tool', arguments: {} } },
    ]);
    const c2 = s2.call;

    // --- remove_jobs ---
    const rmDry = c2(10);
    assert.equal(rmDry.p?.ok, true, 'remove dry_run ok');
    assert.equal(rmDry.p?.dry_run, true, 'remove dry_run flagged');
    assert.deepEqual(rmDry.p?.removed, [id(FRESH)], 'remove dry_run: the present id is named');
    assert.deepEqual(rmDry.p?.not_found, [GHOST], 'remove dry_run: the unknown id is named, not an error');
    assert.equal(rmDry.p?.queue_length, 1, 'remove dry_run: post-removal preview depth');

    const rmReal = c2(11);
    // If the dry run above had written, this would report removed=[]:
    // reporting FRESH proves the dry run touched nothing.
    assert.equal(rmReal.p?.ok, true, 'remove ok (dry run did not write)');
    assert.deepEqual(rmReal.p?.removed, [id(FRESH)], 'remove: the present id was dropped');
    assert.deepEqual(rmReal.p?.not_found, [GHOST], 'remove: unknown id reported');
    assert.equal(rmReal.p?.queue_length, 1, 'remove: queue now 1 deep');

    const rmMissing = c2(12);
    assert.equal(rmMissing.p?.ok, false, 'remove without job_ids is an error');
    assert.match(rmMissing.p?.error ?? '', /job_ids/, 'remove: names the missing argument');

    // the post-remove file state, read LIVE by the server:
    const stRm = c2(15);
    assert.equal(stRm.p?.projects?.p1?.queue_length, 1, 'post-remove: live file depth is 1');
    assert.equal(stRm.p?.projects?.p1?.jobs?.[0]?.job_id, id(EXISTING), 'post-remove: the surviving line is EXISTING (order/fields intact)');

    // --- clear_queue ---
    const clDry = c2(13);
    assert.equal(clDry.p?.ok, true, 'clear dry_run ok');
    assert.equal(clDry.p?.dry_run, true, 'clear dry_run flagged');
    assert.equal(clDry.p?.cleared, 1, 'clear dry_run: would clear the 1 remaining job');

    const clReal = c2(14);
    // If the dry run had emptied the file, this would report cleared=0.
    assert.equal(clReal.p?.ok, true, 'clear ok (dry run did not write)');
    assert.equal(clReal.p?.cleared, 1, 'clear: the job that was there is counted');
    assert.equal(clReal.p?.queue_length, 0, 'clear: queue is empty');
    assert.equal(queueLines(dataDir).length, 0, 'clear: the file is empty on disk');

    // --- job_lookup against the ground-truth files (queue now empty) ---
    const lkDone = c2(16);
    assert.equal(lkDone.p?.found, true, 'lookup done: found via results history');
    assert.equal(lkDone.p?.in_queue, false, 'lookup done: not in the (now empty) queue');
    assert.equal(lkDone.p?.position, null, 'lookup done: no position');
    assert.equal(lkDone.p?.done, true, 'lookup done: last results line ok:true');
    assert.equal(lkDone.p?.quarantined, false, 'lookup done: not quarantined');
    assert.equal(lkDone.p?.results?.length, 1, 'lookup done: one history line');
    assert.equal(lkDone.p?.results?.[0]?.company, 'DoneX', 'lookup done: history echoes company');
    assert.match(lkDone.p?.hint ?? '', /done/, 'lookup done: hint explains the state');

    const lkQuar = c2(17);
    assert.equal(lkQuar.p?.found, true, 'lookup quarantined: found');
    assert.equal(lkQuar.p?.quarantined, true, 'lookup quarantined: quarantine.jsonl fact');
    assert.equal(lkQuar.p?.done, false, 'lookup quarantined: its last line is a failure, not done');
    assert.equal(lkQuar.p?.in_queue, false, 'lookup quarantined: not in the queue');
    assert.equal(lkQuar.p?.results?.length, 1, 'lookup quarantined: the stale failure line is its history');
    assert.equal(lkQuar.p?.results?.[0]?.ok, false, 'lookup quarantined: history ok flag');
    assert.match(lkQuar.p?.hint ?? '', /quarantined/, 'lookup quarantined: hint explains the state');

    const lkGhost = c2(18);
    assert.equal(lkGhost.p?.ok, true, 'lookup never-seen: ok:true (not an error)');
    assert.equal(lkGhost.p?.found, false, 'lookup never-seen: found false');
    assert.equal(lkGhost.p?.in_queue, false, 'lookup never-seen: not in queue');
    assert.equal(lkGhost.p?.done, false, 'lookup never-seen: no done fact');
    assert.equal(lkGhost.p?.quarantined, false, 'lookup never-seen: no quarantine fact');
    assert.match(lkGhost.p?.hint ?? '', /never seen/, 'lookup never-seen: the hint');

    // --- pre-existing error surfaces ---
    const badUrl = c2(19);
    assert.equal(badUrl.p?.ok, false, 'bad url rejected');
    assert.match(badUrl.p?.error ?? '', /valid http\(s\) url/, 'bad url error message');
    const unknownProj = c2(20);
    assert.equal(unknownProj.p?.ok, false, 'unknown project rejected');
    assert.match(unknownProj.p?.error ?? '', /unknown project/, 'unknown project error message');

    assert.equal(s2.byId[21]?.error?.code, -32602, 'unknown tool → JSON-RPC -32602');
    if (s2.stderr.trim()) console.log(`session 2 stderr:\n${s2.stderr.trim()}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #14 — per-project MCP tool policy (mcp block, tools/list filtering,
// tools/call enforcement, IDLEFILL_MCP_READ_ONLY, mcp.enabled:false,
// listChanged). Same hermetic-stdio harness: real process, scratch client dir.
// ---------------------------------------------------------------------------

test('idlefill-mcp issue #14: per-project tool policy — hide + enforce + read-only env + enabled:false', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'idlefill-mcp-policy-'));
  const clientDir = join(scratch, 'client');
  const dataDir = join(scratch, 'data');
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const FRESH = { url: 'https://example.com/policy-1', company: 'PolicyCo', title: 'Policy job' };
  const seedQueue = (file) =>
    writeFileSync(
      join(dataDir, file),
      JSON.stringify({ job_id: jobId(FRESH.company, FRESH.url), payload: { ...FRESH, source: 'seed' } }) + '\n',
      'utf-8',
    );
  seedQueue('queue-p1.jsonl');
  seedQueue('queue-ro.jsonl');
  seedQueue('queue-sub.jsonl');
  seedQueue('queue-off.jsonl');
  writeFileSync(join(dataDir, 'results-p1.jsonl'), '', 'utf-8');

  // p1: no mcp block (today's behavior). ro: allow_write:false.
  // sub: explicit subset (policy order; bogus_tool unknown → dropped + warned
  // once). off: mcp.enabled:false → invisible to the MCP server entirely.
  writeFileSync(
    join(clientDir, 'config.json'),
    JSON.stringify({
      server_url: 'http://127.0.0.1:1',
      token: 'not-a-real-token',
      name: 'policy-test',
      projects: [
        { name: 'p1', queue_file: '../data/queue-p1.jsonl', results_file: '../data/results-p1.jsonl' },
        { name: 'ro', queue_file: '../data/queue-ro.jsonl', results_file: '../data/results-ro.jsonl', mcp: { allow_write: false } },
        { name: 'sub', queue_file: '../data/queue-sub.jsonl', results_file: '../data/results-sub.jsonl', mcp: { tools: ['idlefill_results', 'idlefill_queue_status', 'bogus_tool', 'bogus_tool'] } },
        { name: 'off', queue_file: '../data/queue-off.jsonl', results_file: '../data/results-off.jsonl', mcp: { enabled: false } },
      ],
    }),
    'utf-8',
  );

  const roQueueBefore = readFileSync(join(dataDir, 'queue-ro.jsonl'));
  const offQueueBefore = readFileSync(join(dataDir, 'queue-off.jsonl'));

  try {
    const s = await driveServer(clientDir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      // tools/list per project (policy-resolved)
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { project: 'ro' } },
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { project: 'sub' } },
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { project: 'off' } },
      // tools/list with no param: union across enabled projects
      { jsonrpc: '2.0', id: 5, method: 'tools/list' },
      // repeat of id 5 — identical set → NO list_changed notification
      { jsonrpc: '2.0', id: 6, method: 'tools/list' },
      // enforcement at the call site (hidden ≠ allowed)
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'idlefill_add_jobs', arguments: { project: 'ro', jobs: [FRESH] } } },
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'idlefill_remove_jobs', arguments: { project: 'ro', job_ids: [jobId(FRESH.company, FRESH.url)] } } },
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'idlefill_clear_queue', arguments: { project: 'ro' } } },
      // a read tool for ro still works
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'idlefill_queue_status', arguments: { project: 'ro' } } },
      // sub: tool outside the subset is blocked; inside the subset works
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'idlefill_job_lookup', arguments: { project: 'sub', job_id: 'x-1' } } },
      { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'idlefill_results', arguments: { project: 'sub' } } },
      // disabled project: unknown-project error must NOT enumerate it
      { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'idlefill_add_jobs', arguments: { project: 'off', jobs: [FRESH] } } },
      // queue_status enumeration excludes the disabled project
      { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'idlefill_queue_status', arguments: {} } },
    ]);
    const { byId, notes, call, stderr } = s;

    // --- initialize advertises listChanged + the policy extension ---
    assert.equal(byId[1]?.result?.capabilities?.tools?.listChanged, true, 'initialize: listChanged true');
    assert.match(byId[1]?.result?.instructions ?? '', /params\.project/, 'initialize instructions document the params.project extension');

    // --- tools/list for allow_write:false: write tools hidden ---
    const roTools = byId[2]?.result?.tools || [];
    assert.deepEqual(
      roTools.map((t) => t.name),
      ['idlefill_queue_status', 'idlefill_results', 'idlefill_job_lookup'],
      'ro: write tools not in tools/list',
    );
    assert.ok(roTools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false), 'ro: annotations reflect effective read-only permission');

    // --- tools/list for the explicit subset: exact set, POLICY order ---
    assert.deepEqual(
      byId[3]?.result?.tools?.map((t) => t.name),
      ['idlefill_results', 'idlefill_queue_status'],
      'sub: exactly the configured subset, in the policy order (not static order)',
    );

    // --- unknown tool name in mcp.tools: warned once on stderr, dropped ---
    const warnLines = stderr.split('\n').filter((l) => l.includes('bogus_tool'));
    assert.equal(warnLines.length, 1, 'unknown tool name reported exactly once on stderr');
    assert.match(warnLines[0] ?? '', /unknown tool name "bogus_tool"/, 'stderr names the offending tool');

    // --- disabled project: empty tool list ---
    assert.deepEqual(byId[4]?.result?.tools, [], 'off (enabled:false): no tools listed');

    // --- no-param tools/list: union across enabled projects ---
    assert.deepEqual(
      byId[5]?.result?.tools?.map((t) => t.name),
      ['idlefill_add_jobs', 'idlefill_queue_status', 'idlefill_results', 'idlefill_remove_jobs', 'idlefill_clear_queue', 'idlefill_job_lookup'],
      'no-param list: union of enabled projects (p1 keeps the write tools visible)',
    );
    const unionWrites = byId[5]?.result?.tools?.filter((t) => ['idlefill_add_jobs', 'idlefill_remove_jobs', 'idlefill_clear_queue'].includes(t.name)) || [];
    assert.ok(unionWrites.length === 3 && unionWrites.every((t) => t.annotations?.readOnlyHint === true), 'no-param list: write annotations most-restrictive (ro cannot write)');

    // --- listChanged notification: fired when the set changed, not when identical ---
    const changed = notes.filter((n) => n.method === 'notifications/tools/list_changed');
    // id2→id3 changed, id3→id4 changed, id4→id5 changed, id5→id6 identical (no note)
    assert.equal(changed.length, 3, 'notifications/tools/list_changed fired on each differing list, not on the identical repeat');

    // --- enforcement: hidden write tools still BLOCKED at the call site ---
    const add = call(7);
    assert.equal(add.isError, true, 'ro add_jobs → isError');
    assert.match(add.p?.error ?? '', /^write not allowed for project "ro" \(mcp\.allow_write\)$/, 'ro add_jobs: reason names the governing field');
    assert.equal(call(8).isError, true, 'ro remove_jobs → isError');
    assert.match(call(8).p?.error ?? '', /mcp\.allow_write/, 'ro remove_jobs: governing field named');
    assert.equal(call(9).isError, true, 'ro clear_queue → isError');
    assert.match(call(9).p?.error ?? '', /mcp\.allow_write/, 'ro clear_queue: governing field named');

    // The queue file is BYTE-UNCHANGED after all three blocked writes.
    assert.deepEqual(readFileSync(join(dataDir, 'queue-ro.jsonl')), roQueueBefore, 'ro: queue file byte-identical after blocked writes');

    // --- read tools unaffected for the read-only project ---
    assert.equal(call(10).p?.ok, true, 'ro: read tool still works');

    // --- subset enforcement: outside blocked, inside allowed ---
    const outside = call(11);
    assert.equal(outside.isError, true, 'sub job_lookup (outside subset) → isError');
    assert.match(outside.p?.error ?? '', /^tool "idlefill_job_lookup" not in mcp\.tools for project "sub"$/, 'sub: reason names mcp.tools + project');
    assert.equal(call(12).p?.ok, true, 'sub results (inside subset) works');

    // --- enabled:false: excluded from enumeration + error message ---
    const offCall = call(13);
    assert.equal(offCall.isError, true, 'off add_jobs → isError');
    assert.match(offCall.p?.error ?? '', /unknown project "off"/, 'off: unknown project error');
    assert.ok(!/client config knows: [^;]*\boff\b/.test(offCall.p?.error ?? ''), 'off: not listed in the unknown-project message');
    assert.match(offCall.p?.error ?? '', /p1, ro, sub/, 'off: enabled projects ARE listed');
    assert.deepEqual(readFileSync(join(dataDir, 'queue-off.jsonl')), offQueueBefore, 'off: queue file untouched (daemon may still drain it; MCP never touches it)');

    const stAll = call(14);
    assert.deepEqual(Object.keys(stAll.p?.projects || {}), ['p1', 'ro', 'sub'], 'queue_status enumeration excludes enabled:false project');

    if (stderr.trim() && warnLines.length === 1) {
      /* the expected warning; anything else on stderr is noise to surface */
      const rest = stderr.split('\n').filter((l) => l.trim() && !l.includes('bogus_tool'));
      if (rest.length) console.log(`policy session unexpected stderr:\n${rest.join('\n')}`);
    } else if (stderr.trim()) {
      console.log(`policy session stderr:\n${stderr.trim()}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('idlefill-mcp issue #14: IDLEFILL_MCP_READ_ONLY=1 blocks every write tool for every project', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'idlefill-mcp-ro-env-'));
  const clientDir = join(scratch, 'client');
  const dataDir = join(scratch, 'data');
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const FRESH = { url: 'https://example.com/env-ro-1', company: 'EnvCo', title: 'Env job' };
  writeFileSync(
    join(dataDir, 'queue.jsonl'),
    JSON.stringify({ job_id: jobId(FRESH.company, FRESH.url), payload: { ...FRESH, source: 'seed' } }) + '\n',
    'utf-8',
  );
  // p1 has NO mcp block (would allow everything) — the env flag overrides it.
  writeFileSync(
    join(clientDir, 'config.json'),
    JSON.stringify({
      server_url: 'http://127.0.0.1:1',
      token: 'not-a-real-token',
      name: 'env-ro-test',
      projects: [{ name: 'p1', queue_file: '../data/queue.jsonl', results_file: '../data/results.jsonl' }],
    }),
    'utf-8',
  );
  const queueBefore = readFileSync(join(dataDir, 'queue.jsonl'));

  try {
    const s = await driveServer(clientDir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'idlefill_add_jobs', arguments: { project: 'p1', jobs: [{ url: 'https://example.com/env-ro-2', company: 'EnvCo', title: 'Blocked' }] } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'idlefill_remove_jobs', arguments: { project: 'p1', job_ids: [jobId(FRESH.company, FRESH.url)] } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'idlefill_clear_queue', arguments: { project: 'p1' } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'idlefill_queue_status', arguments: { project: 'p1' } } },
    ], { IDLEFILL_MCP_READ_ONLY: '1' });
    const { byId, call } = s;

    assert.match(byId[1]?.result?.instructions ?? '', /READ-ONLY mode \(IDLEFILL_MCP_READ_ONLY=1\)/, 'initialize instructions advertise read-only mode');
    assert.deepEqual(
      byId[2]?.result?.tools?.map((t) => t.name),
      ['idlefill_queue_status', 'idlefill_results', 'idlefill_job_lookup'],
      'read-only env: write tools hidden from tools/list even with no mcp block',
    );
    for (const id of [3, 4, 5]) {
      const c = call(id);
      assert.equal(c.isError, true, `read-only env: write tool call id ${id} isError`);
      assert.match(c.p?.error ?? '', /read-only mode \(IDLEFILL_MCP_READ_ONLY\)/, `read-only env: error names the env flag (id ${id})`);
    }
    assert.deepEqual(readFileSync(join(dataDir, 'queue.jsonl')), queueBefore, 'read-only env: queue file byte-unchanged');
    assert.equal(call(6).p?.ok, true, 'read-only env: read tools still work');
    if (s.stderr.trim()) console.log(`env-ro session stderr:\n${s.stderr.trim()}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #15 — tool-module extension point (discovered tools). Same hermetic
// harness: real stdio process, scratch dirs, no ports. The committed fixture
// (test-fixtures/hello-tool/idlefill-mcp-tools.mjs) is copied into a scratch
// dir so "remove the file → gone from tools/list" is provable without editing
// the repo. Origin (a) (the adapters/<dir> glob) is proven at unit level
// against discoverToolModules with a scratch repoRoot — the server has no
// repo-root override env, so a full-process test of (a) is impossible without
// touching the real repo (deviation noted in docs/reports/ISSUE15-REPORT.md).
// ---------------------------------------------------------------------------

const FIXTURE_HELLO = join(__dirname, 'test-fixtures', 'hello-tool', 'idlefill-mcp-tools.mjs');

/** Spawn the server expecting a STARTUP failure: returns {code, stderr}. */
async function driveStartup(env) {
  const child = spawn('node', [MCP], {
    env: { ...process.env, IDLEFILL_MCP_TOOLS: undefined, ...(env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderrBuf = [];
  child.stderr.on('data', (d) => stderrBuf.push(d.toString()));
  child.stdin.end();
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 10_000);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  return { code, stderr: stderrBuf.join('') };
}

test('idlefill-mcp issue #15: discovered hello tool — listed, callable, gone when the file is removed', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'idlefill-mcp-modules-'));
  const clientDir = join(scratch, 'client');
  const dataDir = join(scratch, 'data');
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(clientDir, 'config.json'),
    JSON.stringify({
      server_url: 'http://127.0.0.1:1',
      token: 'not-a-real-token',
      name: 'modules-test',
      projects: [{ name: 'p1', queue_file: '../data/queue.jsonl', results_file: '../data/results.jsonl' }],
    }),
    'utf-8',
  );

  // The fixture lives in the repo; work from a scratch copy so removal is
  // provable (and the committed fixture is never mutated). IDLEFILL_MCP_TOOLS
  // points at the fixture DIRECTORY: deleting the module file inside it must
  // remove the tool from the list without breaking startup.
  const fixtureDir = join(scratch, 'hello-tool');
  const fixtureCopy = join(fixtureDir, 'idlefill-mcp-tools.mjs');
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(fixtureCopy, readFileSync(FIXTURE_HELLO));

  const CORE = ['idlefill_add_jobs', 'idlefill_queue_status', 'idlefill_results', 'idlefill_remove_jobs', 'idlefill_clear_queue', 'idlefill_job_lookup'];
  const reqs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hello', arguments: { name: 'idlefill' } } },
    { jsonrpc: '2.0', id: 4, method: 'ping' },
  ];

  try {
    // Session 1: fixture present → hello listed + callable.
    const s1 = await driveServer(clientDir, reqs, { IDLEFILL_MCP_TOOLS: fixtureDir });
    const names1 = s1.byId[2]?.result?.tools?.map((t) => t.name) || [];
    assert.deepEqual(names1, [...CORE, 'hello'], 'discovered tool appended after core, sorted by name');
    const hello = s1.call(3);
    assert.equal(hello.isError, false, 'hello call not an error');
    assert.equal(hello.p?.ok, true, 'hello returns ok');
    assert.equal(hello.p?.hello, 'hello idlefill', 'hello returns its content');
    assert.equal(hello.p?.tool, 'hello', 'call() received the tool name');
    assert.equal(hello.p?.project, 'p1', 'ctx.project resolved by the server (sole configured project)');
    assert.deepEqual(hello.p?.known_projects, ['p1'], 'ctx.paths is the resolved projectPaths map');
    assert.equal(hello.p?.arbiter_is_function, true, 'ctx.arbiter supplied');
    assert.equal(hello.p?.log_is_function, true, 'ctx.log supplied');
    if (s1.stderr.trim()) console.log(`modules session 1 stderr:\n${s1.stderr.trim()}`);

    // Session 2: fixture file removed → hello gone, core intact. No edit to
    // idlefill-mcp.mjs anywhere in this test.
    rmSync(fixtureCopy);
    const s2 = await driveServer(clientDir, reqs, { IDLEFILL_MCP_TOOLS: fixtureDir });
    assert.deepEqual(
      s2.byId[2]?.result?.tools?.map((t) => t.name) || [],
      CORE,
      'removed fixture: tools/list back to core only',
    );
    assert.equal(s2.byId[3]?.error?.code, -32602, 'removed fixture: hello call → unknown tool');
    if (s2.stderr.trim()) console.log(`modules session 2 stderr:\n${s2.stderr.trim()}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('idlefill-mcp issue #15: startup failures — duplicate name in one origin names both paths; api too new refused', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'idlefill-mcp-badmod-'));
  const modA = join(scratch, 'mod-a.mjs');
  const modB = join(scratch, 'mod-b.mjs');
  const modNew = join(scratch, 'mod-new.mjs');
  writeFileSync(modA, 'export default { api: 1, tools: [{ name: "dupe", inputSchema: { type: "object" } }], call: async () => ({ ok: true }) };\n', 'utf-8');
  writeFileSync(modB, 'export default { api: 1, tools: [{ name: "dupe", inputSchema: { type: "object" } }], call: async () => ({ ok: true }) };\n', 'utf-8');
  writeFileSync(modNew, 'export default { api: 999, tools: [{ name: "future", inputSchema: { type: "object" } }], call: async () => ({ ok: true }) };\n', 'utf-8');

  try {
    // Duplicate tool name across two module files of one origin: nonzero exit,
    // the error names BOTH paths.
    const dup = await driveStartup({ IDLEFILL_MCP_TOOLS: `${modA}:${modB}` });
    assert.notEqual(dup.code, 0, 'duplicate tool name → nonzero exit');
    assert.match(dup.stderr, /duplicate tool name "dupe"/, 'duplicate error names the tool');
    assert.ok(dup.stderr.includes(modA) && dup.stderr.includes(modB), 'duplicate error names both paths');

    // api above MODULE_API: refused with an actionable message.
    const future = await driveStartup({ IDLEFILL_MCP_TOOLS: modNew });
    assert.notEqual(future.code, 0, 'api too new → nonzero exit');
    assert.match(future.stderr, /targets api 999, but this server speaks MODULE_API 1/, 'api error states both versions');
    assert.match(future.stderr, /update idlefill-mcp\.mjs/, 'api error is actionable');

    // A module that fails to import is also a startup failure.
    const broken = join(scratch, 'broken.mjs');
    writeFileSync(broken, 'export default { tools: [', 'utf-8');
    const bad = await driveStartup({ IDLEFILL_MCP_TOOLS: broken });
    assert.notEqual(bad.code, 0, 'unparseable module → nonzero exit');
    assert.match(bad.stderr, /failed to import/, 'import failure is reported');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('idlefill-mcp issue #15: throwing module handler → isError naming the module, server stays up', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'idlefill-mcp-throw-'));
  const clientDir = join(scratch, 'client');
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(
    join(clientDir, 'config.json'),
    JSON.stringify({ server_url: 'http://127.0.0.1:1', token: 'x', name: 'throw-test', projects: [] }),
    'utf-8',
  );
  const mod = join(scratch, 'boom-tool.mjs');
  writeFileSync(
    mod,
    'export default { api: 1, tools: [{ name: "boom", inputSchema: { type: "object" } }], call: async () => { throw new Error("handler exploded"); } };\n',
    'utf-8',
  );

  try {
    const s = await driveServer(clientDir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'boom', arguments: {} } },
      // the server must still answer after the module threw
      { jsonrpc: '2.0', id: 3, method: 'ping' },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } },
    ], { IDLEFILL_MCP_TOOLS: mod });
    const boom = s.call(2);
    assert.equal(boom.isError, true, 'throwing handler → isError: true');
    assert.match(boom.p ?? s.byId[2]?.result?.content?.[0]?.text ?? '', /handler exploded/, 'the module error message surfaces');
    assert.ok((s.byId[2]?.result?.content?.[0]?.text || '').includes(mod), 'the error names the module path');
    assert.equal(s.byId[3]?.result !== undefined, true, 'server stays up: ping answered after the throw');
    assert.equal(s.call(4).isError, true, 'server still serving: second throw also handled');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('idlefill-mcp issue #15: core tool schemas byte-identical to tools.golden.json', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'idlefill-mcp-golden-'));
  const clientDir = join(scratch, 'client');
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(
    join(clientDir, 'config.json'),
    JSON.stringify({
      server_url: 'http://127.0.0.1:1',
      token: 'x',
      name: 'golden-test',
      projects: [{ name: 'p1', queue_file: '../data/queue.jsonl', results_file: '../data/results.jsonl' }],
    }),
    'utf-8',
  );
  const golden = readFileSync(join(__dirname, 'tools.golden.json'), 'utf-8');
  const CORE_NAMES = JSON.parse(golden).map((t) => t.name);

  try {
    // No IDLEFILL_MCP_TOOLS: the listing is core-only. The core subset of
    // tools/list must byte-match the committed golden file.
    const s = await driveServer(clientDir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    const listed = s.byId[2]?.result?.tools || [];
    const coreSubset = listed.filter((t) => CORE_NAMES.includes(t.name));
    assert.equal(JSON.stringify(coreSubset, null, 2) + '\n', golden, 'core tools/list schemas byte-identical to golden');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('idlefill-mcp issue #15: discovered write tool flows through the per-project policy (#14)', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'idlefill-mcp-polmod-'));
  const clientDir = join(scratch, 'client');
  const dataDir = join(scratch, 'data');
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(clientDir, 'config.json'),
    JSON.stringify({
      server_url: 'http://127.0.0.1:1',
      token: 'x',
      name: 'polmod-test',
      projects: [
        { name: 'open', queue_file: '../data/queue-open.jsonl', results_file: '../data/results-open.jsonl' },
        { name: 'ro', queue_file: '../data/queue-ro.jsonl', results_file: '../data/results-ro.jsonl', mcp: { allow_write: false } },
      ],
    }),
    'utf-8',
  );
  // A discovered WRITE tool (annotations say so) — the policy must hide and
  // block it for allow_write:false exactly like the core write tools.
  const mod = join(scratch, 'writey-tool.mjs');
  writeFileSync(
    mod,
    'export default {\n' +
      '  api: 1,\n' +
      '  tools: [{ name: "writey", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true } }],\n' +
      '  call: async () => ({ ok: true, wrote: true }),\n' +
      '};\n',
    'utf-8',
  );

  try {
    const s = await driveServer(clientDir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { project: 'ro' } },
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { project: 'open' } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'writey', arguments: { project: 'ro' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'writey', arguments: { project: 'open' } } },
    ], { IDLEFILL_MCP_TOOLS: mod });

    const roNames = s.byId[2]?.result?.tools?.map((t) => t.name) || [];
    assert.ok(!roNames.includes('writey'), 'discovered write tool hidden from allow_write:false project');
    const openNames = s.byId[3]?.result?.tools?.map((t) => t.name) || [];
    assert.ok(openNames.includes('writey'), 'discovered write tool visible to the open project');

    const blocked = s.call(4);
    assert.equal(blocked.isError, true, 'discovered write tool blocked at the call site for ro');
    assert.match(blocked.p?.error ?? '', /write not allowed for project "ro" \(mcp\.allow_write\)/, 'policy reason identical to core write tools');
    assert.equal(s.call(5).p?.ok, true, 'discovered write tool works for the open project');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('idlefill-mcp issue #15 (unit): discoverToolModules — adapter glob, env shadowing, core collision, sort', async () => {
  const { discoverToolModules, MODULE_API } = await import('./mcp-tools-registry.mjs');
  const scratch = mkdtempSync(join(tmpdir(), 'idlefill-mcp-unit-'));
  // A scratch repoRoot with two adapter dirs: one carries the default
  // idlefill-mcp-tools.mjs (origin a), one names its module via the manifest's
  // idlefill.mcp_tools field.
  const repoRoot = join(scratch, 'repo');
  const adir = join(repoRoot, 'adapters', 'alpha');
  const bdir = join(repoRoot, 'adapters', 'beta');
  mkdirSync(adir, { recursive: true });
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(adir, 'package.json'), JSON.stringify({ name: 'x', idlefill: { name: 'alpha', executor: 'node x.mjs' } }), 'utf-8');
  writeFileSync(join(adir, 'idlefill-mcp-tools.mjs'), 'export default { api: 1, tools: [{ name: "zeta_tool", inputSchema: { type: "object" } }, { name: "alpha_tool", inputSchema: { type: "object" } }], call: async () => ({ ok: true }) };\n', 'utf-8');
  writeFileSync(join(bdir, 'package.json'), JSON.stringify({ name: 'y', idlefill: { name: 'beta', executor: 'node y.mjs', mcp_tools: 'custom-tools.mjs' } }), 'utf-8');
  writeFileSync(join(bdir, 'custom-tools.mjs'), 'export default { api: 1, tools: [{ name: "shadowed", inputSchema: { type: "object" } }], call: async () => ({ ok: true, from: "adapter" }) };\n', 'utf-8');
  // Origin (b): an env module with the same "shadowed" name + its own tool.
  const envMod = join(scratch, 'env-tool.mjs');
  writeFileSync(envMod, 'export default { api: 1, tools: [{ name: "shadowed", inputSchema: { type: "object" } }, { name: "env_tool", inputSchema: { type: "object" } }], call: async () => ({ ok: true, from: "env" }) };\n', 'utf-8');

  try {
    const { tools, shadowed } = await discoverToolModules({
      repoRoot,
      extraPaths: [envMod],
      coreNames: ['idlefill_add_jobs'],
    });
    assert.deepEqual(
      tools.map((t) => t.def.name),
      ['alpha_tool', 'env_tool', 'shadowed', 'zeta_tool'],
      'merged set sorted by name (readdir order irrelevant)',
    );
    assert.equal(shadowed.length, 1, 'adapter name shadows the env module');
    assert.equal(shadowed[0].name, 'shadowed', 'shadow report names the shadowed tool');
    assert.ok(shadowed[0].winner.includes(bdir) && shadowed[0].loser === envMod, 'shadow report names winner + loser paths');
    // The surviving "shadowed" entry is the adapter one (beta's manifest-named
    // module — proving the idlefill.mcp_tools field is honoured).
    const sh = tools.find((t) => t.def.name === 'shadowed');
    assert.ok(sh.modulePath.includes(bdir), 'adapter module wins the shadowed name');
    // MODULE_API is exported and >= 1 (settled decision #5).
    assert.ok(MODULE_API >= 1, 'MODULE_API starts at 1');

    // Core-name collision: startup error, not a silent overwrite.
    const coreMod = join(scratch, 'core-clash.mjs');
    writeFileSync(coreMod, 'export default { api: 1, tools: [{ name: "idlefill_add_jobs", inputSchema: { type: "object" } }], call: async () => ({}) };\n', 'utf-8');
    await assert.rejects(
      () => discoverToolModules({ repoRoot, extraPaths: [coreMod], coreNames: ['idlefill_add_jobs'] }),
      /re-declares core tool "idlefill_add_jobs"/,
      'core tool cannot be overridden by a module',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #4: idlefill_results arbiter fallback. When the LOCAL results file
// is missing/empty the tool falls back to GET /api/projects/<p>/results on
// the arbiter (source:"arbiter"); when the local file has rows the arbiter
// is NOT consulted (source:"local"). A stub arbiter on loopback proves the
// request (path, token) and serves the rows.
// ---------------------------------------------------------------------------

function startStubArbiter(rows) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers['authorization'] ?? '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ project: 'p1', count: rows.length, results: rows }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        hits,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('idlefill-mcp issue #4: results arbiter fallback — empty local file → source:"arbiter"; local rows → source:"local" (arbiter untouched)', async () => {
  const stub = await startStubArbiter([
    { project: 'p1', job_id: 'arb-1', ok: true, score: 8.5, tokens_out: 120, tokens_in: 4000, error: null, ts: '2026-09-29T12:00:00.000Z' },
    { project: 'p1', job_id: 'arb-2', ok: false, score: null, tokens_out: 5, tokens_in: 10, error: 'executor_exit_1', ts: '2026-09-29T11:00:00.000Z' },
  ]);
  const scratch = mkdtempSync(join(tmpdir(), 'idlefill-mcp-arbresults-'));
  const clientDir = join(scratch, 'client');
  const dataDir = join(scratch, 'data');
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(clientDir, 'config.json'),
    JSON.stringify({
      server_url: stub.url,
      token: 'stub-token-1',
      name: 'arbresults-test',
      projects: [{ name: 'p1', queue_file: '../data/queue.jsonl', results_file: '../data/results.jsonl' }],
    }),
    'utf-8',
  );

  try {
    // --- Case 1: NO local results file → arbiter fallback ---
    const s1 = await driveServer(clientDir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'idlefill_results', arguments: { project: 'p1', limit: 10 } } },
    ]);
    const r1 = s1.call(2);
    assert.notEqual(r1.isError, true, 'fallback results call is not an error');
    assert.equal(r1.p?.ok, true, 'fallback ok');
    assert.equal(r1.p?.source, 'arbiter', 'source marks the arbiter fallback');
    assert.equal(r1.p?.count, 2, 'both stub rows returned');
    assert.equal(r1.p?.results?.[0]?.job_id, 'arb-1', 'arbiter rows carried through');
    assert.equal(r1.p?.results?.[0]?.score, 8.5, 'score carried from the arbiter row');
    assert.equal(r1.p?.results?.[1]?.error, 'executor_exit_1', 'error carried on the failed row');
    assert.equal(r1.p?.results?.[0]?.company, null, 'company is null on arbiter rows (not stored there)');
    assert.equal(stub.hits.length, 1, 'exactly one arbiter request');
    assert.ok(stub.hits[0].url.startsWith('/api/projects/p1/results?limit=10'), `results route + limit: ${stub.hits[0].url}`);
    assert.match(stub.hits[0].auth, /^Bearer stub-token-1$/, 'the client token rides the fallback request');

    // --- Case 2: local file present with rows → source:"local", arbiter untouched ---
    writeFileSync(
      join(dataDir, 'results.jsonl'),
      JSON.stringify({ ok: true, job_id: 'local-1', score: 4.2, tokens_out: 100, ts: '2026-09-28T10:00:00.000Z' }) + '\n',
      'utf-8',
    );
    const hitsBefore = stub.hits.length;
    const s2 = await driveServer(clientDir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'idlefill_results', arguments: { project: 'p1' } } },
    ]);
    const r2 = s2.call(2);
    assert.equal(r2.p?.source, 'local', 'local rows mark source:"local"');
    assert.equal(r2.p?.count, 1);
    assert.equal(r2.p?.results?.[0]?.job_id, 'local-1');
    assert.equal(stub.hits.length, hitsBefore, 'the arbiter was NOT consulted when the local file has rows');
  } finally {
    await stub.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('idlefill-mcp issue #4: results fallback with an unreachable arbiter keeps the "no results yet" shape', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'idlefill-mcp-noarb-'));
  const clientDir = join(scratch, 'client');
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(
    join(clientDir, 'config.json'),
    JSON.stringify({
      server_url: 'http://127.0.0.1:1', // nothing listens
      token: 'x',
      name: 'noarb-test',
      projects: [{ name: 'p1', queue_file: '../data/queue.jsonl', results_file: '../data/results.jsonl' }],
    }),
    'utf-8',
  );
  try {
    const s = await driveServer(clientDir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'idlefill_results', arguments: { project: 'p1' } } },
    ]);
    const r = s.call(2);
    assert.equal(r.p?.ok, true, 'unreachable arbiter is not an error');
    assert.equal(r.p?.note, 'no results yet', 'today\'s behavior unchanged when both sources are empty');
    assert.equal(r.p?.source, undefined, 'no source key on the no-results shape');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
