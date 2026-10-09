/**
 * arbiter-client.test.ts — the arbiter-side enrollment client against the
 * REAL fleet service (#55 slice 7, D2 + D3).
 *
 * Real end-to-end round trip on a loopback port: the arbiter's
 * `FleetClient` (server/src/fleet-client.ts) enrolls with a one-time
 * token + its ed25519 public key, then proves the service accepts its
 * SIGNED requests — a heartbeat and a roster pull, each signed with the
 * instance's private key over a fresh nonce (D2 step 3). The service
 * verifies every signature against the stored public key (store.ts
 * `authenticate`) — a wrong signature is a 401, so a 200 is proof the
 * client signs the way the service requires.
 *
 * No mocks: real HTTP, real crypto, a real SQLite file in a tmpdir.
 * The arbiter client is imported from the server workspace source
 * (`server/src/fleet-client.ts`) — the very code the arbiter wires into
 * its roster pull (server/src/mesh.ts `buildRosterFetcher`).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type App } from '../src/index.js';

// The arbiter's enrollment client — imported from the server workspace so
// this test exercises the exact production code path.
const serverSrc = resolve(fileURLToPath(new URL('../../server/src', import.meta.url)));
const { FleetClient, enrollmentFileOf, loadEnrollment, enrollmentFileMode } = await import(
  `${serverSrc}/fleet-client.ts`
);
const { Identity } = await import(`${serverSrc}/identity.ts`);

let app: App;
let base: string;
let dir: string;
let clockNow: () => number;
let t: number;
let identity: InstanceType<typeof Identity>;

/** Mint a fresh operator enrollment token through the service's endpoint. */
async function mintToken(): Promise<string> {
  const res = await fetch(`${base}/token`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { token: string };
  assert.ok(typeof body.token === 'string' && body.token.length > 0);
  return body.token;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'idlefill-fleet-client-'));
  t = 1_700_000_000_000;
  clockNow = () => t;
  app = createApp({ dbFile: join(dir, 'fleet.db'), tokenTtlMs: 15 * 60_000, now: clockNow });
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, () => {
      const a = app.server.address();
      base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
      resolve();
    });
  });
  // The arbiter's #55 D1 identity: minted in a tmpdir (never touching the
  // repo's state files), persisted next to its own tmp state file.
  identity = Identity.loadOrCreate(join(dir, 'arbiter', 'state.json'));
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('round trip: enroll → signed heartbeat → signed roster, all accepted by the real service', async () => {
  const token = await mintToken();
  const file = enrollmentFileOf(join(dir, 'arbiter', 'state.json'));
  assert.ok(!existsSync(file), 'precondition: no credential file yet');
  const client = new FleetClient(file, { fleet_url: base, fleet_enrollment_token: token, name: 'urza' }, identity);

  // --- 1. Enroll: the one-time token is exchanged ONCE for the credential.
  assert.equal(client.enrolled, false, 'precondition: not yet enrolled');
  const enr = await client.ensureEnrolled();
  assert.equal(enr.ok, true, JSON.stringify(enr));
  assert.match(enr.instance_id as string, /^m-[0-9a-f]{16}$/, 'the service issued an instance id');
  assert.ok(enr.credential && (enr.credential as string).length >= 32, 'the session credential came back');
  assert.equal(client.enrolled, true, 'the client is now enrolled');
  // The credential persisted to the sibling file (the #39 D2 posture).
  assert.ok(existsSync(file), 'the credential file exists after enroll');
  assert.equal(enrollmentFileMode(file), 0o600, 'owner-only (0600) — the mesh_edges.json precedent');
  const rec = loadEnrollment(file);
  assert.equal(rec?.instance_id, enr.instance_id, 'the persisted id matches');
  assert.equal(rec?.credential, enr.credential, 'the persisted credential matches');
  assert.equal(rec?.name, 'urza', 'the enrollment name is recorded');
  // Idempotent: a second ensureEnrolled does NOT spend the token again
  // (the token is single-use — a second spend would be a token_used 401,
  // and this call must stay a no-op).
  const again = await client.ensureEnrolled();
  assert.equal(again.ok, true, 'the persisted credential makes re-enroll a no-op');
  assert.equal(again.instance_id, enr.instance_id, 'same instance — no second enroll');

  // --- 2. Heartbeat: the client's SIGNED request is accepted.
  const hb = await client.heartbeatOnce(['https://100.64.0.9:8787'], 'online');
  assert.deepEqual(hb, { ok: true }, 'the service accepted the signed heartbeat');
  const hbTime = t; // the service clock AT the heartbeat (last_seen records this)
  t += 60_000; // advance the service clock (a 60 s cadence passes)

  // --- 3. Roster: the client's SIGNED GET /roster is accepted and returns
  //        THIS instance (the only one enrolled) with its urls + key.
  const roster = (await client.signedRoster()) as {
    instances: { instance_id: string; name: string; public_key: string; urls: string[]; last_seen: number | null }[];
  };
  assert.ok(Array.isArray(roster.instances), 'the roster envelope is {instances: [...]}');
  const mine = roster.instances.find((i) => i.instance_id === enr.instance_id);
  assert.ok(mine, 'this instance is in the roster');
  assert.equal(mine.name, 'urza');
  assert.deepEqual(mine.urls, ['https://100.64.0.9:8787'], 'the heartbeat urls ride the roster');
  assert.equal(mine.public_key, identity.publicKeyB64url, 'the roster carries the enrolled public key');
  assert.equal(mine.last_seen, hbTime, 'last_seen tracks the heartbeat');
});

test('the service rejects an UNSIGNED roster pull (401 missing_auth) — proving the signature is what earns the 200', async () => {
  // The pre-slice-5 plain fetch (no auth fields) is exactly what the
  // service refuses: a 401 named missing_auth. The client's signed call
  // returns 200 (previous test) — the signature is the acceptance.
  const res = await fetch(`${base}/roster`);
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'missing_auth');
});

test('a signature from the WRONG key is rejected (401 bad_signature) — the service verifies against the enrolled public key', async () => {
  // A different instance's key signs a nonce claiming THIS instance's id:
  // the service must reject it (bad_signature) — it cannot be faked.
  const token = await mintToken();
  const otherDir = join(dir, 'other');
  const otherIdentity = Identity.loadOrCreate(join(otherDir, 'state.json'));
  const file = enrollmentFileOf(join(otherDir, 'state.json'));
  const other = new FleetClient(file, { fleet_url: base, fleet_enrollment_token: token, name: 'other' }, otherIdentity);
  const enr = await other.ensureEnrolled();
  assert.equal(enr.ok, true, 'the second instance enrolls fine');

  // Now forge: claim the FIRST instance's id but sign with the second key.
  // (The first instance's id is needed — re-read the roster for it.)
  const roster = (await (
    new FleetClient(enrollmentFileOf(join(dir, 'arbiter', 'state.json')), { fleet_url: base, fleet_enrollment_token: '', name: 'urza' }, identity)
  ).signedRoster()) as { instances: { instance_id: string }[] };
  const firstId = roster.instances.find((i) => i.name === 'urza')!.instance_id;
  const { randomBytes } = await import('node:crypto');
  const nonce = randomBytes(16).toString('base64url');
  const sig = Buffer.from(otherIdentity.sign(new TextEncoder().encode(nonce))).toString('base64url');
  const qs = new URLSearchParams({ instance_id: firstId, nonce, signature: sig }).toString();
  const res = await fetch(`${base}/roster?${qs}`);
  assert.equal(res.status, 401, 'the forged cross-key signature is refused');
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'bad_signature', 'named denial — not missing_auth, not unknown_instance');
});

test('a REPLAYED nonce is rejected (401 nonce_replayed) — single-use nonce defense', async () => {
  // The client mints a fresh nonce per call, so it never replays itself;
  // this pins the service-side behavior the client relies on: the same
  // (id, nonce, signature) twice is a 401.
  const client = new FleetClient(
    enrollmentFileOf(join(dir, 'arbiter', 'state.json')),
    { fleet_url: base, fleet_enrollment_token: '', name: 'urza' },
    identity,
  );
  const roster = (await client.signedRoster()) as { instances: { instance_id: string }[] };
  const id = roster.instances.find((i) => i.name === 'urza')!.instance_id;
  const { randomBytes } = await import('node:crypto');
  const nonce = randomBytes(16).toString('base64url');
  const sig = Buffer.from(identity.sign(new TextEncoder().encode(nonce))).toString('base64url');
  const qs = new URLSearchParams({ instance_id: id, nonce, signature: sig }).toString();
  const first = await fetch(`${base}/roster?${qs}`);
  assert.equal(first.status, 200, 'first use accepted');
  void (await first.json());
  const second = await fetch(`${base}/roster?${qs}`);
  assert.equal(second.status, 401, 'the replay is refused');
  const body = (await second.json()) as { error: string };
  assert.equal(body.error, 'nonce_replayed');
});

test('a wiped credential file re-enrolls from a fresh token (D2 recovery, no crash)', async () => {
  const file = enrollmentFileOf(join(dir, 're-enroll', 'state.json'));
  // First enrollment.
  const t1 = await mintToken();
  const c1 = new FleetClient(file, { fleet_url: base, fleet_enrollment_token: t1, name: 'urza' }, identity);
  const enr1 = await c1.ensureEnrolled();
  assert.equal(enr1.ok, true);
  // Wipe the credential (a wiped machine): the token is already spent, so
  // recovery is a FRESH operator token (D2: wiped-machine recovery).
  rmSync(file, { force: true });
  const t2 = await mintToken();
  const c2 = new FleetClient(file, { fleet_url: base, fleet_enrollment_token: t2, name: 'urza' }, identity);
  assert.equal(c2.enrolled, false, 'the wiped credential means the client is unenrolled');
  const enr2 = await c2.ensureEnrolled();
  assert.equal(enr2.ok, true, 'the fresh token re-enrolls');
  assert.ok(enr2.credential && enr2.credential !== enr1.credential, 'a fresh credential (the old one is gone)');
  // And the re-enrolled identity can pull the roster again.
  const roster = (await c2.signedRoster()) as { instances: { instance_id: string }[] };
  assert.ok(roster.instances.some((i) => i.instance_id === enr2.instance_id), 'the re-enrolled instance is in the roster');
});

test('an expired token is refused at enroll (401 token_expired) — the client reports, never crashes', async () => {
  const { token, expires_at } = (await (await fetch(`${base}/token`, { method: 'POST' })).json()) as { token: string; expires_at: number };
  t = expires_at + 1; // jump the service clock past the token's TTL
  const file = enrollmentFileOf(join(dir, 'expired', 'state.json'));
  const client = new FleetClient(file, { fleet_url: base, fleet_enrollment_token: token, name: 'late' }, identity);
  const enr = await client.ensureEnrolled();
  assert.equal(enr.ok, false, 'the expired token is refused');
  assert.equal(enr.error, 'token_expired', 'named denial');
  assert.equal(client.enrolled, false, 'the client stays unenrolled — the signed path is inert');
  assert.equal(await client.signedRoster(), null, 'a not-enrolled client pulls nothing (no crash)');
});
