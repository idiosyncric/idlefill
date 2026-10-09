/**
 * Arbiter-side fleet enrollment + signed roster pull (#55 D2 + D3, slice 7).
 *
 * This is the arbiter's client for the fleet service's control plane
 * (fleet/src/index.ts — docs/architecture/fleet-service.md): enroll ONCE
 * with a one-time enrollment token, persist the returned session
 * credential, and authenticate every roster pull with a signed nonce
 * (D2 step 3: no shared fleet secret ever exists).
 *
 * Wire contract (slice 3, fleet/src/store.ts):
 *   POST /enroll    {token, public_key, name} → {instance_id, credential, nonce}
 *   POST /heartbeat {instance_id, nonce, signature, urls[], presence}
 *   GET  /roster    ?instance_id&nonce&signature → {instances: [...]}
 * Auth fields ride the JSON body for a POST and the query string for a
 * GET. The signature is ed25519 over the server nonce (node:crypto only,
 * the #55 D1 identity substrate signs; 64-byte base64url signature).
 *
 * Credential persistence (the #39 D2 / #55 D1 posture, D6 locked): the
 * session credential and the fleet-issued `instance_id` live in a sibling
 * `fleet_enrollment.json` NEXT TO the state file — mode 0600, atomic
 * tmp+rename, NEVER inside state.json (the state file rides every atomic
 * save and a backup/export must not leak a fleet credential). A corrupt
 * file is moved aside as a `.corrupt-*` sibling and the client
 * re-enrolls from the config token — a wiped credential is a
 * re-enrollment, not a crash.
 *
 * Failure posture (the Service-down rule, mesh.ts): every method that
 * talks to the network is a NO-OP on failure — the roster pull keeps
 * the last-known peer set byte-for-byte, the arbiter never crashes on
 * fleet trouble, and nothing here ever throws.
 *
 * What this module does NOT do: the heartbeat CADENCE (the caller's
 * concern — the arbiter's live urls come from its own config; the
 * cadence rides the mesh federation tick, server/src/mesh.ts
 * `sendHeartbeat`, #55 D3 slice 8: `heartbeatOnce` is the transport,
 * the tick owns the interval), pairing (D4), key rotation, or
 * deployment (D7).
 *
 * Deps: `node:crypto` + `node:fs` + `node:path` only (D7:
 * dependency-free Node). No new dependency.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Identity } from './identity.js';

/** fleet_enrollment.json schema version. Bump only on an incompatible change. */
const ENROLL_SCHEMA = 1;

/**
 * The persisted enrollment record. `credential` is the fleet service's
 * opaque long-lived session credential (only its sha256 is stored on the
 * service side); `instance_id` is the fleet-issued id the instance signs
 * with. Both are 0600 on this file; neither rides the wire except the
 * id (the credential never leaves this machine — the service sees only
 * signatures).
 */
export interface FleetEnrollmentRecord {
  v: number;
  instance_id: string;
  credential: string;
  name: string;
  enrolled_at: number;
}

/**
 * The live record the client keeps in memory. When the credential is
 * unknown (first boot, or a lost/corrupt file that could not be
 * re-enrolled yet) the signed call path is inert: `signedRoster` returns
 * null and the pull stays a no-op — exactly the pre-slice-5 behavior.
 */
export interface FleetSession {
  instance_id: string | null;
  credential: string | null;
}

/** The config the client needs (mirrors the named keys in config.ts). */
export interface FleetClientConfig {
  /** The fleet service base URL (e.g. `https://fleet.samwarth.com:8789`). */
  fleet_url: string;
  /** The one-time enrollment token the operator supplied (D2, single-use). */
  fleet_enrollment_token: string;
  /** Display name registered with the fleet (defaults to mesh_name). */
  name: string;
}

/** Default credential file location: `fleet_enrollment.json` next to the state file. */
export function enrollmentFileOf(stateFile: string): string {
  return join(dirname(stateFile) || '.', 'fleet_enrollment.json');
}

/** Read the persisted enrollment, or null (absent, empty, or corrupt — a `.corrupt-*` move). Never throws. */
export function loadEnrollment(file: string): FleetEnrollmentRecord | null {
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8');
    if (raw.trim() === '') return null; // a truncated-but-empty file is "no enrollment yet", left in place
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const r = parsed as Record<string, unknown>;
    if (r.v !== ENROLL_SCHEMA) throw new Error(`unknown schema v=${String(r.v)}`);
    const id = typeof r.instance_id === 'string' ? r.instance_id : '';
    const cred = typeof r.credential === 'string' ? r.credential : '';
    const name = typeof r.name === 'string' ? r.name : '';
    if (id === '' || id.length > 64 || cred === '' || cred.length > 512 || name.length > 64) {
      throw new Error('malformed record');
    }
    return {
      v: ENROLL_SCHEMA,
      instance_id: id,
      credential: cred,
      name,
      enrolled_at: typeof r.enrolled_at === 'number' && Number.isFinite(r.enrolled_at) ? r.enrolled_at : 0,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[fleet] WARNING: could not load ${file} (${reason}); re-enrolling from the config token`);
    safeMoveAside(file);
    return null;
  }
}

/** Persist the enrollment atomically (the state-file / identity.json posture: 0600 on the TMP before rename). */
export function saveEnrollment(file: string, record: FleetEnrollmentRecord): void {
  const dir = dirname(file);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...record }, null, 2), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600); // a stale wider tmp keeps its mode without this — force
  } catch {
    /* best effort */
  }
  renameSync(tmp, file);
}

/** Move a corrupt file aside (`fleet_enrollment.json.corrupt-<ts>`). */
function safeMoveAside(file: string): void {
  try {
    renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    /* nothing to preserve */
  }
}

/** The file's mode bits (diagnostics/tests; null when absent). */
export function enrollmentFileMode(file: string): number | null {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

export interface EnrollResult {
  ok: boolean;
  instance_id?: string;
  credential?: string;
  /** The server's named denial (invalid_token / token_used / token_expired / ...) or a transport error string. */
  error?: string;
}

/**
 * The enrollment client. All methods are fail-quiet: a network failure or
 * a server denial yields a named `ok: false` result — never a throw, never
 * a crash. The token is single-use: a `token_used` denial is terminal for
 * this token (the operator mints a fresh one); it is reported, not retried.
 */
export class FleetClient {
  private readonly path: string;
  private readonly cfg: FleetClientConfig;
  private readonly identity: Identity;
  /** The live session (null = not enrolled / credential lost — signed calls inert). */
  session: FleetSession | null;

  /**
   * @param file  the credential file (use `enrollmentFileOf(stateFile)` —
   *              the sibling of the state file, the #39/#55 D2 posture)
   * @param cfg   fleet_url + fleet_enrollment_token + name (the named config keys)
   * @param identity  the arbiter's #55 D1 identity (signs every nonce)
   */
  constructor(file: string, cfg: FleetClientConfig, identity: Identity) {
    this.path = file;
    this.cfg = cfg;
    this.identity = identity;
    const rec = loadEnrollment(file);
    this.session =
      rec === null
        ? { instance_id: null, credential: null }
        : { instance_id: rec.instance_id, credential: rec.credential };
  }

  /** The persisted credential file path (diagnostics). */
  get credentialFile(): string {
    return this.path;
  }

  /** Whether a signed call can happen (a persisted or freshly-minted credential). */
  get enrolled(): boolean {
    return this.session?.credential !== null && this.session?.instance_id !== null;
  }

  /**
   * Enroll ONCE (idempotent): with a persisted credential this is a no-op
   * (returns it); without one it spends the config token via `POST /enroll`
   * and persists the credential (0600, atomic). Never throws: a failed
   * enrollment is a no-op — the session stays null and the signed call
   * path stays inert (the pre-slice-5 behavior stands).
   */
  async ensureEnrolled(): Promise<EnrollResult> {
    // A second client on the SAME file (the roster pull and the heartbeat
    // sender are separate FleetClient instances) can enroll while this one
    // still holds a null in-memory session from construction. Re-read the
    // persisted credential BEFORE spending the single-use token: otherwise a
    // already-spent token burns a 400 and the heartbeat silently never
    // happens (#55 slice 8, found by the live proof).
    if (!this.enrolled) {
      const rec = loadEnrollment(this.path);
      if (rec !== null) this.session = { instance_id: rec.instance_id, credential: rec.credential };
    }
    if (this.enrolled) {
      return { ok: true, instance_id: this.session!.instance_id ?? undefined, credential: this.session!.credential ?? undefined };
    }
    const base = this.cfg.fleet_url.replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: this.cfg.fleet_enrollment_token,
          public_key: this.identity.publicKeyB64url,
          name: this.cfg.name,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, error: `enroll HTTP ${res.status} (non-JSON body)` };
    }
    const instanceId = typeof body.instance_id === 'string' ? body.instance_id : '';
    const credential = typeof body.credential === 'string' ? body.credential : '';
    if (!res.ok || instanceId === '' || credential === '') {
      return { ok: false, error: typeof body.error === 'string' ? body.error : `enroll HTTP ${res.status}` };
    }
    this.session = { instance_id: instanceId, credential };
    saveEnrollment(this.path, {
      v: ENROLL_SCHEMA,
      instance_id: instanceId,
      credential,
      name: this.cfg.name,
      enrolled_at: Date.now(),
    });
    return { ok: true, instance_id: instanceId, credential };
  }

  /**
   * One signed roster pull (D2 step 3): mint a nonce, sign it with this
   * instance's ed25519 key, and send it as the query-string auth envelope
   * for `GET /roster`. The nonce is single-use and consumed server-side;
   * a fresh nonce is minted per call (no reuse — a replay is a 401).
   *
   * Returns the raw roster envelope on success, null on ANY failure
   * (not enrolled, transport error, 4xx/5xx, non-JSON body) — the caller
   * treats null as "the last-known peer set stands" (the Service-down
   * rule). Never throws.
   */
  async signedRoster(): Promise<unknown | null> {
    if (!this.enrolled) return null;
    const nonce = randomNonce();
    const signature = Buffer.from(this.identity.sign(new TextEncoder().encode(nonce))).toString('base64url');
    const qs = new URLSearchParams({
      instance_id: this.session!.instance_id as string,
      nonce,
      signature,
    }).toString();
    const base = this.cfg.fleet_url.replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/roster?${qs}`, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      // Service-down rule: a transport failure is a no-op pull (return null;
      // the last-known peer set stands byte-for-byte). Logged once per pull.
      console.error(`[fleet] roster pull failed (${err instanceof Error ? err.message : String(err)}); the last-known peer set stands`);
      return null;
    }
    if (!res.ok) {
      // A 401 means the credential no longer validates (re-enrollment is
      // the recovery, D2: a fresh operator token). Named + fail-quiet.
      console.error(`[fleet] roster pull HTTP ${res.status} — the last-known peer set stands (a 401 means re-enroll with a fresh token)`);
      return null;
    }
    try {
      return await res.json();
    } catch {
      return null; // a non-JSON body is a malformed envelope — the pull is a no-op
    }
  }

  /**
   * One signed heartbeat (D3 cadence): urls[] + coarse presence for this
   * instance. Same posture as `signedRoster`: fail-quiet, null on any
   * failure, a fresh nonce per call. The arbiter's live urls come from its
   * own config (mesh_peers are INBOUND; the outbound urls are the operator's
   * declaration — the caller decides what rides).
   */
  async heartbeatOnce(urls: string[], presence: 'online' | 'offline'): Promise<unknown | null> {
    if (!this.enrolled) return null;
    const nonce = randomNonce();
    const signature = Buffer.from(this.identity.sign(new TextEncoder().encode(nonce))).toString('base64url');
    const base = this.cfg.fleet_url.replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instance_id: this.session!.instance_id,
          nonce,
          signature,
          urls,
          presence,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.error(`[fleet] heartbeat failed (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
    if (!res.ok) {
      console.error(`[fleet] heartbeat HTTP ${res.status}`);
      return null;
    }
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
}

/** A fresh nonce (128 random bits, base64url) — minted per call; the nonce is single-use. */
function randomNonce(): string {
  return randomBytes(16).toString('base64url');
}
