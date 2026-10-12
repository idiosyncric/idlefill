/**
 * The `idlefill control` group (cli.md D2, issue #88 S1) — a passthrough port
 * of scripts/idlefill-control.mjs: behavior byte-identical (same output, same
 * exit codes, same usage text), auth posture unchanged: the arbiter token is
 * read AT RUNTIME from the gitignored config
 * (IDLEFILL_CONFIG / IDLEFILL_CLIENT_CONFIG env, else server/config.json,
 * else client/config.json) and never appears on the command line (D3).
 * The read commands (clients, projects, servers) additionally answer --json.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jsonPayload } from './json.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fail(msg: string): never {
  console.error(`idlefill-control: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Token + server URL resolution (gitignored configs, env first).
// ---------------------------------------------------------------------------

function readJsonConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function resolveAuth(): { token: string; serverUrl: string } {
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
      token: (serverCand.api_tokens as string[])[0] as string,
      serverUrl: `http://127.0.0.1:${serverCand.listen ?? 8787}`,
    };
  }
  fail('no usable config: set IDLEFILL_CLIENT_CONFIG / IDLEFILL_CONFIG, or create client/config.json (token) or server/config.json (api_tokens)');
}

// ---------------------------------------------------------------------------
// --for parsing: 90s / 30m / 2h / 1d (relative), or epoch ms (absolute).
// ---------------------------------------------------------------------------

function parseFor(value: string | undefined): number | null {
  if (!value) return null;
  const m = String(value).match(/^(\d+)([smhd])$/);
  if (m) {
    const n = Number(m[1]);
    const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
    return Date.now() + n * mult;
  }
  if (/^\d{12,}$/.test(value)) return Number(value); // epoch ms
  fail(`bad --for value "${value}" (use e.g. 90s, 30m, 2h, 1d)`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function runControl(argv: string[], json: boolean): Promise<number> {
  const cmd = argv[0];

  const { token, serverUrl } = resolveAuth();
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function api(method: string, path: string, body?: unknown): Promise<Record<string, any>> {
    const res = await fetch(serverUrl + path, {
      method,
      headers: auth,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((err: Error) => fail(`cannot reach arbiter at ${serverUrl} (${err.message})`));
    const text = await res.text();
    let json_: Record<string, any> | null = null;
    try {
      json_ = JSON.parse(text);
    } catch {
      /* not json */
    }
    const detail = (json_?.error ?? json_?.reason ?? text) || 'no detail';
    if (!res.ok) fail(`${method} ${path} → HTTP ${res.status}: ${detail}`);
    return json_ ?? {};
  }

  function usage(): never {
    fail(
      'usage: idlefill-control.mjs clients | pause <client> [--for 30m] | force <client> [--for 30m] | clear <client> ' +
        '| projects | project <name> set [--idle N] [--max N] [--ttl N] | project <name> clear ' +
        '| servers | server add <name> <url> [--models a,b] [--peers p1] [--auth TOKEN] | server set <id> [--name N] [--url U] [--models a,b] [--peers p1] [--auth TOKEN | --auth-clear]',
    );
  }

  if (cmd === 'clients') {
    const st = await api('GET', '/api/state');
    if (json) {
      console.log(jsonPayload(st.clients ?? []));
      process.exit(0);
    }
    if (!st.clients?.length) {
      console.log('no clients registered');
      process.exit(0);
    }
    for (const c of st.clients as Array<Record<string, any>>) {
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

  const listCsv = (v: string | undefined): string[] | undefined =>
    v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : undefined;

  if (cmd === 'projects' || cmd === 'project') {
    const st = await api('GET', '/api/state');
    const printProj = (p: Record<string, any>): void => {
      const s = p.scheduling ?? {};
      const o = s.overrides ?? {};
      const mk = (v: unknown, g: unknown) => (v != null ? `${v} (global ${g})` : `— (global ${g})`);
      console.log(`${p.name}${p.paused ? ' [paused]' : ''}  cap ${p.daily_token_cap === Number.MAX_SAFE_INTEGER ? '∞' : p.daily_token_cap}`);
      console.log(`  idle ≥${s.idle_seconds}s   max ${s.max_concurrent_leases} at a time   auto-cancel after ${s.lease_ttl_seconds}s`);
      console.log(`  overrides: idle ${mk(o.idle_seconds, st.idle?.idle_seconds ?? '—')} · max ${mk(o.max_concurrent_leases, 'global')} · ttl ${mk(o.lease_ttl_seconds, 'global')}`);
    };
    if (cmd === 'projects') {
      if (json) {
        console.log(jsonPayload(st.projects ?? []));
        process.exit(0);
      }
      if (!st.projects?.length) console.log('no projects configured');
      for (const p of st.projects ?? []) printProj(p);
      process.exit(0);
    }
    const name = argv[1];
    const sub = argv[2];
    const numFlag = (flag: string): number | undefined => {
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
      const res = await api('POST', `/api/projects/${encodeURIComponent(name!)}/settings`, body);
      console.log(`ok: ${res.name} → ${JSON.stringify(res.overrides)} (null = inherits the global)`);
      process.exit(0);
    }
    if (sub === 'clear') {
      const res = await api('POST', `/api/projects/${encodeURIComponent(name!)}/settings`, {
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
    const servers = ((await api('GET', '/api/servers')).servers ?? []) as Array<Record<string, any>>;
    const printServer = (s: Record<string, any>): void => {
      console.log(`${s.id}  ${s.watched ? '[watched]' : '[declared]'}  ${s.name}  ${s.url}  ${s.activity_path}${s.auth_set ? '  key:set' : ''}`);
      console.log(`  models: ${s.models.length ? s.models.map((m: Record<string, any>) => `${m.name}${m.running ? ' (running)' : ''}${m.queued ? ` (${m.queued} queued)` : ''}`).join(', ') : '—'}`);
      if (s.peers?.length) console.log(`  peers (routed behind this entry point): ${s.peers.join(', ')}`);
    };
    if (cmd === 'servers') {
      if (json) {
        console.log(jsonPayload(servers));
        process.exit(0);
      }
      if (!servers.length) console.log('no servers declared');
      for (const s of servers) printServer(s);
      process.exit(0);
    }
    const sub = argv[1];
    const nameOrId = argv[2];
    const strFlag = (flag: string): string | undefined => {
      const i = argv.indexOf(flag);
      return i === -1 ? undefined : argv[i + 1];
    };
    // Boolean flag presence (no value consumed) — for --auth-clear.
    const hasFlag = (flag: string): boolean => argv.includes(flag);
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
    const res = await api('POST', `/api/clients/${encodeURIComponent(target!)}/override`, {
      override: cmd,
      until: parseFor(forVal),
    });
    console.log(`ok: ${res.client} → ${cmd}${res.override?.until ? ` until ${new Date(res.override.until).toISOString()}` : ' (until cleared)'}`);
    process.exit(0);
  }

  if (cmd === 'clear') {
    const res = await api('POST', `/api/clients/${encodeURIComponent(target!)}/override`, { override: null });
    console.log(`ok: ${res.client} → override cleared`);
    process.exit(0);
  }

  usage();
}
