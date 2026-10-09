/**
 * client-hermes.test.ts — the loopback Hermes-gateway connector surface
 * (#84), end-to-end against the REAL proxy server (real sockets).
 *
 * Covers:
 *   - the guard ladder: Host loopback, loopback Origin, X-Idlefill-Edit
 *     token (401 without / wrong, fail closed)
 *   - GET never returns key VALUES — only the boot posture + which
 *     profiles carry one (the secret-never-egresses rule)
 *   - PUT writes keys into the key file (parent dir created, 0600,
 *     tmp-then-rename, every other entry preserved) and answers
 *     { restart_required: true, stored_profiles }
 *   - PUT { enabled } writes ONLY the hermes_gateway block into
 *     config.json — every other config key (the token included) and the
 *     file's 0600 mode preserved
 *   - clearing a key (null), malformed bodies (400 whole-body), a
 *     malformed existing key file refused (500, never overwritten), and
 *     the un-file-backed config posture (enabled ⇒ 503, keys still ok)
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLlmProxy, waitProxyReady } from '../src/proxy.js';
import { storedKeyProfiles, validateHermesBody, type ClientHermesStatus } from '../src/client-hermes.js';

const TOKEN = '***';
const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function scratchDirs(): { dir: string; configPath: string; keyFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-hmsgw-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        server_url: 'http://127.0.0.1:8787',
        token: TOKEN,
        client_name: 'gw-test-client',
        proxy_port: 11435,
        projects: [],
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  const keyFile = join(dir, 'nested', 'hermes-gateway-keys.json');
  return { dir, configPath, keyFile };
}

function bootStatus(keyFile: string, over: Partial<ClientHermesStatus> = {}): ClientHermesStatus {
  return {
    enabled: false,
    env_switch: false,
    base_url: 'http://127.0.0.1:8642',
    profiles: ['default', 'web-dev'],
    key_file: keyFile,
    gateway: null,
    ...over,
  };
}

async function startSurface(opts: { configPath: string | null; keyFile: string; status?: Partial<ClientHermesStatus>; home?: string }) {
  const proxy = startLlmProxy({
    port: 0,
    target: 'http://127.0.0.1:1',
    clientProjects: { token: TOKEN, configPath: opts.configPath },
    clientHermes: {
      token: TOKEN,
      configPath: opts.configPath,
      status: () => bootStatus(opts.keyFile, opts.status),
      ...(opts.home ? { home: opts.home } : {}),
    },
  });
  cleanup.push(() => proxy.stop());
  await waitProxyReady(proxy.server);
  return proxy;
}

const edit = (t = TOKEN) => ({ 'x-idlefill-edit': t });

test('#84 guards: 401 without/with a wrong token, cross-origin 403, OPTIONS preflight', async () => {
  const { configPath, keyFile } = scratchDirs();
  const proxy = await startSurface({ configPath, keyFile });
  assert.equal((await fetch(`${proxy.base_url}/client/hermes-gateway`)).status, 401, 'no header = no auth');
  assert.equal((await fetch(`${proxy.base_url}/client/hermes-gateway`, { headers: edit('nope') })).status, 401);
  const corsRef = await fetch(`${proxy.base_url}/client/hermes-gateway`, {
    headers: { ...edit(), origin: 'http://evil.example' },
  });
  assert.equal(corsRef.status, 403, 'a non-loopback Origin is refused');
  const pre = await fetch(`${proxy.base_url}/client/hermes-gateway`, {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1:8787' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8787');
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /x-idlefill-edit/);
});

test('#84 GET reports the posture but NEVER a key value', async () => {
  const { configPath, keyFile } = scratchDirs();
  mkdirSync(join(keyFile, '..'), { recursive: true });
  writeFileSync(keyFile, JSON.stringify({ default: 'super-secret-value', 'web-dev': 'another-secret' }), { mode: 0o600 });
  const proxy = await startSurface({
    configPath,
    keyFile,
    status: { enabled: true, gateway: { reachable: true, version: '0.21.6', ledger_size: 7 } },
  });
  const res = await fetch(`${proxy.base_url}/client/hermes-gateway`, { headers: edit() });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('super-secret-value') && !text.includes('another-secret'), 'key VALUES never egress');
  const body = JSON.parse(text) as ClientHermesStatus & { stored_profiles: string[] };
  assert.equal(body.enabled, true);
  assert.equal(body.gateway?.reachable, true);
  assert.deepEqual(body.stored_profiles, ['default', 'web-dev'], 'only WHICH profiles carry one');
  assert.deepEqual(storedKeyProfiles(keyFile), ['default', 'web-dev']);
});

test('#84 PUT writes keys (0600, dir created, others preserved) and answers restart_required', async () => {
  const { configPath, keyFile } = scratchDirs();
  const proxy = await startSurface({ configPath, keyFile });
  const res = await fetch(`${proxy.base_url}/client/hermes-gateway`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...edit() },
    body: JSON.stringify({ keys: { default: 'key-default', 'web-dev': ' key-web ' } }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { restart_required: boolean; stored_profiles: string[] };
  assert.equal(body.restart_required, true, 'the connector is built at boot — restart stays native');
  assert.deepEqual(body.stored_profiles, ['default', 'web-dev']);
  const written = JSON.parse(readFileSync(keyFile, 'utf-8')) as Record<string, string>;
  assert.deepEqual(written, { default: 'key-default', 'web-dev': 'key-web' }, 'values trimmed, entries written');
  assert.equal(statSync(keyFile).mode & 0o777, 0o600, 'the key file is a secret: 0600');

  // A second PUT preserves entries it does not mention.
  const res2 = await fetch(`${proxy.base_url}/client/hermes-gateway`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...edit() },
    body: JSON.stringify({ keys: { prAgent: 'k3', default: null } }),
  });
  assert.equal(res2.status, 200);
  const after = JSON.parse(readFileSync(keyFile, 'utf-8')) as Record<string, string>;
  assert.deepEqual(after, { 'web-dev': 'key-web', prAgent: 'k3' }, 'null clears, unmentioned stand');
});

test('#84 PUT { enabled } writes ONLY the hermes_gateway block (config keys + mode preserved)', async () => {
  const { configPath, keyFile } = scratchDirs();
  const proxy = await startSurface({ configPath, keyFile });
  const res = await fetch(`${proxy.base_url}/client/hermes-gateway`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...edit() },
    body: JSON.stringify({ enabled: true, keys: { default: 'kd' } }),
  });
  assert.equal(res.status, 200);
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  assert.deepEqual(cfg.hermes_gateway, { enabled: true }, 'the block carries the enable flag');
  assert.equal(cfg.token, TOKEN, 'every other config key stands verbatim');
  assert.equal(cfg.client_name, 'gw-test-client');
  assert.equal(statSync(configPath).mode & 0o777, 0o600, 'the config file keeps its mode');
});

test('#84 PUT validation is fail-closed whole-body (400, nothing written)', async () => {
  const { configPath, keyFile } = scratchDirs();
  const proxy = await startSurface({ configPath, keyFile });
  const bad = [
    {},
    { enabled: 'yes' },
    { keys: 'default' },
    { keys: { '': 'k' } },
    { keys: { 'a/b': 'k' } },
  ];
  for (const b of bad) {
    const res = await fetch(`${proxy.base_url}/client/hermes-gateway`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...edit() },
      body: JSON.stringify(b),
    });
    assert.equal(res.status, 400, `refused: ${JSON.stringify(b)}`);
  }
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  assert.equal(cfg.hermes_gateway, undefined, 'no partial write happened');
  assert.throws(() => readFileSync(keyFile, 'utf-8'), 'the key file was never even created');

  // (a `""` value is a documented CLEAR, not a rejection — covered by the
  // null-clear case above; the validator answers ok for it.)

  // Pure-helper posture on the same shapes.
  assert.equal(validateHermesBody({ keys: { ['x'.repeat(65)]: 'k' } }).ok, false, 'profile name length capped');
  const ok = validateHermesBody({ enabled: false, keys: { p: null } });
  assert.ok(ok.ok && ok.enabled === false && ok.keys.get('p') === null);
});

test('#84 a `~` key_file expands against home — never a literal ~ dir under the cwd', async () => {
  // The shipped-bug guard: boot config carries the RAW '~/.idlefill/...'
  // value; an unexpanded write lands in a literal `~` under the daemon's
  // cwd and the connector (which expands) never sees the key.
  const { dir, configPath } = scratchDirs();
  const home = join(dir, 'fake-home');
  mkdirSync(home);
  const real = join(home, '.gw-keys.json');
  const proxy = await startSurface({ configPath, keyFile: '~/.gw-keys.json', home });
  const res = await fetch(`${proxy.base_url}/client/hermes-gateway`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...edit() },
    body: JSON.stringify({ keys: { default: 'kd' } }),
  });
  assert.equal(res.status, 200);
  assert.equal(readFileSync(real, 'utf-8').includes('kd'), true, 'written under the HOME, not the cwd');
  const get = await fetch(`${proxy.base_url}/client/hermes-gateway`, { headers: edit() });
  const body = (await get.json()) as ClientHermesStatus & { stored_profiles: string[] };
  assert.equal(body.key_file, real, 'GET reports the ABSOLUTE key file, not the raw tilde');
  assert.deepEqual(body.stored_profiles, ['default']);
});

test('#84 a malformed existing key file is REFUSED (500), never overwritten', async () => {
  const { configPath, keyFile } = scratchDirs();
  mkdirSync(join(keyFile, '..'), { recursive: true });
  writeFileSync(keyFile, '{not json', { mode: 0o600 });
  const proxy = await startSurface({ configPath, keyFile });
  const res = await fetch(`${proxy.base_url}/client/hermes-gateway`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...edit() },
    body: JSON.stringify({ keys: { default: 'k' } }),
  });
  assert.equal(res.status, 500);
  assert.equal(readFileSync(keyFile, 'utf-8'), '{not json');
});

test('#84 env-config launch (no config file): enabled ⇒ 503 whole-PUT, keys still writable', async () => {
  const { keyFile } = scratchDirs();
  const proxy = await startSurface({ configPath: null, keyFile });
  const denied = await fetch(`${proxy.base_url}/client/hermes-gateway`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...edit() },
    body: JSON.stringify({ enabled: true, keys: { default: 'kd' } }),
  });
  assert.equal(denied.status, 503, 'the enable cannot be persisted — refuse the WHOLE PUT, never drop it silently');
  const keysOnly = await fetch(`${proxy.base_url}/client/hermes-gateway`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...edit() },
    body: JSON.stringify({ keys: { default: 'kd' } }),
  });
  assert.equal(keysOnly.status, 200);
  assert.deepEqual(storedKeyProfiles(keyFile), ['default']);
});
