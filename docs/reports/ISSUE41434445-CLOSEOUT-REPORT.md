# Close-out acceptance pass — #41, #43, #44, #45 (2026-10-08)

The four issues were code-complete on `main` (the original build reports
stand: [ISSUE41-FAIL-OPEN-REPORT.md](ISSUE41-FAIL-OPEN-REPORT.md),
[ISSUE43-LAUNCHER-REPORT.md](ISSUE43-LAUNCHER-REPORT.md),
[ISSUE44-QUEUE-FORCE-REPORT.md](ISSUE44-QUEUE-FORCE-REPORT.md),
[ISSUE45-SESSION-DETAIL-REPORT.md](ISSUE45-SESSION-DETAIL-REPORT.md)). Their
live proof ran on the legacy single-file page. Since `419db6e` the arbiter
serves the React workspace (`dashboard/dist`), so this pass re-proves the
acceptance points on the CURRENT surface before the issues close.

## Method

- Scratch arbiter on `:18891` under `IDLEFILL_CONFIG` (scratch state file,
  scratch token, `poll_ms` 60 s, no production label or port touched).
- The arbiter serves the committed React build from `dashboard/dist`.
- Fixtures via the public register routes, then DOM asserts in Orca's
  embedded browser (hard reload per view; hash-only `goto` does not remount
  the app, so each view assert reloads first).
- Production `:8787` and the `com.sam.idlefill.server` / `.client` labels
  stayed untouched (verified before and after).

## Acceptance matrix (all PASS on the React surface)

| Point | Issue | Assert | Result |
| --- | --- | --- | --- |
| Fail-open badge on the worker row, armed row renders nothing | #41 | `gate fail-open` badge count on the Projects view = 1 (the `fail_open` worker); the `armed` worker row carries no badge | PASS — screenshot `ISSUE41434445-closeout-projects.png` |
| Launcher: mint + exact `/model …/s/<token>` line + copy | #43 | "New session" card visible for the online `proxy_port`-reporting client; `127.0.0.1:11435` host row; the mint button present; a minted line carries the exact `/model http://127.0.0.1:<port>/s/<token>` shape (page-local, crypto-minted — proven by the shape assert; the copy button is the page's own handler) | PASS — screenshot `ISSUE41434445-closeout-sessions.png` |
| Queue position `queued · #N` + exposed force | #44 | Two queued rows render `queued · #1` and `queued · #2` from the router-reported position; the three-option gate select (running/paused/forced) is present on every row (6 gate selects across the rows + engine pins); the `forced` tag markup is exception-only (no forced row seeded, so none rendered — correct) | PASS |
| Session detail: model tag + token count + sparkline + hermes id | #45 | `model qwen3.8-27b-ninfer` badge, `18.4k tok`, `model gpt-oss-120b`, `900 tok`, 15 SVG sparklines on the view, `hermes conv-aaaa1234` id on row one; the legacy row (no add-keys) renders without any of the extras | PASS |

The `#42 slice 0` hermes-id render is asserted with #45 because the row
carries both; #42 stays open (the middleware plugin itself is unbuilt).

## Not closed by this pass

- #44's promote/remove: still deferred (needs an arbiter→router command
  channel — see the #44 report Scope section). The issue closes as the
  built slice; the deferred part is named in the closing comment.
- #43's optional "Open in Orca" spawn: the issue's own report records it as
  deliberately not built.
