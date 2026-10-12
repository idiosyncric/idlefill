# Issue #92 — Operator CLI S5: `idlefill agent list / connect / disconnect`

Date: 2026-10-12. Plane: the operator CLI (`cli/`, docs/architecture/cli.md D7).
Slices landed before this: S1 (#88), S3 (#90), S4 (#91). S2 (#89, `update`) remains open.

## What landed

`cli/src/agent.ts` — the S5 group, wired live into the dispatcher
(`dispatch.ts`, `index.ts`, `help.ts` AGENT_USAGE now names the live voice).
Zero server/client surface, zero new config keys.

### `agent list` — the published roster, fetch-honest

Reads the daemon's `agent_roster` heartbeat key through the arbiter's
token-gated `GET /api/agent-roster` (#80 plane — LOCAL-truth: the online
loopback client's roster only). The dashboard's honesty axis
(`dashboard/src/lib/agent-stats.ts`) ports whole:

- **no roster key = a named absence** — "the local daemon has no ~/.hermes
  home (or is offline), so nothing was fetched… a named absence, not a
  zero";
- **fetched-empty = a true 0 naming the zero-config posture** — "the
  roster WAS fetched and came back empty… the aggregate endpoint accepts
  any caller";
- rows in plain posture voice: `routes through idlefill` /
  `routes elsewhere` / `no config`, the joining header `${adopted} of N
  profiles adopted`, `--json` prints the raw route body.

### `connect <profile>` / `disconnect <profile>` — the wave's ONLY out-of-repo write

`connect` flips the Hermes profile's **model base URL** to this machine's
aggregate endpoint (`http://127.0.0.1:<aggregate_port>/v1`, the port read
AT RUNTIME from the gitignored client config — same lookup order as
`resolveAuth`, default 8800 mirroring `client/src/config.ts` DEFAULTS; an
explicit `aggregate_port: 0` is a named refusal — there is no aggregate
endpoint to point at). The edit is **line surgery, not a re-serialize**:
the CLI carries every unrelated line — comments, quoting, other provider
blocks, `key_env` references — through byte-for-byte (there is no YAML
parser in this repo and the roster rules in `client/src/agent-roster.ts`
are line-based too, so the edit speaks the same grammar). A profile with
no model block gets the minimal `model:` block appended (the roster
requires it for the adopted posture — endpoint URLs alone classify
`unset`); an already-adopted profile answers `unchanged` with zero write
and zero backup.

`disconnect` **restores the prior config from the newest
`config.yaml.bak-*` backup that PRE-DATES the connect** — the scan is
newest-first and skips backups that are unparseable, carry a
userinfo-bearing URL, or already route to the aggregate port (those are
not a PRIOR config). **It never invents a prior endpoint** — no usable
backup is a named refusal with the scan count and nothing written; a
profile that does not route here at all is a named `not-adopted` refusal.
Before restoring, the current bytes are themselves backed up (symmetric
posture), so nothing a run does is unrecoverable.

The credential rules from `agent-roster.ts` (the authority) are inherited
whole, in code and in tests:

- only the profile's `config.yaml` is ever read — **never a profile
  `.env`, never a `key_env` follow** (the fixture carries a `key_env`
  line; the tests assert it never moves and nothing reads it);
- **never prints a credential** — refusal text never echoes a file's URL
  values; only the CLI's own loopback endpoint and the roster's already
  sanitized published fields are printed;
- a **userinfo-bearing URL (`user:pass@host`) is a REFUSAL, not
  redaction** — pinned by a test asserting the secret never appears in
  the refusal text, not even the host part;
- **unparseable config = named refusal, never a write** — NUL/control
  bytes, tab indentation, more than one top-level `model:` block, and an
  inline-scalar `model: <name>` (no block to hold a base_url) each
  refuse by name;
- **backup written BEFORE any modification**, then atomic tmp+rename
  (the same `backupPathFor` posture the mesh group proved in #91);
- profile names are ONE directory name — traversal, separators, and
  hidden entries are refused as usage errors (exit 2).

Routing, never admission: every success line says the change is only
where the profile SENDS traffic — the idle gate still decides admission
(cli.md D7).

## The `disconnect` decision (flagged for review)

cli.md D7 says `disconnect` "restores the prior endpoint". Since the
connect edit is a surgical line rewrite, the prior endpoint survives ONLY
in the backup connect wrote — so disconnect restores the newest backup
that IS a prior config (never aggregate-routing, parseable, no
userinfo), and refuses rather than fabricating an endpoint when none
qualifies. The round trip is pinned end-to-end: original bytes →
connect (backup + one-line insert) → disconnect → `cmp` byte-identical,
with both backups kept on disk. Manual edits made between connect and
disconnect are preserved as their own newest backup (disconnect backs up
current before restoring) but are superseded by the restore — the success
line names the exact backup restored from and the exact new backup, so
nothing is silently lost.

## Tests — 26 new/updated, repo 959/959 green

`cli/test/agent.test.ts` (24 new pure-helper + real-fs cases): argv
table; profile-name refusals (traversal/hidden/spaces); the aggregate
port/loopback rule ported from the roster (localhost/127.x/`[::1]` yes,
other ports/hosts no); `--json`-adjacent runtime port resolution (env
JSON, 0 = named refusal, junk = named refusal); roster rendering incl.
named-absence and true-0 wording; the connect surgery table (insert into
an existing block / replace in place keeping indent / missing-config
minimal block / already-adopted unchanged / provider-block endpoint does
NOT substitute for a model block — the roster's requirement pinned);
every guard refusal (userinfo never echoed, binary/tab/duplicate-model/
inline-scalar/control-char, "nothing was written" in each); the
disconnect scan (newest-first, skips aggregate-routing + corrupt
backups, not-adopted, no-usable-backup refuses to invent); and the
real-fs round trip on a fixture profile — backup BEFORE the write,
unrelated comment + `key_env` reference byte-intact, restore lands on
the original bytes, both backups kept.

Updated: `dispatch.test.ts` (agent now routes live; update stays
planned-by-name) and `help.test.ts` (agent group help pins the guards:
named absence / true 0 / ONLY out-of-repo write / never a profile .env /
refused not redacted / backup before modification / admission line; the
top help's planned-issue list drops #92).

Gates: cli 97/97, repo **959/959** (server 482 · client 256 · cli 97 ·
adapters 19 · dashboard 3 · tauri/ui 48 · fleet 54), `npm run build`
green, `tsc --noEmit` clean for server/client/cli.

## Live check (against the running production plane, one throwaway profile)

1. **Read-only list** on the live arbiter (:8787, daemon "mac-sam"):
   `4 of 15 profiles adopted`, rows in the plain posture voice — no
   write, no mutation.
2. **Throwaway fixture** `~/.hermes/profiles/s5-throwaway` created with
   an external `providers.elsewhere.api` endpoint, an unrelated-keys +
   comment config (saved copy for byte comparison).
3. `idlefill agent connect s5-throwaway` → `ok: connected … backed up to
   config.yaml.bak-20261012T183027Z`, `prior endpoint:
   http://10.10.10.6:8080/v1` printed; the on-disk `diff` against the
   saved copy shows EXACTLY one inserted line (`  base_url:
   http://127.0.0.1:8800/v1`).
4. After one heartbeat, **the roster re-classified to adopted**:
   `5 of 16 profiles adopted … s5-throwaway routes through idlefill —
   http://127.0.0.1:8800/v1`.
5. `idlefill agent disconnect s5-throwaway` → restored from the pre-
   connect backup, current bytes backed up first; `cmp` against the
   saved original: **byte-identical**; after one heartbeat the row moved
   back to `routes elsewhere`, header back to `4 of 16`.
6. Refusals landed live: second `disconnect` → named `not-adopted`
   refusal (exit 1, nothing written); `connect ../outside` → usage
   refusal naming the path-separator rule (exit 2).
7. Throwaway profile removed; the roster returned to the untouched
   `4 of 15` baseline — production profiles never targeted.

One observation the live fixture surfaced (upstream, NOT a CLI bug): the
roster's published `provider` display value carries inline comments from
the source line (`custom   # unrelated line must survive` — the
line-based `scalarValue` in agent-roster.ts takes the whole scalar). The
CLI renders the published field verbatim; tightening the roster parser
is client-side scope this slice deliberately does not touch.

## Files

- `cli/src/agent.ts` (new), `cli/test/agent.test.ts` (new)
- `cli/src/dispatch.ts`, `cli/src/index.ts`, `cli/src/help.ts` (wiring + live help voice)
- `cli/test/dispatch.test.ts`, `cli/test/help.test.ts` (pins updated)
- `docs/reports/ISSUE92-AGENT-CLI-REPORT.md` (this report), `docs/reports/README.md`, `README.md` (operator-CLI section catches up)
