/**
 * client-projects.test.ts — the loopback client-config editor routes
 * (#61 step 3 A3), end-to-end against the REAL proxy server (real
 * sockets), plus the pure validation/write helpers.
 *
 * Covers:
 *   - the guard ladder: Host must be loopback, a carried Origin must be
 *     loopback (no Origin = allowed), the X-Idlefill-Edit token is
 *     required and constant-time compared
 *   - OPTIONS preflight answers loopback-allow CORS (the cross-port fetch)
 *   - GET returns the config's projects array
 *   - PUT validation is fail-closed: one bad entry rejects the WHOLE body
 *     (400), never a partial write
 *   - a good PUT preserves EVERY other config key (the token included),
 *     preserves the file's 0600 mode, writes tmp-then-rename, and answers
 *     { restart_required: true } (the restart stays native)
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import http from 'node:http';
import { startLlmProxy, waitProxyReady } from '../src/proxy.js';
import { validateProjectsBody, writeProjectsToConfig } from '../src/client-projects.js';

const TOKEN = '***';
const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A scratch client/config.json with a distinctive extra key + 0600. */
function scratchConfig(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-cfgedit-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const cfg = {
    server_url: 'http://127.0.0.1:8787',
    token: TOKEN,
    client_name: 'cfg-test-client',
    projects: [
      { name: 'career-ops', model: 'Qwen3.8-27B', queue_file: '../data/q.jsonl', results_file: '../data/r.jsonl', executor: 'bash x', estimated_seconds: 900 },
    ],
  };
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return { dir, path };
}

async function startProxy(configPath: string | null) {
  const proxy = startLlmProxy({ port: 0, target: 'http://127.0.0.1:1', clientProjects: { token: TOKEN, configPath } });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);
  return proxy;
}

test('GET /client/projects needs the edit token (401 without / wrong)', async () => {
  const { path } = scratchConfig();
  const proxy = await startProxy(path);
  const noHdr = await fetch(`${proxy.base_url}/client/projects`);
  assert.equal(noHdr.status, 401, 'no header = no auth');
  const wrong = await fetch(`${proxy.base_url}/client/projects`, { headers: { 'x-idlefill-edit': 'nope' } });
  assert.equal(wrong.status, 401, 'a wrong token is refused');
  const ok = await fetch(`${proxy.base_url}/client/projects`, { headers: { 'x-idlefill-edit': TOKEN } });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { projects: { name: string }[] };
  assert.equal(body.projects.length, 1, 'GET returns the config projects verbatim');
  assert.equal(body.projects[0]!.name, 'career-ops');
});

test('OPTIONS preflight answers loopback-allow CORS for the cross-port fetch', async () => {
  const { path } = scratchConfig();
  const proxy = await startProxy(path);
  const res = await fetch(`${proxy.base_url}/client/projects`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:8787' } });
  assert.ok(res.status === 204 || res.status === 200, 'preflight answered locally (never passthrough)');
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8787', 'a loopback origin is allowed');
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /x-idlefill-edit/);
});

test('a non-loopback Origin is refused (CSRF posture); a carried-no-Origin client is allowed', async () => {
  const { path } = scratchConfig();
  const proxy = await startProxy(path);
  const bad = await fetch(`${proxy.base_url}/client/projects`, {
    headers: { 'x-idlefill-edit': TOKEN, origin: 'http://evil.example.com:1234' },
  });
  assert.equal(bad.status, 403, 'a non-loopback Origin never reaches the file');
  // fetch to 127.0.0.1 from Node sends no Origin → the allowed no-header path.
  const ok = await fetch(`${proxy.base_url}/client/projects`, { headers: { 'x-idlefill-edit': TOKEN } });
  assert.equal(ok.status, 200);
});

test('a Host header that is not loopback is refused (rebinding guard)', async () => {
  const { path } = scratchConfig();
  const proxy = await startProxy(path);
  // fetch forbids a manual Host header (browser semantics), so this
  // reaches the guard the way an attacker does: a raw request.
  const status = await new Promise<number>((resolveP) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxy.port, path: '/client/projects', headers: { host: 'idlefill.attacker.example', 'x-idlefill-edit': TOKEN } },
      (res) => { res.resume(); resolveP(res.statusCode ?? 0); },
    );
    req.on('error', () => resolveP(-1));
    req.end();
  });
  assert.equal(status, 400, 'the Host guard answers before anything else');
});

test('PUT is fail-closed: one invalid entry rejects the WHOLE body, file untouched', async () => {
  const { path } = scratchConfig();
  const proxy = await startProxy(path);
  const before = readFileSync(path, 'utf-8');
  const badBody = {
    projects: [
      { name: 'fine', model: 'm', queue_file: 'q.jsonl' },
      { name: '', model: 'm', queue_file: 'q.jsonl' }, // invalid: empty name
    ],
  };
  const res = await fetch(`${proxy.base_url}/client/projects`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-idlefill-edit': TOKEN },
    body: JSON.stringify(badBody),
  });
  assert.equal(res.status, 400, 'one invalid entry refuses the whole PUT');
  assert.match(((await res.json()) as { error: string }).error, /row 2/);
  assert.equal(readFileSync(path, 'utf-8'), before, 'a refused PUT never touches the file');

  // Non-numeric estimated_seconds is the same refusal (positive number or reject).
  const res2 = await fetch(`${proxy.base_url}/client/projects`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-idlefill-edit': TOKEN },
    body: JSON.stringify({ projects: [{ name: 'a', model: 'm', queue_file: 'q', estimated_seconds: 'soon' }] }),
  });
  assert.equal(res2.status, 400);
});

test('PUT preserves every other key + the 0600 mode, and says restart_required', async () => {
  const { path } = scratchConfig();
  const proxy = await startProxy(path);
  const edited = {
    projects: [
      { name: 'career-ops', model: 'Qwen3.8-Flash-Next', queue_file: '../data/q.jsonl', results_file: '../data/r.jsonl', executor: 'bash x', estimated_seconds: 600, timeout_seconds: 1500 },
      { name: 'second', model: 'm2', queue_file: 'q2.jsonl', adapter: 'noop' },
    ],
  };
  const res = await fetch(`${proxy.base_url}/client/projects`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-idlefill-edit': TOKEN },
    body: JSON.stringify(edited),
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { restart_required?: boolean }).restart_required, true, 'the response demands the native restart (no self-restart)');

  const cfg = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  // The Swift save path's promise, mirrored: EVERY other key survives.
  assert.equal(cfg.token, TOKEN, 'the token key is preserved verbatim');
  assert.equal(cfg.client_name, 'cfg-test-client', 'unrelated keys pass through');
  assert.equal(cfg.server_url, 'http://127.0.0.1:8787');
  const projects = cfg.projects as Record<string, unknown>[];
  assert.equal(projects.length, 2, 'the projects array is replaced whole');
  assert.equal(projects[0]!.model, 'Qwen3.8-Flash-Next', 'the edited fields landed');
  assert.equal(projects[1]!.adapter, 'noop', 'entries round-trip their extra keys');

  // The mode promise: 0600 kept.
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, 'the 0600 mode is preserved across the rename');

  // tmp-then-rename discipline: no stray .tmp left behind.
  assert.ok(!readdirSync(dirname(path)).some((f) => f.endsWith('.tmp')), 'the temp file was renamed, not left');
});

test('no config file (env-config launch) → 503, never invents one', async () => {
  const proxy = await startProxy(null);
  const res = await fetch(`${proxy.base_url}/client/projects`, { headers: { 'x-idlefill-edit': TOKEN } });
  assert.equal(res.status, 503);
});

test('the config editor never shadows the LLM passthrough on other paths', async () => {
  const { path } = scratchConfig();
  const proxy = await startProxy(path);
  // Dead target on /v1 → the clean 502 passthrough contract still holds.
  const res = await fetch(`${proxy.base_url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 502, 'plain /v1 traffic still passthroughs (the guard is path-exact)');
});

test('writeProjectsToConfig: mode + sibling keys preserved (pure helper)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-cfgwrite-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ a: 1, projects: [{ name: 'x', model: 'm', queue_file: 'q' }] }), { mode: 0o644 });
  const err = writeProjectsToConfig(path, [{ name: 'y', model: 'm', queue_file: 'q' }]);
  assert.equal(err, null);
  const cfg = JSON.parse(readFileSync(path, 'utf-8'));
  assert.equal(cfg.a, 1, 'sibling keys preserved');
  assert.equal(cfg.projects[0].name, 'y');
  assert.equal(statSync(path).mode & 0o777, 0o644, 'whatever mode the file had is kept (the live client file is 0600; a 0644 scratch keeps 0644)');
});

test('validateProjectsBody: the launch-time parsing rules, fail-closed', () => {
  assert.equal(validateProjectsBody(null).ok, false);
  assert.equal(validateProjectsBody({ projects: 'nope' }).ok, false);
  assert.equal(validateProjectsBody({ projects: [{ name: 'a', model: 'm' }] }).ok, false, 'queue_file required');
  assert.equal(validateProjectsBody({ projects: [{ name: 'a', model: 'm', queue_file: 'q', timeout_seconds: -1 }] }).ok, false, 'timeout must be positive');
  assert.equal(validateProjectsBody({ projects: [{ name: 'a', model: 'm', queue_file: 'q', timeout_seconds: 0 }] }).ok, false, 'zero is not positive');
  assert.equal(validateProjectsBody({ projects: [] }).ok, true, 'an empty array is a legal config (the loader defaults to [])');
  const ok = validateProjectsBody({ projects: [{ name: 'a', model: 'm', queue_file: 'q', cwd: '/x', scheduled_rebuild: { enabled: true, command: 'c', every_minutes: 60 } }] });
  assert.equal(ok.ok, true, 'unvalidated sibling keys pass through verbatim');
});
