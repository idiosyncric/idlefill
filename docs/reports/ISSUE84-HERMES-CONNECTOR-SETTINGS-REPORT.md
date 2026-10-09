# #84 — Settings tab: configure the Hermes gateway connector (enable + per-profile API keys)

**Status:** delivered direct on `main`. Ships the last operator gap the #83 report recorded: the connector existed and worked, but enabling it meant hand-editing the launch env and writing a 0600 JSON key file by hand — on mac-sam it stayed dormant with the gateway answering at 127.0.0.1:8642.

## What was built

A **Hermes gateway connector** card on the dashboard **Settings** tab — per ONLINE local client, loopback page origin only (exactly the #61 A3 local-config-editor posture) — backed by a new loopback surface on the client daemon.

**Client (`client/src/client-hermes.ts`, new):** `GET/PUT /client/hermes-gateway` on the already-bound loopback proxy, answered before passthrough (a connector write can never reach the LLM target). Guards identical to the sibling surfaces (`client-projects.ts` / `session-control.ts`): Host loopback-only, a carried Origin must name a loopback origin, `X-Idlefill-Edit: <arbiter token>` constant-time, loopback CORS allow for the cross-port fetch.

- **GET** answers the boot posture (`enabled`, `env_switch`, `base_url`, `profiles`, `key_file`) + the live connector `snapshot()` (`reachable`, `version`, `ledger_size`) + `stored_profiles` — **which** profiles carry a key. **Key VALUES never egress any GET.**
- **PUT** `{ enabled?, keys?: { <profile>: string | null } }` — whole-body fail-closed validation (400, nothing partial): `keys` writes the connector key file (read-modify-write: `null`/empty clears one entry, unmentioned entries stand, parent dir created 0700, tmp-then-rename, **0600 tightened by chmod regardless of umask**); `enabled` writes ONLY the `hermes_gateway` block in the client's own config.json (every other config key — the token included — preserved verbatim, file mode preserved). A malformed existing key file is REFUSED (500), never overwritten. Not-file-backed config (IDLEFILL_CLIENT_CONFIG): a PUT carrying `enabled` 503s the WHOLE body (never a key write with a silently dropped enable); a keys-only PUT still works. Response: `{ restart_required: true, stored_profiles }` — the connector is constructed at daemon boot; the card never restarts anything (same promise as the projects editor).

**Enablement (`config.ts` + `index.ts`):** the loader gains an ADD-key `hermes_gateway` pass-through block (verbatim plain object — `resolveHermesGatewayConfig` owns every member's semantics). Constructor enablement = env switch OR `hermes_gateway.enabled === true`; the env switch ON still wins over an explicit block false (the shell surface stays the stronger manual override). Neither ⇒ the connector is not constructed — the heartbeat stays byte-for-byte the pre-#73 shape (the fail-quiet regression suite still proves it). The resolved config is kept either way so GET can report base_url/profiles/key_file with the connector off.

**Dashboard (`Settings.tsx` + `api.ts`):** the card shows posture (connector on/off, gateway reachable/version/rows, base_url), an enable checkbox, and one password input per profile — placeholder `••• stored — blank keeps it` vs `no key stored`, plus a per-profile **clear** checkbox (sends `null`). Save refetches, so the enable checkbox reflects the BOOT truth until a restart (honest posture: stored ≠ applied).

## Security posture

Keys travel only browser→local-client (loopback, token-guarded), land only in the 0600 key file, are never echoed by any read, never logged, never published to the arbiter, never appear in the heartbeat wire. The dashboard already holds the arbiter token (the same credential the desktop webview injects for the projects editor), so zero-pasting holds.

## Harness + build output

`client/test/client-hermes.test.ts` (new, 7 tests, wired into the client test list): guard ladder (401/403/OPTIONS), GET masks values (response text byte-scanned against planted secrets), PUT key write (0600, dir created, values trimmed, unmentioned entries stand, `null` clears), PUT `enabled` writes only the block with every other config key + mode preserved, fail-closed bodies (400 whole-body, nothing written — a `""` value is the documented CLEAR, not a rejection), malformed key file refused (500, contents untouched), env-config posture (enabled⇒503 whole-PUT, keys-only ok).

connector file 24/24, **client 194/194** (187 + 7), whole-repo `npm run test` exit 0 (zero failures across 7 workspaces), `npm run build` exit 0, `tsc --noEmit` clean for client and dashboard.

## Live posture on this machine

The card is now reachable (client restarted at the new commit); mac-sam's connector remains OFF until the operator flips the card (or env) and types each profile's gateway key — the operator-provisioned Hermes `API_SERVER_KEY` values were deliberately NOT extracted or written by this build (they stay the operator's to type). One restart note: `enabled` + keys apply at the NEXT daemon restart, by design.
