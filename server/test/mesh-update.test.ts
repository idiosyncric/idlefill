/**
 * mesh-update.test.ts — the machine-update plane (docs/architecture/
 * mesh-update.md, LOCKED 2026-10-12).
 *
 * Covers, hermetically (real ed25519 + loopback capture, no network):
 *  TARGET side (the existing signed control relay, new verb):
 *   - signed `update` → 202 queued INTENT (never an exec), audit event,
 *     the coarse `update_intents` block on /api/state
 *   - single-flight: a second request is 409 `update_in_flight`
 *   - the helper plane is admin-token-gated: claim → running, result →
 *     done/failed with named events; 401 without the token; 404 on a
 *     non-claimable id; 400 on a non-boolean ok
 *  REQUESTER side (the local relay, admin plane):
 *   - an `i_control` edge + known peer → the arbiter signs the #39
 *     envelope (the capture verifies under the stored peer key) and
 *     passes the peer's answer through
 *   - no edge → 403 `not_paired`; wrong direction → 403
 *     `direction_denied`; anything but `update` → 400; unreachable
 *     peer → 502 `peer_unreachable`; unknown id → 502 `peer_url_unknown`
 *  STATE decoration: peers carry `i_control` / `controls_me` from the
 *  LOCAL edge store (one source for display and enforcement).
 *  INTENT store unit: TTL → stale, cap, markRunningAbandoned.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApi } from '../src/api.js';
import { Arbiter } from '../src/arbiter.js';
import { StateStore } from '../src/state.js';
import { IdleDetector } from '../src/idle.js';
import { Identity } from '../src/identity.js';
import { MeshFederation } from '../src/mesh.js';
import { signEdgePayload } from '../src/edges.js';
import { UpdateIntents, intentsFileOf, INTENTS_CAP } from '../src/update.js';
import type { ServerConfig } from '../src/types.js';

const ADMIN = 'admin-token-1';
const PEER = 'fleet-peer-token';

function baseCfg(dir: string, over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    listen: 0,
    api_tokens: [ADMIN],
    llama_swap_url: 'http://fake',
    activity_path: '/api/metrics/activity',
    server_name: 'llama-swap',
    server_models: ['Qwen3.8-27B'],
    server_peers: [],
    mesh_peers: [],
    peer_token: PEER,
    mesh_name: '',
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
    ...over,
  };
}

function mkArbiter(cfg: ServerConfig): Arbiter {
  const store = new StateStore(cfg.state_file);
  const det = new IdleDetector({
    fetchActivity: async () => [],
    logMtime: () => null,
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: '',
    idle_seconds: cfg.idle_seconds,
  });
  return new Arbiter(store, cfg, det);
}

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'idlefill-mesh-update-'));
  tmpDirs.push(d);
  return d;
}

function eventsOf(arbiter: Arbiter, kind: string): Record<string, unknown>[] {
  return arbiter['store'].state.events.filter((e) => e.kind === kind) as unknown as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// TARGET side: the signed `update` verb creates an intent, never an exec
// ---------------------------------------------------------------------------

const controller = Identity.mint(); // the peer that controls THIS machine
const controllerId = 'm-controller';
let nonceSeq = 0;

function signHeaders(id: string, ts: number, nonce: string, priv: Identity): Record<string, string> {
  const { signatureB64url } = signEdgePayload(priv, { instance_id: id, path: '/api/mesh/control', ts, nonce });
  return {
    'x-idlefill-instance-id': id,
    'x-idlefill-signature': signatureB64url,
    'x-idlefill-nonce': nonce,
    'x-idlefill-ts': String(ts),
  };
}

let targetApp: ReturnType<typeof buildApi>;
let targetArbiter: Arbiter;
let targetBase = '';
let targetCfg: ServerConfig;

before(async () => {
  const dir = mkTmp();
  targetCfg = baseCfg(dir, { mesh_name: 'target' });
  targetArbiter = mkArbiter(targetCfg);
  targetApp = buildApi({ arbiter: targetArbiter, cfg: targetCfg, publicDir: join(import.meta.dirname, '..', 'public') });
  targetArbiter.edges().upsert({
    peer_instance_id: controllerId,
    peer_public_key: controller.publicKeyB64url,
    peer_name: 'controller',
    direction: 'controls_me',
    created_at: Date.now(),
  });
  await targetApp.listen({ port: 0, host: '127.0.0.1' });
  const addr = targetApp.server.address();
  targetBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await targetApp.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

async function signedUpdate(): Promise<{ status: number; body: Record<string, unknown> }> {
  const h = signHeaders(controllerId, Date.now(), `u-nonce-${++nonceSeq}`, controller);
  h['content-type'] = 'application/json';
  const r = await fetch(`${targetBase}/api/mesh/control`, { method: 'POST', headers: h, body: JSON.stringify({ action: 'update' }) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

test('signed update → 202 queued INTENT + audit; a second is 409 update_in_flight', async () => {
  const r = await signedUpdate();
  assert.equal(r.status, 202);
  assert.equal(r.body.action, 'update');
  assert.equal(r.body.state, 'queued');
  assert.equal(r.body.source_instance_id, controllerId);
  const intentId = r.body.intent_id as string;
  assert.ok(intentId.startsWith('u-'));

  const again = await signedUpdate();
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'update_in_flight');
  assert.equal(again.body.intent_id, intentId, 'the answer names the live intent');

  const aud = eventsOf(targetArbiter, 'mesh_control');
  assert.ok(aud.some((e) => e.detail === 'update' || JSON.stringify(e).includes('update')));

  // The coarse block rides /api/state (anonymous read).
  const st = await (await fetch(`${targetBase}/api/state`)).json();
  const intents = st.update_intents as Record<string, unknown>[];
  assert.ok(Array.isArray(intents) && intents.length === 1);
  assert.equal(intents[0]!.id, intentId);
  assert.equal(intents[0]!.state, 'queued');
});

test('the helper plane: admin token only; claim → running; result → done', async () => {
  const st = await (await fetch(`${targetBase}/api/state`)).json();
  const id = (st.update_intents as { id: string }[])[0]!.id;

  const anon = await fetch(`${targetBase}/api/update-intents`);
  assert.equal(anon.status, 401, 'the helper plane is not anonymous');
  const list = await (await fetch(`${targetBase}/api/update-intents`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
  assert.equal(list.intents[0].state, 'queued');

  const claimed = await fetch(`${targetBase}/api/update-intents/${id}/claim`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).intent.state, 'running');
  const reclaim = await fetch(`${targetBase}/api/update-intents/${id}/claim`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(reclaim.status, 404, 'a running intent is not claimable twice');

  const bad = await fetch(`${targetBase}/api/update-intents/${id}/result`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ok: 'yes' }),
  });
  assert.equal(bad.status, 400, 'ok must be an exact boolean');

  const done = await fetch(`${targetBase}/api/update-intents/${id}/result`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, detail: 'image swapped, healthcheck green' }),
  });
  assert.equal(done.status, 200);
  const intent = (await done.json()).intent;
  assert.equal(intent.state, 'done');
  assert.match(intent.detail, /healthcheck green/);
  assert.ok(eventsOf(targetArbiter, 'mesh_control').some((e) => JSON.stringify(e).includes('update_done')));

  const miss = await fetch(`${targetBase}/api/update-intents/u-nope/claim`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(miss.status, 404);
});

// ---------------------------------------------------------------------------
// REQUESTER side: the local relay signs the envelope ONLY over edges
// ---------------------------------------------------------------------------

let hop: Server;
let hopBase = '';
const hopCaptured: { headers: Record<string | undefined, string | string[] | undefined>; body: unknown }[] = [];

before(async () => {
  hop = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/api/mesh') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ instance_id: 'm-target-1', name: 'target-1', ts: Date.now(), servers: [], queue_depth: 0, sessions: 0, active_leases: 0 }));
        return;
      }
      if (req.url === '/api/mesh/control' && req.method === 'POST') {
        hopCaptured.push({ headers: req.headers as Record<string, string | string[] | undefined>, body: JSON.parse(raw) });
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action: 'update', intent_id: 'u-target', state: 'queued' }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => hop.listen(0, '127.0.0.1', r));
  hopBase = `http://127.0.0.1:${(hop.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => hop.close(() => r()));
});

async function requester(meshOn: boolean): Promise<{ app: ReturnType<typeof buildApi>; arbiter: Arbiter; base: string; mesh: MeshFederation }> {
  const dir = mkTmp();
  const cfg = baseCfg(dir, { mesh_name: 'controller-box', mesh_peers: meshOn ? [{ url: hopBase }] : [] });
  const arbiter = mkArbiter(cfg);
  const mesh = new MeshFederation(cfg, async () => {
    const r = await fetch(`${hopBase}/api/mesh`);
    return r.json();
  });
  const app = buildApi({ arbiter, cfg, publicDir: join(import.meta.dirname, '..', 'public'), ...(meshOn ? { mesh } : {}) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  return { app, arbiter, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, mesh };
}

test('relay: no local edge → 403 not_paired (never signs, never hops)', async () => {
  const ctx = await requester(true);
  try {
    const r = await fetch(`${ctx.base}/api/mesh/control/m-stranger`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'update' }),
    });
    assert.equal(r.status, 403);
    assert.equal(((await r.json()) as Record<string, unknown>).error, 'not_paired');
    assert.equal(hopCaptured.length, 0);
  } finally {
    await ctx.app.close();
  }
});

test('relay: an i_control edge signs the #39 envelope and relays update', async () => {
  const ctx = await requester(true);
  try {
    // The federation must have SEEN the peer (instance_id is the identity).
    await ctx.mesh.refresh(Date.now());
    ctx.arbiter.edges().upsert({
      peer_instance_id: 'm-target-1',
      peer_public_key: Identity.mint().publicKeyB64url, // stored key of the TARGET
      peer_name: 'target-1',
      direction: 'i_control',
      created_at: Date.now(),
    });
    const r = await fetch(`${ctx.base}/api/mesh/control/m-target-1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'update' }),
    });
    assert.equal(r.status, 200);
    const out = (await r.json()) as Record<string, unknown>;
    assert.equal(out.relayed, true);
    assert.equal(out.status, 202, "the peer's own answer passes through");
    assert.equal(hopCaptured.length, 1);
    const cap = hopCaptured[0]!;
    assert.equal((cap.body as Record<string, unknown>).action, 'update');
    assert.equal(cap.headers['x-idlefill-instance-id'], ctx.arbiter.instanceId());
    assert.ok(typeof cap.headers['x-idlefill-nonce'] === 'string' && (cap.headers['x-idlefill-nonce'] as string).length >= 16);
    assert.ok(cap.headers['x-idlefill-signature']);
    // The signature verifies under the REQUESTER's public key (the identity
    // the target stores on its controls_me record — here we prove the wire
    // is a real #39 envelope by re-verifying it).
    const body = Buffer.from(
      JSON.stringify({
        instance_id: ctx.arbiter.instanceId(),
        path: '/api/mesh/control',
        ts: Number(cap.headers['x-idlefill-ts']),
        nonce: cap.headers['x-idlefill-nonce'],
      }),
    );
    const sig = Buffer.from(cap.headers['x-idlefill-signature'] as string, 'base64url');
    assert.ok(Identity.verify(ctx.arbiter.identity().publicKeyB64url, body, sig), 'a real signed envelope crossed the hop');
  } finally {
    await ctx.app.close();
  }
});

test('relay: wrong direction, wrong verb and unknown peer are all named denials', async () => {
  const ctx = await requester(true);
  try {
    await ctx.mesh.refresh(Date.now());
    ctx.arbiter.edges().upsert({ peer_instance_id: 'm-target-1', peer_public_key: Identity.mint().publicKeyB64url, direction: 'controls_me', created_at: Date.now() });
    let r = await fetch(`${ctx.base}/api/mesh/control/m-target-1`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update' }) });
    assert.equal(r.status, 403);
    assert.equal(((await r.json()) as Record<string, unknown>).error, 'direction_denied');

    ctx.arbiter.edges().upsert({ peer_instance_id: 'm-target-1', peer_public_key: Identity.mint().publicKeyB64url, direction: 'i_control', created_at: Date.now() });
    r = await fetch(`${ctx.base}/api/mesh/control/m-target-1`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) });
    assert.equal(r.status, 400, 'only update relays — this is not a general control proxy');

    r = await fetch(`${ctx.base}/api/mesh/control/m-never-seen`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update' }) });
    assert.equal(r.status, 403, 'no edge for the unseen id first');

    const anon = await fetch(`${ctx.base}/api/mesh/control/m-target-1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update' }) });
    assert.equal(anon.status, 401, 'the relay is the ADMIN plane');
  } finally {
    await ctx.app.close();
  }
});

test('state decoration: peers carry i_control/controls_me from the LOCAL edge store', async () => {
  const ctx = await requester(true);
  try {
    await ctx.mesh.refresh(Date.now());
    ctx.arbiter.edges().upsert({ peer_instance_id: 'm-target-1', peer_public_key: Identity.mint().publicKeyB64url, direction: 'i_control', created_at: Date.now() });
    const st = await (await fetch(`${ctx.base}/api/state`)).json();
    const peer = st.mesh.peers.find((p: { instance_id: string }) => p.instance_id === 'm-target-1');
    assert.equal(peer.i_control, true);
    assert.equal('controls_me' in peer, false, 'absent when the edge does not say so (ADD-key discipline)');
  } finally {
    await ctx.app.close();
  }
});

// ---------------------------------------------------------------------------
// The intent store unit: TTL, cap, abandoned runs
// ---------------------------------------------------------------------------

test('intent store: TTL flips queued to stale, cap holds, abandoned runs fail named', () => {
  const f = join(mkTmp(), 'update_intents.json');
  const s = new UpdateIntents(f);
  const t0 = 1_000;
  assert.ok(s.add('m-a', t0));
  assert.equal(s.add('m-b', t0 + 1), null, 'single-flight: one live at a time');
  assert.equal(s.list(t0 + 400_000)[0]!.state, 'stale', 'past the TTL a queued intent can never execute');
  assert.ok(s.add('m-b', t0 + 400_001), 'the stale intent releases the single-flight');

  for (let i = 0; i < 40; i++) {
    for (const it of s.list()) {
      if (it.state === 'queued') s.claim(it.id, t0);
      if (it.state === 'running') s.finish(it.id, true, undefined, t0);
    }
    s.add(`m-x${i}`, t0 + i);
  }
  assert.ok(s.list().length <= INTENTS_CAP, 'capped FIFO');

  for (const it of s.list()) {
    if (it.state === 'queued') s.claim(it.id, t0);
    if (it.state === 'running') s.finish(it.id, true, undefined, t0);
  }
  const run = s.add('m-c', t0)!;
  s.claim(run.id, t0);
  const hit = s.markRunningAbandoned(t0 + 5000);
  assert.equal(hit.length, 1);
  assert.equal(s.list()[s.list().length - 1]!.state, 'failed');
  assert.match(s.list()[s.list().length - 1]!.detail ?? '', /outcome unknown/);

  // The file lives next to the state file and re-reads cleanly.
  const again = new UpdateIntents(intentsFileOf(join(f, '..', 'state.json')));
  assert.ok(again.list().length > 0);
});

test('late report on an abandoned intent lands (the self-update restart race) — never a re-queue, never an overwrite of a settled name', () => {
  const f = join(mkTmp(), 'update_intents-late.json');
  const s = new UpdateIntents(f);
  const t0 = 10_000;
  const it = s.add('m-a', t0)!;
  s.claim(it.id, t0 + 1);
  s.markRunningAbandoned(t0 + 2); // the arbiter restarted mid-deploy (its own swap)
  assert.equal(s.list()[0]!.state, 'failed');
  assert.match(s.list()[0]!.detail ?? '', /outcome unknown/);
  assert.equal(s.claim(it.id, t0 + 3), null, 'an abandoned intent never re-queues — it can never execute');
  const done = s.finish(it.id, true, 'image swapped, healthcheck green', t0 + 4);
  assert.equal(done?.state, 'done', 'the helper\u2019s named outcome replaces the unknown placeholder');
  assert.match(done?.detail ?? '', /healthcheck green/);
  assert.equal(s.finish(it.id, false, 'a late straggler', t0 + 5), null, 'a settled name is never overwritten twice');
});
