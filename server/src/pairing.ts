/**
 * Arbiter-side pairing wiring (#55 D4, slice 10).
 *
 * The fleet service already runs the ceremony (slice 6): B mints a
 * one-time code, A redeems it, the service records the directed edge
 * A -> B and hands A B's public key. The other half was missing: no
 * arbiter ever redeemed a code, so no machine wrote its own
 * `mesh_edges.json` record from the ceremony, and the #39 per-edge routes
 * stayed fail-closed (D8) for every real peer even though the fleet
 * directory knew about the edge.
 *
 * This module is that half. `PairingClient` wraps the fleet ceremony
 * client plus the LOCAL `EdgeStore`, so one call does the whole thing:
 * redeem, write the peer's key locally, and report a named result.
 * `mintCodeForPeer` is the mirror: this machine becomes the CONTROLLED
 * end and hands the operator a code to give to the peer.
 *
 * Direction (pairing.md D5, LOCKED): pairing A to B makes A the
 * CONTROLLER of B. From the LOCAL side's perspective (edges.ts D5):
 *   - I redeemed someone's code  -> I control them -> `i_control`.
 *   - Someone redeemed MY code   -> they control me  -> `controls_me`.
 * The roster pull fills the opposite direction from the same edge row
 * (mesh.ts `edgeFiller`), so both ends end up with the right record.
 *
 * Posture (the Service-down rule): nothing here throws. A failed
 * ceremony is a named `{ ok: false, error }`; the local edge store is
 * never touched on failure, and the arbiter behaves exactly as it did
 * before the attempt.
 *
 * Deps: node:crypto (through FleetClient/Identity), node:fs, node:path.
 * No new dependency (fleet-service D7).
 */

import type { ServerConfig } from './types.js';
import { EdgeStore, type EdgeDirection } from './edges.js';
import { enrollmentFileOf, FleetClient } from './fleet-client.js';
import type { Identity } from './identity.js';

export interface PairResult {
  ok: boolean;
  /** The peer's fleet-issued instance id (the identity; tailnet IPs move). */
  peer_instance_id?: string;
  peer_name?: string;
  /** The direction written on THIS machine's record (pairing.md D5). */
  direction?: EdgeDirection;
  /** Named reason on failure — the same names the fleet service returns
   * (`code_used`, `code_expired`, `invalid_body`, `self_pair`,
   * `bad_signature`, `unknown_instance`, `nonce_replayed`) plus
   * `fleet_not_configured` and transport messages. */
  error?: string;
  /** True when this machine already held a record for the peer. The
   * ceremony succeeded; the local record is ADD-only (mesh.ts edgeFiller
   * precedent), so the operator's existing record stands. */
  already_recorded?: boolean;
}

/**
 * The arbiter's pairing surface: the fleet ceremony client plus the LOCAL
 * edge store it writes into. Built once in `server/src/index.ts`. With no
 * fleet config the client is null and every call answers a named
 * `fleet_not_configured` — pairing is inert, byte-for-byte the pre-slice
 * behavior.
 */
export class PairingClient {
  private readonly client: FleetClient | null;
  private readonly edges: EdgeStore;

  constructor(cfg: ServerConfig, identity: Identity, edges: EdgeStore) {
    this.edges = edges;
    // Same gate as buildRosterFetcher / buildHeartbeatSender (#55 slice 7):
    // any one of the three absent = the fleet plane is inert, byte-for-byte
    // the pre-slice behavior.
    this.client =
      cfg.fleet_url && cfg.fleet_instance_id && cfg.fleet_enrollment_token
        ? new FleetClient(
            enrollmentFileOf(cfg.state_file),
            {
              fleet_url: cfg.fleet_url,
              fleet_enrollment_token: cfg.fleet_enrollment_token,
              name: cfg.mesh_name || osName(),
            },
            identity,
          )
        : null;
  }

  /** Whether the fleet plane is configured at all. */
  get configured(): boolean {
    return this.client !== null;
  }

  /**
   * THIS machine's fleet-issued instance id (the identity the fleet signs
   * against), or null when not enrolled yet. `ensureEnrolled` is idempotent
   * and re-reads the persisted credential, so calling this before a ceremony
   * is safe.
   */
  async localFleetInstanceId(): Promise<string | null> {
    if (!this.client) return null;
    const r = await this.client.ensureEnrolled();
    return r.ok ? r.instance_id ?? null : null;
  }

  /**
   * Mint a one-time pairing code for a peer to redeem. THIS machine
   * becomes the CONTROLLED end of the edge that gets formed. The plaintext
   * code is returned once and never stored here; the operator hands it
   * over the tailnet (fleet-service D7). Null on any failure.
   */
  async mintCodeForPeer(): Promise<{ code: string; ttl_s: number } | null> {
    if (!this.client) return null;
    // Enroll first (idempotent: a persisted credential makes this a no-op).
    void (await this.client.ensureEnrolled()).ok;
    return this.client.mintPairCode();
  }

  /**
   * Redeem a peer's code: this machine becomes the CONTROLLER of the
   * minter, and the peer's public key lands in the LOCAL edge record with
   * direction `i_control` (pairing.md D5). Idempotent — the store keys by
   * peer id, so redeeming twice writes one record. Never throws.
   */
  async pairWithCode(code: string, now = Date.now()): Promise<PairResult> {
    if (!this.client) return { ok: false, error: 'fleet_not_configured' };
    // Enroll first (idempotent: a persisted credential makes this a no-op).
    const enroll = await this.client.ensureEnrolled();
    if (!enroll.ok) return { ok: false, error: enroll.error ?? 'enrollment_failed' };
    const r = await this.client.redeemPairCode(code);
    if (!r.ok) return { ok: false, error: r.error };
    const peer = r.edge.to;
    const prior = this.edges.get(peer);
    try {
      this.edges.upsert({
        peer_instance_id: peer,
        peer_public_key: r.peer_public_key,
        ...(r.peer_name ? { peer_name: r.peer_name } : {}),
        direction: 'i_control',
        // The ceremony is authoritative for the KEY (a re-pair after a key
        // rotation is the documented recovery, pairing.md open question 3),
        // but the record's CREATION time is durable: a second ceremony for
        // the same peer does not reset it.
        created_at: prior ? prior.created_at : now,
      });
    } catch (err) {
      // The store refused the record (malformed shape). The service side
      // is already correct, so the next roster pull fills it. Report the
      // local write failure; never crash.
      return { ok: false, error: `edge_write_failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return {
      ok: true,
      peer_instance_id: peer,
      peer_name: r.peer_name,
      direction: 'i_control',
      already_recorded: prior !== null,
    };
  }

  /**
   * The raw signed roster envelope (diagnostics + the revocation check:
   * after an unpair the edge must be gone from BOTH rows). Null when the
   * fleet plane is absent or the service is unreachable.
   */
  async rosterSnapshot(): Promise<unknown | null> {
    if (!this.client) return null;
    return this.client.signedRoster();
  }

  /**
   * Remove the directed edge on the SERVICE side (the directory). Local
   * revocation stays the enforcement point (pairing.md D6, the existing
   * `POST /api/mesh/unpair` route); this keeps the fleet roster honest so
   * a revoked pairing is not re-filled by the next pull.
   */
  unpairOnService(from: string, to: string): Promise<boolean> {
    if (!this.client) return Promise.resolve(false);
    return this.client.unpairEdge(from, to);
  }
}

/** A stable default fleet display name when the operator set none. */
function osName(): string {
  try {
    return require('node:os').hostname();
  } catch {
    return 'arbiter';
  }
}
