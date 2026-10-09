# Engine health routing and mutual exclusion groups

The owner ask (2026-10-08, direct brief): (1) engines on the same host must
be settable as mutually exclusive (the live case: strata on urza and
llama-swap on urza). (2) Before a request routes to an engine that is not
green, it routes to the next best option. The urza upgrade later removes
the specific contention. The capability stays.

Companion to `docs/architecture/model-aliases.md` (LOCKED — this doc
amends, never restates) and `docs/architecture/aggregate-endpoint.md`
(LOCKED). Citations re-verified against HEAD `7511ce7` on 2026-10-08.
Status: LOCKED by the owner 2026-10-08 (the three questions in the
Decisions block are settled). The build wave is dispatched from this doc.
BUILT 2026-10-08: server chain + engaged + group cap + group write route,
the `fallback` ADD key, the D5 display (both views), and the suite
(`server/test/engine-groups.test.ts`) are in and verified — full suite
green, tsc green, build green, plus a live HTTP proof (scratch arbiter)
of the step-2 re-route (dead pin → next-best probed row, `fallback:
true`) and the group routes (create, one-row-per-group 400, unknown
delete 404).

## The gap, re-verified against the code and the live fleet

- Winner selection is one line: `const winner = survivors.find((p) =>
  p.server_id === pin) ?? survivors[0]!` (`server/src/arbiter.ts:1059`,
  inside `buildAliasBlock`). A "survivor" is a pair on a row whose probe
  FAILED (publishes `catalog_source: 'declared'`) or whose probe SUCCEEDED
  and lists the model (`'probed'`). A dead engine therefore stays a
  legitimate winner. If it is the pinned winner, traffic routes to it and
  dies there.
- The probe fetcher treats any non-2xx as failure
  (`server/src/catalog.ts:92`: `if (!res.ok) throw`), and a failure keeps
  the row's declared list publishable (the D2 merge rule in
  `model-aliases.md`, UNCHANGED and REUSED). So "the probe failed" is
  already a stored, per-tick, per-row fact: `probed` absent vs present
  (`server/src/arbiter.ts:2157-2164`, `probedModels` / `probedAt`).
- The probe cycle runs on the arbiter's own tick, the same tick that
  publishes `catalog` + `model_aliases` (`server/src/index.ts:251-258`).
  The router pulls it every 20 s (`client/src/index.ts:1469-1474`). No
  new probe and no new channel are needed to route on probe health.
- The dashboard's "green" is the IDLE word, not a liveness word
  (`dashboard/src/lib/format.ts:37-43`: `liveWord` returns tone `ok`
  ("Idle") when the idle verdict says idle and not degraded). The idle
  verdict measures activity. A dead engine with a stale or absent feed can
  read idle. The word the operator sees on the InferenceServers view is
  the wrong axis for routing.
- The router never computes health. It applies the published resolved
  winner verbatim (`client/src/aggregate.ts:578-579`: alias map wins over
  the catalog, dispatch calls `forwardFor` with the published entry).
- No group concept exists anywhere: a grep for `engine_group`,
  `mutually.exclusive`, `same_host`, `host_group`, `group_id` across
  `server/src` and `client/src` returns zero hits (verified 2026-10-08).
- The arbiter already knows per-engine BUSY from two independent feeds:
  active leases name their engine (`Lease.server_id`,
  (`server/src/types.ts:522-536`, the per-server cap comment at
  `server/src/arbiter.ts:728-730`). Session rows carry the real engine
  row plus the gate state (`active` = the session holds an inference slot,
  `client/src/session-gate.ts:385`, the register heartbeat contract in
  `model-aliases.md` D6 fence, UNCHANGED and REUSED).
- Live proof of the failure mode (2026-10-08, this machine): the
  `Qwen3.8-Flash-Next` alias pins `srv-45abb4e8` (strata on urza,
  `https://strata.samwarth.com`). That engine answers `/v1/models` with
  HTTP 502. The alias publishes the pinned pair with
  `catalog_source: 'declared'` (the probe failed). A Hermes turn routed
  there at 21:41 EDT burned 302 s and 5 auto-recovery cycles on `HTTP
  502: Bad Gateway` before giving up (agent session
  `20261008_214014_eef9f7`, web-dev profile log). The next-best option
  (scanbot, `srv-f1c85327`, probe healthy) was available the whole time
  and was never tried.

## Inherited rules and amendment discipline

From `model-aliases.md` (LOCKED) and `aggregate-endpoint.md` (LOCKED):

1. The arbiter inventories and resolves. The router routes. The alias
   winner rides the published `model_aliases` block on the `/api/state`
   poll (D4 pull posture, UNCHANGED and REUSED). The router never
   recomputes the winner.
2. New wire shapes are ADD keys. The published entry shape
   `{ name, server_id, url, auth_set, engine_model, catalog_source }`
   keeps every field byte-for-byte.
3. Pair confirmation and drop rules (D2 of the predecessor) stand
   UNCHANGED: a vanished pair drops the pair, never the alias. An
   unprobeable row's pairs publish as `declared`.
4. The agent never learns the engine changed (D4/D6 fence): the alias
   name is the stable contract, the body splice is unchanged.

This doc SUPERSEDES exactly one clause of the predecessor's D4: "A dead
pin falls through: pin absent, pin's row gone, or pin's pair unconfirmed
→ first surviving pair wins." That fall-through becomes the
health-ordered chain of D2 below. Nothing else in the predecessor moves.
The `#67` session engine-pin plane (operator pin on a session row,
`session_pins`) is a different plane and stays UNCHANGED: a session pin
resolves at the router's dispatch time, after the alias block, and this
doc's chain never consults it.

## D1 — Health definition: the catalog probe is the green

**LOCKED.** The routing health of a row is its `/v1/models` probe result
from the CURRENT tick. `probed` present = healthy. `probed` absent
(probe returned non-2xx, timed out, or the fetcher never ran) = not
green. No new probe. No new endpoint. The arbiter already runs this
fetch with the row's own token every tick
(`server/src/arbiter.ts:954-981`, `server/src/catalog.ts:87-98`).

The idle word is not a health input. It measures activity on a separate
detector plane. A dead engine can read idle, and an idle engine is a
perfectly fine routing target. The two axes are orthogonal. Conflating
them is the operator-facing confusion this doc closes.

Hysteresis: one failed probe demotes the row for the next tick. One
successful probe re-promotes it. No strike counter, no cooldown state.
The demotion is reversible within one probe cycle (15 s arbiter tick) and
a dead engine stays demoted on its own.

Detection-to-move latency: one arbiter tick (15 s) plus one router poll
(20 s) = at most about 35 s before traffic leaves a newly-dead engine.
LOCKED at the existing pull cadence. Faster reaction needs a push
channel, and the mesh plane has none by rule.

Rejected (a) — route on the dashboard's `liveWord`: wrong axis
(activity, not liveness) and the wrong process (the dashboard renders,
the arbiter decides). Rejected (b) — a separate liveness probe (TCP/TLS
connect or a dedicated health endpoint): a second probe with its own
cadence, timeout, and failure modes that tests a different surface than
the one the chat call uses. The `/v1/models` probe uses the row's real
credential against the real host. A 200 there is the strongest liveness
claim available at zero new cost. Rejected (c) — learn health from
forwarded-response errors (the router reports 5xx back to the arbiter):
inverts the pull model (router→arbiter reporting of engine faults is a
new push direction), needs per-session error attribution (a 400 is a
client fault, not an engine fault), and reacts one full request later
than the probe does.

## D2 — The winner chain: health-ordered fall-through

**LOCKED.** The one-line winner rule (`server/src/arbiter.ts:1059`)
becomes a chain over the surviving pairs, evaluated in this order:

1. The pinned pair, when it survives AND its row is healthy this tick.
   The operator's pin and the healthy engine agree. This is today's
   behavior for the common case.
2. The first non-pinned pair (insertion order) whose row is healthy this
   tick. The pin is dead. Traffic moves to the next-best option in the
   priority the operator entered. This is the fix for the 21:41 case:
   pin strata (502) → chain moves to scanbot (probed).
3. The pinned pair, when it survives but its row is not healthy.
   Every healthy option is gone or none of the non-pinned pairs is
   healthy. The operator's pin still names the engine. The request fails
   there exactly as today (honest degradation, no silent re-pin).
4. The first surviving pair. No pin applies (absent or its pair
   dropped). Today's fall-through, unchanged.

The chain iterates only surviving pairs (the D2 survivor rules of the
predecessor, UNCHANGED). A pair whose row probed but does not list the
model is not a candidate, exactly as today. The chain therefore NEVER
unpublishes an alias that today publishes: when at least one pair
survives (and a probe failure keeps a pair a survivor), the alias still
publishes, now possibly from a different row. The alias still drops only
when no pair survives (a dead row, a hostile key, a dropped pair),
exactly today's condition.

Inserted order is the priority, and the doc's rejected-least-loaded
decision from the predecessor's D4 stands: no load ranking, no
per-request consult. The chain is a fixed order over the operator's
declared pairs, filtered by the arbiter's own per-tick observations.

Published shape: the entry keeps its six fields and gains ONE ADD key:
`fallback: boolean` — true when the published winner is not the stored
pin. The dashboard renders "re-routed from <pin name>" on the Models tab
and a red probe-health dot on the winner row when
`catalog_source: 'declared'` (the key already exists. The dot is
display-only, D5). `fallback` absent on pre-plane entries
(drop-don't-reject, the standard ADD-key posture).

Rejected — the router runs the chain: it would need the per-pair health
and the per-row busy state on the wire (the block bloats), the router
re-implements arbiter policy, and the pin semantics split across two
processes. The mesh rule stands: state is published, never computed
remotely. Rejected — keep the pin and just mark it red: the operator's
request is explicitly that traffic moves to the next best option before
it dies on a non-green engine. A red pin that still routes is the 21:41
incident with a warning label.

## D3 — Mutual exclusion groups (same-host)

**LOCKED, shape.** A top-level ADD key on `ArbiterState`, sibling of
`servers` and `model_aliases`:

```ts
/** One operator-declared engine group (same-host mutual exclusion). */
interface EngineGroup {
  group_id: string;      // stable slug, the sanitizer class of alias names
  name?: string;         // display label
  server_ids: string[];  // member rows. a row belongs to AT MOST one group
  max_concurrent: number // group-wide admission cap. default 1 = exclusive
}
// ArbiterState ADD key:
engine_groups: EngineGroup[];
```

One group per row. Two groups claiming the same row is a write-time 400
(told, not swallowed, the alias write posture). An unknown `server_id` is
a 400. A group with fewer than two members is accepted (a single-member
group is a no-op cap, and it survives a row re-add without a rewrite).
The state loader gains one tolerate-missing-key line (the `session_pins`
pattern, `server/src/state.ts:85`). A group carries no secret.

**LOCKED, semantics.** A row is ENGAGED when the arbiter observes an
active inference on it: an active lease names it
(`Lease.server_id`, `server/src/types.ts:536`) OR a session row points
at it with gate state `active` (the session holds an inference slot,
`client/src/session-gate.ts:385`. `queued` is not engaged — a parked
request consumes no engine slot yet). Both feeds are already stored
arbiter state, published on the same poll.

The chain (D2) gains one filter, applied to steps 1 and 2 only: a
candidate row is eligible only when NO other row in its group is
ENGAGED. Step 3 and step 4 apply the filter NOT at all: when every
healthy option is blocked by an engaged group peer, the pin (or the
first pair) still wins. Mutual exclusion is a preference between live
options, never a veto on the only option. A request that lands on an
engaged row by step 3/4 rides out exactly as today.

Group cap on the lease plane: a grant on a row in group G is admitted
only when the count of ACTIVE LEASES across all rows of G is below the
group's `max_concurrent` (default 1 = at most one background job across
the whole host, which is the mutual exclusion the owner named). The check
joins the existing per-server evaluation
(`server/src/arbiter.ts:704-730`) as one more per-server condition, with
its own denial reason `group_busy`. Without any group the lease path is
byte-for-byte unchanged.

Rejected (a) — a per-row `host_group` string instead of a named group
entity: a per-row knob cannot carry the group-wide `max_concurrent`, and
the cross-row entity rule (the predecessor's D1 rejected option (b))
applies unchanged. Rejected (b) — hard exclusion (one engine in the group
may be probed/healthy at all): the owner's case is resource contention
on one host, not a statement about the other engine's health. A hard
veto kills the fallback the same ask wants. Rejected (c) — the router
enforces the group: the router sees per-session gate state, not leases.
It cannot count group-wide background load. The arbiter can. The arbiter
decides.

## D4 — Where and when the decision lands

**LOCKED.** The arbiter resolves the chain inside the existing
`probeCatalog` cycle (`server/src/arbiter.ts:954-981`), after the probe
map and the per-pair survivor pass exist. `buildAliasBlock` takes the
group + engaged state as inputs (both in-memory arbiter state, no new
poll of anything). The published `model_aliases` block carries the
resolved winner plus the `fallback` ADD key. The router applies it on
its next `/api/state` poll with ZERO code change to its dispatch
(`client/src/aggregate.ts:578-579` keeps its shape: the published entry
is the entry). Propagation delay is the existing poll cadence (≤ 20 s
router side). NO push channel exists or is built (re-verified against
the route table, as the predecessor did).

The `#67` session pin and the D3 group can both be in force at once.
Precedence: the session pin (router-resolved at dispatch time, per
session) beats the alias chain (arbiter-resolved per tick, per model
name). They act on different scopes and neither consults the other.

Rejected — evaluate the chain at request time in the arbiter (a new
per-request API the router calls): a hot-path dependency the pull model
exists to avoid (the predecessor's D4 rejected this for the same reason),
and it moves the decision into the request's critical path where a slow
tick stalls a turn.

## D5 — Authoring and display

**LOCKED, authoring.** The group plane gets the alias authoring posture
end to end: one admin-token write route `POST /api/engine-groups` (the
`POST /api/aliases` family, `server/src/api.ts`), whole-entry
validation, 400 told not swallowed, one `engine_group_updated` event
(the `model_alias_updated` pattern), state saved with the existing 0600
posture. The dashboard surfaces the groups in the InferenceServers view
(the rows that carry `server_id` already render there): a group picker
per row, a group list with `max_concurrent` and member names, and a live
ENGAGED marker per row (lease count + active session count, both already
on `/api/state`).

**LOCKED, display.** The Models tab renders the routing health the
arbiter decided on: the winner row shows a probe-health dot (green =
`catalog_source: 'probed'`, red = `'declared'`) beside the idle word
(the two axes, side by side, so the operator sees which one a routing
decision used). When `fallback` is true, the tab shows "re-routed from
<pin name>" for that alias. The InferenceServers view gains the same
probe dot on each row. The idle word itself is UNCHANGED (it stays the
activity word. This doc adds the liveness word beside it).

Rejected — change `liveWord` to fold in probe health: one word for two
axes hides which one flipped. The operator who watched a dead engine
read "Idle" needs the two words separated, not a new ambiguous word.

## Rules (restated crisp)

1. Routing health = the current tick's `/v1/models` probe result.
   `probed` = green. `probed` absent = not green. One tick demotes, one
   tick re-promotes. The idle word is a separate axis and is not a
   routing input.
2. The alias winner is a chain: healthy pin → healthy first pair (insertion
   order) → pin (any survivor) → first survivor. The chain never
   unpublishes an alias the current rules publish.
3. A group is a named cross-row entity with a `max_concurrent` cap
   (default 1). A row belongs to at most one group. A row is ENGAGED on
   an active lease or an active session. Engaged peers filter chain
   steps 1-2 only. The lease plane gains a group-wide active-lease cap
   with denial reason `group_busy`.
4. The arbiter decides. The router applies. The published block gains
   `fallback` as the only new wire key. No push channel. No per-request
   consult.
5. The session pin (#67) beats the alias chain. It is a different scope
   and neither consults the other.

## What changes vs what stays untouched

Changes (the build wave, after this grill):

- `server/src/types.ts`: `EngineGroup` + `engine_groups` on
  `ArbiterState`. `fallback` on the published alias entry type.
- `server/src/state.ts`: one tolerate-missing-key line for
  `engine_groups`.
- `server/src/arbiter.ts`: the chain inside `buildAliasBlock` (replaces
  the one-line winner rule at 1059), the engaged determination (leases +
  session rows), the group cap in the per-server grant evaluation
  (704-730), the group write route handler.
- `server/src/api.ts`: `fallback` published on the `model_aliases`
  block, `POST /api/engine-groups` admin route, the group + engaged
  counts on the server view (ADD keys).
- `dashboard/src/views/Models.tsx`: probe dot + re-routed badge.
  `dashboard/src/views/InferenceServers.tsx`: probe dot + group picker
  + group list. `dashboard/src/lib/format.ts`: the probe-dot word (the
  idle word stays).
- Suite: chain order (pin dead → first pair. pin healthy → pin. all
  dead → pin or first, today's behavior), group veto (engaged peer
  filters steps 1-2, never 3-4), group cap on grants (`group_busy`),
  hysteresis (one bad tick demotes, one good tick restores), `fallback`
  ADD key present/absent, no-group byte-parity (lease path and alias
  publish identical to today with zero groups).

Untouched (fenced):

- The probe cycle, the D2 merge rules, the D3 body splice, the D5
  authoring posture of the predecessor, the `catalog` block and every
  existing `/api/*` shape (ADD discipline).
- The idle detector plane and `liveWord` semantics.
- The `#67` session pin plane end to end.
- The session gate, the slot cap, the 11435 listener, the machine default
  fallback target (an unknown model still falls to the machine default.
  This chain orders alias pairs only).
- The mesh plane: groups and the health chain are local machine state,
  never federated (the alias rule, extended).
- Tokens stay write-only. A group and a published alias carry no secret.

## Decisions (owner, 2026-10-08)

1. ~~Group scope~~ — LOCKED by the owner: both planes. The group
   filters the alias chain (D2 steps 1-2) and caps the lease plane
   (the D3 group-wide `max_concurrent`). D3 stands as written.
2. ~~`max_concurrent` default 1~~ — LOCKED by the owner: the value is
   configurable per group. Each group carries its own `max_concurrent`
   (the D3 field). Absent = 1 (hard mutual exclusion). The operator
   sets it per group through the D5 write route and the dashboard
   group list. There is no fleet-wide knob.
3. ~~Display taste~~ — LOCKED by the owner: the probe dot lands on
   both the Models and InferenceServers views. The re-routed badge
   lands on the Models tab. D5 display stands as written.
4. The urza upgrade retires the strata/llama-swap group. The group is
   operator state. Deleting it is one API call after the upgrade. No
   action now. Recorded so the follow-up is found.
