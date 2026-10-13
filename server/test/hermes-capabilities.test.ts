/**
 * hermes-capabilities.test.ts — issue #85 slice B, arbiter side: the
 * `hermes_skills` + `hermes_toolsets` ADD-keys (the gateway's per-profile
 * capability inventory — skills rows are the source-pinned
 * `{name, description, category}`, toolsets rows name + the exact
 * enabled/configured booleans).
 *
 * The ADD-keys-only wire invariants (the acceptance list):
 *   - valid stores: clean blocks land on the client row and echo on
 *     /api/state (the clients row — the Models/Agents-side join), and the
 *     enriched GET /api/agent-roster ride carries them for the Agents tab;
 *   - drop-don't-poison sanitize: a non-array drops the whole key, each
 *     member checked individually (malformed member dropped, row kept), rows
 *     bounded at 200, hostile EXTRA members (toolset label/description/tools,
 *     skill enabled/configured/prompt) have NO landing place — the state file
 *     never grows an unprojected member;
 *   - absent never clears: an old-shaped register body (no key), or an
 *     all-garbage/non-array block, leaves the stored block exactly as it was,
 *     and a client that never sent the key keeps a byte-for-byte pre-#85-B
 *     row (no `hermes_skills`/`hermes_toolsets` key at all).
 *
 * End-to-end through the REAL Fastify app on an ephemeral loopback port (the
 * hermes-jobs.test.ts harness pattern) — no network beyond loopback.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApi, attachWebSocket } from '../src/api.js';
import { Arbiter, cleanHermesSkills, cleanHermesToolsets } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import type { ServerConfig } from '../src/types.js';

const TOKEN = 'test-token-123';
const T0 = Date.parse('2026-09-25T12:00:00Z');

let dir: string;
let cfg: ServerConfig;
let app: ReturnType<typeof buildApi>;
let arbiter: Arbiter;
let base: string;
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-85b-server-'));
  cfg = {
    listen: 0,
    api_tokens: [TOKEN],
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    log_glob: '',
    idle_seconds: 300,
    poll_ms: 60_000, // tests drive ticks manually
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
  arbiter = new Arbiter(store, cfg, {
    poll: async () => ({
      now: T0,
      idle: true,
      idle_for_s: 600,
      last_activity: null,
      last_log_write: null,
      signal_degraded: false,
      degraded_reason: null,
    }),
    signal: () => null,
  } as never);
  app = buildApi({ arbiter, cfg, publicDir: join(dir, 'public') });
  attachWebSocket(app, arbiter, cfg);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

// Live-shaped sanitized blocks as the CLIENT publishes them (slice-B shape).
const SKILLS = [
  { profile: 'default', name: 'orchestration', description: 'Coordinate supervised workers: DAGs, gates, loops.', category: 'agents' },
  { profile: 'web-dev', name: 'shadcn', description: 'Manages components and projects.', category: 'ui' },
];
const TOOLSETS = [
  { profile: 'default', name: 'web', enabled: true, configured: true },
  { profile: 'default', name: 'video_gen', enabled: false, configured: true },
  { profile: 'web-dev', name: 'terminal', enabled: true, configured: false },
];

const ROSTER = [
  { profile: 'default', posture: 'adopted' },
  { profile: 'web-dev', posture: 'external' },
];

async function register(name: string, extra: Record<string, unknown> = {}) {
  return fetch(`${base}/api/clients/register`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name,
      projects: [{ name: 'career-ops', model: 'm', estimated_seconds: 100, queue_depth: 0 }],
      ...extra,
    }),
  });
}

async function state() {
  const res = await fetch(`${base}/api/state?limit=10&token=${TOKEN}`);
  return (await res.json()) as {
    clients: { name: string; hermes_skills?: Record<string, unknown>[]; hermes_toolsets?: Record<string, unknown>[] }[];
  };
}

async function rosterRoute() {
  const res = await fetch(`${base}/api/agent-roster?token=${TOKEN}`);
  return (await res.json()) as {
    client?: string;
    roster?: Record<string, unknown>[];
    skills?: Record<string, unknown>[];
    toolsets?: Record<string, unknown>[];
  };
}

test('valid stores: both blocks land on the client row and echo on /api/state clients', async () => {
  const reg = await register('cap-store-client', { hermes_skills: SKILLS, hermes_toolsets: TOOLSETS });
  assert.equal(reg.status, 200);
  const st = await state();
  const row = st.clients.find((c) => c.name === 'cap-store-client');
  assert.ok(row);
  assert.deepEqual(row.hermes_skills, SKILLS);
  assert.deepEqual(row.hermes_toolsets, TOOLSETS);
});

test("drop-don't-poison: malformed rows drop individually and hostile EXTRA members have nowhere to land", async () => {
  const poisonSkills = [
    'not-a-row',
    null,
    { description: 'no name' }, // name missing ⇒ row dropped whole
    { name: 'ok-1', enabled: true, configured: true, prompt: 'PRIVATE NEVER STORES', instructions: 'SECRET' },
    { name: 'x'.repeat(200), description: 'd'.repeat(300) }, // over-long name ⇒ row dropped whole (edge posture)
    { name: 'ok-2', description: 'd'.repeat(300), category: 'c'.repeat(200) }, // over-cap MEMBERS drop, row stands
  ];
  const poisonToolsets = [
    { name: 'ok-t', label: '🔍 Decoration', description: 'web_search, web_extract', tools: ['web_search'], enabled: true, configured: true },
    { name: 't'.repeat(200) }, // name over cap ⇒ row dropped
    { name: 'bits', enabled: 'yes', configured: 1 }, // non-boolean bits dropped individually
  ];
  const reg = await register('cap-poison-client', { hermes_skills: poisonSkills, hermes_toolsets: poisonToolsets });
  assert.equal(reg.status, 200, 'a malformed block is never a rejection');
  const st = await state();
  const row = st.clients.find((c) => c.name === 'cap-poison-client');
  assert.ok(row?.hermes_skills && row?.hermes_toolsets);
  assert.deepEqual(row!.hermes_skills!.map((r) => r.name), ['ok-1', 'ok-2'], 'nameless/over-long-name rows drop whole; member failures drop just the member');
  const s1 = row!.hermes_skills![0];
  assert.equal(s1.name, 'ok-1');
  for (const forbidden of ['enabled', 'configured', 'prompt', 'instructions', 'PRIVATE', 'SECRET']) {
    assert.ok(!(forbidden in s1), `the stored skill row carries no ${forbidden} member (toolset-only bits + hostile members have NO landing place)`);
  }
  const s2 = row!.hermes_skills![1];
  assert.equal(s2.description, undefined, 'an over-cap description is DROPPED at the arbiter edge (never truncated-and-kept into the state file)');
  assert.equal(s2.category, undefined, 'an over-cap category is dropped');
  const t1 = row!.hermes_toolsets![0];
  assert.equal(t1.name, 'ok-t');
  for (const forbidden of ['label', 'description', 'tools', 'web_search', 'Scraping', '🔍']) {
    assert.ok(!(forbidden in t1), `the stored toolset row carries no ${forbidden} member (decoration/duplication has nowhere to land)`);
  }
  assert.equal(t1.enabled, true, 'the exact boolean stands');
  const t2 = row!.hermes_toolsets![1];
  assert.equal(t2.enabled, undefined, 'non-boolean enabled dropped');
  assert.equal(t2.configured, undefined, 'non-boolean configured dropped');
});

test('absent never clears + old shape stays byte-for-byte: a keyless register leaves stored rows untouched', async () => {
  await register('cap-old-client'); // never carries the keys at all
  let st = await state();
  let row = st.clients.find((c) => c.name === 'cap-old-client')!;
  const before = JSON.stringify(row);
  assert.ok(!('hermes_skills' in row) && !('hermes_toolsets' in row), 'a client that never sent the keys has a byte-for-byte pre-#85-B row');
  await register('cap-old-client');
  st = await state();
  row = st.clients.find((c) => c.name === 'cap-old-client')!;
  assert.equal(JSON.stringify({ ...row, last_seen: 0 }), JSON.stringify({ ...JSON.parse(before), last_seen: 0 }), 'the row is byte-for-byte unchanged by keyless heartbeats');

  await register('cap-holdout', { hermes_skills: SKILLS, hermes_toolsets: TOOLSETS });
  st = await state();
  assert.equal((st.clients.find((c) => c.name === 'cap-holdout')!.hermes_toolsets ?? []).length, 3);
  await register('cap-holdout'); // old-shaped heartbeat (gateway outage / pre-#85-B restart)
  st = await state();
  assert.equal((st.clients.find((c) => c.name === 'cap-holdout')!.hermes_toolsets ?? []).length, 3, 'absent NEVER clears the stored block');
  await register('cap-holdout', { hermes_skills: 'nope' as never, hermes_toolsets: { nope: true } as never });
  st = await state();
  assert.equal((st.clients.find((c) => c.name === 'cap-holdout')!.hermes_skills ?? []).length, 2, 'a malformed non-array block never clears either');
  await register('cap-holdout', { hermes_skills: [{ no_name: 1 }, 7, null] });
  st = await state();
  assert.equal((st.clients.find((c) => c.name === 'cap-holdout')!.hermes_skills ?? []).length, 2, 'an all-dropped array never clears the stored block');
});

test('cleanHermesSkills/cleanHermesToolsets units: caps (200 rows, per-member strings), non-array → undefined, all-dropped → undefined', () => {
  assert.equal(cleanHermesSkills(undefined), undefined);
  assert.equal(cleanHermesSkills('nope'), undefined);
  assert.equal(cleanHermesSkills([]), undefined);
  assert.equal(cleanHermesSkills([{ bad: 1 }, 'x']), undefined, 'all-dropped ⇒ absent (never an empty list stored)');
  const many = Array.from({ length: 250 }, (_, i) => ({ name: `s${i}` }));
  assert.equal(cleanHermesSkills(many)!.length, 200, 'bounded hard at 200 rows');
  assert.equal(cleanHermesToolsets(many.map((s) => ({ name: s.name })))!.length, 200);
  const mixed = cleanHermesSkills([
    { name: '  spaced  ', category: ' agents ' },
    { name: 'x'.repeat(129) }, // name over cap ⇒ row dropped
    { name: 'ok', description: 'd'.repeat(256) }, // exact cap stands
    { name: 'edge', description: 'd'.repeat(257) }, // one over ⇒ member dropped, row kept
  ])!;
  assert.deepEqual(mixed.map((r) => r.name), ['spaced', 'ok', 'edge'], 'names trimmed; over-long name dropped; over-cap description drops the MEMBER only');
  assert.equal(mixed[0].category, 'agents', 'members trimmed');
  assert.ok(mixed[1].description);
  assert.equal(mixed[2].description, undefined);
});

test('the roster route carries the capability blocks (Agents-tab join) — ADD-keys only', async () => {
  // An ONLINE loopback client (registering from 127.0.0.1) with a roster AND
  // capability blocks: the route enriches.
  await register('cap-local-daemon', { agent_roster: ROSTER, hermes_skills: SKILLS, hermes_toolsets: TOOLSETS });
  const r = await rosterRoute();
  assert.equal(r.client, 'cap-local-daemon');
  assert.equal(r.roster?.length, 2);
  assert.equal(r.skills?.length, 2, 'the skills ADD-key rides the roster read');
  assert.equal(r.toolsets?.length, 3, 'the toolsets ADD-key rides the roster read');

  // A client with a roster but NO capability blocks: the route omits the keys
  // (never empty arrays).
  await register('cap-roster-only', { agent_roster: [{ profile: 'flash', posture: 'unset' }] });
  // cap-local-daemon was registered earlier; the route picks the NEWEST
  // online loopback client with a roster — register local again so it wins.
  await register('cap-local-daemon', { agent_roster: ROSTER }); // heartbeat WITHOUT the capability keys (they stand stored)
  const r2 = await rosterRoute();
  assert.equal(r2.client, 'cap-local-daemon');
  assert.equal(r2.roster?.length, 2);
  assert.ok(r2.skills && r2.toolsets, 'the STORED blocks ride on (absent this heartbeat, never cleared)');
});
