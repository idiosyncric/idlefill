# #90 — Operator CLI S3: `idlefill engine` (build report, 2026-10-12)

Design authority: `docs/architecture/cli.md` D6 (engine = the inventory
API's terminal twin). Pure API client over the existing
`GET/POST /api/servers` + `POST /api/servers/remove`
(`server/src/api.ts:803-876`) — zero new arbiter endpoints.

## What landed

**`cli/src/engine.ts`** — the `engine` group, wired into the dispatcher
(`dispatch.ts` flips `engine.implemented`, `index.ts` routes it,
`help.ts` ENGINE_USAGE becomes the live text):

```
idlefill engine [list] [--json]
idlefill engine add <name> <url> [--models a,b] [--peers p1] [--local [--log-glob G]]
idlefill engine set <id> [--name N] [--url U] [--models a,b] [--peers p1]
idlefill engine remove <id>
```

- **list** — one `GET /api/state`: the same `serverView` rows the
  dashboard Resources tab reads, plus the global idle threshold the
  `--json` stays the raw rows (D3: reads answer both voices).
- **Row render (pure `renderEngineRows`/`verdictLine`)** — the dashboard's
  plain voice ported to the terminal: `[watched]/[declared]` header with
  the `key:set` + `(no activity feed)` posture (README
  "Inference-server inventory"), the `runs when idle ≥Ns · max N` knobs
  line (watched rows; `max_concurrent ?? 1`, group named when set), and
  the liveWord words — `idle — grants open · idle for Ns · log wrote Ns
  ago`, `busy — grants blocked · last activity Ns ago`,
  `degraded — grants blocked (<reason>)`,
  `no signal resolves (<no_signal_reason>) — fail-closed for grants`,
  `not watched — display + routing metadata; grants against this engine
  fail closed (mesh.md rule 1)`. Exception-only detail, never a fake verdict.
- **add / set / remove** — the same payload the dashboard form and
  `idlefill control server …` send (auth untouched: engine never sends
  `auth_token`; that stays the control group/dashboard form). The
  arbiter's refusals land as named plain outcomes (`explainApiError`):
  unknown id → "`idlefill engine list` shows the ids", `leases_active`
  → "live leases — let them finish or revoke them first".
- **Auth posture (D3)** — token read AT RUNTIME from the gitignored
  config with the control group's lookup order (env JSON first); it
  never appears on a command line, never printed.
- **Exit codes** — 0 ok · 1 action failed · 2 usage (usage lines name
  the offending token).

## `add --local` — the co-location pre-flight (mesh.md rule 1)

The arbiter's idle detector reads the engine's log file on its OWN host,
so a local row must carry a `log_glob` that matches a real file here.
Before any POST:

1. **Loopback guard** — the probe reads THIS machine's filesystem, so
   `--local` is refused by name when the resolved arbiter URL is not
   loopback (the co-location it would prove would be a lie).
2. **Candidates** — explicit `--log-glob G` probes exactly G; without
   it, six conventional spots slugified by row name (`~/logs/<slug>*.log`,
   `~/logs/<slug>/*.log`, `/var/log/…`, `<repo>/logs/…`, `/tmp/…`).
3. **Probe** — `realProbe` mirrors the detector's OWN matcher
   (dirname + basename glob) and counts real files. Decision table
   (`decideLocalProbe`, pure): first match → save that glob; no match →
   refuse; an **unreadable dir is never a match** — it is named in the
   refusal and the probe still refuses (fail-closed).
4. **No match = refuse with the rule named, save nothing** — every
   probed candidate + outcome printed, plus the two honest ways forward
   (`--log-glob` pointing at the log, or `add` without `--local`: a
   display + routing row, fail-closed for grants).

A remote / unwatched row added without `--local` is fully available and
renders fail-closed for grants — exactly the ownership rule, not a bug.

## The bug the probe caught (fixed, one character)

`server/src/idle.ts makeRealLogMtimeSource` built its basename matcher as
`escapeRe(pat).replace(/\\\*/g, '.*')` — but `escapeRe`'s class did NOT
include `*`, so the wildcard pass had nothing to translate and `*` fell
through as a bare REGEX quantifier: `*.log` built `/^*\.log$/` (throws →
caught → null: **the log signal silently disabled**) and
`strata-*.log` became `/^strata-*\.log$/` (matches `strata.log`, misses
every real `strata-<x>.log`). Production never surfaced it because this
machine's config carries a literal filename glob. The documented
contract ("the newest-mtime file matching `log_glob`", idle.ts's own
docstring) is a basename glob — the fix adds `*` to the escape set. The
CLI probe mirrors the fixed matcher; a pre-flight that answered "matched"
against a matcher that sees nothing would have been exactly the dishonesty
the rule exists to prevent. New regression test drives the REAL
`makeRealLogMtimeSource` over a temp dir (leading-`*` no longer throws,
mid-`*` matches, literal filenames byte-for-byte, newest mtime wins,
no-match/missing-dir → null).

## Tests + gates

- **22 new pure-helper tests** (cli 26 → 48): argv→payload mapping
  (add/set/remove + position-free flags, csv splits, unknown flag/sub
  named, `--auth` stays out of this plane), row renders (the
  `runs when idle ≥120s · max 2 (group g1)` line, the fail-closed
  unwatched line, degraded/no-signal/running/busy words, feed-off +
  `key:set` posture), the `--local` decision table (first-match-wins,
  no-match refusal naming every candidate, unreadable-dir named and
  never a match, explicit-single-glob miss saves nothing) + real-fs
  `realProbe` (match / exact-name / dot-literal / unreadable dir),
  `localCandidateGlobs` slug table, loopback guard, arbiter-error voice,
  engine-live dispatch routing + ENGINE_USAGE names every subcommand.
- **server 473/473** (+1 the log-glob regression), **repo 901/901**
  (server 473 · client 256 · cli 48 · dashboard 48 · fleet 54 ·
  adapters 22), `npm run build` green, `npx tsc --noEmit` clean
  (cli + server).

## Live verification (scratch arbiter :18790, repo-root cwd /tmp/idlefill90)

Full acceptance chain, production :8787 untouched:

1. `add --local … --log-glob '/tmp/idlefill90/logs/ghost-*.log'` →
   refused, rule named, `ghost` absent from `list` — **nothing saved**.
2. `add --local s3-engine … --log-glob '/tmp/idlefill90/logs/engine-*.log'`
   → `matches 2 files on this host`, row saved with the glob.
3. `add box-two http://192.168.9.9:11434` (no `--local`) → saved; list
   renders its posture honestly.
4. `list` — header/knobs/verdict/log lines as designed; `list --json`
   answers the raw rows.
5. Dashboard **Resources tab** on the scratch instance shows the added
   card (`s3-engine`, url in the header; `server_connection_added` in
   RECENT EVENTS) — screenshot `ISSUE90-resources-row.png`.
6. `set srv-45039a30 --name s3-engine-renamed --models qwen3` → ok; the
   renamed card is live on the dashboard.
7. `remove` both rows → ok; `remove srv-nope` → named refusal (exit 1);
   final `list` shows only the seeded watched row. Usage errors exit 2.

Honest incident: the first `add` run resolved to the PRODUCTION arbiter
(:8787) because this machine's existing `client/config.json` wins the
lookup before `IDLEFILL_CONFIG` — the control group's inherited
precedence, behavior identical to the wrapped script. The stray row was
removed immediately (`engine remove srv-13a47bd6`) and production re-verified
clean; the re-run pinned the scratch instance via `IDLEFILL_CLIENT_CONFIG`.

## Out of scope (kept)

No new arbiter endpoints (the escapeRe fix is a bug fix on the matcher,
not a new surface); no `--auth` in this plane (the control group +
dashboard form own the write-only credential); dashboard unchanged;
lease/idle semantics unchanged.
