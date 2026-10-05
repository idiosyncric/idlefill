# Issue #42 — Hermes plugin as the native session gate (tracker mirror)

The Forgejo issue body is the authority:
https://git.samwarth.com/sam/idlefill/issues/42
This file mirrors additions as they land (keep it in sync when the body is PATCHed).

## Slice 0 — session-id header contract (added 2026-10-05, owner ask)

Today Hermes does NOT identify its session on the wire (measured):
- Provider requests carry only `User-Agent: HermesAgent/<version>`
  (`providers/base.py:404`, `agent/codex_headers.py:45`). The session id
  exists (the TUI banner's `Session: <id>`) but nothing forwards it.
- idlefill's session rows are keyed by the hand-set `/s/<token>` path token
  (`SessionRecord`, server/src/types.ts:351; router registration,
  client/src/index.ts:1513). Nothing links the two names for one chat.

Slice 0 = the header plane, additive and useful standalone (before the
middleware plugin lands, and it survives the plugin):

1. Hermes: every provider client sends `X-Hermes-Session-Id: <id>` (+
   optionally `X-Hermes-Model`). Seam: `client_kwargs["default_headers"]`
   at client init (`agent/agent_init.py:832-836` falls back to
   `profile.default_headers`; one injection point covers all providers).
2. idlefill router: capture the header at the loopback proxy; store
   `session_id?` as an ADD-key on `SessionRecord` (never rename). The
   plugin path (middleware `llm_execution` sees the real session_id per
   call) and the header path converge on the SAME stored field — one
   contract, two sources, first-writer-wins per heartbeat.
3. Surfaces: dashboard + desktop (and #61's webview) render the id
   exception-only on session rows — a row that never carried one renders
   unchanged. Non-Hermes clients simply have no id.

Wins immediately: distinct rows per concurrent chat on one profile (the
"why is there only one row" complaint from #42's context, observable even
before the gate plugin), and the sessions list shows the same id the TUI
banner shows.

Acceptance for slice 0: two concurrent Hermes chats on one profile appear
as two rows distinguished by session id; a curl request with no header
still works exactly as today; the idlefill suite covers the add-key
capture + sanitizer posture (bounded strings, drop-don't-reject).
