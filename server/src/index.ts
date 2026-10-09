/**
 * idlefill server entry: config load + HTTP + WS + the idle tick loop.
 *
 * Run: node dist/index.js (container) or `npm run dev` (tsx).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApi, attachWebSocket } from './api.js';
import { Arbiter, leaseServerId, WATCHED_SERVER_ID } from './arbiter.js';
import { loadConfig } from './config.js';
import { IdleDetector, makeActivityFetcherFor, makeRealActivityFetcher, makeRealLogMtimeSource } from './idle.js';
import { LoadCollector, newestFeedTps } from './load.js';
import { makeRealModelsFetcher } from './catalog.js';
import type { ActivityFetcher } from './idle.js';
import type { LoadSignalView } from './load.js';
import { FeedDeltaTracker, MetricsStore, HOUR_MS, instrumentArbiterForMetrics } from './metrics.js';
import { CounterDeltaTracker, OmlxUsageReaders } from './omlx.js';
import { buildRosterFetcher, buildHeartbeatSender, MeshFederation, makeRealMeshFetcher } from './mesh.js';
import { StateStore } from './state.js';
import type { ActivityEntry, EngineCounters, RequestsSource, ServerConnection, ServerProvider } from './types.js';

const entryDir = dirname(fileURLToPath(import.meta.url));

/**
 * The dashboard document directory (dashboard cutover, 2026-10-08): the
 * React workspace's BUILT output (dashboard/dist) is the served dashboard.
 * Candidate order:
 *   1. <repo>/dashboard/dist — the dev/tsx layout (entryDir = server/src),
 *      built by `npm run build` (the test.yml gate builds every workspace);
 *   2. ../dashboard/dist — the container layout (/app/dist → /app/dashboard/dist).
 * The candidate that ships the page must exist in the build context
 * (scripts/deploy-server.sh stages it); a missing build is a deploy gate
 * failure, not a runtime fallback.
 */
function dashboardDir(from: string): string {
  const candidates = [
    join(from, '..', '..', 'dashboard', 'dist'), // server/src → repo/dashboard/dist
    join(from, '..', 'dashboard', 'dist'), // /app/dist → /app/dashboard/dist
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return candidates[candidates.length - 1]!;
}

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
  /** The feed rates captured this tick (cleared at the top of each tick). */
  const feedTpsThisTick = new Map<string, number | null>();
  const fetchByKind = (row: ServerConnection): ActivityFetcher => {
    const counters = (c: EngineCounters) => counterDelta.observe(row.id, c);
    const base = makeActivityFetcherFor(row.provider, row.provider === 'strata' ? counters : undefined);
    return async (url: string, auth?: string): Promise<ActivityEntry[]> => {
      const entries = await base(url, auth);
      feedDelta.observe(url, entries);
      // #52 slice 1 (DATA ONLY): capture the feed's newest-entry engine
      // rate when it rides the wire. Display + sample only — never a
      // verdict input. Strata-adapted entries carry no tokens block, so
      // this is a no-op for that kind.
      if ((row.provider ?? 'llama-swap') !== 'strata') {
        feedTpsThisTick.set(row.id, newestFeedTps(entries));
      }
      return entries;
    };
  };
  // #52 slice 1 (DATA ONLY): one load collector per engine row (D1: a
  // module of the fused arbiter). Reads the kind's load surface inside
  // the existing poll tick. NEVER feeds the verdict — a failed load read
  // yields no reading (absent = unset, never a fake zero), and it must
  // not touch the feed-degraded fail-closed plane.
  const loadCollectors = new Map<string, LoadCollector>();
  // The collector's row inputs (provider, url, credential): a change to ANY
  // one rebuilds the collector — including a token the operator sets AFTER
  // the row exists (the D4 strata auth gap, #52 slice 4): a strata row with
  // no credential that later gets one must start carrying it on the SAME
  // tick. The credential rides the meta as '' when absent (absent and ''
  // are the same input to the collector — neither sends a header).
  const loadCollectorMeta = new Map<string, { provider: ServerProvider; url: string; auth_token: string }>();
  const loadCollectorFor = (row: ServerConnection): LoadCollector | null => {
    const kind: ServerProvider = row.provider ?? 'llama-swap';
    const token = row.auth_token ?? '';
    const meta = loadCollectorMeta.get(row.id);
    const stale = meta && (meta.provider !== kind || meta.url !== row.url || meta.auth_token !== token);
    if (stale) {
      loadCollectors.delete(row.id);
      loadCollectorMeta.delete(row.id);
    }
    let c = loadCollectors.get(row.id);
    if (!c) {
      c = new LoadCollector({
        url: row.url,
        provider: kind,
        ...(row.auth_token ? { auth_token: row.auth_token } : {}),
        // The D3 freshness window bounds the veto: a reading older than
        // this is unknown (load_busy absent). The D4 llama-swap threshold
        // (the owner's knob) is UNSET BY DESIGN — absent = no predicate,
        // load_busy absent, the verdict reads as pre-#52.
        stale_window_ms: (cfg.metrics_load_stale_s ?? 45) * 1000,
        llama_swap_busy_gpu_percent: cfg.metrics_llamaswap_busy_gpu_percent,
      });
      loadCollectors.set(row.id, c);
      loadCollectorMeta.set(row.id, { provider: kind, url: row.url, auth_token: token });
    }
    return c;
  };
  /**
   * One load read per engine row per tick (#52 slice 1). Runs AFTER the
   * feed polls (arbiter.tick) so the tick's own feed rate can ride along
   * with no extra HTTP call (D5). Never throws: a collector's failure is
   * an empty reading, and the load axis must not disturb the verdict.
   */
  const loadRead = async (now: number) => {
    for (const row of store.state.servers) {
      const c = loadCollectorFor(row);
      if (!c) continue;
      try {
        await c.read(now, feedTpsThisTick.get(row.id) ?? null);
      } catch {
        /* load reads never throw; a failure is an absent reading */
      }
    }
  };
  /** The row's captured load reading at `now`, or null (no keys ride). */
  const loadView = (row: ServerConnection, now: number): LoadSignalView | null =>
    loadCollectors.get(row.id)?.current(now) ?? null;

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

  const arbiter = new Arbiter(store, cfg, new Map(), {
    detectorFactory: makeDetector,
    // #64 D4: the /v1/models probe fetcher (credentialed per row, same
    // family as the feed fetchers above).
    modelsFetcher: makeRealModelsFetcher(),
    // #52 slice 3 (the LOAD axis veto): the row's captured load reading at
    // `now` — the same per-row source the /api/state signal block and the
    // engine sample line publish. The arbiter folds a FRESH load_busy into
    // the idle verdict (D2); absent = no load axis = pre-#52 verdict.
    loadView,
  });

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
  const mesh = new MeshFederation(cfg, makeRealMeshFetcher(), {
    // The roster rows and the ceremony carry the FLEET-issued ids, not the
    // locally-minted mesh id. The edge fill compares against the fleet id,
    // so it must be the fleet one (arbiter.fleetInstanceId()).
    localInstanceId: () => arbiter.fleetInstanceId() ?? arbiter.instanceId(),
    // Fleet heartbeat (#55 D3, slice 8): the arbiter publishes its OWN live
    // urls (cfg.fleet_own_urls — the operator's reachability declaration) +
    // coarse presence ('online') to the fleet service on the PROPOSED 60 s
    // cadence, RIDING this same poll tick (no second network loop). Gated on
    // ALL of fleet_url / fleet_instance_id / fleet_enrollment_token — any one
    // absent = no heartbeat, byte-for-byte the pre-slice-8 behavior. The
    // sender reuses the sibling fleet_enrollment.json (ensureEnrolled is
    // idempotent — the one-time token is spent once across roster + heartbeat)
    // and signs a fresh nonce per heartbeat with the #55 D1 identity. A
    // failed heartbeat never throws and never touches the last-known peer set
    // (the Service-down rule).
    heartbeatSender: buildHeartbeatSender(cfg, arbiter.identity()),
    localPublicKey: () => arbiter.identity().publicKeyB64url,
    edgeFiller: (localId, edge, peerKey, peerName, direction) => {
      // The caller of the filler is this machine; the peer is the OTHER
      // end of the directed edge (the roster dedupe already skipped
      // self-edges).
      const peer = edge.to === localId ? edge.from : edge.to;
      if (peer === localId) return; // defensive: never form a self-edge
      const edges = arbiter.edges();
      if (edges.get(peer)) return; // ADD-only: the local record wins
      edges.upsert({
        peer_instance_id: peer,
        peer_public_key: peerKey,
        ...(peerName ? { peer_name: peerName } : {}),
        direction,
        created_at: Date.now(),
      });
      arbiter.logMeshEdgeFormed(peer, direction);
    },
  });
  // Roster pull (#55 D3 + D2, slice 7): the SIGNED fetcher — the arbiter
  // enrolls once (one-time token + ed25519 public key + name -> a session
  // credential persisted in the sibling fleet_enrollment.json, 0600, the
  // #55 D2 posture) and signs a fresh nonce per pull (node:crypto only).
  // ALL of fleet_url / fleet_instance_id / fleet_enrollment_token present
  // = the signed pull; any one absent = the pull is a no-op, byte-for-byte,
  // exactly pre-slice-5 (the Service-down rule; a failed enroll/pull is
  // swallowed by pullRoster, the last-known set stands). The #55 D1
  // identity (identity.json) signs; its public key is the one enrolled with
  // the fleet (the arbiter never invents an instance id).
  const rosterFetcher = buildRosterFetcher(cfg, arbiter.identity());

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

  // #52 slice 2 (the LOAD axis): the captured reading rides the row's signal
  // block on /api/state (display only — never a verdict input). loadView is
  // the tick's per-row read (the same source the engine sample line uses).
  const app = buildApi({
    arbiter: apiArbiter,
    cfg,
    publicDir: dashboardDir(entryDir),
    mesh,
    metrics,
    loadSignal: (row, now) => loadView(row, now),
  });
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
      // The VETOED verdict (the #52 load axis, slice 3): the sample's
      // idle field is the verdict the signal block publishes (a fresh
      // load_busy delays it). The load keys ride below from loadView.
      const sig = arbiter.serverSignalVetoed(row.id, now);
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
      // #52 slice 1 (DATA ONLY): the captured load reading rides the
      // sample line (design doc D6: the same appendEngineSample sink,
      // D5: the SAME key names as the signal block). A failed load read
      // rides as absent keys — never a fake zero — and the sample's
      // idle/degraded fields are the UNTOUCHED verdict.
      const load = loadView(row, now);
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
        ...(load ? { ...load } : {}),
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
      // #52 slice 1 (DATA ONLY): one load read per row on the SAME poll
      // cadence. Clear the per-tick feed-rate capture BEFORE the feed
      // polls (arbiter.tick fills it), then run the load reads AFTER
      // them so the feed's own rate rides along (no extra HTTP call, D5).
      // A load read's failure is an absent reading — it never throws
      // here and must not disturb the verdict.
      feedTpsThisTick.clear();
      const { revoked } = await arbiter.tick();
      await loadRead(Date.now());
      // Catalog probe (#64 D4): per-row credentialed GET /v1/models on
      // the SAME poll tick. probeCatalog never throws (a blocked row keeps
      // its declared list); the result publishes through arbiter.catalog()
      // onto /api/state's `catalog` ADD-key for the router.
      await arbiter.probeCatalog();
      for (const r of revoked) {
        log(`lease ${r.lease.lease_id} (${r.lease.project}/${r.lease.job_id}) → ${r.lease.status} [${r.reason}]`);
        broadcast({ type: 'revoked', lease_id: r.lease.lease_id, project: r.lease.project, job_id: r.lease.job_id, reason: r.reason });
        // Provisional lease-end line: the teardown usage report (if it
        // arrives) replaces it with the final tokens (store dedup).
        metrics.recordLeaseEnd(r.lease, { now: Date.now() });
      }
      const now = Date.now();
      // Roster pull (#55 D3, PROPOSED): before the mesh refresh, so a
      // freshly pulled roster peer is pulled in the SAME tick. Never throws
      // (service down = the last-known peer set stands). fleet_url absent =
      // a no-op. (pullRoster throttles to one pull per fleet_roster_pull_ms.)
      await mesh.pullRoster(rosterFetcher, now);
      // Fleet heartbeat (#55 D3 owner choice 1, PROPOSED, slice 8): the
      // arbiter publishes its OWN urls (cfg.fleet_own_urls) + coarse presence
      // on the PROPOSED 60 s cadence — RIDING this same poll tick (no second
      // network loop; at most one heartbeat per interval, not one per poll).
      // Gated on all three fleet keys (any absent = a no-op, byte-for-byte
      // pre-slice-8). Never throws: a failed heartbeat leaves the
      // last-known peer set untouched (the Service-down rule).
      await mesh.sendHeartbeat(now);
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
