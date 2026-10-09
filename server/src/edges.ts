/**
 * Mesh edge records (#39 slice 1, decision: docs/architecture/pairing.md).
 *
 * An edge record is the locally-stored credential for one paired peer:
 * the peer's `instance_id`, the peer's ed25519 PUBLIC key (the #55 D1
 * substrate — the requester signs with its own private key, the target
 * verifies against the public key stored HERE), the edge direction from
 * the LOCAL side's perspective, and a created timestamp. The private key
 * never enters this file (it lives in `identity.json`, #55 D1).
 *
 * D2 (locked): the records live in a sibling file `mesh_edges.json`, mode
 * 0600, next to `state.json` — never inside `state.json` (the state file
 * rides every atomic save and a backup/export must not leak control
 * identity). The write uses the exact atomic tmp+rename posture of the
 * state file (server/src/state.ts `save()`) and of `identity.json`
 * (#55 D1), so the credential is never world-readable even for the
 * instant between write and rename.
 *
 * D8 (locked): fail-closed. No edge record for a requester means denial
 * of the per-edge routes — no pairing, no detail, no control. This
 * module's `verifyRequester` is the single check the per-edge routes
 * perform; its rejection is the posture, not an edge case.
 *
 * What this file does NOT do: form edges (the pairing ceremony is #55
 * D4's — request/approve vs one-time code is still an owner decision),
 * revoke (D6: the unpair route deletes the record locally; the
 * enforcement here is that the next verification then finds no edge),
 * relay control (D4: slice 2), or audit (D7: slice 2's `mesh_control`
 * event). Slice 1 is the substrate: the store, the verification path,
 * and the fail-closed posture the routes lean on.
 *
 * Failure posture (mirrors the state file and identity.json): a corrupt
 * or unreadable `mesh_edges.json` must not crash the arbiter — it is
 * moved aside as a `.corrupt-*` sibling (never silently deleted) and the
 * store loads empty, which under D8 means everything stays denied. A
 * missing file or an empty file loads empty too (the normal no-pairing
 * state — not corruption, left in place).
 *
 * Crypto: `node:crypto` only — `Identity.verify` (#55 D1) is the
 * verification primitive; this module adds no key material of its own.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Identity } from './identity.js';

/** mesh_edges.json schema version. Bump only on an incompatible change. */
const EDGES_SCHEMA = 1;

/**
 * Edge direction, read from the LOCAL side's perspective (D5):
 * `controls_me` = "this peer is authorized to control me" (pairing A to
 * B stores controls_me=true on B's record for A). `i_control` = the
 * reverse: this instance controls that peer. The direction is a policy
 * on top of the asymmetric credential — verification itself is
 * directional (the requester signs, the target verifies) either way.
 */
export type EdgeDirection = 'controls_me' | 'i_control';

/** One paired peer, as stored on THIS machine. */
export interface EdgeRecord {
  /** The peer's stable instance id (the identity — tailnet IPs move). */
  peer_instance_id: string;
  /** The peer's ed25519 public key (SPKI DER, base64url — #55 D1 shape). */
  peer_public_key: string;
  /** The peer's display name (the mesh snapshot name; diagnostic). */
  peer_name?: string;
  /** Direction from the local side's perspective (D5). */
  direction: EdgeDirection;
  /** Epoch-ms when the edge was created. */
  created_at: number;
}

/** mesh_edges.json file shape: schema version + one record per edge. */
interface EdgesFile {
  v: number;
  edges: EdgeRecord[];
}

/** Default edge file location: `mesh_edges.json` next to the state file. */
export function edgesFileOf(stateFile: string): string {
  return join(dirname(stateFile) || '.', 'mesh_edges.json');
}

/**
 * The per-edge verification verdict (D8 fail-closed). The named `reason`
 * is the one the routes put on the 403 body — a generic 403 is a bug
 * here: the operator must be able to tell an unpaired peer from a
 * mismatched key from a bad signature.
 */
export type EdgeVerdict =
  | { ok: true; edge: EdgeRecord }
  | { ok: false; reason: 'missing_instance_id' | 'unknown_instance_id' | 'bad_signature' };

/** The payload one instance signs on a per-edge request (D1, #39 doc). */
export interface EdgeSignaturePayload {
  /** The signing instance's stable id. */
  instance_id: string;
  /** The target route path (scope binding: a signature for /detail is
   *  not reusable on /control-preview — the path rides the signed
   *  payload). */
  path: string;
  /** The signing instance's epoch-ms clock. Bound into the signature
   *  now; the accepted-skew window lands with the ceremony (slice 2). */
  ts: number;
  /** Single-use nonce. Bound into the signature now; the recently-seen
   *  nonce replay check lands with the ceremony (slice 2). */
  nonce: string;
}

/** Sign an edge-request payload with the LOCAL identity (outbound half). */
export function signEdgePayload(identity: Identity, payload: EdgeSignaturePayload): {
  payload: EdgeSignaturePayload;
  /** Raw ed25519 signature (64 bytes). */
  signature: Uint8Array;
  /** base64url form — the wire form the target accepts. */
  signatureB64url: string;
} {
  const body = Buffer.from(JSON.stringify(payload));
  const sig = identity.sign(body);
  return { payload, signature: sig, signatureB64url: Buffer.from(sig).toString('base64url') };
}

/**
 * Verify an incoming per-edge request against the stored edge record for
 * the claimed `instance_id` (D1: the target verifies the requester's
 * signature against the peer's PUBLIC key stored in the edge record).
 *
 * D8: every failure mode returns `ok: false` with a named reason —
 *   - `missing_instance_id`: the request does not even claim an id;
 *   - `unknown_instance_id`: no edge record for that id (the unpaired
 *     peer — denial is immediate, no propagation delay, D6);
 *   - `bad_signature`: an edge exists but the signature does not
 *     validate under the stored public key (or the payload body does
 *     not match the claimed fields — the signature binds them).
 * Never throws: a malformed request is a rejection, not a crash.
 */
export function verifyRequester(store: EdgeStore, instanceId: string | null | undefined, payload: EdgeSignaturePayload, signatureB64url: string | null | undefined): EdgeVerdict {
  const id = typeof instanceId === 'string' && instanceId.trim() !== '' ? instanceId.trim() : '';
  if (!id) return { ok: false, reason: 'missing_instance_id' };
  const edge = store.get(id);
  if (!edge) return { ok: false, reason: 'unknown_instance_id' };
  // The signature binds instance_id + path + ts + nonce (the canonical
  // payload body) — the claimed fields must agree with what was signed,
  // or a signature minted for another id/path is a mismatch either way.
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'bad_signature' };
  if (payload.instance_id !== id) return { ok: false, reason: 'bad_signature' };
  if (!signatureB64url || typeof signatureB64url !== 'string') return { ok: false, reason: 'bad_signature' };
  const body = Buffer.from(JSON.stringify(payload));
  let sig: Uint8Array;
  try {
    sig = Buffer.from(signatureB64url, 'base64url');
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!Identity.verify(edge.peer_public_key, body, sig)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, edge };
}

/**
 * The persisted edge store.
 *
 * Load-tolerant (the state-file posture): a missing file loads empty
 * (the normal first-boot path — no edges yet, everything denied, which
 * IS the D8 posture); a corrupt file is moved aside as `.corrupt-*` and
 * the store loads empty, with a WARNING on stderr. Never throws from the
 * constructor or `load` — an arbiter that cannot boot has no fail-closed
 * routes to serve.
 */
export class EdgeStore {
  private readonly filePath: string;
  private readonly edges: Map<string, EdgeRecord> = new Map();

  /** Load (or start empty) the edge file at `filePath`. Never throws. */
  constructor(filePath?: string) {
    this.filePath = filePath ?? edgesFileOf('./state.json');
    EdgeStore.loadInto(this);
  }

  /** The persisted path (diagnostics + the `.corrupt-*` move). */
  get file(): string {
    return this.filePath;
  }

  /** All records (stable order: insertion = creation order). */
  list(): EdgeRecord[] {
    return [...this.edges.values()];
  }

  /** The record for a peer instance id, or null (no edge = D8 denial). */
  get(instanceId: string): EdgeRecord | null {
    return this.edges.get(instanceId) ?? null;
  }

  /**
   * Whether `instanceId` is authorized to request the per-edge surface
   * in the given role (D5): a `controls_me` edge admits the requester as
   * controller of this machine (the detail/control routes); an
   * `i_control` edge admits this machine as controller of that peer.
   */
  allows(instanceId: string, role: EdgeDirection): boolean {
    const e = this.edges.get(instanceId);
    return e !== undefined && e.direction === role;
  }

  /**
   * Add (or replace) the edge record for a peer and persist atomically.
   * Malformed input (bad shape, unbounded strings, wrong direction,
   * non-finite timestamp) throws — the ceremony layer (#55 D4) reports
   * it. The public key's PARSE validity is enforced at verification
   * (D8: an unparseable key denies the peer; the arbiter never crashes).
   * Throws only on malformed input; never on I/O.
   */
  upsert(record: EdgeRecord): EdgeRecord {
    if (!isValidEdgeRecord(record)) throw new Error('edges: malformed edge record');
    const clean: EdgeRecord = {
      peer_instance_id: record.peer_instance_id,
      peer_public_key: record.peer_public_key,
      direction: record.direction,
      created_at: record.created_at,
    };
    if (record.peer_name) clean.peer_name = record.peer_name;
    this.edges.set(clean.peer_instance_id, clean);
    this.persist();
    return clean;
  }

  /**
   * Delete the edge record for a peer and persist (D6: revocation is
   * immediate local deletion on the controlled side — the next
   * verification finds no edge and is denied, no propagation).
   * Returns true when a record existed.
   */
  remove(instanceId: string): boolean {
    if (!this.edges.delete(instanceId)) return false;
    this.persist();
    return true;
  }

  // ------------------------------------------------------------------
  // Persistence (the state-file / identity.json posture)
  // ------------------------------------------------------------------

  /** Load + validate the file into the store. Never throws. */
  private static loadInto(store: EdgeStore): void {
    const file = store.file;
    if (!existsSync(file)) return; // first boot: no edges, all routes denied (D8)
    try {
      const raw = readFileSync(file, 'utf-8');
      // An empty (or whitespace-only) file is the "no edges" state — a
      // fresh or truncated-but-valid store, NOT a corrupt file. It loads
      // empty and is left in place (never a crash, never moved aside).
      if (raw.trim() === '') return;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      const r = parsed as Record<string, unknown>;
      if (r.v !== EDGES_SCHEMA) throw new Error(`unknown schema v=${String(r.v)}`);
      if (!Array.isArray(r.edges)) throw new Error('edges is not an array');
      for (const rec of r.edges) {
        if (!isValidEdgeRecord(rec)) throw new Error('malformed edge record');
        store.edges.set(rec.peer_instance_id, { ...rec, peer_public_key: rec.peer_public_key });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[edges] WARNING: could not load ${file} (${reason}); loading with no edges`);
      EdgeStore.safeMoveAside(file);
    }
  }

  /**
   * Persist atomically: tmp write in the same directory + rename over the
   * target — the state file's exact posture (owner-only on the TMP before
   * the rename, plus a forced chmod for a stale wider tmp). The file
   * carries peer PUBLIC keys (not private material), but the 0600 posture
   * is the locked clause (D2) and it keeps a future schema bump that
   * adds secret material from shipping a world-readable window.
   */
  private persist(): void {
    const dir = dirname(this.file);
    if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const doc: EdgesFile = { v: EDGES_SCHEMA, edges: this.list() };
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600); // an existing tmp with a wider mode keeps it — force
    } catch {
      /* best effort */
    }
    renameSync(tmp, this.file);
  }

  /** Move a corrupt file aside (`mesh_edges.json.corrupt-<ts>`). */
  private static safeMoveAside(file: string): void {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* nothing to preserve */
    }
  }

  /** The file's mode bits (diagnostics; null when absent). */
  static fileMode(file: string): number | null {
    try {
      return statSync(file).mode & 0o777;
    } catch {
      return null;
    }
  }
}

/** Validate one edge record at the edge (the store's admission gate). */
function isValidEdgeRecord(rec: unknown): rec is EdgeRecord {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  const r = rec as Record<string, unknown>;
  const id = typeof r.peer_instance_id === 'string' ? r.peer_instance_id : '';
  if (id === '' || id.length > 64) return false;
  const key = typeof r.peer_public_key === 'string' ? r.peer_public_key : '';
  // Bounded like every stored string (the snapshot caps, #50). A key that
  // does not PARSE at verify time simply fails the signature check (D8
  // fail-closed: the peer is denied, not the arbiter crashed) — parse
  // validity is enforced at verification, not at storage.
  if (key === '' || key.length > 64) return false;
  if (r.direction !== 'controls_me' && r.direction !== 'i_control') return false;
  if (typeof r.created_at !== 'number' || !Number.isFinite(r.created_at)) return false;
  if (r.peer_name !== undefined && typeof r.peer_name !== 'string') return false;
  return true;
}
