# Fleet hierarchy — the target resource tree (proposal, 2026-10-12)

Status: **PROPOSED** — D1..D6 await the owner. Written from the owner's
sketched tree (2026-10-12) with two owner decisions already in force for
this round:

- **Fleet root = mesh-aggregated.** The fleet service stays identity-only
  (`docs/architecture/fleet-service.md` hard boundary, unchanged); the
  fleet tree is COMPOSED at the view layer from local state + peer
  snapshots, not stored in a registry.
- **M4 and DGX-Spark_Tyler are OUT of this round.** The tree models only
  machines that actually exist on the mesh today (mac-sam, urza). The
  shape must not preclude them later, but nothing here onboards them.

Verified against HEAD `68d1c6e`.

Review round (2026-10-12): owner comments applied — the fleet tier is a
**Global Projects** section with per-machine Projects as machine children;
aliases carry advertised capabilities (the #87-plane `ProbedModel` facts,
live-probed); the container ask (logs/exec/deploy under a machine-settings
gate) is reported-only in this wave and the ops plane is filed as
**issue #87**. (Note: the "issue #87" cited by `model-capabilities.md` was
never filed on Forgejo — the live issue #87 is the container ops plane.)

## The owner's tree (as sketched)

```
Fleet (Sam)
├── Machine(s)
│   ├── This machine (M1)
│   │   ├── Agent(s) → runtime (Hermes) → profiles (default, web-dev, …)
│   │   ├── Inference Engines (oMLX, …)
│   │   ├── Docker Containers / Services (supabase dev, …)
│   │   ├── System Resources (CPU, GPU, RAM)
│   │   └── Machine-specific Settings
│   ├── Urza (mesh)
│   └── (planned: M4, DGX-Spark_Tyler — out of scope)
├── Projects
├── Model Aliases
└── Settings
```

## The tree as it exists today, filled in

```
FLEET (label only — fleet_id; this instance not enrolled)
├── MACHINES
│   ├── mac-sam  [m-99fdd154dd20 / client c-9b8779db]        ✔ first-class local
│   │   ├── Agents        ✔ 14 Hermes profiles (agent_roster, types.ts:519)
│   │   │                    adopted: accounting-agent, flash, hypnotist, web-dev
│   │   │                    external: business-agent, career-ops, hardware-agent,
│   │   │                              m365-admin, pr-agent, realestate-agent,
│   │   │                              tauri-dev, web-dev-orca · unset: f360, probe
│   │   ├── Engines       ✔ srv-watched oMLX (probed model list lives on the row)
│   │   ├── Projects      ✔ career-ops PAUSED · 500k/day · depth 445
│   │   │                    (client-reported allocation + arbiter
│   │   │                    ProjectConfig/ProjectStateRow — the machine's own truth)
│   │   ├── Containers    ✘ no such resource kind (visibility+ops plane filed as #87)
│   │   ├── SysRes        ~ HostStats: load1/5/15, cpus, mem total/free, uptime
│   │   │                    (server/src/host.ts:24; /api/state `host`,
│   │   │                    dashboard/src/lib/api.ts:407) — GPU deliberately absent
│   │   └── Settings      ✔ config.json per instance + state overrides (theme, caps)
│   └── urza  [m-d6d72403a67f]                               ✔ mesh peer, i_control
│       ├── Agents        ✘ NOT in the peer snapshot (see D4 gap)
│       ├── Engines       ✔ reference rows here: strata-urza (srv-45abb4e8),
│       │                    llama-swap-urza (srv-73de04cd) — owned by urza's
│       │                    arbiter (mesh.md rule 1); engine group "urza" ties
│       │                    them to one host, max_concurrent 1
│       ├── Projects      ~ snapshot carries queue_depth ONLY — peer project
│       │                    names are not published today (D4 ADD key)
│       ├── Containers    ✘ (→ #87)
│       ├── SysRes        ~ MeshPeerSnapshot.host (same HostStats shape,
│       │                    api.ts:426) — coarse counters already ride the snapshot
│       └── Settings      ~ urza's own config.json; not visible from here
├── GLOBAL PROJECTS  (gathered across machines)                ✔ local truth; the
│   ├── career-ops  PAUSED · 500k/day cap · depth 445             cross-machine gather
│   └── urza: queue_depth only today — names need the D4 ADD key  needs D4/S2
├── MODEL ALIASES  (advertised capabilities ride the catalog — ProbedModel, the
│   │                model-capabilities.md #87 plane; live-probed 2026-10-12)
│   ├── Qwen3.8-Flash-Next → strata-urza:iq3_s | strata-scanbot:q2_0 (pinned scanbot)
│   │     winner q2_0: ctx 262144 · in: text+image · out: text — scanbot now
│   │     advertises vision — the engine-side mmproj fix noted in model-capabilities.md
│   │     has landed since that doc's verification
│   └── Qwen3.8-27B        → llama-swap-urza:Qwen3.8-27B       ✔ already fleet-wide
│         declared, not probed — declared rows NEVER gain capability keys (#87 D1)
└── SETTINGS (fleet-scoped)                                    ✘ local-only today
```

## What the sketch already matches (no change needed)

The sketch is closer to the shipped model than it looks:

1. **Machine = instance.** "One idlefill instance per machine" is the mesh
   spine (`docs/architecture/mesh.md`); `instance_id` is the identity, IPs
   move. Peers render as machine rows with an online/stale verdict
   (`api.ts:444-458`, `PEER_STALE_MS = 90_000`). "Urza (mesh)" is exactly
   a `MeshPeer` row + the local edge (`i_control`, `server/src/edges.ts`).
2. **Agents are already children of a machine.** `agent_roster` rides the
   `ClientRecord` (`server/src/types.ts:519,601`); Hermes is today's only
   runtime, so the sketch's "Hermes →" level is the roster itself.
3. **Engines are already children of a machine, by ownership rule.** Grant
   admission is exclusive to the OWNING machine's arbiter (mesh.md rule 1);
   reference rows on a viewer are display/routing only. The engine group
   named `urza` already encodes host co-location.
4. **System Resources are half-built on purpose.** `HostStats`
   (`server/src/host.ts:24-36`) carries load/CPU-count/RAM/uptime for the
   local machine AND rides every peer snapshot. GPU is deliberately NOT a
   host counter — the util/VRAM/power truth rides the engine load axis
   (host.ts header comment; owner ask 2026-10-11).
5. **Aliases are already fleet-wide.** `ModelAlias` pairs reference
   `server_id`s across machines; `pinned_server_id` is a fleet-level
   routing decision (`types.ts:1159`).
6. **Projects exist at BOTH tiers the sketch implies.** Each machine
   holds its own project truth as a machine child (config + client-
   reported allocation — `projectView`'s join). The fleet-level **Global
   Projects** section is the gathering of those truths; the per-machine
   half is already built, the cross-machine naming rides D4. Each machine
   keeps its own project truth (mesh.md D4 defers any shared-project
   concept); the fleet tier is an aggregation.

## Gaps against the sketch

| Sketch node | Today | Gap |
|---|---|---|
| Fleet root | label (`fleet_id`); no fleet-level aggregate view composed as a tree | view-layer composition only (D1) |
| Peer Agents | roster exists on urza's arbiter, not in `/api/mesh` snapshot fields (`mesh.ts:124`, `api.ts:417-427`) | snapshot ADD key (D4/S2) |
| Peer Projects | snapshot carries `queue_depth` only — no peer project names/pause state | snapshot ADD key (D4/S2) |
| Containers/services | nothing — no resource kind anywhere | settings-gated client-reported rows (D5/S3); logs/exec/deploy ops plane filed as issue #87 |
| GPU as machine child | rejected design (engine axis owns GPU truth, host.ts:7-10) | keep rejected unless owner reverses (D6) |
| Machine-specific Settings | per-instance config.json; no cross-machine settings surface | stays local; fleet Settings deferred (D7) |
| Fleet Settings | theme + caps in local state/config only | same as above |

## Decisions

### D1 — The fleet root is a VIEW, not a store — PROPOSED

The tree is composed at the dashboard from `StateSnapshot` keys that
already exist: `clients`, `servers`, `model_aliases`, `projects`,
`engine_groups`, `mesh.peers`, `host`. This follows mesh.md D3 ("local
machine first-class, peers read-only snapshot rows") and the fleet-service
boundary (no fleet-side state store). No arbiter learns the whole tree;
each composes its own copy of the view from what it can see.

Rejected: promoting the fleet service into a machine/engine/agent registry
— it is identity-only by locked design, and mesh-aggregation was the
owner's call (2026-10-12).

### D2 — Machine node identity and facets — PROPOSED

A machine node keys on `instance_id` (identity; addresses move). Three
facets render from existing data:

- **This machine** — local client row + `host` block + local settings.
- **Mesh peer** — ephemeral snapshot + edge role (`i_control` /
  `controls_me`), online/stale verdict.
- **Planned** — a future third facet for machines not yet paired (M4,
  DGX-Spark_Tyler). NOT built this round; the tree shape must tolerate a
  machine with no snapshot (already true for stale peers).

### D3 — Children are joined in the view, no FK re-shape — PROPOSED

Do not restructure `state.json` into nested machine objects. The
existing flat collections already carry the parent keys:

- agents → `ClientRecord` (client == machine)
- engines → ownership rule (owning arbiter) + reference rows carry the
  peer's `instance_id` context; engine groups name hosts
- projects → worker membership is already a computed join
  (`projectView`, `server/src/api.ts:105-201`)

ADD-key discipline holds: the tree is a read-side projection, so no
migration, no renames, old state files untouched.

### D4 — Peer agents AND peer projects ride the mesh snapshot (ADD keys) — PROPOSED

Add `agent_roster` to `MeshSnapshot` — coarse: `{ profile, posture,
provider }` only; no base_url, no key material. Add `projects` — coarse:
`{ name, paused?, queue_depth }` — never job ids/titles/payloads (the
mesh.md never-carries rule), so the fleet-level **Global Projects**
section can name every machine's projects, not just sum depths. Same
sanitize-per-key discipline as `sanitizeHostStats` (`server/src/host.ts:68`)
/ `sanitizeSnapshot` (`mesh.ts:1018`). Privacy posture preserved: #39's
"coarse-by-construction" boundary — an agent profile name or project name
is presence information, like a session count. Privacy inversion (an
operator who does not want roster/project sharing) is an opt-out config
key, default OFF (share), matching the existing snapshot tolerance style:
absent key = older build, never a fake empty.

### D5 — Containers/services: settings-gated reporting now; ops plane is issue #87 — PROPOSED

New `ClientRecord.containers?: ContainerRow[]` — the client daemon (same
process that already scans Hermes jobs/profiles) reports coarse rows:
`{ name, image, state, ports?: number[] }`. Gated by a per-machine
settings key, **default OFF** — the scan (and the surfaces it feeds) only
runs when the operator enables it on that machine (owner ask, 2026-10-12
review). Heartbeat-published like `projects`/`hermes_jobs`
(`types.ts:559` precedent); the arbiter stores echoes verbatim. NOT added
to the mesh snapshot in this wave (containers are richer detail;
cross-machine need is unproven — add it to the snapshot only when a
consumer exists). Dashboard shows the card under the machine node for the
local machine only.

The fuller ask from the same review — **see container logs, execute
commands, deploy containers**, all under the machine-settings gate — is a
control/ops plane, not a read plane, and is deliberately NOT designed
here: filed as **issue #87** for a future grilling (auth plane, exec
safety vs mesh.md rule 3, log-streaming channel, deploy semantics).

### D6 — System Resources: keep the existing split — PROPOSED

Machine node shows CPU (load vs cpu count), RAM (total/free MemBar — the
`ramAxis` rule already exists in `lib/fleet-stats.ts`), and uptime, from
`host` locally and `snapshot.host` for peers. GPU stays on the engine
rows (the engine's own /metrics reports util/VRAM/power from a better
vantage than a host nvidia-smi probe). Do NOT add a host-level GPU
counter unless the owner reverses the 2026-10-11 decision.

### D7 — Fleet-scoped Settings: deferred — PROPOSED

Settings stay per-machine (config.json + local state overrides). A
fleet-settings tier needs a real fleet-scoped store — that is the fleet
service's future control-plane seed (`fleet-service.md`, "Why outside
this repo") and its D7 urza deployment is still unbuilt. The dashboard
Settings card stays under the This-machine node. Nothing in this wave
blocks a later fleet-settings plane.

## Migration path (each slice ships green on its own)

1. **S1 — dashboard IA only.** Compose the fleet tree (fleet → machines
   → per-machine children incl. per-machine Projects + a fleet-level
   Global Projects section and Aliases cards) from existing
   `StateSnapshot` keys. Zero server changes. Retires nothing; the
   current Resources tab sections become tree children.
2. **S2 — peer agents + peer projects in the mesh snapshot.** Arbiter ADD
   keys on `/api/mesh` + sanitize on read + dashboard child lists under
   peer machine nodes + Global Projects names every machine. Wire
   back-compat both directions (old arbiter ↔ new).
3. **S3 — containers (reporting only).** Settings-gated client scan +
   `ClientRecord` ADD key + machine node card. Client/arbiter
   back-compat (old client: key absent, card hidden).
4. **S3b — container ops plane (logs, exec, deploy).** NOT in this wave —
   grilling lives in issue #87.
5. **S4 — fleet settings plane.** BLOCKED on fleet-service D7 deploy;
   not in this wave.

## Explicitly out of scope / rejected

- Fleet service as a machines/engines/agents registry (owner chose
  mesh-aggregation; identity-only boundary is LOCKED in fleet-service.md).
- Onboarding M4 / DGX-Spark_Tyler (owner, 2026-10-12). The shape
  tolerates them later via the Planned facet (D2).
- Cross-machine writes, config push, or centralized settings application
  — violates mesh.md rule 3 ("state is published, never computed
  remotely").
- Work portability / shared-project concept — already deferred by
  mesh.md D4; the tree does not prejudge it.
- Container ops plane (logs, exec, deploy) — filed as issue #87, not
  designed in this doc.
