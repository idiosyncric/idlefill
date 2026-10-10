# #85 slice E — Richer host facts: `GET /health/detailed` earns the host-facts extension

**Status:** delivered on branch `issue-85-hostfacts` (worktree slice; merge to main by the coordinator). Slice E of the #84-key surface issue; slices A/G/D shipped on main before this one — this slice merges on top of them and both flows survive (see the merge note at the end).

## The earn-it verdict (live comparison at build — decided BEFORE the code)

The slice text is conditional: *extend the #73 host-facts block ONLY if the payload earns it (compare with `/v1/health` at build; skip silently if nothing beyond version/status)*. The comparison was run against the operator's live gateway (`http://127.0.0.1:8642`, Hermes **0.21.6**; the `default` profile's Bearer key read locally from `~/.idlefill/hermes-gateway-keys.json` — the key value NEVER pasted anywhere):

- `GET /v1/health` (unauthenticated 200; authed identical): `{status: "ok", platform: "hermes-agent", version: "0.21.6"}` — exactly the slice-B facts today (version + reachability posture).
- `GET /health/detailed` **without** a key: `401 {"error": {"code": "gateway_auth_failed"}}` — the surface is authenticated (the #73 per-profile-key rule applies).
- `GET /health/detailed` **with** the key: 200, and the payload carries MUCH more than `/v1/health`:
  - top-level `status: "degraded"` + `readiness.status: "degraded"` — a **different, stricter verdict** than the `/v1/health` "ok" (the health route reports liveness; the detailed route reports readiness);
  - named per-check verdicts: `state_db`/`session_store`/`config`/`model` ok, **`disk: degraded`** (with raw `used_percent: 98.1`, `free_bytes: 74434170880`), `gateway: ok` (with `state`, `connected_platforms: 4`, `platforms: 4`), `background_queues: ok` (with `active_api_runs: 0`, `process_completions`, `active_delegations`);
  - plus the private bait: per-platform connection records with **names** (discord, homeassistant, api_server, webhook), `writer_pid`s, ISO timestamps, `listener_base` URLs, `metrics_today`, top-level `pid`, `active_agents`, `gateway_busy/drainable`, `exit_reason`, `updated_at`.

**Verdict: EARNED IT.** A degraded-disk verdict + the readiness decomposition + two small counts are real operator facts that `/v1/health` cannot give (and the verdict MISMATCH right now — health "ok" vs readiness "degraded" — proves the surfaces genuinely differ). The skip-silently branch does not apply. But everything beyond the verdicts/counts is bait: the sanitizer drops it by construction.

## What shipped (ADD-keys only — ONE new wire key)

Wire key added: **`hermes_host_facts`** on the client register heartbeat (the #73 slice-B host-facts block's sibling). Nothing else on any wire changed.

- `client/src/hermes-gateway.ts` — slice-E section: `HermesHostFacts` (readiness verdict + `checks` name→status from a FIXED 7-name whitelist `READINESS_CHECKS` + `connected_platforms` (≤100) + `active_api_runs` (≤10 000)); `HostFactStatus` = `ok|degraded|down|unknown` (anything else normalizes to `unknown`, never a crash, never a fabricated `ok`); `sanitizeHostFacts` (drop-don't-poison: every member checked individually; a check may be a bare string or an object; oversized counts dropped, the statuses stand) with the EARNINGS TEST baked in — a detailed body that carries nothing beyond what the health round already reported returns `undefined` (no readiness block, no whitelisted check statuses, no counts, or a verdict identical to `/v1/health`'s when it adds nothing else ⇒ no wire key at all, the issue's skip-silently rule). `fetchRound`: ONE `GET /health/detailed` per REACHABLE round, sent ONLY when at least one profile carries a key (the surface is authenticated; `anyKey` = the default key else the first provisioned profile key — the route is native/global, not profile-scoped, verified live: no `/p/<profile>` prefix exists for it). 401/403/404/5xx/timeout/malformed-JSON ⇒ silent skip, the round stands on the plain health facts. Connector holds `this.hostFacts` per round; `snapshot()` emits `hostFacts` ONLY when `reachable && hostFacts` — an unearned round's snapshot is EXACTLY the pre-#85 shape.
- `client/src/index.ts` — `hermesGatewayHostFacts()` gains the `hermes_host_facts` ADD-key, published ONLY when the snapshot carries it. Down / unkeyed / unearned ⇒ the register body stays byte-for-byte the slice-B+D shape.
- `server/src/types.ts` — `ClientRecord.hermes_host_facts?: HermesHostFactsSummary` + `HostFactStatus` (doc-commented like the sibling ADD keys; display/audit only, never a gate).
- `server/src/arbiter.ts` — `cleanHostFacts` (the #73/#80/#85-D edge-sanitizer posture: the arbiter does NOT trust the client's caps — whitelist, verdict enum and integer bounds re-checked; unknown check names / bad statuses dropped individually; a wholly-invalid block ⇒ undefined ⇒ treated as ABSENT). `registerClient`: present+valid replaces the stored block; **absent NEVER clears it** (new + heartbeat paths) — an old client, a mixed-version heartbeat, or a gateway outage leaves the row byte-for-byte unchanged.
- `server/src/api.ts` — the register route passes the key through (sanitization at the arbiter edge, like `agent_roster`/`hermes_jobs`).
- **Dashboard: ZERO changes (deliberate).** The arbiter-side client rows have no existing host-facts display — even slice B's `hermes_version`/`gateway_reachable` surface only on the Settings card's LOOPBACK live connector read (`/client/hermes-gateway`), which shows the connector's own posture, not stored facts. Adding a stored-facts panel would be new chrome, which the slice forbids. The facts land on the row for audit/CLI and any future display decision.

## Fail-open + caps evidence (tests)

- Unreachable gateway: ZERO `/health/detailed` requests; snapshot deep-equals `{reachable:false}` (no `hostFacts` key at all).
- No operator key: the authenticated probe never fires (0 detailed requests).
- Detailed route 404 / 500 / 401 (wrong key): silent skip, snapshot deep-equals `{version, reachable:true}` — byte-for-byte the slice-B shape.
- A detailed body that adds nothing beyond `/v1/health` (status/version, or an identical readiness verdict with no checks/counts): the probe RAN but publishes NOTHING.
- The earnings case rides the wire ONCE per reachable round: the heartbeat body carries `hermes_host_facts` with `checks.disk === 'degraded'` and `connected_platforms === 4`, and a JSON marker-scan proves `used_percent` / `free_bytes` / platform names never leave the connector or the register body.
- Arbiter edge: `cleanHostFacts` drops non-whitelisted names, over-cap counts, non-integer/negative counts; garbage block never clears the stored one; an old key-less payload registers and never gains the key.

## What was cut from the WIP

The branch carried an uncommitted scaffold from a previous session (folded as `wip:` before the main merge, then reviewed against this live evidence). Honest outcome: **no code was cut** — every block (the earnings test, the 7-name whitelist, the two counts, the arbiter edge re-sanitizer) is directly earned by the live payload above, and the WIP's test fixture matches the live shape (only `free_bytes` differs: a live meter). The WIP also correctly left the dashboard alone, which review confirmed. What the slice DID have to grow into: the merge with D (below). The "shrink" the issue anticipated did not materialize because the payload genuinely earned the block — the comparison is the authority, not frugality for its own sake.

## Merge note (coordinator: verify these in the merge to main)

`main` (slice D's `hermes_jobs` + the jobs fetch in `fetchRound`) collided with the WIP in ALL FIVE shared files — `client/src/hermes-gateway.ts` (the `fetchRound` unreachable-early-return + final return now carry BOTH `hostFacts` and `jobs`; the detailed probe sits between the health round and the per-profile ledger loop; D's jobs loop after it), `client/src/index.ts` (both doc blocks; the register body emits `hermes_jobs` AND `hermes_host_facts`), `server/src/{api,arbiter,types}.ts` (both ADD-keys in the register body type, both `clean*` sanitizers in `registerClient`, both fields on `ClientRecord`). D's `cleanHermesJobs` edge and the jobs visibility flow survived untouched (its 19 tests pass); E adds alongside.

## Gates (from the worktree, after the merge + this slice)

- `npx tsc --noEmit`: client, server, dashboard, fleet — all clean.
- `npm run test`: server 440/440 (+5), client 251/251 (+8), dashboard 10/10, fleet 54/54, adapters 19/19, shell-ui 3/3 — **777/777, 0 fail** (main baseline 764 + 13 new).
- `npm run build`: clean; `dashboard/dist` untouched by this commit (no bundle regeneration churn — the coordinator regenerates centrally).
