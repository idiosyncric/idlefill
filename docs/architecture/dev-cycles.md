# Dev cycles — issue #53 (grilling, 2026-10-04)

The vision's biggest unbuilt piece: the owner queues a project that
resolves open issues, an automated development cycle works the list while
the owner is away, and a series of check gates keeps the cycle honest.
Today a job is ONE shot: payload file → `bash -c` executor → result line
(`runJob`, `client/src/index.ts:1083-1202` — verified). No cycle, no gate
series, no resumability, no self-improvement.

This document is the GRILL, not the build. It locks the cycle state
machine onto the primitives that already exist. The spike
(`client/test/dev-cycle-worked-example.test.ts`) proves the mapping runs
end-to-end on the noop adapter before any `client/src/` change is filed.

## The rules a cycle must not break

Restated from `docs/architecture/mesh.md` (the decision lock this sits on):

1. **Grants fail closed per engine.** A cycle never asks a second arbiter
   for a lease. Every cycle job rides the owning machine's lease loop.
2. **The session gate fails open per machine.** A cycle must never wedge
   interactive traffic.
3. **State is published, never computed remotely.** Cycle state is local
   truth. It never enters the mesh snapshot (mesh.md D1: peer snapshots
   are ephemeral; cycle rows are local, not remote).
4. **Work portability stays DEFERRED** (mesh.md D4, lines 104-115). A
   cycle runs its items and gates on the machine that owns the cycle.
   Nothing here moves a cycle to a peer.

## D1 — Cycle state machine: states map onto existing primitives

Rejected: a new cycle engine with its own states (a second scheduler
beside the lease loop — two admission brains, the exact split the mesh
lock exists to prevent).

Locked: **the cycle is a cursor over the existing queue/lease/results/
quarantine family.** A job is one attempt at one work item. A cycle is an
ordered series of items with gate jobs between them. Every state below is
an existing primitive read or written; the ONLY new artifact is the cycle
row itself (D4).

### The core table

| Cycle state | Truth lives in | Existing primitive |
|---|---|---|
| cycle defined, not started | cycle row `status: "planned"` in `<queue_file>.cycles.json` | atomic tmp+rename write (the `writeQueue` pattern, `client/src/index.ts:237-241`) |
| item queued | one `queue.jsonl` line; payload carries `cycle_id` + `stage` | queue row (`readQueue`/`writeQueue`, `client/src/index.ts:221-241`) |
| item attempt running | active lease from `POST /api/leases` | lease (unchanged grant path, `client/src/index.ts:913-928`) |
| item attempt failed, retry armed | queue line's `attempts` bumped | `bumpJobAttempts` (`client/src/index.ts:286-296`) + arbiter per-job cooldown (`server/src/arbiter.ts:916-939`) |
| item attempt exhausted | `quarantine.jsonl` line | `quarantineJob` (`client/src/index.ts:304-317`), `MAX_ATTEMPTS = 3` (`client/src/index.ts:219`) |
| gate queued | one `queue.jsonl` line, `stage: "gate:<name>"` | queue row (same as an item) |
| gate running | active lease | lease (gates get idle-gating, preemption, budget for free) |
| gate verdict recorded | the gate job's result line in `results.jsonl` | `appendResult` (`client/src/index.ts:356-359`) |
| item quarantined by a gate | `quarantine.jsonl` line, `error: "gate_<name>_failed"` | `quarantineJob` — same file, a different reason string |
| item passed | cycle row cursor advances | cycles file rewrite |
| cycle paused | cycle row `status: "paused"` | cycles file rewrite (the client-pause override stays the operator's blunt tool; the row is the per-cycle tool) |
| cycle done | cycle row `status: "done"` | cycles file rewrite |

Transitions are driven by ONE new loop (the cycle driver, D7) that reads
results and appends the next queue line. The lease loop is untouched: it
leases whatever the queue holds, idle-gated as today.

## D2 — Cycle truth: client-side, in the queue/results family

Rejected: cycle rows in the arbiter's `state.json`. The arbiter may live
on another machine (the Mac-client shape registers to urza's arbiter).
The executor runs where the client runs. A cycle whose truth lives away
from its executor cannot survive the machine that owns it going to sleep.

Locked: **cycle truth is client-side**, next to the queue, same atomic-
write discipline as `writeQueue` and `writeRebuildState`
(`client/src/index.ts:416-422`).

Grilled against the two failure scenarios:

- **Arbiter restart.** The arbiter's leases die; the client's poll sees
  the lease gone from `active_leases` and tears down
  (`client/src/index.ts:882-885`). The queue file and the cycles file
  never left the client. The re-register heartbeat restores the client
  row. The cycle resumes from its own files. This is already the crash
  posture the daemon header states: "the queue file is the source of
  truth" (`client/src/index.ts:57-59`).
- **Machine sleep.** The client daemon suspends; the arbiter (awake on
  urza) lets the lease TTL expire — an unknown outcome, never a job
  failure (`server/src/arbiter.ts:913-914`). The job stays in the queue.
  On wake, the poll loop resumes, re-registers, and re-leases the same
  queue line. The cycle cursor never moved.

Server-side cycle truth would also break mesh rule 3: a peer arbiter
would hold decisions about another machine's work. Client-side truth
keeps every cycle inside its own machine's authority.

## D3 — Gate model: gates are jobs

Rejected: gate steps stored inside the cycle row and run by the cycle
driver itself. That re-implements executor supervision a second time —
a second path that bypasses idle-gating, preemption, the daily budget,
and the anti-thrash stack. Two schedulers deciding when a process runs
is the failure mode the whole arbiter design avoids.

Locked: **a gate is a queue job with a gate-shaped payload.** The gate
executor runs under the same lease, the same timeout machinery
(`runExecutor`, `client/src/index.ts:491-579`), and the same result-line
contract. The cycle driver reads the gate's result line and applies the
cycle row's gate rule to it.

The verdict split matters: the executor's `ok` says "the check RAN".
The gate rule says "the check PASSED". A build gate whose build failed
is an `ok:true` result line carrying a failing fact — the checker worked,
the verdict is no. The spike models exactly this: the noop adapter
echoes the gate's declared fact, and the driver's rule decides.

Gate failure quarantines the item, not the cycle:

- The gate job is its own `job_id`. Its failures bump ITS attempts and
  can throttle IT (`recordJobFailure`, `server/src/arbiter.ts:916-939`;
  a throttled job is refused every grant until `unthrottleJob`,
  `server/src/arbiter.ts:405-406, 1001`). Other jobs are untouched.
- On a failing verdict the driver quarantines the ITEM via the existing
  `quarantineJob` helper with reason `gate_<name>_failed`. The operator
  audit trail is the same file the retry-quarantine already writes.
- The cycle row's cursor advances to the next item. The cycle never
  stops because one item failed a gate.

This extends the throttle/cooldown vocabulary exactly as the issue
asks: per-job cooldown and throttle already isolate ONE job's failures;
the quarantine file already isolates ONE job's exhaustion. A cycle adds
one reason string. No new state.

## D4 — Resumability: what a cycle row persists

Locked: the cycles file is `<queue_file>.cycles.json` — one file per
project, next to the queue, exactly like `<queue_file>.rebuild.json`
(`rebuildStateFile`, `client/src/index.ts:391-393`). It holds an array
of cycle rows. Each row carries:

- `cycle_id`, `project`, `status` (`planned | running | paused | done`)
- the ordered item list: each item's `job_id` and its gates (name,
  gate `job_id`, and the gate RULE written verbatim — the Phase 2 seam,
  D8)
- the cursor: current item index + current stage

That is the minimum for a restart to resume mid-series. The driver
rebuilds the rest from ground truth on every tick: the queue file says
whether the current stage's job is still queued; the results file says
whether it already settled. The cursor never trusts memory.

Corrupt-tolerance posture, identical to `state.json`
(`server/src/state.ts:96-105`) and `readRebuildState`
(`client/src/index.ts:396-413`): a corrupt cycles file reads as an empty
list — the driver does nothing, fail-closed for cycles, and the daemon
keeps draining the queue normally. The queue/results/quarantine files
keep their per-line corrupt-skip rule (`readQueue`,
`client/src/index.ts:229-231`). Writes are tmp+rename in the same
directory (`writeQueue` pattern), so a crash mid-write leaves the last
good file.

## D5 — MCP surface: cycle-shaped tools in the existing family

The career-ops MCP server (`adapters/career-ops/idlefill-mcp.mjs`) today
exposes six queue tools (`idlefill_add_jobs`, `idlefill_queue_status`,
`idlefill_results`, `idlefill_remove_jobs`, `idlefill_clear_queue`,
`idlefill_job_lookup`). Issue #15 already built the extension point:
discovered tool modules merge into the tool table and flow through the
same per-project policy (issue #14).

PROPOSED (the owner should weigh core-vs-module): cycle tools ship as a
**discovered tool module**, not core tools. The gate-rule vocabulary is
project-shaped, and the module path is exactly what issue #15 exists
for. The tool set:

| Tool | Shape | Policy class |
|---|---|---|
| `idlefill_create_cycle` | name + ordered items + per-item gate rules → writes a cycle row | write-bearing (joins the `WRITE_TOOLS` set rule, `idlefill-mcp.mjs:129`) |
| `idlefill_edit_cycle` | change items, gate rules, or status on one cycle | write-bearing |
| `idlefill_pause_cycle` / `idlefill_resume_cycle` | flip one cycle row's status | write-bearing |
| `idlefill_list_cycles` | cycles + cursors + per-item verdicts | read-only |
| `idlefill_cycle_status` | one cycle: cursor, queue position, gate verdicts, quarantine facts | read-only |

Every tool follows the family's existing rules, verified in
`idlefill-mcp.mjs`: config resolved at call time (never baked),
`dry_run=true` previews without writing, fresh-read classification
against the LIVE queue (the `add_jobs` rule), per-project
`mcp.enabled`/`tools`/`allow_write` policy, and
`IDLEFILL_MCP_READ_ONLY=1` blocks every write tool. The cycle tools
write ONLY the cycles file. They never touch leases or the arbiter.

## D6 — Unattended posture: fail closed on the verdict, fail open on the cycle

The operator is away. There are no interactive approvals. Two rules:

1. **Gate ambiguity is NOT a pass.** A gate job that is preempted,
   times out, loses its lease, or exits with no result line has an
   UNKNOWN verdict. The driver never advances the cursor on unknown.
   The job stays in the queue for the retry path (the daemon already
   keeps failed jobs queued, `client/src/index.ts:1126-1186`); at
   `MAX_ATTEMPTS` the item quarantines. Honest verdicts beat progress.
2. **The cycle never wedges.** A quarantined item, a throttled gate
   job, or a paused cycle stops THAT row. The driver advances to the
   next item and the next cycle. This mirrors mesh rule 2 (the session
   gate fails open per machine): the machinery always keeps moving;
   only verdicts fail closed.

Interaction with the session gate: a cycle job is ordinary background
work. Interactive traffic preempts its lease exactly as today
(`server/src/arbiter.ts:562-584`); the preempted gate re-queues and the
cycle waits. The cycle adds no new path to the proxy or the gate.

## D7 — Explicit split: what changes vs what stays untouched

Changes (client/queue family only):

- `client/src/index.ts`: ADD a cycles-file reader/writer pair (the
  `readRebuildState`/`writeRebuildState` shape) and a cycle driver loop
  fired from the poll tick — the exact `maybeRunScheduledRebuilds`
  pattern (`client/src/index.ts:963-971`): cadence check per tick,
  fire-and-forget, never blocks the tick.
- Queue payloads GAIN `cycle_id` and `stage` keys. The payload is open
  vocabulary (`[k: string]: unknown`, `client/src/index.ts:163`), so no
  schema change and no wire change.
- MCP: the cycle tool module (D5).
- Dashboard surfacing (later, additive): cycle counts ride the
  client-published `stats` block on register — the arbiter displays,
  never computes.

Stays UNTOUCHED (hard line):

- The lease loop and grant path (`tickOnce`, `client/src/index.ts:845-929`).
- `runJob`, `runExecutor`, teardown, preemption escalation.
- The arbiter's admission core: idle verdict, reidle gate, concurrency
  cap, preemption, per-job throttle/cooldown, budgets.
- The session gate and the loopback proxy.
- `state.json`'s shape (ADD keys only, never rename — the back-compat
  rule from mesh.md D1).
- The mesh read plane. Cycle rows never federate.

## D8 — Phase 2 self-improvement: the seam, build nothing

An agent reviews prior cycle sessions over MCP and improves the gate
rules. The only Phase 1 requirement that serves it: **the cycle row
stores each gate's rule verbatim** (D4). A reviewer reads
`idlefill_cycle_status` + `idlefill_results` + the quarantine file,
diffs verdicts against outcomes, and rewrites rules through
`idlefill_edit_cycle`. No new machinery is needed for that loop, so
nothing is built for it now.

## Consequences for the filed issues

- The spike (this issue) proves D1/D3/D4 on the noop adapter with zero
  `client/src/` changes. The build wave adds the driver loop and the
  cycles file helpers.
- The MCP cycle module belongs with the issue #15 extension point, not
  with the lease core.
- The dashboard cycle strip is an ADD-keys change to the register
  heartbeat, same discipline as `last_rebuild`
  (`client/src/index.ts:750-771`).

## Pitfalls for the implementation wave

- The cycle driver must never spawn executors itself. Gates are jobs
  (D3) or the design is wrong.
- The driver must re-read queue + results every tick. A cursor that
  trusts memory across ticks breaks the restart story (D4).
- A gate job that succeeds (`ok:true`) is removed from the queue by the
  daemon like any success. Quarantining the item AFTER that success is
  still correct: `quarantineJob` appends the audit line even when the
  queue line already left (`client/src/index.ts:304-317`).
- Do not reuse `scheduled_rebuild` run-state files for cycles. One
  rebuild file per project, many cycle rows per project — different
  shapes, different cadence.
- `client/package.json`'s `test` script lists test files explicitly.
  The build wave must add the new test file to that list (the spike
  file could not be registered here — outside this issue's allowed
  paths).

## Decisions (owner, 2026-10-04)

1. **In-flight cycles per project: configurable, default one.** New
   config knob `cycle_max_in_flight` (default 1). One cursor per cycle
   row already holds. The driver's admission rule caps how many cycle
   rows may hold a running stage at once. Expanding past one is filed
   as issue #56 (multi-cycle concurrency: admission rule, budget
   interaction, N-cycle status shape).
2. **Budget: a cycle inherits the project's daily budget as-is.
   LOCKED.** No cycle-level cap in v1.
3. **Gate short-circuit: skip. LOCKED.** On a failing gate the driver
   quarantines the item and skips that item's remaining gates. The
   quarantine reason string already names the failing gate.
