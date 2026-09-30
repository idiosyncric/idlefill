//
//  IdlefillMenubar.swift — the idlefill menu bar companion (macOS 14+).
//
//  A status-bar icon (AppKit NSStatusItem + NSPopover hosting the SwiftUI
//  panel — MenuBarExtra exposes no click count, which the double-click
//  routing below needs) showing the arbiter state at a glance and
//  controlling the local client daemon:
//
//    status   — color-coded state word + this machine's live status row
//    stats    — queue depth, today finished/failed, tokens out (UTC), the
//               running lease (job · auto-cancels-in)
//    actions  — Open Dashboard · Show Logs · Start/Stop · Restart ·
//               Update code (gated fast-forward + lock-delta install +
//               menu-bar rebuild + daemon restart) · Quit
//
//  Click routing (decided by the pure MenuBarRouter — testable headlessly):
//    single click  — toggle the popover (today's behavior, exactly)
//    double click  — open the DESKTOP app on its State view:
//                    NSWorkspace.open of idlefill://open, falling back to
//                    `open /Applications/Idlefill.app` when the URL-scheme
//                    open is not handled (the desktop app not registered
//                    yet). A double click ALWAYS attempts the desktop app —
//                    only the two panel rows below fall back.
//
//  Re-routed panel rows (same button-row style; the desktop app is
//  "installed" when /Applications/Idlefill.app exists — the standard
//  install target per desktop/update.sh):
//    Show Logs      — installed: idlefill://logs (the desktop app's Logs
//                     view); not installed: open the daemon log dir in
//                     Finder (today's behavior).
//    Open Dashboard — installed: idlefill://projects (the desktop app's
//                     Projects view — this client's project config); not
//                     installed: open server_url/ in the browser (today's
//                     behavior). With the desktop app installed, the menu
//                     bar no longer opens the arbiter web dashboard.
//
//  Design: quiet control room (DESIGN.md). Neutral canvas (#0d1117), hairline
//  dividers (#30363d), one mono family, four signal colors used ONLY for
//  live state (green idle, amber busy, blue working, red degraded). The
//  icon arc sits at rest (gap at the bottom) and rotates a quarter turn
//  while this client holds an active lease — the one live element.
//
//  Daemon liveness comes from the arbiter's own view (the client row's
//  `online` flag = last_seen < 90s), not from a local process table — the
//  daemon can be started from anywhere (menu bar, orca tab, launchd) and
//  the arbiter is the ground truth. Stop sends SIGINT (the daemon's clean
//  shutdown: mid-lease teardown reports partial usage, the job stays queued).
//
//  The token is read at runtime from the gitignored client config
//  (IDLEFILL_CONFIG_FILE or <repo>/client/config.json) — it is never baked
//  into this file or the binary.
//

import AppKit
import SwiftUI
import CryptoKit

// The version baked into the binary at build time. menubar/build.sh
// substitutes the QUOTED placeholder literal (the declaration below — the
// only QUOTED occurrence of the placeholder in the file; the sentinel is
// fragmented so the build's sed can never touch it) with the release
// version (IDLEFILL_VERSION — default: the root package.json version, the
// single version source) BEFORE compiling, so a release binary prints the
// release it was built from — even on a checkout whose package.json has
// since moved on. DO NOT RENAME OR DELETE: build.sh byte-verifies this
// exact declaration (a silent miss would bake the placeholder string into
// the binary).
let __MENUBAR_VERSION__ = "__MENUBAR_VERSION__"
/// The UNSUBSTITUTED marker (fragmented — the build's sed only touches the
/// quoted placeholder literal, so this comparison survives the injection).
let __MENUBAR_VERSION_UNSUBSTITUTED__ = "__MENUBAR_" + "VERSION__"

// MARK: - palette (DESIGN.md tokens)

enum Pal {
  static let canvas   = Color(red: 0x0d / 255, green: 0x11 / 255, blue: 0x17 / 255)
  static let hairline = Color(red: 0x30 / 255, green: 0x36 / 255, blue: 0x3d / 255)
  static let text     = Color(red: 0xc9 / 255, green: 0xd1 / 255, blue: 0xd9 / 255)
  static let dim      = Color(red: 0x8b / 255, green: 0x94 / 255, blue: 0x9e / 255)
  static let ok       = Color(red: 0x3f / 255, green: 0xb9 / 255, blue: 0x50 / 255)
  static let warn     = Color(red: 0xd2 / 255, green: 0x99 / 255, blue: 0x22 / 255)
  static let err      = Color(red: 0xf8 / 255, green: 0x51 / 255, blue: 0x49 / 255)
  static let accent   = Color(red: 0x58 / 255, green: 0xa6 / 255, blue: 0xff / 255)
}

// MARK: - state

enum Conn: String {
  case off, busy, working, idle, degraded, unreachable

  var color: Color {
    switch self {
    case .off: return Pal.dim
    case .busy: return Pal.warn
    case .working: return Pal.accent
    case .idle: return Pal.ok
    case .degraded: return Pal.err
    case .unreachable: return Pal.err
    }
  }
  var word: String {
    switch self {
    case .off: return "stopped"
    case .busy: return "busy"
    case .working: return "running idle tasks"
    case .idle: return "idle"
    case .degraded: return "degraded"
    case .unreachable: return "unreachable"
    }
  }
}

// MARK: - click routing (pure — testable headlessly)

/** What a status-item click should do. */
enum MenuBarClickAction: Equatable {
  /// Toggle the popover (today's behavior for a single click).
  case togglePanel
  /// Open the desktop app on its State view — `idlefill://open`, falling
  /// back to `open /Applications/Idlefill.app` when the URL-scheme open is
  /// not handled.
  case openDesktopApp
}

/** The desktop app's install target (per desktop/update.sh) and the
 *  URL scheme it registers. */
enum DesktopApp {
  static let appPath = "/Applications/Idlefill.app"
  static let scheme = "idlefill"
}

/** Pure routing decision: click count + desktop-app-installed → action.
 *  A double click ALWAYS attempts the desktop app (whether or not it is
 *  installed — the fallback is `open` of the app path itself); only the two
 *  panel rows (Show Logs / Open Dashboard) fall back to their legacy
 *  behavior when the desktop app is NOT installed. */
enum MenuBarRouter {
  static func action(clickCount: Int, desktopInstalled: Bool) -> MenuBarClickAction {
    switch clickCount {
    case 2: return .openDesktopApp
    default: return .togglePanel
    }
  }
}

final class AppModel: ObservableObject {
  @Published var conn: Conn = .off
  @Published var daemonRunning = false
  @Published var queueDepth = 0
  @Published var today: (finished: Int, failed: Int) = (0, 0)
  @Published var tokensToday: (project: String, cap: Double?, value: Double?) = ("", nil, nil)
  @Published var lease: (job: String, expiresAt: Double) = ("", 0)
  @Published var lastSeenS: Int? = nil
  /// The revision of THIS checkout's tree, as the operator should read it:
  /// `git rev-parse --short HEAD`. Refreshed at launch (init) and on every
  /// completed Update Code (where the deployed revision is exactly the
  /// merged origin/main HEAD — no extra git call needed). Not polled on
  /// the 10s cadence: the revision only changes when Update Code runs, so
  /// polling would just burn a git call per tick for a value that cannot
  /// change between updates. The panel shows it in a dedicated `revision`
  /// row (always visible once known) — it is the standing answer to
  /// "what is deployed?".
  @Published var deployedRevision: String? = nil
  @Published var updateNote: String? = nil

  /** The repo the update machinery acts on. `repoRootOverride` (headless
   *  test hook) wins when set — the harness points it at a scratch repo so
   *  the app's OWN updateCode drives the real plan + wrappers against
   *  scratch git state; the app leaves it nil and uses its discovered
   *  root. (A test hook on a plain property, not the environment: the
   *  driver mutates it per-case after process start.) */
  var repoRoot: String { repoRootOverride ?? _repoRoot }
  var repoRootOverride: String? = nil
  private let _repoRoot = AppModel.findRepoRoot()

  // The baked version (substituted at build time by menubar/build.sh — the
  // `__MENUBAR_VERSION__` placeholder carries the release tag's version, so
  // the binary prints the release it was built from). A dev build where the
  // placeholder was never substituted reports itself as a dev build.
  let version = AppModel.bakedVersion()
  /// Update available (newest published release — a release number `v1` or a
  /// legacy `v0.0.1` — strictly greater than the baked version) —
  /// exception-only, the panel's row renders when non-nil.
  @Published var updateAvailable: String? = nil

  init() {
    // Self-driving 10s poll (main runloop — App init runs on the main thread).
    Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
      self?.poll()
    }
    poll()
    // The deployed revision (git rev-parse --short HEAD) — best-effort at
    // launch; a failure (no git, not a repo) leaves it nil and the
    // revision row stays hidden until a successful read.
    if let rev = UpdateLog.currentRevision(repo: repoRoot) { deployedRevision = rev }
    // The release check (update story): once at launch, then every 6h.
    // Offline-tolerant — any failure sets nothing and fails quiet.
    checkForUpdates()
    Timer.scheduledTimer(withTimeInterval: UpdateCheck.cadenceSeconds, repeats: true) { [weak self] _ in
      self?.checkForUpdates()
    }
  }

  static func findRepoRoot() -> String {
    // Returns the REPO ROOT — the dir that CONTAINS `client/` (every caller
    // does repoRoot + "client/…"). IDLEFILL_CONFIG_FILE is a path to
    // client/config.json, so strip two components to get the repo.
    if let p = ProcessInfo.processInfo.environment["IDLEFILL_CONFIG_FILE"] {
      return (((p as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent)
    }
    // The binary ships at <repo>/menubar/IdlefillMenubar. bundleURL points at
    // the executable's own directory (…/menubar), so the repo root is one
    // level up. Works no matter where the app is launched from (double-
    // clicked, launchd, any cwd); the home walk below is a fallback.
    let fm = FileManager.default
    let repo = (Bundle.main.bundleURL.path as NSString).deletingLastPathComponent
    if fm.fileExists(atPath: (repo as NSString).appendingPathComponent("client/config.json")) {
      return repo
    }
    // Fallback: walk up from $HOME looking for a repo that carries
    // client/config.json (the gitignored client config). Bounded: no
    // infinite loops. Note this can only find repos AT or ABOVE $HOME —
    // a repo nested under it (e.g. ~/Software/idlefill) needs the binary
    // location above or IDLEFILL_CONFIG_FILE.
    var dir = NSHomeDirectory()
    for _ in 0..<14 {
      if fm.fileExists(atPath: (dir as NSString).appendingPathComponent("client/config.json")) {
        return dir
      }
      let parent = (dir as NSString).deletingLastPathComponent
      if parent == dir { break }
      dir = parent
    }
    return NSHomeDirectory()
  }

  /** The version baked into the binary at build time. `build.sh` substitutes
   *  the `__MENUBAR_VERSION__` placeholder with the version passed in as
   *  `IDLEFILL_VERSION` (default: the root package.json version), so a
   *  release binary prints the release it was built from; a build that never
   *  went through the substitution (e.g. an ad-hoc `swiftc` on the source)
   *  still resolves to the root package.json version, and a truly broken
   *  read falls back to `0.0.0-dev` — never crashes. */
  static func bakedVersion() -> String {
    if __MENUBAR_VERSION__ != __MENUBAR_VERSION_UNSUBSTITUTED__
      && !__MENUBAR_VERSION__.trimmingCharacters(in: .whitespaces).isEmpty {
      return __MENUBAR_VERSION__
    }
    if let p = ProcessInfo.processInfo.environment["IDLEFILL_CONFIG_FILE"] {
      let repo = (((p as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent)
      if let v = readRootVersion(repo: repo) { return v }
    }
    if let v = readRootVersion(repo: findRepoRoot()) { return v }
    return "0.0.0-dev"
  }

  /** Read `version` from `<repo>/package.json`. */
  private static func readRootVersion(repo: String) -> String? {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: (repo as NSString).appendingPathComponent("package.json"))),
          let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let v = o["version"] as? String, !v.isEmpty else { return nil }
    return v
  }

  /** The update-check base URL: `IDLEFILL_UPDATE_BASE` (test hook — the
   *  headless tests point it at a local stub), defaulting to the Forgejo
   *  host. The check is anonymous (the repo is public) and never sends the
   *  arbiter token. */
  static func updateBase() -> String {
    let raw = ProcessInfo.processInfo.environment["IDLEFILL_UPDATE_BASE"] ?? "https://git.samwarth.com"
    // Strip trailing slash only (the paths are appended with a leading
    // "/"). Stripping ALL slashes is fatal: it turns the default
    // "https://git.samwarth.com" into "https:git.samwarth.com" — a URL with
    // no host — so the check would never reach the server and the app would
    // silently report "no update" forever (the update check is the
    // offline-tolerant kind: it fails quiet, so this was invisible).
    var base = raw
    while base.hasSuffix("/") { base.removeLast() }
    return base
  }

  /** The menubar bundle's install location: the bundle under the repo root
   *  (the LaunchAgent plist points there — the install action swaps it in
   *  place). */
  static func menubarBundleURL() -> URL {
    URL(fileURLWithPath: (findRepoRoot() as NSString).appendingPathComponent("menubar/IdlefillMenubar.app"))
  }

  func token() -> String? {
    let path = (repoRoot as NSString).appendingPathComponent("client/config.json")
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let t = o["token"] as? String, !t.isEmpty else { return nil }
    return t
  }

  func serverURL() -> String {
    let path = (repoRoot as NSString).appendingPathComponent("client/config.json")
    if let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
       let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let u = o["server_url"] as? String, !u.isEmpty { return u }
    return "http://100.105.225.1:8787"
  }

  // MARK: poll

  func poll() {
    guard let tok = token() else {
      conn = .unreachable
      return
    }
    var req = URLRequest(url: URL(string: serverURL() + "/api/state")!)
    req.timeoutInterval = 5
    req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
    URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
      guard let self else { return }
      DispatchQueue.main.async { self.apply(data) }
    }.resume()
  }

  private func apply(_ data: Data?) {
    guard let data, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      conn = .unreachable
      return
    }

    // me — this machine's client row (prefer the online one; fall back to
    // the first row).
    let clients = (o["clients"] as? [[String: Any]]) ?? []
    let me = clients.first(where: { ($0["online"] as? Bool) == true }) ?? clients.first
    guard let c = me else {
      conn = .unreachable
      return
    }
    // Client rows carry NO `online` flag (that lives on the arbiter's
    // projects[].workers rows) — liveness = last_seen within 90s, the same
    // window the arbiter uses for workers.
    let lastSeen = (c["last_seen"] as? Double) ?? 0
    if lastSeen > 0 {
      lastSeenS = Int(Date().timeIntervalSince1970 * 1000 - lastSeen) / 1000
    }
    daemonRunning = lastSeen > 0 && (Date().timeIntervalSince1970 * 1000 - lastSeen) < 90_000

    // my project rows
    let projs = (c["projects"] as? [[String: Any]]) ?? []
    queueDepth = projs.compactMap { $0["queue_depth"] as? Int }.reduce(0, +)
    let finished = projs.compactMap { (($0["stats"] as? [String: Any])?["finished"] as? NSNumber)?.intValue }.reduce(0, +)
    let failed = projs.compactMap { (($0["stats"] as? [String: Any])?["failed"] as? NSNumber)?.intValue }.reduce(0, +)
    today = (finished, failed)

    // running lease held by me
    let leases = (o["active_leases"] as? [[String: Any]]) ?? []
    let myLease = leases.first(where: { ($0["client_id"] as? String) == (c["client_id"] as? String) })
    if let l = myLease {
      lease = ((l["job_id"] as? String) ?? "?", (l["expires_at"] as? Double) ?? 0)
    } else {
      lease = ("", 0)
    }

    // tokens today for my project (best-effort: the arbiter surfaces the cap
    // on the project row; the row is hidden until a running value is found).
    if let p0 = projs.first {
      let name = (p0["name"] as? String) ?? ""
      var cap: Double? = nil
      var val: Double? = nil
      if let projects = o["projects"] as? [[String: Any]] {
        if let mine = projects.first(where: { ($0["name"] as? String) == name }) {
          cap = ((mine["scheduling"] as? [String: Any])?["daily_token_cap"] as? NSNumber)?.doubleValue
          val = (mine["tokens_today"] as? NSNumber)?.doubleValue
        }
      }
      tokensToday = (name, cap, val)
    }

    // the state word
    guard daemonRunning else { conn = .off; return }
    let idle = (o["idle"] as? [String: Any]) ?? [:]
    switch ((idle["degraded"] as? Bool) == true, myLease != nil, (idle["idle"] as? Bool) == true) {
    case (true, _, _): conn = .degraded
    case (false, true, _): conn = .working
    case (false, false, true): conn = .idle
    default: conn = .busy
    }
  }

  // MARK: daemon control

  /** Absolute path to the client package dir (`<repo>/client`). `repoRoot`
   *  is the REPO root — the dir that CONTAINS `client/` — so append it here;
   *  the old code used it AS the client dir, which pointed one level too
   *  high (the app's Start could never find tsx or the entry).
   */
  var clientPkgDir: String {
    (repoRoot as NSString).appendingPathComponent("client")
  }

  private func daemonCommand() -> (cmd: String, arg: String) {
    let tsxBin = (repoRoot as NSString).appendingPathComponent("node_modules/.bin/tsx")
    let entry = (clientPkgDir as NSString).appendingPathComponent("src/index.ts")
    return (tsxBin, entry)
  }

  /** PIDs of the client daemon. A daemon is a `node` process whose command
   *  line carries the repo path AND the client entry (src/ or dist/
   *  index.ts) — the tsx shim shebangs into node, so argv[0] is node with
   *  the entry path later in the argv. A bare `pgrep -f src/index.ts`
   *  matches ANY process with that string in its argv — including a shell
   *  running a command that quotes the path — and stop() would SIGINT the
   *  wrong process.
   */
  static func daemonPIDs(repo: String) -> [Int] {
    // Write ps's output to a temp FILE, not a pipe. `ps -ax` on this box
    // emits ~190 KB — far more than the 64 KB pipe buffer — and reading the
    // pipe only AFTER waitUntilExit() deadlocks: ps blocks on a full pipe,
    // waitUntilExit blocks on ps, and the app's main thread freezes.
    let tmp = (NSTemporaryDirectory() as NSString)
      .appendingPathComponent("idlefill-menubar-ps-\(getpid())")
    FileManager.default.createFile(atPath: tmp, contents: nil)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/ps")
    p.arguments = ["-ax", "-o", "pid=,command="]
    guard let outHandle = FileHandle(forWritingAtPath: tmp) else {
      return []
    }
    p.standardOutput = outHandle
    p.standardError = FileHandle.nullDevice
    do {
      try p.run()
    } catch {
      try? outHandle.close()
      try? FileManager.default.removeItem(atPath: tmp)
      return []
    }
    p.waitUntilExit()
    try? outHandle.close()
    let data = (try? Data(contentsOf: URL(fileURLWithPath: tmp))) ?? Data()
    try? FileManager.default.removeItem(atPath: tmp)
    let text = String(data: data, encoding: .utf8) ?? ""
    var pids: [Int] = []
    for line in text.split(separator: "\n") {
      let parts = line.split(separator: " ", omittingEmptySubsequences: true)
      guard let pid = Int(parts.first ?? ""),
            let exe = parts.dropFirst().first else { continue }
      guard (exe as NSString).lastPathComponent == "node" else { continue }
      guard line.contains(repo) else { continue }
      guard line.contains("src/index.ts") || line.contains("dist/index.ts") else { continue }
      pids.append(pid)
    }
    return pids
  }

  /** PID of the running client daemon, or nil. */
  private func daemonPID() -> Int? { AppModel.daemonPIDs(repo: repoRoot).first }

  func start() {
    if daemonPID() != nil {
      updateNote = "daemon already running"
      return
    }
    let (cmd, arg) = daemonCommand()
    guard FileManager.default.isExecutableFile(atPath: cmd) else {
      updateNote = "start failed: \(cmd) not found — run npm install in the repo, or set IDLEFILL_CONFIG_FILE to client/config.json"
      return
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: cmd)
    p.arguments = [arg]
    p.currentDirectoryURL = URL(fileURLWithPath: clientPkgDir)
    // A GUI-launched app carries a minimal PATH (/usr/bin:/bin) — node lives
    // in Homebrew, and the tsx shim resolves it via `#!/usr/bin/env node`.
    // Give the daemon a real PATH; inherit the rest of our environment.
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", env["PATH"] ?? ""].joined(separator: ":")
    p.environment = env
    do {
      try p.run()
      updateNote = nil
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.poll() }
    } catch {
      updateNote = "start failed: \(error.localizedDescription)"
    }
  }

  func stop() {
    let pids = AppModel.daemonPIDs(repo: repoRoot)
    guard !pids.isEmpty else {
      updateNote = "no daemon process found"
      return
    }
    // SIGINT = the daemon's clean shutdown: mid-lease teardown reports
    // partial usage, the job stays queued (crash-safe). Kill the WHOLE set:
    // a tsx launch is a parent CLI + child node pair — SIGINTing only the
    // first would orphan the one actually running the loop.
    for pid in pids { kill(Int32(pid), SIGINT) }
    updateNote = nil
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.poll() }
  }

  func restart() {
    stop()
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.start() }
  }

  // MARK: update code (issue #11)
  //
  // The OLD updateCode ran `git pull --ff-only` + `npm ci` against the live
  // tree the daemon runs from: `ci` tore down the daemon's own node_modules
  // (restoring exactly the lock file's contents — destroying any uncommitted
  // work in the process) and nothing ever rebuilt the menu bar. The new
  // shape (decision in the pure UpdatePlan, side effects in thin wrappers):
  //
  //   1. pre-flight gates, in order — a refusal stops the operation, and
  //      NOTHING is written (no fetch result consumed, no merge, no
  //      install, no signal to the daemon):
  //        a. tree not clean (git status --porcelain non-empty, the call
  //           timeout-bounded) → refuse
  //        b. git fetch origin main fails → refuse, nothing written
  //        c. HEAD not an ancestor of origin/main (diverged) → refuse
  //        d. no delta (HEAD == origin/main) → no-op note, done
  //      A `git pull` is NEVER run — the only write is `git merge
  //      --ff-only origin/main`, after all three gates pass.
  //   2. stop the daemon FIRST (the existing stop() path — SIGINT the
  //      whole matching PID set): the daemon never runs against a
  //      mid-merge tree or a torn-down node_modules.
  //   3. the gate-verified merge (ff-only onto the fetched origin/main).
  //   4. `npm ci` ONLY on a lock delta (git diff --quiet old..new
  //      -- package-lock.json) — never unconditional, never while the
  //      daemon runs.
  //   5. start() — the same control path Restart uses — ONLY when a
  //      daemon was running (decision 3: if the stop found no daemon
  //      PID, the update applies, no restart is needed, and the final
  //      note says so).
  //   6. rebuild the menu bar bundle (menubar/build.sh — the honest
  //      shape: the running menu bar cannot re-exec its own binary in
  //      place). When the launchd label is loaded AND the label runs the
  //      bundle we just rebuilt (ProgramArguments.0 == the bundle's own
  //      executable path), `launchctl kickstart -k` relaunches the agent
  //      on the new binary and this process exits with the note
  //      "restarting menu bar with new code"; otherwise (dev run, or a
  //      stale label pointing elsewhere — e.g. a bare-binary plist from
  //      before the bundle era) the note says "menu bar rebuilt —
  //      relaunch it to run the new code" and NO process is killed.
  //   7. record: one line per completed update appended to
  //      logs/idlefill-menubar.log (rotated — never deleted, never
  //      truncated to empty), and deployedRevision = the merged HEAD.
  func updateCode() {
    let repo = repoRoot
    updateNote = "updating: checking tree …"
    let logDir = (repo as NSString).appendingPathComponent("logs")
    try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    let logFile = (logDir as NSString).appendingPathComponent("idlefill-menubar.log")
    let kickLabel = "gui/\(geteuid())/\(UpdatePlan.label)"

    // ---- gate (a): the tree must be clean (bounded — a wedged git must
    // not hang the panel; a timeout is a refusal, not a pass). Tracked
    // changes only (status --porcelain with no flags): the repo
    // intentionally ignores untracked scratch. Refuse BEFORE any fetch or
    // write — a dirty tree gets no fetch, no merge, no install, no signal.
    let treeClean = UpdateFacts.gitStatusClean(repo: repo)
    if !treeClean {
      updateNote = UpdatePlan.note(for: .refuse(.dirty))
      return
    }

    // ---- gate (b): fetch (a detached read of the remote — no
    // working-tree mutation). Any failure refuses; nothing is written.
    updateNote = "updating: fetching …"
    let fetchOk = gatedRun(["/usr/bin/git", "fetch", "origin", "main"], cwd: repo, log: logFile).isOK
    guard fetchOk else {
      updateNote = "fetch failed — update aborted"
      return
    }

    // ---- the remaining gate facts from the real wrappers — the SAME
    //    UpdateFacts.gather the headless harness drives against a scratch
    //    repo (isAncestor, hasDelta, lockChanged, daemonPids,
    //    labelLoaded, thisIsLabelBinary, currentShortSha). gather
    //    re-verifies the tree (a concurrent edit between the pre-fetch
    //    check and now refuses at gate (a) — before any write) and reads
    //    both revisions; it returns nil only when they cannot be read.
    guard var input = UpdateFacts.gather(repo: repo) else {
      updateNote = "could not read the current revision — update aborted"
      return
    }
    // gather hardcodes fetchOk (it does not fetch); the caller's logged
    // fetch above is the gate-(b) fact.
    input.fetchOk = fetchOk

    // ---- the pure decision: the gate outcome + the ordered step list +
    // the note, all from the facts above (no side effects in UpdatePlan).
    // The relaunch safety is inside gather: thisIsLabelBinary is true
    // only when the label runs THIS process's own binary (exact path —
    // a bundle run is its bundle's executable, a bare-binary run is that
    // bare path). On any miss it is false and the rebuild becomes a note,
    // never a kill.
    let plan = UpdatePlan.plan(input)

    // The NEW revision (origin/main, just fetched — the merge's target).
    // Read NOW, pre-merge: deployedRevision and the log line must carry it
    // even when the last step (a kickstart) ends this process, and a
    // ff-only merge lands exactly here.
    let newSha = UpdateFacts.shortSha("origin/main", cwd: repo)

    // A refusal or a no-op never writes (the fetch above was read-only):
    // the status row says which, and stop. (treeClean/fetchOk already
    // passed, so only `.diverged` or `.noOp` reach here.)
    if case .proceed = plan.gate {
      // fall through to the step executor
    } else {
      updateNote = plan.note
      if !plan.input.hasDelta, let s = plan.input.currentShortSha { deployedRevision = s }
      return
    }

    // ---- execute the plan's ordered steps (the pure UpdatePlan decided
    // the list; these wrappers only run and gate on each exit status).
    // A failing step halts the operation — the next step (e.g. the
    // install after a failed merge) never runs.
    var startRan = false
    func run(_ s: UpdatePlan.Step) -> Bool {
      var ok = false
      switch s {
      case .stopDaemon:
        // SIGINT the whole matching PID set (the existing stop() path).
        // Fire-and-forget: give the pair a beat to exit before the tree
        // changes under it. No PIDs → stop() notes "no daemon process
        // found" and the update proceeds (no restart needed — the note
        // says so at the end).
        stop()
        Thread.sleep(forTimeInterval: 1.5)
        ok = true
      case .merge:
        updateNote = "updating: merging …"
        ok = gatedRun(["/usr/bin/git", "merge", "--ff-only", "origin/main"], cwd: repo, log: logFile).isOK
        if !ok { updateNote = "merge failed — see logs/idlefill-menubar.log" }
      case .install:
        updateNote = "updating: lock file changed — npm ci …"
        ok = gatedRun([npmPath(), "ci", "--no-audit", "--no-fund"], cwd: repo, log: logFile).isOK
        if !ok { updateNote = "npm ci failed — see logs/idlefill-menubar.log" }
      case .startDaemon:
        updateNote = "updating: starting daemon …"
        startRan = true
        start() // sets a refusal note when it cannot start (nil on success)
        ok = (updateNote == nil || updateNote == "daemon already running")
      case .buildMenubar:
        updateNote = "updating: rebuilding menu bar …"
        let buildSh = (repo as NSString).appendingPathComponent("menubar/build.sh")
        ok = gatedRun(["/bin/bash", buildSh], cwd: repo, log: logFile).isOK
        if !ok { updateNote = "menu bar build failed — see logs/idlefill-menubar.log" }
      case .kickMenubar:
        // Set BEFORE the kick (the issue's requirement): launchd re-runs
        // the (rebuilt) bundle on the same path — this process exits and
        // the new binary takes over.
        updateNote = "restarting menu bar with new code"
        ok = gatedRun(["/bin/launchctl", "kickstart", "-k", kickLabel], cwd: repo, log: logFile).isOK
        if !ok { updateNote = "menu bar rebuilt — relaunch it to run the new code (kickstart failed)" }
      }
      return ok
    }
    var halted = false
    for s in plan.steps {
      if halted { break }
      if !run(s) { halted = true }
    }

    // ---- record (a line per COMPLETED update — a halted update appends
    // nothing to the revision log; the per-step output it did produce is
    // already in the log, so the effect is auditable) + the status row's
    // deployed revision.
    if halted {
      var n = updateNote ?? "update aborted"
      if !plan.input.daemonPids.isEmpty && !startRan {
        n += " — the daemon was stopped by this update; Start it to restore it"
      }
      updateNote = n
      return
    }
    // The NEW revision (read pre-merge above — the ff-only merge lands
    // exactly at origin/main, so it is the deployed revision once the
    // steps complete).
    guard let newShort = newSha else {
      updateNote = "merge applied but the new revision could not be read — see logs/idlefill-menubar.log"
      return
    }
    let line = UpdatePlan.logLine(oldShort: input.currentShortSha ?? "?", newShort: newShort,
                                  daemonPid: plan.input.daemonPids.first,
                                  lockChanged: input.lockChanged)
    UpdateLog.append(line, at: logFile)
    deployedRevision = newShort
    let lastStep: UpdatePlan.Step? = plan.steps.last
    let didKick = lastStep == .kickMenubar
    if !didKick {
      var finalNote = UpdatePlan.note(for: plan.gate)
      if plan.input.daemonPids.isEmpty {
        finalNote += " (daemon was not running — no restart)"
      }
      updateNote = finalNote + " — " + line
    }
    // didKick: the "restarting menu bar with new code" note set before the
    // kick is the final word — the process is about to relaunch.
  }

  /** Run a command, capture whether it succeeded, and append its output to
   *  the log. The termination status is returned so the caller gates the
   *  next step on it (a failing fetch must not be followed by a merge; a
   *  failing merge must not be followed by an install) — the class fix the
   *  issue's item 4 asks for. The log is appended with O_APPEND (see
   *  `appendLog`), never truncated. */
  private func gatedRun(_ cmd: [String], cwd: String, log: String) -> RunResult {
    let captured = Pipe()
    let p = Process()
    p.executableURL = URL(fileURLWithPath: cmd[0])
    p.arguments = Array(cmd.dropFirst())
    p.currentDirectoryURL = URL(fileURLWithPath: cwd)
    // A GUI-launched app carries a minimal PATH; give the children the
    // Homebrew prefix (npm, node, git live there on this box).
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", env["PATH"] ?? ""].joined(separator: ":")
    p.environment = env
    p.standardOutput = captured
    p.standardError = captured
    do {
      try p.run()
    } catch {
      return .failed(255) // spawn failed — treat as a gate failure
    }
    p.waitUntilExit()
    // Drain the pipe (bounded: these are small git/launchctl outputs —
    // the 190 KB ps case is handled by the temp-file path in daemonPIDs).
    let data = (try? captured.fileHandleForReading.readToEnd()) ?? Data()
    if log != "/dev/null" {
      appendLog(cmd: cmd, data: data, exit: Int(p.terminationStatus), at: log)
    }
    return p.terminationStatus == 0 ? .ok : .failed(Int(p.terminationStatus))
  }

  /** Append one command's output to the update log. `FileHandle
   *  (forWritingAtPath:)` TRUNCATES (verified in a probe: a second open
   *  left only the newest line), so appending through it — even with
   *  seekToEndOfFile — destroys the log on the first write. This opens
   *  with O_APPEND instead: the kernel places every write at the true
   *  end, the file is created when missing, and the log is never deleted
   *  nor truncated (rotation is UpdateLog's job, and it keeps a tail). */
  private func appendLog(cmd: [String], data: Data, exit: Int, at path: String) {
    let fm = FileManager.default
    let dir = (path as NSString).deletingLastPathComponent
    try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
    // The 3-ARG open with an explicit mode: a 2-arg open(O_CREAT) creates
    // the file with mode 0000 (the implicit mode is 0), so even the owner
    // could never read the log back (EACCES) — and the next reopen-for-
    //write-or-read would fail too. 0o644 on create; existing files keep
    // their mode. O_APPEND: the kernel places every write at the true end.
    let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
    guard fd >= 0 else { return }
    defer { close(fd) }
    let header = "\n$ \(cmd.joined(separator: " "))\n"
    let footer = "\n[exit \(exit)]\n"
    if let h = header.data(using: .utf8) { _ = h.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) } }
    _ = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    if let f = footer.data(using: .utf8) { _ = f.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) } }
  }

  private enum RunResult {
    case ok
    case failed(Int)
    var isOK: Bool {
      if case .ok = self { return true }
      return false
    }
  }

  private func npmPath() -> String {
    for cand in ["/opt/homebrew/bin/npm", "/usr/local/bin/npm", "/usr/bin/npm"] {
      if FileManager.default.isExecutableFile(atPath: cand) { return cand }
    }
    return "/usr/bin/env"
  }

  // MARK: release update (check + install)

  /** The update check: on launch and every 6h (UpdateCheck.cadenceSeconds),
   *  GET the Forgejo releases list ANONYMOUSLY (the repo is public — the
   *  arbiter token is never sent to Forgejo), compare the newest release
   *  number (or legacy semver tag) against the baked version.
   *  OFFLINE-TOLERANT: any fetch/parse failure sets nothing and fails quiet
   *  — no dialog, no error row; the next cadence tick retries. */
  func checkForUpdates() {
    let base = AppModel.updateBase()
    URLSession.shared.dataTask(with: URL(string: "\(base)/api/v1/repos/sam/idlefill/releases?limit=10")!) { [weak self] data, _, _ in
      guard let self else { return }
      DispatchQueue.main.async { self.applyUpdateCheck(data, localVersion: self.version) }
    }.resume()
  }

  /** Pure: given the releases-list payload + the baked local version, set
   *  the exception-only `updateAvailable` (the tag's version) or clear it.
   *  Split out so the headless test can drive it with canned payloads. */
  func applyUpdateCheck(_ data: Data?, localVersion: String) {
    updateAvailable = UpdateCheck.latestUpdateTag(data: data, localVersion: localVersion)
  }

  /** Install action (phase 1 — sha256, not Developer ID): download the
   *  menubar zip + its sha256 sidecar for the available release, verify the
   *  hash BEFORE any swap (a mismatch or missing sidecar refuses and keeps
   *  the current binary), then swap the bundle in place under the repo
   *  root and kickstart the LaunchAgent when it is loaded. */
  func installUpdate() {
    guard let version = updateAvailable else { return }
    // `updateAvailable` is the BARE version string (what latestUpdateTag
    // returns). The download URL needs the TAG (the version with the "v");
    // the published zip is named after the bare version — downloadRef keeps
    // the two straight (a bare version in the tag slot would 404: Gitea's
    // per-tag route is keyed on the tag, not the version).
    let ref = UpdateCheck.downloadRef(version: version)
    updateNote = "installing \(version) …"
    UpdateCheck.install(
      base: AppModel.updateBase(),
      tag: ref.tag,
      zipName: ref.zip,
      bundleURL: AppModel.menubarBundleURL(),
      label: "com.sam.idlefill.menubar"
    ) { [weak self] outcome in
      guard let self else { return }
      DispatchQueue.main.async {
        switch outcome {
        case .installed:
          self.updateNote = "installed \(version) — relaunched"
          self.updateAvailable = nil
        case .notLoaded:
          self.updateNote = "installed \(version) — agent not loaded: run menubar/install.sh"
          self.updateAvailable = nil
        case .refused:
          // The current binary is untouched; the note explains the refusal.
          break
        }
      }
    }
  }
}

// MARK: - release update check (pure + async — testable headlessly)

/** The update check over the network (issue #10): on launch + every 6h the
 *  menu bar GETs the Forgejo releases list ANONYMOUSLY (the repo is public;
 *  the arbiter token is never sent to Forgejo) and compares the newest
 *  `v<major>.<minor>.<patch>` tag against the baked version.
 *
 *  OFFLINE-TOLERANT: any fetch/parse failure sets nothing — no dialog, no
 *  error row; the next cadence tick retries.
 *
 *  Phase 1 verification is a published sha256 sidecar (Developer ID signing
 *  + notarization is tracked separately): the install downloads the zip AND
 *  the `.sha256` sidecar, verifies the hash BEFORE any swap, and a mismatch
 *  or missing sidecar refuses (the current binary is kept). */
enum UpdateCheck {
  /// The check cadence: launch, then every 6 hours.
  static let cadenceSeconds: TimeInterval = 6 * 60 * 60

  /// sha256 in lowercase hex. (Phase 1 — the published sidecar format.)
  static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).compactMap { String(format: "%02x", $0) }.joined()
  }

  /// Parse `<64 hex>\n` from a sidecar; nil when malformed (the wrong
  /// length or non-hex chars mean the sidecar is not a sha256 — refuse).
  static func parseSidecar(_ text: String) -> String? {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.count == 64, t.allSatisfy(\.isHexDigit) else { return nil }
    return t.lowercased()
  }

  /// Parse a release tag into its numeric version segments. Accepts the
  /// release number (`v1`, `v2`, …) AND the legacy semver (`v0.0.1`,
  /// `v1.2.3`) — 1–3 numeric segments after the leading "v". Anything else
  /// (a pre-release, an odd tag, a non-numeric segment, 0 or >3 segments)
  /// → nil — such tags are SKIPPED by the check. Returns the segments plus
  /// the BARE version string (the tag without the leading "v").
  private static func parseTag(_ tag: String) -> ([Int], String)? {
    guard tag.hasPrefix("v") else { return nil }
    let body = tag.dropFirst()
    let segs = Array(body.split(separator: "."))
    guard (1...3).contains(segs.count) else { return nil }
    var nums: [Int] = []
    for seg in segs {
      guard !seg.isEmpty, seg.allSatisfy(\.isNumber),
            let n = Int(seg), n < 100_000 else { return nil }
      nums.append(n)
    }
    return (nums, String(body))
  }

  /// The newest release strictly newer than the local version, as its BARE
  /// version string (e.g. "1" for tag v1, "0.0.2" for v0.0.2); nil when
  /// nothing is strictly newer. Malformed tags are skipped; any failure
  /// (unparseable payload, malformed local version, no valid tags) → nil:
  /// fail quiet, nothing set, next tick retries.
  static func latestUpdateTag(data: Data?, localVersion: String) -> String? {
    guard let data,
          let o = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
      return nil
    }
    guard let local = versionSegments(localVersion) else { return nil }
    var best: ([Int], String)?
    for rel in o {
      guard let tag = rel["tag_name"] as? String,
            let parsed = parseTag(tag) else { continue }
      if best == nil || versionOrder(parsed.0, best!.0) > 0 { best = (parsed.0, parsed.1) }
    }
    guard let b = best else { return nil }
    return versionOrder(b.0, local) > 0 ? b.1 : nil
  }

  /// Parse a BARE version string (no leading "v") into numeric segments —
  /// the same 1–3 numeric segments a release tag carries. A malformed local
  /// version (non-numeric segment, wrong segment count, out of range) → nil
  /// (a malformed local version fails quiet).
  private static func versionSegments(_ s: String) -> [Int]? {
    let segs = Array(s.split(separator: "."))
    guard (1...3).contains(segs.count) else { return nil }
    var nums: [Int] = []
    for seg in segs {
      guard !seg.isEmpty, seg.allSatisfy(\.isNumber),
            let n = Int(seg), n < 100_000 else { return nil }
      nums.append(n)
    }
    return nums
  }

  /// Numeric version order: compare segment-by-segment, zero-padding the
  /// shorter, so a release number sorts ABOVE the legacy semver
  /// (1 > 0.1.0 > 0.0.2 > 0.0.1) and a higher number above a lower one
  /// (3 > 2 > 1). Returns negative if a < b, 0 if equal, positive if a > b.
  private static func versionOrder(_ a: [Int], _ b: [Int]) -> Int {
    let n = max(a.count, b.count)
    for i in 0..<n {
      let x = i < a.count ? a[i] : 0
      let y = i < b.count ? b[i] : 0
      if x != y { return x < y ? -1 : 1 }
    }
    return 0
  }

  /// The Gitea per-tag download route is keyed on the TAG (the version with
  /// the leading "v"), but the published zip is named after the BARE version
  /// (`IdlefillMenubar-1.app.zip`). Given the bare version string (what
  /// `updateAvailable` holds, e.g. "1" or "0.0.2") → the (tag, zipName) the
  /// install must fetch. The tag always re-adds the "v"; the zip name never
  /// has one — so `updateAvailable` must feed this BARE (no "v").
  static func downloadRef(version: String) -> (tag: String, zip: String) {
    let bare = version.hasPrefix("v") ? String(version.dropFirst()) : version
    return ("v" + bare, "IdlefillMenubar-\(bare).app.zip")
  }

  /// GET `base/api/v1/repos/sam/idlefill/releases?limit=10` (anonymous).
  /// The completion ALWAYS runs, on any thread — including failure (that is
  /// the offline-tolerant contract: the caller must set nothing).
  static func fetchReleases(base: String, completion: @escaping (Data?) -> Void) {
    let url = URL(string: "\(base)/api/v1/repos/sam/idlefill/releases?limit=10")
    guard let u = url else { completion(nil); return }
    var req = URLRequest(url: u)
    req.timeoutInterval = 10
    URLSession.shared.dataTask(with: req) { data, _, _ in
      completion(data)
    }.resume()
  }

  // -- install (phase 1: sha256-verified swap) -----------------------------

  enum Outcome { case installed, notLoaded, refused(String) }

  /** Download `<base>/releases/download/<tag>/<zipName>` + the sidecar
   *  (`<zipName>.sha256`) to a temp dir, verify the hash, then swap the
   *  bundle in place (a temp dir next to the target, then a rename — no
   *  partial-bundle window) and `launchctl kickstart -k gui/<uid>/<label>`
   *  when the agent is loaded. A hash mismatch, a missing/malformed
   *  sidecar, or a failed swap REFUSES: the current bundle is untouched
   *  and the refusal reason is returned. */
  static func install(base: String, tag: String, zipName: String,
                      bundleURL: URL, label: String,
                      completion: @escaping (Outcome) -> Void) {
    let tagEnc = tag.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? tag
    let tmpDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("idlefill-menubar-install-\(getpid())").path
    let fm = FileManager.default
    try? fm.createDirectory(atPath: tmpDir, withIntermediateDirectories: true)
    let zipDest = tmpDir + "/" + zipName
    let sidecarDest = zipDest + ".sha256"
    let dl = { (name: String, dest: String, done: @escaping (Bool, String?) -> Void) in
      let encodedName = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
      guard let url = URL(string: "\(base)/releases/download/\(tagEnc)/\(encodedName)") else {
        done(false, "bad url for \(name)")
        return
      }
      URLSession.shared.downloadTask(with: url) { tmp, _, e in
        guard let tmp = tmp else { done(false, e?.localizedDescription ?? "no data"); return }
        do {
          if fm.fileExists(atPath: dest) { try fm.removeItem(atPath: dest) }
          try fm.moveItem(at: tmp, to: URL(fileURLWithPath: dest))
          done(true, nil)
        } catch { done(false, error.localizedDescription) }
      }.resume()
    }
    dl(zipName, zipDest) { ok, err in
      guard ok else { completion(.refused("download failed: \(err ?? "?")")); return }
      dl(zipName + ".sha256", sidecarDest) { ok, err in
        guard ok else { completion(.refused("sidecar download failed: \(err ?? "?") — the update was NOT installed")); return }
        guard let zipData = try? Data(contentsOf: URL(fileURLWithPath: zipDest)),
              let sideData = try? Data(contentsOf: URL(fileURLWithPath: sidecarDest)),
              let expected = parseSidecar(String(data: sideData, encoding: .utf8) ?? "") else {
          completion(.refused("sha256 sidecar missing or malformed — the update was NOT installed"))
          return
        }
        if sha256Hex(zipData) != expected {
          completion(.refused("sha256 mismatch — the downloaded artifact does not match the published hash; the current build was kept"))
          return
        }
        // Hash verified — the swap is safe.
        do {
          let destDir = bundleURL.deletingLastPathComponent()
          let newURL = destDir.appendingPathComponent("IdlefillMenubar.app.new")
          if fm.fileExists(atPath: newURL.path) { try fm.removeItem(atPath: newURL.path) }
          try fm.createDirectory(atPath: destDir.path, withIntermediateDirectories: true)
          let unz = Process()
          unz.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
          unz.arguments = ["-q", "-d", newURL.path, zipName]
          unz.currentDirectoryURL = URL(fileURLWithPath: tmpDir)
          unz.standardError = FileHandle.nullDevice
          try unz.run()
          unz.waitUntilExit()
          guard unz.terminationStatus == 0 else {
            throw NSError(domain: "idlefill-menubar", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "unzip exited \(unz.terminationStatus)"])
          }
          // The zip's root is the .app dir (the release convention) —
          // unwrap it so <bundle> is ready to rename.
          let inner = newURL.appendingPathComponent(bundleURL.lastPathComponent)
          let final = inner
          if fm.fileExists(atPath: bundleURL.path) { try fm.removeItem(atPath: bundleURL.path) }
          try fm.moveItem(at: final, to: bundleURL)
          try? fm.removeItem(atPath: newURL.path)
          try? fm.removeItem(atPath: zipDest)
        } catch {
          completion(.refused("swap failed: \(error.localizedDescription) — the current build was kept"))
          return
        }
        // Relaunch the agent when it is loaded; otherwise note it.
        let uid = geteuid()
        let kick = Process()
        kick.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        kick.arguments = ["kickstart", "-k", "gui/\(uid)/\(label)"]
        kick.standardOutput = FileHandle.nullDevice
        kick.standardError = FileHandle.nullDevice
        do {
          try kick.run()
          kick.waitUntilExit()
          completion(kick.terminationStatus == 0 ? .installed : .notLoaded)
        } catch {
          completion(.notLoaded)
        }
      }
    }
  }
}

// MARK: - update code (issue #11 — the pure, testable core)

/** The pure decision core of Update Code. Given the pre-flight facts (each
 *  gathered by a thin wrapper that runs a real git/launchd/ps command and
 *  gates on its exit status), decide:
 *
 *   - the gate outcome (`.refuse` with a reason, `.noOp`, or `.proceed`),
 *   - the ordered list of SIDE-EFFECT STEPS to run when it proceeds, and
 *   - the final status-row note.
 *
 *  No git, no launchctl, no Process, no file IO lives here — the headless
 *  harness drives THIS type (plus the real git wrappers) against a scratch
 *  repo, so what the tests prove is what ships.
 *
 *  Gate order (a refusal at any gate means NOTHING is written — no merge,
 *  no install, no signal to the daemon):
 *    a. treeClean==false            → refuse `dirty`
 *    b. fetchOk==false              → refuse `fetch`
 *    c. isAncestor==false           → refuse `diverged`
 *    d. hasDelta==false             → noOp (already up to date)
 *  A `git pull` is never run; the only write step is `.merge` (ff-only
 *  onto the fetched origin/main), present only when every gate passed.
 */
enum UpdatePlan {
  /** The pre-flight facts a plan is decided from. */
  struct Input {
    var treeClean: Bool
    var fetchOk: Bool
    var isAncestor: Bool        // HEAD is an ancestor of origin/main
    var hasDelta: Bool          // HEAD != origin/main (after the fetch)
    var lockChanged: Bool       // package-lock.json differs old..new
    var daemonPids: [Int]       // the current daemon PID set (may be empty)
    var labelLoaded: Bool       // launchctl print gui/<uid>/<label> exit 0
    var thisIsLabelBinary: Bool // this process is the binary the label runs
    var currentShortSha: String?
  }

  /** The gate outcome. `.refuse` and `.noOp` carry no steps; `.proceed`
   *  means the step list is to be executed. Equatable so the harness can
   *  assert on the outcome directly. */
  enum Gate: Equatable {
    case refuse(Reason)
    case noOp
    case proceed
    enum Reason: Equatable {
      case dirty        // tree not clean
      case fetch        // git fetch origin main failed
      case diverged     // HEAD is not an ancestor of origin/main
    }
  }

  /** One ordered side-effect step. The executor (updateCode) maps each to
   *  a real command/wrapper and gates the next step on the exit status. */
  enum Step: Equatable {
    case stopDaemon     // SIGINT the whole matching PID set (stop() path)
    case merge          // git merge --ff-only origin/main (the only write)
    case install        // npm ci --no-audit --no-fund (lock delta only)
    case startDaemon    // start() — the same control path as Restart
    case buildMenubar   // bash menubar/build.sh (rebuild the bundle)
    case kickMenubar    // launchctl kickstart -k gui/<uid>/<label> (relaunch)
  }

  /** The plan: gate + steps + note. Built by `init(input:)`. */
  struct Plan {
    var input: Input
    var gate: Gate
    var steps: [Step]
    var note: String
  }

  /// The menubar LaunchAgent label (the same one menubar/install.sh uses).
  /// `IDLEFILL_MENUBAR_LABEL` override (headless test hook — the harness
  /// points it at a scratch label); the app uses the real label.
  static var label: String {
    ProcessInfo.processInfo.environment["IDLEFILL_MENUBAR_LABEL"] ?? "com.sam.idlefill.menubar"
  }

  /** The pure decision. The gate is evaluated in order; a refusal or a
   *  no-op yields an empty step list (nothing runs, nothing is written).
   *  A proceed builds the step list:
   *    1. stopDaemon  (always first — the daemon never runs against a
   *       mid-merge tree or a torn-down node_modules; empty PIDs is fine,
   *       the note says the daemon was not running)
   *    2. merge       (the gate-verified ff-only write)
   *    3. install     (ONLY when lockChanged — never unconditional)
   *    4. startDaemon (ONLY when a daemon was running — decision 3: if
   *       the stop found no PID, the update applies and no restart is
   *       needed; the note says so. Starting a daemon that was
   *       intentionally off would surprise the operator.)
   *    5. buildMenubar (always — the menu bar's own code must update)
   *    6. kickMenubar  (only when labelLoaded AND thisIsLabelBinary —
   *       otherwise the note says "rebuild — relaunch it"; no kill of a
   *       process that is not the label's)
   */
  static func plan(_ input: Input) -> Plan {
    // (a) tree
    if !input.treeClean {
      return Plan(input: input, gate: .refuse(.dirty), steps: [], note: note(for: .refuse(.dirty)))
    }
    // (b) fetch
    if !input.fetchOk {
      return Plan(input: input, gate: .refuse(.fetch), steps: [], note: note(for: .refuse(.fetch)))
    }
    // (c) divergence
    if !input.isAncestor {
      return Plan(input: input, gate: .refuse(.diverged), steps: [], note: note(for: .refuse(.diverged)))
    }
    // (d) no delta
    if !input.hasDelta {
      return Plan(input: input, gate: .noOp, steps: [], note: "already up to date (\(input.currentShortSha ?? "?"))")
    }
    // proceed
    var steps: [Step] = [.stopDaemon, .merge]
    if input.lockChanged { steps.append(.install) }
    if !input.daemonPids.isEmpty { steps.append(.startDaemon) }
    steps.append(.buildMenubar)
    if input.labelLoaded && input.thisIsLabelBinary { steps.append(.kickMenubar) }
    var note = "updated"
    if input.daemonPids.isEmpty { note += " (daemon was not running — no restart)" }
    if !(input.labelLoaded && input.thisIsLabelBinary) {
      note += " — menu bar rebuilt; relaunch it to run the new code"
    }
    return Plan(input: input, gate: .proceed, steps: steps, note: note)
  }

  /** The status-row note for a gate outcome. */
  static func note(for gate: Gate) -> String {
    switch gate {
    case .refuse(.dirty):    return "tree not clean — commit or stash first, update aborted"
    case .refuse(.fetch):    return "fetch failed — update aborted"
    case .refuse(.diverged): return "local branch diverged from origin/main — reconcile first, update aborted"
    case .noOp:              return "already up to date"
    case .proceed:           return "updated"
    }
  }

  // -- pure helpers over the gate facts (no side effects) ------------------

  /** `git diff --quiet old new -- package-lock.json` exit semantics: 0 =
   *  identical (NOT changed), non-zero = changed (or an error, which the
   *  caller treats as "not a lock delta" — no install, fail quiet about
   *  the install and the merge still applies). */
  static func lockDeltaChanged(diffQuietExit: Int32) -> Bool {
    diffQuietExit != 0
  }

  /** The one-line update record: `<old> → <new> <ISO ts> daemon-pid=<pid
   *  or none> lock-changed=<yes|no>`. */
  static func logLine(oldShort: String, newShort: String, daemonPid: Int?, lockChanged: Bool,
                      timestamp: String = UpdateLog.nowISO()) -> String {
    "\(oldShort) → \(newShort) \(timestamp) daemon-pid=\(daemonPid.map { String($0) } ?? "none") lock-changed=\(lockChanged ? "yes" : "no")"
  }
}

/** The thin wrappers that gather the pre-flight facts from the real
 *  system (git / launchctl / ps). Each is pure + param-driven (no hidden
 *  state, no `repoRoot`) so the headless harness drives THESE wrappers —
 *  the same ones the app uses — against a scratch repo. They are the
 *  "where practical, the REAL git wrappers" of the DoD. The read-only
 *  probes here (status / rev-parse / is-ancestor / diff --quiet / launchctl
 *  print / ps) do NOT log; the write steps in `updateCode` (fetch / merge /
 *  install / build / kick) go through the logged `gatedRun` instead, so the
 *  update log records what an update did.
 */
enum UpdateFacts {
  /** `git status --porcelain` is empty AND the call returned within the
   *  timeout (a wedged git refuses the update rather than hanging the
   *  panel — the repo can sit on a network mount where status stalls).
   *  The timeout is enforced by the perl alarm wrapper (`git` itself has
   *  no timeout flag). Tracked changes only: a dirty tracked file refuses;
   *  untracked scratch is intentionally ignored. */
  static func gitStatusClean(repo: String, timeout: UInt32 = 10) -> Bool {
    let tmp = (NSTemporaryDirectory() as NSString)
      .appendingPathComponent("idlefill-status-\(getpid()).txt")
    FileManager.default.createFile(atPath: tmp, contents: nil)
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
    // alarm N then exec: the child is replaced by git and killed by SIGALRM
    // after N seconds. exit 0 + empty output = clean; anything else (a
    // dirty tree, an error, or the timeout's 128+SIGALRM) = refuse.
    p.arguments = ["-e", "my $t = shift @ARGV; alarm $t; exec @ARGV",
                   String(timeout), "/usr/bin/git", "-C", repo, "status", "--porcelain"]
    p.currentDirectoryURL = URL(fileURLWithPath: repo)
    // The output FileHandle MUST stay open until AFTER waitUntilExit —
    // closing it before run() invalidates the fd Process dups at launch
    // (NSFileHandleOperationException). git status --porcelain output is
    // small, so a temp file (not a 64KB pipe) is safe and the handle can
    // be released only once git has exited.
    let h = FileHandle(forWritingAtPath: tmp)
    if let h { p.standardOutput = h; p.standardError = h }
    do { try p.run() } catch { if let h { try? h.close() }; return false }
    p.waitUntilExit()
    if let h { try? h.close() }
    guard p.terminationStatus == 0,
          let data = try? Data(contentsOf: URL(fileURLWithPath: tmp)) else { return false }
    return (String(data: data, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /** `git rev-parse --short <rev>` (thin wrapper): the short-SHA string, or
   *  nil on any failure (bad ref, no git, not a repo). */
  static func shortSha(_ rev: String, cwd: String) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    p.arguments = ["-C", cwd, "rev-parse", "--short", rev]
    p.currentDirectoryURL = URL(fileURLWithPath: cwd)
    let captured = Pipe()
    p.standardOutput = captured
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { return nil }
    let data = (try? captured.fileHandleForReading.readToEnd()) ?? Data()
    let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return s.isEmpty ? nil : s
  }

  /** Is `HEAD` an ancestor of `origin/main` (the divergence gate)? A
   *  non-ancestor (diverged local branch) or an error (no origin/main)
   *  → false, which refuses the update. */
  static func isAncestorOfOriginMain(repo: String) -> Bool {
    probeExit(["/usr/bin/git", "merge-base", "--is-ancestor", "HEAD", "origin/main"], cwd: repo) == 0
  }

  /** Does `package-lock.json` differ between the two revisions (the
   *  install trigger)? `git diff --quiet old new -- package-lock.json`:
   *  exit 0 = identical (no install), non-zero = changed (install). */
  static func lockDelta(old: String, new: String, cwd: String) -> Bool {
    UpdatePlan.lockDeltaChanged(diffQuietExit:
      probeExit(["/usr/bin/git", "diff", "--quiet", old, new, "--", "package-lock.json"], cwd: cwd))
  }

  /** Is the launchd label loaded (`launchctl print gui/<uid>/<label>`
   *  exit 0)? */
  static func labelLoaded(uid: UInt32, label: String) -> Bool {
    probeExit(["/bin/launchctl", "print", "gui/\(uid)/\(label)"], cwd: "/") == 0
  }

  /** The path the launchd label currently runs (ProgramArguments.0 of the
   *  live `launchctl print gui/<uid>/<label>` output), or nil. The relaunch
   *  safety check is an EXACT compare against this process's own binary —
   *  the label must run what this checkout is, not merely "a menubar". */
  static func labelRuns(uid: UInt32, label: String) -> String? {
    // `launchctl print <target>` renders the job's ProgramArguments as a
    // block of indented lines after `arguments = {`; take the first.
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = ["print", "gui/\(uid)/\(label)"]
    let captured = Pipe()
    p.standardOutput = captured
    p.standardError = FileHandle.nullDevice
    do { try p.run(); p.waitUntilExit() } catch { return nil }
    let data = (try? captured.fileHandleForReading.readToEnd()) ?? Data()
    let text = String(data: data, encoding: .utf8) ?? ""
    guard let start = text.range(of: "arguments = {") else { return nil }
    let rest = text[start.upperBound...]
    for line in rest.split(separator: "\n") {
      let t = line.trimmingCharacters(in: .whitespaces)
      if t == "}" { return nil }
      if !t.isEmpty { return t }
    }
    return nil
  }

  /** This process's own executable path (a bundle run is its bundle's
   *  executable; a bare-binary run is that bare path). */
  static func thisBinary() -> String {
    Bundle.main.bundleURL.path.hasSuffix(".app")
      ? Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/IdlefillMenubar").path
      : (Bundle.main.executablePath ?? "/")
  }

  /** Run a command and return ONLY its termination status (no log, no
   *  capture) — the "probe" primitive for the read-only gate facts. A
   *  failed spawn returns non-zero, so `== 0` reads as "the probe held".
   *  A GUI-launched app carries a minimal PATH; the children get the
   *  Homebrew prefix (git, node live there on this box). */
  static func probeExit(_ cmd: [String], cwd: String) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: cmd[0])
    p.arguments = Array(cmd.dropFirst())
    p.currentDirectoryURL = URL(fileURLWithPath: cwd)
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", env["PATH"] ?? ""].joined(separator: ":")
    p.environment = env
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do {
      try p.run()
      p.waitUntilExit()
      return p.terminationStatus
    } catch {
      return 255
    }
  }

  /** Assemble the full `UpdatePlan.Input` from the live system. Returns
   *  nil only when the CURRENT revision cannot be read (no git / not a
   *  repo / no HEAD) — the caller then aborts with a note. `origin/main`
   *  absent (a fresh clone that never fetched) reads as
   *  isAncestor=false + hasDelta=false — the plan refuses (diverged) and
   *  NOTHING is written, which is the safe default; in both the app and
   *  the harness gather runs only AFTER a successful fetch, so that
   *  branch is defensive. The gate ORDER is the caller's responsibility
   *  (it checks treeClean, then runs the fetch, then consumes these) so a
   *  dirty tree never triggers a fetch or any write; this helper is the
   *  fact bundle for the pure decision once the gates have been checked
   *  in order. */
  static func gather(repo: String, uid: UInt32 = geteuid(),
                     label: String = UpdatePlan.label,
                     thisBin: String? = thisBinary()) -> UpdatePlan.Input? {
    guard let old = shortSha("HEAD", cwd: repo) else { return nil }
    let loaded = labelLoaded(uid: uid, label: label)
    let thisIsLabelBinary = loaded && (labelRuns(uid: uid, label: label) == thisBin)
    let pids = AppModel.daemonPIDs(repo: repo)
    let clean = gitStatusClean(repo: repo)
    // origin/main present (fetched): the real delta facts. Absent (a fresh
    // clone that never fetched): read as "no delta" (the no-op note is the
    // correct answer, and the caller's fetch gate runs before this anyway).
    if let new = shortSha("origin/main", cwd: repo) {
      return UpdatePlan.Input(
        treeClean: clean, fetchOk: true,
        isAncestor: isAncestorOfOriginMain(repo: repo),
        hasDelta: old != new,
        lockChanged: lockDelta(old: old, new: new, cwd: repo),
        daemonPids: pids, labelLoaded: loaded,
        thisIsLabelBinary: thisIsLabelBinary, currentShortSha: old)
    }
    return UpdatePlan.Input(
      treeClean: clean, fetchOk: true, isAncestor: false, hasDelta: false,
      lockChanged: false, daemonPids: pids, labelLoaded: loaded,
      thisIsLabelBinary: thisIsLabelBinary, currentShortSha: old)
  }
}

/** The update log at `<repo>/logs/idlefill-menubar.log` — the app's own
 *  log (the launchd plist's StandardOut/Err live elsewhere). One line per
 *  completed update, appended with O_APPEND (never deleted, never
 *  truncated to empty). Rotation: before an append, if the file exceeds
 *  the cap, keep only the last 512 KiB (truncate the head) — the file is
 *  always left non-empty. */
enum UpdateLog {
  static let capBytes: UInt64 = 1_048_576      // 1 MiB
  static let keepBytes: UInt64 = 524_288       // 512 KiB tail
  static let fileName = "idlefill-menubar.log"

  /** Append one line (rotating first when over the cap). */
  static func append(_ line: String, at path: String) {
    rotateIfNeeded(path: path)
    let dir = (path as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
    guard fd >= 0 else { return }
    defer { close(fd) }
    var bytes = Data(line.utf8)
    bytes.append(0x0a) // \n
    _ = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
  }

  /** If the file is over the cap, keep only its last `keepBytes` — but
   *  never below the start of the final line (a rotation must not cut a
   *  line in half, and must never empty the file). */
  static func rotateIfNeeded(path: String) {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
          let size = attrs[.size] as? UInt64, size > capBytes else { return }
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return }
    var keep = Array(data.suffix(Int(keepBytes)))
    // Never cut the final line: if the kept tail does not end with a
    // newline boundary that aligns to a whole line, back up to the last
    // newline so the tail is whole lines only. (If that would empty it,
    // keep the entire tail.)
    if let nl = keep.lastIndex(where: { $0 == 0x0a }), nl != keep.count - 1 {
      keep = Array(keep.suffix(from: nl + 1))
    }
    if keep.isEmpty { keep = Array(data.suffix(Int(keepBytes))) }
    let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    guard fd >= 0 else { return }
    defer { close(fd) }
    _ = keep.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
  }

  /** ISO-8601 UTC timestamp, e.g. `2026-09-30T12:34:56Z`. */
  static func nowISO() -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
    return f.string(from: Date())
  }

  /** `git rev-parse --short HEAD` in `cwd` (thin wrapper — the value the
   *  deployed-revision row shows). nil on any failure. */
  static func currentRevision(repo: String) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    p.arguments = ["-C", repo, "rev-parse", "--short", "HEAD"]
    p.currentDirectoryURL = URL(fileURLWithPath: repo)
    let captured = Pipe()
    p.standardOutput = captured
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { return nil }
    let data = (try? captured.fileHandleForReading.readToEnd()) ?? Data()
    let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return s.isEmpty ? nil : s
  }
}

// MARK: - views

struct KVRow: View {
  let k: String
  let v: String
  var vcolor: Color = Pal.text
  var body: some View {
    HStack {
      Text(k).font(.system(.body, design: .monospaced)).foregroundStyle(Pal.dim)
      Spacer(minLength: 16)
      Text(v).font(.system(.body, design: .monospaced)).foregroundStyle(vcolor)
    }
  }
}

struct DividerLine: View {
  var body: some View {
    Rectangle().fill(Pal.hairline).frame(height: 1)
  }
}

struct LogoView: View {
  let spinning: Bool
  @State private var angle: Double = 0

  var body: some View {
    ZStack {
      Circle().stroke(Pal.hairline, lineWidth: 2)
      Circle()
        .trim(from: 0, to: 0.75)
        .stroke(Pal.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round))
        .rotationEffect(.degrees(angle - 90))
    }
    .onChange(of: spinning) { _, on in
      if on {
        withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
          angle += 360
        }
      } else {
        withAnimation(.easeOut(duration: 0.2)) { angle = 0 }
      }
    }
  }
}

struct ContentView: View {
  @ObservedObject var m: AppModel

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        LogoView(spinning: m.lease.1 > 0)
          .frame(width: 14, height: 14)
        Text("idlefill")
          .font(.system(.headline, design: .monospaced).weight(.semibold))
          .foregroundStyle(Pal.text)
        Spacer()
        Text(m.conn.word)
          .font(.system(.body, design: .monospaced).weight(.semibold))
          .foregroundStyle(m.conn.color)
      }
      .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 8)

      DividerLine()

      VStack(spacing: 4) {
        KVRow(k: "this machine", v: statusRow)
        // The deployed revision (git rev-parse --short HEAD) — the standing
        // answer to "what is deployed?". Always shown once known (set at
        // launch and on every completed Update Code); hidden only before
        // the first successful read.
        if let rev = m.deployedRevision {
          KVRow(k: "revision", v: rev)
        }
        KVRow(k: "queue", v: "\(m.queueDepth)")
        KVRow(k: "today", v: "\(m.today.finished) ok · \(m.today.failed) failed")
        if m.tokensToday.value != nil {
          KVRow(k: "tokens out", v: tokenRow)
        }
        if m.lease.1 > 0 {
          KVRow(k: "running", v: leaseRow, vcolor: Pal.accent)
        }
      }
      .padding(14).padding(.vertical, 8)

      DividerLine()

      actionRow("Open Dashboard", arrow: true)
      actionRow("Show Logs")
      DividerLine()
      actionRow(m.daemonRunning ? "Stop" : "Start")
      actionRow("Restart")
      DividerLine()
      actionRow("Update Code")

      // Exception-only (the same pattern as the updateNote below): the row
      // exists only while an update is available — hidden otherwise.
      if let v = m.updateAvailable {
        actionRow("Install Update \(v)")
      }

      if let note = m.updateNote {
        DividerLine()
        Text(note).font(.system(.caption, design: .monospaced)).foregroundStyle(Pal.dim)
          .padding(10).frame(maxWidth: .infinity, alignment: .leading)
      }

      DividerLine()
      actionRow("Quit")
    }
    .background(Pal.canvas)
    .frame(width: 300)
  }

  private var statusRow: String {
    if !m.daemonRunning { return "stopped" }
    if let s = m.lastSeenS, s >= 120 { return "stale (\(s / 60) min)" }
    return m.conn.word
  }

  private var tokenRow: String {
    let v = m.tokensToday.value ?? 0
    if let cap = m.tokensToday.cap, cap > 0 {
      return String(format: "%.0f / %.0f (%.0f%%)", v, cap, v / cap * 100)
    }
    return String(format: "%.0f", v)
  }

  private var leaseRow: String {
    let left = Int(max(0, m.lease.1 / 1000 - Date().timeIntervalSince1970))
    return "\(m.lease.0) · auto-cancels \(left / 60)m \(left % 60)s"
  }

  @ViewBuilder
  func actionRow(_ label: String, arrow: Bool = false) -> some View {
    Button(action: {
      switch label {
      case "Open Dashboard":
        // Desktop app installed → its Projects view (this client's project
        // config). Not installed → today's behavior: the arbiter web
        // dashboard in the browser.
        if MenuBarAppState.desktopInstalled() {
          MenuBarAppState.openDesktopURL("idlefill://projects")
        } else if let url = URL(string: m.serverURL() + "/") { NSWorkspace.shared.open(url) }
      case "Show Logs":
        // Desktop app installed → its Logs view. Not installed → today's
        // behavior: open the daemon log dir in Finder.
        if MenuBarAppState.desktopInstalled() {
          MenuBarAppState.openDesktopURL("idlefill://logs")
        } else {
          // The daemon anchors its log to the ENTRY dir (client/src in dev,
          // client/dist after a build), so <client>/<entry>/logs/client.log.
          let pkg = m.clientPkgDir
          let logsBase = (pkg as NSString).appendingPathComponent("logs")
          let entry = FileManager.default.fileExists(atPath: (pkg as NSString).appendingPathComponent("dist/index.ts")) ? "dist" : "src"
          let logDir = ((pkg as NSString).appendingPathComponent(entry) as NSString).appendingPathComponent("logs")
          let target = FileManager.default.fileExists(atPath: logDir) ? logDir : logsBase
          NSWorkspace.shared.open(URL(fileURLWithPath: target))
        }
      case "Start": m.start()
      case "Stop": m.stop()
      case "Restart": m.restart()
      case "Update Code": m.updateCode()
      case "Quit": NSApplication.shared.terminate(nil)
      // The Install Update row carries the version in its label (the
      // exception-only row — it only exists while one is available).
      default:
        if label.hasPrefix("Install Update") { m.installUpdate() }
        else { break }
      }
    }) {
      HStack {
        Text(label).font(.system(.body, design: .monospaced)).foregroundStyle(Pal.text)
        Spacer()
        if arrow {
          Image(systemName: "arrow.up.forward").font(.system(size: 10)).foregroundStyle(Pal.dim)
        }
      }
      .padding(.horizontal, 14).padding(.vertical, 7)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

// MARK: - app (AppKit host — NSStatusItem + NSPopover)

/** Shared state for the status-item host and the panel rows: the
 *  desktop-app-installed check (a FileManager test — no side effects) and
 *  the URL-scheme open with the app-path fallback. */
enum MenuBarAppState {
  /** The desktop app is "installed" when its standard install target
   *  (per desktop/update.sh) exists. */
  static func desktopInstalled() -> Bool {
    FileManager.default.fileExists(atPath: DesktopApp.appPath)
  }

  /** Open an `idlefill://` URL in the desktop app. When the URL-scheme open
   *  is not handled (the scheme not registered yet), fall back to `open`
   *  of the app path itself. */
  static func openDesktopURL(_ string: String) {
    guard let url = URL(string: string) else { return }
    let opened = NSWorkspace.shared.open(url)
    if !opened {
      NSWorkspace.shared.open(URL(fileURLWithPath: DesktopApp.appPath))
    }
  }
}

/** `--version` / `-v` (first arg) prints `idlefill-menubar <version>` and
 *  exits 0 BEFORE any AppKit setup (the App's init /
 *  applicationDidFinishLaunching never run on this path — the decision is
 *  made in main() before the App type is ever touched). */
@main
enum IdlefillMain {
  static func main() {
    let args = CommandLine.arguments
    if args.count > 1, args[1] == "--version" || args[1] == "-v" {
      print("idlefill-menubar \(AppModel.bakedVersion())")
      exit(0)
    }
    IdlefillApp.main()
  }
}

struct IdlefillApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

  var body: some Scene {
    // No window of its own — the status item + popover ARE the app.
    Settings { EmptyView() }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem?
  private var popover: NSPopover?
  private var model: AppModel?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    let model = AppModel()
    self.model = model

    let popover = NSPopover()
    popover.behavior = .transient
    popover.appearance = NSAppearance(named: .darkAqua)
    // The panel view, hosted as-is (NSHostingController sizes the popover
    // to the SwiftUI content, like the old MenuBarExtra window did).
    popover.contentViewController = NSHostingController(rootView: ContentView(m: model))
    self.popover = popover

    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = item.button {
      button.image = MenuIcon.image(spinning: false)
      button.target = self
      button.action = #selector(statusItemClicked(_:))
    }
    self.statusItem = item

    // Keep the icon's spinning state in step with the model (a lease
    // running → the arc rotates) — the MenuBarExtra label used to do this
    // for free; re-render on a slow timer instead.
    Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      guard let self, let button = self.statusItem?.button else { return }
      button.image = MenuIcon.image(spinning: (self.model?.lease.1 ?? 0) > 0)
    }
  }

  /** The click routing decision comes from the pure MenuBarRouter (click
   *  count + desktop-installed → action) — the handler only executes it.
   *  NSStatusBarButton exposes no clickCount (AppKit), so it comes off the
   *  event that drove the action — `NSApp.currentEvent`. */
  @objc private func statusItemClicked(_ sender: NSStatusBarButton) {
    let clickCount = NSApp.currentEvent?.clickCount ?? 1
    let action = MenuBarRouter.action(clickCount: clickCount,
                                      desktopInstalled: MenuBarAppState.desktopInstalled())
    switch action {
    case .togglePanel:
      togglePopover(sender)
    case .openDesktopApp:
      // A double click ALWAYS attempts the desktop app (the fallback to
      // `open` of the app path is inside openDesktopURL).
      MenuBarAppState.openDesktopURL("\(DesktopApp.scheme)://open")
    }
  }

  private func togglePopover(_ button: NSStatusBarButton) {
    guard let popover else { return }
    if popover.isShown {
      popover.performClose(nil)
    } else {
      popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
      popover.contentViewController?.view.window?.makeKey()
    }
  }
}

enum MenuIcon {
  static func image(spinning: Bool) -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let img = NSImage(size: size)
    img.lockFocus()
    let inset: CGFloat = 2.5
    let cx = size.width / 2
    let cy = size.height / 2
    let r = (size.width - inset * 2) / 2
    let hair = NSColor(calibratedRed: 0x30 / 255, green: 0x36 / 255, blue: 0x3d / 255, alpha: 1)
    let blue = NSColor(calibratedRed: 0x58 / 255, green: 0xa6 / 255, blue: 0xff / 255, alpha: 1)

    // track: the full quiet ring
    let track = NSBezierPath(ovalIn: NSRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
    track.lineWidth = 2
    hair.setStroke()
    track.stroke()

    // arc: an open ring, 270° with a rounded leading cap. At rest the gap
    // sits at the bottom; while a lease runs the arc rotates a quarter turn
    // (gap at top-right) — "the bar is turning".
    let arc = NSBezierPath()
    arc.appendArc(withCenter: NSPoint(x: cx, y: cy), radius: r,
                  startAngle: spinning ? 45 : -90, endAngle: spinning ? 315 : 180)
    arc.lineWidth = 2
    arc.lineCapStyle = .round
    blue.setStroke()
    arc.stroke()

    img.unlockFocus()
    img.isTemplate = false
    return img
  }
}
