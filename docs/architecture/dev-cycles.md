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

## D9 — Multi-cycle concurrency (issue #56 addendum)

Owner decision 1 set `cycle_max_in_flight` (default 1) and filed this
addendum for expansion past one. This section settles the three named
questions: the admission rule at a cap above one (D9.1), the daily
budget interaction (D9.2), and the status shape for N cycles (D9.3).
Every citation below was verified in this session against the shipped
issue #58 code. The spike extension in
`client/test/dev-cycle-worked-example.test.ts` runs two cycles over
one project against the real daemon, the real noop adapter, and the
fake arbiter.

### D9.1 — Admission rule: the shipped driver already IS the locked rule

Locked: **a cycle row holds a stage when the queue file carries that
row's current stage job. The cap counts holding rows. A row may start a
stage only while the number of holding rows sits under
`cycle_max_in_flight`.**

Verified against the shipped code:

- `CycleDriver.tick()` (`client/src/index.ts:613-639`) re-reads the
  cycles file and the queue file on every step. The `inFlight` helper
  (`client/src/index.ts:624-629`) counts rows with status `running`
  whose current stage job sits in the queue. The admission gate
  (`client/src/index.ts:635`) skips a non-holding row when that count
  already reaches the cap. A holding row never re-enqueues — its stage
  line already sits in the queue.
- The cap is read from the per-project `cycle_max_in_flight` entry of
  the raw client config by `resolveCycleMaxInFlight`
  (`client/src/index.ts:528-547`). The key's presence is also the
  project's opt-in: absent means null, and `maybeRunCycleDrivers`
  (`client/src/index.ts:1391-1410`) never touches that project's
  cycles file. A present but invalid value falls to 1. The daemon
  fires one driver step per project per poll tick
  (`client/src/index.ts:1205`), building the driver fresh from the
  files each tick (D4).
- The count covers granted-and-running stages as well as merely
  queued ones. A leased job keeps its queue line until it settles.
  The success path removes the line (`client/src/index.ts:1583`). The
  failure path keeps it and bumps `attempts`
  (`client/src/index.ts:296-306, 1595-1604`). Only the quarantine path
  removes it (`client/src/index.ts:314-327`). One queue-file lookup
  therefore names every holder, queued or running. The arbiter stays
  out of the count — the cap is a client-side driver rule (owner
  decision 1).

So the shipped implementation needs NO change for a cap above one. The
spike's `MultiCycleDriver` mirrors `tick()` exactly and proves the
behavior end-to-end: with cap 1 the second cycle's first stage never
enters the queue while the first cycle holds one. With cap 2 both
first stages reach the queue and both cycles lease through the
arbiter.

Rejected alternatives:

- Count only granted-and-running stages. That needs a second source
  of truth for "running". The queue file already carries it, and a
  driver that cross-checks lease state breaks D4's ground-truth rule.
  The deciding trade-off: one file, one truth.
- Enforce the cap in the arbiter. Rejected by D2 and owner decision
  1: cycle truth is client-side, and the arbiter holds no cycle rows.
  The deciding trade-off: a cycle must survive the machine that owns
  it going to sleep.

What the operator must know: the cap admits stage lines, not executor
slots. One daemon runs one executor at a time — the busy-return at
`client/src/index.ts:1236` stops the lease loop while a lease is
active — and the arbiter caps grants per engine with
`max_concurrent_leases` (`server/src/arbiter.ts:469-471`). A cap of 2
pipelines two cycles' stage lines into the queue. The stages still run
one at a time on one machine. True parallel stage execution needs a
multi-lease client, out of scope here (open question 1).

### D9.2 — Budget: the daily budget bounds the project, shared across cycles

Locked: **the per-project daily budget covers every cycle of the
project together. N cycles share one pool. Nothing about the budget
changes when the cap rises past one. This restates owner decision 2
for N > 1.**

Verified against the shipped arbiter:

- The grant check sums the project, never a cycle.
  `const used = this.projectTokensOut(params.project, utcDay(now));`
  and the denial `budget_exhausted` on
  `used >= project.daily_token_cap` (`server/src/arbiter.ts:473-474`).
- The budget record is keyed by project and UTC day:
  `state.budgets[project][day].tokens_out`
  (`projectTokensOut`, `server/src/arbiter.ts:1265-1267` and
  `addBudget`, `server/src/arbiter.ts:1290-1295`). No cycle key exists
  anywhere in the arbiter. `requestLease` (`server/src/arbiter.ts:372`)
  receives the project and the job_id only. `cycle_id` rides the queue
  payload (D7) and never reaches a grant decision.

Rejected alternative: a per-cycle split of the cap. That needs
cycle-keyed budget records in the arbiter — new arbiter state about
another machine's work, against D2 and mesh rule 3. It contradicts
owner decision 2 (no cycle-level cap in v1). The deciding trade-off:
the single operator reasons about one daily pool per project, and the
arbiter stays cycle-blind.

What the operator must know at a cap above one:

- Cycles compete for one pool. One cycle's heavy item can exhaust the
  UTC day for every cycle of the project. Every later grant then
  denies `budget_exhausted` (`server/src/arbiter.ts:474`) until the
  day rolls over. Competition, never a split, is the guarantee: the
  pool always goes to whoever asks first.
- The competition never starves the interactive gate. The budget only
  refuses background grants at lease-request time. Interactive traffic
  needs no lease, and session activity preempts an active lease even
  mid-stage (`server/src/arbiter.ts:578-589`).
- Failure isolation stays per job. A throttled or cooling job blocks
  only its own re-grants (`server/src/arbiter.ts:420-427`). A dead
  gate in one cycle cannot throttle another cycle's jobs. The spike's
  third phase shows the same isolation for quarantine: one failing
  gate quarantines one item, and the other cycle's verdicts stay
  clean.

### D9.3 — Status shape: one entry per cycle, no merged progress line

Locked: **every status surface carries per-cycle entries. No surface
merges N cycles into one progress line.** The shipped MCP pair already
follows the rule. The add-keys rule below keeps the unbuilt dashboard
on it.

Verified against the shipped MCP module
(`adapters/career-ops/idlefill-mcp-cycle-tools.mjs`):

- `idlefill_list_cycles` returns `{ ok, project, cycles_file, count,
  cycles[] }`, and each entry carries `cycle_id`, `status`, `cursor`,
  `items` (a count), and `verdicts` (lines 220-232). No field
  aggregates cursors or verdicts across rows.
- `idlefill_cycle_status` returns ONE cycle: `cycle { cycle_id,
  status, cursor, verdicts, items[] }` plus `current_stage` (lines
  234-270). Each stage fact carries the live queue position and the
  quarantine fact. The queue positions already record `cycle_id` from
  the queue payload (line 96), so every cycle queue line is
  attributable to its cycle.
- Verdicts and quarantine facts are per cycle row and per item (D4,
  D3). The quarantine file is project-wide, but each line names its
  own job, and the row's `verdicts` map is private to the row. The
  spike's third phase asserts both.

The dashboard cycle strip is BUILT (`server/public/index.html` renders a
per-worker Cycles section; `docs/reports/ISSUE53-CYCLE-STRIP-REPORT.md`
records the build + live verification). The shape rule it shipped with:
cycle rows ride the client-published register heartbeat as a `cycles`
key — one entry per cycle row (this section's locked rule; the
per-status-count variant below is the PROPOSED key set the owner's
build-wave pick resolved toward per-cycle rows), plus a sibling
`cycle_cap` carrying the effective `cycle_max_in_flight` (0 = knob
absent). Both computed client-side from the project's cycles file. The
arbiter stores and displays them verbatim, never computes (the
`last_rebuild` discipline, D7). `state.json` gains nothing: no new
arbiter state.

Rejected alternative: an arbiter-side cycle rollup. Rejected by D2 —
the arbiter may live on another machine and holds no cycle rows. The
deciding trade-off: display honesty over query convenience, the same
reason the queue preview is published, not read.

PROPOSED (owner input wanted): the exact `stats.cycles` key set. The
rule — per-cycle entries, add-keys only, client-computed — is locked.
The naming, and whether the strip shows counts or per-cycle rows, is
a build-wave choice (open question 2).

### Open questions (owner input)

1. A cap above one pipelines admission only: one daemon runs one
   executor, so stages still run one at a time per machine (D9.1).
   File multi-lease client work — true parallel stage execution — as
   its own issue, or leave cap > 1 as pipelining only?
2. For the dashboard strip: accept the proposed `stats.cycles` count
   keys, or prefer per-cycle rows in the published stats block? The
   MCP surface already answers per-cycle detail either way.
