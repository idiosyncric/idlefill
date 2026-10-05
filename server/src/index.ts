/**
 * idlefill server entry: config load + HTTP + WS + the idle tick loop.
 *
 * Run: node dist/index.js (container) or `npm run dev` (tsx).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApi, attachWebSocket } from './api.js';
import { Arbiter, leaseServerId, WATCHED_SERVER_ID } from './arbiter.js';
import { loadConfig } from './config.js';
import { IdleDetector, makeActivityFetcherFor, makeRealActivityFetcher, makeRealLogMtimeSource } from './idle.js';
import type { ActivityFetcher } from './idle.js';
import { FeedDeltaTracker, MetricsStore, HOUR_MS, instrumentArbiterForMetrics } from './metrics.js';
import { CounterDeltaTracker, OmlxUsageReaders } from './omlx.js';
import { MeshFederation, makeRealMeshFetcher } from './mesh.js';
import { StateStore } from './state.js';
import type { ActivityEntry, EngineCounters, RequestsSource, ServerConnection, ServerProvider } from './types.js';

const entryDir = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const cfg = loadConfig(entryDir);
  const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

  const store = new StateStore(cfg.state_file);

  // Request delta (#51 D3): the detector already fetches the activity feed
  // every poll; wrap the shared fetcher so each successful poll records its
  // newest entry id. A backwards id (llama-swap restart) reads as an
  // unknown delta, never a negative count.
  const feedDelta = new FeedDeltaTracker();
  // Engine-reported counters (#62): strata /metrics totals ride the SAME
  // poll as the feed adapter; the omlx sqlite store is summed on the
  // sample tick. Keyed per server row. Deltas follow FeedDeltaTracker's
  // posture: first sample + backwards counters read unknown, never
  // negative.
  const counterDelta = new CounterDeltaTracker();
  const omlxReaders = new OmlxUsageReaders(log);
  // One wrapped fetch per provider kind (#60 B, #62): the kind selects the
  // PARSE (llama-swap feed contract vs strata /metrics); the transport,
  // the credential header, and the delta observers are shared.
  const fetchByKind = (row: ServerConnection): ActivityFetcher => {
    const counters = (c: EngineCounters) => counterDelta.observe(row.id, c);
    const base = makeActivityFetcherFor(row.provider, row.provider === 'strata' ? counters : undefined);
    return async (url: string, auth?: string): Promise<ActivityEntry[]> => {
      const entries = await base(url, auth);
      feedDelta.observe(url, entries);
      return entries;
    };
  };

  // Per-engine idle watching (#38): one detector per declared server row.
  // The watched server keeps the config's log_glob; other rows use their
  // own row.log_glob (absent = log signal disabled for that engine).
  const logMtime = makeRealLogMtimeSource();
  const makeDetector = (row: ServerConnection): IdleDetector =>
    new IdleDetector({
      fetchActivity: fetchByKind(row),
      logMtime,
      llama_swap_url: row.url,
      activity_path: row.activity_path,
      log_glob: row.log_glob ?? (row.id === WATCHED_SERVER_ID ? cfg.log_glob : ''),
      // Per-server credential (#60 B): the watched row's seed comes from
      // config.server_auth_token at boot; other rows carry their own.
      ...(row.auth_token ? { auth_token: row.auth_token } : {}),
      // Provider kind (#62): names the fail-closed reason when nothing resolves.
      ...(row.provider ? { provider: row.provider } : {}),
      idle_seconds: cfg.idle_seconds,
    });

  const arbiter = new Arbiter(store, cfg, new Map(), { detectorFactory: makeDetector });

  // Metrics retention store (#51): append-only JSONL next to state.json.
  // The recorder never throws into its caller; the rollup reads raw files.
  const metrics = new MetricsStore({
    stateFile: cfg.state_file,
    rawWindowHours: cfg.metrics_raw_window_hours ?? 48,
    retentionDays: cfg.metrics_retention_days ?? 400,
    log,
  });
  // Denials ride as counters inside the engine sample (D5): the wrapper
  // feeds the per-engine window from every requestLease outcome the API
  // sees, without arbiter.ts changing.
  const apiArbiter = instrumentArbiterForMetrics(arbiter, metrics);

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

  const app = buildApi({ arbiter: apiArbiter, cfg, publicDir: join(entryDir, '..', 'public'), mesh, metrics });
  const wss = attachWebSocket(app, arbiter, cfg);
  const broadcast = (app as unknown as Record<string, unknown>).broadcastWs as (obj: unknown) => void;

  // --- the idle tick loop ---
  let stopped = false;

  // One engine sample per poll tick (#51 D4): the idle verdict, request
  // delta from the feed ids, the grant/denial window counters, and the
  // active lease/session counts. Sessions ride as a count until #45 lands
  // (D2: no second session history).
  // #62: the counter-backed kinds (strata /metrics totals, omlx usage
  // store) replace the feed-id delta as the request source and add engine
  // token truth. llama-swap rows keep feed-id deltas exactly as before.
  const sampleEngines = (now: number) => {
    for (const row of store.state.servers) {
      const sig = arbiter.serverSignal(row.id, now);
      if (!sig) continue; // no detector = no sample for this row
      const url = `${String(row.url ?? '').replace(/\/$/, '')}${row.activity_path ?? ''}`;
      const kind: ServerProvider = row.provider ?? 'llama-swap';

      let req_delta: number | null = null;
      let feed_last_id: number | null = null;
      let requests_source: RequestsSource = 'feed-delta';
      let tokens_in_delta: number | null | undefined = undefined;
      let tokens_out_delta: number | null | undefined = undefined;

      if (kind === 'omlx') {
        // Engine truth from the usage store, diffed like a counter. The
        // read is a SUM over the hourly table — cheap (rows are per
        // hour+model), and the store is read-only (query_only pragma).
        const totals = omlxReaders.forPath(cfg.omlx_usage_db).readTotals();
        if (totals) counterDelta.observe(row.id, totals);
        const d = counterDelta.delta(row.id);
        req_delta = d.req_delta;
        tokens_in_delta = d.tokens_in_delta;
        tokens_out_delta = d.tokens_out_delta;
        requests_source = 'sqlite';
      } else if (kind === 'strata') {
        // The strata fetcher observed /metrics totals on this same poll;
        // the feed-id delta rides as unknown because the adapter's ids
        // are derived from the counter anyway (the counter is the truth).
        const d = counterDelta.delta(row.id);
        req_delta = d.req_delta;
        tokens_in_delta = d.tokens_in_delta;
        tokens_out_delta = d.tokens_out_delta;
        requests_source = 'metrics-counter';
      } else {
        const fd = feedDelta.delta(url);
        req_delta = fd.req_delta;
        feed_last_id = fd.feed_last_id;
      }

      const win = metrics.takeWindow(row.id);
      const activeLeases = arbiter.activeLeases(now).filter((l) => leaseServerId(l) === row.id).length;
      const activeSessions = store.state.sessions.filter((sess) => leaseServerId(sess) === row.id).length;
      metrics.appendEngineSample({
        ts: now,
        kind: 'engine',
        server_id: row.id,
        idle: sig.idle,
        idle_for_s: sig.idle_for_s,
        degraded: sig.signal_degraded,
        req_delta,
        feed_last_id,
        grants: win.grants,
        denials: win.denials,
        active_leases: activeLeases,
        active_sessions: activeSessions,
        requests_source,
        ...(tokens_in_delta !== undefined ? { tokens_in_delta, tokens_out_delta } : {}),
      });
    }
  };

  // One rollup when the clock crosses an hour boundary (#51 D5): the
  // rollup reads the raw files, so a restart mid-hour loses nothing —
  // the first tick after boot rolls the previous completed hour too.
  let lastRolledHour: number | null = null;
  const rollupDue = (now: number) => {
    const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    if (lastRolledHour === null) {
      metrics.rollupHour(currentHour - HOUR_MS, now);
      lastRolledHour = currentHour;
      return;
    }
    if (currentHour > lastRolledHour) {
      // Catch up every completed hour since the last roll (bounded: a
      // long-stopped arbiter does not re-scan months of raw files).
      for (let h = lastRolledHour; h < currentHour && h >= currentHour - 24 * HOUR_MS; h += HOUR_MS) {
        metrics.rollupHour(h, now);
      }
      lastRolledHour = currentHour;
    }
  };

  const tickOnce = async () => {
    try {
      const { revoked } = await arbiter.tick();
      for (const r of revoked) {
        log(`lease ${r.lease.lease_id} (${r.lease.project}/${r.lease.job_id}) → ${r.lease.status} [${r.reason}]`);
        broadcast({ type: 'revoked', lease_id: r.lease.lease_id, project: r.lease.project, job_id: r.lease.job_id, reason: r.reason });
        // Provisional lease-end line: the teardown usage report (if it
        // arrives) replaces it with the final tokens (store dedup).
        metrics.recordLeaseEnd(r.lease, { now: Date.now() });
      }
      const now = Date.now();
      // Mesh pull (#50): refresh peer snapshots on the SAME poll cadence.
      // (The #50 report said "refresh rides the existing tickOnce" — it
      // never actually did: mesh.refresh had no production caller, so the
      // read plane could never federate live. Wired here for #60 A4.)
      // refresh() never throws — each peer's failure rides its own row.
      if (mesh.enabled) await mesh.refresh(now);
      sampleEngines(now);
      rollupDue(now);
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
