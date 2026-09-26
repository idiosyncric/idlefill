/**
 * Live smoke: boot the REAL server (tsx src/index.ts) with IDLEFILL_CONFIG
 * injected (throwaway state file, loopback port), register a worker, and
 * assert the new /api/state shape end-to-end (servers seeded + signal +
 * models, project workers + published stats + effective scheduling, the
 * two new routes). Exits 0/1.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const dirnameOfThisScript = dirname(new URL(import.meta.url).pathname);

const dir = mkdtempSync(join(tmpdir(), 'idlefill-smoke-'));
const TOKEN = 'smoke-token';
const CFG = {
  listen: 18787,
  api_tokens: [TOKEN],
  llama_swap_url: 'http://127.0.0.1:9999',
  activity_path: '/api/metrics/activity',
  server_name: 'llama-swap',
  server_models: ['Qwen3.8-27B'],
  server_peers: ['peer:gpu2'],
  idle_seconds: 300,
  poll_ms: 120_000,
  lease_ttl_seconds: 1800,
  max_concurrent_leases: 2,
  projects: [{ name: 'career-ops', paused: false, daily_token_cap: 100_000 }],
  state_file: join(dir, 'state.json'),
};
const base = `http://127.0.0.1:${CFG.listen}`;
const h = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
let failed = false;
const check = (cond, msg) => {
  if (cond) console.log('  ok  ' + msg);
  else {
    console.error('FAIL  ' + msg);
    failed = true;
  }
};

const child = spawn(
  process.execPath,
  [join(dirnameOfThisScript, 'node_modules/tsx/dist/cli.mjs'), 'src/index.ts'],
  {
    cwd: join(dirnameOfThisScript, 'server'),
    env: { ...process.env, IDLEFILL_CONFIG: JSON.stringify(CFG) },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d));
child.stderr.on('data', (d) => (serverLog += d));

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: h, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const get = (path, opts = {}) => fetch(base + path, opts).then((r) => ({ status: r.status, body: r }));

try {
  // wait for the server to be up (real process; boot includes the first poll
  // against the unreachable fake feed, which is fine — it just degrades)
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const r = await fetch(base + '/api/state');
      up = r.status === 200;
    } catch {
      /* not up yet */
    }
  }
  check(up, 'server booted and serves /api/state');
  if (!up) throw new Error('server never came up\n' + serverLog);

  const st0 = await (await fetch(base + '/api/state')).json();
  check(Array.isArray(st0.servers) && st0.servers.length === 1, 'state.servers: one row seeded from config');
  const s0 = st0.servers[0];
  check(s0.name === 'llama-swap' && s0.watched === true, 'seeded row is the watched feed');
  check(s0.signal !== null && typeof s0.signal === 'object', 'watched row carries the live signal (degraded is fine — fake feed is down)');
  check(Array.isArray(s0.models) && s0.models.length === 1 && s0.models[0].name === 'Qwen3.8-27B' && 'running' in s0.models[0] && 'queued' in s0.models[0], 'models from config, with running/queued');
  check(Array.isArray(s0.peers) && s0.peers.length === 1 && s0.peers[0] === 'peer:gpu2', 'peers from config (display only)');

  // a worker registers with published stats
  const reg = await post('/api/clients/register', {
    name: 'mac-worker',
    ip: '100.94.165.102',
    projects: [
      { name: 'career-ops', model: 'Qwen3.8-27B', estimated_seconds: 900, queue_depth: 3, stats: { finished: 4, failed: 1, last_job: 'job-99', queue: 3 } },
    ],
  });
  check(reg.status === 200, 'register with project stats accepted');

  const st1 = await (await fetch(base + '/api/state?limit=1', { headers: h })).json();
  const p1 = st1.projects.find((p) => p.name === 'career-ops');
  check(p1?.workers?.length === 1 && p1.workers[0].client === 'mac-worker', 'project carries the connected worker');
  check(p1.workers[0].stats?.queue === 3 && p1.workers[0].stats?.finished === 4, 'published stats ride on the worker row (verbatim)');
  check(p1.scheduling?.max_concurrent_leases === 2, 'effective scheduling reflects the global');

  // per-project settings route
  const upd = await post('/api/projects/career-ops/settings', { idle_seconds: 600 });
  check(upd.status === 200 && upd.body?.ok === true && upd.body.overrides.idle_seconds === 600, 'POST /api/projects/:name/settings sets the override');
  const st2 = await (await fetch(base + '/api/state', { headers: h })).json();
  const p2 = st2.projects.find((p) => p.name === 'career-ops');
  check(p2.scheduling.idle_seconds === 600, 'effective idle reflects the override in state');
  check(p2.scheduling.overrides.idle_seconds === 600 && p2.scheduling.overrides.lease_ttl_seconds === null, 'raw overrides exposed (unset = null)');

  // the clear shorthand
  const clr = await post('/api/projects/career-ops/settings', { clear: true });
  check(clr.status === 200 && clr.body?.ok === true && clr.body.overrides.idle_seconds === null, '{clear:true} drops all overrides');

  // pause route still works and survives a settings write
  const pause = await post('/api/projects/career-ops', { paused: true });
  check(pause.status === 200 && pause.body?.paused === true, 'POST /api/projects/:name pauses the project');
  const st4 = await (await fetch(base + '/api/state', { headers: h })).json();
  check(st4.projects.find((p) => p.name === 'career-ops').scheduling.paused === true, 'pause visible in the state view');
  await post('/api/projects/career-ops', { paused: false });

  // server-connection routes
  const add = await post('/api/servers', { name: 'box-two', url: 'http://192.168.9.9:11434', models: ['a'] });
  check(add.status === 200 && add.body?.ok === true && add.body.created === true, 'POST /api/servers adds a declared connection');
  const badUrl = await post('/api/servers', { name: 'x', url: 'nope' });
  check(badUrl.status === 400, 'bad url rejected (400)');
  const dup = await post('/api/servers', { name: 'same', url: CFG.llama_swap_url, activity_path: CFG.activity_path });
  check(dup.status === 400, 'duplicate connection rejected (400)');
  const st3 = await (await fetch(base + '/api/state', { headers: h })).json();
  check(st3.servers.length === 2 && st3.servers[1].watched === false && st3.servers[1].signal === null, 'declared row: inventory, not live');
  const updSrv = await post('/api/servers', { id: add.body.server.id, peers: [] });
  check(updSrv.status === 200 && updSrv.body?.ok === true, 'POST /api/servers by id patches the row');
  const missSrv = await post('/api/servers', { id: 'srv-nope', name: 'x' });
  check(missSrv.status === 404, 'unknown server id rejected (404)');

  // auth: the new routes are token-gated
  const noAuth = await fetch(base + '/api/servers');
  check(noAuth.status === 401, 'GET /api/servers requires a token');

  // the dashboard serves
  const html = await (await fetch(base + '/')).text();
  check(html.includes('Inference servers') && html.includes('Projects') && html.includes('/api/state'), 'dashboard serves the two panes');

  // persistence: the state file carries servers + project rows
  const raw = JSON.parse(readFileSync(CFG.state_file, 'utf8'));
  check(raw.servers?.length === 2, 'state file persisted the server inventory');
  check(Array.isArray(raw.projects) && raw.projects.length === 1 && raw.projects[0].name === 'career-ops', 'state file persisted the project rows');
} catch (err) {
  console.error('FAIL  smoke crashed:', err);
  console.error('--- server log ---\n' + serverLog);
  failed = true;
} finally {
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? 'SMOKE FAILED' : 'SMOKE OK');
process.exit(failed ? 1 : 0);
