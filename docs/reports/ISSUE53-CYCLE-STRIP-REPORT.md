# #53 dashboard cycle strip — build report

The last unbuilt piece of the dev-cycles map (`docs/architecture/dev-cycles.md`,
D9.3 "Status shape" + the dashboard paragraph). Cycles that a client's
CycleDriver works now surface on the per-machine dashboard: client publishes
per-cycle rows from its own cycles file → the arbiter stores + echoes them
verbatim → the dashboard renders one row per (worker, project, cycle).

## What was built

### 1. Client publishes cycles (`client/src/index.ts`)

- NEW exported `CycleStatusRow` + `publishCycles(queueFile, projectName,
  fromDir)` next to the cycles-file helpers: one entry per row in the
  project's cycles file, file order. Fields: `cycle_id`, `status`,
  `items_total` (items array length), `item_index` (the stored
  `cursor.item`, 0-based — the dashboard renders +1), `settled`
  (`Object.keys(verdicts).length`), `passed` / `quarantined` (counts by
  verdict value), `stage` (`cursor.stage`, `'item' | 'gate'`).
- `cycle_cap`: the effective `cycle_max_in_flight` via
  `resolveCycleMaxInFlight` — `0` when the knob is absent (a published
  fact, not a blank).
- Exception-only: the register heartbeat's per-project entry gains the
  sibling keys `cycles` + `cycle_cap` ONLY when there is something to
  publish (no cycles file, an empty list, or only unusable rows → neither
  key rides). Array capped at 20 entries (`CYCLE_PUBLISH_MAX_ROWS`).
  Best-effort like `queuePreview`: the whole block is wrapped and NEVER
  throws; junk rows are skipped per row (the cycles file reads
  unvalidated — `readCycles` fail-closes only on corrupt JSON, a
  valid-JSON array of junk rows reaches the publisher, so row shape is
  guarded there).
- The register payload site is the per-project object next to `stats` and
  `last_rebuild`. `CycleDriver`, the cycles-file helpers, the MCP tools,
  and the gate rule engine are untouched.

### 2. Server stores + echoes verbatim (`server/src/types.ts`, `server/src/api.ts`)

- `types.ts`: NEW `CycleStatusRow` (the arbiter-side shape of the card's
  keys) and `ProjectAllocation` gains optional `cycles?: CycleStatusRow[]`
  + `cycle_cap?: number`. Add-keys only; no renames; `state.json` gains no
  new top-level state — the rows ride inside the existing client-row
  project entries.
- `api.ts` register: `cleanCycles` mirrors `cleanPreview` / `cleanRebuild`
  — array only, ≤20 rows, rows failing shape checks are dropped (cycle_id
  trim ≤128, status ∈ planned|running|paused|done, all numeric fields
  finite integers ≥ 0, stage ∈ item|gate); `cleanCycleCap` (finite integer
  ≥ 0, else the key drops). Both wired into the projects map exactly like
  `last_rebuild`. No new route, no new state file, no arbiter-side
  computation.
- `projectView`: worker rows echo `cycles` + `cycle_cap` with the same
  exception-only spread as `last_rebuild`.

### 3. Dashboard cycle strip (`server/public/index.html`)

- New `#cycles-section` ("Cycles"), placed between Projects and Sessions —
  beside the Machines/queue family. Exception-only: `display:none` while
  no worker row carries a non-empty `cycles` (the mesh/sessions
  convention: hide, not clear).
- `renderCycleStrip(st)` groups one block per (worker, project): the head
  carries the worker liveness dot, project name, worker name, and the
  per-project `cap N` note (exception-only: a missing `cycle_cap` key
  renders nothing; a published `0` renders "cap 0"). One row per cycle:
  cycle_id, status word colored by the existing semantics (running =
  accent, planned = dim, paused = warn, done = ok), progress
  `item (index+1)/items_total`, the stage word, and the verdict tallies
  (`N passed`, `N quarantined` in err color — each omitted at zero).
- Values render verbatim from the existing 5s `/api/state` poll. The ONLY
  arithmetic on the page is the +1 display. No new fetch, no new timer, no
  chart/JS libraries; CSS rides the page's own tokens.

## Decisions honored

- **D2 / D7 (client-side truth, store-don't-compute):** every cycle number
  is computed client-side from the client's own cycles file; the arbiter
  sanitizes for shape/bounds and stores the values verbatim; the page
  renders them verbatim. The arbiter never opens a cycles file and holds
  no cycle state of its own.
- **D4 (cycles file shape):** the publisher reads the shipped `readCycles`
  rows — nothing about the file format changed.
- **D9.3 (status shape):** one entry per cycle row everywhere — wire,
  state, and strip. No merged progress line anywhere; no rollup in the
  arbiter or on the page.
- **Owner picks (the card): per-cycle entries, strip rows not counts.**
  The D9.3 PROPOSED `stats.cycles` per-status COUNT keys are superseded by
  the shipped per-cycle rows (open question 2, answered by this build).
  The keys ride as siblings of `stats` (`cycles` / `cycle_cap` on the
  project entry), which matches the card and keeps `stats` unchanged.
- **Multi-lease stays pipelining-only (open question 1): no new issue
  filed.** D9.1 already documents that cap > 1 pipelines admission only;
  this build changes no execution path.
- Back-compat: pre-strip clients send neither key; the heartbeat replaces
  the per-project allocation, so both keys drop cleanly when a worker
  stops reporting cycles (asserted in the API test).

## Gates (real output)

- `NODE_ENV=test npm run test` (root, all workspaces): **server 128,
  client 83, career-ops 17, noop 2 — 230 pass, 0 fail.** (The client list
  registered the NEW `client/test/cycle-publish.test.ts` — 6 tests:
  publishCycles tallies/cap/absent/junk/20-cap units + one real
  ClientDaemon → fake-arbiter heartbeat test asserting `cycles` +
  `cycle_cap` ride the register body and BOTH keys are absent with no
  cycles file.) Existing stats/preview/last_rebuild tests untouched
  (server 126 → 128: the two new cycle tests only).
- `NODE_ENV=test npm run build`: OK.
- `npx tsc --noEmit` in client/ and server/: zero errors.
- Dashboard inline script: `node --check` OK, plus the repo's
  **dashboard-script-testing** stub-DOM harness (scratch, per the recipe):
  **23/23 assertions** — seeded payload renders exactly 4 cycle rows in 2
  groups with verbatim values (`item 2/3`, stage word, status-word classes
  accent/dim/warn/ok, `1 passed` + err `1 quarantined`, zero tallies
  omitted, `cap 2` / `cap 0` group heads); a cycles block WITHOUT a cap key
  renders rows but no cap note; an empty payload hides the section; the
  harness counts exactly one `/api/state` GET per tick and zero
  cycle-specific fetches.

## Live verification (evidence path: embedded browser + seeded JSON)

Throwaway arbiter on scratch ports — never the live urza deployment, never
the repo's gitignored `server/config.json`: fake activity feed on :8798,
arbiter on :8797 via `IDLEFILL_CONFIG` (state file in scratch), zero
WARNING lines in its boot log. `POST /api/clients/register` carried a
4-row `cycles` block + `cycle_cap: 1` for `career-ops`.

- **`/api/state` verbatim echo:** a byte-for-byte compare of the sent
  block against BOTH views — the raw client row and the projectView
  worker row — returned `true` (`cycles` equal, `cycle_cap` equal). Saved:
  `~/.hermes/profiles/web-dev/cache/scratch/seeded-state.json` (full) and
  `seeded-state-slim.json` (the cycle rows).
- **Orca embedded browser** (`orca tab create` → page `6a81267b…`): after
  re-heartbeat + one 5s tick, DOM eval asserted: section computed
  `display: block`, 1 group head `career-ops | live-cyc-client | cap 1`,
  exactly 4 rows —
  `resolve-open-issues | running | item 3/5 · item · 2 passed · 1 quarantined`,
  `harden-gates | planned | item 1/2 · item` (zero tallies omitted),
  `docs-sweep | paused | item 2/3 · gate · 1 quarantined`,
  `old-cleanup | done | item 3/2 · item · 2 passed` — status classes
  `accent / dim / warn / ok` exactly as designed.
- **Exception-only hide, live:** a heartbeat WITHOUT the block → section
  computed `display: none` within one poll tick; re-registering the block
  brought it back.
- **Clipping settled per the skill recipe:** `getBoundingClientRect()`
  overflow math reports `section.scrollWidth ≤ clientWidth` and every row
  ending 15px inside the section border; a zoomed crop
  (`cycle-strip-crop.png`) re-analyzed with vision confirms no text cut at
  the border. (A full-page vision read flagged the flush right-aligned
  column as "clipped" — the rects + crop disprove it; right-flush is the
  page's existing `.kv` convention.)
- Screenshots committed: `docs/reports/cycle-strip-live.png` (full page,
  seeded strip visible) and `cycle-strip-crop.png` (zoomed panel).
- The scratch tab was closed and both scratch servers stopped (ports
  8797/8798 confirmed clear). `item 3/2` on the done row is honest
  verbatim rendering: the driver advances `cursor.item` past the last
  item when a cycle finishes; the page never clamps published values.

## Doc update

`docs/architecture/dev-cycles.md` (the D9.3 dashboard paragraph): the
"verified NOT built" sentence now says the strip is BUILT and points here.
The locked doc's shape RULES were kept as written; the paragraph's earlier
"per-status row counts … are the expected content" wording — the D9.3
PROPOSED key set the card itself supersedes with per-cycle rows — was
marked superseded rather than left to contradict the shipped build. The
rest of the locked doc is untouched.

## Boundaries respected

No Swift/menubar changes, no MCP changes, no CycleDriver-internal, gate
rule engine, `/api/metrics`, `/api/mesh`, or `state.json` top-level
changes. No live deployment touched, no tags, no release. Files changed:
`client/src/index.ts`, `client/test/cycle-publish.test.ts` (new),
`client/package.json`, `server/src/types.ts`, `server/src/api.ts`,
`server/test/api.test.ts`, `server/public/index.html`, this report,
`docs/reports/README.md`, `docs/architecture/dev-cycles.md`.
