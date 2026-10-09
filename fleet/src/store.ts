/**
 * Fleet service storage (#55 slice 3 + slice 6, the pairing ceremony).
 *
 * D6 LOCKED (docs/architecture/fleet-service.md): SQLite, a file not a
 * server. The driver is `node:sqlite` (DatabaseSync) — a runtime
 * built-in on node v26 (the repo's runtime), so no new dependency and no
 * database server. The file is the store.
 *
 * What this file stores:
 *   - instances: instance_id, fleet_id, name, public_key, credential hash,
 *     urls (JSON), presence, last_seen.
 *   - tokens: enrollment tokens, HASHED (sha256) at rest. A token is
 *     single-use and carries a TTL. The plaintext token is minted at
 *     runtime and shown to the operator once — it is never stored and
 *     never committed.
 *   - nonces: single-use signed-nonce auth (D2 step 3). A nonce is
 *     consumed on first use. A replayed nonce is a 401.
 *   - pair_codes: one-time pairing codes (D4 shape (b)), HASHED at rest,
 *     single-use + TTL, minted by the MINTING instance (B). A code binds
 *     to B's instance_id at mint time; redeeming it from A (a DIFFERENT
 *     instance) forms the directed edge A → B. The plaintext code is
 *     shown to the operator once — never stored, never committed.
 *   - edges: the directed edges (D4 directional, pairing.md D5):
 *     `from` controls `to`. The roster publishes each instance's edges
 *     so every instance can fill its LOCAL edge records (last-known-keys,
 *     fleet-service.md Service-down rule 1).
 *
 * What this file does NOT store: key-rotation history, audit.
 *
 * The control plane is a DIRECTORY, never a relay (mesh.md D1): it
 * records the edge and publishes it in the rosters. Each side then talks
 * directly, authenticated by signed requests against the edge record's
 * stored PUBLIC key — the service never sits between the two arbiters.
 *
 * Wire posture: every wire key is an ADD key. Absent = unset.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

// ---------------------------------------------------------------------------
// D3 cadence values (PROPOSED — the owner picks, fleet-service.md D3).
// Named defaults only. The service locks no value.
// ---------------------------------------------------------------------------

/** LOCKED (owner, 2026-10-09): the instance heartbeat cadence (D3 choice 1). 60 s. */
export const HEARTBEAT_CADENCE_MS = 60_000;
/** LOCKED (owner, 2026-10-09): the staleness ceiling for CONTROL actions (D3 choice 2). 24 h. */
export const CONTROL_STALE_MS = 24 * 3_600_000;
/** LOCKED (owner, 2026-10-09): the arbiter-side roster pull cadence (D3 choice 3). 15 s (the poll tick). */
export const ROSTER_PULL_CADENCE_MS = 15_000;
/** PROPOSED: how long a consumed nonce is kept before pruning (replay window proxy). 5 min. */
export const NONCE_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS instances (
  instance_id TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL DEFAULT 'home',
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  enrolled_at INTEGER NOT NULL,
  urls TEXT NOT NULL DEFAULT '[]',
  presence TEXT,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  fleet_id TEXT NOT NULL DEFAULT 'home',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  PRIMARY KEY (nonce, instance_id)
);
CREATE TABLE IF NOT EXISTS pair_codes (
  code_hash TEXT PRIMARY KEY,
  minter_instance_id TEXT NOT NULL,
  fleet_id TEXT NOT NULL DEFAULT 'home',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS edges (
  from_instance_id TEXT NOT NULL,
  to_instance_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_instance_id, to_instance_id)
);
`;

/** D5 LOCKED: machine identity only. The `fleet_id` seam defaults to 'home'. */
const DEFAULT_FLEET_ID = 'home';

export function openStore(dbFile: string): DatabaseSync {
  const db = new DatabaseSync(dbFile);
  db.exec(SCHEMA);
  return db;
}

/** sha256 hex digest — how secrets are held at rest. */
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Enrollment tokens (D2 LOCKED: one-time, single-use, 15 min TTL default)
// ---------------------------------------------------------------------------

export interface MintedToken {
  /** The plaintext token. Shown to the operator once. Never stored. */
  token: string;
  /** Epoch-ms when the token stops being valid. */
  expires_at: number;
}

/** Mint an enrollment token. High entropy (192 random bits). Stored hashed. */
export function mintToken(db: DatabaseSync, ttlMs: number, now = Date.now()): MintedToken {
  const token = `flt_${randomBytes(24).toString('base64url')}`;
  const expires_at = now + ttlMs;
  db.prepare(
    'INSERT INTO tokens (token_hash, fleet_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(sha256(token), DEFAULT_FLEET_ID, now, expires_at);
  return { token, expires_at };
}

export type RedeemResult =
  | { ok: true; fleet_id: string }
  | { ok: false; error: 'invalid_token' | 'token_used' | 'token_expired' };

/**
 * Redeem a token (the enrollment path). Single-use + TTL enforced
 * atomically: the UPDATE consumes the token only while `used_at IS NULL`,
 * so a double spend cannot pass.
 */
export function redeemToken(db: DatabaseSync, token: string, now = Date.now()): RedeemResult {
  const h = sha256(token);
  const row = db
    .prepare('SELECT fleet_id, expires_at, used_at FROM tokens WHERE token_hash = ?')
    .get(h) as { fleet_id: string; expires_at: number; used_at: number | null } | undefined;
  if (!row) return { ok: false, error: 'invalid_token' };
  if (row.used_at !== null) return { ok: false, error: 'token_used' };
  if (now >= row.expires_at) return { ok: false, error: 'token_expired' };
  const res = db.prepare('UPDATE tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(now, h);
  if (Number(res.changes) !== 1) return { ok: false, error: 'token_used' };
  return { ok: true, fleet_id: row.fleet_id };
}

// ---------------------------------------------------------------------------
// Public-key validation (D1 LOCKED: ed25519, SPKI DER, base64url)
// ---------------------------------------------------------------------------

/**
 * Whether `b64url` is a valid ed25519 SPKI DER public key.
 * 44 DER bytes = 59 base64url chars (the slice-1 identity shape).
 */
export function isValidEd25519PublicKey(b64url: string): boolean {
  if (!/^[A-Za-z0-9_-]{59}$/.test(b64url)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(b64url, 'base64url'),
      type: 'spki',
      format: 'der',
    });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export interface EnrollInput {
  token: string;
  public_key: string;
  name: string;
}

export type EnrollResult =
  | { ok: true; instance_id: string; credential: string; nonce: string }
  | { ok: false; error: string };

/**
 * Enroll an instance: validate the payload FIRST (a malformed request
 * must not burn the operator's token), redeem the token, mint the
 * instance row + a session credential.
 *
 * The credential is an opaque long-lived session bound to the key
 * (D2 step 2). Only its sha256 hash is stored. The returned `nonce` is
 * the server-issued nonce the instance signs for its first call (ADD
 * key on the response — absent means unset for an old reader).
 */
export function enroll(db: DatabaseSync, input: EnrollInput, now = Date.now()): EnrollResult {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0 || name.length > 64 || name.includes('\u0000')) {
    return { ok: false, error: 'invalid_name' };
  }
  if (!isValidEd25519PublicKey(input.public_key)) {
    return { ok: false, error: 'invalid_public_key' };
  }
  const redeem = redeemToken(db, input.token, now);
  if (!redeem.ok) return { ok: false, error: redeem.error };

  const credential = randomBytes(32).toString('base64url');
  let instance_id = '';
  for (let i = 0; i < 8; i++) {
    const cand = `m-${randomBytes(8).toString('hex')}`;
    try {
      db.prepare(
        'INSERT INTO instances (instance_id, fleet_id, name, public_key, credential_hash, enrolled_at, urls) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(cand, redeem.fleet_id, name, input.public_key, sha256(credential), now, '[]');
      instance_id = cand;
      break;
    } catch {
      // A primary-key collision is the only expected failure — retry.
    }
  }
  if (!instance_id) return { ok: false, error: 'instance_id_collision' };
  return { ok: true, instance_id, credential, nonce: mintNonce() };
}

/** A fresh server-issued nonce (128 random bits, base64url). */
export function mintNonce(): string {
  return randomBytes(16).toString('base64url');
}

// ---------------------------------------------------------------------------
// Signed-nonce auth (D2 step 3: no shared fleet secret ever exists)
// ---------------------------------------------------------------------------

export interface AuthInput {
  instance_id?: unknown;
  nonce?: unknown;
  signature?: unknown;
}

export type AuthResult =
  | { ok: true }
  | { ok: false; error: 'missing_auth' | 'unknown_instance' | 'bad_signature' | 'nonce_replayed' };

/**
 * Verify a signed request: the instance signs the server nonce with its
 * ed25519 key. The service checks the signature against the stored
 * public key, then consumes the nonce (single-use). Every denial is
 * named — the caller maps the name to a 401.
 */
export function authenticate(db: DatabaseSync, auth: AuthInput, now = Date.now()): AuthResult {
  const instanceId = typeof auth.instance_id === 'string' ? auth.instance_id : '';
  const nonce = typeof auth.nonce === 'string' ? auth.nonce : '';
  const signature = typeof auth.signature === 'string' ? auth.signature : '';
  if (!instanceId || !nonce || !signature) return { ok: false, error: 'missing_auth' };

  const row = db.prepare('SELECT public_key FROM instances WHERE instance_id = ?').get(instanceId) as
    | { public_key: string }
    | undefined;
  if (!row) return { ok: false, error: 'unknown_instance' };

  // ed25519 signatures are exactly 64 bytes. Anything else cannot verify.
  const sig = new Uint8Array(Buffer.from(signature, 'base64url'));
  if (sig.length !== 64) return { ok: false, error: 'bad_signature' };
  let valid = false;
  try {
    const pub = createPublicKey({
      key: Buffer.from(row.public_key, 'base64url'),
      type: 'spki',
      format: 'der',
    });
    valid = verify(null, new TextEncoder().encode(nonce), pub, sig);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'bad_signature' };

  // A nonce is single-use: consumed on first use. A replay is a 401.
  const seen = db.prepare('SELECT 1 AS x FROM nonces WHERE nonce = ? AND instance_id = ?').get(nonce, instanceId);
  if (seen) return { ok: false, error: 'nonce_replayed' };
  db.prepare('INSERT INTO nonces (nonce, instance_id, issued_at) VALUES (?, ?, ?)').run(nonce, instanceId, now);
  // Prune consumed nonces past the (PROPOSED) retention window.
  db.prepare('DELETE FROM nonces WHERE issued_at < ?').run(now - NONCE_TTL_MS);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Heartbeat + roster (D3 — mechanics locked, values PROPOSED)
// ---------------------------------------------------------------------------

/**
 * Record a heartbeat: urls[] + coarse presence for the calling instance.
 * `urls` null = absent on the wire = keep the stored urls (ADD key).
 * `presence` null = absent = keep the stored presence.
 */
export function heartbeat(
  db: DatabaseSync,
  instanceId: string,
  urls: string[] | null,
  presence: string | null,
  now = Date.now(),
): boolean {
  const res = db
    .prepare(
      'UPDATE instances SET urls = COALESCE(?, urls), presence = COALESCE(?, presence), last_seen = ? WHERE instance_id = ?',
    )
    .run(urls ? JSON.stringify(urls) : null, presence, now, instanceId);
  return Number(res.changes) === 1;
}

export interface RosterEdge {
  /** The controlling instance (A in "A pairs to B"). */
  from: string;
  /** The controlled instance (B). */
  to: string;
}

export interface RosterEntry {
  instance_id: string;
  name: string;
  public_key: string;
  urls: string[];
  /** Epoch-ms of the last heartbeat. Null until the first heartbeat. */
  last_seen: number | null;
  /**
   * The directed edges this instance takes part in (D4, PROPOSED wire
   * key — fleet-service.md roster response: `"edges": [{from, to}]`).
   * ADD key: absent = unset on an old service; the puller's sanitizer
   * treats a missing field as no edges. Both directions of an edge ride
   * on BOTH instances' rows, so each side can fill its LOCAL edge
   * record on the roster pull (the last-known-keys posture).
   */
  edges: RosterEdge[];
}

/** The full roster (a PULL — the service never pushes, never relays). */
export function roster(db: DatabaseSync): RosterEntry[] {
  const rows = db
    .prepare('SELECT instance_id, name, public_key, urls, last_seen FROM instances ORDER BY instance_id')
    .all() as { instance_id: string; name: string; public_key: string; urls: string; last_seen: number | null }[];
  const edgeRows = db
    .prepare('SELECT from_instance_id, to_instance_id FROM edges ORDER BY from_instance_id, to_instance_id')
    .all() as { from_instance_id: string; to_instance_id: string }[];
  return rows.map((r) => ({
    instance_id: r.instance_id,
    name: r.name,
    public_key: r.public_key,
    urls: parseUrls(r.urls),
    last_seen: typeof r.last_seen === 'number' ? r.last_seen : null,
    // Both directions ride on both rows (ADD key): the minter B sees the
    // edge as `to: B`, the redeemer A sees it as `from: A`.
    edges: edgeRows
      .filter((e) => e.from_instance_id === r.instance_id || e.to_instance_id === r.instance_id)
      .map((e) => ({ from: e.from_instance_id, to: e.to_instance_id })),
  }));
}

/** Parse a stored urls JSON column. A corrupt value degrades to []. */
export function parseUrls(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((u): u is string => typeof u === 'string');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// URL + presence sanitization (untrusted wire input)
// ---------------------------------------------------------------------------

/** Max urls an instance may carry (bounded, untrusted input). */
export const MAX_URLS = 16;
/** Max length of one url string. */
export const MAX_URL_LEN = 256;
/** The coarse presence values (D3: coarse presence on the wire). */
export const PRESENCE_VALUES = ['online', 'offline'] as const;
export type Presence = (typeof PRESENCE_VALUES)[number];

/**
 * Sanitize a wire urls[]: strings only, trimmed, length-capped, bounded
 * count. Garbage entries are dropped individually (drop, don't reject).
 */
export function sanitizeUrls(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const u of v) {
    if (out.length >= MAX_URLS) break;
    if (typeof u !== 'string') continue;
    const t = u.trim();
    if (t.length === 0 || t.length > MAX_URL_LEN) continue;
    out.push(t);
  }
  return out;
}

/** Sanitize a wire presence: a known coarse value or null (absent = keep prior). */
export function sanitizePresence(v: unknown): Presence | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return (PRESENCE_VALUES as readonly string[]).includes(t) ? (t as Presence) : null;
}

// ---------------------------------------------------------------------------
// Pairing ceremony (D4 shape (b) — PROPOSED, fleet-service.md +
// pairing.md: one-time code, directional edges, the initiator is the
// controller). The service records the edge and publishes it in the
// rosters — it never relays anything between the two arbiters (D1).
// ---------------------------------------------------------------------------

/** PROPOSED: how long a pairing code stays redeemable. 5 min (shorter
 *  than the enrollment token: a code is minted seconds before it is
 *  redeemed, on the tailnet, by the same operator). */
export const PAIR_CODE_TTL_MS = 5 * 60_000;

/**
 * Mint a pairing code (D4 shape (b), `POST /pair/code`, called by B).
 * The code binds to B's instance_id at mint time; B's instance MUST
 * exist — a code bound to a ghost id is a code that can never form an
 * edge, so minting a code for an unknown instance is a NAMED refusal,
 * not a silent default to 'home'. Stored hashed, like the enrollment
 * token: single-use, TTL, plaintext shown once.
 */
export type MintPairCodeResult =
  | { ok: true; code: string; expires_at: number }
  | { ok: false; error: 'unknown_minter' };

export function mintPairCode(db: DatabaseSync, minterInstanceId: string, ttlMs: number, now = Date.now()): MintPairCodeResult {
  const row = db.prepare('SELECT fleet_id FROM instances WHERE instance_id = ?').get(minterInstanceId) as
    | { fleet_id: string }
    | undefined;
  if (!row) return { ok: false, error: 'unknown_minter' };
  // A non-positive TTL is nonsense: a code that expires the instant it
  // is minted can only ever answer `code_expired`. Fall back to the
  // PROPOSED default (the config layer already guards this; a direct
  // store caller gets the same posture).
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : PAIR_CODE_TTL_MS;
  const code = `pair_${randomBytes(16).toString('base64url')}`;
  const expires_at = now + ttl;
  db.prepare(
    'INSERT INTO pair_codes (code_hash, minter_instance_id, fleet_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sha256(code), minterInstanceId, row.fleet_id, now, expires_at);
  return { ok: true, code, expires_at };
}

export type RedeemPairCodeResult =
  | { ok: true; edge: RosterEdge; peer_public_key: string; peer_name: string }
  | {
      ok: false;
      error: 'invalid_code' | 'code_used' | 'code_expired' | 'self_pair' | 'unknown_redeemer' | 'unknown_minter';
    };

/**
 * Redeem a pairing code (D4 shape (b), `POST /pair/redeem`, called by A).
 *
 * The caller's authenticated instance_id is the CONTROLLER (`from`);
 * the code's minter is the CONTROLLED instance (`to`) — pairing A to B
 * makes A the controller of B (pairing.md D5; the service-side
 * directional semantics of #55 D4). The edge row is INSERTed idempotently
 * (re-pairing the same A → B is a no-op, not a duplicate) and the code
 * is consumed single-use + TTL, exactly like the enrollment token.
 *
 * Every refusal is NAMED and NONE of them burns the code: the
 * single-use UPDATE is the LAST step, so a refused attempt (expired,
 * a wrong redeemer, a ghost minter) leaves the code redeemable by its
 * intended pair. `self_pair` (redeeming one's own code) is a named
 * denial, not an error: the operator minted on the wrong machine, and
 * the service must not form a self-edge (A cannot control A through
 * the ceremony). A redeemer that is not a fleet instance at all is
 * `unknown_redeemer` — the HTTP auth layer already 401s that case
 * (`unknown_instance`), and the store repeats the check so the
 * ceremony's refusals are complete by name at every layer.
 */
export function redeemPairCode(db: DatabaseSync, code: string, redeemerInstanceId: string, now = Date.now()): RedeemPairCodeResult {
  const h = sha256(code);
  const row = db
    .prepare('SELECT minter_instance_id, expires_at, used_at FROM pair_codes WHERE code_hash = ?')
    .get(h) as { minter_instance_id: string; expires_at: number; used_at: number | null } | undefined;
  if (!row) return { ok: false, error: 'invalid_code' };
  // The redeemer must be a fleet instance: a forged or stale id cannot
  // become the controller of anything.
  const redeemer = db
    .prepare('SELECT 1 AS x FROM instances WHERE instance_id = ?')
    .get(redeemerInstanceId);
  if (!redeemer) return { ok: false, error: 'unknown_redeemer' };
  if (row.minter_instance_id === redeemerInstanceId) return { ok: false, error: 'self_pair' };
  if (row.used_at !== null) return { ok: false, error: 'code_used' };
  if (now >= row.expires_at) return { ok: false, error: 'code_expired' };
  // The minter must be enrolled (a code minted for a deleted instance
  // cannot form an edge — a deleted row has no public key to publish).
  // Checked BEFORE consuming: a ghost minter must not silently burn an
  // operator's one-time code.
  const peer = db
    .prepare('SELECT public_key, name FROM instances WHERE instance_id = ?')
    .get(row.minter_instance_id) as { public_key: string; name: string } | undefined;
  if (!peer) return { ok: false, error: 'unknown_minter' };
  const res = db.prepare('UPDATE pair_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').run(now, h);
  if (Number(res.changes) !== 1) return { ok: false, error: 'code_used' };
  // Idempotent: the same directed edge re-forms as a no-op (rotation is
  // unpair + re-pair; a re-pair without the unpair is harmless).
  db.prepare(
    'INSERT INTO edges (from_instance_id, to_instance_id, created_at) VALUES (?, ?, ?) ON CONFLICT (from_instance_id, to_instance_id) DO NOTHING',
  ).run(redeemerInstanceId, row.minter_instance_id, now);
  // The redeem response carries the peer's public key so A can write
  // its LOCAL edge record immediately (pairing.md D1: verification is
  // against the stored peer public key) — the next roster pull would
  // carry it too; this is the same data, returned inline.
  return { ok: true, edge: { from: redeemerInstanceId, to: row.minter_instance_id }, peer_public_key: peer.public_key, peer_name: peer.name };
}

export type DropEdgeResult = { ok: boolean; existed: boolean };

/**
 * Remove a directed edge (D4, `POST /pair/unpair` — the ceremony's
 * `drop_edge`). The caller's
 * authenticated instance_id must be one of the edge's ends — an
 * instance can only unpair an edge it takes part in. Directional
 * semantics (pairing.md D5): unpairing A → B does NOT touch B → A;
 * the reverse direction is a separate edge the operator formed
 * separately and unpairs separately.
 *
 * The service-side deletion is the DIRECTORY update. The enforcement
 * point is the controlled side (pairing.md D6): the target's LOCAL
 * edge record is deleted by its own operator (`POST /api/mesh/unpair`),
 * and the next roster pull confirms the edge is gone. The service
 * never pushes (D1: a directory, not a pipe).
 */
export function unpairEdge(db: DatabaseSync, callerInstanceId: string, from: string, to: string): DropEdgeResult {
  const mine = callerInstanceId === from || callerInstanceId === to;
  const row = db.prepare('SELECT 1 AS x FROM edges WHERE from_instance_id = ? AND to_instance_id = ?').get(from, to);
  if (!mine || !row) return { ok: false, existed: false };
  db.prepare('DELETE FROM edges WHERE from_instance_id = ? AND to_instance_id = ?').run(from, to);
  return { ok: true, existed: true };
}

/** The edges a given instance takes part in (either direction). */
export function edgesFor(db: DatabaseSync, instanceId: string): RosterEdge[] {
  const rows = db
    .prepare(
      'SELECT from_instance_id, to_instance_id FROM edges WHERE from_instance_id = ? OR to_instance_id = ? ORDER BY from_instance_id, to_instance_id',
    )
    .all(instanceId, instanceId) as { from_instance_id: string; to_instance_id: string }[];
  return rows.map((r) => ({ from: r.from_instance_id, to: r.to_instance_id }));
}
