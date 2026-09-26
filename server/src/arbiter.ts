/**
 * Arbiter — the lease state machine on top of the IdleDetector.
 *
 * States per lease: active → finished | revoked | expired.
 *
 * Grant (requestLease):
 *   - system idle (detector verdict; the detector never reports idle while
 *     degraded, so "no grants while degraded" falls out of the same check)
 *   - active lease count < max_concurrent_leases
 *   - project exists, not paused
 *   - project's UTC-day output tokens < daily_token_cap
 *   - no post-revocation reidle gate armed (see below)
 *
 * Revoke (on each idle poll):
 *   - TTL expiry (status expired, reason ttl_expired)
 *   - preempt: NOT idle, not degraded, and the newest NON-EXEMPT activity
 *     entry post-dates the lease's grant. Exempt = the active leases'
 *     owner IPs, so the lease holder's own traffic can never preempt it.
 *
 * After ANY revocation the system must go idle again (full idle_seconds)
 * before the next grant: `reidleAfter` arms on revocation and disarms only
 * when a later poll reports a full idle — no burst of re-grants.
 *
 * Usage accounting: the FIRST usage/finish report for a lease adds the
 * reported tokens to the project's UTC-day counter (day = the report day);
 * later reports keep the max on the lease record but never add again. A
 * preempted lease's teardown report therefore still counts its partial
 * tokens exactly once.
 */

import { randomBytes } from 'node:crypto';
import type { IdleDetector } from './idle.js';
import { activeLeaseExemptIps } from './idle.js';
import type { IdleSignal } from './types.js';
import type { StateStore } from './state.js';
import type { ClientOverride, Lease, ProjectAllocation, ServerConfig, ServerConnection, UtcDate } from './types.js';

export type LeaseRejectionReason =
  | 'not_idle'
  | 'busy'
  | 'project_paused'
  | 'budget_exhausted'
  | 'unknown_project'
  | 'unknown_client'
  | 'client_paused';

export interface LeaseGrantResult {
  ok: boolean;
  lease?: Lease;
  reason?: LeaseRejectionReason;
}

export interface TickResult {
  /** Leases revoked/expired this tick — push WS events for these. */
  revoked: { lease: Lease; reason: string }[];
  signal: IdleSignal;
}

export class Arbiter {
  private readonly store: StateStore;
  private readonly cfg: ServerConfig;
  /** Armed after any revocation; disarmed by the next full-idle verdict. */
  private reidleAfter: number | null = null;

  constructor(store: StateStore, cfg: ServerConfig, private detector: IdleDetector) {
    this.store = store;
    this.cfg = cfg;
    // A fresh Arbiter must see the seeded server inventory, not just one
    // that went through index.ts: the API/tests construct the arbiter
    // directly. Idempotent — a non-empty state file is left untouched.
    this.ensureServersSeeded();
  }

  // ------------------------------------------------------------------
  // Clients
  // ------------------------------------------------------------------

  /**
   * Register (idempotent on name). Re-registration refreshes `last_seen`
   * (the client's liveness heartbeat — the dashboard shows it) and replaces
   * the reported project allocations (the client re-sends its queue depths
   * every poll tick, so the dashboard's per-project worker view stays fresh).
   */
  registerClient(
    name: string,
    reportedIp: string | undefined,
    observedIp: string,
    projects?: ProjectAllocation[],
    now?: number,
  ): { client_id: string; created: boolean } {
    const s = this.store.state;
    const seen = now ?? Date.now();
    const existing = s.clients.find((c) => c.name === name);
    if (existing) {
      if (reportedIp) existing.ip = reportedIp;
      else if (!existing.ip) existing.ip = observedIp;
      if (observedIp) existing.observed_ip = observedIp;
      existing.last_seen = seen;
      if (projects) existing.projects = projects;
      this.store.save();
      return { client_id: existing.client_id, created: false };
    }
    const client_id = `c-${randomBytes(4).toString('hex')}`;
    s.clients.push({
      name,
      client_id,
      ip: reportedIp ?? observedIp,
      observed_ip: observedIp,
      registered_at: new Date(seen).toISOString(),
      last_seen: seen,
      projects: projects ?? [],
    });
    this.store.appendEvent({ kind: 'client_registered', detail: `${name} (${client_id})` });
    this.store.trim();
    this.store.save();
    return { client_id, created: true };
  }

  clientIp(clientId: string): string | null {
    const c = this.store.state.clients.find((x) => x.client_id === clientId);
    return c ? c.ip : null;
  }

  // ------------------------------------------------------------------
  // Client overrides (pause / force)
  // ------------------------------------------------------------------

  /**
   * The override that is in force for a client at `now`, or null:
   *   - no override stored
   *   - override expired (until !== null && now >= until)
   *   - client no longer registered (defensive; tick trims these)
   */
  activeOverride(clientId: string, now?: number): ClientOverride | null {
    const n = now ?? Date.now();
    const o = this.store.state.overrides[clientId];
    if (!o) return null;
    if (o.until !== null && n >= o.until) return null;
    if (!this.store.state.clients.some((c) => c.client_id === clientId)) return null;
    return o;
  }

  /**
   * Set (replace) or clear (override: null) the override for a client,
   * addressed by name or client_id. Persists + records an event.
   */
  setClientOverride(
    ref: string,
    override: 'pause' | 'force' | null,
    until?: number,
  ): { ok: boolean; reason?: string; override?: ClientOverride | null; client_name?: string } {
    const s = this.store.state;
    const client = s.clients.find((c) => c.client_id === ref || c.name === ref);
    if (!client) return { ok: false, reason: 'unknown_client' };
    if (override !== null && until !== undefined) {
      const n = Date.now();
      if (!Number.isFinite(until) || until <= n) return { ok: false, reason: 'until_must_be_in_the_future' };
    }

    if (override === null) {
      const had = s.overrides[client.client_id];
      delete s.overrides[client.client_id];
      if (had) {
        this.store.appendEvent({
          kind: 'client_override_cleared',
          detail: `${client.name}: ${had.override} cleared`,
        });
      }
      this.store.trim();
      this.store.save();
      return { ok: true, override: null, client_name: client.name };
    }

    const o: ClientOverride = {
      client_id: client.client_id,
      override,
      until: until ?? null,
      set_at: Date.now(),
    };
    s.overrides[client.client_id] = o;
    this.store.appendEvent({
      kind: override === 'pause' ? 'client_paused' : 'client_forced',
      detail: `${client.name}${o.until ? ` (until ${new Date(o.until).toISOString().slice(11, 16)}Z)` : ''}`,
    });
    this.store.trim();
    this.store.save();
    return { ok: true, override: o, client_name: client.name };
  }

  // ------------------------------------------------------------------
  // Grants
  // ------------------------------------------------------------------

  requestLease(params: {
    client_id: string;
    project: string;
    job_id: string;
    estimated_seconds: number;
    now?: number;
    signal?: IdleSignal;
  }): LeaseGrantResult {
    const now = params.now ?? Date.now();
    const s = this.store.state;

    const client = s.clients.find((c) => c.client_id === params.client_id);
    if (!client) return { ok: false, reason: 'unknown_client' };

    const sig = params.signal ?? this.detector.signal(now);

    // A 'pause' override is a hard stop for that client — it is reported
    // preferentially (before idle/busy) so the operator's decision is the
    // reason a denied lease gets. It does not touch an already-active lease
    // (the client is mid-run; revocation is driven by idle/preempt/TTL only).
    if (this.activeOverride(params.client_id, now)?.override === 'pause') {
      return { ok: false, reason: 'client_paused' };
    }

    // `sig.idle` is false while degraded (detector invariant), so this single
    // check enforces both "system idle" and "no grants while degraded".
    // An active 'force' override bypasses ONLY the idle verdict and the
    // post-revocation reidle gate — never a degraded signal, because a
    // degraded signal means the activity data itself is unreliable and a
    // forced grant on stale data is exactly the interactive-traffic
    // collision the arbiter exists to prevent.
    const forced = this.activeOverride(params.client_id, now)?.override === 'force';
    if (!forced) {
      if (!sig.idle) return { ok: false, reason: 'not_idle' };
      // Post-revocation reidle rule: after any revocation, require a fresh
      // full idle before the next grant (a regrant in the same poll would let
      // a burst of backfill follow a preempt).
      if (this.reidleAfter !== null) return { ok: false, reason: 'not_idle' };
    } else if (sig.signal_degraded) {
      // Force ≠ "grant on stale data": degraded still blocks (see above).
      return { ok: false, reason: 'not_idle' };
    }

    const active = this.activeLeases(now);
    const project = this.cfg.projects.find((p) => p.name === params.project);
    if (!project) return { ok: false, reason: 'unknown_project' };
    if (project.paused) return { ok: false, reason: 'project_paused' };

    // Per-project grant knobs override the globals (unset = inherit).
    const maxLeases = project.max_concurrent_leases ?? this.cfg.max_concurrent_leases;
    if (active.length >= maxLeases) return { ok: false, reason: 'busy' };

    const used = this.projectTokensOut(params.project, utcDay(now));
    if (used >= project.daily_token_cap) return { ok: false, reason: 'budget_exhausted' };

    const ttlSeconds = project.lease_ttl_seconds ?? this.cfg.lease_ttl_seconds;
    const lease: Lease = {
      lease_id: `l-${randomBytes(4).toString('hex')}`,
      client_id: client.client_id,
      client_name: client.name,
      exempt_ip: client.ip,
      project: project.name,
      job_id: String(params.job_id ?? ''),
      estimated_seconds: Math.max(0, params.estimated_seconds || 0),
      status: 'active',
      granted_at: now,
      expires_at: now + ttlSeconds * 1000,
      tokens_out: 0,
      tokens_in: 0,
    };
    s.leases.push(lease);
    this.store.appendEvent({ kind: 'lease_granted', project: lease.project, lease_id: lease.lease_id, detail: `${client.name}: ${lease.job_id}` });
    this.store.trim();
    this.store.save();
    return { ok: true, lease };
  }

  // ------------------------------------------------------------------
  // Tick (called once per idle poll by the main loop)
  // ------------------------------------------------------------------

  async tick(now?: number): Promise<TickResult> {
    const nowMs = now ?? Date.now();
    const exempt = activeLeaseExemptIps(this.store.state.leases, nowMs);
    const signal = await this.detector.poll(nowMs, exempt);

    // Mirror the detector's degraded transition into state + events.
    const s = this.store.state;
    if (signal.signal_degraded !== s.signal_degraded) {
      s.signal_degraded = signal.signal_degraded;
      s.degraded_reason = signal.degraded_reason;
      this.store.appendEvent({
        kind: signal.signal_degraded ? 'signal_degraded' : 'signal_recovered',
        detail: signal.degraded_reason ?? undefined,
      });
    }
    s.last_activity = signal.last_activity;
    s.last_log_write = signal.last_log_write;

    const revoked: { lease: Lease; reason: string }[] = [];

    for (const lease of s.leases) {
      if (lease.status !== 'active') continue;

      // 1. TTL expiry.
      if (nowMs >= lease.expires_at) {
        this.endLease(lease, 'expired', 'ttl_expired', nowMs);
        revoked.push({ lease, reason: 'ttl_expired' });
        continue;
      }

      // 2. Preempt: system is NOT idle because of FOREIGN (non-exempt)
      //    activity that appeared after this lease was granted.
      //    - degraded: don't judge from stale signals (skip).
      //    - if idle: nothing preempts.
      //    - a non-exempt entry OLDER than the grant (stale) does not revoke.
      if (!signal.signal_degraded && !signal.idle && signal.last_activity) {
        if (signal.last_activity.ts >= lease.granted_at) {
          this.endLease(lease, 'revoked', 'preempted', nowMs);
          revoked.push({ lease, reason: 'preempted' });
        }
      }
    }

    // Sweep client overrides: drop expired ones (now >= until) and orphans
    // (client no longer registered) so state stays clean between writes.
    for (const [cid, o] of Object.entries(s.overrides)) {
      const gone =
        !s.clients.some((c) => c.client_id === cid) ||
        (o.until !== null && nowMs >= o.until);
      if (gone) delete s.overrides[cid];
    }

    // Reidle bookkeeping: any revocation (preempt or TTL) arms the gate;
    // a later full-idle verdict disarms it.
    if (revoked.length > 0) {
      this.reidleAfter = nowMs;
    } else if (signal.idle && this.reidleAfter !== null) {
      this.reidleAfter = null;
    }

    this.store.trim();
    this.store.save();
    return { revoked, signal };
  }

  /** True when a grant is currently blocked by the post-revocation reidle rule. */
  reidleGated(): boolean {
    return this.reidleAfter !== null;
  }

  // ------------------------------------------------------------------
  // Finishing + usage
  // ------------------------------------------------------------------

  /**
   * Finish a lease with reported usage.
   *
   * Idempotency is per-lease, not per-status: the FIRST usage report adds
   * the reported tokens to the project's UTC-day counter (day of the
   * report); repeated finishes keep the max on the lease record and add
   * nothing (no double count). A preempted lease therefore counts its
   * partial teardown report exactly once — at the moment the client sends
   * it, which is the "client reports partial usage at teardown" path.
   */
  finishLease(params: {
    lease_id: string;
    tokens_out?: number;
    tokens_in?: number;
    ok: boolean;
    error?: string;
    now?: number;
  }): { ok: boolean; reason?: string; lease?: Lease } {
    const nowMs = params.now ?? Date.now();
    const s = this.store.state;
    const lease = s.leases.find((l) => l.lease_id === params.lease_id);
    if (!lease) return { ok: false, reason: 'unknown_lease' };

    const to = Math.max(0, params.tokens_out ?? 0);
    const ti = Math.max(0, params.tokens_in ?? 0);

    // Keep the max ever reported (duplicate/partial reports never shrink it).
    lease.tokens_out = Math.max(lease.tokens_out, to);
    lease.tokens_in = Math.max(lease.tokens_in, ti);
    lease.partial = params.ok === false;

    if (!lease.usage_counted) {
      this.addBudget(lease.project, utcDay(nowMs), lease.tokens_out, lease.tokens_in);
      lease.usage_counted = true;
    }

    if (lease.status === 'active') {
      // First terminal transition.
      lease.status = params.ok ? 'finished' : 'revoked';
      if (!params.ok) lease.end_reason = params.error ?? 'failed';
      lease.ended_at = nowMs;
      this.store.appendEvent({
        kind: 'lease_finished',
        project: lease.project,
        lease_id: lease.lease_id,
        detail: `${lease.client_name}: ${lease.job_id} ok=${params.ok} out=${lease.tokens_out}${params.error ? ` err=${params.error}` : ''}`,
      });
    }
    // (already terminal: usage recorded above; status/end_reason stay as-is)

    this.store.trim();
    this.store.save();
    return { ok: true, lease };
  }

  // ------------------------------------------------------------------
  // Projects
  // ------------------------------------------------------------------

  setProjectPaused(name: string, paused: boolean): { ok: boolean; reason?: string } {
    const p = this.cfg.projects.find((x) => x.name === name);
    if (!p) return { ok: false, reason: 'unknown_project' };
    p.paused = paused;
    this.store.appendEvent({ kind: paused ? 'project_paused' : 'project_resumed', project: name });
    this.syncProjectRows();
    this.store.trim();
    this.store.save();
    return { ok: true };
  }

  /**
   * Project-level grant settings (idle_seconds / max_concurrent_leases /
   * lease_ttl_seconds). A value of null CLEARS the per-project override —
   * the project inherits the global knob again. Persisted on the live project
   * config object (survives restarts via the state file's project rows).
   */
  setProjectSettings(
    name: string,
    settings: { idle_seconds?: number | null; max_concurrent_leases?: number | null; lease_ttl_seconds?: number | null },
  ): { ok: boolean; reason?: string } {
    const p = this.cfg.projects.find((x) => x.name === name);
    if (!p) return { ok: false, reason: 'unknown_project' };
    const setKnob = (key: 'idle_seconds' | 'max_concurrent_leases' | 'lease_ttl_seconds', v: number | null | undefined) => {
      if (v === null) delete p[key];
      else if (typeof v === 'number' && Number.isFinite(v) && v > 0) p[key] = v;
    };
    setKnob('idle_seconds', settings.idle_seconds);
    setKnob('max_concurrent_leases', settings.max_concurrent_leases);
    setKnob('lease_ttl_seconds', settings.lease_ttl_seconds);
    const changed =
      settings.idle_seconds !== undefined ||
      settings.max_concurrent_leases !== undefined ||
      settings.lease_ttl_seconds !== undefined;
    if (!changed) return { ok: true };
    this.store.appendEvent({
      kind: 'project_settings_updated',
      project: name,
      detail: [
        p.idle_seconds != null ? `idle≥${p.idle_seconds}s` : '',
        p.max_concurrent_leases != null ? `max ${p.max_concurrent_leases}` : '',
        p.lease_ttl_seconds != null ? `ttl ${p.lease_ttl_seconds}s` : '',
      ]
        .filter(Boolean)
        .join(' · ') || 'inheriting globals',
    });
    this.syncProjectRows();
    this.store.trim();
    this.store.save();
    return { ok: true };
  }

  /**
   * Mirror the live project config rows (pause + per-project knobs) into the
   * state file's persisted project rows; rows for projects removed from
   * config are dropped. Called after every project mutation and once at
   * boot (after the re-hydration) so the persisted rows are truth.
   */
  syncProjectRows(): void {
    const nowMs = Date.now();
    const prev = new Map(this.store.state.projects.map((r) => [r.name, r]));
    this.store.state.projects = this.cfg.projects.map((p) => ({
      name: p.name,
      paused: p.paused,
      idle_seconds: p.idle_seconds,
      max_concurrent_leases: p.max_concurrent_leases,
      lease_ttl_seconds: p.lease_ttl_seconds,
      updated_at: prev.get(p.name)?.updated_at ?? nowMs,
    }));
  }

  // ------------------------------------------------------------------
  // Inference-server connections
  // ------------------------------------------------------------------

  /**
   * Seed the declared-server inventory from config on first load (old state
   * files have no `servers` key). Once rows exist they are operator-managed
   * via the API and are NOT re-seeded — config is the initial declaration,
   * the state file is the live truth.
   */
  ensureServersSeeded(): void {
    const s = this.store.state;
    if (s.servers.length > 0) return;
    const nowMs = Date.now();
    s.servers.push({
      id: 'srv-watched',
      name: this.cfg.server_name ?? 'llama-swap',
      url: this.cfg.llama_swap_url,
      activity_path: this.cfg.activity_path,
      models: [...(this.cfg.server_models ?? [])],
      peers: [...(this.cfg.server_peers ?? [])],
      configured_at: nowMs,
      updated_at: nowMs,
    });
    this.store.save();
  }

  /**
   * Add (no `id`) or patch-update (with `id`) a declared server connection.
   * Create requires name + url; an update patches only the fields provided
   * (at least one must change). Pure inventory: the arbiter keeps watching
   * its single configured feed — a declared row is where a future
   * multi-feed core will point the watcher.
   */
  upsertServerConnection(input: {
    id?: string;
    name?: string;
    url?: string;
    activity_path?: string;
    models?: string[];
    peers?: string[];
  }): { ok: boolean; reason?: string; created: boolean; server?: ServerConnection } {
    const s = this.store.state;
    const strList = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined;
    const models = strList(input.models);
    const peers = strList(input.peers);
    const nowMs = Date.now();
    if (typeof input.id === 'string' && input.id.trim() !== '') {
      const row = s.servers.find((x) => x.id === input.id!.trim());
      if (!row) return { ok: false, reason: 'unknown_server', created: false };
      let changed = false;
      const touch = (apply: () => void) => {
        apply();
        changed = true;
      };
      if (typeof input.name === 'string' && input.name.trim() !== '') touch(() => void (row.name = input.name!.trim()));
      if (typeof input.url === 'string' && input.url.trim() !== '') touch(() => void (row.url = input.url!.trim()));
      if (typeof input.activity_path === 'string' && input.activity_path.trim() !== '')
        touch(() => void (row.activity_path = input.activity_path!.trim()));
      if (models) touch(() => void (row.models = models));
      if (peers) touch(() => void (row.peers = peers));
      if (!changed) return { ok: false, reason: 'nothing to update (provide name, url, activity_path, models, or peers)', created: false };
      row.updated_at = nowMs;
      this.store.appendEvent({ kind: 'server_connection_updated', detail: `${row.name} (${row.url})` });
      this.store.trim();
      this.store.save();
      return { ok: true, created: false, server: row };
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!name || !url) return { ok: false, reason: 'name and url required', created: false };
    if (!/^https?:\/\//.test(url)) return { ok: false, reason: 'url must be an http(s) address', created: false };
    const activityPath =
      typeof input.activity_path === 'string' && input.activity_path.trim() !== '' ? input.activity_path.trim() : '/api/metrics/activity';
    const dupe = s.servers.find((x) => x.url === url && x.activity_path === activityPath);
    if (dupe) return { ok: false, reason: `duplicate connection: ${dupe.name} already declared at this url + activity path`, created: false };
    const server: ServerConnection = {
      id: `srv-${randomBytes(4).toString('hex')}`,
      name,
      url,
      activity_path: activityPath,
      models: models ?? [],
      peers: peers ?? [],
      configured_at: nowMs,
      updated_at: nowMs,
    };
    s.servers.push(server);
    this.store.appendEvent({ kind: 'server_connection_added', detail: `${name} (${url})` });
    this.store.trim();
    this.store.save();
    return { ok: true, created: true, server };
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  activeLeases(now?: number): Lease[] {
    const n = now ?? Date.now();
    return this.store.state.leases.filter((l) => l.status === 'active' && l.expires_at > n);
  }

  /** Active leases + the last `limit` finished/revoked/expired, newest last. */
  recentLeases(limit = 50): Lease[] {
    const active = this.activeLeases();
    const terminal = this.store.state.leases.filter((l) => l.status !== 'active');
    return [...terminal.slice(terminal.length > limit ? terminal.length - limit : 0), ...active];
  }

  /** Output tokens consumed by a project on a UTC day. */
  projectTokensOut(project: string, day: UtcDate): number {
    return this.store.state.budgets[project]?.[day]?.tokens_out ?? 0;
  }

  /**
   * Effective grant knobs for a project (per-project overrides win; unset
   * = inherit the globals). Also exposed on the state view's `scheduling`.
   */
  projectEffectiveSettings(name: string): { idle_seconds: number; max_concurrent_leases: number; lease_ttl_seconds: number } {
    const p = this.cfg.projects.find((x) => x.name === name);
    return {
      idle_seconds: p?.idle_seconds ?? this.cfg.idle_seconds,
      max_concurrent_leases: p?.max_concurrent_leases ?? this.cfg.max_concurrent_leases,
      lease_ttl_seconds: p?.lease_ttl_seconds ?? this.cfg.lease_ttl_seconds,
    };
  }

  projectBudget(project: string, day: UtcDate) {
    const e = this.store.state.budgets[project]?.[day] ?? { tokens_out: 0, tokens_in: 0 };
    const cap = this.cfg.projects.find((p) => p.name === project)?.daily_token_cap ?? 0;
    return { ...e, cap };
  }

  // ------------------------------------------------------------------

  private addBudget(project: string, day: UtcDate, tokensOut: number, tokensIn: number): void {
    const per = (this.store.state.budgets[project] ??= {});
    const e = (per[day] ??= { tokens_out: 0, tokens_in: 0 });
    e.tokens_out += tokensOut;
    e.tokens_in += tokensIn;
  }

  private endLease(lease: Lease, status: 'revoked' | 'expired', reason: string, now: number): void {
    lease.status = status;
    lease.end_reason = reason;
    lease.ended_at = now;
    this.store.appendEvent({
      kind: 'lease_revoked',
      project: lease.project,
      lease_id: lease.lease_id,
      detail: `${lease.client_name}: ${reason} (job ${lease.job_id})`,
    });
  }
}

/** UTC day key for an epoch-ms timestamp: "2026-09-25". */
export function utcDay(ms: number): UtcDate {
  return new Date(ms).toISOString().slice(0, 10);
}
