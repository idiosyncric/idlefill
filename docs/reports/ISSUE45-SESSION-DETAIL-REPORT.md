# Issue #45 — session detail: per-session request history + model (additive slice)

Date: 2026-10-05. Landed on `main`. Screenshot: `ISSUE45-session-detail.png`.

## What the issue asked

A session row is one timestamp deep. The router sees every request, so it
can carry: a compact request history (requests/min over the last 10
minutes), the model each session negotiated, and token usage. Dashboard
rows show the facts inline.

## What landed

### Router side (`client/src/session-gate.ts`)

- **Request ring** per session: epoch-ms of every request the router sees
  (forwarded OR parked — a parked request is still a request), capped at
  240, in-memory only (a restart starts empty).
- **Model + tokens from the RESPONSE, never the request body.** The first
  implementation peeked the request body's first chunk for `"model"`.
  That broke the gate: a parked request's body must stay UNCONSUMED for
  the forward on admission, and a `req` data-listener drains it — tests
  (c)/(e) failed instantly. The fix reads the piped upstream RESPONSE
  instead: an OpenAI-compatible engine echoes the served model in its
  response body, and its streamed `usage` block carries `total_tokens`.
  An extra `data` listener on a piped readable observes copies — it never
  steals bytes. The peek detaches once both facts are known.
- **`history` ADD-key on the register heartbeat**: `{ rpm: number[10],
  model?, tokens? }` — per-minute counts (60s buckets, oldest→newest,
  always 10), computed by the router at report time. Absent for a session
  with no recorded traffic; an old arbiter ignores the key.

### Arbiter side (`server/src/arbiter.ts`, `types.ts`, `api.ts`)

- `SessionRecord.history` with `reported_at` (the arbiter's arrival
  stamp). Sanitizer posture as always: per-key drop-don't-reject (rpm
  entries must be integers 0..1e6, truncated to the newest 10; model
  rides the id sanitizer; tokens an integer 0..1e12; a block with nothing
  valid is treated as absent). Absent leaves the stored block standing —
  heartbeats with traffic refresh it, a report without never clears it.

### Dashboard (`server/public/index.html`)

Exception-only, per row: a `model <name>` tag, a `18.4k tok` count, and a
tiny inline sparkline (the Usage section's existing hand-written SVG
helper — no chart library) rendered from `history.rpm`. A row with no
history block (old router, no traffic) renders EXACTLY as before.

## Live proof

Throwaway arbiter on `:18899` (current code) with three sessions: two
carry history blocks (chatty rpm + model + tokens; flat rpm + different
model), one registers legacy-style with nothing. The Sessions view renders
`model qwen3.8-27b-ninfer` + `18.4k tok` + rising sparkline on row one,
`model gpt-oss-120b` + `900 tok` + flat sparkline on row two, and the
legacy row shows none of the extras.

## Tests

- client `session-gate.test.ts`: 19 pass — the fake upstream now echoes
  model + usage like a real engine; a new end-to-end test asserts the
  ring counts a forwarded request (newest bucket = 1), a parked request
  counts too, and the model/token sniffs reach the heartbeat's `history`.
- server `api.test.ts`: 50 pass — history block stores+echoes verbatim
  with `reported_at`, malformed keys drop per-key, an all-empty block is
  absent, an absent report never clears a stored block; the dashboard
  markup carries the model tag / sparkline.

## Scope — what did NOT land (and why)

- **Desktop (SwiftUI) detail drawer**: retired surfaces — the desktop app
  embeds the dashboard page (#61), so the dashboard inline rendering IS
  the surface now.
- **Per-worktree attribution**: needs the plugin path (the middleware
  knows cwd; the router only sees tokens). Converges with #42's plugin
  slice.
- **Server-side history persistence**: the ring is intentionally
  in-memory. The arbiter stores only the latest compact snapshot; history
  older than that dies with the router — the acceptance bar asks for
  live heat, not archaeology.
