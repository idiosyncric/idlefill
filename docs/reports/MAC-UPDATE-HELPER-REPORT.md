# macOS update-helper gap — the shim chain names itself (issue #89 follow-up, 2026-10-13)

The sentence this pass chased, from ISSUE89-UPDATE-CLI-REPORT.md: "both updater
configs rewired to `idlefill update` (urza live via its absolute shim path
…; Mac config prepared, the macOS helper itself named as an uninstalled
gap)". The task read as "make the macOS side install/reinstall the
`idlefill` PATH shim as part of update.sh". Reading update.sh, the cli
workspace bin wiring, and how the urza helper re-installs its shim showed
the gap is THREE shapes, not one.

## What the gap turned out to be

1. **Code, half-landed.** `update.sh` ALREADY re-runs
   `scripts/install-cli.sh` — step 5, commit `7c43c10` (owner ask
   2026-10-12, cli.md D8 amendment). The live machine proves it:
   `~/.local/bin/idlefill` exists, carries the `idlefill-cli-shim` marker,
   `IDLEFILL_CLI_REPO="/Users/sam/Software/idlefill"`, and `~/.local/bin`
   is on PATH. "Install the shim in update.sh" needed no new code — what
   was missing was the **honesty half**:
   - step 3's `npm run build --workspace cli` was a bare set -e death —
     no one-time devDeps guard (the fresh-checkout trap urza-selfupdate.sh
     learned in #89), and no **named refusal** on build failure; the
     installed shim would keep serving the old dist with zero explanation;
   - neither update.sh nor the CLI asked the PATH-honesty question urza's
     rewire got answered (config carries the ABSOLUTE shim path because
     the rendered unit's PATH lacks the shim dir): on the Mac, what does
     the BARE NAME `idlefill` actually resolve to, and is it the shim this
     run just wrote? A shadowing file or an off-PATH
     `IDLEFILL_CLI_BIN_DIR` was silently possible.
2. **Code, one line missing on the native path.** `native-selfupdate.sh`
   rebuilds cli/ but never re-ran `install-cli.sh` — the narrative ("both
   host helpers re-install the shim") was true of `urza-selfupdate.sh`
   only. Fixed: the installer re-runs right after the rebuild, before any
   unit restarts (idempotent no-op on urza; a foreign target is a named
   refusal that aborts fail-closed).
3. **Doc, not state.** The #89 report's "Mac config prepared" claim is
   documentation-shaped: `~/.idlefill/updater.json` is **NOT on this
   machine** (ls-verified — the dir holds no such file). The report is
   corrected in place: the Mac has no helper config at all; the
   uninstalled-helper gap and "the CLI is the Mac update path" law stand.
   The macOS LaunchAgent renderer for `host-updater.mjs` remains an open
   deploy-side gap, unchanged and honestly named in the #89 report;
   `deploy/install-updater-service.sh` refuses macOS by name ("on macOS
   use a LaunchAgent around scripts/host-updater.mjs").

## What landed

- **update.sh step 3** — one-time `NODE_ENV= npm install --workspace cli`
  when `node_modules/.bin/tsc` is absent (urza's guard, ported), and both
  install and build failures are named refusals naming the law: "the
  idlefill PATH shim must never serve a stale dist … nothing in
  /Applications was touched".
- **update.sh step 5** — `install-cli.sh`'s own named refusals (write |
  byte-identical no-op | different-checkout | foreign-file, atomic render
  + marker re-read, never a dangling target) are now wrapped in a step-5
  refusal naming that /Applications is untouched, and AFTER the install
  the run reads `command -v idlefill`: if the bare name resolves anywhere
  other than the shim just installed (`${IDLEFILL_CLI_BIN_DIR:-$HOME/.local/bin}/idlefill`
  — the installer's default mirrored, no new PATH dir invented), the
  note names exactly what WOULD run and what to do. A note, not a failure:
  the update itself landed.
- **cli/src/update.ts** — the PATH-honesty decision as a pure table
  (cli.md D4 shape): `probeShimText` (marker line + `IDLEFILL_CLI_REPO`
  line; broken/foreign named), `firstOnPath` (bash `command -v` walk,
  empty entry = cwd), `decideShimChain` (ok / installed-off-path /
  not-installed / foreign-path / broken-shim / wrong-checkout), and
  `describeShimChain` as D3 exception-only voice — the two honest
  postures (`ok` and `installed-off-path`, which IS urza's documented
  absolute-path config posture) stay silent; every mismatch names itself
  before the wrapper execs the update command. The install dir is
  `join(homedir(), '.local', 'bin')` — this machine's home, never a
  baked absolute path. README "Updating" steps 3/5 and the cli.md D8
  amendment carry the same law.

## Gates

- `NODE_ENV= npm run test` → **1075/1075** (cli **147/147**, +8 pure
  shim-chain tests: probe table incl. broken/empty-repo, firstOnPath
  order/cwd/non-exec skip, the full verdict table, voice silence vs
  naming, home-relative install dir); baseline 1067 + 8, 0 fail.
- `NODE_ENV= npx tsc --noEmit -p cli/tsconfig.json` clean;
  `NODE_ENV= npm run build` green (cli/dist is gitignored — nothing to
  commit; dashboard/tauri untouched).
- `bash -n update.sh` and `bash -n scripts/native-selfupdate.sh` clean.

## How the shim chain was verified without touching production

Nothing ran against the live shim, the real `~/.local/bin`, or
/Applications; the update chain (pull/rebuild/swap/relaunch) was NEVER
invoked. All writes went to a scratch dir under the OS temp area.

1. **Checkout-relative render:** `IDLEFILL_CLI_BIN_DIR=$SCRATCH bash
   scripts/install-cli.sh` FROM THE WORKTREE → the shim's
   `IDLEFILL_CLI_REPO` is the worktree path — resolved from the script's
   location, proving no hard-coded path; re-run → "byte-identical — clean
   no-op, zero writes".
2. **Live shim byte-honesty:** the MAIN checkout's install-cli.sh rendered
   into scratch; `cmp` against the live `~/.local/bin/idlefill` → **byte
   identical**. So the next real `./update.sh` lands step 5 as the named
   no-op — the fix rides the natural install moment.
3. **Never clobber, never dangle:** a foreign file planted at a scratch
   target → "NOT an idlefill shim (no … marker line) — refusing to touch
   it", exit 1, foreign file intact.
4. **Scratch shim serves the worktree dist:** `$SCRATCH/bin1/idlefill
   --help` renders the help tree; `… update --check` answers
   "up to date at af7f035 — … AHEAD of Release #4 (v4 at 2de1b9c)" — the
   read-only path (feed GET + installed-binary `--version`), proving
   shim → dist → dispatcher → update group live, without any exec of
   update.sh.
5. **update.sh's new blocks, verbatim:** the PATH-honesty block extracted
   from update.sh by awk ran under both PATH states — shim dir off PATH →
   names the actual resolver (the real `~/.local/bin/idlefill`) against
   the scratch target, exit 0; shim dir on PATH → silent. The step-3 block
   extracted verbatim ran with an npm stub failing the build → the named
   refusal line + exit 1.
6. **cli chain decision against the live machine, no exec:** importing the
   BUILT worktree dist and running `describeShimChain(decideShimChain(
   detectShimChainFacts()))` → verdict `wrong-checkout` with both repos
   named (PATH serves `/Users/sam/Software/idlefill`, this invocation runs
   the worktree) — exactly right from a worktree; from the main checkout
   the same call is `ok`/silent, and on urza it is `installed-off-path`
   (silent, documented posture).

## Named non-evidence

- The full `./update.sh` was NOT run (this is the production Mac — it
  would rebuild and relaunch the installed app). Its two new bash blocks
  were verified by verbatim extraction + harness, and its shim-install
  step was byte-proven as a no-op for the live machine.
- The live `idlefill update` wrapper exec was not run (same reason); its
  chain-note wiring is pinned by the pure tables + the built-dist
  decision call above.
- The one-time `npm install --workspace cli` guard ran nowhere (the
  worktree has tsc); it is the code path urza-selfupdate.sh already runs
  in production, ported verbatim.
- The macOS LaunchAgent renderer (mesh-update.md D3) remains uninstalled
  and unrendered — named in the #89 report's open gaps, untouched here by
  design (this pass closes the shim chain, not the helper plane).
