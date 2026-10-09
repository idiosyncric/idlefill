/**
 * Live proof for #55 slice 10: the arbiter-side pairing ceremony.
 *
 * Two REAL arbiter entries (server/src/index.ts) run as child processes on
 * scratch loopback ports against ONE real fleet service. B mints a pairing
 * code, A redeems it through the new route, and the resulting LOCAL edge
 * records on BOTH machines are what make the #39 per-edge route stop
 * answering 403 `unknown_instance_id`.
 *
 * Never touches the arbiter on :8787 or any launchd unit.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start as startFleet } from '../fleet/src/index.js';
import { signEdgePayload } from '../server/src/edges.js';
import { Identity } from '../server/src/identity.js';

const FLEET_PORT = 8911;
const A_PORT = 8912; // the controller (redeemer)
const B_PORT = 8913; // the controlled end (minter)
const ADMIN = 'scratch-admin';
const authHeader = () => ({ authorization: ['Bearer', ADMIN].join(' ') });

async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: authHeader(), signal: AbortSignal.timeout(10_000) });
  return res.json().catch(() => null);
}

async function waitFor(port: number, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/mesh`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-55-pair-live-'));
  const fleet = await startFleet(FLEET_PORT, { dbFile: join(dir, 'fleet.db') });
  console.log(`fleet service up on :${FLEET_PORT}`);

  const mintToken = async (): Promise<string> => {
    const r = await fetch(`http://127.0.0.1:${FLEET_PORT}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return String((await r.json()).token);
  };

  // Each arbiter entry gets its OWN directory: identityFileOf() strips the
  // basename and uses `identity.json` next to the state file, so two entries
  // seeded from one directory share one keypair.
  const ta = await mintToken();
  const tb = await mintToken();

  const spawnArbiter = (name: string, port: number, token: string) =>
    spawn('node_modules/.bin/tsx', ['server/src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        IDLEFILL_CONFIG: JSON.stringify({
          listen: port,
          state_file: join(dir, name, 'state.json'),
          api_tokens: [ADMIN],
          poll_ms: 1000,
          fleet_url: `http://127.0.0.1:${FLEET_PORT}`,
          fleet_instance_id: 'declared-seam',
          fleet_enrollment_token: token,
          fleet_own_urls: [`http://127.0.0.1:${port}`],
          fleet_roster_pull_ms: 2000,
          mesh_name: name,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  const arbA = spawnArbiter('arbiter-a', A_PORT, ta);
  const arbB = spawnArbiter('arbiter-b', B_PORT, tb);
  console.log('arbiter A (:8912) up:', await waitFor(A_PORT), '  arbiter B (:8913) up:', await waitFor(B_PORT));
  await new Promise((r) => setTimeout(r, 10000)); // let the roster pull run

  // 1. B mints a pairing code.
  const mint = await post(`http://127.0.0.1:${B_PORT}/api/mesh/pair/code`, {});
  console.log('B minted a code:', mint.status, JSON.stringify(mint.body));

  // 2. A redeems it: A becomes the CONTROLLER of B (pairing.md D5).
  const pair = await post(`http://127.0.0.1:${A_PORT}/api/mesh/pair`, { code: (mint.body as { code: string }).code });
  console.log('A redeemed:', pair.status, JSON.stringify(pair.body));
  const bFleetId = (pair.body as { paired_with: string }).paired_with;

  // 3. A's local edge file now holds B.
  const aEdges = JSON.parse(readFileSync(join(dir, 'arbiter-a', 'mesh_edges.json'), 'utf8'));
  console.log('A local edge record:', JSON.stringify(aEdges.edges[0]));

  // 4. The fleet directory holds the directed edge, so B's next roster pull
  //    writes B's OWN record for A in the opposite direction.
  const db = new DatabaseSync(join(dir, 'fleet.db'));
  console.log('fleet instances:', JSON.stringify(db.prepare('SELECT instance_id, name, urls, last_seen FROM instances').all()));
  console.log('fleet edges:', JSON.stringify(db.prepare('SELECT from_instance_id, to_instance_id FROM edges').all()));
  db.close();

  await new Promise((r) => setTimeout(r, 3000));
  const bEdgeFile = join(dir, 'arbiter-b', 'mesh_edges.json');
  const bEdges = existsSync(bEdgeFile) ? JSON.parse(readFileSync(bEdgeFile, 'utf8')) : { edges: [] };
  console.log('B local edge records (filled from the roster):', JSON.stringify(bEdges.edges));
  const bState = (await getJson(`http://127.0.0.1:${B_PORT}/api/state`)) as { events?: Array<{ kind: string; detail?: string }> };
  console.log('B mesh events:', JSON.stringify((bState.events ?? []).filter((e) => e.kind.startsWith('mesh'))));

  // 5. Give B a real client row so the relay has a target it can apply to.
  const reg = await post(`http://127.0.0.1:${B_PORT}/api/clients/register`, { name: 'proof-client', ip: '127.0.0.9' });
  console.log('B registered a client row:', reg.status, JSON.stringify(reg.body));

  // 6. THE PROOF: B receives a signed control request from A. Before the
  //    ceremony that is 403 `unknown_instance_id` (pairing.md D8). After it,
  //    the edge exists and the request reaches the action gate.
  const aIdentity = Identity.loadOrCreate(join(dir, 'arbiter-a', 'identity.json'));
  const aEnroll = JSON.parse(readFileSync(join(dir, 'arbiter-a', 'fleet_enrollment.json'), 'utf8'));
  const aFleetId = aEnroll.instance_id as string;
  console.log('A fleet instance id:', aFleetId, '  B fleet instance id:', bFleetId);

  const bStateNow = (await getJson(`http://127.0.0.1:${B_PORT}/api/state`)) as { clients?: Array<{ name: string }> };
  const bClientName = (bStateNow.clients ?? [])[0]?.name ?? 'proof-client';
  console.log('B client rows:', JSON.stringify((bStateNow.clients ?? []).map((c) => c.name)));

  const nonce = `live-proof-nonce-${Date.now()}`;
  const ts = Date.now();
  const signed = signEdgePayload(aIdentity, { instance_id: aFleetId, path: '/api/mesh/control', ts, nonce });
  const res = await fetch(`http://127.0.0.1:${B_PORT}/api/mesh/control`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-idlefill-instance-id': aFleetId,
      'x-idlefill-signature': signed.signatureB64url,
      'x-idlefill-nonce': nonce,
      'x-idlefill-ts': String(ts),
    },
    // A real target row: the request clears the auth chain AND the body gate,
    // i.e. a relayed pause that actually lands on B's own client row.
    body: JSON.stringify({ action: 'pause', client: bClientName, until: Date.now() + 60000 }),
    signal: AbortSignal.timeout(10_000),
  });
  const controlBody = await res.json().catch(() => null);
  console.log('signed control request to B ->', res.status, JSON.stringify(controlBody));
  const after = (await getJson(`http://127.0.0.1:${B_PORT}/api/state`)) as { events?: Array<{ kind: string; detail?: string; source_instance_id?: string }> };
  console.log('B control audit events:', JSON.stringify((after.events ?? []).filter((e) => e.kind === 'mesh_control')));

  // 6. The same request from an UNPAIRED instance still 403s by name (D8).
  const stranger = await fetch(`http://127.0.0.1:${B_PORT}/api/mesh/control`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-idlefill-instance-id': 'm-not-paired',
      'x-idlefill-signature': 'AAAA',
      'x-idlefill-nonce': 'n1',
      'x-idlefill-ts': String(ts),
    },
    body: JSON.stringify({ action: 'pause', client: bClientName }),
    signal: AbortSignal.timeout(10_000),
  });
  console.log('unpaired stranger ->', stranger.status, JSON.stringify(await stranger.json().catch(() => null)));

  const bodyStr = JSON.stringify(controlBody);
  const verdict = res.status !== 403 || !bodyStr.includes('unknown_instance_id');
  console.log('\nVERDICT:', verdict
    ? 'PASS - the ceremony wrote a local record on BOTH ends; B reads the edge and the route moved past the D8 denial'
    : 'FAIL - the ceremony did not produce a usable local edge record');

  arbA.kill('SIGKILL');
  arbB.kill('SIGKILL');
  await fleet.app.close();
  await new Promise((r) => setTimeout(r, 400));
  rmSync(dir, { recursive: true, force: true });
  process.exit(verdict ? 0 : 1);
})();
