# Issue #89 — S2: `idlefill update` / `update --check` (operator CLI, the last open slice)

Landed 2026-10-12/13 (commit `2d469b0`, direct-to-main, pushed to both
remotes). Design authority: `docs/architecture/cli.md` D4 (LOCKED); the
feed contract is `docs/architecture/shell-updater.md` D2/D3; the intent
plane law (no command rides the wire) is `docs/architecture/mesh-update.md` D2.

## What ships

**`cli/src/update.ts`** — the `update` group, implemented:true:

- `idlefill update --check` (read; takes `--json` per D3). Anonymous GET
  of the release feed — the exact URL from `scripts/release.sh` /
  shell-updater.md:
  `https://git.samwarth.com/sam/idlefill/releases/download/latest/latest.json`.
  The feed is sanitized against the D3 shape (object, SemVer version,
  non-empty platforms); anything malformed is a **named outcome, never a
  fake zero** — including an HTTP error or unreachable host.
  The installed marker is read from the bundle binary contract
  (`/Applications/Idlefill.app/Contents/MacOS/idlefill-app --version` →
  `idlefill <short sha>`; the same contract update.sh step 4 writes and
  tauri/build.sh gate 4 byte-verifies). The release commit is resolved
  from the local git tag `v<N>`; a checkout without the tag says so.
  Named answers: "up to date at <sha>" (equal), "up to date at <sha> —
  the installed build is AHEAD of Release #N" (git proves the tag is an
  ancestor of the marker), "Release #N available (<sha>)" (behind), and
  an explicit "named, not guessed" when git cannot place the two. On a
  machine with no installed app (the Linux arbiter host) it names that
  absence. Touches nothing; exit 0 for a true named comparison, 1 when
  the read itself failed.
- `idlefill update [--no-pull]` — a WRAPPER, not a re-implementation
  (D4). It execs THIS machine's documented update command and passes the
  exit code through. `--no-pull` reaches update.sh untouched. There is
  no `idlefill update <peer>` — the mesh intent plane stays the
  dashboard's (plane discipline honored).

**Registry/help/docs**: `dispatch.ts` flips `update` to implemented:true
(slice/issue stay in the table); `help.ts` carries the real usage tree;
`cli.md` marks the S2 row shipped; README "Updating" and the wave status
lines updated.

**`scripts/urza-selfupdate.sh`** (the owed urza prerequisite): after the
"already at TAG" no-op and BEFORE the container swap it now rebuilds the
`cli/` workspace (`npm install --workspace cli` only when
`node_modules/.bin/tsc` is absent) and re-runs `scripts/install-cli.sh`
(idempotent) — fail-closed, mirroring update.sh step 3's posture: the
PATH shim must never serve a stale dist after a host update.

## The Linux-wrapper design decision (named, per the brief)

**Choice: the CLI resolves which script is THIS machine's documented one**
— platform first, docker presence second, named refusal otherwise:

1. `darwin` → `./update.sh` (if the checkout lacks it, named refusal).
2. `linux` + docker on PATH → `scripts/urza-selfupdate.sh` — the
   documented host-helper command (mesh-update.md D3).
3. `linux` without docker → named refusal: "this box has no documented
   update command" (no container to swap; nothing runs).
4. anything else → named refusal naming the platform.

`--no-pull` is refused by name on the Linux path — the host helper always
hard-resolves to origin/main; there is no rebuild-in-place mode there.
macOS-with-docker still picks update.sh: the platform decides before the
docker probe, so a Mac with Docker Desktop is never ambiguous.

Rejected alternative: leaving each `updater.json` pointed at the raw
script. That keeps the old behavior but splits the operator voice in
two (`idlefill update` vs. the helper's string), and the point of this
slice is one documented verb. The D2 law is untouched either way: the
command string never crosses the wire — the helper's own 0600 config
owns it, and now it names `idlefill update`.

## The two updater configs

- **urza (live, verified):** `~/.idlefill/updater.json` `command` rewired
  from `bash /home/sam/idlefill/src/scripts/urza-selfupdate.sh` to
  `/home/sam/.local/bin/idlefill update` (token untouched, never
  printed; mode stays 0600). PATH honesty checked against the rendered
  systemd unit: its `Environment=PATH=/usr/bin:/usr/local/bin:/usr/bin:/bin`
  does NOT include `~/.local/bin`, so the config carries the ABSOLUTE
  shim path; the shim execs `node` which IS on that PATH (`/usr/bin/node`).
  The unit was restarted to pick up the config, then driven live (below).
- **Mac (named gap):** there is no `~/.idlefill/updater.json` here —
  the macOS host-helper was never installed (no LaunchAgent for it;
  `launchctl` shows none, and mesh-update.md D4 says This Machine
  updates by the operator's own command line). The config was created
  anyway with `command = /Users/sam/.local/bin/idlefill update` (0600,
  token read from `server/config.json` at write time, never echoed), so
  the rewire is ready if the macOS helper plane is ever rendered — but
  the honest state is: **no macOS helper runs today; the CLI itself is
  the Mac update path.**
  - **Correction (2026-10-13, mac-update-helper pass):** that "created
    anyway" config does NOT exist on this machine — `ls ~/.idlefill`
    names no `updater.json`. Whether it was never persisted or was
    removed since, the claim could not be re-verified and the doc is
    corrected against the live machine instead of trusted: the Mac has
    **no helper config at all**, so "Mac config prepared" was
    documentation-shaped, not state. The uninstalled-helper gap and the
    "the CLI itself is the Mac update path" law stand, unchanged and
    now honestly documented (see MAC-UPDATE-HELPER-REPORT.md for the
    shim-side gap this same pass closed).

## Gates

- Baselines: cli 99 → **cli 132** (+33), repo 1006 → **1006 + 33 = 1039**,
  all green before the push; `npx tsc --noEmit -p cli/tsconfig.json` clean;
  `npm run build` green; `bash -n scripts/urza-selfupdate.sh` clean.
- New pure-helper tests (`cli/test/update.test.ts`, 32): argv table; feed
  sanitizer (real-shape accept, non-JSON/array/null/missing-version/
  bad-SemVer/empty-platforms refusals); marker parser (contract, full
  sha, garbage); the marker-compare decision table (equal-prefix/ahead/
  behind/unmatched with an injected ancestry probe); human wording for
  every kind; `--json` payload posture (ok true/false, named reason);
  the wrapper decision table (mac/no-update.sh, linux+docker,
  linux-without-docker, missing helper script, `--no-pull` refusal,
  mac+docker, unknown platform); real-fs stub scripts in a scratch dir
  proving exit-code passthrough (3, 9, 0) and argv forwarding; spawn
  failure = named exit 1.
- `dispatch.test.ts`/`help.test.ts` flipped from "planned" assertions to
  "live" assertions (update group live; top help names no planned
  slices).

## Live chain proof

1. **Mac, against the live feed:** `idlefill update --check` →
   `up to date at 7c43c10 — the installed build is AHEAD of Release #4
   (v4 at 2de1b9c): nothing newer is published` (exit 0); `--json`
   carries `decision: "ahead"`, the release ref, and the marker read
   from the /Applications binary. No git guesswork: the tag resolves
   locally, ancestry proved by `git merge-base`.
2. **urza, through the real intent plane:** the Mac arbiter relays
   `{"action":"update"}` → urza records intent `u-9ce0f948` (202 queued).
   The restarted helper claimed it and ran
   `running update command: /home/sam/.local/bin/idlefill update` — and
   the FIRST run FAILED with exit 2: the old dist said "not implemented
   yet — lands in S2 (issue #89)". That failure IS the proof of the
   stale-dist gap this slice closes. The one-time `npm run build
   --workspace cli` + `install-cli.sh` (byte-identical no-op) was run;
   the second intent (`u-3f442557`) named the same refusal; the third
   (`u-3a39aec5`) ran the real chain: wrapper →
   `scripts/urza-selfupdate.sh` → cli rebuild (dist mtime matches the
   run window) → `docker build idlefill-server:2d469b0` → swap →
   healthcheck → `update succeeded … updated: idlefill-server:2d469b0`
   → `result reported: done`. urza's arbiter now runs the shipped build.
3. **urza marker posture:** `/home/sam/.local/bin/idlefill update --check`
   names it honestly: "Release #4 is the latest published (v4 at
   2de1b9c) — this machine has no installed Tauri app to compare
   against"; exit 0, nothing invented.

## Named non-evidence

- The bare macOS wrapper (`idlefill update` → update.sh) was NOT run
  live: it would rebuild and relaunch the installed app mid-session.
  Its selection path is unit-tested against the real repo files; the
  Linux wrapper ran live twice.
- The feed-unreachable branch is pinned by tests only (no network
  simulation against the live host).
- The Mac `updater.json` is a prepared config, not an executed one (no
  macOS helper unit exists — the gap is named above) — and per the
  correction above, the file is not even present on the machine, so
  even "prepared" overstates it.

## Open gaps named for the owner

- macOS host-helper (LaunchAgent around `host-updater.mjs`) has no
  renderer yet — mesh-update.md D3 names it but nothing installs it.
  If it should exist, it is a deploy-side slice; the config it would
  read is already correct on this machine.
- The wrapper bootstrap order is inherent: a machine whose CLI dist
  predates S2 cannot run `idlefill update` until its dist is built
  once (done on urza now; every subsequent update self-heals because
  both wrapped scripts rebuild the cli workspace before anything else).
