#!/usr/bin/env bash
# Headless test for the menubar's update-channel logic (issue #26 DoD):
# compile the REAL source (minus @main) + a driver, run under env -i
# (the GUI environment) with a scratch IDLEFILL_CONFIG_FILE, and drive
# the pure branch-check logic + the REAL ref fetch against a local stub
# of the Forgejo refs API (the IDLEFILL_UPDATE_BASE test hook):
#
#   (a) pure branch check: marker mismatch -> offer the tip marker;
#       equal markers -> nothing; malformed sha / unknown-branch 404
#       JSON / nil payload -> fail quiet;
#   (b) the real URLSession fetch path against the local refs stub:
#       branch mode offers on mismatch; equal -> nothing; unknown branch
#       (the stub's 404) -> fail quiet; dead network -> fail quiet
#       (the AppModel init's own checkForUpdates() fires at the dead
#       base under env -i);
#   (c) back-switch: release mode with a NON-NUMERIC local marker ->
#       offers the newest release unconditionally; release mode numeric
#       -> the unchanged uc-test.sh cases (v1 wins, same -> nil, older
#       -> nil, malformed local -> still nil via the numeric path,
#       malformed payload -> nil);
#   (d) channel-aware downloadRef: edge marker -> its own tag + the
#       marker-named zip; release form byte-identical to before;
#   (e) the edge install: the REAL UpdateCheck.install (sha256 verified
#       BEFORE any swap) against the edge tag on the stub — correct
#       sidecar swaps, tampered sidecar refuses (current bundle kept).
set -euo pipefail
T="$(mktemp -d /tmp/edge-mb-test.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/menubar/IdlefillMenubar.swift"

echo "==> workdir: $T"

# ---- scratch repo (IDLEFILL_CONFIG_FILE points here) -----------------------
mkdir -p "$T/repo/client" "$T/repo/menubar" "$T/repo/logs"
cat > "$T/repo/package.json" <<'EOF'
{ "name": "idlefill-scratch", "version": "2" }
EOF
# update_channel = "main" -> the launch check takes the BRANCH path
# (criterion: the 6h check + the launch check follow the channel).
cat > "$T/repo/client/config.json" <<'EOF'
{ "server_url": "http://127.0.0.1:1", "token": "scratch-not-a-real-token", "client_name": "edge-mb-test", "update_channel": "main" }
EOF
# the "current installed" bundle that a refused install must leave untouched
mkdir -p "$T/repo/menubar/IdlefillMenubar.app/Contents/MacOS"
echo "CURRENT-BUNDLE" > "$T/repo/menubar/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar"
printf '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>' > "$T/repo/menubar/IdlefillMenubar.app/Contents/Info.plist"

# ---- the edge release's artifact: a fake .app bundle zipped (the .app dir
# ---- at the zip root — the release convention) + sidecars -------------------
mkdir -p "$T/fakeapp/IdlefillMenubar.app/Contents/MacOS"
echo "NEW-EDGE-BUNDLE" > "$T/fakeapp/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar"
printf '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>' > "$T/fakeapp/IdlefillMenubar.app/Contents/Info.plist"
# The edge marker's sha7 (a9787a7 — the marker's own tail) + a DIFFERENT
# sha for the "newer push" / other-branch case. The refs API carries the
# FULL 40-hex sha (the marker is its first 7 chars) — build the 40-char
# fixtures by repeating the 7-char prefix (both stay valid hex).
SHA_NEW="a9787a7"
SHA_OLDER="1111111"
SHA40_NEW="$SHA_NEW$(printf 'a%.0s' {1..33})"
SHA40_OLDER="$SHA_OLDER$(printf 'b%.0s' {1..33})"
[ "${#SHA40_NEW}" -eq 40 ] && [ "${#SHA40_OLDER}" -eq 40 ] || { echo "error: sha fixture length" >&2; exit 1; }
# The edge zip is named after the MARKER (edge-main-<sha7>) — the
# edge publish's convention (release.sh's IdlefillMenubar-<v>.app.zip
# with $V = the marker).
EDGE_MARKER="edge-main-$SHA_NEW"
EDGE_ZIP="$T/IdlefillMenubar-$EDGE_MARKER.app.zip"
( cd "$T/fakeapp" && zip -qr "$EDGE_ZIP" IdlefillMenubar.app )
GOOD="$T/good.sidecar"
BAD="$T/bad.sidecar"
( cd "$T" && shasum -a 256 "$(basename "$EDGE_ZIP")" | awk '{print $1}' ) > "$GOOD"
( cd "$T" && shasum -a 256 "$(basename "$EDGE_ZIP")" | awk '{print $1}' | sed 's/./0/g' ) > "$BAD"

# ---- the local refs-API + downloads stub (node http server) ----------------
PORT=$(node -e "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
cat > "$T/stub.js" <<EOF
const http = require('http');
const fs = require('fs');
const shaNew = '$SHA40_NEW';   // the live refs API's shape: the FULL 40-hex sha
const shaOlder = '$SHA40_OLDER';
const edgeMarker = 'edge-main-' + shaNew.slice(0, 7);
const zip = fs.readFileSync('$EDGE_ZIP');
const good = fs.readFileSync('$T/good.sidecar', 'utf8');
const bad = fs.readFileSync('$T/bad.sidecar', 'utf8');
// The numbered releases list (the releases-channel check's input):
// release numbers + a legacy semver + malformed tags. v3 is the NEWEST —
// the back-switch case must offer the newest release unconditionally, and
// that must differ from what the numeric strictly-newer rule offers (2),
// or the case proves nothing.
const releases = [
  { tag_name: 'v3', name: 'Release #3' },
  { tag_name: 'v2', name: 'Release #2' },
  { tag_name: 'v1', name: 'Release #1' },
  { tag_name: 'v0.0.2', name: 'Idlefill 0.0.2' },
  { tag_name: 'not-a-version', name: 'odd' }
];
// The refs-API payloads (verified live: 200 -> an array with ONE entry
// {ref, url, object:{type:'commit', sha}}; unknown branch -> 404 JSON).
const refOf = (b, sha) => [
  { ref: 'refs/heads/' + b, url: 'https://git.samwarth.com/api/v1/repos/sam/idlefill/git/refs/heads/' + b,
    object: { type: 'commit', sha: sha, url: 'https://git.samwarth.com/api/v1/repos/sam/idlefill/git/commits/' + sha } }
];
const server = http.createServer((req, res) => {
  const u = req.url || '';
  if (u.startsWith('/api/v1/repos/sam/idlefill/releases')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(releases));
    return;
  }
  const m = u.match(/^\\/api\\/v1\\/repos\\/sam\\/idlefill\\/git\\/refs\\/heads\\/([A-Za-z0-9._-]+)$/);
  if (m) {
    if (m[1] === 'main') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(refOf('main', shaNew)));
      return;
    }
    if (m[1] === 'dev') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(refOf('dev', shaOlder)));
      return;
    }
    // unknown branch: the live API's exact 404 body.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: "The target couldn't be found." }));
    return;
  }
  if (u === '/releases/download/' + edgeMarker + '/IdlefillMenubar-' + edgeMarker + '.app.zip') {
    res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(zip); return;
  }
  if (u === '/releases/download/' + edgeMarker + '/IdlefillMenubar-' + edgeMarker + '.app.zip.sha256') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(good); return;
  }
  // The TAMPERED-sidecar route: a different tag, same zip bytes, bad hash.
  if (u === '/releases/download/edge-main-0000000/IdlefillMenubar-edge-main-0000000.app.zip') {
    res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(zip); return;
  }
  if (u === '/releases/download/edge-main-0000000/IdlefillMenubar-edge-main-0000000.app.zip.sha256') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(bad); return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
});
server.listen($PORT, '127.0.0.1', () => console.log('STUB-UP ' + $PORT));
setTimeout(() => process.exit(0), 120000);
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

# ---- compile the REAL source (minus @main) + the driver --------------------
sed '/^@main$/,/^}$/d' "$SRC" > "$T/menubar-under-test.swift"
if grep -q '@main' "$T/menubar-under-test.swift"; then echo "error: @main survived the strip"; exit 1; fi
grep -q 'struct IdlefillApp: App' "$T/menubar-under-test.swift" || { echo "error: IdlefillApp lost in the strip"; exit 1; }
grep -q 'enum UpdateCheck' "$T/menubar-under-test.swift" || { echo "error: UpdateCheck lost in the strip"; exit 1; }
grep -q 'static func branchUpdateMarker' "$T/menubar-under-test.swift" || { echo "error: branchUpdateMarker lost in the strip"; exit 1; }
grep -q 'updateChannel' "$T/menubar-under-test.swift" || { echo "error: ClientConfig.updateChannel lost in the strip"; exit 1; }

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
let bundleURL = URL(fileURLWithPath: bundleDest)
let refMain = "[{\"ref\":\"refs/heads/main\",\"object\":{\"type\":\"commit\",\"sha\":\"__SHANEW__\"}}]"
let refOlder = "[{\"ref\":\"refs/heads/dev\",\"object\":{\"type\":\"commit\",\"sha\":\"__SHAOLDER__\"}}]"
let ref404 = "{\"message\":\"The target couldn't be found.\"}"
let releasesCanned = "[{\"tag_name\":\"v3\"},{\"tag_name\":\"v2\"},{\"tag_name\":\"v1\"},{\"tag_name\":\"v0.0.2\"},{\"tag_name\":\"weird\"}]"

// ------------------------------------------------------- (a) pure branch
check("a: marker mismatch -> offer the tip marker",
      UpdateCheck.branchUpdateMarker(data: j(refMain), localMarker: "edge-main-1111111") == "edge-main-__SHA7NEW__")
check("a: equal markers -> nothing (up to date)",
      UpdateCheck.branchUpdateMarker(data: j(refMain), localMarker: "edge-main-__SHA7NEW__") == nil)
check("a: the branch name comes from the payload's ref (dev branch's tip)",
      UpdateCheck.branchUpdateMarker(data: j(refOlder), localMarker: "edge-main-__SHA7NEW__") == "edge-dev-__SHA7OLDER__")
check("a: unknown branch 404 JSON -> fail quiet (nil)",
      UpdateCheck.branchUpdateMarker(data: j(ref404), localMarker: "edge-main-1111111") == nil)
check("a: malformed sha (too short) -> fail quiet",
      UpdateCheck.branchUpdateMarker(data: j("[{\"ref\":\"refs/heads/main\",\"object\":{\"type\":\"commit\",\"sha\":\"abc\"}}]"),
                                     localMarker: "x") == nil)
check("a: malformed object type -> fail quiet",
      UpdateCheck.branchUpdateMarker(data: j("[{\"ref\":\"refs/heads/main\",\"object\":{\"type\":\"tag\",\"sha\":\"__SHANEW__\"}}]"),
                                     localMarker: "x") == nil)
check("a: not an array (the 404 body) -> fail quiet",
      UpdateCheck.branchUpdateMarker(data: j(ref404), localMarker: "x") == nil)
check("a: nil payload -> fail quiet",
      UpdateCheck.branchUpdateMarker(data: nil, localMarker: "x") == nil)
check("a: edgeMarker composes the marker",
      UpdateCheck.edgeMarker(branch: "main", sha7: "a9787a7") == "edge-main-a9787a7")

// ------------------------------------------- (b) the real fetch path (refs)
let semB = DispatchSemaphore(value: 0)
var bResult: (marker: String?, channel: String?) = ("__unset__", nil)
UpdateCheck.fetchBranchTip(base: "http://127.0.0.1:\(port)", branch: "main") { data in
  let m = AppModel()
  m.applyBranchCheck(data, branch: "main")
  bResult = (m.updateAvailable, m.updateChannel)
  semB.signal()
}
if semB.wait(timeout: .now() + 20) == .success {
  check("b: stub refs fetch (branch main) -> offers the tip marker",
        bResult.marker == "edge-main-__SHA7NEW__")
  check("b: the channel fact rides with the marker (the tracked branch)",
        bResult.channel == "main")
} else {
  failures += 1; print("FAIL b: stub refs fetch timed out")
}

// (b) equal markers via the real fetch: the tip marker from the payload,
// used as the LOCAL marker -> the pure verdict is nil (up to date). The
// model's apply path (applyBranchCheck) clears BOTH facts on a nil
// verdict (updateAvailable/updateChannel = r?.marker / r?.channel — the
// same nil path the 404 case below drives through the model).
let semB2 = DispatchSemaphore(value: 0)
var b2: (tip: String?, equalVerdict: String?) = (nil, nil)
UpdateCheck.fetchBranchTip(base: "http://127.0.0.1:\(port)", branch: "main") { data in
  let tip = UpdateCheck.branchUpdateMarker(data: data, localMarker: "definitely-not-the-tip")
  b2.tip = tip
  b2.equalVerdict = UpdateCheck.branchUpdateMarker(data: data, localMarker: tip ?? "")
  semB2.signal()
}
if semB2.wait(timeout: .now() + 20) == .success {
  check("b: equal markers via the real fetch -> nothing (up to date)",
        b2.tip == "edge-main-__SHA7NEW__" && b2.equalVerdict == nil)
} else {
  failures += 1; print("FAIL b: equal-markers fetch timed out")
}

// (b) unknown branch via the real fetch: the stub's 404 JSON -> fail quiet
// (nothing set, nothing cleared to a wrong value, no crash).
let semB3 = DispatchSemaphore(value: 0)
var b3: (marker: String?, channel: String?) = ("__unset__", nil)
UpdateCheck.fetchBranchTip(base: "http://127.0.0.1:\(port)", branch: "no-such-branch") { data in
  let m = AppModel()
  m.applyBranchCheck(data, branch: "no-such-branch")
  b3 = (m.updateAvailable, m.updateChannel)
  semB3.signal()
}
if semB3.wait(timeout: .now() + 20) == .success {
  check("b: unknown branch (404) via the real fetch -> fail quiet, nothing set",
        b3.marker == nil && b3.channel == nil)
} else {
  failures += 1; print("FAIL b: unknown-branch fetch timed out")
}

// (b) the AppModel init's OWN launch check fires at the DEAD base under
// env -i (the config's update_channel = main routes it to the refs API):
// silent, no crash, nothing set — the offline-tolerant contract.
let m2 = AppModel()
RunLoop.main.run(until: Date().addingTimeInterval(3.0))
check("b: offline (dead port) launch check -> silent, no crash, nothing set",
      m2.updateAvailable == nil && m2.updateChannel == nil && m2.updateNote == nil)

// ------------------------------------------- (c) releases channel (the
// back-switch rule + the unchanged numeric cases). Newest in the canned
// list = v3. Back-switch (non-numeric local) must offer the NEWEST
// unconditionally; the numeric rule offers the newest STRICTLY ABOVE.
check("c: back-switch — non-numeric local marker -> offers the newest release unconditionally",
      UpdateCheck.latestUpdateTag(data: j(releasesCanned), localVersion: "edge-main-a9787a7") == "3")
check("c: back-switch — a dev-build local version (0.0.0-dev) offers the newest release",
      UpdateCheck.latestUpdateTag(data: j(releasesCanned), localVersion: "0.0.0-dev") == "3")
check("c: back-switch — a local above the newest (out-of-range numeric) is still non-numeric -> offers the newest",
      UpdateCheck.latestUpdateTag(data: j(releasesCanned), localVersion: "999999") == "3")
check("c: numeric — v3 newest wins (unchanged rule)",
      UpdateCheck.latestUpdateTag(data: j(releasesCanned), localVersion: "1") == "3")
check("c: numeric — same -> nil (unchanged)",
      UpdateCheck.latestUpdateTag(data: j(releasesCanned), localVersion: "3") == nil)
check("c: numeric — local above the newest -> nil (unchanged)",
      UpdateCheck.latestUpdateTag(data: j(releasesCanned), localVersion: "9") == nil)
check("c: numeric — only older -> nil (unchanged)",
      UpdateCheck.latestUpdateTag(data: j("[{\"tag_name\":\"v0.0.1\"}]"), localVersion: "0.0.2") == nil)
check("c: numeric — two-digit above one-digit (v10 > v9, unchanged)",
      UpdateCheck.latestUpdateTag(data: j("[{\"tag_name\":\"v10\"}]"), localVersion: "9") == "10")
check("c: malformed payload -> nil (unchanged, fail quiet)",
      UpdateCheck.latestUpdateTag(data: j("not json"), localVersion: "0.0.2") == nil)
check("c: no valid tags -> nil (unchanged)",
      UpdateCheck.latestUpdateTag(data: j("[{\"tag_name\":\"weird\"}]"), localVersion: "1") == nil)
// The apply-path sets the channel fact: a release offer rides "releases".
let mC = AppModel()
mC.applyUpdateCheck(j(releasesCanned), localVersion: "edge-main-a9787a7")
check("c: applyUpdateCheck — back-switch offer rides channel 'releases'",
      mC.updateAvailable == "3" && mC.updateChannel == "releases")

// -------------------------------------------------- (d) channel-aware refs
check("d: downloadRef edge -> the marker IS the tag + the marker-named zip",
      UpdateCheck.downloadRef(version: "edge-main-a9787a7", isEdge: true).tag == "edge-main-a9787a7"
        && UpdateCheck.downloadRef(version: "edge-main-a9787a7", isEdge: true).zip == "IdlefillMenubar-edge-main-a9787a7.app.zip")
check("d: downloadRef release — byte-identical to the pre-#26 rule (numbered)",
      UpdateCheck.downloadRef(version: "1").tag == "v1"
        && UpdateCheck.downloadRef(version: "1").zip == "IdlefillMenubar-1.app.zip")
check("d: downloadRef release — byte-identical (legacy semver)",
      UpdateCheck.downloadRef(version: "0.0.2").tag == "v0.0.2"
        && UpdateCheck.downloadRef(version: "0.0.2").zip == "IdlefillMenubar-0.0.2.app.zip")
check("d: downloadRef release — v-prefixed input normalized to bare (unchanged)",
      UpdateCheck.downloadRef(version: "v1").tag == "v1"
        && UpdateCheck.downloadRef(version: "v1").zip == "IdlefillMenubar-1.app.zip")
check("d: downloadRef(version:isEdge:false) == downloadRef(version:)",
      UpdateCheck.downloadRef(version: "2", isEdge: false) == UpdateCheck.downloadRef(version: "2"))

// -------------------------------------------------- (e) the edge install
// The REAL UpdateCheck.install (sha256 verified BEFORE any swap) against
// the EDGE TAG on the stub — the channel-aware ref resolution feeds it.
let refEdge = UpdateCheck.downloadRef(version: "edge-main-__SHA7NEW__", isEdge: true)
check("e: the edge install's ref matches the stub's download routes",
      refEdge.tag == "edge-main-__SHA7NEW__" && refEdge.zip == "IdlefillMenubar-edge-main-__SHA7NEW__.app.zip")
let sem1 = DispatchSemaphore(value: 0)
var o1: UpdateCheck.Outcome = .refused("not-run")
UpdateCheck.install(base: "http://127.0.0.1:\(port)", tag: refEdge.tag, zipName: refEdge.zip,
                    bundleURL: bundleURL, label: "com.sam.idlefill.edge-scratch") {
  o1 = $0; sem1.signal()
}
if sem1.wait(timeout: .now() + 40) == .success {
  let bin = bundleURL.appendingPathComponent("Contents/MacOS/IdlefillMenubar").path
  let after = (try? String(contentsOfFile: bin, encoding: .utf8)) ?? ""
  check("e: correct sidecar -> verified + swapped in place (edge tag)",
        after.hasPrefix("NEW-EDGE-BUNDLE") && !isRefused(o1))
} else {
  failures += 1; print("FAIL e: edge install (correct sidecar) timed out")
}

// (e) TAMPERED sidecar on an edge tag -> refused, the current bundle kept.
let binPath = bundleURL.appendingPathComponent("Contents/MacOS/IdlefillMenubar").path
let currentBefore = (try? String(contentsOfFile: binPath, encoding: .utf8)) ?? ""
let refBad = UpdateCheck.downloadRef(version: "edge-main-0000000", isEdge: true)
let sem2 = DispatchSemaphore(value: 0)
var o2: UpdateCheck.Outcome = .refused("not-run")
UpdateCheck.install(base: "http://127.0.0.1:\(port)", tag: refBad.tag, zipName: refBad.zip,
                    bundleURL: bundleURL, label: "com.sam.idlefill.edge-scratch") {
  o2 = $0; sem2.signal()
}
if sem2.wait(timeout: .now() + 40) == .success {
  let nowAfter = (try? String(contentsOfFile: binPath, encoding: .utf8)) ?? ""
  check("e: tampered sidecar (edge tag) -> refused", isRefused(o2))
  check("e: tampered sidecar (edge tag) -> current bundle untouched", nowAfter == currentBefore)
} else {
  failures += 1; print("FAIL e: edge install (tampered sidecar) timed out")
}

if failures > 0 {
  print("EDGE-MB-FAILURES \(failures)")
  exit(1)
}
print("EDGE-MB-ALL-PASS")
exit(0)
EOF

# Bake the run-time values into the driver (|g: the shas + sha7s appear
# inside the marker strings; the source itself carries no test hooks
# beyond IDLEFILL_UPDATE_BASE, which the check reads at fetch time).
GOODHASH="$(cat "$GOOD")"
sed -e "s|__PORT__|$PORT|g" \
    -e "s|__BUNDLE__|$T/repo/menubar/IdlefillMenubar.app|g" \
    -e "s|__GOODHASH__|$GOODHASH|g" \
    -e "s|__SHANEW__|$SHA40_NEW|g" \
    -e "s|__SHAOLDER__|$SHA40_OLDER|g" \
    -e "s|__SHA7NEW__|$SHA_NEW|g" \
    -e "s|__SHA7OLDER__|$SHA_OLDER|g" \
    "$T/main.swift" > "$T/main.baked.swift"
mv "$T/main.baked.swift" "$T/main.swift"
grep -q '__SHA' "$T/main.swift" && { echo "error: a __SHA__ placeholder survived the bake"; exit 1; }

echo "==> swiftc (real source minus @main + driver)"
swiftc -O \
  -o "$T/edge-mb-test" \
  "$T/menubar-under-test.swift" "$T/main.swift" \
  -framework AppKit -framework SwiftUI 2>&1 | grep -E "error:" || true
[ -x "$T/edge-mb-test" ] || { echo "error: driver did not build"; exit 1; }

echo "==> run (env -i, the GUI environment; IDLEFILL_UPDATE_BASE -> dead port)"
RC=0
env -i PATH=/usr/bin:/bin \
  IDLEFILL_CONFIG_FILE="$T/repo/client/config.json" \
  IDLEFILL_UPDATE_BASE="http://127.0.0.1:1" \
  "$T/edge-mb-test" || RC=$?
echo "EDGE-MB-EXIT=$RC"
exit $RC
