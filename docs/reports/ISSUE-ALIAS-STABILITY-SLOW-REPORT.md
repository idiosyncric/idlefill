# Alias stability & slow engines — D3 slow-engine policy (client plane) — 2026-10-12

Spec: `docs/architecture/alias-stability-and-slow-engines.md` D3 (LOCKED,
owner 2026-10-12). Worker D of the alias-stability wave, after B (D1
`fallback_targets` publish) and C (D2 fence) merged. Client plane only:
`client/src/aggregate.ts`, `client/src/config.ts`, `client/src/index.ts`
(poll wiring), `client/config.example.json`, `client/test/aggregate.test.ts`,
`README.md`, `aggregate-endpoint.md` (dated shipped section), this report.
No server/dashboard change.

## The shipped keys (exact, all OPT-IN, ADD posture beside `aggregate_port`)

| key | default | sanitizer |
| --- | --- | --- |
| `aggregate_slow_handling` | `"wait"` | anything but the literal `"failover"` → `"wait"` (drop-don't-reject) |
| `aggregate_ttfb_timeout_ms` | absent (watchdog OFF) | finite positive → floored int; absent/0/negative/garbage → key NOT set |
| `aggregate_queue_depth_cap` | `3` | finite number → `Math.max(0, floor)`; garbage → 3 |

All three are OPTIONAL on `ClientConfig` (the `session_gate` pattern —
hand-built fixtures stay valid); the loader always sets handling + cap, and
toggles ttfb as an ADD key. The router takes
`slowHandling`/`ttfbTimeoutMs`/`queueDepthCap` and arms the watchdog only
when `failover` AND a positive deadline agree.

## Byte-for-byte posture (wait / watchdog-off)

`aggregate_slow_handling` defaults to `wait` and `aggregate_ttfb_timeout_ms`
is UNSET by default — `watchdogActive` is false and `forwardBuffered`'s
`!watchdogActive` branch dispatches through the extracted `sendBuffered`
helper with today's exact response/error plumbing: NO timer is ever
installed, socket errors only, no abort, no retry. Every pre-existing test
in the suite passes UNMODIFIED (the fence test for this is dedicated:
"D3 wait (the default fence)" even passes a 100ms deadline with handling
`wait` and proves no timer, no failover log, no 504 — a 400ms-slow engine
streams fully).

## The watchdog decision table (failover + deadline only)

Scope: the BUFFERED aliased forward (`forwardBuffered`) ONLY — replayable
body. `forwardTo` (bare names, same-id aliases, the default target,
GET/DELETE passthrough) never gets a timer. The timer starts at upstream
dispatch; ANY upstream response (even an error status) clears it FOREVER —
never retry after the first byte.

| at fire time | verdict |
| --- | --- |
| digest FRESH (≤20s) AND `0 < depth < cap` | engine demonstrably working → log `aggregate: alias <name> queue depth N — extending wait`, RE-ARM (repeatable, no failover) |
| stale / zero / ≥cap, first usable `fallback_targets`, retry unspent | destroy the doomed upstream, ONE re-dispatch: same buffered body re-spliced `requestedName → fb.engine_model`, `keys.get(fb.server_id)` via the shared `authFor` resolution (row token wins; keyless + #68 ON = null-strip; keyless plane OFF = undefined pass-through), content-length recomputed; log `aggregate: alias <name> ttfb > <ms>ms → failover <server_id>/<engine_model>` |
| stale/zero/≥cap AND no usable target, OR the ONE retry already spent | local `504` `application/json` `{"error":{"message":"model \"<name>\" upstream timed out before the first byte (<ms>)","type":"upstream_timeout","code":"upstream_timeout","model":"<name>"}}` — headers not yet sent |

Queue digest: new `updateQueueDepths(rows, observedAt?)` router method —
whole-map swap stamped `Date.now()` (`queue_depth` absent = no entry); fed
on EVERY successful `/api/state` poll from `st.servers[]`'s published load
keys. A poll FAILURE never calls it — staleness is handled by AGE
(`QUEUE_DIGEST_FRESH_MS = 20_000`), never by clearing.

## Failover safety rules (as shipped, pinned by tests)

- Pre-first-byte only: response headers arriving disarms forever (test (h)
  — late-but-before-deadline relays, zero watchdog logs).
- Exactly ONE retry, no chains: the second fire with `failoverUsed = 1`
  answers the same 504 (test (g) counts upstream requests: primary 1 +
  fallback 1, one switch log, ever).
- The abandoned upstream's error/response callbacks are silenced by a
  context-IDENTITY swap (`ctx !== self`) — a doomed request can never
  answer a 502 mid-failover or relay over the retry.
- The failover never touches `llm_target` (asserted 0 hits); it is the
  published `fallback_targets` surface or nothing (D1: no token ever rode
  the block — the client uses its own keys-plane row token, asserted
  `Bearer ROW-B-SECRET`).
- `updateAliases` keeps `fallback_targets` with drop-don't-reject: each
  element's three fields validated, malformed elements drop, a malformed
  array = key absent, and the entry still routes on its winner pair in
  every posture (behavioral + `sanitizeAliasFallbackTargets` unit checks).

## Tests

Before: repo 965/965 (per wave brief; the actually-measured baseline on
this checkout was 970/970 — server 487, client 262, cli 97, +97 smaller
workspace totals), client 262. After: repo 980/980 green (client 272, +10),
`npm run build` green, `npx tsc --noEmit` green in `client/`.

New (all in `client/test/aggregate.test.ts`, real sockets, the same fake-
engine/held-engine harness): (a) wait default byte-for-byte — 400ms-slow
primary streams fully with a 100ms deadline configured, zero watchdog
logs; (b) failover happy path — never-answering primary, fallback 200,
spliced body with ITS engine_model, the row token from `updateKeys`,
exactly one switch log in the exact voice; (c) fresh digest depth 1 cap 3
→ `extending wait` (repeatable), the primary eventually answers, zero
failover; (d) depth == cap → failover proceeds; (e) digest stamped 21s old
(the `observedAt` test seam) → failover proceeds; (f) no `fallback_targets`
→ exact 504 body with `error.model` echoed; (g) both engines slow → exactly
ONE upstream retry then 504, request counts pinned; (h) late-but-legal
headers → normal relay, watchdog never fires; (i) config sanitizer posture
(absent → wait/OFF/3, invalid handling → wait, 0 deadline OFF, garbage
floors); plus the updateAliases `fallback_targets` preservation posture.

## Deviations from the brief (with justification)

1. Poll-body shape: the brief sketched `servers: { id, load?: {
   queue_depth } }[]`. The wire truth (verified on disk, worker B/C waves
   untouched) is that `serverView` SPREADS the load reading into the
   `signal` block (`server/src/api.ts` — `...(loadSignal?.(row, now) ??
   {})`): `servers[].signal.queue_depth` is where the count actually
   rides; no `load` object exists on /api/state. The READ-ONLY poll type
   therefore declares BOTH (`signal` primary, `load` for the doc-named
   shape) and the digest call reads `s.load?.queue_depth ??
   s.signal?.queue_depth` — correct against today's arbiter, forward-
   compatible if the doc's naming ever lands. Never persisted, never
   written back anywhere.
2. `updateQueueDepths` carries an optional `observedAt` third parameter —
   the documented test seam for the stale-digest case (the established
   `aliasBodyCapBytes` "production callers never pass it" pattern); the
   daemon calls it with two args, the stamp defaults to `Date.now()`.
3. A PIN-resolved splice forward routes through `forwardBuffered` and is
   therefore watched (spec: "never the pinned-entry pipe unless it goes
   through forwardBuffered"), but a pin block carries no
   `fallback_targets` — the pin is the operator's override, so the alias's
   other pairs are NOT its fallback surface: on fire it gets queue
   suppression against the pinned row's digest, then the clean 504.
   `updateAliases` stores a normalized COPY of each accepted entry (shallow
   spread) so the poll body object is never mutated in place.
