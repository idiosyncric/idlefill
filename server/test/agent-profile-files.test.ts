/**
 * agent-profile-files.test.ts — the mint hand-off OPEN surface (owner ask
 * 2026-10-21). Two layers:
 *   - the module (agent-profile-files.ts) driven with an injected profiles
 *     dir + a fake spawn: name validation (the CLI rules ported), fixed
 *     targets (config.yaml / .env only), the empty paste-target creation,
 *     the per-platform opener, and the named refusals (no home / no profile
 *     / no opener / spawn failure — never a created profile);
 *   - the route (POST /api/agent-profile/open) over real HTTP: token-gated,
 *     the 400/404 named reasons, and the JSON success shape — the success
 *     path is exercised through the module with the fake spawn, never by
 *     actually launching this machine's editor.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import {
  normalizeAgentProfileName,
  openAgentHandoffFile,
  openInDefaultEditor,
  platformOpenCommand,
  type SpawnFn,
} from '../src/agent-profile-files.js';
import { buildApi } from '../src/api.js';
import { Arbiter } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import type { ServerConfig } from '../src/types.js';

const TOKEN = 'test-token-open';
const __dirname = dirname(fileURLToPath(import.meta.url));
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;

// ---------------------------------------------------------------------------
// Fake spawn: records the opener invocations; the 'spawn' event fires on the
// next microtask (after the caller's once() handlers are attached).
// ---------------------------------------------------------------------------

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  opts?: { detached?: boolean; stdio?: unknown };
}

function fakeSpawn(calls: SpawnCall[], mode: 'ok' | 'error' = 'ok'): SpawnFn {
  return (cmd, args, options) => {
    calls.push({ cmd, args, opts: options as SpawnCall['opts'] });
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
    const child = {
      once(ev: string, fn: (arg?: unknown) => void) {
        (handlers[ev] ??= []).push(fn);
        return child;
      },
      unref() {},
    } as unknown as ChildProcess;
    queueMicrotask(() => {
      if (mode === 'ok') for (const fn of handlers['spawn'] ?? []) fn();
      else for (const fn of handlers['error'] ?? []) fn(new Error('ENOENT: no such file or directory'));
    });
    return child;
  };
}

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-open-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.IDLEFILL_HERMES_PROFILES_DIR;
});

/** A profiles dir with the given profile dirs and (optional) file contents. */
function mkProfiles(profiles: Record<string, Partial<Record<'config.yaml' | '.env', string>>>): string {
  const root = mkdtempSync(join(dir, 'profiles-'));
  for (const [name, files] of Object.entries(profiles)) {
    const pdir = join(root, name);
    mkdirSync(pdir, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(pdir, file), text ?? '');
  }
  return root;
}

/** Narrow the result union to its refusal arm, pinning status + reason. */
function refusal(
  r: Awaited<ReturnType<typeof openAgentHandoffFile>>,
  status: 400 | 404 | 500,
  pattern: RegExp,
): void {
  if (r.ok) assert.fail(`expected a refusal, got ${JSON.stringify(r)}`);
  assert.equal(r.status, status);
  assert.match(r.error, pattern);
}

// ---------------------------------------------------------------------------
// The name rules (the CLI's normalizeProfileName, ported) + the opener table
// ---------------------------------------------------------------------------

test('normalizeAgentProfileName refuses everything but a single visible dir name', () => {
  assert.deepEqual(normalizeAgentProfileName('web-dev'), { ok: true, name: 'web-dev' });
  for (const bad of ['', ' ', ' x', 'x ', 'a/b', 'a\\b', 'a\u0000b', '.', '..', '.hidden']) {
    const r = normalizeAgentProfileName(bad);
    assert.equal(r.ok, false, `"${bad}" must be refused`);
  }
  assert.equal(normalizeAgentProfileName(undefined).ok, false);
  assert.equal(normalizeAgentProfileName(42).ok, false);
});

test('platformOpenCommand: open / xdg-open / start — and null elsewhere', () => {
  assert.deepEqual(platformOpenCommand('/p/config.yaml', 'darwin'), { cmd: 'open', args: ['/p/config.yaml'] });
  assert.deepEqual(platformOpenCommand('/p/config.yaml', 'linux'), { cmd: 'xdg-open', args: ['/p/config.yaml'] });
  assert.deepEqual(platformOpenCommand('C:\\p\\config.yaml', 'win32'), {
    cmd: 'cmd.exe',
    args: ['/c', 'start', '', 'C:\\p\\config.yaml'],
  });
  assert.equal(platformOpenCommand('/p/config.yaml', 'freebsd'), null);
});

test('openInDefaultEditor resolves on the spawn event, detached, and names a spawn error', async () => {
  const calls: SpawnCall[] = [];
  await openInDefaultEditor('/p/.env', { platform: 'darwin', spawnFn: fakeSpawn(calls) });
  assert.deepEqual(calls, [{ cmd: 'open', args: ['/p/.env'], opts: { detached: true, stdio: 'ignore' } }]);
  await assert.rejects(
    openInDefaultEditor('/p/.env', { platform: 'linux', spawnFn: fakeSpawn(calls, 'error') }),
    /xdg-open failed to start: ENOENT/,
  );
  await assert.rejects(openInDefaultEditor('/p/.env', { platform: 'sunos' }), /no default opener for platform sunos/);
});

// ---------------------------------------------------------------------------
// The full flow (module) — targets, paste target, named refusals
// ---------------------------------------------------------------------------

test('open flow: existing config.yaml opens as-is (created=false), contents untouched', async () => {
  const root = mkProfiles({ 'web-dev': { 'config.yaml': 'model:\n  default: X\n' } });
  const calls: SpawnCall[] = [];
  const res = await openAgentHandoffFile({ profile: 'web-dev', file: 'config' }, {
    env: { IDLEFILL_HERMES_PROFILES_DIR: root },
    platform: 'darwin',
    spawnFn: fakeSpawn(calls),
  });
  assert.deepEqual(res, { ok: true, path: join(root, 'web-dev', 'config.yaml'), created: false });
  assert.equal(readFileSync(join(root, 'web-dev', 'config.yaml'), 'utf-8'), 'model:\n  default: X\n');
  assert.deepEqual(calls.map((c) => c.args[0]), [join(root, 'web-dev', 'config.yaml')]);
});

test('open flow: a missing .env is created EMPTY — the paste target, never contents', async () => {
  const root = mkProfiles({ 'fresh-agent': { 'config.yaml': 'x: 1\n' } });
  const res = await openAgentHandoffFile({ profile: 'fresh-agent', file: 'env' }, {
    env: { IDLEFILL_HERMES_PROFILES_DIR: root },
    platform: 'darwin',
    spawnFn: fakeSpawn([]),
  });
  if (!res.ok) assert.fail(`expected ok, got ${JSON.stringify(res)}`);
  assert.equal(res.created, true);
  assert.equal(res.path, join(root, 'fresh-agent', '.env'));
  assert.equal(readFileSync(join(root, 'fresh-agent', '.env'), 'utf-8'), '');
  // The config was NOT touched by opening the .env.
  assert.equal(readFileSync(join(root, 'fresh-agent', 'config.yaml'), 'utf-8'), 'x: 1\n');
});

test('open flow: file is fixed to config.yaml/.env — the request cannot name a target', async () => {
  const root = mkProfiles({ agent: { 'config.yaml': 'a\n', '.env': 'b\n' } });
  const deps = { env: { IDLEFILL_HERMES_PROFILES_DIR: root }, platform: 'darwin' as const, spawnFn: fakeSpawn([]) };
  assert.equal((await openAgentHandoffFile({ profile: 'agent', file: 'state.db' }, deps)).ok, false);
  assert.equal((await openAgentHandoffFile({ profile: 'agent', file: 'config.yaml' }, deps)).ok, false);
  assert.equal((await openAgentHandoffFile({ profile: 'agent' }, deps)).ok, false);
  const sneaky = await openAgentHandoffFile({ profile: 'agent', file: 'env', path: join(root, 'agent', 'config.yaml') }, deps);
  assert.equal(sneaky.ok, true); // the extra key is inert — only env/config resolve
});

test('open flow: named refusals — no home, no profile, traversal, hidden; nothing is created', async () => {
  const root = mkProfiles({ agent: { '.env': 'k=v\n' } });
  const deps = { env: { IDLEFILL_HERMES_PROFILES_DIR: root }, platform: 'darwin' as const, spawnFn: fakeSpawn([]) };

  const noHome = await openAgentHandoffFile({ profile: 'agent', file: 'env' }, {
    ...deps,
    env: { IDLEFILL_HERMES_PROFILES_DIR: join(dir, 'nope-not-here') },
  });
  refusal(noHome, 404, /no Hermes profiles directory/);

  const noProfile = await openAgentHandoffFile({ profile: 'ghost', file: 'config' }, deps);
  refusal(noProfile, 404, /no Hermes profile "ghost"/);
  assert.equal(statSync(join(root, 'agent')).isDirectory(), true);
  assert.throws(() => statSync(join(root, 'ghost'))); // never a created profile

  for (const bad of ['../agent', 'a/b', '.hidden', '..']) {
    const r = await openAgentHandoffFile({ profile: bad, file: 'env' }, deps);
    refusal(r, 400, /refused|not a profile|no path separators|hidden/);
  }
});

test('open flow: an opener that fails to start names the failure (500)', async () => {
  const root = mkProfiles({ agent: { 'config.yaml': '' } });
  const res = await openAgentHandoffFile({ profile: 'agent', file: 'config' }, {
    env: { IDLEFILL_HERMES_PROFILES_DIR: root },
    platform: 'darwin',
    spawnFn: fakeSpawn([], 'error'),
  });
  refusal(res, 500, /open failed to start/);
});

// ---------------------------------------------------------------------------
// The route over real HTTP — token gate + the JSON error/success contract
// (success runs through the module above; the route adds auth + codes only)
// ---------------------------------------------------------------------------

let app: ReturnType<typeof buildApi>;
let base: string;

before(async () => {
  const boot = mkdtempSync(join(dir, 'boot-'));
  const cfg = {
    listen: 0,
    api_tokens: [TOKEN],
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    server_name: 'llama-swap',
    server_models: ['Qwen3.8-27B'],
    server_peers: [],
    log_glob: '',
    idle_seconds: 300,
    poll_ms: 60_000,
    lease_ttl_seconds: 1800,
    lease_ttl_safety_factor: 2,
    lease_ttl_floor_seconds: 60,
    max_concurrent_leases: 1,
    job_fail_threshold: 5,
    job_cooldown_seconds: 300,
    projects: [],
    state_file: join(boot, 'state.json'),
  } satisfies ServerConfig;
  const det = new IdleDetector({
    fetchActivity: async () => [],
    logMtime: () => null,
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: '',
    idle_seconds: cfg.idle_seconds,
  });
  app = buildApi({ arbiter: new Arbiter(new StateStore(cfg.state_file), cfg, det), cfg, publicDir: join(__dirname, 'fixtures', 'dashboard') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

after(async () => {
  await app.close();
});

test('POST /api/agent-profile/open is token-gated like every /api/* write', async () => {
  const anon = await fetch(`${base}/api/agent-profile/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'x', file: 'config' }),
  });
  assert.equal(anon.status, 401);
  const wrong = await fetch(`${base}/api/agent-profile/open?token=WRONG`, { method: 'POST' });
  assert.equal(wrong.status, 401, 'a wrong query-string token is still a 401');
});

test('the route carries the named refusals with their status', async () => {
  process.env.IDLEFILL_HERMES_PROFILES_DIR = mkProfiles({ agent: { '.env': '' } });
  const badName = await fetch(`${base}/api/agent-profile/open`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ profile: '../agent', file: 'env' }),
  });
  assert.equal(badName.status, 400);
  assert.match(((await badName.json()) as { error: string }).error, /no path separators|not a profile/);

  const noProfile = await fetch(`${base}/api/agent-profile/open`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ profile: 'ghost', file: 'config' }),
  });
  assert.equal(noProfile.status, 404);
  assert.match(((await noProfile.json()) as { error: string }).error, /no Hermes profile "ghost"/);
});
