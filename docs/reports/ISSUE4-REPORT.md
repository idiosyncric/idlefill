# Issue #4 — job results over REST (arbiter-stored outcomes)

Branch: `issue-4-results-rest` (verified via `git symbolic-ref --short HEAD` as first command).
Worktree: `/Users/sam/orca/workspaces/idlefill/issue-4-results-rest`. Main checkout untouched.
Commit: `049bdbe` (pathspec add; no push, no merge).

## Changes

### Server

- **`server/src/types.ts`** — new `JobResultRow` (`project, job_id, ok, score, tokens_out, tokens_in, error, ts`); `ArbiterState.results: Record<string, JobResultRow>` keyed `project::job_id` (same key shape as `throttled_jobs`).
- **`server/src/state.ts`** — `results: {}` in `emptyState()`, tolerated on load (pre-issue-#4 state files load unchanged), `resultsPerProjectCap` opt (default **200**, exposed read-only for the arbiter's eviction).
- **`server/src/arbiter.ts`** — `finishLease` gains `score?: number|null` and writes the outcome row on **every** usage report via new private `recordJobResult` (latest-only: a newer report replaces the row; eviction keeps the newest 200 rows per project by ts). `ts` = server receive time (ISO) — honors the `now` param so fake-clock tests are deterministic. New query `projectResults(project, {limit, job_id})` → newest-first page.
- **`server/src/api.ts`** — usage handler body parse gains `score` (non-number → null, never rejected). New route `GET /api/projects/:name/results?limit=N&job_id=X`: token-gated by the existing `/api/*` onRequest hook (the anonymous `/api/state` exception does not extend to it), 404 `unknown_project` like sibling routes, limit default 20 cap 200, response `{ project, count, results }` mirroring the MCP tool shape. `/api/state` untouched (stays lean). `server/public/index.html` untouched.

### Client

- **`client/src/index.ts`** — `reportUsage` body type gains `score?: number|null`. Success path sends `score` from the result line (finite number, else null). All four failure call sites (preempt/timeout, crash exit≠0, clean ok:false, teardown) send `score: null`. `job_id`/`project` NOT added to the body (the arbiter knows them from the lease — settled decision #1).

### MCP adapter

- **`adapters/career-ops/idlefill-mcp.mjs`** — `results()` is now async: local rows → `source: "local"`; local file missing/empty → new `arbiterResults()` fallback (`GET /api/projects/<p>/results?limit=N` with the config's `server_url` + `token`, 4s abort like `arbiterState`) → `source: "arbiter"` rows (company/title/report_path null — not stored on the arbiter). Arbiter unreachable/error/empty → today's `{ok:true, project, results:[], note:"no results yet"}` unchanged (no `source` key). Tool description updated → **`tools.golden.json` regenerated** (description-only diff; the #15 byte-identity test passes against the new golden).
- **Intentional response-shape change:** `idlefill_results` now carries `source: "local" | "arbiter"` on non-empty results (settled decision #4). Existing mcp.test.mjs session assertions still pass unmodified (they don't assert absence of the key).

## New tests

- `server/test/arbiter.test.ts` (+5): score → row stored (fields, ts=server time); failed report stores ok:false+error, missing/garbage score → null; second report for same (project,job) REPLACES (latest-only); cap eviction at 200/project (205 jobs → oldest 5 evicted); `projectResults` newest-first + limit + job_id filter.
- `server/test/api.test.ts` (+1 big wire-contract test, +1 route in the 401 sweep): usage score → GET endpoint returns it; newest-first; `?job_id=` filter (and replace semantics over HTTP); `?limit=2`; 404 unknown project; anonymous request → 401 (auth gate).
- `client/test/lease-loop.test.ts`: success-path usage POST body carries `score: 4.2` from the result line.
- `adapters/career-ops/mcp.test.mjs` (+2): stub arbiter on loopback — empty local file → fallback rows with `source:"arbiter"` (asserts route path, `limit`, Bearer token on the request); local rows present → `source:"local"` and **zero** arbiter hits; unreachable arbiter → `note:"no results yet"`, no `source`.

## Gate output (real runs, all `NODE_ENV=` prefixed)

Baseline before changes (`npm run test`): **81 + 51 + 13 + 2 = 147 tests, 0 fail** (saved: `~/.hermes/profiles/web-dev/cache/scratch/issue4-baseline.txt`).

Final `NODE_ENV= npm run test`:

```
ℹ tests 87   ℹ pass 87   ℹ fail 0   (server: 81 baseline + 6 new)
ℹ tests 51   ℹ pass 51   ℹ fail 0   (client)
ℹ tests 15   ℹ pass 15   ℹ fail 0   (career-ops adapter: 13 + 2 new)
ℹ tests 2    ℹ pass 2    ℹ fail 0   (noop adapter)
```

`NODE_ENV= npx tsc --noEmit -p server` → clean. `NODE_ENV= npx tsc --noEmit -p client` → clean.
`NODE_ENV= npm run build` → exit 0.

Ports: never bound 8787/3000; the throwaway arbiter port 18791 was never needed (all new tests use ephemeral loopback ports via the existing harnesses). Post-run `lsof -nP -iTCP:18791 -sTCP:LISTEN` (and 8787/3000) → empty.

## Deviations / notes

1. **Eviction cap lives on `StateStore`** (`resultsPerProjectCap`, default 200) rather than a constant in arbiter.ts — follows the existing `leaseHistoryCap`/`eventCap` persistence-knob pattern; the arbiter reads it at write time.
2. **Result row written on every usage report, not only the first terminal transition.** The issue says "written in finishLease (where ok/error already land)" — a duplicate finish re-stamps ts with the freshest receive time; latest-only semantics are unchanged. Budget idempotency (count-once) untouched.
3. **arbiter.test cap test uses the default 200** (205 jobs) rather than a tiny injected cap, proving the shipped default; `makeHarness` gained a `resultsCap` option for future tests.
4. **api.test results test relocates a leftover session row** (`s-http-1` → `server_id: srv-unwatched` via the register heartbeat): the sessions test leaves fresh session `last_activity` on the watched server, which legitimately defeats idle. `last_activity` only moves forward (Math.max), so the heartbeat's `server_id` reassignment is the supported lever. No production behavior changed.
5. **`idlefill_results` became async** (the fallback fetch); the stdio loop already `await`s TOOL_IMPL, so no protocol change.
6. `tools.golden.json` regenerated mechanically (spawn real server → tools/list core subset), matching the #15 golden test's extraction exactly.

## Final state

`git status --short` → empty (this report committed with the work).

ISSUE4_PIPELINE_COMPLETE
