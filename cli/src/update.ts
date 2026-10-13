/**
 * The `idlefill update` group (cli.md D4, issue #89 S2) — a read-only
 * release-feed check and a WRAPPER around this machine's documented update
 * command. The CLI re-implements NOTHING (D4 LOCKED): `update` execs
 * ./update.sh on macOS, scripts/native-selfupdate.sh on a Linux box with the
 * native arbiter unit installed (container-ops.md D1), or
 * scripts/urza-selfupdate.sh on the Linux container host; `--check` reads the
 * signed release feed published by scripts/release.sh and compares it against
 * the installed build marker.
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
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
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
// documented one: platform first, then on Linux whether the NATIVE arbiter
// unit is installed (the container→native flip, container-ops.md D1), docker
// presence next, named refusal when no path is real. (D4: the wrapper runs
// the machine's own command; it re-implements nothing.)
// ---------------------------------------------------------------------------

export interface MachineEnv {
  platform: string;
  docker: boolean;
  updateScript: string;
  urzaScript: string;
  nativeScript: string;
  /** True when the native Linux arbiter unit exists on this box. */
  nativeUnit: boolean;
}

// The unit name deploy/install-server-service.sh renders, in both the user
// and the system flavor. Its presence — not docker's — says this box runs the
// arbiter natively.
export const NATIVE_UNIT_USER_PATH = '.config/systemd/user/idlefill-server.service';
export const NATIVE_UNIT_SYSTEM_PATH = '/etc/systemd/system/idlefill-server.service';

export function nativeUnitInstalled(home: string = homedir()): boolean {
  return existsSync(join(home, NATIVE_UNIT_USER_PATH)) || existsSync(NATIVE_UNIT_SYSTEM_PATH);
}

export function detectMachineEnv(root: string = repoRoot): MachineEnv {
  const docker = spawnSync('bash', ['-c', 'command -v docker >/dev/null 2>&1'], { encoding: 'utf8' }).status === 0;
  return {
    platform: process.platform,
    docker,
    updateScript: join(root, 'update.sh'),
    urzaScript: join(root, 'scripts', 'urza-selfupdate.sh'),
    nativeScript: join(root, 'scripts', 'native-selfupdate.sh'),
    nativeUnit: nativeUnitInstalled(),
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
    if (env.nativeUnit) {
      // The native install owns this box's arbiter (the container era is
      // over here): picking the container helper would BUILD an image and
      // start a container that fights the running unit for the port.
      if (!existsSync(env.nativeScript)) {
        return {
          ok: false,
          reason:
            `this Linux machine runs the native arbiter unit, but scripts/native-selfupdate.sh is absent at ${env.nativeScript} — the native update path is missing in this checkout. ` +
            'Named refusal: nothing was run.',
        };
      }
      return {
        ok: true,
        script: env.nativeScript,
        what: 'scripts/native-selfupdate.sh — fast-forward main in this checkout, install only when the lockfile moved, restart the arbiter + client units, healthcheck, roll the checkout back to the previous commit on failure',
      };
    }
    if (!env.docker) {
      return {
        ok: false,
        reason:
          'this Linux machine has no docker on PATH and no native arbiter unit installed — the documented Linux update commands are the container-host helper scripts/urza-selfupdate.sh or the native install (deploy/install-server-service.sh + scripts/native-selfupdate.sh), and neither is present here. ' +
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
          'The container host helper always hard-resolves its disposable checkout to origin/main — there is no rebuild-in-place mode there. Nothing was run.',
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
    reason: `idlefill update has no documented command for platform "${env.platform}" — the wave covers macOS (update.sh), the native Linux install (native-selfupdate.sh) and the Linux container host (urza-selfupdate.sh) only. Nothing was run.`,
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
// The shim chain (pure) — PATH honesty on the operator command. scripts/
// install-cli.sh renders the shim (marker line + the IDLEFILL_CLI_REPO line)
// that makes bare `idlefill` THE command, exec'ing THAT checkout's cli/dist.
// The first live urza pass of #89 proved the failure mode: a PATH-resolved
// command that does not serve the checkout you think you are running. This
// is the decision half of the check (update.sh runs the same posture in
// bash after the install); every mismatch is named, never swallowed (D3).
// ---------------------------------------------------------------------------

export const SHIM_MARKER = 'idlefill-cli-shim';

// Mirrors install-cli.sh's default BINDIR ($HOME/.local/bin) as a RELATIVE
// path — this checkout's shim always resolves against THIS machine's home,
// and no new PATH dir is invented here.
export const SHIM_DIR_SUBPATH = join('.local', 'bin');

export type ShimProbe =
  | { kind: 'shim'; repo: string }
  | { kind: 'broken-shim' } // our marker line, no parseable IDLEFILL_CLI_REPO line
  | { kind: 'not-a-shim' }; // not install-cli.sh's rendering at all

export function probeShimText(text: string): ShimProbe {
  if (!text.includes(SHIM_MARKER)) return { kind: 'not-a-shim' };
  const m = /^IDLEFILL_CLI_REPO="(.+)"$/m.exec(text);
  const repo = m?.[1];
  return repo ? { kind: 'shim', repo } : { kind: 'broken-shim' };
}

/** The bash `command -v` shape: first executable hit in PATH order; an
 *  empty PATH entry means the cwd, like bash treats it. */
export function firstOnPath(name: string, pathValue: string, isExecutable: (p: string) => boolean): string | null {
  for (const dir of pathValue.split(':')) {
    const p = join(dir === '' ? '.' : dir, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

export interface ShimChainFacts {
  pathShim: string | null; // what bare `idlefill` resolves to on $PATH (null: nothing)
  pathShimProbe: ShimProbe | null; // content probe of that file (null: unreadable)
  installedProbe: ShimProbe | null; // probe of the default install target (null: absent)
  runningRepo: string; // the checkout THIS CLI code runs from
  target: string; // the default install target for this home
}

export type ShimChainVerdict =
  | { kind: 'ok'; shim: string }
  | { kind: 'installed-off-path'; shim: string }
  | { kind: 'not-installed'; target: string }
  | { kind: 'foreign-path'; shim: string }
  | { kind: 'broken-shim'; shim: string }
  | { kind: 'wrong-checkout'; shim: string; shimRepo: string; runningRepo: string };

export function decideShimChain(f: ShimChainFacts): ShimChainVerdict {
  if (f.pathShim !== null) {
    if (f.pathShimProbe === null || f.pathShimProbe.kind === 'not-a-shim') return { kind: 'foreign-path', shim: f.pathShim };
    if (f.pathShimProbe.kind === 'broken-shim') return { kind: 'broken-shim', shim: f.pathShim };
    if (f.pathShimProbe.repo === f.runningRepo) return { kind: 'ok', shim: f.pathShim };
    return { kind: 'wrong-checkout', shim: f.pathShim, shimRepo: f.pathShimProbe.repo, runningRepo: f.runningRepo };
  }
  if (f.installedProbe?.kind === 'shim' && f.installedProbe.repo === f.runningRepo) {
    return { kind: 'installed-off-path', shim: f.target };
  }
  return { kind: 'not-installed', target: f.target };
}

/** D3 voice: an exception-only note, or null when the chain is honest.
 *  installed-off-path is silent ON PURPOSE — it is urza's documented
 *  posture (its updater config carries the ABSOLUTE shim path precisely
 *  because the rendered unit's PATH lacks the shim dir; #89 verified). */
export function describeShimChain(v: ShimChainVerdict): string | null {
  switch (v.kind) {
    case 'ok':
    case 'installed-off-path':
      return null;
    case 'not-installed':
      return `no \`idlefill\` on this PATH and no shim for this checkout at ${v.target} — run \`bash scripts/install-cli.sh\` from this checkout to put the operator command on PATH (it names anything already there instead of overwriting it)`;
    case 'foreign-path':
      return `bare \`idlefill\` resolves to ${v.shim}, which is NOT a shim scripts/install-cli.sh rendered — that file could be anything. Named, not guessed: this run used the entry it was invoked from`;
    case 'broken-shim':
      return `bare \`idlefill\` resolves to ${v.shim}, which carries the shim marker but no IDLEFILL_CLI_REPO line — re-run \`bash scripts/install-cli.sh\` from the checkout that should own it`;
    case 'wrong-checkout':
      return `bare \`idlefill\` on this PATH serves ${v.shimRepo} (via ${v.shim}), but this invocation runs from ${v.runningRepo} — this run updates ${v.runningRepo}. Named, not guessed.`;
  }
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readShimProbe(path: string): ShimProbe | null {
  try {
    return probeShimText(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function detectShimChainFacts(): ShimChainFacts {
  const target = join(homedir(), SHIM_DIR_SUBPATH, 'idlefill');
  const pathShim = firstOnPath('idlefill', process.env.PATH ?? '', isExecutableFile);
  return {
    pathShim,
    pathShimProbe: pathShim ? readShimProbe(pathShim) : null,
    installedProbe: existsSync(target) ? readShimProbe(target) : null,
    runningRepo: repoRoot,
    target,
  };
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
    // PATH honesty before the exec (the urza lesson of #89): name the shim
    // chain this command actually rides, but only when it is NOT honest —
    // an exception-only line (D3), never noise on the two clean postures.
    const chainNote = describeShimChain(decideShimChain(detectShimChainFacts()));
    if (chainNote) console.log(`idlefill update: ${chainNote}`);
    console.log(`idlefill update → ${w.what}`);
    return runWrapped(w.script, parsed.noPull ? ['--no-pull'] : []);
  } catch (err) {
    console.error(`idlefill update: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
