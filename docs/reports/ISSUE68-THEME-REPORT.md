# Issue #68 build report — the configurable state color scheme (re-scoped to the React dashboard)

The Forgejo #68 brief targets the legacy page. The dashboard cutover
(`419db6e`) made the React workspace the served dashboard. Owner decision
2026-10-08: #68 builds on the React surface only. This report covers that
build.

## Re-scope note

- The #67 pipe/phase colors (`--pipe-*`) have no served surface. They exist
  only in the legacy page (`server/public/index.html`). That gap is tracked
  in Forgejo issue **#74**. This build does not build the pipe surface.
- This build does not edit `server/public/index.html`.
- The nine color tokens live in `dashboard/src/index.css :root`: `--bg`,
  `--panel`, `--border`, `--text`, `--dim`, `--ok`, `--warn`, `--err`,
  `--accent`. Dark theme only (this app has no light theme).
- The dashboard polls `/api/state` every 5 s (`dashboard/src/App.tsx`). That
  poll is the apply channel. There is no WS plane in this build.

## Design

**The plane (server).** A theme write lands on the arbiter as the
`setTheme` method, beside the project-settings plane (same write shape:
sanitize, then `appendEvent` + `trim` + `save`). The state file is the only
persistence. `ArbiterState` gains an optional `theme` key:
`{ colors: Record<string, string>; updated_at: string }`.

**The sanitizer (drop-don't-reject).** A bad value never 400s and never
breaks the map.

- Hex grammar only: `/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/`. A non-conforming
  value drops that key and keeps the prior value.
- Known keys only (the nine tokens). An unknown key drops silently and is
  reported in the response `dropped` list.
- An absent key is a no-op, not a clear. A brand-new write seeds from the
  `:root` defaults first, so the persisted map always carries the full
  nine-token shape.
- An all-bad payload keeps the prior map (it never clears to empty).
- A value is a pure CSS color. It never carries a token or secret.

**The routes (server).**

- `POST /api/theme` — token-gated like every settings write. Body `{ colors }`.
  Response: the effective map + `updated_at` + `applied` + `dropped`.
- `GET /api/state` — publishes `theme` as an ADD key. Anonymous-readable
  (cosmetic values, no secret). Absent when unset. The file's
  `/api/state` ADD-key posture is followed.

**The dashboard.**

- `dashboard/src/lib/theme.ts` — `THEME_KEYS` (the nine keys + a label per
  key), `DEFAULT_THEME` (the exact hex values read from `index.css :root`),
  and `applyTheme` (the apply step).
- `dashboard/src/views/Settings.tsx` — the editable map. One row per key:
  the label, a color input, a hex text input, and a live preview (a dot + the
  word "running" in the chosen color). A "reset to defaults" button posts
  `DEFAULT_THEME`. Save is token-gated. The draft re-seeds from the saved
  theme when it arrives or changes, and never clobbers an in-progress edit.
- `dashboard/src/nav.ts` + `App.tsx` — a top-level nav item `settings`
  (lucide `Settings` icon). `nav.test.ts` is a legacy-to-React drift contract
  (a superset passes). `settings` is a React-only addition.
- The apply: at boot and on every state poll, if the snapshot carries
  `theme.colors`, the app sets each present key as a CSS custom property on
  `document.documentElement`. The `:root` defaults stay the fallback (an
  absent key keeps the default).
- `dashboard/src/lib/api.ts` — the `setTheme(colors)` client call (the
  `qsToken` pattern) + the `theme` field on `StateSnapshot`.

**The cascade.** The Tailwind v4 `@theme inline` block maps `--color-ok` to
`var(--ok)`. So `bg-ok` and `text-ok` resolve to `var(--ok)`. Setting
`--ok` on `<html>` overrides the `:root` default and every utility that
references the token follows. That is the mechanism the live proof asserts.

## Gates (all green before the push)

`NODE_ENV` was unset first (the Hermes terminal exports `NODE_ENV=production`).

```
npm run test                                  # all workspaces
  server   212 pass / 0 fail                  # +4 theme tests
  client   129 pass / 0 fail
  career-ops 17 pass / 0 fail
  noop        2 pass / 0 fail
  dashboard   2 pass / 0 fail                 # nav drift contract (superset)
npx tsc --noEmit -p server/tsconfig.json      # OK
npx tsc --noEmit -p client/tsconfig.json      # OK
npm run typecheck --workspace idlefill-dashboard  # OK
npm run build                                 # all workspaces OK
git config user.email                         # web-dev@agents.samwarth.com
```

The theme unit tests (`server/test/theme.test.ts`) cover: the sanitize
drop-don't-reject, the persistence round-trip, the ADD-key shape (absent when
unset, present once set), and the malformed value keeps the prior value.
The test was added to the server `test` script (a new test file must be
enumerated there or it never runs).

`dashboard/dist` is committed (the cutover posture tracks the built
workspace). The build regenerated it.

## Acceptance (live, scratch only — production never touched)

**Harness (the close-out pattern).**

- A scratch arbiter ran on `:18891` under `IDLEFILL_CONFIG`. It carried a
  scratch state file, a scratch token (`openssl rand -hex 9` — the
  production token was never read), a declared project, `poll_ms 60000`, and
  it served the freshly built `dashboard/dist`.
- Any prior listener on `18891` was killed before boot.
- Production was never touched: the `:8787` arbiter, the
  `com.sam.idlefill.{server,client,app}` labels, the production
  `server/config.json` and its state file. Both were verified before and
  after. The scratch state file was separate from the production one.

**Proof 1 — the write (API).** `POST /api/theme` with the scratch token,
body `{colors:{ok:"#ff0000"}}`.

```
POST /api/theme {ok:#ff0000} → HTTP 200
   ok applied: 1; colors.ok=#ff0000; colors.warn=#d29922 (default #d29922)
```

The effective map carries `ok=#ff0000`. The other keys keep their defaults.

**Proof 2 — the ADD key (API).** `GET /api/state` anonymous (no token).

```
GET /api/state (anonymous) → HTTP 200; theme present: True; theme.colors.ok=#ff0000
```

The `theme` ADD key is present.

**Proof 3 — the dashboard (Orca embedded browser).** The page opened at
`http://127.0.0.1:18891/#settings`. The token was set in the page
`localStorage` key via a shell script that read the token from a disk file
(never printed, never inlined). A hard reload remounted the app (a
hash-only goto does not).

- The Settings view rendered the nine rows. The DOM assert returned
  `colorInputs: 9`, `settingsNav: true`, and the `Color scheme` title.
- The `ok` row's picker + hex input showed the saved `#ff0000` (the draft
  re-seed from the saved theme). The computed `--ok` on `<html>` was
  `#ff0000`.
- The apply channel was proven with a real running-state dot. A scratch
  client was registered (token-gated register route) so the Projects view
  rendered an online worker dot. The dot's class is `bg-ok`. Its computed
  background read `rgb(255, 0, 0)` — red — while `--ok` on `<html>` read
  `#ff0000`. The root override cascaded through the utility.
- The write was driven through the UI Save button (the real token-gated
  write path). Editing `ok` to `#123456` enabled Save. Clicking Save posted
  the map. The API returned `colors.ok=#123456`. Within the next poll the
  page's `--ok` computed to `#123456`.
- Reset was driven through the UI button. It posts `DEFAULT_THEME`.

**Proof 4 — malformed (API).** `POST /api/theme` with the token, body
`{"colors":{"ok":"red; } body{}"}}`.

```
POST /api/theme {ok:'red; } body{}'} → HTTP 200; colors.ok=#ff0000 (keeps prior #ff0000)
```

`ok` keeps the prior value. The page does not break (no CSS injection — the
values pass the hex grammar only).

**Proof 5 — reset to defaults (API).** `POST /api/theme` with
`DEFAULT_THEME`.

```
POST /api/theme (DEFAULT_THEME) → HTTP 200; colors.ok=#3fb950 (default #3fb950); applied=9
```

The colors return to the `index.css` defaults.

**Proof 6 — persistence (restart).** `ok` was set to `#ff0000` through the
UI, then the scratch arbiter was killed and restarted.

```
after restart colors.ok = #ff0000
```

The state file is the only persistence. The theme survived. After a hard
reload, the online running-state dot still read red (`rgb(255, 0, 0)`).

## Live proof (screenshots)

- `ISSUE68-theme-settings.png` — the Settings view. The nine token rows
  (label, swatch, hex chip, and a dot + "running" preview). The `ok` row's
  swatch is red (`#ff0000`). The "reset to defaults" and "save" buttons are
  present.
- `ISSUE68-theme-dot.png` — the Projects sub-view. The online worker dot for
  `scratch-mac` is red (`bg-ok` resolving `var(--ok)` to `#ff0000`).

## Cleanup (mandatory, in order)

- The scratch arbiter (`:18891`) was killed. The port was verified free.
- Production `:8787` + the three labels stayed untouched. `launchctl list`
  and `lsof` confirmed the same PIDs as the baseline before the pass.
- The Orca browser tab created for this pass was closed.

## Out of scope

- The #67 pipe/phase flow view (Forgejo #74). The legacy page
  (`server/public/index.html`).
- A light theme. The named preset list (stretch only: the editable map is
  the contract).
- The WS push plane.

## Not closed by this build

- Forgejo #68 stays open. The supervisor verifies and closes it. No Forgejo
  comment was posted.
