import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv } from '../src/argv.js';

test('empty argv → no group, no sub, no flags', () => {
  assert.deepEqual(parseArgv([]), { group: null, sub: null, args: [], json: false, help: false });
});

test('group + subcommand: args pass through untouched', () => {
  const p = parseArgv(['daemon', 'status']);
  assert.equal(p.group, 'daemon');
  assert.equal(p.sub, 'status');
  assert.deepEqual(p.args, ['status']);
  assert.equal(p.json, false);
});

test('group flags stay in args verbatim (passthrough discipline)', () => {
  const p = parseArgv(['daemon', 'logs', '--lines', '40']);
  assert.deepEqual(p.args, ['logs', '--lines', '40']);
});

test('control-style flags survive parsing', () => {
  const p = parseArgv(['control', 'pause', 'mac-sam', '--for', '30m']);
  assert.equal(p.group, 'control');
  assert.equal(p.sub, 'pause');
  assert.deepEqual(p.args, ['pause', 'mac-sam', '--for', '30m']);
});

test('--json is a global flag: set, stripped, position-independent', () => {
  for (const argv of [['--json', 'daemon', 'status'], ['daemon', '--json', 'status'], ['daemon', 'status', '--json']]) {
    const p = parseArgv(argv);
    assert.equal(p.json, true, argv.join(' '));
    assert.equal(p.group, 'daemon');
    assert.deepEqual(p.args, ['status']);
  }
});

test('--help / -h set the help flag and are stripped', () => {
  assert.equal(parseArgv(['--help']).help, true);
  assert.equal(parseArgv(['-h']).help, true);
  const p = parseArgv(['daemon', '--help']);
  assert.equal(p.group, 'daemon');
  assert.equal(p.help, true);
  assert.deepEqual(p.args, []);
});

test('first non-flag token is the group even after other flags', () => {
  const p = parseArgv(['--json', '--help', 'control', 'clients']);
  assert.equal(p.group, 'control');
  assert.deepEqual(p.args, ['clients']);
});

test('group without a subcommand: sub is null', () => {
  const p = parseArgv(['daemon']);
  assert.equal(p.group, 'daemon');
  assert.equal(p.sub, null);
  assert.deepEqual(p.args, []);
});

test('the first non-flag token is the group; an unknown leading flag passes through', () => {
  const p = parseArgv(['--bogus', 'daemon']);
  assert.equal(p.group, 'daemon');
  assert.deepEqual(p.args, ['--bogus']);
});
