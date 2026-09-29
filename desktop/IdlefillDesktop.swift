//
//  IdlefillDesktop.swift — the idlefill desktop app (macOS 14+).
//
//  A windowed companion (WindowGroup, NOT a MenuBarExtra) built with bare
//  swiftc (no Xcode project). Three surfaces in one window:
//
//    state     — color-coded state word, this machine's status, queue depth,
//                today finished/failed, the running lease (polls /api/state
//                every 5s with the Bearer token)
//    logs      — the client daemon log tail (client/<entry>/logs/client.log),
//                refreshed on a ~2.5s timer, last ~2000 lines kept, auto-scroll
//                to the tail while at the bottom, "follow tail" toggle to
//                resume after scrolling up
//    settings  — opt-in launchd management of the two LaunchAgents (daemon +
//                menu bar) in the user's gui/<uid> domain; the toggles reflect
//                REAL launchctl state, re-checked on every poll
//
//  Design: quiet control room (DESIGN.md). Neutral canvas (#0d1117), hairline
//  dividers (#30363d), one mono family, four signal colors used ONLY for live
//  state (green idle, amber busy, blue working, red degraded).
//
//  The token is read at runtime from <repo>/client/config.json — it is never
//  baked into this file, the bundle, or the binary, and never printed.
//

import AppKit
import SwiftUI

// MARK: - palette (DESIGN.md tokens)

enum Pal {
  static let canvas   = Color(red: 0x0d / 255, green: 0x11 / 255, blue: 0x17 / 255)
  static let panel    = Color(red: 0x16 / 255, green: 0x1b / 255, blue: 0x22 / 255)
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

// MARK: - model

struct LogLine: Identifiable, Equatable {
  let id: Int
  let text: String
}

final class AppModel: ObservableObject {
  // state panel
  @Published var conn: Conn = .off
  @Published var daemonRunning = false
  @Published var queueDepth = 0
  @Published var today: (finished: Int, failed: Int) = (0, 0)
  @Published var lease: (job: String, expiresAt: Double) = ("", 0)
  @Published var lastSeenS: Int? = nil

  // log viewer (stable ids — trimming the head must not re-identify rows)
  @Published var logLines: [LogLine] = []
  @Published var logPath: String = ""
  @Published var followTail = true

  // settings
  @Published var repoPath: String = ""
  @Published var daemonLoaded = false
  @Published var menubarLoaded = false
  @Published var daemonNote: String? = nil
  @Published var menubarNote: String? = nil

  private(set) var repoRoot: String = AppModel.findRepoRoot()

  private var logOffset: UInt64 = 0
  private var logSeq = 0
  private let maxLogLines = 2000
  private let uid = getuid()

  init() {
    loadConfig()
    refreshLaunchdState()
    pollLogs()
    // Self-driving timers (main runloop — App init runs on the main thread).
    Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      self?.poll()
      self?.refreshLaunchdState()
    }
    Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in
      self?.pollLogs()
    }
    poll()
  }

  // MARK: repo path resolution

  /** Default repo root: ~/Software/idlefill, overridable via the IDLEFILL_REPO_PATH
   *  env var or the persisted Settings field (~/Library/Application
   *  Support/Idlefill/config.json). */
  static func findRepoRoot() -> String {
    if let p = ProcessInfo.processInfo.environment["IDLEFILL_REPO_PATH"], !p.isEmpty {
      return (p as NSString).expandingTildeInPath
    }
    let fm = FileManager.default
    if let o = readAppConfig(), let r = o["repo_path"] as? String, !r.isEmpty {
      return (r as NSString).expandingTildeInPath
    }
    let def = ((NSHomeDirectory() as NSString).appendingPathComponent("Software/idlefill"))
    if fm.fileExists(atPath: (def as NSString).appendingPathComponent("client/config.json")) {
      return def
    }
    // Fallback: walk up from $HOME looking for a repo that carries
    // client/config.json (bounded: no infinite loops).
    var dir = NSHomeDirectory()
    for _ in 0..<14 {
      if fm.fileExists(atPath: (dir as NSString).appendingPathComponent("client/config.json")) {
        return dir
      }
      let parent = (dir as NSString).deletingLastPathComponent
      if parent == dir { break }
      dir = parent
    }
    return def
  }

  static func readAppConfig() -> [String: Any]? {
    let path = AppModel.appConfigPath()
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  static func appConfigPath() -> String {
    let base = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/Idlefill")
    try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
    return (base as NSString).appendingPathComponent("config.json")
  }

  func loadConfig() {
    if let o = AppModel.readAppConfig(), let r = o["repo_path"] as? String, !r.isEmpty {
      repoPath = r
      repoRoot = (r as NSString).expandingTildeInPath
    } else {
      repoPath = repoRoot
    }
  }

  /** Persist the Settings repo-path field. An empty field clears the override
   *  back to the default. */
  func saveRepoPath() {
    let v = repoPath.trimmingCharacters(in: .whitespacesAndNewlines)
    var o = AppModel.readAppConfig() ?? [:]
    if v.isEmpty {
      o.removeValue(forKey: "repo_path")
    } else {
      o["repo_path"] = v
    }
    let data = (try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys])) ?? Data()
    try? data.write(to: URL(fileURLWithPath: AppModel.appConfigPath()))
    repoPath = v.isEmpty ? repoRoot : v
    repoRoot = (repoPath as NSString).expandingTildeInPath
    logOffset = 0
    logLines = []
    pollLogs()
    poll()
    refreshLaunchdState()
  }

  var clientPkgDir: String { (repoRoot as NSString).appendingPathComponent("client") }

  // MARK: config (token + server url, read at runtime — never baked in)

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

  // MARK: state poll (same parsing as the menubar app)

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

  // MARK: log viewer

  /** Resolve the daemon log path: <repo>/client/<entry>/logs/client.log where
   *  <entry> is src in dev, dist after a build (mirrors the menubar's Show
   *  Logs detection); if the entry dir's log is missing, fall back to
   *  <repo>/client/logs/. */
  func resolveLogPath() -> String? {
    let fm = FileManager.default
    let pkg = clientPkgDir
    let entry = fm.fileExists(atPath: (pkg as NSString).appendingPathComponent("dist/index.ts")) ? "dist" : "src"
    let entryLog = (((pkg as NSString).appendingPathComponent(entry) as NSString).appendingPathComponent("logs") as NSString).appendingPathComponent("client.log")
    if fm.fileExists(atPath: entryLog) { return entryLog }
    let fallback = ((pkg as NSString).appendingPathComponent("logs") as NSString).appendingPathComponent("client.log")
    if fm.fileExists(atPath: fallback) { return fallback }
    return nil
  }

  func pollLogs() {
    let path = resolveLogPath()
    if let p = path {
      if p != logPath {
        logPath = p
        logOffset = 0
        logLines = []
      }
      appendLog(path: p)
    } else {
      if logPath != "" { logPath = ""; logLines = []; logOffset = 0 }
    }
  }

  private func appendLog(path: String) {
    let fm = FileManager.default
    guard let attrs = try? fm.attributesOfItem(atPath: path),
          let size = (attrs[.size] as? NSNumber)?.uint64Value else { return }
    if size < logOffset {
      // rotated or truncated — restart from the top
      logOffset = 0
      logLines = []
    }
    guard size > logOffset else { return }
    guard let handle = FileHandle(forReadingAtPath: path) else { return }
    defer { try? handle.close() }
    do {
      try handle.seek(toOffset: logOffset)
      let chunk = handle.readDataToEndOfFile()
      logOffset += UInt64(chunk.count)
      guard let text = String(data: chunk, encoding: .utf8) else { return }
      for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
        logLines.append(LogLine(id: logSeq, text: String(line)))
        logSeq += 1
      }
      if logLines.count > maxLogLines {
        logLines.removeFirst(logLines.count - maxLogLines)
      }
    } catch {}
  }

  // MARK: launchd management (opt-in, gui/<uid>, real state only)

  /** Test hook: when IDLEFILL_DESKTOP_TEST is set (to a scratch dir), the
   *  plists are written under that dir (never ~/Library/LaunchAgents) and
   *  the agents carry harmless scratch labels (`/bin/sleep 3600`), never the
   *  real ones. The write-plist → bootstrap → verify → bootout → verify
   *  machinery is byte-identical to the shipping path, so the scratch
   *  labels prove it. */
  private let testDir: String? = ProcessInfo.processInfo.environment["IDLEFILL_DESKTOP_TEST"]
  private let testLabel = "com.sam.idlefill.desktop-test"

  var daemonLabel: String {
    testDir != nil
      ? (ProcessInfo.processInfo.environment["IDLEFILL_DESKTOP_TEST_LABEL_DAEMON"] ?? testLabel)
      : "com.sam.idlefill.client"
  }
  var menubarLabel: String {
    testDir != nil
      ? (ProcessInfo.processInfo.environment["IDLEFILL_DESKTOP_TEST_LABEL_MENUBAR"] ?? testLabel)
      : "com.sam.idlefill.menubar"
  }

  private var plistDir: String {
    testDir ?? ((NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents"))
  }
  var daemonPlistPath: String { (plistDir as NSString).appendingPathComponent("\(daemonLabel).plist") }
  var menubarPlistPath: String { (plistDir as NSString).appendingPathComponent("\(menubarLabel).plist") }

  /** Is the label loaded in our gui domain? exit 0 = loaded. */
  func isLoaded(_ label: String) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = ["print", "gui/\(uid)/\(label)"]
    let tmp = tempFile("idlefill-desktop-lc-\(getpid())-\(label.replacingOccurrences(of: ".", with: "_"))")
    guard let out = FileHandle(forWritingAtPath: tmp) else { return false }
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch {
      try? out.close(); try? FileManager.default.removeItem(atPath: tmp)
      return false
    }
    p.waitUntilExit()
    try? out.close()
    try? FileManager.default.removeItem(atPath: tmp)
    return p.terminationStatus == 0
  }

  func refreshLaunchdState() {
    daemonLoaded = isLoaded(daemonLabel)
    menubarLoaded = isLoaded(menubarLabel)
  }

  /** Run a command, capturing stdout/stderr to a TEMP FILE (a Pipe +
   *  waitUntilExit deadlocks once the child emits more than the 64 KB pipe
   *  buffer — see the menubar's daemonPIDs pattern). Returns (exit, output).
   *  The child gets a real PATH — a GUI-launched app carries only
   *  /usr/bin:/bin, where swiftc/node do not live. */
  func runCmd(_ path: String, _ args: [String]) -> (Int32, String) {
    let tmpOut = tempFile("idlefill-desktop-cmd-out-\(getpid())")
    let tmpErr = tempFile("idlefill-desktop-cmd-err-\(getpid())")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin"].joined(separator: ":")
    p.environment = env
    guard let out = FileHandle(forWritingAtPath: tmpOut),
          let err = FileHandle(forWritingAtPath: tmpErr) else {
      try? FileManager.default.removeItem(atPath: tmpOut)
      try? FileManager.default.removeItem(atPath: tmpErr)
      return (-1, "could not open temp files")
    }
    p.standardOutput = out
    p.standardError = err
    do {
      try p.run()
    } catch {
      try? out.close(); try? err.close()
      try? FileManager.default.removeItem(atPath: tmpOut)
      try? FileManager.default.removeItem(atPath: tmpErr)
      return (-1, error.localizedDescription)
    }
    p.waitUntilExit()
    try? out.close()
    try? err.close()
    let o = (try? String(contentsOfFile: tmpOut, encoding: .utf8)) ?? ""
    let e = (try? String(contentsOfFile: tmpErr, encoding: .utf8)) ?? ""
    try? FileManager.default.removeItem(atPath: tmpOut)
    try? FileManager.default.removeItem(atPath: tmpErr)
    let combined = (o + e).trimmingCharacters(in: .whitespacesAndNewlines)
    return (p.terminationStatus, combined)
  }

  private func tempFile(_ name: String) -> String {
    let tmp = (NSTemporaryDirectory() as NSString).appendingPathComponent(name)
    FileManager.default.createFile(atPath: tmp, contents: nil)
    return tmp
  }

  /** Write the plist then bootstrap. On failure: show the error in a note row
   *  and leave the toggle OFF (state reflects launchctl, so it stays off). */
  private func install(label: String, plistPath: String, plistXML: String, note: ReferenceWritableKeyPath<AppModel, String?>) {
    try? FileManager.default.createDirectory(atPath: (plistPath as NSString).deletingLastPathComponent,
                                             withIntermediateDirectories: true)
    do {
      try plistXML.write(toFile: plistPath, atomically: true, encoding: .utf8)
    } catch {
      self[keyPath: note] = "install failed: could not write \(plistPath)"
      refreshLaunchdState()
      return
    }
    let (st, out) = runCmd("/bin/launchctl", ["bootstrap", "gui/\(uid)", plistPath])
    if st == 0 {
      self[keyPath: note] = nil
    } else {
      // "Bootstrap failed: 5: Input/output error" is what launchctl says when
      // the label is ALREADY loaded — treat that as a clean no-op success.
      if out.contains("Input/output error") || out.lowercased().contains("already") {
        self[keyPath: note] = nil
      } else {
        self[keyPath: note] = "bootstrap failed: \(out)"
      }
    }
    refreshLaunchdState()
  }

  private func uninstall(label: String, note: ReferenceWritableKeyPath<AppModel, String?>) {
    let (st, out) = runCmd("/bin/launchctl", ["bootout", "gui/\(uid)/\(label)"])
    if st == 0 || out.lowercased().contains("could not find service") || out.lowercased().contains("no such process") {
      self[keyPath: note] = nil
    } else {
      self[keyPath: note] = "bootout failed: \(out)"
    }
    refreshLaunchdState()
  }

  // MARK: daemon agent

  func daemonPlistXML() -> String {
    let repo = repoRoot
    let tsx = (repo as NSString).appendingPathComponent("node_modules/.bin/tsx")
    let entry = ((repo as NSString).appendingPathComponent("client") as NSString).appendingPathComponent("src/index.ts")
    let cwd = (repo as NSString).appendingPathComponent("client")
    let logDir = (cwd as NSString).appendingPathComponent("logs")
    // The plist carries NO token — the daemon reads client/config.json itself
    // at startup.
    return """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>Label</key>
        <string>\(daemonLabel)</string>
        <key>ProgramArguments</key>
        <array>
            <string>\(tsx)</string>
            <string>\(entry)</string>
        </array>
        <key>WorkingDirectory</key>
        <string>\(cwd)</string>
        <key>EnvironmentVariables</key>
        <dict>
            <key>PATH</key>
            <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        </dict>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <dict>
            <key>SuccessfulExit</key>
            <false/>
        </dict>
        <key>ThrottleInterval</key>
        <integer>30</integer>
        <key>StandardOutPath</key>
        <string>\(logDir)/launchd.out.log</string>
        <key>StandardErrorPath</key>
        <string>\(logDir)/launchd.err.log</string>
    </dict>
    </plist>
    """
  }

  func setDaemon(on: Bool) {
    if on {
      let xml = testDir != nil ? testPlistXML(daemonLabel) : daemonPlistXML()
      install(label: daemonLabel, plistPath: daemonPlistPath, plistXML: xml, note: \.daemonNote)
    } else {
      uninstall(label: daemonLabel, note: \.daemonNote)
    }
  }

  // MARK: menu bar agent

  func menubarBinaryPath() -> String {
    (repoRoot as NSString).appendingPathComponent("menubar/IdlefillMenubar")
  }

  func menubarPlistXML() -> String {
    let bin = menubarBinaryPath()
    let logDir = (repoRoot as NSString).appendingPathComponent("logs")
    return """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>Label</key>
        <string>\(menubarLabel)</string>
        <key>ProgramArguments</key>
        <array>
            <string>\(bin)</string>
        </array>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <dict>
            <key>SuccessfulExit</key>
            <false/>
        </dict>
        <key>EnvironmentVariables</key>
        <dict>
            <key>PATH</key>
            <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        </dict>
        <key>StandardOutPath</key>
        <string>\(logDir)/idlefill-menubar-launchd.log</string>
        <key>StandardErrorPath</key>
        <string>\(logDir)/idlefill-menubar-launchd-err.log</string>
    </dict>
    </plist>
    """
  }

  func setMenubar(on: Bool) {
    if on {
      if testDir == nil {
        // Build the menubar binary first if it is missing.
        if !FileManager.default.isExecutableFile(atPath: menubarBinaryPath()) {
          let script = (repoRoot as NSString).appendingPathComponent("menubar/build.sh")
          guard FileManager.default.isExecutableFile(atPath: script) else {
            menubarNote = "menubar build failed: \(script) not found"
            refreshLaunchdState()
            return
          }
          menubarNote = "building menubar …"
          let (st, out) = runCmd("/bin/bash", [script])
          if st != 0 || !FileManager.default.isExecutableFile(atPath: menubarBinaryPath()) {
            menubarNote = "menubar build failed: \(out)"
            refreshLaunchdState()
            return
          }
        }
      }
      let xml = testDir != nil ? testPlistXML(menubarLabel) : menubarPlistXML()
      install(label: menubarLabel, plistPath: menubarPlistPath, plistXML: xml, note: \.menubarNote)
    } else {
      uninstall(label: menubarLabel, note: \.menubarNote)
    }
  }

  /** Scratch plist for the test hook (harmless program). */
  func testPlistXML(_ label: String) -> String {
    """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>Label</key>
        <string>\(label)</string>
        <key>ProgramArguments</key>
        <array>
            <string>/bin/sleep</string>
            <string>3600</string>
        </array>
        <key>RunAtLoad</key>
        <true/>
    </dict>
    </plist>
    """
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

struct PanelHead: View {
  let title: String
  var body: some View {
    Text(title.uppercased())
      .font(.system(size: 11, weight: .semibold, design: .monospaced))
      .tracking(1)
      .foregroundStyle(Pal.dim)
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

// MARK: state panel

struct StatePanel: View {
  @ObservedObject var m: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      PanelHead(title: "state")
      VStack(spacing: 4) {
        KVRow(k: "arbiter", v: m.conn.word, vcolor: m.conn.color)
        KVRow(k: "this machine", v: statusRow)
        KVRow(k: "queue", v: "\(m.queueDepth)")
        KVRow(k: "today", v: "\(m.today.finished) ok · \(m.today.failed) failed")
        if m.lease.1 > 0 {
          KVRow(k: "running", v: leaseRow, vcolor: Pal.accent)
        }
      }
      .padding(14).padding(.vertical, 8)
    }
  }

  private var statusRow: String {
    if !m.daemonRunning { return "stopped" }
    if let s = m.lastSeenS, s >= 120 { return "stale (\(s / 60) min)" }
    return m.conn.word
  }

  private var leaseRow: String {
    let left = Int(max(0, m.lease.1 / 1000 - Date().timeIntervalSince1970))
    return "\(m.lease.0) · auto-cancels \(left / 60)m \(left % 60)s"
  }
}

// MARK: log viewer

private struct SentinelKey: PreferenceKey {
  static var defaultValue: Double = .infinity
  static func reduce(value: inout Double, nextValue: () -> Double) { value = min(value, nextValue()) }
}

private struct ViewportKey: PreferenceKey {
  static var defaultValue: Double = 0
  static func reduce(value: inout Double, nextValue: () -> Double) { value = nextValue() }
}

struct LogViewer: View {
  @ObservedObject var m: AppModel
  @State private var sentinelY = Double.infinity
  @State private var viewportH = 0.0
  private let sentinelID = 999_999_999

  /// The user is at the tail when the sentinel's top edge sits at (or past)
  /// the bottom of the viewport.
  private var atBottom: Bool { sentinelY <= viewportH + 2 }

  var body: some View {
    ScrollViewReader { proxy in
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          PanelHead(title: "logs")
          Spacer()
          Button(action: {
            m.followTail.toggle()
            if m.followTail {
              proxy.scrollTo(sentinelID, anchor: .bottom)
            }
          }) {
            Text(m.followTail ? "follow tail: on" : "follow tail: off")
              .font(.system(size: 11, design: .monospaced))
              .foregroundStyle(m.followTail ? Pal.dim : Pal.warn)
          }
          .buttonStyle(.plain)
        }
        .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 4)

        if m.logPath == "" {
          Text("no client log found at \(m.repoRoot)/client/")
            .font(.system(.caption, design: .monospaced))
            .italic()
            .foregroundStyle(Pal.dim)
            .padding(14)
        } else {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
              ForEach(m.logLines) { line in
                Text(line.text.isEmpty ? " " : line.text)
                  .font(.system(size: 11, design: .monospaced))
                  .foregroundStyle(Pal.text)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .padding(.horizontal, 14).padding(.vertical, 1)
                  .overlay(alignment: .bottom) {
                    Rectangle().fill(Pal.hairline.opacity(0.5)).frame(height: 1)
                  }
                  .id(line.id)
              }
              // Sentinel at the tail: its position in the viewport is how we
              // tell whether the user is at the bottom.
              Color.clear.frame(height: 1)
                .background(
                  GeometryReader { geo in
                    Color.clear.preference(key: SentinelKey.self,
                      value: geo.frame(in: .named("logs")).minY)
                  }
                )
                .id(sentinelID)
            }
            .padding(.bottom, 8)
          }
          .coordinateSpace(name: "logs")
          .background(
            GeometryReader { geo in
              Color.clear.preference(key: ViewportKey.self, value: Double(geo.size.height))
            }
          )
          .clipped()
          .onChange(of: m.logLines.count) { _, _ in
            if m.followTail && atBottom {
              proxy.scrollTo(sentinelID, anchor: .bottom)
            }
          }
          .onAppear { proxy.scrollTo(sentinelID, anchor: .bottom) }
        }
      }
      .onPreferenceChange(SentinelKey.self) { sentinelY = $0 }
      .onPreferenceChange(ViewportKey.self) { viewportH = $0 }
    }
  }
}

// MARK: settings

struct SettingsPanel: View {
  @ObservedObject var m: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      PanelHead(title: "settings")
      VStack(spacing: 8) {
        Toggle(isOn: Binding(
          get: { m.daemonLoaded },
          set: { m.setDaemon(on: $0) }
        )) {
          Text("daemon").font(.system(.body, design: .monospaced)).foregroundStyle(Pal.text)
        }
        .toggleStyle(SwitchToggleStyle(tint: Pal.accent))
        .controlSize(.small)

        Toggle(isOn: Binding(
          get: { m.menubarLoaded },
          set: { m.setMenubar(on: $0) }
        )) {
          Text("menu bar").font(.system(.body, design: .monospaced)).foregroundStyle(Pal.text)
        }
        .toggleStyle(SwitchToggleStyle(tint: Pal.accent))
        .controlSize(.small)

        if let note = m.daemonNote {
          Text(note).font(.system(.caption, design: .monospaced)).foregroundStyle(Pal.err)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        if let note = m.menubarNote {
          Text(note).font(.system(.caption, design: .monospaced)).foregroundStyle(Pal.err)
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        DividerLine()

        HStack(spacing: 8) {
          Text("repo path").font(.system(.body, design: .monospaced)).foregroundStyle(Pal.dim)
          TextField("", text: $m.repoPath)
            .font(.system(.body, design: .monospaced))
            .textFieldStyle(.plain)
            .foregroundStyle(Pal.text)
            .background(Pal.canvas)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .padding(4)
          Button("save") { m.saveRepoPath() }
            .font(.system(.body, design: .monospaced))
            .buttonStyle(.plain)
            .foregroundStyle(Pal.accent)
        }

        Text("launchd agents in gui/\(String(getuid())) — the toggles reflect real launchctl state, re-checked every 5s.")
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(Pal.dim)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(14).padding(.vertical, 8)
    }
  }
}

// MARK: content

struct ContentView: View {
  @ObservedObject var m: AppModel

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        LogoView(spinning: m.lease.1 > 0)
          .frame(width: 16, height: 16)
        Text("idlefill · desktop")
          .font(.system(.headline, design: .monospaced).weight(.semibold))
          .foregroundStyle(Pal.text)
        Spacer()
        Text(m.conn.word)
          .font(.system(.body, design: .monospaced).weight(.semibold))
          .foregroundStyle(m.conn.color)
      }
      .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 8)

      DividerLine()

      StatePanel(m: m)
      DividerLine()

      LogViewer(m: m)
        .frame(maxHeight: .infinity)

      DividerLine()
      SettingsPanel(m: m)
    }
    .background(Pal.canvas)
    .frame(minWidth: 520, minHeight: 560)
  }
}

// MARK: - app

@main
struct IdlefillApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
  @StateObject private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      ContentView(m: model)
        .preferredColorScheme(.dark)
    }
    .windowResizability(.contentMinSize)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    // A regular windowed app (.regular, the default) — but draw the dock icon
    // at runtime like the menubar's open-ring logo (no .icns in the bundle).
    NSApp.applicationIconImage = AppIcon.image()
  }
}

enum AppIcon {
  static func image() -> NSImage {
    let size = NSSize(width: 128, height: 128)
    let img = NSImage(size: size)
    img.lockFocus()
    let inset: CGFloat = 16
    let cx = size.width / 2
    let cy = size.height / 2
    let r = (size.width - inset * 2) / 2
    let hair = NSColor(calibratedRed: 0x30 / 255, green: 0x36 / 255, blue: 0x3d / 255, alpha: 1)
    let blue = NSColor(calibratedRed: 0x58 / 255, green: 0xa6 / 255, blue: 0xff / 255, alpha: 1)

    // track: the full quiet ring
    let track = NSBezierPath(ovalIn: NSRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2))
    track.lineWidth = 8
    hair.setStroke()
    track.stroke()

    // arc: an open ring, 270° with a rounded leading cap (gap at the bottom)
    let arc = NSBezierPath()
    arc.appendArc(withCenter: NSPoint(x: cx, y: cy), radius: r, startAngle: -90, endAngle: 180)
    arc.lineWidth = 8
    arc.lineCapStyle = .round
    blue.setStroke()
    arc.stroke()

    img.unlockFocus()
    return img
  }
}
