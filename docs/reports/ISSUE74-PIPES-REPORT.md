# Issue #74 — the #67 pipe/phase flow view, ported into the React Sessions view

Owner decision 2026-10-14: PORT the #67 flow view into the React dashboard. The
#68 theme report named this gap explicitly ("the #67 pipe/phase colors have no
served surface … tracked in #74 … until the pipe surface is decided") — this
build decides it.

## What shipped (dashboard read-side only — ZERO server/client/wire changes)

- `dashboard/src/lib/pipe-phases.ts` (new, pure): the state→phase mapping, the
  shared edge tooltip text, and the orthogonal rounded connector path builder.
  No DOM, no fetch, no timers — the same "pure lib + pinned tests" shape as
  `session-edge.ts` (alias-stability D4) and `hierarchy.ts`.
- `dashboard/src/views/Sessions.tsx`: the existing FlowView keeps its columns,
  its load counts, its D4 exception annotations, and the engine/posture words
  byte-for-byte; on top of it an `aria-hidden` SVG layer draws one orthogonal
  connector per session→engine edge, colored by the pure mapping. Geometry is
  measured from the already-rendered DOM on each render (the 5 s poll re-runs
  it) — zero new network calls, zero new state.
- `dashboard/src/index.css`: the `--pipe-*` tokens as SEMANTIC DERIVATIONS of
  the configured palette — `--pipe-base: var(--border)`, `--pipe-queued:
  var(--warn)`, `--pipe-thinking: var(--ok)`, `--pipe-output: var(--accent)`,
  `--pipe-tools: color-mix(in oklab, var(--accent), var(--err))`. A #68 theme
  write to `--ok/--warn/--accent/--border` moves the pipes with it; there is no
  hardcoded legacy set and no new editable key (the #68 map stays nine). The
  built CSS carries Tailwind's `@supports (color:color-mix(in lab,red,red))`
  guard: on a browser without `color-mix` the purple degrades to the configured
  accent — still palette-derived, never a hardcoded hex.
  Motion runs engine→session on live streams only, gated by
  `prefers-reduced-motion: no-preference`.
- `dashboard/test/pipe-phases.test.ts`: 15 new tests — 9 pure mapping cases,
  the path builder, and four source-pinned render invariants (SVG is
  decoration with the shared title; zero new calls in the flow view; grid
  regressions intact; tokens derived, not hardcoded; nine theme keys).

## The signal → phase mapping (pinned by tests)

| Signal present on the published row | Pipe phase | Render |
| --- | --- | --- |
| `gate.state: 'queued'` (held at the router) | `queued` | warn color, dashed 5 4, no motion — outranks every other signal, exactly as #67 did |
| `phase.state: 'thinking'` fresh (< 10 s, the #67 `FLOW_PHASE_MAX_AGE_MS`) | `thinking` | green (`--ok`), animated engine→session |
| `phase.state: 'output'` fresh | `output` | blue (`--accent`), animated |
| `phase.state: 'tools'` fresh | `tools` | purple, animated |
| engine row NAMES a fresh `queue_depth > 0` (`load_age_s` ≤ 15 s, the D4 freshness window), session not queued, no phase | `queued` | warn dashed, NO motion — engine-side congestion is a published fact, but it is not a stream |
| engine row degraded / no-signal (or no signal at all), nothing else | `base` | border color, dotted 2 3, 0.5 opacity — the existing no-signal posture |
| anything else | `base` | calm idle, solid, quiet |
| phase report older than 10 s | `base` | never the last known color — a stalled report renders idle |
| `queue_depth` from a stale sample | `base` | the stale-sample honesty stays on the grid annotation, not the pipe |

Precedence, as tested: held gate → live stream phase → engine queue depth →
no-signal posture → base. A stream beats engine congestion; a held request
beats a stale phase report.

## Decisions honored

- **#67 visual contract**: orthogonal rounded connectors, session→engine
  columns, semantic colors from design tokens, motion on the pipe from engine
  toward the session, capped and reduced-motion aware. The legacy 120 px
  connector lane becomes a wider column gutter (`gap-14`) so the pipes have a
  legible run without changing the grid's content.
- **#68 theme plane**: the pipe colors follow the configured palette, not the
  legacy hardcoded set — proven live by overriding `--ok/--warn/--accent` and
  watching every pipe stroke follow, including the derived purple.
- **#67 D8 honesty**: engine-internal request queues are not modeled; only the
  published `queue_depth` ADD-key (present when the row's kind names one) can
  warn a pipe. Absent means nothing is claimed.
- **Grid stays functional**: pins, the `re-route…` affordance and exception-only
  annotations are unchanged in rows mode; the flow view draws the SAME edge with
  the SAME tooltip text (`pipeTitle` is the only source), so the decoration
  never contradicts the row. The SVG is `aria-hidden` and pointer-events none —
  no new screen-reader surface, the row semantics already carry it.
- **No optimistic state**: the pipe shows server truth from the poll; a pin
  write appears on the next tick (the shipped D4 posture). The legacy page's
  drag/pending-preview machinery is not re-built — the pin select is the
  affordance, and the report's one-line help says so.
- **The legacy flow view**: nothing to delete — `server/public/index.html` was
  retired in the dashboard cutover (`35803ab`), so the #67 design survives as
  reference in git and in `ISSUE67-{BRIEF,REPORT}.md`. The port does not
  re-create the page.
- **Zero wire change**: no new keys on `/api/state`, no new routes, no new
  theme keys. Exactly the hierarchy-wave pattern: a read-side projection.

## Live proof (scratch loopback :18744, production untouched)

The built `dashboard/dist` was served on `127.0.0.1:18744` by a throwaway
fixture harness (a stub `/api/state` with six sessions across three engines:
thinking / output / tools streams, one gate-queued pinned session, one
queue-depth-only session, one engine with no signal at all). Rendered DOM
assertions from the shipped bundle:

- six connectors drawn (`aria-hidden="true"`), geometry measured from the grid:
  each path starts at the session row's right edge and ends at the engine row's
  left edge (x 514 → 523 for the first pair), with the vertical runs the
  columns require (42 px lane, heights 6–159 px).
- strokes read exactly the tokens: `pipe responding thinking` =
  `rgb(63,185,80)` (= `--ok`), `output` = `rgb(88,166,255)` (= `--accent`),
  `tools` = `oklab(0.690 0.069 -0.026)` (= the accent/err mix), `queued` =
  `rgb(210,153,34)` dashed `5 4` (= `--warn`), `muted` = `rgb(48,54,61)` dotted
  `2 3` at 0.5 opacity (= `--border`); animation `pipeflow` on the three
  stream pipes only.
- theme cascade: setting `--ok:#ff0000 / --warn:#00ff00 / --accent:#0000ff /
  --border:#000000` on `<html>` moved every pipe stroke to match (green→red,
  warn→green, muted→black) — the pipes follow the configured palette.
- tooltip parity: the grid span and the SVG path carry byte-identical titles
  (e.g. `session dddd-444 → engine llamaswap-alpha · operator pin — lands at
  release time · queued at the router`).
- rows mode untouched: the same fixture renders the dense rows (pins, queued
  badge, `re-route…` on the slow edge) with no flow SVG present.
- screenshot: `ISSUE74-pipes-flow.png` (flow mode, all five phases visible).

## Gate transcripts

```
NODE_ENV= npm run test        # repo-wide: 1130 pass / 0 fail
  server 503, client 295, cli 147, career-ops 17, noop 2, fleet 3,
  dashboard 94 → 109 (+15 pipe-phases), tauri settings 54
npx tsc --noEmit -p dashboard/tsconfig.json   # clean
NODE_ENV= npm run build                       # all workspaces green;
                                            # dashboard/dist regenerated + committed
```

(Baseline before this slice: 1115/1115.)

## Refused, and why

- **No invented phase signals.** The stream phases ride the existing #67 `phase`
  ADD-key on the register heartbeat; anything else (per-token token-type
  deltas, tool-name detail, `/chat/stream`-style event streams) does not exist
  on the plane, so no pipe claims it. Where a signal is absent the edge is
  base or the no-signal posture — never a guess.
- **No drag-to-reroute on the pipes.** #67's drag wrote through the pin plane;
  the dashboard's functional affordance is already the pin select (rows mode)
  and the D4 pair chooser. Adding a second drag surface would duplicate a write
  path and add pointer/keyboard state the grid does not need.
- **No new theme keys.** `--pipe-*` are derived, not configured — the #68
  sanitizer's known-key list and the Settings view stay nine rows.
- **No light theme, no WS plane** — out of scope here, as in #68.
