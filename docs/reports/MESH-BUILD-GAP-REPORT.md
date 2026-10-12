# Mesh build-gap — the commits-behind counter (owner ask 2026-10-12)

> "Since we are still tracking updates against the current commit hash,
> can we just show a counter for how many commits behind a peer is?"

## Shipped (738f784, pushed origin + github)

- **Publisher side** (`server/src/revision.ts`): each arbiter resolves its
  boot revision once — `IDLEFILL_REVISION` env first (the git-less
  container path; `deploy-server.sh` + `urza-selfupdate.sh` now bake the
  image tag's sha at swap AND rollback), else `git rev-parse HEAD` at the
  checkout the module runs from. Shape gate `/^[0-9a-f]{4,64}$/` at
  publish AND sanitize — a hex sha or the key stays absent; a hostile
  peer cannot plant a fake build identity.
- **Snapshot**: `GET /api/mesh` gains the `revision` ADD key (wired at
  boot through the new optional `ApiDeps.serverRevision`; every existing
  unwired `buildApi` caller — every pre-existing test — stays
  byte-for-byte).
- **Observer side** (`MeshFederation.buildGapFor`): the arbiter adds a
  `build` key to its own `mesh.peers[]` rows by counting
  `git rev-list --count <peer>..<local>` / `<local>..<peer>` on its OWN
  checkout — no remote, no hub. Cached per (local|peer) revision pair
  (two git calls per pair for a process lifetime, not per view; a
  restart or machine update changes a side and the pair re-counts).
- **Words** (decision table `decideBuildGap`, pure + injected counter):
  `behind` = the peer's build lacks N commits this machine already runs
  (the update word); `ahead` = honest mirror, the viewer is the stale
  one; `diverged` = neither is a fast-forward of the other; `same` RIDES
  the wire — "up to date" is the counter's confirmed zero, not a
  silence; `unknown` = the shas cannot be ordered from here → "builds
  differ", never a fake number. Prefix equality (full sha vs the baked
  `--short` a container publishes, ≥7 hex) short-circuits to `same`
  before any git call. Garbage shas never reach git argv (shape gate +
  `RANGE_RE` before `spawnSync`).
- **Surfaces**: Machines peer card gains the build line (behind/diverged
  warn-toned, the rest dim; the tooltip names the counting rule and the
  honest absences); `idlefill mesh status` gains
  `build <sha7> · N behind this machine` under the header (pure, absent
  silent for pre-key rows).
- **Docs**: dated clause under D2 of `mesh.md`.

## Honesty bounds (named, not smoothed)

- "N behind" counts commits **between the two builds**, not behind
  origin — if both machines lag the remote, the number is relative to
  the viewer. Neither side needs a remote to count; that is the point of
  the local-rev-list design.
- A peer that predates the key, or a git-less arbiter that never got
  `IDLEFILL_REVISION`, reports nothing: no build line, no `build` key,
  never a fake zero.
- The observer's own absence (no boot revision here) kills the `build`
  key too — the counter says nothing it cannot prove.
- The counter does not auto-poke the update button; the operator still
  clicks it (the two-step arm stands).

## Tests

- server 487 → **493** (+7): publish/sanitize shape gates, decideBuildGap
  decision table (incl. prefix short-circuit + garbage-never-reaches-git
  fence), `makeRevListCounter` against a REAL throwaway git repo (counts
  2 commits, unknown object → null, argv shape gate), `view()` build-key
  wiring (same rides, no-local absent, per-pair cache pin),
  `/api/mesh` wired-vs-unwired.
- cli 97 → **99** (+2): `buildGapLine` word table incl.
  absent-peer-silence; `renderPeerRows` build line.
- dashboard 56 → **57** (+1): all six relations of `buildGapLine`.
- Gates: repo **990/990**, `npm run build` green, `tsc --noEmit` green
  (server/client/cli/dashboard), dashboard dist regenerated (served
  bundle — the established pattern).

## Live evidence (production)

- mac `738f784` + scanbot `738f784` (pulled + restarted): both answer
  `revision: 738f7847…` at `/api/mesh`; mac's merged view carries
  `build: {relation: "same"}` on scanbot — the confirmed zero renders.
- urza (container predating the change): no `revision`, no `build` key —
  honest absence, exactly the pre-key posture; the next urza swap through
  the (updated) self-update script bakes its sha and the counter
  activates there.
- The behind counter's fixture IS this report commit: after it lands and
  the mac arbiter restarts, the Machines tab shows scanbot
  `build 738f784 · 1 behind` (warn); one click of the two-step update
  button relays the intent, the helper pulls + restarts scanbot, and the
  line zeroes to `up to date`. (The behind→zero transition itself is the
  standing demo; unit tests pin every word of the decision table.)
