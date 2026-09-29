//
//  IdlefillMenubar.swift — the idlefill menu bar companion (macOS 14+).
//
//  A MenuBarExtra icon (the idlefill circular-loading-bar logo: an open ring
//  with a rounded leading cap) that shows the arbiter state at a glance and
//  controls the local client daemon:
//
//    status   — color-coded state word + this machine's live status row
//    stats    — queue depth, today finished/failed, tokens out (UTC), the
//               running lease (job · auto-cancels-in)
//    actions  — Open Dashboard · Show Logs · Start/Stop · Restart ·
//               Update code (git pull + npm ci + restart) · Quit
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

  init() {
    // Self-driving 10s poll (main runloop — App init runs on the main thread).
    Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
      self?.poll()
    }
    poll()
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
        if let url = URL(string: m.serverURL() + "/") { NSWorkspace.shared.open(url) }
      case "Show Logs":
        // The daemon anchors its log to the ENTRY dir (client/src in dev,
        // client/dist after a build), so <client>/<entry>/logs/client.log.
        let pkg = m.clientPkgDir
        let logsBase = (pkg as NSString).appendingPathComponent("logs")
        let entry = FileManager.default.fileExists(atPath: (pkg as NSString).appendingPathComponent("dist/index.ts")) ? "dist" : "src"
        let logDir = ((pkg as NSString).appendingPathComponent(entry) as NSString).appendingPathComponent("logs")
        let target = FileManager.default.fileExists(atPath: logDir) ? logDir : logsBase
        NSWorkspace.shared.open(URL(fileURLWithPath: target))
      case "Start": m.start()
      case "Stop": m.stop()
      case "Restart": m.restart()
      case "Update Code": m.updateCode()
      case "Quit": NSApplication.shared.terminate(nil)
      default: break
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

// MARK: - app

@main
struct IdlefillApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
  @StateObject private var model = AppModel()

  var body: some Scene {
    MenuBarExtra {
      ContentView(m: model)
    } label: {
      Image(nsImage: MenuIcon.image(spinning: model.lease.1 > 0))
    }
    .menuBarExtraStyle(.window)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
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
