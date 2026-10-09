# GRILL REPORT — engine health routing + mutual exclusion groups: five decisions settled on verified code

**Doc:** `docs/architecture/engine-health-routing.md` (new). D1..D5 in the
mesh.md format. All LOCKED (owner review 2026-10-08 settled the three
open questions). No src, config, or test file touched. Type:
wayfinder:grilling. Source: owner brief 2026-10-08 (direct chat, no
Forgejo issue yet). Amends the LOCKED `model-aliases.md` D4 winner
clause only. It cites it as the inherited constraint.

## What landed

The decision doc settles the two owner asks (same-host mutual exclusion,
route to the next-best option before a non-green engine) against code
read on disk at HEAD `7511ce7` and the live fleet probed below. It
replaces exactly one clause of the predecessor's D4 — the dead-pin
fall-through line — with the health-ordered chain, and states that
supersession in the amendment-discipline block. It names the one wire
key the plane adds (`fallback`, ADD-key posture) and leaves the router
dispatch byte-for-byte.

Replaces from `model-aliases.md`, stated as amendments: the D4 sentence
"A dead pin falls through: pin absent, pin's row gone, or pin's pair
unconfirmed → first surviving pair wins" is SUPERSEDED by the D2 chain
(healthy pin → healthy first pair → pin → first survivor). Everything
else in the predecessor (the D2 merge rules, the D3 splice, the D5
authoring posture, the D6 fence) stands UNCHANGED and is REUSED, cited
as such.

## Live verification (actual output, 2026-10-08, this machine)

Ports (lsof): `:8800` LISTEN (node PID 18360, 127.0.0.1 — the
aggregate), `:8787` LISTEN (node PID 20890, `*:8787` — the arbiter),
`:8000` LISTEN (python3.1 PID 79619 — oMLX), `:11435` LISTEN (same
client PID — the 11435 proxy).

The failure this doc exists to close (driven live, not asserted):

- `curl -s -m 8 https://strata.samwarth.com/v1/models` — HTTP **502**
  Bad Gateway. The pinned winner of the `Qwen3.8-Flash-Next` alias
  (stored `pinned_server_id: srv-45abb4e8`) answers 502.
- `curl -s -m 8 http://10.10.10.6:8080/v1/models` (no header) — HTTP
  **401** `{"error":{"type":"authentication_error","message":"missing or
  wrong API key"}}`. The next-best pair's row. Probes healthy under its
  own token (the arbiter's `probed_at` is set, `catalog_source:
  'probed'` on its pair in a prior tick).
- The published `model_aliases` block (admin-token `GET /api/state`):
  `Qwen3.8-Flash-Next` winner `srv-45abb4e8` with
  `catalog_source: 'declared'` — the dead pin publishes as a survivor
  because the probe failure keeps the pair alive under the predecessor's
  D2 rule. A Hermes turn routed there at 21:41 EDT (agent session
  `20261008_214014_eef9f7`, web-dev `agent.log` line 29134-29135) burned
  302.1 s and 5 auto-recovery cycles on `HTTP 502: Bad Gateway` before
  giving up. The next-best option was available the whole time.
- `curl -s -m 8 http://100.105.225.1:11434/v1/models` — HTTP **200**, no
  token (the `Qwen3.8-27B` alias winner probes healthy,
  `catalog_source: 'probed'`). The contrast case: a healthy pin routes
  and stays.
- Row auth posture (loopback `GET /api/server-keys`, values redacted):
  `srv-watched` oMLX token present, `srv-45abb4e8` urza token present,
  `srv-f1c85327` scanbot token present, `srv-73de04cd` llama-swap token
  ABSENT (probes open).

Absence claims (grep both packages, `--include='*.ts'`):

- `engine_group|mutually.exclusive|exclusive_group|same_host|host_group|group_id`
  → zero hits. No group concept exists. This is new code to build.
- No push channel: no route or WS by which the arbiter initiates to the
  router (re-verified the route table, as the predecessor did).

Citations re-verified against HEAD `7511ce7` on 2026-10-08: the winner
line at `server/src/arbiter.ts:1059`, the probe throw at
`server/src/catalog.ts:93`, the probe cycle scheduling at
`server/src/index.ts:251-258`, the lease per-server evaluation at
`server/src/arbiter.ts:704-730` + the per-server cap at 728-730, the
`Lease.server_id` type at `server/src/types.ts:522-536`, the gate
`active` state at `client/src/session-gate.ts:385`, the router dispatch
at `client/src/aggregate.ts:578-579`, the state tolerate-missing-key
pattern at `server/src/state.ts:85`, the `probedModels`/`probedAt`
accessors at `server/src/arbiter.ts:2157-2164`, the idle word at
`dashboard/src/lib/format.ts:37-43`, the `liveWord` call site at
`dashboard/src/views/InferenceServers.tsx:178-180`, the alias authoring
route family at `server/src/api.ts` (`POST /api/aliases`, the
`/api/server-keys` loopback guard at 689-691).

## Decisions

- D1 LOCKED: the catalog probe IS the health signal. One tick demotes,
  one re-promotes. The idle word is not a routing input.
- D2 LOCKED: the winner chain (healthy pin → healthy first pair → pin →
  first survivor) supersedes the predecessor's dead-pin fall-through
  line. One ADD key (`fallback`) on the published entry. The chain never
  unpublishes an alias the current rules publish.
- D3 LOCKED: named `engine_groups` (cross-row entity, `max_concurrent`
  default 1), one group per row, ENGAGED = active lease or active
  session. The group filters chain steps 1-2 only. The lease plane gains
  a group-wide cap with denial `group_busy`.
- D4 LOCKED: the arbiter decides inside the existing `probeCatalog`
  cycle. The router applies on the existing poll with zero dispatch
  change. The `#67` session pin beats the alias chain (different scope).
- D5 LOCKED (posture) + PROPOSED (display): one admin-token write route,
  the alias authoring posture end to end. Probe dot beside the idle word
  on both the Models and InferenceServers views + the re-routed badge.

## Decisions (owner, 2026-10-08)

1. Group scope: both planes (the alias chain filter and the lease cap).
   D3 stands as written.
2. `max_concurrent`: configurable per group (the D3 field). Absent = 1.
   No fleet-wide knob.
3. Display: the probe dot on both views + the re-routed badge on the
   Models tab. D5 display stands as written.
4. Recorded (no action now): the urza upgrade retires the
   strata/llama-swap group. Deletion is one API call.
