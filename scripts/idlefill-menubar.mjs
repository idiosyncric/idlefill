#!/usr/bin/env node
/**
 * idlefill menubar CLI — control + troubleshoot the client daemon, from a
 * terminal while developing it.
 *
 *   node scripts/idlefill-menubar.mjs status      what the daemon sees: paths,
 *                                                 daemon pid, arbiter view
 *   node scripts/idlefill-menubar.mjs start       launch the daemon (same
 *                                                 command the Settings toggle runs)
 *   node scripts/idlefill-menubar.mjs stop        SIGINT the daemon (clean
 *                                                 shutdown, crash-safe)
 *   node scripts/idlefill-menubar.mjs restart     stop, then start
 *   node scripts/idlefill-menubar.mjs logs [--lines N]
 *                                                 tail client/logs/client.log
 *   node scripts/idlefill-menubar.mjs diagnose    status + tsx/node checks +
 *                                                 log tail + online/stale
 *                                                 interpretation
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

// The daemon anchors its log to the ENTRY dir (client/src in dev, client/dist
// after a build) → <client>/<entry>/logs/client.log.
const clientEntryDir = existsSync(join(clientDir, 'dist', 'index.ts'))
  ? join(clientDir, 'dist')
  : join(clientDir, 'src');
const clientLog = join(clientEntryDir, 'logs', 'client.log');

// ---- process discovery (same identity rule as the Swift app) --------------

const UNIT = 'idlefill-client'; // the Linux systemd user unit (deploy/systemd/)

function isLinux() { return process.platform === 'linux'; }

/** The systemd user unit's state, or null (not Linux / no user bus / unit
 *  not installed). Issue #54: on Linux the supervisor answers lifecycle,
 *  and a SIGINT here would fight Restart=on-failure. */
function systemdUnit() {
  if (!isLinux()) return null;
  const r = spawnSync('systemctl', ['--user', 'show', UNIT, '-p', 'ActiveState,SubState,ExecMainPID,EnableState'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const o = {};
  for (const line of (r.stdout ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
  }
  return Object.keys(o).length ? o : null;
}

function psRows() {
  // macOS: /bin/ps -ax (BSD flags). Linux procps: the -ax form is a compat
  // alias but -eo is the canonical "every process" selector; same columns.
  const args = isLinux() ? ['-eo', 'pid=,ppid=,command='] : ['-ax', '-o', 'pid=,ppid=,command='];
  const out = spawnSync('/bin/ps', args, { encoding: 'utf8' });
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

// ---- config / arbiter ------------------------------------------------------

function clientConfig() {
  const p = join(clientDir, 'config.json');
  if (!existsSync(p)) return { present: false, server_url: null, token: null, client_name: null };
  const o = JSON.parse(readFileSync(p, 'utf8'));
  return { present: true, server_url: o.server_url ?? null, token: o.token ?? null, client_name: o.client_name ?? null };
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
    // "me" = the row matching THIS client's configured name (registration is
    // idempotent by name, issue #10) — fall back to an online row only when
    // no name-match exists. A first-online guess grabs the WRONG machine
    // once the fleet has a second online client (issue #54 teaches that).
    const byName = cfg.client_name ? clients.find((c) => c.name === cfg.client_name) : null;
    const me = byName ?? clients.find((c) => c.online) ?? clients[0] ?? null;
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
  const unit = systemdUnit();
  const cfg = clientConfig();
  const tsxOk = existsSync(tsxBin);
  const st = await arbiterState();

  if (!quiet) {
    console.log(`repo     ${repo}`);
    console.log(`config   ${cfg.present ? join(clientDir, 'config.json') : r('missing — ' + join(clientDir, 'config.json'))}`);
    console.log(`tsx      ${tsxOk ? tsxBin : r(tsxBin + ' — run npm install')}`);
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
        const ageS = me.last_seen ? Math.round((Date.now() - me.last_seen) / 1000) : null;
        const projs = me.projects ?? [];
        const depth = projs.reduce((s, p) => s + (p.queue_depth ?? 0), 0);
        const done = projs.reduce((s, p) => s + (p.stats?.finished ?? 0), 0);
        const fail = projs.reduce((s, p) => s + (p.stats?.failed ?? 0), 0);
        const lease = st.active_leases.find((l) => l.client_id === me.client_id);
        const bits = [
          `${me.online ? y('online') : r('offline')}`,
          ageS != null ? `last_seen ${ageS}s ago` : 'last_seen n/a',
          `rev ${(me.revision ?? 'pre-#49').slice(0, 7)}`,
          `queue ${depth}`,
          `today ${done} ok / ${fail} failed`,
        ];
        if (lease) bits.push(`running ${lease.job_id}`);
        console.log(`arbiter  ${me.name}: ${bits.join(' · ')}`);
      }
    }
  }
  return { pids, cfg, tsxOk, st, unit };
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
  // The repo-local tsx shim is the fast path; a box without hoisted
  // node_modules falls back to `npx tsx` (what the launchd plist and the
  // systemd unit both run — issue #54 keeps one command shape everywhere).
  const useShim = existsSync(tsxBin);
  if (!useShim) console.log(a(`note: ${tsxBin} missing — falling back to npx tsx`));
  const child = spawn(useShim ? tsxBin : 'npx', useShim ? [entry] : ['tsx', entry], {
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
    if (daemonPids().length === 0) { console.log('stopped'); return 0; }
  }
  console.log(a('still running after 10s — escalating to SIGTERM'));
  for (const pid of daemonPids()) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  return 0;
}

function cmdApp(args) {
  const sub = args[0] ?? 'status';
  console.log(r('the app subcommand retired with the Swift menubar (issue #69 close-out) — the Tauri shell is the app now'));
  return 1;
}

async function cmdDiagnose() {
  const { pids, cfg, tsxOk, st, unit } = await printStatus(true);
  console.log('');
  console.log(`config   ${mark(cfg.present)} ${cfg.present ? `server_url=${cfg.server_url}` : join(clientDir, 'config.json')}`);
  console.log(`tsx      ${mark(tsxOk)} ${tsxBin}`);
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

const [cmd, ...rest] = process.argv.slice(2);
const linesArg = rest.includes('--lines') ? Number(rest[rest.indexOf('--lines') + 1] ?? 30) : 30;
let rc = 0;
switch (cmd) {
  case 'status': await printStatus(false); break;
  case 'pids': { const p = daemonPids(); console.log(p.join('\n')); rc = p.length ? 0 : 1; break; }
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
