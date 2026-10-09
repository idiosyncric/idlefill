/**
 * Live proof for #55 slice 9: a fleet roster row carrying live urls makes that
 * instance a pullable peer with NO mesh_peers config.
 *
 * Real fleet service (fleet/src/index.ts `start`) on a loopback port. Real
 * arbiter entry (server/src/index.ts) as a child process, running its own poll
 * tick. The peer instance is a real HTTP stub serving /api/mesh. The arbiter on
 * :8787 is never touched.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start as startFleet } from '../fleet/src/index.js';
import { FleetClient } from '../server/src/fleet-client.js';
import { Identity } from '../server/src/identity.js';

const FLEET_PORT = 8901;
const ARB_PORT = 8900;
const PEER_PORT = 8902;
const PEER_URL = `http://127.0.0.1:${PEER_PORT}`;

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-55-roster-'));

  // --- the peer instance: a real HTTP stub that answers GET /api/mesh ---
  // Distinct directory: identityFileOf() strips the basename and uses
  // `identity.json` next to the state file, so a peer identity in the SAME
  // directory as the arbiter's state file would resolve to the same file —
  // and the two instances would share one keypair.
  const peerIdentity = Identity.loadOrCreate(join(dir, 'peer/identity.json'));
  const peer = createServer((req, res) => {
    if (req.url !== '/api/mesh') { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      instance_id: 'm-laptop',
      name: 'laptop arbiter',
      ts: Date.now(),
      servers: [{ name: 'llama-swap', idle: false, idle_for_s: null, degraded: false }],
      queue_depth: 3,
      sessions: 2,
      active_leases: 1,
      public_key: peerIdentity.publicKeyB64url,
    }));
  });
  peer.listen(PEER_PORT, '127.0.0.1');

  // --- the real fleet service ---
  const fleet = await startFleet(FLEET_PORT, { dbFile: join(dir, 'fleet.db') });
  console.log(`fleet service up on :${FLEET_PORT}`);

  const mint = async (): Promise<string> => {
    const r = await fetch(`http://127.0.0.1:${FLEET_PORT}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return String((await r.json()).token);
  };
  const tokenPeer = await mint();
  const tokenArb = await mint();

  // The peer instance enrolls and heartbeats its live url.
  const peerClient = new FleetClient(join(dir, 'peer-enroll.json'), {
    fleet_url: `http://127.0.0.1:${FLEET_PORT}`,
    fleet_enrollment_token: await tokenPeer,
    name: 'laptop arbiter',
  }, peerIdentity);
  const enr = await peerClient.ensureEnrolled();
  console.log('peer instance enrolled:', enr.ok, enr.instance_id);
  const hb = await peerClient.heartbeatOnce([PEER_URL], 'online');
  console.log('peer heartbeat:', JSON.stringify(hb));

  // --- the real arbiter entry: NO mesh_peers, fleet_url only ---
  const arb = spawn('node_modules/.bin/tsx', ['server/src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      IDLEFILL_CONFIG: JSON.stringify({
        listen: ARB_PORT,
        state_file: join(dir, 'state.json'),
        api_tokens: ['scratch-admin'],
        poll_ms: 1000,
        fleet_roster_pull_ms: 1000,
        fleet_url: `http://127.0.0.1:${FLEET_PORT}`,
        fleet_instance_id: 'declared-seam',
        fleet_enrollment_token: await tokenArb,
        fleet_own_urls: [`http://127.0.0.1:${ARB_PORT}`],
        mesh_name: 'home-arbiter',
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  arb.stderr.on('data', (c) => process.stderr.write('[arb] ' + c));

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { await fetch(`http://127.0.0.1:${ARB_PORT}/api/mesh`, { signal: AbortSignal.timeout(2000) }); up = true; } catch {}
  }
  console.log('arbiter entry up:', up, '(no mesh_peers configured)');
  await new Promise((r) => setTimeout(r, 8000));

  // What the fleet actually holds (read in-process, same signed path).
  console.log('fleet roster as the service sees it:', JSON.stringify(await peerClient.signedRoster()));
  const st = await fetch(`http://127.0.0.1:${ARB_PORT}/api/state`, { headers: { authorization: 'Bearer scratch-admin' } });
  const body = await st.json();
  const stateRaw = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  console.log('arbiter effective fleet keys:', JSON.stringify({
    fleet_url: stateRaw.config?.fleet_url,
    fleet_instance_id: stateRaw.config?.fleet_instance_id,
    fleet_roster_pull_ms: stateRaw.config?.fleet_roster_pull_ms,
    fleet_own_urls: stateRaw.config?.fleet_own_urls,
    mesh_peers: stateRaw.config?.mesh_peers,
  }));
  console.log('\nGET /api/state -> mesh.peers:');
  console.log(JSON.stringify(body.mesh, null, 2));

  const peers = body.mesh?.peers || [];
  const found = peers.find((p: any) => p.instance_id === 'm-laptop');
  console.log('\nVERDICT:', found && found.online
    ? `PASS — the roster row made ${PEER_URL} a pullable peer with no mesh_peers config; snapshot queue_depth=${found.snapshot?.queue_depth}`
    : 'FAIL — the peer did not resolve from the roster urls');

  arb.kill('SIGKILL');
  peer.close();
  await fleet.app.close();
  await new Promise((r) => setTimeout(r, 400));
  rmSync(dir, { recursive: true, force: true });
  process.exit(found && found.online ? 0 : 1);
})();
