/**
 * Fastify routes for the arbiter.
 *
 * Auth: every API route requires one of the configured tokens, presented either as the Bearer
 * credential in the Authorization header or as a `token` query parameter.
 * The dashboard page itself is unauthenticated (documented in README);
 * `/api/state` is a read-only endpoint that is
 * public ONLY when the request carries no token at all — if a token is
 * present and wrong, it is rejected (401). This matches the spec's
 * "dashboard itself is unauthenticated read-only state" while keeping the
 * authenticated API surface strict.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import os from 'node:os';
import fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { WebSocketServer } from 'ws';
import { utcDay, type Arbiter, WATCHED_SERVER_ID } from './arbiter.js';
import { seriesKeyOf, type MetricsBucket, type MetricsSeries, type MetricsStore } from './metrics.js';
import { buildMeshSnapshot, type MeshFederation } from './mesh.js';
import { isLoopbackAddress } from './catalog.js';
import type { ClientRecord, CycleStatusRow, ProjectAllocation, QueuePreviewRow, RebuildRunState, ServerConfig, ServerConnection } from './types.js';

export interface ApiDeps {
  arbiter: Arbiter;
  cfg: ServerConfig;
  /** Path to the static dashboard. */
  publicDir: string;
  /**
   * Mesh federation read plane (#50). Optional so existing callers/tests
   * stay valid; absent = no mesh (no /api/mesh route beyond the local
   * snapshot, no `mesh` key on /api/state).
   */
  mesh?: MeshFederation;
  /**
   * Metrics retention store (#51). Optional so existing callers/tests stay
   * valid; absent = GET /api/metrics answers 501 (the store is not wired).
   */
  metrics?: MetricsStore;
}

/** Validate a request token against the configured set. */
export function isValidToken(cfg: ServerConfig, token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false;
  return cfg.api_tokens.includes(token);
}

/**
 * Mesh read-plane auth (#50 D2): the fleet peer_token is read-only and
 * scoped to GET /api/mesh ONLY. It never unlocks any other /api/* route,
 * and local admin tokens always work on /api/mesh (the operator's own
 * surfaces read the same endpoint).
 */
export function isPeerToken(cfg: ServerConfig, token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false;
  const pt = cfg.peer_token;
  return typeof pt === 'string' && pt !== '' && token === pt;
}

/**
 * Parse the `limit` query param (1..500, default 10) for history windows.
 * Tolerates both Fastify query shapes (parsed object or raw query string).
 */
function queryLimit(req: { query: unknown }): number {
  let v: unknown = null;
  const q = req.query;
  if (typeof q === 'string') v = new URLSearchParams(q).get('limit');
  else if (q !== null && typeof q === 'object') v = (q as Record<string, unknown>).limit;
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? Math.min(500, n) : 10;
}

function bearer(req: { headers: Record<string, unknown>; query: unknown }): string | null {
  const h = req.headers['authorization'];
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const q = (typeof req.query === 'object' && req.query !== null ? req.query : {}) as Record<string, unknown>;
  if (typeof q.token === 'string' && q.token.length > 0) return q.token;
  return null;
}

/**
 * Project view for the dashboard: the project config + today's budget, the
 * connected workers allocated to it (clients that report this project, with
 * their published stats), and the EFFECTIVE scheduling knobs (per-project
 * overrides win; unset = the global). Workers are ordered online-first,
 * then by name.
 */
function projectView(
  arbiter: Arbiter,
  cfg: ServerConfig,
  clients: { name: string; last_seen: number; projects: { name: string; model: string; estimated_seconds: number; queue_depth: number; queue_preview?: QueuePreviewRow[]; stats?: Record<string, number | string>; last_rebuild?: RebuildRunState; cycles?: CycleStatusRow[]; cycle_cap?: number }[]; version?: string; protocol?: number; revision?: string; gate_posture?: 'armed' | 'fail_open'; proxy_port?: number; daemon_behind?: boolean }[],
  day: string,
  now: number,
  today: Record<string, { finished: number; failed: number }>,
) {
  return cfg.projects.map((p) => {
    const eff = arbiter.projectEffectiveSettings(p.name);
    const workers = clients
      .filter((c) => (c.projects ?? []).some((x) => x.name === p.name))
      .map((c) => {
        const alloc = (c.projects ?? []).find((x) => x.name === p.name);
        return {
          client: c.name,
          model: alloc?.model ?? '',
          estimated_seconds: alloc?.estimated_seconds ?? 0,
          queue_depth: alloc?.queue_depth ?? 0,
          // The client's queue rows (priority order) for the queue detail
          // page — published verbatim, never computed by the arbiter.
          queue_preview: alloc?.queue_preview ?? [],
          online: now - c.last_seen < 90_000,
          stats: alloc?.stats ?? {},
          // Scheduled rebuild run state (issue #3): stored + echoed verbatim
          // from the client's heartbeat. Absent = never run / not configured.
          ...(alloc?.last_rebuild ? { last_rebuild: alloc.last_rebuild } : {}),
          // Dev-cycle rows (#53 D9.3): echoed verbatim from the allocation,
          // exception-only like last_rebuild — absent when the worker reports
          // no cycles. The strip renders per-cycle rows; no rollup here.
          ...(alloc?.cycles ? { cycles: alloc.cycles } : {}),
          ...(alloc?.cycle_cap !== undefined ? { cycle_cap: alloc.cycle_cap } : {}),
          // Version handshake (exception-only: absent on pre-version
          // clients, so the row carries the keys only when the client
          // reported them — the dashboard renders them exception-only too).
          ...(c.version ? { version: c.version } : {}),
          ...(c.protocol !== undefined ? { protocol: c.protocol } : {}),
          // Code-staleness (issue #49): the daemon's boot commit, same
          // exception-only rule (absent on pre-#49 clients).
          ...(c.revision ? { revision: c.revision } : {}),
          // Gate posture (#41): the router's own armed-vs-fail-open state,
          // echoed exception-only (absent on pre-#41 clients AND on a daemon
          // running with no session gate — both render the row unchanged).
          ...(c.gate_posture ? { gate_posture: c.gate_posture } : {}),
          // Session launcher (#43): the port the router's proxy bound, so
          // the Sessions view can mint sessions against THIS machine.
          ...(c.proxy_port ? { proxy_port: c.proxy_port } : {}),
          // Code-staleness verdict (#61 step 3 A1): the client's own
          // boot-vs-HEAD comparison, echoed exception-only like the other
          // display facts (absent = current or a pre-#61-step-3 client —
          // both render the row unchanged).
          ...(c.daemon_behind ? { daemon_behind: true } : {}),
        };
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || a.client.localeCompare(b.client));
    return {
      ...p,
      budget_today: arbiter.projectBudget(p.name, day),
      workers,
      today: today[p.name] ?? { finished: 0, failed: 0 },
      scheduling: {
        paused: p.paused,
        idle_seconds: eff.idle_seconds,
        max_concurrent_leases: eff.max_concurrent_leases,
        lease_ttl_seconds: eff.lease_ttl_seconds,
        daily_token_cap: p.daily_token_cap,
        // The per-project overrides in effect (absent key = inherits the
        // global value).
        overrides: {
          idle_seconds: p.idle_seconds ?? null,
          max_concurrent_leases: p.max_concurrent_leases ?? null,
          lease_ttl_seconds: p.lease_ttl_seconds ?? null,
        },
        // The global knobs a knob falls back to while its override is unset
        // — the dashboard's settings editor shows them as the placeholder.
        global: {
          idle_seconds: cfg.idle_seconds,
          max_concurrent_leases: cfg.max_concurrent_leases,
          lease_ttl_seconds: cfg.lease_ttl_seconds,
        },
      },
    };
  });
}

/**
 * Today's (UTC) completed work for a project, computed from lease
 * end-records already in state — the dashboard's results row. A lease that
 * terminated with status 'finished' counts as finished; any other terminal
 * lease (revoked: client-reported failure / preemption, or expired) counts
 * as failed. Active leases do not count.
 */
function todayTotals(leases: { project: string; status: string; ended_at?: number }[], day: string) {
  const per: Record<string, { finished: number; failed: number }> = {};
  for (const l of leases) {
    if (l.status === 'active') continue;
    if (!l.ended_at || utcDay(l.ended_at) !== day) continue;
    const e = (per[l.project] ??= { finished: 0, failed: 0 });
    if (l.status === 'finished') e.finished += 1;
    else e.failed += 1;
  }
  return per;
}

/**
 * The declared inference-server connections with their models expanded into
 * the queueable-resource rows the dashboard renders. EVERY watched server
 * carries its live signal object (the arbiter polls one detector per server
 * row); a row whose source has no detector yet carries `signal: null` and
 * is fail-closed for grants.
 */
function serverView(arbiter: Arbiter, cfg: ServerConfig, now: number) {
  const s = arbiter['store'].state;
  const activeClients = new Set(arbiter.activeLeases(now).map((l) => l.client_name));
  const runningModels = new Set<string>();
  const queuedByModel = new Map<string, number>();
  for (const c of s.clients) {
    const online = now - (c.last_seen ?? 0) < 90_000;
    for (const a of c.projects ?? []) {
      if (!a.model) continue;
      if (online) queuedByModel.set(a.model, (queuedByModel.get(a.model) ?? 0) + (a.queue_depth ?? 0));
      if (activeClients.has(c.name)) runningModels.add(a.model);
    }
  }
  return s.servers.map((row: ServerConnection) => {
    const sig = arbiter.serverSignal(row.id, now);
    const lastAct = sig?.last_activity ?? null;
    const signal = sig
      ? {
          idle: sig.idle,
          idle_for_s: sig.idle_for_s,
          last_activity: lastAct ? { ...lastAct, age_s: Math.max(0, Math.round((now - lastAct.ts) / 1000)) } : null,
          last_log_write_age_s: sig.last_log_write ? Math.max(0, Math.round((now - sig.last_log_write) / 1000)) : null,
          degraded: sig.signal_degraded,
          degraded_reason: sig.degraded_reason,
          // Feed-off providers (#60 A1): false = this row declares no feed
          // and log mtime alone carries the verdict. ADD key.
          feed_enabled: sig.feed_enabled,
          // Honest fail-closed (#62): why NO signal can resolve on a
          // feed-less row whose log glob matches nothing. ADD key.
          no_signal_reason: sig.no_signal_reason ?? null,
          reidle_gated: arbiter.reidleGated(row.id),
          // Session folding (#32): the newest session activity on this server.
          session_last_activity_age_s: (() => {
            const a = arbiter.sessionActivityOn(row.id, now);
            return a === null ? null : Math.max(0, Math.round((now - a) / 1000));
          })(),
        }
      : null;
    // Model inventory: the last /v1/models probe that ANSWERED wins over
    // the operator-declared list (the same merge the #64 catalog publishes
    // — a failed probe never silently loses the declaration). model_source
    // names which one the row shows; probed_at is the "last seen" for the
    // inventory (null = the probe never answered since boot). ADD keys.
    const probed = arbiter.probedModels(row.id);
    const inventory = probed ?? row.models;
    // The row is echoed verbatim — so the credential (#60 B) is STRIPPED
    // here. auth_token is write-only: this view feeds GET /api/servers AND
    // the anonymous /api/state, and the dashboard renders both. A boolean
    // (auth_set) tells the form a token exists without revealing it. ADD
    // key.
    const { auth_token, ...rowPublic } = row;
    return {
      ...rowPublic,
      auth_set: auth_token !== undefined && auth_token !== '',
      watched: sig !== null,
      signal,
      model_source: probed !== null ? 'probed' : 'declared',
      probed_at: arbiter.probedAt(row.id),
      models: inventory.map((m) => ({ name: m, running: runningModels.has(m), queued: queuedByModel.get(m) ?? 0 })),
    };
  });
}

/** Attach the API routes (authed) and the dashboard (public read). */
export function buildApi(deps: ApiDeps): FastifyInstance {
  const { arbiter, cfg, publicDir, mesh, metrics } = deps;

  const app = fastify({ logger: false });
  app.decorate('idlefill', { arbiter, cfg, publicDir });

  // --- auth guard for /api/* (except the documented public read paths) ---
  app.addHook('onRequest', async (req, reply) => {
    // req.url carries the query string (e.g. "/api/state?limit=10") — strip it
    // for the exact-path check, or the anonymous public read of /api/state
    // would 401 the moment the dashboard appends ?limit=N.
    const path = (req.url ?? '').split('?')[0];
    if (!req.raw.url?.startsWith('/api/')) return;
    const token = bearer(req);
    // Public read paths: none by design, EXCEPT /api/state when the caller
    // presents no token at all (anonymous dashboard poll). A wrong token on
    // ANY /api/* path is a 401.
    const isAnonymousState = path === '/api/state' && req.method === 'GET' && token === null;
    if (isAnonymousState) return;
    // Metrics read plane (#51 D6): the /api/state anonymous exception
    // extends to GET /api/metrics — the dashboard is anonymous today and the
    // tailnet is the trust boundary. A wrong token is still a 401 (it falls
    // through to the strict check below), and the fleet peer_token does NOT
    // unlock this route: isMeshRead below is scoped to /api/mesh only.
    const isAnonymousMetrics = path === '/api/metrics' && req.method === 'GET' && token === null;
    if (isAnonymousMetrics) return;
    // Mesh read plane (#50 D2): the fleet peer_token is read-only and works
    // ONLY on GET /api/mesh. It never unlocks any other route; a wrong
    // token anywhere (including here) is still a 401.
    const isMeshRead = path === '/api/mesh' && req.method === 'GET' && isPeerToken(cfg, token);
    if (isMeshRead) return;
    if (!isValidToken(cfg, token)) {
      await reply.code(401).send({ error: 'unauthorized', hint: 'present a valid token (Authorization: Bearer or ?token=)' });
      return;
    }
  });

  // ------------------------------------------------------------------
  // Clients
  // ------------------------------------------------------------------

  app.post('/api/clients/register', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; ip?: string; projects?: ProjectAllocation[]; version?: unknown; protocol?: unknown; revision?: unknown; gate_posture?: unknown; proxy_port?: unknown; aggregate_port?: unknown; daemon_behind?: unknown; client_log?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'name required' });
    const remote = (req.ip ?? '').split(':').pop() ?? 'unknown';
    const cleanStats = (raw: unknown): Record<string, number | string> | undefined => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
      const out: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (Object.keys(out).length >= 24) break; // a stat row is display data, not a dump
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        else if (typeof v === 'string' && v.trim() !== '' && v.length <= 64) out[k] = v;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    };
    // The queue preview (the dashboard's queue page data) is display-only, so
    // bound it hard: ≤100 rows, job_id ≤128 chars, title ≤200 chars,
    // company ≤64 chars, finite score / non-negative integer attempts.
    // Unbounded client text would bloat the arbiter's state file on every
    // save — the same reason stats are capped above.
    const cleanPreview = (raw: unknown): QueuePreviewRow[] | undefined => {
      if (!Array.isArray(raw)) return undefined;
      const out: QueuePreviewRow[] = [];
      for (const r of raw as Record<string, unknown>[]) {
        if (out.length >= 100) break;
        if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
        const job_id = typeof r.job_id === 'string' && r.job_id.trim() !== '' ? r.job_id.slice(0, 128) : '';
        if (!job_id) continue;
        out.push({
          job_id,
          title: typeof r.title === 'string' && r.title.trim() !== '' ? r.title.slice(0, 200) : job_id,
          company: typeof r.company === 'string' && r.company.trim() !== '' ? r.company.slice(0, 64) : 'unknown',
          score: typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : null,
          attempts: typeof r.attempts === 'number' && Number.isInteger(r.attempts) && r.attempts >= 0 ? r.attempts : 0,
        });
      }
      return out.length > 0 ? out : undefined;
    };
    // Scheduled rebuild run state (issue #3): client-published display data,
    // same discipline as stats/preview — stored verbatim, never computed.
    // Sanitized: every field must be a finite number, else the row is
    // dropped (a malformed report must not bloat or poison the state file).
    const cleanRebuild = (raw: unknown): RebuildRunState | undefined => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
      const r = raw as Record<string, unknown>;
      const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
      if (!fin(r.last_run_ts) || !fin(r.exit_code) || !fin(r.duration_ms) || !fin(r.queue_before) || !fin(r.queue_after)) {
        return undefined;
      }
      return {
        last_run_ts: r.last_run_ts,
        exit_code: r.exit_code,
        duration_ms: r.duration_ms,
        queue_before: r.queue_before,
        queue_after: r.queue_after,
      };
    };
    // Dev-cycle status rows (#53 D9.3): client-published display data, same
    // discipline as preview/rebuild — stored verbatim, never computed.
    // Bound it hard like the preview: ≤20 rows (the client caps at 20 too),
    // cycle_id trim ≤128, status one of planned|running|paused|done, every
    // numeric field a finite integer ≥ 0, stage one of item|gate. A row
    // failing shape checks is DROPPED, never stored; a non-array or an
    // all-dropped array means the key is absent.
    const cleanCycles = (raw: unknown): CycleStatusRow[] | undefined => {
      if (!Array.isArray(raw)) return undefined;
      const uint = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
      const out: CycleStatusRow[] = [];
      for (const r of raw as Record<string, unknown>[]) {
        if (out.length >= 20) break;
        if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
        const cycle_id = typeof r.cycle_id === 'string' && r.cycle_id.trim() !== '' ? r.cycle_id.trim().slice(0, 128) : '';
        if (!cycle_id) continue;
        const status = r.status;
        if (status !== 'planned' && status !== 'running' && status !== 'paused' && status !== 'done') continue;
        if (!uint(r.items_total) || !uint(r.item_index) || !uint(r.settled) || !uint(r.passed) || !uint(r.quarantined)) continue;
        const stage = r.stage;
        if (stage !== 'item' && stage !== 'gate') continue;
        out.push({ cycle_id, status, items_total: r.items_total, item_index: r.item_index, settled: r.settled, passed: r.passed, quarantined: r.quarantined, stage });
      }
      return out.length > 0 ? out : undefined;
    };
    // cycle_cap: the client's effective cycle_max_in_flight (0 = knob
    // absent). A plain display number — finite integer ≥ 0, else dropped.
    const cleanCycleCap = (raw: unknown): number | undefined =>
      typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
    const projects = Array.isArray(body.projects)
      ? body.projects
          .filter((p) => p && typeof p.name === 'string' && p.name.trim() !== '')
          .map((p) => ({
            name: p.name.trim(),
            model: typeof p.model === 'string' ? p.model : '',
            estimated_seconds: typeof p.estimated_seconds === 'number' && Number.isFinite(p.estimated_seconds) ? p.estimated_seconds : 0,
            queue_depth: typeof p.queue_depth === 'number' && Number.isFinite(p.queue_depth) ? p.queue_depth : 0,
            queue_preview: cleanPreview((p as { queue_preview?: unknown }).queue_preview),
            stats: cleanStats((p as { stats?: unknown }).stats),
            ...(cleanRebuild((p as { last_rebuild?: unknown }).last_rebuild)
              ? { last_rebuild: cleanRebuild((p as { last_rebuild?: unknown }).last_rebuild) }
              : {}),
            ...(cleanCycles((p as { cycles?: unknown }).cycles)
              ? { cycles: cleanCycles((p as { cycles?: unknown }).cycles) }
              : {}),
            ...(cleanCycleCap((p as { cycle_cap?: unknown }).cycle_cap) !== undefined
              ? { cycle_cap: cleanCycleCap((p as { cycle_cap?: unknown }).cycle_cap) }
              : {}),
          }))
      : undefined;
    // Version handshake (optional — pre-version clients omit both and keep
    // registering fine): the client's own version string + the wire-protocol
    // revision it speaks. Sanitized in registerClient (version: string
    // ≤64 chars; protocol: integer 0..1000; malformed → dropped).
    const version = typeof body.version === 'string' ? body.version : undefined;
    const protocol = typeof body.protocol === 'number' ? body.protocol : undefined;
    // Code-staleness (issue #49): the commit the client's running process
    // loaded its code from. Same edge posture — a plain string pass-through,
    // sanitized in registerClient; absent on pre-#49 clients.
    const revision = typeof body.revision === 'string' ? body.revision : undefined;
    // Gate posture (#41): the router's OWN fail-open/armed state, a plain
    // pass-through here — sanitized (exact-value, else dropped) in
    // registerClient. Absent = an old client or a gate-less daemon: the
    // surfaces render the row exactly as before.
    const gate_posture = body.gate_posture === 'armed' || body.gate_posture === 'fail_open' ? body.gate_posture : undefined;
    // Session launcher (#43): the port the proxy actually bound — a plain
    // pass-through here, sanitized (integer 1..65535, else dropped) in
    // registerClient. The daemon registers once before its proxy binds, so
    // the key simply arrives on a later heartbeat; old clients never send
    // it at all.
    const proxy_port = typeof body.proxy_port === 'number' ? body.proxy_port : undefined;
    // Agent-key plane (#68): the aggregate listener's bound port, same
    // pass-through — sanitized (integer 1..65535, else dropped) in
    // registerClient, absent on daemons without the listener.
    const aggregate_port = typeof body.aggregate_port === 'number' ? body.aggregate_port : undefined;
    // Code-staleness verdict (#61 step 3 A1): the client computed it where
    // the facts live (boot revision vs live HEAD of the checkout it runs
    // from). A plain pass-through here — sanitized (exact boolean, else
    // dropped) in registerClient. Absent on pre-#61-step-3 clients: the
    // row renders exactly as before.
    const daemon_behind = typeof body.daemon_behind === 'boolean' ? body.daemon_behind : undefined;
    // Client log tail (#61 step 3 A2): the client publishes it ONLY to a
    // loopback arbiter. A plain array pass-through here — bounded (≤120
    // lines, per-line cap, non-strings dropped) in registerClient.
    const client_log = Array.isArray(body.client_log) ? (body.client_log as string[]) : undefined;
    const res = arbiter.registerClient(
      name,
      typeof body.ip === 'string' && body.ip.trim() ? body.ip.trim() : undefined,
      remote,
      projects,
      undefined,
      version !== undefined || protocol !== undefined || revision !== undefined || gate_posture !== undefined || proxy_port !== undefined || aggregate_port !== undefined || daemon_behind !== undefined || client_log !== undefined
        ? { version, protocol, revision, gate_posture, proxy_port, aggregate_port, daemon_behind, client_log }
        : undefined,
    );
    return reply.code(200).send({ client_id: res.client_id, created: res.created });
  });

  /**
   * Operator override for a client: { override: "pause" | "force" | null,
   * until?: epoch_ms }. `null` clears it. `until` (future) makes it auto-expire.
   * Addressed by client name or client_id. 404 for an unknown client.
   */
  app.post('/api/clients/:ref/override', async (req, reply) => {
    const ref = decodeURIComponent((req.params as { ref: string }).ref);
    const body = (req.body ?? {}) as { override?: 'pause' | 'force' | null; until?: number };
    if (!ref.trim()) return reply.code(400).send({ error: 'client reference required' });
    const ov = body.override;
    if (ov !== 'pause' && ov !== 'force' && ov !== null) {
      return reply.code(400).send({ error: 'override must be "pause", "force", or null (clear)' });
    }
    const until = typeof body.until === 'number' && Number.isFinite(body.until) ? body.until : undefined;
    const res = arbiter.setClientOverride(ref.trim(), ov, until);
    if (!res.ok) return reply.code(404).send({ error: res.reason ?? 'unknown_client' });
    return { ok: true, client: res.client_name, override: res.override ?? null };
  });

  // ------------------------------------------------------------------
  // Leases
  // ------------------------------------------------------------------

  app.get('/api/leases', async (req) => {
    return { leases: arbiter.recentLeases(50), active: arbiter.activeLeases() };
  });

  app.post('/api/leases', async (req, reply) => {
    const body = (req.body ?? {}) as {
      client_id?: string;
      project?: string;
      job_id?: string;
      estimated_seconds?: number;
      /** Engine to run on (per-engine admission, #38). Absent = watched server. */
      server_id?: string;
    };
    if (!body.client_id || !body.project || !body.job_id) {
      return reply.code(400).send({ error: 'client_id, project and job_id are required' });
    }
    const clientExists = arbiter.clientIp(body.client_id) !== null;
    if (!clientExists) {
      return reply.code(409).send({ reason: 'unknown_client' });
    }
    const res = arbiter.requestLease({
      client_id: body.client_id,
      project: String(body.project),
      job_id: String(body.job_id),
      estimated_seconds: typeof body.estimated_seconds === 'number' ? body.estimated_seconds : 0,
      ...(typeof body.server_id === 'string' && body.server_id.trim() !== '' ? { server_id: body.server_id.trim() } : {}),
    });
    if (!res.ok || !res.lease) {
      return reply.code(409).send({ reason: res.reason ?? 'unknown' });
    }
    return reply.code(201).send({
      lease_id: res.lease.lease_id,
      client_id: res.lease.client_id,
      project: res.lease.project,
      job_id: res.lease.job_id,
      ...(res.lease.server_id ? { server_id: res.lease.server_id } : {}),
      granted_at: res.lease.granted_at,
      expires_at: res.lease.expires_at,
      ttl_seconds: Math.round((res.lease.expires_at - res.lease.granted_at) / 1000),
    });
  });

  app.post('/api/leases/:id/usage', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      tokens_out?: number;
      tokens_in?: number;
      ok?: boolean;
      error?: string;
      /** Last ≤1000 chars of the executor's combined output (crash stderr). */
      error_detail?: string;
      /** Client-reported score from the result line (issue #4); null on failure paths. */
      score?: number | null;
    };
    const res = arbiter.finishLease({
      lease_id: id,
      tokens_out: typeof body.tokens_out === 'number' ? body.tokens_out : 0,
      tokens_in: typeof body.tokens_in === 'number' ? body.tokens_in : 0,
      ok: body.ok !== false,
      error: typeof body.error === 'string' ? body.error : undefined,
      // Client-reported failure detail (last ≤1000 chars of the executor's
      // combined output). Truncated server-side in finishLease; stored on
      // the lease record and the lease_finished event.
      error_detail: typeof body.error_detail === 'string' ? body.error_detail : undefined,
      // Score (issue #4): number|null from the client's result line. A
      // non-number (garbage) stores as null — never rejected.
      score: typeof body.score === 'number' && Number.isFinite(body.score) ? body.score : null,
    });
    if (!res.ok) return reply.code(404).send({ error: res.reason ?? 'unknown_lease' });
    return { ok: true, lease: { lease_id: id, tokens_out: res.lease?.tokens_out, tokens_in: res.lease?.tokens_in, status: res.lease?.status } };
  });

  // ------------------------------------------------------------------
  // Projects
  // ------------------------------------------------------------------

  app.get('/api/projects', async () => {
    const day = new Date().toISOString().slice(0, 10);
    return {
      projects: projectView(arbiter, cfg, arbiter['store'].state.clients, day, Date.now(), todayTotals(arbiter['store'].state.leases, day)),
    };
  });

  app.post('/api/projects/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as { paused?: boolean };
    if (typeof body.paused !== 'boolean') return reply.code(400).send({ error: 'paused (boolean) required' });
    const res = arbiter.setProjectPaused(name, body.paused);
    if (!res.ok) return reply.code(404).send({ error: res.reason ?? 'unknown_project' });
    const p = cfg.projects.find((x) => x.name === name)!;
    return { ok: true, name, paused: p.paused };
  });

  /**
   * Project-level grant settings (the knobs that gate this project's grants,
   * beyond the per-project pause): idle_seconds (runs when idle ≥ Ns),
   * max_concurrent_leases (max N jobs at a time), lease_ttl_seconds
   * (auto-cancels after Ns). A value of `null` CLEARS the per-project
   * override — the project inherits the global value again.
   */
  app.post('/api/projects/:name/settings', async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as {
      clear?: boolean;
      idle_seconds?: number | null;
      max_concurrent_leases?: number | null;
      lease_ttl_seconds?: number | null;
    };
    const numOr = (v: unknown): number | null | undefined => (v === null ? null : typeof v === 'number' ? v : undefined);
    // { clear: true } drops every override at once (CLI shorthand).
    const settings = body.clear
      ? { idle_seconds: null, max_concurrent_leases: null, lease_ttl_seconds: null }
      : {
          idle_seconds: numOr(body.idle_seconds),
          max_concurrent_leases: numOr(body.max_concurrent_leases),
          lease_ttl_seconds: numOr(body.lease_ttl_seconds),
        };
    if (settings.idle_seconds === undefined && settings.max_concurrent_leases === undefined && settings.lease_ttl_seconds === undefined) {
      return reply.code(400).send({ error: 'provide idle_seconds, max_concurrent_leases, or lease_ttl_seconds (number, or null to clear the override)' });
    }
    for (const v of Object.values(settings)) {
      if (v !== null && v !== undefined && (!Number.isFinite(v) || v <= 0)) {
        return reply.code(400).send({ error: 'settings must be positive numbers (or null to clear)' });
      }
    }
    const res = arbiter.setProjectSettings(name, settings);
    if (!res.ok) return reply.code(404).send({ error: res.reason ?? 'unknown_project' });
    const p = cfg.projects.find((x) => x.name === name)!;
    return {
      ok: true,
      name,
      overrides: {
        idle_seconds: p.idle_seconds ?? null,
        max_concurrent_leases: p.max_concurrent_leases ?? null,
        lease_ttl_seconds: p.lease_ttl_seconds ?? null,
      },
    };
  });

  /**
   * Anti-thrash operator recovery: clear the (project, job_id) throttle,
   * its failure count, and its grant cooldown so the job can be granted
   * again (token-authed like the other admin routes). Idempotent —
   * unthrottling a job that was never throttled succeeds. 404 for an
   * unknown project.
   */
  app.post('/api/projects/:name/jobs/:job_id/unthrottle', async (req, reply) => {
    const { name, job_id } = req.params as { name: string; job_id: string };
    const res = arbiter.unthrottleJob(name, job_id);
    if (!res.ok) return reply.code(404).send({ error: res.reason ?? 'unknown_project' });
    return { ok: true, project: name, job_id, was_throttled: res.was_throttled };
  });

  /**
   * Per-job outcomes (issue #4): the LAST reported result per (project,
   * job_id), newest first. `limit` defaults to 20, capped at 200 (the MCP
   * results tool's discipline); `job_id` filters to one job. Unknown
   * project → 404 like sibling project routes. Token-gated by the /api/*
   * hook (NOT the anonymous /api/state exception). Response shape mirrors
   * the MCP idlefill_results tool. /api/state deliberately stays lean —
   * this route is the results surface.
   */
  app.get('/api/projects/:name/results', async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    if (!cfg.projects.find((p) => p.name === name)) {
      return reply.code(404).send({ error: 'unknown_project' });
    }
    let limit: unknown = null;
    const q = req.query;
    if (typeof q === 'string') limit = new URLSearchParams(q).get('limit');
    else if (q !== null && typeof q === 'object') limit = (q as Record<string, unknown>).limit;
    const n = typeof limit === 'string' ? Number.parseInt(limit, 10) : Number.NaN;
    const capped = Number.isInteger(n) && n >= 1 ? Math.min(200, n) : 20;
    const jobId = typeof q === 'object' && q !== null ? (q as Record<string, unknown>).job_id : undefined;
    const results = arbiter.projectResults(name, {
      limit: capped,
      ...(typeof jobId === 'string' && jobId !== '' ? { job_id: jobId } : {}),
    });
    return { project: name, count: results.length, results };
  });

  // ------------------------------------------------------------------
  // Inference servers (declared connections + their model resources)
  // ------------------------------------------------------------------

  app.get('/api/servers', async (req) => {
    return { servers: serverView(arbiter, cfg, Date.now()) };
  });

  /**
   * GET /api/server-keys (#64 D2): the router's loopback-scoped key pull.
   * The ONE read surface that ever carries an engine credential, and it
   * answers ONLY a loopback caller — the arbiter binds 0.0.0.0
   * (index.ts:251), so the check lives INSIDE the route on
   * `req.socket.remoteAddress` (the raw socket, not req.ip: Fastify's
   * req.ip honors trust-proxy settings the arbiter does not configure).
   * Auth: the standard /api/* hook (admin api_tokens) still applies —
   * this route ADDS the loopback requirement on top, it never loosens
   * auth. A non-loopback caller with a VALID admin token is refused 403.
   *
   * This is deliberately NOT part of /api/state (that view is
   * anonymous-readable). No other read surface carries a token (#60 B
   * write-only posture, doc D2 rule 3). Tokens here are the arbiter's
   * stored row values, handed to the machine's own router for in-memory
   * use only.
   */
  app.get('/api/server-keys', async (req, reply) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      return reply.code(403).send({ error: 'loopback-only route', hint: 'GET /api/server-keys answers only the machine\'s own router' });
    }
    const s = arbiter['store'].state;
    return {
      server_keys: s.servers
        .filter((row: ServerConnection) => row.auth_token !== undefined && row.auth_token !== '')
        .map((row: ServerConnection) => ({ id: row.id, name: row.name, url: row.url, auth_token: row.auth_token })),
      // #68: the agent-key DIGESTS the router enforces. Digests, never
      // plaintexts: the router answers a caller by hashing what the
      // CALLER presented, so even a stolen pull response cannot replay a
      // usable credential. Empty array = the key plane is off (today's
      // posture: any caller on loopback passes).
      client_key_hashes: arbiter.clientKeyDigests(),
    };
  });

  /**
   * Add (no id) or update (with id) a declared server connection:
   * { name, url, activity_path?, models?, peers? }. Inventory only — the
   * arbiter watches its single configured feed; a declared row is where a
   * future multi-feed core will point the watcher.
   */
  app.post('/api/servers', async (req, reply) => {
    const body = (req.body ?? {}) as {
      id?: string;
      name?: string;
      url?: string;
      activity_path?: string;
      log_glob?: string;
      provider?: string;
      auth_token?: string;
      models?: string[];
      peers?: string[];
    };
    const res = arbiter.upsertServerConnection(body);
    if (!res.ok) {
      return reply.code(res.reason === 'unknown_server' ? 404 : 400).send({ error: res.reason ?? 'invalid' });
    }
    // The created/updated row is echoed — strip the credential (#60 B) the
    // same way serverView does. The caller just SET it; it never reads it
    // back through this API.
    const { auth_token, ...serverPublic } = res.server!;
    return { ok: true, created: res.created, server: { ...serverPublic, auth_set: auth_token !== undefined && auth_token !== '' } };
  });

  /**
   * Remove a declared server connection: { id }. The arbiter refuses a
   * row with live leases (409) and an unknown id (404) — see
   * removeServerConnection. Token-gated like every settings write.
   */
  app.post('/api/servers/remove', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string };
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) return reply.code(400).send({ error: 'id required' });
    const res = arbiter.removeServerConnection(id);
    if (!res.ok) {
      return reply.code(res.reason === 'unknown_server' ? 404 : 409).send({ error: res.reason ?? 'invalid' });
    }
    return { ok: true, removed: res.removed };
  });

  // ------------------------------------------------------------------
  // Theme colors (#68): the operator-tuned dashboard color scheme
  // ------------------------------------------------------------------

  /**
   * POST /api/theme: the theme write route. Token-gated like every settings
   * write (the standard /api/* onRequest hook). Body: `{ colors }`.
   *
   * Drop-don't-reject: the arbiter sanitizes per key (hex grammar + known
   * keys only). A bad key or a malformed value NEVER 400s — it drops that
   * key and keeps the prior value (an all-bad payload keeps the prior map,
   * never clears to empty). So this route always 200s with the EFFECTIVE
   * map (the nine-token shape after sanitization) + updated_at + the count
   * of tokens applied + the unknown keys dropped. The values are pure CSS
   * colors — no token or secret ever crosses the wire.
   */
  app.post('/api/theme', async (req) => {
    const body = (req.body ?? {}) as { colors?: unknown };
    const colors = body.colors && typeof body.colors === 'object' && !Array.isArray(body.colors)
      ? (body.colors as Record<string, unknown>)
      : {};
    const res = arbiter.setTheme(colors);
    return {
      ok: true,
      colors: res.theme.colors,
      updated_at: res.theme.updated_at,
      applied: res.applied,
      dropped: res.dropped,
    };
  });

  // ------------------------------------------------------------------
  // Agent keys (#68): idlefill-issued credentials for aggregate callers
  // ------------------------------------------------------------------

  /**
   * POST /api/client-keys: mint an agent key. { label } → the public row
   * PLUS the plaintext token, ONCE, in this response. The state row keeps
   * only the sha256 digest (#60 B write-only posture): no read surface —
   * not GET /api/client-keys, not /api/state, not the loopback pull —
   * ever carries a plaintext, and the pull carries only digests.
   */
  app.post('/api/client-keys', async (req, reply) => {
    const body = (req.body ?? {}) as { label?: string };
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!label) return reply.code(400).send({ error: 'label required' });
    if (label.length > 64) return reply.code(400).send({ error: 'label too long (max 64 chars)' });
    const { key, token } = arbiter.mintClientKey(label);
    return reply.code(201).send({ id: key.id, label: key.label, created_at: key.created_at, token });
  });

  /** GET /api/client-keys: the public rows (id/label/created_at). No hash, no plaintext. */
  app.get('/api/client-keys', async () => {
    return { keys: arbiter.clientKeys() };
  });

  /**
   * GET /api/agent-endpoints (#68): the agent base URLs an Add-agent
   * flow can hand an agent config — one per ONLINE client whose
   * aggregate listener reported a bound port. These are loopback URLs:
   * they are only honest on the machine they name, which is why the
   * flow offers only THIS machine's daemon (the dashboard is served by
   * it) and says so rather than offering a remote URL that would not
   * resolve on the operator's box.
   *
   * Each endpoint also names the DEFAULT model (`model`): the highest-priority
   * alias the machine advertises (the first published alias), else the first
   * bare catalog entry, else null (the machine's default target). The mint
   * hand-off bakes this name into the agent's config.yaml so a pasted block
   * works out of the box.
   */
  app.get('/api/agent-endpoints', async () => {
    const now = Date.now();
    const defaultModel = arbiter.modelAliases()[0]?.name ?? arbiter.catalog()[0]?.name ?? null;
    return {
      endpoints: arbiter['store'].state.clients
        .filter((c: ClientRecord) => typeof c.aggregate_port === 'number' && now - c.last_seen < 90_000)
        .map((c: ClientRecord) => ({ client: c.name, url: `http://127.0.0.1:${c.aggregate_port}/v1`, model: defaultModel })),
    };
  });

  /** POST /api/client-keys/revoke: { id }. The router stops accepting it on its next pull. */
  app.post('/api/client-keys/revoke', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string };
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) return reply.code(400).send({ error: 'id required' });
    const res = arbiter.revokeClientKey(id);
    if (!res.ok) {
      return reply.code(res.reason === 'unknown_key' ? 404 : 400).send({ error: res.reason ?? 'invalid' });
    }
    return { ok: true, revoked: res.revoked };
  });

  // ------------------------------------------------------------------
  // Model aliases (#66 — docs/architecture/model-aliases.md D1–D5)
  // ------------------------------------------------------------------

  /**
   * GET /api/aliases: the STORED alias rows for the dashboard Models tab —
   * pairs verbatim + the last tick's per-pair source markers + the pin.
   * No secret by construction (an alias is server_id + engine id only).
   * NOT part of the anonymous /api/state view: this is the authoring read
   * for an operator surface, so the standard /api/* token applies.
   */
  app.get('/api/aliases', async () => {
    return { aliases: arbiter.aliasRows() };
  });

  /**
   * POST /api/aliases: the alias write route (the drag's write path is the
   * same). Body: { alias, pairs?, pin?, delete?, order? } — upsert with alias +
   * pairs (optional pin), re-pin with alias + pin on an existing alias,
   * removal with { alias, delete: true }, or a PRIORITY re-arrangement with
   * { order: [name, …] } (the stored keys are re-inserted in that order;
   * first = the default model). WHOLE-ENTRY validation answers 400 with the
   * reason (D1/D2 posture: a wrong entry is told, not swallowed); a delete of
   * an unknown alias is 404. Every write appends an event (the
   * server_connection_updated pattern) so the Sessions view and the logs dock
   * see the change. The response echoes the STORED entry — pairs carry no
   * secret (D1: aliases are secret-free by construction), so nothing strips.
   */
  app.post('/api/aliases', async (req, reply) => {
    const body = (req.body ?? {}) as { alias?: unknown; pairs?: unknown; pin?: unknown; delete?: unknown; order?: unknown };
    const res = arbiter.putModelAlias(body);
    if (!res.ok) {
      return reply.code(res.reason === 'unknown_alias' ? 404 : 400).send({ error: res.reason ?? 'invalid' });
    }
    return {
      ok: true,
      created: res.created === true,
      deleted: res.deleted === true,
      reordered: res.reordered === true,
      ...(res.alias ? { alias: res.alias } : {}),
    };
  });

  // ------------------------------------------------------------------
  // Sessions (router-self-registered interactive traffic — #32/#33)
  // ------------------------------------------------------------------

  /**
   * Register/heartbeat a session (idempotent on token). The router calls
   * this on first sight of a /s/<token> path and refreshes it with each
   * heartbeat, reporting the newest request time it saw on the session.
   */
  app.post('/api/sessions/register', async (req, reply) => {
    const body = (req.body ?? {}) as {
      token?: string;
      client_id?: string;
      client_name?: string;
      server_id?: string;
      last_activity?: number;
      gate?: unknown;
      session_id?: unknown;
      history?: unknown;
      phase?: unknown;
    };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) return reply.code(400).send({ error: 'token required' });
    const res = arbiter.registerSession(token, {
      ...(body.client_id ? { client_id: String(body.client_id) } : {}),
      ...(body.client_name ? { client_name: String(body.client_name) } : {}),
      ...(body.server_id ? { server_id: String(body.server_id) } : {}),
      ...(typeof body.last_activity === 'number' && Number.isFinite(body.last_activity) ? { last_activity: body.last_activity } : {}),
      // gate-state: forwarded VERBATIM (absent = the idle report → clear;
      // validation + drop-don't-reject live in registerSession).
      gate: body.gate,
      // #42 Slice 0: the Hermes conversation id, forwarded verbatim the
      // same way (bounded/sanitized in registerSession, never a rejection).
      session_id: body.session_id,
      // #45: the compact request history (per-minute counts + last model
      // + last streamed tokens). Forwarded verbatim; the sanitizer lives
      // in registerSession (drop-don't-reject, like the gate block).
      ...(body.history !== undefined ? { history: body.history } : {}),
      // #67: the response-phase block (the router's stream truth:
      // thinking/output/tools + observation age). Verbatim like `gate` —
      // absent = the no-phase report (the stored phase CLEARS), and the
      // three-verdict sanitizer lives in registerSession.
      phase: body.phase,
    });
    if (!res.ok) return reply.code(400).send({ error: res.reason ?? 'invalid' });
    return reply.code(res.created ? 201 : 200).send({ created: res.created, session: res.session });
  });

  app.get('/api/sessions', async () => {
    const now = Date.now();
    return {
      sessions: arbiter.listSessions().map((sess) => {
        const pin = arbiter.sessionPinBlock(sess.token, typeof sess.history?.model === 'string' ? sess.history.model : undefined, sess.server_id);
        return {
          ...sess,
          override: arbiter.activeSessionOverride(sess.token, now),
          ...(pin ? { engine_pin: pin } : {}),
        };
      }),
    };
  });

  /**
   * Operator override for a session: { override: "pause" | "force" | null,
   * until?: epoch_ms }. Same shape as the client override (#32). 'pause'
   * asks the router to hold that session's traffic. 404 for an unknown
   * session token.
   */
  app.post('/api/sessions/:token/override', async (req, reply) => {
    const token = decodeURIComponent((req.params as { token: string }).token);
    const body = (req.body ?? {}) as { override?: 'pause' | 'force' | null; until?: number };
    if (!token.trim()) return reply.code(400).send({ error: 'session token required' });
    const ov = body.override;
    if (ov !== 'pause' && ov !== 'force' && ov !== null) {
      return reply.code(400).send({ error: 'override must be "pause", "force", or null (clear)' });
    }
    const until = typeof body.until === 'number' && Number.isFinite(body.until) ? body.until : undefined;
    const res = arbiter.setSessionOverride(token.trim(), ov, until);
    if (!res.ok) return reply.code(404).send({ error: res.reason ?? 'unknown_session' });
    return { ok: true, override: res.override ?? null };
  });

  /**
   * #67 operator engine pin for a session: { server_id: "<row id>" | null
   * (clear) }. The drag/pin write path — SIBLING of the override route
   * above (same token path shape, same operator surface, same poll-learned
   * channel). Truth constrains the target (arbiter.setSessionPin: the row
   * must serve the session's model per alias pairs / probed inventory);
   * an unknown session is 404, an illegal target is 400 with the reason
   * (the alias-write posture: a wrong write is told, not swallowed). The
   * pin applies at RELEASE time: queued + next-request traffic moves, a
   * running stream never does.
   */
  app.post('/api/sessions/:token/pin', async (req, reply) => {
    const token = decodeURIComponent((req.params as { token: string }).token);
    const body = (req.body ?? {}) as { server_id?: string | null };
    if (!token.trim()) return reply.code(400).send({ error: 'session token required' });
    const sid = body.server_id;
    if (sid === undefined) return reply.code(400).send({ error: 'server_id required (null clears the pin)' });
    const res = arbiter.setSessionPin(token.trim(), sid);
    if (!res.ok) {
      const code = res.reason === 'unknown_session' ? 404 : 400;
      return reply.code(code).send({ error: res.reason ?? 'invalid' });
    }
    return { ok: true, pin: res.pin ?? null };
  });

  // ------------------------------------------------------------------
  // Mesh federation read plane (#50)
  // ------------------------------------------------------------------

  /**
   * This instance's coarse snapshot for peers. Auth: the fleet peer_token
   * (read-only, scoped here by the onRequest hook) or a local admin token.
   * COARSE by construction — presence, per-engine idle signal, queue
   * DEPTHS, session/lease counts. Never job ids, titles, URLs, payloads.
   */
  app.get('/api/mesh', async () => {
    const now = Date.now();
    const s = arbiter['store'].state;
    const servers = s.servers.map((row: ServerConnection) => ({
      name: row.name,
      signal: arbiter.serverSignal(row.id, now),
    }));
    return buildMeshSnapshot(
      arbiter.instanceId(),
      cfg.mesh_name || os.hostname(),
      servers,
      arbiter.totalQueueDepth(),
      arbiter.listSessions().length,
      arbiter.activeLeases(now).length,
      now,
      // The arbiter's own version (display-only; the client handshake
      // precedent). Absent on a build that never baked one.
      process.env.IDLEFILL_VERSION,
    );
  });

  // ------------------------------------------------------------------
  // Metrics retention store (#51 D6)
  // ------------------------------------------------------------------

  /**
   * Range read over the retention store. Params: `series` (engine|lease|
   * session, required), `key` (optional filter: server_id / session token /
   * project), `from`/`to` (epoch-ms, default the last 7 days), `bucket`
   * (hour default | raw; raw answers only inside the raw window — the store
   * clamps). Bad params answer 400 with an error string, same discipline as
   * the settings routes. The response caps at 2,000 points: the OLDEST are
   * trimmed and `truncated: true` rides. Auth: anonymous read like
   * /api/state (the onRequest hook); a wrong token is still 401; the fleet
   * peer_token does NOT unlock this route.
   */
  app.get('/api/metrics', async (req, reply) => {
    if (!metrics) return reply.code(501).send({ error: 'metrics store not wired' });

    const q = (typeof req.query === 'object' && req.query !== null ? req.query : {}) as Record<string, unknown>;
    const series = q.series;
    if (series !== 'engine' && series !== 'lease' && series !== 'session') {
      return reply.code(400).send({ error: 'series must be engine, lease, or session' });
    }
    const bucket = q.bucket === undefined ? 'hour' : q.bucket;
    if (bucket !== 'hour' && bucket !== 'raw') {
      return reply.code(400).send({ error: 'bucket must be hour or raw' });
    }
    const now = Date.now();
    const WEEK_MS = 7 * 86_400_000;
    const from = typeof q.from === 'string' || typeof q.from === 'number' ? Number(q.from) : now - WEEK_MS;
    const to = typeof q.to === 'string' || typeof q.to === 'number' ? Number(q.to) : now;
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return reply.code(400).send({ error: 'from and to must be epoch-ms numbers' });
    }
    if (from > to) return reply.code(400).send({ error: 'from must be <= to' });
    if (typeof q.key !== 'undefined' && typeof q.key !== 'string') {
      return reply.code(400).send({ error: 'key must be a string' });
    }

    const lines = metrics.readRange({
      series: series as MetricsSeries,
      ...(typeof q.key === 'string' && q.key !== '' ? { key: q.key } : {}),
      from,
      to,
      bucket: bucket as MetricsBucket,
      now,
    });

    // 2,000-point cap: trim the OLDEST, keep the newest (D6).
    const MAX_POINTS = 2000;
    const truncated = lines.length > MAX_POINTS;
    const kept = truncated ? lines.slice(lines.length - MAX_POINTS) : lines;

    const byKey = new Map<string, Record<string, unknown>[]>();
    for (const l of kept) {
      const k = seriesKeyOf(l);
      let arr = byKey.get(k);
      if (!arr) {
        arr = [];
        byKey.set(k, arr);
      }
      arr.push(l as unknown as Record<string, unknown>);
    }
    return {
      series: [...byKey.entries()].map(([key, points]) => ({ key, points })),
      truncated,
    };
  });

  // ------------------------------------------------------------------
  // State (public read when anonymous; token-authed otherwise)
  // ------------------------------------------------------------------

  app.get('/api/state', async (req) => {
    // Note: the onRequest hook already 401'd a wrong token here; an anonymous
    // or correctly-tokened request reaches this handler.
    const s = arbiter['store'].state;
    const now = Date.now();
    const active = arbiter.activeLeases();
    const day = new Date().toISOString().slice(0, 10);
    // The top-level `idle` block is the WATCHED server's view (per-server
    // detail rides `servers[]`). A watched row without a detector reads
    // degraded (fail-closed).
    const sig = arbiter.serverSignal(WATCHED_SERVER_ID, now) ?? {
      now,
      idle: false,
      idle_for_s: null,
      last_activity: null,
      last_log_write: null,
      signal_degraded: true,
      degraded_reason: 'no detector for the watched server',
      feed_enabled: true,
    };
    const lastAct = sig.last_activity ?? s.last_activity;
    const lastActAgo = lastAct ? Math.max(0, Math.round((now - lastAct.ts) / 1000)) : null;
    const limit = queryLimit(req);

    return {
      now,
      idle: {
        idle: sig.idle,
        idle_seconds: cfg.idle_seconds,
        degraded: s.signal_degraded,
        degraded_reason: s.degraded_reason,
        reidle_gated: arbiter.reidleGated(),
        last_activity: lastAct ? { ...lastAct, age_s: lastActAgo } : null,
        last_log_write: s.last_log_write,
        last_log_write_age_s: s.last_log_write ? Math.max(0, Math.round((now - s.last_log_write) / 1000)) : null,
        idle_for_s: sig.idle_for_s,
      },
      leases: arbiter.recentLeases(limit),
      active_leases: active,
      // Client rows carry their active operator override (if any), so the
      // dashboard and clients can see pause/force state without a second call.
      clients: s.clients.map((c) => ({ ...c, override: arbiter.activeOverride(c.client_id, now) })),
      // Interactive sessions (#32/#33) with their active operator override.
      // #67: an active engine pin rides the row as the resolved
      // `engine_pin` ADD-key (server_id + url + engine_model when the
      // pinned row serves the session's model under another id + set_at) —
      // the router learns it on this same poll, the pause/force channel.
      sessions: arbiter.listSessions().map((sess) => {
        const pin = arbiter.sessionPinBlock(sess.token, typeof sess.history?.model === 'string' ? sess.history.model : undefined, sess.server_id);
        return {
          ...sess,
          override: arbiter.activeSessionOverride(sess.token, now),
          ...(pin ? { engine_pin: pin } : {}),
        };
      }),
      // Anti-thrash: the jobs currently throttled (persisted; newest last).
      // Empty list when nothing is throttled — the dashboard renders this
      // as the exception-only "Throttled jobs" section.
      throttled_jobs: arbiter.throttledJobs(),
      // Mesh federation (#50): this instance's identity + the merged peer
      // view. ADD key (the /api/state shape contract: add, never rename).
      // Ephemeral — peer snapshots never touch state.json. Absent when no
      // federation is wired (a build without the mesh module stays as-is).
      ...(mesh ? { mesh: { instance_id: arbiter.instanceId(), peers: mesh.view(now) } } : {}),
      projects: projectView(arbiter, cfg, s.clients, day, now, todayTotals(s.leases, day)),
      servers: serverView(arbiter, cfg, now),
      // Aggregate endpoint catalog (#64 D4): the arbiter-built, deduped
      // model→row map the router's :8800 listener routes on. ADD key —
      // present from the first tick; an old router ignores it. Carries
      // name/server_id/url/auth_set ONLY: the credential NEVER rides
      // here (this view is anonymous-readable; the write-only posture,
      // #60 B, stays intact — the token crosses only over the
      // loopback-scoped GET /api/server-keys).
      catalog: arbiter.catalog(),
      // Model aliases (#66 D3): the arbiter-resolved alias block — one
      // entry per alias with the WINNER pair already applied (name,
      // server_id, url, auth_set, engine_model, catalog_source). ADD-key
      // SIBLING of `catalog`; the `catalog` key itself stays byte-for-byte
      // (amendment discipline). The credential NEVER rides here either —
      // auth_set only, same write-only posture (#60 B).
      model_aliases: arbiter.modelAliases(),
      // Dashboard color scheme (#68): the persisted theme map, the ADD key.
      // Anonymous-readable — cosmetic values only (pure hex colors, no token
      // or secret). Absent when unset (the dashboard falls back to its :root
      // defaults); present with the full nine-token shape once set.
      ...(arbiter.theme() ? { theme: arbiter.theme() } : {}),
      events: s.events.slice(Math.max(0, s.events.length - limit)).reverse(),
    };
  });

  // ------------------------------------------------------------------
  // Dashboard (static; the README documents the public read)
  // ------------------------------------------------------------------

  const sendShell = (reply: FastifyReply) => {
    const file = join(publicDir, 'index.html');
    if (!existsSync(file)) return reply.code(500).send(`dashboard missing (${publicDir}/index.html)`);
    return reply.type('text/html; charset=utf-8').send(readFileSync(file, 'utf-8'));
  };

  app.get('/', (_req, reply) => sendShell(reply));

  // Queue detail link — /[project]/[worker]/queue. The React dashboard
  // (cutover 2026-10-08) serves the SPA shell here so old deep links keep
  // resolving; the queue VIEW itself is not ported to React yet (tracked
  // as a follow-up — the queue data still rides /api/state).
  app.get('/:project/:worker/queue', (_req, reply) => sendShell(reply));

  // Built SPA assets — /assets/<hashed file>. The Vite build emits hashed
  // filenames (immutable), so a year of max-age is safe. Traversal-guarded:
  // the resolved path must stay inside publicDir/assets.
  app.get('/assets/*', (req, reply) => {
    const rel = (req.params as { '*': string })['*'];
    const assetsDir = resolve(publicDir, 'assets');
    const file = resolve(assetsDir, rel);
    if (!file.startsWith(assetsDir + '/') || !existsSync(file)) {
      return reply.code(404).send('asset not found');
    }
    const type =
      { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }[extname(file)] ??
      'application/octet-stream';
    return reply.header('cache-control', 'public, max-age=31536000, immutable').type(type).send(readFileSync(file));
  });

  return app;
}

/**
 * Attach a WebSocketServer to the Fastify server's underlying http server on
 * /api/leases/events. Handshake validates the token (query `token` or
 * `Sec-WebSocket-Protocol`-independent; the client uses ?token=).
 *
 * Events pushed: {type:"revoked", lease_id, project, reason} and
 * {type:"lease", ...} (grants). One connection per client.
 */
export function attachWebSocket(app: FastifyInstance, arbiter: Arbiter, cfg: ServerConfig): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/api/leases/events') {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    if (!isValidToken(cfg, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    // Ping/pong keepalive (clients that die on the wire get reaped).
    const w = ws as WebSocket & { isAlive?: boolean };
    w.isAlive = true;
    w.on('pong', () => {
      w.isAlive = true;
    });
    w.on('error', () => {});
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { isAlive?: boolean };
      if (w.isAlive === false) {
        w.terminate();
        continue;
      }
      w.isAlive = false;
      try {
        w.ping();
      } catch {
        /* ignore */
      }
    }
  }, 30000);
  interval.unref?.();
  wss.on('close', () => clearInterval(interval));

  /** Push an event to ALL connected clients (fan-out is small). */
  const broadcast = (obj: unknown) => {
    const data = JSON.stringify(obj);
    for (const ws of wss.clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  };

  // Revoke events are pushed by index.ts via this handle.
  (app as unknown as Record<string, unknown>).broadcastWs = broadcast;

  return wss;
}

import type { WebSocket } from 'ws';
