/**
 * pair.test.ts — the fleet service pairing ceremony (#55 D4, shape (b)).
 *
 * Real crypto (ed25519 via node:crypto) + a real HTTP server on an
 * ephemeral port + a real SQLite file in a per-test tmpdir. No mocks.
 *
 * The ceremony (PROPOSED wire, fleet-service.md + pairing.md D5):
 * B mints a one-time code (`POST /pair/code`), A redeems it
 * (`POST /pair/redeem`), the service records the DIRECTED edge A → B
 * (A is the controller of B) and publishes it in both rosters.
 * Unpairing removes one direction only. The service is the directory,
 * never the relay — it carries the edge record, not the control
 * traffic (mesh.md D1).
 *
 * Covers the required cases:
 *   - mint + redeem forms the directed edge (from = the redeemer,
 *     to = the minter) and returns the peer's public key
 *   - a USED code is rejected (single-use; 400 code_used)
 *   - an EXPIRED code is rejected (TTL; 400 code_expired)
 *   - a BAD code is rejected (400 invalid_code)
 *   - a SELF-pair is rejected (400 self_pair)
 *   - the roster carries the edge on BOTH ends' rows (the ADD key)
 *   - unpair removes ONE direction only (directional semantics); a
 *     non-end cannot unpair (404 unknown_edge); the edge is gone from
 *     both rosters
 *   - the code plaintext never lands in the store (only the hash at
 *     rest — the enrollment token's posture)
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/index.js';
import { sha256 } from '../src/store.js';

// ---------------------------------------------------------------------------
// Fixtures (same posture as enroll.test.ts: the instance signs a bare
// server nonce with its ed25519 key — the fleet plane's shape).
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

/** A fake clock the app shares, so code expiry is deterministic without sleeping. */
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

interface Instance {
  instanceId: string;
  kp: KeyPair;
  name: string;
}

interface Harness {
  app: App;
  base: string;
  clock: Clock;
  dir: string;
}

/** The pairing-code TTL for this harness (short, so the expiry test is exact). */
const PAIR_TTL_MS = 5 * 60_000;

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-fleet-pair-'));
  const clock = new Clock();
  const app = createApp({
    dbFile: join(dir, 'fleet.db'),
    tokenTtlMs: 15 * 60_000,
    pairCodeTtlMs: PAIR_TTL_MS,
    now: clock.now.bind(clock),
  });
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
async function mintToken(): Promise<string> {
  const r = await jfetch('/token', { method: 'POST' });
  assert.equal(r.status, 200, 'token mint');
  return r.body.token as string;
}

/** Enroll an instance through the full path (token + public key + name). */
async function enroll(name: string): Promise<Instance> {
  const token = await mintToken();
  const kp = mintKeyPair();
  const r = await jfetch('/enroll', {
    method: 'POST',
    body: JSON.stringify({ token, public_key: kp.publicKeyB64url, name }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { instanceId: r.body.instance_id as string, kp, name };
}

/** A fresh server nonce signed by the instance (the fleet auth shape). */
function authBody(instanceId: string, kp: KeyPair, extra: Record<string, unknown> = {}): string {
  const nonce = randomBytes(16).toString('base64url');
  return JSON.stringify({ instance_id: instanceId, nonce, signature: kp.sign(nonce), ...extra });
}

/** Mint a pairing code as B (the minter is the CONTROLLED instance). */
async function mintPairCode(inst: Instance, extra: Record<string, unknown> = {}): Promise<{ code: string; ttl_s: number }> {
  const r = await jfetch('/pair/code', { method: 'POST', body: authBody(inst.instanceId, inst.kp, extra) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(typeof r.body.code === 'string' && (r.body.code as string).startsWith('pair_'), 'code shape');
  assert.equal(r.body.ttl_s, PAIR_TTL_MS / 1000, 'the PROPOSED TTL rides the response');
  return { code: r.body.code as string, ttl_s: r.body.ttl_s as number };
}

/** Pull the roster (signed GET) and return the row for `instanceId`. */
async function rosterRow(instanceId: string, kp: KeyPair): Promise<Record<string, unknown> | undefined> {
  const nonce = randomBytes(16).toString('base64url');
  const qs = new URLSearchParams({ instance_id: instanceId, nonce, signature: kp.sign(nonce) }).toString();
  const res = await fetch(`${H.base}/roster?${qs}`);
  assert.equal(res.status, 200, 'authenticated roster pull');
  const body = (await res.json()) as { instances: Record<string, unknown>[] };
  return body.instances.find((i) => i.instance_id === instanceId);
}

// ---------------------------------------------------------------------------
// The ceremony: mint + redeem
// ---------------------------------------------------------------------------

test('pair: mint + redeem forms the directed edge A -> B (A controls B)', async () => {
  const B = await enroll('urza'); // the minter = the CONTROLLED instance
  const A = await enroll('lab'); // the redeemer = the CONTROLLER

  const { code } = await mintPairCode(B);
  const r = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.edge, { from: A.instanceId, to: B.instanceId }, 'the directed edge: A controls B');
  assert.equal(r.body.peer_public_key, B.kp.publicKeyB64url, 'A gets B\'s public key (its local edge record)');
  assert.equal(r.body.peer_name, 'urza', 'the peer name rides the response');
});

test('pair: a USED code is rejected (400 code_used) — single-use', async () => {
  const B = await enroll('urza-2');
  const A = await enroll('lab-2');
  const C = await enroll('lab-3');
  const { code } = await mintPairCode(B);
  const first = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) });
  assert.equal(first.status, 200, 'first use succeeds');
  const second = await jfetch('/pair/redeem', { method: 'POST', body: authBody(C.instanceId, C.kp, { code }) });
  assert.equal(second.status, 400, 'the second use is refused');
  assert.equal(second.body.error, 'code_used');
});

test('pair: an EXPIRED code is rejected (400 code_expired) — the TTL', async () => {
  const B = await enroll('urza-3');
  const A = await enroll('lab-4');
  const { code } = await mintPairCode(B);
  H.clock.advance(PAIR_TTL_MS + 1); // past the PROPOSED 5 min TTL
  const r = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'code_expired');
});

test('pair: a BAD code is rejected (400 invalid_code)', async () => {
  const A = await enroll('lab-5');
  const r = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: 'pair_not-real' }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_code');
});

test('pair: a SELF-pair is rejected (400 self_pair) — a machine cannot pair to itself', async () => {
  const B = await enroll('urza-4');
  const { code } = await mintPairCode(B);
  // B redeems B's own code: the minter and the redeemer must differ.
  const r = await jfetch('/pair/redeem', { method: 'POST', body: authBody(B.instanceId, B.kp, { code }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'self_pair');
});

test('pair: a malformed redeem body is a 400 (invalid_body), never a crash', async () => {
  const A = await enroll('lab-6');
  const noCode = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, {}) });
  assert.equal(noCode.status, 400);
  assert.equal(noCode.body.error, 'invalid_body');
  const blank = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: '   ' }) });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error, 'invalid_body');
});

test('pair: the pairing routes require signed auth (401 named denials)', async () => {
  const B = await enroll('urza-5');
  // Missing auth entirely.
  const missing = await jfetch('/pair/code', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, 'missing_auth');
  // A signature from the WRONG key.
  const other = mintKeyPair();
  const wrong = await jfetch('/pair/code', { method: 'POST', body: authBody(B.instanceId, other) });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'bad_signature');
  // A replayed nonce (single-use auth, same as the roster).
  const nonce = randomBytes(16).toString('base64url');
  const body = JSON.stringify({ instance_id: B.instanceId, nonce, signature: B.kp.sign(nonce) });
  const first = await jfetch('/pair/code', { method: 'POST', body });
  assert.equal(first.status, 200, 'first use');
  const replay = await jfetch('/pair/code', { method: 'POST', body });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error, 'nonce_replayed');
});

// ---------------------------------------------------------------------------
// The roster: the edge rides on BOTH ends' rows (the ADD key)
// ---------------------------------------------------------------------------

test('roster: a formed edge rides on both ends\' rows (the edges ADD key)', async () => {
  const B = await enroll('urza-6');
  const A = await enroll('lab-7');
  const { code } = await mintPairCode(B);
  const r = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) });
  assert.equal(r.status, 200, 'the edge forms');

  const rowA = (await rosterRow(A.instanceId, A.kp))!;
  const rowB = (await rosterRow(B.instanceId, B.kp))!;
  assert.deepEqual(rowA.edges, [{ from: A.instanceId, to: B.instanceId }], 'A\'s row carries the edge');
  assert.deepEqual(rowB.edges, [{ from: A.instanceId, to: B.instanceId }], 'B\'s row carries the edge too');
  // B (the controlled side) knows who controls it; A (the controller)
  // knows whom it controls. Each side derives its local edge record
  // (controls_me / i_control) from the same {from, to} pair.
  assert.equal(rowB.public_key, B.kp.publicKeyB64url, 'B\'s row carries B\'s key (A verifies against it)');
  assert.equal(rowA.public_key, A.kp.publicKeyB64url, 'A\'s row carries A\'s key (B verifies against it)');
});

test('roster: an unpaired instance has an EMPTY edges array (never absent-crash)', async () => {
  const solo = await enroll('solo');
  const row = (await rosterRow(solo.instanceId, solo.kp))!;
  assert.deepEqual(row.edges, [], 'no edge yet = an empty array');
});

// ---------------------------------------------------------------------------
// Unpair: immediate, directional, ends-only
// ---------------------------------------------------------------------------

test('unpair: an edge end removes the directed edge; it is gone from both rosters', async () => {
  const B = await enroll('urza-7');
  const A = await enroll('lab-8');
  const { code } = await mintPairCode(B);
  const formed = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) });
  assert.equal(formed.status, 200, 'the edge forms');

  // A (the controller) unpairs — the operator-side revocation (pairing.md
  // D6: the enforcement point is the controlled side; the service's
  // deletion is the directory update the next roster pull confirms).
  const unpair = await jfetch('/pair/unpair', {
    method: 'POST',
    body: authBody(A.instanceId, A.kp, { edge: { from: A.instanceId, to: B.instanceId } }),
  });
  assert.equal(unpair.status, 200, JSON.stringify(unpair.body));
  assert.equal(unpair.body.ok, true);

  const rowA = (await rosterRow(A.instanceId, A.kp))!;
  const rowB = (await rosterRow(B.instanceId, B.kp))!;
  assert.deepEqual(rowA.edges, [], 'A\'s roster: the edge is gone');
  assert.deepEqual(rowB.edges, [], 'B\'s roster: the edge is gone');
});

test('unpair: is DIRECTIONAL — removing A -> B leaves B -> A standing', async () => {
  const B = await enroll('urza-8');
  const A = await enroll('lab-9');
  // Two directed edges, both directions (the operator pairs each way).
  const { code: codeB } = await mintPairCode(B);
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: codeB }) })).status, 200, 'A -> B');
  const { code: codeA } = await mintPairCode(A);
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(B.instanceId, B.kp, { code: codeA }) })).status, 200, 'B -> A');

  const rowA = (await rosterRow(A.instanceId, A.kp))!;
  assert.equal(rowA.edges.length, 2, 'both directions recorded');

  // Unpair ONLY A -> B.
  const unpair = await jfetch('/pair/unpair', {
    method: 'POST',
    body: authBody(A.instanceId, A.kp, { edge: { from: A.instanceId, to: B.instanceId } }),
  });
  assert.equal(unpair.status, 200, 'the named direction is removed');

  const afterA = (await rosterRow(A.instanceId, A.kp))!;
  const afterB = (await rosterRow(B.instanceId, B.kp))!;
  assert.deepEqual(afterA.edges, [{ from: B.instanceId, to: A.instanceId }], 'A keeps the edge it is the target of (B -> A)');
  assert.deepEqual(afterB.edges, [{ from: B.instanceId, to: A.instanceId }], 'B keeps the edge it controls (B -> A)');
});

test('unpair: a NON-end cannot remove the edge (404 unknown_edge)', async () => {
  const B = await enroll('urza-9');
  const A = await enroll('lab-10');
  const outsider = await enroll('outsider');
  const { code } = await mintPairCode(B);
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) })).status, 200, 'the edge forms');

  const r = await jfetch('/pair/unpair', {
    method: 'POST',
    body: authBody(outsider.instanceId, outsider.kp, { edge: { from: A.instanceId, to: B.instanceId } }),
  });
  assert.equal(r.status, 404, 'an instance that is not an end cannot unpair');
  assert.equal(r.body.error, 'unknown_edge');
  // The edge still stands.
  const rowA = (await rosterRow(A.instanceId, A.kp))!;
  assert.deepEqual(rowA.edges, [{ from: A.instanceId, to: B.instanceId }], 'the edge survives the outsider\'s attempt');
});

test('unpair: the SAME direction twice is a 404 the second time (already gone)', async () => {
  const B = await enroll('urza-10');
  const A = await enroll('lab-11');
  const { code } = await mintPairCode(B);
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) })).status, 200, 'the edge forms');
  const body = authBody(A.instanceId, A.kp, { edge: { from: A.instanceId, to: B.instanceId } });
  const first = await jfetch('/pair/unpair', { method: 'POST', body });
  assert.equal(first.status, 200, 'first unpair');
  const second = await jfetch('/pair/unpair', { method: 'POST', body: authBody(A.instanceId, A.kp, { edge: { from: A.instanceId, to: B.instanceId } }) });
  assert.equal(second.status, 404, 'the direction is already gone');
  assert.equal(second.body.error, 'unknown_edge');
});

test('unpair: a malformed body is a 400 (invalid_body)', async () => {
  const A = await enroll('lab-12');
  const noEdge = await jfetch('/pair/unpair', { method: 'POST', body: authBody(A.instanceId, A.kp, {}) });
  assert.equal(noEdge.status, 400);
  assert.equal(noEdge.body.error, 'invalid_body');
  const junkEdge = await jfetch('/pair/unpair', { method: 'POST', body: authBody(A.instanceId, A.kp, { edge: 'nope' }) });
  assert.equal(junkEdge.status, 400);
  assert.equal(junkEdge.body.error, 'invalid_body');
});

// ---------------------------------------------------------------------------
// Store hygiene: no plaintext code at rest
// ---------------------------------------------------------------------------

test('store: the pairing code plaintext never lands in the db file', async () => {
  const B = await enroll('urza-11');
  const { code } = await mintPairCode(B);
  const raw = readFileSync(H.app.dbFile, 'utf-8');
  assert.ok(!raw.includes(code), 'the plaintext code is not in the store');
  // The store keys the code by hash only.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(H.app.dbFile, { readOnly: true });
  const row = db.prepare('SELECT minter_instance_id FROM pair_codes WHERE code_hash = ?').get(sha256(code)) as
    | { minter_instance_id: string }
    | undefined;
  assert.ok(row, 'the store holds the code by hash only');
  assert.equal(row.minter_instance_id, B.instanceId, 'the code is bound to the minter');
  db.close();
});

// ---------------------------------------------------------------------------
// Re-pair: the rotation recovery path (pairing.md open question 3)
// ---------------------------------------------------------------------------

test('re-pair: unpair + a fresh code re-forms the edge (the rotation recovery)', async () => {
  const B = await enroll('urza-12');
  const A = await enroll('lab-13');
  const { code: c1 } = await mintPairCode(B);
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: c1 }) })).status, 200, 'first pairing');

  const body = authBody(A.instanceId, A.kp, { edge: { from: A.instanceId, to: B.instanceId } });
  assert.equal((await jfetch('/pair/unpair', { method: 'POST', body })).status, 200, 'the unpair');

  // A fresh code re-forms the same directed edge (idempotent INSERT).
  const { code: c2 } = await mintPairCode(B);
  const repair = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: c2 }) });
  assert.equal(repair.status, 200, 'the re-pair');
  assert.deepEqual(repair.body.edge, { from: A.instanceId, to: B.instanceId });
  const rowA = (await rosterRow(A.instanceId, A.kp))!;
  assert.deepEqual(rowA.edges, [{ from: A.instanceId, to: B.instanceId }], 'exactly one edge stands after the re-pair');
});
