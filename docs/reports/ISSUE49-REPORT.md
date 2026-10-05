# Issue #49 — Daemon code-staleness flag

Detection, not auto-restart, exactly as the issue proposed: the daemon
reports the commit its running process loaded code from; the surfaces
compare it against their own checkout HEAD and flag the mismatch. The
one-click restart (menubar Restart row / desktop "restart daemon") stays
the operator's gate — no lease is ever interrupted automatically.

## What was built

**Daemon (`client/src/revision.ts`, `client/src/index.ts`)**
- `resolveRevision()` runs `git rev-parse HEAD` once at startup, anchored
  on the entry dir the same way `version.ts` resolves the repo root
  (dev + dist layouts). Best-effort: no git / not a repo / any failure →
  `undefined`, never a throw.
- The register handshake carries `revision` (the FULL 40-char SHA) as a
  top-level field next to `version`/`protocol`. Non-git checkouts omit
  the key entirely.

**Arbiter (`server/src/arbiter.ts`, `server/src/api.ts`, `types.ts`)**
- `registerClient` sanitizes it like `version`: string ≤64 chars,
  malformed → dropped, absent → no field. First registration stores it;
  re-registration (the heartbeat) updates it — so a daemon restart moves
  the row within one tick. Registration is never rejected for it.
- `/api/state` echoes it on the client row (spread carries it) and
  `projectView` adds it exception-only to the per-project worker row.
  The arbiter only stores + echoes — it has no view of client repo trees.

**Surfaces (client-side comparison, per the issue)**
- Menubar (`menubar/IdlefillMenubar.swift`): pure `AppModel.daemonBehind
  (reported:checkout:)` — mismatch → true; full-SHA-vs-its-short-prefix
  → false (same commit); absent on either side → false (an old daemon
  renders exactly as before). The poll compares the name-matched row's
  `revision` against this checkout's CURRENT HEAD and the panel shows an
  exception-only amber `daemon behind` row under `revision`. Side fix:
  `deployedRevision` is now refreshed on each poll tick — its "only
  Update Code changes it" premise is exactly what a direct merge/pull
  breaks; a stale cache would hide the very exception this feature shows.
- Desktop (`desktop/IdlefillDesktop.swift`): same pure rule; the poll
  compares MY client row's `revision` against a fresh
  `git rev-parse --short HEAD` in `repoRoot`; the STATE tab shows the
  exception-only `daemon behind` row (amber), next to the existing
  Settings "restart daemon" affordance.

## Harness + build output

- `client/test/revision.test.ts` — NEW, wired into the client suite:
  dev + dist layouts resolve the real repo HEAD; no-git → undefined;
  failing git binary → undefined; the real daemon registers with
  `revision` = the repo HEAD at start (full 40-char SHA).
- `server/test/api.test.ts` — store/clear/invalid-dropped matrix:
  register WITH revision echoes on client row + worker row; register
  WITHOUT keeps 200 and no key (old daemon); >64-char and non-string
  dropped, never rejected; a later valid report updates the row; an
  omitted field leaves the stored row untouched.
- `menubar/staleness-test.sh` — NEW (panel-test.sh pattern, scratch GIT
  repo, real HEAD): 9 pure-rule cases + 4 real-model cases via
  `injectStatePayload` (mismatch → tag; this checkout's HEAD → cleared;
  no revision → renders as before; another machine's row cannot drive
  this machine's flag). Result: `STALENESS-ALL-PASS` (13/13).
- `desktop/staleness-test.sh` — NEW (sessions-test.sh pattern, Sparkle
  vendored): 8 pure-rule cases + 3 real-model cases. Result:
  `STALENESS-DT-ALL-PASS` (11/11).
- Gates at this commit: `npm test` all workspaces — 126 / 76 / 17 / 2
  pass, 0 fail. `npx tsc --noEmit -p server/tsconfig.json` +
  `-p client/tsconfig.json` — clean. `npm run build` — clean.
  `swiftc -parse` both Swift sources — clean. Existing menubar
  harnesses re-run green after the poll-tick revision refresh:
  `panel-test.sh` PANEL-ALL-PASS, `scope-test.sh` SCOPE-ALL-PASS,
  `sessions-test.sh` SESSIONS-ALL-PASS.

## Live verification (2026-10-05)

The issue's live instance was real: the deployed daemon predated the
gate-state merge and silently never sent the `gate` block.

- Arbiter redeployed via the standard path (visible Orca tab, wrapper,
  `IDLEFILL-DEPLOY-DONE-rc0`): image `idlefill-server:086f196` on urza,
  healthcheck pass, both remotes pushed.
- Daemon kickstart (`launchctl kickstart -k gui/$(id -u)/
  com.sam.idlefill.client`, 0 active leases confirmed first) brought up
  the #49 client: the live client row now reads
  `revision: 086f196e1ea9ee…` — the full boot SHA, matching the repo
  HEAD at boot. Absent before the restart; present after.
- Stale→clear cycle exercised for real: after a further docs commit
  advanced the tree to `f1bc4c8` WITHOUT touching the daemon, the
  arbiter row still reported `086f196` → mismatch (the surfaces' pure
  prefix rule flags it: `behind=true`). One `kickstart -k` later the
  row reported `f1bc4c8` → `behind=false`, cleared within one
  heartbeat, exactly as specified. The daemon now runs at the tree's
  HEAD; the flag is clear.

## Back-compat

Old daemon → no `revision` key anywhere, every surface renders as
before. Old arbiter → ignores the extra body key (FastAPI-style pass-
through; the register handler reads only known keys). Malformed →
dropped at the edge, never a rejection.
