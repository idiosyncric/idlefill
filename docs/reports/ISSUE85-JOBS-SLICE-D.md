# #85 slice D — Hermes jobs: the read-plane visibility strip for Hermes' own cron

**Status:** delivered on branch `issue-85-jobs` (worktree slice; merge to main by the coordinator). Slice D of the #84-key surface issue; slices B/C/E and the control slices F–I are untouched here.

**Naming (the issue's hard rule):** every artifact says HERMES jobs — the wire
key is `hermes_jobs`, the client identifiers are `jobsPath`/`sanitizeHermesJob`/
`jobsByProfile`/`jobsSnapshot`/`hermesJobs`, the arbiter sanitizer is
`cleanHermesJobs`, the dashboard label is the constant `HERMES_JOBS_LABEL =
"Hermes jobs"`, and the card header renders that constant. idlefill has its own
job concept (queue/lease jobs) and the collision is the named hazard — a bare
`jobs` key on the register body is not consumed into the row (pinned by a test).

## What shipped

A read-only strip so the operator sees **Hermes' own scheduled cron beside
idlefill's cycles**. Transport: the client's existing connector round harvests
`GET /api/jobs` per keyed profile and publishes the sanitized block as an
**ADD-key `hermes_jobs`** on the client register heartbeat (the #73 slice-B
host-facts precedent: last-known-wins across rounds, merge-on-arrival per
profile, ABSENT ⇒ the register body byte-for-byte today's shape). At most ONE
bounded GET per profile per connector round — never per page render, never
bulk-polled. **Read-only: no pause/resume/run/create/update/delete verb is
ever addressed** (they exist live — see evidence — but stay out of this
issue); there is no write affordance anywhere in the new UI.

- `client/src/hermes-gateway.ts` — the slice-D section: `jobsPath(profile)`
  (home store + `/p/<profile>` mirror, verified live), the caps +
  `sanitizeHermesJob` (drop-don't-poison, names-only style caps per the
  slice-B discipline), the per-round fetch inside `fetchRound` (keyed
  profiles only; `include_disabled=true` so PAUSED jobs stay visible), and
  `HermesGatewayConnector.jobsSnapshot()`.
- `client/src/index.ts` — `hermesGatewayHostFacts()` gains the ADD-key:
  `hermes_jobs` rides the register body ONLY when a round answered a
  non-empty list; connector off / never polled / empty ⇒ key ABSENT.
- `server/src/types.ts` — `HermesJobRow` + the client-row `hermes_jobs`
  field (doc-commented like the sibling ADD keys).
- `server/src/arbiter.ts` — `cleanHermesJobs` (the #73/#80 edge sanitizer:
  non-array/all-dropped ⇒ ABSENT, malformed rows dropped individually,
  hostile extra members have NO landing place); registerClient stores on a
  valid report, ABSENT never clears; new + heartbeat paths.
- `server/src/api.ts` — the register route accepts the key as a plain
  array pass-through; `projectView` echoes it onto worker rows
  exception-only (an old arbiter simply never reads the body key — old
  clients never send it).
- `dashboard/src/lib/api.ts` — `HermesJobRow` + optional `hermes_jobs` on
  `ClientRow`/`WorkerRow` (the ADD-key shape contract).
- `dashboard/src/lib/hermes-jobs.ts` — pure `collectHermesJobGroups` (per
  client from `st.clients`, online-first then name; absent/empty ⇒ no
  group) + `HERMES_JOBS_LABEL` (the ONE copy constant, pinned by test).
- `dashboard/src/views/Overview.tsx` — the **"Hermes jobs"** card, placed
  in the grid BESIDE the #53 dev-cycle strip (the natural home for
  per-client detail — the cycles strip is idlefill's cycle row, the new
  card is Hermes' cron row; same exception-only card family as the #86
  peer-row expand / #73 host-facts precedent). Rows: Hermes job id,
  profile, name, schedule text, `paused` badge (exception-only), state
  word, `ran …` / `due in …`. **Zero buttons** (pinned by a test).
- `client/package.json` / `server/package.json` / `dashboard/package.json`
  — the three new test files registered.

## Live shape evidence (read-only curl, gateway `http://127.0.0.1:8642`, 0.21.x; the operator's `default` key read locally from `~/.idlefill/hermes-gateway-keys.json` — the key value NEVER pasted anywhere)

- `GET /api/jobs` (keyed, default profile) → `200 {"jobs": []}` — EMPTY
  because BOTH of this machine's Hermes jobs are currently paused and the
  default listing filters `enabled` out. This is why the connector fetches
  `?include_disabled=true` (verified: the gateway's `_handle_list_jobs`
  honours the flag; a visibility strip must not lose the frozen cron — the
  `enabled`/`state` members carry the pause).
- `GET /api/jobs?include_disabled=true` → `200`, two full records; keys
  pinned: `id` (`[a-f0-9]{12}`), `name`, `prompt` (1 947 chars on the live
  record — NEVER published), `skills/skill/model/provider(_snapshot)`,
  `base_url`, `script`, `no_agent`, `monitor_*`, `context_from`,
  `schedule` (object `{kind:'cron', expr:'0 6 * * *', display:'every day
  at 6:00'}`), `schedule_display` (the derived human form),
  `repeat {times, completed}`, `enabled` (bool), `state` (`paused` here;
  vocabulary `scheduled|paused|completed|error`), `paused_at/paused_reason`,
  `created_at/next_run_at/last_run_at` (**ISO-8601 with offset, not
  epoch**), `last_status/last_error/last_delivery_error/failure_streak`,
  `deliver` (e.g. `discord:…`), `origin`, `enabled_toolsets`, `workdir`,
  `last_dispatch {…}`, `fire_claim`, and `latest_execution` (execution-row
  record: id, pid, `claimed_at/started_at/finished_at`, `status`,
  `delivery_outcome`).
- Per-profile mirror: `GET /p/<profile>/api/jobs` for the unkeyed profiles
  registered with the gateway → `401` (the per-profile Bearer rule holds
  for the jobs route); for two profile dirs NOT registered with the
  gateway (`f360-agent`, `probe-agent`) → `404` — the connector treats any
  non-200 as "this profile stands last-known" (fail-quiet).
- Gateway source cross-check (`cron/jobs.py list_jobs` + the route table):
  the listing is UNPAGINATED (one GET is the complete per-profile truth —
  no page walk like the session ledger), and the table registers
  `POST /api/jobs`, `PATCH/DELETE /api/jobs/{id}`,
  `POST /api/jobs/{id}/(pause|resume|run)` — **none is called from this
  slice** (the connector only ever GETs).
- Verification limit (same honesty note as #73/#83): the live daemon on
  this machine predates the slice (a restart is the operator's step), so
  the daemon end-to-end round against the REAL gateway is not exercised;
  the daemon-level proofs run against the in-process fake gateway pinned
  to the exact live envelope above. Only the `default` profile carries a
  key on this machine, so the named-profile jobs fetch is pinned by the
  live 401/404 observations + stub tests.

## Wire shapes

Register heartbeat (client → arbiter), ADD-key only:

```
hermes_jobs?: [ { profile?, id, name?, schedule?, enabled?, state?,
                  last_run?, next_run? } ]        // last_run/next_run epoch-ms
```

Absent (connector off, never polled, all profiles unkeyed/failed, empty
stores) ⇒ the key is OMITTED — the body byte-for-byte today's shape, and
an old arbiter never reads the key anyway. `GET /api/jobs/{id}` (the
issue's optional part): deliberately NOT fetched — the unpaginated listing
is already the complete per-profile truth and the strip needs no
drill-down; one GET per profile per round keeps the zero-extra-request
posture clean.

## Caps + sanitizers chosen (ledger-style, drop-don't-poison)

- Client: ≤ `JOBS_MAX_PER_PROFILE=50` rows per profile per round;
  `JOBS_MAX_TOTAL=100` rows published; strings id ≤64 (live class 12 hex),
  profile ≤64, name ≤128, schedule ≤128 (display form preferred:
  `schedule_display` → `schedule.display` → `schedule.expr` → legacy bare
  string), state ≤32 (NOT an exact-enum drop — the gateway owns that
  vocabulary); `enabled` exact boolean; timestamps ISO-8601 → epoch-ms,
  unparsable/negative dropped (never a fake zero). NEVER projected:
  `prompt`, `deliver`, `workdir`/`script`, `last_error`/
  `last_delivery_error`, `latest_execution`, `last_dispatch`, snapshots —
  the marker-scan tests assert none of them reaches the wire.
- Arbiter: `cleanHermesJobs` re-sanitizes independently (untrusted client):
  ≤100 rows, per-member caps (over-cap member DROPPED, the #80 roster
  edge posture), over-long/empty id drops the row, hostile extra members
  have no landing place; non-array / all-dropped ⇒ ABSENT, ABSENT never
  clears the stored block.
- Dashboard: renders what arrived; absent ⇒ the card hides (never an
  empty list pretending to be truth).

## Merge semantics (the honest statement)

Cross-round last-known-wins: a round that did not answer for a profile
(down / 401 / 404 / 5xx / malformed envelope) leaves that profile's stored
list untouched. A round that answered 200 with a well-formed envelope is
the COMPLETE truth for that profile (the gateway's `list_jobs` is
unpaginated), so it REPLACES the stored list — a deleted Hermes job leaves
the strip within one round instead of haunting it forever; an empty list
publishes NOTHING (absent, never a `[]` dump, and the arbiter's stored
block survives the same way).

## Harness + gates

- `client/test/hermes-jobs.test.ts` — 12 tests: sanitizer vs the pinned
  live record (private-member scan), legacy schedule forms, drop-don't-
  poison + caps units, `jobsPath`; connector: per-profile paths/keys +
  `include_disabled`, ONE GET per profile per round (cadence gate),
  unkeyed ⇒ zero requests, 401/500/malformed ⇒ last-known stands, 200
  replaces (deleted job gone in one round), empty ⇒ publish nothing,
  50/100 caps, down ⇒ ZERO jobs requests, poison records drop
  individually; daemon-level: connector off ⇒ `hermes_jobs` NEVER in any
  register body (byte-for-byte), on ⇒ rides under exactly `hermes_jobs`
  and NEVER a bare `jobs` key, poisoned members absent, unkeyed mirror
  zero requests.
- `server/test/hermes-jobs.test.ts` — 5 tests through the real Fastify
  app: valid stores + echoes on `/api/state` clients AND Projects workers;
  drop-don't-poison + hostile-member nowhere-to-land; absent-never-clears
  + old-shaped body leaves the row byte-for-byte (non-array and
  all-garbage array too); `cleanHermesJobs` unit caps; naming invariant
  (bare `jobs` on the wire never stores).
- `dashboard/test/hermes-jobs.test.ts` — 2 tests: the label constant is
  exactly "Hermes jobs" and Overview renders the constant (the card
  region contains no Button/onClick — read-only pinned); group collection
  (per client, absent/empty skip, online-first order).

Gates: `npm run test` exit 0 — server 435/435 (430 + 5 new), client
243/243 (231 + 12), dashboard 10/10 (8 + 2), career-ops 17/17, noop 2/2,
shell-ui 3/3, fleet 54/54 = **764 total, 0 failures** (main baseline 745).
`npm run build` exit 0. `npx tsc --noEmit` clean for client, server,
dashboard, fleet. `dashboard/dist` intentionally NOT committed (served
bundle regenerated centrally on main).

## Deliberately NOT in this slice

- The `/api/jobs/{id}` detail route (the issue's optional part) — the
  listing is already complete; fewer moving parts, same zero-extra-request
  posture.
- Any write verb (pause/resume/run/create/update/delete) — out of this
  issue's scope law for D ("Read-only; no pause/resume/run verbs"); the
  `paused` badge is display-only and says so in its tooltip.
- Prompt/deliver/workdir/error/execution projection — private-adjacent by
  design (the prompt is the operator's job prompt; the strip needs the
  schedule, not the payload).
- Per-round jobs polling (never), jobs in the session heartbeat (this
  rides the CLIENT register only), WIRE_PROTOCOL bump (ADD-keys precedent
  keeps it 1).

## Owner-visible notes

- After merge + client restart with the connector on + keyed, the operator
  sees a "Hermes jobs" card on Overview beside the Cycles strip: one block
  per machine, rows = that machine's Hermes cron (paused jobs visible with
  a `paused` badge). Machines whose gateway is down keep their last-known
  strip (absent publish never clears it).
- The strip is per CLIENT (not per project) — a client with no projects
  still reports its Hermes cron.
