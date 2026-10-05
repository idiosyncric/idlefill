#!/usr/bin/env bash
# Headless test for code-staleness (issue #49) on the desktop app: compile
# the REAL source (minus @main) + a driver, run under env -i with a scratch
# GIT repo — the same harness pattern as desktop/sessions-test.sh.
#
# What is proven:
#   1. The pure rule (AppModel.daemonBehind(reported:checkout:)):
#      mismatch -> true; full SHA vs its short prefix -> false; absent on
#      either side (old daemon / unreadable checkout) -> false; blank ->
#      false; case/whitespace tolerant.
#   2. The REAL poll path: a real AppModel whose repoRoot is a scratch GIT
#      checkout (real HEAD), canned /api/state payloads through
#      injectStatePayload — the same read site the 5s poll drives:
#        - my client row reports an OLDER commit -> daemonBehind (the tag
#          renders);
#        - the row reports THIS checkout's HEAD (the full SHA, as the
#          daemon sends it) -> cleared (the restart-cleared state);
#        - the row reports no revision (old daemon) -> false, renders as
#          before.
#
# Nothing networked: server_url points at a closed loopback port (the
# harness injects payloads; the poll itself fails quiet offline).
set -euo pipefail
T="$(mktemp -d /tmp/staleness-dt-test.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/desktop/IdlefillDesktop.swift"
VENDOR="$REPO/desktop/vendor/sparkle"

echo "==> workdir: $T"

# ---- scratch repo: a REAL git checkout (the comparison reads real HEAD) ----
mkdir -p "$T/repo/client"
printf '{ "name": "idlefill-scratch", "version": "0.1.0" }\n' > "$T/repo/package.json"
git -C "$T/repo" init -q
git -C "$T/repo" -c user.email=test@test -c user.name=test add -A
git -C "$T/repo" -c user.email=test@test -c user.name=test commit -qm init
HEAD_FULL=$(git -C "$T/repo" rev-parse HEAD)
HEAD_SHORT=$(git -C "$T/repo" rev-parse --short HEAD)
OTHER_FULL=$(printf '0%.0s' {1..40})   # 40 zeros — never this repo's HEAD
printf '{ "server_url": "http://127.0.0.1:1", "client_name": "stale-dt-test", "token": "arbiter-fixture-token" }\n' > "$T/repo/client/config.json"

# ---- compile the REAL source (minus @main) + the driver --------------------
sed '/^@main$/,/^}$/d' "$SRC" > "$T/desktop-under-test.swift"
if grep -q '@main' "$T/desktop-under-test.swift"; then echo "error: @main survived the strip"; exit 1; fi
grep -q 'static func daemonBehind' "$T/desktop-under-test.swift" || { echo "error: daemonBehind lost in the strip"; exit 1; }
grep -q 'func injectStatePayload' "$T/desktop-under-test.swift" || { echo "error: injectStatePayload lost in the strip"; exit 1; }
# The STATE panel renders the exception row (the visual pass is the eyeball step).
grep -q 'daemon behind' "$T/desktop-under-test.swift" || { echo "error: the daemon-behind row is not wired into StatePanel"; exit 1; }

cat > "$T/main.swift" <<'EOF'
import Foundation
import SwiftUI

var failures = 0
func check(_ name: String, _ cond: Bool) {
  if cond { print("PASS \(name)") } else { failures += 1; print("FAIL \(name)") }
}

let HEAD_FULL = "__HEAD_FULL__"
let HEAD_SHORT = "__HEAD_SHORT__"
let OTHER_FULL = "__OTHER_FULL__"

// ==========================================================================
// (1) the pure rule
// ==========================================================================
check("rule: mismatch -> true", AppModel.daemonBehind(reported: OTHER_FULL, checkout: HEAD_SHORT))
check("rule: full SHA vs its short prefix -> false (same commit)",
      !AppModel.daemonBehind(reported: HEAD_FULL, checkout: HEAD_SHORT))
check("rule: short vs full prefix the other way -> false",
      !AppModel.daemonBehind(reported: HEAD_SHORT, checkout: HEAD_FULL))
check("rule: equal -> false", !AppModel.daemonBehind(reported: HEAD_FULL, checkout: HEAD_FULL))
check("rule: absent reported (old daemon) -> false", !AppModel.daemonBehind(reported: nil, checkout: HEAD_SHORT))
check("rule: absent checkout -> false", !AppModel.daemonBehind(reported: HEAD_FULL, checkout: nil))
check("rule: blank reported -> false", !AppModel.daemonBehind(reported: "   ", checkout: HEAD_SHORT))
check("rule: case-tolerant -> false",
      !AppModel.daemonBehind(reported: HEAD_FULL.uppercased(), checkout: HEAD_SHORT))

// ==========================================================================
// (2) the REAL model path against the scratch repo's REAL HEAD
// ==========================================================================
func clientPayload(revisionJSON: String) -> [String: Any] {
  let json: String
  if revisionJSON.isEmpty {
    json = """
    { "clients": [{ "client_id": "c-dt", "name": "stale-dt-test",
                    "last_seen": \(Int(Date().timeIntervalSince1970 * 1000)),
                    "projects": [] }],
      "idle": { "idle": true, "degraded": false } }
    """
  } else {
    json = """
    { "clients": [{ "client_id": "c-dt", "name": "stale-dt-test",
                    "last_seen": \(Int(Date().timeIntervalSince1970 * 1000)),
                    "projects": [], "revision": "\(revisionJSON)" }],
      "idle": { "idle": true, "degraded": false } }
    """
  }
  guard let d = json.data(using: .utf8),
        let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
    fatalError("bad fixture json")
  }
  return o
}

let m = AppModel()
RunLoop.main.run(until: Date().addingTimeInterval(0.5))

m.injectStatePayload(clientPayload(revisionJSON: OTHER_FULL))
check("live: my row reports an older commit -> daemonBehind", m.daemonBehind)

m.injectStatePayload(clientPayload(revisionJSON: HEAD_FULL))
check("live: my row reports this checkout's HEAD -> cleared (restart state)", !m.daemonBehind)

m.injectStatePayload(clientPayload(revisionJSON: ""))
check("live: my row with NO revision (old daemon) -> renders as before", !m.daemonBehind)

if failures > 0 {
  print("STALENESS-DT-FAILURES \(failures)")
  exit(1)
}
print("STALENESS-DT-ALL-PASS")
exit(0)
EOF

sed -e "s|__HEAD_FULL__|$HEAD_FULL|g" -e "s|__HEAD_SHORT__|$HEAD_SHORT|g" -e "s|__OTHER_FULL__|$OTHER_FULL|g" \
  "$T/main.swift" > "$T/main.baked.swift"
mv "$T/main.baked.swift" "$T/main.swift"

echo "==> swiftc (real source minus @main + driver)"
swiftc -O \
  -o "$T/staleness-dt-test" \
  "$T/desktop-under-test.swift" "$T/main.swift" \
  -framework AppKit -framework SwiftUI \
  -F "$VENDOR" -framework Sparkle \
  -Xlinker -rpath -Xlinker "@loader_path/Frameworks" 2>&1 | grep -E "error:" || true
[ -x "$T/staleness-dt-test" ] || { echo "error: driver did not build"; exit 1; }

mkdir -p "$T/Frameworks"
ln -s "$VENDOR/Sparkle.framework" "$T/Frameworks/Sparkle.framework"

echo "==> run (env -i, the GUI environment; scratch repo -> git HEAD)"
RC=0
env -i PATH=/usr/bin:/bin \
  HOME="$T/home" \
  IDLEFILL_REPO_PATH="$T/repo" \
  "$T/staleness-dt-test" || RC=$?
echo "STALENESS-DT-EXIT=$RC"
rm -rf "$T"
exit $RC
