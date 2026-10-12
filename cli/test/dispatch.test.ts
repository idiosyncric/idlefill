import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv } from '../src/argv.js';
import { dispatch, EXIT_FAIL, EXIT_OK, EXIT_USAGE, GROUP_ORDER, GROUPS, isGroupId, notImplementedNote } from '../src/dispatch.js';

const parse = (argv: string[]) => parseArgv(argv);

test('exit-code convention: 0 ok, 1 failed, 2 usage', () => {
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_FAIL, 1);
  assert.equal(EXIT_USAGE, 2);
});

test('daemon/control route as live passthrough groups (S1)', () => {
  assert.deepEqual(dispatch(parse(['daemon', 'status'])), { kind: 'group', group: 'daemon' });
  assert.deepEqual(dispatch(parse(['control', 'clients'])), { kind: 'group', group: 'control' });
  assert.equal(GROUPS.daemon.implemented, true);
  assert.equal(GROUPS.control.implemented, true);
});

test('engine routes as a live group (S3, #90)', () => {
  assert.deepEqual(dispatch(parse(['engine', 'list'])), { kind: 'group', group: 'engine' });
  assert.equal(GROUPS.engine.implemented, true);
});

test('mesh routes as a live group (S4, #91)', () => {
  assert.deepEqual(dispatch(parse(['mesh', 'status'])), { kind: 'group', group: 'mesh' });
  assert.deepEqual(dispatch(parse(['mesh', 'join', 'http://100.105.225.1:8787'])), { kind: 'group', group: 'mesh' });
  assert.equal(GROUPS.mesh.implemented, true);
});

test('agent routes as a live group (S5, #92)', () => {
  assert.deepEqual(dispatch(parse(['agent', 'list'])), { kind: 'group', group: 'agent' });
  assert.deepEqual(dispatch(parse(['agent', 'connect', 'web-dev'])), { kind: 'group', group: 'agent' });
  assert.equal(GROUPS.agent.implemented, true);
  assert.equal(GROUPS.agent.slice, 'S5');
  assert.equal(GROUPS.agent.issue, 92);
});

test('update is registered but refuses by name until S2', () => {
  const planned: Array<[string, string, number]> = [
    ['update', 'S2', 89],
  ];
  for (const [id, slice, issue] of planned) {
    const spec = GROUPS[id as keyof typeof GROUPS];
    assert.equal(spec.implemented, false, id);
    assert.equal(spec.slice, slice, id);
    assert.equal(spec.issue, issue, id);
    const note = notImplementedNote(spec);
    assert.match(note, new RegExp(`^idlefill ${id}: not implemented yet — lands in ${slice} \\(issue #${issue}\\)$`));
  }
});

test('no argv → no-group (usage)', () => {
  assert.deepEqual(dispatch(parse([])), { kind: 'no-group' });
});

test('unknown token → unknown-group with the token named', () => {
  assert.deepEqual(dispatch(parse(['frobnicate'])), { kind: 'unknown-group', group: 'frobnicate' });
});

test('an unknown leading flag does not block the group token', () => {
  assert.deepEqual(dispatch(parse(['--bogus', 'daemon'])), { kind: 'group', group: 'daemon' });
});

test('isGroupId accepts exactly the six registered groups', () => {
  for (const id of GROUP_ORDER) assert.equal(isGroupId(id), true, id);
  assert.equal(isGroupId('frobnicate'), false);
  assert.equal(isGroupId(''), false);
});

test('the group table carries the D2 order and a summary per group', () => {
  assert.deepEqual(GROUP_ORDER, ['update', 'mesh', 'engine', 'agent', 'daemon', 'control']);
  for (const id of GROUP_ORDER) {
    assert.ok(GROUPS[id].summary.length > 0, id);
    assert.equal(GROUPS[id].id, id);
  }
});
