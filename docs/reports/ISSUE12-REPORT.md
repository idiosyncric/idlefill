# Issue #12 report — Menu bar: multi-machine / multi-project scope

Branch `issue-12-menubar-scope` (base `b6dd837` = main). All acceptance
criteria proven by the new headless harness `menubar/scope-test.sh`
(real app source minus `@main` + a driver, `env -i` GUI environment,
against canned payloads AND a throwaway arbiter) plus the existing
harnesses. Production was never touched (throwaway ports only; the
production daemon PIDs and `node_modules` mtime are asserted unchanged
at the end of `uc-update-test.sh`).

## What changed (per file)

### `menubar/IdlefillMenubar.swift` (the app — all of issue #12)

- **`ClientConfig` (parsed once).** The gitignored client config is now
  parsed ONCE at launch into `ClientConfig` (`token` + `server_url` +
  `client_name`), replacing the old `token()`/`serverURL()` pair that
  re-read and re-parsed the same file on every call. The token rides
  from here into the `Authorization` header only — never printed,
  logged, or baked into the bundle.
- **`ScopeView` (the pure decision core — the harness's target).**
  Projects one state payload into the panel view:
  - the machine picker lists every `clients[]` row (online =
    `last_seen` < 90s, the arbiter's own window; the client row carries
    no `online` flag) plus the explicitly labelled **"all machines"**
    aggregate;
  - the DEFAULT ("this machine") is the row whose `name` equals the
    config's `client_name`, whatever the payload order. Registration is
    idempotent by name, so the name — not the `client_id` — survives
    daemon restarts. No matching name → the labelled "all machines"
    fallback; a key the payload no longer carries re-resolves to the
    default. The old first-online heuristic survives ONLY as that
    fallback's label, never as the default;
  - the project picker lists the scope's published projects;
    "all projects" aggregates them; a dropped project falls back to the
    aggregate;
  - per-project rows read the PUBLISHED arbiter view (`workers[]`,
    `scheduling` incl. `overrides`/`global`, `today`, `budget_today`),
    narrowed to the scope's own worker rows — the scope's queue depth is
    the scope machine's published depths (the aggregate = the sum of
    its parts); `tokens out` sums the parts with each project's own cap
    (a cap ≥ `MAX_SAFE_INTEGER` = ∞);
  - exception tags: `paused` / `budget full` per project, `worker
    paused` (the client-published `stats.paused`), the machine row's
    active override;
  - EVERY active lease of the picked client is projected
    (`max_concurrent_leases > 1` lists all of them — today took
    `.first`);
  - the picked project's `queue_preview` becomes the queue peek (a
    worker publishing no preview degrades to the depth number).
- **`AppModel` scope state.** Picker selections are MODEL STATE:
  `selectMachine`/`selectProject` re-project the LAST payload through
  `ScopeView` — no network on selection. `poll()` maps a missing token
  to a DISTINCT `Conn.noToken` (amber "no token") separate from
  `.unreachable` (red "unreachable"); a 401 = `Conn.unauthorized`
  (amber "bad token") — a third, operator-actionable state that must
  not read as a dead server. The header state word is the arbiter's
  GLOBAL verdict for the box (degraded → any active lease → idle →
  busy; a scope never rewords the header). Two liveness facts are kept
  apart: `daemonRunning` (drives Start/Stop) = LOCAL daemon liveness
  (the name-matched row, fallback the freshest), while the status
  row's staleness = the SCOPE machine's `last_seen` ("all machines" =
  the freshest row) — the row displayed and the process controlled can
  differ, and the panel says which.
- **Scope controls on the EXISTING routes (no new endpoints), same
  token gate as the dashboard:**
  - project gate — `POST /api/projects/:name` `{paused}` (touched body
    only);
  - grant knobs — `POST /api/projects/:name/settings`, the body
    carries ONLY the touched knob; JSON `null` (serialized as
    `NSNull()`) clears it back to the global. The cycle reads the
    GLOBAL knob (`scheduling.global`), never the effective one — a
    cycle that read the effective value would chase its own override
    (nil → 2× → 3× → nil);
  - worker override — `POST /api/clients/:ref/override`
    `{override: "pause"|"force"|null, until: null}`, `:ref` = the
    client NAME.
  - no token → NO request is issued and the status row / note names
    the missing token + the config path.
- **`findRepoRoot()` guard:** an `IDLEFILL_CONFIG_FILE` without at
  least two path components (a bare filename) is treated as unset — it
  used to collapse to the filesystem root.
- **View (panel):** the scope section (machine picker with online dot
  + exception override tag; project picker with `paused`/`budget
  full`/`worker paused` tags), the stats section (queue, today,
  tokens out with the scope's cap and per-project label, EVERY running
  lease, the queue peek "N shown of M waiting"), and the exception-only
  control rows (live labels — "pause project X" / "resume project X",
  "pause this worker" / "resume this worker" / "clear force (this
  worker)"). The icon spin and the arc stay tied to THIS client's
  leases. The status row names the missing token on `.noToken` and the
  rejection on `.unauthorized`.
- Test hook `injectStatePayload` — inert in the production app
  (nothing but the harness calls it; it performs no network of its own).

### `menubar/scope-test.sh` (new — the acceptance-criteria harness)

Compiles the REAL source minus `@main` + a driver, runs under
`env -i PATH=/usr/bin:/bin` (the GUI environment). Two halves:
- **(a) the pure `ScopeView` against canned payloads** —
  order-independence (B-first vs A-first), the name-matched default,
  the labelled fallback, stale-key re-resolution, per-project values,
  the all-machines aggregate = the sum of its parts (14 ≠ 6), per-
  project caps, budget-full/paused tags, the queue peek, lease
  listing (both leases; another client's scope lists none).
- **(b) the REAL `AppModel` against a THROWAWAY arbiter** (`node
  server/dist/index.js` on a scratch port, `IDLEFILL_CONFIG` env JSON,
  an activity-feed stub with one 100s-old entry so the detector is
  idle, seeded terminal leases for the `today` fixture — failed loud
  on any arbiter WARNING or missing seeded lease, per the fixture
  rules) with two fake clients registered and TWO active leases
  granted (both on career-ops — realestate is seeded paused, so a
  grant there would be refused `project_paused`; the cross-project
  listing is proven by the pure (a3) canned case instead), then:
  the default scope = mac-sam's row by NAME; the picker rows; the
  exception override tag; per-project values from the published view;
  the gate toggle (the server state flips `paused: false → true`);
  the settings bodies (`{max_concurrent_leases:4}` and the
  NSNull-clear `{max_concurrent_leases:null}`) accepted by the route;
  the no-token path (conn `.noToken`, the status row names the
  missing token + config path, the gate refuses WITHOUT a request —
  the same server URL would answer 401 to a stray one); `.noToken` vs
  `.unreachable` vs `.unauthorized` distinct words AND distinct signal
  colours (a dead server WITH a token reaches `.unreachable`); and the
  `daemonPIDs` matcher on the LOCAL process table (scratch repo →
  none; a decoy process quoting the entry path → NOT matched).
  The scratch credential is assembled at runtime from two shell
  fragments and passed via argv/env — it never appears as a literal
  next to a scheme or a `token` key in the file.

### `README.md`

The "The menu bar app (macOS)" section: the panel description now
covers the scope, and a new **Scope (machine × project)** bullet
documents the identity rule, the pickers (model-state, no network on
selection, stale-key re-resolution), the published-view values, the
two kept-apart liveness facts, the existing-route controls + token
gate, and the `noToken`/`unauthorized`/`unreachable` distinction —
with `scope-test.sh` named as the harness (the same pattern the
Update Code bullet gives `uc-update-test.sh`).

### `package-lock.json`

Root version `0.1.0` → `1` — the lockfile mirroring the root
`package.json` (which was already `1` on main when release #1 was cut
2026-09-30); `npm` re-synced it when the gate suite ran. No dependency
change. Committed so the tree is clean at the end.

## Acceptance-criteria evidence (real output)

`bash menubar/scope-test.sh` — **44/44 PASS, `SCOPE-ALL-PASS`,
`SCOPE-EXIT=0`** (throwaway arbiter on a scratch port; both active
leases granted: `l-5e0d309c (career-ops/live-1) + l-7b4034ac
(career-ops/live-2)`; two fake clients registered):

```
PASS a1: default selection is the name-matched row (payload order B-first)
PASS a1: default selection is the name-matched row (payload order A-first)
PASS a1: both orders agree on the label
PASS a1: unmatched client_name -> labelled all-machines fallback
PASS a1: stale selection re-resolves to the default
PASS a2: default scope (machine B) queue = B's published depths (2+4)
PASS a2: aggregate today = sum of parts (7+2 / 1+3)
PASS a2: all-machines aggregate = sum of its parts (3+5 + 2+4 = 14)
PASS a2: picked project renders its OWN values (depth 2, 7/1)
PASS a2: second project visible (depth 4, 2/3)
PASS a2: per-project caps (1000 / 500)
PASS a2: budget-full tag on the reached finite cap (realestate)
PASS a2: no budget-full tag below the cap (career-ops)
PASS a2: paused tag on the paused project
PASS a2: queue peek from the picked project's me-row
PASS a2: a dropped project falls back to all-projects
PASS a3: two active leases -> both listed
PASS a3: the lease jobs are the right ones
PASS a3: another client's scope lists none of this client's leases
PASS b1: model default machine = mac-sam's row (by name, not order)
PASS b1: the machine picker lists every clients[] row + the aggregate
PASS b1: the box-a row carries the exception-only pause tag
PASS b1: the header word is the arbiter's global verdict (working — 2 live leases)
PASS b1: the local-machine liveness (the row the controls act on) is online
PASS b2: default scope queue = the published depths (2+4)
PASS b2: default scope today = the published totals (1 ok / 1 failed)
PASS b2: tokens out sums the parts (0+0) with the summed finite cap (1500)
PASS b2: picking career-ops narrows the values (depth 2, cap 1000)
PASS b2: the queue peek is the picked project's published preview (3 rows)
PASS b3: two active leases -> both listed in the panel model
PASS b3: the lease jobs are the granted ones
PASS b4: the gate toggle confirmed (note names the pause)
PASS b4: the server state flipped (career-ops paused=true)
PASS b4: settings body {max_concurrent_leases:4} accepted by the route
PASS b4: settings body {max_concurrent_leases:null} clears (the NSNull shape)
PASS b4: no token -> conn .noToken (word 'no token')
PASS b4: no token -> the status row NAMES the missing token + the config path
PASS b4: no token -> the gate refuses WITHOUT a request (note says so)
PASS b5: distinct words (no token != unreachable)
PASS b5: distinct colours (amber warn != red err)
PASS b5: unauthorized (401) is amber too, distinct from the red
PASS b5: dead server + token -> .unreachable (word 'unreachable')
PASS b6: daemonPIDs(repo:) finds nothing in the scratch repo (local process table)
PASS b6: a decoy process quoting the entry path is NOT matched
SCOPE-ALL-PASS
SCOPE-EXIT=0
```

Criterion mapping: 1 = a1 + b1 + b6 (name-matched default regardless
of payload order; controls on the local process table, proven on the
matcher with a decoy). 2 = a2 + b2 (per-project values; aggregate =
sum of parts — 14 for all machines, not 6; each project's own cap).
3 = a3 + b3 (two active leases, both listed, cross-verified against
another client's scope). 4 = b4 (the exact `{paused}` body, the
server state flips, the NSNull-clear settings shape, no token → no
request + the status row says so). 5 = b5 (distinct words AND distinct
signal colours; the dead-server-with-token case actually reaches
`.unreachable`).

## Gate suite (real output, in the worktree, `NODE_ENV` unset)

- `npx tsc --noEmit -p server/tsconfig.json` — OK (no output)
- `npx tsc --noEmit -p client/tsconfig.json` — OK (no output)
- `npm run build` — OK (`idlefill-server@0.1.0 build` tsc pass)
- `node --check adapters/career-ops/idlefill-mcp.mjs` — OK
- `swiftc -parse menubar/IdlefillMenubar.swift` — OK (exit 0, no output)
- `npm run test` (full workspace suite):
  ```
  > idlefill-server@0.1.0 test — tests 66, pass 66, fail 0
  > idlefill-client@0.1.0 test — tests 30, pass 30, fail 0
  > idlefill-adapter-career-ops@0.1.0 test — tests 4, pass 4, fail 0
  ```
- `bash menubar/uc-test.sh` — `UC-ALL-PASS`, `UC-EXIT=0`
- `bash menubar/uc-update-test.sh` — `UC11-ALL-PASS`, `UC11-EXIT=0`
  (and, on exit: `==> production daemon PIDs (after): 10361 10367` +
  `==> production node_modules mtime: 1790738183 -> 1790738183` —
  production untouched)
- `bash menubar/scope-test.sh` — `SCOPE-ALL-PASS`, `SCOPE-EXIT=0` (above)
- Pre-run pitfall check: `lsof -nP -iTCP:18787 -sTCP:LISTEN` clear
  before every suite run (the fixed-port smoke orphan check).

## Deviations from the spec

- **Both active leases in the live harness ride career-ops** (the spec
  example had one per project). realestate is seeded `paused: true` in
  the arbiter state (needed for criterion 2's `paused` tag), and a
  grant on a paused project is refused `project_paused` — so two
  cross-project live grants were impossible in one fixture. The
  criterion ("both are listed") is proven identically on career-ops,
  and the cross-project listing is additionally proven by the pure
  (a3) canned case (`live-1` career-ops + `live-2` realestate, both
  listed).
- **The seeded terminal leases are epoch-MILLISECONDS.** The first
  draft of the harness seeded seconds (like the BSD `date +%s` idiom)
  and the `today` fixture silently hollowed out — the arbiter's clock
  is ms (`utcDay(ms)`, `expires_at = now + ttl*1000`). The harness
  seeds ms and fails loud on any arbiter WARNING or missing seeded
  lease id (the fixture rules).
- **The panel's `today` reads the arbiter's per-project `today` view**
  (`finished`/`failed` computed from lease end-records), replacing
  today's client-published `stats` sum — the spec's "read the
  published view, do not recompute it" instruction; with both
  machines publishing `stats`, the old sum would have double-counted
  the box-wide totals per project.
