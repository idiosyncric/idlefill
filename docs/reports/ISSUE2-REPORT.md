# Issue #2 report — score-ordered dispatch + add_jobs response echo (gaps 1 + 3)

Branch: `issue-2-score-echo` (verified with `git symbolic-ref --short HEAD` as the first command).
Worktree: `/Users/sam/orca/workspaces/idlefill/issue-2-score-echo` (main checkout at `~/Software/idlefill` untouched).
Commit: `823340f` (no push, no merge).

## Changes

### Gap 1 — score-ordered dispatch (client daemon, selection-only)

`client/src/index.ts`:
- **New pure exported helper `priorityOrder(jobs)`** (next to `nextJob`/`readQueue`): returns a NEW array sorted by `payload.score` DESC; `null`/`undefined`/non-number score treated as `-Infinity` (sorts last); ties keep file order (stable sort = FIFO tiebreak). Never mutates the input.
- **`nextJob`** now returns `priorityOrder(readQueue(file))[0] ?? null` — the daemon requests the lease for the highest-score job even when `add_jobs` appended it at the tail.
- **`queuePreview`** now runs the queue through the SAME `priorityOrder` helper before slicing, so the registration payload the dashboard shows as "priority order" matches dispatch order.
- **No on-disk re-sort**: `writeQueue` untouched — the queue file keeps its file order; ordering is selection-time only.

### Gap 3 — add_jobs response echo (career-ops MCP adapter)

`adapters/career-ops/idlefill-mcp.mjs`:
- New `addedEcho(jobs)` helper; the `added` field of the add_jobs response — **both dry_run and real** — is now an array of `{job_id, url, company, title}` built from the STORED job (the `toAdd` payload values, i.e. exactly what lands in the queue file), not bare ids and not the raw input echo.
- Tool description updated: score documented as "the daemon dispatches highest-score-first, FIFO tiebreak" (was "for ordering context"), plus a line documenting the stored-job echo.
- Every other response field unchanged.

Out of scope respected: no server changes, no remove/clear/lookup tool edits, no queue-file rewrites, no dashboard HTML.

## New tests

- `client/test/priority-order.test.ts` (new, wired into `client/package.json` test script): 5 unit tests — score DESC; null/missing/garbage/NaN score sort last; stable ties keep file order; purity (new array, input untouched); `nextJob` picks the tail high-score job while the on-disk order stays unchanged.
- `client/test/lease-loop.test.ts`: new lease-loop test against the existing fake arbiter — queue file head is `prio-low` (11), tail is `prio-high` (95); asserts the daemon's FIRST lease request is `prio-high`, then that the remaining queue lines keep their on-disk file order (selection-only proof).
- `adapters/career-ops/mcp.test.mjs`: dry_run + real `added` assertions updated to the object shape, plus byte-compare of every echoed field (`job_id`, `url`, `company`, `title`) against the stored queue-file line, and `dry_run echo === real echo`.

## Gate output

### Baseline (before any change, at base commit 9fe06e1)

```
> idlefill-server@0.1.0 test   ℹ tests 80  ℹ pass 80  ℹ fail 0
> idlefill-client@0.1.0 test   ℹ tests 37  ℹ pass 37  ℹ fail 0
> idlefill-adapter-career-ops  ℹ tests 4   ℹ pass 4   ℹ fail 0
> idlefill-adapter-noop@0.1.0  ℹ tests 2   ℹ pass 2   ℹ fail 0
```
Baseline total: 123 tests, 0 fail.

### Final (`NODE_ENV= npm run test` from the worktree root)

```
> idlefill-server@0.1.0 test   ℹ tests 80  ℹ pass 80  ℹ fail 0
> idlefill-client@0.1.0 test   ℹ tests 43  ℹ pass 43  ℹ fail 0
> idlefill-adapter-career-ops  ℹ tests 4   ℹ pass 4   ℹ fail 0
> idlefill-adapter-noop@0.1.0  ℹ tests 2   ℹ pass 2   ℹ fail 0
```
Final total: 129 tests, 0 fail = baseline 123 + 6 new (5 priority-order units + 1 lease-loop). The adapter test count stays 4 because gap 3 extends the existing session test in place (byte-compare assertions added inside it).

### Typecheck + build

```
NODE_ENV= npx tsc --noEmit -p client   → clean (exit 0)
NODE_ENV= npm run build                → clean (server tsc, exit 0)
```

### Port hygiene

No test bound 18792 (the fake arbiter uses an ephemeral loopback port; nothing was ever started on 8787/3000). Post-run check: `lsof -nP -iTCP:18792 -sTCP:LISTEN` → empty.

## Deviations

None. Notes:
- The lease-loop test flips the fake arbiter busy while the first job settles, so the "first lease request" assertion can't race a second claim — same pattern the existing clean-failure test uses.
- `queuePreview`'s doc comment was corrected (it previously claimed file order IS priority order; after this change dispatch order is computed, not file order).
