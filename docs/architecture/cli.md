# The idlefill CLI — one operator voice (design, 2026-10-12)

Status: **ACCEPTED** — owner ask 2026-10-12 ("let's plan out a CLI… proceed with
the design doc, file issues for implementation"). D1–D8 below are the design
the owner accepted in-thread; the implementation waves are filed as
**issues #88–#92** (S1–S5). The two items flagged as judgement calls (D5's
scoped re-read, D7's profile write-back) are settled as the recommendations
stated; either can be re-opened by the owner before its slice starts.

Verified against HEAD `8e7a7b9`.

## What this doc decides

One operator command — `idlefill <group> …` — for the things today scattered
across `update.sh`, `scripts/idlefill-control.mjs`, `scripts/idlefill-daemon.mjs`,
raw `config.json` edits, and (for mesh joining) the absence of any flow at all.
The CLI is a **front-end, not a new backend**: every command either calls an
endpoint that already exists, runs a script that already exists, or (mesh join,
agent connect) is explicitly named as the wave that adds the missing piece.

The four owner-named commands:

```
idlefill update              # update the installed app/checkout to the latest release
idlefill mesh join …         # start the process of joining a mesh
idlefill engine              # list + configurator (e.g. add an engine on this machine)
idlefill agent               # connected/discovered agents; connect / disconnect
```

## Verified state at HEAD (what the CLI wraps)

- **Update:** `./update.sh` (fail-closed five-step sequence, README "Updating");
  the signed release feed `…/releases/download/latest/latest.json` published by
  `scripts/release.sh` (the #75 shell-updater plane); the build-marker identity
  contract (`idlefill-app --version` → `idlefill <short sha>`); the remote-machine
  intent plane (`server/src/update.ts`, `scripts/host-updater.mjs`,
  `docs/architecture/mesh-update.md`).
- **Mesh:** `mesh_peers` + `peer_token` in the arbiter config (static registry,
  read at boot — `loadConfig` runs once, `server/src/index.ts:49`); `GET
  /api/mesh` read plane; `GET /api/state → mesh.peers` merged view; the #39
  pairing ceremony (`/api/mesh/pair/code`, per-instance ed25519 in
  `identity.json`). **There is no join flow** — today joining means hand-editing
  a gitignored config and restarting. That absence is what S4 builds.
- **Engine:** `GET/POST /api/servers`, `POST /api/servers/remove`
  (`server/src/api.ts:803-876`); the ownership/co-location rule (mesh.md rule 1:
  the detector demands the engine's `log_glob` on the same host).
- **Agent:** the daemon's `agent_roster` heartbeat key (`client/src/agent-roster.ts`
  — `adopted` / `external` / `unset` per Hermes profile, credential rules
  LOCKED there); the aggregate endpoint (`aggregate_port`, default 8800).
- **Existing CLIs:** `scripts/idlefill-control.mjs` (arbiter control),
  `scripts/idlefill-daemon.mjs` (daemon control) — both already read the token
  from gitignored config at runtime, never from argv.

## D1 — Packaging: one `cli/` npm workspace (LOCKED)

New workspace `cli/` (Node 22, ESM, TypeScript strict, tsx + node:test), bin
`idlefill`, wired into root `package.json` workspaces so the existing
`npm run test` / `npm run build` / per-package `tsc --noEmit` gates cover it.
In the checkout it runs via the bin (`npx idlefill`, later a linked install);
it is NOT shipped in the Tauri bundle (D8).

The Rust question was asked and answered during the planning thread: the CLI
stays TypeScript. It is HTTP glue + config upserts + script wrappers; the rules
it touches (mesh config sanitizing, roster posture, server-row rules) live in
TS on the server/client side, and re-implementing them in Rust forever is the
drift class this repo keeps catching. The only place a Rust binary earns its
keep long-term is the SaaS "one signed binary" story — out of scope here, and
if that day comes it changes the **arbiter**, not the CLI front-end.

## D2 — One dispatcher; the old scripts become shims (LOCKED)

`idlefill` routes to groups:

```
idlefill update [--check] [--no-pull]
idlefill mesh   status | join <url> [--name N] | leave <name|url> | pair [code]
idlefill engine [list] | add <name> <url> [--models a,b] [--peers p1] [--local]
                | set <id> […] | remove <id>
idlefill agent  [list] | connect <profile> | disconnect <profile>
idlefill daemon status | start | stop | restart | logs | diagnose
idlefill control clients | pause | force | clear | projects | servers …
```

`daemon` and `control` are **passthrough groups** (S1): the existing scripts
keep their behavior byte-identical and become thin shims that exec the
workspace entry, so every existing doc/citation keeps working. Nothing is
deleted in this wave; the scripts retire only after a wave of usage (if ever).

## D3 — Voice, output, auth (LOCKED)

- The dashboard copy convention is the CLI's voice: plain words, named
  outcomes, exception-only detail (the repo's "don't-make-me-think" pass
  applies to terminals too). Every failure names its reason.
- Every read command takes `--json` for scripting; the human rendering is the
  default.
- Auth stays exactly the proven pattern: the Bearer token is read AT RUNTIME
  from the gitignored config (`server/config.json` / `client/config.json`,
  same env overrides as today) and NEVER appears on a command line.
- Writes go through the arbiter's admin API where an endpoint exists (engine,
  mesh status/pair, control); where it doesn't (mesh join's config row, agent
  connect's profile file), the CLI owns the write and the discipline below.

## D4 — `update`: wrapper + feed probe, one plane only (LOCKED)

- `update --check` = anonymous GET of the release `latest.json` feed + compare
  against the installed build marker; a named answer either way
  ("up to date at <sha>" / "Release #N available"). Touches nothing.
- `update` runs `./update.sh` — the locked five-step fail-closed sequence
  (dirty-checkout refusal, `--ff-only`, green-build gate before relaunch,
  rename-swap staging, process-settle). The CLI is a WRAPPER; it does not
  re-implement the steps.
- **Plane discipline:** this is the local checkout/app plane. Updating ANOTHER
  machine is the mesh intent plane (`mesh-update.md`, the dashboard button) —
  deliberately NOT `idlefill update <peer>` in this wave. No new auto-updater
  for daemon or arbiter (the shell-updater D7 amendment stands: the daemon and
  the arbiter carry none).

## D5 — `mesh`: join is the flow that doesn't exist yet (LOCKED, judgement call flagged)

- `status` renders `mesh.peers` from the local arbiter with the dashboard's
  honesty posture (fetch age grows; past the threshold the row names itself
  offline; never fake progress).
- `join <url>` is **probe-then-write**: the candidate must answer
  `GET /api/mesh` with the configured `peer_token` before anything is written
  (unreachable / wrong shape / wrong token = named refusal, zero mutation).
  Then an upsert of the `mesh_peers` row into `server/config.json`: atomic
  write, timestamped backup, and the D1 naming trap is enforced — `mesh_peers`
  (federation) is never confused with `server_peers` (llama-swap backends).
- **The re-read decision:** the arbiter reads config at boot only, so a live
  join needs either a restart or a scoped re-read. LOCKED as the
  recommendation: a **scoped re-read** behind one local-admin endpoint
  (re-apply `mesh_peers` + `peer_token` only, next poll tick picks it up). A
  full arbiter restart to add a peer is wrong on urza (lease drain, swap
  machinery) and overkill everywhere else. This is the ONLY new server-side
  surface in the whole CLI wave.
- `pair [code]` rides the #39 ceremony — no new handshake, no new credential
  plane. `join` creates the READ row only; control edges stay the pairing's.
- No new transport, ever: mesh.md D1 (read-through pull, no hub, no gossip) is
  inherited unchanged.

## D6 — `engine`: the inventory API's terminal twin (LOCKED)

List/add/set/remove over the existing `/api/servers` surface — the same rows
the dashboard Resources tab and `idlefill-control.mjs server` manage. The
owner's example ("add an inference engine running on the local machine") is
`add --local`: the co-location rule from mesh.md rule 1 becomes a PRE-FLIGHT —
probe the candidate log locations, require `log_glob` to match a real file,
otherwise refuse with the rule named and save nothing. A remote/`watched:
false` row remains available and stays honest: it renders fail-closed for
grants, exactly as the ownership rule intends.

## D7 — `agent`: roster view + the one out-of-repo write (LOCKED, judgement call flagged)

- `agent list` reads the `agent_roster` the daemon already publishes. The
  dashboard's fetch-honesty axis ports whole: no roster key = a named absence
  (Linux daemon without `~/.hermes`), fetched-empty = a true 0 naming the
  zero-config posture.
- `connect <profile>` = flip the Hermes profile to the `adopted` posture: set
  its model base URL to this machine's bound aggregate endpoint (`127.0.0.1:
  <aggregate_port>`, the same value the roster classifies on).
  `disconnect <profile>` restores the prior endpoint.
- **The write-back decision:** this is the only CLI write outside the repo.
  LOCKED as the recommendation with the agent-roster.ts credential rules
  inherited whole: never read a profile `.env`, never follow `key_env`, never
  print a credential, userinfo-bearing URLs refused not redacted, unparseable
  config = named refusal, backup written before any modification. This is why
  S5 ships last and gets the most review.
- Routing, never admission: connect/disconnect changes where a profile SENDS
  traffic; it can never make the idle gate grant something it would refuse.

## D8 — Out of scope for this wave (LOCKED)

- No Rust CLI (D1 rationale); no CLI inside the Tauri bundle; no SaaS auth
  planes; no `mesh update <peer>` (the intent plane stays the dashboard's for
  now); no new dashboard surfaces; no changes to lease/idle semantics.
  - **Amendment (dated 2026-10-12, owner ask "make sure the CLI is included
    when installing the app"):** the lock STANDS — the CLI stays OUT of the
    Tauri bundle. The ask is met at the install layer: `update.sh` rebuilds
    the `cli/` workspace and runs `scripts/install-cli.sh`, which writes a
    linked shim `~/.local/bin/idlefill` exec'ing this checkout's
    `cli/dist/index.js`. Build-from-checkout is the product model
    (tauri-cutover D7), so the linked shim updates for free on every
    `./update.sh`; the installer is idempotent and refuses by name to
    overwrite anything it did not render.
- MCP stays the scheduling plane (README "Scheduling work") — the CLI is the
  OPERATOR plane; they share the arbiter API, not each other's job.

## Slices — each ships green on its own

| Slice | Issue | Lands |
|---|---|---|
| S1 | **#88** | `cli/` workspace + dispatcher + help tree; `daemon`/`control` passthrough groups; shims keep old paths working. Zero new behavior. |
| S2 | **#89** | `idlefill update` / `--check` — release-feed probe + build-marker compare + update.sh wrapper. |
| S3 | **#90** | `idlefill engine` — inventory CRUD + `--local` co-location pre-flight. Pure API client. |
| S4 | **#91** | `idlefill mesh status/join/leave/pair` + the ONE new server surface (scoped mesh config re-read). |
| S5 | **#92** | `idlefill agent list/connect/disconnect` — roster rendering + the guarded Hermes write-back. |

Sequencing note: S1 before everything (the dispatcher), S4 before any second
machine joins the mesh by hand again, S5 last and only after its safety rules
are reviewed against the real `~/.hermes`.
