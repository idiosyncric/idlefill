# Alias stability & slow engines — D4 dashboard (session→engine edge + re-route) — 2026-10-12

Spec: `docs/architecture/alias-stability-and-slow-engines.md` D4 (LOCKED,
owner 2026-10-12). Worker E of the alias-stability wave, after B (D1),
C (D2) and D (D3) merged. Dashboard plane only:
`dashboard/src/lib/api.ts`, `dashboard/src/views/Models.tsx`,
`dashboard/src/views/Sessions.tsx`, the new pure helper
`dashboard/src/lib/session-edge.ts`, its test file, the regenerated served
bundle (`dashboard/dist`), this report. **Zero server/client/cli change: the
pin API and the pair data are ALL pre-existing routes** —
`GET /api/aliases` (B's markers ride it verbatim) and
`POST /api/sessions/:token/pin` (unchanged since #67).

## What renders where

**Models view (`Models.tsx`)** — pair-marker vocabulary now carries the D1
rename: `mismatch` renders as the chip **"probe says no"** (warn dot, warn
text, the honest tooltip: the row's /v1/models probe SUCCEEDED but its list
lacks this id — an ALERT, not a drop; the alias still publishes degraded);
sanitizer `dropped` keeps its own distinct chip **"dropped (config)"** with
an err dot (hostile id / missing row / blank url — config corruption). A
**`degraded`** chip (the view's existing warn badge vocabulary) sits on the
winner line when the published entry carries `degraded: true` — the winner
is not probe-confirmed this tick. `fallback_targets` renders as secondary
read-only chips in the card footer (`↦ engine / model`, dim pill) — the D3
failover surface, named as such in the title; **no new write surface**.

**api.ts types** — `ServerSignal` gains the `queue_depth?` ADD key (the
D-verified wire truth: serverView SPREADS the load reading into the signal
block, so `servers[].signal.queue_depth` is where the count rides, with
`load_age_s` as its freshness stamp); `ModelAliasEntry` gains `degraded?` +
`fallback_targets?: ModelAliasFallbackTarget[]` (exported
`{server_id,url,engine_model}`); the `AliasRow.pairs[].source` union gains
`"mismatch"`.

**Sessions view (`Sessions.tsx`, rows mode)** — every session row draws its
ENGINE EDGE (`→ engine-name`, the view's existing edge vocabulary; the pin
wins the edge once one stands). The edge carries an exception-only
annotation — `· 2 queued`, `· sample 40s old`, `· degraded`, `· no-signal`
— only when the engine row NAMES a fact (the load-read honesty law: absent
renders nothing, never a fake zero). The flow view's session nodes get the
same labelled edge (no graph library; the engine column already carries the
liveWord posture). The busy/idle word itself stays on the engine rows
(Resources + flow column) — repeating it on every edge would alert on the
normal state of a running session (see deviations).

## The slow heuristic as shipped

Pure helper `engineEdge(session, engineSignal)` (`lib/session-edge.ts`, 8
tests): **slow ⇔ the session's gate state is `active` AND the edge's engine
row shows (fresh `queue_depth > 0` — fresh meaning `load_age_s ≤ 15 s`,
`EDGE_SAMPLE_STALE_S`, D4's "~15s", and queue freshness IS `load_age_s` —
OR `load_age_s > 15 s`, OR posture degraded (`signal.degraded`) /
no-signal (`signal === null` or `no_signal_reason` set)**. Display only:
slow turns the edge warn-toned, names every reason in the tooltip (ages are
honest "at the arbiter's snapshot"), and surfaces the **"re-route…"**
affordance on that row. A queued session on a slow engine still shows the
annotation but NEVER the slow word (the gate must say ACTIVE).

## The pin payload reused (exact, unchanged since #67)

`POST /api/sessions/:token/pin` with body `{ server_id: "<row id>" }`, or
`{ server_id: null }` to clear — `server/src/api.ts:1255`,
`arbiter.setSessionPin` (alias session ⇒ the target must be one of the
alias's pair rows, which is exactly what the chooser lists). The existing
`setSessionPin()` fetch helper posts it; the pin lands through the existing
release-time resolver (`pinnedEntryFor`): queued + next-request traffic
moves, a running stream never does. The chooser shows pairs verbatim from
`GET /api/aliases` (engine rows named, source marker shown — a `mismatch`
pair is still a legal pin target: the pin is the operator's override). No
optimistic state: after the POST the 5s poll shows the row's `engine_pin`.
A session model with NO alias pairs is REFUSED BY NAME in the chooser; the
"clear pin" button appears only when a pin actually stands (the route
supports `server_id: null`).

## Tests

Before: repo 980/980 (per wave brief). After: repo **988/988** green —
dashboard 48 → **56** (+8 `session-edge.test.ts`), every other workspace
byte-for-byte (server 487, client 272, cli 97, adapters 19, shell-ui 3,
fleet 54). `npm run build` green (dist regenerated); `npx tsc --noEmit`
green in `dashboard/`; client types did not move (no client tsc run needed,
the repo build compiles it green).

Byte-for-byte posture: an unpinned session on a healthy engine (signal
present, not degraded, sample fresh, queue absent or 0) gets NO annotation,
no tone change, no button — the row renders exactly as before.

## Deviations from the brief (with justification)

1. **busy/idle posture is not repeated on every edge.** D4 lists
   "busy/queue/age" as edge annotations, but rule 5 (unpinned healthy rows
   byte-for-byte) forbids new chrome on healthy rows, and "active session
   on a busy healthy engine" is the NORMAL state — alerting on it would be
   noise. The posture word lives where the view already draws it (engine
   rows, liveWord vocabulary); the edge annotates exceptions only
   (degraded / no-signal) plus queue and sample age.
2. **Pinned sessions now draw the edge too** (`→ engine`, with the
   operator-pin tooltip). The byte-for-byte guard covers UNPINNED healthy
   rows; D4 says every session row draws its edge, and the pin IS the
   edge's engine.
3. **`signal === null` (a row with no idle detector) counts as the
   no-signal posture** — with an ACTIVE session the freshness of that
   engine cannot be proven, which is precisely D4's alert. The annotation
   says `no-signal`, never a guess.
4. **`dashboard/dist` is committed** with the source change (regenerated
   served bundle) — the established pattern (the arbiter serves dist; every
   prior dashboard commit regenerates it). No other build output, no
   config.json, no pre-existing dirty docs are staged.
