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
 *
 * Fleet roster seam (#55 D3, PROPOSED — docs/architecture/fleet-service.md):
 * when `fleet_url` is set the arbiter pulls `GET /roster` from the fleet
 * service on the pull interval and merges the roster rows into the peer
 * set. The service is the directory, never the pipe: a merged row is
 * pulled from its own /api/mesh on the normal cadence, exactly like a
 * configured peer. The roster is ADD-only — it adds peers, never
 * removes or modifies entries. Service unreachable = the pull fails
 * silently and the last-known peer set stands byte-for-byte (the
 * Service-down rule). Absent `fleet_url` = the pull never happens.
 */

import { randomBytes } from 'node:crypto';
import { FleetClient, enrollmentFileOf, type FleetClientConfig } from './fleet-client.js';
import { Identity } from './identity.js';
import type { ServerConfig } from './types.js';

/** Peer liveness window — the 90s client-liveness precedent, reused. */
export const PEER_STALE_MS = 90_000;

/** PROPOSED: the fleet roster pull interval (#55 D3, owner choice 3).
 *  15 s — the existing poll tick. Configurable via `fleet_roster_pull_ms`. */
export const ROSTER_PULL_MS = 15_000;

/** Hard caps on a REMOTE snapshot (it is untrusted input — same
 *  discipline as cleanPreview/cleanStats on the registration path). */
const MAX_SERVERS = 20;
const MAX_NAME = 64;
/** Hard caps on a fleet ROSTER (untrusted input, same discipline). */
const MAX_ROSTER_ROWS = 100;
const MAX_URLS_PER_ROW = 16;

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
  /**
   * Fleet membership label (#55 D5, locked) — which tenant this instance
   * belongs to. ADD key: absent on a snapshot from a pre-#55-slice-2 peer =
   * unset (the reader treats it as no label; never a crash). A display label
   * only — never a secret.
   */
  fleet_id?: string;
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

/**
 * One row of the fleet roster (the shape `GET /roster` returns per
 * instance — fleet/src/store.ts RosterEntry). Untrusted input: every
 * field is validated before the row touches the peer map.
 */
export interface RosterRow {
  instance_id: string;
  name: string;
  public_key: string;
  urls: string[];
  last_seen: number | null;
}

/**
 * Fetch the fleet roster: `GET {fleetUrl}/roster` (auth: a signed nonce —
 * see `makeSignedRosterFetcher`). Injectable for tests; throws on any
 * failure (a failed pull is a no-op — the Service-down rule).
 */
export type RosterFetcher = (fleetUrl: string, now: number) => Promise<unknown>;

/**
 * The signed roster fetcher (#55 D2 + D3, slice 7): the production
 * replacement for the pre-slice-5 plain fetch. Enrolls ONCE (a one-time
 * token + the instance public key + a name → a persisted session
 * credential in the sibling `fleet_enrollment.json`, the #39/#55 D2
 * posture: 0600, atomic tmp+rename, never in state.json), then mints +
 * signs a fresh nonce with the arbiter's ed25519 key (node:crypto only)
 * for every roster pull (D2 step 3: no shared fleet secret ever exists).
 *
 * Failure posture (the Service-down rule): a failed enroll or pull
 * throws — and `pullRoster` swallows it exactly as today (the last-known
 * peer set stands byte-for-byte). A 401 on the roster means the
 * credential no longer validates: recovery is a re-enrollment with a
 * fresh operator token (wiped-machine recovery, D2), not a crash.
 *
 * Injectable seams (tests): `enroll` / `signedRoster` replace the
 * `FleetClient` call path without a network; the default is the real
 * `FleetClient` bound to the #55 D1 identity.
 */
export interface SignedRosterOpts {
  /** The enrollment file path (default: `enrollmentFileOf(stateFile)`). */
  file?: string;
  /** Replaces the enroll call (tests): returns {ok, instance_id, credential, error?}. */
  enroll?: () => Promise<{ ok: boolean; instance_id?: string; credential?: string; error?: string }>;
  /** Replaces the signed roster call (tests): returns the raw envelope or null. */
  signedRoster?: () => Promise<unknown | null>;
}

export function makeSignedRosterFetcher(
  cfg: ServerConfig,
  identity: Identity,
  opts: SignedRosterOpts = {},
): RosterFetcher {
  const base = cfg.fleet_url!.replace(/\/+$/, '');
  const file = opts.file ?? enrollmentFileOf(cfg.state_file);
  const clientCfg: FleetClientConfig = {
    fleet_url: base,
    fleet_enrollment_token: cfg.fleet_enrollment_token ?? '',
    // The enrollment name: the mesh display name, falling back to the
    // config's server_name, then the hostname (the fleet roster row is a
    // display label, never a secret).
    name: cfg.mesh_name || cfg.server_name || 'arbiter',
  };
  const client = new FleetClient(file, clientCfg, identity);
  const enroll = opts.enroll ?? (() => client.ensureEnrolled());
  const signed =
    opts.signedRoster ??
    (async () => {
      // A persisted credential makes this a no-op; a missing credential
      // attempts the enroll first (idempotent — already spent = a no-op).
      void (await client.ensureEnrolled()).ok;
      return client.signedRoster();
    });
  return async (_fleetUrl, _now) => {
    // Enroll once (idempotent — a persisted credential skips the spend);
    // a failed enroll throws so pullRoster takes the no-op path.
    const r = await enroll();
    if (!r.ok || r.instance_id === undefined || r.credential === undefined) {
      throw new Error(`fleet enroll: ${r.error ?? 'unknown error'}`);
    }
    const raw = await signed();
    if (raw === null) throw new Error('fleet roster pull failed (service down or 401 — see [fleet] log line)');
    return raw;
  };
}

/**
 * Build the production roster fetcher for a live config (#55 D3 + D2,
 * slice 7): the SIGNED fetcher when `fleet_url` AND `fleet_instance_id`
 * AND `fleet_enrollment_token` are all present; otherwise a no-op
 * fetcher — the pull stays fail-quiet exactly as pre-slice-5 (the
 * Service-down rule: the last-known peer set stands byte-for-byte, no
 * crash, no enroll attempt, no credential file touched).
 *
 * The `fleet_instance_id` key is the declaration seam: "this instance has
 * a fleet identity" (its ed25519 keypair is the #55 D1 `identity.json`).
 * The fleet-issued id + credential persist in `fleet_enrollment.json`
 * after the first successful enroll — that file, not config, is the
 * source of truth for the signed calls.
 */
export function buildRosterFetcher(cfg: ServerConfig, identity: Identity): RosterFetcher {
  if (!cfg.fleet_url || !cfg.fleet_instance_id || !cfg.fleet_enrollment_token) {
    // Any of the three absent = the signed pull is inert. The fetcher
    // never runs (pullRoster is also gated on fleet_url alone for
    // backward-compatible tests) — and if it ever is called, it throws
    // into pullRoster's catch: a no-op, byte-for-byte, exactly today.
    return () => Promise.reject(new Error('fleet roster pull: not enrolled (fleet_url / fleet_instance_id / fleet_enrollment_token incomplete)'));
  }
  return makeSignedRosterFetcher(cfg, identity);
}

/**
 * Validate + clamp a REMOTE roster (untrusted input — the same discipline
 * as sanitizeSnapshot). Returns the usable rows. A malformed envelope
 * (wrong shape) yields []. A malformed ROW is dropped individually —
 * never trusted, never a crash. Row caps: MAX_ROSTER_ROWS rows,
 * MAX_URLS_PER_ROW urls, strings length-capped.
 */
export function sanitizeRoster(raw: unknown): RosterRow[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.instances)) return [];
  const out: RosterRow[] = [];
  for (const row of r.instances.slice(0, MAX_ROSTER_ROWS)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const ro = row as Record<string, unknown>;
    // Identity is exact, not clamped: a 5000-char "instance_id" is hostile
    // input, and truncating it would mint a fake identity. Drop the row.
    const rawId = typeof ro.instance_id === 'string' ? ro.instance_id : '';
    if (rawId.trim() === '' || rawId.length > 64) continue;
    const name = typeof ro.name === 'string' ? ro.name.slice(0, MAX_NAME) : '';
    const public_key = typeof ro.public_key === 'string' ? ro.public_key.slice(0, 256) : '';
    const last_seen = typeof ro.last_seen === 'number' && Number.isFinite(ro.last_seen) ? Math.floor(ro.last_seen) : null;
    const urls: string[] = [];
    if (Array.isArray(ro.urls)) {
      for (const u of ro.urls.slice(0, MAX_URLS_PER_ROW)) {
        if (typeof u !== 'string') continue;
        const clean = u.trim().slice(0, 2048);
        if (clean === '' || clean === 'self') continue;
        if (!/^https?:\/\//i.test(clean)) continue; // a mesh peer url is an http(s) address
        if (!urls.includes(clean)) urls.push(clean);
      }
    }
    if (urls.length === 0) continue; // a row with no usable url cannot be pulled from
    out.push({ instance_id: rawId, name, public_key, urls, last_seen });
  }
  return out;
}

interface PeerEntry {
  url: string;
  name?: string;
  instanceId: string | null;
  lastOk: number | null;
  lastError: string | null;
  snapshot: MeshSnapshot | null;
  /** Set when the row came from a fleet roster pull (ADD provenance). */
  rosterOrigin?: boolean;
}

export class MeshFederation {
  private readonly cfg: ServerConfig;
  private readonly fetcher: MeshFetcher;
  private readonly peers = new Map<string, PeerEntry>();
  /** When a roster pull is due next (epoch-ms). 0 = never armed (no fleet_url). */
  private nextRosterPullAt = 0;

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
   * Pull the fleet roster (if configured) and merge its rows into the peer
   * set. Never throws: a failed pull is a no-op (the Service-down rule —
   * the last-known peer set stands byte-for-byte).
   *
   * Merge rule (PROPOSED — #55 D3): ADD-only. A roster row adds a peer at
   * its first usable url. An explicit `mesh_peers` entry WINS over a roster
   * row for the same url (it was declared by the operator) and over the
   * same instance_id (the static registry is the truth; the roster only
   * fills in peers the operator did not name). A roster row never removes
   * or rewrites an existing entry.
   */
  async pullRoster(rosterFetcher: RosterFetcher, now: number): Promise<void> {
    const fleetUrl = this.cfg.fleet_url;
    if (!fleetUrl) return; // absent = the pull never happens
    const intervalMs = this.cfg.fleet_roster_pull_ms ?? ROSTER_PULL_MS;
    if (now < this.nextRosterPullAt) return; // not due yet (at most one pull per interval)
    this.nextRosterPullAt = now + intervalMs;
    let rows: RosterRow[];
    try {
      rows = sanitizeRoster(await rosterFetcher(fleetUrl, now));
    } catch {
      return; // unreachable / malformed envelope: the last-known set stands
    }
    // Merge rule (PROPOSED — #55 D3): ADD-only. An explicit `mesh_peers`
    // entry WINS over a roster row for the same instance_id — the static
    // registry is the truth the operator wrote. A configured peer's
    // instanceId is null until its first fetch, so "configured" is judged
    // by ORIGIN (rosterOrigin absent = from config), never by the observed
    // id. A roster row also never claims the id of an already-known peer.
    const configuredIds = new Set(
      [...this.peers.values()]
        .filter((p) => p.rosterOrigin !== true && p.instanceId !== null)
        .map((p) => p.instanceId as string),
    );
    for (const row of rows) {
      if (configuredIds.has(row.instance_id)) continue;
      // A roster row whose instance is already known (from a previous pull)
      // is not re-added: no rewrite, no url churn. ADD-only on the set.
      const existing = [...this.peers.values()].find((p) => p.instanceId === row.instance_id);
      if (existing) continue;
      for (const url of row.urls) {
        const clean = url.trim().replace(/\/+$/, '');
        if (!clean || clean === 'self' || this.peers.has(clean)) continue;
        this.peers.set(clean, {
          url: clean,
          name: row.name || undefined,
          instanceId: row.instance_id,
          lastOk: null,
          lastError: null,
          snapshot: null,
          rosterOrigin: true,
        });
      }
    }
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
  /** Fleet membership label (#55 D5) — ADD key, absent = unset. */
  fleetId?: string,
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
  // #55 D5: the fleet membership label. ADD key — present when the publisher
  // has one, ABSENT (unset) otherwise; old readers ignore it, a snapshot
  // without the field parses fine on this side.
  if (typeof fleetId === 'string' && fleetId.trim() !== '') snap.fleet_id = fleetId.trim().slice(0, MAX_NAME);
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
  // #55 D5: the fleet membership label — ADD key, untrusted input, length-
  // capped like the rest. Absent on pre-slice-2 peers; the field stays
  // unset, never a crash.
  if (typeof r.fleet_id === 'string' && r.fleet_id.trim() !== '') out.fleet_id = r.fleet_id.trim().slice(0, MAX_NAME);
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
