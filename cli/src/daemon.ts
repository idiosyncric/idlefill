/**
 * The `idlefill daemon` group (cli.md D2, issue #88 S1) — a passthrough port
 * of scripts/idlefill-daemon.mjs: behavior byte-identical (same output, same
 * exit codes), auth posture unchanged (the arbiter token is read AT RUNTIME
 * from the gitignored client config and never printed). Read commands
 * (status, pids) additionally answer --json (D3).
 *
 * The daemon anchors its log to the ENTRY dir (client/src in dev, client/dist
 * after a build) → <client>/<entry>/logs/client.log.
 *
 * start/stop use the SAME daemon identity rule the Tauri shell uses: a
 * `node` process whose command line carries this repo's path AND the client
 * entry (src/ or dist/ index.ts). A bare `pgrep -f src/index.ts` matches any
 * shell that merely quotes the path — do not use it.
 *
 * Linux (issue #54): the daemon-side commands (status/start/stop/restart/
 * logs/diagnose/pids) are platform-portable — `ps` adapts to procps and the
 * arbiter view is the same. On Linux the daemon's supervisor is systemd
 * (deploy/install-client-service.sh) and status/diagnose show the unit's
 * state and route stop/restart to `systemctl --user` when it is active.
 *
 * Config: the repo root resolves from this module's location (cli/src or
 * cli/dist → repo root two levels up), overridable with
 * IDLEFILL_CONFIG_FILE=/path/to/client/config.json (same env the app
 * honors).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { DAEMON_USAGE } from './help.js';
import { jsonPayload } from './json.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

// ---- resolve the repo the same way the app does ---------------------------

interface Paths {
  repo: string;
  clientDir: string;
  tsxBin: string;
  entry: string;
  clientLog: string;
  configPath: string;
}

function findRepo(): string {
  const envFile = process.env.IDLEFILL_CONFIG_FILE;
  if (envFile) return dirname(dirname(resolve(envFile))); // <repo>/client/config.json
  let dir = moduleDir; // cli/src (or cli/dist) → repo root two levels up
  for (let i = 0; i < 14; i += 1) {
    if (existsSync(join(dir, 'client', 'config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `no client/config.json found walking up from ${moduleDir} — ` +
      `pass IDLEFILL_CONFIG_FILE=/path/to/client/config.json`
  );
}

let paths: Paths | null = null;

function initPaths(): Paths {
  if (paths) return paths;
  const repo = findRepo();
  const clientDir = join(repo, 'client');
  const tsxBin = join(repo, 'node_modules', '.bin', 'tsx');
  const entry = join(clientDir, 'src', 'index.ts');
  const clientEntryDir = existsSync(join(clientDir, 'dist', 'index.ts'))
    ? join(clientDir, 'dist')
    : join(clientDir, 'src');
  paths = {
    repo,
    clientDir,
    tsxBin,
    entry,
    clientLog: join(clientEntryDir, 'logs', 'client.log'),
    configPath: join(clientDir, 'config.json'),
  };
  return paths;
}

function P(): Paths {
  if (!paths) throw new Error('daemon paths not initialized — call runDaemon first');
  return paths;
}

// ---- process discovery (same identity rule as the Swift app) --------------

const UNIT = 'idlefill-client'; // the Linux systemd user unit (deploy/systemd/)

function isLinux(): boolean {
  return process.platform === 'linux';
}

/** The systemd user unit's state, or null (not Linux / no user bus / unit
 *  not installed). Issue #54: on Linux the supervisor answers lifecycle,
 *  and a SIGINT here would fight Restart=on-failure. */
function systemdUnit(): Record<string, string> | null {
  if (!isLinux()) return null;
  const r = spawnSync('systemctl', ['--user', 'show', UNIT, '-p', 'ActiveState,SubState,ExecMainPID,EnableState'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const o: Record<string, string> = {};
  for (const line of (r.stdout ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
  }
  return Object.keys(o).length ? o : null;
}

function psRows(): string[] {
  // macOS: /bin/ps -ax (BSD flags). Linux procps: the -ax form is a compat
  // alias but -eo is the canonical "every process" selector; same columns.
  const args = isLinux() ? ['-eo', 'pid=,ppid=,command='] : ['-ax', '-o', 'pid=,ppid=,command='];
  const out = spawnSync('/bin/ps', args, { encoding: 'utf8' });
  return (out.stdout ?? '').split('\n').filter((l) => l.trim().length > 0);
}

/** Daemons of THIS repo: node + repo path + client entry in argv. */
function daemonPids(): number[] {
  const pids: number[] = [];
  for (const line of psRows()) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, , cmd] = m;
    const argv0 = (cmd ?? '').split(/\s+/)[0] ?? '';
    if (!argv0.endsWith('/node') && argv0 !== 'node') continue;
    if (!(cmd ?? '').includes(P().repo)) continue;
    if (!cmd?.includes('src/index.ts') && !cmd?.includes('dist/index.ts')) continue;
    pids.push(Number(pid));
  }
  return pids;
}

// ---- config / arbiter ------------------------------------------------------

interface ClientCfg {
  present: boolean;
  server_url: string | null;
  token: string | null;
  client_name: string | null;
}

function clientConfig(): ClientCfg {
  const p = P().configPath;
  if (!existsSync(p)) return { present: false, server_url: null, token: null, client_name: null };
  const o = JSON.parse(readFileSync(p, 'utf8'));
  return { present: true, server_url: o.server_url ?? null, token: o.token ?? null, client_name: o.client_name ?? null };
}

interface ArbiterState {
  reachable: boolean;
  status?: number;
  clients?: unknown[];
  me?: Record<string, unknown> | null;
  idle?: unknown;
  active_leases?: unknown[];
}

async function arbiterState(): Promise<ArbiterState> {
  const cfg = clientConfig();
  const url = cfg.server_url ?? 'http://100.105.225.1:8787';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url + '/api/state', {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { reachable: false, status: res.status };
    const o = (await res.json()) as Record<string, any>;
    const clients = o.clients ?? [];
    // Client rows carry no `online` flag (workers do) — liveness = last_seen
    // within 90s, the arbiter's own workers window.
    for (const c of clients) {
      c.online = typeof c.last_seen === 'number' && c.last_seen > 0 && Date.now() - c.last_seen < 90_000;
    }
    // "me" = the row matching THIS client's configured name (registration is
    // idempotent by name, issue #10) — fall back to an online row only when
    // no name-match exists. A first-online guess grabs the WRONG machine
    // once the fleet has a second online client (issue #54 teaches that).
    const byName = cfg.client_name ? clients.find((c: Record<string, unknown>) => c.name === cfg.client_name) : null;
    const me = byName ?? clients.find((c: Record<string, unknown>) => c.online) ?? clients[0] ?? null;
    return { reachable: true, clients, me, idle: o.idle ?? null, active_leases: o.active_leases ?? [] };
  } catch {
    return { reachable: false };
  }
}

// ---- output helpers --------------------------------------------------------

const y = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const a = (s: string) => `\x1b[33m${s}\x1b[0m`;
function mark(ok: boolean): string {
  return ok ? y('ok  ') : r('FAIL');
}

interface StatusData {
  pids: number[];
  cfg: ClientCfg;
  tsxOk: boolean;
  st: ArbiterState;
  unit: Record<string, string> | null;
}

async function gatherStatus(): Promise<StatusData> {
  const pids = daemonPids();
  const unit = systemdUnit();
  const cfg = clientConfig();
  const tsxOk = existsSync(P().tsxBin);
  const st = await arbiterState();
  return { pids, cfg, tsxOk, st, unit };
}

function printStatusHuman(d: StatusData): void {
  const { pids, cfg, tsxOk, st, unit } = d;
  console.log(`repo     ${P().repo}`);
  console.log(`config   ${cfg.present ? P().configPath : r('missing — ' + P().configPath)}`);
  console.log(`tsx      ${tsxOk ? P().tsxBin : r(P().tsxBin + ' — run npm install')}`);
  if (isLinux()) {
    console.log(`unit     ${unit ? `${UNIT} ${unit.ActiveState}/${unit.SubState} pid=${unit.ExecMainPID ?? '?'} ${unit.EnableState ?? ''}` : a('no systemd user unit — deploy/install-client-service.sh')}`);
  }
  console.log(`daemon   ${pids.length ? 'pid ' + pids.join(', ') + (pids.length > 1 ? ' (tsx CLI + daemon — expected pair)' : '') : 'not running'}`);
  if (!st.reachable) {
    console.log(`arbiter  ${r('unreachable')} (${cfg.server_url ?? 'no server_url in config'})`);
  } else {
    const me = st.me;
    if (!me) {
      console.log(`arbiter  reachable — no client rows registered`);
    } else {
      const ageS = me.last_seen ? Math.round((Date.now() - (me.last_seen as number)) / 1000) : null;
      const projs = (me.projects as Array<Record<string, unknown>> | undefined) ?? [];
      const depth = projs.reduce((s, p) => s + ((p.queue_depth as number | undefined) ?? 0), 0);
      const done = projs.reduce((s, p) => s + ((((p.stats as Record<string, number> | undefined) ?? {}).finished as number | undefined) ?? 0), 0);
      const fail = projs.reduce((s, p) => s + ((((p.stats as Record<string, number> | undefined) ?? {}).failed as number | undefined) ?? 0), 0);
      const lease = (st.active_leases as Array<Record<string, unknown>> | undefined)?.find((l) => l.client_id === me.client_id);
      const bits = [
        `${me.online ? y('online') : r('offline')}`,
        ageS != null ? `last_seen ${ageS}s ago` : 'last_seen n/a',
        `rev ${(((me.revision as string | undefined) ?? 'pre-#49') as string).slice(0, 7)}`,
        `queue ${depth}`,
        `today ${done} ok / ${fail} failed`,
      ];
      if (lease) bits.push(`running ${lease.job_id}`);
      console.log(`arbiter  ${me.name}: ${bits.join(' · ')}`);
    }
  }
}

// ---- --json read shapes (D3) — pure builders, no token, no secrets --------

export interface StatusJsonInput extends StatusData {
  repo: string;
  configPath: string;
  tsxPath: string;
}

export function statusJson(d: StatusJsonInput): Record<string, unknown> {
  return {
    repo: d.repo,
    config_path: d.configPath,
    config: {
      present: d.cfg.present,
      server_url: d.cfg.server_url,
      client_name: d.cfg.client_name,
    },
    tsx: { path: d.tsxPath, ok: d.tsxOk },
    unit: d.unit,
    pids: d.pids,
    arbiter: d.st.reachable
      ? {
          reachable: true,
          me: d.st.me ?? null,
          clients: d.st.clients ?? [],
          idle: d.st.idle ?? null,
          active_leases: d.st.active_leases ?? [],
        }
      : { reachable: false, status: d.st.status ?? null },
  };
}

export function pidsJson(pids: number[]): Record<string, unknown> {
  return { pids };
}

function logTail(n: number): void {
  if (!existsSync(P().clientLog)) {
    console.log(`no log at ${P().clientLog}`);
    return;
  }
  const lines = readFileSync(P().clientLog, 'utf8').split('\n');
  console.log(`--- ${P().clientLog} (last ${n}) ---`);
  for (const l of lines.slice(-n)) process.stdout.write(l + '\n');
}

// ---- actions ----------------------------------------------------------------

async function cmdStart(): Promise<number> {
  const pids = daemonPids();
  if (pids.length) {
    console.log(`daemon already running (pid ${pids.join(', ')})`);
    return 0;
  }
  // The repo-local tsx shim is the fast path; a box without hoisted
  // node_modules falls back to `npx tsx` (what the launchd plist and the
  // systemd unit both run — issue #54 keeps one command shape everywhere).
  const useShim = existsSync(P().tsxBin);
  if (!useShim) console.log(a(`note: ${P().tsxBin} missing — falling back to npx tsx`));
  const child = spawn(useShim ? P().tsxBin : 'npx', useShim ? [P().entry] : ['tsx', P().entry], {
    cwd: P().clientDir,
    detached: true,
    stdio: 'ignore',
    // GUI-launched apps carry a minimal PATH — node lives in Homebrew and
    // the tsx shim resolves it via `#!/usr/bin/env node`.
    env: { ...process.env, PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH ?? ''].join(':') },
  });
  child.unref();
  console.log(`daemon launched (pid ${child.pid}) — log: ${P().clientLog}`);
  return 0;
}

async function cmdStop(): Promise<number> {
  const pids = daemonPids();
  if (!pids.length) {
    console.log('no daemon process found');
    return 1;
  }
  // Issue #54: under systemd the SUPERVISOR owns lifecycle. A SIGINT here
  // reads as a crash and Restart=on-failure relaunches in ~30s — refuse and
  // route the operator to the unit instead.
  const unit = systemdUnit();
  if (unit && unit.ActiveState === 'active') {
    console.log(r(`the daemon is supervised by systemd — use: systemctl --user stop ${UNIT}`));
    return 1;
  }
  for (const pid of pids) process.kill(pid, 'SIGINT');
  console.log(`SIGINT → ${pids.join(', ')}`);
  // wait for clean exit (up to 10s)
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r2) => setTimeout(r2, 500));
    if (daemonPids().length === 0) {
      console.log('stopped');
      return 0;
    }
  }
  console.log(a('still running after 10s — escalating to SIGTERM'));
  for (const pid of daemonPids()) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
  return 0;
}

function cmdApp(_args: string[]): number {
  console.log(r('the app subcommand retired with the Swift menubar (issue #69 close-out) — the Tauri shell is the app now'));
  return 1;
}

async function cmdDiagnose(): Promise<number> {
  const d = await gatherStatus();
  const { pids, cfg, tsxOk, st, unit } = d;
  console.log('');
  console.log(`config   ${mark(cfg.present)} ${cfg.present ? `server_url=${cfg.server_url}` : P().configPath}`);
  console.log(`tsx      ${mark(tsxOk)} ${P().tsxBin}`);
  const nodeCheck = spawnSync('node', ['--version'], { encoding: 'utf8', env: { PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':') + ':' + (process.env.PATH ?? '') } });
  console.log(`node     ${mark(nodeCheck.status === 0)} ${nodeCheck.stdout?.trim() ?? nodeCheck.error?.message}`);
  if (isLinux()) {
    console.log(`unit     ${mark(!!unit)} ${unit ? `${UNIT} ${unit.ActiveState}/${unit.SubState} ${unit.EnableState ?? ''}` : 'no systemd user unit (deploy/install-client-service.sh)'}`);
  }
  console.log(`daemon   ${mark(pids.length >= 1)} ${pids.length ? 'pid ' + pids.join(', ') + (pids.length > 1 ? ' (tsx CLI + daemon — expected pair)' : '') : 'not running'}`);
  console.log(`arbiter  ${mark(st.reachable)} ${st.reachable ? (st.me ? `me=${st.me.name} online=${st.me.online}` : 'no client rows') : `unreachable${st.status ? ` (HTTP ${st.status})` : ''}`}`);

  if (pids.length && st.reachable && st.me && !st.me.online) {
    console.log('');
    console.log(a('daemon is up locally but the arbiter sees it offline — it is not heartbeating. Check the log tail below (fetch failed / config fell back to defaults = wrong server_url).'));
  }
  if (!pids.length && st.reachable && st.me && st.me.online) {
    console.log('');
    console.log(a('no local daemon process, but the arbiter shows a client online — it was started from somewhere else (another terminal/orca tab), or it died within the last 90s.'));
  }
  if (!pids.length && !st.reachable) {
    console.log('');
    console.log(a('nothing running and the arbiter is unreachable — fix config/arbiter first, then `start`. The arbiter is ground truth for liveness.'));
  }
  console.log('');
  logTail(15);
  return 0;
}

// ---- dispatch ----------------------------------------------------------------

export async function runDaemon(argv: string[], json: boolean): Promise<number> {
  initPaths();
  const [cmd, ...rest] = argv;
  const linesArg = rest.includes('--lines') ? Number(rest[rest.indexOf('--lines') + 1] ?? 30) : 30;
  let rc = 0;
  switch (cmd) {
    case 'status': {
      const d = await gatherStatus();
      if (json) console.log(jsonPayload(statusJson({ ...d, repo: P().repo, configPath: P().configPath, tsxPath: P().tsxBin })));
      else printStatusHuman(d);
      break;
    }
    case 'pids': {
      const p = daemonPids();
      if (json) console.log(jsonPayload(pidsJson(p)));
      else console.log(p.join('\n'));
      rc = p.length ? 0 : 1;
      break;
    }
    case 'start':
      rc = await cmdStart();
      break;
    case 'stop':
      rc = await cmdStop();
      break;
    case 'restart': {
      rc = await cmdStop();
      if (rc === 0) rc = await cmdStart();
      break;
    }
    case 'logs':
      logTail(linesArg);
      break;
    case 'diagnose':
      rc = await cmdDiagnose();
      break;
    case 'app':
      rc = cmdApp(rest);
      break;
    default:
      console.log(DAEMON_USAGE);
      rc = 2;
  }
  return rc;
}
