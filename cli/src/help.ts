/**
 * The idlefill help tree (cli.md D2/D3, issue #88 S1).
 * The daemon group's text is byte-identical to the usage block
 * scripts/idlefill-daemon.mjs printed on an unknown command — the passthrough
 * promise. Everything else is the dispatcher's own voice.
 */

import { GROUPS, GROUP_ORDER } from './dispatch.js';
import type { GroupId } from './dispatch.js';

export const DAEMON_USAGE = `/**
idlefill daemon CLI — control + troubleshoot the client daemon, from a
terminal while developing it. (Renamed from idlefill-menubar.mjs: the
Swift menubar it named retired with the #69 cutover.)

  node scripts/idlefill-daemon.mjs status      what the daemon sees: paths,
                                               daemon pid, arbiter view
  node scripts/idlefill-daemon.mjs start       launch the daemon (same
                                               command the Settings toggle runs)
  node scripts/idlefill-daemon.mjs stop        SIGINT the daemon (clean
                                               shutdown, crash-safe)
  node scripts/idlefill-daemon.mjs restart     stop, then start
  node scripts/idlefill-daemon.mjs logs [--lines N]
                                               tail client/logs/client.log
  node scripts/idlefill-daemon.mjs diagnose    status + tsx/node checks +
                                               log tail + online/stale
                                               interpretation

start/stop use the SAME daemon identity rule the Tauri shell uses: a
\`node\` process whose command line carries this repo's path AND the client
entry (src/ or dist/ index.ts). A bare \`pgrep -f src/index.ts\` matches any
shell that merely quotes the path — do not use it.
`;

export const CONTROL_USAGE = `idlefill control — operator controls for the arbiter
(also reachable as scripts/idlefill-control.mjs).

  idlefill control clients
  idlefill control pause  <client> [--for 30m]
  idlefill control force  <client> [--for 30m]
  idlefill control clear  <client>

  idlefill control projects
  idlefill control project <name> set [--idle N] [--max N] [--ttl N]
  idlefill control project <name> clear

  idlefill control servers
  idlefill control server add <name> <url> [--models a,b,c] [--peers p1,p2]
  idlefill control server set <id> [--name N] [--url U] [--models a,b] [--peers p1] [--auth TOKEN | --auth-clear]

<client> may be a client name or a client_id.
pause  — the arbiter refuses NEW leases for that client (active leases
         keep running; nothing is revoked).
force  — the arbiter grants this client a lease even while the box is
         busy (still blocked by: degraded signal, max-concurrent, project
         pause, daily budget).
--for  — auto-expire the override (90s / 30m / 2h); default: until cleared.
project set — per-project grant knobs (idle Ns / max N at a time /
              auto-cancel after Ns); each flag is optional and independent.
project clear — drop ALL per-project overrides (inherit the globals).
servers    — the declared inference-server inventory.
--json     — clients / projects / servers print machine-readable JSON.
Auth: the arbiter token is read AT RUNTIME from the gitignored config —
it never appears on a command line.
`;

export const UPDATE_USAGE = `idlefill update — update this checkout/app to the latest release.

  idlefill update [--check] [--no-pull]

Planned — S2 (issue #89). Not implemented yet; ./update.sh stays the
manual path (the locked five-step fail-closed sequence).
`;

export const MESH_USAGE = `idlefill mesh — join / leave / inspect the mesh.

  idlefill mesh status | join <url> [--name N] | leave <name|url> | pair [code]

Planned — S4 (issue #91). Not implemented yet; today joining means
hand-editing server/config.json (mesh_peers — NOT server_peers) and
restarting the arbiter.
`;

export const ENGINE_USAGE = `idlefill engine — the inference-engine inventory.

  idlefill engine [list] | add <name> <url> [--models a,b] [--peers p1] [--local]
                | set <id> […] | remove <id>

Planned — S3 (issue #90). Not implemented yet; today: the dashboard
Resources tab or scripts/idlefill-control.mjs server …
`;

export const AGENT_USAGE = `idlefill agent — connected / discovered agents on this machine.

  idlefill agent [list] | connect <profile> | disconnect <profile>

Planned — S5 (issue #92). Not implemented yet; today: read the daemon's
agent_roster heartbeat.
`;

const GROUP_USAGE: Record<GroupId, string> = {
  update: UPDATE_USAGE,
  mesh: MESH_USAGE,
  engine: ENGINE_USAGE,
  agent: AGENT_USAGE,
  daemon: DAEMON_USAGE,
  control: CONTROL_USAGE,
};

export function topHelp(): string {
  const rows = GROUP_ORDER.map((id) => {
    const g = GROUPS[id];
    const status = g.implemented ? 'live' : `${g.slice} (#${g.issue}) — planned`;
    return `  ${id.padEnd(8)} ${g.summary.padEnd(58)} ${status}`;
  });
  return [
    'idlefill — one operator voice',
    '',
    'Usage:',
    '  idlefill <group> [command] [flags]',
    '',
    'Groups:',
    ...rows,
    '',
    'Flags:',
    '  -h, --help   help for the dispatcher or a group',
    '  --json       read commands print machine-readable JSON',
    '',
    'Design: docs/architecture/cli.md',
    '',
  ].join('\n');
}

export function groupHelp(id: GroupId): string {
  return GROUP_USAGE[id];
}
