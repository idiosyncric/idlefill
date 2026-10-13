/**
 * hermes-capabilities.test.ts — issue #85 slice B: HERMES SKILLS + TOOLSETS
 * (the per-profile capability inventory, `GET /v1/skills` + `GET
 * /v1/toolsets`). READ-ONLY: the connector makes only GETs — there is no
 * enable/disable/install verb in this surface.
 *
 * Suites:
 *   1. The sanitizers against the LIVE-VERIFIED gateway shapes pinned at
 *      build against the running gateway (see docs/reports/
 *      ISSUE85-SKILLS-SLICE-B.md): the toolsets envelope `{object:'list',
 *      platform, data:[{name,label,description,enabled,configured,tools}]}`
 *      (200 live); the skills row is pinned from the gateway SOURCE
 *      (tools/skills_tool.py:239 — `{name, description, category}`) because
 *      the live route 500'd at build ("Failed to enumerate skills" — the
 *      connector must fail-quiet, NOTHING is guessed). Projection only:
 *      toolset label/description/tools are decoration/duplication and NEVER
 *      publish; skills carry NO enabled/configured fabrication.
 *   2. The connector against a FAKE gateway: per-profile paths + per-profile
 *      keys; ONE bounded GET per surface per profile per round (cadence);
 *      unkeyed ⇒ ZERO requests; down ⇒ ZERO capability requests; 401/500
 *      (the live skills failure too)/malformed ⇒ last-known stands; a 200
 *      replaces; per-profile and total caps; poison records drop
 *      individually; snapshots absent pre-first-round/disabled.
 *   3. Daemon-level ADD-keys-only wire invariant (real ClientDaemon + fake
 *      arbiter): connector off ⇒ the register body NEVER carries
 *      `hermes_skills`/`hermes_toolsets` (byte-for-byte today's shape);
 *      connector on ⇒ the blocks ride under exactly those keys (never bare
 *      `skills`/`toolsets` — the names are the gateway's surfaces, and a
 *      bare key would collide with idlefill vocabulary).
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
  skillsPath,
  toolsetsPath,
  sanitizeHermesSkill,
  sanitizeHermesToolset,
  SKILLS_MAX_PER_PROFILE,
  SKILLS_MAX_TOTAL,
  TOOLSETS_MAX_PER_PROFILE,
  TOOLSETS_MAX_TOTAL,
  SKILL_DESC_CAP,
  type HermesSkillRow,
  type HermesToolsetRow,
} from '../src/hermes-gateway.js';

const here = dirname(fileURLToPath(import.meta.url));
const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

// ---------------------------------------------------------------------------
// The live-verified toolsets rows (subset of the 28 live rows, shape pinned by
// the build-time curl evidence in the slice-B report) and the SOURCE-pinned
// skills row (skills_tool.py:239 — the live route 500'd, so the row shape is
// pinned from the gateway source, honestly labeled).
// ---------------------------------------------------------------------------

const LIVE_TOOLSETS = [
  {
    name: 'web',
    label: '🔍 Web Search & Scraping',
    description: 'web_search, web_extract',
    enabled: true,
    configured: true,
    tools: ['web_extract', 'web_search'],
  },
  {
    name: 'video_gen',
    label: '🎬 Video Generation',
    description: 'video_generate',
    enabled: false,
    configured: true,
    tools: ['video_generate'],
  },
  {
    name: 'x_search',
    label: '🐦 X Search',
    description: 'x_search',
    enabled: false,
    configured: false,
    tools: [],
  },
];

const SKILL_ROWS = [
  { name: 'orchestration', description: 'Coordinate supervised workers: DAGs, gates, loops.', category: 'agents' },
  { name: 'shadcn', description: 'Manages components and projects.', category: 'ui' },
];

// ---------------------------------------------------------------------------
// Suite 1: the sanitizers
// ---------------------------------------------------------------------------

test('sanitizeHermesToolset: live row → name + the two exact booleans ONLY (label/description/tools NEVER published)', () => {
  const row = sanitizeHermesToolset(LIVE_TOOLSETS[0], 'default');
  assert.ok(row);
  assert.equal(row.name, 'web');
  assert.equal(row.profile, 'default');
  assert.equal(row.enabled, true);
  assert.equal(row.configured, true);
  const wire = JSON.stringify(row);
  // The toolset description is the tool-name list (duplication) and the
  // label is emoji decoration — neither is the issue's capability row.
  for (const forbidden of ['🔍', 'Scraping', 'web_search', 'web_extract', 'description', 'tools', 'label']) {
    assert.ok(!wire.includes(forbidden), `the published row never carries ${forbidden}`);
  }
});

test('sanitizeHermesToolset: exact booleans only (no coercion), missing bits stay absent, caps + drop rules', () => {
  assert.equal(sanitizeHermesToolset({ name: 'x', enabled: 'yes', configured: 1 }, 'default')?.enabled, undefined, 'a non-boolean enabled is DROPPED (exact-boolean rule)');
  assert.equal(sanitizeHermesToolset({ name: 'x', configured: 1 }, 'default')?.configured, undefined);
  assert.equal(sanitizeHermesToolset({ name: 'x' }, 'default')?.enabled, undefined, 'an absent bit stays absent (never fabricated false)');
  assert.equal(sanitizeHermesToolset({ description: 'no name' }, 'default'), undefined, 'no usable name ⇒ row dropped whole');
  assert.equal(sanitizeHermesToolset('not-an-object', 'default'), undefined);
  const long = sanitizeHermesToolset({ name: 't'.repeat(200), enabled: false, configured: false }, 'p'.repeat(200))!;
  assert.equal(long.name.length, 64);
  assert.equal(long.profile?.length, 64);
  assert.equal(long.enabled, false, 'a live false stands (the disabled toolset is visible, exception-marked)');
});

test('sanitizeHermesSkill: source-pinned row → name/description/category; description capped at 256 (the issue cap); NO enabled/configured fabrication', () => {
  const row = sanitizeHermesSkill(SKILL_ROWS[0], 'default');
  assert.ok(row);
  assert.equal(row.name, 'orchestration');
  assert.equal(row.profile, 'default');
  assert.equal(row.category, 'agents');
  assert.equal(row.description, 'Coordinate supervised workers: DAGs, gates, loops.');
  // The gateway row carries no enabled/configured member — a poison entry
  // offering them has NO landing place.
  const poison = sanitizeHermesSkill({ name: 's', enabled: true, configured: true, prompt: 'SECRET', instructions: 'SECRET' }, 'web-dev')!;
  assert.ok(!('enabled' in poison) && !('configured' in poison), 'the toolset-only bits are NEVER stamped onto skills');
  const pwire = JSON.stringify(poison);
  assert.ok(!pwire.includes('SECRET'), 'extra hostile members never land');
  // Description cap: the issue's 256 (the one text member the cap governs).
  const long = sanitizeHermesSkill({ name: 's', description: 'd'.repeat(300), category: 'c'.repeat(200) }, 'default')!;
  assert.equal(long.description?.length, SKILL_DESC_CAP);
  assert.equal(SKILL_DESC_CAP, 256);
  assert.equal(long.category?.length, 64);
});

test('skillsPath/toolsetsPath: default = home listener, a named profile = the /p/<profile> mirror (mirrors exist; the per-profile key rule holds — verified live)', () => {
  assert.equal(skillsPath('default'), '/v1/skills');
  assert.equal(skillsPath('web-dev'), '/p/web-dev/v1/skills');
  assert.equal(toolsetsPath('default'), '/v1/toolsets');
  assert.equal(toolsetsPath('a b'), '/p/a%20b/v1/toolsets');
});

// ---------------------------------------------------------------------------
// Suite 2: the connector against a fake gateway
// ---------------------------------------------------------------------------

interface CapOpts {
  healthUp?: boolean;
  /** profile → current toolset rows. */
  toolsets: Record<string, unknown[]>;
  /** profile → current skill rows. */
  skills: Record<string, unknown[]>;
  expectKeys?: Record<string, string>;
  /** profiles answering 500 on the skills route (the live build state). */
  skillsBroken?: string[];
  /** profiles answering 500 on the toolsets route. */
  toolsetsBroken?: string[];
  /** profiles answering a malformed envelope. */
  garbage?: string[];
  deny?: string[];
}

interface CapGateway {
  base: string;
  opts: CapOpts;
  requests: { path: string; query: string; auth: string }[];
  close: () => Promise<void>;
}

function startCapGateway(opts: CapOpts): Promise<CapGateway> {
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
      return send(200, { status: 'ok', version: '0.21.6' });
    }
    const surf = url.pathname.match(/^\/(?:p\/([^/]+)\/)?(v1\/skills|v1\/toolsets)$/);
    if (req.method === 'GET' && surf) {
      const profile = surf[1] ?? 'default';
      const isSkills = surf[2] === 'v1/skills';
      if (opts.deny?.includes(profile)) return send(401, { error: { code: 'gateway_auth_failed' } });
      const expected = opts.expectKeys?.[profile];
      if (opts.expectKeys && !expected) return send(401, { error: { code: 'gateway_auth_failed' } });
      if (expected && (req.headers.authorization ?? '') !== `Bearer ${expected}`) return send(401, { error: { code: 'gateway_auth_failed' } });
      if (opts.garbage?.includes(profile)) return send(200, { nope: true });
      if (isSkills && opts.skillsBroken?.includes(profile)) return send(500, { error: { message: 'Failed to enumerate skills', type: 'server_error' } });
      if (!isSkills && opts.toolsetsBroken?.includes(profile)) return send(500, { error: { message: 'Failed to enumerate toolsets', type: 'server_error' } });
      const rows = isSkills ? opts.skills[profile] : opts.toolsets[profile];
      return send(200, { object: 'list', ...(isSkills ? {} : { platform: 'api_server' }), data: rows ?? [] });
    }
    // Everything else (ledger, jobs) answers the empty-list posture.
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

const skillReqs = (gw: CapGateway) => gw.requests.filter((r) => r.path === '/v1/skills' || r.path.endsWith('/v1/skills'));
const toolsetReqs = (gw: CapGateway) => gw.requests.filter((r) => r.path === '/v1/toolsets' || r.path.endsWith('/v1/toolsets'));

test('connector: ONE bounded GET per surface per keyed profile per round — paths + per-profile keys, snapshots merged', async () => {
  const gw = await startCapGateway({
    skills: { default: SKILL_ROWS, 'web-dev': [{ name: 'career-ops-pilot', description: 'adapter pilot', category: 'work' }] },
    toolsets: { default: LIVE_TOOLSETS, 'web-dev': [{ name: 'terminal', enabled: true, configured: true }] },
    expectKeys: { default: 'default-key', 'web-dev': 'profile-key' },
  });
  cleanup.push(() => gw.close());
  const c = new HermesGatewayConnector(gwCfg(gw.base));
  // Pre-first-round: NOTHING published.
  assert.equal(c.skillsSnapshot(), undefined);
  assert.equal(c.toolsetsSnapshot(), undefined);
  await c.poll();
  const skills = c.skillsSnapshot();
  const toolsets = c.toolsetsSnapshot();
  assert.ok(skills && toolsets);
  assert.deepEqual(skills.map((r) => r.name), ['orchestration', 'shadcn', 'career-ops-pilot'], 'config-order profile attribution');
  assert.deepEqual(new Set(toolsets.map((r) => r.profile)), new Set(['default', 'web-dev']));
  // Second poll in the same instant is cadence-gated: at most one GET per
  // surface per profile per CONNECTOR ROUND.
  await c.poll();
  assert.equal(skillReqs(gw).length, 2, 'ONE /v1/skills GET per profile per round');
  assert.equal(toolsetReqs(gw).length, 2, 'ONE /v1/toolsets GET per profile per round');
  assert.equal(skillReqs(gw).find((r) => r.path === '/v1/skills')?.auth, 'Bearer default-key');
  assert.equal(toolsetReqs(gw).find((r) => r.path === '/p/web-dev/v1/toolsets')?.auth, 'Bearer profile-key', 'per-profile key discipline');
  assert.ok(toolsets.some((t) => t.name === 'video_gen' && t.enabled === false), 'a disabled toolset is REPORTED (the bit is the fact), never hidden');
});

test('connector: unkeyed profile ⇒ ZERO capability requests', async () => {
  const gw = await startCapGateway({
    skills: { default: SKILL_ROWS, 'web-dev': [{ name: 'secret-skill' }] },
    toolsets: { default: LIVE_TOOLSETS, 'web-dev': [{ name: 'terminal' }] },
  });
  cleanup.push(() => gw.close());
  const c = new HermesGatewayConnector(gwCfg(gw.base, { profileKeys: new Map() }));
  await c.poll();
  assert.ok(c.skillsSnapshot()?.some((r) => r.name === 'orchestration'));
  assert.equal(skillReqs(gw).filter((r) => r.path === '/p/web-dev/v1/skills').length, 0, 'no request to an unkeyed profile');
  assert.equal(toolsetReqs(gw).filter((r) => r.path === '/p/web-dev/v1/toolsets').length, 0);
  assert.ok(!c.skillsSnapshot()?.some((r) => r.name === 'secret-skill'), 'the unkeyed profile publishes nothing');
});

test('connector: down ⇒ ZERO capability requests; 401/500/malformed rounds stand last-known; a 200 REPLACES', async () => {
  const gw = await startCapGateway({
    healthUp: false,
    skills: { default: SKILL_ROWS },
    toolsets: { default: LIVE_TOOLSETS },
  });
  cleanup.push(() => gw.close());
  const down = new HermesGatewayConnector(gwCfg(gw.base, { profiles: ['default'] }));
  await down.poll();
  assert.equal(skillReqs(gw).length + toolsetReqs(gw).length, 0, 'a down gateway sees NO extra capability request — byte-for-byte zero');
  assert.equal(down.skillsSnapshot(), undefined);

  // A fresh gateway for the stand/replace sequence.
  const gw2 = await startCapGateway({
    skills: { default: SKILL_ROWS },
    toolsets: { default: [{ name: 'keep', enabled: true }, { name: 'gone', enabled: true }] },
    expectKeys: { default: 'default-key' },
  });
  cleanup.push(() => gw2.close());
  let t = 0;
  const c = new HermesGatewayConnector(gwCfg(gw2.base, { profiles: ['default'] }), { now: () => (t += 60_000) });
  await c.poll(); // round 1
  assert.deepEqual(c.toolsetsSnapshot()?.map((r) => r.name), ['keep', 'gone']);
  gw2.opts.skillsBroken = ['default'];
  gw2.opts.toolsetsBroken = ['default'];
  await c.poll(); // round 2: 500s (the live skills failure class) ⇒ last-known stands
  assert.deepEqual(c.toolsetsSnapshot()?.map((r) => r.name), ['keep', 'gone'], 'a 500 round never clears the strip');
  gw2.opts.skillsBroken = undefined;
  gw2.opts.toolsetsBroken = undefined;
  gw2.opts.deny = ['default'];
  await c.poll(); // round 3: 401 ⇒ last-known stands
  assert.deepEqual(c.skillsSnapshot()?.map((r) => r.name), ['orchestration', 'shadcn'], 'a 401 round never clears skills either');
  gw2.opts.deny = undefined;
  gw2.opts.garbage = ['default'];
  await c.poll(); // round 4: malformed envelope ⇒ last-known stands
  assert.deepEqual(c.toolsetsSnapshot()?.map((r) => r.name), ['keep', 'gone']);
  gw2.opts.garbage = undefined;
  gw2.opts.toolsets.default = [{ name: 'keep', enabled: true }];
  await c.poll(); // round 5: complete truth replaces ⇒ `gone` is GONE
  assert.deepEqual(c.toolsetsSnapshot()?.map((r) => r.name), ['keep'], 'the answering round replaces (a vanished toolset leaves in one round)');
  gw2.opts.toolsets.default = [];
  gw2.opts.skills.default = [];
  await c.poll(); // round 6: empty answer ⇒ publish NOTHING (absent, never a [] dump)
  assert.equal(c.toolsetsSnapshot(), undefined);
  assert.equal(c.skillsSnapshot(), undefined);
});

test('connector: count caps — per-profile (200) and published total, both blocks', async () => {
  const manySkills = Array.from({ length: 240 }, (_, i) => ({ name: `s${i}`, description: 'd', category: 'c' }));
  const manyToolsets = Array.from({ length: 240 }, (_, i) => ({ name: `t${i}`, enabled: true, configured: true }));
  const gw = await startCapGateway({
    skills: { default: manySkills, 'web-dev': manySkills.map((s) => ({ ...s, name: `w_${s.name}` })) },
    toolsets: { default: manyToolsets, 'web-dev': manyToolsets.map((t) => ({ ...t, name: `w_${t.name}` })) },
    expectKeys: { default: 'default-key', 'web-dev': 'profile-key' },
  });
  cleanup.push(() => gw.close());
  const c = new HermesGatewayConnector(gwCfg(gw.base));
  await c.poll();
  const skills = c.skillsSnapshot();
  const toolsets = c.toolsetsSnapshot();
  assert.ok(skills && toolsets);
  assert.equal(skills.length, SKILLS_MAX_TOTAL, `skills total capped hard at ${SKILLS_MAX_TOTAL}`);
  assert.equal(toolsets.length, TOOLSETS_MAX_TOTAL, `toolsets total capped hard at ${TOOLSETS_MAX_TOTAL}`);
  assert.ok(skills.filter((r) => r.profile === 'default').length <= SKILLS_MAX_PER_PROFILE);
  assert.ok(toolsets.filter((r) => r.profile === 'default').length <= TOOLSETS_MAX_PER_PROFILE);
});

test("connector: poison records drop individually (drop-don't-poison)", async () => {
  const gw = await startCapGateway({
    skills: { default: ['string-row', null, { no_name: true }, { name: 'survivor' }] },
    toolsets: { default: ['string-row', null, { no_name: true }, { name: 'survivor', enabled: true }] },
    expectKeys: { default: 'default-key' },
  });
  cleanup.push(() => gw.close());
  const c = new HermesGatewayConnector(gwCfg(gw.base, { profiles: ['default'] }));
  await c.poll();
  assert.deepEqual(c.skillsSnapshot()?.map((r) => r.name), ['survivor'], 'bad records dropped individually, the round stands');
  assert.deepEqual(c.toolsetsSnapshot()?.map((r) => r.name), ['survivor']);
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
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-85b-'));
  const cfg: ClientConfig = {
    server_url: arb.url,
    token: 't85b',
    client_name: '85b-test-client',
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

test("fail-open (connector off): the register body NEVER carries hermes_skills/hermes_toolsets — byte-for-byte today's shape", async () => {
  setGwEnv({ IDLEFILL_HERMES_GATEWAY: undefined, IDLEFILL_HERMES_GATEWAY_URL: undefined, IDLEFILL_HERMES_GATEWAY_KEY: undefined });
  const { daemon, arb, dir } = await bootDaemon();
  try {
    assert.equal(daemon.hermesConnector, null);
    await waitFor(() => arb.registers.length >= 3, 3000, 'a few heartbeat registers');
    for (const b of arb.registers) {
      assert.ok(!('hermes_skills' in b), 'the ADD-key is ABSENT (the wire stays byte-for-byte the pre-#85-B shape)');
      assert.ok(!('hermes_toolsets' in b));
      assert.ok(!('skills' in b) && !('toolsets' in b), 'not even bare keys');
    }
  } finally {
    await daemon.stop();
    await arb.close();
    rmSync(dir, { recursive: true, force: true });
    restoreGwEnv();
  }
});

test('wire on (connector on, gateway answering): the blocks ride under exactly `hermes_skills`/`hermes_toolsets`, sanitized', async () => {
  const gw = await startCapGateway({
    skills: { default: SKILL_ROWS },
    toolsets: { default: LIVE_TOOLSETS },
    expectKeys: { default: 'test-key' },
  });
  cleanup.push(() => gw.close());
  setGwEnv({ IDLEFILL_HERMES_GATEWAY: '1', IDLEFILL_HERMES_GATEWAY_URL: gw.base, IDLEFILL_HERMES_GATEWAY_KEY: 'test-key' });
  const { daemon, arb, dir } = await bootDaemon();
  try {
    await waitFor(
      () =>
        arb.registers.some((b) => Array.isArray(b.hermes_toolsets) && (b.hermes_toolsets as HermesToolsetRow[]).length > 0) &&
        arb.registers.some((b) => Array.isArray(b.hermes_skills) && (b.hermes_skills as HermesSkillRow[]).length > 0),
      5000,
      'the hermes_skills + hermes_toolsets blocks on the client register heartbeat',
    );
    const body = arb.registers.find((b) => Array.isArray(b.hermes_toolsets))!;
    // NAMING: the wire keys carry the HERMES prefix — bare `skills`/`toolsets`
    // NEVER ride the body (collision with idlefill vocabulary is refused by
    // shape).
    assert.ok('hermes_skills' in body && 'hermes_toolsets' in body);
    assert.ok(!('skills' in body) && !('toolsets' in body), 'NEVER bare skills/toolsets keys');
    const tsets = body.hermes_toolsets as HermesToolsetRow[];
    assert.deepEqual(tsets.map((t) => t.name), ['web', 'video_gen', 'x_search']);
    assert.ok(tsets.find((t) => t.name === 'x_search')?.configured === false, 'the configured bit rides verbatim (exception-marked at render)');
    const wire = JSON.stringify(body);
    assert.ok(!wire.includes('🔍') && !wire.includes('web_search') && !wire.includes('Scraping'), 'decoration/duplication never leaves the connector');
  } finally {
    await daemon.stop();
    await arb.close();
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
    restoreGwEnv();
  }
});
