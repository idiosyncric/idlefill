# Issue #67 brief (mirror of the Forgejo issue body)

## Ask (owner, 2026-10-06)

The **Sessions** tab should show sessions broken out by which model each session is trying to use, and — in the same visual language as /archify diagrams — draw **flowing connectors** from a left column of sessions to a right column of inference engines, with load statistics on the pipes/nodes. Not a static diagram: a live surface.

Required behaviors, verbatim intent:

1. **Break out by model.** Sessions grouped by the model they request (derived key = model name today. The #45 `history.model` ADD-key and the session's catalog row give it).
2. **Connectors session → engine, left column → right column**, archify-style: SVG pipes, semantic colors from the dashboard's design tokens, orthogonal/rounded routing, dark/light themes (the dashboard already themes with CSS vars).
3. **Queue coloring.** While a session has parked requests (`gate.state: 'queued'`, with `waiting` + `position` — already an ADD-key on the register heartbeat), its connector renders in the waiting/queue color.
4. **Response motion.** When the engine is answering, animate motion ON the pipe **from the engine toward the session** (the stream direction), colored by phase: **green = thinking** (reasoning deltas), **blue = output** (content deltas), **purple = tool calls** (`tool_calls` deltas). Color scheme will be made configurable later (separate issue).
5. **Drag to re-route.** The operator can drag a connector's engine end from one engine to another — even between different models — and **the agent is never told the model behind the scenes changed.** The session keeps asking for the same alias/name. Only the resolved engine moves. This covers **switching a request that is WAITING in queue** — see "Switching a queued request" below.

## Switching a queued request (owner question, 2026-10-06 — RESOLVED)

Scenario: oMLX is slow and already has 5 requests waiting. A request just arrived and is parked. The operator wants it pointed at a different engine without the agent noticing.

**Do NOT buffer every request.** A parked request ALREADY keeps its complete body unconsumed, by design. `park()` holds `{ req, res, path, forward }` (`client/src/session-gate.ts:439`) and the #45 invariant requires the body stay whole for the forward on admission (`client/src/session-gate.ts:286-288` — the wedge where a `data` listener drained a parked request was found by the (c)/(e) gate tests). Re-routing is therefore a target swap at release time, not a buffering policy. Buffering admitted traffic would regress a posture the tests already pin.

**Do NOT ask the agent to re-send.** That path exists only as the failure posture: `expireHold` answers a capped hold with a retryable 503 + `Retry-After` (~15s + jitter, `client/src/session-gate.ts:465-470`). As intended UX it is strictly worse: it depends on the client SDK honoring the retry (Hermes sees a plain OpenAI endpoint. It has no idea idlefill asked for a resend), it costs a round-trip, it re-pays the queue position, and the #45 request ring counts two requests for one user action. It also breaks the #67 rule that the switch is invisible to the agent.

**The behavior: swap the target at release.**

1. The drag/switch writes an operator override in the SAME shape and channel as pause/force. The arbiter stores a per-session engine pin, the router learns it on the existing `GET /api/state` poll (`client/src/session-gate.ts:23-26`, enforcement at 300-310). No new push channel exists (#44's report: there is no arbiter→router command channel — do not invent one). This is the same answer #66 D4 reached for alias re-pins.
2. **The one code seam that blocks it today:** the aggregate router bakes the target into a closure at dispatch time — `opts.gate.route(req, res, key, rawUrl, forwardFor(entry))` (`client/src/aggregate.ts:257`). A parked hold carries that closure. The release path must resolve the target **at call time**: if the session holds a pin, forward to the pinned engine, otherwise the catalog entry. Change the held `forward` from a captured target to a resolver the hold calls on admission.
3. The #66 model-id splice then applies automatically: the splice lives in the forward seam, and release calls forward. A parked request whose model string must change length for the new engine splices at forward time, with the length rule (#66 D3).
4. Valid targets are constrained by truth: only engines whose catalog/probe entry actually serves the session's model. For aliases, "valid target" is exactly "the other pair's engine" — the #67 drag and this queued-switch are the same operation on the same plane.
5. **Session-scoped, not request-scoped.** The pin lives on the session's edge (the connector), so the rest of that session's traffic leaves the congested engine too. A request-scoped pin has no stable handle — the #45 ring entries are epoch stamps, not addressable IDs — and dies with the hold.
6. **Running (already-forwarded) requests are NOT switchable.** Bytes are mid-stream. Re-routing one means aborting it, which the client sees — that violates the invisible-switch rule. "Switch" means queued and next-request only. If the operator needs to kill a live run, that is a separate abort primitive (the client gets the error, its own retry re-sends to the then-current target). Preemption today ends leases, not HTTP streams (`server/src/arbiter.ts:738-745`) — do not conflate them.
7. **Honest cost: one poll tick.** The dashboard writes to the arbiter, the router learns on its next `/api/state` poll — the same latency pause/force has today. If that is too slow for a drag UX, the precedent for instant is already in the repo: #61 step 3's config editor writes straight to the client over the loopback proxy behind the Host/Origin/constant-time-token ladder (`/client/projects`, `client/src/client-projects.ts`). A router-local pin write on that same ladder would take effect on the very next release. First slice: arbiter-stored pin + poll propagation (zero new channels, mesh-safe, consistent with #66 D4). The loopback fast-write is a later slice.
8. **Congestion visibility limit, stated so acceptance never promises more:** the gate's slots are per-SESSION (`maxActive` sessions), not per-engine. idlefill's view of engine congestion is the arbiter's in-flight session count per row — NOT the engine's internal request queue (llama.cpp's own queue is opaque to us). So a switch helps when the new engine has real capacity, and the load statistics in this issue are the operator's basis for judging that. Do not model or claim engine-internal queue depth.

## What already exists (verified 2026-10-06)

- Sessions section: `server/public/index.html` — `#sessions-section` + `renderSessions()` rows (`.sess`), exception-only posture, `#45` inline-SVG sparkline precedent (`.sspark svg`), inline SVG usage pattern from #51. The tab strip already has the Sessions vtab + badge.
- Arbiter session rows (`server/src/types.ts` `SessionRecord`): `server_id` (engine attribution, #64 made the router set it for aggregate traffic), `gate: {state, waiting, position?}`, `history: {rpm, model?, tokens?, reported_at}`, `session_id` (#42 Slice 0). All of the connector's truth is ALREADY on `/api/state`.
- Queue truth lives at the ROUTER (FIFO, `client/src/session-gate.ts`). The arbiter sees only the heartbeat echo. The dashboard already polls `/api/state` on a cadence.
- Operator override plane already exists end-to-end: `SessionOverrideKind = 'pause' | 'force'` (`client/src/session-gate.ts:37`), arbiter-stored, learned on the poll, enforced at 300-310. The engine pin is a sibling of that plane.
- Response-phase observation point: the router pipes engine bytes to the client today. The proxy's `up.on('data', …)` bytes counter (`client/src/proxy.ts:109`) and the #45 response sniffer ("observe copies, never steal bytes") are the precedent for classifying streaming deltas — `delta.reasoning_content` → thinking, `delta.content` → output, `delta.tool_calls` → tool calls (OpenAI chunk shapes. oMLX/llama-swap/llama.cpp all emit `reasoning_content` for thinking models, verified live in #64's stream probe).

## What is NOT in place (build or dependency)

- **Per-session response phase is not reported anywhere today.** Build: a response-phase sniffer in the router (same unshift/copy discipline as #45 — never consume the stream) publishing a bounded phase snapshot per session (`phase: 'thinking'|'output'|'tools'|null` + age), as an ADD-key on the register heartbeat, sanitizer drop-don't-reject.
- **The engine pin does not exist yet.** Build it as an ADD-key sibling of the pause/force override plane, keyed by the session's derived key, arbiter-stored, poll-learned. Depends on #66 for WHAT a legal target is (an alias's pair set). Without #66 landed, the pin still works against bare-name catalog rows — state in the build report which shape shipped and why.
- **Release-time target resolution is not implemented** — the closure capture in `aggregate.ts:257` freezes the engine at dispatch. This is the required change (see item 2 of the queued-switch section).
- **Model grouping is per-machine truth.** Session rows carry `client_id`. The dashboard shows one fleet view. State how cross-machine rows group (by model name across rows is fine. Label counts per machine).

## Visual contract (archify-style, native implementation)

NOT the archify viewer runtime (that is a generated static HTML artifact with its own trace machinery — see the archify skill). This is the dashboard's own SVG + CSS, matching archify's *language*: clean node columns, rounded orthogonal connectors, semantic per-state colors from design tokens, quiet chrome, and reader-visible statistics on nodes and pipes. Motion is CSS/SVG on the pipes, capped: honor `prefers-reduced-motion` (fall back to static state colors).

- Left column: session nodes (label = derived key/model, secondary line = client_name, rpm mini-spark, tokens). Group header = model name (breakout).
- Right column: engine nodes (one per arbiter server row: name, in-flight sessions count, queue count, model count).
- Pipes: session → engine (the `server_id` field. Absent means the watched row, label it). Base color = calm idle. Queued pipe = warn/queue color + dashed flow. Active pipe = base. Responding pipe = animated moving dashes/gradient engine→session, green/blue/purple by phase.
- Load stats: per-engine in-flight + queued counts. Per-pipe nothing beyond state unless cheap. Counts from arbiter session rows (active + gate.state).
- Drag: pointer-drag the engine endpoint of a pipe onto another engine node. Valid targets highlight. The drop writes via the pin plane (see queued-switch section). The optimistic UI reconciles against the next `/api/state` poll (server truth wins. A rejected or failed write reverts with a reason). Esc cancels. Keyboard alternative required (select pipe, arrow-key/`m` to move target — accessibility, motor: ≥44px hit areas).
- A pipe whose session is queued AND the operator has just pinned a new engine shows the queue color still (the request has not been released yet) plus the pending-target marker. Server truth on the next poll settles the pipe onto the new engine.

## Data-plane additions summary (the build surface)

1. Router: response-phase sniffer ADD-key on register heartbeat (`phase`, `phase_at`), bounded values, drop-don't-reject, never breaks streaming (#45 discipline).
2. Router: release-time target resolution — held forwards resolve the engine on admission instead of at dispatch.
3. Arbiter + router: per-session engine pin, sibling of the pause/force override plane, ADD-key, poll-learned, sanitizer drop-don't-reject.
4. Dashboard: new Sessions flow view — either a second mode inside the Sessions vtab (flow ⟷ rows toggle) or a section under it. Rows mode stays exactly as today (exception-only rows are the dense ops view. Flow is the glance view). Do not delete rows.
5. Engine-node stats from existing arbiter data. No new arbiter queries.
6. Drag write path: the pin plane above (arbiter-stored, poll-learned). Legal targets = engines that actually serve the session's model per the catalog/#66 alias pairs.
7. Everything remains fail-open/fail-quiet: missing add-keys = pipes render base-colored, no animation, no pin honored (the surfaces-always-render rule this repo uses everywhere).

## Acceptance

- Live: with two machines/one machine several Hermes sessions on models resolving to different engines, the flow view shows the breakout, pipes colored by idle/queued, motion animating engine→session while a stream runs, phase color changing on reasoning vs content (demo with a thinking model — `reasoning_content` streams first).
- Live: drag re-routes a session's model to another engine. The NEXT request goes to the new engine (curl probe + session row `server_id` change). The client (Hermes) sees no error and no model-name change.
- Live, the queued switch (the owner scenario): park requests on a slow/loaded engine (drive the session-slot cap so requests queue), drag the queued connector to a different engine, then confirm the parked request is forwarded to the NEW engine on admission — with the #66 splice applied where the engine's model id differs — and the client sees one continuous response, no error, no model-name change, and the #45 ring counts ONE request, not two.
- Live, the fence: a request already mid-stream does NOT move when the pin changes (its bytes finish on the old engine). Prove the pin applies to the next request, not the running one.
- Live: kill the arbiter — pipes go static/base, rows mode unchanged, no console spam, pins not honored (fail-open posture #41).
- Tests: phase sniffer unit (delta classification, never consumes stream — reuse the #45 parked-request harness), sanitizer tests for the new ADD-keys, pin write/read tests at the API level, release-time-resolution test (a parked hold follows the pin, a running hold does not), and the drag write-path tests at the API level. Dashboard JS stays test-light like siblings (the repo's dashboard has no DOM suite. API-level tests + live acceptance only — state that honestly).
- Gates: tsc both packages, full `npm run test` green (never regress the current 184+112+17+2), build green, ASD-STE100 docs.

## Order

Depends on #66 (aliases) for what a legal target is. Phase-motion + flow view itself can start in parallel IF the drag lands after #66. The release-time-resolution seam (#67 data-plane item 2) is small and can ship with the pin. Suggested: #65 (status fix, shipped) → #66 grill (shipped, owner answers in) → #66 build → #67 build (phases + flow view first slice, pin + drag second slice).
