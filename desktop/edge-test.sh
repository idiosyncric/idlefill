#!/usr/bin/env bash
# Headless test for the desktop app's edge (branch) update channel
# (issue #26 DoD): compile the REAL source (minus @main) + a driver, run
# under env -i (the GUI environment) with a scratch HOME (the app config
# lives under $HOME/Library/Application Support/Idlefill/), and drive:
#
#   (a) the pure branch-check logic (the desktop's copy of the menubar's
#       UpdateCheck.branchUpdateMarker): mismatch -> the tip marker;
#       equal markers -> nothing; unknown-branch 404 JSON / malformed
#       sha / nil payload -> fail quiet;
#   (b) the baked marker of an UN-SUBSTITUTED build -> the default 1.0
#       (never the literal placeholder — the fail-mode contract);
#   (c) the app config round trip through the REAL loadConfig/
#       saveUpdateChannel: the defaults when absent; channel + branch
#       load from the file; a malformed channel falls back to "releases";
#       saveUpdateChannel is read-modify-write (every other key —
#       repo_path — preserved, pretty JSON);
#   (d) the REAL checkBranchUpdates() against a local stub of the
#       Forgejo refs API (the IDLEFILL_UPDATE_BASE test hook): mismatch
#       -> offers the tip marker (edgePending + the status line names
#       it); unknown branch (the stub's 404) -> the operator-actionable
#       "not found" note; DEAD network -> fail quiet (the previous
#       status is restored — a dead fetch must not read "up to date");
#       equal markers (a pure verdict over the real fetched payload)
#       -> nothing;
#   (e) the REAL confirmEdgeInstall() + runEdgeSwap() against the stub +
#       a SCRATCH bundle (the IDLEFILL_DESKTOP_EDGE_TARGET hook — never
#       /Applications, never the owner's installed app; NO_OPEN so a
#       headless run spawns no GUI): correct sidecar -> sha256 verified
#       BEFORE the swap + the scratch bundle replaced; tampered sidecar
#       -> refused, the current bundle kept, the status line says so.
set -euo pipefail
T="$(mktemp -d /tmp/edge-dt-test.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/desktop/IdlefillDesktop.swift"
# The framework search dir is vendor/sparkle (it CONTAINS
# Sparkle.framework) — the same -F the build.sh passes.
VENDOR="$REPO/desktop/vendor/sparkle"

echo "==> workdir: $T"

# ---- scratch repo (IDLEFILL_REPO_PATH points here; no token — poll()
# ---- stands down) + scratch HOME (the app config lives under it) --------
mkdir -p "$T/repo/client" "$T/repo/logs" "$T/home" "$T/scratch"
printf '{ "server_url": "http://127.0.0.1:1", "client_name": "edge-dt-test" }\n' > "$T/repo/client/config.json"
# The CURRENT bundle that a refused install must leave untouched.
mkdir -p "$T/scratch/Idlefill.app/Contents/MacOS"
echo "CURRENT-BUNDLE" > "$T/scratch/Idlefill.app/Contents/MacOS/Idlefill"
printf '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>' > "$T/scratch/Idlefill.app/Contents/Info.plist"

# ---- the edge release's artifact: a fake Idlefill.app bundle zipped
# ---- (bundle at the zip root — the release convention) + sidecars ------
# The edge zip is named "Idlefill <marker>.zip" (a SPACE — the edge
# publish's naming; installEdge percent-encodes it on the wire).
# The tip's sha7 (a9787a7 — 7 hex chars, the marker's own tail) + the
# OTHER branch's sha (the tampered-sidecar case's marker tail). The refs
# API carries the FULL 40-hex sha (the marker is its first 7 chars).
SHA_NEW="a9787a7"
SHA_BAD="4444444"
SHA40_NEW="$SHA_NEW$(printf 'a%.0s' {1..33})"
SHA40_BAD="$SHA_BAD$(printf 'b%.0s' {1..33})"
[ "${#SHA40_NEW}" -eq 40 ] && [ "${#SHA40_BAD}" -eq 40 ] || { echo "error: sha fixture length" >&2; exit 1; }
EDGE_MARKER="edge-main-$SHA_NEW"
BAD_MARKER="edge-bad-$SHA_BAD"
mkdir -p "$T/fakeapp/Idlefill.app/Contents/MacOS"
echo "NEW-EDGE-BUNDLE" > "$T/fakeapp/Idlefill.app/Contents/MacOS/Idlefill"
printf '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>' > "$T/fakeapp/Idlefill.app/Contents/Info.plist"
DZIP="$T/Idlefill $EDGE_MARKER.zip"
( cd "$T/fakeapp" && zip -qr "$DZIP" Idlefill.app )
GOOD="$T/good.sidecar"
BAD="$T/bad.sidecar"
( cd "$T" && shasum -a 256 "$(basename "$DZIP")" | awk '{print $1}' ) > "$GOOD"
( cd "$T" && shasum -a 256 "$(basename "$DZIP")" | awk '{print $1}' | sed 's/./0/g' ) > "$BAD"

# ---- the local refs-API + downloads stub (node http server) -------------
PORT=$(node -e "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
cat > "$T/stub.js" <<EOF
const http = require('http');
const fs = require('fs');
const enc = (s) => encodeURIComponent(s);
const zip = fs.readFileSync('$T/Idlefill $EDGE_MARKER.zip');
const good = fs.readFileSync('$T/good.sidecar', 'utf8');
const bad = fs.readFileSync('$T/bad.sidecar', 'utf8');
const refOf = (b, sha) => [
  { ref: 'refs/heads/' + b, url: 'https://git.samwarth.com/api/v1/repos/sam/idlefill/git/refs/heads/' + b,
    object: { type: 'commit', sha: sha, url: 'https://git.samwarth.com/api/v1/repos/sam/idlefill/git/commits/' + sha } }
];
const dlMarker = '$EDGE_MARKER';
const dlBad = '$BAD_MARKER';
const dzip = 'Idlefill ' + dlMarker + '.zip';
const server = http.createServer((req, res) => {
  const u = req.url || '';
  const m = u.match(/^\\/api\\/v1\\/repos\\/sam\\/idlefill\\/git\\/refs\\/heads\\/([^/]+)$/);
  if (m) {
    if (m[1] === 'main') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(refOf('main', '$SHA40_NEW'))); return; }
    if (m[1] === 'bad')  { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(refOf('bad', '$SHA40_BAD'))); return; }
    // unknown branch: the live API's exact 404 body.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: "The target couldn't be found." }));
    return;
  }
  if (u === '/sam/idlefill/releases/download/' + dlMarker + '/' + enc(dzip)) {
    res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(zip); return;
  }
  if (u === '/sam/idlefill/releases/download/' + dlMarker + '/' + enc(dzip + '.sha256')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(good); return;
  }
  // The TAMPERED-sidecar route: the 'bad' branch's marker, same zip
  // bytes, a sidecar that does not match.
  const badZip = 'Idlefill ' + dlBad + '.zip';
  if (u === '/sam/idlefill/releases/download/' + dlBad + '/' + enc(badZip)) {
    res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(zip); return;
  }
  if (u === '/sam/idlefill/releases/download/' + dlBad + '/' + enc(badZip + '.sha256')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(bad); return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
});
server.listen($PORT, '127.0.0.1', () => console.log('STUB-UP ' + $PORT));
setTimeout(() => process.exit(0), 180000);
EOF
node "$T/stub.js" > "$T/stub.log" 2>&1 &
STUB_PID=$!
trap 'kill $STUB_PID 2>/dev/null || true; rm -rf "$T"' EXIT
for i in $(seq 1 50); do
  grep -q "STUB-UP" "$T/stub.log" 2>/dev/null && break
  sleep 0.2
done
grep -q "STUB-UP" "$T/stub.log" || { echo "STUB never came up:"; cat "$T/stub.log"; exit 1; }
echo "==> stub on 127.0.0.1:$PORT (pid $STUB_PID)"

# ---- compile the REAL source (minus @main) + the driver -----------------
sed '/^@main$/,/^}$/d' "$SRC" > "$T/desktop-under-test.swift"
if grep -q '@main' "$T/desktop-under-test.swift"; then echo "error: @main survived the strip"; exit 1; fi
grep -q 'struct IdlefillApp: App' "$T/desktop-under-test.swift" || { echo "error: IdlefillApp lost in the strip"; exit 1; }
grep -q 'static func branchUpdateMarker' "$T/desktop-under-test.swift" || { echo "error: branchUpdateMarker lost in the strip"; exit 1; }
grep -q 'func checkBranchUpdates' "$T/desktop-under-test.swift" || { echo "error: checkBranchUpdates lost in the strip"; exit 1; }
grep -q 'func confirmEdgeInstall' "$T/desktop-under-test.swift" || { echo "error: confirmEdgeInstall lost in the strip"; exit 1; }
grep -q 'func saveUpdateChannel' "$T/desktop-under-test.swift" || { echo "error: saveUpdateChannel lost in the strip"; exit 1; }
# The UI controls exist in the source (the visual render is the owner's
# pass — the report's eyeball checklist).
grep -q 'Picker("", selection: $m.updateChannel)' "$T/desktop-under-test.swift" || { echo "error: the channel picker control is missing"; exit 1; }
grep -q 'text: $m.updateBranch' "$T/desktop-under-test.swift" || { echo "error: the branch field control is missing"; exit 1; }
grep -q 'install edge build' "$T/desktop-under-test.swift" || { echo "error: the confirm control is missing"; exit 1; }

cat > "$T/main.swift" <<'EOF'
import Foundation
import AppKit

var failures = 0
func check(_ name: String, _ cond: Bool) {
  if cond { print("PASS \(name)") } else { failures += 1; print("FAIL \(name)") }
}
func j(_ s: String) -> Data? { s.data(using: .utf8) }
/// Spin the main runloop (in 0.2s slices, so timers fire) until `cond`.
func waitUntil(timeout: TimeInterval, _ cond: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if cond() { return true }
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
  }
  return cond()
}
let port = "__PORT__"
let marker = "edge-main-__SHA7NEW__"
let badMarker = "edge-bad-__SHA7BAD__"
let scratchBundle = "__SCRATCH__/Idlefill.app/Contents/MacOS/Idlefill"

// The DEAD-network run (a second driver invocation, --deadport, with
// IDLEFILL_UPDATE_BASE -> a dead port): the ONLY case is the
// offline-tolerant contract — a dead fetch restores the previous
// status, sets nothing, no crash.
if CommandLine.arguments.contains("--deadport") {
  let dm = AppModel()
  dm.updateChannel = "branch"
  dm.updateBranch = "main"
  dm.updateStatus = "seeded"
  dm.checkBranchUpdates()
  let restored = waitUntil(timeout: 30) {
    !dm.updateChecking && dm.updateStatus == "seeded"
  }
  check("deadport: a dead fetch restores the previous status (fail quiet)",
        restored && dm.edgePending == false
          && (dm.updateStatus ?? "").contains("up to date") == false)
  if failures > 0 { print("EDGE-DT-FAILURES \(failures)"); exit(1) }
  print("EDGE-DT-DEADPORT-PASS")
  exit(0)
}

let refMain = "[{\"ref\":\"refs/heads/main\",\"object\":{\"type\":\"commit\",\"sha\":\"__SHANEW__\"}}]"
let refBad = "[{\"ref\":\"refs/heads/bad\",\"object\":{\"type\":\"commit\",\"sha\":\"__SHABAD__\"}}]"
let ref404 = "{\"message\":\"The target couldn't be found.\"}"

// ------------------------------------------------- (a) pure branch check
check("a: marker mismatch -> offer the tip marker",
      AppModel.branchUpdateMarker(data: j(refMain), localMarker: "1.0") == marker)
check("a: equal markers -> nothing (up to date)",
      AppModel.branchUpdateMarker(data: j(refMain), localMarker: marker) == nil)
check("a: the branch name comes from the payload's ref (bad branch's tip)",
      AppModel.branchUpdateMarker(data: j(refBad), localMarker: "x") == badMarker)
check("a: unknown branch 404 JSON -> fail quiet (nil)",
      AppModel.branchUpdateMarker(data: j(ref404), localMarker: "1.0") == nil)
check("a: malformed sha (too short) -> fail quiet",
      AppModel.branchUpdateMarker(data: j("[{\"ref\":\"refs/heads/main\",\"object\":{\"type\":\"commit\",\"sha\":\"abc\"}}]"),
                                  localMarker: "x") == nil)
check("a: malformed object type -> fail quiet",
      AppModel.branchUpdateMarker(data: j("[{\"ref\":\"refs/heads/main\",\"object\":{\"type\":\"tag\",\"sha\":\"__SHANEW__\"}}]"),
                                  localMarker: "x") == nil)
check("a: not an array (the 404 body) -> fail quiet",
      AppModel.branchUpdateMarker(data: j(ref404), localMarker: "x") == nil)
check("a: nil payload -> fail quiet",
      AppModel.branchUpdateMarker(data: nil, localMarker: "x") == nil)

// ------------------------------------------------------- (b) the marker
let m0 = AppModel()
check("b: an un-substituted build reports the default 1.0",
      m0.bakedMarker == "1.0")
check("b: it is NOT the literal placeholder (the fail-mode contract)",
      !m0.bakedMarker.contains("__DESKTOP"))
check("b: the default channel is releases (no config)",
      m0.updateChannel == "releases" && m0.updateBranch == "main")

// --------------------------------------------- (c) the app config round
// trip through the REAL loadConfig / saveUpdateChannel. (The app config
// is JSON — written via JSONSerialization, exactly like saveUpdateChannel;
// NSDictionary.write would emit a PLIST, which the loader must reject.)
let cfgPath = AppModel.appConfigPath()
func writeJSON(_ o: [String: Any]) {
  let d = try! JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys])
  try! d.write(to: URL(fileURLWithPath: cfgPath))
}
let seed = ["repo_path": "/tmp/seed-repo", "update_channel": "branch", "update_branch": "dev", "other_key": "keep"]
writeJSON(seed)
let m1 = AppModel()
check("c: loadConfig — channel + branch load from the file",
      m1.updateChannel == "branch" && m1.updateBranch == "dev")
m1.updateBranch = "  main  " // the save trims (whitespace-trimmed discipline)
m1.saveUpdateChannel()
var saved: [String: Any] = [:]
if let d = try? Data(contentsOf: URL(fileURLWithPath: cfgPath)) {
  saved = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
}
check("c: saveUpdateChannel — update_channel + trimmed branch persisted",
      saved["update_channel"] as? String == "branch" && saved["update_branch"] as? String == "main")
check("c: saveUpdateChannel — every other key preserved (repo_path, other_key)",
      saved["repo_path"] as? String == "/tmp/seed-repo" && saved["other_key"] as? String == "keep")
// A malformed channel value falls back to "releases" (the read discipline).
writeJSON(["update_channel": "bogus-channel"])
let m2 = AppModel()
check("c: a malformed channel value falls back to releases (never a third channel)",
      m2.updateChannel == "releases")

// ------------------------- (d) the REAL checkBranchUpdates() (the fetch)
// The model's own launch-time env carried IDLEFILL_UPDATE_BASE -> the
// stub, so checkBranchUpdates() fetches the stub's refs API.
// Restore a config the branch check reads (branch main).
writeJSON(["update_channel": "branch", "update_branch": "main"])
let md = AppModel()
check("d: pre-check state (nothing pending, the seeded status)",
      md.edgePending == false)
md.updateStatus = "seeded" // the status a dead fetch must RESTORE
md.updateBranch = "main"
md.checkBranchUpdates()
let gotOffer = waitUntil(timeout: 30) {
  !md.updateChecking && md.updateStatus?.contains("new build \(marker) on main") == true
}
check("d: branch mode (the real fetch) -> offers the tip marker",
      gotOffer && md.edgePending == true)
check("d: the status line names the tip marker (operator-facing)",
      md.updateStatus?.contains(marker) == true)

// (d) unknown branch (the stub's 404) -> the operator-actionable note
// (distinct from the offline-tolerant silence).
md.updateBranch = "no-such-branch"
md.edgePending = true // a stale pending offer must be cleared by a 404
md.checkBranchUpdates()
let got404 = waitUntil(timeout: 30) {
  !md.updateChecking && md.updateStatus?.contains("not found") == true
}
check("d: unknown branch (the stub's 404) -> the 'not found' note",
      got404 && md.edgePending == false)

// (d) DEAD network -> fail quiet: no response at all — the previous
// status is RESTORED (a dead fetch must not read "up to date"), nothing
// pending, no error row. (A fresh model: the env points the check base
// at a DEAD port — the model reads the env at launch, so this needs its
// own process; the harness re-runs the driver with --deadport below.)
// Here: a 5xx + non-refs payload via the stub's 404-for-unknown route is
// already covered; the pure equal-markers case over the REAL fetched
// payload (tip marker as the local marker -> nil):
let semD = DispatchSemaphore(value: 0)
var dTip: String? = nil
var dEqual: String? = "unset"
URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:\(port)/api/v1/repos/sam/idlefill/git/refs/heads/main")!) { data, _, _ in
  dTip = AppModel.branchUpdateMarker(data: data, localMarker: "definitely-not-the-tip")
  dEqual = AppModel.branchUpdateMarker(data: data, localMarker: dTip ?? "")
  semD.signal()
}.resume()
if semD.wait(timeout: .now() + 20) == .success {
  check("d: equal markers via the real fetch -> nothing (up to date)",
        dTip == marker && dEqual == nil)
} else {
  failures += 1; print("FAIL d: equal-markers fetch timed out")
}

// --------------------------------- (e) the REAL confirmEdgeInstall()
// (e) CORRECT sidecar: download + sha256 verified BEFORE the swap, then
// the swap in the detached helper — the SCRATCH bundle is replaced
// (never /Applications — the env hook re-points the target).
md.updateBranch = "main"
md.edgePending = true
md.confirmEdgeInstall()
let installing = waitUntil(timeout: 45) {
  md.updateStatus?.contains("installing") == true
}
check("e: confirm (correct sidecar) -> verified, the install started",
      installing)
// The detached helper does the swap OUTSIDE this process — poll the
// scratch bundle until the new binary content lands (or the bound ends).
let swapped = waitUntil(timeout: 60) {
  ((try? String(contentsOfFile: scratchBundle, encoding: .utf8)) ?? "").hasPrefix("NEW-EDGE-BUNDLE")
}
check("e: the swap landed on the scratch bundle (the current one was replaced)",
      swapped)

// (e) TAMPERED sidecar (the 'bad' branch's marker): sha256 mismatch ->
// refused, the scratch bundle (the CURRENT build) kept, the status line
// says so, nothing pending.
let before = (try? String(contentsOfFile: scratchBundle, encoding: .utf8)) ?? ""
md.updateBranch = "bad"
md.edgePending = true
md.confirmEdgeInstall()
let refused = waitUntil(timeout: 45) {
  !md.updateChecking && (md.updateStatus?.contains("mismatch") == true
      || md.updateStatus?.contains("NOT installed") == true)
}
check("e: tampered sidecar -> refused (the status line says so)",
      refused && md.edgePending == false)
let after = (try? String(contentsOfFile: scratchBundle, encoding: .utf8)) ?? ""
check("e: tampered sidecar -> the current bundle is untouched",
      after == before && after.hasPrefix("NEW-EDGE-BUNDLE"))

if failures > 0 {
  print("EDGE-DT-FAILURES \(failures)")
  exit(1)
}
print("EDGE-DT-ALL-PASS")
exit(0)
EOF

# Bake the run-time values into the driver (|g — every placeholder
# occurs at least twice: in the marker strings AND the canned payloads).
sed -e "s|__PORT__|$PORT|g" \
    -e "s|__SHA7NEW__|$SHA_NEW|g" \
    -e "s|__SHA7BAD__|$SHA_BAD|g" \
    -e "s|__SHANEW__|$SHA40_NEW|g" \
    -e "s|__SHABAD__|$SHA40_BAD|g" \
    -e "s|__SCRATCH__|$T/scratch|g" \
    "$T/main.swift" > "$T/main.baked.swift"
mv "$T/main.baked.swift" "$T/main.swift"
grep -qE '__PORT__|__SHA|__SCRATCH__' "$T/main.swift" && { echo "error: a placeholder survived the bake"; exit 1; }

echo "==> swiftc (real source minus @main + driver)"
swiftc -O \
  -o "$T/edge-dt-test" \
  "$T/desktop-under-test.swift" "$T/main.swift" \
  -framework AppKit -framework SwiftUI \
  -F "$VENDOR" -framework Sparkle \
  -Xlinker -rpath -Xlinker "@loader_path/Frameworks" 2>&1 | grep -E "error:" || true
[ -x "$T/edge-dt-test" ] || { echo "error: driver did not build"; exit 1; }
# The driver links Sparkle via @rpath/@loader_path/Frameworks (the bundle
# layout — the binary lives at <App>/Contents/MacOS/, the framework at
# <App>/Contents/Frameworks/). The harness binary sits at $T/edge-dt-test,
# so provide $T/Frameworks the same way the bundle does.
mkdir -p "$T/Frameworks"
ln -s "$VENDOR/Sparkle.framework" "$T/Frameworks/Sparkle.framework"

echo "==> run (env -i, the GUI environment; scratch HOME + repo; stub base; scratch swap target)"
RC=0
env -i PATH=/usr/bin:/bin \
  HOME="$T/home" \
  IDLEFILL_DESKTOP_CONFIG="$T/homecfg.json" \
  IDLEFILL_REPO_PATH="$T/repo" \
  IDLEFILL_UPDATE_BASE="http://127.0.0.1:$PORT" \
  IDLEFILL_DESKTOP_EDGE_TARGET="$T/scratch/Idlefill.app" \
  IDLEFILL_DESKTOP_EDGE_NO_OPEN=1 \
  "$T/edge-dt-test" || RC=$?
echo "EDGE-DT-EXIT=$RC"

# The DEAD-network case (a fresh process whose check base is a DEAD port
# — the env is a launch-time snapshot, so it needs its own run): the
# previous status must be RESTORED, nothing pending, no "up to date".
echo "==> run (dead port — the offline-tolerant contract)"
RC2=0
env -i PATH=/usr/bin:/bin \
  HOME="$T/home" \
  IDLEFILL_DESKTOP_CONFIG="$T/homecfg.json" \
  IDLEFILL_REPO_PATH="$T/repo" \
  IDLEFILL_UPDATE_BASE="http://127.0.0.1:1" \
  IDLEFILL_DESKTOP_EDGE_TARGET="$T/scratch/Idlefill.app" \
  IDLEFILL_DESKTOP_EDGE_NO_OPEN=1 \
  "$T/edge-dt-test" --deadport || RC2=$?
echo "EDGE-DT-DEADPORT-EXIT=$RC2"

exit $(( RC + RC2 ))
