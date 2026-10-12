# Alias stability & slow engines — LIVE verification (F), production chain, 2026-10-12

Owner runbook: SIGTERM the arbiter mid-session, restart, resume the turn — assert zero
401 "API key required" entries in the oMLX log and the agent sees either a stream or a
clean model_unavailable.

## Before (the 2026-10-12 incident, unchanged historical evidence)

arbiter SIGTERM 11:56 EDT → down ~5h → cold start 13:09:32 → `model_aliases: []` for
~15s → `updateAliases([])` cleared the router map → the next `Qwen3.8-Flash-Next` request
fell to `llm_target` (oMLX :8000) with the agent key stripped → `401 "API key required"`
(oMLX log 12:55:11 / 12:57:19 / 13:04:05 / 13:11:43 EDT).

## After (the fix chain live on this machine)

Production arbiter and client daemon are LaunchAgents (`com.sam.idlefill.server` /
`com.sam.idlefill.client`, tsx from this checkout), so `launchctl kickstart -k` loads the
new main — three kickstarts ran (20:01:13, 20:01:43, 20:09:02 UTC); evidence lines in
`runbook-evidence.jsonl` (scratch).

| assertion | evidence |
| --- | --- |
| a cold start NEVER publishes empty `model_aliases` while config stands (D1 seed) | first `/api/state` answer after each cold start, 2.8s and 62ms after kickstart, already carried `["Qwen3.8-Flash-Next","Qwen3.8-27B"]` with per-entry `catalog_source`/`degraded`/`fallback_targets` |
| the alias STAYS routed across an arbiter death mid-session | a `Qwen3.8-Flash-Next` turn started 2.5s before the SIGTERM stayed bound to its alias engine (session `as-runbook-c` rows show `server_id: srv-f1c85327` through the outage; client log shows gate FAIL-OPEN then re-arm, no re-dispatch, no fall-through) |
| the resumed turn STREAMS post-restart | `p4-post-restart-stream`: HTTP 200, 32 SSE chunks, `[DONE]`, 30.5s through the demonstrably busy srv-f1c85327 (`load_busy true, in_flight 1`) — wait posture = today |
| `:8800 /v1/models` advertises the configured aliases with caps | `p2-advertise`: `["Qwen3.8-Flash-Next","Qwen3.8-27B"]` + `context_length 262144` on the probed winner |
| D1 live wire: secondary pairs publish | `fallback_targets: 1` on Flash-Next (pin srv-f1c85327, secondary srv-45abb4e8); `degraded: true` on the declared-only 27B winner (no-signal row, honest chip) |
| ZERO 401 through another engine's auth | oMLX POST→401 count EXACTLY 265 at baseline and 265 at close (every entry predates the fix — last is 13:11:43); zero bytes reached :8000 from any aliased request (byte-zero pinned by C's regression in client/test) |
| the fence never poisons routing | after two restarts + a fail-open outage window, aliased requests routed normally — `configuredAliasNames` monotonic, block re-poll restored the map byte-identically |

## Honest non-evidence (named, not papered over)

- NO live `alias_pair_mismatch` fired: every production pair is `probed` or honestly
  `declared` — no probe contradiction exists to alert on. The event + rate limiter are
  pinned by server tests (arbiter.test.ts), not by this run.
- The D3 failover/queue paths did NOT run live: `aggregate_slow_handling` defaults to
  `wait` (owner posture (a) = today byte-for-byte) and the knobs are opt-in; live
  failover would have rewritten a busy engine's traffic. Behavior pinned by D's 10
  client tests instead. The engine WAS honestly slow (41s and 30.5s TTFB, load_busy,
  in_flight=1) — the wait posture waited, as designed.
- Dashboard E evidence: the live `/api/aliases` + `/api/state` wire carries every input
  the new views render (`mismatch`/`degraded`/`fallback_targets`, `signal.queue_depth`);
  the Models card is gated behind a settings edit token, so no anonymous screenshot was
  taken — D4 logic pinned by 8 `session-edge.test.ts` tests.
- A runbook artifact of its own: a router request whose CLIENT times out is not aborted
  upstream — the generation completes server-side (visible as lingering `in_flight`).
  Today's posture (untouched by this wave), worth its own issue.

## Runbook hygiene

Four agent keys were minted for the runbook (`alias-stability-runbook` x2, `final` x3
chains) and ALL revoked — the final `GET /api/client-keys` list shows only the four
pre-existing operator labels (Accounting Agent, Web-dev, flash, hypnotist).

Named fleet observations (pre-existing, NOT touched by this wave):

1. `srv-watched` (seeded llama_swap row → oMLX :8000) carries NO auth token, so the
   arbiter's catalog probe to it 401s every tick (19k GET-401 lines in the oMLX log).
   Harmless by design (the pair-less row just never confirms) but noisy — the fix is an
   operator write: set the row token (dashboard Resources / server-keys plane).
2. A stale listener-less `tsx server/src/index.ts` arbiter process (pid 94996/94997,
   started Oct 11 22:55, holds one half-dead accepted socket, binds nothing) sits
   beside the launchd-manured :8787 holder. Named and left alone — not this wave's
   process; the owner may want to `kill` it.

## Gates (final main)

npm run test 988/988 (server 487, client 272, dashboard 56, cli 97, fleet root suites
unchanged), npm run build green, `npx tsc --noEmit` green per touched package (B: server,
C/D: client, E: dashboard).
