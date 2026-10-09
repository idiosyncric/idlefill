/**
 * Mesh federation — the read plane (#50 D1/D2, decision: docs/architecture/mesh.md).
 *
 * Each arbiter PULLS a coarse snapshot from each configured peer on the
 * poll cadence and publishes the merged view. No hub, no gossip, no
 * cross-arbiter write: every arbiter stays the single source of truth for
 * its own machine. Snapshots are EPHEMERAL — held in memory, never
 * written to state.json (a persisted peer snapshot would become stale
 * remote truth on disk; the state file stays one machine's truth).
 *
 * The snapshot is COARSE by construction (privacy by endpoint scope, not
 * by filter): presence, per-engine idle signal, queue DEPTHS, session
 * counts, active lease counts. Never job ids, titles, URLs, or payloads.
 *
 * Failure posture: a failed peer fetch is not an error. The peer row
 * keeps its last snapshot with a growing fetch age; past PEER_STALE_MS
 * (the 90s liveness precedent) it renders offline. Exception-only: the
 * error string rides the row only while the last fetch failed.
 */

import { randomBytes } from 'node:crypto';
import type { ServerConfig } from './types.js';

/** Peer liveness window — the 90s client-liveness precedent, reused. */
export const PEER_STALE_MS = 90_000;

/** Hard caps on a REMOTE snapshot (it is untrusted input — same
 *  discipline as cleanPreview/cleanStats on the registration path). */
const MAX_SERVERS = 20;
const MAX_NAME = 64;

/**
 * The coarse snapshot one arbiter publishes at GET /api/mesh and pulls
 * from peers. Field-for-field display data — the mesh never moves
 * decisions (state is published, never computed remotely).
 */
export interface MeshSnapshot {
  /** The publishing instance's stable id (persisted; survives restarts). */
  instance_id: string;
  /** Display name (config mesh_name, default hostname). */
  name: string;
  /** Publisher's clock at snapshot time (epoch-ms, its own clock). */
  ts: number;
  /** Version handshake facts (display-only, exception-only). */
  version?: string;
  /** The publisher's ed25519 public key (#55 D1) — ADD key; absent = unset. */
  public_key?: string;
  /** One row per LOCAL engine this arbiter owns — coarse signal only. */
  servers: {
    name: string;
    idle: boolean;
    idle_for_s: number | null;
    degraded: boolean;
  }[];
  /** Sum of queue depths across this machine's clients (a number, not rows). */
  queue_depth: number;
  /** Interactive sessions registered on this machine. */
  sessions: number;
  /** Active leases on this machine. */
  active_leases: number;
}

/** The local view of one configured peer (what /api/state's mesh key carries). */
export interface PeerView {
  url: string;
  /** Config name, falling back to the observed snapshot name, falling back to the URL host. */
  name: string;
  /** Observed instance id (the identity — tailnet IPs move, the id does not). */
  instance_id: string | null;
  online: boolean;
  /** Seconds since the last SUCCESSFUL fetch (null = never succeeded). */
  fetch_age_s: number | null;
  /** Last fetch error — exception-only, cleared on the next success. */
  error?: string;
  /** The last snapshot pulled (null = never succeeded). */
  snapshot: MeshSnapshot | null;
}

/** Fetch one peer's /api/mesh snapshot. Injectable for tests; throws on any failure. */
export type MeshFetcher = (url: string, token: string) => Promise<unknown>;

interface PeerEntry {
  url: string;
  name?: string;
  instanceId: string | null;
  lastOk: number | null;
  lastError: string | null;
  snapshot: MeshSnapshot | null;
}

export class MeshFederation {
  private readonly cfg: ServerConfig;
  private readonly fetcher: MeshFetcher;
  private readonly peers = new Map<string, PeerEntry>();

  constructor(cfg: ServerConfig, fetcher: MeshFetcher) {
    this.cfg = cfg;
    this.fetcher = fetcher;
    for (const p of cfg.mesh_peers ?? []) {
      const url = String(p?.url ?? '').trim().replace(/\/+$/, '');
      if (!url || url === 'self') continue;
      if (!this.peers.has(url)) {
        this.peers.set(url, { url, name: p.name?.trim() || undefined, instanceId: null, lastOk: null, lastError: null, snapshot: null });
      }
    }
  }

  /** True when at least one peer is configured (the tick can skip the work otherwise). */
  get enabled(): boolean {
    return this.peers.size > 0;
  }

  /**
   * Pull every peer concurrently. Never throws: each peer's failure is
   * recorded on its own row (exception-only) and the previous snapshot
   * stands.
   */
  async refresh(now: number): Promise<void> {
    if (this.peers.size === 0) return;
    const token = this.cfg.peer_token ?? '';
    await Promise.all(
      [...this.peers.values()].map(async (p) => {
        try {
          const raw = await this.fetcher(`${p.url}/api/mesh`, token);
          const snap = sanitizeSnapshot(raw);
          if (!snap) {
            p.lastError = 'malformed snapshot';
            return;
          }
          p.snapshot = snap;
          p.instanceId = snap.instance_id;
          p.lastOk = now;
          p.lastError = null;
        } catch (err) {
          p.lastError = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
        }
      }),
    );
  }

  /** The merged peer view for /api/state (local machine is NOT a row here). */
  view(now: number): PeerView[] {
    return [...this.peers.values()].map((p) => ({
      url: p.url,
      name: p.name ?? p.snapshot?.name ?? hostOf(p.url),
      instance_id: p.instanceId,
      online: p.lastOk !== null && now - p.lastOk < PEER_STALE_MS,
      fetch_age_s: p.lastOk === null ? null : Math.max(0, Math.round((now - p.lastOk) / 1000)),
      ...(p.lastError ? { error: p.lastError } : {}),
      snapshot: p.snapshot,
    }));
  }
}

/**
 * Build THIS instance's coarse snapshot for GET /api/mesh. Takes narrow
 * inputs (not the Arbiter) so mesh.ts stays dependency-light and testable.
 */
export function buildMeshSnapshot(
  instanceId: string,
  name: string,
  servers: { name: string; signal: { idle: boolean; idle_for_s: number | null; signal_degraded: boolean } | null }[],
  queueDepth: number,
  sessions: number,
  activeLeases: number,
  now: number,
  version?: string,
  /** The publisher's ed25519 public key (#55 D1) — ADD key, absent = unset. */
  publicKey?: string,
): MeshSnapshot {
  const snap: MeshSnapshot = {
    instance_id: instanceId,
    name,
    ts: now,
    servers: servers.slice(0, MAX_SERVERS).map((s) => ({
      name: String(s.name).slice(0, MAX_NAME),
      idle: s.signal?.idle === true,
      idle_for_s: s.signal?.idle_for_s ?? null,
      degraded: s.signal?.signal_degraded === true,
    })),
    queue_depth: Number.isFinite(queueDepth) && queueDepth >= 0 ? Math.floor(queueDepth) : 0,
    sessions: Number.isFinite(sessions) && sessions >= 0 ? Math.floor(sessions) : 0,
    active_leases: Number.isFinite(activeLeases) && activeLeases >= 0 ? Math.floor(activeLeases) : 0,
  };
  if (version) snap.version = String(version).slice(0, MAX_NAME);
  // #55 D1: the publisher's ed25519 public key. ADD key — present when the
  // publisher mints an identity, ABSENT (unset) otherwise; existing readers
  // that predate the field simply ignore it.
  if (typeof publicKey === 'string' && publicKey.trim() !== '') snap.public_key = publicKey.slice(0, 64);
  return snap;
}

/**
 * Validate + clamp a REMOTE snapshot. Returns null when the payload is
 * not a usable snapshot at all (wrong shape, missing identity). Every
 * string is length-capped and every number must be finite — a hostile or
 * buggy peer must not bloat or poison the local state view.
 */
export function sanitizeSnapshot(raw: unknown): MeshSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const instance_id = typeof r.instance_id === 'string' && r.instance_id.trim() !== '' ? r.instance_id.slice(0, 64) : '';
  if (!instance_id) return null;
  const name = typeof r.name === 'string' ? r.name.slice(0, MAX_NAME) : '';
  const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : 0;
  const servers: MeshSnapshot['servers'] = [];
  if (Array.isArray(r.servers)) {
    for (const s of r.servers.slice(0, MAX_SERVERS)) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
      const row = s as Record<string, unknown>;
      const sname = typeof row.name === 'string' && row.name.trim() !== '' ? row.name.slice(0, MAX_NAME) : 'engine';
      servers.push({
        name: sname,
        idle: row.idle === true,
        idle_for_s: typeof row.idle_for_s === 'number' && Number.isFinite(row.idle_for_s) && row.idle_for_s >= 0 ? Math.round(row.idle_for_s) : null,
        degraded: row.degraded === true,
      });
    }
  }
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const out: MeshSnapshot = {
    instance_id,
    name,
    ts,
    servers,
    queue_depth: num(r.queue_depth),
    sessions: num(r.sessions),
    active_leases: num(r.active_leases),
  };
  if (typeof r.version === 'string' && r.version.trim() !== '') out.version = r.version.slice(0, MAX_NAME);
  // #55 D1: the publisher's public key — ADD key, untrusted input, length-
  // capped like the rest. Absent on pre-#55 peers; the field stays unset.
  if (typeof r.public_key === 'string' && r.public_key.trim() !== '') out.public_key = r.public_key.slice(0, 64);
  return out;
}

/** Mint a fresh instance id (`m-<hex>` — the mesh identity, #50 D2). */
export function mintInstanceId(): string {
  return `m-${randomBytes(6).toString('hex')}`;
}

/** Default (real) peer fetcher: GET {peer}/api/mesh with the fleet read token. */
export function makeRealMeshFetcher(timeoutMs = 10_000): MeshFetcher {
  return async (url, token) => {
    const res = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`mesh fetch HTTP ${res.status}`);
    return await res.json();
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
