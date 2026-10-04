Map: #53 (dev cycles — the vision's biggest unbuilt piece) · #50 (mesh lock, D4 work portability) · #13/#15 (adapter + MCP extension points) · Type: wayfinder:grilling

## What landed

The decision document is `docs/architecture/dev-cycles.md` (mesh.md
format: D1-D8, chosen option + rejected alternative + deciding trade-off
per decision, the state→primitive core table, the explicit split, open
questions). The spike is `client/test/dev-cycle-worked-example.test.ts`.

## Decisions settled

- **D1 (locked):** the cycle is a cursor over the existing
  queue/lease/results/quarantine family. Every state maps onto an
  existing primitive; the only new artifact is the cycle row.
- **D2 (locked):** cycle truth is client-side, in
  `<queue_file>.cycles.json`, next to the queue. Grilled against
  arbiter restart and machine sleep — both resume from the client's own
  files. Server-side truth would break mesh rule 3.
- **D3 (locked):** gates are jobs, not steps inside the cycle row. A
  gate runs under the normal lease, so idle-gating, preemption, budget,
  and anti-thrash apply for free. A failing gate quarantines the ITEM
  (existing `quarantineJob`, reason `gate_<name>_failed`) and the cycle
  continues. No new state.
- **D4 (locked):** the cycle row persists cursor + items + gate rules
  verbatim. Corrupt-tolerance identical to `state.json` /
  `readRebuildState`: corrupt reads as empty, fail-closed for cycles.
- **D5 (proposed):** cycle MCP tools (`create/edit/pause/resume/list/
  status`) ship as a discovered tool module (the issue #15 seam), under
  the issue #14 per-project policy.
- **D6 (locked):** unattended posture — verdicts fail CLOSED (unknown
  never advances the cursor), the cycle machinery never wedges (mirrors
  mesh rule 2).
- **D7 (locked):** the split. The lease loop, `runJob`, `runExecutor`,
  arbiter admission, the session gate, and `state.json`'s shape stay
  untouched.
- **D8 (recorded):** Phase 2 self-improvement needs only the seam —
  gate rules stored verbatim, editable via `idlefill_edit_cycle`.

## Spike result (acceptance item 2)

The worked example — "resolve open issues in repo X", 3 items x 2 gates,
item 2's build gate fails and quarantines exactly one item while the
cycle finishes — runs end-to-end on the REAL noop adapter through the
fake arbiter, with ZERO changes under `client/src/` or `server/`. The
spike also proves: resumability (a driver rebuilt from the persisted
cycles file resumes mid-series and never re-leases a settled stage),
fail-closed on an unknown verdict (an unsettled gate parks the cursor;
no later item enqueues), and corrupt-cycles-file tolerance.

**Finding: the spike needed no src changes.** The state machine maps
onto the existing primitives as designed. One registration gap:
`client/package.json`'s `test` script lists test files explicitly, and
that file is outside this issue's allowed paths — the spike file is NOT
yet in the suite. The build wave must add it (noted in the doc's
pitfalls).

## Verification (actual output)

- Spike alone: `npx tsx --test test/dev-cycle-worked-example.test.ts` →
  4 tests, 4 pass, 0 fail.
- Full suite: `unset NODE_ENV && npm run test` → server 113/113, client
  61/61, career-ops 15/15, noop 2/2. Total 191 pass, 0 fail.
- `npx tsc --noEmit` in `client/` → clean.

## What the build wave adds

The cycles-file reader/writer pair + a driver loop fired from the poll
tick (the `maybeRunScheduledRebuilds` shape), the MCP cycle tool
module, and the test-file registration. Nothing else moves.

## Owner decisions (2026-10-04)

The owner reviewed the grill and locked the three open questions. In-flight
cycles per project: configurable via `cycle_max_in_flight`, default one.
Budget: a cycle inherits the project's daily budget as-is; no cycle-level
cap in v1. Gate short-circuit: skip; a failing gate quarantines the item
and skips that item's remaining gates. Expanding past one in-flight cycle
is filed as issue #56 (multi-cycle concurrency: admission rule, budget
interaction, N-cycle status shape). The spike file is now registered in
`client/package.json`'s `test` script; the client suite count rose from
61 to 65.
