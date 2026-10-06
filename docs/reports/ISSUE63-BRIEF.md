# Issue #63 — Aggregate inference endpoint (tracker mirror)

The Forgejo issue body is the authority:
https://git.samwarth.com/sam/idlefill/issues/63
This file mirrors additions as they land (keep it in sync when the body is PATCHed).

---

# Aggregate inference endpoint: one URL, one model list, for every Hermes profile

## Gap (owner ask, 2026-10-05 session b33c0796)

Every Hermes profile should point at ONE loopback endpoint — the owner named
`http://127.0.0.1:8888/v1`. `hermes model` there must list the de-duplicated
union of models from every connected inference engine. The endpoint must
report profile + session id to the Sessions surface so analytics gain real
attribution. The follow-up ask: drop the hand-set `/s/<token>` base_urls
(that plane is issue #42; this issue grills the aggregate half).

Measured today: profiles point DIRECT at engines. Most config.yaml files
carry `http://100.105.225.1:11434/v1` (urza llama-swap) or
`http://127.0.0.1:8000/v1` (Mac oMLX). Only the `flash` profile uses the
idlefill router, at `http://127.0.0.1:11435/s/flash/v1`. Nothing serves
`8888`, and `8888` appears nowhere in the repo.

## Verified code facts (re-verify every citation in the doc)

- `client/src/proxy.ts` — the loopback proxy forwards to ONE target
  (`opts.target`). `/s/<token>/...` hits the gate; every other path is
  exact passthrough. Binds 127.0.0.1 only.
- `client/src/config.ts` — `llm_target` is a single string (the Mac's
  `client/config.json` sets `http://127.0.0.1:8000`); `proxy_port` default
  11435; `session_gate` default true; `max_active_agent_sessions` default 2.
- `client/src/session-gate.ts` — sessions keyed by `/s/<token>`;
  `X-Hermes-Session-Id` captured per request into `session_id` (#42 slice
  0, merged 5bf3190); slot cap + FIFO park + pause/force + fail-open.
- `server/src/types.ts` — `ServerConnection` rows already carry
  `models: string[]`, `provider` kind, and a per-server `auth_token`
  (#60 B). `auth_token` is WRITE-ONLY: stripped from every read surface
  (`serverView` in `server/src/api.ts:233-241`). Only the arbiter state
  file holds it.
- `server/src/api.ts` — every `/api/*` route needs a token from config
  `api_tokens`. The anonymous `/api/state` view exists. No data-plane
  route (`/v1/*`) exists on the arbiter today.
- Commit f5b8ab5 states plainly: an arbiter→router command channel "does
  not exist" — promote/remove were deferred for exactly that reason.
- The Hermes core sends NO session/profile identity on the wire (slice-0
  brief; `docs/reports/ISSUE42-BRIEF.md`). The header-injection seam is in
  the Hermes repo — OUT OF SCOPE for this issue (owner: idlefill repo only
  for this wave).
- Fleet state: Mac arbiter on loopback :8787 (launchd
  com.sam.idlefill.server), daemon proxy bound 11435, oMLX :8000
  key-gated, urza llama-swap at 100.105.225.1:11434.

## Proposal to grill

The router cannot fan out to N key-gated engines: it holds one
`llm_target` and zero engine credentials; the credentials sit write-only
in the arbiter. The arbiter already owns the whole engine inventory
(models, kinds, per-server tokens). Grill where the aggregate plane lives
and what identity survives without the token path.

## Decisions to settle (D1..D6)

1. **D1 — who serves the aggregate endpoint.** Options: (a) the client
   router binds a second fixed port (8888) and routes by model; (b) the
   LOCAL ARBITER serves a data plane (`:8787/v1/...`) and profiles point
   there; (c) a separate thin router process. Weigh against mesh.md D5
   (one fused process per machine) and D3 (local-first surfaces).
2. **D2 — the credential plane.** The arbiter already holds per-server
   `auth_token`s. Does the data plane live where the tokens live, or does
   a token get pushed to the router (needs the command channel that does
   not exist), or does the router config duplicate them (violates the
   write-only posture)?
3. **D3 — session identity without `/s/<token>`.** With the Hermes-core
   header injection out of scope this wave, what keys a session row on
   aggregate traffic? Options: keep the header path as the future key and
   accept one coarse row per profile today; derive identity from
   `X-Hermes-Session-Id` when present and fall back to the model/client
   pair; something the grill finds in the code.
4. **D4 — the de-duplicated catalog.** Union across `ServerConnection`
   rows + live `/v1/models` probes where reachable. Name collisions
   across engines (same model name, different hosts) — dedup key,
   display shape, and the routing target when one name maps to N engines.
   State what the arbiter provably cannot see for feed-off providers.
5. **D5 — gate + lease interplay.** Does aggregate traffic enter the
   session gate (slot cap, park, pause/force, idle folding, preemption)
   exactly like `/s/<token>` traffic, and under which key?
6. **D6 — what stays untouched.** The `/s/<token>` path keeps working
   (#42 keeps the router path for non-Hermes clients); the job-flow
   plain `/v1` passthrough contract is unchanged; the `flash` profile's
   existing config keeps working.

## Deliverable

`docs/architecture/aggregate-endpoint.md` in the mesh.md grill format
(numbered D1..Dn: chosen option, rejected alternatives, the deciding
trade-off; crisp rules; "what changes vs what stays untouched"; open
questions for the owner). LOCKED where clear-cut, PROPOSED where the
owner must weigh in. Plus the `docs/reports/README.md` index line and a
short `docs/reports/ISSUE<NN>-GRILL-REPORT.md`. ASD-STE100 prose. No
code changes in this issue — decisions first, build wave after.

## Fenced paths (worker owns ONLY these)

- `docs/architecture/aggregate-endpoint.md` (new)
- `docs/reports/ISSUE<NN>-GRILL-REPORT.md` (new)
- one index line in `docs/reports/README.md`

Must-not-touch: every `src/`, `test/`, `public/`, config file, and every
other doc. Never `git add -A`. Commit only (never push). Completion
marker as the final line of the run.

## Acceptance

- Every code citation re-read on disk before it lands in the doc.
- Each D states the chosen option, the rejected alternatives, and the
  trade-off that decided it.
- D2 answers where the token lives for a routed request end-to-end.
- D3 names the identity key that survives headerless traffic TODAY.
- No src/test/public/config file touched (checked with git show --stat).
