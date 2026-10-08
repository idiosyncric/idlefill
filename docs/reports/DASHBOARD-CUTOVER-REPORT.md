# Dashboard cutover — the arbiter serves the React workspace

**Date:** 2026-10-08 · **No issue number** (owner call in-session after the tauri-app "old UI" report).
**Decision:** Serve `dashboard/dist` from the arbiter — full cutover, legacy page retired (option picked by the owner).

## The problem

The tauri window is `WebviewUrl::External` on the arbiter origin (`tauri/src-tauri/src/lib.rs` `dashboard_url()`), and the arbiter served `server/public/index.html` — the legacy single-file vanilla page. The React workspace (`dashboard/`, the Resources rethink MVP step 1, sidebar shell included) only existed at the vite dev server `:5273`. Two surfaces, two frontends; the installed app could never show the new UI.

## What changed

- `server/src/index.ts` — `dashboardDir(entryDir)` resolves the public dir:
  1. `<repo>/dashboard/dist` (dev/tsx layout: `server/src` → up two),
  2. `<entry>/../dashboard/dist` (container: `/app/dist` → `/app/dashboard/dist`),
  3. `server/public` — retired-legacy fail-safe, last candidate only.
- `server/src/api.ts` — `/` and the queue deep-link route serve the SPA shell (`sendShell`); new `/assets/*` route serves the hashed Vite bundle with content types + `cache-control: immutable` (1 yr), traversal-guarded to `publicDir/assets`.
- `server/test/api.test.ts` — the three legacy-markup string tests (view-tabs, queue-section, copy-token) become the SPA-shell contract: shell document shape, asset serving/typing/404/traversal, token-never-served posture extended to bundles.
- `server/test/fixtures/dashboard/` — shell + one hashed asset mirroring the real dist (tests never read the live build).
- `dashboard/src/nav.ts` + `dashboard/test/nav.test.ts` — the nav model became a **drift contract**: every `data-view`/`data-subview` the retired legacy page carried must exist in the React nav or the test fails. First run caught a real gap: **Agents** (the #72 sub-view) was missing from the React nav — added.
- `.gitignore` — `!dashboard/dist/` (the built output is COMMITTED, same Q-b build-from-checkout posture as `tauri/settings-ui`).
- `server/Dockerfile` + `scripts/deploy-server.sh` — the committed `dashboard/dist` ships into the container at `/app/dashboard/dist` (archive stages `server` + `dashboard/dist`; the remote build moves it into the docker context, failing closed if absent).

## Verification (all live)

- `npm test` — server 208 (incl. the new asset/shell contracts), dashboard nav contract 2/2 after adding Agents, all other workspaces green; zero fails.
- `npm run build` — dashboard tsc + vite green.
- Arbiter restarted (`launchctl kickstart -k gui/501/com.sam.idlefill.server`, zero live leases at the time): `GET /` returns the React shell (`assets/index-DWmM8MQr.js`), `GET /assets/*.js|css` 200 + typed, traversal probe 404.
- Orca browser on the tauri window's exact origin (`http://127.0.0.1:8787/#resources`): sidebar + full nav render (1032 px viewport).

## Still transitional (deliberate)

- The React app is still step-1 in coverage: Machines/Projects/Models/Agents/Sessions/Usage/Overview show an in-progress placeholder; the queue VIEW is not ported (deep links resolve to the shell). The nav contract test keeps every retired surface named until it is ported.
- The urza container (the fleet arbiter, `idlefill-server:786a414`) still serves legacy until the next `scripts/deploy-server.sh` run carries the committed dist.
