# Issue 67 — Sessions flow view (build report)

Date: 2026-10-07. Branch: `main` (direct-to-main per repo convention).
Brief: `docs/reports/ISSUE67-BRIEF.md` (grill-locked decisions carried there verbatim; this report records what shipped and what acceptance proved).

## What shipped

Three commits on `main`, then one acceptance-fix pass (this report):

1. `402193c` — arbiter: session pins + response-phase plane. `setSessionPin` / `sessionPinBlock` (the sibling of the pause/force override plane: same write shape, same poll-learned channel, one-tick latency — #66 D4 precedent). The `engine_pin` ADD-key rides the session row on `/api/state` and `/api/sessions`; the `phase` ADD-key rides transitions immediately (not next cadence).
2. `383d56f` — router: release-time pin resolution (`pinnedEntryFor`) + the response-phase sniffer on the aggregate forward seam. The sniffer watches the engine's own bytes: `reasoning_content` → thinking, `tool_calls` → tools, `content` → output; clears when the stream ends or goes quiet past `FLOW_PHASE_MAX_AGE_MS`.
3. `bb222e3` — dashboard: the flow view in `server/public/index.html` (538 lines). Sessions grouped by model name, engine column right, orthogonal SVG connectors, phase-colored pipes, drag + keyboard pin writes, rows⟷flow toggle (localStorage), fail-quiet rows.
4. Acceptance-fix pass (this session): see "Acceptance caught a real defect" below.

## Acceptance caught a real defect (the headline finding)

The flagship scenario — drag a parked alias request from the winner pair's engine to the other pair — was **refused end-to-end for real traffic**, even though the shipped arbiter test passed.

Root cause: the router sniffs `history.model` from the **response** (the #45 seam), so a live alias session carries the **winner pair's engine id** (`model-b-id`), never the alias name (`Flagship`). The arbiter's pin-legality and the block's splice resolution both keyed aliases **by name only**. For live sessions the alias branch never fired: legality fell to the bare-inventory branch and returned `not_an_alias_pair` / `row_lacks_model` (400); `engine_pin.engine_model` stayed absent, so even a forced pin would forward the alias name to an engine that does not serve it. The shipped test only passed because its fixture hand-registered `history.model: 'Flag'` — the alias-shape, not the live shape.

Fix (arbiter `aliasForSessionModel`, mirrored in the page's `sessLegalTargets`): resolve the session's alias **name first, then by the exact (session row, sniffed engine id) pair**. The pair match is row-constrained on purpose: a bare-name session that happens to share an id with some alias pair keeps the bare inventory rule, never alias legality.

New regression test pins the live shape: `#67 pins: an alias session with the LIVE sniff shape (engine id, not the alias name) resolves through its pair` (`server/test/arbiter.test.ts`). It asserts the cross-pair pin lands, the block carries the pinned pair's own engine id, a non-pair row is still refused, and the bare-session-sharing-an-id case keeps the bare rule.

Second (keyboard) finding: the first Arrow press on an unpreviewed pipe resolved to `targets[0]` — which can be the session's **current** row — so nothing previewed and the following Enter wrote nothing. Fixed to land on a **different** legal engine (the same rule Enter's default uses).

## Live acceptance (scratch stack, production untouched)

Throwaway driver: `:18811` scratch arbiter (scratch state file), `:18812` beta + `:18813` alpha fake OpenAI engines (strict: 404 `model_not_found` on any other model id — the splice fence; steppable SSE for phase proof), `:18814` scratch daemon aggregate (`proxy_port: 0`, so `:11435` was never bound). Real `client/config.json` and `data/state.json` untouched; production ports untouched; driver clears scratch ports at boot and exit and holds a single-instance lock.

Proven live, in order (full PASS transcript in `run/accept.out`):

- boot: arbiter up; scratch daemon registers with `proxy_port 0`; rows added, probe-cycle publishes the catalog; one poll tick and the router's aggregate `/v1/models` names the alias exactly once.
- **A — alias dispatch + #66 splice + phase ride**: alias request routes to the winner (beta), one continuous 200 stream; beta received the spliced `model-b-id`; the session row carries the real catalog row id + the sniffed engine id; a held stream parks the slot (`gate.state: active`); `phase: thinking` rides `/api/state`; the thinking→output transition rides the heartbeat immediately.
- **B — the queued switch (the owner scenario)**: a second request for the active session is parked at the router (`queued · #1`, body unconsumed); the operator pins it to the **other alias pair row** (accepted — the fixed path); `/api/state` publishes the resolved `engine_pin` block with `engine_model=model-a-id` (the splice key); after one daemon poll, the slot releases and the **parked request lands on alpha** — one continuous 200, no client resend — and alpha's `/hits` shows the spliced `model-a-id` body. The #45 ring counted exactly 2 requests for 2 user actions: **the switch counted zero extra** (no double count).
- **C — the running-stream fence**: while a held stream runs on beta, the pin writes fine; when the stream finishes it **completes on beta** — the pin never aborted or moved it — and alpha's hit count never grew for the running request. The **next** request then follows the pin to alpha, proving the fence is exactly "from admission on." The pin **persists** for later requests; `{server_id: null}` clears it and dispatch falls back to the alias winner.
- **D — fail-open**: with the arbiter killed, the parked request was released anyway (no 503 wedge), post-kill traffic admitted.
- Sweep: the unit suite proves a pin orphans with its session row; the acceptance stack proves a session row disappears after idle (`last_seen` age > 5 min) with the pin gone in the same save.

## Surface harness (throwaway, not committed)

The inline flow view was booted in a vm stub-DOM harness (the `server/test/page-agents.test.ts` pattern): breakout by model name, per-machine counts, engine load stats straight off the rows, pipe classes (queued warn / phase green-purple / fail-quiet base), the phase-age limit, ArrowDown preview + Enter pin POST carrying the gate token, refusal reverts with the reason told, no-token refusal, Esc cancel, pin-clear write shape, rows-mode untouched. 12/12 after the arrow-key fix; the harness also served as the regression net for the page-side alias-pair mirror fix.

## Gate transcripts

- `server`: `npx tsc --noEmit` clean; `node --import tsx --test test/arbiter.test.ts` → 66/66 pass (includes the new live-shape pin test); full `npm test` → 208 pass / 0 fail.
- `client`: `npx tsc --noEmit` clean; `npm test` → 129/129 pass (includes the new block-incomplete fall-through test).
- `server/test/page-agents.test.ts` → 1/1 pass.
- Flow-page harness (`67accept/flow-page-harness.mjs`) → `HARNESS-67-ALL-PASS`.
- Live acceptance (`67accept/accept.mjs`) → `ACCEPTANCE-ALL-PASS`, exit 0 (A1–A6, B1–B6, C2–C7, D3–D5; driver waits anchored on the gate's own log lines, never sleep gambles).

## Notes

- The flow view ships on the legacy page (`server/public/index.html`). If the flow view moves to the React dashboard (#72 Resources rethink), the brief's "surface relocations follow it free" clause applies: the pins are server data, the flow view is a render of it.
- `model_aliases` doc note: `docs/architecture/model-aliases.md:470` deferred the "second-call" sniff-boundary item to #67 — the response-phase sniffer + this session's pair-resolution fix close it; the model-aliases doc itself stays as written (#66 owns it).
- Scratch harnesses/acceptance drivers live under `~/.hermes/profiles/web-dev/cache/scratch/67accept/` and are throwaway; they were deliberately not committed (the repo's committed test tiers carry the regression coverage instead).
