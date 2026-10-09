/**
 * Live proof for #39 enforcement half — drives the REAL shipped entry
 * (server/src/index.ts) on a scratch loopback port with a temp state file.
 * No mocks: real ed25519 crypto (node:crypto), real HTTP, the actual route
 * table. Does NOT touch the running arbiter on :8787 (scratch port 8791 +
 * scratch state/identity files under a temp dir).
 */
import { spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = process.argv[2] || process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'idlefill-39d-live-'));
const stateFile = join(dir, 'state.json');
const edgesFile = join(dir, 'mesh_edges.json');
const ADMIN = 'scratch-admin';
const PEER = 'scratch-peer';

// --- Mint the PAIRED controller keypair (the #55 D1 substrate). ---
const { publicKey: pubDer, privateKey: privDer } = generateKeyPairSync('ed25519');
const pubB64url = pubDer.export({ type: 'spki', format: 'der' }).toString('base64url');
const controllerId = 'live-controller';
// A stranger keypair: valid signatures, but NO edge record → D8 denial.
const stranger = generateKeyPairSync('ed25519');
const strangerId = 'live-stranger';

// --- Seed the local edge record (the D2 file the relay reads). ---
// direction 'controls_me' from the TARGET's perspective: the controller is
// authorized to control THIS machine. This is exactly what the #55 D4
// ceremony writes; the enforcement plane is ceremony-agnostic.
writeFileSync(
  edgesFile,
  JSON.stringify(
    { v: 1, edges: [{ peer_instance_id: controllerId, peer_public_key: pubB64url, peer_name: 'controller-box', direction: 'controls_me', created_at: Date.now() }] },
    null,
    2,
  ),
  { mode: 0o600 },
);

const cfg = {
  listen: PORT,
  api_tokens: [ADMIN],
  peer_token: PEER,
  llama_swap_url: 'http://127.0.0.1:9', // unreachable: the tick's feed fetch fails + is caught
  activity_path: '', // feed-off: no real fetch, no degraded signal
  server_name: 'scratch',
  server_models: ['Qwen3.8-27B'],
  server_peers: [],
  mesh_peers: [], // no roster, no peers: the mesh plane is inert
  log_glob: '',
  idle_seconds: 300,
  poll_ms: 3_600_000, // the tick loop effectively sleeps; boot's first tick is enough
  projects: [{ name: 'career-ops', paused: false, daily_token_cap: 10_000 }],
  state_file: stateFile,
  mesh_name: 'scratch-target',
  // no fleet_url → no roster pull, no edge fill (the seeded edge stands).
};

// --- Sign a canonical {instance_id, path, ts, nonce} payload. ---
function signHeaders(id, path, ts, nonce, priv) {
  const body = Buffer.from(JSON.stringify({ instance_id: id, path, ts, nonce }));
  const sig = sign(null, body, priv);
  return {
    'x-idlefill-instance-id': id,
    'x-idlefill-signature': Buffer.from(sig).toString('base64url'),
    'x-idlefill-nonce': nonce,
    'x-idlefill-ts': String(ts),
  };
}
let n = 0;
const nonce = () => `live-nonce-${++n}-${Math.random().toString(36).slice(2, 8)}`;
const now = () => Date.now();

async function call(method, path, headers, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, json, text };
}

const line = (label, x) => console.log(`\n===== ${label} =====\n${typeof x === 'string' ? x : JSON.stringify(x, null, 2)}`);

// --- Launch the REAL entry. ---
const child = spawn(process.execPath, ['--import', 'tsx', join(CWD, 'server', 'src', 'index.ts')], {
  cwd: CWD,
  env: { ...process.env, IDLEFILL_CONFIG: JSON.stringify(cfg), IDLEFILL_STATE: stateFile },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// Never leave the scratch arbiter behind, no matter how this script ends.
const stopChild = () => {
  if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 1500).unref?.();
};
process.on('exit', stopChild);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
let bootLog = '';
child.stdout.on('data', (d) => (bootLog += d.toString()));
child.stderr.on('data', (d) => (bootLog += d.toString()));

// Wait for readiness (coarse plane answers with the peer_token).
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  try {
    const r = await fetch(`${BASE}/api/mesh`, { headers: { authorization: `Bearer ${PEER}` } });
    if (r.status === 200) ready = true;
  } catch {
    /* not up yet */
  }
  if (!ready) await new Promise((r) => setTimeout(r, 500));
}
if (!ready) {
  console.log('BOOT LOG:\n' + bootLog);
  child.kill('SIGTERM');
  process.exit(2);
}
line('boot (ready on :' + PORT + ')', bootLog.trim().split('\n').slice(0, 8).join('\n'));

// Register a real client row with queue DETAIL (job ids + titles) + a raw
// log tail, via the admin plane — so the detail route has real content.
const reg = await call(
  'POST',
  '/api/clients/register',
  { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
  {
    name: 'w-live',
    ip: '10.0.0.7',
    projects: [
      {
        name: 'career-ops',
        model: 'Qwen3.8-27B',
        estimated_seconds: 900,
        queue_depth: 2,
        queue_preview: [
          { job_id: 'job-L1', title: 'Apply to Acme (live)', company: 'Acme', score: 0.9, attempts: 0 },
          { job_id: 'job-L2', title: 'Research Zeta (live)', company: 'Zeta', score: 0.7, attempts: 1 },
        ],
      },
    ],
    client_log: ['RAW-LOG-LIVE-1 executor started', 'RAW-LOG-LIVE-2 tool call ok'],
  },
);
line('register client (admin)', { status: reg.status, body: reg.json });

// 1) No local edge record → 403 with a NAMED reason (D8). A real signature
//    from an UNPAIRED instance — the signature cannot open what pairing never closed.
const s1 = await call('GET', '/api/mesh/detail', signHeaders(strangerId, '/api/mesh/detail', now(), nonce(), stranger.privateKey));
line('1. detail, no edge (stranger) → expect 403 unknown_instance_id', { status: s1.status, body: s1.json });

const s2 = await call('POST', '/api/mesh/control', { 'content-type': 'application/json', ...signHeaders(strangerId, '/api/mesh/control', now(), nonce(), stranger.privateKey) }, { action: 'pause', client: 'w-live' });
line('2. control, no edge (stranger) → expect 403 unknown_instance_id', { status: s2.status, body: s2.json });

// 2) A PAIRED edge record allows the detail read (D3 + D5).
const d1 = await call('GET', '/api/mesh/detail', signHeaders(controllerId, '/api/mesh/detail', now(), nonce(), privDer));
line('3. detail, paired controller → expect 200 (queue detail crosses)', { status: d1.status, body: d1.json });

// 3) A control verb changes ONLY the target's own row.
const c1 = await call('POST', '/api/mesh/control', { 'content-type': 'application/json', ...signHeaders(controllerId, '/api/mesh/control', now(), nonce(), privDer) }, { action: 'pause', client: 'w-live' });
line('4. control pause (paired) → expect 200', { status: c1.status, body: c1.json });
// Confirm the target's state actually changed (admin read).
const st1 = await call('GET', '/api/state', { authorization: `Bearer ${ADMIN}` });
const cl = st1.json?.clients?.find((c) => c.name === 'w-live');
line('5. /api/state after pause (admin) → client row override', { status: st1.status, client_override: cl?.override, raw_log_on_state: st1.text.includes('RAW-LOG-LIVE-1') });

// 4) An unknown verb is rejected (400 bad_action, no state change).
const c2 = await call('POST', '/api/mesh/control', { 'content-type': 'application/json', ...signHeaders(controllerId, '/api/mesh/control', now(), nonce(), privDer) }, { action: 'steal', client: 'w-live' });
line('6. control unknown verb "steal" → expect 400 bad_action', { status: c2.status, body: c2.json });

// 5) Payload-free: the detail projection never carries the raw log tail.
line('7. detail payload-free check', { detail_has_raw_log: d1.text.includes('RAW-LOG-LIVE-1'), detail_has_raw_log_2: d1.text.includes('RAW-LOG-LIVE-2') });

// 6) The coarse plane stays coarse (unpaired surface, zero pairing).
const m1 = await call('GET', '/api/mesh', { authorization: `Bearer ${PEER}` });
line('8. coarse /api/mesh (peer_token) → coarse only', { status: m1.status, coarse_has_job_id: m1.text.includes('job-L1'), coarse_has_title: m1.text.includes('Apply to Acme (live)') });

// Lift the pause (clean up the scratch row) — resume alias.
await call('POST', '/api/mesh/control', { 'content-type': 'application/json', ...signHeaders(controllerId, '/api/mesh/control', now(), nonce(), privDer) }, { action: 'resume', client: 'w-live' });

// --- Stop the scratch process + clean up. ---
child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 300));
if (child.exitCode === null) child.kill('SIGKILL');
rmSync(dir, { recursive: true, force: true });
console.log('\n===== scratch stopped + temp dir cleaned =====');
process.exit(0);
