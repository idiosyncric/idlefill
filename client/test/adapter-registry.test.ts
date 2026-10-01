/**
 * adapter-registry.test.ts — issue #13: the adapter registry.
 *
 * Covers:
 *   - discovery: one bounded scan of adapters/<name>/package.json finds
 *     career-ops and noop with their manifests; a dir without an "idlefill"
 *     key is not an adapter (no error).
 *   - precedence: an explicit projects[].executor beats the adapter
 *     manifest; projects[].adapter resolves to the manifest's executor
 *     template + payload_fields + estimates.
 *   - unknown adapter: adapter_error set at load time; the daemon logs FATAL
 *     at startup, requests NO leases, and keeps registering/heartbeating
 *     (online-but-inactive — same posture as a missing executor script).
 *   - the noop adapter runs one job end to end through the fake arbiter with
 *     ZERO edits to client/src: its declared payload_fields reach the payload
 *     file (undeclared keys do NOT), its result line's tokens flow through
 *     to the usage report, and the queue shrinks only on success.
 */

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAdapters } from '../src/adapters.js';
import { loadClientConfig, type ClientConfig } from '../src/config.js';
import { ClientDaemon, type QueueJob } from '../src/index.js';
import { startFakeArbiter, type FakeArbiter } from './fake-arbiter.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

let dir: string;
let arb: FakeArbiter;
let queueFile: string;
let resultsFile: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-registry-'));
  arb = await startFakeArbiter();
  queueFile = join(dir, 'queue.jsonl');
  resultsFile = join(dir, 'results.jsonl');
});
after(async () => {
  await arb.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('discovery finds career-ops and noop manifests', () => {
  const adapters = discoverAdapters(repoRoot);
  assert.ok(adapters.has('career-ops'), 'career-ops manifest discovered');
  assert.ok(adapters.has('noop'), 'noop manifest discovered');
  const co = adapters.get('career-ops')!;
  assert.equal(co.executor, 'node {repo}/adapters/career-ops/eval.mjs {payload_file} {result_file}');
  assert.deepEqual(co.payload_fields, ['url', 'company', 'title']);
  assert.equal(co.estimated_seconds, 900);
  assert.equal(co.timeout_seconds, 1200);
  const noop = adapters.get('noop')!;
  assert.deepEqual(noop.payload_fields, ['target', 'note']);
  assert.ok(existsSync(join(noop.dir, 'eval.mjs')), 'manifest dir points at the adapter dir');
});

test('a missing adapters dir is an empty registry, not an error', () => {
  const adapters = discoverAdapters(join(dir, 'no-such-dir'));
  assert.equal(adapters.size, 0);
});

// ---------------------------------------------------------------------------
// Config resolution precedence
// ---------------------------------------------------------------------------

function cfgWith(projects: Record<string, unknown>[]): ClientConfig {
  process.env.IDLEFILL_CLIENT_CONFIG = JSON.stringify({
    server_url: arb.url,
    token: 't',
    client_name: 'registry-test',
    proxy_port: 0, // ephemeral — never collide with a live client daemon
    projects,
  });
  const cfg = loadClientConfig(join(repoRoot, 'client', 'src'));
  delete process.env.IDLEFILL_CLIENT_CONFIG;
  return cfg;
}

test('adapter resolves executor + payload_fields + estimates from the manifest', () => {
  const cfg = cfgWith([
    { name: 'noop-proj', adapter: 'noop', queue_file: join(dir, 'q.jsonl'), results_file: join(dir, 'r.jsonl'), model: 'm' },
  ]);
  const p = cfg.projects[0]!;
  assert.equal(p.executor, 'node {repo}/adapters/noop/eval.mjs {payload_file} {result_file}');
  assert.deepEqual(p.payload_fields, ['target', 'note']);
  assert.equal(p.estimated_seconds, 5, 'manifest estimate flows through');
  assert.equal(p.timeout_seconds, 30, 'manifest timeout flows through');
  assert.equal(p.adapter_error, undefined);
});

test('explicit executor beats the adapter manifest (escape hatch)', () => {
  const cfg = cfgWith([
    { name: 'p', adapter: 'noop', executor: 'node {repo}/custom.mjs {payload_file}', queue_file: 'q', results_file: 'r', model: 'm', estimated_seconds: 7 },
  ]);
  const p = cfg.projects[0]!;
  assert.equal(p.executor, 'node {repo}/custom.mjs {payload_file}');
  assert.equal(p.estimated_seconds, 7, 'config estimate beats manifest');
});

test('unknown adapter: adapter_error names the registry contents', () => {
  const cfg = cfgWith([
    { name: 'p', adapter: 'nope', queue_file: 'q', results_file: 'r', model: 'm' },
  ]);
  const p = cfg.projects[0]!;
  assert.equal(p.executor, '');
  assert.match(p.adapter_error ?? '', /unknown adapter "nope"/);
  assert.match(p.adapter_error ?? '', /career-ops/, 'the error lists what IS registered');
});

// ---------------------------------------------------------------------------
// Daemon posture: unknown adapter = FATAL, no leases, still heartbeating
// ---------------------------------------------------------------------------

class CaptureLog {
  lines: string[] = [];
  info(msg: string): void {
    this.lines.push(msg);
  }
}

test('unknown adapter: FATAL at startup, no lease requests, registration still runs', async () => {
  const log = new CaptureLog();
  writeFileSync(queueFile, JSON.stringify({ job_id: 'job-unk', payload: { target: 'x' } } satisfies QueueJob) + '\n');
  const cfg = cfgWith([
    { name: 'unk-proj', adapter: 'nope', queue_file: queueFile, results_file: resultsFile, model: 'm' },
  ]);
  const regsBefore = arb.registers.length;
  const d = new ClientDaemon(cfg, { pollMs: 50, log });
  await d.start();
  await new Promise((r) => setTimeout(r, 400));
  await d.stop();

  assert.ok(log.lines.some((l) => l.startsWith('FATAL: unknown adapter "nope"')), `FATAL logged: ${JSON.stringify(log.lines)}`);
  assert.equal(arb.leaseRequests.filter((x) => x.job_id === 'job-unk').length, 0, 'unknown adapter must not request leases');
  assert.ok(arb.registers.length > regsBefore, 'registration/heartbeat still runs (online-but-inactive)');
});

// ---------------------------------------------------------------------------
// The noop adapter end to end: zero client/src edits
// ---------------------------------------------------------------------------

test('noop adapter runs one job end to end (declared payload fields only)', async () => {
  arb.idle = true;
  // The queue line carries a payload with BOTH declared and undeclared keys.
  writeFileSync(
    queueFile,
    JSON.stringify({ job_id: 'noop-1', payload: { target: 'T-1', note: 'N-1', secret: 'MUST-NOT-FORWARD' } } satisfies QueueJob) + '\n',
  );
  const cfg = cfgWith([
    { name: 'noop-proj', adapter: 'noop', queue_file: queueFile, results_file: resultsFile, model: 'm' },
  ]);
  const log = new CaptureLog();
  const d = new ClientDaemon(cfg, { pollMs: 50, log });
  await d.start();

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (existsSync(resultsFile) && readFileSync(resultsFile, 'utf-8').trim() !== '') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await d.stop();

  // Success path: usage ok:true with the adapter's token counts.
  const use = arb.usageReports.find((u) => u.body.ok === true && u.body.tokens_out === 42);
  assert.ok(use, `noop result tokens flow through: ${JSON.stringify(arb.usageReports.map((u) => u.body))}`);

  // Result line appended + queue shrank.
  const res = JSON.parse(readFileSync(resultsFile, 'utf-8').trim().split('\n').pop()!);
  assert.equal(res.job_id, 'noop-1');
  assert.equal(res.ok, true);
  assert.equal(readFileSync(queueFile, 'utf-8').trim(), '', 'job left the queue only after success');

  // Payload vocabulary: the payload file the executor READ must carry the
  // declared fields and NOT the undeclared one. The adapter echoes what it
  // saw into the result line.
  assert.deepEqual(res.echo, { target: 'T-1', note: 'N-1' }, 'declared fields forwarded; undeclared absent');
});
