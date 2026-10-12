# Issue #88 — Operator CLI S1: the `cli/` workspace + the `idlefill` dispatcher

Landed 2026-10-12. Design authority: `docs/architecture/cli.md` (D1–D3,
accepted 2026-10-12). Scope: the S1 scaffold — dispatcher, help tree, exit
codes, passthrough groups, shims. **Zero new behavior.**

## What landed

- **`cli/` npm workspace** (D1): Node 22, ESM, TypeScript strict
  (`strict` + `noUncheckedIndexedAccess`, same shape as server/fleet), tsx +
  node:test. Package `idlefill-cli`, **bin `idlefill`** (`dist/index.js`,
  shebang preserved by tsc, exec bit set by the build script). Wired into
  root `package.json` workspaces, so `npm run test` / `npm run build` /
  per-package `tsc --noEmit` gates now cover it.
- **One dispatcher** (`cli/src/index.ts` + `cli/src/argv.ts` +
  `cli/src/dispatch.ts` + `cli/src/help.ts`):
  - argv parsing: first non-flag token is the group; everything after it
    passes through untouched except the dispatcher-owned `--json` /
    `--help`/`-h` flags.
  - group routing via a registry (`dispatch.ts`): `daemon` and `control` are
    LIVE; `update`/`mesh`/`engine`/`agent` are registered and **refuse by
    name** with their slice + issue (`idlefill update: not implemented yet —
    lands in S2 (issue #89)`) until S2–S5 land.
  - help tree: top help lists all six groups with live/planned status;
    `idlefill <group> --help` prints the group usage.
  - exit codes: **0 ok · 1 action failed · 2 usage** (dispatcher usage
    errors are 2; the wrapped groups keep their own historical rc semantics).
  - `--json` on the read commands (D3): `daemon status|pids`,
    `control clients|projects|servers` — human rendering stays the default.
- **Passthrough groups** (D2): `cli/src/daemon.ts` and `cli/src/control.ts`
  are faithful TS ports of `scripts/idlefill-daemon.mjs` /
  `scripts/idlefill-control.mjs` — same output strings, same exit codes,
  same usage text, same Linux/systemd posture, same repo/config resolution.
- **Shims**: both `scripts/idlefill-*.mjs` are now thin shims that exec the
  workspace entry (`node cli/dist/index.js <group> …`, falling back to the
  repo tsx shim + `cli/src/index.ts` when `dist/` is not built) with the
  group prepended and argv passed through. Every existing doc/citation
  keeps working; nothing was deleted.

## Decisions honored

- **D1** — stays TypeScript, one `cli/` workspace, not in the Tauri bundle.
- **D2** — `daemon`/`control` passthrough with **byte-identical behavior**
  (proven below, not just asserted); old script paths retire only after a
  wave of usage.
- **D3** — dashboard voice: every failure names its reason (unknown group,
  planned group, shim without build). `--json` for scripting on reads.
  **Auth posture unchanged**: the arbiter token is read AT RUNTIME from the
  gitignored config (`IDLEFILL_CLIENT_CONFIG`/`IDLEFILL_CONFIG` env, else
  `client/config.json`, else `server/config.json` — same resolution as
  before), never parsed from argv, never printed. The `--json` status shape
  is built field-by-field so a token cannot leak by construction (pinned by
  a test).
- **Zero new behavior** — no server/client surface touched, no config keys
  added (server diff: zero), no token ever on a command line.

## Byte-identity proof (the passthrough promise)

Baseline captured from the pre-change scripts against the live arbiter, then
re-run through the shims after the swap and diffed:

| Invocation | Result |
| --- | --- |
| `idlefill-daemon.mjs` (no args) | EXACT (rc 2) |
| `idlefill-daemon.mjs bogus` | EXACT (rc 2) |
| `idlefill-daemon.mjs app` | EXACT (rc 1) |
| `idlefill-daemon.mjs pids` | EXACT (rc 0) |
| `idlefill-daemon.mjs status` | identical except the live `last_seen` age (4s → 7s — live data drift) |
| `idlefill-daemon.mjs logs --lines 3` | EXACT (rc 0) |
| `idlefill-control.mjs` (no args) | EXACT (rc 1) |
| `idlefill-control.mjs bogus` | EXACT (rc 1) |
| `idlefill-control.mjs clients` / `servers` / `projects` | EXACT (rc 0) |

The daemon group's usage block is additionally pinned **byte-for-byte in a
test** (`cli/test/help.test.ts` golden text).

## Gates (all green before push)

- `npx tsc --noEmit -p cli/tsconfig.json` — clean (and the test files
  type-check clean under the same flags, checked ad hoc).
- `env -u NODE_ENV npm run test` — 8 workspaces, **878/878 pass, 0 fail**,
  including the 26 new cli tests (argv parsing, dispatch/exit codes, help
  tree incl. the byte-golden, `--json` emission + no-token-shape).
- `env -u NODE_ENV npm run build` — green (cli build added).
- `npm install` links `node_modules/.bin/idlefill`; `npx idlefill …` smoke:
  top help / group helps rc 0, no-args rc 2, unknown group rc 2 naming the
  token, `update` rc 2 naming S2/#89, `daemon status --json` / `pids
  --json` / `control clients|servers|projects --json` emit parseable JSON
  with zero token/credential leakage (servers carry the API's `auth_set`
  booleans only). Shim fallback verified with `dist/` temporarily absent.

## Files

- new: `cli/package.json`, `cli/tsconfig.json`, `cli/src/{index,argv,dispatch,help,json,daemon,control}.ts`,
  `cli/test/{argv,dispatch,help,json}.test.ts`, this report
- changed: `package.json` (workspace entry), `scripts/idlefill-daemon.mjs` +
  `scripts/idlefill-control.mjs` (→ shims), `README.md` (phase row +
  Layout `cli/` + `scripts/` entries), `docs/reports/README.md` (index row)

## Next (not in this slice)

S2 `update` (#89), S3 `engine` (#90), S4 `mesh` (#91), S5 `agent` (#92) —
each behind the dispatcher groups already registered here.
