#!/usr/bin/env bash
# Headless test for the sessions-at-a-glance rows (issue #9): compile the
# REAL source (minus @main) + a driver, run under env -i (the GUI
# environment) — the same harness pattern as panel-test.sh / uc-test.sh
# (scope-test.sh retired with the scope pickers, #61 step 4).
#
# What is proven (canned /api/state payloads through the PURE
# ScopeView.project projection — the exact read site the panel renders):
#   (a) NO sessions key / empty sessions[] -> NO sessions fact at all
#       (sessionsCountLine nil, no rows — Exception-Only rule).
#   (b) 2 active + 1 paused -> count line "2 active, 1 paused"; ONLY the
#       paused session gets an exception one-liner (healthy = no row).
#   (c) stale (last_seen 2h ago, no override) -> tagged stale (the 90s
#       daemonRunning precedent), counted as stale, NOT active.
#   (d) override label rendering: pause -> "paused", force -> "forced";
#       paused AND stale -> both words on the one-liner.
#   (e) client_name shown when present; token prefix when absent.
#   (g) gate-state (#40): queued rides the exception one-liner (with the
#       waiting count when >1); paused+queued and queued+stale show both;
#       absent/null/malformed gate (old arbiter) renders exactly as before.
#   Plus: the single write site — AppModel.injectStatePayload (the real
#   poll path's apply()) lands sessions/sessionsCountLine on the model,
#   and an empty payload clears them.
#
# Nothing networked: the scratch config points server_url at a closed
# loopback port and the update base at a dead port (IDLEFILL_UPDATE_BASE).
set -euo pipefail
T="$(mktemp -d /tmp/sessions-test.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/menubar/IdlefillMenubar.swift"

echo "==> workdir: $T"

# ---- scratch repo (IDLEFILL_CONFIG_FILE points here) -----------------------
mkdir -p "$T/repo/client"
cat > "$T/repo/package.json" <<'EOF'
{ "name": "idlefill-scratch", "version": "0.1.0" }
EOF

# ---- compile the REAL source (minus @main) + the driver --------------------
sed '/^@main$/,/^}$/d' "$SRC" > "$T/menubar-under-test.swift"
if grep -q '@main' "$T/menubar-under-test.swift"; then echo "error: @main survived the strip"; exit 1; fi
grep -q 'struct ScopeSession' "$T/menubar-under-test.swift" || { echo "error: ScopeSession lost in the strip"; exit 1; }
grep -q 'static func project' "$T/menubar-under-test.swift" || { echo "error: ScopeView.project lost in the strip"; exit 1; }

cat > "$T/main.swift" <<'EOF'
import Foundation
import SwiftUI

var failures = 0
func check(_ name: String, _ cond: Bool) {
  if cond { print("PASS \(name)") } else { failures += 1; print("FAIL \(name)") }
}

// Fixed clock: every fixture is relative to NOW (epoch-ms, the arbiter's
// unit). 2025-09-27T16:00:00Z — any fixed instant works; the stale verdict
// only compares differences.
let NOW: Double = 1_759_000_000_000

// Canned payloads go through a JSON round-trip so the projection sees the
// EXACT value shapes the poll delivers (JSONSerialization boxes numbers as
// NSNumber, nulls as NSNull — a hand-built Swift dict would hide cast bugs).
func payload(_ json: String) -> [String: Any] {
  guard let d = json.data(using: .utf8),
        let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
    fatalError("bad fixture json")
  }
  return o
}

// The pure projection, "all machines / all projects" (sessions are global
// interactive traffic — the machine picker never narrows them).
func proj(_ json: String) -> ScopeView.Result {
  ScopeView.project(payload: payload(json), configName: nil,
                    selectedMachine: ScopeView.allMachinesKey,
                    selectedProject: ScopeView.allProjectsKey,
                    nowMs: NOW)
}

// ==========================================================================
// (a) no sessions key / empty array -> NO sessions fact at all
// ==========================================================================
let vNoKey = proj("{ \"clients\": [], \"projects\": [] }")
check("(a) no sessions key: sessions empty", vNoKey.sessions.isEmpty)
check("(a) no sessions key: count line nil (block hidden)", vNoKey.sessionsCountLine == nil)

let vEmpty = proj("{ \"sessions\": [] }")
check("(a) empty sessions[]: sessions empty", vEmpty.sessions.isEmpty)
check("(a) empty sessions[]: count line nil (block hidden)", vEmpty.sessionsCountLine == nil)

// A row with an empty/missing token is junk the projection drops (it can
// never be named or acted on) — it must not mint a phantom count.
let vJunk = proj("{ \"sessions\": [ { \"last_seen\": \(Int(NOW)) } ] }")
check("(a) tokenless row dropped", vJunk.sessions.isEmpty && vJunk.sessionsCountLine == nil)

// ==========================================================================
// (b) 2 active + 1 paused -> count correct, ONLY paused gets a one-liner
// ==========================================================================
let vMix = proj("""
{ "sessions": [
  { "token": "tokhealthy1", "registered_at": \(Int(NOW) - 5000), "last_seen": \(Int(NOW) - 10_000), "last_activity": \(Int(NOW) - 10_000), "override": null },
  { "token": "tokhealthy2", "client_name": "mac-sam", "registered_at": \(Int(NOW) - 4000), "last_seen": \(Int(NOW) - 30_000), "override": null },
  { "token": "tokpaused1", "client_name": "mac-kitchen", "registered_at": \(Int(NOW) - 3000), "last_seen": \(Int(NOW) - 5_000),
    "override": { "token": "tokpaused1", "override": "pause", "until": null, "set_at": \(Int(NOW) - 2_000) } }
] }
""")
check("(b) 3 sessions projected", vMix.sessions.count == 3)
check("(b) count line '2 active, 1 paused'", vMix.sessionsCountLine == "2 active, 1 paused")
let linesB = vMix.sessions.compactMap(\.exceptionLine)
check("(b) exactly ONE one-liner (healthy sessions render no row)", linesB.count == 1)
check("(b) the one-liner is the paused session's",
      linesB.first == "mac-kitchen · paused")
check("(b) healthy sessions carry no exception line",
      vMix.sessions.filter { $0.exceptionLine == nil }.count == 2)
check("(b) healthy sessions not stale", vMix.sessions.filter(\.stale).isEmpty)

// ==========================================================================
// (c) stale (last_seen 2h ago) -> tagged stale, counted stale not active
// ==========================================================================
let vStale = proj("""
{ "sessions": [
  { "token": "tokstale01", "client_name": "mac-old", "registered_at": \(Int(NOW) - 7_200_000), "last_seen": \(Int(NOW) - 7_200_000), "override": null }
] }
""")
check("(c) stale session projected", vStale.sessions.count == 1)
check("(c) stale flag set (2h > 90s window)", vStale.sessions.first?.stale == true)
check("(c) one-liner tagged stale", vStale.sessions.first?.exceptionLine == "mac-old · stale")
check("(c) count line counts it stale, not active", vStale.sessionsCountLine == "1 stale")
// The 90s precedent boundary: 89s ago is NOT stale, 91s ago IS.
let vEdge = proj("""
{ "sessions": [
  { "token": "tokfresh001", "last_seen": \(Int(NOW) - 89_000), "override": null },
  { "token": "tokjustgone", "last_seen": \(Int(NOW) - 91_000), "override": null }
] }
""")
check("(c) 89s ago not stale / 91s ago stale",
      vEdge.sessions.first(where: { $0.token == "tokfresh001" })?.stale == false
      && vEdge.sessions.first(where: { $0.token == "tokjustgone" })?.stale == true)
check("(c) boundary count '1 active, 1 stale'", vEdge.sessionsCountLine == "1 active, 1 stale")

// ==========================================================================
// (d) override label rendering (pause / force; paused+stale shows both)
// ==========================================================================
let vOv = proj("""
{ "sessions": [
  { "token": "tokforce01", "client_name": "mac-forced", "last_seen": \(Int(NOW) - 5_000),
    "override": { "token": "tokforce01", "override": "force", "until": \(Int(NOW) + 60_000), "set_at": \(Int(NOW) - 1_000) } },
  { "token": "tokpstale1", "client_name": "mac-paused-stale", "last_seen": \(Int(NOW) - 7_200_000),
    "override": { "token": "tokpstale1", "override": "pause", "until": null, "set_at": \(Int(NOW) - 7_000_000) } }
] }
""")
check("(d) force -> overrideLabel 'force' + 'forced' one-liner",
      vOv.sessions.first(where: { $0.token == "tokforce01" })?.overrideLabel == "force"
      && vOv.sessions.first(where: { $0.token == "tokforce01" })?.exceptionLine == "mac-forced · forced")
check("(d) paused AND stale -> both words",
      vOv.sessions.first(where: { $0.token == "tokpstale1" })?.exceptionLine == "mac-paused-stale · paused · stale")
// Buckets are mutually exclusive (each session counts once: pause/force
// override wins over the stale verdict), joined active,paused,forced,stale.
check("(d) count line '1 paused, 1 forced'", vOv.sessionsCountLine == "1 paused, 1 forced")
// An unknown override word is not a label (defensive: only pause|force render).
let vBogus = proj("""
{ "sessions": [
  { "token": "tokbogus01", "last_seen": \(Int(NOW) - 5_000),
    "override": { "token": "tokbogus01", "override": "sideways", "until": null, "set_at": \(Int(NOW)) } }
] }
""")
check("(d) unknown override word -> no label, healthy (no row)",
      vBogus.sessions.first?.overrideLabel == nil
      && vBogus.sessions.first?.exceptionLine == nil
      && vBogus.sessionsCountLine == "1 active")

// ==========================================================================
// (e) client_name shown when present; token prefix when absent
// ==========================================================================
let vWho = proj("""
{ "sessions": [
  { "token": "abcdefghij2345", "client_name": "mac-named", "last_seen": \(Int(NOW) - 7_200_000), "override": null },
  { "token": "xyzw9876qpon", "last_seen": \(Int(NOW) - 7_200_000), "override": null },
  { "token": "emptyname0000", "client_name": "", "last_seen": \(Int(NOW) - 7_200_000), "override": null }
] }
""")
check("(e) client_name shown in the one-liner",
      vWho.sessions.first(where: { $0.token == "abcdefghij2345" })?.exceptionLine == "mac-named · stale")
check("(e) no client_name -> short token prefix names the row",
      vWho.sessions.first(where: { $0.token == "xyzw9876qpon" })?.exceptionLine == "xyzw9876… · stale")
check("(e) empty client_name treated as absent",
      vWho.sessions.first(where: { $0.token == "emptyname0000" })?.exceptionLine == "emptynam… · stale")
check("(e) clientName carried on the projection",
      vWho.sessions.first(where: { $0.token == "abcdefghij2345" })?.clientName == "mac-named"
      && vWho.sessions.first(where: { $0.token == "xyzw9876qpon" })?.clientName == nil)
// last_activity carried (0 -> nil, the arbiter's "none yet" encoding).
check("(e) lastActivity absent -> nil",
      vWho.sessions.first(where: { $0.token == "abcdefghij2345" })?.lastActivity == nil)
let vAct = proj("""
{ "sessions": [
  { "token": "actzero00000", "last_seen": \(Int(NOW) - 5_000), "last_activity": 0, "override": null },
  { "token": "actreal00000", "last_seen": \(Int(NOW) - 5_000), "last_activity": \(Int(NOW) - 4_000), "override": null }
] }
""")
check("(e) lastActivity 0 -> nil",
      vAct.sessions.first(where: { $0.token == "actzero00000" })?.lastActivity == nil)
check("(e) lastActivity real value carried",
      vAct.sessions.first(where: { $0.token == "actreal00000" })?.lastActivity == NOW - 4_000)

// ==========================================================================
// (g) gate-state (#40): the router's parked-request block rides the row.
//     queued is an ADDITIONAL exception fact (like stale) — the count
//     buckets are unchanged (queued-but-healthy still counts active).
//     Absent / null / malformed gate (old arbiter) renders as before.
// ==========================================================================
let vGate = proj("""
{ "sessions": [
  { "token": "gq1aaaaaaaa", "client_name": "mac-q", "last_seen": \(Int(NOW) - 5_000), "override": null,
    "gate": { "state": "queued", "waiting": 1 } },
  { "token": "gq3aaaaaaaa", "client_name": "mac-q3", "last_seen": \(Int(NOW) - 5_000), "override": null,
    "gate": { "state": "queued", "waiting": 3 } },
  { "token": "gactiveaaaa", "client_name": "mac-a", "last_seen": \(Int(NOW) - 5_000), "override": null,
    "gate": { "state": "active", "waiting": 2 } }
] }
""")
check("(g) queued waiting=1 -> 'queued' one-liner",
      vGate.sessions.first(where: { $0.token == "gq1aaaaaaaa" })?.exceptionLine == "mac-q · queued")
check("(g) queued waiting=3 -> 'queued · 3 waiting'",
      vGate.sessions.first(where: { $0.token == "gq3aaaaaaaa" })?.exceptionLine == "mac-q3 · queued · 3 waiting")
check("(g) active gate is not an exception (no row)",
      vGate.sessions.first(where: { $0.token == "gactiveaaaa" })?.exceptionLine == nil
      && vGate.sessions.first(where: { $0.token == "gactiveaaaa" })?.queued == false)
check("(g) queued fields carried on the projection",
      vGate.sessions.first(where: { $0.token == "gq3aaaaaaaa" })?.queued == true
      && vGate.sessions.first(where: { $0.token == "gq3aaaaaaaa" })?.waitingCount == 3
      && vGate.sessions.first(where: { $0.token == "gq1aaaaaaaa" })?.waitingCount == 0)
// queued does NOT change the count buckets (still active, not its own bucket).
check("(g) count line unaffected by queued", vGate.sessionsCountLine == "3 active")
// paused + queued shows BOTH words (override first, like the desktop row).
let vGateOv = proj("""
{ "sessions": [
  { "token": "gpqaaaaaaaaa", "client_name": "mac-pq", "last_seen": \(Int(NOW) - 5_000),
    "override": { "token": "gpqaaaaaaaaa", "override": "pause", "until": null, "set_at": \(Int(NOW) - 1_000) },
    "gate": { "state": "queued", "waiting": 2 } }
] }
""")
check("(g) paused AND queued -> both words",
      vGateOv.sessions.first?.exceptionLine == "mac-pq · paused · queued · 2 waiting")
// queued + stale shows both too.
let vGateStale = proj("""
{ "sessions": [
  { "token": "gstaaaaaaaaa", "client_name": "mac-gs", "last_seen": \(Int(NOW) - 7_200_000), "override": null,
    "gate": { "state": "queued", "waiting": 1 } }
] }
""")
check("(g) queued AND stale -> both words",
      vGateStale.sessions.first?.exceptionLine == "mac-gs · queued · stale")
// Back-compat: absent key, null, and malformed blocks all render as before.
let vGateOld = proj("""
{ "sessions": [
  { "token": "gabsaaaaaaaa", "client_name": "mac-abs", "last_seen": \(Int(NOW) - 5_000), "override": null },
  { "token": "gnullaaaaaaa", "client_name": "mac-null", "last_seen": \(Int(NOW) - 5_000), "override": null,
    "gate": null },
  { "token": "gbadaaaaaaaa", "client_name": "mac-bad", "last_seen": \(Int(NOW) - 5_000), "override": null,
    "gate": { "state": "sideways", "waiting": 1 } },
  { "token": "gbad2aaaaaaa", "client_name": "mac-bad2", "last_seen": \(Int(NOW) - 5_000), "override": null,
    "gate": "not-an-object" }
] }
""")
check("(g) absent gate -> no tag, healthy",
      vGateOld.sessions.first(where: { $0.token == "gabsaaaaaaaa" })?.queued == false
      && vGateOld.sessions.first(where: { $0.token == "gabsaaaaaaaa" })?.exceptionLine == nil)
check("(g) null gate (idle report) -> no tag",
      vGateOld.sessions.first(where: { $0.token == "gnullaaaaaaa" })?.queued == false)
check("(g) malformed gate block -> treated as absent",
      vGateOld.sessions.first(where: { $0.token == "gbadaaaaaaaa" })?.queued == false
      && vGateOld.sessions.first(where: { $0.token == "gbad2aaaaaaa" })?.queued == false)
check("(g) old-arbiter payload count line unchanged", vGateOld.sessionsCountLine == "4 active")

// ==========================================================================
// (f) the single write site: the REAL poll path (apply -> applyProjection)
//     lands the projection on the model; an empty payload clears it.
//     apply() computes nowMs from Date() — fixtures here ride the LIVE
//     clock so the fresh session is fresh for the model too.
// ==========================================================================
try? """
{ "server_url": "http://127.0.0.1:1", "client_name": "sessions-test" }
""".write(toFile: "__REPO__/client/config.json", atomically: true, encoding: .utf8)
let liveNow = Date().timeIntervalSince1970 * 1000
let m = AppModel()
m.injectStatePayload(payload("""
{ "sessions": [
  { "token": "tokmodel001", "client_name": "mac-live", "last_seen": \(Int(liveNow) - 5_000), "override": null },
  { "token": "tokmodel002", "client_name": "mac-live", "last_seen": \(Int(liveNow) - 7_200_000), "override": null }
] }
"""))
check("(f) model.sessions populated by applyProjection", m.sessions.count == 2)
check("(f) model.sessionsCountLine set", m.sessionsCountLine == "1 active, 1 stale")
check("(f) stale one-liner reaches the model",
      m.sessions.compactMap(\.exceptionLine) == ["mac-live · stale"])
m.injectStatePayload(payload("{ \"sessions\": [] }"))
check("(f) empty payload clears model.sessions", m.sessions.isEmpty)
check("(f) empty payload clears the count line", m.sessionsCountLine == nil)

if failures > 0 {
  print("SESSIONS-FAILURES \(failures)")
  exit(1)
}
print("SESSIONS-ALL-PASS")
exit(0)
EOF

sed -e "s|__REPO__|$T/repo|g" "$T/main.swift" > "$T/main.baked.swift"
mv "$T/main.baked.swift" "$T/main.swift"

echo "==> swiftc (real source minus @main + driver)"
swiftc -O \
  -o "$T/sessions-test" \
  "$T/menubar-under-test.swift" "$T/main.swift" \
  -framework AppKit -framework SwiftUI 2>&1 | grep -E "error:" || true
[ -x "$T/sessions-test" ] || { echo "error: driver did not build"; exit 1; }

echo "==> run (env -i, the GUI environment)"
RC=0
env -i PATH=/usr/bin:/bin \
  IDLEFILL_CONFIG_FILE="$T/repo/client/config.json" \
  IDLEFILL_UPDATE_BASE="http://127.0.0.1:1" \
  "$T/sessions-test" || RC=$?
echo "SESSIONS-EXIT=$RC"
exit $RC
