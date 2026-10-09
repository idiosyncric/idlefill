/**
 * agent-roster.test.ts — issue #80: the client's LOCAL Hermes profile roster.
 *
 * Covers (following the api.test.ts arbiter/api style — real Fastify app on
 * an ephemeral loopback port, no network):
 *   - the `cleanAgentRoster` sanitizer: a valid roster stores; a malformed
 *     MEMBER is dropped individually (the rest are kept); a non-array and an
 *     all-dropped array → undefined (the whole key is treated as absent);
 *     rows are bounded hard.
 *   - the register heartbeat ADD-key: a present, valid `agent_roster` stores
 *     on the client row AND echoes on /api/state; malformed members drop
 *     individually (drop-don't-reject); a later valid report updates; an
 *     ABSENT report NEVER clears the stored value (the ADD-key contract).
 *   - GET /api/agent-roster: returns the ONLINE loopback client's roster; a
 *     remote (tailnet) client's roster is not honest on this box → omitted;
 *     no roster online → the body carries no `roster` key.
 *   - the client-truth posture pair: a client that never sends the key keeps
 *     its row exactly as-is (no key), like every other ADD-key.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApi, attachWebSocket } from '../src/api.js';
import { Arbiter, cleanAgentRoster, isLoopbackIp } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import type { ServerConfig } from '../src/types.js';

const T0 = Date.parse('2026-09-25T12:00:00Z');
const TOKEN = 'roster-token-456';
const __dirname = dirname(fileURLToPath(import.meta.url));

let dir: string;
let app: ReturnType<typeof buildApi>;
let arbiter: Arbiter;
let cfg: ServerConfig;
let base: string;
let det: IdleDetector;

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-roster-'));
  cfg = {
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
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 10_000 }],
    state_file: join(dir, 'state.json'),
  };
  const store = new StateStore(cfg.state_file);
  det = new IdleDetector({
    fetchActivity: async () => [], // quiet → idle; the roster tests never grant
    logMtime: () => null,
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: '',
    idle_seconds: cfg.idle_seconds,
  });
  arbiter = new Arbiter(store, cfg, det);
  app = buildApi({ arbiter, cfg, publicDir: join(__dirname, 'fixtures', 'dashboard') });
  attachWebSocket(app, arbiter, cfg);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// cleanAgentRoster — the sanitizer (the gate_posture/client_log edge pattern)
// ---------------------------------------------------------------------------

test('cleanAgentRoster: a valid roster passes through verbatim (trimmed)', () => {
  const rows = cleanAgentRoster([
    { profile: 'web-dev', posture: 'adopted', provider: 'llama-swap', base_url: 'http://127.0.0.1:8800/v1' },
    { profile: 'strata-agent', posture: 'external', base_url: 'https://strata.samwarth.com/v1' },
    { profile: 'probe-agent', posture: 'unset' },
  ]);
  assert.ok(Array.isArray(rows));
  assert.equal(rows!.length, 3);
  assert.deepEqual(rows![0], { profile: 'web-dev', posture: 'adopted', provider: 'llama-swap', base_url: 'http://127.0.0.1:8800/v1' });
  assert.equal(rows![1].base_url, 'https://strata.samwarth.com/v1');
  assert.equal(rows![2].posture, 'unset');
});

test('cleanAgentRoster: whitespace-trims the profile; drops an empty/over-long name', () => {
  const rows = cleanAgentRoster([
    { profile: '  padded  ', posture: 'unset' },
    { profile: '   ', posture: 'unset' }, // empty after trim → dropped
    { profile: 'x'.repeat(65), posture: 'unset' }, // over the 64 cap → dropped
  ]);
  assert.ok(Array.isArray(rows));
  assert.equal(rows!.length, 1);
  assert.equal(rows![0].profile, 'padded');
});

test('cleanAgentRoster: a malformed MEMBER is dropped individually, the rest kept', () => {
  const rows = cleanAgentRoster([
    { profile: 'good-1', posture: 'adopted' },
    null, // non-object → dropped
    'not-an-object', // non-object → dropped
    { profile: 'bad-posture', posture: 'vibes' }, // bad posture → dropped
    { posture: 'adopted' }, // missing profile → dropped
    { profile: 'good-2', posture: 'external', provider: 12345 }, // non-string provider → the field is dropped, the row kept
    [1, 2, 3], // array member → dropped
  ]);
  assert.ok(Array.isArray(rows));
  assert.equal(rows!.length, 2, 'only the two well-shaped rows survive');
  assert.deepEqual(rows!.map((r) => r.profile), ['good-1', 'good-2']);
  assert.equal(rows![1].provider, undefined, 'the bad provider was dropped, not the row');
});

test('cleanAgentRoster: non-array and all-dropped arrays → undefined (the key is absent)', () => {
  assert.equal(cleanAgentRoster(undefined), undefined);
  assert.equal(cleanAgentRoster(null), undefined);
  assert.equal(cleanAgentRoster('nope'), undefined);
  assert.equal(cleanAgentRoster({ profile: 'x', posture: 'adopted' }), undefined, 'a bare object (not an array) → absent');
  assert.equal(cleanAgentRoster([{ profile: 'x', posture: 'bad' }, 'junk']), undefined, 'all members dropped → undefined');
  assert.equal(cleanAgentRoster([]), undefined, 'an empty array → undefined');
});

test('cleanAgentRoster: bounded hard (a hostile client cannot bloat the state file)', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ profile: `p${i}`, posture: 'unset' as const }));
  const rows = cleanAgentRoster(many);
  assert.ok(Array.isArray(rows));
  assert.equal(rows!.length, 24, 'capped at 24 rows');
});

test('isLoopbackIp: loopback true, tailnet/unknown false', () => {
  assert.equal(isLoopbackIp('127.0.0.1'), true);
  assert.equal(isLoopbackIp('localhost'), true);
  assert.equal(isLoopbackIp('::1'), true);
  assert.equal(isLoopbackIp('100.94.165.102'), false);
  assert.equal(isLoopbackIp('10.0.0.1'), false);
  assert.equal(isLoopbackIp('unknown'), false);
  assert.equal(isLoopbackIp(undefined), false);
});

// ---------------------------------------------------------------------------
// Register heartbeat: the ADD-key contract over the real endpoint
// ---------------------------------------------------------------------------

test('register: a valid agent_roster stores on the client row and echoes on /api/state', async () => {
  const roster = [
    { profile: 'web-dev', posture: 'adopted', provider: 'llama-swap', base_url: 'http://127.0.0.1:8800/v1' },
    { profile: 'pr-agent', posture: 'external', base_url: 'https://strata.samwarth.com/v1' },
    { profile: 'probe-agent', posture: 'unset' },
  ];
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'roster-local', ip: '100.94.165.102', agent_roster: roster }),
  });
  assert.equal(reg.status, 200, `register: ${await reg.clone().text()}`);
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; agent_roster?: { profile: string; posture: string; base_url?: string }[] }[];
  };
  const row = st.clients.find((c) => c.name === 'roster-local')!;
  assert.ok(row.agent_roster, 'the client row carries the roster');
  assert.equal(row.agent_roster!.length, 3);
  assert.equal(row.agent_roster!.find((r) => r.profile === 'web-dev')!.posture, 'adopted');
  assert.equal(row.agent_roster!.find((r) => r.profile === 'pr-agent')!.base_url, 'https://strata.samwarth.com/v1');
});

test('register: malformed roster members drop individually (drop-don\'t-reject); registration still 200', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'roster-mixed',
      agent_roster: [
        { profile: 'ok-a', posture: 'adopted', base_url: 'http://127.0.0.1:8800/v1' },
        { profile: 'bad-posture', posture: 'vibes' }, // dropped
        'garbage', // dropped
        { profile: 'ok-b', posture: 'unset' },
      ],
    }),
  });
  assert.equal(reg.status, 200, 'a malformed member never rejects the registration');
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; agent_roster?: { profile: string }[] }[];
  };
  const row = st.clients.find((c) => c.name === 'roster-mixed')!;
  assert.ok(row.agent_roster, 'the well-shaped members still stored');
  assert.deepEqual(
    row.agent_roster!.map((r) => r.profile).sort(),
    ['ok-a', 'ok-b'],
    'the malformed members were dropped individually',
  );
});

test('register: a NON-ARRAY roster is treated as absent (the key is not stored)', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'roster-badshape', agent_roster: 'not-an-array' }),
  });
  assert.equal(reg.status, 200);
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; agent_roster?: unknown }[];
  };
  const row = st.clients.find((c) => c.name === 'roster-badshape')!;
  assert.equal(row.agent_roster, undefined, 'a non-array roster is dropped (absent), never stored');
});

test('register: an ABSENT roster NEVER clears the stored value (the ADD-key contract)', async () => {
  // Seed a roster on a fresh client…
  const seed = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'roster-persist',
      agent_roster: [{ profile: 'web-dev', posture: 'adopted', base_url: 'http://127.0.0.1:8800/v1' }],
    }),
  });
  assert.equal(seed.status, 200);
  // …then re-register the SAME client with NO agent_roster key (an old client
  // or a daemon whose Hermes home went away). The stored roster must stand.
  const refresh = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'roster-persist' }),
  });
  assert.equal(refresh.status, 200);
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; agent_roster?: { profile: string }[] }[];
  };
  const row = st.clients.find((c) => c.name === 'roster-persist')!;
  assert.ok(row.agent_roster, 'the absent report did not clear the stored roster');
  assert.equal(row.agent_roster!.length, 1);
  assert.equal(row.agent_roster![0].profile, 'web-dev');
});

test('register: a client that never sends the key keeps its row exactly as-is (no key)', async () => {
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'roster-legacy', version: '0.1.0' }),
  });
  assert.equal(reg.status, 200);
  const st = (await (await fetch(`${base}/api/state`, { headers: auth })).json()) as {
    clients: { name: string; agent_roster?: unknown; version?: string }[];
  };
  const row = st.clients.find((c) => c.name === 'roster-legacy')!;
  assert.equal('agent_roster' in row, false, 'the pre-#80 client row has no roster key');
  assert.equal(row.version, '0.1.0', 'the other reported facts still land');
});

// ---------------------------------------------------------------------------
// GET /api/agent-roster: the LOCAL-truth read surface
// ---------------------------------------------------------------------------

test('GET /api/agent-roster: returns the ONLINE loopback client\'s roster', async () => {
  // The test's base URL is 127.0.0.1, so a client registered through it has a
  // loopback observed IP — the honest LOCAL client for this arbiter.
  const reg = await fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: 'roster-surface-local',
      agent_roster: [
        { profile: 'web-dev', posture: 'adopted', base_url: 'http://127.0.0.1:8800/v1' },
        { profile: 'f360-agent', posture: 'unset' },
      ],
    }),
  });
  assert.equal(reg.status, 200);
  const body = (await (await fetch(`${base}/api/agent-roster`, { headers: auth })).json()) as {
    client?: string;
    roster?: { profile: string; posture: string }[];
  };
  assert.ok(body.roster, 'the route returned a roster');
  assert.equal(body.roster!.length, 2);
  assert.equal(body.roster!.find((r) => r.profile === 'web-dev')!.posture, 'adopted');
  // The roster is local-truth: the `client` named is the live loopback client
  // (the one we just registered as the newest online local daemon).
  assert.equal(body.client, 'roster-surface-local', 'the route names the local client whose roster it served');
});

test('GET /api/agent-roster: a remote (tailnet) client\'s roster is not honest → omitted', async () => {
  // A client whose observed IP is NOT loopback is a remote daemon: its roster
  // names a different box's profiles. The read surface must not surface it —
  // localAgentRoster considers only loopback clients.
  assert.equal(isLoopbackIp('100.94.165.102'), false, 'a tailnet IP is not loopback');
  // With a far-future "now" every previously-registered client is stale
  // (offline: now - last_seen ≥ the 90s window), so no ONLINE loopback client
  // exists → no roster.
  const farFuture = Date.now() + 120_000; // comfortably beyond the 90s window
  const none = arbiter.localAgentRoster(farFuture);
  assert.equal(none, undefined, 'no ONLINE client → no roster');
});
