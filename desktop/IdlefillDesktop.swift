//
//  IdlefillDesktop.swift — the idlefill desktop app (macOS 14+).
//
//  A windowed companion (WindowGroup, NOT a MenuBarExtra) built with bare
//  swiftc (no Xcode project). ONE surface (issue #61 step 3): the window IS
//  the arbiter's own page — a WKWebView loading its live origin — under a
//  slim native toolbar the page can never own:
//
//    webview — THE surface: a WKWebView (system WebKit, zero new
//                dependencies) loading the arbiter's LIVE origin —
//                server_url from client/config.json, never a hardcoded
//                host, never a bundled copy of index.html (a copied page
//                re-creates the drift bug inside the bundle). The gate
//                token from client/config.json is injected via a
//                WKUserScript at .documentStart — BEFORE the page's inline
//                script runs — into the page's own localStorage key, so
//                every write works with zero pasting. The page carries
//                everything the retired Swift panels used to render:
//                state facts, sessions + per-session gates, the client
//                log tail (the logs dock's Client log tab), the local
//                project-config editor, the `daemon behind` staleness tag
//                (#61 step 3 A1-A3 closed those gaps IN the page). ATS:
//                the bundle's NSAllowsArbitraryLoads covers the
//                plain-HTTP loopback load (live-proven, build.sh's note).
//    toolbar — the slim native strip above the webview: which origin the
//              app points at + token auto-injected + the arbiter-stopped
//              exception (the loaded-but-exited agent → kickstart
//              Relaunch) + Reload + a settings disclosure. Settings
//              re-hosts the machinery the arbiter can NEVER know about:
//              the daemon / menu bar / arbiter launchd toggles (REAL
//              launchctl state, re-checked every 5s, the runs: lines, the
//              menubar stale marker, the arbiter stopped/Relaunch row),
//              the repo path, and the update channel (Sparkle releases +
//              the edge channel with pin, progress + confirm). Lifecycle
//              stays native — launchd controls never move into the page
//              (#61 lock).
//
//  Deep links: the bundle registers the `idlefill://` URL scheme
//  (CFBundleURLTypes in the generated Info.plist). Every host routes the
//  ONE surface: the webview reloads the live origin with the page view's
//  `#<view>` appended where a page view exists — state → #overview,
//  sessions → #sessions, projects → #projects, usage → #usage; "" / open
//  / dashboard / logs / unknown → the page's default view (the logs DOCK
//  is a dock, not a hashable view). A URL that launches the app opens on
//  the requested view; a URL delivered to a RUNNING app activates it,
//  brings the window forward, and re-points the webview. Parsing lives in
//  the pure `AppModel.hashView(for:)` so it is testable headlessly.
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
import WebKit

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
  /// The canvas color for AppKit surfaces (the webview under-page fill —
  /// same #0d1117 as `canvas`, which is a SwiftUI Color AppKit rejects).
  static let canvasNS = NSColor(srgbRed: 0x0d / 255.0, green: 0x11 / 255.0, blue: 0x17 / 255.0, alpha: 1)
}

// MARK: - model

final class AppModel: ObservableObject {
  /** The Settings disclosure (the slim native toolbar, #61 step 3): the
   *  re-hosted launchd/update machinery renders while open; the webview
   *  never tears down — the page keeps its state through open/close. */
  @Published var settingsOpen = false
  /** The page view a deep link asked for (nil = no hash = the page's own
   *  default). The webview loads <origin>#<view>; the page reads the hash
   *  itself (server/public/index.html HASH_VIEW_RE). */
  @Published var dashboardHash: String? = nil

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
  /** The LOCAL arbiter agent (com.sam.idlefill.server, issue #60 Slice A —
   *  the fused Mac instance the Dashboard tab's webview loads). Three
   *  states matter, and `launchctl print` exit 0 alone cannot see them:
   *  loaded+running (a `pid =` line in the print dump), loaded+exited
   *  (print exit 0, NO pid line — the clean-SIGTERM death that left the
   *  dashboard blank while every "loaded" check read healthy), and not
   *  loaded. The toggle reflects loaded; the exception row fires on
   *  loaded+exited; "relaunch" is `launchctl kickstart` (no -k: it starts
   *  an exited job and is a no-op-while-running, proven live 2026-10-05
   *  against a scratch label). */
  @Published var arbiterLoaded = false
  @Published var arbiterRunning = false
  @Published var arbiterNote: String? = nil

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

  private let uid = getuid()

  init() {
    loadConfig()
    refreshLaunchdState()
    // The lifecycle tick: launchd state is re-read from REAL launchctl
    // every 5s. It is the only native poll left — every data surface
    // lives on the embedded page, which polls the arbiter itself.
    Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      self?.refreshLaunchdState()
    }
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
    refreshLaunchdState()
  }

  // MARK: deep-link routing (pure — testable headlessly)

  /** Map a deep-link URL to the PAGE VIEW hash it should open. The one
   *  surface is the embedded page (#61 step 3): every host re-points the
   *  webview at the live origin with the page view's hash appended where
   *  a page view exists — "state" → overview (the page's Overview view
   *  carries the facts the old state tab showed), "sessions" → sessions,
   *  "projects" → projects, "usage" → usage. "" / "open" / "dashboard" /
   *  "logs" / any unknown host → nil: the page's default view (the logs
   *  DOCK is a dock, not a hashable view). The page reads the hash
   *  itself (server/public/index.html HASH_VIEW_RE). */
  static func hashView(for url: URL) -> String? {
    guard url.scheme == "idlefill" else { return nil }
    switch url.host {
    case "state": return "overview"
    case "sessions": return "sessions"
    case "projects": return "projects"
    case "usage": return "usage"
    default: return nil
    }
  }

  /** Apply a deep link: bring the app forward and re-point the webview at
   *  the page view the URL names. Safe from both launch-time (.onOpenURL)
   *  and a running app — activating an already-active app is a no-op. A
   *  WindowGroup app can end up with more than one window (e.g. a
   *  URL-opened window alongside a restored one); the deep link targets
   *  ONE window, so any extras are closed and the first visible one is
   *  kept + focused. The hash is stored on the model so a later Reload
   *  keeps the operator on the view the link asked for. */
  func handleDeepLink(_ url: URL) {
    let view = AppModel.hashView(for: url)
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
      self.dashboardHash = view
      self.reloadDashboard()
    }
  }

  // MARK: dashboard webview (issue #61 step 1) — stored members

  /// The page's gate-token localStorage key — the exact constant the
  /// dashboard reads on every write (server/public/index.html:
  /// `const GATE_TOKEN_KEY = "idlefill.token"` + gateToken()). Mirrored
  /// here deliberately: the page's contract is the contract; the app
  /// injects into it, never around it. If the page ever renames the key,
  /// this constant and the live eyeball are the two places to change.
  static let gateTokenKey = "idlefill.token"

  /// THE dashboard webview — ONE instance kept on the model so a tab
  /// switch re-hosts the same live view instead of tearing the page down
  /// and reloading it. The user script is re-armed on every (re)load so a
  /// rotated token in client/config.json takes effect on the next reload.
  private(set) lazy var dashboardWebView: WKWebView = {
    let w = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 760),
                      configuration: WKWebViewConfiguration())
    w.underPageBackgroundColor = Pal.canvasNS
    return w
  }()

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
  /** The local arbiter agent (issue #60 Slice A, fused Mac instance — the
   *  origin the Dashboard tab loads). A remote-arbiter checkout has no
   *  such agent: the Settings row renders from its ABSENT state, and the
   *  install path refuses rather than starting a second arbiter that
   *  would race the real host. */
  var arbiterLabel: String {
    testDir != nil
      ? (ProcessInfo.processInfo.environment["IDLEFILL_DESKTOP_TEST_LABEL_ARBITER"] ?? testLabel)
      : "com.sam.idlefill.server"
  }

  private var plistDir: String {
    testDir ?? ((NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents"))
  }
  var daemonPlistPath: String { (plistDir as NSString).appendingPathComponent("\(daemonLabel).plist") }
  var menubarPlistPath: String { (plistDir as NSString).appendingPathComponent("\(menubarLabel).plist") }
  var arbiterPlistPath: String { (plistDir as NSString).appendingPathComponent("\(arbiterLabel).plist") }

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
    let aPrint = launchctlPrint(arbiterLabel)
    daemonLoaded = dPrint != nil
    menubarLoaded = mPrint != nil
    arbiterLoaded = aPrint != nil
    // Issue #23: surface WHAT each agent runs. The drift marker is
    // exception-only: it fires only when the loaded menubar agent runs a
    // different executable than this checkout's built bundle — a stale
    // agent becomes visible instead of masquerading as healthy.
    daemonRuns = dPrint.flatMap { firstArgument($0) }
    menubarRuns = mPrint.flatMap { firstArgument($0) }
    menubarStale = menubarLoaded && (menubarRuns != menubarBundleExecutable())
    // The arbiter's liveness is NOT loaded-ness: a loaded service can sit
    // EXITED (clean SIGTERM + KeepAlive SuccessfulExit=false = no
    // relaunch), and its print dump still exits 0 — with NO `pid =` line.
    // That is the exact blank-dashboard state: the toggle reads ON, the
    // page is dead. Liveness = the pid line's presence (proven live
    // against a scratch label: exited-but-loaded prints state "not
    // running" with no pid, and `launchctl kickstart` starts it).
    arbiterRunning = aPrint.map { AppModel.pidLine($0) != nil } ?? false
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

  /** The service's live pid from a `launchctl print` dump: a trimmed
   *  `pid = <n>` line, or nil when the dump carries none. A LOADED service
   *  with no pid line is the exited-but-loaded state (the blank-dashboard
   *  shape); a missing pid value parses to nil too (fail closed — "the
   *  arbiter is not running" is the safe read when the dump is odd).
   *  Pure + static so the headless harness proves the parse directly. */
  static func pidLine(_ printOutput: String) -> Int? {
    for line in printOutput.split(separator: "\n") {
      let t = line.trimmingCharacters(in: .whitespaces)
      guard t.hasPrefix("pid =") else { continue }
      let v = t.dropFirst("pid =".count).trimmingCharacters(in: .whitespaces)
      if let n = Int(v), n > 0 { return n }
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

  // MARK: local arbiter agent (issue #60 Slice A)

  /** The port this checkout's arbiter binds (server/config.json `listen`,
   *  absent -> the 8787 default). Only the number is read; the config
   *  holds tokens and is never printed. */
  func serverConfigPort() -> Int {
    let path = (repoRoot as NSString).appendingPathComponent("server/config.json")
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let n = o["listen"] as? Double, n > 0 else { return 8787 }
    return Int(n)
  }

  /** Is the arbiter port served by a process this label does NOT own?
   *  (install-server-agent.sh's check_port_foreign, same rule): a
   *  hand-run `npm run dev` arbiter would silently shadow the agent, so
   *  the app refuses to bootstrap over it. nil = no foreign listener
   *  (port free, or owned by this label's job); non-nil = the owner's
   *  message. `lsof` needs the PATH runCmd prepends (a GUI app carries
   *  none of /usr/sbin by default). */
  private func foreignPortOwner(_ port: Int) -> String? {
    let (st, out) = runCmd("/usr/sbin/lsof", ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"])
    if st != 0 || out.isEmpty { return nil }
    let myPid = launchctlPrint(arbiterLabel).flatMap { AppModel.pidLine($0) }
    for line in out.split(separator: "\n") {
      let p = line.trimmingCharacters(in: .whitespaces)
      if p.isEmpty { continue }
      if p == String(myPid ?? -1) { return nil }  // owned by this label
      if let n = Int(p) { return "pid \(n)" }
    }
    return nil
  }

  /** The arbiter plist, rendered from THIS checkout (the same values
   *  deploy/install-server-agent.sh substitutes into its template): npx +
   *  tsx on server/src/index.ts, WorkingDirectory server/, logs under
   *  server/logs. The plist carries NO secrets — the arbiter reads
   *  server/config.json itself. KeepAlive SuccessfulExit=false matches
   *  the shipped template (the reason a clean exit stays down — which is
   *  why this row's exception marker + Relaunch exist). */
  func arbiterPlistXML() -> String {
    let repo = repoRoot
    let cwd = (repo as NSString).appendingPathComponent("server")
    let entry = (cwd as NSString).appendingPathComponent("src/index.ts")
    let logDir = cwd
    return """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>Label</key>
        <string>\(arbiterLabel)</string>
        <key>ProgramArguments</key>
        <array>
            <string>/opt/homebrew/bin/npx</string>
            <string>tsx</string>
            <string>\(entry)</string>
        </array>
        <key>WorkingDirectory</key>
        <string>\(cwd)</string>
        <key>EnvironmentVariables</key>
        <dict>
            <key>PATH</key>
            <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
            <key>NODE_ENV</key>
            <string>production</string>
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
        <string>\(logDir)/logs/launchd.out.log</string>
        <key>StandardErrorPath</key>
        <string>\(logDir)/logs/launchd.err.log</string>
    </dict>
    </plist>
    """
  }

  func setArbiter(on: Bool) {
    if on {
      // The remote-arbiter refusal: this checkout's client points the
      // dashboard at another host (urza), so a Mac-local agent would
      // start a second arbiter the dashboard never reads and which could
      // race the real one's feed. Only when the arbiter's own config is
      // ALSO absent — a genuinely remote setup — does it refuse. (A fused
      // checkout points server_url at loopback and proceeds.)
      if testDir == nil, Self.isArbiterRemote(clientServerURL: serverURL(), hasServerConfig: serverConfigExists()) {
        arbiterNote = "this checkout's server_url is a remote arbiter — a local agent would shadow it; not installed"
        refreshLaunchdState()
        return
      }
      let port = serverConfigPort()
      if testDir == nil, let owner = foreignPortOwner(port) {
        arbiterNote = "port \(port) is served by \(owner), not this agent — stop the hand-run arbiter first"
        refreshLaunchdState()
        return
      }
      let xml = testDir != nil ? testPlistXML(arbiterLabel) : arbiterPlistXML()
      install(label: arbiterLabel, plistPath: arbiterPlistPath, plistXML: xml, note: \.arbiterNote)
    } else {
      uninstall(label: arbiterLabel, note: \.arbiterNote)
    }
  }

  /** PURE so the harness proves the rule: a fused checkout (loopback
   *  server_url, or a server/config.json that exists) may run the local
   *  agent; a checkout whose client points at a REMOTE host AND has no
   *  local arbiter config refuses. Loopback = localhost or 127.x. */
  static func isArbiterRemote(clientServerURL: String, hasServerConfig: Bool) -> Bool {
    if hasServerConfig { return false }
    guard let host = URL(string: clientServerURL)?.host?.lowercased() else { return true }
    return !(host == "localhost" || host.hasPrefix("127."))
  }

  func serverConfigExists() -> Bool {
    FileManager.default.fileExists(atPath: (repoRoot as NSString).appendingPathComponent("server/config.json"))
  }

  /** The arbiter agent's live pid (nil = not loaded, or loaded but
   *  exited). Exposed for the headless harness — the shipped liveness
   *  read is `arbiterRunning`, which parses the same dump. */
  func arbiterPid() -> Int? {
    launchctlPrint(arbiterLabel).flatMap { AppModel.pidLine($0) }
  }

  /** Bring the arbiter back. `kickstart` WITHOUT -k: it starts an
   *  exited-but-loaded job (proven live: rc 0, new pid) and is a no-op
   *  while the job already runs — the safe one-button fix for the blank-
   *  dashboard state, and the right call even when the label is not
   *  loaded at all (then it fails "could not find service" and the note
   *  tells the operator to flip the toggle on instead). */
  func relaunchArbiter() {
    if arbiterLoaded {
      let (st, out) = runCmd("/bin/launchctl", ["kickstart", "gui/\(uid)/\(arbiterLabel)"])
      arbiterNote = st == 0 ? nil : "relaunch failed: \(out)"
    } else {
      setArbiter(on: true)
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

        // The LOCAL arbiter agent (the origin the Dashboard tab loads).
        // The toggle reflects loaded-ness — but loaded is NOT live: a
        // clean exit under KeepAlive SuccessfulExit=false leaves the
        // service loaded and the process gone, print still exits 0, and
        // every loaded-check reads healthy while the dashboard renders
        // blank. So this row carries its own exception: "stopped" fires
        // only in the loaded-but-exited state, with the one-button fix
        // (kickstart = start it under the same agent).
        Toggle(isOn: Binding(
          get: { m.arbiterLoaded },
          set: { m.setArbiter(on: $0) }
        )) {
          Text("arbiter").font(.system(.body, design: .monospaced)).foregroundStyle(Pal.text)
        }
        .toggleStyle(SwitchToggleStyle(tint: Pal.accent))
        .controlSize(.small)
        if m.arbiterLoaded {
          if m.arbiterRunning {
            Text("running: \(m.arbiterLabel)").font(.system(size: 11, design: .monospaced))
              .foregroundStyle(Pal.dim)
              .frame(maxWidth: .infinity, alignment: .leading)
          } else {
            HStack(spacing: 6) {
              Text("stopped").font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(Pal.err)
              Text("loaded but not running — the dashboard origin is down")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Pal.dim)
              Spacer(minLength: 4)
              Button("Relaunch") { m.relaunchArbiter() }
                .font(.system(size: 11, design: .monospaced))
                .buttonStyle(.plain)
                .foregroundStyle(Pal.ok)
                .help("launchctl kickstart — start the agent's job without changing the plist")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
        }

        if let note = m.daemonNote {
          Text(note).font(.system(.caption, design: .monospaced)).foregroundStyle(Pal.err)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        if let note = m.menubarNote {
          Text(note).font(.system(.caption, design: .monospaced)).foregroundStyle(Pal.err)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        if let note = m.arbiterNote {
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

// MARK: - dashboard webview (issue #61 step 1) — behavior

extension AppModel {
  /// The WKUserScript source that satisfies the page's own gate mechanism
  /// at documentStart — BEFORE the page's inline script ever runs — so
  /// every write works with zero pasting. The injection is ADDITIVE: the
  /// page's own token box stays fully functional for browser users (they
  /// still paste, the page still persists to the same key). The token
  /// rides as a JSON string literal so no character can break out of it;
  /// the value is NEVER printed, logged, or returned in any other form.
  /// nil token (config unreadable) -> nil script: the page still loads
  /// read-only and its own "gate needs the arbiter API token" hint works.
  static func gateTokenScript(gateToken: String?) -> String? {
    guard let t = gateToken, !t.isEmpty else { return nil }
    guard let d = try? JSONSerialization.data(withJSONObject: [t]),
          let arr = String(data: d, encoding: .utf8) else { return nil }
    // ["tok…"] -> "tok…" (JSON-quoted, escaped — the array is just the
    // encoder's way to get a compliant string literal).
    let literal = String(arr.dropFirst().dropLast())
    return "(function(){try{localStorage.setItem(\"\(AppModel.gateTokenKey)\", \(literal));}catch(e){}})();"
  }

  /// The page's live origin: server_url from client/config.json (0600) +
  /// the deep-link view hash when one is set (#overview/#projects/
  /// #sessions/#usage). Never a hardcoded host, never a file: URL into a
  /// bundled copy of index.html — a copied page re-creates the drift bug
  /// inside the bundle. The arbiter serves its own version-matched page.
  func dashboardURL() -> URL? {
    let u = serverURL()
    guard !u.isEmpty else { return nil }
    let frag = dashboardHash.map { "#" + $0 } ?? ""
    return URL(string: (u.hasSuffix("/") ? u : u + "/") + frag)
  }

  /// Arm the documentStart token script for the CURRENT config, then load
  /// (or reload) the live origin. Called at first display and by the
  /// Reload affordance. The token is read at call time — never baked in.
  func reloadDashboard() {
    let w = dashboardWebView
    w.configuration.userContentController.removeAllUserScripts()
    if let src = AppModel.gateTokenScript(gateToken: token()) {
      w.configuration.userContentController.addUserScript(
        WKUserScript(source: src, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    if let url = dashboardURL() {
      w.load(URLRequest(url: url))
    }
  }
}

/// Hosts the model's single WKWebView inside the SwiftUI tree.
struct DashboardWebView: NSViewRepresentable {
  let m: AppModel
  func makeNSView(context: Context) -> WKWebView { m.dashboardWebView }
  func updateNSView(_ nsView: WKWebView, context: Context) {}
}

/// THE surface: the arbiter's own page, hosted, under the slim native
/// toolbar (the #61 step 3 shape). The strip carries only facts the page
/// cannot know (which origin the app points at, the launchd agent's REAL
/// liveness) and the actions the page must not own (reload the host,
/// open the native lifecycle settings the arbiter can never know about).
struct DashboardPanel: View {
  @ObservedObject var m: AppModel
  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Text("idlefill · desktop")
          .font(.system(size: 12, weight: .semibold, design: .monospaced))
          .foregroundStyle(Pal.text)
        Text("arbiter origin")
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(Pal.dim)
        Text(m.dashboardURL()?.host ?? "—")
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(Pal.text)
        Text("token auto-injected")
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(Pal.dim)
        // The one fact the page cannot state about itself: its origin is
        // a local agent process that is loaded but NOT running (the
        // clean-exit death — the service reads "loaded", the page renders
        // blank against the canvas fill). Exception-Only: nothing here
        // while the agent runs. The fix is inline — same kickstart the
        // Settings toggle uses — then Reload re-points the webview.
        if m.arbiterLoaded && !m.arbiterRunning {
          Text("arbiter stopped").font(.system(size: 11, weight: .semibold, design: .monospaced))
            .foregroundStyle(Pal.err)
          Button("Relaunch") { m.relaunchArbiter() }
            .font(.system(size: 11, design: .monospaced))
            .buttonStyle(.plain)
            .foregroundStyle(Pal.ok)
            .help("launchctl kickstart the arbiter agent, then reload this page")
        }
        Spacer()
        Button(m.settingsOpen ? "settings ▾" : "settings ▸") { m.settingsOpen.toggle() }
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .buttonStyle(.plain)
          .foregroundStyle(m.settingsOpen ? Pal.text : Pal.dim.opacity(0.8))
          .help("launchd agents, repo path, updates — the native lifecycle the page can never own")
        Button("Reload") { m.reloadDashboard() }
          .controlSize(.small)
          .help("reload the page and re-inject the current token")
      }
      .padding(.horizontal, 14).padding(.vertical, 6)
      // The disclosure: the Settings content re-hosted between the strip
      // and the webview. The webview NEVER tears down around it — the
      // embedded page keeps its state through an open/close.
      if m.settingsOpen {
        DividerLine()
        ScrollView {
          SettingsPanel(m: m)
        }
        .frame(maxHeight: 420)
      }
      DividerLine()
      DashboardWebView(m: m)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .onAppear {
      // Load once; later reloads go through the Reload button (a page
      // refresh timer is the page's own job — it polls every 5s itself).
      if m.dashboardWebView.url == nil { m.reloadDashboard() }
    }
  }
}

// MARK: content

/// The window IS the surface: the hosted page under the slim native
/// toolbar (#61 step 3 — the five Swift tabs retired with their parity
/// built into the page).
struct ContentView: View {
  @ObservedObject var m: AppModel

  var body: some View {
    DashboardPanel(m: m)
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
