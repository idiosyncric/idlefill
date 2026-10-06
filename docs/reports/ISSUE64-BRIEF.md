# Issue #64 — Aggregate inference endpoint build wave (tracker mirror)

The Forgejo issue body is the authority:
https://git.samwarth.com/sam/idlefill/issues/64
The locked decision doc: `docs/architecture/aggregate-endpoint.md`.
This file mirrors additions as they land (keep it in sync when the body
is PATCHed).

---

# Aggregate inference endpoint — build wave (:8800, catalog, gate-keyed sessions)

## Authority

Decision doc `docs/architecture/aggregate-endpoint.md` is LOCKED in full
(owner review 2026-10-05, all six decisions + four owner answers). This
issue is the build. Every D-rule from the doc binds; re-read it before
coding. Companion grill: #63.

## Scope (the doc's "Changes" list, verbatim shape)

- `client/src/config.ts`: ADD `aggregate_port` (default **8800**, `0` =
  off). Loader DEFAULTS pattern.
- `client/src/index.ts`: start a SECOND loopback listener (`startLlmProxy`
  shape) with a catalog router in front of the SAME `SessionGate`
  instance. Add the catalog fetch/refresh loop (pull on the existing
  poll cadence).
- `client/src/proxy.ts` or a sibling module: the model-routed forward —
  one target per chosen row, per-request `Authorization` header from the
  router's in-memory key table. Unknown/absent model falls back to the
  machine's default `llm_target` (never worse than plain passthrough).
- `server/src/api.ts`: ADD `GET /api/server-keys` — admin-token scoped,
  answers ONLY to loopback callers (the arbiter binds 0.0.0.0; enforce
  the loopback check in the route). Returns per-row engine URL +
  auth_token for the router's own use. It is NOT part of `/api/state`
  (that view is anonymous-readable) and no other read surface ever
  carries a token.
- `server/src/arbiter.ts` / idle.ts family: per-row credentialed
  `GET /v1/models` probe on the `poll_ms` tick; probe success REPLACES
  the declared list, failure keeps it; the merged catalog publishes to
  the router (`/api/state` ADD-key `catalog` block: model name, server
  id, engine URL, `auth_set` — never the token).
- Session identity (D3): the gate key is `X-Hermes-Session-Id` when
  present, else the request body's `model` name (sniff without
  buffering — the #45 pattern). Register carries `server_id` = the
  catalog-chosen row (D5: wrong row = wrong idle folding/preemption).
- Collision rule (D4 + owner): a bare name on N rows renders ONCE;
  routing pins to row declaration order (no `model_preference` key this
  wave). Probe-blocked rows publish `catalog_source: declared`.
- `/v1/models` on :8800 answers from the catalog union — never a
  passthrough probe.

## Untouched (D6 fence)

The 11435 listener's behavior is byte-for-byte unchanged (`/s/<token>`
gate branch + plain `/v1` job passthrough). `SessionRecord`'s existing
fields keep their ADD-key contract. Every existing `/api/*` route keeps
its auth scope. Leases/budgets/mesh read plane untouched. Profile
configs stay the operator's action AFTER the wave, not part of it.

## Acceptance

- Suite: catalog merge + collision rule (bare dedup, declaration-order
  pin), probe-failure-keeps-declared, key-pull route answers loopback
  only (non-loopback caller refused), gate derived-key registration
  (header present and absent paths), fallback-to-llm_target for unknown
  model, catalog block shape on `/api/state` carries `auth_set` and no
  token anywhere.
- `npx tsc --noEmit` clean per package; `npm run test` + `npm run build`
  green before push.
- Live acceptance on the Mac: `curl http://127.0.0.1:8800/v1/models`
  returns the deduped union; a chat-completion with a known model
  reaches the right engine (oMLX row today); the Sessions view shows
  the derived-key row with the correct `server_id`; the 11435 job flow
  and one `/s/<token>` session still behave exactly as before
  (before/after evidence).
- Report `docs/reports/ISSUE64-REPORT.md` + README index line +
  screenshot evidence under `docs/reports/`.

## Sequencing note

This issue is additive on main (direct-to-main mode). The Hermes-core
`X-Hermes-Session-Id` injection and the profile config re-point ride
separate owner actions; the endpoint must behave correctly with them
absent (D3's fallback).
