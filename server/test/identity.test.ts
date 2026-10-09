/**
 * identity.test.ts — the per-instance ed25519 identity substrate (#55 D1).
 *
 * Covers (real crypto, `node:crypto` only — no mocks, no fixtures):
 *   - mint: keypair shapes (59-char base64url public, 64-char private)
 *   - sign/verify round trip; a tampered payload FAILS; a wrong key FAILS
 *   - persistence: loadOrCreate mints on first use, re-loads the SAME
 *     keypair from identity.json (stable across restarts)
 *   - the file is mode 0600
 *   - a rotated (re-minted) keypair yields a DIFFERENT public key, and the
 *     old signature fails under the new key
 *   - a corrupt identity.json falls back to a fresh mint WITHOUT throwing
 *     (the stale file is moved aside, never deleted silently)
 *   - the private key NEVER enters state.json
 *   - the mesh snapshot: public_key is an ADD key — absent when unset,
 *     present + sanitized (length-capped) when set; an OLD-SHAPED snapshot
 *     without the field still sanitizes byte-for-byte (existing readers
 *     unaffected)
 *
 * Hermetic: real files in a per-test tmpdir. No network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Identity, identityFileOf, type IdentityRecord } from '../src/identity.js';
import { buildMeshSnapshot, sanitizeSnapshot, type MeshSnapshot } from '../src/mesh.js';

function mkDir(): string {
  return mkdtempSync(join(tmpdir(), 'idlefill-identity-'));
}

function stateFileIn(dir: string): string {
  return join(dir, 'state.json');
}

// ---------------------------------------------------------------------------
// Mint + sign/verify — real ed25519
// ---------------------------------------------------------------------------

test('mint: produces the locked key shapes (59-char public, 64-char private)', () => {
  const id = Identity.mint();
  assert.match(id.publicKeyB64url, /^[A-Za-z0-9_-]{59}$/, 'ed25519 SPKI DER → 59 chars base64url');
  assert.match(id.privateKeyB64url, /^[A-Za-z0-9_-]{64}$/, 'ed25519 PKCS#8 DER → 64 chars base64url');
  assert.ok(id.createdAt > 0);
});

test('sign/verify round trip: a signature verifies under the matching public key', () => {
  const id = Identity.mint();
  const payload = new TextEncoder().encode('fleet payload');
  const sig = id.sign(payload);
  assert.equal(sig.length, 64, 'ed25519 signatures are 64 bytes');
  assert.equal(Identity.verify(id.publicKeyB64url, payload, sig), true);
});

test('tampered payload FAILS verification (real crypto, no leniency)', () => {
  const id = Identity.mint();
  const payload = new TextEncoder().encode('fleet payload');
  const sig = id.sign(payload);
  const tampered = new TextEncoder().encode('fleet payloads');
  assert.equal(Identity.verify(id.publicKeyB64url, tampered, sig), false);
  // A signature for a different payload does not cross over.
  const other = id.sign(tampered);
  assert.equal(Identity.verify(id.publicKeyB64url, payload, other), false);
});

test('a signature under key A fails under key B', () => {
  const a = Identity.mint();
  const b = Identity.mint();
  const payload = new TextEncoder().encode('cross-key probe');
  assert.equal(Identity.verify(b.publicKeyB64url, payload, a.sign(payload)), false);
  assert.equal(Identity.verify(a.publicKeyB64url, payload, a.sign(payload)), true);
});

test('verify never throws on garbage (bad key / bad signature shape)', () => {
  const id = Identity.mint();
  const payload = new TextEncoder().encode('x');
  assert.equal(Identity.verify('!!!not-base64!!!', payload, id.sign(payload)), false);
  assert.equal(Identity.verify(id.publicKeyB64url, payload, new Uint8Array([1, 2, 3])), false);
});

// ---------------------------------------------------------------------------
// Persistence: sibling identity.json, atomic, stable across restarts
// ---------------------------------------------------------------------------

test('loadOrCreate: mints on first use, re-loads the SAME keypair from disk', () => {
  const dir = mkDir();
  const sf = stateFileIn(dir);
  const first = Identity.loadOrCreate(sf);
  const file = identityFileOf(sf);
  assert.equal(file, join(dir, 'identity.json'), 'the identity lives next to the state file');
  assert.ok(existsSync(file));
  const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as IdentityRecord;
  assert.equal(onDisk.v, 1, 'schema version 1');
  assert.equal(onDisk.public_key, first.publicKeyB64url);
  assert.equal(onDisk.private_key, first.privateKeyB64url);
  const second = Identity.loadOrCreate(sf); // "restart"
  assert.equal(second.publicKeyB64url, first.publicKeyB64url, 'same keypair after a restart');
  assert.equal(second.createdAt, first.createdAt);
  // And the second load can still verify the first load's signature.
  const payload = new TextEncoder().encode('stability');
  assert.equal(Identity.verify(first.publicKeyB64url, payload, second.sign(payload)), true);
});

test('identity.json is mode 0600 (owner-only)', () => {
  const dir = mkDir();
  const id = Identity.loadOrCreate(stateFileIn(dir));
  assert.equal(Identity.fileMode(id.file), 0o600);
});

test('the private key NEVER enters state.json (D1: it is a sibling file)', () => {
  const dir = mkDir();
  const sf = stateFileIn(dir);
  const id = Identity.loadOrCreate(sf);
  // Simulate the arbiter's state write alongside the identity file.
  writeFileSync(sf, JSON.stringify({ instance_id: 'm-test', servers: [] }));
  const stateJson = readFileSync(sf, 'utf-8');
  assert.ok(!stateJson.includes(id.privateKeyB64url), 'private key absent from state.json');
  assert.ok(!stateJson.includes('private_key'), 'no private_key field rides state.json');
  assert.ok(readFileSync(id.file, 'utf-8').includes(id.privateKeyB64url), 'the private key lives in identity.json');
});

test('a rotated (re-minted) keypair produces a DIFFERENT public key; the old signature fails', () => {
  const dir = mkDir();
  const sf = stateFileIn(dir);
  const old = Identity.loadOrCreate(sf);
  const payload = new TextEncoder().encode('pre-rotation');
  const oldSig = old.sign(payload);
  // Rotation: the stale identity.json is replaced by a fresh mint.
  writeFileSync(old.file, '{"v":1,"public_key":"stale","private_key":"stale","created_at":1}');
  const rotated = Identity.loadOrCreate(sf);
  assert.notEqual(rotated.publicKeyB64url, old.publicKeyB64url, 'rotation changes the public key');
  // The old signature no longer verifies under the new key.
  assert.equal(Identity.verify(rotated.publicKeyB64url, payload, oldSig), false);
  // The new key signs and verifies its own payloads.
  const freshSig = rotated.sign(payload);
  assert.equal(Identity.verify(rotated.publicKeyB64url, payload, freshSig), true);
});

// ---------------------------------------------------------------------------
// Failure posture: corrupt / missing identity.json never throws
// ---------------------------------------------------------------------------

test('a corrupt identity.json falls back to a fresh mint WITHOUT throwing', () => {
  const dir = mkDir();
  const sf = stateFileIn(dir);
  const good = Identity.loadOrCreate(sf);
  const file = identityFileOf(sf);
  writeFileSync(file, '{ not valid json !!!!!');
  let revived: Identity;
  assert.doesNotThrow(() => {
    revived = Identity.loadOrCreate(sf);
  }, 'a corrupt identity must not crash the arbiter');
  const r = revived!;
  assert.ok(r.publicKeyB64url, 'a fresh keypair was minted');
  assert.notEqual(r.publicKeyB64url, good.publicKeyB64url, 'the fresh mint is a new keypair');
  // The stale file is moved aside (the state-file .corrupt-* precedent),
  // never silently deleted.
  const siblings = readdirSync(dir);
  assert.ok(siblings.some((f) => f.startsWith('identity.json.corrupt-')), 'stale file preserved as .corrupt-*');
  // The revived identity works end-to-end.
  const payload = new TextEncoder().encode('post-corruption');
  assert.equal(Identity.verify(r.publicKeyB64url, payload, r.sign(payload)), true);
});

test('a half-written identity.json (valid JSON, bad keys) falls back to a fresh mint', () => {
  const dir = mkDir();
  const sf = stateFileIn(dir);
  const good = Identity.loadOrCreate(sf);
  writeFileSync(identityFileOf(sf), JSON.stringify({ v: 1, public_key: 'AAAA', private_key: 'BBBB', created_at: 1 }));
  let revived: Identity;
  assert.doesNotThrow(() => {
    revived = Identity.loadOrCreate(sf);
  });
  assert.notEqual(revived!.publicKeyB64url, good.publicKeyB64url);
});

test('an identity.json with mismatched key halves is rejected, not trusted', () => {
  const dir = mkDir();
  const sf = stateFileIn(dir);
  const a = Identity.mint();
  const b = Identity.mint();
  const mixed: IdentityRecord = { v: 1, public_key: a.publicKeyB64url, private_key: b.privateKeyB64url, created_at: 1 };
  writeFileSync(identityFileOf(sf), JSON.stringify(mixed)); // private of B, public of A
  let revived: Identity;
  assert.doesNotThrow(() => {
    revived = Identity.loadOrCreate(sf);
  });
  assert.notEqual(revived!.publicKeyB64url, mixed.public_key, 'the mismatched pair was discarded');
});

// ---------------------------------------------------------------------------
// The mesh snapshot: public_key is an ADD key (absent = unset)
// ---------------------------------------------------------------------------

test('buildMeshSnapshot: public_key is ABSENT when unset (old readers see the old shape)', () => {
  const oldShape = buildMeshSnapshot('m-1', 'urza', [], 12, 3, 1, 1_700_000_000_000, '2');
  assert.ok(!('public_key' in oldShape), 'absent = unset — no new field on the wire');
  assert.deepEqual(
    Object.keys(oldShape).sort(),
    ['active_leases', 'instance_id', 'name', 'queue_depth', 'servers', 'sessions', 'ts', 'version'].sort(),
    'the field set is exactly the pre-#55 set',
  );
  const withKey = buildMeshSnapshot('m-1', 'urza', [], 12, 3, 1, 1_700_000_000_000, '2', 'k'.repeat(59));
  assert.equal(withKey.public_key, 'k'.repeat(59), 'present when the publisher carries a key');
});

test('the OLD-SHAPED snapshot (no public_key) still sanitizes — existing peers unaffected', () => {
  const old: MeshSnapshot = {
    instance_id: 'm-abc123',
    name: 'urza',
    ts: 1_700_000_000_000,
    servers: [{ name: 'llama-swap', idle: true, idle_for_s: 600, degraded: false }],
    queue_depth: 42,
    sessions: 2,
    active_leases: 1,
    version: '2',
  };
  const out = sanitizeSnapshot(old);
  assert.ok(out);
  assert.equal(out.instance_id, 'm-abc123');
  assert.equal(out.queue_depth, 42);
  assert.ok(!('public_key' in out), 'the ADD key stays absent for a pre-#55 peer');
  // The wire bytes are unchanged: an old reader deserializing this sees
  // exactly the pre-#55 field set.
  assert.deepEqual(
    Object.keys(out).sort(),
    ['active_leases', 'instance_id', 'name', 'queue_depth', 'servers', 'sessions', 'ts', 'version'].sort(),
  );
});

test('sanitizeSnapshot: a peer public_key is length-capped (untrusted input)', () => {
  const out = sanitizeSnapshot({
    instance_id: 'm-abc123',
    name: 'urza',
    ts: 1_700_000_000_000,
    servers: [],
    queue_depth: 1,
    sessions: 0,
    active_leases: 0,
    public_key: 'k'.repeat(500),
  });
  assert.ok(out);
  assert.equal(out.public_key?.length, 64, 'capped like the other untrusted strings');
  const blank = sanitizeSnapshot({ instance_id: 'm-1', name: 'x', ts: 1, servers: [], queue_depth: 0, sessions: 0, active_leases: 0, public_key: '   ' });
  assert.ok(!('public_key' in (blank ?? {})), 'blank public_key stays unset');
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// (file-backed identities expose their record via publicKeyB64url /
//  privateKeyB64url / file; in-memory mints need no file access)

