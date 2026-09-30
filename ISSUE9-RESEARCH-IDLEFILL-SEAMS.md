# idlefill — Seam map for issue #9 (sessions) + Forgejo tracker capability

Repo: `/Users/sam/Software/idlefill` (branch main, clean, read-only). All line numbers verified against the working tree on 2026-09-30.

## Seam map

### 1. Client registration / heartbeat

| What | Where |
|---|---|
| Route `POST /api/clients/register` (authed) | `server/src/api.ts:215`–`280` (handler; body shape `{name, ip?, projects?, version?, protocol?}` at 216; queue_preview sanitized ≤100 rows at 235–252; stats ≤24 keys at 220–229; calls `arbiter.registerClient` at 271–278; 200 `{client_id, created}` at 279) |
| Idempotent-by-name core | `server/src/arbiter.ts:112`–`167` `registerClient` — id field is **`name`** (lookup at 133: `s.clients.find((c) => c.name === name)`); the stable row id is **`client_id`** (`c-<8hex>`, minted at 148, type `types.ts:138`) |
| Re-registration = heartbeat | `arbiter.ts:134`–`147` — refreshes `last_seen` (138), observed IP wins (135), replaces `projects`, tracks version/protocol (143–144), returns the SAME `client_id` with `created:false` (146). Event `client_registered` only on first contact (163) |
| 90s online rule (not a heartbeat timer — it's a display/eligibility window on `last_seen`) | `server/src/api.ts:84` (`online: now - c.last_seen < 90_000` in `projectView` worker rows) and `api.ts:167` (queue-depth attribution in `serverView`); mirrored client-side in menubar `menubar/IdlefillMenubar.swift:376` (machine option online) and `:841` (`daemonRunning = meLastSeen > 0 && nowMs - meLastSeen < 90_000`). No sweep drops stale clients — the window is re-evaluated per read |
| `last_seen` type/meaning | `server/src/types.ts:151–152` (epoch-ms of most recent successful (re)registration) |
| Client side | `client/src/index.ts:574`–`614` `register()` (POST at 575); heartbeat = re-register with fresh queue depths **every tick** of the daemon loop (`tickOnce` at 670, `refreshRegistration` call at 674; loop 660–668; `pollMs` default **20000 ms** at 514, knob at 488). Also restores after server restart and reconnects WS (671–674 comment) |
| Where overrides stick across restarts | Overrides are keyed by `client_id` in `state.overrides` (`types.ts:335`–`340`, `state.ts:25, 68–69`). Re-registration by the same **name** keeps the same `client_id` (`arbiter.ts:146`) so overrides persist; the `types.ts:335–337` comment documents the one exception: unregistration followed by re-registration mints a NEW `client_id`, so the override does NOT stick in that case (the orphaned entry is swept — see seam 2) |

**Session version needs:** a session is not a registered client. Minimal reuse: piggyback on the `clients` row (no new endpoint) — e.g. the daemon reports a `session` field in the register body (sanitizing pattern already there at `api.ts:220–252`); or add `state.sessions` + a `GET /api/state` field (seam 5). The 90s window at `api.ts:84/167` is the liveness precedent to copy if sessions carry their own `last_seen`.

### 2. Operator override (`POST /api/clients/:ref/override`)

| What | Where |
|---|---|
| Route + handler | `server/src/api.ts:287`–`299` — `:ref` = client **name or client_id** (decoded at 288); body `{override: "pause" \| "force" \| null, until?: epoch_ms}` (289); 400 on bad override (292–294); `until` must be finite ms (295); 404 unknown client (297) |
| Storage | `state.overrides: Record<client_id, ClientOverride>` — `types.ts:340`, type at `types.ts:184`–`189` (`{client_id, override, until, set_at}`); load/migration `state.ts:25, 68–69` |
| Arbiter API | `setClientOverride(ref, override, until)` — `arbiter.ts:199`–`238` (resolves ref→client, clears on `null` 210–221, appends `client_paused`/`client_forced` event 231–234); `activeOverride(clientId, now)` — `arbiter.ts:179`–`191` (null when absent or `now >= until`) |
| Grant-time gates | `requestLease`: **pause** = hard deny before idle/busy (`arbiter.ts:264`–`266`, reason `client_paused`, comment 260–263: never touches an active lease); **force** = bypasses ONLY the idle verdict + reidle gate (`arbiter.ts:291`–`301`; degraded still blocks 298–300, and per `types.ts:177–179` also not max-concurrent/project-pause/budget) |
| Sweep site ("optional until expiry swept each tick") | `arbiter.ts:401`–`408` inside `tick()` — drops expired (`nowMs >= o.until`) and orphaned (client no longer registered) overrides every poll |
| Payload exposure | `/api/state` clients rows carry the live override: `api.ts:512` (`clients.map((c) => ({...c, override: arbiter.activeOverride(...)}))`) |
| Client side | `client/src/index.ts:702`–`711` — pause → daemon stops asking (703); force → client skips its own idle/reidle checks (710–711) mirroring the server |
| Dashboard | `setOverride()` at `server/public/index.html:1016` (POST with `?token=` at 1032); per-worker gate select 565–568; paused badge 545–547 |
| Menubar | read-only projection: `overrideLabel` from `c["override"]` in `ScopeView.project` at `IdlefillMenubar.swift:363` (controls themselves hit the existing routes — header comment L25–27) |

**Session version needs:** the route is per-**client**; a session-level pause would need either a new `:ref` namespace (`sessions/:id`) or a new body dimension — the store shape `Record<id, {override, until, set_at}>` (`types.ts:184–189`) and the sweep loop (`arbiter.ts:403–408`) are the exact patterns to clone; grant-time insertion point is `requestLease` just before the idle check (264/291 area).

### 3. Reidle gate + lease state machine

| What | Where |
|---|---|
| `requestLease` (grant conditions, full order) | `server/src/arbiter.ts:244`–`352` (signature 244–251). Order: unknown client 255–256 → **pause override** 264–266 → job throttled 276–278 → job cooldown 279–282 → idle verdict + degraded + **force** 284–301 (force computed 291; `!sig.idle` 293; **reidle gate 297** reason `not_idle`; degraded-still-blocks 298–300) → unknown project 304–305 → project paused 306 → **max_concurrent_leases** 309–310 (reason `busy`) → **daily token cap** 312–313 (reason `budget_exhausted`) → adaptive TTL 315–328 → lease object 329–342 (`exempt_ip: client.ip` at 333; `expires_at = now + leaseTtl*1000` at 339) → push/event/save 343–350 → return 351 |
| **Reidle gate — what it is** | NOT a per-project setting: a single **global runtime flag** `reidleAfter: number \| null` (`arbiter.ts:65`, doc at 20–21 + 294–296). Armed by ANY revocation during a tick (`arbiter.ts:412`–`413`), disarmed by a later full-idle verdict (414–415). Checked at grant time at 297 (skipped when forced). Accessor `reidleGated()` 424–426; exposed in payload at `api.ts:161` (serverView signal) and `api.ts:502` (`idle.reidle_gated`); client honors it at `client/src/index.ts:711` |
| Per-project grant knobs | `project.max_concurrent_leases ?? cfg.max_concurrent_leases` at 309; effective-values helper `projectEffectiveSettings` 798–805; note: per-project `idle_seconds` exists in config (`types.ts:14–17, 315`) and is surfaced to the dashboard (`api.ts:102–116`) but the grant itself checks only the GLOBAL detector verdict (`sig.idle`, 258/293) — the per-project idle knob is display-only today |
| State machine | `active → finished \| revoked \| expired` (`arbiter.ts:4`); `LeaseStatus` type `types.ts:191`; `Lease` fields incl. `exempt_ip`/`expires_at`/`tokens_out/in`/`usage_counted` at `types.ts:193`–`219` |
| Revocation paths (all in `tick()`, `arbiter.ts:358`–`421`) | (1) **TTL expiry** 382–386 → `endLease('expired','ttl_expired')`; (2) **activity preemption** 393–398 → `endLease('revoked','preempted')` — only when NOT degraded, NOT idle, and the newest non-exempt `last_activity.ts >= lease.granted_at` (stale entries don't revoke; exempt traffic can't preempt at all). `endLease` itself: 822–832. (3) **Client-reported failure** via `finishLease` 442–511 (`status = ok ? 'finished' : 'revoked'` at 479; `end_reason` 480). Budget is NOT a revocation path — it only blocks new grants (312–313) |
| Daily token cap / budget bar enforcement | Gate: `arbiter.ts:312`–`313` (`used >= project.daily_token_cap`). Counting: first usage report per lease only — `finishLease` 472–475 (`usage_counted` flag, `addBudget` at 815–820, keyed `state.budgets[project][utcDay]` per `types.ts:343`). Reads: `projectTokensOut` 790–791, `projectBudget` 807–811 (returns `{tokens_out, tokens_in, cap}`). Dashboard bar: `index.html:535`–`538` (hot > 80%, 538); cap text 495. Config default: `Number.MAX_SAFE_INTEGER` = "∞" (`config.ts:71`) |
| max_concurrent_leases enforcement | `arbiter.ts:309`–`310` (active lease count ≥ effective max → `busy`); `activeLeases(now)` used at 303 |
| WS revocation push | `server/src/api.ts:554`–`614` `attachWebSocket` (`/api/leases/events`, token in query 563–568); `broadcast` 603–608; pushed per revoked lease by the tick loop (`server/src/index.ts:72`–`84` — `arbiter.tick()` → `{revoked}` → broadcast; loop interval `cfg.poll_ms` at 85) |
| Client teardown on revoke | `client/src/index.ts` WS handler (connect at 632–633) + server-side lease-loss check at 688–692 (teardown `lease_lost`) |

**Session version needs:** the reidle gate's "armed/disarmed by any revocation" semantics (412–416) are the template for a session analogue (session end → gate armed → require fresh idle before backfill resumes). Grant-condition insertion for a session gate slots at ~264/297 (before the idle check); a session-held box that should NOT be leased is today expressible only as a per-CLIENT `pause` override (seam 2) — there is no session-level row in `state` yet.

### 4. Activity feed correlation + self-traffic exemption

| What | Where |
|---|---|
| Feed source | `GET {llama_swap_url}{activity_path}` — URL built at `server/src/idle.ts:74`; defaults `config.ts:26` (`/api/metrics/activity`), config type `types.ts:25/42`; detector constructed with the real fetcher at `server/src/index.ts:22` |
| `ActivityRow`/`ActivityEntry` parsing | Type: `server/src/types.ts:224`–`228` (`{timestamp, src, model}`); real fetcher `makeRealActivityFetcher` `idle.ts:181`–`188` (expects `{data: ActivityEntry[]}`, 10s `AbortSignal.timeout`); wrapped by `fetchFeed` 136–144 (null on any failure → degraded) |
| Feed consumption in `poll()` | `idle.ts:69`–`111` — newest-first; **first NON-EXEMPT entry** = `last_activity` (97–104); all-exempt feed → keep previous `lastActivity` (comment 92–96); fetch failure → keep last-known + `degraded=true` (77–84); empty feed → keep last-known (106–107) |
| **Exemption predicate ("iff and only if the client currently holds an active lease")** | Exact site: `idle.ts:97` — `entries.find((x) => !exemptIps.has(srcKey(x.src)))`, where `exemptIps` is built by `activeLeaseExemptIps(leases, now)` at **`idle.ts:169`–`178`**: `l.status === 'active' && l.expires_at > now` → `srcKey(l.exempt_ip)`. The set is fed in by the arbiter each tick (`arbiter.ts:360`), keeping the detector a pure function of `(entries, exemptIps, now)` (invariant documented `idle.ts:20`–`25`). `srcKey` (bare-IP normalization, both `ip:x.x.x.x` and bare formats) at 153–157; `exempt_ip` is captured from the client's observed IP **at grant time** (`arbiter.ts:333`, `types.ts:197`–`198`) |
| Second signal (log mtime) | `idle.ts:71` (NInfer `req-*.jsonl` mtime every 5s while decoding); verdict fusion `signal()` 114–127 — `idle = !degraded && idleFor >= idle_seconds*1000` at 117, `idle_for = now − max(last_activity, last_log_write)` at 115 |
| **How a held session's traffic interacts (decision note, not a fix)** | The detector is **IP-keyed, not process/session-keyed**. (a) A box holding an **active lease**: all its feed entries are exempt (175/97) — an interactive session running on that box is INVISIBLE to the arbiter; its traffic can't set `last_activity`, can't block idle, and can't preempt (preemption at `arbiter.ts:393–398` only ever sees the non-exempt `last_activity`). (b) A box with NO lease: session traffic is foreign → counts as `last_activity` → system not idle → grants blocked (`not_idle`), and if it post-dates a grant it preempts (393–398). So today the exemption granularity is "lease on that IP" and a session either (i) co-owns an exempted IP (its traffic never gates anything) or (ii) behaves exactly like interactive llama-swap traffic. A session-aware version would need the exemption set keyed per-session (new field on the lease or a parallel `state.sessions` row with its own `srcKey`) rather than per-lease. |

### 5. Dashboard panel structure (`server/public/index.html`, 1480 lines, hand-written, inline JS OUTSIDE tsc)

Sections in `<main>` (all rendered by the single 5s `refresh()`):

| Section / panel | DOM lines | Render path (inline JS) | State payload fields read |
|---|---|---|---|
| Inference servers | `<section>` **270–274** (h2 271, `#add-server-form` 272, `#servers` 273) | `srvBlock(s, st)` **409**; called from `refresh()` at 683–688 | `st.servers[]` (row shape: `serverView` `api.ts:174`–`182`: `url/activity_path/models/peers` + `watched` + live `signal` + per-model `running`/`queued`) |
| Projects (running jobs, budget bar, workers+stats, gates, exception notes) | `<section>` **276–279** (`#projects` 278) | `workBlock(p, st)` **491**–~624 (running jobs 517–533, budget bar 535–538, worker rows 544–574, "not running" notes 576–581); `refresh()` 690–715 (client_id/override joined onto workers at 698–704) | `st.projects[]` (`projectView` `api.ts:56`–`121`: `budget_today` 96, `scheduling` effective+global knobs 102–116, `workers`, `today`, `paused`), `st.active_leases` (518), `st.clients` (override/version join), `st.now` |
| Throttled jobs (exception-only, hidden while empty) | `<section id="throttled-section">` **284–287** | inline in `refresh()` **717–737** (display toggle 723/725) | `st.throttled_jobs[]` (`api.ts:516`) |
| Queue search (static input, read-only client-side filter) | `<section id="queue-search-section">` **296–301** | `renderQueueSearch()` **870**; input is static DOM so mid-type survives the 5s rebuild (comment 289–295) | `st.projects[].workers[].queue_preview` (published by clients, sanitized `api.ts:235`–`252`) |
| Queue detail page `/[project]/[worker]/queue` (SAME file; CSS view switch `body.queuepage` **242–244**, class set **793–794**) | `<section id="queue-section">` **309–312** | `renderQueuePage(st)` **796**; route detection `QUEUE_PAGE` IIFE 787–791; server routes `GET /` and `GET /:project/:worker/queue` both serve this file (`api.ts:527`–`541`) | same `/api/state` payload (queue preview) |
| Logs tray (bottom, tabs Events/Leases — not a `<section>`) | **317–348** (tabs 336–339, limit combo 340–345) | tab wiring **934–946**; events table 739–749; leases table 751–772; tray expand 928–933 | `st.events[]` (`api.ts:519`), `st.leases[]` (`api.ts:508`, `recentLeases` `arbiter.ts:782`) |
| Header status + engine gate | header **~245–262** (`#gate`, `#gate-token-hint`) | `setStatus` 625, `liveStatus` 637 (priority: degraded / running-idle-tasks / idle / busy, 632–636), `syncGateOptions` 994, `setOverride` 1016 (POST `/api/clients/:id/override` at 1032), `setProjectPaused` 1052 (POST at 1064), `settingsPost` 1260 | `st.idle.*` (shape `api.ts:497`–`507`), `st.active_leases` |

Auto-refresh plumbing: `async function refresh()` **641** — fetch `GET /api/state?limit=<logs-limit>` **649** (anonymous-allowed path, `api.ts:193`–`209`); stands down while a settings form is open (645); queuepage early-return 670–673; `setInterval(refresh, 5000)` **1477**. Full payload shape: `api.ts:495`–`520` (`now, idle, leases, active_leases, clients(+override), throttled_jobs, projects, servers, events`).

**Where a Sessions panel slots in:** new `<section>` after the Projects section (after L279, before `#throttled-section`) with a `#sessions` container; render function called from `refresh()` after the projects block (~715) reading a new `st.sessions` field (added in the `/api/state` body, `api.ts:512`–`517` region); auto-refresh + queuepage hiding come for free (the queuepage CSS rule at 244 whitelists only `#queue-section`/`#queue-search-section`, so a new section is automatically hidden on the queue page); interactive controls would reuse the token-gated `settingsPost` pattern (1260) / gate-token storage (982–1008). No new server route needed if the data rides on `/api/state` (client-published pattern, like `queue_preview`/`stats`); a pause/force action per session would need a seam-2-style route.

### 6. Menubar (`menubar/IdlefillMenubar.swift`, 2665 lines)

| What | Where |
|---|---|
| Poll endpoint + interval | `poll()` **733–757** — single call: `GET {server_url}/api/state` with `Authorization: Bearer <token>` (742–744, 5s timeout); 401 → `.unauthorized` (748–753, distinct from dead server); missing token → `.noToken` (734–741). Driven by `Timer.scheduledTimer(10s)` at **609–613** (+ immediate first `poll()` 613) |
| Payload projection | `apply(data)` **770–788** → pure `ScopeView.project(payload:configName:selectedMachine:selectedProject:nowMs:)` at **350** (doc 340–349: inputs = raw payload dict, config's `client_name`, picked machine key, picked project key, nowMs) → `applyProjection` **793**–854+ |
| What `project()` reads | `payload["clients"]` **355** → `ScopeClient{id, name, lastSeen, projectNames, overrideLabel, queueTotal}` (356–366; struct ~207–216, `overrideLabel` 214); `payload["projects"]` **367** → `ScopeProject` (struct 237+); machine options + online = `lastSeen < 90_000` **373–378**; `ScopeLease` rows (jobId/project/expiresAt) **514–520** (struct 219–223) filtered to the picked machine (514); queue preview rows `ScopeQueueRow` (struct 227–230); budget rows (`tokensOut`/`cap`) + today's `finished`/`failed` |
| Model application | `applyProjection` 793–854: `machines`/`projectKey`/`queueDepth`/`today`/`leases`/`queuePreview` 797–807; budget row 811–820; liveness split: `daemonRunning` = LOCAL name-matched row's `last_seen < 90s` (821–841, drives Start/Stop row — `actionRow` at 2373), scope staleness = picked machine's `last_seen` (842–854). Lease one-liner rendering: `leaseRow` **2456** |
| Control scope (context) | header comment **L25–27**: the menubar only drives EXISTING routes (project pause `POST /api/projects/:name`, grant knobs) — its data surface is 100% the `/api/state` projection |

**Where a sessions one-liner hangs:** a sessions fact rides in on `GET /api/state` (no new endpoint) → add a read in `ScopeView.project` (alongside the `payload["clients"]`/`payload["projects"]` reads at 355/367), a new `@Published` in the model next to `leases` (555), and one line in the panel body next to `leaseRow` (2456). `applyProjection` (793) is the single write site; `daemonRunning` (841) is the liveness precedent if the session needs its own 90s window.

---

## Forgejo capability (tracker)

Source: public `https://git.samwarth.com/swagger.v1.json` (OpenAPI 2.0, 314 paths — gitea 1.22 core). Token from `~/.hermes/profiles/pr-agent/.env` read into a variable only (never printed; not needed — the swagger is public). GET-only, script-based. Full spec cached at `scratch/forgejo-swagger.json`.

### Native issue blocking: YES

Two endpoint families exist (path keys contain `dependen`/`block`):

- `/repos/{owner}/{repo}/issues/{index}/blocks` — GET `issueListBlocks` ("List issues that are blocked by this issue"), POST `issueCreateIssueBlocking` ("Block the issue given in the body by the issue in path"), DELETE `issueRemoveIssueBlocking`; responses 201/404 (POST)
- `/repos/{owner}/{repo}/issues/{index}/dependencies` — GET `issueListIssueDependencies` ("all issues that block this issue"), POST `issueCreateIssueDependencies` ("Make the issue in the url depend on the issue in the form"), DELETE `issueRemoveIssueDependencies`; responses 201/404/423 (POST)

POST/DELETE body schema for both is `IssueMeta {index: integer, owner: string, repo: string}` — i.e. the body carries the OTHER issue's number (`index`); `owner`/`repo` are (redundant per swagger) path mirrors. Semantics: `POST .../{A}/blocks` = "A blocks body.issue" (equivalently body.issue is blocked by A); `POST .../{A}/dependencies` = "A depends on body.issue" — same edge, two verbs (blocks/dependencies are the two directions of one relation).

### Label create route: YES

- `GET /repos/{owner}/{repo}/labels` — `issueListLabels` (query: `sort`, `page`, `limit`), returns `Label {id, name, color, description, exclusive, is_archived, url}`
- `POST /repos/{owner}/{repo}/labels` — `issueCreateLabel`, body `CreateLabelOption {name, color, description?, exclusive?, is_archived?}`, **required: `name` + `color`** → 201/404/422
- Also present: `GET/PATCH/DELETE /repos/{owner}/{repo}/labels/{id}` (by numeric id, NOT by name) and per-issue assignment `POST /repos/{owner}/{repo}/issues/{index}/labels` (`issueAddLabel`, body `IssueLabelsOption {labels: [label_id-or-name], updated_at?}`)

### Issue create/patch shapes (confirmed)

- `POST /repos/{owner}/{repo}/issues` — body `CreateIssueOption`, **required: `title`**; optional `assignee, assignees, body, closed, due_date, labels, milestone, ref` → 201/403/404/412/422/423
- `PATCH /repos/{owner}/{repo}/issues/{index}` — body `EditIssueOption`: `title, state, body, assignee, assignees, milestone, due_date, ref, unset_due_date, updated_at` (optimistic lock) → 201/403/404/412

### Gotchas

1. **`EditIssueOption` has NO `labels` field** — label changes go exclusively through `/issues/{index}/labels` (POST/PUT/DELETE), never the PATCH body.
2. Label mutation routes are **by numeric `{id}`**, not by name — to remove a specific label you must first `GET /labels` and match by name (swagger shows no by-name GET).
3. `POST /dependencies` can return **423** (listed in swagger; presumably locked-state) — handle it; `POST /blocks` only 201/404.
4. This is OpenAPI **2.0** swagger: body refs like `IssueMeta`/`CreateLabelOption` are in `definitions`; `{index}` path params are issue NUMBERS (int), while the `Issue` response carries both `id` (db id) and `number`.
5. Whether the Forgejo **UI renders** native dependencies (blocking badge) on v15/1.22 was not verified from swagger — worth one manual check before deciding to drop the body convention.

### Answer for issue #9

- **Native blocking: available** (both `/blocks` and `/dependencies` verbs, create/list/remove).
- **Label create: available** (`POST /labels`, `{name, color}` required).
- Decision input: the "Blocked by" **body-line convention can now be backed (or replaced) by native dependency edges** — e.g. keep body lines as human/agent-readable text while the tracker shows real blocking relations; if the UI does not surface them (gotcha 5), the body line stays the source of truth.
