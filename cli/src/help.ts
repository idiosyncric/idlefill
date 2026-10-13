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

export const UPDATE_USAGE = `idlefill update — update THIS machine's idlefill install (cli.md D4).

  idlefill update [--check] [--no-pull] [--json]

--check — read-only: an anonymous GET of the signed release feed (the
\`latest\` pseudo-tag's latest.json, published by scripts/release.sh),
compared against the installed build marker (the /Applications bundle's
\`idlefill-app --version\` → \`idlefill <short sha>\`). A named answer
either way — "up to date at <sha>" / "Release #N available (<sha>)".
Touches nothing; an unreachable feed is a named outcome, never a fake
zero. --json prints the machine-readable verdict.
update — a WRAPPER, not a re-implementation (D4): it execs THIS machine's
documented update command — macOS: ./update.sh (the locked five-step
fail-closed sequence); Linux with the native arbiter unit:
scripts/native-selfupdate.sh; Linux container host:
scripts/urza-selfupdate.sh.
--no-pull rebuilds this checkout at its current commit (the macOS and native
Linux paths).
Exit codes pass through from the wrapped script. Plane discipline: this
is the local checkout/app plane — updating ANOTHER machine is the mesh
intent plane (the dashboard button, mesh-update.md); there is no
\`idlefill update <peer>\`.
`;

export const MESH_USAGE = `idlefill mesh — join / leave / inspect the mesh.

  idlefill mesh status [--json]
  idlefill mesh join <url> [--name N]
  idlefill mesh leave <name|url>
  idlefill mesh pair [code]

status — the merged peer rows with the dashboard's fetch-honesty posture:
the snapshot age grows, past the 90s window the row names itself offline;
never fake progress.
join — probe-then-write: the candidate must answer GET /api/mesh with the
configured peer_token BEFORE anything is written (unreachable / wrong
shape / refused token = named refusal, zero mutation). Then the
mesh_peers row is upserted into server/config.json — atomic write,
timestamped backup, server_peers (llama-swap backends) untouched — and
the arbiter re-reads JUST mesh_peers + peer_token (no restart; the next
poll tick pulls the row).
leave — drops the row, re-reads the same scoped keys, reports.
pair — no code: mints a one-time pairing code (this machine becomes the
controlled end). With a code: redeems a peer's code (this machine
becomes the controller). Rides the locked #39/#55 ceremony — no new
handshake, no new credential plane.
Auth: the arbiter token is read AT RUNTIME from the gitignored config —
it never appears on a command line.
`;

export const ENGINE_USAGE = `idlefill engine — the inference-engine inventory (the terminal twin of
the dashboard Resources tab and \`idlefill control server …\`).

  idlefill engine [list] [--json]
  idlefill engine add <name> <url> [--models a,b] [--peers p1] [--local [--log-glob G]]
  idlefill engine set <id> [--name N] [--url U] [--models a,b] [--peers p1]
  idlefill engine remove <id>

add --local — the co-location pre-flight (mesh.md rule 1): the arbiter's
idle detector reads the engine's log file ON THE ARBITER'S HOST, so a
local engine must carry a log_glob that matches a real file here. The CLI
probes candidate log locations BEFORE saving — no match, nothing is saved
and the rule is named. Pass --log-glob to point at the engine's log.
Without --local a row is display + routing metadata: fail-closed for
grants, exactly as the ownership rule intends.
remove refuses a row with live leases — the arbiter answers, the CLI
names it.
Auth: the arbiter token is read AT RUNTIME from the gitignored config —
it never appears on a command line.
`;

export const AGENT_USAGE = `idlefill agent — connected / discovered agents on this machine.

  idlefill agent [list] [--json]
  idlefill agent connect <profile>
  idlefill agent disconnect <profile>

list — renders the agent_roster the daemon already publishes, with the
dashboard's fetch-honesty posture: no roster key is a named absence (a
daemon with no ~/.hermes home, or offline) — never a fake zero; a
fetched-empty roster is a true 0 naming the zero-config posture.
connect — flips the Hermes profile's model base URL to this machine's
aggregate endpoint (127.0.0.1:<aggregate_port>); disconnect restores the
prior config from the timestamped backup connect wrote — it never invents
a prior endpoint. This is the wave's ONLY out-of-repo write, and the
agent-roster credential rules are inherited whole: only config.yaml is
read (never a profile .env, never a key_env reference), a
userinfo-bearing URL is refused not redacted, an unparseable config is a
named refusal, and the backup is written before any modification.
Routing only — connect/disconnect change where a profile SENDS traffic;
the idle gate still decides admission.
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
