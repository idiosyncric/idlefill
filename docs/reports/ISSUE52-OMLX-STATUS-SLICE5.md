# #52 slice 5 — the oMLX `/api/status` collector (the D8 amendment, wired)

The slice the grill's D8 amendment opened (`ISSUE52-GRILL-REPORT.md`
follow-up 1, `../architecture/metrics-sidecar.md` D8): the probe hit
`/health` and never `/api/status` — a probe hole, not an engine gap. The
installed oMLX 0.7.0 carries a REAL in-flight count, and this slice
re-points the oMLX collector at it. oMLX stops being mtime-only and gets
its first real D4 veto.

## What shipped (exactly the LOCKED call, no scope creep)

- **The surface** (`server/src/load.ts` `LoadCollector.specFor`): oMLX
  polls `GET {url}/api/status` (was `/health`), and `load_source` becomes
  **`omlx-status`** (was `omlx-health`). The `/health` parse
  (`parseOmlxHealth`) had no consumer after the re-point and was removed;
  the 05:55 `/health` capture stands in the inventory as the record.
- **The predicate** (`loadBusyFor`, the kind's first real D4 veto):
  **`active_requests > 0`**. A read without the count is UNKNOWN
  (`load_busy` absent), never a fake idle and never a fake busy. The D3
  freshness gate is untouched: the veto rides only while
  `load_age_s` ≤ `metrics_load_stale_s` (45 s default).
- **The counts**: `in_flight` = `active_requests` (the aggregate
  in-flight across loaded engines), `queue_depth` = `waiting_requests`
  — the first queue count in the fleet, filling the D5 "named, not
  filled" key for the oMLX kind. Absent on llama-swap and strata (the
  probes found no queue count there — unchanged).
- **Real identity**: `model_loaded` = the ACTUAL loaded ids from
  `loaded_models` (joined with `,` when several are resident — no longer
  the default-model guess, and absent when nothing is loaded);
  `model_quant` = the shared quant when every loaded id parses to the
  same one (ambiguous when they differ — never a guess);
  `omlx_loaded_count` = `models_loaded` (pool residency; falls back to
  the id count when the count field is missing).
- **Tolerant sanitizer**: a non-finite/negative count drops that KEY
  (never coerced to zero), non-string `loaded_models` entries are
  skipped, and a 200 body naming no usable count and no model info is a
  FAILED read (null) — absent = unknown, never a fake idle.
- **ADD keys, same posture as slices 1–4**: `queue_depth` joins the
  signal block (`types.ts` `IdleSignal`) and the #51 engine sample line
  (`metrics.ts` `EngineSampleLine`); the arbiter/API spread the whole
  view, so it passes through with no whitelist change. The mesh
  snapshot stays byte-for-byte (D7). Hour buckets stay load-free (D5).
  The dashboard is UNTOUCHED (the new keys ride the wire;
  `loadRead` shows its existing parts).

## Locked things that stayed locked

- **llama-swap threshold: still UNSET by owner choice** — no number
  invented, no knob touched; the kind's gauges ride as display/sample
  and its veto stays inert.
- **KV posture: ride the proxies, no KV key.** The `avg_*_tps` /
  `total_*_tokens` / `model_memory_*` fields of the envelope are NOT
  wired — the lock names only predicate/identity/in_flight/queue_depth.
- **The mtime stays the fallback basis** until a fresh read lands, and
  the fail-open discipline is unchanged: a failed load read never
  touches `signal_degraded`, never vetoes, never fills a zero.

## Live-vs-documented verdict (honest)

**No live capture exists.** oMLX was re-checked at this slice: still
DOWN — `/api/status` and `/health` on `127.0.0.1:8000` both answer
`000` (nothing listens), and the live watched row (`srv-watched`,
provider `omlx`) carries NO load keys — exactly the D2-rule-3 fail-open
plane. So the test fixture is pinned to the **installed 0.7.0 source
itself**: `brew omlx 0.7.0` → `omlx/server.py` `server_status`
(lines 2945–3026), the exact return dict that answers — `status`,
`version`, `uptime_seconds`, `models_discovered`, `models_loaded`,
`models_loading`, `default_model`, `loaded_models: [ids]`,
`total_requests`, `active_requests`, `waiting_requests`,
`total_*_tokens`, `cache_efficiency`, `avg_prefill_tps`,
`avg_generation_tps`, `model_memory_used`/`max`, `custom_kernels`,
`ane_prefill` — matching the inventory addendum's envelope. When the
host is back, the live payload should be re-captured against this
fixture (the sanitizer is tolerant of drift; a field the installed
0.7.0 does not emit cannot be a fake zero).

## The credential (where the key comes from)

`/api/status` is guarded by oMLX `verify_api_key` (installed source,
`omlx/server.py:323-375`): it checks the **`Authorization: Bearer`**
header (or `x-api-key`) against the main key AND all sub keys — the
row's key qualifies, unlike the admin surface (main key only). The
collector already sends that header from the shared row credential
(slice 4's family): `index.ts` `loadCollectorFor` passes
`ServerConnection.auth_token` (`server/src/types.ts`) and the collector
sends `Authorization: Bearer <token>` only when set; the meta rebuild
keeps a later-set token live. The watched oMLX row's token is seeded
from config `server_auth_token` (gitignored `server/config.json`) at
`arbiter.ts:2674`. **No key appears in code, tests, reports, or
commits** (tests use a placeholder). The 401 body shape was verified
from the source too — FastAPI `{"detail": "API key required"}` — so the
slice-4 named-reason parser now also reads a top-level `detail` (the
engine's own message rides verbatim, same shape as strata's
`error.message`); the named reason now says
`/api/status requires a credential (HTTP 401: API key required) — the
row carries no credential — set auth_token on this server row (the D4
busy predicate can never fire until it does)`.

## Fail-open parity pinned by tests

- oMLX unreachable → SILENT: no reading, no reason, `current()` null —
  the row reads byte-for-byte as today's mtime-only row (this is what
  the live row does right now).
- oMLX 401 without a credential → reason-only view (`load_fail_reason`
  is the ONLY key), never a fake `load_source`/`load_age_s`/`load_busy`.
- oMLX 401 WITH a credential → the wrong/revoked case named; a later
  200 clears it (last-success-wins) and `load_busy` starts riding.
- Verdict byte-identity: with each failed oMLX read the detector
  verdict JSON equals the no-collector baseline (fresh and degraded).
- e2e: a FRESH `active_requests: 2` read vetoes (feed idle, `idle`
  false, grant denied with reason `load_busy`); a fresh 0 publishes
  `load_busy` false and the grant goes through; a 46 s-old busy read
  is UNKNOWN (counts still ride, no veto).

## Files + gates (real counts)

Changed: `server/src/load.ts`, `server/src/types.ts`,
`server/src/metrics.ts`, `server/test/load-capture.test.ts`,
`server/test/busy-veto.test.ts`, the design doc + reports index. No
client/dashboard/fleet change; no new config knob; `dashboard/dist`
untouched.

- 16 new tests (11 `load-capture`: parser envelope/loaded-ids/
  multi-model/tolerance + 3 collector + 4 fail-open; 5 `busy-veto`: 2
  collector freshness + 3 arbiter e2e), replacing the 5 tests that
  pinned the old `/health` parse.
- `npx tsc --noEmit -p server`: clean.
- `npm run test`: server 451/451, client 251/251, career-ops 17/17,
  noop 2/2, shell-ui 3/3, dashboard 10/10, fleet 54/54 — **788/788,
  0 fail** (main baseline 777; +11 net).
- `npm run build`: green.

## Open when this merges

1. **Live proof pending**: oMLX is down — when it is back, re-capture
   `/api/status` against the fixture (grill follow-up 1's "re-verify
   when the host is back" stays open until then).
2. The watched oMLX row already carries a credential path
   (`server_auth_token`); if the loopback server runs with NO api_key,
   `verify_api_key` accepts keyless loopback — the read works either
   way (verified in the installed source).
3. llama-swap `model_loaded`/`model_quant` pairing (grill follow-up 2)
   and the optional threshold number (follow-up 3) remain follow-ups.
