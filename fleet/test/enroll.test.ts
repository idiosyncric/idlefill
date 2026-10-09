/**
 * enroll.test.ts — the fleet service enrollment + roster (#55 slice 3).
 *
 * Real crypto (ed25519 via node:crypto) + a real HTTP server on an
 * ephemeral port + a real SQLite file in a per-test tmpdir. No mocks.
 *
 * Covers the required cases:
 *   - enrollment with a BAD token is rejected (401 invalid_token)
 *   - a USED token is rejected (single-use; 401 token_used)
 *   - an EXPIRED token is rejected (TTL; 401 token_expired)
 *   - a heartbeat with an INVALID signature is rejected (401 bad_signature)
 *   - the roster returns the enrolled instance with its public key + urls
 * Plus: the nonce is single-use (a replay is a 401), an unknown instance
 * is a 401, and the token plaintext never lands in the store (only the
 * hash is at rest — no secrets committed).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/index.js';
import { parseUrls, sha256, sanitizeUrls } from '../src/store.js';

// ---------------------------------------------------------------------------
// Fixture: a keypair that signs like the arbiter's identity would.
// ---------------------------------------------------------------------------

interface KeyPair {
  publicKeyB64url: string;
  sign(payload: string): string; // base64url 64-byte signature
}

function mintKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pk = createPrivateKey({
    key: privateKey.export({ type: 'pkcs8', format: 'der' }),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    publicKeyB64url: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    sign(payload: string): string {
      return sign(null, Buffer.from(payload), pk).toString('base64url');
    },
  };
}

/** A fake clock the app shares, so expiry is deterministic without sleeping. */
class Clock {
  private t: number;
  constructor(ms = 1_700_000_000_000) {
    this.t = ms;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

interface Harness {
  app: App;
  base: string;
  clock: Clock;
  dir: string;
}

function makeHarness(ttlMs = 15 * 60_000): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-fleet-'));
  const clock = new Clock();
  const app = createApp({ dbFile: join(dir, 'fleet.db'), tokenTtlMs: ttlMs, now: clock.now.bind(clock) });
  return { app, base: '', clock, dir };
}

let H: Harness;
let PORT: number;

before(async () => {
  H = makeHarness();
  PORT = await new Promise<number>((resolve, reject) => {
    H.app.server.once('error', reject);
    H.app.server.listen(0, () => {
      const a = H.app.server.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    });
  });
  H.base = `http://127.0.0.1:${PORT}`;
});

after(async () => {
  await H.app.close();
  rmSync(H.dir, { recursive: true, force: true });
});

async function jfetch(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(H.base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

/** Mint an enrollment token through the operator endpoint. */
async function mintToken(): Promise<{ token: string; expires_at: number }> {
  const r = await jfetch('/token', { method: 'POST' });
  assert.equal(r.status, 200, 'token mint');
  assert.ok(typeof r.body.token === 'string' && (r.body.token as string).length > 0, 'token returned');
  assert.ok(typeof r.body.expires_at === 'number', 'expires_at returned');
  return r.body as { token: string; expires_at: number };
}

/** Sign a server nonce the way the arbiter will (ed25519, base64url). */
function authBody(instanceId: string, kp: KeyPair, nonce: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    instance_id: instanceId,
    nonce,
    signature: kp.sign(nonce),
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

test('enroll: a fresh token + valid key + name returns instance_id + credential', async () => {
  const { token } = await mintToken();
  const kp = mintKeyPair();
  const r = await jfetch('/enroll', {
    method: 'POST',
    body: JSON.stringify({ token, public_key: kp.publicKeyB64url, name: 'urza' }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.instance_id as string, /^m-[0-9a-f]{16}$/, 'instance_id shape');
  assert.ok(typeof r.body.credential === 'string' && (r.body.credential as string).length >= 32, 'credential returned');
  // The first server nonce rides the response as an ADD key.
  assert.ok(typeof r.body.nonce === 'string', 'first nonce returned (ADD key)');
});

test('enroll: a BAD token is rejected (401 invalid_token)', async () => {
  const kp = mintKeyPair();
  const r = await jfetch('/enroll', {
    method: 'POST',
    body: JSON.stringify({ token: 'flt_totally-wrong', public_key: kp.publicKeyB64url, name: 'urza' }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'invalid_token');
});

test('enroll: a USED token is rejected (401 token_used) — single-use', async () => {
  const { token } = await mintToken();
  const kp1 = mintKeyPair();
  const first = await jfetch('/enroll', {
    method: 'POST',
    body: JSON.stringify({ token, public_key: kp1.publicKeyB64url, name: 'first' }),
  });
  assert.equal(first.status, 200, 'first use succeeds');
  const kp2 = mintKeyPair();
  const second = await jfetch('/enroll', {
    method: 'POST',
    body: JSON.stringify({ token, public_key: kp2.publicKeyB64url, name: 'second' }),
  });
  assert.equal(second.status, 401, 'second use is refused');
  assert.equal(second.body.error, 'token_used');
});

test('enroll: an EXPIRED token is rejected (401 token_expired) — 15 min TTL default', async () => {
  const { token, expires_at } = await mintToken();
  // The shared clock jumps past the expiry (the default TTL is 15 min).
  H.clock.advance((expires_at - H.clock.now()) + 1);
  const kp = mintKeyPair();
  const r = await jfetch('/enroll', {
    method: 'POST',
    body: JSON.stringify({ token, public_key: kp.publicKeyB64url, name: 'late' }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'token_expired');
});

test('enroll: an invalid public key is a 400 and does NOT burn the token', async () => {
  const { token } = await mintToken();
  const bad = 'k'.repeat(59); // right length, not a valid SPKI
  const r = await jfetch('/enroll', {
    method: 'POST',
    body: JSON.stringify({ token, public_key: bad, name: 'x' }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_public_key');
  // The token still works: the malformed request must not consume it.
  const kp = mintKeyPair();
  const ok = await jfetch('/enroll', {
    method: 'POST',
    body: JSON.stringify({ token, public_key: kp.publicKeyB64url, name: 'still-good' }),
  });
  assert.equal(ok.status, 200, 'the token survives the malformed request');
});

// ---------------------------------------------------------------------------
// Signed-nonce auth
// ---------------------------------------------------------------------------

/** Enroll through the full path and return the instance + a fresh nonce. */
async function enrollInstance(name: string): Promise<{ instanceId: string; kp: KeyPair }> {
  const { token } = await mintToken();
  const kp = mintKeyPair();
  const r = await jfetch('/enroll', {
    method: 'POST',
    body: JSON.stringify({ token, public_key: kp.publicKeyB64url, name }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { instanceId: r.body.instance_id as string, kp };
}

test('heartbeat: an INVALID signature is rejected (401 bad_signature)', async () => {
  const { instanceId, kp } = await enrollInstance('sig-test');
  const nonce = randomBytes(16).toString('base64url');
  const r = await jfetch('/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ instance_id: instanceId, nonce, signature: 'A'.repeat(86), urls: ['https://100.64.0.2:8787'] }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'bad_signature');
});

test('heartbeat: a signature from a DIFFERENT key is rejected', async () => {
  const { instanceId } = await enrollInstance('cross-key');
  const other = mintKeyPair(); // the wrong key signs the nonce
  const nonce = randomBytes(16).toString('base64url');
  const r = await jfetch('/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      instance_id: instanceId,
      nonce,
      signature: other.sign(nonce),
      urls: ['https://100.64.0.3:8787'],
    }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'bad_signature');
});

test('heartbeat: a REPLAYED nonce is rejected (401 nonce_replayed) — single-use', async () => {
  const { instanceId, kp } = await enrollInstance('replay');
  const nonce = randomBytes(16).toString('base64url');
  const body = authBody(instanceId, kp, nonce, { urls: ['https://100.64.0.4:8787'], presence: 'online' });
  const first = await jfetch('/heartbeat', { method: 'POST', body });
  assert.equal(first.status, 200, 'first use');
  const second = await jfetch('/heartbeat', { method: 'POST', body });
  assert.equal(second.status, 401, 'the replay is refused');
  assert.equal(second.body.error, 'nonce_replayed');
});

test('auth: an unknown instance_id is a 401 (unknown_instance)', async () => {
  const kp = mintKeyPair();
  const nonce = randomBytes(16).toString('base64url');
  const r = await jfetch('/roster', {
    method: 'POST',
    body: authBody('m-deadbeefdeadbeef', kp, nonce),
  });
  // /roster is a GET; a POST with a valid signature for an unknown id
  // still lands on the auth path first. The named denial is the point.
  assert.ok([401, 404].includes(r.status));
  assert.equal(r.status === 401 ? r.body.error : undefined, 'unknown_instance');
});

test('auth: missing auth fields are a 401 (missing_auth)', async () => {
  const r = await jfetch('/roster', { method: 'POST', body: JSON.stringify({ instance_id: 'm-x', nonce: '', signature: '' }) });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'missing_auth');
});

// ---------------------------------------------------------------------------
// Heartbeat + roster
// ---------------------------------------------------------------------------

test('roster: returns the enrolled instance with its public key + urls', async () => {
  const { instanceId, kp } = await enrollInstance('urza');

  // Two heartbeats: urls update, last_seen advances.
  const n1 = randomBytes(16).toString('base64url');
  const h1 = await jfetch('/heartbeat', {
    method: 'POST',
    body: authBody(instanceId, kp, n1, { urls: ['https://100.64.0.2:8787'], presence: 'online' }),
  });
  assert.equal(h1.status, 200, JSON.stringify(h1.body));
  assert.equal(h1.body.ok, true);
  const t1 = H.clock.now();
  H.clock.advance(1000);
  const n2 = randomBytes(16).toString('base64url');
  const h2 = await jfetch('/heartbeat', {
    method: 'POST',
    body: authBody(instanceId, kp, n2, { urls: ['https://100.64.0.2:8787', 'https://100.115.9.9:8787'] }),
  });
  assert.equal(h2.status, 200);

  // GET /roster with signed-nonce auth.
  const n3 = randomBytes(16).toString('base64url');
  // The roster is a GET; the auth rides the query as a signed envelope:
  // instance_id + nonce + signature, each URL-encoded. The service reads
  // them the same way it reads a body for a POST.
  const qs = new URLSearchParams({
    instance_id: instanceId,
    nonce: n3,
    signature: kp.sign(n3),
  }).toString();
  const res = await fetch(`${H.base}/roster?${qs}`);
  assert.equal(res.status, 200, 'authenticated roster pull');
  const body = (await res.json()) as { instances: Record<string, unknown>[] };
  const mine = body.instances.find((i) => i.instance_id === instanceId);
  assert.ok(mine, 'the enrolled instance is in the roster');
  assert.equal(mine.name, 'urza');
  assert.equal(mine.public_key, kp.publicKeyB64url, 'the roster carries the public key');
  assert.deepEqual(mine.urls, ['https://100.64.0.2:8787', 'https://100.115.9.9:8787'], 'urls ride the roster');
  assert.equal(mine.last_seen, t1 + 1000, 'last_seen tracks the newest heartbeat');
});

// ---------------------------------------------------------------------------
// Store hygiene: no plaintext secret at rest
// ---------------------------------------------------------------------------

test('store: the enrollment token plaintext never lands in the db file', async () => {
  const { token } = await mintToken();
  const raw = readFileSync(H.app.dbFile, 'utf-8');
  assert.ok(!raw.includes(token), 'the plaintext token is not in the store');
  // The hash IS what the store keys on — the operator token mints by hash.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(H.app.dbFile, { readOnly: true });
  const row = db.prepare('SELECT token_hash FROM tokens WHERE token_hash = ?').get(sha256(token)) as
    | { token_hash: string }
    | undefined;
  assert.ok(row, 'the store holds the token by hash only');
  db.close();
});

// ---------------------------------------------------------------------------
// Sanitizers (pure functions, untrusted wire input)
// ---------------------------------------------------------------------------

test('sanitizeUrls: drops garbage, trims, caps length + count', () => {
  assert.deepEqual(sanitizeUrls([' https://a ', 42, null]), ['https://a'], 'non-strings drop individually');
  assert.deepEqual(sanitizeUrls([]), [], 'an empty array stays empty');
  assert.equal(sanitizeUrls('nope'), null, 'a non-array is invalid');
  assert.deepEqual(sanitizeUrls(['x'.repeat(257)]), [], 'over-long entries drop');
  const many = Array.from({ length: 32 }, (_, i) => `https://u${i}`);
  assert.equal(sanitizeUrls(many)!.length, 16, 'bounded at MAX_URLS');
});

test('parseUrls: a corrupt stored value degrades to []', () => {
  assert.deepEqual(parseUrls('not-json'), []);
  assert.deepEqual(parseUrls('{}'), []);
  assert.deepEqual(parseUrls('["a", "b"]'), ['a', 'b']);
});
