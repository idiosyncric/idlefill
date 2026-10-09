# Issue #46 — Slice 2, the signal path: in-session hold signal (build report, 2026-10-09)

**Scope.** The design's OPEN DECISIONS are the boundary. This slice ships the parts that
need no decision: the in-session signal on the plugin path. It deliberately ships only
the signal path — the hold cap on paused holds, the pause-period aging rule, the
turn-interrupt verb, and the `hold_kind` key's final name (and channel) are owner
decisions and are not touched here.

**What landed.** `plugins/hermes-idlefill/__init__.py` (the #42 slice-1 plugin, unchanged
elsewhere): when the gate holds a call (`queued` or `paused`), the plugin now records the
hold's first report and its clock instant. At the end of the hold it writes ONE
exception-only line to its own log: the reason (the gate's state word) and the measured
hold length in whole seconds, e.g. `held by idlefill gate (queued, 31s)`. Absent data
renders nothing: no hold, no line. A duration is never fabricated and never a fake zero
(`max(0, …)` guards only the clock direction). The token never appears in the line. A
daemon down mid-hold or a malformed state ends the hold with no line (fail-open, the
#42 posture). The plugin resolves its log through a module attribute, so tests observe
it with no real stderr. `hold_kind` is not used: the gate's `/gate/state` body carries
only `state` + `position` (the #42 slice-2 contract), so the reason is the state word and
the duration is the plugin's own measurement. The `hold_kind` key is marked PROPOSED in
the design doc (its name and channel stay the owner's call, open decision 5).

**Tests (real output, 2026-10-09).** `python3 -m unittest plugins/hermes-idlefill/test_plugin.py -v`:
**17/17 OK** (12 pre-existing + 5 new): `test_queued_hold_emits_one_signal_line` (one line
per hold episode, the token absent), `test_paused_hold_emits_one_signal_line`,
`test_armed_session_emits_no_signal_line`, `test_unreachable_emits_no_line_and_still_admits`
(fail-open: admitted, no line), `test_malformed_state_emits_no_line_and_never_raises`.

**Nothing else broke.** `NODE_ENV=test npm run test` (root, all workspaces): server
**331/331**, client **177/177**, career-ops **17/17**, noop **2/2**, shell-ui **3/3**,
dashboard **4/4**, fleet **14/14** — exit 0. `NODE_ENV=test npx tsc --noEmit -p
client/tsconfig.json`: clean. One note: a fresh worktree has no `node_modules`, and
`version-handshake.test.ts` spawns `node_modules/.bin/tsx` literally — one pre-existing
client failure there, identical with this diff stashed, gone with dependencies installed.

**Open decisions (all five, from the design doc, remain unanswered).**
1. Does the hold cap apply to paused holds, or only to queued holds?
2. Confirm the pause-period rule (pause does not feed the aging clock; unpause re-anchors).
3. Which path ships the signal — the native plugin or a router observer hook? This slice
   builds the native-plugin path; the channel choice stays open.
4. Scope of the turn interrupt (fence out of slice 2, or wait on a Hermes verb)?
5. Name and channel of the `hold_kind` ADD key.

No push, no merge: branch `issue-46-signal`.
