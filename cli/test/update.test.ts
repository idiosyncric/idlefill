/**
 * Pure-helper tests for `idlefill update` (cli.md D4, issue #89 S2): the
 * argv table, the release-feed shape sanitizer (malformed feed = a named
 * outcome, never a fake zero), the marker-compare decision table
 * (up-to-date / ahead / behind / unmatched / no-app / bad-marker), the
 * --json posture, the wrapper decision table (macOS vs Linux container
 * host vs no documented path; --no-pull plumbing; exit-code passthrough),
 * and the shim-chain PATH-honesty table (the urza lesson of #89: a bare
 * `idlefill` that does not serve the running checkout is named, never
 * trusted; the documented absolute-path posture stays silent).
 * A real-fs test stubs the wrapped script in a scratch dir.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';

import {
  APP_BINARY,
  checkPayload,
  decideMarker,
  decideShimChain,
  describeCheck,
  describeShimChain,
  firstOnPath,
  parseBuildMarker,
  parseUpdateArgs,
  nativeUnitInstalled,
  probeShimText,
  RELEASE_FEED_URL,
  resolveUpdateCommand,
  runWrapped,
  sanitizeReleaseFeed,
  SHIM_DIR_SUBPATH,
  SHIM_MARKER,
  type MachineEnv,
  type ReleaseRef,
  type ShimChainFacts,
} from '../src/update.js';
import { parseArgv } from '../src/argv.js';

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

test('bare update parses to the wrapper with no flags', () => {
  const p = parseUpdateArgs([]);
  assert.ok(p.ok);
  assert.equal(p.check, false);
  assert.equal(p.noPull, false);
});

test('--check and --no-pull are the only flags, in any order', () => {
  const p1 = parseUpdateArgs(['--check']);
  const p2 = parseUpdateArgs(['--no-pull', '--check']);
  assert.ok(p1.ok && p2.ok);
  assert.equal(p1.check, true);
  assert.equal(p2.check, true);
  assert.equal(p2.noPull, true);
});

test('every usage mistake is named with the usage line', () => {
  assert.ok(!parseUpdateArgs(['--bogus']).ok);
  assert.ok(!parseUpdateArgs(['now']).ok);
  assert.ok(!parseUpdateArgs(['urza']).ok, 'no positional peer — the intent plane stays the dashboard\'s');
  assert.ok(!parseUpdateArgs(['--check', 'extra']).ok);
  assert.match(parseUpdateArgs(['--bogus']).error ?? /x/, /unknown flag "--bogus"/);
});

test('--json is stripped upstream and never reaches the group args', () => {
  // The dispatcher owns --json/--help (D3); the group sees clean args.
  const parsed = parseArgv(['update', '--check', '--json']);
  assert.deepEqual(parsed.args, ['--check']);
  assert.equal(parsed.json, true);
  const p = parseUpdateArgs(parsed.args);
  assert.ok(p.ok && p.check);
});

// ---------------------------------------------------------------------------
// The feed sanitizer — malformed is a named outcome, never a fake zero
// ---------------------------------------------------------------------------

const realFeedShape = {
  version: '1.0.4',
  pub_date: '2026-10-09T19:59:17Z',
  notes: 'Release #4 (tag v4).',
  platforms: { 'darwin-aarch64': { url: 'https://example/Idlefill.app.tar.gz', signature: 'aGVhZA==' } },
};

test('the live latest.json shape is accepted and names the release number', () => {
  const f = sanitizeReleaseFeed(JSON.stringify(realFeedShape));
  assert.ok(f.ok);
  assert.equal(f.version, '1.0.4');
  assert.equal(f.releaseNumber, 4);
});

test('a non-JSON answer is a named malformed outcome, not an empty one', () => {
  const f = sanitizeReleaseFeed('<html>502 Bad Gateway</html>');
  assert.equal(f.ok, false);
  assert.match(f.reason, /not JSON/);
});

test('an array, a bare string, or a null body are refused by name', () => {
  for (const body of ['[]', '"latest"', 'null', '42']) {
    const f = sanitizeReleaseFeed(body);
    assert.equal(f.ok, false, body);
    assert.match(f.reason, /not a JSON object/);
  }
});

test('a version-less or platforms-less feed is refused, not read as "nothing published"', () => {
  const noVersion = sanitizeReleaseFeed(JSON.stringify({ pub_date: 'x', platforms: realFeedShape.platforms }));
  assert.equal(noVersion.ok, false);
  assert.match(noVersion.reason, /names no version/);
  const noPlatforms = sanitizeReleaseFeed(JSON.stringify({ version: '1.0.5', platforms: {} }));
  assert.equal(noPlatforms.ok, false);
  assert.match(noPlatforms.reason, /no platforms/);
});

test('a version that is not a release SemVer is named with the D5 contract', () => {
  const f = sanitizeReleaseFeed(JSON.stringify({ version: '2.1', platforms: realFeedShape.platforms }));
  assert.equal(f.ok, false);
  assert.match(f.reason, /not a release SemVer/);
  const zero = sanitizeReleaseFeed(JSON.stringify({ version: '1.0.0', platforms: realFeedShape.platforms }));
  assert.equal(zero.ok, false, 'release number 0 is not a release');
});

// ---------------------------------------------------------------------------
// The build marker contract: `idlefill <short sha>` — anything else names
// ---------------------------------------------------------------------------

test('a contract-conforming marker parses; garbage does not', () => {
  assert.equal(parseBuildMarker('idlefill 7c43c10\n'), '7c43c10');
  assert.equal(parseBuildMarker('idlefill 2de1b9c625eca922c0f14fe0346bd023364e3a99'), '2de1b9c625eca922c0f14fe0346bd023364e3a99');
  assert.equal(parseBuildMarker('idlefill-app version 1.0.4'), null);
  assert.equal(parseBuildMarker(''), null);
  assert.equal(parseBuildMarker('idlefill dev'), null);
  assert.equal(parseBuildMarker('idlefill 7c43c10 idlefill 7c43c10'), null);
});

// ---------------------------------------------------------------------------
// The marker-compare decision table
// ---------------------------------------------------------------------------

const REL: ReleaseRef = { version: '1.0.4', number: 4, tag: 'v4', commit: '2de1b9c625eca922c0f14fe0346bd023364e3a99' };
const MARKER = '7c43c10';

test('equal: the marker IS the release commit — up to date (short prefix counts)', () => {
  assert.equal(decideMarker('2de1b9c', REL.commit, () => null), 'up-to-date');
  assert.equal(decideMarker(REL.commit, REL.commit, () => null), 'up-to-date');
});

test('ahead: the release tag is an ancestor of the installed build', () => {
  const kind = decideMarker(MARKER, REL.commit, (a, b) => a === REL.commit && b === MARKER);
  assert.equal(kind, 'ahead');
});

test('behind: the installed build is an ancestor of the release tag', () => {
  const older = '1111111';
  const kind = decideMarker(older, REL.commit, (a, b) => a === older && b === REL.commit);
  assert.equal(kind, 'behind');
});

test('unmatched: when git cannot place either commit, the answer names that', () => {
  const kind = decideMarker(MARKER, REL.commit, () => null);
  assert.equal(kind, 'unmatched');
  const diverged = decideMarker(MARKER, REL.commit, () => false);
  assert.equal(diverged, 'unmatched');
});

// ---------------------------------------------------------------------------
// Human wording — every branch names itself; nothing is a fake zero
// ---------------------------------------------------------------------------

test('behind reads "Release #N available (<sha>)" and points at the wrapper', () => {
  const lines = describeCheck({ kind: 'behind', marker: MARKER, release: REL });
  assert.ok(lines[0].includes('Release #4 available (2de1b9c)'));
  assert.ok(lines[0].includes('7c43c10'));
  assert.ok(lines[1].includes('idlefill update'));
});

test('up-to-date and ahead both answer with the installed sha', () => {
  assert.ok(describeCheck({ kind: 'up-to-date', marker: MARKER, release: REL })[0].includes('up to date at 7c43c10'));
  const ahead = describeCheck({ kind: 'ahead', marker: MARKER, release: REL })[0];
  assert.ok(ahead.includes('up to date at 7c43c10') && ahead.includes('AHEAD'));
});

test('an unreachable feed names the URL and refuses to invent an answer', () => {
  const lines = describeCheck({ kind: 'feed-unreachable', error: 'HTTP 502' });
  assert.ok(lines[0].includes(RELEASE_FEED_URL));
  assert.ok(lines.join(' ').includes('never a fake zero'));
});

test('no-app, bad-marker, no-commit and unmatched all name their uncertainty', () => {
  assert.ok(describeCheck({ kind: 'no-app', release: REL }).join(' ').includes('no installed Tauri app'));
  assert.ok(describeCheck({ kind: 'bad-marker', output: 'garbage output' }).join(' ').includes('garbage output'));
  assert.ok(describeCheck({ kind: 'no-commit', release: REL, reason: 'git cannot resolve tag v4' }).join(' ').includes('no verdict'));
  assert.ok(describeCheck({ kind: 'unmatched', marker: MARKER, release: REL }).join(' ').includes('named, not guessed'));
});

// ---------------------------------------------------------------------------
// The --json posture
// ---------------------------------------------------------------------------

test('the JSON payload carries the decision, the release, and the marker', () => {
  const p = checkPayload({ kind: 'behind', marker: MARKER, release: REL });
  assert.equal(p.decision, 'behind');
  assert.equal(p.ok, true);
  assert.equal(p.release.number, 4);
  assert.equal(p.installed.marker, MARKER);
  assert.equal(p.installed.binary, APP_BINARY);
  assert.equal(p.feed, RELEASE_FEED_URL);
});

test('the JSON payload marks failed reads ok=false and names the reason', () => {
  const p = checkPayload({ kind: 'feed-unreachable', error: 'ETIMEDOUT' });
  assert.equal(p.ok, false);
  assert.equal(p.decision, 'feed-unreachable');
  assert.equal(p.error, 'ETIMEDOUT');
  const m = checkPayload({ kind: 'feed-malformed', reason: 'not JSON' });
  assert.equal(m.ok, false);
});

// ---------------------------------------------------------------------------
// The wrapper decision table — which script is THIS machine's documented one
// ---------------------------------------------------------------------------

const env = (over: Partial<MachineEnv> = {}): MachineEnv => ({
  platform: 'darwin',
  docker: false,
  updateScript: '/repo/update.sh',
  urzaScript: '/repo/scripts/urza-selfupdate.sh',
  nativeScript: '/repo/scripts/native-selfupdate.sh',
  nativeUnit: false,
  ...over,
});

const NATIVE = join(REPO_ROOT, 'scripts', 'native-selfupdate.sh');

test('macOS: update.sh is the documented command when it exists', () => {
  const w = resolveUpdateCommand({ ...env(), updateScript: join(REPO_ROOT, 'update.sh') }, false);
  assert.ok(w.ok);
  assert.equal(w.script, join(REPO_ROOT, 'update.sh'));
  assert.ok(w.what.includes('update.sh'));
});

test('macOS without update.sh in the checkout: named refusal, nothing runs', () => {
  const w = resolveUpdateCommand(env({ updateScript: '/nonexistent/update.sh' }), false);
  assert.equal(w.ok, false);
  assert.match(w.reason, /update\.sh is absent/);
  assert.ok(w.reason.includes('Nothing was run'));
});

test('Linux container host: docker + urza-selfupdate.sh selects the host helper', () => {
  const w = resolveUpdateCommand({ ...env(), platform: 'linux', docker: true, urzaScript: join(REPO_ROOT, 'scripts', 'urza-selfupdate.sh') }, false);
  assert.ok(w.ok);
  assert.equal(w.script, join(REPO_ROOT, 'scripts', 'urza-selfupdate.sh'));
  assert.ok(w.what.includes('urza-selfupdate.sh'));
});

test('a NATIVE Linux install wins over docker even with docker installed', () => {
  // The cutover hazard: the container helper would build an image and start a
  // container that fights the running unit for the arbiter port.
  const w = resolveUpdateCommand(
    {
      ...env(),
      platform: 'linux',
      docker: true,
      urzaScript: join(REPO_ROOT, 'scripts', 'urza-selfupdate.sh'),
      nativeScript: NATIVE,
      nativeUnit: true,
    },
    false,
  );
  assert.ok(w.ok);
  assert.equal(w.script, NATIVE);
  assert.ok(w.what.includes('native-selfupdate.sh'));
  assert.ok(w.what.includes('units'));
});

test('native unit but no native-selfupdate.sh here: named refusal, nothing runs', () => {
  const w = resolveUpdateCommand({ ...env(), platform: 'linux', docker: true, nativeUnit: true, nativeScript: '/nonexistent/native-selfupdate.sh' }, false);
  assert.equal(w.ok, false);
  assert.match(w.reason, /native-selfupdate\.sh is absent/);
  assert.ok(w.reason.includes('nothing was run'));
});

test('--no-pull is legal on the native path — it rebuilds THIS checkout', () => {
  const w = resolveUpdateCommand({ ...env(), platform: 'linux', docker: true, nativeUnit: true, nativeScript: NATIVE }, true);
  assert.ok(w.ok);
  assert.equal(w.script, NATIVE);
});

test('the native unit is detected in the user flavor and the system flavor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-native-unit-'));
  try {
    assert.equal(nativeUnitInstalled(dir), false, 'no unit files = not native');
    const userDir = join(dir, '.config', 'systemd', 'user');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'idlefill-server.service'), '# rendered\n');
    assert.equal(nativeUnitInstalled(dir), true, 'the rendered user unit says this box is native');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(nativeUnitInstalled('/nonexistent-home'), false);
});

test('Linux without docker: named refusal — this box has no documented update command', () => {
  const w = resolveUpdateCommand({ ...env(), platform: 'linux', docker: false }, false);
  assert.equal(w.ok, false);
  assert.match(w.reason, /no docker on PATH/);
  assert.ok(w.reason.includes('Named refusal'));
});

test('Linux with docker but no host-helper script: named refusal', () => {
  const w = resolveUpdateCommand({ ...env(), platform: 'linux', docker: true, urzaScript: '/nonexistent/urza-selfupdate.sh' }, false);
  assert.equal(w.ok, false);
  assert.match(w.reason, /urza-selfupdate\.sh is absent/);
});

test('--no-pull is update.sh semantics: the Linux path refuses it by name', () => {
  const w = resolveUpdateCommand({ ...env(), platform: 'linux', docker: true, urzaScript: join(REPO_ROOT, 'scripts', 'urza-selfupdate.sh') }, true);
  assert.equal(w.ok, false);
  assert.match(w.reason, /--no-pull names update\.sh semantics/);
});

test('macOS + docker installed still picks update.sh — the platform decides first', () => {
  const w = resolveUpdateCommand({ ...env(), platform: 'darwin', docker: true, updateScript: join(REPO_ROOT, 'update.sh') }, false);
  assert.ok(w.ok);
  assert.equal(w.script, join(REPO_ROOT, 'update.sh'));
});

test('an unknown platform names the gap instead of guessing', () => {
  const w = resolveUpdateCommand(env({ platform: 'win32' }), false);
  assert.equal(w.ok, false);
  assert.match(w.reason, /no documented command for platform "win32"/);
});

// ---------------------------------------------------------------------------
// Exit-code passthrough and --no-pull plumbing (real stub scripts)
// ---------------------------------------------------------------------------

test("a stub script's exit code passes through unchanged (fail and success)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-update-stub-'));
  try {
    const fail = join(dir, 'stub-fail.sh');
    const pass = join(dir, 'stub-pass.sh');
    writeFileSync(fail, '#!/bin/bash\necho "stub ran with: $*"\nexit 3\n');
    writeFileSync(pass, '#!/bin/bash\ncase "$1" in --no-pull) echo "no-pull honoured";; esac\nexit 0\n');
    assert.equal(runWrapped(fail, ['--no-pull']), 3);
    assert.equal(runWrapped(pass, ['--no-pull']), 0);
    assert.equal(runWrapped(pass, []), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runWrapped forwards the argv to the wrapped script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idlefill-update-args-'));
  try {
    const stub = join(dir, 'stub-args.sh');
    writeFileSync(stub, '#!/bin/bash\necho "$1"|head -1\nexit 9\n');
    assert.equal(runWrapped(stub, ['--no-pull']), 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a spawn failure is a named failure with exit 1, not a passthrough', () => {
  const r = runWrapped('/definitely/not/here/script.sh', [], () => ({ status: null, error: new Error('ENOENT stub') }));
  assert.equal(r, 1);
});

test('a wrapped command answering 0 but with a null status is not read as success', () => {
  assert.equal(runWrapped('whatever', [], () => ({ status: null })), 1);
  assert.equal(runWrapped('whatever', [], () => ({ status: 7 })), 7);
});

// ---------------------------------------------------------------------------
// The shim chain — PATH honesty (the urza lesson of #89, Mac side)
// ---------------------------------------------------------------------------

const renderedShim = (repo: string): string => [
  '#!/bin/sh',
  `# ${SHIM_MARKER} v1 — rendered by scripts/install-cli.sh; do not edit.`,
  `IDLEFILL_CLI_REPO="${repo}"`,
  'DIST="$IDLEFILL_CLI_REPO/cli/dist/index.js"',
  'exec node "$DIST" "$@"',
  '',
].join('\n');

test('a rendered shim is probed for its checkout; anything else is named', () => {
  assert.deepEqual(probeShimText(renderedShim('/repo/a')), { kind: 'shim', repo: '/repo/a' });
  assert.deepEqual(probeShimText('#!/bin/sh\necho not idlefill\n'), { kind: 'not-a-shim' });
  assert.deepEqual(probeShimText(`# ${SHIM_MARKER} v1 but the repo line was edited away`), { kind: 'broken-shim' });
  assert.deepEqual(probeShimText(`# ${SHIM_MARKER}\nIDLEFILL_CLI_REPO=""`), { kind: 'broken-shim' }, 'an empty repo line is broken, not a shim serving ""');
});

test('firstOnPath walks PATH in order and skips non-executables', () => {
  const tried: string[] = [];
  const hit = firstOnPath('idlefill', `/a:/b:/c`, (p) => {
    tried.push(p);
    return p === join('/b', 'idlefill');
  });
  assert.equal(hit, join('/b', 'idlefill'));
  assert.deepEqual(tried, [join('/a', 'idlefill'), join('/b', 'idlefill')], 'first hit wins — /c is never probed');
  assert.equal(firstOnPath('idlefill', '', (p) => {
    tried.push(p);
    return false;
  }), null);
  assert.equal(tried[tried.length - 1], join('.', 'idlefill'), 'an empty PATH entry means the cwd, like bash');
});

const facts = (over: Partial<ShimChainFacts> = {}): ShimChainFacts => ({
  pathShim: '/home/op/.local/bin/idlefill',
  pathShimProbe: probeShimText(renderedShim('/repo/a')),
  installedProbe: probeShimText(renderedShim('/repo/a')),
  runningRepo: '/repo/a',
  target: '/home/op/.local/bin/idlefill',
  ...over,
});

test('the honest chain: bare `idlefill` serves THIS checkout — ok, and silent', () => {
  const v = decideShimChain(facts());
  assert.equal(v.kind, 'ok');
  assert.equal(describeShimChain(v), null);
});

test('a PATH shim serving a DIFFERENT checkout is named (the stale/shadow chain class)', () => {
  const v = decideShimChain(facts({ runningRepo: '/repo/b' }));
  assert.equal(v.kind, 'wrong-checkout');
  assert.ok(v.kind === 'wrong-checkout' && v.shimRepo === '/repo/a' && v.runningRepo === '/repo/b');
  const line = describeShimChain(v) ?? '';
  assert.ok(line.includes('/repo/a') && line.includes('/repo/b') && line.includes('Named, not guessed.'));
});

test('a PATH hit that is not install-cli.sh rendering is named, never trusted', () => {
  const foreign = decideShimChain(facts({ pathShimProbe: probeShimText('#!/bin/sh\nrm -rf /\n') }));
  assert.equal(foreign.kind, 'foreign-path');
  assert.ok((describeShimChain(foreign) ?? '').includes('NOT a shim scripts/install-cli.sh rendered'));
  const unreadable = decideShimChain(facts({ pathShimProbe: null }));
  assert.equal(unreadable.kind, 'foreign-path', 'a PATH hit whose contents cannot be read is NOT assumed honest');
  const broken = decideShimChain(facts({ pathShimProbe: probeShimText(`# ${SHIM_MARKER} with no repo line`) }));
  assert.equal(broken.kind, 'broken-shim');
  assert.ok((describeShimChain(broken) ?? '').includes('install-cli.sh'));
});

test('no PATH hit but the target shim serves this checkout: installed-off-path — the urza posture, silent', () => {
  // urza's updater config carries the ABSOLUTE shim path precisely because
  // the rendered unit's PATH lacks the shim dir (#89 verified) — an honest
  // invocation must not be treated as a failure.
  const v = decideShimChain(facts({ pathShim: null, pathShimProbe: null }));
  assert.equal(v.kind, 'installed-off-path');
  assert.equal(describeShimChain(v), null);
});

test('no PATH hit and no shim for this checkout at the target: named, with the installer named', () => {
  const absent = decideShimChain(facts({ pathShim: null, pathShimProbe: null, installedProbe: null }));
  assert.equal(absent.kind, 'not-installed');
  assert.ok((describeShimChain(absent) ?? '').includes('scripts/install-cli.sh'));
  const otherRepoAtTarget = decideShimChain(facts({
    pathShim: null,
    pathShimProbe: null,
    installedProbe: probeShimText(renderedShim('/repo/a')),
    runningRepo: '/repo/b',
  }));
  assert.equal(otherRepoAtTarget.kind, 'not-installed', "a target shim for ANOTHER checkout is not THIS checkout's chain");
});

test('the shim install dir is this home-relative (no absolute path is baked into the repo)', () => {
  assert.equal(SHIM_DIR_SUBPATH, join('.local', 'bin'), 'mirrors install-cli.sh default BINDIR — not a new PATH dir');
  assert.ok(!SHIM_DIR_SUBPATH.startsWith('/'));
});
