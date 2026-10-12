import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_USAGE, CONTROL_USAGE, DAEMON_USAGE, ENGINE_USAGE, groupHelp, MESH_USAGE, topHelp, UPDATE_USAGE } from '../src/help.js';
import { GROUP_ORDER } from '../src/dispatch.js';

test('the daemon group help is byte-identical to the old script usage block', () => {
  // Golden text captured from `node scripts/idlefill-daemon.mjs` (no args)
  // before the shim swap — the passthrough promise (cli.md D2).
  const golden = [
    '/**',
    'idlefill daemon CLI — control + troubleshoot the client daemon, from a',
    'terminal while developing it. (Renamed from idlefill-menubar.mjs: the',
    'Swift menubar it named retired with the #69 cutover.)',
    '',
    '  node scripts/idlefill-daemon.mjs status      what the daemon sees: paths,',
    '                                               daemon pid, arbiter view',
    '  node scripts/idlefill-daemon.mjs start       launch the daemon (same',
    '                                               command the Settings toggle runs)',
    '  node scripts/idlefill-daemon.mjs stop        SIGINT the daemon (clean',
    '                                               shutdown, crash-safe)',
    '  node scripts/idlefill-daemon.mjs restart     stop, then start',
    '  node scripts/idlefill-daemon.mjs logs [--lines N]',
    '                                               tail client/logs/client.log',
    '  node scripts/idlefill-daemon.mjs diagnose    status + tsx/node checks +',
    '                                               log tail + online/stale',
    '                                               interpretation',
    '',
    'start/stop use the SAME daemon identity rule the Tauri shell uses: a',
    '`node` process whose command line carries this repo\'s path AND the client',
    'entry (src/ or dist/ index.ts). A bare `pgrep -f src/index.ts` matches any',
    'shell that merely quotes the path — do not use it.',
    '',
  ].join('\n');
  assert.equal(DAEMON_USAGE, golden);
  assert.equal(groupHelp('daemon'), golden);
});

test('the control group help names every wrapped subcommand', () => {
  assert.equal(groupHelp('control'), CONTROL_USAGE);
  for (const needle of [
    'idlefill control clients',
    'idlefill control pause',
    'idlefill control force',
    'idlefill control clear',
    'idlefill control projects',
    'idlefill control project',
    'idlefill control servers',
    'idlefill control server add',
    'idlefill control server set',
  ]) {
    assert.ok(CONTROL_USAGE.includes(needle), needle);
  }
  assert.ok(CONTROL_USAGE.includes('never appears on a command line'));
});

test('top help lists all six groups with their status', () => {
  const help = topHelp();
  assert.ok(help.includes('idlefill <group> [command] [flags]'));
  for (const id of GROUP_ORDER) assert.ok(help.includes(id), id);
  assert.ok(help.includes('live'));
  for (const issue of ['#89', '#90', '#91', '#92']) assert.ok(help.includes(issue), issue);
  assert.ok(help.includes('--json'));
  assert.ok(help.includes('docs/architecture/cli.md'));
});

test('planned groups name their slice, issue, and today\'s path', () => {
  assert.ok(UPDATE_USAGE.includes('S2 (issue #89)') && UPDATE_USAGE.includes('./update.sh'));
  assert.ok(ENGINE_USAGE.includes('S3 (issue #90)') && ENGINE_USAGE.includes('idlefill-control.mjs server'));
  assert.ok(MESH_USAGE.includes('S4 (issue #91)') && MESH_USAGE.includes('mesh_peers'));
  assert.ok(AGENT_USAGE.includes('S5 (issue #92)') && AGENT_USAGE.includes('agent_roster'));
  assert.equal(groupHelp('update'), UPDATE_USAGE);
  assert.equal(groupHelp('mesh'), MESH_USAGE);
  assert.equal(groupHelp('engine'), ENGINE_USAGE);
  assert.equal(groupHelp('agent'), AGENT_USAGE);
});
