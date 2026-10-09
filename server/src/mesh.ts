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
import type { EdgeRecord } from './edges.js';

/** Peer liveness window — the 90s client-liveness precedent, reused. */
export const PEER_STALE_MS = 90_000;

/** PROPOSED: the fleet roster pull interval (#55 D3, owner choice 3).
 *  15 s — the existing poll tick. Configurable via `fleet_roster_pull_ms`. */
export const ROSTER_PULL_MS = 15_000;

/** PROPOSED: the fleet heartbeat interval (#55 D3, owner choice 1, slice 8).
 *  60 s — quieter than the 15 s poll tick; a moved address is re-published
 *  within a minute. Configurable via `fleet_heartbeat_ms`. The heartbeat
 *  RIDES the existing poll tick (no second network loop): at most one
 *  heartbeat per interval, NOT one per poll. */
export const HEARTBEAT_MS = 60_000;

/** Hard caps on a REMOTE snapshot (it is untrusted input — same
 *  discipline as cleanPreview/cleanStats on the registration path). */
const MAX_SERVERS = 20;
const MAX_NAME = 64;
/** Hard caps on a fleet ROSTER (untrusted input, same discipline). */
const MAX_ROSTER_ROWS = 100;
const MAX_URLS_PER_ROW = 16;
/** Max directed edges per roster row (bounded, untrusted input). */
const MAX_EDGES_PER_ROW = 64;

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
  /**
   * The directed edges this instance takes part in (the `edges` ADD key,
   * #55 D4 — fleet-service.md roster response `{from, to}`). ADD key:
   * absent on a pre-ceremony roster = no edges (an old service keeps
   * working byte-for-byte). Untrusted input: bounded + validated like
   * the rest of the row; a malformed edge is dropped individually.
   */
  edges: RosterEdgeRow[];
}

/**
 * Fetch the fleet roster: `GET {fleetUrl}/roster` (auth: a signed nonce —
 * see `makeSignedRosterFetcher`). Injectable for tests; throws on any
 * failure (a failed pull is a no-op — the Service-down rule).
 */
export type RosterFetcher = (fleetUrl: string, now: number) => Promise<unknown>;

/**
 * A directed roster edge (the `edges` ADD key on a roster row —
 * fleet-service.md roster response: `{from, to}`). Untrusted input:
 * both ends are exact, length-bounded identities; the direction is
 * carried as-is (it is a policy fact, not a secret).
 */
export interface RosterEdgeRow {
  /** The controlling instance (A in "A pairs to B"). */
  from: string;
  /** The controlled instance (B). */
  to: string;
}

/**
 * The local edge-record writer (#39 substrate, #55 D4 fill seam).
 * Given the roster's directed edge for the LOCAL instance, the arbiter
 * upserts the LOCAL side's `mesh_edges.json` record — the last-known-keys
 * posture (fleet-service.md Service-down rule 1: peers keep working with
 * last-known keys; a roster row carries the peer's public key). The
 * writer is the seam so mesh.ts stays dependency-light: the real writer
 * wraps `EdgeStore.upsert` (+ the `mesh_edge_formed` event) in index.ts;
 * tests pass a recorder. The writer NEVER throws a way out of the pull:
 * the caller wraps it in the same never-throw posture as the fetch.
 */
export type EdgeFiller = (
  localInstanceId: string,
  edge: RosterEdgeRow,
  peerPublicKey: string,
  peerName: string | undefined,
  direction: 'controls_me' | 'i_control',
) => void;

/**
 * The signed roster fetcher (#55 D2 + D3, slice 7): the production
 * replacement for the pre-slice-5 plain fetch. Enrolls ONCE (a one-time
 * token + the instance public key + a name -> a persisted session
 * credential in the sibling `fleet_enrollment.json`, the #55 D2
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
 * One fleet heartbeat send (#55 D3, slice 8): the arbiter's live urls +
 * coarse presence to the fleet service's `POST /heartbeat`. Injectable for
 * tests; the production sender (see `buildHeartbeatSender`) is fail-quiet
 * (null on any failure, never throws) — but `MeshFederation.sendHeartbeat`
 * wraps the seam in a try/catch anyway, so a THROWSING transport (the test
 * seam) cannot break the tick or touch the last-known peer set (the
 * Service-down rule).
 */
export type HeartbeatSender = (urls: string[], presence: 'online' | 'offline') => Promise<unknown | null>;

/**
 * The fleet heartbeat sender (#55 D3 owner choice 1, slice 8): the
 * production replacement for the pre-slice-8 "no heartbeat" behavior.
 * Enrolls ONCE (the SAME sibling `fleet_enrollment.json` as the roster
 * pull — `ensureEnrolled` is idempotent, so the one-time token is spent
 * exactly once across roster + heartbeat), then signs a fresh nonce per
 * heartbeat with the arbiter's ed25519 key (D2 step 3: no shared fleet
 * secret ever exists). The arbiter publishes its OWN urls
 * (`fleet_own_urls` — the operator's reachability declaration; the mesh
 * peers are INBOUND, this is the OUTBOUND self-declaration) + coarse
 * presence ('online' — a running arbiter is, by definition, online).
 *
 * Gating: ALL of `fleet_url` / `fleet_instance_id` / `fleet_enrollment_token`
 * present = the signed heartbeat; any one absent = the sender is inert
 * (a no-op returning null — no enroll, no network, no credential touched,
 * byte-for-byte the pre-slice-8 behavior).
 *
 * Failure posture (the Service-down rule): a failed heartbeat is a NO-OP
 * (fail-quiet: `heartbeatOnce` returns null on any failure, never throws).
 *
 * Injectable seams (tests): `enroll` / `heartbeat` replace the
 * `FleetClient` call path without a network; the default is the real
 * `FleetClient` bound to the #55 D1 identity.
 */
export interface HeartbeatSenderOpts {
  /** The enrollment file path (default: `enrollmentFileOf(stateFile)`). */
  file?: string;
  /** Replaces the enroll call (tests): returns {ok, instance_id, credential, error?}. */
  enroll?: () => Promise<{ ok: boolean; instance_id?: string; credential?: string; error?: string }>;
  /** Replaces the signed heartbeat call (tests): returns the raw response or null. */
  heartbeat?: (urls: string[], presence: 'online' | 'offline') => Promise<unknown | null>;
}

export function buildHeartbeatSender(
  cfg: ServerConfig,
  identity: Identity,
  opts: HeartbeatSenderOpts = {},
): HeartbeatSender {
  if (!cfg.fleet_url || !cfg.fleet_instance_id || !cfg.fleet_enrollment_token) {
    // Any of the three absent = the heartbeat is inert (byte-for-byte the
    // pre-slice-8 behavior: no enroll attempt, no network, no credential
    // file touched). The caller (MeshFederation.sendHeartbeat) also gates
    // on the three keys, so this is the second, defense-in-depth gate.
    return () => Promise.resolve(null);
  }
  const base = cfg.fleet_url.replace(/\/+$/, '');
  const file = opts.file ?? enrollmentFileOf(cfg.state_file);
  const clientCfg: FleetClientConfig = {
    fleet_url: base,
    fleet_enrollment_token: cfg.fleet_enrollment_token ?? '',
    // The heartbeat name: the mesh display name, falling back to the
    // config's server_name, then the hostname (a display label, never a
    // secret) — the same name the roster pull enrolls under.
    name: cfg.mesh_name || cfg.server_name || 'arbiter',
  };
  const client = new FleetClient(file, clientCfg, identity);
  const enroll = opts.enroll ?? (() => client.ensureEnrolled());
  const send =
    opts.heartbeat ??
    (async (urls: string[], presence: 'online' | 'offline') => {
      // A persisted credential makes this a no-op; a missing credential
      // attempts the enroll first (idempotent — already spent = a no-op).
      void (await client.ensureEnrolled()).ok;
      return client.heartbeatOnce(urls, presence);
    });
  return async (urls, presence) => {
    // Enroll once (idempotent — a persisted credential skips the spend);
    // a failed enroll is a no-op heartbeat (fail-quiet, never a throw).
    const r = await enroll();
    if (!r.ok || r.instance_id === undefined || r.credential === undefined) {
      return null;
    }
    return send(urls, presence);
  };
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
    // A row with no usable url cannot be PULLED from (no peer is added).
    // But it may still carry pairing edges (#55 D4), and dropping it would
    // silently lose a real pairing for a machine that has not heartbeated a
    // url yet. Keep the row when it carries edges; drop it when it carries
    // nothing usable at all.
    const hasEdges = Array.isArray(ro.edges) && ro.edges.length > 0;
    if (urls.length === 0 && !hasEdges) continue;
    // The `edges` ADD key (#55 D4): the directed edges this row's
    // instance takes part in. Untrusted input, same discipline as urls:
    // bounded count, strings exact + length-capped, a malformed edge
    // dropped individually (never a row drop — the row's peer facts are
    // still usable). Absent / non-array = no edges (pre-ceremony roster).
    const edges: RosterEdgeRow[] = [];
    if (Array.isArray(ro.edges)) {
      for (const e of ro.edges.slice(0, MAX_EDGES_PER_ROW)) {
        if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
        const eo = e as Record<string, unknown>;
        const from = typeof eo.from === 'string' ? eo.from.trim() : '';
        const to = typeof eo.to === 'string' ? eo.to.trim() : '';
        // Identity, exact: over-long ends are hostile, drop the edge.
        if (from === '' || to === '' || from.length > 64 || to.length > 64) continue;
        if (from === to) continue; // a self-edge is not a pairing
        if (edges.some((x) => x.from === from && x.to === to)) continue;
        edges.push({ from, to });
      }
    }
    out.push({ instance_id: rawId, name, public_key, urls, last_seen, edges });
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

/** Optional federation wiring (all absent = byte-for-byte the old behavior). */
export interface FederationOptions {
  /** The LOCAL instance id (for the roster edge fill). Absent = no fill. */
  localInstanceId?: () => string;
  /** The local edge-record writer (#55 D4 fill seam). Absent = no fill. */
  edgeFiller?: EdgeFiller;
  /** The fleet heartbeat sender (#55 D3, slice 8). Absent = no heartbeat
   *  (byte-for-byte the pre-slice-8 behavior). The production wiring is
   *  `buildHeartbeatSender`; tests inject a recorder or a throwing
   *  transport to prove the Service-down rule. */
  heartbeatSender?: HeartbeatSender;
  /** THIS instance's ed25519 public key (#55 D1). A roster row carrying the
   *  SAME key is this machine — the fleet roster returns every instance,
   *  including the local one. Absent = no self-detection (a self-row merges
   *  like any other row). */
  localPublicKey?: () => string;
}

export class MeshFederation {
  private readonly cfg: ServerConfig;
  private readonly fetcher: MeshFetcher;
  private readonly localInstanceId?: () => string;
  private readonly edgeFiller?: EdgeFiller;
  private readonly heartbeatSender?: HeartbeatSender;
  private readonly localPublicKey?: () => string;
  private readonly peers = new Map<string, PeerEntry>();
  /** When a roster pull is due next (epoch-ms). 0 = never armed (no fleet_url). */
  private nextRosterPullAt = 0;
  /** When a fleet heartbeat is due next (epoch-ms). 0 = never armed
   *  (no fleet_url / no heartbeat sender — the pre-slice-8 behavior). */
  private nextHeartbeatAt = 0;
  /** (peer, key) pairs already filled into the local edge store since
   *  boot — the roster pull runs every 15 s; the edge file is rewritten
   *  only when a NEW (peer, key) pair arrives, never on every pull. */
  private readonly filledEdges = new Set<string>();

  constructor(cfg: ServerConfig, fetcher: MeshFetcher, opts: FederationOptions = {}) {
    this.cfg = cfg;
    this.fetcher = fetcher;
    this.localInstanceId = opts.localInstanceId;
    this.edgeFiller = opts.edgeFiller;
    this.heartbeatSender = opts.heartbeatSender;
    this.localPublicKey = opts.localPublicKey;
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
      // Never become your own peer: the roster returns EVERY instance,
      // including this one. A self-row would add a self-loop the refresh
      // then fetches. Match on the PUBLIC KEY (the fleet-issued instance id
      // is not the local mesh instance id), not the id.
      if (this.localPublicKey) {
        try {
          if (row.public_key && row.public_key === this.localPublicKey()) continue;
        } catch { /* no identity available: treat the row as any peer */ }
      }
      // Slice 9 (#55 D3): peer identity is the INSTANCE, not the url. A
      // tailnet address moves; the roster row reports the new urls and the
      // old ones stop answering. Reconcile the url set for this instance
      // instead of ADD-only accumulating a stale address forever.
      //   - an entry whose url the roster no longer reports is dropped;
      //   - a declared url not already a peer key is added.
      // An explicit `mesh_peers` entry is never touched: it is judged by
      // ORIGIN (rosterOrigin absent), so the operator's static registry
      // still wins, and a url that is already a peer key is never
      // re-pointed. A row with no usable url contributes nothing (the
      // sanitizer drops it before this loop — byte-for-byte the old
      // behavior).
      const declared = row.urls
        .map((u) => u.trim().replace(/\/+$/, ''))
        .filter((u) => u !== '' && u !== 'self' && /^https?:\/\//i.test(u));
      for (const p of [...this.peers.values()]) {
        if (p.rosterOrigin !== true || p.instanceId !== row.instance_id) continue;
        if (!declared.includes(p.url)) this.peers.delete(p.url);
      }
      for (const url of declared) {
        if (this.peers.has(url)) continue; // already a peer (config or another instance): never re-point
        this.peers.set(url, {
          url,
          name: row.name || undefined,
          instanceId: row.instance_id,
          lastOk: null,
          lastError: null,
          snapshot: null,
          rosterOrigin: true,
        });
      }
    }
    // Edge fill (the pairing ceremony, #55 D4 shape (b) — PROPOSED wire):
    // the roster publishes each instance's directed edges as an ADD key.
    // The LOCAL instance writes the LOCAL side's edge record from the
    // roster — the last-known-keys posture (fleet-service.md Service-down
    // rule 1: a peer keeps working with the locally-stored public key).
    // The peer's public key comes from the PEER'S OWN roster row (a row's
    // `public_key` is that row's instance's key, never the other edge
    // end's). Fail-closed: no usable row for the peer end = no record
    // written, never a crash. The writer is the seam (FederationOptions):
    // the real one (index.ts) is ADD-only on mesh_edges.json — a record
    // this machine already holds for the peer is the operator's truth
    // (pairing.md D6 enforcement point) and is never rewritten by the
    // roster; re-pairing after a key rotation is the explicit local
    // action (pairing.md open question 3). Absent local id or filler =
    // no fill (byte-for-byte the pre-ceremony pull).
    if (this.edgeFiller && this.localInstanceId) {
      let localId = '';
      try {
        localId = this.localInstanceId();
      } catch {
        localId = '';
      }
      if (localId) {
        const rowById = new Map<string, RosterRow>();
        for (const row of rows) {
          if (!rowById.has(row.instance_id)) rowById.set(row.instance_id, row);
        }
        // Dedupe the directed edge (it rides on BOTH ends' rows).
        const seen = new Set<string>();
        for (const row of rows) {
          for (const edge of row.edges) {
            if (edge.from === edge.to) continue; // a self-edge is never formed
            if (edge.to !== localId && edge.from !== localId) continue; // not my edge
            const dedupeKey = `${edge.from}\u0000${edge.to}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            const peer = edge.to === localId ? edge.from : edge.to;
            const direction: 'controls_me' | 'i_control' = edge.to === localId ? 'controls_me' : 'i_control';
            const peerRow = rowById.get(peer);
            const peerKey = peerRow && typeof peerRow.public_key === 'string' ? peerRow.public_key : '';
            // A usable ed25519 SPKI key is 59 base64url chars; the edge
            // store admits up to 64 (its bounded cap). Anything else is
            // not a key — skip (fail-closed: no record, no crash).
            if (peerKey === '' || peerKey.length > 64) continue;
            // Process-lifetime dedupe: the roster is re-pulled every
            // interval; a (peer, key) pair already handed to the writer
            // since boot is not handed again (the writer's own ADD-only
            // check is the authoritative rule; this keeps the hot path
            // from re-touching the store every 15 s).
            const fillKey = `${peer}\u0000${peerKey}`;
            if (this.filledEdges.has(fillKey)) continue;
            this.filledEdges.add(fillKey);
            try {
              this.edgeFiller(localId, edge, peerKey, peerRow?.name || undefined, direction);
            } catch {
              // A writer failure (a malformed record the store refused)
              // is a no-op for this edge — never a crash (the pull's
              // never-throw posture).
            }
          }
        }
      }
    }
  }

  /**
   * Send the fleet heartbeat (if configured): the arbiter's OWN live urls
   * (`cfg.fleet_own_urls` — the operator's reachability declaration) + coarse
   * presence ('online' — a running arbiter is, by definition, online) to
   * the fleet service. Rides the EXISTING poll tick (no second network
   * loop): at most ONE heartbeat per `fleet_heartbeat_ms` interval (the
   * PROPOSED 60 s default), NOT one per poll (the 15 s poll tick).
   *
   * Gating: all of `fleet_url` / `fleet_instance_id` / `fleet_enrollment_token`
   * present AND a `heartbeatSender` wired = the heartbeat; any one absent
   * (or no sender) = the heartbeat never happens, byte-for-byte the
   * pre-slice-8 behavior.
   *
   * Failure posture (the Service-down rule): a FAILED heartbeat NEVER throws
   * and NEVER touches the last-known peer set — the peer map is left
   * untouched, the arbiter never crashes on fleet trouble. The interval gate
   * still advances on failure (a failing fleet is re-tried on the NEXT
   * interval, not every poll — no hammering a downed service).
   */
  async sendHeartbeat(now: number): Promise<void> {
    // Any of the three fleet keys absent = the heartbeat never happens
    // (byte-for-byte the pre-slice-8 behavior; matches buildRosterFetcher
    // and buildHeartbeatSender's gating).
    if (!this.cfg.fleet_url || !this.cfg.fleet_instance_id || !this.cfg.fleet_enrollment_token) return;
    if (!this.heartbeatSender) return; // no sender wired = no heartbeat
    const intervalMs = this.cfg.fleet_heartbeat_ms ?? HEARTBEAT_MS;
    if (now < this.nextHeartbeatAt) return; // not due yet (at most one heartbeat per interval)
    this.nextHeartbeatAt = now + intervalMs;
    // The arbiter's OWN urls (the outbound self-declaration) + coarse
    // presence. A running arbiter is online by definition — presence is
    // the coarse value, not a health probe.
    const urls = (this.cfg.fleet_own_urls ?? []).map((u) => u.trim()).filter((u) => u !== '');
    try {
      await this.heartbeatSender(urls, 'online');
    } catch {
      // Service-down rule: a failed/throwing heartbeat is a no-op. The
      // last-known peer set stands byte-for-byte (the peer map is never
      // touched by the heartbeat path), and the tick never throws. The
      // interval gate already advanced (set above), so a downed fleet is
      // re-tried on the NEXT interval, not every poll.
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
