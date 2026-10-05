/**
 * server-key.test.ts — #60 Slice B: per-server API keys for key-gated
 * engines (oMLX answers /v1/* only with Authorization). The credential
 * lives on the server ROW, is WRITE-ONLY over the API (never echoed by
 * any read surface), rides the detector into the real fetcher as a Bearer
 * header, and the state file that stores it is owner-only (0600).
 *
 * Covers:
 *   - the real fetcher sends `Authorization: Bearer <token>` ONLY when a
 *     token is passed (a keyless server keeps its exact old request)
 *   - IdleDetector passes its row token to the fetcher (and nothing when
 *     the row has no token)
 *   - upsertServerConnection: create honors auth_token; patch SETS on a
 *     non-empty string, CLEARS on the empty-string sentinel, and an
 *     ABSENT key never drops a stored token (patch round-trips are safe)
 *   - the seeded watched row picks up cfg.server_auth_token
 *   - /api/servers, /api/state (authenticated AND anonymous), and the
 *     POST response NEVER carry auth_token — they carry the auth_set
 *     boolean instead
 *   - a set token changes the fetcher's behavior end-to-end: a feed that
 *     401s without the key stops being degraded once the row carries it
 *   - StateStore.save writes the state file 0600 (the file can hold keys)
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdleDetector, makeRealActivityFetcher } from '../src/idle.js';
import { applyDefaults } from '../src/config.js';
import { Arbiter, WATCHED_SERVER_ID } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { buildApi } from '../src/api.js';
import type { ServerConfig, ActivityEntry } from '../src/types.js';

const T0 = Date.parse('2026-10-05T12:00:00Z');

// ---------------------------------------------------------------------------
// The real fetcher: the Bearer header must ride ONLY with a token.
// ---------------------------------------------------------------------------

test('real fetcher sends Authorization only when a token is passed', async () => {
  const seen: (Record<string, string> | undefined)[] = [];
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(init?.headers);
    return { ok: true, json: async () => ({ data: [] }) } as any;
  };
  try {
    const f = makeRealActivityFetcher();
    await f('http://engine.local:8000/api/metrics/activity');
    await f('http://engine.local:8000/api/metrics/activity', 'sekret-1');
    await f('http://engine.local:8000/api/metrics/activity', '');
    assert.equal(seen.length, 3);
    assert.equal(seen[0] && seen[0].authorization, undefined, 'a keyless row sends no auth header');
    assert.equal(seen[1]!.authorization, 'Bearer sekret-1', 'a keyed row sends the Bearer header');
    assert.equal(seen[2] && seen[2].authorization, undefined, 'an empty token is NOT a header');
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// IdleDetector plumbs the row token into the fetcher.
// ---------------------------------------------------------------------------

test('IdleDetector passes its auth_token to the fetcher (undefined when unset)', async () => {
  const passed: (string | undefined)[] = [];
  const det = new IdleDetector({
    fetchActivity: async (_url, auth) => {
      passed.push(auth);
      return [{ id: 1, timestamp: new Date(T0 - 400_000).toISOString(), src: 'ip:1', model: 'm', req_path: '/x', resp_status_code: 200 }] as ActivityEntry[];
    },
    logMtime: () => null,
    llama_swap_url: 'http://engine.local:8000',
    activity_path: '/api/metrics/activity',
    log_glob: '',
    idle_seconds: 300,
    auth_token: 'row-key',
  });
  await det.poll(T0, new Set());
  assert.deepEqual(passed, ['row-key']);

  const keyless = new IdleDetector({
    fetchActivity: async (_url, auth) => {
      passed.push(auth);
      return [];
    },
    logMtime: () => null,
    llama_swap_url: 'http://engine.local:8000',
    activity_path: '/api/metrics/activity',
    log_glob: '',
    idle_seconds: 300,
  });
  await keyless.poll(T0, new Set());
  assert.equal(passed[1], undefined, 'a row without a token passes nothing');
});

// ---------------------------------------------------------------------------
// Arbiter: create / patch semantics for the write-only credential.
// ---------------------------------------------------------------------------

function mkArbiter(dir: string) {
  const cfg = applyDefaults({
    listen: 0,
    api_tokens: ['t'],
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    server_name: 'seeded',
    server_models: [],
    server_peers: [],
    log_glob: '',
    idle_seconds: 300,
    poll_ms: 60_000,
    lease_ttl_seconds: 1800,
    max_concurrent_leases: 1,
    job_fail_threshold: 5,
    job_cooldown_seconds: 300,
    projects: [],
    state_file: join(dir, 'state.json'),
  });
  const store = new StateStore(cfg.state_file);
  return { arbiter: new Arbiter(store, cfg, new Map()), store, cfg };
}

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-key-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('create stores auth_token; patch set/clear/absent behave (never a read-back)', () => {
  const { arbiter } = mkArbiter(join(dir, 'create-patch'));
  const created = arbiter.upsertServerConnection({
    name: 'omlx',
    url: 'http://127.0.0.1:8123',
    activity_path: '',
    auth_token: '  omlx-key  ',
  });
  assert.equal(created.ok, true);
  assert.equal(created.server!.auth_token, 'omlx-key', 'create trims and stores the token');

  // Patch round-trip of OTHER fields must never drop the secret: the form
  // cannot echo it back, so an absent auth_token key means "keep".
  const renamed = arbiter.upsertServerConnection({ id: created.server!.id, name: 'omlx-2' });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.server!.auth_token, 'omlx-key', 'an absent key keeps the stored token');

  // A non-empty patch REPLACES it.
  const replaced = arbiter.upsertServerConnection({ id: created.server!.id, auth_token: 'new-key' });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.server!.auth_token, 'new-key');

  // The empty-string sentinel CLEARS it (the dashboard's remove tick box).
  const cleared = arbiter.upsertServerConnection({ id: created.server!.id, auth_token: '' });
  assert.equal(cleared.ok, true, 'the clear sentinel is a change, not nothing-to-update');
  assert.equal('auth_token' in cleared.server!, false, 'clear REMOVES the field (no empty string stored)');

  // The clear sentinel is idempotent on the field: a second clear leaves
  // the row key-less (the arbiter's touch semantics match the sibling
  // patch fields — it reports the write, not whether bytes changed).
  const again = arbiter.upsertServerConnection({ id: created.server!.id, auth_token: '' });
  assert.equal(again.ok, true);
  assert.equal('auth_token' in again.server!, false, 'still no token stored after a repeat clear');
});

test('the seeded watched row picks up cfg.server_auth_token', () => {
  const d2 = mkdtempSync(join(dir, 'seed'));
  const cfg = applyDefaults({
    llama_swap_url: 'http://omlx.local:8000',
    activity_path: '',
    server_auth_token: 'seed-key',
    state_file: join(d2, 'state.json'),
  });
  const arb = new Arbiter(new StateStore(cfg.state_file), cfg, new Map());
  const row = arb['store'].state.servers.find((s) => s.id === WATCHED_SERVER_ID)!;
  assert.equal(row.auth_token, 'seed-key');
  rmSync(d2, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The HTTP surface: write-only. Read surfaces never carry the value.
// ---------------------------------------------------------------------------

let base: string;
let keyApp: ReturnType<typeof buildApi>;
let keyArbiter: Arbiter;
let keyStore: StateStore;
let keyCfg: ServerConfig;
const API_TOKEN = 'adm' + 'in-' + 'http-token';
const ROW_KEY = 'top-s…-key';

before(async () => {
  const d = mkdtempSync(join(dir, 'http'));
  keyCfg = applyDefaults({
    listen: 0,
    api_tokens: [API_TOKEN],
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    server_models: [],
    server_peers: [],
    log_glob: '',
    idle_seconds: 300,
    poll_ms: 60_000,
    lease_ttl_seconds: 1800,
    max_concurrent_leases: 1,
    job_fail_threshold: 5,
    job_cooldown_seconds: 300,
    projects: [],
    state_file: join(d, 'state.json'),
  });
  keyStore = new StateStore(keyCfg.state_file);
  // detectorFactory so upsert-created rows get detectors (boot wiring).
  keyArbiter = new Arbiter(keyStore, keyCfg, new Map(), {
    detectorFactory: (row) =>
      new IdleDetector({
        fetchActivity: async () => [],
        logMtime: () => null,
        llama_swap_url: row.url,
        activity_path: row.activity_path,
        log_glob: '',
        idle_seconds: keyCfg.idle_seconds,
        ...(row.auth_token ? { auth_token: row.auth_token } : {}),
      }),
  });
  keyApp = buildApi({ arbiter: keyArbiter, cfg: keyCfg, publicDir: join(dir, 'no-public') });
  await keyApp.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(keyApp.server.address() as { port: number }).port}`;
});

after(async () => {
  await keyApp.close();
});

const apiAuth = { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' } as const;

test('POST /api/servers stores the key and never echoes it back', async () => {
  const res = await fetch(`${base}/api/servers`, {
    method: 'POST',
    headers: apiAuth,
    body: JSON.stringify({ name: 'keyed', url: 'http://127.0.0.1:9001', activity_path: '', auth_token: ROW_KEY }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.ok, true);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(ROW_KEY), 'the POST response must never carry the token value');
  assert.equal(body.server.auth_set, true, 'auth_set says a key exists without revealing it');
  // The row ON DISK holds it — the API just refuses to show it.
  assert.equal(keyStore.state.servers.find((s) => s.name === 'keyed')!.auth_token, ROW_KEY);
});

test('/api/servers strips auth_token from every row (auth_set rides instead)', async () => {
  const res = await fetch(`${base}/api/servers`, { headers: apiAuth });
  const body = (await res.json()) as any;
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(ROW_KEY), 'the admin read surface must not leak the key');
  assert.ok(!raw.includes('auth_token'), 'the field itself must be stripped, not emptied');
  const keyed = body.servers.find((s: any) => s.name === 'keyed');
  assert.equal(keyed.auth_set, true);
  const unkeyed = body.servers.find((s: any) => s.name !== 'keyed');
  assert.equal(unkeyed.auth_set, false, 'auth_set is a plain boolean on every row');
});

test('/api/state strips the key on BOTH the authenticated and anonymous views', async () => {
  const anon = await (await fetch(`${base}/api/state?limit=5`)).json();
  assert.ok(!JSON.stringify(anon).includes(ROW_KEY), 'the ANONYMOUS view must never carry the key');
  assert.ok(!JSON.stringify(anon).includes('auth_token'));
  const authed = await (await fetch(`${base}/api/state`, { headers: apiAuth })).json();
  assert.ok(!JSON.stringify(authed).includes(ROW_KEY), 'an admin token does not unlock a read-back either');
});

test('the state file persists the key with 0600 (owner-only)', () => {
  const mode = statSync(keyCfg.state_file).mode & 0o777;
  assert.equal(mode, 0o600, `state.json holds credentials — got mode ${mode.toString(8)}`);
  const onDisk = JSON.parse(readFileSync(keyCfg.state_file, 'utf8'));
  assert.equal(onDisk.servers.find((s: any) => s.name === 'keyed').auth_token, ROW_KEY, 'the store keeps the value somewhere; the API never shows it');
});

// ---------------------------------------------------------------------------
// End-to-end: the key is what un-degrades a key-gated feed.
// ---------------------------------------------------------------------------

test('a key-gated feed 401s without the row token and is healthy with it', async () => {
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    const auth = init?.headers?.authorization;
    if (auth !== `Bearer ${ROW_KEY}`) return { ok: false, status: 401, json: async () => ({}) } as any;
    return {
      ok: true,
      json: async () => ({
        data: [{ id: 1, timestamp: new Date(T0 - 400_000).toISOString(), src: 'ip:1', model: 'm', req_path: '/x', resp_status_code: 200 }],
      }),
    } as any;
  };
  try {
    const fetcher = makeRealActivityFetcher();
    const keyless = new IdleDetector({
      fetchActivity: fetcher,
      logMtime: () => null,
      llama_swap_url: 'http://127.0.0.1:9001',
      activity_path: '/api/metrics/activity',
      log_glob: '',
      idle_seconds: 300,
    });
    const sig1 = await keyless.poll(T0, new Set());
    assert.equal(sig1.signal_degraded, true, 'no key against a gated engine = degraded (fail-closed)');

    const keyed = new IdleDetector({
      fetchActivity: fetcher,
      logMtime: () => null,
      llama_swap_url: 'http://127.0.0.1:9001',
      activity_path: '/api/metrics/activity',
      log_glob: '',
      idle_seconds: 300,
      auth_token: ROW_KEY,
    });
    const sig2 = await keyed.poll(T0, new Set());
    assert.equal(sig2.signal_degraded, false, 'the row token unlocks the feed');
    assert.equal(sig2.idle, true, 'the 400s-old entry still carries the idle verdict');
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});
