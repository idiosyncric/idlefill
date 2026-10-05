/**
 * The daemon's boot revision (issue #49).
 *
 * The daemon is not a versioned binary: launchd runs `tsx client/src/index.ts`
 * straight from the working tree, and KeepAlive relaunches only on crash.
 * After a direct repo update (merge + push, or `git pull`), the running
 * process keeps executing the code it loaded at start while the tree moves
 * ahead — and the version handshake cannot reveal it (the release number
 * only bumps when a `v<N>` tag is cut). The fix is a second handshake fact:
 * the git commit this process's code was loaded from.
 *
 * Resolution follows the same {repo} discipline as version.ts: anchor on
 * the entry dir (client/src in dev, client/dist built) and resolve the repo
 * root at `../..` (fallback `..` for a partial checkout). Best-effort by
 * contract: no git binary, not a git checkout, or any git failure yields
 * undefined — the field is simply omitted from the handshake and a
 * pre-revision client keeps registering exactly as before. Reading a
 * revision must never crash startup.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `git rev-parse HEAD` at the repo root resolved from this module's own
 * directory — the full commit SHA the running code was loaded from, or
 * undefined on any failure. The FULL SHA (40 chars, within the arbiter's
 * ≤64 sanitize rule) is reported verbatim; surfaces compare by prefix so
 * their own `git rev-parse --short HEAD` values match it.
 */
export function resolveRevision(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
  gitPath: string = 'git',
): string | undefined {
  // Same root candidates as version.ts: root = ../.. from the entry dir
  // (identical in the dev and dist layouts), `..` as the fallback.
  for (const cand of [join(moduleDir, '..', '..'), join(moduleDir, '..')]) {
    let r: ReturnType<typeof spawnSync>;
    try {
      r = spawnSync(gitPath, ['-C', cand, 'rev-parse', 'HEAD'], { encoding: 'utf-8', timeout: 5000 });
    } catch {
      continue; // git could not even be spawned — try the next candidate
    }
    if (r.error || r.status !== 0) continue;
    // Node's typings box stdout as string|Buffer even with encoding set;
    // String() is a no-op on the utf-8 string and honest on the fallback.
    const sha = String(r.stdout ?? '').trim();
    // A bare repo in a bare checkout answers with the SHA alone; anything
    // else (empty, multi-line oddity) is not a usable identity.
    if (/^[0-9a-f]{4,64}$/.test(sha)) return sha;
  }
  return undefined;
}
