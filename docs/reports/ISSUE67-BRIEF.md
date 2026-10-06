# Issue #67 brief (mirror of the Forgejo issue body)

## Ask (owner, 2026-10-06)

The **Sessions** tab should show sessions broken out by which model each session is trying to use, and — in the same visual language as /archify diagrams — draw **flowing connectors** from a left column of sessions to a right column of inference engines, with load statistics on the pipes/nodes. Not a static diagram: a live surface.

Required behaviors, verbatim intent:

1. **Break out by model.** Sessions grouped by the model they request (derived key = model name today. The #45 `history.model` ADD-key and the session's catalog row give it).
2. **Connectors session → engine, left column → right column**, archify-style: SVG pipes, semantic colors from the dashboard's design tokens, orthogonal/rounded routing, dark/light themes (the dashboard already themes with CSS vars).
3. **Queue coloring.** While a session has parked requests (`gate.state: 'queued'`, with `waiting` + `position` — already an ADD-key on the register heartbeat), its connector renders in the waiting/queue color.
4. **Response motion.** When the engine is answering, animate motion ON the pipe **from the engine toward the session** (the stream direction), colored by phase: **green = thinking** (reasoning deltas), **blue = output** (content deltas), **purple = tool calls** (`tool_calls` deltas). Color scheme will be made configurable later (separate issue).
5. **Drag to re-route.** The operator can drag a connector's engine end from one engine to another — even between different models — and **the agent is never told the model behind the scenes changed.** The session keeps asking for the same alias/name. Only the resolved engine moves.

## What already exists (verified 2026-10-06)

- Sessions section: `server/public/index.html` — `#sessions-section` + `renderSessions()` rows (`.sess`), exception-only posture, `#45` inline-SVG sparkline precedent (`.sspark svg`), inline SVG usage pattern from #51. The tab strip already has the Sessions vtab + badge.
- Arbiter session rows (`server/src/types.ts` `SessionRecord`): `server_id` (engine attribution, #64 made the router set it for aggregate traffic), `gate: {state, waiting, position?}`, `history: {rpm, model?, tokens?, reported_at}`, `session_id` (#42 Slice 0). All of the connector's truth is ALREADY on `/api/state`.
- Queue truth lives at the ROUTER (FIFO, `client/src/session-gate.ts`). The arbiter sees only the heartbeat echo. The dashboard already polls `/api/state` on a cadence.
- Response-phase observation point: the router pipes engine bytes to the client today. The proxy's `up.on('data', …)` bytes counter (`client/src/proxy.ts:109`) and the #45 response sniffer ("observe copies, never steal bytes") are the precedent for classifying streaming deltas — `delta.reasoning_content` → thinking, `delta.content` → output, `delta.tool_calls` → tool calls (OpenAI chunk shapes. oMLX/llama-swap/llama.cpp all emit `reasoning_content` for thinking models, verified live in #64's stream probe).

## What is NOT in place (build or dependency)

- **Per-session response phase is not reported anywhere today.** Build: a response-phase sniffer in the router (same unshift/copy discipline as #45 — never consume the stream) publishing a bounded phase snapshot per session (`phase: 'thinking'|'output'|'tools'|null` + age), as an ADD-key on the register heartbeat, sanitizer drop-don't-reject.
- **Drag-to-re-route needs a write path.** Two designs, and the right one depends on model aliases (#66 grill):
  - *Preferred end state:* aliases (#66) carry an operator-selectable resolved engine. The drag writes the alias→row pin in the ARBITER. The router learns via the `/api/state` poll (same pull posture as pause/force overrides, `client/src/session-gate.ts:23-26`). No new push channel exists — #44's report states there is no arbiter→router command channel. Do not invent one.
  - *Without aliases (session-level pin):* a per-session engine override keyed by the session's derived key. Honest limitation: the derived key is the MODEL name (D3), so a session-pin re-routes every session (per machine) requesting that model — which is exactly alias semantics anyway. Decide: build #67's drag AFTER #66 lands, or build the pin now as an override-shaped ADD-key with #66 inheriting it. The grill/build should state which and why.
- **Model grouping is per-machine truth.** Session rows carry `client_id`. The dashboard shows one fleet view. State how cross-machine rows group (by model name across rows is fine. Label counts per machine).

## Visual contract (archify-style, native implementation)

NOT the archify viewer runtime (that is a generated static HTML artifact with its own trace machinery — see the archify skill). This is the dashboard's own SVG + CSS, matching archify's *language*: clean node columns, rounded orthogonal connectors, semantic per-state colors from design tokens, quiet chrome, and reader-visible statistics on nodes and pipes. Motion is CSS/SVG on the pipes, capped: honor `prefers-reduced-motion` (fall back to static state colors).

- Left column: session nodes (label = derived key/model, secondary line = client_name, rpm mini-spark, tokens). Group header = model name (breakout).
- Right column: engine nodes (one per arbiter server row: name, in-flight sessions count, queue count, model count).
- Pipes: session → engine (the `server_id` field. Absent means the watched row, label it). Base color = calm idle. Queued pipe = warn/queue color + dashed flow. Active pipe = base. Responding pipe = animated moving dashes/gradient engine→session, green/blue/purple by phase.
- Load stats: per-engine in-flight + queued counts. Per-pipe nothing beyond state unless cheap. Counts from arbiter session rows (active + gate.state).
- Drag: pointer-drag the engine endpoint of a pipe onto another engine node. Valid targets highlight. The drop writes via the chosen write path. The optimistic UI reconciles against the next `/api/state` poll (server truth wins. A rejected or failed write reverts with a reason). Esc cancels. Keyboard alternative required (select pipe, arrow-key/`m` to move target — accessibility, motor: ≥44px hit areas).

## Data-plane additions summary (the build surface)

1. Router: response-phase sniffer ADD-key on register heartbeat (`phase`, `phase_at`), bounded values, drop-don't-reject, never breaks streaming (#45 discipline).
2. Dashboard: new Sessions flow view — either a second mode inside the Sessions vtab (flow ⟷ rows toggle) or a section under it. Rows mode stays exactly as today (exception-only rows are the dense ops view. Flow is the glance view). Do not delete rows.
3. Engine-node stats from existing arbiter data. No new arbiter queries.
4. Drag write path: per the #66 dependency decision. The alias pin is preferred, the session-override pin is the interim.
5. Everything remains fail-open/fail-quiet: missing add-keys = pipes render base-colored, no animation (the surfaces-always-render rule this repo uses everywhere).

## Acceptance

- Live: with two machines/one machine several Hermes sessions on models resolving to different engines, the flow view shows the breakout, pipes colored by idle/queued, motion animating engine→session while a stream runs, phase color changing on reasoning vs content (demo with a thinking model — `reasoning_content` streams first).
- Live: drag re-routes a session's model to another engine. The NEXT request goes to the new engine (curl probe + session row `server_id` change). The client (Hermes) sees no error and no model-name change.
- Live: kill the arbiter — pipes go static/base, rows mode unchanged, no console spam (fail-open posture #41).
- Tests: phase sniffer unit (delta classification, never consumes stream — reuse the #45 parked-request harness), sanitizer tests for the new ADD-keys, the drag write-path tests at the API level (arbiter writes/pins), dashboard JS stays test-light like siblings (the repo's dashboard has no DOM suite. API-level tests + live acceptance only — state that honestly).
- Gates: tsc both packages, full `npm run test` green (never regress 184+97+17+2), build green, ASD-STE100 docs.

## Order

Depends on #66 (aliases) for the drag's target design. Phase-motion + flow view itself can start in parallel IF the drag lands after #66. Suggested: #65 (status fix, small) → #66 grill → #67 build (phases + flow view first slice, drag second slice).
