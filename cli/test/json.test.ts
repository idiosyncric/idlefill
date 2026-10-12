import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jsonPayload } from '../src/json.js';
import { pidsJson, statusJson } from '../src/daemon.js';
import type { StatusJsonInput } from '../src/daemon.js';

test('jsonPayload emits parseable pretty JSON', () => {
  const s = jsonPayload({ a: 1, b: [true, null, 'x'] });
  assert.ok(s.includes('\n'));
  assert.deepEqual(JSON.parse(s), { a: 1, b: [true, null, 'x'] });
});

const sampleInput: StatusJsonInput = {
  repo: '/repo',
  configPath: '/repo/client/config.json',
  tsxPath: '/repo/node_modules/.bin/tsx',
  pids: [111, 112],
  cfg: { present: true, server_url: 'http://127.0.0.1:8787', token: 'SECRET-TOKEN-NEVER-EMITTED', client_name: 'mac-sam' },
  tsxOk: true,
  unit: null,
  st: {
    reachable: true,
    me: { client_id: 'c-1', name: 'mac-sam', online: true, last_seen: 1, projects: [] },
    clients: [{ client_id: 'c-1', name: 'mac-sam' }],
    idle: { idle_seconds: 300 },
    active_leases: [],
  },
};

test('status --json shape: named fields, no token, arbiter view present', () => {
  const out = statusJson(sampleInput);
  assert.equal(out.repo, '/repo');
  assert.equal(out.config_path, '/repo/client/config.json');
  assert.deepEqual(out.config, { present: true, server_url: 'http://127.0.0.1:8787', client_name: 'mac-sam' });
  assert.deepEqual(out.tsx, { path: '/repo/node_modules/.bin/tsx', ok: true });
  assert.deepEqual(out.pids, [111, 112]);
  const arbiter = out.arbiter as Record<string, unknown>;
  assert.equal(arbiter.reachable, true);
  assert.ok(Array.isArray(arbiter.clients));
});

test('status --json never carries the token (D3 auth posture)', () => {
  const s = jsonPayload(statusJson(sampleInput));
  assert.ok(!s.includes('token'), 'no token key in the payload');
  assert.ok(!s.includes('SECRET-TOKEN-NEVER-EMITTED'), 'no token value anywhere');
});

test('status --json renders the unreachable arbiter honestly', () => {
  const out = statusJson({ ...sampleInput, st: { reachable: false, status: 502 } });
  assert.deepEqual(out.arbiter, { reachable: false, status: 502 });
  const unreachable = statusJson({ ...sampleInput, st: { reachable: false } });
  assert.deepEqual(unreachable.arbiter, { reachable: false, status: null });
});

test('pids --json emits { pids: [...] }', () => {
  assert.deepEqual(JSON.parse(jsonPayload(pidsJson([1, 2, 3]))), { pids: [1, 2, 3] });
  assert.deepEqual(JSON.parse(jsonPayload(pidsJson([]))), { pids: [] });
});
