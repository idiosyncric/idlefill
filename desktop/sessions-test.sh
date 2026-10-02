#!/usr/bin/env bash
# Headless test for the desktop app's sessions tab: compile the REAL
# source (minus @main) + a driver, run under env -i (the GUI environment)
# with a scratch repo — the same harness pattern as menubar/sessions-test.sh
# and desktop/edge-test.sh.
#
# What is proven (canned /api/state payloads through the PURE
# SessionsView.project — the exact read site the panel renders — plus the
# REAL model write path against a local arbiter stub):
#   (a) no sessions key / empty sessions[] -> NO rows (the panel renders
#       its quiet empty state; the tokenless junk row is dropped).
#   (b) state words on a FIXED clock per the dashboard's windows:
#       Paused (override) > Active (online + request <30s) > Idle,
#       including the 30s and 90s boundaries.
#   (c) stale (heartbeat >=90s) is a TAG + dim, NOT a state word — the
#       word stays Idle (or Paused under an override).
#   (d) the gate button title per row: Pause on a running row, Resume on
#       a paused row.
#   (e) the write site's WIRE SHAPE, built by the pure
#       SessionsView.overrideRequest: POST <server>/api/sessions/<enc
#       token>/override, body {"override":"pause"} / {"override":null},
#       Authorization: Bearer <arbiter token> — the arbiter token appears
#       in the HEADER and NOWHERE in the URL; the session token is
#       percent-encoded in the path.
#   (f) the REAL model path: setSessionOverride flips the row optimistically
#       and marks it in-flight (per-row disable); against the stub a
#       successful pause STANDS (note cleared, the stub received the exact
#       wire shape with the token only in the header); a resume sends
#       {"override":null}; a 404 (unknown_session) REVERTS the row, sets
#       the one-line note, and RE-POLLS (the stub's /api/state rows land);
#       a DEAD port reverts with the unreachable note.
#
# Nothing touches the network beyond 127.0.0.1 (the stub + a closed port).
set -euo pipefail
T="$(mktemp -d /tmp/sessions-dt-test.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/desktop/IdlefillDesktop.swift"
VENDOR="$REPO/desktop/vendor/sparkle"

echo "==> workdir: $T"

# ---- scratch repo (IDLEFILL_REPO_PATH points here) -------------------------
# Run 1's config points server_url at the STUB (the live write-path cases);
# run 2's (--deadport) at a CLOSED port (the offline contract). The token
# is a fixture — it never leaves this scratch dir.
mkdir -p "$T/repo/client" "$T/home"
printf '{ "name": "idlefill-scratch", "version": "0.1.0" }\n' > "$T/repo/package.json"

# ---- the arbiter stub (node): override routes + a /api/state re-poll ------
PORT=$(node -e "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
cat > "$T/stub.js" <<EOF
const http = require('http');
const fs = require('fs');
const LOG = '$T/stub.log';
fs.writeFileSync(LOG, '');
// The session the stub KNOWS (the 200 case). An override POST to any
// other token answers the live arbiter's exact 404 (unknown_session).
// The stub tracks the override the way the arbiter does: the POST sets it,
// /api/state reflects it — so a background poll can never race the test's
// own injected rows out of the paused state the write just proved.
let ov = null;
const KNOWN = 'tokstub001';
const server = http.createServer((req, res) => {
  const u = req.url || '';
  if (req.method === 'GET' && u.startsWith('/api/state')) {
    // The re-poll truth: exactly ONE session, fresh heartbeat, override as
    // last set through this stub.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      now: Date.now(),
      clients: [],
      sessions: [{ token: KNOWN, client_name: 'stub-router', registered_at: Date.now() - 5000,
                   last_seen: Date.now(), last_activity: null,
                   override: ov ? { token: KNOWN, override: ov, until: null, set_at: Date.now() } : null }]
    }));
    return;
  }
  const m = u.match(/^\\/api\\/sessions\\/([^/]+)\\/override$/);
  if (req.method === 'POST' && m) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      fs.appendFileSync(LOG, JSON.stringify({
        path: u, token_seg: decodeURIComponent(m[1]),
        auth: req.headers['authorization'] || '',
        ctype: req.headers['content-type'] || '',
        body
      }) + '\n');
      if (decodeURIComponent(m[1]) === KNOWN) {
        try { ov = JSON.parse(body).override; } catch { ov = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, override: ov }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown_session' }));
      }
      return;
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});
server.listen($PORT, '127.0.0.1', () => console.log('STUB-UP ' + $PORT));
setTimeout(() => process.exit(0), 180000);
EOF
node "$T/stub.js" > "$T/stub.out" 2>&1 &
STUB_PID=$!
trap 'kill $STUB_PID 2>/dev/null || true; rm -rf "$T"' EXIT
for i in $(seq 1 50); do
  grep -q "STUB-UP" "$T/stub.out" 2>/dev/null && break
  sleep 0.2
done
grep -q "STUB-UP" "$T/stub.out" || { echo "STUB never came up:"; cat "$T/stub.out"; exit 1; }
echo "==> stub on 127.0.0.1:$PORT (pid $STUB_PID)"

# The configs are baked with the real port. Run 1's repo points at the
# stub; run 2 (--deadport) uses a second scratch repo whose server_url is
# a CLOSED port (the offline contract).
mkdir -p "$T/repo-dead/client"
printf '{ "server_url": "http://127.0.0.1:%s", "client_name": "sessions-dt-test", "token": "arbiter-fixture-token" }\n' "$PORT" > "$T/repo/client/config.json"
printf '{ "server_url": "http://127.0.0.1:1", "client_name": "sessions-dt-test", "token": "arbiter-fixture-token" }\n' > "$T/repo-dead/client/config.json"

# ---- compile the REAL source (minus @main) + the driver --------------------
sed '/^@main$/,/^}$/d' "$SRC" > "$T/desktop-under-test.swift"
if grep -q '@main' "$T/desktop-under-test.swift"; then echo "error: @main survived the strip"; exit 1; fi
grep -q 'struct IdlefillApp: App' "$T/desktop-under-test.swift" || { echo "error: IdlefillApp lost in the strip"; exit 1; }
grep -q 'struct SessionRow' "$T/desktop-under-test.swift" || { echo "error: SessionRow lost in the strip"; exit 1; }
grep -q 'static func project' "$T/desktop-under-test.swift" || { echo "error: SessionsView.project lost in the strip"; exit 1; }
grep -q 'static func overrideRequest' "$T/desktop-under-test.swift" || { echo "error: SessionsView.overrideRequest lost in the strip"; exit 1; }
grep -q 'func setSessionOverride' "$T/desktop-under-test.swift" || { echo "error: setSessionOverride lost in the strip"; exit 1; }
grep -q 'func injectStatePayload' "$T/desktop-under-test.swift" || { echo "error: injectStatePayload lost in the strip"; exit 1; }
# The UI controls exist in the source (the visual render is the eyeball pass).
grep -q 'SessionsPanel(m: m)' "$T/desktop-under-test.swift" || { echo "error: the sessions tab is not wired into ContentView"; exit 1; }
grep -q 'case "sessions": return .sessions' "$T/desktop-under-test.swift" || { echo "error: the sessions deep-link host is missing"; exit 1; }

cat > "$T/main.swift" <<'EOF'
import Foundation
import SwiftUI

var failures = 0
func check(_ name: String, _ cond: Bool) {
  if cond { print("PASS \(name)") } else { failures += 1; print("FAIL \(name)") }
}

// Fixed clock for the PURE projection cases: every fixture is relative to
// NOW (epoch-ms, the arbiter's unit). The stale/active verdicts only
// compare differences, so any fixed instant works.
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
func proj(_ json: String) -> [SessionRow] {
  SessionsView.project(payload: payload(json), nowMs: NOW)
}
func row(_ rows: [SessionRow], _ tok: String) -> SessionRow? {
  rows.first { $0.token == tok }
}

if CommandLine.arguments.contains("--deadport") {
  // ========================================================================
  // (f2) the DEAD-port contract: the optimistic flip REVERTS with the
  //      unreachable note (server_url points at a closed port).
  // ========================================================================
  let liveNow = Date().timeIntervalSince1970 * 1000
  let m = AppModel()
  m.injectStatePayload(payload("""
  { "sessions": [
    { "token": "tokdead001", "client_name": "mac-x", "last_seen": \(Int(liveNow) - 5_000), "override": null }
  ] }
  """))
  check("(f2) dead run: row projected", m.sessions.count == 1 && m.sessions[0].actionTitle == "Pause")
  m.setSessionOverride(sessionToken: "tokdead001", paused: true)
  check("(f2) optimistic flip lands before the response",
        m.sessions.first?.stateWord == "Paused" && m.pendingSessionTokens.contains("tokdead001"))
  for _ in 0..<50 {
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    if m.pendingSessionTokens.isEmpty { break }
  }
  check("(f2) dead port: row REVERTED (not paused)", m.sessions.first?.paused == false)
  check("(f2) dead port: the unreachable note is set",
        m.sessionsNote?.contains("could not reach") == true)
  check("(f2) in-flight flag cleared", m.pendingSessionTokens.isEmpty)
  if failures > 0 { print("SESSIONS-DT-FAILURES \(failures)"); exit(1) }
  print("SESSIONS-DT-DEAD-ALL-PASS")
  exit(0)
}

// ==========================================================================
// (a) no sessions key / empty array -> NO rows (the panel's empty state)
// ==========================================================================
check("(a) no sessions key: no rows", proj("{ \"clients\": [], \"projects\": [] }").isEmpty)
check("(a) empty sessions[]: no rows", proj("{ \"sessions\": [] }").isEmpty)
// A row with an empty/missing token is junk the projection drops (it can
// never be named or acted on).
check("(a) tokenless row dropped", proj("{ \"sessions\": [ { \"last_seen\": \(Int(NOW)) } ] }").isEmpty)

// ==========================================================================
// (b) state words per the 30s/90s windows (fixed clock)
// ==========================================================================
let vWords = proj("""
{ "sessions": [
  { "token": "tokactive01", "last_seen": \(Int(NOW) - 10_000), "last_activity": \(Int(NOW) - 10_000), "override": null },
  { "token": "tokidle0001", "last_seen": \(Int(NOW) - 10_000), "last_activity": \(Int(NOW) - 31_000), "override": null },
  { "token": "tokidle0002", "last_seen": \(Int(NOW) - 10_000), "last_activity": null, "override": null },
  { "token": "tokpaused01", "last_seen": \(Int(NOW) - 10_000), "last_activity": \(Int(NOW) - 1_000),
    "override": { "token": "tokpaused01", "override": "pause", "until": null, "set_at": \(Int(NOW) - 2_000) } },
  { "token": "tokedgeact1", "last_seen": \(Int(NOW) - 10_000), "last_activity": \(Int(NOW) - 29_000), "override": null },
  { "token": "tokofflin01", "last_seen": \(Int(NOW) - 120_000), "last_activity": \(Int(NOW) - 5_000), "override": null }
] }
""")
check("(b) 6 sessions projected", vWords.count == 6)
check("(b) online + request 10s ago -> Active", row(vWords, "tokactive01")?.stateWord == "Active")
check("(b) online + request 31s ago -> Idle", row(vWords, "tokidle0001")?.stateWord == "Idle")
check("(b) online + no requests yet -> Idle", row(vWords, "tokidle0002")?.stateWord == "Idle")
check("(b) override pause -> Paused (beats Active)", row(vWords, "tokpaused01")?.stateWord == "Paused")
check("(b) 30s boundary: 29s ago still Active", row(vWords, "tokedgeact1")?.stateWord == "Active")
check("(b) offline (heartbeat 120s) + recent request -> NOT Active", row(vWords, "tokofflin01")?.stateWord == "Idle")
// The 90s boundary on the stale verdict: 89s ago is NOT stale, 91s ago IS.
let vEdge = proj("""
{ "sessions": [
  { "token": "tokfresh001", "last_seen": \(Int(NOW) - 89_000), "override": null },
  { "token": "tokjustgone", "last_seen": \(Int(NOW) - 91_000), "override": null }
] }
""")
check("(b) 89s ago not stale / 91s ago stale",
      row(vEdge, "tokfresh001")?.stale == false && row(vEdge, "tokjustgone")?.stale == true)

// ==========================================================================
// (c) stale is a TAG + dim, NOT a state word
// ==========================================================================
let vStale = proj("""
{ "sessions": [
  { "token": "tokstale01", "client_name": "mac-old", "last_seen": \(Int(NOW) - 7_200_000), "override": null },
  { "token": "tokpstale1", "client_name": "mac-paused-stale", "last_seen": \(Int(NOW) - 7_200_000),
    "override": { "token": "tokpstale1", "override": "pause", "until": null, "set_at": \(Int(NOW) - 7_000_000) } }
] }
""")
check("(c) stale row keeps a REAL state word (Idle), stale flagged separately",
      row(vStale, "tokstale01")?.stateWord == "Idle" && row(vStale, "tokstale01")?.stale == true)
check("(c) paused + stale -> word Paused, stale tag still set",
      row(vStale, "tokpstale1")?.stateWord == "Paused" && row(vStale, "tokpstale1")?.stale == true)
// The panel dims via row.stale (opacity) and renders the "stale" tag from
// it — the row itself carries the flag, never a "Stale" word.
check("(c) no row ever renders a 'Stale' state word",
      vStale.allSatisfy { $0.stateWord != "Stale" })

// ==========================================================================
// (d) the gate button title per row (Pause vs Resume) + label fields
// ==========================================================================
check("(d) running row -> 'Pause'", row(vWords, "tokactive01")?.actionTitle == "Pause")
check("(d) paused row -> 'Resume'", row(vWords, "tokpaused01")?.actionTitle == "Resume")
check("(d) stale running row -> 'Resume' would be wrong; it is 'Pause'",
      row(vStale, "tokstale01")?.actionTitle == "Pause")
check("(d) short token label + full token carried",
      row(vWords, "tokactive01")?.shortToken == "tokactiv"
      && row(vWords, "tokactive01")?.token == "tokactive01")
check("(d) client_name carried; empty treated as absent",
      row(vStale, "tokstale01")?.clientName == "mac-old"
      && row(vWords, "tokactive01")?.clientName == nil)
check("(d) last-request text uses the dashboard's ago() wording",
      row(vWords, "tokactive01")?.lastRequestText == "last request 10s ago"
      && row(vWords, "tokidle0002")?.lastRequestText == "no requests yet")
let vMeta = proj("""
{ "sessions": [
  { "token": "tokmeta001", "last_seen": \(Int(NOW) - 5_000), "last_activity": \(Int(NOW) - 132_000),
    "server_id": "srv-gpu", "override": null }
] }
""")
check("(d) server_id carried + 'last request 2m 12s ago'",
      row(vMeta, "tokmeta001")?.serverId == "srv-gpu"
      && row(vMeta, "tokmeta001")?.lastRequestText == "last request 2m 12s ago")

// ==========================================================================
// (e) the write site's WIRE SHAPE (pure builder — no networking)
// ==========================================================================
let rPause = SessionsView.overrideRequest(serverURL: "http://127.0.0.1:9999",
                                          sessionToken: "abc123", paused: true,
                                          arbiterToken: "SEKRET-TOKEN")
let rResume = SessionsView.overrideRequest(serverURL: "http://127.0.0.1:9999",
                                           sessionToken: "abc123", paused: false,
                                           arbiterToken: "SEKRET-TOKEN")
check("(e) pause URL = POST <server>/api/sessions/<token>/override",
      rPause.url?.absoluteString == "http://127.0.0.1:9999/api/sessions/abc123/override"
      && rPause.httpMethod == "POST")
check("(e) Authorization header carries the arbiter token",
      rPause.value(forHTTPHeaderField: "Authorization") == "Bearer SEKRET-TOKEN")
check("(e) the arbiter token appears NOWHERE in the URL",
      !(rPause.url?.absoluteString.contains("SEKRET-TOKEN") ?? true))
check("(e) content-type json",
      rPause.value(forHTTPHeaderField: "content-type") == "application/json")
let pauseBody = (try? JSONSerialization.jsonObject(with: rPause.httpBody ?? Data())) as? [String: Any]
let resumeBody = (try? JSONSerialization.jsonObject(with: rResume.httpBody ?? Data())) as? [String: Any]
check("(e) pause body {\"override\":\"pause\"}", pauseBody?["override"] as? String == "pause")
check("(e) resume body {\"override\":null} (NSNull on the wire)",
      resumeBody?["override"] is NSNull)
// The session token is percent-encoded in the path (encodeURIComponent
// parity): a token with reserved chars must not break the route.
let rWeird = SessionsView.overrideRequest(serverURL: "http://h", sessionToken: "a/b c~d",
                                          paused: true, arbiterToken: "t")
check("(e) session token percent-encoded in the path",
      rWeird.url?.absoluteString == "http://h/api/sessions/a%2Fb%20c~d/override")

// ==========================================================================
// (f) the REAL model path against the stub: optimistic flip, in-flight
//     disable, success stands, 404 reverts + re-polls. Fixtures ride the
//     LIVE clock (apply() computes nowMs from Date()).
// ==========================================================================
let liveNow = Date().timeIntervalSince1970 * 1000
let m = AppModel()
// Let the init poll land FIRST (the stub's single fresh row) — otherwise
// its in-flight response could overwrite the injected rows mid-write and
// the "stands after the 200" check would race the poll, not the write.
for _ in 0..<50 {
  RunLoop.main.run(until: Date().addingTimeInterval(0.1))
  if m.sessions.count == 1 && m.sessions[0].token == "tokstub001" { break }
}
check("(f) init poll landed the stub row before the write cases",
      m.sessions.count == 1 && m.sessions[0].token == "tokstub001")
m.injectStatePayload(payload("""
{ "sessions": [
  { "token": "tokstub001", "client_name": "stub-router", "last_seen": \(Int(liveNow) - 5_000), "override": null },
  { "token": "tokghost01", "client_name": "gone", "last_seen": \(Int(liveNow) - 7_200_000), "override": null }
] }
"""))
check("(f) model.sessions populated by the real apply()", m.sessions.count == 2)

// Optimistic flip + per-row in-flight flag (BEFORE the response arrives).
m.setSessionOverride(sessionToken: "tokstub001", paused: true)
check("(f) optimistic: row flips to Paused immediately",
      m.sessions.first(where: { $0.token == "tokstub001" })?.stateWord == "Paused"
      && m.sessions.first(where: { $0.token == "tokstub001" })?.actionTitle == "Resume")
check("(f) in-flight: the row's token is marked pending",
      m.pendingSessionTokens.contains("tokstub001"))
check("(f) in-flight disable is PER-ROW (the other row is not pending)",
      !m.pendingSessionTokens.contains("tokghost01"))
for _ in 0..<50 {
  RunLoop.main.run(until: Date().addingTimeInterval(0.1))
  if m.pendingSessionTokens.isEmpty { break }
}
check("(f) success: the paused row STANDS after the 200",
      m.sessions.first(where: { $0.token == "tokstub001" })?.paused == true)
check("(f) success: no error note", m.sessionsNote == nil)
check("(f) in-flight flag cleared", m.pendingSessionTokens.isEmpty)

// The stub received the EXACT wire shape (log written by the stub itself;
// one JSON object per line — parsed, not string-matched).
func stubLines() -> [[String: Any]] {
  let raw = (try? String(contentsOfFile: "__LOG__", encoding: .utf8)) ?? ""
  return raw.split(separator: "\n").compactMap { line in
    (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
  }
}
let stubLog = stubLines()
check("(f) the stub received POST /api/sessions/tokstub001/override",
      stubLog.contains { ($0["path"] as? String) == "/api/sessions/tokstub001/override"
        && ($0["token_seg"] as? String) == "tokstub001" })
check("(f) the stub saw the Bearer header with the config token",
      stubLog.contains { ($0["auth"] as? String) == "Bearer arbiter-fixture-token" })
check("(f) the stub saw content-type json",
      stubLog.contains { ($0["ctype"] as? String) == "application/json" })
check("(f) the stub saw body {\"override\":\"pause\"}",
      stubLog.contains { ($0["body"] as? String)?.contains("\"override\":\"pause\"") == true })
check("(f) the arbiter token appears NOWHERE in any request path",
      !stubLog.isEmpty && stubLog.allSatisfy { !((($0["path"] as? String) ?? "").contains("arbiter-fixture-token")) })

// Resume sends {"override":null}.
m.setSessionOverride(sessionToken: "tokstub001", paused: false)
for _ in 0..<50 {
  RunLoop.main.run(until: Date().addingTimeInterval(0.1))
  if m.pendingSessionTokens.isEmpty { break }
}
let stubLog2 = stubLines()
check("(f) resume: the stub saw body {\"override\":null}",
      stubLog2.contains { ($0["body"] as? String)?.contains("\"override\":null") == true })
check("(f) resume: the row stands un-paused",
      m.sessions.first(where: { $0.token == "tokstub001" })?.paused == false)

// 404 (unknown_session): revert + note + immediate re-poll (the stub's
// /api/state carries exactly ONE fresh session — after the re-poll the
// ghost row is GONE and the stub row is present).
m.setSessionOverride(sessionToken: "tokghost01", paused: true)
for _ in 0..<80 {
  RunLoop.main.run(until: Date().addingTimeInterval(0.1))
  if m.sessions.count == 1 && m.sessions[0].token == "tokstub001" { break }
}
check("(f) 404: the ghost row reverted then VANISHED via the re-poll",
      m.sessions.count == 1 && m.sessions[0].token == "tokstub001")
check("(f) 404: the one-line note names the arbiter-truth refresh",
      m.sessionsNote?.contains("unknown") == true)
check("(f) re-poll landed arbiter truth (fresh stub row, running)",
      m.sessions[0].paused == false && m.sessions[0].actionTitle == "Pause")

// The deep-link host + tab order (the settled design: state, sessions,
// logs, projects, settings; unknown host -> State).
check("(g) idlefill://sessions routes to .sessions",
      AppModel.route(for: URL(string: "idlefill://sessions")!) == .sessions)
check("(g) unknown host still routes to .state",
      AppModel.route(for: URL(string: "idlefill://bogus")!) == .state)
check("(g) tab order state, sessions, logs, projects, settings",
      MainTab.allCases.map(\.rawValue) == ["state", "sessions", "logs", "projects", "settings"])

if failures > 0 {
  print("SESSIONS-DT-FAILURES \(failures)")
  exit(1)
}
print("SESSIONS-DT-ALL-PASS")
exit(0)
EOF

sed -e "s|__LOG__|$T/stub.log|g" "$T/main.swift" > "$T/main.baked.swift"
mv "$T/main.baked.swift" "$T/main.swift"
grep -q '__LOG__' "$T/main.swift" && { echo "error: a placeholder survived the bake"; exit 1; }

echo "==> swiftc (real source minus @main + driver)"
swiftc -O \
  -o "$T/sessions-dt-test" \
  "$T/desktop-under-test.swift" "$T/main.swift" \
  -framework AppKit -framework SwiftUI \
  -F "$VENDOR" -framework Sparkle \
  -Xlinker -rpath -Xlinker "@loader_path/Frameworks" 2>&1 | grep -E "error:" || true
[ -x "$T/sessions-dt-test" ] || { echo "error: driver did not build"; exit 1; }
# The driver links Sparkle via @rpath/@loader_path/Frameworks (the bundle
# layout). The harness binary sits at $T/sessions-dt-test, so provide
# $T/Frameworks the same way the bundle does (the edge-test precedent).
mkdir -p "$T/Frameworks"
ln -s "$VENDOR/Sparkle.framework" "$T/Frameworks/Sparkle.framework"

echo "==> run (env -i, the GUI environment; scratch repo -> the stub)"
RC=0
env -i PATH=/usr/bin:/bin \
  HOME="$T/home" \
  IDLEFILL_DESKTOP_CONFIG="$T/homecfg.json" \
  IDLEFILL_REPO_PATH="$T/repo" \
  "$T/sessions-dt-test" || RC=$?
echo "SESSIONS-DT-EXIT=$RC"

# The DEAD-port run (a fresh process whose server_url is a closed port —
# the config is read per call, but a separate scratch config keeps the
# live-run cases honest).
echo "==> run (dead port — the revert-on-failure contract)"
RC2=0
env -i PATH=/usr/bin:/bin \
  HOME="$T/home" \
  IDLEFILL_DESKTOP_CONFIG="$T/homecfg.json" \
  IDLEFILL_REPO_PATH="$T/repo-dead" \
  "$T/sessions-dt-test" --deadport || RC2=$?
echo "SESSIONS-DT-DEADPORT-EXIT=$RC2"

[ "$RC" -eq 0 ] && [ "$RC2" -eq 0 ] || exit 1
echo "SESSIONS-DT-HARNESS-PASS"
