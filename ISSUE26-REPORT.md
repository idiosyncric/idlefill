# Issue #26 report — Branch/commit-tracking update channel (edge channel)

Branch `issue-26-branch-update` (base `a9787a7` + version bump
`0010274` = main). A second, opt-in **update channel** for BOTH
auto-update surfaces — the desktop app and the menu bar app — plus the
CI publish path. The default stays `releases`: with no channel
configured, behavior is byte-identical to today (the Sparkle flow is
untouched; the menubar's `uc-test.sh` numeric cases stay green;
`CFBundleVersion` stays numeric). All of it proven by the two new
headless harnesses + the existing suites + one LIVE round-trip (a
scratch tag, fully cleaned up afterwards) — no production daemon or
installed app was touched.

## What changed (per file)

### `scripts/edge-release.sh` (new — the edge publish body)

The publish path the CI calls (and the live probe called — one code
path, per the issue): `edge-release.sh <tag> [sha]`.

- **The tag is the identity.** `edge-<name>-<sha7>` — ONE string, three
  uses: the Forgejo release TAG, the release name's tail
  (`Edge <name> <sha7>`), and the artifact-zip name part. The name part
  (the branch in CI, `probe` for the live probe) is DERIVED from the
  tag, and the tag's `-<sha7>` tail is anchored to the sha (mismatch
  refused before anything is built or pushed). The sha defaults to the
  checkout's HEAD — in CI the checkout IS the pushed commit.
- **Builds BOTH artifacts with the marker** (the `release.sh`
  conventions): menubar `IDLEFILL_VERSION=<marker>` →
  `IdlefillMenubar-<marker>.app.zip` (bundle at zip root); desktop
  `IDLEFILL_VERSION=<numeric-release-number> IDLEFILL_DESKTOP_BUILD=<marker>`
  → `Idlefill <marker>.zip`. The desktop's `CFBundleVersion` stays the
  numeric release number (root `package.json` — Sparkle compares
  `CFBundleVersion`, never the marker); the marker goes into the new
  `__DESKTOP_BUILD__` baked literal. **No `IDLEFILL_SUPUBLICEDKEY`** —
  edge (dev) builds never carry the Sparkle key; the numbered pipeline
  is the only signer.
- **Carries the live numbered feed forward BEFORE the release
  exists:** fetches `releases/download/latest/appcast.xml` + every
  enclosure zip it references, so the edge release (the newest)
  republishes the whole current feed. Without this, `latest` would
  serve the edge release and the numbered appcast would 404 for every
  Sparkle machine. The edge zips NEVER enter the appcast — no appcast
  is generated or signed on this path (no `generate_appcast`, no key).
- **The tag is git-pushed** (the REST tag route does not exist on this
  Forgejo — `POST /git/tags` 404s), from the checkout's origin; idempotent
  re-runs reuse/repoint the tag, delete-then-create the release per
  commit (the `release.sh` pattern). Staging is `mktemp -d` (auto-cleaned
  on exit) — NEVER `~/idlefill-release-staging` (that dir belongs to the
  numbered pipeline; an edge artifact there would poison its staging-clean
  guard). A half-published run (a failure after the tag push) removes the
  orphaned tag on exit.
- **Verifies live (anonymous — the feed's real access path):** the
  appcast GETs 200 + parses (and still carries the carried-forward
  latest version); every edge zip + sidecar GETs 200 over the public
  per-tag download URL (asset names percent-encoded — the desktop zip's
  name carries a space); the recomputed sha256 of each edge zip matches
  its sidecar (live == staging == recomputed — the exact pair the
  in-app installs verify BEFORE any swap).

### `.gitea/workflows/edge.yml` (new — thin, gate-first)

- Trigger: push to a TRACKED BRANCH — `main` today; the branch list is a
  one-line variable at the top (extending is a one-line change).
- `runs-on: urza`, workflow-level `env: NODE_ENV: test` (the standing
  hermetic fix — a runner daemon started with `NODE_ENV=production` would
  make `npm ci` skip devDeps and the test suites would die),
  `concurrency: group: edge, cancel-in-progress: false`.
- **The FULL test suite runs FIRST as a hard gate** — the same step list
  as `release.yml`, copied verbatim (tests, typecheck, build, mcp
  syntax, desktop parse). The edge builds are never signed, so there is
  no signing-key pre-flight. Any red step stops the job; nothing
  publishes.
- The publish step injects `FORGEJO_TOKEN` (`secrets.FORGEJO_TOKEN ||
  secrets.GITHUB_TOKEN`, same as release.yml) and runs
  `bash scripts/edge-release.sh "edge-<branch>-<sha7>" "<sha>"`.

### `menubar/IdlefillMenubar.swift` (the menubar's channel + back-switch)

- **`ClientConfig`** gains `updateChannel` (from `update_channel`;
  nil/absent = the releases channel; same parse discipline as the other
  keys — empty string = absent).
- **`checkForUpdates()`** routes on the config's channel: absent →
  today's releases check, byte-identical; a branch name → the refs-API
  check below.
- **Branch channel (new pure logic):** `fetchBranchTip` GETs
  `<base>/api/v1/repos/sam/idlefill/git/refs/heads/<branch>` ANONYMOUSLY
  (the repo is public; the arbiter token is never sent — the
  `IDLEFILL_UPDATE_BASE` test hook applies). `branchCheck` /
  `branchUpdateMarker` (pure): the tip's marker is `edge-<branch>-<sha7>`
  of the returned sha, the branch name read from the payload's own `ref`
  (the source of truth — a config switched to a different branch simply
  sees the new branch's tip). An update is available ⇔ the baked marker
  DIFFERS from the tip marker (no ordering on branch builds: a newer
  push is a different marker, and the difference IS the update; equal
  markers → up to date). Any failure (nil payload, malformed, 404 JSON,
  malformed sha) → nil: fail quiet, nothing set, next tick retries.
- **Back-switch rule (the bug this issue exists to un-stick):** the
  releases rule used to return nil (fail quiet) for a non-numeric local
  version — so a machine baked with a non-numeric version (an edge
  marker, a dev build) could NEVER come back to the releases channel.
  Now a non-numeric local version offers the newest release
  unconditionally. Numeric local versions keep the old rule exactly
  (the `uc-test.sh` numeric cases prove it).
- **`updateAvailable` may now hold a marker** (a first-class value, not a
  malformed version); `updateChannel` rides with it. **`downloadRef`**
  gets the channel-aware overload: releases — the release's bare version
  → `v<bare>` tag + numbered zip (byte-identical to before, the
  original now delegates to the overload); edge — the marker IS its own
  tag (no "v") + the marker-named `IdlefillMenubar-<marker>.app.zip`.
- **Install reuses `UpdateCheck.install` verbatim** (sha256 verified
  BEFORE any swap; mismatch/missing sidecar refuses and keeps the
  current bundle) — only the ref resolution changed. The panel's
  exception-only `Install Update <value>` row renders for markers as-is
  (`edge-main-a9787a7` fits).

### `desktop/IdlefillDesktop.swift` (build identity + channel + UI)

- **Build marker (the menubar's placeholder pattern):** a
  `let __DESKTOP_BUILD__ = "__DESKTOP_BUILD__"` quoted literal,
  substituted by quoted-literal-only sed in `desktop/build.sh` (the same
  byte-verify guards — a surviving quoted placeholder FAILS the build).
  A fragmented sentinel (`"__DESKTOP_" + "BUILD__"`) compares the
  un-substituted value so the build's sed can never touch the
  comparison. An un-substituted build reports the default `1.0` — NEVER
  the literal placeholder (the same fail-mode as the menubar's
  `0.0.0-dev`).
- **`--version` / `-v`:** a new `@main` entry prints the baked marker
  and exits BEFORE any AppKit setup (`idlefill edge-main-a9787a7`) — an
  installed build proves its own origin. The `App` type is otherwise
  untouched.
- **Channel state:** `updateChannel` (`"releases"` default / `"branch"`)
  + `updateBranch` (default `main`) + `edgePending`, read in
  `loadConfig()` and persisted by `saveUpdateChannel()` — the EXACT
  save/preserve pattern of `saveRepoPath` (read-modify-write, pretty
  JSON, every other key preserved; a malformed channel value falls back
  to `releases`; switching away from the branch channel clears a pending
  edge offer). Config: `~/Library/Application Support/Idlefill/config.json`.
- **`checkForUpdates()`** routes on the channel: `releases` → the
  existing Sparkle flow, byte-identical; `branch` → `checkBranchUpdates`
  (the desktop's copy of the menubar's pure logic + the same anonymous
  refs check, `IDLEFILL_UPDATE_BASE`-overridable, defaulting to the host
  `kSparkleFeedURL` derives from). A mismatch sets `edgePending` and the
  status line names the tip marker; a 404 (a typo'd branch name) says
  `branch <name> not found` (operator-actionable — distinct from the
  offline silence); a DEAD network / unparseable body sets NOTHING NEW —
  the previous status is restored (the "checking …" narration must not
  outlive a dead fetch as a permanent row, and a failed fetch must not
  read "up to date"); "up to date" is reserved for a genuine refs
  response whose tip equals this build's marker.
- **Confirm + swap:** `confirmEdgeInstall` re-fetches the tip (the check
  may be stale), downloads `Idlefill <marker>.zip` + its `.sha256`
  sidecar, verifies sha256 BEFORE any swap (CryptoKit — a mismatch /
  missing / malformed sidecar refuses, keeps the current bundle, and the
  status line says so), then `runEdgeSwap` does the `desktop/update.sh`
  sequence with the build step replaced by the downloaded zip: unzip,
  quit the running app cleanly (the quit matches the TARGET BUNDLE — a
  `ps` parse over the name-matched PIDs keeping only the one whose
  executable lives in the target bundle, never a bare name match),
  replace, relaunch — driven from a DETACHED helper (stdio to null, not
  waited on: the helper reparents to launchd when the app exits, and it
  may kill the app as part of the swap). The status line narrates each
  phase the way `updateStatus` does today.
- **Settings UI:** next to the "check for updates…" row — an
  **update channel** picker (`releases` | `branch`) + a **branch** field
  (default `main`, shown only while `branch` is selected) + a save
  button; the exception-only **install edge build** confirm control
  exists only while `edgePending`. The status line's color: refusals /
  not-found / mismatches read red (operator-actionable); the note line
  now names both channels.
- **`appConfigPath()` test hook (`IDLEFILL_DESKTOP_CONFIG`):** re-points
  the config file for the headless harness. NOT optional comfort — a GUI
  app (AppKit) IGNORES the HOME environment: `NSHomeDirectory()` resolves
  to the user's real home even under `env -i HOME=<scratch>` (AppKit
  resets it from the account DB), so without this hook a harness "scratch
  config" would silently read AND WRITE the user's real config file.
  (This bit the first harness run — see Deviations; the contaminated
  file was a pure harness artifact and was removed.)

### `desktop/build.sh`

- The `__DESKTOP_BUILD__` substitution (quoted-literal-only sed, the
  menubar's byte-verify guards: a surviving quoted placeholder fails the
  build). `IDLEFILL_DESKTOP_BUILD` sets the marker; default = the
  numeric `IDLEFILL_VERSION`. `CFBundleVersion` is set EXACTLY as before
  (the numeric `IDLEFILL_VERSION`) — Sparkle compares it, never the
  marker. Build output now reports the marker.

### `menubar/uc-test.sh` (one expectation updated)

- The "malformed local version → nil (fail quiet)" expectation is the
  PRE-#26 behavior — the exact bug the back-switch rule fixes. It now
  expects the newest release (the rule's documented behavior). Every
  other case is untouched.

### `menubar/edge-test.sh` (new — the menubar harness)

Compiles the REAL source minus `@main` + a driver, `env -i` GUI
environment, scratch `IDLEFILL_CONFIG_FILE`, against canned payloads AND
a local Node.js stub of the Forgejo refs API (the
`IDLEFILL_UPDATE_BASE` hook). 34 checks: branch mode offers on marker
mismatch; equal markers → nothing; the branch name comes from the
payload's ref; unknown branch 404 / malformed sha / non-array / nil
payload → fail quiet; the real stub fetch (mismatch / equal / 404 / dead
port) through the model's launch check; the back-switch rule (non-numeric
+ dev-build locals offer the newest release) beside the UNCHANGED
numeric rule (v3-newest, same, above, two-digit, malformed payload, no
valid tags); `applyUpdateCheck` rides channel `releases`;
`downloadRef` edge (the marker IS the tag + marker-named zip) vs
releases (byte-identical to the pre-#26 rule, incl. legacy semver and
v-normalization); the edge install against the stub (correct sidecar →
verified + swapped; tampered sidecar → refused, current bundle
untouched).

### `desktop/edge-test.sh` (new — the desktop harness)

Same pattern (real source minus `@main` + driver, `env -i`, scratch
HOME + repo, the refs-API stub, the `IDLEFILL_DESKTOP_CONFIG` +
`IDLEFILL_DESKTOP_EDGE_TARGET` + `IDLEFILL_DESKTOP_EDGE_NO_OPEN` hooks —
the swap target is a SCRATCH bundle, never `/Applications`, and a
headless run spawns no GUI). 25 checks across two runs: the pure
branch-check logic (mismatch / equal / payload-derived branch / 404 /
malformed / nil); the un-substituted build reports `1.0` (never the
literal placeholder); the config round trip through the REAL
`loadConfig`/`saveUpdateChannel` (defaults when absent; channel + branch
load; malformed channel → `releases`; save preserves every other key;
trimmed branch); the REAL `checkBranchUpdates()` against the stub (the
real fetch offers the tip marker + `edgePending`; the status line names
it; the stub's 404 → the "not found" note; a pure equal-markers verdict
over the real fetched payload); the REAL `confirmEdgeInstall()` +
`runEdgeSwap()` (correct sidecar → sha256 verified BEFORE the swap + the
scratch bundle replaced; tampered sidecar → refused, the status line
says so, the current bundle untouched); and a second driver run whose
check base is a DEAD port (the offline-tolerant contract: the previous
status is restored, nothing pending, no crash, never "up to date").

### `README.md`

- **The menu bar app** — the Update check bullet now documents both
  channels (releases + back-switch rule; branch channel via
  `update_channel` in `client/config.json`; the marker-named install),
  and names `menubar/edge-test.sh`.
- **The desktop app** — the Settings tab bullet names the channel
  picker + branch field and their persistence.
- **Updating** — retitled "Updating (two channels: releases + branch)";
  a new **The branch channel (edge builds)** subsection documents the
  settings, the check (anonymous refs, marker, confirm + verify + swap,
  the 404 vs offline distinction), where the edge builds come from
  (carry-forward, no Sparkle key), and build identity (`--version`, the
  `1.0` fail-mode, `CFBundleVersion` numeric).
- **Releases & CI** — `edge.yml` added to the workflow list (gate-first,
  one-line branch list, what the publish step does).

### `.gitignore`

- `desktop/.IdlefillDesktop.versioned.swift` (the build's substituted
  source, like the menubar's versioned file).

## Verified (real output, abridged)

**Gate suite** (worktree, `NODE_ENV` unset):

```
> idlefill-server@0.1.0 test — tests 66, pass 66, fail 0
> idlefill-client@0.1.0 test — tests 30, pass 30, fail 0
> idlefill-adapter-career-ops@0.1.0 test — tests 4, pass 4, fail 0
server tsc OK / client tsc OK (tsc --noEmit, per-package)
swiftc -parse: menubar OK / desktop OK
bash -n: desktop/build.sh, scripts/edge-release.sh, menubar/uc-test.sh,
        menubar/edge-test.sh, desktop/edge-test.sh — all OK
forgejo-runner validate: edge.yml, test.yml, release.yml — all OK
```

**Existing suites** (the releases channel stays byte-identical):

- `bash menubar/uc-test.sh` — `UC-ALL-PASS`, `UC-EXIT=0` (all numeric
  cases unchanged; the one malformed-local expectation now asserts the
  back-switch rule).
- `bash menubar/edge-test.sh` — 34 PASS, `EDGE-MB-ALL-PASS`,
  `EDGE-MB-EXIT=0`.
- `bash desktop/edge-test.sh` — 25 PASS (24 + the dead-port run),
  `EDGE-DT-ALL-PASS`, `EDGE-DT-EXIT=0`, `EDGE-DT-DEADPORT-PASS`,
  `EDGE-DT-DEADPORT-EXIT=0`.

**Build marker plumbing** (built into the worktree's own gitignored
dirs — never installed):

```
menubar  IDLEFILL_VERSION=edge-main-0010274 → --version: idlefill-menubar edge-main-0010274
desktop  IDLEFILL_VERSION=2 IDLEFILL_DESKTOP_BUILD=edge-main-0010274
         → --version: idlefill edge-main-0010274 ; CFBundleVersion: 2 (numeric)
desktop  default (no env) → --version: idlefill 1.0 (NOT the literal
         placeholder) ; CFBundleVersion: 1.0
git status: no build output tracked (the ignore list is intact)
```

**LIVE round-trip** (the one live exercise — a scratch tag on this
branch's HEAD, WITHOUT touching main; credential parsed at runtime from
the profile git-credentials, never written anywhere):
`scripts/edge-release.sh edge-probe-0010274 <sha>` ran END-TO-END:

- tag git-pushed; both apps built with the marker (desktop
  `CFBundleVersion` 2, no Sparkle key); zips + sidecars staged; the live
  numbered feed (appcast + 3 zips) carried forward BEFORE the release;
  release `Edge probe 0010274` created on the tag with all 8 assets.
- Verified live (anonymous): appcast GETs 200 + parses, served by the
  newest release (the edge one) while still carrying the numbered
  versions `['2', '1', '0.0.2']`; every carried-forward enclosure GETs
  200; all 4 edge artifacts GET 200 over the public per-tag download
  URL; recomputed sha256 == live sidecar == staging sidecar for both
  edge zips — `EDGE-VERIFICATION-OK`.
- The harness's pure logic against the LIVE refs API: a
  release-baked local (`1.0`) is offered `edge-main-<sha7>`; a local
  already at the tip marker is up to date (nil).
- **Cleaned up:** the release deleted (API, 204), the tag deleted
  (remote + local). Re-verified after cleanup: the appcast is BYTE-
  IDENTICAL to the pre-state, every numbered asset still GETs 200
  (`latest` and the `v1` release's own asset), and the probe's zip now
  404s. `PROBE-ROUNDTRIP-OK`.

## Open owner decision

**The first real push to `main` activates the per-push edge publish.**
`edge.yml` triggers on push to `main` — so the moment this branch is
merged into main, that merge push publishes the first real
`edge-main-<sha7>` release (and every later push to `main` publishes one
too, replacing the previous in place — delete-then-create per commit).
That is the intended steady state (every main push is a fresh edge
build both channels' machines can see), but confirm it is what you want
before merging; the branch list at the top of `edge.yml` is a one-line
variable if you'd rather track a different set of branches.

## Eyeball checklist (owner's desktop-app pass)

Build + run the desktop app from this worktree
(`bash desktop/build.sh && open desktop/Idlefill.app`):

1. **Settings tab renders the channel option** — the "update channel"
   row (the `releases` | `branch` picker) sits next to the "check for
   updates…" row; the "branch" field (default `main`) appears ONLY
   while `branch` is selected; the save button is present.
2. **Persistence across a relaunch** — pick `branch` + a branch name +
   save; quit; relaunch. The picker still shows `branch` and the field
   still shows the name. (The config lives in
   `~/Library/Application Support/Idlefill/config.json` alongside
   `repo_path`; a hand-edited unknown channel value must fall back to
   `releases`.)
3. **The branch-check status line against the live repo, branch
   `main`** — with `branch`/`main` saved, tap **check for updates…**:
   it should say `checking main for a new build…` and settle on
   `up to date (1.0)` (no edge build is published on `main` until the
   first real push after this lands) — NOT a fetch-failure line.
4. **Refusal message on a bad branch name** — set the branch to
   `no-such-branch` + save + check: the status line says
   `branch no-such-branch not found — check the name` (red), no install
   control. (Distinct from the offline silence: kill the network, check
   again on a real branch — the previous status is restored, no error
   row.)
