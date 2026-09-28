/**
 * group-kill.test.ts — process-group kill for the executor (Fix 1).
 *
 * The daemon spawns the executor as `bash -c "<cmd>"` DETACHED: the child
 * becomes the leader of its own process group, and every kill targets the
 * GROUP (`process.kill(-pid)`). The career-ops adapter then forks node
 * grandchildren (Playwright, the eval) — a signal to the bash pid alone
 * leaves them alive (verified by the coordinator). An orphaned eval's LLM
 * traffic then looks like interactive activity and wedges the idle signal.
 *
 * These tests use a REAL detached spawn of a harmless command — hermetic
 * and fast (< 3s). No daemons, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { runExecutor } from '../src/index.js';
// @ts-expect-error plain-JS helper (no types) — ps-based process probes
import { pidExists } from './pid-utils.js';

function waitFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('group SIGKILL reaches the bash wrapper AND its forked child (no orphans)', async () => {
  const marker = `/tmp/idlefill-orphan-${process.pid}`;
  // bash forks `sleep 30 &` (a grandchild) then `wait`s — a signal to the
  // bash pid alone would leave the sleep alive.
  const ex = runExecutor({
    command: `sleep 30 & wait; touch ${marker}`,
    timeoutMs: 10_000,
    onExit: () => {},
  });
  assert.ok(ex.child.pid && ex.child.pid > 0, 'the child has a pid (and leads its process group)');
  await waitFor(300); // let bash fork the sleep and settle
  assert.ok(!existsSync(marker), 'bash is still waiting (the command did not finish on its own)');

  ex.kill('SIGKILL'); // → process.kill(-pid, SIGKILL): the WHOLE group
  const outcome = await ex.promise;
  assert.equal(outcome.timedOut, false, 'we killed it by hand, not by timeout');
  assert.ok(outcome.signal === 'SIGKILL' || outcome.exitCode !== 0, `the child was killed, got ${JSON.stringify(outcome)}`);

  // The regression: after a group SIGKILL, NOTHING of the tree is alive.
  // Poll briefly for any leftover `sleep 30` process.
  let orphaned = false;
  for (let i = 0; i < 10; i++) {
    if (existsSync(marker)) {
      orphaned = true; // bash survived (it would have written the marker)
      break;
    }
    if (pidExists('sleep', '30')) {
      orphaned = true;
      break;
    }
    await waitFor(100);
  }
  assert.equal(orphaned, false, 'no orphaned bash/sleep processes survived the group SIGKILL');
});

test('timeout escalates SIGINT → grace → SIGKILL and reports timedOut', async () => {
  const ex = runExecutor({
    command: 'sleep 30',
    timeoutMs: 300,
    timeoutGraceMs: 500,
    onExit: () => {},
  });
  const started = Date.now();
  const outcome = await ex.promise;
  const elapsed = Date.now() - started;
  assert.equal(outcome.timedOut, true, 'timedOut stays true when WE initiated the kill');
  // SIGINT (sleep ignores it? no — sleep dies on SIGINT) lands at ~300ms;
  // allow the full grace + margin, and it must NOT be an instant kill either.
  assert.ok(elapsed >= 300, `the timeout fired (elapsed ${elapsed}ms)`);
  assert.ok(elapsed < 5000, `no runaway grace (elapsed ${elapsed}ms)`);
  assert.ok(outcome.signal !== null || outcome.exitCode !== 0, 'the child did not exit cleanly');
});

test('output tail captures the child stdout (combined, for the log)', async () => {
  const ex = runExecutor({
    command: 'echo hello-from-stdout; echo oops >&2',
    timeoutMs: 10_000,
    onExit: () => {},
  });
  const outcome = await ex.promise;
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.outputTail, /hello-from-stdout/);
  assert.match(outcome.outputTail, /oops/);
  assert.match(outcome.outputTail, /----- stderr -----/); // both streams ⇒ separator
});

test('preempt via kill(SIGINT) on the group still settles the promise', async () => {
  const ex = runExecutor({
    command: 'sleep 30',
    timeoutMs: 10_000,
    onExit: () => {},
  });
  await waitFor(200);
  ex.kill('SIGINT'); // preemption path: SIGINT to the group, no grace timer
  const outcome = await ex.promise;
  assert.equal(outcome.timedOut, false, 'a manual SIGINT is a preemption, not a timeout');
  assert.equal(outcome.signal, 'SIGINT');
});
