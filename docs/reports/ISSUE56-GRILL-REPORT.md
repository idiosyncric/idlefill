Map: #56 (multi-cycle concurrency) · #53 (the locked dev-cycle grill, decisions 1-3) · #58 (the shipped cycle driver this addendum verifies against) · Type: wayfinder:grilling

## What landed

The decision addendum is `docs/architecture/dev-cycles.md` — one new
section, `## D9 — Multi-cycle concurrency (issue #56 addendum)`, with
D9.1/D9.2/D9.3 in the mesh.md format (chosen option + rejected
alternative + deciding trade-off per decision). The spike extension
adds ONE end-to-end test to
`client/test/dev-cycle-worked-example.test.ts`: two cycles on one
project, one set of ground-truth files, real daemon + real noop
adapter + fake arbiter. No changes under `client/src/`, `server/`, or
`adapters/` — the cap is a client-side driver rule and the build wave
owns any code change.

## Decisions settled

- **D9.1 (locked):** a row holds a stage when the queue file carries
  its current stage job. The cap counts holding rows. Every citation
  verified against the shipped `CycleDriver.tick()`
  (`client/src/index.ts:613-639`), `resolveCycleMaxInFlight`
  (`client/src/index.ts:528-547`), and `maybeRunCycleDrivers`
  (`client/src/index.ts:1391-1410`). **The shipped implementation
  already IS the locked rule — it needs no change for a cap above
  one.** The count covers granted-and-running stages too, because a
  leased job keeps its queue line until it settles
  (`client/src/index.ts:1583`). Rejected: counting lease state
  (second source of truth), arbiter-side enforcement (breaks D2).
  Stated plainly: the cap pipelines admission. One daemon runs one
  executor at a time, so true parallel stages need a multi-lease
  client (open question 1).
- **D9.2 (locked):** the daily budget bounds the project, shared
  across cycles. Verified: the grant check sums the project
  (`server/src/arbiter.ts:473-474`), the budget record is keyed by
  project + UTC day with no cycle key anywhere
  (`server/src/arbiter.ts:1265-1267, 1290-1295`). Owner decision 2
  stays true at N > 1. The operator learns: cycles compete for one
  pool (grants deny `budget_exhausted` project-wide), never split it,
  and the interactive gate is never starved. Interactive traffic
  needs no lease, and session activity preempts even mid-stage,
  `server/src/arbiter.ts:578-589`). Rejected: a per-cycle split —
  needs cycle-keyed arbiter state, against D2 and owner decision 2.
- **D9.3 (locked):** per-cycle entries on every surface, no merged
  progress line. The shipped MCP pair already complies:
  `idlefill_list_cycles` returns `{ ok, project, cycles_file, count,
  cycles[] }` with per-row cursor/verdicts (module lines 220-232),
  `idlefill_cycle_status` returns one cycle's full view plus
  `current_stage` (lines 234-270). The dashboard cycle strip is
  verified NOT built: `server/public/index.html` has zero "cycle"
  occurrences. Shape rule stated: ADD a `cycles` key to the
  client-published `stats` block (`client/src/index.ts:1108-1114`).
  The arbiter displays, never computes, and adds no arbiter state. The
  exact key set is PROPOSED (open question 2).

## Spike result (acceptance item 2)

One new test: "multi-cycle concurrency (D9.1/D9.3)". Three phases on
two cycle rows over the SAME queue/results/state files, each row with
its own cursor, driven by a spike `MultiCycleDriver` that mirrors the
shipped `tick()` shape (it does not import the shipped driver — the
shipped unit test `test/cycle-driver.test.ts` already covers the cap
itself):

- Cap 1: cycle A's stage parked via `denyLeaseAfter` — cycle B's
  first stage never enters the queue while A holds. Repeated ticks
  keep the queue at one holder. After the park lifts, both cycles
  finish and the queue never held two cycle stages at once.
- Cap 2: both first stages admitted on the first tick, both rows
  `running`, all eight stages leased through the arbiter, both cycles
  `done` with clean verdicts.
- Independence: one failing gate quarantines ONE cycle's item
  (`gate_build_failed`, one quarantine line project-wide). The other
  cycle's verdicts and its full gate series are untouched, and the
  short-circuit skips only the failing item's remaining gates.

The spike modeled two concurrent cycles with ZERO `client/src/`
changes — no missing primitive.

## Verification (actual output)

- `unset NODE_ENV && npx tsc --noEmit -p client/tsconfig.json` →
  clean.
- Spike alone: `npx tsx --test test/dev-cycle-worked-example.test.ts`
  → 5 tests, 5 pass, 0 fail (was 4 before this extension).
- `NODE_ENV= npm run test -w client` → 78 tests, 78 pass, 0 fail
  (baseline 77). The spike's count rose by exactly the new test.

## Open owner questions

1. Cap > 1 pipelines admission only — one daemon runs one executor.
   File multi-lease client work (true parallel stage execution) as
   its own issue, or keep cap > 1 as pipelining only?
2. Dashboard cycle strip (unbuilt): accept the proposed
   `stats.cycles` count keys, or prefer per-cycle rows in the
   published stats block?
