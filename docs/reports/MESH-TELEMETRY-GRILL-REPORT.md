# GRILL REPORT — cross-mesh telemetry: read-time peer metrics over the mesh

**Doc:** `docs/architecture/mesh-telemetry.md` (new). D1..D7 in the
mesh.md format, per the issue #79 proposal. All D-blocks LOCKED in shape.
Open questions 1-6 await the owner. No src, config, or test file touched.
Type: wayfinder:grilling. Source: Forgejo issue #79. Supersedes one clause
of the LOCKED `metrics-history.md` D7 (the deferred cross-machine answer),
stated as an amendment in the doc's inherited-constraints block. Everything
else in #51 and #50 stands UNCHANGED and is REUSED, cited as such.

Citations re-verified against HEAD `4369a37` on 2026-10-09 (the worktree
branch `issue-79`).

## Live verification (actual output, 2026-10-09, this machine)

Port (`lsof -nP -iTCP:8787 -sTCP:LISTEN`): `:8787` LISTEN, node PID 84508
(the arbiter).

Anonymous `GET /api/state` (the live inventory): four server rows —
`oMLX`, `urza` (url `https://strata.samwarth.com`), `strata-scanbot`,
`llama-swap`. All four rows are watched and carry probed model lists. The
llama-swap row's list includes `Qwen3.8-27B`. `mesh.instance_id` = `m-99fdd154dd20`.
One peer: `urza` at `http://100.105.225.1:8787`, online, `fetch_age_s` 5.
The urza snapshot carries one engine row: `llama-swap`
(`idle` false, `idle_for_s` 17, `degraded` false), `queue_depth` 445,
`sessions` 2, `active_leases` 0. Snapshot keys:
`active_leases`, `instance_id`, `name`, `queue_depth`, `servers`,
`sessions`, `ts`. No models, no metrics, no tokens. The brief's claim
("presence crosses the mesh, detail does not") is CONFIRMED.

Auth posture (curl, the fleet `peer_token` read from
`server/config.json` in-script and never printed):

- `GET /api/metrics` (no token, no `series`) → HTTP 400. The route is
  anonymous and the bad param is told.
- `GET /api/metrics?series=engine&bucket=hour&from=1` (no token) → HTTP
  200, `series: []`, `truncated: false`. The 48-hour raw window holds no
  hour lines on this machine. The store is wired and answering.
- `GET /api/metrics?series=engine` with the fleet `peer_token` → HTTP 401.
  The `peer_token` does NOT unlock the local metrics route (confirmed the
  code claim at `server/src/api.ts:296`).
- `GET /api/mesh` with the fleet `peer_token` → HTTP 200
  (`instance_id` `m-99fdd154dd20`, name `mac-sam`, 4 server rows).
  The `peer_token` DOES unlock the mesh route (the scope this doc extends).
- `GET /api/metrics` with a wrong token → HTTP 401 (the strict check at
  `server/src/api.ts:304-307`).

Absence greps (verified 2026-10-09, zero hits each):

- `metrics-remote`, `peer_metrics`, `remoteMetrics` across `server/src`,
  `client/src`, `dashboard/src`: 0 hits. The read-time pull does not exist
  yet. The doc's D2 is new code.
- `docker`, `portScan`, `scanPort` across the same three packages: 0 hits.
  No auto-discovery exists (D7's boundary).

## Corrections to the brief

1. Row names. The issue body lists the Mac's four rows as "oMLX, urza/strata,
   strata-scanbot/strata, llama-swap." The live rows at probe time are named
   `oMLX`, `urza`, `strata-scanbot`, `llama-swap` (the row name for
   `https://strata.samwarth.com` is now `urza`). The row count (4) and the
   peer state (urza online, one coarse row) match. The live names above are
   the verified facts.

No other brief claim failed re-verification.

## Open questions (owner input, restated from the doc)

1. Existing fleet `peer_token`, or a second secret for the metrics plane now?
2. Which series cross on demand (engine only, or plus lease plus session)?
3. Is the 48-hour raw window enough cross-machine, or hour-bucket only?
4. Offline peer: last-pulled aggregate (labeled stale), or nothing?
5. Session series `token` field across the mesh: fine, or excluded by
   default?
6. Pull cache TTL default (60 s)?
