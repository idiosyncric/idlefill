# Issue #14 report — per-project MCP tool policy

Branch `issue-14-mcp-policy` (worktree of idlefill). Scope: the MCP server
`adapters/career-ops/idlefill-mcp.mjs` + its hermetic stdio test
`adapters/career-ops/mcp.test.mjs`. No daemon, arbiter, or
`client/src/config.ts` changes (settled decision #7/#8 — config.ts is owned
by another worker this week; the MCP server parses its own config copy).

## What changed

### `adapters/career-ops/idlefill-mcp.mjs`

**Policy layer (new, ~110 lines).** Optional `mcp` block per
`client/config.json` `projects[]` entry: `{ enabled?, tools?, allow_write? }`.

- `projectEntries(cfg)` — raw name-valid entries (policy needs the entries,
  not just paths).
- `projectPaths(cfg)` now SKIPS `mcp.enabled:false` projects. That single
  chokepoint removes them from every MCP-side enumeration: tool project
  resolution, the `unknown project` message, `queue_status`'s project map,
  and `defaultProject`. The daemon's config loader is untouched — it still
  drains their queues (settled decision #3).
- `WRITE_TOOLS = {add_jobs, remove_jobs, clear_queue}` (the actual table in
  the file — the issue text predates remove/clear/lookup; settled decision
  #1). Read-only: queue_status, results, job_lookup.
- `READ_ONLY_MODE = IDLEFILL_MCP_READ_ONLY === '1'` — operator escape hatch,
  read once at process start, applies to every project regardless of config.
- `visibleToolsFor(entry)` — the ordered visible set: `mcp.tools` order
  preserved (policy order, not static order); unknown names dropped with a
  once-per-process stderr warning (`ignoring unknown tool name "X" in
  mcp.tools for project "Y"`), never fatal; `allow_write:false` or
  READ_ONLY_MODE strips the write tools.
- `enforceToolPolicy(name, project, cfg)` — call-site enforcement. Error
  strings exactly as settled decision #6:
  `write not allowed for project "x" (mcp.allow_write)` /
  `tool "Y" not in mcp.tools for project "x"` /
  `read-only mode (IDLEFILL_MCP_READ_ONLY): write not allowed for project "x"`.
  Unknown/disabled projects return null → the tool's own unknown-project
  error fires (its enumeration already excludes disabled projects).

**`initialize`.** `capabilities.tools.listChanged: true`. The `instructions`
string now documents the per-project policy, the nonstandard `params.project`
extension on `tools/list`, and the read-only mode (worded differently when
READ_ONLY_MODE is active, so a client can see it is ON right now).

**`tools/list`.** Policy-resolved:
- `params.project` (nonstandard extension) → that project's effective set,
  each tool carrying `annotations: {readOnlyHint, destructiveHint}` reflecting
  the EFFECTIVE permission (a listed write tool is writable here →
  `readOnlyHint:false, destructiveHint:true`; read tools the inverse).
  Unknown or disabled project → empty array.
- No param (settled decision #4): the UNION of the enabled projects' visible
  sets, ordered by the static TOOLS table (deterministic), with
  MOST-RESTRICTIVE annotations — a write tool is annotated writable only if
  EVERY enabled project may write it. If no projects are configured at all
  there is no policy source, so the full static table is published exactly as
  today (calls still resolve via adapter discovery / unknown-project error).
- `listChanged`: each response is fingerprinted (JSON of the shaped array);
  a fingerprint differing from the last one SENT on that connection is
  followed by `notifications/tools/list_changed` on the same stdio channel.
  First response never notifies; identical repeats never notify.

**`tools/call`.** Before dispatching, the project is resolved exactly as the
tool would (`args.project || defaultProject(cfg)`) and `enforceToolPolicy`
runs. A denial returns `isError: true` with `{ok:false, error:<reason>}` —
the operation never executes (queue file byte-unchanged, asserted in tests).

### `adapters/career-ops/mcp.test.mjs`

- `driveServer` gained an optional `env` merge (for the READ_ONLY test) and
  now collects method-only messages into `notes` (for the notification
  assertion). The existing baseline test body is UNCHANGED (acceptance: no
  `mcp` block behaves identically — asserted against the untouched baseline).
- Two new tests in the same hermetic-stdio pattern:
  1. **policy session** — four projects (`p1` no block, `ro`
     `allow_write:false`, `sub` explicit subset incl. `bogus_tool` twice,
     `off` `enabled:false`): write tools hidden from `ro`'s list with
     read-only annotations; subset returned in policy order; unknown name
     warned exactly once on stderr and dropped; disabled project lists no
     tools; no-param union = all six with most-restrictive write
     annotations; `list_changed` fired 3× across four differing lists and
     NOT on the identical repeat; blocked add/remove/clear on `ro` all
     `isError:true` naming `mcp.allow_write`, queue file byte-compared
     unchanged; read tool still works; `sub` blocks the out-of-subset tool
     naming `mcp.tools`; `off` produces `unknown project "off"` that does
     NOT enumerate it (enabled projects do appear), its queue file
     untouched, and `queue_status` omits it.
  2. **read-only env session** — `IDLEFILL_MCP_READ_ONLY=1` with a project
     that has NO mcp block: instructions advertise READ-ONLY mode, write
     tools hidden, all three write calls blocked naming the env flag,
     queue byte-unchanged, read tools work.

## Gate output (real)

Baseline before changes (`NODE_ENV= npm run test`):
server 80 / client 44 / career-ops 5 / noop 2 — 131 tests, 0 fail.

Final (`NODE_ENV= npm run test`):

```
> idlefill-server@0.1.0 test   ℹ tests 80  ℹ pass 80  ℹ fail 0
> idlefill-client@0.1.0 test   ℹ tests 44  ℹ pass 44  ℹ fail 0
> idlefill-adapter-career-ops@0.1.0 test
  ✔ idlefill-mcp: stdio sessions — add/status/results(echo)/lookup + remove/clear/lookup facts (3024ms)
  ✔ idlefill-mcp issue #14: per-project tool policy — hide + enforce + read-only env + enabled:false (1518ms)
  ✔ idlefill-mcp issue #14: IDLEFILL_MCP_READ_ONLY=1 blocks every write tool for every project (1512ms)
  ✔ rebuild rules / --force / score order / estimated_seconds
  ℹ tests 7  ℹ pass 7  ℹ fail 0
> idlefill-adapter-noop@0.1.0 test ℹ tests 2 ℹ pass 2 ℹ fail 0
```

133 tests, 0 fail (baseline 131 + 2 new; baseline mcp test unchanged and
green). `npm run build` (tsc, server workspace): clean. `node --check` on
both touched files: clean.

## Deviations / notes

- **`read_only_roles` skipped** (settled decision #2): no role concept exists
  in the MCP server; the field is accepted-in-config but never read. A config
  carrying it behaves as if absent.
- **No-param `tools/list` = union with most-restrictive annotations**
  (settled decision #4, second variant): union across enabled projects,
  static-table order; a write tool is annotated writable only when every
  enabled project may write it. Chosen for determinism; documented in the
  server's initialize instructions.
- **`listChanged` notification IS testable** in the stdio harness (the
  harness now parses method-only lines) — asserted fired-3× / not-on-repeat;
  no fight needed.
- **READ_ONLY error wording** puts the flag first (`read-only mode
  (IDLEFILL_MCP_READ_ONLY): write not allowed for project "x"`) so the
  governing field is unmistakable; the `mcp.allow_write` and `mcp.tools`
  messages match decision #6 verbatim.
- **Zero configured projects**: no policy source exists, so `tools/list`
  publishes the full static table (today's behavior) rather than an empty
  union — keeps the adapter-discovery path working.
- Enforcement resolves the project with the SAME rule the tool uses
  (`args.project || defaultProject`), so a policy can't be bypassed by
  omitting `project` when a default exists.
