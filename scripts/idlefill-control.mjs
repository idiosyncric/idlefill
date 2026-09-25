#!/usr/bin/env node
/**
 * idlefill control CLI — operator overrides for registered clients.
 *
 *   node scripts/idlefill-control.mjs clients
 *   node scripts/idlefill-control.mjs pause  <client> [--for 30m]
 *   node scripts/idlefill-control.mjs force  <client> [--for 30m]
 *   node scripts/idlefill-control.mjs clear  <client>
 *
 * <client> may be a client name or a client_id.
 * pause  — the arbiter refuses NEW leases for that client (active leases
 *          keep running; nothing is revoked).
 * force  — the arbiter grants this client a lease even while the box is
 *          busy (still blocked by: degraded signal, max-concurrent, project
 *          pause, daily budget).
 * --for  — auto-expire the override (90s / 30m / 2h); default: until cleared.
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

const usage = () => fail('usage: idlefill-control.mjs clients | pause <client> [--for 30m] | force <client> [--for 30m] | clear <client>');

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
