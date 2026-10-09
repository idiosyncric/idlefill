/**
 * Live proof for #55 slice 8. The fleet service runs as a REAL HTTP server
 * (fleet/src/index.ts `start`) on a loopback port. The arbiter runs as a REAL
 * child process (server/src/index.ts), with its own poll tick. The proof
 * kills both children before it exits.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { start as startFleet } from '../fleet/src/index.js';
import { buildHeartbeatSender } from '../server/src/mesh.js';
import { applyDefaults } from '../server/src/config.js';
import { Identity } from '../server/src/identity.js';
import { enrollmentFileOf, loadEnrollment } from '../server/src/fleet-client.js';

const ARB_PORT = 8905;
const OWN_URL = 'http://100.64.0.9:8787';

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-55-hb-'));
  const stateFile = join(dir, 'state.json');
  const dbFile = join(dir, 'fleet.db');

  // Real fleet service, real HTTP, ephemeral port.
  const fleet = await startFleet(0, { dbFile });
  const fleetPort = fleet.port;
  console.log(`real fleet service on :${fleetPort}`);

  const mint = await fetch(`http://127.0.0.1:${fleetPort}/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const token = (await mint.json()).token;
  console.log('enrollment token minted:', mint.status);

  // PART A: what the shipped config layer actually applies (no network here).
  const identity = Identity.loadOrCreate(stateFile);
  const cfg = applyDefaults({
    listen: ARB_PORT,
    state_file: stateFile,
    api_tokens: ['x'],
    fleet_url: `http://127.0.0.1:${fleetPort}`,
    fleet_instance_id: 'declared-seam',
    fleet_enrollment_token: token,
    fleet_own_urls: [OWN_URL],
    mesh_name: 'home-arbiter',
  });
  console.log('cadence applyDefaults yields:', cfg.fleet_heartbeat_ms, 'ms (the PROPOSED default)');
  console.log('own urls applyDefaults yields:', cfg.fleet_own_urls);
  // No heartbeat is sent here. Every heartbeat in the DB below comes from the
  // arbiter child's own poll tick.

  // PART B: the real arbiter entry, its real poll tick, real HTTP.
  const arb = spawn('node_modules/.bin/tsx', ['server/src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      IDLEFILL_CONFIG: JSON.stringify({
        listen: ARB_PORT,
        state_file: stateFile,
        api_tokens: ['scratch-admin'],
        poll_ms: 1000,
        fleet_url: `http://127.0.0.1:${fleetPort}`,
        fleet_instance_id: 'declared-seam',
        fleet_enrollment_token: token,
        fleet_own_urls: [OWN_URL],
        fleet_heartbeat_ms: 2000,
        mesh_name: 'home-arbiter',
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  arb.stdout.on('data', (c) => process.stdout.write('[arb] ' + c));
  arb.stderr.on('data', (c) => process.stdout.write('[arb] ' + c));
  arb.on('exit', (code, sig) => process.stdout.write(`[arb] exit code=${code} signal=${sig}\n`));

  let arbUp = false;
  let lastErr = '';
  for (let i = 0; i < 60 && !arbUp; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await fetch(`http://127.0.0.1:${ARB_PORT}/api/mesh`, { signal: AbortSignal.timeout(2000) });
      arbUp = true;
    } catch (e) { lastErr = (e as Error).message; }
  }
  console.log('arbiter entry up:', arbUp, arbUp ? '' : `(last probe: ${lastErr})`);

  await new Promise((r) => setTimeout(r, 15000));

  const db = new DatabaseSync(dbFile);
  const rows = db.prepare('SELECT instance_id, name, urls, presence, last_seen FROM instances').all();
  const nonces = db.prepare('SELECT COUNT(*) AS n FROM nonces').get()?.n ?? 0;
  db.close();
  console.log('enrollment file the child wrote:', existsSync(enrollmentFileOf(stateFile)));
  console.log('child enrollment record:', JSON.stringify(loadEnrollment(enrollmentFileOf(stateFile))));

  console.log('\nfleet DB rows after the arbiter tick:');
  console.log(JSON.stringify(rows, null, 2));
  console.log('single-use nonces consumed:', nonces);

  const row = rows.find((r: any) => typeof r.urls === 'string' && r.urls.includes(OWN_URL));
  console.log('\nVERDICT:', row
    ? `PASS — the roster row carries urls ${row.urls}, presence ${row.presence}, last_seen ${row.last_seen}`
    : 'FAIL — no heartbeat urls on the row');

  arb.kill('SIGKILL');
  await fleet.app.close();
  await new Promise((r) => setTimeout(r, 400));
  rmSync(dir, { recursive: true, force: true });
  process.exit(row ? 0 : 1);
})();
