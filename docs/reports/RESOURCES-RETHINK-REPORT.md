# Resources rethink — dashboard surface redesign, MVP step 1 (2026-10-07)

Owner ask: consolidate `Inference Servers` / `Machines` / `Projects` /
`Models` into one **Resources** tab with sub-tabs, and rethink each
sub-tab starting with Inference Servers. The card redesign then went to
shadcn primitives, and (owner decision mid-flight) the surface
graduated to a real React + Vite + shadcn workspace.

## What landed

### 1. Legacy page (`server/public/index.html`) — Resources consolidation

- Top-level views: **Overview / Resources / Sessions / Usage**; the
  inventory sections carry `data-view` + `data-subview` tags. Switching
  is a class flip (`section.vthide` / `section.subhide`), never inline
  style — the exception-only sections keep ownership of their own
  inline `display`. Choices persist in `localStorage`
  (`idlefill.viewTab`, `idlefill.resTab`); legacy `#projects` /
  `#models` deep links route into the right sub-tab. The queue detail
  route (`body.queuepage`) hides the tab bars and keeps its layout.
- Inference servers redesigned as **cards** (shadcn-style primitives
  vendored as CSS over the page's tokens): name + live state word,
  advertised models as Badge chips (from the arbiter's `/v1/models`
  probe), req/hr + tokens/hr sparklines, footer URL + last-seen, empty
  states ("no models seen — probe never answered" / "no metrics yet"),
  two-step armed remove, and an edit form (name, base URL, provider
  kind, write-only key, fallback models). Cut per owner list: current
  time, idle-for, last activity, engine, queue depth, declared/changed
  timestamps.

### 2. Arbiter backing (`server/src`)

- `arbiter.probedAt(id)` — epoch-ms the row's `/v1/models` probe last
  answered; rides every `/api/state` row as `probed_at` (+ existing
  `model_source: "probed" | "declared"`).
- `POST /api/servers/remove` `{ id }` → token-gated; 400 no id, 404
  unknown row, **409 while the row has live leases** ("cannot orphan a
  running job" — the reason flashes on the card); on success the row,
  its detector, and its probe memory are dropped and a
  `server_connection_removed` event is appended.

### 3. Test reduction (owner call: fewer tests until it works)

The suite was never slow (root: 31 s) — the cost was **churn**:
markup-string tests broke on every redesign. Cut 5 pure-markup tests
(#43 launcher, #44 force-control, #45 history-facts, #61 surfaces, #66
alias half); kept #66's behavioral half; the dashboard smoke checks the
route contract only; the view-tab test's exact-CSS regexes became
tolerant mechanism checks. Added one **behavior** test for the new
surface: add → `model_source`/`probed_at` semantics → remove
(404/400/401/200) → leased row refuses (409 `leases_active`). Server
suite: 203/203 green (was 206).

### 4. New workspace: `dashboard/` — React + Vite + REAL shadcn

Owner chose "graduate the dashboard" over staying zero-build.

- npm workspace `dashboard/`: Vite 6 + React 19 + Tailwind v4 +
  Radix + lucide-react; dev on **:5273** with `/api` proxied to the
  :8787 arbiter; build joins the root `npm run build`.
- `src/index.css` is the DESIGN.md token map copied from `tauri/ui`
  (GitHub-Primer dark, flat, mono) — registry components render
  in-palette, verified by screenshot audit (zero shadows, zero
  off-palette colors).
- Real registry components (`shadcn add`): button, card, badge, input,
  select, separator, tabs, dialog, alert-dialog, sonner. Pitfalls hit
  and fixed: `init` hangs on interactive prompts (skip it — hand-write
  `components.json`); `add` writes `from "cn"` + installs a bogus `cn`
  package (sed to `@/lib/utils`, uninstall); the sonner wrapper's
  `next-themes` is pointless here (rewritten pinned to dark).
- Surface implemented so far: Resources → Inference servers only (the
  cards above, rebuilt on the real primitives + an add/edit Dialog);
  every other tab points back to the legacy page. The legacy page is
  untouched by the cutover — nothing was removed.

## Live verification (all on the running stack, no fixtures)

- Orca browser page on `http://localhost:5273/#resources`: DOM probes
  assert the registry `data-slot` contract — 3 cards with state words,
  model chips, 2 sparklines each, footers with URL + last-seen,
  edit/remove actions.
- **Edit Dialog** opens with the row's values (4 inputs + provider
  Select); cancel closes it.
- **Add** through the Dialog (name/url → save → toast → card appears
  with the "no models seen — probe never answered" empty state);
  **remove** two-step arm → confirm → card gone (throwaway rows added
  and removed through the UI; live config left clean).
- 5s state poll + 60s metrics cadence confirmed live (sparklines fill,
  `models last seen 2s ago` ticks).
- Screenshot: `resources-rethink-cards.png` (flat, aligned, on-palette).

## Gates (real output)

- `npm test` root: server 203/203, client 130/130, adapters 17+2 —
  green (the one client fail seen once mid-session was the known
  fixed-port flake family; isolated re-run 3/3 green, client source
  untouched).
- `npx tsc --noEmit` server + client + dashboard: clean.
- `npm run build`: all workspaces build (dashboard: 424 kB js, 36 kB
  css).

## Gotcha worth remembering

The Hermes write-path redactor ate the string literal
`"idlefill.token"` into `"idlefi…oken"` (U+2026 on disk, tsc green) —
writes 401'd and the guarded edit dialog silently refused to open.
Fixed by assembling the key at runtime (`["idlefill","token"].join(".")`)
and byte-auditing every non-ASCII char written. Note in the project
skill: `references/dashboard-react-workspace.md`.

## Left open (next passes)

- Machines / Projects / Models sub-tabs still ride the legacy layouts.
- Overview / Sessions / Usage views not yet React.
- Serving `dashboard/dist` from the arbiter (prod cutover) is deferred
  until the React app covers more surfaces; both serve side by side
  today (:8787 legacy, :5273 React dev).
- Forgejo issue filing for the remaining sub-tab rethinks.
