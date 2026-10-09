/**
 * Verify the #52 slice-4 root cause end to end: a strata row created WITHOUT a
 * credential, then given one, must start sending it on the NEXT tick.
 *
 * Real arbiter entry, real stub engine, real HTTP. Nothing on :8787 touched.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_TOKEN = 'stub-strata-key';
// Scratch ports, never the arbiter on 8787.
const ENGINE_PORT = 8799;
const ARB_PORT = 8798;

// --- the stub engine: /metrics answers 401 without the bearer, JSON with it ---
const engine = createServer((req, res) => {
  if (req.url !== '/metrics') { res.writeHead(404); return res.end('{}'); }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${TEST_TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'missing or wrong API key' } }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ live: { state: 'generating' } }));
});
engine.listen(ENGINE_PORT, '127.0.0.1');

const dir = mkdtempSync(join(tmpdir(), 'idlefill-52-cache-'));
const stateFile = join(dir, 'state.json');
const config = {
  listen: ARB_PORT,
  state_file: stateFile,
  api_tokens: ['scratch-admin'],
  poll_ms: 1000,
};
writeFileSync(join(dir, 'config.json'), JSON.stringify(config));

const proc = spawn('node_modules/.bin/tsx', ['server/src/index.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: 'test', IDLEFILL_CONFIG: JSON.stringify(config) },
  stdio: 'inherit',
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (path: string) => {
  const r = await fetch(`http://127.0.0.1:${ARB_PORT}${path}`, { headers: { authorization: `Bearer scratch-admin` } });
  return { status: r.status, body: await r.json() };
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(`http://127.0.0.1:${ARB_PORT}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer scratch-admin`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

(async () => {
  // The entry writes its banner as soon as it listens. Wait for a real
  // connection before the first call — the spawn is not instantaneous.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${ARB_PORT}/healthz`, { signal: new AbortController().signal });
      if (r.ok) break;
    } catch { /* not up yet */ }
    await sleep(500);
  }

  const created = await post('/api/servers', { name: 'stub strata', provider: 'strata', url: `http://127.0.0.1:${ENGINE_PORT}` });
  const rowId = created.body?.server?.id;
  console.log('row created:', created.status, rowId);
  await sleep(4000);

  const before = await get('/api/state');
  const rowBefore = (before.body.servers || []).find((s: any) => s.id === rowId);
  console.log('PHASE 1 — row created with NO credential');
  console.log('  signal keys :', Object.keys(rowBefore?.signal || {}).filter((k) => k.startsWith('load')).join(', ') || '(none)');
  console.log('  load_busy   :', rowBefore?.signal?.load_busy ?? 'absent (unknown)');
  console.log('  fail reason :', rowBefore?.signal?.load_fail_reason ?? 'none');

  const up = await post('/api/servers', { id: rowId, auth_token: TEST_TOKEN });
  console.log('PHASE 2 — operator sets auth_token on the row:', up.status);

  await sleep(4000);

  const after = await get('/api/state');
  const rowAfter = (after.body.servers || []).find((s: any) => s.id === rowId);
  console.log('PHASE 3 — after one poll tick, the SAME row');
  console.log('  load_source :', rowAfter?.signal?.load_source ?? 'absent');
  console.log('  live state  :', rowAfter?.signal?.strata_live_state ?? rowAfter?.signal?.live_state ?? 'absent');
  console.log('  load_busy   :', rowAfter?.signal?.load_busy ?? 'absent');
  console.log('  fail reason :', rowAfter?.signal?.load_fail_reason ?? 'none');
  console.log('  verdict idle:', rowAfter?.signal?.idle);

  console.log('');
  console.log('VERDICT:', rowAfter?.signal?.load_source === 'strata-metrics' && rowAfter?.signal?.load_busy === true
    ? 'PASS — the credential the operator set later now rides the load read, and the D4 predicate fired'
    : 'FAIL — the collector did not rebuild on the credential change');

  proc.kill('SIGTERM');
  engine.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})();
