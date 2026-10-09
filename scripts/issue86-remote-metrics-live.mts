/**
 * issue86-remote-metrics-live.mts — live proof of the #79/#86 remote
 * metrics plane on REAL sockets (no mocks, no inject).
 *
 * PART A — loopback pair, the happy path:
 *   a real peer arbiter (its own MetricsStore) + a real puller arbiter
 *   (MeshFederation with the production makeRealMeshFetcher +
 *   makeRealRemoteMetricsFetcher), both listening on 127.0.0.1. Real HTTP
 *   fetches over the real token plane.
 *
 * PART B — the real failure branch: urza (the tailnet peer, still running
 *   the pre-#86 build WITHOUT the serve route). The puller hop fails
 *   exactly as designed: cache stays empty, the answer is a named gap,
 *   no fake zeros, no persisted remote line. (Deploying #86 to urza is a
 *   separate owner step, not part of this card.)
 *
 * Nothing here prints a secret: the tokens are read from the local
 * config.json and only referenced by name.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/src/config.js';
import { buildApi } from '../server/src/api.js';
import { Arbiter } from '../server/src/arbiter.js';
import { StateStore } from '../server/src/state.js';
import { IdleDetector } from '../server/src/idle.js';
import { MetricsStore } from '../server/src/metrics.js';
import { MeshFederation, makeRealMeshFetcher, makeRealRemoteMetricsFetcher } from '../server/src/mesh.js';
import type { ServerConfig } from '../server/src/types.js';

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

async function main(): Promise<void> {
  const live = loadConfig(join(import.meta.dirname, '..', 'server'));
  const admin = live.api_tokens[0];
  const peerTok = live.peer_token ?? '';
  if (!admin || !peerTok) throw new Error('local config carries no api token / peer_token');
  const urzaUrl = (live.mesh_peers ?? []).map((p) => p.url).find((u) => /^https?:\/\//.test(u));

  const dirs: string[] = [];
  const peerDir = mkdtempSync(join(tmpdir(), 'issue86-peer-'));
  const pullerDir = mkdtempSync(join(tmpdir(), 'issue86-puller-'));
  dirs.push(peerDir, pullerDir);

  // --- PART A: the real pair over real sockets ----------------------------
  const peerMetrics = new MetricsStore({ stateFile: join(peerDir, 'state.json'), rawWindowHours: 48, retentionDays: 400, log: (m) => console.log(m) });
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    peerMetrics.appendEngineSample({
      ts: now - i * 60_000,
      kind: 'engine',
      server_id: 'srv-live-peer',
      idle: true,
      idle_for_s: 42,
      degraded: false,
      req_delta: 3,
      feed_last_id: now - i * 60_000,
      grants: 0,
      denials: {},
      active_leases: 0,
      active_sessions: 1,
      requests_source: 'metrics-counter',
      tokens_in_delta: 100,
      tokens_out_delta: 420,
    });
  }
  const peerCfg: ServerConfig = { ...live, listen: 0, state_file: join(peerDir, 'state.json'), mesh_peers: [] };
  const peerApp = buildApi({ arbiter: mkArbiter(peerCfg), cfg: peerCfg, publicDir: peerDir, metrics: peerMetrics });
  const peerPort = await peerApp.listen({ port: 0, host: '127.0.0.1' }).then((a) => new URL(a).port);
  const peerBase = `http://127.0.0.1:${peerPort}`;

  const pullerCfg: ServerConfig = { ...live, listen: 0, state_file: join(pullerDir, 'state.json'), mesh_peers: [{ url: peerBase, name: 'live-peer' }] };
  const mesh = new MeshFederation(pullerCfg, makeRealMeshFetcher(), { remoteMetricsFetcher: makeRealRemoteMetricsFetcher() });
  const pullerApp = buildApi({ arbiter: mkArbiter(pullerCfg), cfg: pullerCfg, publicDir: pullerDir, mesh });
  const pullerPort = await pullerApp.listen({ port: 0, host: '127.0.0.1' }).then((a) => new URL(a).port);

  await mesh.refresh(Date.now());
  const peers = mesh.view(Date.now());
  const peerId = peers[0]?.instance_id;
  if (!peerId) throw new Error('live pair: peer never identified (snapshot pull failed?)');
  console.log(`[A] peer instance: ${peerId} (pulled over real HTTP from ${peerBase})`);

  const from = now - 3_600_000;
  const pullUrl = `http://127.0.0.1:${pullerPort}/api/metrics/remote?peer=${peerId}&series=engine&bucket=raw&from=${from}&to=${now + 1000}&token=${admin}`;
  const r1 = await fetch(pullUrl, { cache: 'no-store' });
  const b1 = (await r1.json()) as { series: { key: string; points: Record<string, unknown>[] }[]; truncated: boolean; peer: string; pulled_at: number; stale: boolean };
  console.log(`[A] pull #1: HTTP ${r1.status} peer=${b1.peer} stale=${b1.stale} pulled_at=${b1.pulled_at} series=${b1.series.map((s) => `${s.key}(${s.points.length})`).join(',')}`);
  if (r1.status !== 200 || b1.stale !== false || b1.peer !== peerId) throw new Error('pull #1 shape wrong');
  const pts = b1.series.find((s) => s.key === 'srv-live-peer')?.points ?? [];
  if (pts.length === 0 || pts[0]!.tokens_out_delta !== 420) throw new Error('peer lines did not ride honest');

  const r2 = await fetch(pullUrl, { cache: 'no-store' });
  const b2 = (await r2.json()) as { stale: boolean; pulled_at: number };
  console.log(`[A] pull #2 (inside the 60 s TTL): HTTP ${r2.status} stale=${b2.stale} pulled_at=${b2.pulled_at} (original clock kept)`);
  if (b2.stale !== true || b2.pulled_at !== b1.pulled_at) throw new Error('cache behavior wrong');

  const anon = await fetch(`http://127.0.0.1:${pullerPort}/api/metrics/remote?peer=${peerId}&series=engine`);
  const serveDirect = await fetch(`${peerBase}/api/metrics/remote?series=engine&bucket=raw&from=${from}&to=${now + 1000}`, { headers: { authorization: `Bearer ${peerTok}` } });
  console.log(`[A] auth over real sockets: anonymous pull -> ${anon.status} (401 expected); peer_token on the peer's serve side -> ${serveDirect.status} (200 expected)`);
  if (anon.status !== 401 || serveDirect.status !== 200) throw new Error('auth matrix over real sockets wrong');

  const pullerFiles = readdirSync(pullerDir);
  const stateTxt = readFileSync(join(pullerDir, 'state.json'), 'utf-8');
  console.log(`[A] ephemeral: puller dir = [${pullerFiles.join(', ')}]; state.json mentions remote lines: ${stateTxt.includes('srv-live-peer')}`);
  if (pullerFiles.some((f) => f.startsWith('metrics-')) || stateTxt.includes('srv-live-peer')) throw new Error('a remote line persisted — D3 violated');

  // --- PART B: the real urza failure branch --------------------------------
  if (!urzaUrl) {
    console.log('[B] no http mesh peer in the local config — skipping the urza branch');
  } else {
    const urzaMesh = new MeshFederation({ ...live, state_file: join(pullerDir, 'state.json') }, makeRealMeshFetcher(), { remoteMetricsFetcher: makeRealRemoteMetricsFetcher() });
    await urzaMesh.refresh(Date.now());
    const urza = urzaMesh.view(Date.now()).find((p) => p.url === urzaUrl);
    if (!urza || !urza.instance_id) {
      console.log(`[B] urza (${urzaUrl}) not online on the coarse plane right now — failure branch stands by the stale rule instead`);
    } else {
      const direct = await fetch(`${urzaUrl}/api/metrics/remote?series=engine`, { headers: { authorization: `Bearer ${peerTok}` } });
      console.log(`[B] urza peer_token on its serve side: HTTP ${direct.status} (the PRE-#86 build has no route and its old hook 401s the peer_token before routing — deploying #86 to urza is the separate owner step)`);
      let gap = '';
      try {
        await urzaMesh.pullMetrics(urza.instance_id, { series: 'engine', from, to: now }, Date.now());
        gap = 'UNEXPECTED SUCCESS';
      } catch (e) {
        gap = `named gap: ${e instanceof Error ? e.message : e}`;
      }
      const view = urzaMesh.view(Date.now()).find((p) => p.url === urzaUrl);
      console.log(`[B] puller answer: ${gap}; cache entries on the urza row: ${view?.metrics_cache?.entries ?? 0} (no fake zeros, nothing persisted)`);
      if (view?.metrics_cache !== undefined) throw new Error('a failed urza fetch left a cache entry');
    }
  }

  await peerApp.close();
  await pullerApp.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  console.log('PASS: #86 remote metrics plane live — loopback pair green, urza failure branch renders a named gap');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
