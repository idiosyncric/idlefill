# Issue #59 — Live inference-server load in the glance panel

Built + gates green on `issue-59` (worktree `.wt/59`, base `4369a37`).

## What was built

The glance panel (the Tauri shell's retired-menubar surface, #69) now shows
each declared inference server's live load, projected from the arbiter's
`/api/state` `servers[]` rows (`serverView` in `server/src/api.ts`) — no new
API surface; the poll already fetches that payload every 5 s.

**Rust pure spec (`tauri/src-tauri/src/glance.rs`, the verdict's home):**

- `ServerRow` — one server's compact readout: `name`, `running` (the row's
  `models[]` entries with `running: true`), `queued` (their `queued` totals,
  saturated), `idle_readout` (the signal's `idle_for_s` formatted as
  `idle 90s` / `idle 10m 30s` — None when the signal carries no
  `idle_for_s`; fail-closed like #62, never an idle countdown that wasn't
  proven), and the `degraded` marker.
- `project_server_loads(payload)` — projects `servers[]` (the same shape the
  arbiter's `serverView` emits: per-row `signal` with `idle` /
  `idle_for_s` / `degraded` / `degraded_reason`, per-model
  `{name, running, queued}`). A row without a `name` doesn't render; an
  empty/absent `servers` array yields no rows — the section renders nothing
  (Exception-Only).
- `server_load_lines(row)` — the row's display lines, Exception-Only:
  - a **signal-less** row (`signal: null` — no detector yet — or a signal
    with no `idle_for_s`) renders a dim `no signal` line, **never a fake
    zero**;
  - a **degraded** row (`signal.degraded: true`) renders the `degraded`
    marker line (red in the view);
  - a healthy row renders the load facts line ONLY when non-zero
    (`2 running · 3 queued` — zero buckets omitted, the
    `sessions_count_line` convention).

**Wiring (`tauri/src-tauri/src/lib.rs`):** the 5 s `poll_glance` loop (the
only native poll — no new polling loop) projects the servers on the same
payload and stores them in `GlanceState.server_loads`; `glance_state` IPC
emits `serverLoads[]` = `{name, line, status, tone, idle}` with `tone`
`"err"` for degraded rows and `"dim"` for everything else. The glance
window (fixed, `overflow: hidden`) now sizes itself to the projected rows
on each toggle: 220 px base + 34 px per load row, capped at 340 px, re-applied
while open so a row landing between ticks fits.

**View (`tauri/ui/src/glance.tsx` + `tauri/ui/src/lib/ipc.ts`):** a
`GlanceServerLoad` type + `serverLoads: GlanceServerLoad[]` on `GlanceState`.
The section renders between the session exception lines and the action rows,
using the existing tokens only — console text for the name (row identity),
`text-dim` for the load facts / idle countdown / `no signal` line, `text-err`
for the `degraded` marker (DESIGN.md: red = failure, amber =
operator-actionable — a load-less or no-signal row is neither, so no
`text-warn`). Empty section = nothing rendered.

## Decisions honored

- **Pure spec + cargo tests pin the verdict** (the D1 rule): the view is a
  projector over `glance_state`'s JSON; it recomputes nothing.
- **Exception-Only** at every level: no servers → no section; healthy
  load-less row → name only, no fake `0 running`; signal-less row → dim
  `no signal`, no fake zero / no fake idle.
- **No new API surface**: `GET /api/state` already carries `servers[]`
  expanded by `serverView` (per-row `signal` + per-model facts).
- **No new polling loop**: the existing 5 s loop + the existing
  `window.__glanceRefresh` seam carry the data.
- **Design tokens only**: existing `text-dim` / `text-err` / `text-warn`
  classes (no new classes; `font-semibold` + arbitrary-value spacing are
  already in use in this view).
- **Committed build output is the embedded surface** (Q-b): the regenerated
  `tauri/settings-ui` assets are committed with the change.

## Harness + build output

Run for real in the worktree:

- `cargo fmt --check` — exit 0, **zero hunks** (baseline on `4369a37` was
  already clean; the pre-existing ~30-hunk drift the brief mentioned is not
  present at this HEAD).
- `cargo clippy -- -D warnings` — exit 0 (the only output is the pre-existing
  Cargo.toml `debug_assertions` manifest warning, present at baseline).
- `cargo test` — 54 passed; 0 failed. 4 new tests in `glance::tests`
  (`server_load_running_queued_and_degraded_rows`,
  `server_load_signalless_row_never_fakes_a_zero`,
  `server_load_empty_or_absent_servers_render_nothing`,
  `idle_readout_omits_whole_units_when_zero`) + the 50-test baseline suite
  green.
- `NODE_ENV=test npm run build` (`tsc --noEmit && vite build`) — exit 0
  (vite 6.4.4, 148 modules, built in ~13 s); `tauri/settings-ui` regenerated
  (glance bundle re-hashed, `serverLoads` projection in the emitted chunk).

## Live verification

The spec's behavior is pinned by the cargo tests above (fixture payloads
mirror the live `serverView` shape). The window surface is the bundled
`tauri/settings-ui` output — verified by the build gate; opening the tray
glance on a running instance is the operator's acceptance step (the branch
is unmerged by design).
