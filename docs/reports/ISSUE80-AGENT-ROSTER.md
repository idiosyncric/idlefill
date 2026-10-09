# Issue #80 — Agent roster: local Hermes profiles with idlefill posture

**Status:** Implemented (branch `issue-80`). Read-only roster of this machine's
Hermes profiles with a per-profile idlefill-posture tag, surfaced in the
Agents pane. No push, no merge.

## What it does

The Agents pane (#72) shows the agent keys idlefill has MINTED. It did not
show the agent POPULATION: which Hermes profiles exist on this machine and
which already route through idlefill. #80 adds a read-only roster of the
**local** Hermes profiles (the dashboard is served by this machine's own
arbiter — the same loopback-honesty posture as the #72 machine picker) with a
per-profile posture tag, and gives the Agents pane the adoption view it was
missing.

- **Posture** per profile:
  - `adopted` — the profile's config.yaml names this machine's OWN bound
    aggregate port as an endpoint URL (host is loopback AND port equals the
    daemon's `aggregate_port`). Renders the exception-only tag
    `routes through idlefill`.
  - `external` — a model block present but routing elsewhere (another engine,
    strata, a different machine, or a different loopback port). Renders
    `elsewhere`.
  - `unset` — no config.yaml, or no model block. Renders `no config`.
- **Count line:** `N of M profiles adopted`.
- **Key-join:** a minted key whose label **exactly** matches a profile name
  tags that row `key minted` (exact match only — never fuzzy).
- **Mint pre-fill:** an unadopted row offers a `mint key` action that opens the
  EXISTING mint dialog (#72) with the label pre-filled from the profile name —
  zero new server routes for the write path.
- **Credential posture:** the scan reads `model.provider` + endpoint URLs
  only. It never follows a `key_env` reference, never reads a profile `.env`,
  and never logs a profile it cannot parse (an unparseable config just
  classifies as `unset`). A published `base_url` that carries a
  credential-looking userinfo (`user:pass@host`) is OMITTED.

## The one design decision worth flagging

The issue body says posture is derivable from `model.provider` +
`model.base_url`. In the real Hermes configs on this box, `model.base_url` is
often **absent** — the adopting idlefill endpoint lives under
`providers.<name>.base_url` / `.api`. E.g. `web-dev` →
`model.provider: llama-swap` (no `model.base_url`) but
`providers.idlefill.base_url: http://127.0.0.1:8800/v1` = adopted. To tag such
a profile `adopted`, the posture discriminator scans **every** endpoint URL
(`base_url:`/`api:` at any depth) in the file, while the published
`provider`/`base_url` DISPLAY fields still come strictly from the `model`
block (as the issue specifies). This is documented in
`client/src/agent-roster.ts`.

## Files

| Surface | File | Change |
| --- | --- | --- |
| client | `client/src/agent-roster.ts` | New: `scanHermesProfiles(aggregatePort)` (fixture seam `scanHermesProfilesAt`, `targetsAggregatePort`). Scans `~/.hermes/profiles/*`, reads `config.yaml` best-effort (no yaml dep — minimal YAML surface), classifies posture. |
| client | `client/src/index.ts` | Publish `agent_roster` on the register heartbeat (ADD-key; omitted when no Hermes home / no profiles; best-effort — never breaks the heartbeat). |
| server | `server/src/types.ts` | `AgentRosterRow` type + `ClientRecord.agent_roster` ADD-key field. |
| server | `server/src/arbiter.ts` | `cleanAgentRoster` sanitizer (bounded ≤24 rows, malformed members dropped individually, non-array/all-dropped → absent, absent never clears); `registerClient` stores/echoes the key (both create + heartbeat branches); `localAgentRoster()` accessor; `isLoopbackIp` helper. |
| server | `server/src/api.ts` | Register pass-through; `GET /api/agent-roster` (LOCAL-truth: the newest-online loopback client's roster; omitted when none). |
| dashboard | `dashboard/src/lib/api.ts` | `AgentRosterRow` type, `ClientRow.agent_roster`, `getAgentRoster()`. |
| dashboard | `dashboard/src/views/Agents.tsx` | `RosterCard` (profiles-on-this-machine list above the key list), exact-label join to minted keys, posture tags, count line, `key minted` tag, `mint key` pre-fill into the existing dialog. |
| tests | `client/test/agent-roster.test.ts` | 11 fixture-tree tests (adopted / external / unset / missing dir / userinfo-omit / never-throw). |
| tests | `server/test/agent-roster.test.ts` | 13 tests: sanitizer trio, register ADD-key contract (store/echo, malformed-drops-individually, absent-never-clears, legacy no-key), `GET /api/agent-roster` local-truth + remote-omitted. |

## ADD-key contract (the standard pair, verified)

- **absent = unset:** a client that never sends `agent_roster` keeps its row
  exactly as-is (no key) — a pre-#80 client is unaffected.
- **malformed member drops only that key:** a malformed roster member is
  dropped individually; the rest are kept. A non-array / all-dropped array is
  treated as absent (never stored, never clears the stored value).
- **absent never clears the stored value:** a re-register with no `agent_roster`
  does not wipe a previously stored roster.
- **old arbiter / old client:** an old arbiter ignores the key (unknown field);
  a new arbiter + old client keeps working (no key → no roster, the card
  hides).

## Local check (this Mac)

14 profiles listed. `web-dev` tagged `adopted` (its `providers.idlefill.base_url`
names this machine's aggregate port `:8800`); the strata / tailnet profiles
tagged `external`; `f360-agent` / `probe-agent` (no config.yaml) tagged
`unset`. Count line: `1 of 14 profiles adopted`.

## Gates (real output)

- `NODE_ENV=test npm run test` — **403 pass / 0 fail** (server 241, client
  143, adapters 17, +2).
- `NODE_ENV=test npm run build` — green (server `tsc -p` emit + dashboard
  `tsc --noEmit && vite build`); dashboard/dist + tauri/settings-ui build
  output regenerated.
- `npx tsc --noEmit` — server, client, dashboard all clean (exit 0).

## Non-goals (held)

No cross-machine roster (#55 fleet plane). No writes to Hermes config (the
#72 paste hand-off stays the adoption path). No profile→session join (#73
slice A's `hermes_meta` can tag roster rows later). No key revocation flow on
roster rows (read-only; #72's two-step revoke covers the key rows).
