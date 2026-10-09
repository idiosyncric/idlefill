/**
 * Fleet service storage (#55 slice 3).
 *
 * D6 LOCKED (docs/architecture/fleet-service.md): SQLite, a file not a
 * server. The driver is `node:sqlite` (DatabaseSync) — a runtime
 * built-in on node v26 (the repo's runtime), so no new dependency and no
 * database server. The file is the store.
 *
 * What this slice stores:
 *   - instances: instance_id, fleet_id, name, public_key, credential hash,
 *     urls (JSON), presence, last_seen.
 *   - tokens: enrollment tokens, HASHED (sha256) at rest. A token is
 *     single-use and carries a TTL. The plaintext token is minted at
 *     runtime and shown to the operator once — it is never stored and
 *     never committed.
 *   - nonces: single-use signed-nonce auth (D2 step 3). A nonce is
 *     consumed on first use. A replayed nonce is a 401.
 *
 * What this slice does NOT store: pairing edges (D4 — the owner's shape
 * decision is pending), key-rotation history, audit. The schema leaves
 * room for all three without a migration of this slice's tables.
 *
 * Wire posture: every wire key is an ADD key. Absent = unset.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

// ---------------------------------------------------------------------------
// D3 cadence values (PROPOSED — the owner picks, fleet-service.md D3).
// Named defaults only. The service locks no value.
// ---------------------------------------------------------------------------

/** PROPOSED: the instance heartbeat cadence (D3 owner choice 1). 60 s. */
export const HEARTBEAT_CADENCE_MS = 60_000;
/** PROPOSED: the staleness ceiling for CONTROL actions (D3 owner choice 2). 24 h. */
export const CONTROL_STALE_MS = 24 * 3_600_000;
/** PROPOSED: the arbiter-side roster pull cadence (D3 owner choice 3). 15 s (the poll tick). */
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

export interface RosterEntry {
  instance_id: string;
  name: string;
  public_key: string;
  urls: string[];
  /** Epoch-ms of the last heartbeat. Null until the first heartbeat. */
  last_seen: number | null;
}

/** The full roster (a PULL — the service never pushes, never relays). */
export function roster(db: DatabaseSync): RosterEntry[] {
  const rows = db
    .prepare('SELECT instance_id, name, public_key, urls, last_seen FROM instances ORDER BY instance_id')
    .all() as { instance_id: string; name: string; public_key: string; urls: string; last_seen: number | null }[];
  return rows.map((r) => ({
    instance_id: r.instance_id,
    name: r.name,
    public_key: r.public_key,
    urls: parseUrls(r.urls),
    last_seen: typeof r.last_seen === 'number' ? r.last_seen : null,
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
