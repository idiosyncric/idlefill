/**
 * The daemon's version string.
 *
 * Single version source: the ROOT package.json (the repo root) — the release
 * tag `v<X.Y.Z>` is cut from it and the desktop release pipeline treats it as
 * the version authority, so the daemon and the published releases always
 * agree. (client/package.json's own `version` is NOT the source — the issue
 * said so, but the root package is the one that tags come from.)
 *
 * Resolution follows the same {repo} discipline as config.ts: anchor on
 * `import.meta.url` (the module dir — client/src in dev, client/dist after a
 * build) and look for the repo-root package.json one level above the client
 * package dir (i.e. `../..` from the entry dir — the same result in both
 * the dev and dist layouts, like config.ts's {repo} resolution). The
 * client package's own package.json is only a fallback for a partial
 * checkout.
 *
 * Parse failure or a missing file yields `0.0.0-dev` — a version read must
 * never crash startup.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV_VERSION = '0.0.0-dev';

/**
 * Resolve the release version from the ROOT package.json, given this
 * module's own directory (client/src in dev, client/dist built). The root
 * package (one level above the client package dir) is the version source —
 * checked FIRST; the client package's own package.json is only a fallback
 * when no root package is found (a partial checkout), and a missing or
 * unreadable file yields DEV_VERSION. Both dev and dist layouts anchor the
 * root at `../..` from the entry dir — the same discipline as config.ts.
 */
export function resolveVersion(moduleDir: string = dirname(fileURLToPath(import.meta.url))): string {
  for (const cand of [join(moduleDir, '..', '..', 'package.json'), join(moduleDir, '..', 'package.json')]) {
    if (!existsSync(cand)) continue;
    try {
      const raw = JSON.parse(readFileSync(cand, 'utf-8')) as { version?: unknown };
      if (typeof raw.version === 'string' && raw.version.trim() !== '') return raw.version.trim();
    } catch {
      /* unreadable — try the next candidate */
    }
  }
  return DEV_VERSION;
}
