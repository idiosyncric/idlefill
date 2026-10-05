#!/usr/bin/env node
/**
 * idlefill control CLI — operator controls for the arbiter.
 *
 *   node scripts/idlefill-control.mjs clients
 *   node scripts/idlefill-control.mjs pause  <client> [--for 30m]
 *   node scripts/idlefill-control.mjs force  <client> [--for 30m]
 *   node scripts/idlefill-control.mjs clear  <client>
 *
 *   node scripts/idlefill-control.mjs projects
 *   node scripts/idlefill-control.mjs project <name> set [--idle N] [--max N] [--ttl N]
 *   node scripts/idlefill-control.mjs project <name> clear
 *
 *   node scripts/idlefill-control.mjs servers
 *   node scripts/idlefill-control.mjs server add <name> <url> [--models a,b,c] [--peers p1,p2]
 *   node scripts/idlefill-control.mjs server set <id> [--name N] [--url U] [--models a,b] [--peers p1]
 *
 * <client> may be a client name or a client_id.
 * pause  — the arbiter refuses NEW leases for that client (active leases
 *          keep running; nothing is revoked).
 * force  — the arbiter grants this client a lease even while the box is
 *          busy (still blocked by: degraded signal, max-concurrent, project
 *          pause, daily budget).
 * --for  — auto-expire the override (90s / 30m / 2h); default: until cleared.
 * project set — per-project grant knobs (idle Ns / max N at a time /
 *               auto-cancel after Ns); each flag is optional and independent.
 * project clear — drop ALL per-project overrides (inherit the globals).
 * servers    — the declared inference-server inventory (the arbiter watches
 *              one feed; extra rows are where a future multi-feed core will
 *              point the watcher).
 *
 * Auth: reads the arbiter token AT RUNTIME from the gitignored config
 * (IDLEFILL_CONFIG / IDLEFILL_CLIENT_CONFIG env, else server/config.json,
 * else client/config.json). The token never appears on the command line.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv[0];

function fail(msg) {
  console.error(`idlefill-control: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Token + server URL resolution (gitignored configs, env first).
// ---------------------------------------------------------------------------

function readJsonConfig(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function resolveAuth() {
  // Client config: single `token` + `server_url`.
  const clientCand =
    (process.env.IDLEFILL_CLIENT_CONFIG && JSON.parse(process.env.IDLEFILL_CLIENT_CONFIG)) ??
    readJsonConfig(join(repoRoot, 'client', 'config.json')) ??
    readJsonConfig(join(repoRoot, 'client', 'config.client.json'));
  if (clientCand && typeof clientCand.token === 'string' && clientCand.token && !clientCand.token.startsWith('REPLACE_WITH')) {
    return {
      token: clientCand.token,
      serverUrl: typeof clientCand.server_url === 'string' ? clientCand.server_url : 'http://127.0.0.1:8787',
    };
  }
  // Server config: `api_tokens` array (first entry).
  const serverCand =
    (process.env.IDLEFILL_CONFIG && JSON.parse(process.env.IDLEFILL_CONFIG)) ??
    readJsonConfig(join(repoRoot, 'server', 'config.json'));
  if (serverCand && Array.isArray(serverCand.api_tokens) && serverCand.api_tokens.length > 0) {
    return {
      token: serverCand.api_tokens[0],
      serverUrl: `http://127.0.0.1:${serverCand.listen ?? 8787}`,
    };
  }
  fail('no usable config: set IDLEFILL_CLIENT_CONFIG / IDLEFILL_CONFIG, or create client/config.json (token) or server/config.json (api_tokens)');
}

// ---------------------------------------------------------------------------
// --for parsing: 90s / 30m / 2h / 1d (relative), or epoch ms (absolute).
// ---------------------------------------------------------------------------

function parseFor(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d+)([smhd])$/);
  if (m) {
    const n = Number(m[1]);
    const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
    return Date.now() + n * mult;
  }
  if (/^\d{12,}$/.test(value)) return Number(value); // epoch ms
  fail(`bad --for value "${value}" (use e.g. 90s, 30m, 2h, 1d)`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const { token, serverUrl } = resolveAuth();
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function api(method, path, body) {
  const res = await fetch(serverUrl + path, {
    method,
    headers: auth,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((err) => fail(`cannot reach arbiter at ${serverUrl} (${err.message})`));
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  const detail = (json?.error ?? json?.reason ?? text) || 'no detail';
  if (!res.ok) fail(`${method} ${path} → HTTP ${res.status}: ${detail}`);
  return json ?? {};
}

const usage = () =>
  fail(
    'usage: idlefill-control.mjs clients | pause <client> [--for 30m] | force <client> [--for 30m] | clear <client> ' +
      '| projects | project <name> set [--idle N] [--max N] [--ttl N] | project <name> clear ' +
      '| servers | server add <name> <url> [--models a,b] [--peers p1] [--auth TOKEN] | server set <id> [--name N] [--url U] [--models a,b] [--peers p1] [--auth TOKEN | --auth-clear]',
  );

if (cmd === 'clients') {
  const st = await api('GET', '/api/state');
  if (!st.clients?.length) {
    console.log('no clients registered');
    process.exit(0);
  }
  for (const c of st.clients) {
    const ov = c.override
      ? `${c.override.override}${c.override.until ? ` until ${new Date(c.override.until).toISOString().slice(11, 16)}Z` : ''}`
      : '—';
    console.log(`${c.name}\t${c.client_id}\t${c.ip}\t${ov}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Project-level grant knobs + the declared inference-server inventory.
// (These take a project name / server id as their target, NOT a client.)
// ---------------------------------------------------------------------------

const listCsv = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : undefined);

if (cmd === 'projects' || cmd === 'project') {
  const st = await api('GET', '/api/state');
  const printProj = (p) => {
    const s = p.scheduling ?? {};
    const o = s.overrides ?? {};
    const mark = (v, g) => (v != null ? `${v} (global ${g})` : `— (global ${g})`);
    console.log(`${p.name}${p.paused ? ' [paused]' : ''}  cap ${p.daily_token_cap === Number.MAX_SAFE_INTEGER ? '∞' : p.daily_token_cap}`);
    console.log(`  idle ≥${s.idle_seconds}s   max ${s.max_concurrent_leases} at a time   auto-cancel after ${s.lease_ttl_seconds}s`);
    console.log(`  overrides: idle ${mark(o.idle_seconds, st.idle?.idle_seconds ?? '—')} · max ${mark(o.max_concurrent_leases, 'global')} · ttl ${mark(o.lease_ttl_seconds, 'global')}`);
  };
  if (cmd === 'projects') {
    if (!st.projects?.length) console.log('no projects configured');
    for (const p of st.projects ?? []) printProj(p);
    process.exit(0);
  }
  const name = argv[1];
  const sub = argv[2];
  const numFlag = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const n = Number(argv[i + 1]);
    if (!Number.isFinite(n) || n <= 0) fail(`bad ${flag} value "${argv[i + 1]}" (positive number)`);
    return n;
  };
  if (sub === 'set') {
    const body = {
      idle_seconds: numFlag('--idle') ?? null,
      max_concurrent_leases: numFlag('--max') ?? null,
      lease_ttl_seconds: numFlag('--ttl') ?? null,
    };
    const res = await api('POST', `/api/projects/${encodeURIComponent(name)}/settings`, body);
    console.log(`ok: ${res.name} → ${JSON.stringify(res.overrides)} (null = inherits the global)`);
    process.exit(0);
  }
  if (sub === 'clear') {
    const res = await api('POST', `/api/projects/${encodeURIComponent(name)}/settings`, {
      idle_seconds: null,
      max_concurrent_leases: null,
      lease_ttl_seconds: null,
    });
    console.log(`ok: ${res.name} → overrides cleared (inheriting the globals)`);
    process.exit(0);
  }
  usage();
}

if (cmd === 'servers' || cmd === 'server') {
  const servers = (await api('GET', '/api/servers')).servers ?? [];
  const printServer = (s) => {
    console.log(`${s.id}  ${s.watched ? '[watched]' : '[declared]'}  ${s.name}  ${s.url}  ${s.activity_path}${s.auth_set ? '  key:set' : ''}`);
    console.log(`  models: ${s.models.length ? s.models.map((m) => `${m.name}${m.running ? ' (running)' : ''}${m.queued ? ` (${m.queued} queued)` : ''}`).join(', ') : '—'}`);
    if (s.peers?.length) console.log(`  peers (routed behind this entry point): ${s.peers.join(', ')}`);
  };
  if (cmd === 'servers') {
    if (!servers.length) console.log('no servers declared');
    for (const s of servers) printServer(s);
    process.exit(0);
  }
  const sub = argv[1];
  const nameOrId = argv[2];
  const strFlag = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  // Boolean flag presence (no value consumed) — for --auth-clear.
  const hasFlag = (flag) => argv.includes(flag);
  if (sub === 'add') {
    const url = argv[3];
    if (!nameOrId || !url) usage();
    const res = await api('POST', '/api/servers', {
      name: nameOrId,
      url,
      ...(strFlag('--auth') !== undefined ? { auth_token: strFlag('--auth') } : {}),
      models: listCsv(strFlag('--models')),
      peers: listCsv(strFlag('--peers')),
    });
    console.log(`ok: added ${res.server.id} (${res.server.name}) — declared inventory; the arbiter keeps watching its configured feed`);
    process.exit(0);
  }
  if (sub === 'set') {
    if (!nameOrId) usage();
    const res = await api('POST', '/api/servers', {
      id: nameOrId,
      name: strFlag('--name'),
      url: strFlag('--url'),
      // --auth TOKEN sets the per-server credential; --auth-clear sends the
      // empty sentinel that removes it. Neither flag = the stored key stays
      // (the API never echoes it back, so it cannot be round-tripped).
      ...(hasFlag('--auth-clear') ? { auth_token: '' } : strFlag('--auth') !== undefined ? { auth_token: strFlag('--auth') } : {}),
      models: listCsv(strFlag('--models')),
      peers: listCsv(strFlag('--peers')),
    });
    console.log(`ok: updated ${res.server.id} (${res.server.name})${res.server.auth_set ? ' (API key stored)' : ''}`);
    process.exit(0);
  }
  usage();
}

const target = argv[1];
const forIdx = argv.indexOf('--for');
const forVal = forIdx !== -1 ? argv[forIdx + 1] : undefined;
if (!target) usage();

if (cmd === 'pause' || cmd === 'force') {
  const res = await api('POST', `/api/clients/${encodeURIComponent(target)}/override`, {
    override: cmd,
    until: parseFor(forVal),
  });
  console.log(`ok: ${res.client} → ${cmd}${res.override?.until ? ` until ${new Date(res.override.until).toISOString()}` : ' (until cleared)'}`);
  process.exit(0);
}

if (cmd === 'clear') {
  const res = await api('POST', `/api/clients/${encodeURIComponent(target)}/override`, { override: null });
  console.log(`ok: ${res.client} → override cleared`);
  process.exit(0);
}

usage();
