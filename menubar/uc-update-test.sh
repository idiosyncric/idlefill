#!/usr/bin/env bash
# Headless test for the menubar's Update Code (issue #11 DoD):
#   - compile the REAL source (minus @main) + a driver,
#   - run under env -i (the GUI environment),
#   - drive the REAL UpdatePlan (pure decision) and the REAL UpdateFacts
#     git wrappers against SCRATCH repos (a local bare origin + file:// clone),
#   - AND drive the REAL AppModel.updateCode() end-to-end against a scratch
#     repo (with a committed stub menubar/build.sh + a dead update base),
#   - prove the daemon-PID matcher returns exactly the production daemon pair.
#
# DoD scenarios: (a) dirty-tree refusal, (b) clean no-delta -> no-op,
# (c) clean delta, lock unchanged -> merge applied, NO npm ci, (d) clean
# delta, lock changed -> install step recorded + npm ci runs, (e) fetch
# failure (dead remote) -> refusal, nothing written, (f) divergence -> refusal.
set -euo pipefail
T="$(mktemp -d /tmp/uc11.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/menubar/IdlefillMenubar.swift"

echo "==> workdir: $T"

# ---------------------------------------------------------------------------
# scratch-repo factory. Each case gets: a bare origin.git + a work clone.
# The seed commit ALSO carries a stub menubar/build.sh (committed, so it is
# tracked + clean) so the REAL updateCode() build step can run in the scratch.
# ---------------------------------------------------------------------------
mk_base() { # <dir>
  local dir="$1"
  git init -q --bare "$dir/origin.git"
  git init -q -b main "$dir/seed"
  ( cd "$dir/seed"
    git config user.email t@t.t; git config user.name t
    echo "lock-v1" > package-lock.json
    echo '{ "name": "idlefill-scratch", "version": "0.1.0" }' > package.json
    mkdir -p client/src menubar
    echo 'console.log("idlefill")' > client/src/index.ts
    echo "release A" > RELEASE.txt
    # The real repo ignores *.log (and its logs/ dirs); the scratch repo must
    # too, or the logs/ dir updateCode() creates before gate (a) would make
    # the tree look dirty (status --porcelain: ?? logs/).
    printf 'logs/\n*.log\nnode_modules/\n' > .gitignore
    cat > menubar/build.sh <<'STUB'
#!/usr/bin/env bash
echo "STUB-BUILD $PWD"
touch "$PWD/.uc11-build-ran"
STUB
    git add -A; git commit -qm A
    git remote add origin "$dir/origin.git"
    git push -q -u origin main )
  git clone -q -b main "$dir/origin.git" "$dir/work"
  ( cd "$dir/work"; git config user.email t@t.t; git config user.name t )
}

# advance <dir> <file> <content>: push one new commit (to origin) changing <file>.
advance() {
  local dir="$1" file="$2" content="$3"
  git clone -q -b main "$dir/origin.git" "$dir/adv"
  ( cd "$dir/adv"; git config user.email t@t.t; git config user.name t
    printf '%s\n' "$content" > "$file"
    git add -A; git commit -qm B; git push -q origin main )
  rm -rf "$dir/adv"
}

# ---- case repos ----------------------------------------------------------
mk_base "$T/A"                                   # (b) clean, no delta
mk_base "$T/B"
printf 'dirty\n' >> "$T/B/work/RELEASE.txt"      # (a) dirty tree
mk_base "$T/C"
advance "$T/C" RELEASE.txt "release B"           # (c) delta, lock unchanged
mk_base "$T/D"                                    # (d) delta, lock CHANGED
git clone -q -b main "$T/D/origin.git" "$T/D/adv"
( cd "$T/D/adv"; git config user.email t@t.t; git config user.name t
  printf '{ "name": "idlefill-scratch", "version": "0.2.0", "dependencies": { "left-pad": "1.3.0" } }\n' > package.json
  cat > package-lock.json <<'LOCKB'
{
  "name": "idlefill-scratch",
  "version": "0.2.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "idlefill-scratch", "version": "0.2.0", "dependencies": { "left-pad": "1.3.0" } },
    "node_modules/left-pad": { "version": "1.3.0", "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", "integrity": "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==" }
  }
}
LOCKB
  echo "release D" > RELEASE.txt
  git add -A; git commit -qm D; git push -q origin main )
rm -rf "$T/D/adv"
mk_base "$T/E"
git -C "$T/E/work" remote set-url origin "file:///$T/E/does-not-exist.git"   # (e) dead remote
mk_base "$T/F"
advance "$T/F" RELEASE.txt "remote B"
( cd "$T/F/work"; echo "local-only" >> RELEASE.txt; git add -A; git commit -qm "local D" ) # (f) diverged

# ---- scratch config (so AppModel init targets a dead port, no real net) --
mkdir -p "$T/repoA/client"
cat > "$T/repoA/client/config.json" <<'EOF'
{ "server_url": "http://127.0.0.1:1", "token": "scratch-not-a-real-token", "client_name": "uc11" }
EOF

# ---- the production daemon pair (read from the REAL ps table) -------------
PROD_REPO="/Users/sam/Software/idlefill"
PROD_PIDS="$(/bin/ps -ax -o pid=,command= | grep -F "$PROD_REPO" | grep -F "src/index.ts" | awk '{print $1}' | grep -E '^[0-9]+$' | tr '\n' ' ')"
[ -n "$PROD_PIDS" ] || { echo "error: no production daemon PIDs found on this box"; exit 1; }
PROD_NM="$PROD_REPO/node_modules"
PROD_NM_MTIME_BEFORE="$([ -d "$PROD_NM" ] && stat -f %m "$PROD_NM" || echo absent)"
echo "==> production daemon PIDs (before): $PROD_PIDS"

# ---- compile the REAL source (minus @main) + the driver -------------------
sed '/^@main$/,/^}$/d' "$SRC" > "$T/menubar-under-test.swift"
if grep -q '@main' "$T/menubar-under-test.swift"; then echo "error: @main survived the strip"; exit 1; fi
grep -q 'enum UpdatePlan' "$T/menubar-under-test.swift" || { echo "error: UpdatePlan lost in the strip"; exit 1; }
grep -q 'enum UpdateFacts' "$T/menubar-under-test.swift" || { echo "error: UpdateFacts lost in the strip"; exit 1; }
grep -q 'enum UpdateLog'  "$T/menubar-under-test.swift" || { echo "error: UpdateLog lost in the strip"; exit 1; }
grep -q 'func updateCode' "$T/menubar-under-test.swift" || { echo "error: updateCode lost in the strip"; exit 1; }

cat > "$T/main.swift" <<'SWIFT'
import Foundation

var failures = 0
func check(_ name: String, _ cond: Bool) {
  if cond { print("PASS \(name)") } else { failures += 1; print("FAIL \(name)") }
}
let T = "__T__"
let PROD_REPO = "__PROD_REPO__"
let PROD_PIDS = "__PROD_PIDS__"
let WORKTREE = "__WORKTREE__"

func fileExists(_ p: String) -> Bool { FileManager.default.fileExists(atPath: p) }
func readFile(_ p: String) -> String { (try? String(contentsOfFile: p, encoding: .utf8)) ?? "" }
func logOf(_ d: String) -> String { ((d as NSString).appendingPathComponent("work") as NSString).appendingPathComponent("logs/idlefill-menubar.log") }
func lines(_ s: String) -> [String] { s.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) }
func lastLine(_ s: String, containing sub: String) -> String? {
  for l in lines(s).reversed() where l.contains(sub) { return l }
  return nil
}
// true if a line containing <cmd> is followed (within 6 lines) by <exit>.
func logHas(_ log: String, cmd: String, exit: String) -> Bool {
  let l = lines(log)
  guard let i = l.firstIndex(where: { $0.contains(cmd) }) else { return false }
  let window = Array(l[(i + 1)...].prefix(6))
  return window.contains { $0.contains(exit) }
}
func env(_ k: String, _ v: String) { setenv(k, v, 1) }
// Point the app's OWN updateCode at a scratch repo: set the repoRootOverride
// (a plain property, since setenv after process start is not reflected in
// ProcessInfo.environment) and drive the real AppModel.updateCode().
func freshModel(_ repo: String) -> AppModel {
  let m = AppModel()
  m.repoRootOverride = repo
  return m
}
func shortSha(_ rev: String, _ repo: String) -> String? { UpdateFacts.shortSha(rev, cwd: repo) }

// ============================================================ pure decision
let pNoDaemon = UpdatePlan.plan(UpdatePlan.Input(treeClean: true, fetchOk: true, isAncestor: true, hasDelta: true,
                                                 lockChanged: false, daemonPids: [], labelLoaded: false,
                                                 thisIsLabelBinary: false, currentShortSha: "aaa"))
check("pure: no-daemon -> proceed, no startDaemon", pNoDaemon.gate == .proceed && !pNoDaemon.steps.contains(.startDaemon))
check("pure: no-daemon -> no install (lock unchanged)", !pNoDaemon.steps.contains(.install))
check("pure: no-daemon -> note says no restart", pNoDaemon.note.contains("daemon was not running — no restart"))
let pDaemon = UpdatePlan.plan(UpdatePlan.Input(treeClean: true, fetchOk: true, isAncestor: true, hasDelta: true,
                                               lockChanged: false, daemonPids: [4242], labelLoaded: false,
                                               thisIsLabelBinary: false, currentShortSha: "aaa"))
check("pure: daemon running -> startDaemon present", pDaemon.steps.contains(.startDaemon))
check("pure: daemon running -> note has no restart clause", !pDaemon.note.contains("daemon was not running"))
let pLock = UpdatePlan.plan(UpdatePlan.Input(treeClean: true, fetchOk: true, isAncestor: true, hasDelta: true,
                                             lockChanged: true, daemonPids: [], labelLoaded: false,
                                             thisIsLabelBinary: false, currentShortSha: "aaa"))
check("pure: lock changed -> install present", pLock.steps.contains(.install))
let pKick = UpdatePlan.plan(UpdatePlan.Input(treeClean: true, fetchOk: true, isAncestor: true, hasDelta: true,
                                             lockChanged: false, daemonPids: [], labelLoaded: true,
                                             thisIsLabelBinary: true, currentShortSha: "aaa"))
check("pure: label loaded + label binary -> kick present", pKick.steps.contains(.kickMenubar))
let pNoKick = UpdatePlan.plan(UpdatePlan.Input(treeClean: true, fetchOk: true, isAncestor: true, hasDelta: true,
                                               lockChanged: false, daemonPids: [], labelLoaded: true,
                                               thisIsLabelBinary: false, currentShortSha: "aaa"))
check("pure: label loaded but NOT the label binary -> no kick (note only)", !pNoKick.steps.contains(.kickMenubar))
check("pure: dirty -> refuse, no steps",
      UpdatePlan.plan(UpdatePlan.Input(treeClean: false, fetchOk: true, isAncestor: true, hasDelta: true,
                                       lockChanged: false, daemonPids: [], labelLoaded: false,
                                       thisIsLabelBinary: false, currentShortSha: "a")).gate == .refuse(.dirty))
check("pure: fetch fail -> refuse, no steps",
      UpdatePlan.plan(UpdatePlan.Input(treeClean: true, fetchOk: false, isAncestor: true, hasDelta: true,
                                       lockChanged: false, daemonPids: [], labelLoaded: false,
                                       thisIsLabelBinary: false, currentShortSha: "a")).gate == .refuse(.fetch))
check("pure: diverged -> refuse, no steps",
      UpdatePlan.plan(UpdatePlan.Input(treeClean: true, fetchOk: true, isAncestor: false, hasDelta: true,
                                       lockChanged: false, daemonPids: [], labelLoaded: false,
                                       thisIsLabelBinary: false, currentShortSha: "a")).gate == .refuse(.diverged))
check("pure: no delta -> noOp",
      UpdatePlan.plan(UpdatePlan.Input(treeClean: true, fetchOk: true, isAncestor: true, hasDelta: false,
                                       lockChanged: false, daemonPids: [], labelLoaded: false,
                                       thisIsLabelBinary: false, currentShortSha: "abc1234")).gate == .noOp)
check("pure: logLine format",
      UpdatePlan.logLine(oldShort: "a1", newShort: "b2", daemonPid: 1234, lockChanged: true, timestamp: "TS")
      == "a1 → b2 TS daemon-pid=1234 lock-changed=yes")

// ===================================================== (b) clean no-delta
let mA = freshModel("\(T)/A/work")
mA.updateCode()
let logA = readFile(logOf("\(T)/A"))
check("(b) no-delta -> up-to-date note",
      mA.updateNote == "already up to date (\(shortSha("HEAD", "\(T)/A/work") ?? "?"))")
check("(b) no-delta -> fetch was read-only (logged, nothing written)",
      logA.contains("git fetch origin main") && !logA.contains("git merge") && !logA.contains("npm ci"))
check("(b) no-delta -> no rebuild, no restart", !fileExists("\(T)/A/work/.uc11-build-ran"))
check("(b) no-delta -> deployedRevision = current sha",
      mA.deployedRevision == (shortSha("HEAD", "\(T)/A/work") ?? "?"))

// ========================================================== (a) dirty tree
let mB = freshModel("\(T)/B/work")
mB.updateCode()
check("(a) dirty -> refusal note",
      mB.updateNote == "tree not clean — commit or stash first, update aborted")
check("(a) dirty -> dirty file untouched", readFile("\(T)/B/work/RELEASE.txt").contains("dirty"))
check("(a) dirty -> no log file written", !fileExists(logOf("\(T)/B")))

// ================================================== (c) delta, lock unchanged
let cBefore = shortSha("HEAD", "\(T)/C/work") ?? "?"
// The target sha = origin's main (commit B). Read it from the BARE origin
// (which already has B) — NOT from the work clone's origin/main, which the
// update's own fetch is what moves to B (pre-fetch it still equals A=HEAD).
let cAfter  = shortSha("main", "\(T)/C/origin.git") ?? "?"
let mC = freshModel("\(T)/C/work")
mC.updateCode()
check("(c) note is the update record (lock-changed=no)",
      (mC.updateNote ?? "").hasPrefix("updated") && mC.updateNote?.contains("lock-changed=no") == true)
check("(c) log has the fetch (read-only)", readFile(logOf("\(T)/C")).contains("git fetch origin main"))
check("(c) log has the merge", readFile(logOf("\(T)/C")).contains("git merge --ff-only origin/main"))
check("(c) merge applied to the working tree",
      shortSha("HEAD", "\(T)/C/work") == cAfter && readFile("\(T)/C/work/RELEASE.txt").contains("release B"))
check("(c) NO npm ci (lock unchanged)", !readFile(logOf("\(T)/C")).contains("npm ci"))
check("(c) build ran (stub)", fileExists("\(T)/C/work/.uc11-build-ran"))
check("(c) deployedRevision = new sha", mC.deployedRevision == cAfter)
check("(c) log revision line",
      (lastLine(readFile(logOf("\(T)/C")), containing: "daemon-pid=") ?? "").contains("\(cBefore) → \(cAfter)"))

// ============================================== (d) delta, lock CHANGED
let dBefore = shortSha("HEAD", "\(T)/D/work") ?? "?"
// Target sha from the BARE origin (commit D) — the work clone's origin/main
// is what the update's own fetch moves to D.
let dAfter  = shortSha("main", "\(T)/D/origin.git") ?? "?"
let mD = freshModel("\(T)/D/work")
mD.updateCode()
let logD = readFile(logOf("\(T)/D"))
check("(d) note lock-changed=yes", mD.updateNote?.contains("lock-changed=yes") == true)
check("(d) install step recorded (npm ci exit 0)", logHas(logD, cmd: "npm ci", exit: "[exit 0]"))
check("(d) merge applied (HEAD == origin/main)", shortSha("HEAD", "\(T)/D/work") == dAfter)
check("(d) node_modules installed (npm ci really ran)", fileExists("\(T)/D/work/node_modules"))
check("(d) deployedRevision = new sha", mD.deployedRevision == dAfter)

// ==================================================== (e) fetch failure
let mE = freshModel("\(T)/E/work")
mE.updateCode()
check("(e) dead remote -> fetch-fail note", mE.updateNote == "fetch failed — update aborted")
check("(e) log has the failed fetch", readFile(logOf("\(T)/E")).contains("git fetch origin main"))
check("(e) NOTHING written (no merge)", !readFile(logOf("\(T)/E")).contains("git merge"))

// ======================================================== (f) divergence
let mF = freshModel("\(T)/F/work")
mF.updateCode()
let logF = readFile(logOf("\(T)/F"))
check("(f) diverged -> refusal note",
      mF.updateNote == "local branch diverged from origin/main — reconcile first, update aborted")
check("(f) log has the (successful) fetch", logF.contains("git fetch origin main"))
check("(f) NOTHING written (no merge)", !logF.contains("git merge"))
check("(f) local commit untouched (still diverged)",
      shortSha("HEAD", "\(T)/F/work") != shortSha("origin/main", "\(T)/F/work"))

// ==================================================== rotation unit case
let rotLog = "\(T)/rot/idlefill-menubar.log"
try? FileManager.default.createDirectory(atPath: (rotLog as NSString).deletingLastPathComponent,
                                         withIntermediateDirectories: true)
var rot = Data()
rot.append("HEADMARKER\n".data(using: .utf8)!)
rot.append(Data(repeating: 0x62, count: 1_258_291))       // ~1.2 MiB filler (no newlines)
rot.append("TAILMARKER-KEEP\n".data(using: .utf8)!)
try! rot.write(to: URL(fileURLWithPath: rotLog))
UpdateLog.append("POSTROTATION", at: rotLog)
let after = readFile(rotLog)
check("rotation: over cap -> head gone", !after.contains("HEADMARKER"))
check("rotation: tail kept", after.contains("TAILMARKER-KEEP"))
check("rotation: new line appended after rotation", after.contains("POSTROTATION"))
let rotSize = (try? Data(contentsOf: URL(fileURLWithPath: rotLog)))?.count ?? Int.max
check("rotation: file <= cap + one line", rotSize <= Int(UpdateLog.capBytes) + 512)

// ============================================ daemon-PID matcher (live ps)
let prodPids = AppModel.daemonPIDs(repo: PROD_REPO)
let want = PROD_PIDS.split(separator: " ").compactMap { Int($0) }
check("daemon-PIDs: exactly the production pair (\(want))", prodPids.sorted() == want.sorted())
check("daemon-PIDs: worktree repo -> none (no false match)", AppModel.daemonPIDs(repo: WORKTREE) == [])

if failures > 0 { print("UC11-FAILURES \(failures)"); exit(1) }
print("UC11-ALL-PASS")
exit(0)
SWIFT

# Bake run-time values into the driver.
sed -e "s|__T__|$T|" \
    -e "s|__PROD_REPO__|$PROD_REPO|" \
    -e "s|__PROD_PIDS__|$PROD_PIDS|" \
    -e "s|__WORKTREE__|$REPO|" \
    "$T/main.swift" > "$T/main.baked.swift"
mv "$T/main.baked.swift" "$T/main.swift"

echo "==> swiftc (real source minus @main + driver)"
swiftc -O -o "$T/uc11" "$T/menubar-under-test.swift" "$T/main.swift" -framework AppKit -framework SwiftUI 2>&1 | grep -E "error:" || true
[ -x "$T/uc11" ] || { echo "error: driver did not build"; exit 1; }

echo "==> run (env -i, the GUI environment)"
RC=0
env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
  IDLEFILL_CONFIG_FILE="$T/repoA/client/config.json" \
  IDLEFILL_UPDATE_BASE="http://127.0.0.1:1" \
  IDLEFILL_MENUBAR_LABEL="com.sam.idlefill.uc11-scratch" \
  "$T/uc11" || RC=$?
echo "UC11-EXIT=$RC"

# ---- the production daemon must be UNTOUCHED (still the same two PIDs) ----
PROD_PIDS_AFTER="$(/bin/ps -ax -o pid=,command= | grep -F "$PROD_REPO" | grep -F "src/index.ts" | awk '{print $1}' | grep -E '^[0-9]+$' | tr '\n' ' ')"
PROD_NM_MTIME_AFTER="$([ -d "$PROD_NM" ] && stat -f %m "$PROD_NM" || echo absent)"
echo "==> production daemon PIDs (after): $PROD_PIDS_AFTER"
echo "==> production node_modules mtime: $PROD_NM_MTIME_BEFORE -> $PROD_NM_MTIME_AFTER"
if [ "$PROD_PIDS_AFTER" != "$PROD_PIDS" ]; then
  echo "error: production daemon PIDs changed — the update touched the live daemon"; RC=1
fi
if [ "$PROD_NM_MTIME_BEFORE" != "$PROD_NM_MTIME_AFTER" ] && [ "$PROD_NM_MTIME_BEFORE" != "absent" ]; then
  echo "error: production node_modules mtime changed — the update touched the live tree"; RC=1
fi

exit $RC
