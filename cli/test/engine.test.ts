/**
 * Pure-helper tests for `idlefill engine` (cli.md D6, issue #90 S3):
 * argv→payload mapping, the dashboard-plain row render, and the
 * `--local` co-location probe decision table (glob matches / no match /
 * unreadable dir) — the mesh.md rule 1 pre-flight that saves nothing on
 * a miss. Plus real-fs probes of realProbe's matcher semantics.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAddPayload,
  buildRemovePayload,
  buildSetPayload,
  decideLocalProbe,
  explainApiError,
  isLoopbackUrl,
  localCandidateGlobs,
  localRefusalText,
  parseEngineArgs,
  realProbe,
  renderEngineRows,
  verdictLine,
  type ProbeFn,
  type ServerRow,
} from '../src/engine.js';

// ---------------------------------------------------------------------------
// argv → payload
// ---------------------------------------------------------------------------

const okParse = (argv: string[]) => {
  const p = parseEngineArgs(argv);
  assert.ok(p.ok, p.ok ? '' : p.error);
  return p as Extract<typeof p, { ok: true }>;
};

test('bare group token means list', () => {
  const p = okParse([]);
  assert.equal(p.cmd, 'list');
  assert.deepEqual(p.positional, []);
});

test('add: positional name+url, --models/--peers csvs split to arrays', () => {
  const p = okParse(['add', 'box-two', 'http://192.168.9.9:11434', '--models', 'a,b', '--peers', 'peer:gpu2']);
  assert.deepEqual(p.positional, ['box-two', 'http://192.168.9.9:11434']);
  const payload = buildAddPayload(p.positional, p.flags);
  assert.ok(payload.ok);
  assert.deepEqual(payload.ok && payload.body, {
    name: 'box-two',
    url: 'http://192.168.9.9:11434',
    models: ['a', 'b'],
    peers: ['peer:gpu2'],
  });
});

test('add --local: the flag is position-free and the payload stays clean until the probe saves it', () => {
  const p = okParse(['add', '--local', 'strata-box', 'http://127.0.0.1:1239', '--log-glob', '/Users/sam/logs/strata-*.log']);
  assert.equal(p.flags.local, true);
  assert.equal(p.flags.logGlob, '/Users/sam/logs/strata-*.log');
  const payload = buildAddPayload(p.positional, p.flags);
  assert.ok(payload.ok);
  assert.deepEqual(payload.ok && payload.body, { name: 'strata-box', url: 'http://127.0.0.1:1239' });
});

test('add refuses a missing or extra positional — the usage line names it', () => {
  assert.ok(!buildAddPayload(['only-name'], { local: false }).ok);
  assert.ok(!buildAddPayload(['n', 'u', 'extra'], { local: false }).ok);
});

test('set: patches only the provided fields; zero patch flags is a usage error', () => {
  const p = okParse(['set', 'srv-a1b2', '--name', 'renamed', '--peers', 'peer:gpu2']);
  const payload = buildSetPayload(p.positional, p.flags);
  assert.ok(payload.ok);
  assert.deepEqual(payload.ok && payload.body, { id: 'srv-a1b2', name: 'renamed', peers: ['peer:gpu2'] });

  const empty = buildSetPayload(['srv-a1b2'], { local: false });
  assert.ok(!empty.ok);
  assert.match(empty.ok ? '' : empty.error, /--name \/ --url \/ --models \/ --peers/);
});

test('remove: exactly one id', () => {
  const p = okParse(['remove', 'srv-a1b2']);
  const payload = buildRemovePayload(p.positional);
  assert.ok(payload.ok);
  assert.deepEqual(payload.ok && payload.body, { id: 'srv-a1b2' });
  assert.ok(!buildRemovePayload([]).ok);
});

test('unknown subcommand and unknown flag are usage errors naming the token', () => {
  const c = parseEngineArgs(['frobnicate']);
  assert.ok(!c.ok);
  assert.match(c.ok ? '' : c.error, /unknown engine command "frobnicate"/);
  const f = parseEngineArgs(['add', 'n', 'u', '--auth', 'sekret']);
  assert.ok(!f.ok);
  assert.match(f.ok ? '' : f.error, /unknown flag "--auth"/);
});

// ---------------------------------------------------------------------------
// Row render — the dashboard-plain voice
// ---------------------------------------------------------------------------

const watchedIdle: ServerRow = {
  id: 'srv-aaaa',
  name: 'strata-box',
  url: 'http://127.0.0.1:1239',
  activity_path: '/metrics',
  log_glob: '/Users/sam/logs/strata-*.log',
  models: [{ name: 'qwen3', running: false, queued: 2 }],
  peers: ['peer:gpu2'],
  auth_set: true,
  watched: true,
  group_id: 'g1',
  max_concurrent: 2,
  signal: { idle: true, idle_for_s: 300, last_log_write_age_s: 12, feed_enabled: true },
};

const declaredRemote: ServerRow = {
  id: 'srv-bbbb',
  name: 'box-two',
  url: 'http://192.168.9.9:11434',
  activity_path: '/api/metrics/activity',
  models: [],
  peers: [],
  watched: false,
  signal: null,
};

test('a watched idle row renders the knobs + verdict in the projects voice (runs when idle ≥Ns · max N)', () => {
  const out = renderEngineRows([watchedIdle], 120);
  assert.ok(out[0].includes('srv-aaaa') && out[0].includes('[watched]') && out[0].includes('key:set'), out[0]);
  assert.ok(out.some((l) => l.includes('runs when idle ≥120s · max 2 (group g1)')), out.join('\n'));
  assert.ok(out.some((l) => l.includes('idle — grants open · idle for 300s · log wrote 12s ago')), out.join('\n'));
  assert.ok(out.some((l) => l.includes('models: qwen3 (2 queued)')), out.join('\n'));
  assert.ok(out.some((l) => l.includes('peers (routed behind this entry point): peer:gpu2')), out.join('\n'));
  assert.ok(out.some((l) => l.includes('log: /Users/sam/logs/strata-*.log')), out.join('\n'));
});

test('an unwatched (remote) row names the fail-closed posture honestly — no fake verdict, no knobs line', () => {
  const out = renderEngineRows([declaredRemote], 120);
  assert.ok(out[0].includes('[declared]'), out[0]);
  assert.ok(
    out.some((l) => l.includes('not watched — display + routing metadata; grants against this engine fail closed (mesh.md rule 1)')),
    out.join('\n'),
  );
  assert.ok(!out.some((l) => l.includes('runs when idle')), out.join('\n'));
});

test('degraded / no-signal / running / busy read as the dashboard words them (exception-only detail)', () => {
  assert.match(
    verdictLine({ id: 'x', name: 'x', url: 'u', watched: true, signal: { degraded: true, degraded_reason: 'activity fetch failed' } }),
    /^degraded — grants blocked \(activity fetch failed\)$/,
  );
  assert.match(
    verdictLine({ id: 'x', name: 'x', url: 'u', watched: true, signal: { no_signal_reason: 'feed disabled and the log glob matches nothing' } }),
    /fail-closed for grants/,
  );
  assert.match(
    verdictLine({ id: 'x', name: 'x', url: 'u', watched: true, engaged: true, signal: { idle: false } }),
    /^running idle tasks — background work in progress$/,
  );
  assert.match(
    verdictLine({ id: 'x', name: 'x', url: 'u', watched: true, signal: { idle: false, last_activity: { age_s: 5 } } }),
    /^busy — grants blocked · last activity 5s ago$/,
  );
});

test('feed-off rows say the log mtime carries the verdict; the header names the absent feed (README posture)', () => {
  const row: ServerRow = {
    id: 'x',
    name: 'omlx',
    url: 'http://127.0.0.1:8000',
    activity_path: '',
    watched: true,
    signal: { idle: true, idle_for_s: 60, last_log_write_age_s: 30, feed_enabled: false },
  };
  const out = renderEngineRows([row], 300);
  assert.ok(out[0].includes('(no activity feed)'), out[0]);
  assert.ok(out.some((l) => l.includes('no activity feed — log mtime carries the verdict')), out.join('\n'));
});

// ---------------------------------------------------------------------------
// --local probe decision table (injected probe)
// ---------------------------------------------------------------------------

const probeTable = (table: Record<string, ReturnType<ProbeFn>>): ProbeFn => (glob) =>
  table[glob] ?? { kind: 'no-match' };

test('probe decision: first matching glob is saved; later candidates are never probed', () => {
  const order: string[] = [];
  const probe: ProbeFn = (g) => {
    order.push(g);
    return g === 'B' ? { kind: 'match', files: 3 } : { kind: 'no-match' };
  };
  const d = decideLocalProbe(['A', 'B', 'C'], probe);
  assert.equal(d.verdict, 'save');
  assert.equal(d.log_glob, 'B');
  assert.equal(d.matched, 3);
  assert.deepEqual(order, ['A', 'B']);
});

test('probe decision: no match anywhere → refuse, every candidate named', () => {
  const d = decideLocalProbe(['A', 'B'], probeTable({}));
  assert.equal(d.verdict, 'refuse');
  assert.deepEqual(d.probed.map((p) => `${p.glob}:${p.outcome}`), ['A:no match', 'B:no match']);
});

test('probe decision: an unreadable dir is never a match — it is named, and the whole probe still refuses', () => {
  const d = decideLocalProbe(['A', 'B'], probeTable({ A: { kind: 'unreadable', error: 'EACCES' } }));
  assert.equal(d.verdict, 'refuse');
  assert.deepEqual(d.probed.map((p) => `${p.glob}:${p.outcome}`), ['A:unreadable (EACCES)', 'B:no match']);
  const text = localRefusalText('strata-box', d);
  assert.match(text, /co-location rule \(mesh\.md rule 1\)/);
  assert.match(text, /Nothing was saved\./);
  assert.match(text, /--log-glob/);
});

test('probe decision: an explicit single glob that misses saves nothing', () => {
  const d = decideLocalProbe(['/nowhere/eng*.log'], probeTable({}));
  assert.equal(d.verdict, 'refuse');
  assert.equal(d.probed.length, 1);
});

// ---------------------------------------------------------------------------
// realProbe — the detector's matcher semantics on the real fs
// ---------------------------------------------------------------------------

test('realProbe: glob matches real files / exact names / dots are literal', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'strata-a.log'), 'x');
  writeFileSync(join(dir, 'strata-b.log'), 'x');
  writeFileSync(join(dir, 'other.txt'), 'x');
  assert.deepEqual(realProbe(join(dir, 'strata-*.log')), { kind: 'match', files: 2 });
  assert.deepEqual(realProbe(join(dir, 'strata-a.log')), { kind: 'match', files: 1 });
  assert.deepEqual(realProbe(join(dir, '*.txt')), { kind: 'match', files: 1 });
  assert.deepEqual(realProbe(join(dir, 'missing*.log')), { kind: 'no-match' });
  assert.deepEqual(realProbe(join(dir, 'strata-a?log')), { kind: 'no-match' });
});

test('realProbe: an unreadable dir is reported, not crashed — and never a match', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-probe-lock-'));
  writeFileSync(join(dir, 'a.log'), 'x');
  chmodSync(dir, 0o000);
  t.after(() => chmodSync(dir, 0o755));
  const r = realProbe(join(dir, '*.log'));
  assert.equal(r.kind, 'unreadable');
});

test('localCandidateGlobs: the conventional spots, slugified by row name', () => {
  const globs = localCandidateGlobs('GPU Box', '/Users/sam', '/repo');
  assert.deepEqual(globs, [
    '/Users/sam/logs/gpu-box*.log',
    '/Users/sam/logs/gpu-box/*.log',
    '/var/log/gpu-box*.log',
    '/var/log/gpu-box/*.log',
    '/repo/logs/gpu-box*.log',
    '/tmp/gpu-box*.log',
  ]);
});

// ---------------------------------------------------------------------------
// Loopback guard + arbiter error voice
// ---------------------------------------------------------------------------

test('isLoopbackUrl: --local only proves co-location when the arbiter runs here', () => {
  assert.ok(isLoopbackUrl('http://127.0.0.1:8787'));
  assert.ok(isLoopbackUrl('http://localhost:8787'));
  assert.ok(isLoopbackUrl('http://127.0.0.1'));
  assert.ok(!isLoopbackUrl('http://10.10.10.6:8080'));
  assert.ok(!isLoopbackUrl('http://urza.tailnet.ts.net'));
  assert.ok(!isLoopbackUrl('not a url'));
});

test('arbiter refusals render as plain named outcomes, unknown ones keep the detail', () => {
  assert.equal(explainApiError(404, 'unknown_server'), 'no engine with that id — `idlefill engine list` shows the ids');
  assert.equal(
    explainApiError(409, 'leases_active (let them finish or revoke them first)'),
    'remove refused: this engine has live leases — let them finish or revoke them first',
  );
  assert.equal(explainApiError(400, 'duplicate connection: box already declared at this url + activity path'), null);
  assert.equal(explainApiError(400, 'url must be an http(s) address'), null);
});
