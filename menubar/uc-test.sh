#!/usr/bin/env bash
# Headless test for the menubar's UpdateCheck (issue #10 DoD):
# compile the REAL source (minus @main) + a driver, run under env -i
# (the GUI environment) with a scratch IDLEFILL_CONFIG_FILE.
#
# (a) pure comparison: newer tag -> available (the NEWEST valid),
#     older/same -> not available, malformed tags skipped;
# (b) the real URLSession fetch path against a LOCAL stub of the releases
#     API (node http server on a scratch port, canned releases list) via
#     IDLEFILL_UPDATE_BASE — and OFFLINE (dead port) -> silent, no crash,
#     nothing set (the AppModel init's own checkForUpdates() fires at the
#     dead base under env -i);
# (c) sha256: a correct sidecar verifies + the bundle swaps in place, a
#     tampered file/sidecar is refused (the current bundle is kept), a
#     missing sidecar is refused.
set -euo pipefail
T="$(mktemp -d /tmp/uc-test.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/menubar/IdlefillMenubar.swift"

echo "==> workdir: $T"

# ---- scratch repo (IDLEFILL_CONFIG_FILE points here) -----------------------
mkdir -p "$T/repo/client" "$T/repo/menubar" "$T/repo/logs"
cat > "$T/repo/package.json" <<'EOF'
{ "name": "idlefill-scratch", "version": "0.1.0" }
EOF
cat > "$T/repo/client/config.json" <<'EOF'
{ "server_url": "http://127.0.0.1:1", "token": "scratch-not-a-real-token", "client_name": "uc-test" }
EOF
# the "current installed" bundle that a refused install must leave untouched
mkdir -p "$T/repo/menubar/IdlefillMenubar.app/Contents/MacOS"
echo "CURRENT-BUNDLE" > "$T/repo/menubar/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar"
printf '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>' > "$T/repo/menubar/IdlefillMenubar.app/Contents/Info.plist"
# The committed plist template (the re-point renders it — the shipped one).
cp "$REPO/menubar/IdlefillMenubar.plist" "$T/repo/menubar/IdlefillMenubar.plist"

# ---- (issue #23) the stale scratch label for the release re-point case ----
# A SCRATCH label (never the real com.sam.idlefill.menubar) loaded on a
# DIFFERENT path INSIDE the scratch repo (the bare pre-bundle-era binary).
# The install must RE-POINT it at the swapped bundle.
SCRATCH_LABEL="com.sam.idlefill.uc-scratch"
mkdir -p "$T/plists"
printf '#!/bin/sh\nexec sleep 3600\n' > "$T/repo/menubar/IdlefillMenubar"
chmod +x "$T/repo/menubar/IdlefillMenubar"
cat > "$T/plists/$SCRATCH_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$SCRATCH_LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$T/repo/menubar/IdlefillMenubar</string></array>
    <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$SCRATCH_LABEL" 2>/dev/null || true   # idempotent start
launchctl bootstrap "gui/$(id -u)" "$T/plists/$SCRATCH_LABEL.plist" || { echo "error: scratch bootstrap failed"; exit 1; }
trap 'launchctl bootout "gui/$(id -u)/'"$SCRATCH_LABEL"'" 2>/dev/null || true; kill $STUB_PID 2>/dev/null || true; rm -rf "$T"' EXIT
launchctl print "gui/$(id -u)/$SCRATCH_LABEL" >/dev/null 2>&1 || { echo "error: scratch label not loaded after bootstrap"; exit 1; }
echo "==> scratch label $SCRATCH_LABEL loaded on the STALE path $T/repo/menubar/IdlefillMenubar"

# ---- the new release's artifact: a fake .app bundle zipped (the .app dir at
# ---- the zip root — the release convention) + sidecars ----------------------
mkdir -p "$T/fakeapp/IdlefillMenubar.app/Contents/MacOS"
echo "NEW-BUNDLE-1" > "$T/fakeapp/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar"
printf '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>' > "$T/fakeapp/IdlefillMenubar.app/Contents/Info.plist"
# The published menubar zip is named after the BARE release version
# (release.sh: IdlefillMenubar-$V.app.zip) — the release number, no "v".
GOOD="$T/IdlefillMenubar-1.app.zip"
( cd "$T/fakeapp" && zip -qr "$GOOD" IdlefillMenubar.app )
( cd "$T" && shasum -a 256 "IdlefillMenubar-1.app.zip" | awk '{print $1}' ) > "$T/good.sidecar"
# a TAMPERED sidecar (valid 64-hex shape, wrong hash) for the v2 route
( cd "$T" && shasum -a 256 "IdlefillMenubar-1.app.zip" | awk '{print $1}' | sed 's/./0/g' ) > "$T/bad.sidecar"

# ---- the local releases-API stub (node http server on a scratch port) ------
PORT=$(node -e "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
cat > "$T/stub.js" <<EOF
const http = require('http');
const fs = require('fs');
// the local releases list: numbered releases (the scheme) + one legacy
// semver tag (the pre-numbering feed) + malformed tags that must be skipped.
const releases = [
  { tag_name: 'v1', name: 'Release #1' },
  { tag_name: 'v0.0.2', name: 'Idlefill 0.0.2' },
  { tag_name: 'not-a-version', name: 'odd' },
  { tag_name: 'v1.0', name: 'two segments' }
];
const zip = fs.readFileSync('$GOOD');
const good = fs.readFileSync('$T/good.sidecar', 'utf8');
const bad = fs.readFileSync('$T/bad.sidecar', 'utf8');
const server = http.createServer((req, res) => {
  const u = req.url || '';
  if (u.startsWith('/api/v1/repos/sam/idlefill/releases')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(releases));
    return;
  }
  if (u === '/releases/download/v1/IdlefillMenubar-1.app.zip') {
    res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(zip); return;
  }
  if (u === '/releases/download/v1/IdlefillMenubar-1.app.zip.sha256') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(good); return;
  }
  if (u === '/releases/download/v2/IdlefillMenubar-2.app.zip') {
    res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(zip); return; // same bytes
  }
  if (u === '/releases/download/v2/IdlefillMenubar-2.app.zip.sha256') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(bad); return;
  }
  if (u === '/releases/download/v3/IdlefillMenubar-3.app.zip') {
    res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(zip); return;
  }
  // v3: NO sidecar route at all (missing sidecar -> refuse)
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
});
server.listen($PORT, '127.0.0.1', () => console.log('STUB-UP ' + $PORT));
setTimeout(() => process.exit(0), 120000);
EOF
node "$T/stub.js" > "$T/stub.log" 2>&1 &
STUB_PID=$!
trap 'launchctl bootout "gui/$(id -u)/'"$SCRATCH_LABEL"'" 2>/dev/null || true; kill $STUB_PID 2>/dev/null || true; rm -rf "$T"' EXIT
for i in $(seq 1 50); do
  grep -q "STUB-UP" "$T/stub.log" 2>/dev/null && break
  sleep 0.2
done
grep -q "STUB-UP" "$T/stub.log" || { echo "STUB never came up:"; cat "$T/stub.log"; exit 1; }
echo "==> stub on 127.0.0.1:$PORT (pid $STUB_PID)"

# ---- compile the REAL source (minus @main) + the driver --------------------
# The @main enum is the only thing that needs stripping — everything else
# (UpdateCheck, AppModel, the views, the AppDelegate) is testable as-is.
sed '/^@main$/,/^}$/d' "$SRC" > "$T/menubar-under-test.swift"
if grep -q '@main' "$T/menubar-under-test.swift"; then echo "error: @main survived the strip"; exit 1; fi
grep -q 'struct IdlefillApp: App' "$T/menubar-under-test.swift" || { echo "error: IdlefillApp lost in the strip"; exit 1; }
grep -q 'enum UpdateCheck' "$T/menubar-under-test.swift" || { echo "error: UpdateCheck lost in the strip"; exit 1; }

cat > "$T/main.swift" <<'EOF'
import Foundation

var failures = 0
func check(_ name: String, _ cond: Bool) {
  if cond { print("PASS \(name)") } else { failures += 1; print("FAIL \(name)") }
}
func j(_ s: String) -> Data? { s.data(using: .utf8) }
func isRefused(_ o: UpdateCheck.Outcome) -> Bool {
  if case .refused = o { return true }
  return false
}

let port = "__PORT__"
let bundleDest = "__BUNDLE__"
let repoRoot = "__REPO__"
let scratchLabel = "__SCRATCHLABEL__"
let goodHash = "__GOODHASH__"
let badHash = "__BADHASH__"
let zipPath = "__ZIP__"
let bundleURL = URL(fileURLWithPath: bundleDest)

// ---------------------------------------------------------------- (a) pure
// Numbered releases (the scheme) + a legacy semver tag + malformed tags that
// must be skipped. v1 (the release number) is the newest and must win.
let canned = "[{\"tag_name\":\"v0.0.1\"},{\"tag_name\":\"v0.0.2\"},{\"tag_name\":\"v1\"},{\"tag_name\":\"weird\"},{\"tag_name\":\"v1.0\"},{\"tag_name\":\"v1-beta\"}]"
check("a: release number beats legacy semver (v1 newest), malformed skipped",
      UpdateCheck.latestUpdateTag(data: j(canned), localVersion: "0.0.2") == "1")
check("a: same release number -> nil",
      UpdateCheck.latestUpdateTag(data: j(canned), localVersion: "1") == nil)
check("a: only older tags -> nil",
      UpdateCheck.latestUpdateTag(data: j("[{\"tag_name\":\"v0.0.1\"}]"), localVersion: "0.0.2") == nil)
check("a: higher number above lower (v2 > v1), numeric not lexicographic",
      UpdateCheck.latestUpdateTag(data: j("[{\"tag_name\":\"v2\"}]"), localVersion: "1") == "2")
check("a: two-digit number above one-digit (v10 > v9)",
      UpdateCheck.latestUpdateTag(data: j("[{\"tag_name\":\"v10\"}]"), localVersion: "9") == "10")
check("a: a semver newer than the local semver still works (v0.0.2 > v0.0.1)",
      UpdateCheck.latestUpdateTag(data: j("[{\"tag_name\":\"v0.0.2\"}]"), localVersion: "0.0.1") == "0.0.2")
check("a: malformed payload -> nil (fail quiet)",
      UpdateCheck.latestUpdateTag(data: j("not json"), localVersion: "0.0.2") == nil)
check("a: nil payload -> nil",
      UpdateCheck.latestUpdateTag(data: nil, localVersion: "0.0.2") == nil)
check("a: malformed local version -> the BACK-SWITCH rule (issue #26) offers the newest release unconditionally — a non-numeric local version can never compare numerically, and must not strand the machine on the releases channel (the pre-#26 expectation was nil/fail-quiet-forever — the exact bug #26 fixes)",
      UpdateCheck.latestUpdateTag(data: j("[{\"tag_name\":\"v1\"}]"), localVersion: "bogus") == "1")
// The bare version string is what installUpdate() feeds to downloadRef —
// the Gitea tag is the bare version with the "v" re-added, and the zip is
// named after the bare version (never the tag).
check("a: downloadRef (numbered) -> tag v1 / zip IdlefillMenubar-1.app.zip",
      UpdateCheck.downloadRef(version: "1").tag == "v1"
        && UpdateCheck.downloadRef(version: "1").zip == "IdlefillMenubar-1.app.zip")
check("a: downloadRef (legacy semver) -> tag v0.0.2 / zip IdlefillMenubar-0.0.2.app.zip",
      UpdateCheck.downloadRef(version: "0.0.2").tag == "v0.0.2"
        && UpdateCheck.downloadRef(version: "0.0.2").zip == "IdlefillMenubar-0.0.2.app.zip")
check("a: downloadRef (a v-prefixed input is normalized to bare)",
      UpdateCheck.downloadRef(version: "v1").tag == "v1"
        && UpdateCheck.downloadRef(version: "v1").zip == "IdlefillMenubar-1.app.zip")

// --------------------------------------------------- (b) the real fetch path
// against the LOCAL stub (the same endpoint the app hits:
// <base>/api/v1/repos/sam/idlefill/releases?limit=10).
let semB = DispatchSemaphore(value: 0)
var bResult: String? = "__unset__"
UpdateCheck.fetchReleases(base: "http://127.0.0.1:\(port)") { data in
  let m = AppModel()
  m.applyUpdateCheck(data, localVersion: "0.0.2")
  bResult = m.updateAvailable
  semB.signal()
}
if semB.wait(timeout: .now() + 20) == .success {
  check("b: stub fetch -> update available (1 — the release number wins)", bResult == "1")
} else {
  failures += 1; print("FAIL b: stub fetch timed out")
}

// (b) OFFLINE (dead port) — the AppModel init's own checkForUpdates() fires
// against IDLEFILL_UPDATE_BASE (the dead port baked into this env -i run):
// silent, no crash, nothing set.
let m2 = AppModel()
RunLoop.main.run(until: Date().addingTimeInterval(3.0))
check("b: offline (dead port) -> silent, no crash, nothing set",
      m2.updateAvailable == nil && m2.updateNote == nil)

// ---------------------------------------------------------------- (c) sha256
check("c: sha256 known vector (abc)",
      UpdateCheck.sha256Hex(Data("abc".utf8)) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
check("c: sidecar parse (good)", UpdateCheck.parseSidecar(goodHash + "\n") == goodHash)
check("c: sidecar parse (64 zeros — valid shape)", UpdateCheck.parseSidecar(badHash) != nil)
check("c: sidecar parse (short) -> nil", UpdateCheck.parseSidecar("zz") == nil)
check("c: sidecar parse (non-hex) -> nil",
      UpdateCheck.parseSidecar(String(repeating: "z", count: 64)) == nil)

// (c) install: CORRECT sidecar -> verifies + swaps the bundle in place.
// tag "v1" + zip "IdlefillMenubar-1.app.zip" — exactly what downloadRef
// yields for the bare version "1" (the value updateAvailable would hold).
// ISSUE #23: the scratch label is loaded on a STALE path inside the repo
// (the harness bootstrapped it on the bare binary) — this same call must
// RE-POINT it at the swapped bundle and verify via launchctl print.
let sem1 = DispatchSemaphore(value: 0)
var o1: UpdateCheck.Outcome = .refused("not-run")
UpdateCheck.install(base: "http://127.0.0.1:\(port)", tag: "v1",
                    zipName: "IdlefillMenubar-1.app.zip",
                    bundleURL: bundleURL, repoRoot: repoRoot, label: scratchLabel) {
  o1 = $0; sem1.signal()
}
if sem1.wait(timeout: .now() + 40) == .success {
  let bin = bundleURL.appendingPathComponent("Contents/MacOS/IdlefillMenubar").path
  let after = (try? String(contentsOfFile: bin, encoding: .utf8)) ?? ""
  check("c: correct sidecar -> verified + swapped in place",
        after.hasPrefix("NEW-BUNDLE-1") && !isRefused(o1))
  check("c: outcome is .installed (agent verified on the swapped bundle)",
        o1 == .installed)
  // Issue #23: the LOADED agent now runs the swapped bundle executable.
  let runs = UpdateFacts.labelRuns(uid: geteuid(), label: scratchLabel)
  check("c: the stale label was RE-POINTED — launchctl print shows the bundle executable",
        runs == bin)
  let rendered = (try? String(contentsOfFile: "__PLISTDIR__/\(scratchLabel).plist", encoding: .utf8)) ?? ""
  check("c: the rendered plist (from the committed template) carries the bundle executable",
        rendered.contains("<string>\(bin)</string>") && rendered.contains("<string>\(scratchLabel)</string>"))
} else {
  failures += 1; print("FAIL c: install (correct sidecar) timed out")
}

// (c) install: TAMPERED sidecar -> refused, the current bundle is kept.
let binPath = bundleURL.appendingPathComponent("Contents/MacOS/IdlefillMenubar").path
let currentBefore = (try? String(contentsOfFile: binPath, encoding: .utf8)) ?? ""
let sem2 = DispatchSemaphore(value: 0)
var o2: UpdateCheck.Outcome = .refused("not-run")
UpdateCheck.install(base: "http://127.0.0.1:\(port)", tag: "v2",
                    zipName: "IdlefillMenubar-2.app.zip",
                    bundleURL: bundleURL, repoRoot: repoRoot, label: scratchLabel) {
  o2 = $0; sem2.signal()
}
if sem2.wait(timeout: .now() + 40) == .success {
  let nowAfter = (try? String(contentsOfFile: binPath, encoding: .utf8)) ?? ""
  check("c: tampered sidecar -> refused", isRefused(o2))
  check("c: tampered sidecar -> current bundle untouched", nowAfter == currentBefore)
} else {
  failures += 1; print("FAIL c: install (tampered sidecar) timed out")
}

// (c) install: MISSING sidecar (404) -> refused.
let sem3 = DispatchSemaphore(value: 0)
var o3: UpdateCheck.Outcome = .refused("not-run")
UpdateCheck.install(base: "http://127.0.0.1:\(port)", tag: "v3",
                    zipName: "IdlefillMenubar-3.app.zip",
                    bundleURL: bundleURL, repoRoot: repoRoot, label: scratchLabel) {
  o3 = $0; sem3.signal()
}
if sem3.wait(timeout: .now() + 40) == .success {
  check("c: missing sidecar -> refused", isRefused(o3))
} else {
  failures += 1; print("FAIL c: install (missing sidecar) timed out")
}

// (c) sha256 of a TAMPERED FILE (the DoD's "a tampered file is refused"):
// flip one byte of the published zip -> the hash no longer matches the
// sidecar; the untampered bytes match.
if let zipBytes = try? Data(contentsOf: URL(fileURLWithPath: zipPath)) {
  var tampered = zipBytes
  tampered[0] ^= 0xff
  check("c: tampered zip bytes vs published hash -> mismatch",
        UpdateCheck.sha256Hex(tampered) != goodHash)
  check("c: untampered zip bytes vs published hash -> match",
        UpdateCheck.sha256Hex(zipBytes) == goodHash)
} else {
  failures += 1; print("FAIL c: could not read the staging zip")
}

if failures > 0 {
  print("UC-FAILURES \(failures)")
  exit(1)
}
print("UC-ALL-PASS")
exit(0)
EOF

# Bake the run-time values into the driver (the source itself carries no
# test hooks beyond IDLEFILL_UPDATE_BASE, which the check reads at fetch
# time).
sed -e "s|__PORT__|$PORT|" \
    -e "s|__BUNDLE__|$T/repo/menubar/IdlefillMenubar.app|" \
    -e "s|__REPO__|$T/repo|" \
    -e "s|__SCRATCHLABEL__|$SCRATCH_LABEL|" \
    -e "s|__PLISTDIR__|$T/plists|" \
    -e "s|__GOODHASH__|$(cat "$T/good.sidecar")|" \
    -e "s|__BADHASH__|$(cat "$T/bad.sidecar")|" \
    -e "s|__ZIP__|$GOOD|" \
    "$T/main.swift" > "$T/main.baked.swift"
mv "$T/main.baked.swift" "$T/main.swift"

echo "==> swiftc (real source minus @main + driver)"
swiftc -O \
  -o "$T/uc-test" \
  "$T/menubar-under-test.swift" "$T/main.swift" \
  -framework AppKit -framework SwiftUI 2>&1 | grep -E "error:" || true
[ -x "$T/uc-test" ] || { echo "error: driver did not build"; exit 1; }

echo "==> run (env -i, the GUI environment; IDLEFILL_UPDATE_BASE -> dead port)"
RC=0
env -i PATH=/usr/bin:/bin \
  IDLEFILL_CONFIG_FILE="$T/repo/client/config.json" \
  IDLEFILL_UPDATE_BASE="http://127.0.0.1:1" \
  IDLEFILL_MENUBAR_PLIST_DIR="$T/plists" \
  "$T/uc-test" || RC=$?
echo "UC-EXIT=$RC"
exit $RC
