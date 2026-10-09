/**
 * pairing.test.ts — the arbiter-side pairing wiring (#55 D4, slice 10).
 *
 * The ceremony lives on the fleet service (slice 6). What this file pins
 * is the ARBITER half that was missing: redeem a peer's code and write the
 * LOCAL `mesh_edges.json` record, so the #39 per-edge routes stop denying
 * with `unknown_instance_id` for a real paired peer.
 *
 * Real crypto (ed25519 via node:crypto), a REAL fleet service on a real
 * loopback port, a REAL SQLite file in a tmpdir, a REAL EdgeStore file.
 * No mocks.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { start as startFleet } from '../../fleet/src/index.js';
import { EdgeStore } from '../src/edges.js';
import { Identity } from '../src/identity.js';
import { FleetClient, enrollmentFileOf } from '../src/fleet-client.js';
import { MeshFederation } from '../src/mesh.js';
import { PairingClient } from '../src/pairing.js';
import { applyDefaults } from '../src/config.js';
import { sanitizeRoster } from '../src/mesh.js';

const TMP = mkdtempSync(join(tmpdir(), 'idlefill-pairing-'));

let fleetApp: { close: () => Promise<void> } | null = null;

async function bootFleet(dbFile: string): Promise<number> {
  mkdirSync(dirname(dbFile), { recursive: true });
  const r = await startFleet(0, { dbFile });
  fleetApp = r.app;
  return r.port;
}

async function closeFleet(): Promise<void> {
  if (fleetApp) {
    await fleetApp.close();
    fleetApp = null;
  }
}

async function mintToken(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return String((await res.json()).token);
}

/** One real arbiter side: identity + edge store + pairing client. */
/**
 * One real arbiter side: identity + edge store + pairing client.
 *
 * EACH machine gets its OWN directory. `identityFileOf()` replaces the
 * basename with `identity.json` next to the state file, so two machines
 * seeded from one directory silently share ONE keypair — and the fleet
 * then reads the ceremony as a self-pair. (The same gotcha the #55 slice 9
 * live proof hit.)
 */
function arbiterSide(dir: string, port: number, token: string, name: string) {
  const home = join(dir, name);
  mkdirSync(home, { recursive: true });
  const stateFile = join(home, 'state.json');
  const identity = Identity.loadOrCreate(stateFile);
  const edges = new EdgeStore(join(home, 'mesh_edges.json'));
  const pairing = new PairingClient(
    applyDefaults({
      state_file: stateFile,
      fleet_url: `http://127.0.0.1:${port}`,
      fleet_instance_id: 'declared-seam',
      fleet_enrollment_token: token,
      mesh_name: name,
    }),
    identity,
    edges,
  );
  return { identity, edges, pairing };
}

after(async () => {
  await closeFleet();
  rmSync(TMP, { recursive: true, force: true });
});

test('slice 10: mint + redeem writes the LOCAL edge record with the peer real public key and the D5 direction', async () => {
  const dir = join(TMP, 'a1');
  const port = await bootFleet(join(dir, 'fleet.db'));
  const a = arbiterSide(dir, port, await mintToken(port), 'arbiter-a');
  const b = arbiterSide(dir, port, await mintToken(port), 'arbiter-b');

  // B mints, A redeems: A becomes the CONTROLLER of B (pairing.md D5).
  const mint = await b.pairing.mintCodeForPeer();
  assert.ok(mint && typeof mint.code === 'string' && mint.code.length > 0, 'the mint returns a plaintext code once');
  assert.ok(mint.ttl_s > 0, 'the code carries its TTL');

  const r = await a.pairing.pairWithCode(mint.code);
  assert.equal(r.ok, true, `the redeem succeeded (got ${r.error})`);
  assert.equal(r.direction, 'i_control', 'the redeemer controls the minter (D5, LOCKED)');
  assert.ok(r.peer_instance_id && r.peer_instance_id.startsWith('m-'), 'the peer id is the fleet-issued identity');
  assert.equal(r.peer_name, 'arbiter-b', 'the peer name rides through');
  assert.equal(r.already_recorded, false, 'this peer was not recorded before');

  const rec = a.edges.get(r.peer_instance_id!);
  assert.ok(rec, 'the local edge record exists for the peer');
  assert.equal(rec.peer_public_key, b.identity.publicKeyB64url, 'the stored key is the peer REAL ed25519 public key');
  assert.equal(rec.direction, 'i_control', 'direction is from the local side perspective');
  assert.ok(Number.isFinite(rec.created_at), 'the record carries a creation timestamp');

  // The private half never appears in this machine's edge file, and the
  // file keeps the 0600 posture (pairing.md D2).
  const raw = readFileSync(a.edges.file, 'utf8');
  assert.ok(!raw.includes(b.identity.privateKeyB64url), 'no peer private key in the edge file');
  assert.equal(statSync(a.edges.file).mode & 0o777, 0o600, 'the edge file is 0600');

  await closeFleet();
});

test('slice 10: pairing flips the D8 denial on the right side, and never implies the reverse', async () => {
  const dir = join(TMP, 'a2');
  const port = await bootFleet(join(dir, 'fleet.db'));
  const a = arbiterSide(dir, port, await mintToken(port), 'arbiter-a2');
  const b = arbiterSide(dir, port, await mintToken(port), 'arbiter-b2');

  assert.equal(a.edges.list().length, 0, 'precondition: an unpaired arbiter holds no edges (D8 fail-closed)');

  const r = await a.pairing.pairWithCode((await b.pairing.mintCodeForPeer())!.code);
  assert.equal(r.ok, true);
  assert.equal(a.edges.allows(r.peer_instance_id!, 'i_control'), true, 'A may control B');
  assert.equal(a.edges.allows(r.peer_instance_id!, 'controls_me'), false, 'the reverse is NOT implied (directional, D5)');
  assert.equal(b.edges.list().length, 0, 'minting alone writes nothing on the minter side');

  await closeFleet();
});

test('slice 10: the CONTROLLED end gets controls_me from the roster pull (both ends, opposite directions)', async () => {
  const dir = join(TMP, 'a3');
  const port = await bootFleet(join(dir, 'fleet.db'));
  const a = arbiterSide(dir, port, await mintToken(port), 'arbiter-a3');
  const b = arbiterSide(dir, port, await mintToken(port), 'arbiter-b3');

  const r = await a.pairing.pairWithCode((await b.pairing.mintCodeForPeer())!.code);
  assert.equal(r.ok, true);
  const aFleetId = await a.pairing.localFleetInstanceId();
  assert.ok(aFleetId, 'A is enrolled, so its fleet id is known');

  // B's own signed roster pull, driven through MeshFederation exactly as
  // server/src/index.ts wires it: the edgeFiller writes B's LOCAL record.
  // The SAME enrollment file the pairing client used: ensureEnrolled is a
  // no-op when the credential is already persisted, so B does not need a
  // second one-time token.
  const bClient = new FleetClient(enrollmentFileOf(join(dir, 'arbiter-b3', 'state.json')), {
    fleet_url: `http://127.0.0.1:${port}`,
    fleet_enrollment_token: 'already-spent',
    name: 'arbiter-b3',
  }, b.identity);
  await bClient.ensureEnrolled();
  const bFleetId = await bClient.ensureEnrolled().then((r) => r.instance_id);
  assert.ok(bFleetId, 'B is enrolled on the fleet');

  const filled: Array<{ peer: string; direction: string; key: string }> = [];
  const mesh = new MeshFederation(
    applyDefaults({
      state_file: join(dir, 'arbiter-b3', 'state.json'),
      fleet_url: `http://127.0.0.1:${port}`,
    }),
    async () => ({ instance_id: 'm-b-mesh', name: 'arbiter-b3', ts: Date.now(), servers: [], queue_depth: 0, sessions: 0, active_leases: 0 }),
    {
      localInstanceId: () => bFleetId,
      edgeFiller: (localId, edge, peerKey, peerName, direction) => {
        const peer = edge.to === localId ? edge.from : edge.to;
        b.edges.upsert({
          peer_instance_id: peer,
          peer_public_key: peerKey,
          ...(peerName ? { peer_name: peerName } : {}),
          direction,
          created_at: Date.now(),
        });
        filled.push({ peer, direction, key: peerKey });
      },
    },
  );
  await mesh.pullRoster(async () => await bClient.signedRoster(), Date.now());

  assert.equal(filled.length, 1, 'the roster carried exactly one edge for B');
  assert.equal(filled[0].peer, aFleetId, 'the B edge points at A');
  assert.equal(filled[0].direction, 'controls_me', 'B is the CONTROLLED end: A controls B (D5)');
  assert.equal(filled[0].key, a.identity.publicKeyB64url, 'B stores A public key');
  assert.equal(b.edges.allows(filled[0].peer, 'controls_me'), true, 'the #39 detail/control routes now admit A on B');

  await closeFleet();
});

test('slice 10: redeeming the same peer twice is idempotent — one record, the first created_at stands', async () => {
  const dir = join(TMP, 'a4');
  const port = await bootFleet(join(dir, 'fleet.db'));
  const a = arbiterSide(dir, port, await mintToken(port), 'arbiter-a4');
  const b = arbiterSide(dir, port, await mintToken(port), 'arbiter-b4');

  const first = await a.pairing.pairWithCode((await b.pairing.mintCodeForPeer())!.code);
  assert.equal(first.ok, true);
  const created = a.edges.get(first.peer_instance_id!)!.created_at;

  // A spent code cannot be redeemed again, so a second ceremony needs a
  // fresh mint. The LOCAL record must not duplicate or rewrite.
  const second = await a.pairing.pairWithCode((await b.pairing.mintCodeForPeer())!.code);
  assert.equal(second.ok, true);
  assert.equal(second.already_recorded, true, 'the store already held this peer');
  const rec = a.edges.get(first.peer_instance_id!)!;
  assert.equal(rec.created_at, created, 'the existing record is not rewritten');
  assert.equal(a.edges.list().length, 1, 'exactly one edge record for one peer');

  await closeFleet();
});

test('slice 10: a used code answers the named code_used and adds nothing', async () => {
  const dir = join(TMP, 'a5');
  const port = await bootFleet(join(dir, 'fleet.db'));
  const a = arbiterSide(dir, port, await mintToken(port), 'arbiter-a5');
  const b = arbiterSide(dir, port, await mintToken(port), 'arbiter-b5');

  const code = (await b.pairing.mintCodeForPeer())!.code;
  assert.equal((await a.pairing.pairWithCode(code)).ok, true);
  const again = await a.pairing.pairWithCode(code);
  assert.equal(again.ok, false, 'a spent code cannot be redeemed again');
  assert.equal(again.error, 'code_used', 'the failure is NAMED, not a bare error');
  assert.equal(a.edges.list().length, 1, 'the failed attempt added no second record');

  await closeFleet();
});

test('slice 10: bad code, self-pair, and empty code are all refused by name with nothing written', async () => {
  const dir = join(TMP, 'a6');
  const port = await bootFleet(join(dir, 'fleet.db'));
  const a = arbiterSide(dir, port, await mintToken(port), 'arbiter-a6');

  const bad = await a.pairing.pairWithCode('not-a-real-code');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_code', 'the service names a bad code');
  assert.equal(a.edges.list().length, 0, 'nothing was written');

  const self = await a.pairing.pairWithCode((await a.pairing.mintCodeForPeer())!.code);
  assert.equal(self.ok, false);
  assert.equal(self.error, 'self_pair', 'an instance cannot pair with itself');
  assert.equal(a.edges.list().length, 0, 'no self-edge was written');

  const empty = await a.pairing.pairWithCode('');
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'invalid_body', 'an empty code is refused before the network');
  assert.equal(a.edges.list().length, 0, 'still nothing written');

  await closeFleet();
});

test('slice 10: a roster row with edges but no urls is kept (a paired machine must not lose its pairing), a row with neither is dropped', () => {
  const rows = sanitizeRoster({
    instances: [
      { instance_id: 'm-paired', name: 'no urls yet', public_key: 'KEY', urls: [], last_seen: null, edges: [{ from: 'm-other', to: 'm-paired' }] },
      { instance_id: 'm-nothing', name: 'nothing usable', public_key: 'KEY', urls: [], last_seen: null, edges: [] },
      { instance_id: 'm-urls', name: 'has urls', public_key: 'KEY', urls: ['http://x:8787'], last_seen: null },
    ],
  });
  const ids = rows.map((r) => r.instance_id);
  assert.ok(ids.includes('m-paired'), 'the edge-only row survives: its pairing must reach the local store');
  assert.ok(!ids.includes('m-nothing'), 'a row with neither urls nor edges is dropped (the slice 9 rule stands)');
  assert.ok(ids.includes('m-urls'), 'a url row is unchanged');
});

test('slice 10: no fleet config means pairing is inert (named denial, edge store untouched, no crash)', async () => {
  const dir = join(TMP, 'a7');
  const identity = Identity.loadOrCreate(join(dir, 'identity.json'));
  const edges = new EdgeStore(join(dir, 'mesh_edges.json'));
  const pairing = new PairingClient(applyDefaults({ state_file: join(dir, 'state.json') }), identity, edges);

  assert.equal(pairing.configured, false, 'no fleet_url = no pairing surface');
  assert.equal(await pairing.mintCodeForPeer(), null, 'the mint is a no-op');
  const r = await pairing.pairWithCode('abc');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'fleet_not_configured', 'the denial is NAMED so the operator can act');
  assert.equal(edges.list().length, 0, 'the edge store is untouched');
  assert.equal(await pairing.unpairOnService('m-a', 'm-b'), false, 'the service call is a no-op');
});

test('slice 10: an unreachable fleet service returns a named error and never throws', async () => {
  const dir = join(TMP, 'a8');
  const identity = Identity.loadOrCreate(join(dir, 'identity.json'));
  const edges = new EdgeStore(join(dir, 'mesh_edges.json'));
  const pairing = new PairingClient(
    applyDefaults({
      state_file: join(dir, 'state.json'),
      fleet_url: 'http://127.0.0.1:59999',
      fleet_instance_id: 'declared-seam',
      fleet_enrollment_token: 'a-token',
    }),
    identity,
    edges,
  );
  const r = await pairing.pairWithCode('abc');
  assert.equal(r.ok, false, 'the redeem failed without throwing');
  assert.ok(r.error && r.error.length > 0, 'the transport failure is named');
  assert.equal(edges.list().length, 0, 'no record written on a transport failure');
  assert.equal(await pairing.mintCodeForPeer(), null, 'the mint is a quiet null too');
});

test('slice 10: unpairOnService removes the edge from the directory, so the next pull cannot re-fill a deleted record', async () => {
  const dir = join(TMP, 'a9');
  const port = await bootFleet(join(dir, 'fleet.db'));
  const a = arbiterSide(dir, port, await mintToken(port), 'arbiter-a9');
  const b = arbiterSide(dir, port, await mintToken(port), 'arbiter-b9');

  const r = await a.pairing.pairWithCode((await b.pairing.mintCodeForPeer())!.code);
  assert.equal(r.ok, true);
  const peer = r.peer_instance_id!;
  const localId = await a.pairing.localFleetInstanceId();
  assert.ok(localId, 'the redeem enrolled this machine, so the fleet id is known');

  // Root cause the slice fixes: the operator deleted the LOCAL record, but
  // the fleet directory still carries the edge, so the next roster pull
  // would re-create it. Removing the edge on the service side stops that.
  assert.equal(a.edges.get(peer) !== null, true, 'precondition: the local record exists');
  a.edges.remove(peer);
  assert.equal(a.edges.get(peer), null, 'the operator revoked it locally');

  const removed = await a.pairing.unpairOnService(localId!, peer);
  assert.equal(removed, true, 'the directory dropped the directed edge');

  const roster = (await a.pairing.rosterSnapshot()) as {
    instances: Array<{ instance_id: string; edges: Array<{ from: string; to: string }> }>;
  } | null;
  const remainingEdges = (roster?.instances ?? []).flatMap((row) => row.edges);
  assert.equal(remainingEdges.length, 0, 'the revoked edge is gone from both roster rows');

  await closeFleet();
});
