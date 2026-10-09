/**
 * ceremony.test.ts — the fleet-side pairing ceremony hardening (#55 slice 11).
 *
 * Slice 6 built the ceremony; slice 10 wired the arbiter half. This file
 * pins the CEREMONY CONTRACT itself, one named refusal per acceptance line,
 * against a real HTTP server, real ed25519 crypto and a real SQLite file.
 * No mocks.
 *
 * The contract (docs/architecture/fleet-service.md D4, pairing.md D5/D6):
 *   mint_pair_code  -> a single-use code carrying its TTL
 *   redeem_pair_code-> the DIRECTED edge (the redeemer is the controller),
 *                      idempotent on repeat, every refusal NAMED:
 *                      expired / used / bad_signature / self_pair /
 *                      unknown_redeemer
 *   drop_edge       -> the directed edge is gone, so a later roster pull
 *                      cannot re-create a record the operator deleted
 *   the roster      -> carries the edge on BOTH endpoints' rows even when a
 *                      paired machine has never heartbeated a url
 *   unsigned        -> no ceremony call succeeds without a valid signature
 *
 * The invariant this slice adds: a REFUSED redeem never burns the code.
 * The single-use UPDATE is the last step, so expired/self_pair/
 * unknown_redeemer/unknown_minter refusals leave the code redeemable by
 * its intended pair.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/index.js';
import { mintPairCode, redeemPairCode, sha256, unpairEdge, PAIR_CODE_TTL_MS } from '../src/store.js';

// ---------------------------------------------------------------------------
// Fixtures (the pair.test.ts posture: real keys, real server, real db file)
// ---------------------------------------------------------------------------

interface KeyPair {
  publicKeyB64url: string;
  sign(payload: string): string;
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

/** A fake clock so the TTL boundary is exact without sleeping. */
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

const CODE_TTL_MS = 5 * 60_000;

let H: { app: App; base: string; clock: Clock; dir: string };

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-fleet-ceremony-'));
  const clock = new Clock();
  const app = createApp({
    dbFile: join(dir, 'fleet.db'),
    tokenTtlMs: 15 * 60_000,
    pairCodeTtlMs: CODE_TTL_MS,
    now: clock.now.bind(clock),
  });
  const port = await new Promise<number>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, () => {
      const a = app.server.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    });
  });
  H = { app, base: `http://127.0.0.1:${port}`, clock, dir };
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

async function mintToken(): Promise<string> {
  const r = await jfetch('/token', { method: 'POST' });
  assert.equal(r.status, 200, 'token mint');
  return r.body.token as string;
}

async function enroll(name: string): Promise<Instance> {
  const kp = mintKeyPair();
  const r = await jfetch('/enroll', {
    method: 'POST',
    body: JSON.stringify({ token: await mintToken(), public_key: kp.publicKeyB64url, name }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { instanceId: r.body.instance_id as string, kp, name };
}

/** A fresh server nonce signed by the instance (the fleet auth shape). */
function authBody(instanceId: string, kp: KeyPair, extra: Record<string, unknown> = {}): string {
  const nonce = randomBytes(16).toString('base64url');
  return JSON.stringify({ instance_id: instanceId, nonce, signature: kp.sign(nonce), ...extra });
}

async function mintCode(inst: Instance): Promise<string> {
  const r = await jfetch('/pair/code', { method: 'POST', body: authBody(inst.instanceId, inst.kp) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.code as string;
}

/** A fresh unsigned nonce "signature" minted by a DIFFERENT key — looks
 *  like a signed call, and must fail closed. */
function forgedAuth(instanceId: string): string {
  const nonce = randomBytes(16).toString('base64url');
  return JSON.stringify({ instance_id: instanceId, nonce, signature: mintKeyPair().sign(nonce) });
}

/** The edge rows in the store, straight from SQLite (the ground truth). */
function edgeRows(): Array<{ from: string; to: string }> {
  const db = new DatabaseSync(H.app.dbFile, { readOnly: true });
  try {
    return db
      .prepare('SELECT from_instance_id AS "from", to_instance_id AS "to" FROM edges')
      .all() as Array<{ from: string; to: string }>;
  } finally {
    db.close();
  }
}

/** The roster as any arbiter would see it (signed pull). */
interface RosterRowT {
  instance_id: string;
  public_key: string;
  urls: string[];
  edges: Array<{ from: string; to: string }>;
}

async function rosterRows(): Promise<RosterRowT[]> {
  const inst = await rosterInstance();
  const nonce = randomBytes(16).toString('base64url');
  const qs = new URLSearchParams({
    instance_id: inst.instanceId,
    nonce,
    signature: inst.kp.sign(nonce),
  }).toString();
  const res = await fetch(`${H.base}/roster?${qs}`);
  assert.equal(res.status, 200, 'authenticated roster pull');
  const body = (await res.json()) as { instances: RosterRowT[] };
  return body.instances;
}

// Any enrolled instance works as a roster caller; keep one cheap.
let rosterCaller: Instance | null = null;
async function rosterInstance(): Promise<Instance> {
  if (!rosterCaller) rosterCaller = await enroll('roster-caller');
  return rosterCaller;
}

// ---------------------------------------------------------------------------
// mint_pair_code: single-use, TTL-carrying
// ---------------------------------------------------------------------------

test('mint: a pairing code is single-use and carries its TTL (code + ttl_s + a stored expiry)', async () => {
  const B = await enroll('urza-mint');
  const A = await enroll('lab-mint');
  const mintedAt = H.clock.now();
  const r = await jfetch('/pair/code', { method: 'POST', body: authBody(B.instanceId, B.kp) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(typeof r.body.code === 'string' && (r.body.code as string).startsWith('pair_'), 'the code shape');
  assert.equal(r.body.ttl_s, CODE_TTL_MS / 1000, 'the TTL rides the response in seconds');

  const db = new DatabaseSync(H.app.dbFile, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT expires_at, used_at FROM pair_codes WHERE code_hash = ?')
      .get(sha256(r.body.code as string)) as { expires_at: number; used_at: number | null } | undefined;
    assert.ok(row, 'the code is stored by hash only');
    assert.equal(row.expires_at, mintedAt + CODE_TTL_MS, 'the stored expiry is mint time + TTL');
    assert.equal(row.used_at, null, 'a minted code starts unused');
  } finally {
    db.close();
  }

  // Single-use: the second redeem is refused by name.
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: r.body.code }) })).status, 200);
  const again = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: r.body.code }) });
  assert.equal(again.status, 400);
  assert.equal(again.body.error, 'code_used');
});

test('mint: a code minted for an instance the fleet does not know is refused by name (no ghost minter)', async () => {
  const db = new DatabaseSync(H.app.dbFile);
  try {
    const r = mintPairCode(db, 'm-ghost-does-not-exist', CODE_TTL_MS, H.clock.now());
    assert.equal(r.ok, false, 'a ghost id cannot mint');
    assert.equal(r.error, 'unknown_minter', 'the refusal is NAMED');
  } finally {
    db.close();
  }
  // And over HTTP the same posture: the signer must be a real instance.
  const r = await jfetch('/pair/code', { method: 'POST', body: forgedAuth('m-ghost-http') });
  assert.equal(r.status, 401, 'an unknown signer never mints');
  assert.equal(r.body.error, 'unknown_instance');
});

test('mint: a non-positive TTL falls back to the PROPOSED default, never an instantly-expired code', async () => {
  const B = await enroll('urza-ttl');
  const db = new DatabaseSync(H.app.dbFile);
  try {
    const now = H.clock.now();
    const r = mintPairCode(db, B.instanceId, 0, now);
    assert.equal(r.ok, true, 'a real minter still mints');
    assert.equal(r.expires_at, now + PAIR_CODE_TTL_MS, 'the nonsense TTL is replaced by the default');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// redeem_pair_code: the directed edge, written by the redeemer
// ---------------------------------------------------------------------------

test('redeem: the redeemer is the CONTROLLER — the edge is written as (redeemer -> minter)', async () => {
  const B = await enroll('urza-dir');
  const A = await enroll('lab-dir');
  const code = await mintCode(B);
  const r = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.edge, { from: A.instanceId, to: B.instanceId }, 'A controls B (pairing.md D5)');
  assert.equal(r.body.peer_public_key, B.kp.publicKeyB64url, 'the controller gets the peer public key');
  const rows = edgeRows().filter((e) => (e.from === A.instanceId || e.to === A.instanceId) && (e.from === B.instanceId || e.to === B.instanceId));
  assert.deepEqual(rows.map((e) => ({ from: e.from, to: e.to })), [{ from: A.instanceId, to: B.instanceId }], 'the service stored exactly the directed edge, in the D5 direction');
});

test('redeem: idempotent on repeat — re-pairing the same A -> B is one edge, not two', async () => {
  const B = await enroll('urza-idem');
  const A = await enroll('lab-idem');
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: await mintCode(B) }) })).status, 200);
  // A spent code cannot be redeemed twice; the re-pair needs a fresh mint
  // (the rotation recovery path, pairing.md open question 3).
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: await mintCode(B) }) })).status, 200);
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: await mintCode(B) }) })).status, 200);
  assert.equal(edgeRows().filter((e) => (e.from === A.instanceId && e.to === B.instanceId)).length, 1, 'three ceremonies, ONE edge row (the PRIMARY KEY deduped them)');

  const rowA = (await rosterRows()).find((i) => i.instance_id === A.instanceId)!;
  assert.equal((rowA.edges as unknown[]).length, 1, 'the roster publishes one edge, not a duplicate per ceremony');
});

// ---------------------------------------------------------------------------
// Every refusal, by NAME
// ---------------------------------------------------------------------------

test('redeem: an expired code is refused with the NAMED reason code_expired', async () => {
  const B = await enroll('urza-exp');
  const A = await enroll('lab-exp');
  const code = await mintCode(B);
  H.clock.advance(CODE_TTL_MS); // exactly at the expiry instant: expired
  const r = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error, 'code_expired');
  assert.equal(edgeRows().filter((e) => e.from === A.instanceId && e.to === B.instanceId).length, 0, 'the refused ceremony wrote no edge');
});

test('redeem: the TTL boundary is exclusive — one millisecond before expiry the code still redeems', async () => {
  const B = await enroll('urza-ttl2');
  const A = await enroll('lab-ttl2');
  const mintedAt = H.clock.now();
  const code = await mintCode(B);
  H.clock.advance(CODE_TTL_MS - 1);
  const r = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) });
  assert.equal(r.status, 200, `redeemed at ${H.clock.now() - mintedAt} ms of a ${CODE_TTL_MS} ms TTL`);
  H.clock.advance(1);
  const expired = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: await mintCode(B) }) });
  assert.equal(expired.status, 200, 'a fresh code still works after the clock moves');
});

test('redeem: a used code is refused with the NAMED reason code_used', async () => {
  const B = await enroll('urza-used');
  const A = await enroll('lab-used');
  const C = await enroll('lab-used-2');
  const code = await mintCode(B);
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) })).status, 200);
  const r = await jfetch('/pair/redeem', { method: 'POST', body: authBody(C.instanceId, C.kp, { code }) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'code_used');
  assert.equal(edgeRows().filter((e) => e.from === C.instanceId).length, 0, 'the second attempt wrote nothing');
});

test('redeem: an unsigned ceremony call is refused with the NAMED reason bad_signature and forms no edge', async () => {
  const B = await enroll('urza-sig');
  const A = await enroll('lab-sig');
  const code = await mintCode(B);

  // A signature minted by the WRONG key: looks signed, is not ours.
  const wrong = await jfetch('/pair/redeem', { method: 'POST', body: forgedAuth(A.instanceId) });
  assert.equal(wrong.status, 401, JSON.stringify(wrong.body));
  assert.equal(wrong.body.error, 'bad_signature');

  // Missing signature entirely.
  const bare = await jfetch('/pair/redeem', { method: 'POST', body: JSON.stringify({ instance_id: A.instanceId, nonce: randomBytes(16).toString('base64url') }) });
  assert.equal(bare.status, 401);
  assert.equal(bare.body.error, 'missing_auth');

  // A garbage-shaped signature.
  const junk = await jfetch('/pair/redeem', {
    method: 'POST',
    body: JSON.stringify({ instance_id: A.instanceId, nonce: randomBytes(16).toString('base64url'), signature: 'not-a-signature' }),
  });
  assert.equal(junk.status, 401);
  assert.equal(junk.body.error, 'bad_signature');

  assert.equal(edgeRows().filter((e) => e.from === A.instanceId && e.to === B.instanceId).length, 0, 'no unsigned ceremony formed an edge');
  // And the code is still redeemable by the intended pair.
  const good = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) });
  assert.equal(good.status, 200, 'the refused attempts did not burn the code');
});

test('redeem: NO ceremony route (code/redeem/unpair) answers an unsigned call', async () => {
  const B = await enroll('urza-unsigned');
  const A = await enroll('lab-unsigned');
  for (const path of ['/pair/code', '/pair/redeem', '/pair/unpair']) {
    const r = await jfetch(path, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(r.status, 401, `${path} without a signature`);
    assert.equal(r.body.error, 'missing_auth', `${path} names its denial`);
  }
  // A replayed nonce is also a named refusal (single-use auth).
  const nonce = randomBytes(16).toString('base64url');
  const body = JSON.stringify({ instance_id: B.instanceId, nonce, signature: B.kp.sign(nonce), code: 'pair_x' });
  const first = await jfetch('/pair/redeem', { method: 'POST', body });
  assert.equal(first.status, 400, 'the first attempt is refused for the code, not the auth');
  assert.equal(first.body.error, 'invalid_code');
  const replay = await jfetch('/pair/redeem', { method: 'POST', body });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error, 'nonce_replayed');
  assert.equal(edgeRows().filter((e) => e.from === A.instanceId).length, 0, 'nothing formed on the unsigned/replayed path');
});

test('redeem: a self-pair is refused with the NAMED reason self_pair and does not burn the code', async () => {
  const B = await enroll('urza-self');
  const A = await enroll('lab-self');
  const code = await mintCode(B);
  const self = await jfetch('/pair/redeem', { method: 'POST', body: authBody(B.instanceId, B.kp, { code }) });
  assert.equal(self.status, 400);
  assert.equal(self.body.error, 'self_pair');
  assert.equal(edgeRows().filter((e) => e.from === B.instanceId && e.to === B.instanceId).length, 0, 'no self-edge');
  // The refusal is not a burn: the intended controller can still redeem it.
  const ok = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) });
  assert.equal(ok.status, 200, 'a refused self-pair leaves the code redeemable');
});

test('redeem: a redeemer the fleet does not know is refused with the NAMED reason unknown_redeemer', async () => {
  // Store level: the ceremony's refusal list is complete by name.
  const db = new DatabaseSync(H.app.dbFile);
  try {
    const B = await enroll('urza-unk');
    const minted = mintPairCode(db, B.instanceId, CODE_TTL_MS, H.clock.now());
    assert.equal(minted.ok, true);
    const r = redeemPairCode(db, minted.code, 'm-never-enrolled', H.clock.now());
    assert.equal(r.ok, false);
    assert.equal(r.error, 'unknown_redeemer', 'an unknown redeemer is named, not silently accepted');
    assert.equal(edgeRows().filter((e) => e.to === B.instanceId && e.from === 'm-never-enrolled').length, 0, 'no edge from a ghost controller');
    // Still redeemable by a real instance — the refusal did not burn it.
    const A = await enroll('lab-unk');
    assert.equal(redeemPairCode(db, minted.code, A.instanceId, H.clock.now()).ok, true, 'the intended pair can still redeem');
  } finally {
    db.close();
  }
});

test('redeem: every refusal is in the contract set and no successful redeem is ever a refusal', async () => {
  const B = await enroll('urza-set');
  const A = await enroll('lab-set');
  const code = await mintCode(B);
  const ok = await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) });
  assert.equal(ok.status, 200);
  const refusals: string[] = [];
  refusals.push((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: 'pair_fake' }) })).body.error as string);
  refusals.push((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code }) })).body.error as string);
  refusals.push((await jfetch('/pair/redeem', { method: 'POST', body: authBody(B.instanceId, B.kp, { code: await mintCode(B) }) })).body.error as string);
  for (const reason of refusals) {
    assert.ok(['invalid_code', 'code_used', 'code_expired', 'self_pair', 'unknown_redeemer', 'unknown_minter'].includes(reason), `unexpected refusal name: ${reason}`);
  }
  assert.ok(refusals.includes('invalid_code') && refusals.includes('code_used') && refusals.includes('self_pair'), 'bad/used/self all present');
});

// ---------------------------------------------------------------------------
// drop_edge: the directory update that makes a revocation stick
// ---------------------------------------------------------------------------

test('drop_edge: removing the directed edge is gone from BOTH endpoints and cannot be re-created by a pull', async () => {
  const B = await enroll('urza-drop');
  const A = await enroll('lab-drop');
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: await mintCode(B) }) })).status, 200);
  const pair = (id1: string, id2: string) => edgeRows().filter((e) => e.from === id1 && e.to === id2).length;
  assert.equal(pair(A.instanceId, B.instanceId), 1);

  const drop = await jfetch('/pair/unpair', {
    method: 'POST',
    body: authBody(A.instanceId, A.kp, { edge: { from: A.instanceId, to: B.instanceId } }),
  });
  assert.equal(drop.status, 200, JSON.stringify(drop.body));
  assert.equal(pair(A.instanceId, B.instanceId), 0, 'the edge row is deleted from the directory');

  // Every later roster pull sees nothing: no row can re-create the record.
  for (let i = 0; i < 3; i++) {
    const rows = await rosterRows();
    const aRow = rows.find((i2) => i2.instance_id === A.instanceId)!;
    const bRow = rows.find((i2) => i2.instance_id === B.instanceId)!;
    assert.deepEqual(aRow.edges, [], `pull ${i}: A carries no edge`);
    assert.deepEqual(bRow.edges, [], `pull ${i}: B carries no edge`);
  }

  // A drop from a NON-end is refused by name and leaves the edge standing.
  const C = await enroll('lab-drop-outsider');
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: await mintCode(B) }) })).status, 200);
  const denied = await jfetch('/pair/unpair', {
    method: 'POST',
    body: authBody(C.instanceId, C.kp, { edge: { from: A.instanceId, to: B.instanceId } }),
  });
  assert.equal(denied.status, 404);
  assert.equal(denied.body.error, 'unknown_edge');
  assert.equal(edgeRows().filter((e) => e.from === A.instanceId && e.to === B.instanceId).length, 1, 'the outsider dropped nothing');

  // The SAME direction twice: the second drop is a named 404, never a crash.
  assert.equal((await jfetch('/pair/unpair', { method: 'POST', body: authBody(A.instanceId, A.kp, { edge: { from: A.instanceId, to: B.instanceId } }) })).status, 200);
  const repeat = await jfetch('/pair/unpair', { method: 'POST', body: authBody(A.instanceId, A.kp, { edge: { from: A.instanceId, to: B.instanceId } }) });
  assert.equal(repeat.status, 404);
  assert.equal(repeat.body.error, 'unknown_edge');
});

test('drop_edge: is directional — dropping A -> B leaves B -> A standing', async () => {
  const B = await enroll('urza-dyn');
  const A = await enroll('lab-dyn');
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: await mintCode(B) }) })).status, 200); // A -> B
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(B.instanceId, B.kp, { code: await mintCode(A) }) })).status, 200); // B -> A
  const both = (x: string, y: string) => edgeRows().filter((e) => (e.from === x && e.to === y) || (e.from === y && e.to === x)).map((e) => ({ from: e.from, to: e.to }));
  assert.equal(both(A.instanceId, B.instanceId).length, 2);
  assert.equal((await jfetch('/pair/unpair', { method: 'POST', body: authBody(A.instanceId, A.kp, { edge: { from: A.instanceId, to: B.instanceId } }) })).status, 200);
  assert.deepEqual(both(A.instanceId, B.instanceId), [{ from: B.instanceId, to: A.instanceId }], 'only the named direction was dropped');
});

// ---------------------------------------------------------------------------
// The roster carries the ceremony even for a machine with no url yet
// ---------------------------------------------------------------------------

test('roster: a paired machine with NO url ever still carries the edge on its own row', async () => {
  const B = await enroll('urza-nourl'); // never heartbeats: urls stay []
  const A = await enroll('lab-nourl');
  A.kp; // A also never heartbeats; the edge must ride regardless
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: await mintCode(B) }) })).status, 200);

  const rows = await rosterRows();
  const aRow = rows.find((i) => i.instance_id === A.instanceId)!;
  const bRow = rows.find((i) => i.instance_id === B.instanceId)!;
  assert.deepEqual(aRow.urls, [], 'neither machine has a url yet');
  assert.deepEqual(aRow.edges, [{ from: A.instanceId, to: B.instanceId }], 'the controller row carries the edge');
  assert.deepEqual(bRow.edges, [{ from: A.instanceId, to: B.instanceId }], 'the controlled row carries the same edge (the ADD key rides both rows)');
  assert.equal(bRow.public_key, B.kp.publicKeyB64url, 'the key the controller needs is published even without a url');
});

test('roster: after a drop_edge the edge is absent from both rows on the next pull (no re-creation)', async () => {
  const B = await enroll('urza-nourl2');
  const A = await enroll('lab-nourl2');
  assert.equal((await jfetch('/pair/redeem', { method: 'POST', body: authBody(A.instanceId, A.kp, { code: await mintCode(B) }) })).status, 200);
  const rows = await rosterRows();
  assert.equal(rows.find((i) => i.instance_id === B.instanceId)!.edges.length, 1, 'precondition: the url-less row carries the edge');
  assert.equal((await jfetch('/pair/unpair', { method: 'POST', body: authBody(A.instanceId, A.kp, { edge: { from: A.instanceId, to: B.instanceId } }) })).status, 200);
  const after = await rosterRows();
  assert.deepEqual(after.find((i) => i.instance_id === A.instanceId)!.edges, [], 'the controller sees nothing');
  assert.deepEqual(after.find((i) => i.instance_id === B.instanceId)!.edges, [], 'the url-less peer sees nothing');
});

// ---------------------------------------------------------------------------
// Store hygiene
// ---------------------------------------------------------------------------

test('store: the plaintext code never lands in the db file, and a refused code is not marked used', async () => {
  const B = await enroll('urza-hyg');
  const code = await mintCode(B);
  const raw = readFileSync(H.app.dbFile, 'utf-8');
  assert.ok(!raw.includes(code), 'no plaintext code at rest');

  const self = await jfetch('/pair/redeem', { method: 'POST', body: authBody(B.instanceId, B.kp, { code }) });
  assert.equal(self.status, 400);
  assert.equal(self.body.error, 'self_pair');
  const db = new DatabaseSync(H.app.dbFile, { readOnly: true });
  try {
    const row = db.prepare('SELECT used_at FROM pair_codes WHERE code_hash = ?').get(sha256(code)) as { used_at: number | null } | undefined;
    assert.ok(row, 'the code is keyed by hash');
    assert.equal(row.used_at, null, 'a REFUSED redeem did not consume the code');
  } finally {
    db.close();
  }
});
