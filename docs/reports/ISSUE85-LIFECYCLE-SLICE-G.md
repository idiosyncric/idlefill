# #85 slice G — Session lifecycle flags from the Sessions row (loopback-only control verb)

**Status:** delivered on branch `issue-85-lifecycle` (worktree slice; merge to main by the coordinator). Slice G of the #84-key surface issue; the remaining slices (B–F, H, I) are untouched here. Slice A's probe-walk posture and refusal discipline are reused verbatim (the exact-id walk lives in the connector, not a duplicated helper).

## What shipped

Rename / pin straight from the Sessions row — an operator click, never a cycle. The
PATCH travels browser → OWNING client's loopback daemon → Hermes gateway. Nothing
about it ever enters the arbiter wire: no register heartbeat, no `/api/state`, no
usage report (marker-scan proof below), and the client never writes the patch into
the enrichment ledger (writing it there would let a new `title` ride the
`hermes_meta` heartbeat — that WOULD be publishing the verb's payload; the next
natural poll refreshes the row instead).

- `client/src/hermes-gateway.ts` — the slice-G block: `LIFECYCLE_FIELDS`
  (`title/pinned/archived/hidden/unread` — the gateway's client-safe set MINUS
  `end_reason`), `validateLifecyclePatch` (fail-closed whole-body; `end_reason`
  and any other field refused BY NAME with a reason that says why it is off the
  table; `title` trimmed/capped 256; `title:null` = the gateway's documented
  restore path), `LifecycleResult`, and `HermesGatewayConnector.patchLifecycle`
  — the #83 exact-id probe walk (keyed profiles in config order, first 200 owns
  the row), the PATCH landing on that SAME profile EXACTLY ONCE per call,
  named refusals with statuses, local logging of field NAMES only.
- `client/src/hermes-lifecycle.ts` — the loopback route
  `PATCH /client/hermes-lifecycle/<session_id>`. Guards are the EXACT sibling
  posture (#61/#84/#85-A): Host loopback; a present Origin must name a loopback
  origin (CSRF); `X-Idlefill-Edit: <arbiter token>` constant-time, fail-closed,
  checked BEFORE the method guard; PATCH/OPTIONS only (the OPTIONS preflight
  advertises PATCH); loopback CORS allow headers; body capped 16 KiB (413).
  The gateway's per-profile API key never appears in any body.
- `client/src/proxy.ts` — `hermesLifecycle` opt (absent ⇒ the path falls through
  to plain passthrough, byte-for-byte prior posture — pinned by a test);
  answered BEFORE passthrough; fire-safe async dispatch like slice A.
- `client/src/index.ts` — wires the route with `token` + a `connector` getter
  (connector not constructed ⇒ the named 503 refusal, zero gateway requests).
- `client/package.json` — `test/hermes-lifecycle.test.ts` registered.
- `dashboard/src/lib/api.ts` — `patchLocalHermesLifecycle(port, id, patch)`
  (loopback fetch + `X-Idlefill-Edit`; a refusal throws `<named reason> — <detail>`
  so the toast is verbatim).
- `dashboard/src/views/Sessions.tsx` — `LifecycleControls` on the row: inline
  rename (Enter writes, Esc cancels, `×` discards, an empty draft is a no-op) and
  a pin toggle. Rendered only for rows with a Hermes `session_id`; disabled with
  an honest tooltip when the owning client has no live loopback port (never
  relayed through the arbiter). One click = one PATCH: both controls are disabled
  while in flight and a refusal is NEVER retried — the toast shows the refusal
  reason verbatim.
- `package-lock.json` — none touched (no new deps).

## Wire shapes (as implemented)

Loopback route (client daemon, 127.0.0.1 proxy bind):

```
PATCH /client/hermes-lifecycle/<session_id>
    headers: X-Idlefill-Edit: <arbiter token>
    body:    { title?: string|null, pinned?: bool, archived?: bool, hidden?: bool, unread?: bool }
200 { ok: true, profile, session_id, patched: [field names…] }     // names only — never values
400 reason: invalid_session_id | invalid_body | bad_host
401 reason: unauthorized
403 reason: cross_origin
405 reason: method_not_allowed          (PATCH/OPTIONS only)
413 reason: body_too_large              (>16 KiB)
503 reason: connector_disabled | no_key | gateway_unreachable | gateway_ambiguous
404 reason: session_not_found           (ONLY every keyed profile answered an explicit 404)
<any gateway status> reason: gateway_rejected  (the gateway itself refused the write)
```

Gateway side (unchanged surface, just consumed): `PATCH {prefix}/api/sessions/{id}`
with the sanitized patch — success answers `{object:'hermes.session', session:{…}}`
(the client ECHOES NONE of it; the verdict carries field names only).

## Allow-list + the `end_reason` fence (acceptance: "client-safe fields ONLY")

The gateway's own set is `{title, end_reason, pinned, archived, hidden, unread}`
(verified in `_handle_patch_session` — live evidence below). The client fences
`end_reason` OUT and refuses it BY NAME **before a single byte leaves the
process** — the refusal reason spells out why: ending a LIVE row while its agent
still runs is a footgun the gate cannot arbitrate (issue #85, slice G). Every
other foreign field (`model`, `system_prompt`, anything) is refused the same way;
malformed bodies, empty patches, and bad types never reach the walk either
(test-asserted: ZERO gateway requests for every refused body shape).

## Scope law (the #85 control-slice decision) — how each clause is met

- (a) deliberate operator gesture only: the route fires from the row's rename/pin
  click; the button is the authorization.
- (b) never automated: there is NO automatic caller — no cycle/lease/poll path in
  the daemon references `patchLifecycle`; the daemon-level test sleeps past a poll
  round and asserts the gateway's PATCH count stayed at the one click.
- (c) logged locally, never published: the connector logs `hermes lifecycle patch
  applied to <id> (profile <p>): <field names>` and refusal reason names — values
  never reach the log; the verdict carries no session echo; nothing enters the
  ledger, so nothing can ride `hermes_meta`/heartbeat/`/api/state`.
- (d) gate plane: no provider calls are involved — a lifecycle PATCH is pure
  metadata at the gateway; the steer/chat gate-visibility note belongs to slice F
  (nothing to print on this button beyond what the tooltips say: loopback-only).

Exactly-once: one deliberate click → one probe walk → at most ONE PATCH (never
retried, even on a gateway-refused write or a mid-PATCH transport failure — a
blind retry of a rejected write is how double patches happen). The route never
resubmits; the dashboard disables the control while in flight.

## Refusal honesty (the slice-A walk verdicts, reused)

- Disabled / unconstructed connector ⇒ 503 `connector_disabled`, ZERO requests.
  No profile carries a key ⇒ 503 `no_key`, ZERO requests. Malformed id ⇒ 400,
  zero requests. Disallowed body ⇒ 400 `invalid_body`, zero requests.
- Walk (only when keyed): 404 = definitive miss for THAT profile → walk on;
  401/403/5xx = ambiguous → walk on; a transport failure ENDS the walk (one
  bounded attempt, no per-profile retry storm against a dead host).
- The named 404 `session_not_found` answers ONLY when EVERY keyed profile gave an
  explicit 404. An all-ambiguous walk answers 503 `gateway_ambiguous` — the
  gateway never said "no such session", and the operator is never lied to.
- A resolved profile whose PATCH the gateway rejects answers `gateway_rejected`
  with the gateway's own status and complaint (bounded 256 chars) — verbatim to
  the toast, never retried, never walked on (the row was HERE).
- No negative caching (viewer-grade on-demand posture): a repeated deliberate
  click re-walks — absence is never cached for a control verb.

## Bounds + sanitizers

Body ≤16 KiB at the route; `title` trimmed and capped 256 client-side (the
gateway caps too); flags boolean-only; the walk is 1 GET per keyed profile + at
most 1 PATCH; timeouts ride the connector's `timeout_ms`; the verdict body is
five field names at most.

## UI field decision (surfaced vs API-only)

- **Surfaced:** `title` (inline rename) and `pinned` (row toggle) — the issue's
  named row UX.
- **API-only:** `archived`, `hidden`, `unread`. The Sessions list is arbiter
  truth, not the Hermes desktop sidebar: a hidden/archived row would keep showing
  here regardless, so the flag would be an invisible no-op on this page, and the
  issue says do not invent chrome for it. The route allow-lists all five, so a
  later slice can surface them with no wire change. `title:null` (restore the
  derived title) is likewise API-only — the rename affordance writes strings;
  a "reset title" button is a cheap later add.

## Harness + gates

`client/test/hermes-lifecycle.test.ts` — 16 tests, three suites: (1) the
connector verb against a fake gateway (end_reason/unknown/bad-type/empty refused
BY NAME with ZERO requests, unit sanitizer honesty incl. `title:null` + the 256
cap, the #83 walk resolving the owner with the PATCH landing once on the owning
profile's mirror path with that profile's Bearer, `title:null` verbatim to the
gateway, all-404 ⇒ named 404 with ZERO PATCHes, all-401 ⇒ 503 `gateway_ambiguous`
(never a false 404), disabled/unkeyed/malformed-id ⇒ named refusals with ZERO
requests, unreachable ⇒ one bounded attempt, gateway-refused ⇒ `gateway_rejected`
with its status + exactly one PATCH, the ledger stays at 0 rows); (2) the ROUTE
through the real proxy (token guard, cross-origin 403, GET 405, OPTIONS preflight
advertises PATCH, disallowed/malformed body 400 before any gateway request,
gateway-refused surfaces verbatim still exactly one PATCH, absent-connector named
503, no-opts byte-for-byte passthrough fall-through); (3) NEVER-ON-WIRE proof at
daemon level: real `ClientDaemon` + gate + fake arbiter, a title MARKER PATCHed
over the loopback route, then every client/session register body, usage report,
and the arbiter `/api/state` scanned — none carries it; the ledger stays 0; the
gateway saw exactly ONE PATCH, and a sleep past a poll round adds zero more.

Gates: `npm run test` exit 0 — server 430/430, client 231/231 (incl. 16 new),
career-ops 17/17, noop 2/2, shell-ui 3/3, dashboard 8/8, fleet 54/54 = 745 total,
0 failures (main baseline 729 + 16). `npm run build` exit 0.
`npx tsc --noEmit` clean for client, dashboard, server, fleet.
`dashboard/dist` left untouched (the coordinator regenerates the served bundle
centrally — no dist churn in this commit).

## Live evidence (read-only probes, gateway `http://127.0.0.1:8642`, v0.21.x)

- `PATCH /api/sessions/does-not-exist-85g` (unauthenticated, JSON body) → 401
  `{code:'gateway_auth_failed'}`, while `PATCH /api/nope-85g` → 404: the route is
  REGISTERED and the auth layer is per-route — a PATCH to a foreign id would be
  the 404 posture the walk keys on. No live PATCH was ever sent: writes are
  operator-gated, and the probes used unauthenticated requests + nonexistent ids.
- The installed gateway source (`~/.hermes/hermes-agent/gateway/platforms/api_server.py`)
  pins the contract consumed: `_CAPABILITY_ENDPOINTS` carries
  `("session_update", ("PATCH", "/api/sessions/{session_id}"))`;
  `_handle_patch_session` allows `{title, end_reason, pinned, archived, hidden,
  unread}` (unknown ⇒ 400 `unsupported_session_field`; non-boolean flags ⇒ 400
  `invalid_session_field`; bad title ⇒ 400 `invalid_title`; `title:null` ⇒ `""` =
  the restore path; success ⇒ `{object:'hermes.session', session}`); note
  `set_session_pinned` CLEARS `hidden`, and the gateway applies pinned LAST —
  compound pin+hidden requests have gateway-side ordering (this slice's UI sends
  exactly one field per click anyway).
- Verification limit (same honesty note as #83/#85-A): the walk was never run
  through the LIVE daemon against real keys — the daemon-level proof runs against
  the fake gateway pinning this exact contract.

## Corrections applied to the pre-existing WIP (this slice's critical review)

The branch arrived with a half-finished slice-G (an uncommitted `patchLifecycle`
plus a second, unwired route file that surfaced mid-session). Fixed/superseded:

1. **False 404 on ambiguous walks** (the exact bug slice A's report caught in its
   own WIP): the WIP fell through a 401-only / 5xx-only walk to
   `session_not_found`. Now the named 503 `gateway_ambiguous` — the honest 404 is
   reserved for all-explicit-404.
2. **Unnamed, status-less refusals**: the WIP returned plain `error` strings for
   disabled/unkeyed/unreachable with no status or name. Now every refusal is a
   slice-A-shaped named verdict with its status.
3. **Transport failure walked the whole profile list** (N attempts against a dead
   host). Now the walk ENDS on a transport failure — one bounded attempt.
4. **Gateway echo passthrough** (`body: parsed` riding the verdict): replaced —
   the verdict carries field NAMES only, so no verb payload can ever be echoed
   onward.
5. A bespoke `bearer()` obfuscation helper (no precedent anywhere in the repo;
   every sibling writes the literal) dropped; dead `lifecycleKeyedProfiles()`
   dropped.
6. The stale second route (`client/src/client-lifecycle.ts`, path
   `/client/hermes-session/<id>`, unwired in `index.ts`, written against the
   pre-review `RunResult` connector shape) and its stray `proxy.ts` import were
   removed; `hermes-lifecycle.ts` supersedes it (and matches slice A's path
   naming).
7. Client-side `title:''` rejected (the gateway's restore path is `title:null`,
   not an empty string) — kept from the WIP with a test pinning `null`
   pass-through.

## Deliberately NOT in this slice

- `end_reason` (the issue's explicit fence), `DELETE /api/sessions/{id}` (OUT),
  model-lock (H), fork (I), chat/steer (F).
- No ledger write from the verb (publishes nothing — see above), no negative
  cache, no HEAD, no cross-client relay (an offline owner = disabled buttons with
  an honest tooltip), no automatic invocation of any kind.
- `archived`/`hidden`/`unread` UI chrome (API allow-listed, no honest place on
  the arbiter-truth row yet).
- Arbiter wire: ZERO changes (the verb touches no server/fleet code; the
  ADD-keys-only rule is satisfied by adding nothing).

## Owner-visible decision (flagging, not blocking)

The pin button's on/off state is PAGE-LOCAL memory (the page remembers only what
it clicked: first click pins, the next unpins). Hermes' current `pinned` value is
never published to the arbiter, so the page cannot OBSERVE it — and a pin over an
already-pinned row is a gateway no-op, so a wrong guess cannot corrupt anything.
If the owner wants the true flag reflected across reloads/clients, the clean shape
is an ADD-keys roster/heartbeat key for the sidebar flags (a slice-B-style
additive poll key) — deliberately NOT smuggled in here, because reading four
boolean sidebar flags every round for a two-button UI is exactly the kind of
publish this fence exists to make a deliberate decision.
