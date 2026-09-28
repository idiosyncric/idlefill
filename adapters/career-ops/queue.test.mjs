/**
 * queue.test.mjs — the queue builder's exclusion rules (Fix 3).
 *
 * A job_id is rebuilt into the queue only when it has NOT been durably
 * handled: a job whose LAST results line is ok:false (a retriable failure)
 * IS rebuilt; a job with a later ok:true line is NOT; a quarantined job
 * (quarantine.jsonl) is never. --force rebuilds everything.
 *
 * Hermetic: a fake CAREER_OPS_ROOT + a temp IDLEFILL_DATA, run against the
 * real queue.mjs as a subprocess. No network.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE = join(__dirname, 'queue.mjs');

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function urlHash8(url) {
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 8);
}
const jobId = (company, url) => `${slug(company || 'unknown')}-${urlHash8(url)}`;

let dir; // CAREER_OPS_ROOT
let data; // IDLEFILL_DATA

const ACME_FAIL = 'https://a.example/jd-fail';
const ACME_DONE = 'https://a.example/jd-done';
const ACME_QUAR = 'https://a.example/jd-quar';
const ACME_NEW = 'https://a.example/jd-new';

function setup(resultsLines = [], quarantinedIds = []) {
  rmSync(dir, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(dir, 'data', 'pipeline-prioritized.json'),
    JSON.stringify([
      { company: 'Acme', url: ACME_FAIL, title: 'T', score: 9, skip: false },
      { company: 'Acme', url: ACME_DONE, title: 'T', score: 8, skip: false },
      { company: 'Acme', url: ACME_QUAR, title: 'T', score: 7, skip: false },
      { company: 'Acme', url: ACME_NEW, title: 'T', score: 6, skip: false },
    ]),
  );
  if (resultsLines.length) writeFileSync(join(data, 'results.jsonl'), resultsLines.join('\n') + '\n');
  if (quarantinedIds.length) writeFileSync(join(data, 'quarantine.jsonl'), quarantinedIds.map((id) => JSON.stringify({ job_id: id, attempts: 3, error: 'x', ts: 't' })).join('\n') + '\n');
  const res = spawnSync('node', [QUEUE], {
    env: { ...process.env, CAREER_OPS_ROOT: dir, IDLEFILL_DATA: data },
    encoding: 'utf-8',
  });
  if (res.status !== 0) throw new Error(`queue.mjs failed: ${res.stderr}\n${res.stdout}`);
  const lines = existsSync(join(data, 'queue.jsonl'))
    ? readFileSync(join(data, 'queue.jsonl'), 'utf-8').split('\n').filter((l) => l.trim())
    : [];
  return { ids: lines.map((l) => JSON.parse(l).job_id), stdout: res.stdout };
}

test('rebuild rules: failed-only job IS rebuilt; later ok:true is NOT; quarantined is NEVER', () => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-queue-src-'));
  data = mkdtempSync(join(tmpdir(), 'idlefill-queue-data-'));
  const { ids, stdout } = setup(
    [
      JSON.stringify({ job_id: jobId('Acme', ACME_FAIL), ok: false, error: 'extract_failed', ts: 't1' }),
      // acme-done: a failure FIRST, then a success — its LAST line is ok:true.
      JSON.stringify({ job_id: jobId('Acme', ACME_DONE), ok: false, error: 'extract_failed', ts: 't1' }),
      JSON.stringify({ job_id: jobId('Acme', ACME_DONE), ok: true, ts: 't2' }),
    ],
    [jobId('Acme', ACME_QUAR)],
  );

  assert.ok(ids.includes(jobId('Acme', ACME_FAIL)), 'a job whose only results line is ok:false IS rebuilt (retriable)');
  assert.ok(!ids.includes(jobId('Acme', ACME_DONE)), 'a job with a later ok:true line is NOT rebuilt');
  assert.ok(!ids.includes(jobId('Acme', ACME_QUAR)), 'a quarantined job is NOT rebuilt');
  assert.ok(ids.includes(jobId('Acme', ACME_NEW)), 'a fresh job is built');
  assert.equal(ids.length, 2, `exactly the retriable + fresh jobs, got ${ids.join(', ')}`);
  assert.match(stdout, /already-done 1, quarantined 1/, `the summary carries the new counts: ${stdout.trim()}`);
});

test('--force rebuilds everything (including done + quarantined)', () => {
  const res = spawnSync('node', [QUEUE, '--force'], {
    env: { ...process.env, CAREER_OPS_ROOT: dir, IDLEFILL_DATA: data },
    encoding: 'utf-8',
  });
  assert.equal(res.status, 0);
  const lines = readFileSync(join(data, 'queue.jsonl'), 'utf-8').split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 4, '--force ignores both exclusions');
});

test('score order is preserved (stable, desc)', () => {
  rmSync(data, { recursive: true, force: true });
  const { ids } = setup([], []);
  assert.deepEqual(ids, [jobId('Acme', ACME_FAIL), jobId('Acme', ACME_DONE), jobId('Acme', ACME_QUAR), jobId('Acme', ACME_NEW)]);
});

after(() => {
  for (const d of [dir, data]) if (d) rmSync(d, { recursive: true, force: true });
});
