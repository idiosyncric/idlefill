/**
 * The daemon process-identity rule (cli.md D2, `idlefill daemon pids/status`):
 * node + THIS repo + the CLIENT entry, named specifically. The regression this
 * pins is the native-Linux false fire (the urza cutover, container-ops.md D1):
 * the arbiter runs from the SAME checkout as the client daemon, so the loose
 * 'src/index.ts' substring counted the arbiter's node processes as client
 * daemons — which made `idlefill daemon pids` lie and made
 * deploy/install-client-service.sh refuse its own unit's processes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isClientDaemonCmdline } from '../src/daemon.js';

const REPO = '/home/sam/Software/idlefill';
const CLIENT = `${REPO}/client`;

test('the client daemon is recognised in both run flavors', () => {
  assert.ok(
    isClientDaemonCmdline(`node ${REPO}/node_modules/.bin/tsx ${CLIENT}/src/index.ts`, REPO, CLIENT),
    'the tsx dev flavor (what the systemd unit and the launchd agent both exec)',
  );
  assert.ok(isClientDaemonCmdline(`node ${CLIENT}/dist/index.js`, REPO, CLIENT), 'the built flavor');
});

test('the ARBITER of the same checkout is never a client daemon', () => {
  // The native Linux install runs both from one checkout; the server entry has
  // to be refused by name, not by the loose substring.
  assert.ok(!isClientDaemonCmdline(`node ${REPO}/node_modules/.bin/tsx ${REPO}/server/src/index.ts`, REPO, CLIENT));
  assert.ok(!isClientDaemonCmdline(`node ${REPO}/server/dist/index.js`, REPO, CLIENT));
});

test('a foreign checkout, a foreign entry, and a non-node process are all refused', () => {
  assert.ok(
    !isClientDaemonCmdline('node /opt/other/node_modules/.bin/tsx /opt/other/client/src/index.ts', REPO, CLIENT),
    'another checkout owns its own daemon',
  );
  assert.ok(!isClientDaemonCmdline(`node ${REPO}/node_modules/.bin/tsx ${REPO}/fleet/src/index.ts`, REPO, CLIENT));
  assert.ok(
    !isClientDaemonCmdline(`sh -c tsx ${CLIENT}/src/index.ts`, REPO, CLIENT),
    'the wrapper shell is not the daemon — argv[0] must be node',
  );
});
