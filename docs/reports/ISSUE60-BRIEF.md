# Mac-local arbiter: first fused instance, provider-aware server connections, oMLX metrics

Owner-directed 2026-10-05. Sequencing: (1) stand up the first local arbiter on
the Mac, (2) dashboard/UI work to add providers + model fail-over across them,
(3) basic metrics wiring.

## Why

`docs/architecture/mesh.md` D3/D5 locks the target: every machine runs one
fused arbiter serving its own local dashboard; the Swift desktop app is a thin
client of the LOCAL origin. urza-only arbiter hosting is the transitional
shape. Today the Mac has no arbiter (`lsof :8787` = nothing listening) and
urza's config carries no `mesh_peers` / `peer_token`, so the read plane built
in #50 has never federated in production.

## Live facts (measured 2026-10-05)

- The Mac's engine is oMLX: `omlx-server` on :8000, host 0.0.0.0, API-key auth
  on `/v1/*` (`/v1/models` -> 401 anonymous), `/health` -> 200. No activity
  feed: `/api/metrics/activity`, `/api/stats`, `/metrics` all -> 404.
- oMLX local truth: `~/.omlx/stats.json` (lifetime per-model prompt/completion/
  cached tokens, request counts, prefill/generation durations) and
  `~/.omlx/usage.sqlite3` table `model_usage_hourly` (hour x model: requests,
  tokens, seconds). `~/Library/Application Support/oMLX/logs/server.log`
  carries one `Chat completion: model=..., N tokens in Ts (tok/s), prompt: N`
  line per request.
- The Mac client daemon (launchd `com.sam.idlefill.client`) points at urza
  (`server_url` 100.105.225.1:8787, `llm_target` urza:11434). Its one project
  `career-ops` allocates `Qwen3.8-27B` — an engine that lives on urza.

## Blocker found in the code (fix first)

`IdleDetector.poll` treats ANY failed feed fetch as degraded, and a degraded
signal can never be idle, so grants stay fail-closed forever (`server/src/
idle.ts`). A provider with no activity feed — oMLX today — is therefore
unwatchable even though its log-mtime signal is perfectly good. Fix: a server
row with an empty `activity_path` (or a new `feed: false` flag) disables the
feed signal instead of degrading. Log mtime alone then carries the verdict,
same fail-closed posture when the glob matches nothing.

## Slice A — first local arbiter on the Mac

- Run the arbiter on the Mac, loopback :8787, its own `state.json` +
  `metrics` dir under a Mac data path. launchd label distinct from the
  existing `com.sam.idlefill.client` (the daemon stays one process).
- Seed it with the oMLX engine as its watched server (log-mtime signal on
  `~/Library/Application Support/oMLX/logs/server.log`).
- FORK LOCKED (owner decisions 2026-10-05, refined the same day): the daemon
  MOVES to the local arbiter now. Engine ownership is exclusive per mesh
  D2/D3: the Mac arbiter holds the detector for oMLX; urza's llama-swap can
  enter the Mac config as a reference row (`watched: false`, fail-closed for
  grants). `career-ops` does NOT move engines yet: it is deliberately
  configured `paused: true` on the Mac arbiter, so its grants fail closed by
  design and its queue stalling is the APPROVED state until Slice B + B2
  land. Do not repair career-ops in this slice. urza keeps its own arbiter,
  its engine, and its own career-ops view.

## Slice B — dashboard: add providers

The `+ add server` form (server/public/index.html `serverFormHtml`) posts
name/url/models/peers and an optional activity path. The server
(`Arbiter.upsertServer`) ALSO accepts `log_glob`, but the form never sends it.
Gaps to close:

- `log_glob` row on the add form AND the edit form (without it a provider
  added from the dashboard has no second signal at all).
- Provider kind: llama-swap (feed + log) vs log-only (feed disabled per the
  blocker above) — one select, not a magic string.
- Per-server credential for key-gated engines (oMLX needs `Authorization` for
  `/v1/*`; today no route or row carries a secret). Token must live in the
  arbiter's store/config, never in the page.

## Slice B2 — model fail-over across connected providers (owner ask 2026-10-05)

Idlefill gives an OPTION to fail over to models served by any provider
connected to idlefill. Shape:

- Per-project fallback chain (`model_fallback: [model, ...]` in the project
  config, edited in the dashboard's per-project settings form next to the
  grant knobs). Evaluated in order; unset chain = today's fail-closed
  behavior (fail-over is strictly opt-in).
- At grant time the arbiter walks the chain: the job's primary model first,
  then each fallback. A model is grantable only when one of THAT arbiter's
  own watched servers carries it and its signal is not degraded. Engine
  ownership stays exclusive — the arbiter never fails over onto a remote
  reference row (mesh D2/D3).
- The substitution rides the lease row and the executor payload's `model`
  field, so adapters run against the fail-over model knowing nothing about
  fail-over. The lease/dashboard row shows the substitution exception-only
  (rendered only when it differs from the queued model).
- The Slice B provider UI is what makes the chain visible to build: the
  dashboard shows which models each connected provider actually serves, and
  the operator (or an agent via MCP later) composes chains from that.

## Slice C — basic metrics

oMLX publishes hourly per-model usage locally. Two candidate shapes: a thin
exporter on the Mac that reads `usage.sqlite3` and POSTs samples to the local
arbiter (folds into #52's exporter design), or the arbiter reading the local
sqlite directly (it is on the same machine, which is exactly the co-location
rule #50 already enforces). Recommend the direct read for the Mac (no
sidecar, no network plane) and keep #52 as the remote-host answer. The
dashboard Usage section already renders the #51 store; the exporter only has
to feed it.

## Acceptance

- Mac arbiter answers `/api/state` and `/` on loopback; the oMLX row shows a
  live signal word and an `idle for` countdown, not a degraded row.
- The daemon's heartbeat lands on the Mac arbiter (worker row online);
  `career-ops` renders paused there; a stalled career-ops queue is expected,
  not a defect.
- urza and the Mac list each other in the Machines strip with `online` true
  (static `mesh_peers` + shared `peer_token` on both sides; peer_token grants
  ONLY `/api/mesh`).
- Desktop app repointed at the local origin still renders every tab.
- career-ops stays correct-but-paused on BOTH dashboards (urza's own view
  unaffected until the operator unpauses it there too).
- Gates: `npm run test`, `npm run build`, per-package `npx tsc --noEmit`.

Blocks / relates: #52 (exporter sidecar), #59 (menubar live load for connected
servers), #39 (pairing — this slice stays on static `mesh_peers` on purpose).
