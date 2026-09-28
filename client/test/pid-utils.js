/**
 * Tiny cross-platform process probes for the group-kill test. We avoid
 * `pkill`/`pgrep` (flaky arg matching) and drive `ps` with an explicit argv.
 */

import { execFileSync } from 'node:child_process';

/**
 * @param {...string} needles
 * @returns {boolean} true when at least one process's command line contains
 * ALL of `needles`. Used to detect an orphaned `sleep 30` grandchild after a
 * group SIGKILL.
 */
export function pidExists(...needles) {
  try {
    const out = execFileSync('ps', ['-eo', 'command'], { encoding: 'utf-8', timeout: 5000 });
    for (const line of out.split('\n')) {
      if (!needles.every((n) => line.includes(n))) continue;
      // Skip this test's own ps + the probe line itself.
      if (line.includes('ps -eo')) continue;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * @param {number} pid
 * @param {string} sig
 * @returns {void}
 */
export function killSync(pid, sig) {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}
