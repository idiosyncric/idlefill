# #85 slice A — On-demand Hermes transcript in the session viewer (loopback-only)

**Status:** delivered on branch `issue-85-transcript` (worktree slice; merge to main by the coordinator). Slice A of the #84-key surface issue; the remaining slices (B–I) are untouched here.

## What shipped

The session viewer now shows the REAL conversation for a Hermes session — roles,
content (per-member capped), `tool_name`/`tool_calls`, `token_count`,
`finish_reason`, timestamps — instead of only the router-observed request stats.
The bytes travel gateway → owning client daemon → LOCAL page only. They never
ride the register heartbeat, the arbiter's `/api/state`, or any mesh publish,
and nothing is ever bulk-polled: the client fetches one bounded page only while
the viewer is open and the operator pages forward.

- `client/src/hermes-gateway.ts` — `transcriptPath(profile, id)` (the
  `session_messages` capability + `/p/<profile>` mirror rule, same shape as the
  #83 `sessionPath`), the page/clamp/sanitizer constants +
  `sanitizeTranscriptMessage`, and `HermesGatewayConnector.fetchTranscript` —
  the on-demand walk (per-profile Bearer keys, profiles in config order, first
  200 wins). NOTHING from the transcript enters the ledger, the attempts
  bookkeeping, or any publish.
- `client/src/hermes-transcript.ts` — the loopback route
  `GET /client/hermes-transcript/<session_id>?offset=…&limit=…` on the daemon's
  existing proxy bind. Guards are the EXACT sibling posture (#61/#84): Host must
  be loopback; a present Origin must name a loopback origin (CSRF); auth is
  `X-Idlefill-Edit: <arbiter token>` constant-time, fail-closed; loopback CORS
  allow headers for the cross-port page fetch; GET/OPTIONS only. The gateway
  key never appears in any body.
- `client/src/proxy.ts` — `hermesTranscript` opt (absent ⇒ the path falls
  through to plain passthrough, byte-for-byte prior posture — pinned by a test);
  answered BEFORE passthrough; fire-safe async dispatch (the handler never
  rejects by contract; the `.catch` is seam-surprise insurance, never an
  unhandled rejection).
- `client/src/index.ts` — wires the route with `token` + a `connector` getter
  (connector not constructed ⇒ the named 503 refusal, zero gateway requests).
- `client/package.json` — `test/hermes-transcript.test.ts` registered in the
  explicit client test list.
- `dashboard/src/lib/api.ts` — `readLocalHermesTranscript(port, id, offset,
  limit)` (loopback fetch + `X-Idlefill-Edit`, same shape as the #84 local
  surfaces).
- `dashboard/src/views/Sessions.tsx` — the viewer sheet gains a conversation
  panel, rendered ONLY when the row carries a `session_id` AND the owning
  client is online with a `proxy_port`; first page on open, "older messages"
  button walks `next_offset`; refusal reasons surface verbatim (a named error,
  never a stack). When the client is offline/no port: a plain "only reachable
  over loopback" note — the page NEVER proxies transcript through the arbiter.
- `package-lock.json` — incidental: the lock's root `version` synced 2→4 by
  `npm install` (precedent: "the lockfile stays in sync", 0010274).

## Wire shapes

Loopback route (client daemon, 127.0.0.1 proxy bind):

```
GET /client/hermes-transcript/<session_id>?offset=<n>&limit=<n>
    headers: X-Idlefill-Edit: <arbiter token>
200 { ok: true, profile, session_id, offset, limit, returned, next_offset,
      has_more, messages: [{ role, content?, content_truncated?, tool_name?,
      tool_calls?: [{ name, arguments? }], tool_calls_truncated?,
      token_count?, finish_reason?, timestamp?(epoch-ms), id? }] }
400 { ok:false, error, reason:'invalid_session_id' }
401 { ok:false, error, reason:'unauthorized' }            (no/!edit token)
403 cross_origin / 400 bad_host / 405 method_not_allowed
503 reason: connector_disabled | no_key | gateway_unreachable | gateway_ambiguous
404 reason: session_not_found   (ONLY every keyed profile answered an explicit 404)
```

Gateway side (unchanged surface, just consumed): `GET {prefix}/api/sessions/
{id}/messages?offset&limit&order=oldest` → `{object:'list', session_id,
data:[_message_response rows], pagination:{limit,offset,order,returned}}` —
pinned LIVE against 0.21.6 (see evidence).

## Bounds + sanitizers (acceptance: "bounded pages + sanitizer")

- Page: default 50, cap 200 (deliberately tighter than the gateway's own 500),
  offset cap 100 000; garbage params fall to bounds BEFORE any HTTP (test
  asserts the gateway only ever sees clamped `offset/limit`).
- Per-member caps (drop-don't-poison, `rowToMeta` posture): content 4 000
  (flagged `content_truncated`), tool name 128, tool calls ≤ 20 (flagged
  `tool_calls_truncated`), tool args 500, finish_reason 64; a row without a
  usable role is dropped whole; timestamps epoch-s→ms normalized.
- Paging rides RAW gateway rows (`next_offset = offset + raw consumed`), never
  the sanitized count — sanitizer drops can never re-show or overlap;
  `has_more` = raw page was full (the messages envelope carries no has_more).

## Refusal honesty (acceptance: "404 posture walks profiles like the #83 probe; unkeyed/disabled ⇒ clean 503-class")

- Disabled connector / not constructed ⇒ 503 `connector_disabled`, ZERO gateway
  requests. No profile carries a key ⇒ 503 `no_key`, ZERO requests. Malformed
  id ⇒ 400 (no request).
- Walk (only when keyed): 404 = definitive miss for THAT profile → walk on;
  401/403/5xx/malformed = ambiguous → walk on; transport failure ends the walk
  (one bounded attempt per walk, no retry storm). The 404 `session_not_found`
  is answered ONLY when EVERY keyed profile said explicit 404; an all-ambiguous
  walk answers 503 `gateway_ambiguous` — the gateway never said "no such
  session", and the operator is never lied to with a false not-found.
- No negative cache for transcripts (unlike the #83 enrichment walk): the
  surface is on-demand and viewer-gated, so a repeated lookup is one bounded
  request per deliberate click — caching conversation absence buys nothing and
  a reopened session must answer immediately.

## Harness + gates

`client/test/hermes-transcript.test.ts` — 18 tests, three suites: (1) the
connector walk against a fake gateway pinning the live envelope (sanitize/caps/
drop, 404 walk order, every-404 ⇒ 404, all-401 ⇒ 503 ambiguous, 5xx ⇒ 503
ambiguous, malformed envelope walks on, disabled/unkeyed ⇒ named 503 with ZERO
requests, unreachable ⇒ one attempt, clamp-before-request, has_more heuristic,
`next_offset` raw paging with a dropped row, sanitizer unit, `transcriptPath`);
(2) the ROUTE through the real proxy (token guard, cross-origin 403, POST 405,
absent-connector named 503, and no-opts byte-for-byte passthrough fall-through);
(3) NEVER-ON-WIRE proof at daemon level: real `ClientDaemon` + gate + fake
arbiter, marker-carrying transcript fetched over the loopback route, then every
client register body, session register body, usage report, and the arbiter
`/api/state` scanned for the marker — none carries it; the ledger stays at 0
rows and the gateway's `/messages` route was hit exactly ONCE (the viewer),
zero polling.

Gates: `npm run test` exit 0 — server 430/430, client 215/215 (incl. 18 new),
career-ops 17/17, noop 2/2, shell-ui 3/3, dashboard 8/8, fleet 54/54 = 729
total, 0 failures. `npm run build` exit 0. `npx tsc --noEmit` clean for
client, dashboard, server, fleet.

## Live route evidence (read-only curl, gateway `http://127.0.0.1:8642`, v0.21.6)

- `GET /api/sessions/<real id>/messages?offset=0&limit=2&order=oldest` → 200
  `{object:'list', session_id, data:[…], pagination:{limit:2, offset:0,
  order:'oldest', returned:2}}`; row keys `id, session_id, role, content,
  tool_call_id, tool_calls, tool_name, timestamp (epoch-seconds), token_count,
  finish_reason` (+ `display_kind, reasoning, reasoning_content` — deliberately
  NOT projected by the sanitizer). `GET /api/sessions/does-not-exist/messages`
  → 404 `{error:{code:'session_not_found'}}` — the definitive-miss posture the
  walk keys on.
- Verification limit (same honesty note as #83): the operator's connector keys
  are still unprovisioned on this machine, so the walk has not run through the
  LIVE daemon; the daemon-level proof runs against the fake gateway that pins
  this exact live envelope.

## Corrections applied to the pre-existing WIP (this slice's critical review)

1. False 404 on ambiguous walks: the WIP's all-401/5xx/malformed walk fell
   through to `session_not_found` (it claimed "every keyed profile answered
   404" — never true). Now the named 503 `gateway_ambiguous` (the WIP had a
   half-wired `sawAmbiguous` flag that was set but never read, plus a
   duplicated dead tail block; replaced).
2. Paging advanced `offset + returned` (sanitized count) — with any
   sanitizer drop the viewer would re-show messages and could end the walk
   early. Now `next_offset` (raw consumed) end-to-end (connector → api client
   → sheet button).
3. Test bugs: the clamp assertion regex couldn't match the real query order;
   the unreachable-gateway probe called `address()` before `listening` fired
   (null-port TypeError); the route tests stopped the proxy twice (cleanup +
   finally) which left a pending promise at after() (the file hung ~150 s).
   All fixed; 18/18 clean and the process exits.
4. Route posture trimmed to the sibling parity: HEAD removed (it paid the full
   gateway walk to discard the body, and the viewer never sends it), auth moved
   before the method guard, unused imports and a dead re-export dropped,
   `void handleHermesTranscript` made fire-safe.

## Deliberately NOT in this slice

- The gateway's `pagination.returned` is not trusted for paging (raw `data`
  length is used — the same trust posture as the #81 ledger pager).
- No streaming, no composer/verbs (slices F–I), no `display_kind`/`reasoning`
  projection, no transcript negative caching, no HEAD, no cross-client proxy
  (the panel only reads the OWNING client's loopback port; an offline owner is
  a plain note, never an arbiter relay).
- Arbiter wire: zero changes (the transcript touches no server/arbiter code;
  all wire discipline stays ADD-keys-only because nothing was added).
