//
//  IdlefillDesktop.swift — the idlefill desktop app (macOS 14+).
//
//  A windowed companion (WindowGroup, NOT a MenuBarExtra) built with bare
//  swiftc (no Xcode project). Five tabs in one window:
//
//    state     — color-coded state word, this machine's status, queue depth,
//                today finished/failed, the running lease (polls /api/state
//                every 5s with the Bearer token)
//    sessions  — the interactive Hermes sessions the arbiter knows about
//                (the same /api/state poll's sessions[]): every row listed
//                with its state word (Paused > Active > Idle, the 30s/90s
//                windows), a stale tag on a lapsed heartbeat, and the
//                per-session gate (Pause / Resume →
//                POST /api/sessions/<token>/override). The desktop is the
//                INTERACTION surface for sessions (the menubar is
//                read-only, the dashboard is remote)
//    logs      — the client daemon log tail (client/<entry>/logs/client.log),
//                refreshed on a ~2.5s timer, last ~2000 lines kept, auto-scroll
//                to the tail while at the bottom, "follow tail" toggle to
//                resume after scrolling up
//    projects  — this client's project config (client/config.json):
//                client_name + server_url read-only, one editable row per
//                project (name, model, queue_file, estimated_seconds,
//                timeout_seconds; executor + cwd read-only). Save rewrites the
//                file preserving every other key (the token included) and the
//                0600 mode; a successful save shows a "daemon restart to apply"
//                note with a Restart affordance (the same launchd path the
//                Settings toggle uses).
//    settings  — opt-in launchd management of the two LaunchAgents (daemon +
//                menu bar) in the user's gui/<uid> domain; the toggles reflect
//                REAL launchctl state, re-checked on every poll
//
//  Deep links: the bundle registers the `idlefill://` URL scheme
//  (CFBundleURLTypes in the generated Info.plist). Hosts: "" or "open" →
//  State (the default), "logs" → Logs, "projects" → Projects; any unknown
//  host → State. A URL that launches the app opens on the requested tab; a
//  URL delivered to a RUNNING app activates it, brings the window forward,
//  and switches tabs. Parsing lives in the pure `AppModel.route(for:)` so it
//  is testable headlessly.
//
//  Design: quiet control room (DESIGN.md). Neutral canvas (#0d1117), hairline
//  dividers (#30363d), one mono family, four signal colors used ONLY for live
//  state (green idle, amber busy, blue working, red degraded).
//
//  The token is read at runtime from <repo>/client/config.json — it is never
//  baked into this file, the bundle, or the binary, never printed, and never
//  displayed in any view or written to any log line.
//

import AppKit
import SwiftUI
import Sparkle
import CryptoKit

// MARK: - build marker (issue #26)

// The marker baked into the binary at build time. desktop/build.sh
// substitutes the QUOTED placeholder literal (the declaration below — the
// only QUOTED occurrence of the placeholder in the file; the sentinel is
// fragmented so the build's sed can never touch it) with the build marker
// (IDLEFILL_DESKTOP_BUILD — default: the numeric IDLEFILL_VERSION, the
// CFBundleVersion) BEFORE compiling, so `Idlefill --version` prints the
// build it was baked with — an installed edge build proves its own origin
// (`edge-main-a9787a7`) instead of posing as a release. DO NOT RENAME OR
// DELETE: build.sh byte-verifies this exact declaration (a silent miss
// would bake the placeholder string into the binary).
let __DESKTOP_BUILD__ = "__DESKTOP_BUILD__"
/// The UNSUBSTITUTED marker (fragmented — the build's sed only touches the
/// quoted placeholder literal, so this comparison survives the injection).
let __DESKTOP_BUILD_UNSUBSTITUTED__ = "__DESKTOP_" + "BUILD__"

// MARK: - auto-update (Sparkle)

/** The appcast feed: a release ASSET on the Forgejo repo (public repo,
 *  ingress LAN-restricted — see README "Updating"). Gitea's release-download
 *  route is `/releases/download/{vTag}/{fileName}` (web.go — there is NO
 *  `/releases/latest/download/` route, that GitHub form 404s on Gitea), so
 *  the feed uses the `latest` pseudo-tag in the {vTag} slot. `latest`
 *  resolves against the LATEST release, which carries the whole current
 *  feed (appcast.xml + every zip it references). No auth — Sparkle does a
 *  plain HTTPS GET. */
let kSparkleFeedURL = "https://git.samwarth.com/sam/idlefill/releases/download/latest/appcast.xml"

/** Sparkle updater delegate: pins the feed URL at runtime (belt-and-
 *  suspenders with SUFeedURL in Info.plist) and surfaces errors in the
 *  Settings status line. Every method is @optional in the protocol; we
 *  implement only what the app needs. */
final class UpdaterDelegate: NSObject, SPUUpdaterDelegate {
  var onStatus: (String) -> Void = { _ in }

  // The appcast feed URL (belt-and-suspenders with SUFeedURL in Info.plist).
  // NOTE: the ObjC `feedURLStringForUpdater:` requirement is imported into
  // Swift as `feedURLString(for:)`.
  func feedURLString(for updater: SPUUpdater) -> String? {
    return kSparkleFeedURL
  }

  // "No update" has TWO overloads in the protocol. The no-error one fires on
  // a genuine up-to-date; the error-carrying one fires when the fetch/parse
  // failed (feed 404s while the repo is still private, malformed appcast, …).
  // Implementing both keeps the status line honest instead of collapsing
  // "up to date" and "couldn't reach the feed" into one string.
  func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
    onStatus("up to date")
  }

  func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: Error) {
    onStatus("no update found — " + error.localizedDescription)
  }

  func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
    onStatus("update available: v" + item.displayVersionString)
  }

  func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
    onStatus("update v\(item.displayVersionString) downloaded — Sparkle will install on relaunch")
  }

  func updater(_ updater: SPUUpdater, failedToDownloadUpdate item: SUAppcastItem, error: Error) {
    onStatus("download failed — " + error.localizedDescription)
  }

  func userDidCancelDownload(_ updater: SPUUpdater) {
    onStatus("download cancelled")
  }

  func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
    onStatus("update aborted — " + error.localizedDescription)
  }
}

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

/// The main window's tabs — and the deep-link target type.
enum MainTab: String, CaseIterable {
  case state, sessions, logs, projects, settings

  var title: String { rawValue.uppercased() }
}

// MARK: sessions (interactive Hermes sessions — the desktop is the gate)

/** The windows the dashboard uses (server/public/index.html
 *  SESSION_ONLINE_MS / SESSION_ACTIVE_MS) — kept honest to the dashboard:
 *  online = a heartbeat within 90s; active = online AND a request seen
 *  within 30s. Stale is NOT a state word: it is the dim + tag on a row
 *  whose heartbeat lapsed past the same 90s window. */
let kSessionOnlineMs: Double = 90_000
let kSessionActiveMs: Double = 30_000

/** One projected sessions-tab row. Produced ONLY by the pure
 *  `SessionsView.project` (never by the view), so the headless harness
 *  (desktop/sessions-test.sh) asserts the exact semantics the panel
 *  renders. Unlike the menubar's Exception-Only rule, the desktop lists
 *  EVERY session — it is the interaction surface; you need the healthy
 *  rows to pause them. */
struct SessionRow: Identifiable, Equatable {
  /// Identity + label: the token IS the session's identity (the /s/<token>
  /// path). The row shows a short prefix; the full token rides in the
  /// tooltip only (never a printed/logged surface).
  let token: String
  let shortToken: String
  let clientName: String?
  /// The state word: "Paused" | "Active" | "Idle" (the dashboard's
  /// priority: override pause > online + recent request > idle).
  let stateWord: String
  /// Heartbeat lapsed past 90s — a dim + "stale" tag, NOT a state word.
  let stale: Bool
  /// "last request …" text (the dashboard's ago() wording), or
  /// "no requests yet".
  let lastRequestText: String
  /// The engine this session routes to (shown as "→ server_id" when set).
  let serverId: String?
  /// True when the operator gate holds this session (override == pause).
  let paused: Bool
  /// The gate button's title: a paused row offers "Resume", a running
  /// row offers "Pause".
  let actionTitle: String

  var id: String { token }
}

enum SessionsView {
  /** PURE projection: /api/state payload (+ a fixed clock) → view rows.
   *  Mirrors the dashboard's sessStateWord/sessBlock semantics exactly.
   *  Rows with an empty/missing token are junk the projection drops (they
   *  can never be named or acted on). `nowMs` is epoch-ms, injectable so
   *  the harness runs on a fixed clock. */
  static func project(payload: [String: Any], nowMs: Double) -> [SessionRow] {
    let rows = (payload["sessions"] as? [[String: Any]]) ?? []
    return rows.compactMap { s in
      guard let tok = (s["token"] as? String), !tok.isEmpty else { return nil }
      let lastSeen = (s["last_seen"] as? Double) ?? 0
      let stale = nowMs - lastSeen >= kSessionOnlineMs
      let online = !stale
      let ov = (s["override"] as? [String: Any])?["override"] as? String
      let paused = ov == "pause"
      let lastActivity = (s["last_activity"] as? Double).flatMap { $0 == 0 ? nil : $0 }
      let stateWord: String
      if paused {
        stateWord = "Paused"
      } else if online, let la = lastActivity, nowMs - la < kSessionActiveMs {
        stateWord = "Active"
      } else {
        stateWord = "Idle"
      }
      let lastRequestText: String
      if let la = lastActivity {
        lastRequestText = "last request " + agoText(nowMs - la)
      } else {
        lastRequestText = "no requests yet"
      }
      let name = (s["client_name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
      let serverId = (s["server_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
      return SessionRow(
        token: tok,
        shortToken: String(tok.prefix(8)),
        clientName: name,
        stateWord: stateWord,
        stale: stale,
        lastRequestText: lastRequestText,
        serverId: serverId,
        paused: paused,
        actionTitle: paused ? "Resume" : "Pause"
      )
    }
  }

  /** The dashboard's ago() wording (server/public/index.html), ported:
   *  "45s ago" / "3m 12s ago" / "2h 5m ago". */
  static func agoText(_ ms: Double) -> String {
    let s = max(0, (ms / 1000).rounded())
    if s < 60 { return "\(Int(s))s ago" }
    let m = floor(s / 60)
    if m < 60 { return "\(Int(m))m \(Int(s.truncatingRemainder(dividingBy: 60)))s ago" }
    let h = floor(m / 60)
    return "\(Int(h))h \(Int(m.truncatingRemainder(dividingBy: 60)))m ago"
  }

  /** PURE request builder for the gate write — the single write site for
   *  sessions. `POST <serverURL>/api/sessions/<urlencoded token>/override`
   *  with body {"override":"pause"} (pause) or {"override":null} (resume),
   *  Authorization: Bearer <arbiter token>. The token parameter NEVER
   *  appears in the URL or the body — only in the header — and nothing
   *  here logs any of it. Pure (no networking) so the harness asserts the
   *  exact wire shape. */
  static func overrideRequest(serverURL: String, sessionToken: String,
                              paused: Bool, arbiterToken: String) -> URLRequest {
    // Percent-encode the session token for the path segment (RFC 3986
    // unreserved set — the same discipline as the dashboard's
    // encodeURIComponent).
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    let enc = sessionToken.addingPercentEncoding(withAllowedCharacters: allowed) ?? sessionToken
    var req = URLRequest(url: URL(string: serverURL + "/api/sessions/" + enc + "/override")!)
    req.httpMethod = "POST"
    req.timeoutInterval = 5
    req.setValue("Bearer \(arbiterToken)", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.httpBody = try! JSONSerialization.data(withJSONObject:
      ["override": (paused ? "pause" : (NSNull())) as Any])
    return req
  }
}

// MARK: - model

struct LogLine: Identifiable, Equatable {
  let id: Int
  let text: String
}

final class AppModel: ObservableObject {
  // active tab (the tab strip binds to it; deep links set it)
  @Published var activeTab: MainTab = .state

  // state panel
  @Published var conn: Conn = .off
  @Published var daemonRunning = false
  @Published var queueDepth = 0
  @Published var today: (finished: Int, failed: Int) = (0, 0)
  @Published var lease: (job: String, expiresAt: Double) = ("", 0)
  @Published var lastSeenS: Int? = nil

  // sessions tab (the same /api/state poll carries sessions[])
  @Published var sessions: [SessionRow] = []
  /** Tokens whose gate write is in flight — the button is disabled
   *  PER-ROW (not globally) while its own request runs. */
  @Published var pendingSessionTokens: Set<String> = []
  /** One-line error under the tab's rows (a failed override; cleared on
   *  the next successful write or poll that proves the state). */
  @Published var sessionsNote: String? = nil

  // log viewer (stable ids — trimming the head must not re-identify rows)
  @Published var logLines: [LogLine] = []
  @Published var logPath: String = ""
  @Published var followTail = true

  // projects (this client's config.json)
  @Published var projClientName: String = ""
  @Published var projServerURL: String = ""
  @Published var projRows: [ProjectRow] = []
  @Published var projNote: String? = nil
  @Published var projSavedPendingRestart = false

  // settings
  @Published var repoPath: String = ""
  @Published var daemonLoaded = false
  @Published var menubarLoaded = false
  @Published var daemonNote: String? = nil
  @Published var menubarNote: String? = nil
  /** Issue #23: the executable each loaded agent ACTUALLY runs (the
   *  LOADED service's ProgramArguments.0 from `launchctl print` — not the
   *  on-disk plist). nil while the label is not loaded. The Settings rows
   *  show these so a stale agent is distinguishable from a healthy one. */
  @Published var daemonRuns: String? = nil
  @Published var menubarRuns: String? = nil
  /** Exception-Only (DESIGN.md): true ONLY when the loaded menubar agent
   *  runs a DIFFERENT executable than this checkout's built bundle. No
   *  mark when healthy; clears after a successful re-point (the state is
   *  re-read from real launchd on every poll). */
  @Published var menubarStale = false

  // auto-update (Sparkle + the edge channel)
  @Published var updateStatus: String? = nil
  @Published var updateChecking = false
  private var updaterController: SPUStandardUpdaterController?
  private let updaterDelegate = UpdaterDelegate()
  /** The update channel (issue #26): "releases" (the default — today's
   *  Sparkle flow, byte-identical) or "branch" (the branch channel: the
   *  tracked branch's latest published build). Persisted in the app
   *  config alongside `repo_path`. */
  @Published var updateChannel: String = "releases"
  /** The branch the BRANCH channel tracks (default "main"). */
  @Published var updateBranch: String = "main"
  /** The DEVELOPMENT PIN (the branch channel's pinning extension): a
   *  commit SHA (7–40 hex). Set while the branch channel is selected, the
   *  check targets `edge-<branch>-<sha7(pin)>` (the pinned commit's edge
   *  build) instead of the branch's TIP: pinned marker == this build's
   *  marker -> up to date; a different pinned marker is offered IFF its
   *  edge release exists (`GET …/releases/tags/<marker>` — the per-commit
   *  tag edge.yml publishes on push, or `scripts/edge-release.sh` on
   *  demand); a missing pin offers nothing (publish the build, re-check).
   *  Malformed/empty = absent -> today's tip-following behavior.
   *  Persisted in the app config alongside `update_channel`. */
  @Published var updatePin: String = ""
  /** An edge build is awaiting the operator's confirm (set by the branch
   *  check; cleared on confirm / channel change / re-check). */
  @Published var edgePending: Bool = false
  /** The download's byte progress (0...1) while an edge update downloads;
   *  nil = no determinate progress (idle, or a phase with no byte count —
   *  the UI shows a spinner then). Driven by a poll of the URLSessionTask's
   *  own progress while the zip downloads. */
  @Published var updateProgress: Double? = nil
  /** The pin field's visibility (Settings): the field is exception-only —
   *  it renders when a pin is SET or the operator opened it with "pin".
   *  The old layout showed channel + branch + pin simultaneously. */
  @Published var showPinField: Bool = false
  /** The branch field's visibility (Settings): same exception rule as the
   *  pin — renders when the tracked branch is NOT the default or the
   *  operator opened it with "branch". */
  @Published var showBranchField: Bool = false
  /** The check watchdog (seconds): a check that never reports back (a
   *  hung task, a silent delegate miss) must not leave the UI stuck on
   *  "checking…" forever — the 2026-10-01 incident froze the row on
   *  "installing … the app will quit and relaunch" while the old process
   *  outlived the swap. Injectable for the headless harness. */
  var checkWatchdog: TimeInterval = 60
  private var watchdogToken = 0
  /** The last moment a download's byte counter advanced — the watchdog
   *  re-arms (instead of standing down) while a download is ALIVE: the
   *  timeout is for a HUNG check, not a slow network. */
  private var lastProgressAt = Date.distantPast

  private(set) var repoRoot: String = AppModel.findRepoRoot()

  private var logOffset: UInt64 = 0
  private var logSeq = 0
  private let maxLogLines = 2000
  private let uid = getuid()

  init() {
    loadConfig()
    refreshLaunchdState()
    loadProjects()
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

  // MARK: auto-update (Sparkle)

  /** Lazily build the Sparkle controller on the FIRST "Check for Updates…"
   *  tap (never at launch — the Settings panel must work before any update
   *  plumbing exists, and a headless build/test must not start an updater).
   *  The controller's `updaterDelegate` is weak, so we hold it. The updater
   *  targets the app's own main bundle (the running bundle). */
  private func ensureUpdaterController() {
    guard updaterController == nil else { return }
    updaterDelegate.onStatus = { [weak self] msg in
      DispatchQueue.main.async {
        self?.updateStatus = msg
        self?.updateChecking = false
      }
    }
    updaterController = SPUStandardUpdaterController(
      updaterDelegate: updaterDelegate,
      userDriverDelegate: nil
    )
  }

  /** Kick off a manual update check, routed on the channel (issue #26):
   *  `releases` → the existing Sparkle flow, byte-identical (Sparkle's
   *  standard UI shows the progress dialog; the status line here mirrors
   *  the delegate callbacks — checking → up-to-date / update available /
   *  download + install). `branch` → the branch check below. */
  func checkForUpdates() {
    if updateChannel == "branch" {
      checkBranchUpdates()
      return
    }
    ensureUpdaterController()
    guard let c = updaterController else { return }
    updateStatus = "checking for updates…"
    updateChecking = true
    armWatchdog()
    c.checkForUpdates(nil)
  }

  /** Arm the check watchdog: if a check is STILL running after
   *  `checkWatchdog` seconds, stand the UI down with an actionable status
   *  instead of leaving "checking…"/"installing…" frozen forever (the
   *  2026-10-01 incident). Token-guarded: a newer check invalidates an
   *  older timer, and a completed check (updateChecking == false) makes a
   *  firing timer a no-op — no explicit disarm needed on the happy paths.
   *  Returns the token: a check's network completion must match it
   *  (watchdogToken) before touching state — when the watchdog FIRES it
   *  bumps the token, so the hung fetch's own late timeout (URLSession
   *  restores its captured prevStatus at ~10s) can never stomp the
   *  "timed out" row or a newer check's status. */
  @discardableResult
  private func armWatchdog() -> Int {
    watchdogToken += 1
    let token = watchdogToken
    DispatchQueue.main.asyncAfter(deadline: .now() + checkWatchdog) { [weak self] in
      self?.watchdogFire(token: token)
    }
    return token
  }

  /** The watchdog's firing body (a method, not a self-capturing closure —
   *  the re-arm recursion would otherwise cycle on its own capture). */
  private func watchdogFire(token: Int) {
    guard watchdogToken == token, updateChecking else { return }
    // A download whose byte counter advanced inside the window is ALIVE
    // (a slow network, not a hung check) — re-check later WITHOUT
    // bumping the token (the in-flight completion still owns the state).
    if updateProgress != nil,
       Date().timeIntervalSince(lastProgressAt) < checkWatchdog {
      DispatchQueue.main.asyncAfter(deadline: .now() + checkWatchdog) { [weak self] in
        self?.watchdogFire(token: token)
      }
      return
    }
    watchdogToken += 1 // invalidate this check's own late completion
    updateChecking = false
    updateProgress = nil
    edgePending = false
    updateStatus = "update check timed out — try again"
  }

  // MARK: update channel — branch (edge) channel (issue #26)

  /** The update-check base for the branch channel: `IDLEFILL_UPDATE_BASE`
   *  (the same test hook the menubar's check uses — the headless harness
   *  points it at a local stub of the refs API), defaulting to the host
   *  that `kSparkleFeedURL` derives from (parse the feed URL's HOST —
   *  the feed URL is `<host>/sam/idlefill/releases/download/…`, so the
   *  check base is `<scheme>://<host>`, the same host the feed lives on).
   *  The check is ANONYMOUS (the repo is public) and never sends the
   *  arbiter token. */
  static func updateBase() -> String {
    if let raw = ProcessInfo.processInfo.environment["IDLEFILL_UPDATE_BASE"] {
      var base = raw
      while base.hasSuffix("/") { base.removeLast() }
      return base
    }
    if let u = URL(string: kSparkleFeedURL), let host = u.host {
      return "https://" + host
    }
    return "https://git.samwarth.com"
  }

  /** Pure: the BRANCH-channel update verdict (the desktop's copy of the
   *  menubar's `UpdateCheck.branchUpdateMarker` — the logic is tiny and
   *  both apps are bare-swiftc single files, so each carries its own; a
   *  shared file would need a shared build step neither has).
   *
   *  Given the refs-API payload (verified live: `GET …/git/refs/heads/<b>`
   *  → 200 `[{ref, url, object:{type:"commit", sha}}]`; unknown branch →
   *  404 JSON) + the baked marker, an update is available ⇔ the baked
   *  marker DIFFERS from the tip's marker — no ordering on branch builds:
   *  a newer push is a different marker, and the difference IS the
   *  update (equal markers → up to date → nil). The branch name is read
   *  from the payload's own `ref` (the source of truth — a config
   *  switched to a different branch sees the new branch's tip on the
   *  next check). Any failure (nil payload, malformed, 404 JSON,
   *  malformed sha) → nil: fail quiet, nothing set, next check retries. */
  static func branchUpdateMarker(data: Data?, localMarker: String) -> String? {
    guard let data,
          let o = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]],
          let first = o.first,
          let ref = first["ref"] as? String,
          ref.hasPrefix("refs/heads/"),
          let obj = first["object"] as? [String: Any],
          (obj["type"] as? String) == "commit",
          let sha = obj["sha"] as? String,
          sha.count == 40, sha.allSatisfy(\.isHexDigit) else {
      return nil
    }
    // The branch name is the ref's own tail (the source of truth — the
    // prefix was just verified).
    let branch = String(ref.dropFirst("refs/heads/".count))
    guard !branch.isEmpty else { return nil }
    let tip = "edge-\(branch)-\(String(sha.prefix(7)))"
    return tip == localMarker ? nil : tip
  }

  /** The DEVELOPMENT PIN (the branch channel's pinning extension): a pin
   *  value is a commit SHA — its first 7–40 hex chars (the marker uses
   *  the sha7; a full 40-hex sha pins the same marker as its own
   *  prefix). Anything else = malformed = ABSENT (the check falls back
   *  to tip-following). (The desktop's copy of the menubar's
   *  `UpdateCheck.isPinSha` — same logic, the single-file convention.) */
  static func isPinSha(_ s: String) -> Bool {
    (7...40).contains(s.count) && s.allSatisfy(\.isHexDigit)
  }

  /** Pure (the pinning check, given a pinned marker + the availability
   *  probe's verdict): the pin's OFFER — the pinned marker iff it
   *  DIFFERS from this build's marker AND its edge release exists;
   *  otherwise nil (up to date, or the pin was never published — the
   *  operator publishes the build via `scripts/edge-release.sh` and
   *  re-checks). (The desktop's copy of the menubar's
   *  `UpdateCheck.pinUpdateMarker`.) */
  static func pinUpdateMarker(pinMarker: String, localMarker: String, exists: Bool) -> String? {
    guard pinMarker != localMarker else { return nil }
    return exists ? pinMarker : nil
  }

  /** The PIN's edge marker, from the tracked branch + the pin's sha:
   *  `edge-<branch>-<sha7>` — the first 7 chars of the pin (a full 40-hex
   *  sha pins the same marker as its own prefix; the marker IS the
   *  per-commit edge release's TAG the probe checks + the zip's name). */
  static func pinnedMarker(branch: String, pin: String) -> String {
    "edge-\(branch)-\(String(pin.prefix(7)))"
  }

  /** The baked build marker (the build identity — `--version` prints it).
   *  Release builds carry the numeric version (the CFBundleVersion); edge
   *  builds carry the edge marker. An un-substituted build reports the
   *  default `1.0` (the build.sh default), never the literal placeholder. */
  var bakedMarker: String {
    if __DESKTOP_BUILD__ != __DESKTOP_BUILD_UNSUBSTITUTED__,
       !__DESKTOP_BUILD__.trimmingCharacters(in: .whitespaces).isEmpty {
      return __DESKTOP_BUILD__
    }
    return "1.0"
  }

  /** The BRANCH-channel check: GET the tracked branch's tip via the refs
   *  API (anonymous, `IDLEFILL_UPDATE_BASE`-overridable), compare the
   *  tip's marker against this build's marker. An available update sets
   *  `edgePending` (the Settings row turns into the confirm control);
   *  the status line names the tip marker. A 404 (the branch does not
   *  exist — a typo'd branch name) says so in the status line (operator-
   *  actionable, distinct from the offline-tolerant silence of a fetch
   *  failure). OFFLINE-TOLERANT (the automatic check's contract): a DEAD
   *  network (no response) or an unparseable body (a 5xx, a non-refs
   *  payload) sets nothing new — the previous status is RESTORED (the
   *  "checking …" narration was set at the start of this check and must
   *  not outlive it as a permanent row) and the next check retries.
   *  "up to date" is reserved for a genuine refs response whose tip
   *  equals this build's marker. A REFUSED install keeps the current
   *  bundle and says so in the status line (the same contract as the
   *  menubar's sha256 gate). */
  func checkBranchUpdates() {
    let branch = updateBranch.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !branch.isEmpty else {
      updateStatus = "set a branch name for the branch channel"
      return
    }
    // The DEVELOPMENT PIN (the branch channel's pinning extension): a
    // valid `updatePin` retargets the check from the branch's TIP to the
    // PINNED commit's edge marker — no refs fetch (a pin cannot move; the
    // marker IS the sha). The one network fact is the pinned edge
    // release's EXISTENCE (`GET …/releases/tags/<marker>` — the per-commit
    // tag edge.yml publishes on push, or `scripts/edge-release.sh` on
    // demand), probed with the RAW status codes (unlike the refs fetch
    // above, a genuine 404 here is OPERATOR-ACTIONABLE: "pin not
    // published — publish it", distinct from the offline-tolerant
    // silence of a dead fetch).
    let pin = updatePin.trimmingCharacters(in: .whitespacesAndNewlines)
    if AppModel.isPinSha(pin) {
      checkPinnedBuild(branch: branch, pin: pin)
      return
    }
    // The status to RESTORE when a check that already started fails
    // offline — the "checking …" narration set below must not outlive a
    // dead fetch as a permanent row, and a failed fetch must not be
    // mistaken for "up to date".
    let prevStatus = updateStatus
    updateStatus = "checking \(branch) for a new build…"
    updateChecking = true
    let token = armWatchdog()
    let base = AppModel.updateBase()
    let branchEnc = branch.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? branch
    guard let url = URL(string: "\(base)/api/v1/repos/sam/idlefill/git/refs/heads/\(branchEnc)") else {
      updateChecking = false
      updateStatus = prevStatus
      return
    }
    var req = URLRequest(url: url)
    req.timeoutInterval = 10
    URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
      guard let self else { return }
      DispatchQueue.main.async {
        // A watchdog stand-down or a newer check invalidated this one —
        // its late completion must not stomp the newer state.
        guard self.watchdogToken == token else { return }
        self.updateChecking = false
        // OFFLINE-TOLERANT: only a GENUINE refs response (2xx) or a
        // genuine 404 (the branch does not exist) changes the status line.
        // Any other outcome — no HTTP response at all (the network is
        // down), a 5xx, a non-refs payload — sets nothing new: the
        // previous status is restored, no error row, the next check
        // retries.
        guard let e = resp as? HTTPURLResponse else {
          self.edgePending = false
          self.updateStatus = prevStatus
          return
        }
        if e.statusCode == 404 {
          // The branch does not exist (a typo'd branch name) — the refs
          // API answers 404. A distinct, operator-actionable note (NOT
          // the offline-tolerant silence: the fetch succeeded).
          self.edgePending = false
          self.updateStatus = "branch \(branch) not found — check the name"
          return
        }
        guard (200..<300).contains(e.statusCode), let data else {
          self.edgePending = false
          self.updateStatus = prevStatus
          return
        }
        // A genuine 2xx payload: is it a WELL-FORMED refs response?
        // `branchUpdateMarker` returns nil for BOTH "the tip equals this
        // build's marker" (up to date) AND "the payload is not a refs
        // payload" (a fetch that answered but did not answer) — the shape
        // check separates the "up to date" verdict from a failure.
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]],
              let first = o.first,
              let ref = first["ref"] as? String, ref.hasPrefix("refs/heads/"),
              let obj = first["object"] as? [String: Any],
              (obj["type"] as? String) == "commit",
              let sha = obj["sha"] as? String,
              sha.count == 40, sha.allSatisfy(\.isHexDigit) else {
          self.edgePending = false
          self.updateStatus = prevStatus
          return
        }
        let tip = AppModel.branchUpdateMarker(data: data, localMarker: self.bakedMarker)
        if let tip {
          self.edgePending = true
          self.updateStatus = "new build \(tip) on \(branch) — confirm to install"
        } else {
          // The tip equals this build's marker (up to date) — the marker
          // is named so the operator sees WHICH build this is.
          self.edgePending = false
          self.updateStatus = "up to date (\(self.bakedMarker))"
        }
      }
    }.resume()
  }

  /** The PINNED-build check (the branch channel's pinning extension, the
   *  real fetch path): probe `GET …/releases/tags/<pinned marker>` with
   *  the RAW status codes — a genuine 2xx = the pinned build is
   *  published (offer it, except when this build already IS it: up to
   *  date, the marker named so the operator sees WHICH build this is);
   *  a genuine 404 = the tag was never published (or cleaned) — an
   *  operator-actionable note that names the exact publish command
   *  (`scripts/edge-release.sh` with the marker + the pin's sha); any
   *  other outcome (no HTTP response — the network is down — a 5xx) =
   *  offline-tolerant: the previous status is RESTORED, nothing
   *  pending, the next check retries. A REFUSED install (the sha256
   *  gate) keeps the current bundle and says so — the same contract as
   *  the tip check. */
  func checkPinnedBuild(branch: String, pin: String) {
    let marker = AppModel.pinnedMarker(branch: branch, pin: pin)
    let prevStatus = updateStatus
    updateStatus = "checking the pinned build \(marker)…"
    updateChecking = true
    let token = armWatchdog()
    let base = AppModel.updateBase()
    let tagEnc = marker.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? marker
    guard let url = URL(string: "\(base)/api/v1/repos/sam/idlefill/releases/tags/\(tagEnc)") else {
      updateChecking = false
      updateStatus = prevStatus
      return
    }
    var req = URLRequest(url: url)
    req.timeoutInterval = 10
    URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
      guard let self else { return }
      DispatchQueue.main.async {
        // A watchdog stand-down or a newer check invalidated this one.
        guard self.watchdogToken == token else { return }
        self.updateChecking = false
        guard let e = resp as? HTTPURLResponse else {
          // No HTTP response at all — the network is down. The previous
          // status is restored (fail quiet; a dead fetch must not read
          // "up to date" and must not read "not published").
          self.edgePending = false
          self.updateStatus = prevStatus
          return
        }
        if e.statusCode == 404 {
          // The tag was never published (or was cleaned) — a DISTINCT,
          // operator-actionable note (the fetch succeeded): name the
          // exact publish command (the marker + the pin's sha — the
          // script validates that the tag ends in the sha's sha7).
          self.edgePending = false
          self.updateStatus = "pin \(marker) not published — publish it: scripts/edge-release.sh \(marker) \(pin)"
          return
        }
        guard (200..<300).contains(e.statusCode) else {
          // A non-2xx/404 (a 5xx, a rate limit) — the probe failed: the
          // previous status is restored, the next check retries.
          self.edgePending = false
          self.updateStatus = prevStatus
          return
        }
        let offer = AppModel.pinUpdateMarker(pinMarker: marker, localMarker: self.bakedMarker, exists: true)
        if let offer {
          self.edgePending = true
          self.updateStatus = "pinned build \(offer) — confirm to install"
        } else {
          // The pinned marker equals this build's marker — up to date;
          // the marker is named so the operator sees WHICH build this is.
          self.edgePending = false
          self.updateStatus = "up to date (\(self.bakedMarker))"
        }
      }
    }.resume()
  }

  /** Confirm control (branch channel): install the build the check
   *  offered. TIP mode (no pin): re-fetch the tip at confirm time
   *  (the check may be stale — a newer push since the check would have
   *  a different marker). PIN mode: the pinned marker is FINAL (a pin
   *  cannot move) — the offered marker is re-derived and installed
   *  directly, no re-fetch (re-probing could only return the same
   *  verdict; the install's own download 404s fail closed). Then,
   *  either mode: download the DESKTOP zip + sidecar for it, verify
   *  sha256 BEFORE any swap (a mismatch or missing sidecar refuses —
   *  the current bundle is kept and the status line says so), then swap
   *  the installed bundle in the `desktop/update.sh` sequence (unzip →
   *  quit the running app cleanly → replace → relaunch), driven from a
   *  DETACHED helper: the app is the GUI and must not kill its own
   *  process tree from inside itself. The status line narrates each
   *  phase the way `updateStatus` does today. */
  func confirmEdgeInstall() {
    let branch = updateBranch.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !branch.isEmpty else { return }
    updateStatus = "downloading the new build…"
    updateChecking = true
    let token = armWatchdog()
    let base = AppModel.updateBase()
    // PIN mode: the pinned marker is final (no re-fetch — a pin cannot
    // move; the check's verdict stands). TIP mode: re-fetch the tip
    // (it may have moved since the check).
    let pin = updatePin.trimmingCharacters(in: .whitespacesAndNewlines)
    if AppModel.isPinSha(pin) {
      installEdge(marker: AppModel.pinnedMarker(branch: branch, pin: pin), token: token)
      return
    }
    let branchEnc = branch.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? branch
    guard let url = URL(string: "\(base)/api/v1/repos/sam/idlefill/git/refs/heads/\(branchEnc)") else {
      updateChecking = false
      return
    }
    var req = URLRequest(url: url)
    req.timeoutInterval = 10
    URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
      guard let self else { return }
      DispatchQueue.main.async {
        guard self.watchdogToken == token else { return }
        guard let tip = AppModel.branchUpdateMarker(data: data, localMarker: self.bakedMarker) else {
          self.updateChecking = false
          self.edgePending = false
          self.updateStatus = "up to date (\(self.bakedMarker))"
          return
        }
        self.installEdge(marker: tip, token: token)
      }
    }.resume()
  }

  /** The download + verify (branch channel; main thread, status-line
   *  narration): the zip + sidecar for the tip's marker, sha256 verified
   *  BEFORE any swap (the menubar's Phase-1 contract, CryptoKit — a
   *  mismatch / missing / malformed sidecar refuses and keeps the current
   *  bundle). Then the swap in a detached helper (below). */
  private func installEdge(marker: String, token: Int) {
    let zipName = "Idlefill \(marker).zip"
    let tagEnc = marker.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? marker
    let dlBase = AppModel.updateBase() + "/sam/idlefill/releases/download/\(tagEnc)"
    let tmpDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("idlefill-desktop-edge-\(getpid())").path
    let fm = FileManager.default
    try? fm.createDirectory(atPath: tmpDir, withIntermediateDirectories: true)
    let zipDest = tmpDir + "/" + zipName
    let sidecarDest = zipDest + ".sha256"
    let dl = { (suffix: String, dest: String, track: Bool, done: @escaping (Bool) -> Void) in
      let enc = suffix.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? suffix
      guard let url = URL(string: "\(dlBase)/\(enc)") else { done(false); return }
      // The progress bar's feed (the zip only — the sidecar is a few
      // bytes): poll the task's own byte counters every 0.25s; expected
      // <= 0 (no Content-Length) keeps the bar indeterminate (nil). The
      // poll dies in the completion handler, before done() runs.
      var poll: Timer? = nil
      let task = URLSession.shared.downloadTask(with: url) { tmp, _, _ in
        // The completion runs on the URLSession delegate queue — the
        // timer lives on the MAIN runloop; invalidate where it lives
        // (Timer is not thread-safe), ahead of done()'s own main-queue
        // hop so no stale fraction lands after the caller clears it.
        if let poll { DispatchQueue.main.async { poll.invalidate() } }
        guard let tmp = tmp else { done(false); return }
        do {
          if fm.fileExists(atPath: dest) { try fm.removeItem(atPath: dest) }
          try fm.moveItem(at: tmp, to: URL(fileURLWithPath: dest))
          done(true)
        } catch { done(false) }
      }
      if track {
        poll = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak task] _ in
          guard let task else { return }
          let exp = task.countOfBytesExpectedToReceive
          let got = task.countOfBytesReceived
          if exp > 0 {
            DispatchQueue.main.async {
              self.lastProgressAt = Date()
              self.updateProgress = Double(got) / Double(exp)
            }
          }
        }
      }
      task.resume()
    }
    dl(zipName, zipDest, true) { [weak self] ok in
      guard let self else { return }
      DispatchQueue.main.async {
        // The watchdog stood this install down (a dead download) — the
        // late completion must not resurrect it or stomp the "timed out"
        // row / a newer check.
        guard self.watchdogToken == token else { return }
        self.updateProgress = nil
        guard ok else {
          self.updateChecking = false
          self.edgePending = false
          self.updateStatus = "download failed — \(marker) was NOT installed"
          return
        }
        self.updateStatus = "downloading the hash…"
        dl(zipName + ".sha256", sidecarDest, false) { [weak self] ok in
          guard let self else { return }
          DispatchQueue.main.async {
            guard self.watchdogToken == token else { return }
            guard ok,
                  let zipData = try? Data(contentsOf: URL(fileURLWithPath: zipDest)),
                  let sideData = try? Data(contentsOf: URL(fileURLWithPath: sidecarDest)) else {
              self.updateChecking = false
              self.updateStatus = "sha256 sidecar missing — \(marker) was NOT installed (the current build was kept)"
              self.edgePending = false
              return
            }
            let text = (String(data: sideData, encoding: .utf8) ?? "")
              .trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.count == 64, text.allSatisfy(\.isHexDigit) else {
              self.updateChecking = false
              self.updateStatus = "sha256 sidecar malformed — \(marker) was NOT installed (the current build was kept)"
              self.edgePending = false
              return
            }
            let hash = SHA256.hash(data: zipData).compactMap { String(format: "%02x", $0) }.joined()
            guard hash == text.lowercased() else {
              self.updateChecking = false
              self.updateStatus = "sha256 mismatch — the downloaded artifact does not match the published hash; the current build was kept"
              self.edgePending = false
              return
            }
            self.runEdgeSwap(zip: zipDest, marker: marker)
          }
        }
      }
    }
  }

  /** The swap, in a DETACHED helper — the `desktop/update.sh` sequence
   *  with the build step replaced by the downloaded zip: unzip → quit the
   *  running app (clean SIGTERM; the app holds no leases) → replace the
   *  installed bundle → relaunch. The helper is a plain `bash` process
   *  whose stdio points at null (NOT a Pipe — a Process with a Pipe
   *  deadlocks past the 64 KB buffer) and is NOT waited on: the helper
   *  reparents to launchd when this app exits (it may kill THIS app as
   *  part of the swap — it must outlive it).
   *
   *  The quit step matches the TARGET bundle, not just the process name
   *  (a bare `pkill -x Idlefill` would also kill an Idlefill running
   *  from a different checkout — the repo's daemon-identity rule: never
   *  match on a name that other processes share; a `ps` parse over the
   *  name-matched PIDs, keeping only the one whose executable lives in
   *  the target bundle). Test hooks (the IDLEFILL_DESKTOP_TEST
   *  pattern): `IDLEFILL_DESKTOP_EDGE_TARGET` re-points the target (the
   *  harness swaps a scratch bundle — never /Applications), and
   *  `IDLEFILL_DESKTOP_EDGE_NO_OPEN` skips the relaunch (a headless run
   *  must not spawn a GUI app). Both inert in production (unset). */
  private func runEdgeSwap(zip: String, marker: String) {
    let target = ProcessInfo.processInfo.environment["IDLEFILL_DESKTOP_EDGE_TARGET"]
      ?? "/Applications/Idlefill.app"
    let noOpen = ProcessInfo.processInfo.environment["IDLEFILL_DESKTOP_EDGE_NO_OPEN"] != nil
    // The relaunch line (the LAST line of the script): the real `open` in
    // production, a no-op for a headless test run (the env hook — the
    // script shape stays identical either way, so the swap logic is the
    // one thing that gets verified).
    let openLine = noOpen ? ": # headless run — no relaunch" : "open \"$TARGET\""
    // The quit handshake (the 2026-10-01 fix): the old script fired a
    // blind `kill -TERM` and moved on after 5s — when the TERM did not
    // take, the swap replaced the bundle UNDER the still-running old
    // process, `open` re-activated that stale instance, and the status
    // line froze on "installing … the app will quit and relaunch"
    // forever (the update had actually landed). Now: the script signals
    // READY after unzipping, the APP quits itself when it sees READY
    // (a GUI app terminating itself is the reliable quit), and the
    // script waits on the pid with TERM→KILL escalation before swapping.
    let tmpBase = FileManager.default.temporaryDirectory
      .appendingPathComponent("idlefill-edge-swap-\(getpid())")
    let readyFile = tmpBase.path + ".ready"
    // Self-quit is the production path (the READY handshake). The
    // headless harness normally disables it (its driver must live to
    // assert the swap); IDLEFILL_DESKTOP_EDGE_SELFQUIT re-enables JUST
    // the handshake while NO_OPEN still suppresses the relaunch — the
    // --selfquit harness case proves the app quits itself and the
    // script's TERM→KILL escalation never has to fire.
    let selfQuit = noOpen
      ? ProcessInfo.processInfo.environment["IDLEFILL_DESKTOP_EDGE_SELFQUIT"] != nil
      : true
    let script = """
      set -euo pipefail
      T=$(mktemp -d)
      unzip -q -d "$T" "\(zip)"
      [ -d "$T/Idlefill.app" ] || { echo "zip root is not the Idlefill.app bundle"; exit 1; }
      touch "$READY"
      # Wait for the old app to die: its own quit (the READY handshake) is
      # the fast path; TERM then KILL escalate so the swap NEVER lands
      # under a live old process. SELF_PID is only set on the self-quit
      # path (production); the headless harness has no pid to wait on.
      if [ -n "${SELF_PID:-}" ]; then
        for i in $(seq 1 40); do kill -0 "$SELF_PID" 2>/dev/null || break; sleep 0.25; done
        kill -TERM "$SELF_PID" 2>/dev/null || true
        for i in $(seq 1 20); do kill -0 "$SELF_PID" 2>/dev/null || break; sleep 0.25; done
        kill -KILL "$SELF_PID" 2>/dev/null || true
      fi
      # Any OTHER Idlefill running from the target bundle (a second
      # instance the handshake cannot know about) — same identity rule
      # as before: match the TARGET bundle, never a bare name.
      for pid in $(pgrep -x Idlefill 2>/dev/null || true); do
        exe=$(ps -p "$pid" -o comm= 2>/dev/null || true)
        case "$exe" in
          "$TARGET"/*) kill -TERM "$pid" 2>/dev/null || true ;;
        esac
      done
      for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -x Idlefill >/dev/null 2>&1 || break; sleep 0.5; done
      mkdir -p "$(dirname "$TARGET")"
      rm -rf "$TARGET.new"
      mv "$T/Idlefill.app" "$TARGET.new"
      rm -rf "$TARGET"
      mv "$TARGET.new" "$TARGET"
      rm -rf "$T"
      rm -f "$READY"
      \(openLine)
      """
    let scriptPath = tmpBase.path + ".sh"
    guard (try? script.write(toFile: scriptPath, atomically: true, encoding: .utf8)) != nil else {
      updateStatus = "could not write the install script — \(marker) was NOT installed (the current build was kept)"
      return
    }
    try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: scriptPath)
    try? FileManager.default.removeItem(atPath: readyFile)
    updateStatus = "installing \(marker) — the app will quit and relaunch"
    // Stay in the checking state through the swap: if the helper dies
    // before the handshake (an unzip failure), the watchdog stands the
    // UI down instead of freezing on "installing…" (the incident's
    // symptom). The app normally exits long before the watchdog fires.
    updateChecking = true
    armWatchdog()
    edgePending = false
    let helper = Process()
    helper.executableURL = URL(fileURLWithPath: "/bin/bash")
    // The helper's env carries the TARGET (the script's $TARGET) and the
    // READY handshake file; the test hooks are read by the APP (above),
    // not the script, so only the target crosses. sleep 0.5: let this
    // process's main thread reach run() before the script starts; stdio
    // to null (a Pipe would deadlock the helper if it ever wrote past
    // the 64 KB buffer).
    var env = ProcessInfo.processInfo.environment
    env["TARGET"] = target
    env["READY"] = readyFile
    if selfQuit { env["SELF_PID"] = String(getpid()) } else { env.removeValue(forKey: "SELF_PID") }
    helper.environment = env
    helper.arguments = ["-c", "sleep 0.5; bash '\(scriptPath)' >/dev/null 2>&1; rm -f '\(scriptPath)'"]
    helper.standardOutput = FileHandle.nullDevice
    helper.standardError = FileHandle.nullDevice
    do {
      try helper.run()
      // Deliberately NOT waited on — the helper outlives this app (it
      // must survive the quit step to finish the swap).
    } catch {
      updateChecking = false
      updateStatus = "could not start the install helper — \(marker) was NOT installed (the current build was kept)"
      return
    }
    // The self-quit: poll for READY (the script unzipped + verified the
    // bundle), then terminate cleanly so the swap replaces a dead
    // bundle. Production only (the headless harness's driver must live
    // to assert the swap).
    if selfQuit {
      Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { timer in
        if FileManager.default.fileExists(atPath: readyFile) {
          timer.invalidate()
          // NSApplication.shared, not NSApp: the headless harness driver
          // has no AppKit lifecycle (NSApp would be nil → crash); in the
          // real app `shared` IS the running instance.
          NSApplication.shared.terminate(nil)
        }
      }
    }
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
    // Test hook (the IDLEFILL_DESKTOP_TEST pattern — the menubar's
    // IDLEFILL_CONFIG_FILE equivalent): a headless harness re-points the
    // config file. This is NOT optional comfort — a GUI app (AppKit)
    // IGNORES the HOME environment: NSHomeDirectory() resolves to the
    // user's real home even under `env -i HOME=<scratch>` (AppKit resets
    // it from the account DB), so without this hook a harness "scratch
    // config" would silently READ AND WRITE the user's real config file.
    if let raw = ProcessInfo.processInfo.environment["IDLEFILL_DESKTOP_CONFIG"], !raw.isEmpty {
      return raw
    }
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
    // The update channel + branch (issue #26) — same read discipline as
    // repo_path (empty/absent = the default). A malformed channel value
    // (anything but the two known names) falls back to "releases": a
    // hand-edited config must never point the check at a third channel.
    if let o = AppModel.readAppConfig(), let c = o["update_channel"] as? String, !c.isEmpty {
      updateChannel = (c == "branch") ? "branch" : "releases"
    }
    if let o = AppModel.readAppConfig(), let b = o["update_branch"] as? String, !b.isEmpty {
      updateBranch = b
    }
    // The DEVELOPMENT PIN (the branch channel's pinning extension) — same
    // read discipline as the branch: empty/absent = absent, a malformed
    // value (not 7–40 hex) is dropped: a hand-typed garbage pin must
    // never become a marker tail that 404s forever (the check falls back
    // to tip-following).
    if let o = AppModel.readAppConfig(), let p = o["update_pin"] as? String, !p.isEmpty {
      if AppModel.isPinSha(p.trimmingCharacters(in: .whitespacesAndNewlines)) {
        updatePin = p.trimmingCharacters(in: .whitespacesAndNewlines)
      }
    }
  }

  /** Persist the update channel + branch + pin (the branch channel's
   *  pinning extension). The EXACT save/preserve pattern of
   *  saveRepoPath: read-modify-write, pretty JSON, every other key
   *  (repo_path included) preserved. An empty/malformed pin field
   *  CLEARS the pin (the branch channel's tip-following behavior
   *  resumes); switching away from the branch channel clears any
   *  pending edge offer — a stale "update available" for a channel the
   *  operator just left would install from the wrong place. */
  func saveUpdateChannel() {
    let branch = updateBranch.trimmingCharacters(in: .whitespacesAndNewlines)
    let pin = updatePin.trimmingCharacters(in: .whitespacesAndNewlines)
    var o = AppModel.readAppConfig() ?? [:]
    o["update_channel"] = updateChannel
    o["update_branch"] = branch
    if AppModel.isPinSha(pin) {
      o["update_pin"] = pin
    } else {
      o["update_pin"] = NSNull()
    }
    let data = (try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys])) ?? Data()
    try? data.write(to: URL(fileURLWithPath: AppModel.appConfigPath()))
    updateBranch = branch.isEmpty ? "main" : branch
    updatePin = AppModel.isPinSha(pin) ? pin : ""
    edgePending = false
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
    loadProjects()
  }

  var clientPkgDir: String { (repoRoot as NSString).appendingPathComponent("client") }

  // MARK: deep-link routing (pure — testable headlessly)

  /** Map a URL to the tab it should open on. Hosts: "" or "open" → State
   *  (the default), "sessions" → Sessions, "logs" → Logs, "projects" →
   *  Projects; any other host — or a non-idlefill scheme — → State. */
  static func route(for url: URL) -> MainTab {
    guard url.scheme == "idlefill" else { return .state }
    switch url.host {
    case "sessions": return .sessions
    case "logs": return .logs
    case "projects": return .projects
    default: return .state
    }
  }

  /** Apply a deep link: bring the app forward and switch to the tab the URL
   *  names. Safe from both launch-time (.onOpenURL) and a running app —
   *  activating an already-active app is a no-op. A WindowGroup app can end
   *  up with more than one window (e.g. a URL-opened window alongside a
   *  restored one); the deep link targets ONE window, so any extras are
   *  closed and the first visible one is kept + focused. */
  func handleDeepLink(_ url: URL) {
    DispatchQueue.main.async {
      NSApp.activate(ignoringOtherApps: true)
      let visible = NSApp.windows.filter { $0.isVisible }
      if visible.count > 1 {
        for extra in visible.dropFirst() {
          extra.close()
        }
      }
      if let win = visible.first {
        win.makeKeyAndOrderFront(nil)
      }
      self.activeTab = AppModel.route(for: url)
    }
  }

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

    // sessions — parsed on EVERY successful poll (before the clients
    // guard: sessions are global interactive traffic; a payload whose
    // clients[] is empty still carries the sessions truth). The pure
    // projection is the single read site the Sessions panel renders.
    sessions = SessionsView.project(payload: o, nowMs: Date().timeIntervalSince1970 * 1000)

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

  /** Test seam (the menubar's injectStatePayload precedent): run the REAL
   *  poll-path apply() over a canned payload, headlessly. */
  func injectStatePayload(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    apply(data)
  }

  // MARK: sessions gate write (Pause / Resume — the desktop's interaction)

  /** Flip one session's operator gate. The wire shape is built by the PURE
   *  SessionsView.overrideRequest (POST /api/sessions/<token>/override,
   *  {"override":"pause"|"null"}, Bearer header — the arbiter token rides
   *  ONLY in the header, never the URL, never printed). Write-path UX
   *  discipline (the Settings/Projects pattern): optimistic flip +
   *  per-row in-flight disable; revert with a one-line error on failure;
   *  a 404 (unknown_session — the arbiter restarted) re-polls at once so
   *  the rows re-land on arbiter truth; success is confirmed by the next
   *  5s poll. */
  func setSessionOverride(sessionToken: String, paused: Bool) {
    guard !pendingSessionTokens.contains(sessionToken) else { return }
    guard let arbiterToken = token() else {
      sessionsNote = "override failed: no arbiter token in client/config.json"
      return
    }
    let req = SessionsView.overrideRequest(serverURL: serverURL(), sessionToken: sessionToken,
                                           paused: paused, arbiterToken: arbiterToken)
    // Optimistic: flip the row NOW (state word + button title follow it).
    let prev = sessions
    if let i = sessions.firstIndex(where: { $0.token == sessionToken }) {
      let r = sessions[i]
      sessions[i] = SessionRow(token: r.token, shortToken: r.shortToken, clientName: r.clientName,
                               // Resume optimistically reads "Idle" (the
                               // row's own timestamps are not carried on
                               // the view row); the next poll re-derives
                               // Active/Idle from arbiter truth.
                               stateWord: paused ? "Paused" : "Idle",
                               stale: r.stale, lastRequestText: r.lastRequestText,
                               serverId: r.serverId, paused: paused,
                               actionTitle: paused ? "Resume" : "Pause")
    }
    pendingSessionTokens.insert(sessionToken)
    URLSession.shared.dataTask(with: req) { [weak self] _, resp, err in
      DispatchQueue.main.async {
        guard let self else { return }
        self.pendingSessionTokens.remove(sessionToken)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if err == nil && (status == 200 || status == 201) {
          // Success: the optimistic row stands; the next 5s poll confirms
          // it against arbiter truth. Clear any older error line.
          self.sessionsNote = nil
          return
        }
        // Failure: revert to the pre-click rows.
        self.sessions = prev
        if status == 404 {
          // unknown_session (the arbiter restarted / the session is gone):
          // re-poll immediately so the rows re-land on arbiter truth.
          self.sessionsNote = "session unknown to the arbiter — refreshing"
          self.poll()
        } else if status == -1 {
          self.sessionsNote = "override failed: could not reach the arbiter"
        } else {
          self.sessionsNote = "override failed: HTTP \(status)"
        }
      }
    }.resume()
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

  // MARK: projects (this client's config.json)

  /** One editable row of the Projects view. The fields map 1:1 onto the
   *  project keys in client/config.json (see client/src/config.ts). */
  struct ProjectRow: Identifiable {
    let id: Int
    var name: String
    var model: String
    var queueFile: String
    var estimatedSeconds: String
    var timeoutSeconds: String
    let executor: String
    let cwd: String
  }

  private var clientConfigPath: String {
    (repoRoot as NSString).appendingPathComponent("client/config.json")
  }

  /** Read this client's config at runtime (the same pattern as token()/
   *  serverURL() — never baked in) and fill the Projects view. The token is
   *  parsed but NEVER copied into a view-facing property. */
  func loadProjects() {
    let path = clientConfigPath
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      projClientName = ""
      projServerURL = ""
      projRows = []
      projNote = "no client config found at \(path)"
      projSavedPendingRestart = false
      return
    }
    projNote = nil
    projClientName = (o["client_name"] as? String) ?? ""
    projServerURL = (o["server_url"] as? String) ?? ""
    var rows: [ProjectRow] = []
    for (i, p) in ((o["projects"] as? [[String: Any]]) ?? []).enumerated() {
      rows.append(ProjectRow(
        id: i,
        name: (p["name"] as? String) ?? "",
        model: (p["model"] as? String) ?? "",
        queueFile: (p["queue_file"] as? String) ?? "",
        estimatedSeconds: numText(p["estimated_seconds"]),
        timeoutSeconds: numText(p["timeout_seconds"]),
        executor: (p["executor"] as? String) ?? "",
        cwd: (p["cwd"] as? String) ?? ""
      ))
    }
    projRows = rows
  }

  private func numText(_ v: Any?) -> String {
    if let n = v as? NSNumber {
      let d = n.doubleValue
      return d == d.rounded() ? String(Int(d)) : String(d)
    }
    return ""
  }

  /** Validate the edited rows: per row, name / model / queue_file are
   *  required, and the numeric fields are positive numbers when non-empty.
   *  Returns an error message, or nil when clean. */
  func validateProjects() -> String? {
    for r in projRows {
      if r.name.trimmingCharacters(in: .whitespaces).isEmpty {
        return "row \(r.id + 1): name is required"
      }
      if r.model.trimmingCharacters(in: .whitespaces).isEmpty {
        return "row \(r.id + 1): model is required"
      }
      if r.queueFile.trimmingCharacters(in: .whitespaces).isEmpty {
        return "row \(r.id + 1): queue_file is required"
      }
      for (label, text) in [("estimated_seconds", r.estimatedSeconds), ("timeout_seconds", r.timeoutSeconds)] {
        let t = text.trimmingCharacters(in: .whitespaces)
        if !t.isEmpty {
          guard let d = Double(t), d.isFinite, d > 0 else {
            return "row \(r.id + 1): \(label) must be a positive number"
          }
        }
      }
    }
    return nil
  }

  /** Rewrite client/config.json with the edited project rows, preserving
   *  EVERY other key (the token included) and the file's existing mode
   *  (read before, chmod'd back after). Only the project-row fields the view
   *  edits are mutated; all other keys pass through untouched. On success:
   *  the "daemon restart to apply" note with a Restart affordance. */
  func saveProjects() {
    let path = clientConfigPath
    if let err = validateProjects() {
      projNote = err
      projSavedPendingRestart = false
      return
    }
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
      projNote = "save failed: could not read \(path)"
      projSavedPendingRestart = false
      return
    }
    guard let parsed = (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) as? [String: Any] else {
      projNote = "save failed: could not read \(path)"
      projSavedPendingRestart = false
      return
    }
    var o = parsed
    let fm = FileManager.default
    // Capture the existing mode BEFORE writing — it must be restored after.
    let existingMode = (try? fm.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.int16Value

    var newProjects: [[String: Any]] = []
    for (i, p) in ((o["projects"] as? [[String: Any]]) ?? []).enumerated() {
      guard i < projRows.count else { continue }
      let r = projRows[i]
      var np = p
      np["name"] = r.name.trimmingCharacters(in: .whitespaces)
      np["model"] = r.model.trimmingCharacters(in: .whitespaces)
      np["queue_file"] = r.queueFile.trimmingCharacters(in: .whitespaces)
      let est = r.estimatedSeconds.trimmingCharacters(in: .whitespaces)
      if est.isEmpty {
        np.removeValue(forKey: "estimated_seconds")
      } else if let d = Double(est) {
        np["estimated_seconds"] = d == d.rounded() ? Int(d) : d
      }
      let to = r.timeoutSeconds.trimmingCharacters(in: .whitespaces)
      if to.isEmpty {
        np.removeValue(forKey: "timeout_seconds")
      } else if let d = Double(to) {
        np["timeout_seconds"] = d == d.rounded() ? Int(d) : d
      }
      newProjects.append(np)
    }
    o["projects"] = newProjects

    let out = (try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys]))
    do {
      guard let out else { throw CocoaError(.fileWriteUnknown) }
      try out.write(to: URL(fileURLWithPath: path), options: .atomic)
      if let m = existingMode {
        try? fm.setAttributes([.posixPermissions: NSNumber(value: m)], ofItemAtPath: path)
      }
      projNote = nil
      projSavedPendingRestart = true
      loadProjects()
    } catch {
      projNote = "save failed: \(error.localizedDescription)"
      projSavedPendingRestart = false
    }
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
    launchctlPrint(label) != nil
  }

  /** The LOADED service's ProgramArguments.0 (issue #23) — parsed from
   *  `launchctl print gui/<uid>/<label>` (the LOADED view, NOT the
   *  on-disk plist — plutil reads a file that may not be what launchd
   *  actually loaded). nil when the label is not loaded or the block is
   *  unreadable. */
  func runningExecutable(_ label: String) -> String? {
    launchctlPrint(label).flatMap { firstArgument($0) }
  }

  /// Run `launchctl print gui/<uid>/<label>`, returning its stdout when
  /// the label is loaded (exit 0), nil otherwise. Temp-file capture (the
  /// 64 KB Pipe-deadlock class — print output is small but the rule is
  /// the class fix).
  private func launchctlPrint(_ label: String) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = ["print", "gui/\(uid)/\(label)"]
    let tmp = tempFile("idlefill-desktop-lc-\(getpid())-\(label.replacingOccurrences(of: ".", with: "_"))")
    guard let out = FileHandle(forWritingAtPath: tmp) else { return nil }
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch {
      try? out.close(); try? FileManager.default.removeItem(atPath: tmp)
      return nil
    }
    p.waitUntilExit()
    try? out.close()
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    guard p.terminationStatus == 0 else { return nil }
    return (try? String(contentsOfFile: tmp, encoding: .utf8)) ?? ""
  }

  /** The executable this checkout's menubar bundle build produces — the
   *  path a healthy menubar agent must run (menubar/build.sh's output;
   *  the committed plist template renders exactly this). */
  func menubarBundleExecutable() -> String {
    (repoRoot as NSString)
      .appendingPathComponent("menubar/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar")
  }

  func refreshLaunchdState() {
    // One `launchctl print` per label — loaded-ness AND the running
    // executable come from the same LOADED view.
    let dPrint = launchctlPrint(daemonLabel)
    let mPrint = launchctlPrint(menubarLabel)
    daemonLoaded = dPrint != nil
    menubarLoaded = mPrint != nil
    // Issue #23: surface WHAT each agent runs. The drift marker is
    // exception-only: it fires only when the loaded menubar agent runs a
    // different executable than this checkout's built bundle — a stale
    // agent becomes visible instead of masquerading as healthy.
    daemonRuns = dPrint.flatMap { firstArgument($0) }
    menubarRuns = mPrint.flatMap { firstArgument($0) }
    menubarStale = menubarLoaded && (menubarRuns != menubarBundleExecutable())
  }

  /// The first ProgramArguments entry from a `launchctl print` dump.
  private func firstArgument(_ printOutput: String) -> String? {
    guard let start = printOutput.range(of: "arguments = {") else { return nil }
    let rest = printOutput[start.upperBound...]
    for line in rest.split(separator: "\n") {
      let t = line.trimmingCharacters(in: .whitespaces)
      if t == "}" { return nil }
      if !t.isEmpty { return t }
    }
    return nil
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

  /** Restart the daemon through the SAME launchd path the Settings toggle
   *  uses (kickstart -k = kill + relaunch under the agent's KeepAlive). The
   *  Projects view's "restart to apply" affordance calls this after a config
   *  save; a successful kickstart clears the pending-restart note — the
   *  daemon now runs with the saved config. In a test/scratch context the
   *  test-hook label applies. */
  func restartDaemon() {
    let (st, out) = runCmd("/bin/launchctl", ["kickstart", "-k", "gui/\(uid)/\(daemonLabel)"])
    if st == 0 {
      daemonNote = nil
      projSavedPendingRestart = false
    } else {
      daemonNote = "restart failed: \(out)"
    }
    refreshLaunchdState()
  }

  // MARK: menu bar agent

  /** The executable this checkout's menubar bundle build produces — the
   *  path a healthy menubar agent must run (menubar/build.sh's output;
   *  the committed plist template renders exactly this). Issue #23: the
   *  desktop's own plist renders THIS path (the bundle era), so a
   *  desktop-installed agent never reads as stale against its own build. */
  func menubarBinaryPath() -> String {
    menubarBundleExecutable()
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

// MARK: sessions

/** The sessions tab: EVERY interactive session the arbiter knows (the
 *  interaction surface — the healthy rows must be visible to be paused),
 *  rendered from the pure SessionsView.project rows. Row semantics mirror
 *  the dashboard (server/public/index.html sessBlock): short token +
 *  client_name, "last request …", → server_id, the stale tag + dim on a
 *  lapsed heartbeat (NOT a state word), the state word, and the one-button
 *  gate (Pause / Resume). Empty sessions[] → a quiet empty state, never a
 *  blank pane. */
struct SessionsPanel: View {
  @ObservedObject var m: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        PanelHead(title: "sessions")
        Spacer()
        Text("\(m.sessions.count)")
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(Pal.dim)
          .padding(.trailing, 14)
      }
      if m.sessions.isEmpty {
        Text("no sessions — Hermes sessions pointed at this router appear here")
          .font(.system(.caption, design: .monospaced))
          .italic()
          .foregroundStyle(Pal.dim)
          .padding(14)
      } else {
        ScrollView {
          VStack(spacing: 0) {
            ForEach(m.sessions) { row in
              sessionRow(row, pending: m.pendingSessionTokens.contains(row.token))
              Rectangle().fill(Pal.hairline.opacity(0.5)).frame(height: 1)
            }
          }
        }
        .frame(maxHeight: .infinity)
      }
      if let note = m.sessionsNote {
        Text(note)
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(Pal.err)
          .padding(.horizontal, 14).padding(.vertical, 6)
      }
    }
  }

  @ViewBuilder
  private func sessionRow(_ row: SessionRow, pending: Bool) -> some View {
    HStack(spacing: 10) {
      Circle()
        .fill(row.stale ? Pal.dim : Pal.ok)
        .frame(width: 7, height: 7)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 8) {
          // The short prefix labels the row; the FULL token rides in the
          // tooltip (the operator matches it against the router URL).
          Text(row.shortToken)
            .font(.system(size: 12, weight: .semibold, design: .monospaced))
            .foregroundStyle(Pal.text)
            .help("session \(row.token)")
          if let name = row.clientName {
            Text(name)
              .font(.system(size: 11, design: .monospaced))
              .foregroundStyle(Pal.dim)
          }
          if row.stale {
            Text("stale")
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(Pal.dim)
              .padding(.horizontal, 5).padding(.vertical, 1)
              .overlay(RoundedRectangle(cornerRadius: 3).stroke(Pal.hairline))
              .help("no heartbeat from this session in the last 90s — the router may have dropped it")
          }
        }
        HStack(spacing: 8) {
          Text(row.lastRequestText)
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(Pal.dim)
            .help("the newest request the router saw on this session")
          if let sid = row.serverId {
            Text("→ \(sid)")
              .font(.system(size: 11, design: .monospaced))
              .foregroundStyle(Pal.dim)
              .help("the engine this session routes to")
          }
        }
      }
      Spacer()
      Text(row.stateWord)
        .font(.system(size: 12, weight: .semibold, design: .monospaced))
        .foregroundStyle(Self.stateColor(row.stateWord))
        .help(Self.stateNote(row.stateWord))
      Button(action: { m.setSessionOverride(sessionToken: row.token, paused: !row.paused) }) {
        Text(pending ? "…" : row.actionTitle)
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .foregroundStyle(Pal.text)
          .padding(.horizontal, 10).padding(.vertical, 4)
          .overlay(RoundedRectangle(cornerRadius: 4).stroke(Pal.hairline))
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(pending)
      .help(row.paused ? "open the gate — resume this session's traffic"
                        : "hold this session's traffic at the router")
    }
    .padding(.horizontal, 14).padding(.vertical, 8)
    // Stale is a DIM, not a state word (the dashboard's rule).
    .opacity(row.stale ? 0.55 : 1.0)
    .background(
      // Per-row in-flight marker: a hairline accent wash while THIS row's
      // write runs (the button shows "…" and is disabled).
      Group { if pending { Rectangle().fill(Pal.accent.opacity(0.06)) } }
    )
  }

  static func stateColor(_ w: String) -> Color {
    switch w {
    case "Paused": return Pal.warn
    case "Active": return Pal.ok
    default: return Pal.dim
    }
  }
  static func stateNote(_ w: String) -> String {
    switch w {
    case "Paused": return "paused — the router holds this session's traffic"
    case "Active": return "a request was seen on this session just now"
    default: return "no request seen on this session recently"
    }
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

// MARK: projects

struct ProjectsPanel: View {
  @ObservedObject var m: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      PanelHead(title: "projects")
      VStack(alignment: .leading, spacing: 8) {
        KVRow(k: "client_name", v: m.projClientName)
        KVRow(k: "server_url", v: m.projServerURL)

        ForEach(m.projRows) { r in
          projectBlock(r)
        }

        if m.projRows.isEmpty {
          Text(m.projNote ?? "no projects configured")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(Pal.dim)
        }

        HStack(spacing: 8) {
          Button("save") { m.saveProjects() }
            .font(.system(.body, design: .monospaced))
            .buttonStyle(.plain)
            .foregroundStyle(Pal.accent)
          if m.projSavedPendingRestart {
            Text("saved — daemon restart to apply").font(.system(.caption, design: .monospaced)).foregroundStyle(Pal.warn)
            Button("restart daemon") { m.restartDaemon() }
              .font(.system(.body, design: .monospaced))
              .buttonStyle(.plain)
              .foregroundStyle(Pal.accent)
          }
        }

        if let note = m.projNote {
          Text(note).font(.system(.caption, design: .monospaced)).foregroundStyle(Pal.err)
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        Text("edits rewrite client/config.json — every other key (including the token) is preserved and the file keeps its 0600 mode; the daemon picks changes up on its next start.")
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(Pal.dim)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(14).padding(.vertical, 8)
    }
  }

  @ViewBuilder
  private func projectBlock(_ r: AppModel.ProjectRow) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(r.name.isEmpty ? "project" : r.name)
        .font(.system(.body, design: .monospaced).weight(.semibold))
        .foregroundStyle(Pal.text)
      editField("name", text: binding(\.name, r.id))
      editField("model", text: binding(\.model, r.id))
      editField("queue_file", text: binding(\.queueFile, r.id))
      editField("estimated_seconds", text: binding(\.estimatedSeconds, r.id))
      editField("timeout_seconds", text: binding(\.timeoutSeconds, r.id))
      KVRow(k: "executor", v: r.executor)
      KVRow(k: "cwd", v: r.cwd)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Pal.panel)
    .clipShape(RoundedRectangle(cornerRadius: 6))
  }

  private func editField(_ label: String, text: Binding<String>) -> some View {
    HStack(spacing: 8) {
      Text(label).font(.system(.body, design: .monospaced)).foregroundStyle(Pal.dim)
        .frame(width: 150, alignment: .leading)
      TextField("", text: text)
        .font(.system(.body, design: .monospaced))
        .textFieldStyle(.plain)
        .foregroundStyle(Pal.text)
        .background(Pal.canvas)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .padding(4)
    }
  }

  private func binding(_ kp: WritableKeyPath<AppModel.ProjectRow, String>, _ id: Int) -> Binding<String> {
    Binding(
      get: {
        guard let i = m.projRows.firstIndex(where: { $0.id == id }) else { return "" }
        return m.projRows[i][keyPath: kp]
      },
      set: { nv in
        guard let i = m.projRows.firstIndex(where: { $0.id == id }) else { return }
        m.projRows[i][keyPath: kp] = nv
      }
    )
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
        // Issue #23: the toggle row carries the agent's ACTUAL running
        // executable (the LOADED launchctl view) — a stale agent is no
        // longer indistinguishable from a healthy one.
        if let runs = m.daemonRuns {
          Text("runs: \(runs)").font(.system(size: 11, design: .monospaced))
            .foregroundStyle(Pal.dim)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
        }

        Toggle(isOn: Binding(
          get: { m.menubarLoaded },
          set: { m.setMenubar(on: $0) }
        )) {
          Text("menu bar").font(.system(.body, design: .monospaced)).foregroundStyle(Pal.text)
        }
        .toggleStyle(SwitchToggleStyle(tint: Pal.accent))
        .controlSize(.small)
        if let runs = m.menubarRuns {
          Text("runs: \(runs)").font(.system(size: 11, design: .monospaced))
            .foregroundStyle(Pal.dim)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
        }
        // The stale marker (issue #23) — EXCEPTION-ONLY (DESIGN.md): it
        // appears only when the loaded menubar agent runs a different
        // executable than this checkout's built bundle. No mark when
        // healthy; it clears on the next poll after a successful
        // re-point (Update Code / Install Update / install.sh).
        if m.menubarStale {
          HStack(spacing: 6) {
            Text("stale").font(.system(size: 11, weight: .semibold, design: .monospaced))
              .foregroundStyle(Pal.warn)
            Text("the agent does not run this checkout's built bundle — Update Code or Install Update re-points it")
              .font(.system(size: 11, design: .monospaced))
              .foregroundStyle(Pal.dim)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }

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

        DividerLine()

        // The update row (redesigned after the 2026-10-01 stuck-update
        // incident): ONE line that states where updates come from in
        // plain words, a compact control, and the pin hidden behind an
        // "advanced" affordance (it renders only when set or opened —
        // the old layout showed channel + branch + pin + a three-way
        // explanation paragraph at once, which read as noise).
        HStack(spacing: 8) {
          Text("updates").font(.system(.body, design: .monospaced)).foregroundStyle(Pal.dim)
          Picker("", selection: $m.updateChannel) {
            Text("releases").tag("releases")
            Text("branch").tag("branch")
          }
          .labelsHidden()
          .frame(width: 110)
          // One plain sentence for the selected channel (never both).
          Text(m.updateChannel == "branch"
               ? "latest build pushed to \((m.updateBranch.isEmpty ? "main" : m.updateBranch))"
               : "published releases")
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(Pal.dim)
            .lineLimit(1)
          Spacer(minLength: 4)
          // The pin (advanced): a tiny toggle that reveals the field;
          // the field also shows whenever a pin is set (so a pin can
          // always be cleared).
          if m.updateChannel == "branch" {
            Button(m.updateBranch == "main" ? "branch" : "edit branch") { m.showBranchField = true }
              .font(.system(size: 11, design: .monospaced))
              .buttonStyle(.plain)
              .foregroundStyle(Pal.dim)
              .disabled(m.updateBranch != "main")
            Button(m.updatePin.isEmpty ? "pin" : "edit pin") { m.showPinField = true }
              .font(.system(size: 11, design: .monospaced))
              .buttonStyle(.plain)
              .foregroundStyle(Pal.dim)
              .disabled(!m.updatePin.isEmpty)
          }
          Button("save") { m.saveUpdateChannel() }
            .font(.system(.body, design: .monospaced))
            .buttonStyle(.plain)
            .foregroundStyle(Pal.accent)
        }
        // The branch + pin fields, exception-only: the branch field only
        // when the tracked branch is NOT the default or "branch" opened
        // it, the pin field only when opened or set.
        if m.updateChannel == "branch" && (m.updateBranch != "main" || m.showBranchField || m.showPinField || !m.updatePin.isEmpty) {
          HStack(spacing: 8) {
            if m.updateChannel == "branch" && (m.updateBranch != "main" || m.showBranchField) {
              Text("branch").font(.system(.body, design: .monospaced)).foregroundStyle(Pal.dim)
              TextField("", text: $m.updateBranch)
                .font(.system(.body, design: .monospaced))
                .textFieldStyle(.plain)
                .foregroundStyle(Pal.text)
                .background(Pal.canvas)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .padding(4)
                .frame(maxWidth: 160)
            }
            if m.showPinField || !m.updatePin.isEmpty {
              Text("pin").font(.system(.body, design: .monospaced)).foregroundStyle(Pal.dim)
              TextField("", text: $m.updatePin, prompt: Text("commit sha — empty follows the branch tip").foregroundStyle(Pal.dim))
                .font(.system(.body, design: .monospaced))
                .textFieldStyle(.plain)
                .foregroundStyle(Pal.text)
                .background(Pal.canvas)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .padding(4)
                .frame(maxWidth: 260)
              // Clear an unwanted pin without saving an empty field past
              // the visibility rule (empty + closed = tip-following).
              if !m.updatePin.isEmpty {
                Button("clear") { m.updatePin = ""; m.showPinField = false; m.saveUpdateChannel() }
                  .font(.system(size: 11, design: .monospaced))
                  .buttonStyle(.plain)
                  .foregroundStyle(Pal.dim)
              }
            }
            Spacer(minLength: 4)
          }
        }

        DividerLine()

        HStack(spacing: 8) {
          Button(m.updateChecking ? "checking…" : "check for updates…") { m.checkForUpdates() }
            .font(.system(.body, design: .monospaced))
            .buttonStyle(.plain)
            .foregroundStyle(m.updateChecking ? Pal.dim : Pal.accent)
            .disabled(m.updateChecking)
          // The branch-channel confirm control — exception-only (the
          // menubar's Install Update row pattern): it exists only while
          // an edge build is pending (the check found a tip marker
          // newer than this build). Releases channel: never shown (the
          // Sparkle dialog drives its own install).
          if m.edgePending {
            Button("install edge build") { m.confirmEdgeInstall() }
              .font(.system(.body, design: .monospaced))
              .buttonStyle(.plain)
              .foregroundStyle(m.updateChecking ? Pal.dim : Pal.ok)
              .disabled(m.updateChecking)
          }
          if let status = m.updateStatus {
            Text(status)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(statusColor(status))
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        // The update progress (the 2026-10-01 ask): a real bar while an
        // edge download runs (determinate from the task's byte counts;
        // indeterminate when the server sends no length), a spinner for
        // every other in-flight phase (a check, the hash fetch, the
        // swap handshake). Nothing when idle — Exception-Only.
        if m.updateChecking {
          HStack(spacing: 8) {
            if let frac = m.updateProgress {
              ProgressView(value: min(max(frac, 0), 1))
                .progressViewStyle(.linear)
                .tint(Pal.accent)
              Text("\(Int((min(max(frac, 0), 1)) * 100))%")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Pal.dim)
                .frame(width: 38, alignment: .trailing)
            } else {
              ProgressView().controlSize(.small).tint(Pal.accent)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }

        Text("updates come from the Forgejo repo — see the README \"Updating\" section.")
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(Pal.dim)
          .frame(maxWidth: .infinity, alignment: .leading)

        Text("launchd agents in gui/\(String(getuid())) — the toggles reflect real launchctl state, re-checked every 5s.")
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(Pal.dim)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(14).padding(.vertical, 8)
    }
  }

  /** The status line's color: a refusal / bad-branch-name / failed
   *  status is operator-actionable (red); the narration is dim. (The
   *  pre-#26 rule kept — a Sparkle fetch failure reads "no update …".) */
  private func statusColor(_ s: String) -> Color {
    if s.hasPrefix("no update") && s.contains("—") { return Pal.err }
    if s.contains("NOT installed") || s.contains("not found")
      || s.contains("not published") || s.contains("mismatch")
      || s.contains("failed") { return Pal.err }
    return Pal.dim
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

      // tab strip (deep links set m.activeTab; the buttons set it too)
      HStack(spacing: 0) {
        ForEach(MainTab.allCases, id: \.self) { tab in
          Button(action: { m.activeTab = tab }) {
            Text(tab.title)
              .font(.system(size: 11, weight: .semibold, design: .monospaced))
              .tracking(1)
              .foregroundStyle(m.activeTab == tab ? Pal.text : Pal.dim)
              .padding(.horizontal, 14).padding(.vertical, 7)
              .overlay(alignment: .bottom) {
                if m.activeTab == tab {
                  Rectangle().fill(Pal.accent).frame(height: 2)
                }
              }
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
        Spacer()
      }

      DividerLine()

      Group {
        switch m.activeTab {
        case .state:
          StatePanel(m: m)
        case .sessions:
          SessionsPanel(m: m)
            .frame(maxHeight: .infinity)
        case .logs:
          LogViewer(m: m)
            .frame(maxHeight: .infinity)
        case .projects:
          ProjectsPanel(m: m)
        case .settings:
          SettingsPanel(m: m)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .background(Pal.canvas)
    .frame(minWidth: 560, minHeight: 560)
  }
}

// MARK: - app

@main
enum IdlefillMain {
  static func main() {
    // `--version` / `-v` (first arg) prints the baked build marker and
    // exits 0 BEFORE any AppKit setup (the App's init /
    // applicationDidFinishLaunching never run on this path — the decision
    // is made in main() before the App type is ever touched). The marker
    // is the build's identity (issue #26): the numeric release version for
    // release builds, the edge marker (`edge-<branch>-<sha7>`) for branch
    // channel builds — an installed build proves its own origin. A build
    // that never went through the substitution (an ad-hoc `swiftc` on the
    // source) reports the default `1.0` — NOT the literal placeholder
    // (the same fail-mode as the menubar's `0.0.0-dev`).
    let args = CommandLine.arguments
    if args.count > 1, args[1] == "--version" || args[1] == "-v" {
      if __DESKTOP_BUILD__ != __DESKTOP_BUILD_UNSUBSTITUTED__,
         !__DESKTOP_BUILD__.trimmingCharacters(in: .whitespaces).isEmpty {
        print("idlefill \(__DESKTOP_BUILD__)")
      } else {
        print("idlefill 1.0")
      }
      exit(0)
    }
    IdlefillApp.main()
  }
}

struct IdlefillApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
  @StateObject private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      ContentView(m: model)
        .preferredColorScheme(.dark)
        .onOpenURL { url in
          model.handleDeepLink(url)
        }
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
