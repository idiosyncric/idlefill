/**
 * mesh-reread.test.ts — the scoped mesh config re-read (#91, cli.md D5 —
 * the ONLY new server surface in the CLI wave).
 *
 * Covers:
 *   - MeshFederation.applyMeshConfig: re-applies mesh_peers + peer_token
 *     ONLY; added rows start honest (never fetched), removed config rows
 *     drop, and an existing row's in-flight state (observed instance_id,
 *     last snapshot, fetch ages) is PRESERVED — the view never blanks
 *   - a fleet-roster-origin row is NEVER touched by the config re-apply
 *     (the roster pull owns those rows, #55 D3)
 *   - the new peer set is pulled on the SAME poll cadence (the next
 *     refresh hits the added url; a failing peer still never throws)
 *   - POST /api/mesh/peers/reload auth: the local ADMIN plane only —
 *     anonymous, a wrong token, and the fleet peer_token all stay 401
 *   - the response never carries the peer_token value (set/unset only)
 *   - a failed config re-read (broken source) is 500 with the reason and
 *     applies NOTHING — the live peer set stands
 *   - the shared cfg object: a re-applied peer_token applies to the auth
 *     hook on the very next request (no restart), in both directions
 *   - the audit event lands in the state file (the unpair/revoke precedent)
 *
 * Hermetic: injected fake fetchers + app.inject. No network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApi } from '../src/api.js';
import { Arbiter } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import { MeshFederation, type MeshFetcher } from '../src/mesh.js';
import { applyDefaults } from '../src/config.js';
import type { ServerConfig } from '../src/types.js';

const T0 = Date.parse('2026-10-12T12:00:00Z');
const ADMIN = 'admin-token-91';
const PEER = 'fleet-peer-token-91';

function baseCfg(dir: string, over: Partial<ServerConfig> = {}): ServerConfig {
  return applyDefaults({
    listen: 0,
    api_tokens: [ADMIN],
    llama_swap_url: 'http://fake',
    server_models: ['Qwen3.8-27B'],
    projects: [{ name: 'career-ops', paused: false, daily_token_cap: 10_000 }],
    state_file: join(dir, 'state.json'),
    peer_token: PEER,
    ...over,
  });
}

const snapshot = (id: string, name: string) => ({
  instance_id: id,
  name,
  ts: T0,
  servers: [{ name: 'llama-swap', idle: true, idle_for_s: 600, degraded: false }],
  queue_depth: 7,
  sessions: 2,
  active_leases: 1,
});

function mkMesh(cfg: ServerConfig, opts: { ok?: Set<string>; fail?: Set<string> } = {}): { mesh: MeshFederation; pulled: string[] } {
  const pulled: string[] = [];
  const fetcher: MeshFetcher = async (url) => {
    pulled.push(url);
    const target = url.replace('/api/mesh', '');
    if (opts.fail?.has(target)) throw new Error(`mesh fetch HTTP 502`);
    if (opts.ok && !opts.ok.has(target)) throw new Error('mesh fetch HTTP 404');
    return snapshot(`m-of-${target}`, `name-of-${target}`);
  };
  return { mesh: new MeshFederation(cfg, fetcher), pulled };
}

function mkApp(cfg: ServerConfig, mesh: MeshFederation | undefined, reloadMeshConfig?: () => { mesh_peers: { url: string; name?: string }[]; peer_token: string }) {
  const store = new StateStore(cfg.state_file);
  const det = new IdleDetector({
    fetchActivity: async () => [],
    logMtime: () => null,
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: '',
    idle_seconds: cfg.idle_seconds,
  });
  const arbiter = new Arbiter(store, cfg, det);
  const app = buildApi({ arbiter, cfg, publicDir: join(import.meta.dirname, 'fixtures', 'dashboard'), mesh, reloadMeshConfig });
  return { app, arbiter, store };
}

// ---------------------------------------------------------------------------
// applyMeshConfig — the scoped re-apply, unit level
// ---------------------------------------------------------------------------

test('applyMeshConfig: added rows appear honest (never fetched, offline) and enable the tick', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-reread-'));
  try {
    const cfg = baseCfg(dir, { mesh_peers: [] });
    const { mesh } = mkMesh(cfg);
    assert.equal(mesh.enabled, false);
    const n = mesh.applyMeshConfig([{ url: 'http://peer-a:8787/', name: 'alpha' }], 'tok-2');
    assert.equal(n, 1);
    assert.equal(mesh.enabled, true, 'the next poll tick will pull it (enabled flips)');
    const view = mesh.view(T0);
    assert.deepEqual(view.map((p) => p.url), ['http://peer-a:8787']);
    assert.equal(view[0]!.name, 'alpha');
    assert.equal(view[0]!.online, false, 'never fetched = offline, never a fake current row');
    assert.equal(view[0]!.fetch_age_s, null);
    assert.equal(cfg.peer_token, 'tok-2', 'the scoped key rides the shared config object');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyMeshConfig: in-flight state is PRESERVED for a kept row; removed config rows drop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-reread-'));
  try {
    const cfg = baseCfg(dir, { mesh_peers: [{ url: 'http://peer-a:8787' }] });
    const { mesh, pulled } = mkMesh(cfg, { ok: new Set(['http://peer-a:8787', 'http://peer-b:8787']) });
    await mesh.refresh(T0);
    const before = mesh.view(T0)[0]!;
    assert.equal(before.online, true);
    assert.equal(before.snapshot?.queue_depth, 7);

    mesh.applyMeshConfig([{ url: 'http://peer-a:8787', name: 'renamed' }, { url: 'http://peer-b:8787' }], PEER);
    const a = mesh.view(T0 + 10_000).find((p) => p.url === 'http://peer-a:8787')!;
    assert.equal(a.instance_id, 'm-of-http://peer-a:8787', 'the observed instance id survives the re-read');
    assert.equal(a.snapshot?.queue_depth, 7, 'the last snapshot survives — the view never blanks under the operator');
    assert.equal(a.fetch_age_s, 10, 'the fetch age keeps growing from the ORIGINAL clock');
    assert.equal(a.name, 'renamed', 'the config name re-applies');
    const b = mesh.view(T0).find((p) => p.url === 'http://peer-b:8787')!;
    assert.equal(b.online, false, 'the added row starts never-fetched');

    // Remove it again — the config row drops.
    mesh.applyMeshConfig([{ url: 'http://peer-a:8787', name: 'renamed' }], PEER);
    assert.deepEqual(mesh.view(T0).map((p) => p.url), ['http://peer-a:8787']);

    // The added peer is pulled on the SAME poll cadence (no restart), and a
    // failing peer still never throws.
    mesh.applyMeshConfig([{ url: 'http://peer-b:8787' }], PEER);
    await mesh.refresh(T0 + 20_000);
    assert.ok(pulled.some((u) => u === 'http://peer-b:8787/api/mesh'), 'the next refresh pulls the added row');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyMeshConfig: a fleet-roster row is NEVER touched by the config re-apply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-reread-'));
  try {
    const cfg = baseCfg(dir, { mesh_peers: [], fleet_url: 'http://fleet.test' });
    const { mesh } = mkMesh(cfg);
    await mesh.pullRoster(
      async () => ({
        instances: [{ instance_id: 'm-roster', name: 'roster-peer', public_key: 'k', urls: ['http://roster:8787'], last_seen: T0 }],
      }),
      T0,
    );
    assert.deepEqual(mesh.view(T0).map((p) => p.url), ['http://roster:8787']);
    mesh.applyMeshConfig([{ url: 'http://config:8787' }], PEER);
    assert.deepEqual(
      mesh.view(T0).map((p) => p.url).sort(),
      ['http://config:8787', 'http://roster:8787'],
      'the roster row stands — the roster pull owns it, not the config re-apply (#55 D3)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyMeshConfig: registry garbage is normalized (blank/self/dup rows never become peers)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-reread-'));
  try {
    const cfg = baseCfg(dir, { mesh_peers: [] });
    const { mesh } = mkMesh(cfg);
    mesh.applyMeshConfig(
      [
        { url: '  http://p:1//  ' },
        { url: 'http://p:1' },
        { url: 'self' },
        { url: '   ' },
        { url: 'http://p:2', name: '  ' },
      ],
      PEER,
    );
    assert.deepEqual(mesh.view(T0).map((p) => p.url), ['http://p:1', 'http://p:2']);
    assert.deepEqual(cfg.mesh_peers, [{ url: 'http://p:1' }, { url: 'http://p:2' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// POST /api/mesh/peers/reload — the local-admin endpoint
// ---------------------------------------------------------------------------

test('the reload endpoint: admin token applies the new set; peer_token and anonymous stay 401', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-reread-'));
  try {
    const cfg = baseCfg(dir, { mesh_peers: [{ url: 'http://peer-a:8787' }] });
    const { mesh, pulled } = mkMesh(cfg, { ok: new Set(['http://peer-a:8787', 'http://peer-b:8787']) });
    const app = mkApp(cfg, mesh, () => ({
      mesh_peers: [{ url: 'http://peer-a:8787' }, { url: 'http://peer-b:8787', name: 'beta' }],
      peer_token: PEER,
    })).app;

    const anon = await app.inject({ method: 'POST', url: '/api/mesh/peers/reload' });
    assert.equal(anon.statusCode, 401);
    const wrong = await app.inject({ method: 'POST', url: '/api/mesh/peers/reload', headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.statusCode, 401);
    // The fleet read token is scoped to GET /api/mesh — it never reaches a
    // control surface, this one included (mesh.md D2).
    const peerTok = await app.inject({ method: 'POST', url: '/api/mesh/peers/reload', headers: { authorization: `Bearer ${PEER}` } });
    assert.equal(peerTok.statusCode, 401);

    const ok = await app.inject({ method: 'POST', url: '/api/mesh/peers/reload', headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(ok.statusCode, 200);
    const body = ok.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.peers.map((p: { url: string }) => p.url), ['http://peer-a:8787', 'http://peer-b:8787']);
    assert.equal(body.peer_token, 'set', 'the token VALUE never rides the response');
    assert.ok(!JSON.stringify(body).includes(PEER));
    assert.equal(body.poll_ms, cfg.poll_ms, 'the CLI quotes the cadence the row lands on');

    // The next poll tick pulls it — and /api/state's merged view carries the
    // added row, honest (offline until the first fetch).
    await mesh.refresh(T0);
    assert.ok(pulled.some((u) => u === 'http://peer-b:8787/api/mesh'));
    const st = await app.inject({ method: 'GET', url: '/api/state' });
    const peers = st.json().mesh.peers as { url: string; name: string; online: boolean }[];
    assert.deepEqual(peers.map((p) => p.url), ['http://peer-a:8787', 'http://peer-b:8787']);
    assert.equal(peers[1]!.name, 'beta');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a re-applied peer_token applies to the auth hook on the NEXT request — no restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-reread-'));
  try {
    const cfg = baseCfg(dir, { mesh_peers: [] });
    const { mesh } = mkMesh(cfg);
    const app = mkApp(cfg, mesh, () => ({ mesh_peers: [], peer_token: 'rotated-token-91' })).app;

    // Before: the old token works on GET /api/mesh, the new one does not.
    assert.equal((await app.inject({ method: 'GET', url: '/api/mesh', headers: { authorization: `Bearer ${PEER}` } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/mesh', headers: { authorization: 'Bearer rotated-token-91' } })).statusCode, 401);

    assert.equal((await app.inject({ method: 'POST', url: '/api/mesh/peers/reload', headers: { authorization: `Bearer ${ADMIN}` } })).statusCode, 200);

    // After: flipped on the very next request, in BOTH directions (a stale
    // token stops working the moment it is replaced — the tightening side).
    assert.equal((await app.inject({ method: 'GET', url: '/api/mesh', headers: { authorization: `Bearer ${PEER}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/mesh', headers: { authorization: 'Bearer rotated-token-91' } })).statusCode, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed config re-read is a named 500 and applies NOTHING — the live peer set stands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-reread-'));
  try {
    const cfg = baseCfg(dir, { mesh_peers: [{ url: 'http://peer-a:8787' }], peer_token: PEER });
    const { mesh } = mkMesh(cfg, { ok: new Set(['http://peer-a:8787']) });
    await mesh.refresh(T0);
    const app = mkApp(cfg, mesh, () => {
      throw new Error('failed to parse config /tmp/x/config.json: SyntaxError bad json');
    }).app;

    const r = await app.inject({ method: 'POST', url: '/api/mesh/peers/reload', headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(r.statusCode, 500);
    assert.equal(r.json().error, 'config_reread_failed');
    assert.match(r.json().reason, /bad json/);

    // Zero mutation: same single row, still online with its snapshot, same token.
    const view = mesh.view(T0);
    assert.deepEqual(view.map((p) => p.url), ['http://peer-a:8787']);
    assert.equal(view[0]!.online, true);
    assert.equal(cfg.peer_token, PEER);
    assert.equal((await app.inject({ method: 'GET', url: '/api/mesh', headers: { authorization: `Bearer ${PEER}` } })).statusCode, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unwired variants answer 501 (no mesh module / no re-read wiring)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-reread-'));
  try {
    const cfg = baseCfg(dir, {});
    const noMesh = mkApp(cfg, undefined, () => ({ mesh_peers: [], peer_token: '' })).app;
    assert.equal((await noMesh.inject({ method: 'POST', url: '/api/mesh/peers/reload', headers: { authorization: `Bearer ${ADMIN}` } })).statusCode, 501);

    const cfg2 = baseCfg(dir, { state_file: join(dir, 'state2.json') });
    const { mesh } = mkMesh(cfg2);
    const noReload = mkApp(cfg2, mesh).app;
    assert.equal((await noReload.inject({ method: 'POST', url: '/api/mesh/peers/reload', headers: { authorization: `Bearer ${ADMIN}` } })).statusCode, 501);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the reload lands a named audit event in the state file — the token value never rides it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-reread-'));
  try {
    const cfg = baseCfg(dir, { mesh_peers: [] });
    const { mesh } = mkMesh(cfg);
    const { app, store } = mkApp(cfg, mesh, () => ({ mesh_peers: [{ url: 'http://p:1' }], peer_token: 'secret-token-xyz' }));
    void store;
    const r = await app.inject({ method: 'POST', url: '/api/mesh/peers/reload', headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(r.statusCode, 200);
    const events = (JSON.parse(readFileSync(cfg.state_file, 'utf-8')).events ?? []) as { kind: string; detail: string }[];
    const mine = events.filter((e) => e.kind === 'mesh_peers_reloaded');
    assert.equal(mine.length, 1);
    assert.match(mine[0]!.detail, /1 configured peer\(s\); peer_token set/);
    assert.ok(!JSON.stringify(events).includes('secret-token-xyz'), 'the audit never carries the token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
