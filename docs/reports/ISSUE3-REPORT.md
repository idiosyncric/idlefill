# ISSUE3-REPORT — scheduled scan → queue rebuild loop

**Branch guard:** `git symbolic-ref --short HEAD` → `issue-3-rebuild-loop` (verified as first command). Worktree: `/Users/sam/orca/workspaces/idlefill/issue-3-rebuild-loop`. Main checkout `/Users/sam/Software/idlefill` untouched. Ports 8787/3000 never bound; 18794 never needed (all tests use ephemeral loopback ports) — `lsof -nP -iTCP:18794 -sTCP:LISTEN` verified empty.

## What was built (settled decisions 1–6, daemon shape only)

A per-project scheduled queue-rebuild loop in the client daemon:

1. **Config key** — `scheduled_rebuild: { enabled, command, every_minutes }` on each
   `ClientProjectConfig` (`client/src/config.ts`). `parseScheduledRebuild()` defaults
   `every_minutes` to 60 when enabled without it; `enabled: true` with a missing/blank
   command is treated as disabled (the daemon never invents a command). Documented in
   `client/config.example.json` (`_docs.scheduled_rebuild` + example project key).
2. **Cadence = minimum interval since last run**, checked on the existing poll tick
   (`tickOnce` → `maybeRunScheduledRebuilds()` in `client/src/index.ts`). The check reads
   the persisted run-state file, so the cadence survives daemon restarts. The check runs
   before the lease-loop gates, so a rebuild fires even while a job holds a lease or the
   box is busy — the queue refills for the NEXT grant. Fire-and-forget: the tick never
   blocks on the command.
3. **Black-box command** — run via `runExecutor` (the executor's existing timeout
   machinery: `bash -c`, detached process group, SIGINT→grace→SIGKILL) with a 15-minute
   cap (`REBUILD_TIMEOUT_MS`) and cwd = the project's `cwd` (same default as the
   executor). The daemon never parses the command's output or any project files; the only
   contract is the exit code. A timed-out rebuild records `exit_code: -1`.
4. **Guards (generic)** — (a) nonzero exit: the daemon never touches the queue; the
   failure is recorded in run state and logged loudly. (b) empty-source refusal is the
   command's job (queue-builder-generic, per the lane clarification). (c) idlefill refuses
   overlapping rebuilds: one in flight per project (`rebuildInFlight` set).
5. **Run state persisted next to the queue** — `<queue_file>.rebuild.json`
   (`{last_run_ts, exit_code, duration_ms, queue_before, queue_after}`), atomic
   tmp+rename write, read tolerantly (corrupt → null → due). `queue_before/after` are
   the daemon's own `queueDepth` counts. Lives in the data dir, never the project repo.
6. **Rebuild event + heartbeat echo** — the register/heartbeat payload's `projects[]`
   rows now carry `last_rebuild` (the run-state object) when present
   (`ClientDaemon.register`). The arbiter sanitizes it at the edge (`cleanRebuild` in
   `server/src/api.ts`: all five fields must be finite numbers, else dropped — never a
   rejection), stores it on the client row, and echoes it on `/api/state` in both the raw
   `clients[]` rows and the `projects[].workers[]` rows. `Arbiter.registerClient` diffs
   the reported `last_run_ts` against the stored row and emits a `rebuild` event kind
   (`EventKind` in `server/src/types.ts`) with detail `queue 445 → 512 (exit 0, 4200ms)`
   — exactly once per run (same `last_run_ts` across the 20s heartbeat never
   double-logs). No new API surface.

## Files changed

- `client/src/config.ts` — `ScheduledRebuildConfig`, `parseScheduledRebuild`,
  `REBUILD_DEFAULT_EVERY_MINUTES`, `ClientProjectConfig.scheduled_rebuild`.
- `client/src/index.ts` — `RebuildRunState`, `rebuildStateFile`, `readRebuildState`,
  `writeRebuildState`, `rebuildDue`, `REBUILD_TIMEOUT_MS`; daemon:
  `maybeRunScheduledRebuilds` + `runScheduledRebuild` (tick hook), `last_rebuild` in the
  register payload, in-flight rebuilds SIGKILLed on `stop()`.
- `client/config.example.json` — example `scheduled_rebuild` key + `_docs` entry.
- `server/src/types.ts` — `RebuildRunState`, `ProjectAllocation.last_rebuild`,
  `EventKind` gains `'rebuild'`.
- `server/src/api.ts` — `cleanRebuild` sanitizer on register; `last_rebuild` echoed in
  `projectView` worker rows.
- `server/src/arbiter.ts` — `noteRebuilds()` diff-and-emit in `registerClient`
  (heartbeat + fresh-registration paths).
- `client/package.json` — test script gains `test/rebuild-scheduler.test.ts`.

## New tests

- `client/test/rebuild-scheduler.test.ts` (7 tests): cadence due/not-due by
  `last_run_ts` (incl. exact boundary + restart-survival), config parsing (default 60,
  garbage → disabled), run-state file shape + corrupt-file tolerance, daemon integration
  against the fake arbiter with stub fixtures (`client/test/fixtures/rebuild-add.sh`,
  `rebuild-sleep.sh` — never career-ops files): due rebuild runs + state recorded +
  heartbeat carries `last_rebuild`; failed command (exit 2) → queue untouched, exit code
  recorded; not-due → command never runs; overlapping rebuilds refused across ~20 poll
  ticks.
- `server/test/api.test.ts` (+1 test): `last_rebuild` rides register → `/api/state`
  (client row + projectView worker row); `rebuild` event emitted once per new run with
  the `queue 445 → 512 (exit 0…)` detail; same-run heartbeat does not double-log; newer
  run emits a second event; malformed `last_rebuild` dropped, never rejected.

## Gate output (real runs, `NODE_ENV=` prefix on every npm/npx)

**Baseline before changes** — `NODE_ENV= npm run test`: exit 0 —
server 80/80, client 44/44, career-ops 5/5, noop 2/2 (131 total, 0 fail).

**Final** — `NODE_ENV= npm run test`: exit 0 —

```
ℹ tests 81   ℹ pass 81   ℹ fail 0   (idlefill-server)
ℹ tests 51   ℹ pass 51   ℹ fail 0   (idlefill-client)
ℹ tests 5    ℹ pass 5    ℹ fail 0   (idlefill-adapter-career-ops)
ℹ tests 2    ℹ pass 2    ℹ fail 0   (idlefill-adapter-noop)
```

139 total, 0 fail (baseline 131 + 8 new).

`NODE_ENV= npx tsc --noEmit -p client` → clean.
`NODE_ENV= npx tsc --noEmit -p server` → clean.
`NODE_ENV= npm run build` → clean (server tsc; other workspaces have no build step).

## Deviations / additions beyond the settled decisions

- **Timeout kill posture:** a rebuild killed by the 15-min cap records `exit_code: -1`
  (the runExecutor outcome reports signal/timedOut, not a process exit code). Documented
  in the code and the sanitizer comment.
- **`stop()` SIGKILLs in-flight rebuild children:** runExecutor children are detached
  process groups; without this a daemon restart would orphan a running rebuild chain.
- **Fresh registration with existing state emits one `rebuild` event** (arbiter restarted
  with a clean state file, client restarted mid-cadence): no prior row to diff against,
  so the last run surfaces once. Deliberate, commented.

## Known follow-ups (explicitly out of scope here)

- **`daily_at` time-of-day trigger** — the issue's lane comment lists it alongside
  `every_minutes`; per settled decision 2 this step ships `every_minutes` only. The
  cadence check is one function (`rebuildDue`) — `daily_at` slots in as an OR condition
  against the same persisted state.
- **Dashboard panel row** for `last_rebuild` — the data already rides `/api/state`
  (`projects[].workers[].last_rebuild` and `clients[].projects[].last_rebuild`) and the
  `rebuild` events appear in the events feed; rendering the row is the follow-up.
- `scripts/` cron/launchd entrypoint — rejected for this step (daemon shape only).
