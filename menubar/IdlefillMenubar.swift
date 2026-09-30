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
//               Update code (git pull + npm ci + restart) · Quit
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
  @Published var updateNote: String? = nil

  let repoRoot: String = AppModel.findRepoRoot()

  // The baked version (substituted at build time by menubar/build.sh — the
  // `__MENUBAR_VERSION__` placeholder carries the release tag's version, so
  // the binary prints the release it was built from). A dev build where the
  // placeholder was never substituted reports itself as a dev build.
  let version = AppModel.bakedVersion()
  /// Update available (newest published `vX.Y.Z` strictly greater than the
  /// baked version) — exception-only, the panel's row renders when non-nil.
  @Published var updateAvailable: String? = nil

  init() {
    // Self-driving 10s poll (main runloop — App init runs on the main thread).
    Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
      self?.poll()
    }
    poll()
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
    (ProcessInfo.processInfo.environment["IDLEFILL_UPDATE_BASE"] ?? "https://git.samwarth.com")
      .replacingOccurrences(of: "/", with: "")
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
  func daemonPIDs() -> [Int] {
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
    let repo = repoRoot
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
  private func daemonPID() -> Int? { daemonPIDs().first }

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
    let pids = daemonPIDs()
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

  func updateCode() {
    let repo = repoRoot
    let logDir = (repo as NSString).appendingPathComponent("logs")
    try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    let logFile = (logDir as NSString).appendingPathComponent("idlefill-menubar.log")
    updateNote = "updating: git pull + npm ci …"
    run("/usr/bin/git", ["pull", "--ff-only", "origin", "main"], cwd: repo, log: logFile)
    run(npmPath(), ["ci", "--no-audit", "--no-fund"], cwd: repo, log: logFile)
    updateNote = "updated — restarting daemon"
    restart()
  }

  private func npmPath() -> String {
    for cand in ["/opt/homebrew/bin/npm", "/usr/local/bin/npm", "/usr/bin/npm"] {
      if FileManager.default.isExecutableFile(atPath: cand) { return cand }
    }
    return "/usr/bin/env"
  }

  private func run(_ path: String, _ args: [String], cwd: String, log: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    p.currentDirectoryURL = URL(fileURLWithPath: cwd)
    if let f = FileHandle(forWritingAtPath: log) {
      p.standardOutput = f
      p.standardError = f
    }
    do {
      try p.run()
      p.waitUntilExit()
      if p.terminationStatus != 0 {
        updateNote = "\((path as NSString).lastPathComponent) exited \(p.terminationStatus) — see logs/idlefill-menubar.log"
      }
    } catch {
      updateNote = "\((path as NSString).lastPathComponent) failed: \(error.localizedDescription)"
    }
  }

  // MARK: release update (check + install)

  /** The update check: on launch and every 6h (UpdateCheck.cadenceSeconds),
   *  GET the Forgejo releases list ANONYMOUSLY (the repo is public — the
   *  arbiter token is never sent to Forgejo), compare the newest `vX.Y.Z`
   *  against the baked version. OFFLINE-TOLERANT: any fetch/parse failure
   *  sets nothing and fails quiet — no dialog, no error row; the next
   *  cadence tick retries. */
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
    guard let tag = updateAvailable else { return }
    updateNote = "installing \(tag) …"
    UpdateCheck.install(
      base: AppModel.updateBase(),
      tag: tag,
      zipName: "IdlefillMenubar-\(tag).app.zip",
      bundleURL: AppModel.menubarBundleURL(),
      label: "com.sam.idlefill.menubar"
    ) { [weak self] outcome in
      guard let self else { return }
      DispatchQueue.main.async {
        switch outcome {
        case .installed:
          self.updateNote = "installed \(tag) — relaunched"
          self.updateAvailable = nil
        case .notLoaded:
          self.updateNote = "installed \(tag) — agent not loaded: run menubar/install.sh"
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

  /// Parse a release tag: `v<maj>.<min>.<patch>` (three numeric segments)
  /// → ((maj,min,patch), version string like "1.2.4"); anything else (a
  /// pre-release, an odd tag, a different segment count, a non-numeric
  /// segment) → nil — such tags are SKIPPED by the check.
  private static func parseTag(_ tag: String) -> ((Int, Int, Int), String)? {
    guard tag.hasPrefix("v") else { return nil }
    var segs: [Int?] = []
    var strs: [String] = []
    for seg in tag.dropFirst().split(separator: ".") {
      guard !seg.isEmpty, seg.allSatisfy(\.isNumber), let n = Int(seg) else { return nil }
      segs.append(n)
      strs.append(String(seg))
    }
    guard segs.count == 3,
          let a = segs[0], let b = segs[1], let c = segs[2],
          a < 100_000, b < 100_000, c < 100_000 else { return nil }
    return ((a, b, c), strs.joined(separator: "."))
  }

  /// The newest release whose `tag_name` is `v<maj>.<min>.<patch>` (numeric
  /// compare of the three segments; malformed tags skipped), strictly
  /// greater than the local version → its version string (e.g. "1.2.4").
  /// Any failure (unparseable payload, malformed version, no valid tags)
  /// → nil: fail quiet, nothing set, next tick retries.
  static func latestUpdateTag(data: Data?, localVersion: String) -> String? {
    guard let data,
          let o = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
      return nil
    }
    guard let local = semver(localVersion) else { return nil }
    var best: ((Int, Int, Int), String)?
    for rel in o {
      guard let tag = rel["tag_name"] as? String,
            let parsed = parseTag(tag) else { continue }
      if best == nil || parsed.0 > best!.0 { best = (parsed.0, parsed.1) }
    }
    guard let b = best else { return nil }
    return b.0 > local ? b.1 : nil
  }

  /// "1.2.3" → (1, 2, 3); non-numeric segments, a different segment count,
  /// or out-of-range values → nil (a malformed local version fails quiet).
  private static func semver(_ s: String) -> (Int, Int, Int)? {
    var parts: [Int?] = []
    for seg in s.split(separator: ".") {
      if seg.isEmpty || !seg.allSatisfy(\.isNumber) { return nil }
      parts.append(Int(seg))
    }
    guard parts.count == 3,
          let a = parts[0], let b = parts[1], let c = parts[2],
          a >= 0, a < 100_000, b >= 0, b < 100_000, c >= 0, c < 100_000 else {
      return nil
    }
    return (a, b, c)
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
