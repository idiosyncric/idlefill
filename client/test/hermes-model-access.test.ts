/**
 * hermes-model-access.test.ts — issue #85 slice C: HERMES MODEL ACCESS
 * (`GET /v1/models` — what the gateway SERVES — + `GET /api/model/options?
 * include_unconfigured=false` — what each profile could SWITCH TO). READ-ONLY:
 * the connector makes only GETs — no model set/switch verb exists in this
 * surface.
 *
 * Suites:
 *   1. The sanitizers against the LIVE-VERIFIED gateway shapes pinned at build
 *      against the running gateway (see docs/reports/
 *      ISSUE85-MODELOPTIONS-SLICE-C.md): the models envelope `{object:'list',
 *      data:[{id,object,created,owned_by,permission,root,parent}]}` (200
 *      live); the options envelope `{model,provider,providers:[{slug,name,
 *      is_current,is_user_defined,models,total_models,source,api_url,
 *      native_catalog_empty,authenticated,free_tier,pricing_pending,
 *      unavailable_models,capabilities,featured_models,aliases}]}` (200 live,
 *      56 providers unfiltered / 7 with the query filter). Projection only:
 *      served rows keep id (+ optional root); provider rows keep slug + the
 *      exact current/authenticated booleans + a bounded first slice of model
 *      NAMES + a sane total_models — the pricing/endpoint/config detail NEVER
 *      publishes, and a definitively unauthenticated provider drops whole.
 *   2. The connector against a FAKE gateway: per-profile paths + the query
 *      filter + per-profile keys; ONE bounded GET per surface per profile per
 *      round (cadence); unkeyed ⇒ ZERO requests; down ⇒ ZERO; 401/500/
 *      malformed ⇒ last-known stands; a 200 replaces; provider caps (24/48),
 *      per-provider name cap (24 + models_truncated), per-profile name budget
 *      (200); poison records drop individually.
 *   3. Daemon-level ADD-keys-only wire invariant (real ClientDaemon + fake
 *      arbiter): connector off ⇒ the register body NEVER carries
 *      `hermes_models`/`hermes_model_options`; connector on ⇒ they ride under
 *      exactly those keys (never bare — the pricing bait members are scanned
 *      absent on the wire).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HermesGatewayConnector,
  resolveHermesGatewayConfig,
  modelsPath,
  modelOptionsPath,
  sanitizeHermesModel,
  sanitizeHermesModelProvider,
  MODELS_MAX_PER_PROFILE,
  MODELS_MAX_TOTAL,
  MODEL_OPTIONS_MAX_PER_PROFILE,
  MODEL_OPTIONS_MAX_TOTAL,
  MODEL_NAMES_PER_PROVIDER,
  MODEL_NAMES_MAX_PER_PROFILE,
  MODEL_ID_CAP,
  type HermesModelRow,
  type HermesModelProviderRow,
} from '../src/hermes-gateway.js';

const here = dirname(fileURLToPath(import.meta.url));
const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

// ---------------------------------------------------------------------------
// The live-verified rows (shape pinned by the build-time curl evidence in the
// slice-C report — the key value NEVER pasted). The options provider is the
// full live member set: the sanitizer's projection surface is exactly the
// gap between this row and the published row.
// ---------------------------------------------------------------------------

const LIVE_MODEL_ENTRY = {
  id: 'hermes-agent',
  object: 'model',
  created: 1_700_00_00_00,
  owned_by: 'hermes',
  permission: {},
  root: null,
  parent: null,
};

const fineTuneEntry = {
  id: 'hermes-agent-ft',
  object: 'model',
  created: 1_700_00_00_00,
  owned_by: 'hermes',
  permission: {},
  root: 'hermes-agent',
  parent: 'hermes-agent',
};

const liveProvider = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  name: `Display ${slug}`,
  is_current: slug === 'openrouter',
  is_user_defined: false,
  models: Array.from({ length: 40 }, (_, i) => `${slug}/model-${i}`),
  total_models: 912,
  source: 'native',
  api_url: 'https://openrouter.example/api/v1',
  native_catalog_empty: false,
  authenticated: true,
  free_tier: false,
  pricing_pending: false,
  unavailable_models: ['hidden-model'],
  capabilities: { tools: true, vision: false },
  featured_models: ['featured-one'],
  aliases: { 'short-name': `${slug}/model-0` },
  ...over,
});

// ---------------------------------------------------------------------------
// Suite 1: the sanitizers
// ---------------------------------------------------------------------------

test('sanitizeHermesModel: live entry → id (+root when a string); OpenAI-compat decoration NEVER published', () => {
  const row = sanitizeHermesModel(LIVE_MODEL_ENTRY, 'default');
  assert.ok(row);
  assert.deepEqual(row, { id: 'hermes-agent', profile: 'default' }, 'a null root stays ABSENT (never a fake empty)');
  const ft = sanitizeHermesModel(fineTuneEntry, 'web-dev')!;
  assert.equal(ft.root, 'hermes-agent', 'a string root rides (the upstream a derived model names)');
  assert.equal(ft.profile, 'web-dev');
  const wire = JSON.stringify(row);
  for (const forbidden of ['created', 'owned_by', 'permission', 'parent', 'object']) {
    assert.ok(!wire.includes(forbidden), `the decoration member ${forbidden} never lands on the wire`);
  }
  assert.equal(sanitizeHermesModel({ object: 'model' }, 'default'), undefined, 'no usable id ⇒ dropped whole');
  const long = sanitizeHermesModel({ id: 'm'.repeat(200), root: 'r'.repeat(200) }, 'p'.repeat(200))!;
  assert.equal(long.id.length, MODEL_ID_CAP);
  assert.equal(long.root?.length, MODEL_ID_CAP);
  assert.equal(long.profile?.length, 64);
});

test('sanitizeHermesModelProvider: live provider → slug/current/authenticated/≤24 names/truncated/total ONLY (name + pricing/endpoint/config bait NEVER published)', () => {
  const row = sanitizeHermesModelProvider(liveProvider('openrouter'), 'default');
  assert.ok(row);
  assert.equal(row.slug, 'openrouter');
  assert.equal(row.current, true);
  assert.equal(row.authenticated, true);
  assert.equal(row.models?.length, MODEL_NAMES_PER_PROVIDER);
  assert.equal(row.models?.[0], 'openrouter/model-0');
  assert.equal(row.models_truncated, true, 'the real list was longer than the cap — honest marker');
  assert.equal(row.total_models, 912);
  const wire = JSON.stringify(row);
  // The bait: display decoration + pricing/endpoint/config detail the issue
  // names as NEVER-published.
  for (const forbidden of ['Display ', 'api_url', 'openrouter.example', 'capabilities', 'aliases', 'free_tier', 'pricing_pending', 'featured', 'hidden-model', 'unavailable', 'native_catalog_empty', 'is_user_defined', 'source', 'short-name']) {
    assert.ok(!wire.includes(forbidden), `the bait member ${forbidden} never lands on the wire`);
  }
});

test('sanitizeHermesModelProvider: authenticated:false DROPS the provider whole (cannot serve ⇒ no row); exact booleans only; caps + drop rules', () => {
  assert.equal(sanitizeHermesModelProvider(liveProvider('xai', { authenticated: false }), 'default'), undefined, 'a definitively unauthenticated provider publishes NOTHING');
  assert.ok(sanitizeHermesModelProvider(liveProvider('xai', { authenticated: undefined }), 'default'), 'an ABSENT authenticated bit is unknown, not false — the row stands');
  const noBool = sanitizeHermesModelProvider({ slug: 's', is_current: 'yes', authenticated: 1, total_models: -4 }, 'default')!;
  assert.equal(noBool.current, undefined, 'non-boolean current drops (exact-boolean rule)');
  assert.equal(noBool.authenticated, undefined);
  assert.equal(noBool.total_models, undefined, 'a negative count is not sane — dropped');
  assert.ok(sanitizeHermesModelProvider({ slug: 's', total_models: 9_999 }, 'default')?.total_models === 9_999, 'a sane count rides');
  assert.equal(sanitizeHermesModelProvider({ name: 'no slug' }, 'default'), undefined, 'no usable slug ⇒ dropped whole');
  assert.ok(!sanitizeHermesModelProvider({ slug: 's', models: ['ok', 42, '', { evil: true }] }, 'default')?.models?.includes('42'), 'bad model entries drop individually');
  const long = sanitizeHermesModelProvider({ slug: 'z'.repeat(200), models: ['m'.repeat(200), 'keeper'] }, 'p'.repeat(200))!;
  assert.equal(long.slug.length, 64);
  assert.equal(long.models?.[0]?.length, 128);
});

test('modelsPath/modelOptionsPath: default = home listener, a named profile = the /p/<profile> mirror; the options query asks the gateway to filter (verified live: 7/56 providers)', () => {
  assert.equal(modelsPath('default'), '/v1/models');
  assert.equal(modelsPath('web-dev'), '/p/web-dev/v1/models');
  assert.equal(modelOptionsPath('default'), '/api/model/options?include_unconfigured=false');
  assert.equal(modelOptionsPath('a b'), '/p/a%20b/api/model/options?include_unconfigured=false');
});

// ---------------------------------------------------------------------------
// Suite 2: the connector against a fake gateway
// ---------------------------------------------------------------------------

interface McOpts {
  healthUp?: boolean;
  /** profile → current served entries. */
  models: Record<string, unknown[]>;
  /** profile → current provider rows. */
  providers: Record<string, unknown[]>;
  expectKeys?: Record<string, string>;
  modelsBroken?: string[];
  optionsBroken?: string[];
  /** profiles answering 200 with a body missing the `providers` array. */
  garbage?: string[];
  deny?: string[];
}

interface McGateway {
  base: string;
  opts: McOpts;
  requests: { path: string; query: string; auth: string }[];
  close: () => Promise<void>;
}

function startMcGateway(opts: McOpts): Promise<McGateway> {
  const requests: { path: string; query: string; auth: string }[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push({ path: url.pathname, query: url.search, auth: req.headers.authorization ?? '' });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/v1/health' || /^\/p\/[^/]+\/v1\/health$/.test(url.pathname)) {
      if (opts.healthUp === false) return send(500, { status: 'err' });
      return send(200, { status: 'ok', version: '0.21.7' });
    }
    const surf = url.pathname.match(/^\/(?:p\/([^/]+)\/)?(v1\/models|api\/model\/options)$/);
    if (req.method === 'GET' && surf) {
      const profile = surf[1] ?? 'default';
      const isOptions = surf[2] === 'api/model/options';
      if (opts.deny?.includes(profile)) return send(401, { error: { code: 'gateway_auth_failed' } });
      const expected = opts.expectKeys?.[profile];
      if (opts.expectKeys && !expected) return send(401, { error: { code: 'gateway_auth_failed' } });
      if (expected && (req.headers.authorization ?? '') !== `Bearer ${expected}`) return send(401, { error: { code: 'gateway_auth_failed' } });
      if (isOptions && url.searchParams.get('include_unconfigured') !== 'false') {
        return send(400, { error: { message: 'the test gateway requires the honest query filter' } });
      }
      if (opts.garbage?.includes(profile)) return send(200, isOptions ? { model: null } : { data: 'not-an-array' });
      if (isOptions && opts.optionsBroken?.includes(profile)) return send(500, { error: { message: 'Failed to enumerate model options', type: 'server_error' } });
      if (!isOptions && opts.modelsBroken?.includes(profile)) return send(500, { error: { message: 'Failed to list models', type: 'server_error' } });
      if (isOptions) return send(200, { model: 'hermes-agent', provider: 'openrouter', providers: opts.providers[profile] ?? [] });
      return send(200, { object: 'list', data: opts.models[profile] ?? [] });
    }
    // Everything else (ledger, jobs, skills/toolsets) answers the empty posture.
    return send(200, { object: 'list', data: [], limit: 200, offset: 0, has_more: false, jobs: [] });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        opts,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function gwCfg(base: string, over: Partial<ReturnType<typeof resolveHermesGatewayConfig>> = {}): ReturnType<typeof resolveHermesGatewayConfig> {
  return {
    enabled: true,
    base_url: base,
    profiles: ['default', 'web-dev'],
    key: 'default-key',
    profileKeys: new Map([['web-dev', 'profile-key']]),
    poll_seconds: 30,
    timeout_ms: 500,
    key_file: '/dev/null',
    ...over,
  };
}

const modelReqs = (gw: McGateway) => gw.requests.filter((r) => r.path === '/v1/models' || r.path.endsWith('/v1/models'));
const optionsReqs = (gw: McGateway) => gw.requests.filter((r) => r.path === '/api/model/options' || r.path.endsWith('/api/model/options'));

test('connector: ONE bounded GET per surface per keyed profile per round — paths + query filter + per-profile keys, snapshots merged', async () => {
  const gw = await startMcGateway({
    models: { default: [LIVE_MODEL_ENTRY], 'web-dev': [fineTuneEntry] },
    providers: {
      default: [liveProvider('openrouter'), liveProvider('anthropic', { is_current: false, total_models: 42 })],
      'web-dev': [liveProvider('openrouter', { is_current: false, authenticated: false }), liveProvider('openai', { is_current: true })],
    },
    expectKeys: { default: 'default-key', 'web-dev': 'profile-key' },
  });
  cleanup.push(() => gw.close());
  const c = new HermesGatewayConnector(gwCfg(gw.base));
  // Pre-first-round: NOTHING published.
  assert.equal(c.modelsSnapshot(), undefined);
  assert.equal(c.modelOptionsSnapshot(), undefined);
  await c.poll();
  const models = c.modelsSnapshot();
  const options = c.modelOptionsSnapshot();
  assert.ok(models && options);
  assert.deepEqual(models.map((r) => r.id), ['hermes-agent', 'hermes-agent-ft'], 'config-order profile attribution');
  assert.deepEqual(new Set(options.map((r) => r.profile)), new Set(['default', 'web-dev']));
  assert.equal(options.find((r) => r.profile === 'web-dev' && r.slug === 'openai')?.current, true, 'the profile switch vocabulary attributes per profile');
  assert.ok(!options.some((r) => r.profile === 'web-dev' && r.slug === 'openrouter'), 'the web-dev openrouter row reports authenticated:false ⇒ DROPS whole (cannot serve)');
  // Second poll in the same instant is cadence-gated: at most one GET per
  // surface per profile per CONNECTOR ROUND.
  await c.poll();
  assert.equal(modelReqs(gw).length, 2, 'ONE /v1/models GET per profile per round');
  assert.equal(optionsReqs(gw).length, 2, 'ONE /api/model/options GET per profile per round');
  assert.ok(optionsReqs(gw).every((r) => r.query.includes('include_unconfigured=false')), 'the query filter rides on EVERY options request (the gateway filters unconfigured itself)');
  assert.equal(modelReqs(gw).find((r) => r.path === '/v1/models')?.auth, 'Bearer default-key');
  assert.equal(optionsReqs(gw).find((r) => r.path === '/p/web-dev/api/model/options')?.auth, 'Bearer profile-key', 'per-profile key discipline');
});

test('connector: unkeyed profile ⇒ ZERO model-access requests', async () => {
  const gw = await startMcGateway({
    models: { default: [LIVE_MODEL_ENTRY], 'web-dev': [fineTuneEntry] },
    providers: { default: [liveProvider('openrouter')], 'web-dev': [liveProvider('secret-provider')] },
  });
  cleanup.push(() => gw.close());
  const c = new HermesGatewayConnector(gwCfg(gw.base, { profileKeys: new Map() }));
  await c.poll();
  assert.ok(c.modelsSnapshot()?.some((r) => r.id === 'hermes-agent'));
  assert.equal(modelReqs(gw).filter((r) => r.path === '/p/web-dev/v1/models').length, 0, 'no request to an unkeyed profile');
  assert.equal(optionsReqs(gw).filter((r) => r.path === '/p/web-dev/api/model/options').length, 0);
  assert.ok(!c.modelOptionsSnapshot()?.some((r) => r.slug === 'secret-provider'), 'the unkeyed profile publishes nothing');
});

test('connector: down ⇒ ZERO model-access requests; 401/500/malformed rounds stand last-known; a 200 REPLACES', async () => {
  const gw = await startMcGateway({
    healthUp: false,
    models: { default: [LIVE_MODEL_ENTRY] },
    providers: { default: [liveProvider('openrouter')] },
  });
  cleanup.push(() => gw.close());
  const down = new HermesGatewayConnector(gwCfg(gw.base, { profiles: ['default'] }));
  await down.poll();
  assert.equal(modelReqs(gw).length + optionsReqs(gw).length, 0, 'a down gateway sees NO extra model-access request — byte-for-byte zero');
  assert.equal(down.modelsSnapshot(), undefined);

  const gw2 = await startMcGateway({
    models: { default: [LIVE_MODEL_ENTRY] },
    providers: { default: [liveProvider('keep'), liveProvider('gone')] },
    expectKeys: { default: 'default-key' },
  });
  cleanup.push(() => gw2.close());
  let t = 0;
  const c = new HermesGatewayConnector(gwCfg(gw2.base, { profiles: ['default'] }), { now: () => (t += 60_000) });
  await c.poll(); // round 1
  assert.deepEqual(c.modelOptionsSnapshot()?.map((r) => r.slug), ['keep', 'gone']);
  gw2.opts.modelsBroken = ['default'];
  gw2.opts.optionsBroken = ['default'];
  await c.poll(); // round 2: 500s ⇒ last-known stands
  assert.deepEqual(c.modelOptionsSnapshot()?.map((r) => r.slug), ['keep', 'gone'], 'a 500 round never clears the strip');
  assert.deepEqual(c.modelsSnapshot()?.map((r) => r.id), ['hermes-agent']);
  gw2.opts.modelsBroken = undefined;
  gw2.opts.optionsBroken = undefined;
  gw2.opts.deny = ['default'];
  await c.poll(); // round 3: 401 ⇒ last-known stands
  assert.deepEqual(c.modelsSnapshot()?.map((r) => r.id), ['hermes-agent'], 'a 401 round never clears served models either');
  gw2.opts.deny = undefined;
  gw2.opts.garbage = ['default'];
  await c.poll(); // round 4: malformed envelope ⇒ last-known stands
  assert.deepEqual(c.modelOptionsSnapshot()?.map((r) => r.slug), ['keep', 'gone']);
  gw2.opts.garbage = undefined;
  gw2.opts.providers.default = [liveProvider('keep')];
  await c.poll(); // round 5: complete truth replaces ⇒ `gone` is GONE
  assert.deepEqual(c.modelOptionsSnapshot()?.map((r) => r.slug), ['keep'], 'the answering round replaces (a vanished provider leaves in one round)');
  gw2.opts.providers.default = [];
  gw2.opts.models.default = [];
  await c.poll(); // round 6: empty answer ⇒ publish NOTHING (absent, never a [] dump)
  assert.equal(c.modelOptionsSnapshot(), undefined);
  assert.equal(c.modelsSnapshot(), undefined);
});

test('connector: count caps — 24 providers/profile, 48 published total, 24 names/provider (+truncated), 200 names/profile budget', async () => {
  const manyProviders = Array.from({ length: 40 }, (_, i) => liveProvider(`p${i}`, { is_current: i === 0, total_models: 10 }));
  const gw = await startMcGateway({
    models: { default: Array.from({ length: 80 }, (_, i) => ({ id: `m${i}` })), 'web-dev': Array.from({ length: 80 }, (_, i) => ({ id: `w${i}` })) },
    providers: { default: manyProviders, 'web-dev': manyProviders },
    expectKeys: { default: 'default-key', 'web-dev': 'profile-key' },
  });
  cleanup.push(() => gw.close());
  const c = new HermesGatewayConnector(gwCfg(gw.base));
  await c.poll();
  const options = c.modelOptionsSnapshot();
  const models = c.modelsSnapshot();
  assert.ok(options && models);
  assert.equal(options.filter((r) => r.profile === 'default').length, MODEL_OPTIONS_MAX_PER_PROFILE, `providers per profile capped at ${MODEL_OPTIONS_MAX_PER_PROFILE}`);
  assert.equal(options.length, MODEL_OPTIONS_MAX_TOTAL, `provider rows total capped at ${MODEL_OPTIONS_MAX_TOTAL}`);
  assert.equal(models.length, MODELS_MAX_TOTAL, `served rows total capped at ${MODELS_MAX_TOTAL}`);
  assert.ok(models.filter((r) => r.profile === 'default').length <= MODELS_MAX_PER_PROFILE);
  const perProvider = options.map((r) => r.models?.length ?? 0);
  assert.ok(perProvider.every((n) => n <= MODEL_NAMES_PER_PROVIDER), 'names per provider capped at 24');
  const defaultRows = options.filter((r) => r.profile === 'default');
  const defaultNames = defaultRows.reduce((n, r) => n + (r.models?.length ?? 0), 0);
  assert.equal(defaultNames, MODEL_NAMES_MAX_PER_PROFILE, 'the per-profile name budget is consumed EXACTLY then stops (never exceeded)');
  assert.ok(defaultRows.every((r) => r.models_truncated === true), 'every 40-name provider says so honestly');
});

test("connector: poison provider records drop individually (drop-don't-poison)", async () => {
  const gw = await startMcGateway({
    models: { default: ['string-row', null, { no_id: true }, { id: 'survivor' }] },
    providers: { default: ['string-row', null, { no_slug: true }, { slug: 'survivor', models: ['ok'] }] },
    expectKeys: { default: 'default-key' },
  });
  cleanup.push(() => gw.close());
  const c = new HermesGatewayConnector(gwCfg(gw.base, { profiles: ['default'] }));
  await c.poll();
  assert.deepEqual(c.modelsSnapshot()?.map((r) => r.id), ['survivor'], 'bad records dropped individually, the round stands');
  assert.deepEqual(c.modelOptionsSnapshot()?.map((r) => r.slug), ['survivor']);
});

// ---------------------------------------------------------------------------
// Suite 3: daemon-level ADD-keys-only wire invariant
// ---------------------------------------------------------------------------

import { ClientDaemon } from '../src/index.js';
import type { ClientConfig } from '../src/config.js';
import { startFakeArbiter, type FakeArbiter } from './fake-arbiter.js';

function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error(`timeout waiting: ${what}`));
      }
    }, 10);
  });
}

const savedGwEnv: Record<string, string | undefined> = {
  IDLEFILL_HERMES_GATEWAY: process.env.IDLEFILL_HERMES_GATEWAY,
  IDLEFILL_HERMES_GATEWAY_URL: process.env.IDLEFILL_HERMES_GATEWAY_URL,
  IDLEFILL_HERMES_GATEWAY_KEY: process.env.IDLEFILL_HERMES_GATEWAY_KEY,
};

function setGwEnv(vars: Record<string, string | undefined>): void {
  for (const k of Object.keys(savedGwEnv)) {
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function restoreGwEnv(): void {
  for (const [k, v] of Object.entries(savedGwEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function bootDaemon(): Promise<{ daemon: ClientDaemon; arb: FakeArbiter; dir: string }> {
  const arb = await startFakeArbiter();
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-85c-'));
  const cfg: ClientConfig = {
    server_url: arb.url,
    token: 't85c',
    client_name: '85c-test-client',
    ip: '100.94.165.102',
    proxy_port: 0,
    llm_target: 'http://127.0.0.1:1', // never hit in these tests
    aggregate_port: 0,
    repo_root: here,
    state_dir: join(dir, 'state'),
    state_file: join(dir, 'state.json'),
    projects: [],
  };
  const daemon = new ClientDaemon(cfg, { pollMs: 50, log: { info: () => {} } });
  await daemon.start();
  return { daemon, arb, dir };
}

test("fail-open (connector off): the register body NEVER carries hermes_models/hermes_model_options — byte-for-byte today's shape", async () => {
  setGwEnv({ IDLEFILL_HERMES_GATEWAY: undefined, IDLEFILL_HERMES_GATEWAY_URL: undefined, IDLEFILL_HERMES_GATEWAY_KEY: undefined });
  const { daemon, arb, dir } = await bootDaemon();
  try {
    assert.equal(daemon.hermesConnector, null);
    await waitFor(() => arb.registers.length >= 3, 3000, 'a few heartbeat registers');
    for (const b of arb.registers) {
      assert.ok(!('hermes_models' in b), 'the ADD-key is ABSENT (the wire stays byte-for-byte the pre-#85-C shape)');
      assert.ok(!('hermes_model_options' in b));
      assert.ok(!('models' in b) && !('model_options' in b), 'not even bare keys');
    }
  } finally {
    await daemon.stop();
    await arb.close();
    rmSync(dir, { recursive: true, force: true });
    restoreGwEnv();
  }
});

test('wire on (connector on, gateway answering): the blocks ride under exactly `hermes_models`/`hermes_model_options`, sanitized, bait-free', async () => {
  const gw = await startMcGateway({
    models: { default: [LIVE_MODEL_ENTRY] },
    providers: { default: [liveProvider('openrouter'), liveProvider('anthropic', { is_current: false })] },
    expectKeys: { default: 'test-key' },
  });
  cleanup.push(() => gw.close());
  setGwEnv({ IDLEFILL_HERMES_GATEWAY: '1', IDLEFILL_HERMES_GATEWAY_URL: gw.base, IDLEFILL_HERMES_GATEWAY_KEY: 'test-key' });
  const { daemon, arb, dir } = await bootDaemon();
  try {
    await waitFor(
      () =>
        arb.registers.some((b) => Array.isArray(b.hermes_model_options) && (b.hermes_model_options as HermesModelProviderRow[]).length > 0) &&
        arb.registers.some((b) => Array.isArray(b.hermes_models) && (b.hermes_models as HermesModelRow[]).length > 0),
      5000,
      'the hermes_models + hermes_model_options blocks on the client register heartbeat',
    );
    const body = arb.registers.find((b) => Array.isArray(b.hermes_model_options))!;
    // NAMING: the wire keys carry the HERMES prefix — bare `models` would
    // collide with idlefill vocabulary (servers[].models).
    assert.ok('hermes_models' in body && 'hermes_model_options' in body);
    assert.ok(!('models' in body) && !('model_options' in body), 'NEVER bare models/model_options keys');
    const opts = body.hermes_model_options as HermesModelProviderRow[];
    assert.deepEqual(opts.map((r) => r.slug), ['openrouter', 'anthropic']);
    assert.equal(opts[0]?.current, true);
    assert.equal(opts[0]?.models_truncated, true, 'the truncation marker rides verbatim');
    // The bait scan: pricing/endpoint/config detail NEVER leaves the box.
    const wire = JSON.stringify(body);
    for (const forbidden of ['api_url', 'openrouter.example', 'capabilities', 'free_tier', 'pricing_pending', 'featured', 'Display ']) {
      assert.ok(!wire.includes(forbidden), `the bait member ${forbidden} is absent from the whole register body`);
    }
  } finally {
    await daemon.stop();
    await arb.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
    restoreGwEnv();
  }
});
