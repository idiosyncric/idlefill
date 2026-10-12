# :8800 default-target fence — the D2 client router fence (build report, 2026-10-12)

Design authority: `docs/architecture/alias-stability-and-slow-engines.md`
D2 (LOCKED, owner 2026-10-12) — worker C's client half of the
"alias stability and slow engines" wave. This slice NARROWS
`aggregate-endpoint.md` D6 ("unknown/absent model → `llm_target`"): a name
the router has EVER seen published in a `model_aliases` block is no longer
"absent". Server-side D1 (cold-start publish seeding) is the companion
worker's slice — untouched here.

## The incident, in one line

Arbiter SIGTERM'd ~5h, cold-started at 13:09:32 and published
`model_aliases: []` for its first ~15s; the client's
`updateAliases(st.model_aliases ?? [])` CLEARED the router's alias map, and
the next `Qwen3.8-Flash-Next` request fell through to `llm_target`
(oMLX :8000) with the agent key STRIPPED (#68) → `401 "API key required"`
from an unrelated engine (logs 12:55:11 & 13:11:43 EDT, sessions
a0f1fdb0 / 20261012_131104_c4f89f).

## Before → after around the incident

| step | before (this morning) | after (this commit) |
| --- | --- | --- |
| arbiter cold start publishes `model_aliases: []` | `updateAliases([])` clears the alias map — AND forgets the names ever existed | map still clears (no stale pin, unchanged); the monotonic `configuredAliasNames` set keeps every EVER-accepted name for the process lifetime |
| POST `/v1/chat/completions` naming `Qwen3.8-Flash-Next` | no map entry → `forwardFor` default-target fallback → llm_target :8000, agent key stripped by the #68 posture → `401 {"error":{"message":"API key required",…}}` from oMLX | name in `configuredAliasNames`, resolves in NEITHER map → LOCAL `503`, content-type `application/json`, body below — fired BEFORE the gate (no slot, no park, no registration), before `onSessionRoute`, and with ZERO bytes to any upstream (fake llm_target recorded 0 requests / 0 bytes in the regression test) |
| same name with a bare catalog row standing | routes to that row | routes to that row — UNCHANGED (the fence fires only when neither map resolves) |
| genuinely unknown name | falls to `llm_target`, body untouched | byte-for-byte unchanged (D6 stands for unknown names) |
| next poll republishes the healthy block | routes normally | routes normally — the fence memory never poisons a live block |
| GET `/v1/models` with the empty block | `{"object":"list","data":[]}` | unchanged |
| GET/DELETE/HEAD passthrough (no model) | default target, ungated | unchanged |

The fence body, byte-exact (OpenAI-style, `error.model` echoed):

```json
{"error":{"message":"model \"<name>\" is configured on this machine but no engine currently serves it","type":"model_unavailable","code":"model_unavailable","model":"<name>"}}
```

## What landed

**`client/src/aggregate.ts`** — inside `startAggregateRouter`'s closure:

- `const configuredAliasNames = new Set<string>()` — process-lifetime,
  MONOTONIC: `updateAliases` adds the name of every entry it ACCEPTS into
  the routing map (malformed entries drop and are never named — the same
  defensive posture as before); nothing ever removes a name. The empty /
  absent block clears `aliases`/`aliasByName` exactly as before.
- `dispatch(model)` — after `entry = alias ?? catalog`: if
  `model && !entry && configuredAliasNames.has(model)` → the 503 above and
  `return`. That single seam covers BOTH the gated path (fires before
  `gate.route` — no slot consumed) and the gate-off / no-identity fallback
  (fires before `forwardFor`), plus it precedes `onSessionRoute` so no
  register heartbeat rides a fenced request. A one-line local log names
  the fence (`aggregate: fence <name> … 503 model_unavailable`) — no
  upstream is involved.
- No new config keys, no interface changes, no touched seams
  (`agentAuthOk`, gate, pins, splice, buffered forward, key plane all
  ride byte-for-byte).

**`docs/architecture/aggregate-endpoint.md`** — a dated "The D6
fall-through NARROWED" section documenting the narrowed posture in the
doc where D6 lives (the alias-stability doc says D2 narrows it; the
narrowing is recorded beside the decision it narrows).

## Tests

Real sockets, the existing harness shapes (aggregate.test.ts's
echo/recording `startEngine` + the REAL `SessionGate`; aliases.test.ts's
byte-recording `startEcho`):

- **6 new tests** in `client/test/aggregate.test.ts` (the incident name
  `Qwen3.8-Flash-Next`):
  1. (a) one alias fed → `updateAliases([])` → POST naming it → `503` with
     the EXACT body (`error.model` echoed), llm_target hits = 0 AND
     received bytes = 0, alias engine hits = 0, no `onSessionRoute`;
  2. fence BEFORE the gate: gated router, `registered` stays empty,
     `queueDepth` 0 (no slot consumed), zero upstream bytes;
  3. (b) unknown name + empty published block → default target, body
     forwarded untouched (today's posture);
  4. (c) alias map cleared but a bare catalog row of the same name → that
     row serves it (not fenced, not default);
  5. (d) after a 503, a republished block restores normal routing — with
     the #66 splice standing (the fence never poisons a healthy block);
  6. (e) `GET /v1/models` with the empty published block still answers
     the empty list (the fence does not resurrect the list, no probe).
- **1 rewritten test** in `client/test/aliases.test.ts` — the old
  "#66 D6 fence: cleared aliases fall to the default target" pinned the
  pre-D2 posture this decision replaces; it now asserts the narrowed
  fence: unknown name → default untouched (bytes forwarded), CLEARED
  alias name → 503 `model_unavailable` (full body asserted), default
  target saw exactly ONE request (the unknown name), never the fenced
  one. The chunk-boundary parity test (sniff miss → model `undefined`)
  still falls to the default — the fence requires a SNIFFED name, so that
  documented parity is untouched.

| suite | before | after |
| --- | --- | --- |
| repo (`npm run test`, all workspaces) | 959/959 | **965/965** |
| client (`client/test`) | 256/256 | **262/262** (+6) |
| `npx tsc --noEmit` (client) | green | green |
| `npm run build` (repo) | green | green |

## Honesty limit (documented, not fixed — D2's own words)

The fence can only fence what the process has SEEN: a client cold-started
during a publish gap never received the alias names, so `configuredAliasNames`
is empty for them and their requests keep today's `llm_target`
fall-through. That window is closed SERVER-side by D1 (the arbiter seeds
the publish block at load — `modelAliases()` never returns an empty array
while stored config is non-empty) — not by this slice, by design.

## Deviations from the brief

None functional. One addition within scope: the fence answers also emit a
one-line router log line (local observability, zero bytes upstream, no
behavior). The first full-repo baseline run under-reported the server
workspace (440 vs the true 482 — a cold-cache `--test-force-exit`
reporting artifact); the 959 baseline above is the re-verified number,
consistent with HEAD's own commit message.
