#!/usr/bin/env node
/**
 * idlefill menubar CLI — control + troubleshoot the menu bar app and the
 * client daemon it launches, from a terminal while developing either.
 *
 *   node scripts/idlefill-menubar.mjs status      what the app sees: paths,
 *                                                 daemon pid, arbiter view
 *   node scripts/idlefill-menubar.mjs start       launch the daemon (same
 *                                                 command the app's Start runs)
 *   node scripts/idlefill-menubar.mjs stop        SIGINT the daemon (clean
 *                                                 shutdown, crash-safe)
 *   node scripts/idlefill-menubar.mjs restart     stop, then start
 *   node scripts/idlefill-menubar.mjs logs [--lines N]
 *                                                 tail client/logs/client.log
 *   node scripts/idlefill-menubar.mjs diagnose    status + tsx/node checks +
 *                                                 log tail + online/stale
 *                                                 interpretation
 *   node scripts/idlefill-menubar.mjs app start|stop|status
 *                                                 control the IdlefillMenubar
 *                                                 binary itself (it is not
 *                                                 installed as a launchd job)
 *
 * start/stop use the SAME daemon identity rule the menu bar app uses: a
 * `node` process whose command line carries this repo's path AND the client
 * entry (src/ or dist/ index.ts). A bare `pgrep -f src/index.ts` matches any
 * shell that merely quotes the path — do not use it.
 *
 * Config: repo root resolves from this script's location (scripts/ → parent),
 * overridable with IDLEFILL_CONFIG_FILE=/path/to/client/config.json (same env
 * the app honors). The arbiter token is read at runtime from the gitignored
 * client config and never printed.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));

// ---- resolve the repo the same way the app does ---------------------------

function findRepo() {
  const envFile = process.env.IDLEFILL_CONFIG_FILE;
  if (envFile) return dirname(dirname(resolve(envFile))); // <repo>/client/config.json
  let dir = scriptDir; // scripts/ → repo root one level up
  for (let i = 0; i < 14; i += 1) {
    if (existsSync(join(dir, 'client', 'config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `no client/config.json found walking up from ${scriptDir} — ` +
      `pass IDLEFILL_CONFIG_FILE=/path/to/client/config.json`
  );
}

const repo = findRepo();
const clientDir = join(repo, 'client');
const tsxBin = join(repo, 'node_modules', '.bin', 'tsx');
const entry = join(clientDir, 'src', 'index.ts');
const appBin = join(repo, 'menubar', 'IdlefillMenubar');

// The daemon anchors its log to the ENTRY dir (client/src in dev, client/dist
// after a build) → <client>/<entry>/logs/client.log.
const clientEntryDir = existsSync(join(clientDir, 'dist', 'index.ts'))
  ? join(clientDir, 'dist')
  : join(clientDir, 'src');
const clientLog = join(clientEntryDir, 'logs', 'client.log');

// ---- process discovery (same identity rule as the Swift app) --------------

function psRows() {
  const out = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return (out.stdout ?? '').split('\n').filter((l) => l.trim().length > 0);
}

/** Daemons of THIS repo: node + repo path + client entry in argv. */
function daemonPids() {
  const pids = [];
  for (const line of psRows()) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, , cmd] = m;
    const argv0 = cmd.split(/\s+/)[0] ?? '';
    if (!argv0.endsWith('/node') && argv0 !== 'node') continue;
    if (!cmd.includes(repo)) continue;
    if (!cmd.includes('src/index.ts') && !cmd.includes('dist/index.ts')) continue;
    pids.push(Number(pid));
  }
  return pids;
}

/** The menu bar binary (by executable basename, exact). */
function appPid() {
  for (const line of psRows()) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const argv0 = (m[3] ?? '').split(/\s+/)[0] ?? '';
    if (argv0 === appBin || (argv0.endsWith('/IdlefillMenubar') && argv0.startsWith(repo))) {
      return Number(m[1]);
    }
  }
  return null;
}

// ---- config / arbiter ------------------------------------------------------

function clientConfig() {
  const p = join(clientDir, 'config.json');
  if (!existsSync(p)) return { present: false, server_url: null, token: null };
  const o = JSON.parse(readFileSync(p, 'utf8'));
  return { present: true, server_url: o.server_url ?? null, token: o.token ?? null };
}

async function arbiterState() {
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
    const o = await res.json();
    const clients = o.clients ?? [];
    // Client rows carry no `online` flag (workers do) — liveness = last_seen
    // within 90s, the arbiter's own workers window.
    for (const c of clients) {
      c.online = typeof c.last_seen === 'number' && c.last_seen > 0 && Date.now() - c.last_seen < 90_000;
    }
    const me = clients.find((c) => c.online) ?? clients[0] ?? null;
    return { reachable: true, clients, me, idle: o.idle ?? null, active_leases: o.active_leases ?? [] };
  } catch {
    return { reachable: false };
  }
}

// ---- output helpers --------------------------------------------------------

const y = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const a = (s) => `\x1b[33m${s}\x1b[0m`;
function mark(ok) { return ok ? y('ok  ') : r('FAIL'); }

async function printStatus(quiet) {
  const pids = daemonPids();
  const app = appPid();
  const cfg = clientConfig();
  const tsxOk = existsSync(tsxBin);
  const st = await arbiterState();

  if (!quiet) {
    console.log(`repo     ${repo}`);
    console.log(`config   ${cfg.present ? join(clientDir, 'config.json') : r('missing — ' + join(clientDir, 'config.json'))}`);
    console.log(`tsx      ${tsxOk ? tsxBin : r(tsxBin + ' — run npm install')}`);
    console.log(`daemon   ${pids.length ? 'pid ' + pids.join(', ') + (pids.length > 1 ? ' (tsx CLI + daemon — expected pair)' : '') : 'not running'}`);
    console.log(`app      ${app ? 'pid ' + app : 'not running'}  (${appBin})`);
    if (!st.reachable) {
      console.log(`arbiter  ${r('unreachable')} (${cfg.server_url ?? 'no server_url in config'})`);
    } else {
      const me = st.me;
      if (!me) {
        console.log(`arbiter  reachable — no client rows registered`);
      } else {
        const ageS = me.last_seen ? Math.round((Date.now() - me.last_seen) / 1000) : null;
        const projs = me.projects ?? [];
        const depth = projs.reduce((s, p) => s + (p.queue_depth ?? 0), 0);
        const done = projs.reduce((s, p) => s + (p.stats?.finished ?? 0), 0);
        const fail = projs.reduce((s, p) => s + (p.stats?.failed ?? 0), 0);
        const lease = st.active_leases.find((l) => l.client_id === me.client_id);
        const bits = [
          `${me.online ? y('online') : r('offline')}`,
          ageS != null ? `last_seen ${ageS}s ago` : 'last_seen n/a',
          `queue ${depth}`,
          `today ${done} ok / ${fail} failed`,
        ];
        if (lease) bits.push(`running ${lease.job_id}`);
        console.log(`arbiter  ${me.name}: ${bits.join(' · ')}`);
      }
    }
  }
  return { pids, app, cfg, tsxOk, st };
}

function logTail(n) {
  if (!existsSync(clientLog)) { console.log(`no log at ${clientLog}`); return; }
  const lines = readFileSync(clientLog, 'utf8').split('\n');
  console.log(`--- ${clientLog} (last ${n}) ---`);
  for (const l of lines.slice(-n)) process.stdout.write(l + '\n');
}

// ---- actions ----------------------------------------------------------------

async function cmdStart() {
  const pids = daemonPids();
  if (pids.length) { console.log(`daemon already running (pid ${pids.join(', ')})`); return 0; }
  if (!existsSync(tsxBin)) { console.log(r(`start failed: ${tsxBin} not found — run npm install in ${repo}`)); return 1; }
  const child = spawn(tsxBin, [entry], {
    cwd: clientDir,
    detached: true,
    stdio: 'ignore',
    // GUI-launched apps carry a minimal PATH — node lives in Homebrew and
    // the tsx shim resolves it via `#!/usr/bin/env node`.
    env: { ...process.env, PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH ?? ''].join(':') },
  });
  child.unref();
  console.log(`daemon launched (pid ${child.pid}) — log: ${clientLog}`);
  return 0;
}

async function cmdStop() {
  const pids = daemonPids();
  if (!pids.length) { console.log('no daemon process found'); return 1; }
  for (const pid of pids) process.kill(pid, 'SIGINT');
  console.log(`SIGINT → ${pids.join(', ')}`);
  // wait for clean exit (up to 10s)
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r2) => setTimeout(r2, 500));
    if (daemonPids().length === 0) { console.log('stopped'); return 0; }
  }
  console.log(a('still running after 10s — escalating to SIGTERM'));
  for (const pid of daemonPids()) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  return 0;
}

function cmdApp(args) {
  const sub = args[0] ?? 'status';
  if (sub === 'status') {
    const pid = appPid();
    console.log(`IdlefillMenubar ${pid ? 'running (pid ' + pid + ')' : 'not running'} — ${appBin}`);
    return pid ? 0 : 1;
  }
  if (sub === 'start') {
    if (appPid()) { console.log('app already running'); return 0; }
    if (!existsSync(appBin)) { console.log(r(`app binary missing: ${appBin} — run menubar/build.sh`)); return 1; }
    const child = spawn(appBin, [], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    console.log(`app launched (pid ${child.pid})`);
    return 0;
  }
  if (sub === 'stop') {
    const pid = appPid();
    if (!pid) { console.log('app not running'); return 1; }
    process.kill(pid, 'SIGTERM');
    console.log(`SIGTERM → ${pid}`);
    return 0;
  }
  return 2;
}

async function cmdDiagnose() {
  const { pids, app, cfg, tsxOk, st } = await printStatus(true);
  console.log('');
  console.log(`config   ${mark(cfg.present)} ${cfg.present ? `server_url=${cfg.server_url}` : join(clientDir, 'config.json')}`);
  console.log(`tsx      ${mark(tsxOk)} ${tsxBin}`);
  const nodeCheck = spawnSync('node', ['--version'], { encoding: 'utf8', env: { PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':') + ':' + (process.env.PATH ?? '') } });
  console.log(`node     ${mark(nodeCheck.status === 0)} ${nodeCheck.stdout?.trim() ?? nodeCheck.error?.message}`);
  console.log(`daemon   ${mark(pids.length >= 1)} ${pids.length ? 'pid ' + pids.join(', ') + (pids.length > 1 ? ' (tsx CLI + daemon — expected pair)' : '') : 'not running'}`);
  console.log(`app      ${mark(!!app)} ${app ? 'pid ' + app : 'not running'}`);
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

const [cmd, ...rest] = process.argv.slice(2);
const linesArg = rest.includes('--lines') ? Number(rest[rest.indexOf('--lines') + 1] ?? 30) : 30;
let rc = 0;
switch (cmd) {
  case 'status': await printStatus(false); break;
  case 'start': rc = await cmdStart(); break;
  case 'stop': rc = await cmdStop(); break;
  case 'restart': {
    rc = await cmdStop();
    if (rc === 0) rc = await cmdStart();
    break;
  }
  case 'logs': logTail(linesArg); break;
  case 'diagnose': rc = await cmdDiagnose(); break;
  case 'app': rc = cmdApp(rest); break;
  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 24).join('\n').replace(/^ \* ?/gm, ''));
    rc = 2;
}
process.exit(rc);
