/**
 * The arbiter's boot revision (the arbiter twin of client/src/revision.ts,
 * issue #49 — mesh build-gap, owner ask 2026-10-12).
 *
 * The arbiter is not a versioned binary either: launchd/systemd run
 * `tsx server/src/index.ts` straight from the working tree, and a
 * direct repo update (push + restart) moves the tree while older builds
 * keep serving. The mesh snapshot gains a `revision` ADD key so a peer
 * can count the git gap between two machines' builds; this module is
 * where THIS process learns the commit its code was loaded from.
 *
 * Precedence: an explicit `IDLEFILL_REVISION` env (the container path —
 * urza's image is built from a git archive and carries no .git, so the
 * deploy script bakes the commit sha into the container env) wins over
 * the git lookup. Then the same {repo} discipline as the client: anchor
 * on the entry dir (server/src in dev, server/dist built) and resolve
 * the repo root at `../..` (fallback `..` for a partial checkout).
 *
 * Best-effort by contract: no git binary, not a git checkout, garbage
 * env value, or any git failure yields undefined — the key is simply
 * omitted from the snapshot and the peer card shows no build line.
 * Reading a revision must never crash startup.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The wire shape of a revision: a lowercase hex commit sha (short or full). */
export const REVISION_RE = /^[0-9a-f]{4,64}$/;

/**
 * `git rev-parse HEAD` at the repo root resolved from this module's own
 * directory — the full commit SHA the running code was loaded from, or
 * undefined on any failure. The FULL SHA is reported; surfaces compare by
 * prefix and count with `git rev-list <a>..<b>`, which resolves short and
 * full forms alike.
 */
export function resolveRevision(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
  gitPath: string = 'git',
): string | undefined {
  for (const cand of [join(moduleDir, '..', '..'), join(moduleDir, '..')]) {
    let r: ReturnType<typeof spawnSync>;
    try {
      r = spawnSync(gitPath, ['-C', cand, 'rev-parse', 'HEAD'], { encoding: 'utf-8', timeout: 5000 });
    } catch {
      continue; // git could not even be spawned — try the next candidate
    }
    if (r.error || r.status !== 0) continue;
    const sha = String(r.stdout ?? '').trim();
    if (REVISION_RE.test(sha)) return sha;
  }
  return undefined;
}

/**
 * The boot revision THIS process runs: the baked env value first (the
 * container path — a git-less container still knows its build), then the
 * git lookup. Anything not matching REVISION_RE is rejected — a garbage
 * env value falls through to git, and if git fails too the revision is
 * simply absent (never a fake identity on the wire).
 */
export function bootRevision(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const fromEnv = (env.IDLEFILL_REVISION ?? '').trim().toLowerCase();
  if (REVISION_RE.test(fromEnv)) return fromEnv;
  return resolveRevision(moduleDir);
}
