/**
 * noop.test.mjs — the noop adapter's executor (issue #13 fixture).
 *
 * Hermetic: writes a payload file, runs eval.mjs as a subprocess, asserts the
 * result line. The payload_fields filtering itself is covered client-side
 * (client/test/adapter-registry.test.ts); this proves the executor contract:
 * exit 0 + one JSON result line with ok/job_id/tokens.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL = join(__dirname, 'eval.mjs');

const dir = mkdtempSync(join(tmpdir(), 'idlefill-noop-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('eval.mjs writes a success result line with tokens + echo', () => {
  const payloadFile = join(dir, 'payload.json');
  const resultFile = join(dir, 'result.json');
  writeFileSync(payloadFile, JSON.stringify({ job_id: 'n-1', target: 'T', note: 'N', model: 'm', proxy_base_url: 'http://127.0.0.1:1/v1' }));
  const r = spawnSync('node', [EVAL, payloadFile, resultFile], { encoding: 'utf-8' });
  assert.equal(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  const res = JSON.parse(readFileSync(resultFile, 'utf-8').trim());
  assert.equal(res.ok, true);
  assert.equal(res.job_id, 'n-1');
  assert.equal(res.tokens_out, 42);
  assert.equal(res.tokens_in, 7);
  assert.deepEqual(res.echo, { target: 'T', note: 'N' });
});

test('eval.mjs usage without args exits 2', () => {
  const r = spawnSync('node', [EVAL], { encoding: 'utf-8' });
  assert.equal(r.status, 2);
});
