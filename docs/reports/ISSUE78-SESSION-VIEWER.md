# Issue #78 — in-app session viewer (the router's view)

Per-issue build report. Subject: an in-app "session viewer" on the dashboard
Sessions tab that opens a panel showing that session's **router-observed**
requests — request timing, the last model the router sniffed, and the last
streamed token total — plus the 60-second request buckets.

## What was built

The ring the router already keeps per session (#45) — the epoch-ms of every
forwarded/parked request, the last model name sniffed from an upstream response
echo, and the last streamed token total — is exposed read-only and surfaced in
the app. The viewer is **explicitly not a full chat reader**: the router never
reconstructs the prompt/response, so the panel shows exactly what the router
saw (timing + sniffed model + token total) and says so plainly.

Four seams, mirroring the existing `/api/sessions` + `history` ADD-key
pattern:

1. **Client — loopback transcript surface** (`client/src/proxy.ts`,
   `client/src/session-gate.ts`)
   - `SessionGate.transcriptFor(token)` — a pure read of the in-memory ring:
     per-request entries (`{ at, model?, tokens? }`, newest-first) + the #45
     10×60s buckets (the same counts the `history` heartbeat publishes, so the
     two surfaces agree by construction). Unknown token / empty ring → the same
     empty shape (fail-quiet).
   - `GET /sessions/<token>/transcript` on the loopback proxy — answered
     **before** the gate's `/s/<token>` dispatch (the path shapes don't collide:
     this is `/sessions/…`, that is `/s/…`) and before plain passthrough, so the
     control path never reaches the LLM target. Returns
     `{ token, requests: [{ at, model, tokens }], buckets: number[] }`.
     Unknown / oversized token / no gate configured → **fail-quiet** 200 + the
     empty shape (no requests, zero buckets) — the viewer is never wedged by a
     bad handle. It is a read surface: a transcript GET never proxies traffic
     upstream.

2. **Arbiter — the forwarding route** (`server/src/api.ts`,
   `server/src/arbiter.ts`)
   - `Arbiter.clientRouteForSession(token)` — resolves the OWNING client by
     `client_id` (then `client_name`) → `{ ip, proxy_port? }`.
   - `GET /api/sessions/:token/transcript` — forwards to the owning client's
     loopback proxy port (`GET /sessions/<token>/transcript` there). The router
     owns the ring; the arbiter only relays it (the same "client-truth" posture
     as the `history` block).
     - **Auth posture: the sibling `/api/sessions` route** — the top-level
       `/api` guard enforces a configured token (Bearer or `?token=`) before
       this runs; the route adds no extra credential.
     - **Loopback-only forward** — the ring lives at the client's `127.0.0.1`
       proxy, so the forward fetches `127.0.0.1:<proxy_port>` and only when the
       owner's `ip` is loopback. A non-loopback owner is refused (we must not
       fetch an operator-supplied remote IP with the operator's token).
     - **Fail-closed, never invented** — owner unknown / no `proxy_port` /
       non-loopback owner / router unreachable / non-2xx → **502** with the
       honest reason. It never fabricates a transcript.

3. **Dashboard — the affordance + panel** (`dashboard/src/views/Sessions.tsx`,
   `dashboard/src/lib/api.ts`)
   - A `view` button on each Sessions row opens a **Sheet**
     (`dashboard/src/components/ui/sheet`) fed by
     `GET /api/sessions/<token>/transcript` (new `getSessionTranscript` +
     `SessionTranscript`/`SessionTranscriptRequest` types).
   - The panel shows, per request: **time** (clock + "ago"), the **model** the
     router sniffed (badge), and the **streamed token total**; plus the
     **requests/min, last 10 min** sparkline (`buckets`).
   - A clear honesty line in the header: *"the router's view, not the full
     conversation — what the router observed per request (time, model,
     streamed token total), never the messages."*
   - States: loading; **transcript unavailable** (the 502 reason, explained —
     the owning router may be offline or report no reachable loopback port);
     and **no requests in the router's ring** (the honest empty case, noting the
     ring is in-memory and a daemon restart starts it empty).
   - Design tokens only — `text-dim` / `text-err` / `border-border` /
     `bg-panel` / the existing `Badge` + `Button` + `Sparkline`; no hardcoded
     colors.

4. **Client test** (`client/test/session-transcript.test.ts`, added to the
   `client` test script) — real sockets, real proxy + real gate + a fake
   upstream, in the style of `client/test/proxy.test.ts`:
   - **known token** (with observed traffic) → the per-request entries
     (time + sniffed model + token total) newest-first + 10 buckets; a
     transcript GET never reaches the upstream;
   - **unknown token** → fail-quiet: 200 + empty shape (no requests, zero
     buckets), never 404/5xx;
   - **empty ring** → a fresh router answers the empty shape at the gate read
     (the unit-level view of "known but idle").

## Decisions honored

- **Not a chat reader** — the whole surface is labeled the router's view; the
  response bodies of the requests are never surfaced (the test asserts the
  read path does not touch the upstream).
- **Same auth posture as the sibling session routes** — the arbiter route
  inherits the `/api` token guard; no new credential.
- **Client-truth discipline** — the router owns the ring; the arbiter relays.
  The buckets reuse the #45 windowing so the transcript and the `history`
  heartbeat agree by construction.
- **Fail-quiet at the router, fail-closed at the arbiter** — an unknown token
  at the loopback surface is an honest empty (the viewer is never an error);
  an unreachable/unresolvable owner at the arbiter is an honest 502 (nothing is
  invented).
- **Loopback-only forward** — the arbiter never fetches a remote IP with the
  operator's token.
- **No hardcoded colors** — existing design tokens/CSS vars throughout.

## Files

- `client/src/session-gate.ts` — `SessionTranscriptRequest` / `SessionTranscript`
  + `SessionGate.transcriptFor(token)`.
- `client/src/proxy.ts` — `TRANSCRIPT_PATH_RE` + the
  `GET /sessions/<token>/transcript` handler (read-only, fail-quiet).
- `server/src/arbiter.ts` — `Arbiter.clientRouteForSession(token)`.
- `server/src/api.ts` — `GET /api/sessions/:token/transcript` (token-gated,
  loopback-only forward, fail-closed 502).
- `dashboard/src/lib/api.ts` — `SessionTranscriptRequest` / `SessionTranscript`
  + `getSessionTranscript(token)`.
- `dashboard/src/views/Sessions.tsx` — `TranscriptSheet` + the per-row `view`
  button.
- `client/test/session-transcript.test.ts` — the three-case endpoint test.
- `client/package.json` — the new test added to the `test` script.
- `dashboard/dist/**` — rebuilt served bundle (the committed surface).
- `docs/reports/ISSUE78-SESSION-VIEWER.md` (this file) + indexed in
  `docs/reports/README.md`.

## Harness + build output

Run from the worktree root, `NODE_ENV=test` (so `npm` keeps devDependencies):

- `dashboard` — `tsc --noEmit` clean; `vite build` → `dist/index.html` +
  hashed `assets/*.js` / `assets/*.css` (rebuilt, committed).
- `client` — `tsc --noEmit` clean; the new transcript suite passes
  (known / unknown / empty-ring).
- `server` — `tsc --noEmit` clean.

The exact per-suite pass counts are recorded in the commit summary; the
dashboard typecheck + build and the `client` + `server` `tsc` are all green.

## Honest limits

- The `model` / `tokens` on each entry are the router's **last observed**
  values for the session (the same facts the `history` heartbeat reports), not
  a per-request capture — a single ring entry carries the session's sniffed
  model + the last streamed token total. The request **timing** is per-request.
- The ring is in-memory; a daemon restart starts it empty (stated on the empty
  panel).
- A session owned by a client on a DIFFERENT machine has its ring on that
  machine's loopback proxy — the arbiter (on this machine) cannot reach it, so
  it answers 502 "the session owner is not on this machine." Same-machine
  (loopback) owners are the supported case.
