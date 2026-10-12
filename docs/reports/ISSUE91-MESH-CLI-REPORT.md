# #91 — Operator CLI S4: `idlefill mesh` + the scoped mesh config re-read (build report, 2026-10-12)

Design authority: `docs/architecture/cli.md` D5 (LOCKED, judgement call
settled). This slice carries the ONLY new server-side surface in the whole
CLI wave: the scoped re-read of `mesh_peers` + `peer_token` behind one
local-admin endpoint. Inherited whole: mesh.md D1 (read-through pull — no
new transport), D2 (`peer_token` read plane), the `mesh_peers` vs
`server_peers` naming trap, and the pairing.md ceremony (ride it, don't
redesign it — `join` creates the READ row only).

## What landed

**`server/src/mesh.ts`** — `MeshFederation.applyMeshConfig(peers, token)`:
re-applies ONLY the two scoped keys on the shared live config object;
keeps a kept row's observed `instance_id`, last snapshot and growing
fetch age byte-for-byte (the view never blanks); added rows start honest
(never fetched → offline); removed config rows drop; fleet-roster-origin
rows are NEVER touched (#55 D3 owns them); registry garbage (blank/`self`/
dup/`/`-suffixed urls) normalizes through the boot rule (`normalizePeerRows`,
now shared with the constructor).

**`server/src/api.ts`** — `POST /api/mesh/peers/reload` (the wave's one
new endpoint): local ADMIN plane (like `/api/mesh/unpair` and the pair
ceremony — the hook already scopes `peer_token` to `GET /api/mesh`, so it
401s here and that is tested). It re-reads the arbiter's OWN config source
(`ApiDeps.reloadMeshConfig`, wired in `server/src/index.ts` to re-run the
exact `loadConfig(entryDir)` boot resolution), applies it through
`applyMeshConfig`, and answers with the live peer set + `peer_token:
set|unset` — the token VALUE never rides the response. A failed config
re-read is a named 500 that applies NOTHING (the live set stands). Audit:
new ADD event kind `mesh_peers_reloaded` with coarse detail (peer count +
set/unset — never the token). No restart: `enabled` flips and the next
`poll_ms` tick pulls the added rows.

**`cli/src/mesh.ts`** — the `mesh` group:

```
idlefill mesh status [--json]
idlefill mesh join <url> [--name N]
idlefill mesh leave <name|url>
idlefill mesh pair [code]
```

- **status** — one `GET /api/state`, rendering `mesh.peers` with the
  dashboard's fetch-honesty axis: age grows; past the 90 s window the row
  NAMES itself offline and the stale snapshot is never shown as current;
  a never-fetched row says so with its error; no mesh key / no peers are
  named absences. `--json` prints the raw rows.
- **join** — probe-then-write, exactly as locked: the candidate must
  answer `GET /api/mesh` with the configured `peer_token` BEFORE anything
  is written — unreachable / 401-403 (token mismatch) / non-2xx / wrong
  shape = named refusal + exit 1 + ZERO mutation. Guards named before
  probing: self-join, `IDLEFILL_CONFIG`-env arbiter (the file this command
  writes would never be read), absent `peer_token` (the read plane needs
  one on both sides). Then the `mesh_peers` upsert into
  `server/config.json`: dedupe on the normalized url, timestamped backup
  (`config.json.bak-<UTC>`), atomic tmp+rename, and the NAMING TRAP
  enforced — `server_peers` and every other key ride through
  byte-for-byte. Then the scoped re-read; if the arbiter is down or the
  applied set doesn't carry the row (config source elsewhere), that is
  NAMED and exit 1, the written row honestly reported. Finally the first
  real fetch is awaited on the SAME cadence (`poll_ms + margin`, bounded)
  and rendered online/offline as it truly is.
- **leave** — exact-url match first, then name; not-found names the known
  peers, an ambiguous name refuses with every url printed, no file =
  named absence — each ZERO mutation. Removed → backup + atomic write +
  re-read; if the fleet roster still owns the url the note says so.
- **pair [code]** — rides `POST /api/mesh/pair/code` (no code: mint, this
  machine becomes the controlled end, code + ttl + the exact peer-side
  command printed) and `POST /api/mesh/pair` (with a code: redeem, this
  machine becomes the controller) — `code_used` / `code_expired` /
  `self_pair` / `fleet_not_configured` / mint-failure all land as named
  plain outcomes. No new handshake, no new credential plane (pairing.md
  whole).
- Voice/auth (D3): every failure names its reason; exit codes 0/1/2;
  token + `peer_token` read at runtime from the gitignored config, never
  argv, never printed (the reload response, the audit event and every CLI
  line are asserted token-free).

## The live check caught a real CLI bug

The first live `mesh join` (scratch worktree arbiters, see below) failed
with `HTTP 400: Bad Request` on the re-read: the CLI's apiCall always sent
`content-type: application/json`, and Fastify 400s a JSON-content-type
request with an EMPTY body — the reload/pair-code calls are body-less
POSTs. Fixed in `a4519e2` (content-type only rides when a body does) and
the worktrees were refreshed to the fix WITHOUT restarting the running
scratch arbiters — itself a live proof of the scoped re-read story (the
server side did not need to change at all).

## Tests — 30 new + 2 dispatcher/help re-pins, all hermetic

`cli/test/mesh.test.ts` (21): argv table; url normalization (trailing
slashes/`self`/non-http); upsert add/dedupe/rename/unchanged + reject;
**the naming trap pinned as a byte-check — `server_peers` and every other
key survive the upsert untouched**; remove by url/name, not-found names
the known peers, ambiguous refuses; backup name + real-FS atomic
tmp+rename round-trip (old bytes in the backup, new bytes in the file,
fresh file gets no backup); corrupt config = named refusal; the probe
decision table (ok / unreachable / refused-token / http / bad-shape) with
every refusal naming its reason AND promising zero mutation; the offline
wording (stale row names itself offline past the window — no stale
snapshot shown as current; never-fetched is honest; an online row's
last-fetch failure rides as an exception); the pairing error voice.

`server/test/mesh-reread.test.ts` (9): `applyMeshConfig` in-flight
preservation (snapshot/instance id/fetch age survive; added row starts
never-fetched; removed config rows drop; the added row is pulled on the
SAME refresh cadence); a roster-origin row is immune to the config
re-apply; registry garbage normalizes; the endpoint's auth posture
(anonymous/wrong/**peer_token** all 401 — the read token never reaches a
control surface); the response never carries the token value; a
re-applied `peer_token` flips the auth hook on the very next request in
BOTH directions (no restart); a failed config re-read is a named 500 with
the live set standing byte-for-byte; unwired variants 501; the audit
event lands without the token.

Gates: `npm run test` 933/933 green (server 482 = 473 + 9, cli 71 = 48 +
23), `npm run build` green, `tsc --noEmit` clean for server + cli. (One
earlier server run under-counted 453 of 482 — a runner artifact, zero
failures, re-verified 482/482 three consecutive times.)

## Live two-local-arbiters check (production untouched)

Two scratch worktrees (`s4-a`/`s4-b` — gitignored configs, separate state
files, `poll_ms 3000`, a decoy `server_peers: ["peer:llama-decoy"]`),
two arbiters on :18891 / :18892, started once and NEVER restarted for
the whole chain:

1. `mesh status` with no peers → named absence, exit 0.
2. `mesh join http://127.0.0.1:1` → `join refused — cannot reach …
   Nothing was written to server/config.json.` exit 1; no backup file,
   no `mesh_peers` key appeared (zero mutation proven on disk).
3. `mesh join http://127.0.0.1:18892 --name beta` from A → probe proved
   the peer_token matches (candidate answered as `m-953f48621f3c`
   "beta-s4"), row written with timestamped backup, the RUNNING arbiter
   re-read its config, and the first fetch came back within one tick:
   `online — snapshot fetched 2s ago`.
4. B joined A the same way (`m-08c008e42c62` "alpha-s4") — **both rows
   appear**: A shows beta online (age 3 s), B shows alpha online (age 0 s).
5. `mesh leave beta` on A → row gone, arbiter re-applied its set
   **without a restart** (the arbiter log holds exactly one "listening"
   line), A's status: `no mesh peers configured`. B left the same way —
   **both views updated**.
6. `mesh leave ghost` → named, zero mutation; `mesh pair` without the
   fleet plane → the named `fleet_not_configured` posture.
7. Post-run facts on disk: the decoy `server_peers` survived all five
   atomic writes byte-for-byte (the naming trap, live); `mesh_peers`
   ended `[]`; the state file carries the `mesh_peers_reloaded` audit
   events and the peer_token value appears nowhere; 5 timestamped
   backups; 0 tick errors.

Production `:8787` and the real gitignored configs were never touched —
every write happened inside the scratch worktrees, which were removed
after the chain.

## Boundaries held

Zero new transport (mesh.md D1), zero new credential plane (pairing.md
inherited whole), `mesh_peers` stays the static registry (no peer store
in `state.json` — snapshots stay ephemeral), `join` creates the READ row
only, the control edge stays the ceremony's, no dashboard changes, no
`server_peers` confusion anywhere (tested on both the pure and the live
axis).
