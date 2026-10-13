/**
 * hermes-model-access.test.ts — issue #85 slice C, arbiter side: the
 * `hermes_models` + `hermes_model_options` ADD-keys (the gateway's served
 * model list + the per-profile switchable provider catalog).
 *
 * The ADD-keys-only wire invariants (the acceptance list):
 *   - valid stores: clean blocks land on the client row and echo on
 *     /api/state (the clients row — the Models-tab join reads them there);
 *   - drop-don't-poison sanitize: a non-array drops the whole key, each
 *     member checked individually (malformed member dropped, row kept),
 *     rows bounded (64 served / 24 provider rows, 200 stored names), and
 *     hostile EXTRA members (api_url/capabilities/aliases/free_tier,
 *     created/owned_by/parent, an authenticated:false provider) have NO
 *     landing place — the state file never grows an unprojected member;
 *   - absent never clears: an old-shaped register body (no key), or an
 *     all-garbage/non-array block, leaves the stored block exactly as it
 *     was, and a client that never sent the keys keeps a byte-for-byte
 *     pre-#85-C row.
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
import { Arbiter, cleanHermesModels, cleanHermesModelOptions } from '../src/arbiter.js';
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
  dir = mkdtempSync(join(tmpdir(), 'idlefill-85c-server-'));
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

// Live-shaped sanitized blocks as the CLIENT publishes them (slice-C shape).
const MODELS = [
  { profile: 'default', id: 'hermes-agent' },
  { profile: 'web-dev', id: 'hermes-agent-ft', root: 'hermes-agent' },
];
const MODEL_OPTIONS = [
  { profile: 'default', slug: 'openrouter', current: true, authenticated: true, models: ['glm-4.7', 'gpt-5-codex'], models_truncated: true, total_models: 912 },
  { profile: 'default', slug: 'anthropic', authenticated: true, models: ['claude-opus-4-5'] },
  { profile: 'web-dev', slug: 'openai', current: true, models: ['gpt-5.2'] },
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
    clients: { name: string; hermes_models?: Record<string, unknown>[]; hermes_model_options?: Record<string, unknown>[] }[];
  };
}

test('valid stores: both blocks land on the client row and echo on /api/state clients (the Models-tab join)', async () => {
  const reg = await register('model-store-client', { hermes_models: MODELS, hermes_model_options: MODEL_OPTIONS });
  assert.equal(reg.status, 200);
  const st = await state();
  const row = st.clients.find((c) => c.name === 'model-store-client');
  assert.ok(row);
  assert.deepEqual(row.hermes_models, MODELS);
  assert.deepEqual(row.hermes_model_options, MODEL_OPTIONS);
});

test("drop-don't-poison: malformed rows drop individually and hostile EXTRA members have nowhere to land", async () => {
  const poisonModels = [
    'not-a-row',
    null,
    { object: 'model' }, // no usable id ⇒ row dropped whole
    { id: 'ok-1', created: 1, owned_by: 'x', permission: { p: 1 }, parent: 'y', prompt: 'SECRET' }, // decoration has NO landing place
    { id: 'm'.repeat(200) }, // over-cap id ⇒ row dropped (edge posture)
  ];
  const poisonOptions = [
    { slug: 'ok-p', name: 'Display Name', api_url: 'https://evil.example', capabilities: { tools: true }, aliases: { a: 'b' }, free_tier: true, featured_models: ['x'], unavailable_models: ['y'], total_models: 42, models: ['good', 42, '', 'i'.repeat(200), 'keeper'], current: true, authenticated: true },
    { slug: 'p'.repeat(200) }, // slug over cap ⇒ row dropped
    { name: 'no slug' }, // no usable slug ⇒ row dropped
    { slug: 'unauth', authenticated: false, models: ['whatever'] }, // rides as a row with authenticated:false (the CLIENT drops these before they arrive; the arbiter has no authority to re-drop silently — it stores the honest flag)
    { slug: 'nums', current: 'yes', authenticated: 1, total_models: -5, models_truncated: 'yes' }, // non-exact members drop individually
  ];
  const reg = await register('model-poison-client', { hermes_models: poisonModels, hermes_model_options: poisonOptions });
  assert.equal(reg.status, 200, 'a malformed block is never a rejection');
  const st = await state();
  const row = st.clients.find((c) => c.name === 'model-poison-client');
  assert.ok(row?.hermes_models && row?.hermes_model_options);
  assert.deepEqual(row!.hermes_models!.map((r) => r.id), ['ok-1'], 'nameless/over-long rows drop whole');
  const m1 = row!.hermes_models![0];
  for (const forbidden of ['created', 'owned_by', 'permission', 'parent', 'prompt', 'SECRET']) {
    assert.ok(!(forbidden in m1), `the stored served-model row carries no ${forbidden} member`);
  }
  const opts = row!.hermes_model_options!;
  assert.deepEqual(opts.map((r) => r.slug), ['ok-p', 'unauth', 'nums']);
  const p1 = opts[0];
  for (const forbidden of ['name', 'api_url', 'capabilities', 'aliases', 'free_tier', 'featured_models', 'unavailable_models', 'Display', 'evil.example']) {
    assert.ok(!(forbidden in p1), `the stored provider row carries no ${forbidden} member (pricing/endpoint/config bait has nowhere to land)`);
  }
  assert.deepEqual(p1.models, ['good', 'keeper'], 'bad name entries drop individually; the over-cap one drops (never truncated-and-kept)');
  assert.equal(p1.total_models, 42, 'a sane count rides verbatim');
  const p3 = opts[2];
  assert.equal(p3.current, undefined, 'non-boolean current dropped');
  assert.equal(p3.authenticated, undefined, 'non-boolean authenticated dropped');
  assert.equal(p3.total_models, undefined, 'a negative count dropped');
  assert.equal(p3.models_truncated, undefined, 'non-boolean truncated dropped');
});

test('absent never clears + old shape stays byte-for-byte: a keyless register leaves stored rows untouched', async () => {
  await register('model-old-client'); // never carries the keys at all
  let st = await state();
  let row = st.clients.find((c) => c.name === 'model-old-client')!;
  const before = JSON.stringify(row);
  assert.ok(!('hermes_models' in row) && !('hermes_model_options' in row), 'a client that never sent the keys has a byte-for-byte pre-#85-C row');
  await register('model-old-client');
  st = await state();
  row = st.clients.find((c) => c.name === 'model-old-client')!;
  assert.equal(JSON.stringify({ ...row, last_seen: 0 }), JSON.stringify({ ...JSON.parse(before), last_seen: 0 }), 'the row is byte-for-byte unchanged by keyless heartbeats');

  await register('model-holdout', { hermes_models: MODELS, hermes_model_options: MODEL_OPTIONS });
  st = await state();
  assert.equal((st.clients.find((c) => c.name === 'model-holdout')!.hermes_model_options ?? []).length, 3);
  await register('model-holdout'); // old-shaped heartbeat (gateway outage / pre-#85-C restart)
  st = await state();
  assert.equal((st.clients.find((c) => c.name === 'model-holdout')!.hermes_model_options ?? []).length, 3, 'absent NEVER clears the stored block');
  await register('model-holdout', { hermes_models: 'nope' as never, hermes_model_options: { nope: true } as never });
  st = await state();
  assert.equal((st.clients.find((c) => c.name === 'model-holdout')!.hermes_models ?? []).length, 2, 'a malformed non-array block never clears either');
  await register('model-holdout', { hermes_models: [{ no_id: 1 }, 7, null] });
  st = await state();
  assert.equal((st.clients.find((c) => c.name === 'model-holdout')!.hermes_models ?? []).length, 2, 'an all-dropped array never clears the stored block');
});

test('cleanHermesModels/cleanHermesModelOptions units: caps (64 rows, 24 provider rows, per-member strings/names), non-array → undefined, all-dropped → undefined', () => {
  assert.equal(cleanHermesModels(undefined), undefined);
  assert.equal(cleanHermesModels('nope'), undefined);
  assert.equal(cleanHermesModels([]), undefined);
  assert.equal(cleanHermesModels([{ bad: 1 }, 'x']), undefined, 'all-dropped ⇒ absent (never an empty list stored)');
  const many = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` }));
  assert.equal(cleanHermesModels(many)!.length, 64, 'bounded hard at 64 served rows');
  const manyProviders = Array.from({ length: 40 }, (_, i) => ({ slug: `p${i}`, models: [`n${i}`] }));
  assert.equal(cleanHermesModelOptions(manyProviders)!.length, 24, 'bounded hard at 24 provider rows');
  const mixed = cleanHermesModels([
    { id: '  spaced  ', root: '  root ' },
    { id: 'x'.repeat(129) }, // id over cap ⇒ row dropped
    { id: 'ok', root: 'r'.repeat(128) }, // exact cap stands
    { id: 'edge', root: 'r'.repeat(129) }, // one over ⇒ member dropped, row kept
  ])!;
  assert.deepEqual(mixed.map((r) => r.id), ['spaced', 'ok', 'edge'], 'ids trimmed; over-long id dropped; over-cap root drops the MEMBER only');
  assert.equal(mixed[0].root, 'root', 'members trimmed');
  assert.ok(mixed[1].root);
  assert.equal(mixed[2].root, undefined);
  // The stored-name budget: 24 per provider AND 200 per client row total.
  const fat = cleanHermesModelOptions(
    Array.from({ length: 24 }, (_, i) => ({ slug: `p${i}`, models: Array.from({ length: 40 }, (_, j) => `n${i}-${j}`) })),
  )!;
  const storedNames = fat.reduce((n, r) => n + (r.models?.length ?? 0), 0);
  assert.equal(storedNames, 200, 'the stored name budget (200 per client row) is consumed EXACTLY then stops');
  assert.ok(fat.every((r) => (r.models?.length ?? 0) <= 24), 'per-provider cap holds at the edge too');
});
