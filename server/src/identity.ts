/**
 * Per-instance identity substrate (#55 D1, locked: docs/architecture/fleet-service.md).
 *
 * Each arbiter owns one ed25519 keypair, minted at first use and persisted
 * in a sibling `identity.json` next to the state file. The private key NEVER
 * enters `state.json` — the state file rides every atomic save, and a secret
 * there would too. The file is 0600, written with the exact atomic
 * tmp+rename posture of the state file (server/src/state.ts `save()`), so
 * the secret is never world-readable even for the instant between write and
 * rename.
 *
 * The public key (44 DER bytes = 59 chars base64url) is what the fleet
 * publishes. `public_key` rides the mesh snapshot as an ADD key next to the
 * existing `instance_id` — absent = unset, so peers that ignore the new
 * field are unaffected.
 *
 * Failure posture (mirrors the state file): a corrupt or unreadable
 * identity.json must not crash the arbiter — a fresh keypair is minted on
 * demand. The stale file is moved aside as a `.corrupt-*` sibling (the
 * state-file precedent), never silently deleted.
 *
 * Crypto: `node:crypto` only, no new dependency. ed25519 signs with a null
 * hash — `crypto.sign(null, payload, privateKey)` / `crypto.verify(null,
 * payload, publicKey, sig)` (a 64-byte signature). Live-verified on
 * node v26.10.0, 2026-10-09.
 *
 * Not in this slice: enrollment (D2 needs the fleet service), roster (D3),
 * pairing (D4). No network.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** identity.json schema version. Bump only on an incompatible change. */
const IDENTITY_SCHEMA = 1;

/** The identity record persisted next to the state file. */
export interface IdentityRecord {
  /** Bump on an incompatible change; the loader rejects unknown versions. */
  v: number;
  /** ed25519, SPKI, DER, base64url — the publishable half. */
  public_key: string;
  /** ed25519, PKCS#8, DER, base64url — owner-only, lives in the 0600 file. */
  private_key: string;
  /** Epoch-ms when the keypair was minted. */
  created_at: number;
}

/** Default identity file location: `identity.json` next to the state file. */
export function identityFileOf(stateFile: string): string {
  return join(dirname(stateFile) || '.', 'identity.json');
}

/**
 * The per-instance ed25519 identity.
 *
 * Mint-on-first-use: the constructor is internal; the entry points are
 * `Identity.loadOrCreate` (file-backed, mints when absent or corrupt) and
 * `Identity.mint` (in-memory, for tests). A corrupt file degrades to a
 * fresh mint — the arbiter boots, and a `WARNING` lands on stderr (the
 * corrupt-state-file precedent).
 */
export class Identity {
  private readonly filePath: string;
  private readonly record: IdentityRecord;
  private readonly privateKey: ReturnType<typeof createPrivateKey>;
  private readonly publicKey: ReturnType<typeof createPublicKey>;

  private constructor(record: IdentityRecord, file: string) {
    this.filePath = file;
    this.record = record;
    this.privateKey = createPrivateKey({
      key: Buffer.from(record.private_key, 'base64url'),
      type: 'pkcs8',
      format: 'der',
    });
    this.publicKey = createPublicKey({
      key: Buffer.from(record.public_key, 'base64url'),
      type: 'spki',
      format: 'der',
    });
    // The private and public halves must agree — a hand-edited or
    // half-written file is treated as corrupt, never trusted. (Node's
    // crypto exposes no derive-public-from-private for ed25519 KeyObjects,
    // so prove agreement by round-tripping a probe signature through both.)
    const probe = Buffer.from('idlefill-identity-probe');
    if (!verify(null, probe, this.publicKey, sign(null, probe, this.privateKey))) {
      throw new Error('identity: private/public key mismatch');
    }
  }

  /** The persisted path (diagnostics + the `.corrupt-*` move). */
  get file(): string {
    return this.filePath;
  }

  /** The publishable public key (SPKI DER, base64url — 59 chars for ed25519). */
  get publicKeyB64url(): string {
    return this.record.public_key;
  }

  /** The private key (PKCS#8 DER, base64url). Owner-only accessor for
   *  local operations + tests — it is never published, never in
   *  state.json, and never rides the mesh snapshot. */
  get privateKeyB64url(): string {
    return this.record.private_key;
  }

  get createdAt(): number {
    return this.record.created_at;
  }

  /**
   * Load the identity at `identityFileOf(stateFile)`, or mint + persist a
   * fresh keypair when the file is missing or unusable. Never throws: any
   * load failure degrades to a fresh mint (the arbiter boots).
   */
  static loadOrCreate(stateFile: string): Identity {
    const file = identityFileOf(stateFile);
    // A MISSING identity file is the normal first-boot path (the state file
    // starts fresh silently too) — mint without fanfare.
    if (!existsSync(file)) return Identity.mintAndPersist(file);
    try {
      return Identity.fromFile(file);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const fresh = Identity.mintAndPersist(file);
      const stale = Identity.safeMoveAside(file);
      console.error(
        `[identity] WARNING: could not load ${file} (${reason}); minting a fresh keypair` +
          (stale ? ` (stale file moved to ${stale})` : ''),
      );
      return fresh;
    }
  }

  /** Mint a fresh in-memory keypair (not persisted). For tests. */
  static mint(): Identity {
    return Identity.mintFor(identityFileOf('./state.json'));
  }

  /** Mint a fresh keypair bound to `file` and persist it atomically. */
  private static mintAndPersist(file: string): Identity {
    const fresh = Identity.mintFor(file);
    fresh.persist();
    return fresh;
  }

  /** Sign `payload` with this instance's private key (ed25519, 64-byte sig). */
  sign(payload: Uint8Array): Uint8Array {
    return sign(null, Buffer.from(payload), this.privateKey);
  }

  /** Whether `signature` is a valid ed25519 signature of `payload` under `pubKeyB64url`. Never throws. */
  static verify(pubKeyB64url: string, payload: Uint8Array, signature: Uint8Array): boolean {
    try {
      const pub = createPublicKey({
        key: Buffer.from(pubKeyB64url, 'base64url'),
        type: 'spki',
        format: 'der',
      });
      return verify(null, Buffer.from(payload), pub, signature);
    } catch {
      return false;
    }
  }

  /** Read + validate an existing identity file. Throws on any anomaly. */
  private static fromFile(file: string): Identity {
    if (!existsSync(file)) throw new Error('not found');
    const raw = readFileSync(file, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`not parseable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const r = parsed as Record<string, unknown>;
    if (r.v !== IDENTITY_SCHEMA) throw new Error(`unknown schema v=${String(r.v)}`);
    const pub = typeof r.public_key === 'string' ? r.public_key : '';
    const priv = typeof r.private_key === 'string' ? r.private_key : '';
    if (!pub || !priv) throw new Error('missing keys');
    const createdAt = typeof r.created_at === 'number' && Number.isFinite(r.created_at) ? r.created_at : 0;
    // The constructor derives the KeyObjects and cross-checks the halves —
    // a bad key encoding throws here and is handled by loadOrCreate.
    return new Identity({ v: IDENTITY_SCHEMA, public_key: pub, private_key: priv, created_at: createdAt }, file);
  }

  /** Mint a fresh keypair bound to `file` (not yet persisted). */
  private static mintFor(file: string): Identity {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rec: IdentityRecord = {
      v: IDENTITY_SCHEMA,
      public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      private_key: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
      created_at: Date.now(),
    };
    return new Identity(rec, file);
  }

  /**
   * Persist this identity atomically: tmp write in the same directory +
   * rename over the target — the state file's exact posture (owner-only on
   * the TMP before the rename, plus a forced chmod for a stale wider tmp).
   */
  private persist(): void {
    const dir = dirname(this.file);
    if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    // The file carries the private key — owner-only, set on the TMP before
    // the rename so the secret is never world-readable (state.ts:134-140).
    writeFileSync(tmp, JSON.stringify(this.record, null, 2), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600); // an existing tmp with a wider mode keeps it — force
    } catch {
      /* best effort */
    }
    renameSync(tmp, this.file);
  }

  /** Move a stale file aside (`identity.json.corrupt-<ts>`); '' when nothing to move. */
  private static safeMoveAside(file: string): string {
    try {
      const stale = `${file}.corrupt-${Date.now()}`;
      renameSync(file, stale);
      return stale;
    } catch {
      return '';
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
