# Issue #6 — per-job lease TTL (client-side) — report

Branch: `issue-6-perjob-ttl` (verified with `git symbolic-ref --short HEAD` before any work).

## What changed

### 1. Client: per-job estimate wins at lease-request time (`client/src/index.ts`)

- `QueueJob.payload` gained a typed optional `estimated_seconds?: number` with a
  doc comment (finite > 0 counts; anything else falls back to the project value).
- New exported helper `jobEstimatedSeconds(job)`: returns
  `payload.estimated_seconds` only when it is a finite number > 0 — strings,
  negatives, NaN, null, missing all yield `undefined`.
- The lease POST in `tickOnce()` (was `estimated_seconds: proj.estimated_seconds ?? 900`)
  now sends `jobEstimatedSeconds(job.job) ?? proj.estimated_seconds ?? 900`.

### 2. Arbiter clamp verified — NO server change (settled decision 2)

Read `server/src/arbiter.ts` `requestLease` (current base, ~412–445): it computes
`ttlSeconds = project.lease_ttl_seconds ?? cfg.lease_ttl_seconds`, then
`computeLeaseTtl(est, ttlSeconds, cfg.lease_ttl_safety_factor, cfg.lease_ttl_floor_seconds)`
— estimate × safety factor, floored at `lease_ttl_floor_seconds`, capped at the
effective project/global TTL. Exactly as the issue describes. Server untouched.

### 3. Adapter passthrough (`adapters/career-ops/queue.mjs`)

Checked the real source shape: `~/Software/career-ops/data/pipeline-prioritized.json`
(206 rows) carries only `categories, company, score, skip, title, url` — **no
`estimated_seconds` field**. Per settled decision 4, no field was invented; the
builder now *preserves* `estimated_seconds` onto the queue-line payload only when
the source row already carries a finite number > 0 (string/negative dropped).
The queue-line format doc in the file header documents the optional field.
There is no separate README queue-line section for the builder; the README's
"Adaptive lease TTL" section (the TTL docs home) was updated instead — see 5.

### 4. Tests

- `client/test/fake-arbiter.ts`: records `estimated_seconds` from the lease POST
  body on every captured `leaseRequests` entry. New test seam `denyLeaseAfter`
  (per-job grant cap, see "flake fix" below).
- `client/test/lease-loop.test.ts`: new test
  **"per-job TTL: payload.estimated_seconds drives the lease POST; garbage falls
  back to the project value"** covering all three required cases in one loop:
  (a) `est: 120` → lease POST carries 120; (b) no field → project value (10);
  (c) `est: "300"` and `est: -5` → project value (10). `mkQueue` accepts an
  `est?: unknown` so garbage values round-trip through the real JSON queue file.
- `adapters/career-ops/queue.test.mjs`: new test proving the builder preserves a
  sane source `estimated_seconds` and drops string/negative/missing (never invents).

### 5. Docs

- `README.md` "Adaptive lease TTL (the estimate lever)" section: documents the
  per-job `payload.estimated_seconds` override, the finite > 0 validation, and
  the builder's never-invent passthrough rule.
- `adapters/career-ops/queue.mjs` header: queue-line format now shows the
  optional `estimated_seconds` with its semantics.

## Flake fix (deviation-adjacent, in scope of "all workspaces green")

The first full-suite run failed on the **pre-existing** `clean failure … attempts: 1`
test (got `attempts: 2`). Baseline check: 5/5 green on stashed base, but 1/3 fail
with my changes — the test's "flip `arb.idle=false` when the failure report
lands" snapshot races the daemon's 50 ms re-poll; my added test shifts timing and
made the latent race fire more often. Fixed at the root: the fake arbiter gained
a deterministic per-job grant cap (`denyLeaseAfter`), and the test now caps
`job-cf` at 1 grant instead of racing the idle flip. Verified: 5× consecutive
full-client-suite runs green (38/38 each) after the fix.

## Gate output (real, from this worktree)

`NODE_ENV= npm run test` (worktree root):

```
> idlefill-server@0.1.0 test   ℹ tests 80  ℹ pass 80  ℹ fail 0
> idlefill-client@0.1.0 test   ℹ tests 38  ℹ pass 38  ℹ fail 0   (baseline 37 + 1 new)
> idlefill-adapter-career-ops  ℹ tests 5   ℹ pass 5   ℹ fail 0   (baseline 4 + 1 new)
> idlefill-adapter-noop@0.1.0  ℹ tests 2   ℹ pass 2   ℹ fail 0
```

Total 125 pass, 0 fail (baseline 123 + 2 new tests).

`NODE_ENV= npx tsc --noEmit -p client` → clean (no output).
Server not touched → no server tsc needed; `NODE_ENV= npm run build` → exit 0, clean
(build compiles the server workspace only; client has no build script).

No throwaway arbiter was needed (the client tests use the in-process fake arbiter
on an ephemeral port); port 18793 was never bound. `npm run dev` never run.

## Deviations

1. The three required client test cases (a/b/c) are one test with four queue
   lines instead of three separate tests — same coverage, one daemon loop, less
   runtime.
2. Added the `denyLeaseAfter` fake-arbiter seam + de-flaked the pre-existing
   clean-failure test (see above). Test-harness only; no product code involved.
3. Adapter: source pipeline has no `estimated_seconds` today, so the change is
   the decision-4 "preserve if present" branch + header doc, not a new producer.
