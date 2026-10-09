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
- `missEnrich` throttle + cache: at most `SINGLE_MAX_ATTEMPTS = 2` per id, at least `SINGLE_RETRY_MS = 300_000` apart, one in flight per id (`singleInFlight` dedup — the 10s heartbeat cadence cannot flood); the attempts bookkeeping is size-capped at `SINGLE_TRACKED_MAX = 1000` (oldest record dropped, the `SESSION_ID_INDEX_MAX` posture).
- `lookupSingle(id)`: probes `GET {prefix}/api/sessions/{id}` (`sessionPath(profile, id)` — new export, same profile-mirror rule, id URL-escaped) per KEYED profile in config order (the gate header carries the id only — owning profile unknown), first exact hit wins; 401/404/non-200/malformed moves to the next profile, a transport error ends the probe; every path is fail-quiet. A hit merges through the existing `mergeHermesMeta` (last-known-wins) into `ledger` and stamps `lastSeenRound` with the current reachable round so the #82 eviction rules age the row normally (an ended child evicts after the grace; the hard cap can still LRU it — a re-miss after eviction can spend the remaining attempt, bounded).
- Fail-open unchanged: connector disabled, gateway down, or no key for any profile ⇒ NOTHING is scheduled — a down gateway still sees zero extra requests and the heartbeat is byte-for-byte the pre-#73 shape.

## Harness + build output

`client/test/hermes-gateway.test.ts` — fake gateway gained a single-session route stub (per-profile canned rows, 404 `session_not_found` for every other id, same `expectKeys` auth discipline). Five new tests:

1. child enriches via the probe walk: default 404s, web-dev answers (per-profile key asserted); first heartbeat still publishes absent; a HIT stops the walk and never re-probes; published meta shape unchanged (`is_internal_child` never published);
2. 404 posture + throttle: a 10-miss burst ⇒ exactly 2 requests (one per keyed profile); same-clock heartbeats add nothing; after the retry window ONE more pair, then the attempt cap holds — 4 requests EVER;
3. unreachable ⇒ zero lookups scheduled; reachable + fully unkeyed ⇒ zero requests;
4. a single-route 401 on one profile keeps probing the next (web-dev hit after default 401);
5. daemon-level (real ClientDaemon + gate + fake arbiter): a listed-out child id on the traffic ⇒ the miss probes the exact-id route, a LATER heartbeat carries `hermes_meta` — and `include_children` never appears in any listing query.

Also pinned `sessionPath` in the path test. (Harness catch: the fake-clock throttle test must start its clock past the poll-cadence gate, else `poll()` skips and nothing is scheduled.)

`tsx --test test/hermes-gateway.test.ts`: 24/24. `npm test --workspace client`: 187/187. Whole-repo `npm run test`: exit 0, zero failures across all 7 workspaces. `npm run build`: exit 0. `npx tsc --noEmit -p client/tsconfig.json`: clean.

## Live verification limit (recorded honestly)

No operator gateway key is provisioned on this machine (`~/.idlefill/hermes-gateway-keys.json` absent, no `IDLEFILL_HERMES*` in the client LaunchAgent), and the connector is not currently switched on in the daemon env — so no authenticated live single-route probe was made. Auth + payload shape were verified against the RUNNING Hermes 0.21.6 source (routes, decorators, response builders above) and the child-row counts against read-only live SQLite. When the operator provisions keys (`key_file` / `key_env` + `IDLEFILL_HERMES_GATEWAY=1`), the daemon-level test's posture reproduces against the live gateway unchanged.
