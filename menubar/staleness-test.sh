#!/usr/bin/env bash
# Headless test for code-staleness (issue #49) on the menubar panel:
# compile the REAL source (minus @main) + a driver, run under env -i —
# the same harness pattern as panel-test.sh / scope-test.sh.
#
# What is proven:
#   1. The pure rule (AppModel.daemonBehind(reported:checkout:)):
#      mismatch -> true; equal -> false; the daemon's FULL SHA vs the
#      checkout's short prefix -> false (same commit); absent on either
#      side (old daemon / unreadable checkout) -> false; blank -> false;
#      case/whitespace tolerant.
#   2. The REAL poll path: a real AppModel against a scratch GIT repo
#      (real HEAD), canned /api/state payloads through injectStatePayload
#      — the same read site the 10s poll drives:
#        - the name-matched row reports a DIFFERENT revision -> tag on;
#        - the row reports THIS checkout's HEAD (full SHA) -> tag off
#          (the restart-cleared state);
#        - the row reports no revision (old daemon) -> tag off, renders
#          as before.
#
# Nothing networked: server_url points at a closed loopback port.
set -euo pipefail
T="$(mktemp -d /tmp/staleness-mb-test.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/menubar/IdlefillMenubar.swift"

echo "==> workdir: $T"

# ---- scratch repo: a REAL git checkout (the comparison reads real HEAD) ----
mkdir -p "$T/repo/client"
cat > "$T/repo/package.json" <<'EOF'
{ "name": "idlefill-scratch", "version": "0.1.0" }
EOF
git -C "$T/repo" init -q
git -C "$T/repo" -c user.email=test@test -c user.name=test add -A
git -C "$T/repo" -c user.email=test@test -c user.name=test commit -qm init
HEAD_FULL=$(git -C "$T/repo" rev-parse HEAD)
HEAD_SHORT=$(git -C "$T/repo" rev-parse --short HEAD)
OTHER_FULL=$(printf '0%.0s' {1..40})   # 40 zeros — never this repo's HEAD
cat > "$T/repo/client/config.json" <<EOF
{ "server_url": "http://127.0.0.1:1", "client_name": "stale-test" }
EOF

# ---- compile the REAL source (minus @main) + the driver --------------------
sed '/^@main$/,/^}$/d' "$SRC" > "$T/menubar-under-test.swift"
if grep -q '@main' "$T/menubar-under-test.swift"; then echo "error: @main survived the strip"; exit 1; fi
grep -q 'static func daemonBehind' "$T/menubar-under-test.swift" || { echo "error: daemonBehind lost in the strip"; exit 1; }

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
check("rule: whitespace-tolerant -> false",
      !AppModel.daemonBehind(reported: "  \(HEAD_FULL) ", checkout: " \(HEAD_SHORT)"))

// ==========================================================================
// (2) the REAL model path: name-matched row + this checkout's real HEAD
// ==========================================================================
func payload(revisionJSON: String) -> [String: Any] {
  var row: [String: Any] = [
    "client_id": "c-stale", "name": "stale-test",
    "last_seen": Date().timeIntervalSince1970 * 1000,
    "projects": [[String: Any]](),
  ]
  if !revisionJSON.isEmpty { row["revision"] = revisionJSON }
  return ["clients": [row], "idle": ["idle": true, "degraded": false]]
}

let m = AppModel()
RunLoop.main.run(until: Date().addingTimeInterval(0.5))

m.injectStatePayload(payload(revisionJSON: OTHER_FULL))
check("live: row reports an older commit -> daemonBehind", m.daemonBehind)

m.injectStatePayload(payload(revisionJSON: HEAD_FULL))
check("live: row reports this checkout's HEAD -> cleared (restart state)", !m.daemonBehind)

m.injectStatePayload(payload(revisionJSON: ""))
check("live: row with NO revision (old daemon) -> renders as before", !m.daemonBehind)

// A row that is NOT the name match never drives the flag for this machine.
let m2 = AppModel()
RunLoop.main.run(until: Date().addingTimeInterval(0.5))
var p = payload(revisionJSON: OTHER_FULL)
p["clients"] = [["client_id": "c-other", "name": "someone-else",
                 "last_seen": Date().timeIntervalSince1970 * 1000,
                 "projects": [[String: Any]](), "revision": OTHER_FULL]]
m2.injectStatePayload(p)
check("live: another machine's row cannot drive this machine's flag", !m2.daemonBehind)

if failures > 0 {
  print("STALENESS-FAILURES \(failures)")
  exit(1)
}
print("STALENESS-ALL-PASS")
exit(0)
EOF

sed -e "s|__HEAD_FULL__|$HEAD_FULL|g" -e "s|__HEAD_SHORT__|$HEAD_SHORT|g" -e "s|__OTHER_FULL__|$OTHER_FULL|g" \
  "$T/main.swift" > "$T/main.baked.swift"
mv "$T/main.baked.swift" "$T/main.swift"

echo "==> swiftc (real source minus @main + driver)"
swiftc -O \
  -o "$T/staleness-mb-test" \
  "$T/menubar-under-test.swift" "$T/main.swift" \
  -framework AppKit -framework SwiftUI 2>&1 | grep -E "error:" || true
[ -x "$T/staleness-mb-test" ] || { echo "error: driver did not build"; exit 1; }

echo "==> run (env -i, the GUI environment)"
RC=0
env -i PATH=/usr/bin:/bin \
  IDLEFILL_CONFIG_FILE="$T/repo/client/config.json" \
  IDLEFILL_UPDATE_BASE="http://127.0.0.1:1" \
  "$T/staleness-mb-test" || RC=$?
echo "STALENESS-EXIT=$RC"
rm -rf "$T"
exit $RC
