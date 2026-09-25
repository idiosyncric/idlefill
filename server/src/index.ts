/**
 * idlefill server entry: config load + HTTP + WS + the idle tick loop.
 *
 * Run: node dist/index.js (container) or `npm run dev` (tsx).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApi, attachWebSocket } from './api.js';
import { Arbiter } from './arbiter.js';
import { loadConfig } from './config.js';
import { IdleDetector, makeRealActivityFetcher, makeRealLogMtimeSource } from './idle.js';
import { StateStore } from './state.js';

const entryDir = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const cfg = loadConfig(entryDir);

  const store = new StateStore(cfg.state_file);
  const detector = new IdleDetector({
    fetchActivity: makeRealActivityFetcher(),
    logMtime: makeRealLogMtimeSource(),
    llama_swap_url: cfg.llama_swap_url,
    activity_path: cfg.activity_path,
    log_glob: cfg.log_glob,
    idle_seconds: cfg.idle_seconds,
  });
  const arbiter = new Arbiter(store, cfg, detector);

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

  const app = buildApi({ arbiter, cfg, publicDir: join(entryDir, '..', 'public') });
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
