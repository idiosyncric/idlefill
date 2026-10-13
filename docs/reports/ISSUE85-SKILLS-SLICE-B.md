# #85 slice B — Skills + toolsets inventory: `GET /v1/skills` + `GET /v1/toolsets` per profile

**Status:** delivered on branch `agent/85-slice-bc` (worktree slice; merge to
main by the coordinator). Slice B of the #84-key surface issue; slice C rides
the same connector on the next commit of this branch.

**Naming (inherited from D):** the wire keys are `hermes_skills` +
`hermes_toolsets` — this is HERMES' capability inventory; a bare `skills` /
`toolsets` key never rides the register body (pinned by a daemon test).

## What shipped

Read-only per-profile capability rows beside the #80 Agents roster.
Transport: the client's existing connector round harvests `GET /v1/skills` +
`GET /v1/toolsets` per keyed profile and publishes the sanitized blocks as
ADD-keys on the client register heartbeat (the slice-B/D discipline:
last-known-wins across rounds, merge-on-arrival per profile, ABSENT ⇒ the
register body byte-for-byte today's shape). At most ONE bounded GET per
surface per profile per connector round — never per page render, never
bulk-polled. **Read-only: there is no enable/disable/install verb anywhere**
(the gateway owns the enabled/configured verdicts; the dashboard only shows
them).

- `client/src/hermes-gateway.ts` — the slice-B section: `skillsPath`/
  `toolsetsPath` (home store + `/p/<profile>` mirror), the caps +
  `sanitizeHermesSkill`/`sanitizeHermesToolset` (drop-don't-poison), the
  `fetchListSurface` helper (one bounded GET, fail-quiet verdict), the
  per-round fetch inside `fetchRound` (keyed profiles only), and
  `HermesGatewayConnector.skillsSnapshot()/toolsetsSnapshot()`.
- `client/src/index.ts` — `hermesGatewayHostFacts()` gains the two ADD-keys:
  `hermes_skills`/`hermes_toolsets` ride the register body ONLY when a round
  answered non-empty rows; connector off / never polled / empty ⇒ keys
  ABSENT.
- `server/src/types.ts` — `HermesSkillRow` + `HermesToolsetRow` + the
  client-row fields (doc-commented like the sibling ADD keys).
- `server/src/arbiter.ts` — `cleanHermesSkills`/`cleanHermesToolsets` (the
  #73/#80/#85-D edge sanitizer: non-array/all-dropped ⇒ ABSENT, malformed
  members dropped individually, hostile extra members have NO landing
  place); `registerClient` stores on a valid report, ABSENT never clears;
  new + heartbeat paths. `localAgentRoster()` carries the same client's
  stored blocks onto the roster read.
- `server/src/api.ts` — the register route accepts the keys as plain array
  pass-throughs; `GET /api/agent-roster` gains the ADD-keys `skills` /
  `toolsets` (present only when the local client reported them — never empty
  arrays). `/api/state` already echoes the full client row (the Models-side
  join is free).
- `dashboard/src/lib/api.ts` — `HermesSkillRow`/`HermesToolsetRow` +
  optional `ClientRow` fields + the enriched `getAgentRoster()` return.
- `dashboard/src/lib/hermes-capabilities.ts` — pure
  `groupCapabilitiesByProfile` (rows bucketed by their STAMPED profile;
  unstamped ⇒ `default`, never a name-guess) + `hasCapabilities` + the
  `HERMES_CAPABILITIES_LABEL` copy constant (pinned by test).
- `dashboard/src/views/Agents.tsx` — the roster rows gain per-profile
  `CapabilityChips`: toolset chips carry the gateway's verdicts (dim +
  line-through = not enabled, dashed border = not configured, exact words in
  the tooltip), skill chips show the name with category/description in the
  tooltip. Exception-only: a profile with neither renders NOTHING (its row
  is byte-for-byte its pre-slice shape); a header hint line appears ONLY
  while any capability rows exist. **Zero buttons** (pinned by a test).
- Test files are picked up by the `test/*.test.ts` globs (no package.json
  registration needed in this tree).

## Live shape evidence (read-only curl against the running gateway
`http://127.0.0.1:8642`, Hermes **0.21.7**; the operator's `default` key read
locally from `~/.idlefill/hermes-gateway-keys.json` — the key value NEVER
pasted anywhere)

- Auth posture: `GET /v1/skills`, `/v1/toolsets`, `/v1/models`,
  `/api/model/options` WITHOUT a key → all `401 {"error":{"code":
  "gateway_auth_failed"}}` — the #73 per-profile Bearer rule applies to every
  one of these surfaces.
- Per-profile mirrors: `GET /p/flash/v1/toolsets` (and the other three) with
  the DEFAULT-home key → `401` — the per-profile key rule holds (a foreign
  key never unlocks a named profile's mirror); the connector sends only the
  profile's own key, unkeyed ⇒ zero requests.
- `GET /v1/toolsets` (keyed) → `200 {"object":"list","platform":"api_server",
  "data":[{name,label,description,enabled,configured,tools[…]}]}` — 28 rows
  on the live box; pinned members + live states (e.g. `web enabled+configured
  true`, `video_gen enabled false configured true`, `x_search
  enabled+configured false`). Source cross-check: `api_server.py`
  `_handle_toolsets` (the row is exactly these six members; unpaginated).
- `GET /v1/skills` (keyed) → **`500 {"error":{"message":"Failed to enumerate
  skills","type":"server_error"}`** on this box at build time — the route
  EXISTS and is authenticated, but enumeration fails here. The connector
  fail-quiet consequence: this profile stands last-known and publishes
  NOTHING (verified end-to-end below — the stored row carries no
  `hermes_skills` key). The SUCCESS row shape is pinned from the gateway
  SOURCE (`api_server.py _handle_skills` → `tools/skills_tool.py:239`:
  `{name, description, category}` — the route returns
  `{object:'list', data:[…]}`; there is NO enabled/configured member on
  skills, so none is fabricated).
- Verification limit (same honesty note as #73/#83/#85-D): the live daemon on
  this machine predates the slice (a restart is the operator's step); the
  end-to-end round against the REAL gateway ran instead through the scratch
  harness described under "Live end-to-end verification" (scratch arbiter
  :18901, cleaned up after — the production arbiter :8787, the aggregate
  endpoint :8800 and the running daemon were never touched).

## Wire shapes

Register heartbeat (client → arbiter), ADD-keys only:

```
hermes_skills?:   [ { profile?, name, description?, category? } ]   // description ≤256
hermes_toolsets?: [ { profile?, name, enabled?, configured? } ]     // exact booleans
```

Absent (connector off, never polled, all profiles unkeyed/failed/500, empty
stores) ⇒ the keys are OMITTED — the body byte-for-byte today's shape, and an
old arbiter never reads the keys anyway. `WIRE_PROTOCOL` stays 1 (the
ADD-keys precedent).

## Caps + sanitizers chosen (ledger-style, drop-don't-poison)

- Client: ≤ `SKILLS_MAX_PER_PROFILE=200` / `TOOLSETS_MAX_PER_PROFILE=200` rows
  per profile per round (the issue's N≤200), published totals capped at 200
  each; strings skill name ≤128, description ≤256 (the issue's text cap),
  category ≤64, toolset name ≤64, profile ≤64; `enabled`/`configured` EXACT
  booleans. NEVER projected: toolset `label` (emoji decoration),
  `description`/`tools` (the tool-name list — duplication), and NO
  enabled/configured fabrication on skills. The issue's wording ("never
  descriptions… descriptions capped at 256 chars") is honored as: skill
  description — the only description the capability row actually needs —
  publishes at ≤256; the toolset description never publishes (the names-only
  half). Decision recorded rather than silently split.
- Arbiter: `cleanHermesSkills`/`cleanHermesToolsets` re-sanitize
  independently (untrusted client): ≤200 rows, over-cap member DROPPED (the
  #80 roster edge posture), over-long/empty name drops the row, hostile
  members (skill `enabled`/`configured`/`prompt`, toolset `label`/
  `description`/`tools`) have no landing place; non-array / all-dropped ⇒
  ABSENT, ABSENT never clears the stored block.
- Dashboard: renders what arrived; absent ⇒ no chips, no hint (never an
  empty list pretending to be truth).

## Merge semantics (the honest statement)

Cross-round last-known-wins: a round that did not answer for a profile
(down / 401 / 500 — the live skills class / malformed envelope) leaves that
profile's stored list untouched. A 200 with a well-formed `{object:'list',
data:[…]}` envelope is the COMPLETE truth for that profile (both routes are
unpaginated — verified in the source), so it REPLACES the stored list; an
empty answer publishes NOTHING (absent, never a `[]` dump, and the arbiter's
stored block survives the same way).

## Harness + gates

- `client/test/hermes-capabilities.test.ts` — 11 tests: sanitizers vs the
  live-pinned toolset row + source-pinned skill row (decoration/duplication
  and hostile members NEVER published, 256 description cap, exact-boolean
  rule, no enabled/configured fabrication); `skillsPath`/`toolsetsPath`;
  connector: ONE GET per surface per profile per round (cadence gate),
  per-profile key discipline, unkeyed ⇒ ZERO requests, down ⇒ ZERO
  capability requests, 401/500/malformed ⇒ last-known stands, 200 replaces,
  empty ⇒ publish nothing, 200-row caps, poison records drop individually;
  daemon-level: connector off ⇒ `hermes_skills`/`hermes_toolsets` NEVER in
  any register body (byte-for-byte), on ⇒ the blocks ride under exactly those
  keys and NEVER bare `skills`/`toolsets`, decoration absent on the wire.
- `server/test/hermes-capabilities.test.ts` — 5 tests through the real
  Fastify app: valid stores + echo on `/api/state` clients; drop-don't-
  poison + hostile-member nowhere-to-land (skill enabled/configured/prompt,
  toolset label/description/tools); absent-never-clears + old-shaped body
  leaves the row byte-for-byte (non-array and all-garbage array too);
  `clean*` unit caps; the roster route carries the blocks (stored blocks
  ride on a heartbeat that omits the keys).
- `dashboard/test/hermes-capabilities.test.ts` — 3 tests: the label constant
  is exactly "Hermes capabilities" and the Agents chip region contains no
  Button/onClick (read-only pinned); grouping by stamped profile + the
  unstamped ⇒ default rule; absent/empty ⇒ empty map + the exception-only
  gate.

Gates (this commit): `npm run test` exit 0 — server 499/499 (494 + 5),
client 284/284 (273 + 11), dashboard 88/88 (85 + 3), cli 139/139, career-ops
17/17, noop 2/2, shell-ui 3/3, fleet 54/54 = **1086 total, 0 failures**
(main baseline 1067). `npx tsc --noEmit` clean for client, server, dashboard.
`npm run build` exit 0; `dashboard/dist` regenerated and committed (bundle-
drift gate). No tauri sources touched ⇒ cargo gates not applicable.

## Live end-to-end verification (scratch harness, cleaned up)

Real `ClientDaemon` + real arbiter app on scratch loopback :18901 + the
operator's REAL gateway at :8642 (connector's own key-file posture; read-only
GETs; the production arbiter :8787 / aggregate :8800 / live daemon untouched):

- the client row stored on the scratch arbiter carried `hermes_version`
  0.21.7, `gateway_reachable: true`, `hermes_jobs` (D survived), and
  **`hermes_toolsets` with 28 live rows** (name/profile/enabled/configured
  only);
- **`hermes_skills` ABSENT** — the live route 500s ⇒ fail-quiet stand,
  nothing published, nothing guessed;
- JSON scans of the full stored row: toolset `label`/`description`/`tools`
  decoration absent; the gateway API key value NEVER appears;
- `GET /api/agent-roster` returned `{client, roster(16), toolsets(28)}` —
  the Agents-tab join, skills omitted (never an empty array);
- scratch arbiter closed, daemon stopped, temp dirs removed.

## Deliberately NOT in this slice

- Any fix/workaround for the gateway's live `/v1/skills` 500 — idlefill does
  not fix the gateway; the strip is honestly empty until the gateway
  enumerates (fail-quiet, no fabricated rows, no error chrome).
- Any write verb (enable/disable/install) — out of this slice's scope law.
- Toolset `label`/`description`/`tools` projection — decoration and
  duplication (recorded decision above).
- A new dashboard route: the Agents join rides the EXISTING token-gated
  `GET /api/agent-roster` with ADD-keys (an old dashboard ignores them).
- WIRE_PROTOCOL bump (stays 1, the ADD-keys precedent).
