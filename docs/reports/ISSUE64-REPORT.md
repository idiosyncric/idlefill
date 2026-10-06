# Issue #64 — Aggregate inference endpoint build report

Authority: `docs/architecture/aggregate-endpoint.md` (LOCKED, owner review
2026-10-05). Tracker mirror: `ISSUE64-BRIEF.md`. Forgejo issue:
https://git.samwarth.com/sam/idlefill/issues/64

## What shipped

The Mac client daemon now runs a SECOND loopback listener inside the same
process. Default: `127.0.0.1:8800` (`aggregate_port`; `0` turns it off).
Mesh D5 counts processes, not listeners, so the process count did not
change.

- `client/src/config.ts` — ADD key `aggregate_port` (default 8800, `0` =
  off). The loader clamps negative and garbage values to the default.
- `client/src/aggregate.ts` (new) — the model-routed router.
  `GET /v1/models` answers from the catalog union, never a probe. A chat
  request routes by the body's `model` to the catalog row's engine. The
  router adds that row's `Authorization` header from an in-memory key
  table. An unknown model, an absent model, or an empty catalog falls
  back to the machine's `llm_target`. A port conflict logs one line and
  the daemon continues without the endpoint.
- `client/src/index.ts` — starts the listener in front of the SAME
  `SessionGate` instance (one shared slot cap). The existing `/api/state`
  poll feeds the catalog. A second pull of the same cadence reads
  `GET /api/server-keys`. Tokens stay in memory only. The register
  heartbeat for an aggregate session carries `server_id` = the
  catalog-chosen row (D5).
- `server/src/catalog.ts` (new) — catalog merge rules. A successful
  `/v1/models` probe replaces the row's declared list. A failed probe
  keeps it (`catalog_source: "declared"`, never a false `probed`). A bare
  name appears once; the first row in declaration order wins.
- `server/src/arbiter.ts` — `probeCatalog()` runs on the `poll_ms` tick
  with a credentialed per-row fetcher (same family as #60 B).
- `server/src/api.ts` — the `catalog` ADD-key on `GET /api/state`
  (name, server_id, url, `auth_set`, `catalog_source` — never the token).
  New `GET /api/server-keys`: admin token PLUS a loopback check on
  `req.socket.remoteAddress`. A non-loopback caller with a valid admin
  token gets 403. `/api/state` is still anonymous-readable and still
  carries no credential.

D6 fence held: the 11435 listener, the lease/queue/budget engine, and
every existing route's auth scope are unchanged. The suite re-runs the
11435 `/s/<token>` flow and the job passthrough as regression guards.

## Gate numbers (actual output)

- `npx tsc --noEmit` per package: clean (client and server).
- `npm test` (workspace): server 184 pass / 0 fail; client 97 pass / 0
  fail; adapters 17 + 2 pass / 0 fail. Total 300 pass.
- New tests: 5 server-side in `server/test/api.test.ts` (catalog merge,
  collision pin, probe-blocked stays declared, credentialed probe,
  server-keys loopback rule both ways, `auth_token` substring absent from
  the state JSON). 6 client-side in `client/test/aggregate.test.ts`
  (models from catalog, per-row auth header, fallback, header-else-model
  gate key, one shared cap across both listeners, `engineBase`).
- `npm run build`: rc=0.

## Live acceptance (Mac, 2026-10-06)

- No active leases before the restart (check script read the token from
  gitignored `client/config.json` at runtime).
- Arbiter + client restarted with `launchctl kickstart -k` (only those
  two labels).
- `curl http://127.0.0.1:8800/v1/models` → 4 deduped entries: two
  `srv-watched` (declared), `qwen3.8-flash-next-iq3_s` (`srv-45abb4e8`,
  probed), `qwen3.8-flash-next-q2_0` (`srv-f1c85327`, probed).
- Chat through :8800 with `qwen3.8-flash-next-q2_0` → 200 from the
  10.10.10.241 row engine (its `timings` block proves the target).
- Same request shape with an unknown model through :8800 and through
  11435 → byte-identical upstream answer. Fallback = today behavior.
- Sessions view: derived-key row `qwen3.8-flash-next-q2_0` carries the
  non-watched `server_id` `srv-f1c85327` (D5). The `/s/agg64fence`
  session on 11435 registered and admitted exactly as before.
- Anonymous `/api/state` → `catalog` present, zero `auth_token`
  substrings, zero key values (compared without printing them).

## What is left (operator / next wave)

- The Hermes core must inject `X-Hermes-Session-Id` (separate action).
  Until then, aggregate sessions key on the model name — the D3 fallback,
  proven live above.
- Hermes profile configs must re-point to `http://127.0.0.1:8800/v1`.
  That is the owner's action AFTER the wave (brief, sequencing note).
- Two live session rows from the test probes (`NotInCatalog64`,
  `agg64fence`) age out on their own TTLs.

## Notes for the next worker

- A client test that starts a real daemon must set `aggregate_port: 0`,
  or it fights the live daemon for :8800. The env-JSON config path
  (`IDLEFILL_CLIENT_CONFIG` in `client/test/adapter-registry.test.ts`)
  needs the same key — an object patch to the typed fixtures misses it.
- The Hermes write path mangles token-like literals to `***` in tool
  args. Build such strings from fragments in a script and byte-verify
  after writing.
