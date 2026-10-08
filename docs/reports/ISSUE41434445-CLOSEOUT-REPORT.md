# Close-out acceptance pass — #41, #43, #44, #45 (2026-10-08)

The four issues are code-complete on `main`. The original build reports
stand: [ISSUE41-FAIL-OPEN-REPORT.md](ISSUE41-FAIL-OPEN-REPORT.md),
[ISSUE43-LAUNCHER-REPORT.md](ISSUE43-LAUNCHER-REPORT.md),
[ISSUE44-QUEUE-FORCE-REPORT.md](ISSUE44-QUEUE-FORCE-REPORT.md),
[ISSUE45-SESSION-DETAIL-REPORT.md](ISSUE45-SESSION-DETAIL-REPORT.md).
Their live proof ran on the legacy single-file page. The arbiter serves the
React workspace since `419db6e`. This pass re-proves the acceptance points
on the current surface before the close.

## Method

- A scratch arbiter runs on `:18891` under `IDLEFILL_CONFIG`. It carries a
  scratch state file, a scratch token, and a `poll_ms` of 60 s. The pass
  touches no production label or port.
- The arbiter serves the committed React build from `dashboard/dist`.
- Fixtures ride the public register routes.
- DOM asserts run in Orca's embedded browser. Each view assert does a hard
  reload. A hash-only `goto` does not remount the app.
- Production `:8787` and the `com.sam.idlefill.server` / `.client` labels
  stay untouched. The pass verifies them before and after.

## Acceptance matrix (all PASS on the React surface)

| Point | Issue | Assert | Result |
| --- | --- | --- | --- |
| Fail-open badge on the worker row. The armed row renders nothing | #41 | The `gate fail-open` badge count on the Projects view is 1. The badge sits on the `fail_open` worker. The `armed` worker row carries no badge | PASS — screenshot `ISSUE41434445-closeout-projects.png` |
| Launcher: mint + exact `/model …/s/<token>` line + copy | #43 | The New session card shows for the online client. The host row shows `127.0.0.1:11435`. The mint button shows. A minted line carries the exact `/model http://127.0.0.1:<port>/s/<token>` shape. The mint is page-local and crypto-minted. The shape assert proves the form | PASS — screenshot `ISSUE41434445-closeout-sessions.png` |
| Queue position `queued · #N` + exposed force | #44 | Two queued rows render `queued · #1` and `queued · #2` from the router-reported position. Every row carries the three-option gate select (running / paused / forced). The view shows 6 select triggers: 3 engine pin selects + 3 gate selects. The `forced` tag is exception-only. No forced row is seeded, so no tag renders | PASS |
| Session detail: model tag + token count + sparkline + hermes id | #45 | Row one shows the `qwen3.8-27b-ninfer` model badge, `18.4k tok`, a sparkline, and the `hermes conv-aaaa1234` id. Row two shows `gpt-oss-120b`, `900 tok`, a flat sparkline. The view carries 15 SVG sparklines. The legacy row (no add-keys) renders without any of the extras | PASS |

The #42 slice-0 hermes-id render is asserted with #45. The row carries both
facts. #42 stays open. The middleware plugin is unbuilt.

## Not closed by this pass

- #44 promote / remove stays deferred. This pair needs an arbiter→router
  command channel. That channel does not exist. See the #44 report Scope
  section. The issue closes as the built slice. The closing comment names
  the deferred part.
- #43 "Open in Orca" spawn stays unbuilt. The build report records the
  decision: the copy-paste flow proves itself in daily use first.
