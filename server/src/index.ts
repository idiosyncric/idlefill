/**
 * idlefill server entry: config load + HTTP + WS + the idle tick loop.
 *
 * Run: node dist/index.js (container) or `npm run dev` (tsx).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApi, attachWebSocket } from './api.js';
import { Arbiter, WATCHED_SERVER_ID } from './arbiter.js';
import { loadConfig } from './config.js';
import { IdleDetector, makeRealActivityFetcher, makeRealLogMtimeSource } from './idle.js';
import { MeshFederation, makeRealMeshFetcher } from './mesh.js';
import { StateStore } from './state.js';
import type { ServerConnection } from './types.js';

const entryDir = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const cfg = loadConfig(entryDir);

  const store = new StateStore(cfg.state_file);

  // Per-engine idle watching (#38): one detector per declared server row.
  // The watched server keeps the config's log_glob; other rows use their
  // own row.log_glob (absent = log signal disabled for that engine).
  const fetchActivity = makeRealActivityFetcher();
  const logMtime = makeRealLogMtimeSource();
  const makeDetector = (row: ServerConnection): IdleDetector =>
    new IdleDetector({
      fetchActivity,
      logMtime,
      llama_swap_url: row.url,
      activity_path: row.activity_path,
      log_glob: row.log_glob ?? (row.id === WATCHED_SERVER_ID ? cfg.log_glob : ''),
      idle_seconds: cfg.idle_seconds,
    });

  const arbiter = new Arbiter(store, cfg, new Map(), { detectorFactory: makeDetector });

  // Mesh federation read plane (#50): pull coarse peer snapshots on the
  // poll cadence. Ephemeral — never written to state.json. No peers
  // configured = the module stays inert (the /api/mesh route still
  // answers with this instance's own snapshot for peers that list us).
  const mesh = new MeshFederation(cfg, makeRealMeshFetcher());

  // Persisted operator settings re-hydrate onto the live config objects:
  //  - project rows (pause state + per-project grant-knob overrides) replace
  //    the config-file rows (config is the declaration; state is the truth);
  //  - declared server connections seed from config on first load.
  const s = store.state;
  const byName = new Map(s.projects.map((p) => [p.name, p]));
  for (const p of cfg.projects) {
    const row = byName.get(p.name);
    if (row) {
      p.paused = row.paused === true;
      if (typeof row.idle_seconds === 'number') p.idle_seconds = row.idle_seconds;
      if (typeof row.max_concurrent_leases === 'number') p.max_concurrent_leases = row.max_concurrent_leases;
      if (typeof row.lease_ttl_seconds === 'number') p.lease_ttl_seconds = row.lease_ttl_seconds;
    }
  }
  arbiter.syncProjectRows();
  arbiter.ensureServersSeeded();
  store.save();

  // Restore lease statuses across a server restart: any lease that was
  // `active` when the process died is expired (its TTL ran out while we
  // weren't here — a dead holder cannot hold the box hostage).
  const now = Date.now();
  for (const lease of store.state.leases) {
    if (lease.status === 'active' && now >= lease.expires_at) {
      lease.status = 'expired';
      lease.end_reason = 'ttl_expired';
      lease.ended_at = now;
      store.appendEvent({ kind: 'lease_revoked', project: lease.project, lease_id: lease.lease_id, detail: 'expired at server restart' });
    }
  }
  store.save();

  const app = buildApi({ arbiter, cfg, publicDir: join(entryDir, '..', 'public'), mesh });
  const wss = attachWebSocket(app, arbiter, cfg);
  const broadcast = (app as unknown as Record<string, unknown>).broadcastWs as (obj: unknown) => void;

  const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

  // --- the idle tick loop ---
  let stopped = false;
  const tickOnce = async () => {
    try {
      const { revoked } = await arbiter.tick();
      for (const r of revoked) {
        log(`lease ${r.lease.lease_id} (${r.lease.project}/${r.lease.job_id}) → ${r.lease.status} [${r.reason}]`);
        broadcast({ type: 'revoked', lease_id: r.lease.lease_id, project: r.lease.project, job_id: r.lease.job_id, reason: r.reason });
      }
    } catch (err) {
      // A tick must never kill the process (network blips, FS hiccups).
      log(`tick error: ${err instanceof Error ? err.message : err}`);
    }
  };
  await tickOnce(); // first poll immediately so state is fresh at boot
  const timer = setInterval(tickOnce, cfg.poll_ms);
  timer.unref?.();

  // --- listen ---
  await app.listen({ port: cfg.listen, host: '0.0.0.0' });
  log(
    `idlefill arbiter listening on :${cfg.listen} — ` +
    `idle after ${cfg.idle_seconds}s, poll ${cfg.poll_ms}ms, ` +
    `llama_swap=${cfg.llama_swap_url}, log_glob=${cfg.log_glob || '(disabled)'}, ` +
    `projects=${cfg.projects.map((p) => p.name).join(',') || '(none)'}, state=${cfg.state_file}`,
  );

  const shutdown = async (sig: string) => {
    if (stopped) return;
    stopped = true;
    log(`${sig}: shutting down`);
    clearInterval(timer);
    try {
      await app.close();
      wss.close();
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[idlefill] fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exit(1);
});
