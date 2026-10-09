# #83 — Connector: delegate/subagent children enrich via a bounded single-session lookup

**Status:** delivered direct on `main` (owner decision 2026-10-04: direct-to-main, CI gates are the review). The issue body asked the owner to pick among options A/B/C before a build slice; the owner's instruction was to FIX the enrichment gap ⇒ **option A** (bounded per-id lookup), not B (label the gap) and not C (parent ride).

## The gap (re-verified against Hermes 0.21.6 source + read-only live DBs)

- A session whose `model_config` JSON carries `_delegate_from` (a `delegate_task` subagent, a desktop agent-close child) is DELIBERATELY absent from the default `GET /api/sessions` listing: `_session_filter_where` appends `_LISTABLE_CHILD_SQL AND _delegate_from_json('s.model_config') IS NULL` when children are excluded (`~/.hermes/hermes-agent/hermes_state_sessions.py:120-127`), and `_handle_list_sessions` parses `include_children` with `default=False` (`api_server.py:3074`) — the connector's listing requests never pass it, so the exclusion always applies to the ledger round.
- The gate plugin wraps EVERY provider call, a subagent's included, so the child's captured `X-Hermes-Session-Id` joined against NOTHING in the ledger: `metaFor` → undefined ⇒ `hermes_meta` absent (fail-open, pre-existing and still correct — this issue only widens coverage).
- Live read-only DB check on this machine (`sessions.model_config` contains `_delegate_from`): default home 57 rows, `web-dev` 47 (2 with `ended_at IS NULL` — the issue's "2 active"), `hypnotist` 4, plus `career-ops` 6, `flash` 5, `hardware-agent` 5, `accounting-agent` 1, `web-dev-orca` 1. Present in the DBs, invisible to the listing.
- NOT a gap (issue correction, honored): compression rotations surface their live TIP row through `list_sessions_rich` (`project_compression_tips=True`), and the fix must NOT pass `include_children=true` — that would admit hidden internal children as first-class listing rows. The connector's listing requests are untouched.

## The route that answers for a child (verified in source)

`GET /api/sessions/{session_id}` — capability `session` in `_CAPABILITY_ENDPOINTS` (`api_server.py:91`), registered at `api_server.py:1738`, `@_require_auth` (3188). `_handle_get_session` (3189) resolves ANY exact id via `_get_existing_session_or_404` → `db.get_session` (3038-3045) — children included — and returns `{object: 'hermes.session', session: _session_response(row)}`. `_session_response` (2985-3020) projects the SAME safe-keys the listing rows carry (plus the provenance bit `is_internal_child`; the model snapshot never crosses), so the existing `rowToMeta` sanitizer applies verbatim. Auth (`_check_auth`, 1559): Bearer vs the per-profile `API_SERVER_KEY`, `hmac.compare_digest`; named profiles fail closed without their own key — the connector's exact per-profile key rule it already applies to listing reads.

## What was built (`client/src/hermes-gateway.ts`)

Option A, contained ENTIRELY inside the connector — no daemon (`index.ts`), gate, arbiter, or wire change:

- `metaFor(sessionId)` normalizes the id (`normalizeSessionId` — the same trim/cap rule `rowToMeta` applies to row ids) and on a ledger MISS (enabled + reachable only) calls `missEnrich(id)` — fire-and-forget — while still returning `undefined` THIS heartbeat (the miss publish stays byte-for-byte pre-#83; a later heartbeat carries the merged row).
- `missEnrich` throttle + cache: at most `SINGLE_MAX_ATTEMPTS = 2` walks per id, at least `SINGLE_RETRY_MS = 300_000` apart, one in flight per id (`singleInFlight` dedup — the 10s heartbeat cadence cannot flood); the attempts bookkeeping is size-capped at `SINGLE_TRACKED_MAX = 1000` (oldest record dropped, the `SESSION_ID_INDEX_MAX` posture).
- **Negative 404 cache (this slice):** `lookupSingle` tracks the walk's verdict. If EVERY keyed profile answered an explicit 404 the gateway gave a definitive "no such session" answer: the id is cached in `singleNotFound` and is **never fetched again** (size-capped 1000, oldest dropped). An ambiguous walk — transport failure, 401/403, 5xx, malformed body, a foreign id in the answer — is NOT cached, so the id keeps its remaining bounded attempt under the throttle.
- **Per-round cap (this slice):** `SINGLE_LOOKUPS_PER_ROUND = 8` distinct ids may be scheduled per REACHABLE poll round (`roundMissIds`, reset every reachable round). A flood of unknown ids therefore never exceeds 8 ids × keyed profiles requests per cadence; deferred ids are admitted by the next round.
- `lookupSingle(id)`: probes `GET {prefix}/api/sessions/{id}` (`sessionPath(profile, id)` — new export, same profile-mirror rule, id URL-escaped) per KEYED profile in config order (the gate header carries the id only — owning profile unknown), first exact hit wins; 401/404/non-200/malformed moves to the next profile, a transport error ends the probe; every path is fail-quiet. A hit merges through the existing `mergeHermesMeta` (last-known-wins) into `ledger` and stamps `lastSeenRound` with the current reachable round so the #82 eviction rules age the row normally (an ended child evicts after the grace; the hard cap can still LRU it — a re-miss after eviction can spend the remaining attempt, bounded).
- Fail-open unchanged: connector disabled, gateway down, or no key for any profile ⇒ NOTHING is scheduled — a down gateway still sees zero extra requests and the heartbeat is byte-for-byte the pre-#73 shape.

## Harness + build output

`client/test/hermes-gateway.test.ts` — fake gateway gained a single-session route stub (per-profile canned rows, 404 `session_not_found` for every other id, same `expectKeys` auth discipline) plus a `singleRouteStatus` knob to model a non-404 ambiguous route. Seven connector-level #83 tests now:

1. child enriches via the probe walk: default 404s, web-dev answers (per-profile key asserted); first heartbeat still publishes absent; a HIT stops the walk and never re-probes; published meta shape unchanged (`is_internal_child` never published);
2. **404 negative cache:** a 10-miss burst ⇒ exactly 2 requests (one per keyed profile); 50 heartbeats past the retry window (fake clock) add ZERO — the cached definitive miss is never re-fetched, and a fresh poll round does not re-open it;
3. **throttle + attempt cap on ambiguous walks:** a 500 on every exact-id read (no definitive answer, so no negative cache) ⇒ one walk, ONE retry after `SINGLE_RETRY_MS`, then the cap holds — 4 requests EVER;
4. **per-round cap:** 14 unknown ids in one burst ⇒ exactly `SINGLE_LOOKUPS_PER_ROUND = 8` distinct ids walked (8 × 2 keyed profiles = 16 requests), the deferred ids admitted only after the next reachable round;
5. unreachable ⇒ zero lookups scheduled; reachable + fully unkeyed ⇒ zero requests;
6. a single-route 401 on one profile keeps probing the next (web-dev hit after default 401);
7. daemon-level (real ClientDaemon + gate + fake arbiter): a listed-out child id on the traffic ⇒ the miss probes the exact-id route, a LATER heartbeat carries `hermes_meta` — and `include_children` never appears in any listing query.

Also pinned `sessionPath` in the path test. (Harness catch: the fake-clock throttle test must start its clock past the poll-cadence gate, else `poll()` skips and nothing is scheduled.)

`tsx --test test/hermes-gateway.test.ts`: **26/26**. `npm test --workspace client`: **197/197**. Whole-repo `npm run test`: **exit 0, 673/673 pass** (server 414, client 197, career-ops 17, noop 2, shell-ui 3, dashboard 4, fleet 36 — zero failures). `npm run build`: exit 0. `npx tsc --noEmit -p client/tsconfig.json`: clean.

## Live route evidence (read-only curl, gateway `http://127.0.0.1:8642`, v0.21.6)

The single-session route EXISTS and resolves delegate children by exact id. Auth used the operator's own `API_SERVER_KEY` from `~/.hermes/.env` (the connector's own `~/.idlefill/hermes-gateway-keys.json` is still unprovisioned on this machine — see the limit note below):

- `GET /api/sessions?limit=200` → 200, 200 rows; the delegate child `20261008_155926_ea090f` (`_delegate_from: 20261008_154307_477561`) is **absent** from the default listing — the exact posture the probe exists for.
- `GET /api/sessions/20261008_155926_ea090f` → **200** `{object:'hermes.session', session:{id, model 'Qwen3.8-27B', message_count 76, tool_call_count 59, input_tokens 404262, output_tokens 34421, reasoning_tokens 25484, estimated_cost_usd 0.0, ended_at 1791490494.78, end_reason 'agent_close', is_internal_child: true}}`.
- `GET /api/sessions/does-not-exist-xyz` → **404** `{error:{code:'session_not_found'}}` — the definitive-miss posture the negative cache keys on.
- `GET /api/sessions?limit=200&include_children=true` → the child appears, confirming why the connector must never widen the listing.

## Live verification limit (recorded honestly)

No operator key is provisioned for the CONNECTOR (`~/.idlefill/hermes-gateway-keys.json` absent, no `IDLEFILL_HERMES*` in the client LaunchAgent), and the connector is not currently switched on in the daemon env — so the probe has not run through the live daemon. The live route itself WAS verified authenticated (curl above, using the operator's own `API_SERVER_KEY` from `~/.hermes/.env`): 200 for a delegate child's exact id, 404 for an unknown id. When the operator provisions keys (`key_file` / `key_env` + `IDLEFILL_HERMES_GATEWAY=1`), the daemon-level test's posture reproduces against the live gateway unchanged.
