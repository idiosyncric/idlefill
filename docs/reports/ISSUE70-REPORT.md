# Issue #70 — Tauri build wave report

Wave: build `tauri/` to parity (D8 phase 1). Decision doc:
`docs/architecture/tauri-cutover.md` (LOCKED D1–D9, Q-a..Q-d). Spike
evidence: `docs/reports/ISSUE69-GRILL-REPORT.md`. This report closes the
wave. Fence: `tauri/**` + this file only. Nothing else changed.

## 1. The Info.plist corruption — root cause closed

The supervisor finding (2026-10-06 14:47): the release bundle's
`Contents/Info.plist` was 115 bytes and began with `[`. plutil lint said
"Unexpected character [ at line 1". The content was a bare
CFBundleURLTypes JSON array.

**The bundler did not write it. The verify command wrote it.**

Mechanism, probed byte-exactly on this host (macOS 27.0.1, build
26A434):

```
$ plutil -extract CFBundleURLTypes json p_json.plist
stdout: []
after: 37 bytes   # p_json.plist now holds ONLY the extracted JSON
```

On this plutil, `plutil -extract <key> json <file>` without `-o`
overwrites the INPUT file with the extracted JSON and prints nothing.
The `json` and `xml1` output formats rewrite the file. The `raw` format
prints to stdout and leaves the file intact, and `json -o -` prints to
stdout and leaves it intact. The 115-byte artifact equals exactly what
`plutil -extract CFBundleURLTypes json` returns for this bundle. The
mtime "correlated with build exits" because the check ran right after
the build, inside the gate.

The fingerprint reproduced three times this session, including once by
this session's own diagnostic probe: a fresh clean `tauri build` wrote a
1363-byte valid XML plist; the ad-hoc command
`plutil -extract CFBundleURLTypes json "$PL"` then replaced it with the
identical 115-byte corpse and printed nothing. That accidental
reproduction is the closing proof of the mechanism.

Hypotheses tested directly, per the supervisor note:

1. "bundle.macOS.infoPlist points at our own ATS merge file and corrupts
   the merge." REFUTED. tauri-cli 2.11.4 `src/interface/rust.rs:1650`
   merges `tauri/src-tauri/Info.plist` with the `infoPlist` field via
   `merge_plist` (a dictionary fold). tauri-bundler 2.9.4
   `src/bundle/macos/app.rs:299` inserts CFBundleURLTypes as a proper
   plist array, and line 366 writes the file with `to_file_xml` — XML,
   never JSON. A clean rebuild (this session, `IDLEFILL_BUILD_MARKER=
   gaterun bash build.sh`) produced a 1363-byte plist that lints OK and
   carries BOTH the scheme and the ATS merge. No config change was
   needed.
2. "stale/interrupted rebuild." REFUTED. `rm -rf target/{release,debug}/bundle`
   plus a fresh build reproduced a healthy plist every time. The
   corruption only ever followed a bare-json extract.

Fix: the guard stays, hardened. `tauri/build.sh`'s gate-4 block now uses
only the `raw` probe form (never rewrites the input), and it re-lints
the plist AFTER the extractions — "corrupted BY THE GATE CHECK itself"
fails the build instead of shipping the corpse. The block documents the
mechanism so a human re-check uses `-o -`.

## 2. Gates — actual output

### Gate 1 — cargo test (45 green)

```
test result: ok. 45 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

Test names (module::test, = the D9 pin map rows, section 3):

glance (glanceStatusRow + panelActionRows + sessions/staleness/state
port, 20 tests): status_row_no_token_names_the_config_path,
status_row_bad_token_names_the_config_path,
status_row_out_of_window_is_stopped, status_row_in_window_is_the_state_word,
action_rows_open_desktop_is_the_first_and_only_nav_row,
relaunch_item_is_exception_only, sessions_absent_or_empty_yield_no_facts,
sessions_count_line_buckets_and_exception_lines,
stale_session_counts_stale_not_active, paused_and_stale_show_both_words,
queued_gate_rides_the_one_liner_with_waiting_count,
malformed_gate_renders_as_before, state_word_no_clients_is_unreachable,
state_word_switch_order, active_lease_filter_ignores_terminal_rows,
daemon_running_matches_by_name, conn_from_http_status,
state_maps_to_overview, direct_views, everything_else_is_the_default_view —
the last three are `deeplink::tests`.

deeplink (D5 hashView map, 3 tests): state_maps_to_overview, direct_views,
everything_else_is_the_default_view, foreign_scheme_is_none.

config (client/config.json parse, 3 tests): config_full_parse,
config_empty_strings_are_none, config_missing_file_shape.

token (D3 initialization_script, 4 tests): script_shape_matches_the_swift_port,
script_escapes_special_characters, empty_and_missing_tokens_emit_no_script,
debug_never_prints_the_token.

lifecycle (D4 launchctl port, 16 tests): pid_line_running_dump_yields_the_pid,
pid_line_exited_but_loaded_is_none, pid_line_garbage_value_is_none,
pid_line_empty_dump_is_none, pid_line_zero_is_none,
remote_loopback_without_server_config_is_allowed,
remote_localhost_host_is_allowed, remote_server_config_present_allows_regardless,
remote_server_url_and_no_config_refuses, remote_unparseable_url_refuses,
first_argument_reads_the_arguments_block, first_argument_absent_block_is_none,
arbiter_plist_shape_mirrors_the_shipped_template,
daemon_plist_shape_mirrors_the_shipped_template,
test_plist_is_the_harmless_scratch_program,
bootout_noop_strings_match_launchd_reality, bootstrap_already_loaded_noop_matches.

### Gate 2 — clippy

```
$ cargo clippy -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 9.73s
```

Zero warnings.

### Gate 3 — build.sh marker + --version contract

```
$ IDLEFILL_BUILD_MARKER=plutil-fix bash tauri/build.sh
...
built: .../target/release/bundle/macos/Idlefill.app
idlefill plutil-fix
info.plist verified: URL scheme + ATS present

$ .../Idlefill.app/Contents/MacOS/idlefill-app --version
idlefill plutil-fix
```

Default marker is `dev` (pinned in build.sh:
`MARKER="${IDLEFILL_BUILD_MARKER:-dev}"`).

### Gate 4 — both bundles, scheme + ATS merge

Note the probe form: `json -o -` (stdout). A bare `json` would rewrite
the file — that is section 1.

```
== debug (1363 bytes before probes)
target/debug/.../Info.plist: OK
CFBundleURLTypes: [{"CFBundleTypeRole":"Editor","CFBundleURLName":"com.sam.idlefill.app idlefill","CFBundleURLSchemes":["idlefill"]}]
ATS: true                       # raw form; NSAllowsArbitraryLoads
bytes after probes: 1363  UNCHANGED by probes
== release (1363 bytes before probes)
target/release/.../Info.plist: OK
CFBundleURLTypes: [{"CFBundleTypeRole":"Editor","CFBundleURLName":"com.sam.idlefill.app idlefill","CFBundleURLSchemes":["idlefill"]}]
ATS: true
bytes after probes: 1363  UNCHANGED by probes
```

(`plutil -extract NSAppTransportSecurity json` errors "Invalid object in
plist for JSON format" for a nested dict — a plutil output-format limit,
not a plist defect. `raw` reads the boolean fine, and `plutil -lint`
passes.)

### Gate 5 — live acceptance re-run

Re-run was required: this session rebuilt the release bundle the harness
runs. `bash tauri/acceptance-test.sh`:

```
PASS scratch arbiter listens on 18790
PASS scratch arbiter answers /api/state with the scratch token
PASS PAGE_LOAD Finished on the scratch origin
PASS LAUNCHD edge loaded=1 running=1
PASS LAUNCHD edge running=0 (dead edge seen)
PASS AUTO_RELOAD fired exactly twice for two edges (got 2)
PASS real client/config.json byte-identical (md5)
PASS production arbiter label still loaded
PASS production arbiter still answers 8787
ACCEPTANCE-ALL-PASS
```

Proof lines from the app's own log show two full dead→live cycles
(live 1 → dead → live 2 with one AUTO_RELOAD each). Scratch label
`com.sam.idlefill.app70test.server`, scratch port 18790, scratch token
generated per run (never printed). The production arbiter was never
kickstarted. The real `client/config.json` md5 was byte-identical
before/after (harness assertion above).

Install harness re-run (Q-d script, unchanged this session, proven
again): `bash tauri/install-test.sh` → `INSTALL-TEST-ALL-PASS` (26
checks; real labels untouched; the real app label never installed).

### Gate 6 — scope proof

`git show --stat` per commit shows only `tauri/**` and
`docs/reports/ISSUE70-REPORT.md`. See section 5.

## 3. D9 retirement pin map

Every retired-Swift behavior → the cargo test that now pins it, or the
honest row.

| Retired Swift behavior (harness) | Replacement |
|---|---|
| pid-line liveness parse (`desktop/arbiter-test.sh`, e737411) | `lifecycle::pid_line_running_dump_yields_the_pid`, `pid_line_exited_but_loaded_is_none`, `pid_line_garbage_value_is_none`, `pid_line_empty_dump_is_none`, `pid_line_zero_is_none` |
| remote-vs-loopback rule (`arbiter-test.sh`) | `lifecycle::remote_loopback_without_server_config_is_allowed`, `remote_localhost_host_is_allowed`, `remote_server_config_present_allows_regardless`, `remote_server_url_and_no_config_refuses`, `remote_unparseable_url_refuses` |
| rendered-plist shape / "no token ever" (`arbiter-test.sh`) | `lifecycle::arbiter_plist_shape_mirrors_the_shipped_template`, `daemon_plist_shape_mirrors_the_shipped_template`, `test_plist_is_the_harmless_scratch_program` |
| bootstrap/bootout/kickstart no-op strings (`arbiter-test.sh`) | `lifecycle::bootout_noop_strings_match_launchd_reality`, `bootstrap_already_loaded_noop_matches`; live scratch-label cycle proven by `tauri/acceptance-test.sh` + `tauri/install-test.sh` |
| glance status row (`menubar/panel-test.sh` `glanceStatusRow`) | `glance::status_row_no_token_names_the_config_path`, `status_row_bad_token_names_the_config_path`, `status_row_out_of_window_is_stopped`, `status_row_in_window_is_the_state_word`, `state_word_no_clients_is_unreachable`, `state_word_switch_order` |
| panel action rows minus the update row (`panel-test.sh` `panelActionRows`, `desktopRowTag`) | `glance::action_rows_open_desktop_is_the_first_and_only_nav_row`, `relaunch_item_is_exception_only` (exception-only replaces the desktopRowTag pair) |
| sessions-at-a-glance rows (`menubar/sessions-test.sh`) | `glance::sessions_absent_or_empty_yield_no_facts`, `sessions_count_line_buckets_and_exception_lines`, `stale_session_counts_stale_not_active`, `paused_and_stale_show_both_words`, `queued_gate_rides_the_one_liner_with_waiting_count`, `malformed_gate_renders_as_before` |
| code-staleness tag (`menubar/staleness-test.sh`) | `glance::daemon_running_matches_by_name` (name-match rule kept); the behind-release note: no replacement — the update plane retires (Q-b) |
| lease / count lines (`panel-test.sh` aggregates) | `glance::active_lease_filter_ignores_terminal_rows`, `conn_from_http_status` |
| token injection script (`desktop` WKUserScript pin, #61 (i)) | `token::script_shape_matches_the_swift_port`, `script_escapes_special_characters`, `empty_and_missing_tokens_emit_no_script`, `debug_never_prints_the_token` |
| `client/config.json` parse (both shells' config readers) | `config::config_full_parse`, `config_empty_strings_are_none`, `config_missing_file_shape` |
| deep-link `idlefill://` view map (`desktop` hashView routing) | `deeplink::state_maps_to_overview`, `direct_views`, `everything_else_is_the_default_view`, `foreign_scheme_is_none` + built-bundle plist proof (gate 4) |
| `menubar/uc-test.sh`, `uc-update-test.sh`, `edge-test.sh`, `desktop/edge-test.sh` | No replacement — the whole update plane retires (Q-b LOCKED). The `--version` marker survives (gate 3) |
| `menubar/install-test.sh` (menubar install) | `tauri/install-test.sh` (26 checks, scratch label) ports the render-before-bootout + refusal discipline for the ONE app label (Q-d) |
| `menubar/scope-test.sh` | — (already retired at #61 step 4) |

## 4. Honest degradations + deferred items

- Glance = borderless positioned window, not NSPopover (D5 rule 5).
  Blur-dismiss replaces click-outside. Pinned fallback (plain tray menu)
  was NOT taken; the window approach shipped.
- The Swift toolbar/`Update Code`/update rows retire by lock (Q-b). The
  tray menu is: glance, Open Desktop, Settings, Quit, plus the
  exception-only stopped word + Relaunch arbiter item.
- Deep-link functional round-trip is DEFERRED to the cutover commit.
  The wave does not register `idlefill://` (the live Swift desktop keeps
  the claim). Evidence: the built bundle carries the scheme in
  CFBundleURLTypes (gate 4) and the hashView map is pinned in Rust
  (gate 1). The cutover step is registration + one round-trip on the
  real label.
- CI gates are NOT flipped in this wave. `test.yml` / `edge.yml` /
  `release.yml` keep the `swiftc -parse` gates. The flip (cargo fmt +
  clippy + test per D9) lands at the owner-gated deletion commit, when
  `desktop/` + `menubar/` retire. Stated per the brief fence.
- `cargo fmt --check` is part of the FUTURE CI gate (D9). Not run as a
  wave gate; listed for the deletion commit so the flip is not a
  surprise.
- No LaunchAgent install against any real label (wave fence).
  `com.sam.idlefill.app` stays unloaded on this machine; Q-d install is a
  cutover step.

## 5. Commits (this session)

- `tauri/build.sh` — gate-4 block kept, hardened, documented (the
  section-1 root cause + guard-the-guard re-lint).
- `docs: #70 report` — this file.

`git show --stat` output for each commit is pasted in the dispatch
completion; every touched path is inside `tauri/**` or this report. The
untracked `client/src/logs/` (live daemon output) was never added.
