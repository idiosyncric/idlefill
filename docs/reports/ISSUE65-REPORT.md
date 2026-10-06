# Issue #65 — upstream status propagation through both forwarders

Tracker mirror: `ISSUE65-BRIEF.md`. Forgejo issue:
https://git.samwarth.com/sam/idlefill/issues/65

## The bug

Both forwarders copied upstream headers but never the upstream status.
`res.statusCode` stayed at Node's default 200. An engine 401 reached the
caller as HTTP 200 plus the engine's error body. An OpenAI-compatible SDK
parsed a completion, found no choices, and reported an empty stream. The
real reason (auth rejected) never arrived.

Live probe evidence (before the fix, 2026-10-06):

```
curl 127.0.0.1:8000/v1/chat/completions  -> HTTP 401  {"error":{"message":"API key required",...}}
curl 127.0.0.1:8800/v1/chat/completions  -> HTTP 200  {"error":{"message":"API key required",...}}
curl 127.0.0.1:11435/v1/chat/completions -> HTTP 200  {"error":{"message":"API key required",...}}
```

## What shipped

One line per forwarder, set before the header copy and the pipe. Every
other posture stayed byte-identical.

- `client/src/aggregate.ts` — the upstream-response handler now sets
  `res.statusCode = up.statusCode ?? 502`.
- `client/src/proxy.ts` — the 11435 passthrough handler now sets the same
  (the value was already captured into `entry.status` for the request
  log. It now reaches the caller as well).

Kept unchanged, by design:

- The router's own 502 for an unreachable engine (`llm target down`).
- The gate's 503 for a parked request past the hold cap.
- The hop-by-hop header skip set (`transfer-encoding`, `connection`,
  `content-length`).
- SSE streaming: `up.pipe(res)` untouched.
- The `entry.status` logging line in the proxy.

The D6 fence for the 11435 contract reads "headers pass through". The
status was always meant to pass too: the code already captured it. This
restores intended fidelity. It is not a contract change. Job adapters
that mis-retried on 200-plus-error bodies now get a correct 4xx.

## Tests

Appended to the two already-registered files, no new files:

- `client/test/aggregate.test.ts` — four new tests: an engine 401 reaches
  the caller as 401 through the aggregate listener. An engine 401 lands
  as 401 through `gate.route` admission. An engine 200 SSE keeps status
  200 with byte-identical frames (the #45 sniffer stream posture, not
  regressed). An unreachable engine through the aggregate forwarder stays
  a clean 502 with the `llm target down` body.
- `client/test/proxy.test.ts` — one new test: an engine 401 reaches the
  job caller as 401 with the engine body verbatim, and the proxy request
  log still records status 401.

## Gate output (actual)

```
env -u NODE_ENV npx tsc --noEmit -p client/tsconfig.json   -> rc=0
env -u NODE_ENV npm run test    -> server 189, client 112, career-ops 17, noop 2 — 0 fail (baseline 184+97+17+2)
env -u NODE_ENV npm run build   -> rc=0
```

Honest note: the first full-suite run failed one lease-loop tokens test
(actual 4096, expected 2048). That test passed in an isolated lease-loop
run and in the full-suite rerun above. The fixture shares fixed ports.
The first batch run hit the known concurrent-fixture flake family. My
five new tests passed in both the isolated pair run (14/14) and the full
rerun.

## Live acceptance (Mac, both labels restarted)

Read-only lease probe first (`GET /api/state` via a script reading the
gitignored `client/config.json` at runtime): `active_leases_count=0`.
Restart scope: `launchctl kickstart -k` on `com.sam.idlefill.server` and
`com.sam.idlefill.client` only. The srv-watched row stayed keyless on
purpose: its 401 is the acceptance scenario.

```
:8800  POST Qwen3.8-Flash-Next -> 401 {"error":{"message":"API key required",...}}   (was 200 pre-restart)
:11435 POST Qwen3.8-Flash-Next -> 401 {"error":{"message":"API key required",...}}   (was 200 pre-restart)
:8000  direct engine            -> 401 (ground truth, body byte-identical to both)
:8800  POST qwen3.8-flash-next-iq3_s stream -> 200, SSE frames + [DONE] normal (1.85s)
```

One honest observation from the restart window: the client label
crash-looped with `fetch failed` for a few seconds while the arbiter
label was still binding. launchd re-spawned it. The daemon came up with
both listeners bound. That pre-existing startup race is out of scope
here and unchanged by this fix.

## Build status

Shipped on main 2026-10-06: one status line per forwarder, five new
tests, all three gates green, live 401 propagation proven on :8800 and
:11435 with the keyless srv-watched row left in place. Issue #65 can
close.
