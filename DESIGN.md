---
name: idlefill
description: The Quiet Control Room — the operator console for idle-gated background work on a local LLM server.
colors:
  bg: "#0d1117"
  panel: "#161b22"
  border: "#30363d"
  text: "#c9d1d9"
  dim: "#8b949e"
  ok: "#3fb950"
  warn: "#d29922"
  err: "#f85149"
  accent: "#58a6ff"
typography:
  display:
    fontFamily: "ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace"
    fontSize: "22px"
    lineHeight: "1.5"
  headline:
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "0.5px"
  body:
    fontSize: "13px"
    lineHeight: "1.5"
  aux:
    fontSize: "12px"
    lineHeight: "1.5"
  label:
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "1px"
  micro:
    fontSize: "11px"
    lineHeight: "1.5"
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "14px"
  xl: "16px"
  page: "20px"
components:
  section-panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
  gate:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    typography: "{typography.aux}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  gate-small:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    typography: "{typography.micro}"
    rounded: "{rounded.lg}"
    padding: "1px 4px"
  tag:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    typography: "{typography.micro}"
    rounded: "{rounded.lg}"
    padding: "0 6px"
  tag-ok:
    textColor: "{colors.ok}"
  tag-warn:
    textColor: "{colors.warn}"
  tag-err:
    textColor: "{colors.err}"
  tag-accent:
    textColor: "{colors.accent}"
  budget-bar:
    backgroundColor: "{colors.border}"
    rounded: "{rounded.xs}"
    height: "6px"
  input-token:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    typography: "{typography.micro}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
---

# Design System: idlefill

## Overview

**Creative North Star: "The Quiet Control Room"**

The idlefill dashboard is an instrument panel, not a website. It sits on a dark canvas in one monospace family at a density an operator can read across the room in a single glance: a color-coded state word, a kill-switch combobox, two data panes (Inference Servers, Projects), and a log dock pinned to the bottom edge. The page polls every 5 seconds and redraws itself; nothing animates, nothing floats, nothing asks for attention. The only saturated pixels on the page are live state.

Color is scarce by doctrine. A single neutral ramp — the GitHub dark (Primer) palette, used unmodified — carries all structure: panels, hairlines, labels, empty states. Four signal colors (green, amber, red, blue) appear only where a live verdict needs them: the Idle/Busy/Running Idle Tasks/Degraded word, online dots, the budget bar, and exception tags. If a pixel is colored, something is happening.

Depth is tonal, not lifted: the canvas sits darker than the slate panels, and 1px hairlines do the work shadows would. Radii are small and utilitarian (3–10px), borders always 1px. The result is a control room that stays quiet while the machine sleeps — and speaks plainly the moment it wakes.

**Key Characteristics:**
- One monospace family, 11–13px base, a single 22px display number
- Four signal colors, state-only: green quiet, amber blocked, red failed, blue working
- Zero shadows; tonal layering plus 1px hairlines
- Fluid auto-fit panel grid (min 340px columns), no media queries
- Exception-only tags: no tag is the healthy state
- Fixed bottom logs tray (a dock) with a single 150ms chevron transition

## Colors

A dark, unmodified GitHub-Primer-family palette: one neutral ramp, four signal colors. Structure is gray; state is color.

### Primary
- **Signal Blue** (#58a6ff): the page's only accent. Links, the "Running Idle Tasks" state word, the budget-bar fill, and the event-kind column. Blue means background work is actively running.

### Secondary
- **Signal Green** (#3fb950): healthy and quiet. The "Idle" state, the ok idle-countdown, online worker dots, the "active" tag, and ok signal-health.
- **Signal Amber** (#d29922): blocked or at risk. The "Busy" state, low-ttl warnings, the re-idle gate "armed" note, paused/forced/budget-full tags, and the hot budget-bar fill (past 80% of the daily cap).
- **Signal Red** (#f85149): failure. The "Degraded" and "unreachable" states, the paused-client override badge, and degraded signal health.

### Neutral
- **Midnight Canvas** (#0d1117): page background; also the fill of controls (gates, tabs, token input) — controls sink into the canvas.
- **Console Slate** (#161b22): the panel surface — sections, header, logs tray, active tab.
- **Hairline** (#30363d): every border and divider; at 50% alpha (rgba(48,54,61,0.5)) as the softer divider inside tables and project blocks.
- **Console Text** (#c9d1d9): body text, values, tabular data.
- **Muted Gray** (#8b949e): keys, secondary metadata, empty states, offline dots, the 11px panel heads.

### Named Rules
**The One Word Rule.** The state is the word, not the frame. Live state rides the color-coded status word; control frames around it — comboboxes, borders, default badges — stay neutral.

**The Exception-Only Rule.** Tags appear for exceptions only (paused, budget full, forced). No tag is the healthy state; a "running" or "scheduling" tag is noise.

## Typography

**Display Font:** the mono stack (ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas)
**Body Font:** the same mono stack
**Label/Mono Font:** the same — one family on the page

**Character:** the entire surface is system monospace; hierarchy is built from size, weight, and tracking rather than a second family.

### Hierarchy
- **Display** (400, 22px, 1.5): one number on the page — the idle countdown, colored ok/warn by verdict.
- **Headline** (600, 15px, +0.5px tracking): the page title "idlefill · arbiter" in the header.
- **Body** (400, 13px, 1.5): base reading size; kv values and table data.
- **Aux** (400, 12px, 1.5): tables, the status word, gates, and the header subtitle line.
- **Label** (600, 11px, +1px tracking, uppercase): pane heads ("Inference Servers", "Projects", …) and the logs-tray toggle.
- **Micro** (400, 11px, 1.5): schedule lines, tags, tray metadata, footer, per-client gates.

### Named Rules
**The One Typeface Rule.** There is one family on the page. Hierarchy comes from size, weight, and tracking — not from a display face.

## Layout

A fluid, breakpoint-free rhythm: full-width header (14px 20px) → main grid → footer (10px 20px) → fixed logs tray docked at the bottom (the body reserves 40px of clearance). Main is `repeat(auto-fit, minmax(340px, 1fr))` with a 14px gap — panels reflow one-to-many across the viewport with no media queries. Panels take 12px 14px padding; kv rows 2px 0; table cells 3px 6px; project blocks 8px 0 with the 50%-alpha hairline between them. Density is the identity: 11–13px everywhere, 22px for a single number.

## Elevation & Depth

No shadows — the page has zero `box-shadow`. Depth is tonal layering: Midnight Canvas under Console Slate panels, and the 50%-alpha hairline where a divider must read. Controls sink (canvas fill inside a slate panel) rather than lift. The one state change that changes perceived position is the logs tray, whose body slides above its bar.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest and flat always; state is communicated with color and text, never lift.

## Shapes

A radius scale of 3 / 4 / 6 / 8 / 10px. 3px: the budget bar (fully rounded ends) and inline code chips. 4px: the tab group, selects, and the token input. 6px: panels. 8px: state tags and the small gate pill. 10px: the header gate pill. Borders are always 1px solid Hairline (or the 50% hairline inside tables). No clipping, no cut corners; the only outlined shapes are tags, whose border color carries the semantic.

## Components

### Panels (sections)
A quiet slate card: 6px radius, 1px Hairline, 12px 14px padding; an 11px uppercase Muted-Gray head sits 8px above the content. Panels never float, never gain a border emphasis — the grid gap does the separation.

### The State Word
The page's hero. A 12px/600 word at the right of the header, left of the gate: **Idle** (green), **Busy** (amber), **Running Idle Tasks** (blue), **Degraded** / **unreachable** (red). It carries a plain-words tooltip ("grants open" / "grants blocked" / "background work in progress" / "signal degraded — grants blocked").

### Gates
The operator's kill switch, in two sizes. Header (global): 10px pill, 12px type, 2px 8px padding. Per-client (in the Clients table): 8px pill, 11px type, 1px 4px padding. Both are canvas-filled with a 1px neutral border; the disabled state is opacity 0.55 when nothing is registered. Two fixed options: **Engine Paused** / **Engine Running** — the live state is never in the options.

### State Tags
11px, 8px radius, 0 6px padding, 1px border in the same color as the text: neutral (Hairline border, Console Text) for the default "active"; Signal Green "active"; Signal Blue "finished"; Signal Amber "revoked", "expired", "paused" (project), "forced"; Signal Red "paused" (client override).

### Budget Bar
A 6px-tall Hairline track with fully rounded ends and a Signal Blue fill; past 80% of the daily cap the fill turns Signal Amber (hot). It sits directly under the "output tokens today (UTC)" kv row.

### Worker Rows
One line per allocated worker: a 7px dot (green online, Muted Gray offline) · bold name (min 84px) · dim meta ("model · ~est/job") · right-aligned "N queued". A tooltip explains the columns in plain words.

### KV Rows
Key left (Muted Gray) / value right, 2px 0. The only place the 22px display size appears is the idle-countdown value.

### Tables
12px; header row is Muted Gray 600 with a 1px Hairline underneath; body rows divide with the 50% hairline; no zebra striping.

### Logs Tray
A fixed bottom dock: a slim slate bar (5px 16px) holding an uppercase 11px toggle with a chevron (the page's only transition, 150ms ease), the Events/Leases/Client log tab group (4px radius; active tab slate-filled with Console Text, inactive canvas-filled with Muted Gray — the Client log tab is Exception-Only: it exists only while a client publishes its log tail, and only on a loopback arbiter), and a records-to-show select (10/25/50/100). Expanded, the body (canvas background, 1px top hairline, max 45vh) slides above the bar.

### Empty States
Muted Gray italic — "no active lease", "none registered", "no events yet". The null case is always legible; there are no illustrations.

## Do's and Don'ts

### Do:
- **Do** let one color-coded word carry the live state (Idle / Busy / Running Idle Tasks / Degraded) and keep every frame around it neutral.
- **Do** divide with 1px hairlines: Hairline at panel edges, the 50% hairline inside tables and project blocks.
- **Do** reflow panels with the auto-fit grid (`repeat(auto-fit, minmax(340px, 1fr))`, 14px gap) instead of adding breakpoints.
- **Do** set every panel head at 11px / 600 / +1px tracking, uppercase, Muted Gray.
- **Do** reserve the 22px display size for the idle countdown alone.
- **Do** keep schedule lines in plain words: "runs when idle ≥Ns · max N jobs at a time · auto-cancels after Xm".

### Don't:
- **Don't** add shadows or gradient washes — depth is tonal layering plus 1px hairlines only (the page has zero box-shadow).
- **Don't** render a tag for the healthy state: no tag means running, fine (no "running", no "scheduling").
- **Don't** animate anything but the tray chevron (150ms ease); the page redraws every 5s, so motion is a defect.
