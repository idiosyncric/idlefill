/**
 * The `idlefill update` group (cli.md D4, issue #89 S2) — a read-only
 * release-feed check and a WRAPPER around this machine's documented update
 * command. The CLI re-implements NOTHING (D4 LOCKED): `update` execs
 * ./update.sh on macOS or scripts/urza-selfupdate.sh on the Linux container
 * host; `--check` reads the signed release feed published by
 * scripts/release.sh and compares it against the installed build marker.
 * Plane discipline: the LOCAL checkout/app plane only — updating ANOTHER
 * machine is the mesh intent plane (mesh-update.md, the dashboard button);
 * there is no `idlefill update <peer>`.
 *
 * Voice (D3): a named answer either way — "up to date at <sha>" /
 * "Release #N available (<sha>)". An unreachable or malformed feed is a
 * named outcome, never a fake zero. `--json` on the read (`--check`).
 * Exit codes: 0 ok · 1 action failed · 2 usage.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './engine.js';
import { jsonPayload } from './json.js';

export const UPDATE_USAGE = 'usage: idlefill update [--check] [--no-pull]';

// The feed VERBATIM from scripts/release.sh (FEED_URL) and shell-updater.md
// D3 — the Forgejo `latest` pseudo-tag's latest.json. Never invented here.
export const RELEASE_FEED_URL =
  'https://git.samwarth.com/sam/idlefill/releases/download/latest/latest.json';

// The build-marker contract (update.sh step 4, tauri/build.sh gate 4): the
// installed bundle answers `idlefill-app --version` → `idlefill <short sha>`.
// The CLI reads the marker from the /Applications binary — that IS the app
// the operator has installed.
export const APP_BINARY = '/Applications/Idlefill.app/Contents/MacOS/idlefill-app';

// ---------------------------------------------------------------------------
// argv (pure)
// ---------------------------------------------------------------------------

export type UpdateParse =
  | { ok: true; check: boolean; noPull: boolean }
  | { ok: false; error: string };

export function parseUpdateArgs(argv: string[]): UpdateParse {
  let check = false;
  let noPull = false;
  for (const tok of argv) {
    if (tok === '--check') {
      check = true;
      continue;
    }
    if (tok === '--no-pull') {
      noPull = true;
      continue;
    }
    if (tok.startsWith('-')) return { ok: false, error: `unknown flag "${tok}" — ${UPDATE_USAGE}` };
    return { ok: false, error: `update takes no positional arguments ("${tok}") — ${UPDATE_USAGE}` };
  }
  return { ok: true, check, noPull };
}

// ---------------------------------------------------------------------------
// The feed shape + sanitizer (pure) — malformed is a named outcome, never a
// fake zero. Mirrors the D3 contract validated by scripts/release.sh.
// ---------------------------------------------------------------------------

export type FeedSanitized =
  | { ok: true; version: string; releaseNumber: number }
  | { ok: false; reason: string };

export function sanitizeReleaseFeed(text: string): FeedSanitized {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `the feed is not JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'the feed is not a JSON object — that is not the latest.json shape (shell-updater.md D3)' };
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.version !== 'string' || m.version.trim() === '') {
    return { ok: false, reason: 'the feed names no version' };
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(m.version.trim());
  if (!match) {
    return { ok: false, reason: `the feed version "${m.version}" is not a release SemVer (the channel publishes 1.0.N — D5)` };
  }
  const number = Number(match[3]);
  if (!Number.isInteger(number) || number < 1) {
    return { ok: false, reason: `the feed version "${m.version}" names release number ${match[3]} — a release number is an integer >= 1` };
  }
  if (!m.platforms || typeof m.platforms !== 'object' || Array.isArray(m.platforms) || Object.keys(m.platforms).length === 0) {
    return { ok: false, reason: 'the feed carries no platforms — a published release always carries the signed bundle pair' };
  }
  return { ok: true, version: m.version.trim(), releaseNumber: number };
}

// ---------------------------------------------------------------------------
// The installed build marker (pure parse; the runner reads the binary)
// ---------------------------------------------------------------------------

export function parseBuildMarker(text: string): string | null {
  const m = /^\s*idlefill\s+([0-9a-fA-F]{7,40})\s*$/.exec(String(text ?? ''));
  const sha = m?.[1];
  return sha ? sha.toLowerCase() : null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function sameCommit(marker: string, full: string): boolean {
  const a = marker.toLowerCase();
  const b = full.toLowerCase();
  return b.startsWith(a) || a.startsWith(b);
}

// ---------------------------------------------------------------------------
// The marker-compare decision table (pure — the ancestry probe is injected)
// ---------------------------------------------------------------------------

export interface ReleaseRef {
  version: string;
  number: number;
  tag: string;
  commit: string | null;
}

export type CheckDecision =
  | { kind: 'up-to-date'; marker: string; release: ReleaseRef }
  | { kind: 'ahead'; marker: string; release: ReleaseRef }
  | { kind: 'behind'; marker: string; release: ReleaseRef }
  | { kind: 'unmatched'; marker: string; release: ReleaseRef }
  | { kind: 'no-app'; release: ReleaseRef }
  | { kind: 'bad-marker'; output: string }
  | { kind: 'no-commit'; release: ReleaseRef; reason: string }
  | { kind: 'feed-unreachable'; error: string }
  | { kind: 'feed-malformed'; reason: string };

/**
 * Decide from the installed marker and the release commit. `isAncestor(a, b)`
 * returns true when a is an ancestor of b, false when it is not, null when
 * the checkout's git cannot resolve one of the shas. Every branch is named —
 * nothing is guessed.
 */
export function decideMarker(
  marker: string,
  releaseCommit: string,
  isAncestor: (a: string, b: string) => boolean | null,
): CheckDecision['kind'] {
  if (sameCommit(marker, releaseCommit)) return 'up-to-date';
  if (isAncestor(releaseCommit, marker) === true) return 'ahead';
  if (isAncestor(marker, releaseCommit) === true) return 'behind';
  return 'unmatched';
}

export function describeCheck(d: CheckDecision): string[] {
  switch (d.kind) {
    case 'up-to-date':
      return [
        `up to date at ${d.marker} — the installed app matches Release #${d.release.number} (tag ${d.release.tag}, commit ${shortSha(d.release.commit ?? '')})`,
        'nothing was touched',
      ];
    case 'ahead':
      return [
        `up to date at ${d.marker} — the installed build is AHEAD of Release #${d.release.number} (${d.release.tag} at ${shortSha(d.release.commit ?? '')}): nothing newer is published`,
        'nothing was touched',
      ];
    case 'behind':
      return [
        `Release #${d.release.number} available (${shortSha(d.release.commit ?? '')}) — the installed build ${d.marker} is behind the published release`,
        'run `idlefill update` to take it',
      ];
    case 'unmatched':
      return [
        `Release #${d.release.number} is published (${d.release.tag} at ${shortSha(d.release.commit ?? '')}), but the installed build ${d.marker} does not match it and this checkout's git cannot place the two`,
        'named, not guessed — nothing was touched',
      ];
    case 'no-app':
      return [
        `Release #${d.release.number} is the latest published (${d.release.tag} at ${shortSha(d.release.commit ?? '')})`,
        'this machine has no installed Tauri app to compare against — the release feed is the macOS bundle channel; nothing was touched',
      ];
    case 'bad-marker':
      return [
        `the installed app answered --version with something the marker contract does not recognize: "${d.output}"`,
        'cannot tell — named, never guessed',
      ];
    case 'no-commit':
      return [
        `the feed names Release #${d.release.number} (${d.release.tag}), but this checkout cannot resolve the tag: ${d.reason}`,
        'no verdict — a fake answer would be worse than none',
      ];
    case 'feed-unreachable':
      return [
        `release feed unreachable (${RELEASE_FEED_URL}): ${d.error}`,
        'no answer — never a fake zero',
      ];
    case 'feed-malformed':
      return [
        `the feed answered, but NOT in the latest.json shape: ${d.reason}`,
        'no answer — never a fake zero',
      ];
  }
}

export function checkPayload(d: CheckDecision): Record<string, unknown> {
  const base: Record<string, unknown> = { decision: d.kind, feed: RELEASE_FEED_URL };
  if ('release' in d && d.release) base.release = d.release;
  if ('marker' in d) base.installed = { binary: APP_BINARY, marker: d.marker };
  if (d.kind === 'no-app') base.installed = { binary: APP_BINARY, marker: null };
  if (d.kind === 'bad-marker') base.installed = { binary: APP_BINARY, raw_output: d.output };
  if (d.kind === 'no-commit') base.reason = d.reason;
  if (d.kind === 'feed-unreachable') base.error = d.error;
  if (d.kind === 'feed-malformed') base.reason = d.reason;
  base.ok = ['up-to-date', 'ahead', 'behind', 'unmatched', 'no-app'].includes(d.kind);
  return base;
}

// ---------------------------------------------------------------------------
// The wrapper decision table (pure) — which script is THIS machine's
// documented one: platform first, docker presence second, named refusal when
// neither path is real. (D4: the wrapper runs the machine's own command; it
// re-implements nothing.)
// ---------------------------------------------------------------------------

export interface MachineEnv {
  platform: string;
  docker: boolean;
  updateScript: string;
  urzaScript: string;
}

export function detectMachineEnv(root: string = repoRoot): MachineEnv {
  const docker = spawnSync('bash', ['-c', 'command -v docker >/dev/null 2>&1'], { encoding: 'utf8' }).status === 0;
  return {
    platform: process.platform,
    docker,
    updateScript: join(root, 'update.sh'),
    urzaScript: join(root, 'scripts', 'urza-selfupdate.sh'),
  };
}

export type WrapperDecision =
  | { ok: true; script: string; what: string }
  | { ok: false; reason: string };

export function resolveUpdateCommand(env: MachineEnv, noPull: boolean): WrapperDecision {
  if (env.platform === 'darwin') {
    if (!existsSync(env.updateScript)) {
      return { ok: false, reason: `this is a macOS machine but update.sh is absent at ${env.updateScript} — the documented manual path is not in this checkout. Nothing was run.` };
    }
    return { ok: true, script: env.updateScript, what: './update.sh — the locked five-step fail-closed sequence (README "Updating")' };
  }
  if (env.platform === 'linux') {
    if (!env.docker) {
      return {
        ok: false,
        reason:
          'this Linux machine has no docker on PATH — the documented Linux update command is the container-host helper scripts/urza-selfupdate.sh, and there is no container host here. ' +
          'Named refusal: this box has no documented update command; nothing was run.',
      };
    }
    if (!existsSync(env.urzaScript)) {
      return { ok: false, reason: `scripts/urza-selfupdate.sh is absent at ${env.urzaScript} — the host-helper path is missing in this checkout. Nothing was run.` };
    }
    if (noPull) {
      return {
        ok: false,
        reason:
          '--no-pull names update.sh semantics (rebuild THIS checkout at its current commit). ' +
          'The host helper always hard-resolves the checkout to origin/main — there is no rebuild-in-place mode there. Nothing was run.',
      };
    }
    return {
      ok: true,
      script: env.urzaScript,
      what: 'scripts/urza-selfupdate.sh — fetch main, build from the committed tree, swap the container, healthcheck, roll back on failure',
    };
  }
  return {
    ok: false,
    reason: `idlefill update has no documented command for platform "${env.platform}" — the wave covers macOS (update.sh) and the Linux container host (urza-selfupdate.sh) only. Nothing was run.`,
  };
}

export type SpawnLike = (cmd: string, args: string[]) => { status: number | null; error?: Error };

const realSpawn: SpawnLike = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf8' });

/** Run the wrapped script; its exit code passes through unchanged. */
export function runWrapped(script: string, args: string[], spawn: SpawnLike = realSpawn): number {
  const r = spawn('bash', [script, ...args]);
  if (r.error) {
    console.error(`idlefill update: the wrapped command could not start (${r.error.message})`);
    return 1;
  }
  return r.status ?? 1;
}

// ---------------------------------------------------------------------------
// The live group
// ---------------------------------------------------------------------------

function resolveTagCommit(releaseNumber: number): string | null {
  const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--quiet', `v${releaseNumber}^{}`], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  const sha = String(r.stdout).trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function gitIsAncestor(a: string, b: string): boolean | null {
  const r = spawnSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', a, b]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

async function runCheck(json: boolean): Promise<number> {
  let decision: CheckDecision;
  try {
    const res = await fetch(RELEASE_FEED_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      decision = { kind: 'feed-unreachable', error: `HTTP ${res.status}` };
    } else {
      const feed = sanitizeReleaseFeed(await res.text());
      if (!feed.ok) {
        decision = { kind: 'feed-malformed', reason: feed.reason };
      } else {
        const release: ReleaseRef = {
          version: feed.version,
          number: feed.releaseNumber,
          tag: `v${feed.releaseNumber}`,
          commit: resolveTagCommit(feed.releaseNumber),
        };
        if (!existsSync(APP_BINARY)) {
          decision = { kind: 'no-app', release };
        } else {
          const out = spawnSync(APP_BINARY, ['--version'], { encoding: 'utf8' });
          const raw = `${out.stdout ?? ''}${out.stderr ?? ''}`.trim();
          if (out.error || out.status !== 0) {
            decision = { kind: 'bad-marker', output: raw || `the bundle binary exited with status ${out.status ?? 'unknown'}` };
          } else {
            const marker = parseBuildMarker(raw);
            if (!marker) {
              decision = { kind: 'bad-marker', output: raw };
            } else if (release.commit === null) {
              decision = { kind: 'no-commit', release, reason: `git cannot resolve tag ${release.tag} in this checkout (run \`git fetch --tags\`)` };
            } else {
              const kind = decideMarker(marker, release.commit, gitIsAncestor);
              decision = kind === 'up-to-date' || kind === 'ahead' || kind === 'behind' || kind === 'unmatched'
                ? { kind, marker, release }
                : { kind: 'unmatched', marker, release };
            }
          }
        }
      }
    }
  } catch (err) {
    decision = { kind: 'feed-unreachable', error: err instanceof Error ? err.message : String(err) };
  }
  if (json) {
    console.log(jsonPayload(checkPayload(decision)));
  } else {
    console.log(describeCheck(decision).join('\n'));
  }
  return decision.kind === 'feed-unreachable' || decision.kind === 'feed-malformed' || decision.kind === 'bad-marker' || decision.kind === 'no-commit' ? 1 : 0;
}

export async function runUpdate(argv: string[], json: boolean): Promise<number> {
  try {
    const parsed = parseUpdateArgs(argv);
    if (!parsed.ok) {
      console.error(`idlefill update: ${parsed.error}`);
      return 2;
    }
    if (parsed.check) return runCheck(json);

    const env = detectMachineEnv();
    const w = resolveUpdateCommand(env, parsed.noPull);
    if (!w.ok) {
      console.error(`idlefill update: ${w.reason}`);
      return 1;
    }
    console.log(`idlefill update → ${w.what}`);
    return runWrapped(w.script, parsed.noPull ? ['--no-pull'] : []);
  } catch (err) {
    console.error(`idlefill update: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
