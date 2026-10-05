//
//  IdlefillMenubar.swift — the idlefill menu bar companion (macOS 14+).
//
//  A status-bar icon (AppKit NSStatusItem + NSPopover hosting the SwiftUI
//  panel — MenuBarExtra exposes no click count, which the double-click
//  routing below needs) showing the arbiter state at a glance and
//  controlling the local client daemon:
//
//    status   — color-coded state word (the arbiter's global verdict for
//               the box) + the picked scope's live status row
//    scope    — a machine picker over clients[] (online dot, last_seen;
//               the default "this machine" = the client row whose name
//               matches this checkout's config client_name, whatever the
//               payload order; the labelled "all machines" aggregate is
//               the explicitly-chosen fallback) and, inside it, a project
//               picker over the picked client's reported projects (the
//               default "all projects" is today's aggregate)
//    stats    — per picked scope: queue depth, today finished/failed,
//               tokens out (UTC) with the project's OWN cap, the running
//               lease(s) (every active lease of this client — max
//               concurrent > 1 lists them all), the published queue peek
//               (queue_preview; a worker publishing no preview degrades
//               to the depth number)
//    controls — the published per-scope detail drives exception-only
//               controls on existing routes (no new endpoints): the
//               project pause gate (POST /api/projects/:name), the grant
//               knobs (POST /api/projects/:name/settings), the worker
//               pause/force override (POST /api/clients/:ref/override).
//               Same token gate as the dashboard: no token → no POST and
//               the status row names the missing token.
//    actions  — Open Dashboard · Show Logs · Start/Stop · Restart ·
//               Open Desktop (the double-click action as a row; its right
//               half carries the exception-only update tag — the
//               updateAvailable value verbatim, no tag when up to date) ·
//               Install Update <v> (exception-only). The Update Code and
//               Quit rows are GONE (issue #27 — the panel door only; the
//               UpdatePlan/updateCode() machinery stays intact and
//               tested); the app's exit path is the CLI
//               (`node scripts/idlefill-menubar.mjs app stop`) or launchd.
//
//  Click routing (decided by the pure MenuBarRouter — testable headlessly):
//    single click  — toggle the popover (today's behavior, exactly)
//    double click  — open the DESKTOP app on its State view:
//                    NSWorkspace.open of idlefill://open, falling back to
//                    `open /Applications/Idlefill.app` when the URL-scheme
//                    open is not handled (the desktop app not registered
//                    yet). A double click ALWAYS attempts the desktop app —
//                    only the two panel rows below fall back. The
//                    `Open Desktop` panel row performs the SAME action
//                    through the SAME shared helper (MenuBarAppState
//                    .openDesktopApp) so row and router cannot drift.
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
  case off, busy, working, idle, degraded, unreachable, noToken, unauthorized

  var color: Color {
    switch self {
    case .off: return Pal.dim
    case .busy: return Pal.warn
    case .working: return Pal.accent
    case .idle: return Pal.ok
    case .degraded: return Pal.err
    case .unreachable: return Pal.err
    // Distinct from .unreachable (the arbiter's red is "the server is down"):
    // a missing token is a local misconfiguration — the operator cannot fix
    // it by restarting anything, so the signal word AND colour must let the
    // two fail on screen (DESIGN.md: red = failure, amber = blocked/at risk).
    case .noToken: return Pal.warn
    // The token is present but the arbiter rejects it (401) — a third,
    // equally operator-actionable state; it must not read as a dead server.
    case .unauthorized: return Pal.warn
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
    case .noToken: return "no token"
    case .unauthorized: return "bad token"
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

// MARK: - client config (parsed once)

/** The gitignored client config, parsed ONCE at launch into a value.
 *  Today's shape re-read + re-parsed the file on every call (token() and
 *  serverURL() each parsed the whole file per poll, per control POST). The
 *  parse also takes `client_name` — the key that survives daemon restarts
 *  (registration is idempotent by name), so the menu bar can select THIS
 *  machine's row from the state payload by name instead of by whatever
 *  happens to come first.
 *
 *  Never printed, never logged; the token rides from here into the
 *  Authorization header only. */
struct ClientConfig: Equatable {
  let token: String?
  let serverURL: String
  let clientName: String?
  /** The update channel (issue #26), from `update_channel`: nil/absent =
   *  the releases channel (today's behavior); a branch name = the branch
   *  channel (the branch's tip is the "latest build"). Same parse
   *  discipline as the other keys (empty string = absent). */
  let updateChannel: String?
  /** The DEVELOPMENT PIN (the pinning extension of the branch channel),
   *  from `update_pin`: a commit SHA (7–40 hex). Set while the branch
   *  channel is active, the check targets `edge-<channel>-<sha7(pin)>`
   *  (the pinned commit's edge build) instead of the branch's TIP:
   *  pinned marker == the baked marker -> up to date (nothing); a
   *  different pinned marker is offered IFF its edge release exists
   *  (`GET …/releases/tags/<marker>` — a per-commit tag a push to the
   *  branch publishes, or `scripts/edge-release.sh` on demand).
   *  Malformed (not 7–40 hex) or empty = ABSENT — today's tip-following
   *  behavior is the fallback. On the releases channel it is ignored. */
  let updatePin: String?
  /** The automatic update-check cadence in MINUTES (issue #27), from
   *  `update_check_minutes`: absent/empty/non-numeric = the default 360
   *  (today's hardcoded 6h). Clamped to a minimum of 5 — a value below
   *  the floor is clamped AND the clamp is logged once at launch to the
   *  menubar log (see `UpdateCheck.resolveCadence`). Read once at launch
   *  like every other key; a relaunch picks up a new value. */
  let updateCheckMinutes: Int
  /// Set when the configured value was BELOW the floor and got clamped:
  /// the raw value, so AppModel can log the clamp once at launch (the
  /// panel never shows it — the note belongs in the menubar log).
  let updateCheckClampedFrom: Int?

  static let serverURLDefault = "http://100.105.225.1:8787"

  static func load(path: String) -> ClientConfig {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      return ClientConfig(token: nil, serverURL: serverURLDefault, clientName: nil,
                          updateChannel: nil, updatePin: nil,
                          updateCheckMinutes: UpdateCheck.cadenceMinutesDefault,
                          updateCheckClampedFrom: nil)
    }
    let token = (o["token"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    let url = (o["server_url"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? serverURLDefault
    let name = (o["client_name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    let channel = (o["update_channel"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    let pin = (o["update_pin"] as? String).flatMap { $0.isEmpty ? nil : $0 }
      .flatMap { UpdateCheck.isPinSha($0) ? $0 : nil }
    // Same parse discipline as the other keys: absent / empty / invalid
    // (non-numeric, non-integer JSON) = the default. The clamp + its
    // once-at-launch log note live in UpdateCheck.resolveCadence.
    let cadence = UpdateCheck.resolveCadence(o["update_check_minutes"])
    return ClientConfig(token: token, serverURL: url, clientName: name,
                        updateChannel: channel, updatePin: pin,
                        updateCheckMinutes: cadence.value,
                        updateCheckClampedFrom: cadence.clampedFrom)
  }
}

// MARK: - scope view (pure — testable headlessly)

/** One machine row in the state payload's clients[]. */
struct ScopeClient {
  let id: String
  let name: String
  let lastSeen: Double     // epoch-ms (0 = unknown)
  let projectNames: [String]
  let overrideLabel: String?   // active operator override (exception-only)
  let queueTotal: Int          // sum over the client's project rows
}

/** One running lease row for the scope. */
struct ScopeLease {
  let jobId: String
  let project: String
  let expiresAt: Double        // epoch-ms
}

/** A queue peek row from the published queue_preview (a worker that
 *  publishes no preview degrades to the depth number alone). */
struct ScopeQueueRow {
  let title: String
  let company: String
}

/** One router-self-registered interactive session (#9), as the arbiter
 *  publishes it on the state payload's sessions[]. The menubar only
 *  DISPLAYS sessions (read-only — pause/resume lives on the dashboard);
 *  the stale verdict and the exception one-liner are computed HERE (pure)
 *  so the harness (menubar/sessions-test.sh) asserts exactly what
 *  renders. */
struct ScopeSession {
  let token: String
  let clientName: String?      // the router that registered it, when identified
  let lastSeen: Double         // epoch-ms (0 = unknown)
  let lastActivity: Double?    // epoch-ms of the newest request seen (nil = none yet)
  let overrideLabel: String?   // active operator override ("pause" | "force"; nil = none)
  let stale: Bool              // now - last_seen > 90_000 (the daemonRunning precedent)
  /** Gate-state (#40): the router reports parked requests waiting for
   *  admission (gate.state == "queued"). An ADDITIONAL fact like `stale` —
   *  the exception one-liner gains the word, nothing else changes.
   *  Absent/unknown gate (old arbiter) ⇒ false, row renders as before. */
  let queued: Bool
  /** Parked-request count when >1 (0 otherwise) — the one-liner reads
   *  "queued · N waiting" only when there is more than one waiting. */
  let waitingCount: Int
  /** The exception one-liner (paused / forced / queued / stale sessions only —
   *  DESIGN.md Exception-Only: a healthy session renders NO row). nil = healthy. */
  let exceptionLine: String?
}

/** One project row under the picked machine, as the arbiter publishes it:
 *  the client-reported values + the arbiter's per-project view (workers[],
 *  scheduling, today, budget_today). `me` marks the picked client's own
 *  worker row inside this project — the row the per-worker override acts
 *  on. */
struct ScopeProject {
  let name: String
  let depth: Int
  let finished: Int
  let failed: Int
  let tokensOut: Double
  let cap: Double
  let paused: Bool
  let budgetFull: Bool
  let idleSeconds: Double
  let maxLeases: Double
  let ttlSeconds: Double
  /** The GLOBAL grant knobs (scheduling.global) — the value an override
   *  falls back to. The panel's knob cycle cycles from THESE (a cycle
   *  that read the effective value would chase its own override). */
  let globalIdleSeconds: Double
  let globalMaxLeases: Double
  let globalTtlSeconds: Double
  let workersOnline: Int
  let workersTotal: Int
  let meOnline: Bool?
  let mePaused: Bool?
  let meQueuePreview: [ScopeQueueRow]
  let idleOverride: Double?
  let maxOverride: Double?
  let ttlOverride: Double?
}

/** The panel's data, projected PURELY from one state payload — the
 *  dashboard's standing convention (data comes straight from the payload;
 *  the menu bar recomputes nothing). Driven headlessly by the harness
 *  (menubar/scope-test.sh) with canned payloads, so what the tests prove
 *  is what ships.
 *
 *  The two levels of scope (machine × project) are decided here, not in
 *  the view:
 *    - the machine picker lists every clients[] row (online dot +
 *      last_seen);
 *    - "this machine" (the DEFAULT, and today's behaviour) is the row
 *      whose name equals the config's client_name — whatever the order in
 *      the payload. If the payload carries no row of that name (config
 *      without client_name, or this machine never registered), the
 *      picker defaults to the explicitly labelled "all machines"
 *      aggregate — the old first-online heuristic survives ONLY as that
 *      labelled fallback, never as the default;
 *    - the project picker lists the picked client's reported project
 *      names; the default "all projects" aggregates them (today's
 *      behaviour). The per-project rows always render, so a second
 *      project's depth/budget/results are never invisible. */
enum ScopeView {
  static let allMachinesKey = "__all_machines__"
  static let allProjectsKey = "__all_projects__"
  /** "Unset" machine selection (the model's placeholder before the first
   *  projection): project() resolves it to the DEFAULT (the name-matched
   *  row, else the labelled "all machines" fallback). The old first-
   *  online heuristic survives ONLY as that fallback's label, never as
   *  the default. */
  static let unsetMachineKey = "__unset__"

  /** One machine-picker option: a clients[] row, or the "all machines"
   *  fallback (the old heuristic, explicitly labelled — chosen by the
   *  operator, never the default). */
  struct MachineOption {
    var key: String
    var label: String
    var online: Bool
    var lastSeen: Double
  }

  struct Result {
    let machines: [MachineOption]
    /** The picked machine's key (a client_id or allMachinesKey). */
    var selectedMachine: String
    let machineLabel: String
    /** The picked client's reported project names (the project picker).
     *  Empty for the "all machines" aggregate (it projects the
     *  per-project view across every machine — no client-specific rows). */
    let projectNames: [String]
    var selectedProject: String
    let projects: [ScopeProject]
    let queueTotal: Int
    let finished: Int
    let failed: Int
    /** This client's running leases (ALL of them — max_concurrent_leases
     *  > 1 lists every concurrent lease). Empty for "all machines". */
    let leases: [ScopeLease]
    /** The picked project's published queue peek (empty when the worker
     *  publishes no preview — the panel degrades to the depth number). */
    let queuePreview: [ScopeQueueRow]
    /** Interactive sessions (#9) — global (the watched server's
     *  interactive traffic, not narrowed by the machine picker). */
    let sessions: [ScopeSession]
    /** The sessions count line ("2 active, 1 paused"); nil = no sessions
     *  registered = the whole sessions block hidden (Exception-Only). */
    let sessionsCountLine: String?
  }

  static func machineLabel(clientId: String?, name: String?) -> String {
    // id == name when the arbiter's name is a bare word (e.g. "mac-sam");
    // never show the id twice.
    if let id = clientId, let n = name, !n.isEmpty, id != n { return "\(n) (\(id))" }
    if let n = name, !n.isEmpty { return n }
    return clientId ?? "unknown"
  }

  static func machineLabel(clientId: String?, name: String?, allMachines: Bool) -> String {
    allMachines ? "all machines" : machineLabel(clientId: clientId, name: name)
  }

  /** Project one state payload (JSON dictionary) into the panel view for
   *  the operator's current picker selection.
   *  - configName: the config's client_name — the key that selects this
   *    machine's row whatever the payload order; nil → the "all machines"
   *    fallback is the default;
   *  - selectedMachine: a client_id / allMachinesKey; a
   *    key the payload no longer carries (a renamed/removed client)
   *    re-resolves to the default;
   *  - selectedProject: a project name / allProjectsKey; a name the
   *    picked client no longer reports falls back to allProjectsKey. */
  static func project(payload: [String: Any],
                      configName: String?,
                      selectedMachine: String,
                      selectedProject: String,
                      nowMs: Double) -> Result {
    let clients = (payload["clients"] as? [[String: Any]]) ?? []
    let clientRows: [ScopeClient] = clients.map { c in
      let projs = (c["projects"] as? [[String: Any]]) ?? []
      return ScopeClient(
        id: (c["client_id"] as? String) ?? "",
        name: (c["name"] as? String) ?? "",
        lastSeen: (c["last_seen"] as? Double) ?? 0,
        projectNames: projs.compactMap { $0["name"] as? String },
        overrideLabel: ((c["override"] as? [String: Any])?["override"] as? String) ?? nil,
        queueTotal: projs.compactMap { $0["queue_depth"] as? Int }.reduce(0, +)
      )
    }
    let projectRows = (payload["projects"] as? [[String: Any]]) ?? []

    // ---- machine picker options (every row; online = last_seen < 90s —
    // the same window the arbiter uses for workers; the row's own
    // last_seen is the client row's liveness — it carries no `online`
    // flag).
    let machines: [MachineOption] = clientRows.map { c in
      MachineOption(key: c.id,
                    label: machineLabel(clientId: c.id, name: c.name),
                    online: c.lastSeen > 0 && nowMs - c.lastSeen < 90_000,
                    lastSeen: c.lastSeen)
    }

    // ---- the picked machine. The DEFAULT is the name-matched row (the
    // config's client_name — registration is idempotent by name, so the
    // name survives daemon restarts). A requested key that no longer
    // exists re-resolves to the default; an absent configName (or no
    // matching row) lands on the explicitly labelled "all machines"
    // fallback — the old first-online heuristic is that fallback's
    // selection, never the default.
    let defaultKey: String
    if let cn = configName {
      defaultKey = clientRows.first(where: { $0.name == cn })?.id ?? allMachinesKey
    } else {
      defaultKey = allMachinesKey
    }
    let pickedKey: String
    if selectedMachine == allMachinesKey {
      pickedKey = allMachinesKey
    } else if clientRows.contains(where: { $0.id == selectedMachine }) {
      pickedKey = selectedMachine
    } else {
      pickedKey = defaultKey
    }
    let picked = clientRows.first(where: { $0.id == pickedKey })

    // ---- the scope's client rows: the picked machine, or EVERY machine
    // for the labelled aggregate (today's rows, minus the identity guess
    // — the default "all projects" sums over all of them exactly as
    // before).
    let scopeClients: [ScopeClient] =
      pickedKey == allMachinesKey ? clientRows : (picked.map { [$0] } ?? [])

    // ---- the picked client's project names (the project picker) —
    // the client's OWN reported rows, in payload order. The "all machines"
    // aggregate has no client-specific project rows: its projects come
    // from the arbiter's per-project view (the union every machine
    // reports), so the picker lists those.
    let projectNames: [String]
    if let p = picked {
      projectNames = p.projectNames
    } else {
      projectNames = projectRows.compactMap { $0["name"] as? String }
    }

    // ---- the picked project. A name the picked client no longer reports
    // (a project dropped from its config since the last tick) falls back
    // to allProjectsKey.
    let projKey: String = projectNames.contains(selectedProject)
      ? selectedProject : allProjectsKey

    // ---- project rows for the scope: the arbiter's per-project view
    // (workers[], scheduling, today, budget_today) narrowed to the scope's
    // client rows (a project with NO worker in the scope is not listed —
    // the same way today's aggregate only saw the picked client's
    // projects).
    var projects: [ScopeProject] = []
    for pr in projectRows {
      let pName = (pr["name"] as? String) ?? ""
      guard !pName.isEmpty else { continue }
      let workers = (pr["workers"] as? [[String: Any]]) ?? []
      guard workers.contains(where: { w in
        scopeClients.contains(where: { $0.name == ((w["client"] as? String) ?? "") })
      }) else { continue }
      let sched = (pr["scheduling"] as? [String: Any]) ?? [:]
      let today = (pr["today"] as? [String: Any]) ?? [:]
      let budget = (pr["budget_today"] as? [String: Any]) ?? [:]
      // The me-row: the picked client's own worker row inside this project
      // (the per-worker override acts on it). nil for "all machines" (there
      // is no single me) — the panel then shows no worker-gate control.
      let meRow = (pickedKey == allMachinesKey ? nil : workers.first { w in
        (w["client"] as? String) == picked?.name
      })
      let overrides = (sched["overrides"] as? [String: Any]) ?? [:]
      let globals = (sched["global"] as? [String: Any]) ?? [:]
      let dNum: (Any?) -> Double? = { (v: Any?) in (v as? NSNumber)?.doubleValue }
      let tokensOut = dNum(budget["tokens_out"]) ?? 0
      let cap = dNum(sched["daily_token_cap"]) ?? 0
      // Budget full = the dashboard's own rule (index.html): a FINITE cap
      // (MAX_SAFE_INTEGER = ∞) that the day's tokens_out has reached.
      let finiteCap = cap > 0 && cap < 9_007_199_254_740_992
      let idle = (sched["idle_seconds"] as? NSNumber)?.doubleValue ?? 0
      let maxl = (sched["max_concurrent_leases"] as? NSNumber)?.doubleValue ?? 0
      let ttl = (sched["lease_ttl_seconds"] as? NSNumber)?.doubleValue ?? 0
      // The SCOPE's share of the project: the picked machine's own worker
      // rows (for "all machines": every row — the aggregate is the sum of
      // its parts, the dashboard's own rule). `workers` itself is the
      // project's GLOBAL roster (every machine reporting it).
      let scopeWorkers = workers.filter { w in
        scopeClients.contains { sc in (w["client"] as? String) == sc.name }
      }
      projects.append(ScopeProject(
        name: pName,
        depth: scopeWorkers.compactMap { $0["queue_depth"] as? Int }.reduce(0, +),
        finished: (today["finished"] as? NSNumber)?.intValue ?? 0,
        failed: (today["failed"] as? NSNumber)?.intValue ?? 0,
        tokensOut: tokensOut,
        cap: cap,
        paused: (sched["paused"] as? Bool) == true,
        budgetFull: finiteCap && tokensOut >= cap,
        idleSeconds: idle,
        maxLeases: maxl,
        ttlSeconds: ttl,
        globalIdleSeconds: dNum(globals["idle_seconds"]) ?? idle,
        globalMaxLeases: dNum(globals["max_concurrent_leases"]) ?? maxl,
        globalTtlSeconds: dNum(globals["lease_ttl_seconds"]) ?? ttl,
        workersOnline: scopeWorkers.filter { ($0["online"] as? Bool) == true }.count,
        workersTotal: scopeWorkers.count,
        meOnline: meRow.flatMap { $0["online"] as? Bool },
        mePaused: meRow.flatMap { (($0["stats"] as? [String: Any])?["paused"] as? Bool) },
        meQueuePreview: (meRow?["queue_preview"] as? [[String: Any]])?.compactMap { r in
          let title = (r["title"] as? String) ?? (r["job_id"] as? String) ?? ""
          let company = (r["company"] as? String) ?? ""
          return ScopeQueueRow(title: title, company: company)
        } ?? [],
        idleOverride: dNum(overrides["idle_seconds"]),
        maxOverride: dNum(overrides["max_concurrent_leases"]),
        ttlOverride: dNum(overrides["lease_ttl_seconds"])
      ))
    }

    // ---- the picked project's values. "all projects" = the sum of its
    // parts (today's aggregate, built from the published per-project
    // rows — never recomputed from raw client data). A specific project =
    // that row's own published values.
    let pickedProj = (projKey == allProjectsKey ? nil : projects.first { $0.name == projKey })
    let queueTotal = pickedProj.map { $0.depth } ?? projects.map { $0.depth }.reduce(0, +)
    let finished = pickedProj.map { $0.finished } ?? projects.map { $0.finished }.reduce(0, +)
    let failed = pickedProj.map { $0.failed } ?? projects.map { $0.failed }.reduce(0, +)
    let queuePreview = pickedProj?.meQueuePreview ?? []

    // ---- interactive sessions (#9): the arbiter's sessions[] rows, each
    // carrying its active operator override ({override: "pause"|"force",
    // until, set_at} or null). Sessions are the watched server's
    // INTERACTIVE traffic — global, not narrowed by the machine picker
    // (attribution rides client_name, shown in the one-liner). The menubar
    // only DISPLAYS them (read-only; pause/resume lives on the dashboard).
    // The stale verdict mirrors daemonRunning's 90s window.
    let sessionRows = (payload["sessions"] as? [[String: Any]]) ?? []
    let sessions: [ScopeSession] = sessionRows.compactMap { s in
      guard let tok = (s["token"] as? String), !tok.isEmpty else { return nil }
      let lastSeen = (s["last_seen"] as? Double) ?? 0
      let stale = nowMs - lastSeen > 90_000
      let ov = (s["override"] as? [String: Any])?["override"] as? String
      let label = (ov == "pause" || ov == "force") ? ov : nil
      let name = (s["client_name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
      let lastActivity = (s["last_activity"] as? Double).flatMap { $0 == 0 ? nil : $0 }
      // Gate-state (#40): the router's parked-request block. Absent /
      // null / malformed (old arbiter) ⇒ not queued, row renders as before.
      let gateBlk = (s["gate"] as? [String: Any])
      let queued = (gateBlk?["state"] as? String) == "queued"
      let waiting = (gateBlk?["waiting"] as? Double).map { Int($0) } ?? 0
      // Exception-only one-liner (DESIGN.md): a healthy session renders NO
      // row. The session is named by its router's client_name when the
      // router identified itself, else by a short token prefix.
      let who = name ?? String(tok.prefix(8)) + "…"
      // Word order mirrors the desktop row: override, then queued, then
      // stale — every applicable fact shows (paused+queued shows both).
      var words: [String] = []
      if label == "pause" { words.append("paused") }
      else if label == "force" { words.append("forced") }
      if queued { words.append(waiting > 1 ? "queued · \(waiting) waiting" : "queued") }
      if stale { words.append("stale") }
      let line = words.isEmpty ? nil : "\(who) · " + words.joined(separator: " · ")
      return ScopeSession(token: tok, clientName: name, lastSeen: lastSeen,
                          lastActivity: lastActivity, overrideLabel: label,
                          stale: stale, queued: queued,
                          waitingCount: waiting > 1 ? waiting : 0,
                          exceptionLine: line)
    }
    // The count line (the only always-on sessions row, and only when
    // sessions exist): plain words, zero buckets omitted —
    // "2 active, 1 paused". nil = no sessions = NO row at all.
    let sessionsCountLine: String? = sessions.isEmpty ? nil : {
      var parts: [String] = []
      let n: (_ pred: (ScopeSession) -> Bool) -> Int = { f in sessions.filter(f).count }
      let activeN = n { $0.overrideLabel == nil && !$0.stale }
      let pausedN = n { $0.overrideLabel == "pause" }
      let forcedN = n { $0.overrideLabel == "force" }
      let staleN = n { $0.overrideLabel == nil && $0.stale }
      if activeN > 0 { parts.append("\(activeN) active") }
      if pausedN > 0 { parts.append("\(pausedN) paused") }
      if forcedN > 0 { parts.append("\(forcedN) forced") }
      if staleN > 0 { parts.append("\(staleN) stale") }
      return parts.joined(separator: ", ")
    }()

    // ---- the running leases. For a picked client: EVERY active lease of
    // that client (max_concurrent_leases > 1 → all of them). For "all
    // machines": none — the aggregate has no single lease owner to show
    // (the icon's spin stays tied to this client's leases, which for the
    // default scope is the name-matched row).
    let activeLeases = (payload["active_leases"] as? [[String: Any]]) ?? []
    let leases: [ScopeLease] = (pickedKey == allMachinesKey ? [] : activeLeases.filter {
      ($0["client_id"] as? String) == picked?.id
    }).map { l in
      ScopeLease(jobId: (l["job_id"] as? String) ?? "?",
                 project: (l["project"] as? String) ?? "",
                 expiresAt: (l["expires_at"] as? Double) ?? 0)
    }

    let machineLabel: String = {
      if pickedKey == allMachinesKey { return "all machines" }
      return machineLabel(clientId: picked?.id, name: picked?.name)
    }()

    return Result(machines: machines,
                  selectedMachine: pickedKey,
                  machineLabel: machineLabel,
                  projectNames: projectNames,
                  selectedProject: projKey,
                  projects: projects,
                  queueTotal: queueTotal,
                  finished: finished,
                  failed: failed,
                  leases: leases,
                  queuePreview: queuePreview,
                  sessions: sessions,
                  sessionsCountLine: sessionsCountLine)
  }
}

final class AppModel: ObservableObject {
  @Published var conn: Conn = .off
  @Published var daemonRunning = false
  // The scope (issue #12): the machine × project pickers drive which rows
  // the panel shows. The DEFAULT is "this machine · all projects" — the
  // name-matched client row (the config's client_name) and its aggregate —
  // exactly today's behaviour; the pickers let the operator widen it.
  @Published var machine: ScopeView.MachineOption
    = ScopeView.MachineOption(key: ScopeView.unsetMachineKey, label: "…",
                              online: false, lastSeen: 0)
  @Published var projectKey: String = ScopeView.allProjectsKey
  @Published var scopeProjects: [ScopeProject] = []
  @Published var queueDepth = 0
  @Published var today: (finished: Int, failed: Int) = (0, 0)
  @Published var leases: [ScopeLease] = []
  @Published var queuePreview: [ScopeQueueRow] = []
  /// Interactive sessions (#9) — read-only display (the controls live on
  /// the dashboard). Global: the watched server's interactive traffic, not
  /// narrowed by the machine picker.
  @Published var sessions: [ScopeSession] = []
  /// The sessions count line ("2 active, 1 paused"); nil = no sessions —
  /// the whole block hidden (Exception-Only rule).
  @Published var sessionsCountLine: String? = nil
  @Published var lastSeenS: Int? = nil
  /// Every clients[] row from the last payload (the machine picker's
  /// options; the "all machines" aggregate row is added by viewMachines).
  @Published var machines: [ScopeView.MachineOption] = []
  /// The published per-project token budget for the picked project
  /// ("all projects" sums the parts; a hidden row = the scope has no
  /// budget data yet).
  @Published var tokensToday: (label: String, cap: Double, value: Double) = ("", 0, 0)
  @Published var tokenRowVisible = false
  /// The revision of THIS checkout's tree, as the operator should read it:
  /// `git rev-parse --short HEAD`. Refreshed at launch (init), on every
  /// completed Update Code, and on each poll tick since issue #49 — the
  /// old "only Update Code changes it" premise is exactly what a direct
  /// merge/pull breaks, and the daemon-behind comparison needs the
  /// CURRENT HEAD (a stale cache would hide the exception it exists to
  /// show). A non-git repo leaves it nil and the revision row stays
  /// hidden until a successful read.
  @Published var deployedRevision: String? = nil
  /** Code-staleness (issue #49): true when the daemon's reported boot
   *  commit and this checkout's HEAD differ — i.e. the running process
   *  predates the tree it runs from (launchd `KeepAlive` relaunches only
   *  on crash, so a direct merge/push never restarts it and the release
   *  `version` handshake cannot see it). Exception-only: no tag when the
   *  daemon reports no revision (an old daemon) or this app cannot read
   *  its own HEAD. */
  @Published var daemonBehind = false
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
  /// The gitignored client config, parsed ONCE at launch (token + server
  /// URL + client_name). Replaces the old token()/serverURL() pair, each of
  /// which re-read + re-parsed the same file per call.
  let config: ClientConfig = ClientConfig.load(
    path: (AppModel.findRepoRoot() as NSString).appendingPathComponent("client/config.json"))
  /** The config path the app's own repo discovery resolved to (the
   *  operator-visible "the token lives in <path>" fact). */
  var configPath: String {
    (repoRoot as NSString).appendingPathComponent("client/config.json")
  }

  // The baked version (substituted at build time by menubar/build.sh — the
  // `__MENUBAR_VERSION__` placeholder carries the release tag's version, so
  // the binary prints the release it was built from). A dev build where the
  // placeholder was never substituted reports itself as a dev build.
  let version = AppModel.bakedVersion()
  /// Update available — exception-only, the panel's row renders when
  /// non-nil. A RELEASES-channel value is the release's BARE version
  /// (a release number `1` or a legacy `0.0.2`); a BRANCH-channel value
  /// is the tip's EDGE MARKER (`edge-<branch>-<sha7>` — a non-numeric
  /// marker is a first-class value, not a malformed version).
  @Published var updateAvailable: String? = nil
  /// The channel an available update comes from (issue #26) — "releases"
  /// or the tracked branch name; nil until the first check resolves one.
  /// The install path routes on it: a release value resolves to
  /// `v<bare>` + the numbered zip name; an edge value is its OWN tag
  /// (the marker) with the marker-named menubar zip.
  @Published var updateChannel: String? = nil

  // MARK: panel action block (pure — the harness asserts what renders)

  /** One row of the panel's action block: label + the render options.
   *  `dividerBefore` places the hairline above the row (the block's
   *  visual groups). */
  struct PanelActionRow {
    let label: String
    var arrow: Bool = false
    var dividerBefore: Bool = false
    var tag: (text: String, color: Color)? = nil
  }

  /** The exception-only update indicator on the `Open Desktop` row: the
   *  `updateAvailable` value VERBATIM (a release number `1`, a legacy
   *  `0.0.2`, an edge marker `edge-main-a9787a7`) in the panel's tag
   *  color (amber — the exception color the paused/budget tags use);
   *  nil (no update) -> NO tag: label-only row, no empty tag box, no dim
   *  "current" mark (DESIGN.md Exception-Only rule). Pure so the headless
   *  harness proves exactly what renders. */
  static func desktopRowTag(updateAvailable: String?) -> (text: String, color: Color)? {
    guard let v = updateAvailable else { return nil }
    return (v, Pal.warn)
  }

  /** The action block's row SET (issue #27): Open Dashboard · Show Logs ·
   *  Start/Stop · Restart · Open Desktop (always-on; right half carries
   *  `desktopRowTag`) · Install Update <v> (exception-only). NO Update
   *  Code, NO Quit — the panel door is gone, the machinery stays. The
   *  view renders THIS list, so the harness asserts the shipped panel. */
  static func panelActionRows(updateAvailable: String?, daemonRunning: Bool) -> [PanelActionRow] {
    var rows: [PanelActionRow] = [
      PanelActionRow(label: "Open Dashboard", arrow: true),
      PanelActionRow(label: "Show Logs"),
      PanelActionRow(label: daemonRunning ? "Stop" : "Start", dividerBefore: true),
      PanelActionRow(label: "Restart"),
      PanelActionRow(label: "Open Desktop", dividerBefore: true,
                     tag: desktopRowTag(updateAvailable: updateAvailable)),
    ]
    if let v = updateAvailable {
      rows.append(PanelActionRow(label: "Install Update \(v)"))
    }
    return rows
  }

  /** The panel's `daemon behind` exception rule (issue #49), PURE so the
   *  headless harness proves what renders. `reported` is the daemon's boot
   *  commit from the client row (`revision`), `checkout` this app's own
   *  `git rev-parse --short HEAD`. The daemon reports the FULL SHA; the
   *  checkout value is short — a short form is unique in this repo (the
   *  update machinery already relies on short-sha identity), so an
   *  unambiguous prefix match counts as the SAME commit. Any real
   *  mismatch → true (the flag's only clear path is a daemon restart,
   *  which re-registers with the new boot commit on its next heartbeat).
   *  Absent/blank on either side (an old daemon, an unreadable checkout)
   *  → false: render exactly as before. */
  static func daemonBehind(reported: String?, checkout: String?) -> Bool {
    let r = (reported ?? "").trimmingCharacters(in: .whitespaces).lowercased()
    let h = (checkout ?? "").trimmingCharacters(in: .whitespaces).lowercased()
    guard !r.isEmpty, !h.isEmpty else { return false }
    return !(r == h || r.hasPrefix(h) || h.hasPrefix(r))
  }

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
    // A missing token is a DISTINCT state from an unreachable arbiter
    // (criterion 5): "no token" (amber) vs "unreachable" (red) — the
    // operator cannot tell an unconfigured client from a dead server any
    // other way. The 10s poll retries and the word switches on its own
    // once a token appears in the config.
    if config.token == nil { conn = .noToken }
    // The cadence clamp (issue #27): a configured value below the floor
    // is clamped — the clamp is logged ONCE at launch to the menubar log
    // (never the panel; the panel stays exception-free for a local config
    // quirk that is already resolved).
    if let raw = config.updateCheckClampedFrom {
      let logDir = (repoRoot as NSString).appendingPathComponent("logs")
      try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
      UpdateLog.append("update_check_minutes \(raw) below floor \(UpdateCheck.cadenceMinutesMin) — clamped to \(config.updateCheckMinutes) (\(UpdateLog.nowISO()))",
                       at: (logDir as NSString).appendingPathComponent(UpdateLog.fileName))
    }
    // The release check (update story): once at launch, then every
    // `update_check_minutes` (config; default 360 = 6h — issue #27 made
    // the cadence explicit; the value is read ONCE at launch like every
    // other config key — a relaunch picks up a new one).
    // Offline-tolerant — any failure sets nothing and fails quiet.
    checkForUpdates()
    Timer.scheduledTimer(withTimeInterval: TimeInterval(config.updateCheckMinutes * 60), repeats: true) { [weak self] _ in
      self?.checkForUpdates()
    }
  }

  static func findRepoRoot(bundlePath: String = Bundle.main.bundleURL.path) -> String {
    // Returns the REPO ROOT — the dir that CONTAINS `client/` (every caller
    // does repoRoot + "client/…"). IDLEFILL_CONFIG_FILE is a path to
    // client/config.json, so strip two components to get the repo.
    // GUARD: an env value without at least two path components (a bare
    // filename) would collapse to the filesystem ROOT — the one-level-deeper
    // bug class this file has hit before — so treat it as unset and fall
    // through to the binary-location discovery.
    if let p = ProcessInfo.processInfo.environment["IDLEFILL_CONFIG_FILE"] {
      let parent = (p as NSString).deletingLastPathComponent
      let root = (parent as NSString).deletingLastPathComponent
      if !(parent.isEmpty || root.isEmpty) { return root }
    }
    // The binary ships at <repo>/menubar/IdlefillMenubar.app — bundleURL
    // points at the BUNDLE (…/menubar/IdlefillMenubar.app), so the repo
    // root is TWO levels up. The legacy bare-binary shape (…/menubar/
    // IdlefillMenubar, pre-bundle) puts bundleURL at <repo>/menubar — ONE
    // level up. Probe bundleURL and its two parents: the first candidate
    // that carries client/config.json wins. (The old single-level
    // assumption was a real bug: a bundle launch resolved to <repo>/
    // menubar, found no config there, and the home walk below cannot
    // DESCEND into ~/Software/… — the agent then ran token-less, ignored
    // the configured update channel, and checked the wrong channel.)
    let fm = FileManager.default
    var cand = bundlePath
    for _ in 0..<3 {
      if fm.fileExists(atPath: (cand as NSString).appendingPathComponent("client/config.json")) {
        return cand
      }
      let parent = (cand as NSString).deletingLastPathComponent
      if parent == cand { break }
      cand = parent
    }
    // Fallback: the operator's standard checkout location (the desktop
    // app's default — same shape), then a bounded walk UP from $HOME.
    // Note the walk can only find repos AT or ABOVE $HOME — a repo nested
    // under it (e.g. ~/Software/idlefill) needs the binary location above,
    // this default, or IDLEFILL_CONFIG_FILE.
    let def = (NSHomeDirectory() as NSString).appendingPathComponent("Software/idlefill")
    if fm.fileExists(atPath: (def as NSString).appendingPathComponent("client/config.json")) {
      return def
    }
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

  /** The client config's arbiter token (parsed once at launch — see
   *  `config`). The Authorization header is the ONLY place it rides; it is
   *  never printed, logged, or baked into the bundle. */
  var arbiterToken: String? { config.token }

  /** The arbiter URL (config's server_url, parsed once at launch). */
  func serverURL() -> String { config.serverURL }

  // MARK: poll

  func poll() {
    guard let tok = arbiterToken else {
      // DISTINCT on screen from a dead arbiter (criterion 5): the word is
      // "no token" (amber — a local misconfiguration), not "unreachable"
      // (red — the server is down). No request is issued; the 10s retry
      // switches the word on its own once a token appears in the config.
      conn = .noToken
      return
    }
    var req = URLRequest(url: URL(string: serverURL() + "/api/state")!)
    req.timeoutInterval = 5
    req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
    URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
      guard let self else { return }
      DispatchQueue.main.async {
        if let e = resp as? HTTPURLResponse, e.statusCode == 401 {
          // A WRONG token (the config's token is no longer valid) is
          // operator-actionable and must not read as a dead server.
          self.conn = .unauthorized
          return
        }
        self.apply(data)
      }
    }.resume()
  }

  /** Test hook (the scope harness): inject a state payload as if the
   *  poll had just received it — the SAME path the poll drives (apply).
   *  INERT in the production app: nothing but the harness calls it, and
   *  it performs no network of its own (the harness needs the model's
   *  picker state without the no-token model ever polling — a stray
   *  request would itself be the failure being tested). */
  func injectStatePayload(_ o: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: o) else { return }
    apply(data)
  }

  private func apply(_ data: Data?) {
    guard let data, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      conn = .unreachable
      return
    }
    // The pure scope projection (ScopeView — the harness's target): the
    // machine × project pickers' state + every value the panel shows, all
    // straight from the payload. A token that just appeared clears the
    // "no token" state.
    conn = .off
    lastPayload = o
    let nowMs = Date().timeIntervalSince1970 * 1000
    let view = ScopeView.project(payload: o,
                                 configName: config.clientName,
                                 selectedMachine: machine.key,
                                 selectedProject: projectKey,
                                 nowMs: nowMs)
    applyProjection(view, nowMs: nowMs, o: o)
  }

  /** Applies the pure projection to the model's state. Shared by apply()
   *  (the 10s poll) and reproject() (a picker selection — no network; the
   *  data stays the last payload's). */
  private func applyProjection(_ view: ScopeView.Result, nowMs: Double, o: [String: Any]) {
    // A picker key the payload no longer carries (a renamed/removed
    // client, a dropped project) re-resolves to the default — the model
    // tracks the RESOLVED selection so the next tick stays put.
    machine = ScopeView.MachineOption(key: view.selectedMachine,
                                      label: view.machineLabel,
                                      online: view.machines.first(where: { $0.key == view.selectedMachine })?.online ?? false,
                                      lastSeen: view.machines.first(where: { $0.key == view.selectedMachine })?.lastSeen ?? 0)
    machines = view.machines
    projectKey = view.selectedProject
    scopeProjects = view.projects
    queueDepth = view.queueTotal
    today = (view.finished, view.failed)
    leases = view.leases
    queuePreview = view.queuePreview
    sessions = view.sessions
    sessionsCountLine = view.sessionsCountLine
    // The picked project's published token budget ("all projects" sums the
    // parts — the aggregate equals the sum of its parts). Hidden while the
    // scope has no budget rows at all (a fresh arbiter state).
    if view.projects.isEmpty {
      tokensToday = ("", 0, 0)
      tokenRowVisible = false
    } else {
      let isAll = projectKey == ScopeView.allProjectsKey
      let value = view.projects.map { $0.tokensOut }.reduce(0, +)
      let finite = view.projects.map { $0.cap > 0 && $0.cap < 9_007_199_254_740_992 ? $0.cap : 0 }.reduce(0, +)
      tokensToday = (isAll ? "all projects" : projectKey, finite, value)
      tokenRowVisible = true
    }
    // Liveness. TWO distinct facts, kept distinct (the row displayed and
    // the process controlled can belong to different machines — nothing
    // on screen may blur that):
    //   - `daemonRunning` (drives the Start/Stop row) is the LOCAL
    //     daemon's liveness — the name-matched row ("this machine") —
    //     because those controls act on the local process table
    //     (daemonPID()), whatever the picker shows. No name match (a
    //     fresh config / unregistered machine) falls back to the
    //     freshest row — the old heuristic, now only ever a fallback.
    //   - the status row's STALENESS is the SCOPE machine's last_seen
    //     (the operator is looking at that machine's row; "all machines"
    //     = the freshest row).
    let clients = (o["clients"] as? [[String: Any]]) ?? []
    let meLastSeen: Double
    if let cn = config.clientName,
       let c = clients.first(where: { ($0["name"] as? String) == cn }) {
      meLastSeen = (c["last_seen"] as? Double) ?? 0
    } else {
      meLastSeen = clients.compactMap { $0["last_seen"] as? Double }.max() ?? 0
    }
    daemonRunning = meLastSeen > 0 && nowMs - meLastSeen < 90_000
    // Code-staleness (issue #49): compare the daemon's boot `revision`
    // (same name-matched row the liveness above reads) against THIS
    // checkout's CURRENT HEAD. The launch-only `deployedRevision` cache
    // cannot serve this: its "the revision only changes when Update Code
    // runs" premise is exactly what direct merges/pulls break — the tree
    // moves ahead and neither the daemon nor the cache moves with it. So
    // the poll refreshes the value (one local `git rev-parse --short
    // HEAD`, ~ms, every 10s — cheap and it makes the revision row
    // honest too: after a direct pull the panel shows the tree's new
    // HEAD and the daemon-behind tag together). Exception-only: an old
    // daemon that reports no revision renders as before. The comparison
    // is client-side by design: the arbiter has no view of the
    // operator's repo tree.
    if let rev = UpdateLog.currentRevision(repo: repoRoot) { deployedRevision = rev }
    let meRevision: String?
    if let cn = config.clientName,
       let c = clients.first(where: { ($0["name"] as? String) == cn }) {
      meRevision = (c["revision"] as? String)
    } else {
      meRevision = nil
    }
    daemonBehind = Self.daemonBehind(reported: meRevision, checkout: deployedRevision)
    let scopeRows: [Double]
    if machine.key == ScopeView.allMachinesKey {
      scopeRows = clients.compactMap { $0["last_seen"] as? Double }
    } else {
      scopeRows = clients.compactMap { row in
        ((row["client_id"] as? String) == machine.key) ? (row["last_seen"] as? Double) : nil
      }
    }
    let scopeLastSeen = scopeRows.max() ?? 0
    if scopeLastSeen > 0 {
      lastSeenS = Int(nowMs - scopeLastSeen) / 1000
    }

    // the state word — the arbiter's GLOBAL verdict for the box (a scope
    // the operator picked never rewords the header): degraded is a
    // box-wide condition, idle is the arbiter's own signal, and "working"
    // = ANY active lease (the box is running an idle task right now). A
    // payload with NO client rows at all is still .unreachable — the
    // arbiter answering without any registered client is indistinguishable
    // from a dead one (today's semantics).
    guard !clients.isEmpty else { conn = .unreachable; return }
    let idle = (o["idle"] as? [String: Any]) ?? [:]
    switch ((idle["degraded"] as? Bool) == true, activeLeasesGlobal(o).isEmpty, (idle["idle"] as? Bool) == true) {
    case (true, _, _): conn = .degraded
    case (false, false, _): conn = .working
    case (false, true, true): conn = .idle
    default: conn = .busy
    }
  }

  /** Every ACTIVE lease in the payload (scope-independent — the header
   *  word is the arbiter's verdict for the box, not for a picked machine). */
  private func activeLeasesGlobal(_ o: [String: Any]) -> [[String: Any]] {
    ((o["active_leases"] as? [[String: Any]]) ?? []).filter {
      ($0["status"] as? String ?? "active") == "active"
    }
  }

  // MARK: view-facing scope facts (pure reads of the model state)

  /** The machine picker's rows: the explicitly labelled "all machines"
   *  aggregate FIRST, then every clients[] row (the dot = online). The
   *  default selection ("this machine" — the name-matched row) sits
   *  among its siblings; nothing about the picker's layout changes when
   *  the operator widens the scope. */
  var viewMachines: [ScopeView.MachineOption] {
    let all = ScopeView.MachineOption(key: ScopeView.allMachinesKey,
                                      label: "all machines", online: false, lastSeen: 0)
    return [all] + machines
  }

  /** The machine row's active override (exception-only tag; nil = none). */
  func viewMachineOverride(_ key: String) -> String? {
    guard key != ScopeView.allMachinesKey, let o = lastPayload else { return nil }
    return ((o["clients"] as? [[String: Any]])?.first(where: { ($0["client_id"] as? String) == key })?["override"] as? [String: Any])?["override"] as? String
  }

  /** The project-gate control row exists only for a picked (non-aggregate)
   *  project — exception-only, the dashboard's same rule. */
  var pickedProjectVisible: Bool { pickedProject != nil }

  /** The project gate's LIVE label ("pause project X" / "resume project
   *  X" — the state is in the label, not in a separate badge). */
  var pickedProjectLabel: String {
    guard let p = pickedProject else { return "" }
    return (p.paused ? "resume project " : "pause project ") + p.name
  }

  /** The worker-override control row's LIVE label (a specific machine
   *  only — "all machines" has no single worker to act on; nil hides it).
   *  none → pause; pause → resume (clear); force → clear force. */
  var scopeWorkerControlLabel: String? {
    guard machine.key != ScopeView.allMachinesKey, lastPayload != nil else { return nil }
    switch scopeMachineOverride ?? "none" {
    case "pause": return "resume this worker"
    case "force": return "clear force (this worker)"
    default: return "pause this worker"
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

  // MARK: scope pickers (issue #12)
  //
  // The machine × project pickers are model state: a selection re-runs the
  // pure ScopeView projection against the LAST state payload (no network —
  // the next 10s tick refreshes the data under the new selection). A key
  // the last payload does not carry is rejected (the picker rows only ever
  // come from the last payload).

  /** The last raw state payload (the picker re-projection's input; nil
   *  until the first successful poll). */
  private var lastPayload: [String: Any]?

  func selectMachine(_ key: String) {
    guard lastPayload != nil,
          key == ScopeView.allMachinesKey ||
          (lastPayload?["clients"] as? [[String: Any]])?.contains(where: { ($0["client_id"] as? String) == key }) == true
    else { return }
    machine.key = key
    machine.online = false
    machine.lastSeen = 0
    reproject()
  }

  func selectProject(_ key: String) {
    guard lastPayload != nil,
          key == ScopeView.allProjectsKey ||
          scopeProjects.contains(where: { $0.name == key })
    else { return }
    projectKey = key
    reproject()
  }

  private func reproject() {
    guard let o = lastPayload else { return }
    let nowMs = Date().timeIntervalSince1970 * 1000
    let view = ScopeView.project(payload: o,
                                 configName: config.clientName,
                                 selectedMachine: machine.key,
                                 selectedProject: projectKey,
                                 nowMs: nowMs)
    applyProjection(view, nowMs: nowMs, o: o)
  }

  // MARK: scope controls (issue #12)
  //
  // The published per-scope detail drives the panel's exception-only
  // controls on the routes that ALREADY exist (no new endpoints — the
  // dashboard's token gate is the reference, scripts/idlefill-control.mjs):
  //   project pause gate     POST /api/projects/:name            {paused}
  //   grant knobs            POST /api/projects/:name/settings   {knobs}
  //   worker override        POST /api/clients/:ref/override     {override, until}
  // SAME token gate as the dashboard: no token → NO request is issued and
  // the status row names the missing token.

  /** The picked project row (nil for the "all projects" aggregate). */
  private var pickedProject: ScopeProject? {
    projectKey == ScopeView.allProjectsKey ? nil : scopeProjects.first { $0.name == projectKey }
  }

  /** The picked client's row in the last payload (the worker override's
   *  `:ref` — the client NAME, the key that survives daemon restarts). */
  private var pickedClientRef: String? {
    guard let o = lastPayload else { return nil }
    if machine.key == ScopeView.allMachinesKey { return nil }
    return (o["clients"] as? [[String: Any]])?.first(where: { ($0["client_id"] as? String) == machine.key })?["name"] as? String
  }

  /** Toggle the picked project's pause gate (POST /api/projects/:name).
   *  Token-gated: no token → no request, and the status row names the
   *  missing token (criterion 4). */
  func toggleProjectPaused() {
    guard let p = pickedProject else { return }
    guard arbiterToken != nil else {
      updateNote = "no token configured — project gate needs the arbiter token (\(configPath)) — no request sent"
      return
    }
    postJSON(path: "/api/projects/\(Self.urlEncode(p.name))",
             body: ["paused": !p.paused],
             ok: "project \(p.paused ? "resumed" : "paused")",
             detail: p.name)
  }

  /** Cycle the picked project's grant knobs through
   *  global → 2 × global → 3 × global → global (POST
   *  /api/projects/:name/settings — the body carries only the touched
   *  knob; JSON null clears the override back to the global). The cycle
   *  reads the GLOBAL knob (scheduling.global), never the effective one —
   *  a cycle that read the effective value would chase its own override.
   *  Token-gated like the gate. */
  func cycleProjectKnob(_ knob: String) {
    guard let p = pickedProject else { return }
    guard arbiterToken != nil else {
      updateNote = "no token configured — grant knobs need the arbiter token (\(configPath)) — no request sent"
      return
    }
    let global: Double
    let current: Double?
    switch knob {
    case "idle": global = p.globalIdleSeconds; current = p.idleOverride
    case "max": global = p.globalMaxLeases; current = p.maxOverride
    default: global = p.globalTtlSeconds; current = p.ttlOverride
    }
    let next: Double? = current == nil ? global * 2 : (current == global * 2 ? global * 3 : nil)
    let key = knob == "idle" ? "idle_seconds" : (knob == "max" ? "max_concurrent_leases" : "lease_ttl_seconds")
    // null (JSON) clears the knob back to the global — the dashboard's
    // same shape (NSNull: a nil Optional would not serialize at all).
    let value: Any = next.map { $0 as Any } ?? NSNull()
    let body: [String: Any] = [key: value]
    postJSON(path: "/api/projects/\(Self.urlEncode(p.name))/settings",
             body: body,
             ok: "project \(p.name) \(knob) → \(next.map { String(Int($0)) } ?? "global")",
             detail: p.name)
  }

  /** Cycle the picked client's worker override: none → pause → force →
   *  none (POST /api/clients/:ref/override — the body is exactly
   *  {override, until}). Token-gated like the gate. */
  func cycleWorkerOverride() {
    guard let ref = pickedClientRef else { return }
    guard arbiterToken != nil else {
      updateNote = "no token configured — worker override needs the arbiter token (\(configPath)) — no request sent"
      return
    }
    let cur = scopeMachineOverride ?? "none"
    let next: String
    switch cur {
    case "pause": next = "force"
    case "force": next = "none"
    default: next = "pause"
    }
    postJSON(path: "/api/clients/\(Self.urlEncode(ref))/override",
             body: ["override": next == "none" ? NSNull() : next, "until": NSNull()],
             ok: "worker \(ref) → \(next)",
             detail: ref)
  }

  /** The picked machine's active override (from the last payload; nil =
   *  none) — drives the worker control row's label. */
  private var scopeMachineOverride: String? {
    guard let o = lastPayload, machine.key != ScopeView.allMachinesKey else { return nil }
    return ((o["clients"] as? [[String: Any]])?.first(where: { ($0["client_id"] as? String) == machine.key })?["override"] as? [String: Any])?["override"] as? String
  }

  /** Token-gated POST to an existing route. No token → the caller has
   *  already refused (the status row names the missing token) — this
   *  method issues NO request without one. On 2xx the note confirms; on
   *  anything else the note carries the HTTP status (the operator can
   *  then look at the arbiter). The body is exactly what the route
   *  documents — NSNull() serializes as JSON null (the clear-value shape). */
  private func postJSON(path: String, body: [String: Any], ok: String, detail: String) {
    guard let tok = arbiterToken,
          let url = URL(string: serverURL() + path) else {
      // Belt-and-braces: the public entry points (toggleProjectPaused &
      // co.) already gate on the token and name it in the status row.
      updateNote = "no token configured — no request sent (\(detail))"
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.timeoutInterval = 5
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
    do { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
    catch { updateNote = "could not encode the \(detail) request — no request sent"; return }
    updateNote = "sending \(detail) …"
    URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
      guard let self else { return }
      DispatchQueue.main.async {
        if let e = err {
          self.updateNote = "\(detail) failed: \(e.localizedDescription)"
        } else if let r = resp as? HTTPURLResponse, (200..<300).contains(r.statusCode) {
          self.updateNote = ok
        } else {
          self.updateNote = "\(detail) → HTTP \((resp as? HTTPURLResponse)?.statusCode ?? -1) — see the arbiter"
        }
        // Refresh the published view (the gate's state rides back on the
        // next poll; fetch it now so the panel reflects the write).
        self.poll()
      }
    }.resume()
  }

  static func urlEncode(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s
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
  //      place), then take over the LaunchAgent (issue #23 — the loaded
  //      agent must end RUNNING the rebuilt bundle): when the label's
  //      ProgramArguments.0 already equals the bundle's executable,
  //      `launchctl kickstart -k` relaunches the agent on the new binary
  //      and this process exits with the note "restarting menu bar with
  //      new code"; when the label is loaded but STALE (points at an old
  //      path inside this repo — e.g. a bare-binary plist from before the
  //      bundle era), the plan appends a REPAIR step: render the
  //      committed plist template + bootout + bootstrap re-points it at
  //      the rebuilt bundle. A label pointing OUTSIDE this repo belongs
  //      to another checkout — never killed, never re-pointed (the note
  //      says relaunch). After any kick/bootstrap the executor verifies
  //      `launchctl print` shows the bundle executable — a mismatch is a
  //      surfaced failure, not a success.
  //   7. record: one line per completed update appended to
  //      logs/idlefill-menubar.log (rotated — never deleted, never
  //      truncated to empty), and deployedRevision = the merged HEAD.
  func updateCode() {
    let repo = repoRoot
    updateNote = "updating: checking tree …"
    let logDir = (repo as NSString).appendingPathComponent("logs")
    try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    let logFile = (logDir as NSString).appendingPathComponent("idlefill-menubar.log")

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
      case .kickMenubar, .repairAgent:
        // Issue #23: the loaded agent must END RUNNING the freshly built
        // bundle. The label already runs it → kickstart -k (today's
        // behavior). A stale label inside this repo → render the committed
        // template + bootout + bootstrap (the repair). Either way the note
        // is set BEFORE the take-over (the issue's requirement): launchd
        // re-runs the rebuilt bundle on the same path — this process exits
        // and the new binary takes over. A label outside this repo is
        // another checkout's agent: never killed, never re-pointed.
        updateNote = "restarting menu bar with new code"
        let take = LaunchAgent.takeOver(repo: repo, label: UpdatePlan.label, log: logFile)
        switch take {
        case .kicked, .repaired:
          // Post-kick verify (issue #23 item 2): the LOADED service's
          // ProgramArguments.0 must equal the just-built bundle executable.
          // A mismatch is a repair FAILURE surfaced on the status row —
          // never a silent success.
          let want = UpdateFacts.bundleExecutable(repo: repo)
          let got = UpdateFacts.labelRuns(uid: geteuid(), label: UpdatePlan.label)
          if got != want {
            updateNote = "menu bar agent did not end up on the rebuilt bundle (launchctl shows \(got ?? "<nothing>")) — check 'launchctl print gui/\(geteuid())/\(UpdatePlan.label)'"
            ok = false
          } else {
            ok = true
          }
        case .notLoaded:
          updateNote = "menu bar rebuilt — relaunch it to run the new code (agent not loaded)"
          ok = false
        case .foreign:
          updateNote = "menu bar rebuilt — the loaded agent runs another checkout's binary; relaunch it yourself"
          ok = false
        case .failed(let why):
          updateNote = "menu bar rebuilt — agent re-point failed: \(why)"
          ok = false
        }
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
    let didTakeOver = lastStep == .kickMenubar || lastStep == .repairAgent
    if !didTakeOver {
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

  /** The update check: on launch and every `update_check_minutes`
   *  (config; default 360 = 6h),
   *  routed on the CONFIG'S CHANNEL (issue #26; `client/config.json`'s
   *  `update_channel` — absent = releases, today's behavior):
   *
   *  - releases (the default): GET the Forgejo releases list ANONYMOUSLY
   *    (the repo is public — the arbiter token is never sent to Forgejo),
   *    compare the newest release number (or legacy semver tag) against
   *    the baked version (a NON-NUMERIC baked version — an edge marker or
   *    a dev build — offers the newest release unconditionally: the
   *    back-switch rule, without which such a machine could never come
   *    back to this channel).
   *  - branch: GET the tracked branch's tip via the refs API, offer the
   *    tip's edge marker whenever it differs from the baked marker.
   *
   *  OFFLINE-TOLERANT: any fetch/parse failure sets nothing and fails
   *  quiet — no dialog, no error row; the next cadence tick retries. */
  func checkForUpdates() {
    let base = AppModel.updateBase()
    let channel = config.updateChannel
    if let channel, let pin = config.updatePin {
      // The DEVELOPMENT PIN (the branch channel's pinning extension):
      // the check targets the PINNED commit's edge marker instead of
      // the branch's TIP — no refs fetch (a pin cannot move; the marker
      // IS the sha). The one network fact is the pinned edge release's
      // EXISTENCE (its per-commit tag, published by edge.yml on push or
      // `scripts/edge-release.sh` on demand): a different marker that
      // exists is offered; a missing tag offers nothing (the operator
      // publishes the build, the next tick retries) — offline-tolerant
      // like the rest of the check.
      let marker = UpdateCheck.edgeMarker(branch: channel, sha7: String(pin.prefix(7)))
      UpdateCheck.fetchReleaseExists(base: base, tag: marker) { [weak self] data in
        guard let self else { return }
        DispatchQueue.main.async { self.applyPinCheck(exists: data != nil, pinMarker: marker) }
      }
      return
    }
    if let channel {
      UpdateCheck.fetchBranchTip(base: base, branch: channel) { [weak self] data in
        guard let self else { return }
        DispatchQueue.main.async { self.applyBranchCheck(data, branch: channel) }
      }
    } else {
      URLSession.shared.dataTask(with: URL(string: "\(base)/api/v1/repos/sam/idlefill/releases?limit=10")!) { [weak self] data, _, _ in
        guard let self else { return }
        DispatchQueue.main.async { self.applyUpdateCheck(data, localVersion: self.version) }
      }.resume()
    }
  }

  /** Pure: given the releases-list payload + the baked local version, set
   *  the exception-only `updateAvailable` (the tag's version) or clear it.
   *  Split out so the headless test can drive it with canned payloads. */
  func applyUpdateCheck(_ data: Data?, localVersion: String) {
    updateAvailable = UpdateCheck.latestUpdateTag(data: data, localVersion: localVersion)
    // The channel fact rides with the marker (the install routes on it):
    // a value set here came from the releases channel — "releases".
    updateChannel = updateAvailable == nil ? nil : "releases"
  }

  /** Pure (the branch channel): given the refs-API payload + the baked
   *  marker, set `updateAvailable` to the tip's marker (or clear it) when
   *  the tip differs. The refs payload is the source of truth for the
   *  branch name, so a config switched to a different branch simply sees
   *  the new branch's tip on the next tick. (The static `branchCheck`
   *  carries the same facts for a chosen local marker — the headless
   *  test drives THAT; the model drives it with its own baked version.) */
  func applyBranchCheck(_ data: Data?, branch: String) {
    let r = UpdateCheck.branchCheck(data: data, localMarker: version)
    updateAvailable = r?.marker
    updateChannel = r?.channel
  }

  /** Pure (the pinning check): given the pin's availability verdict +
   *  the pinned marker, set `updateAvailable` to the PINNED marker (or
   *  clear it) — the offer exists iff the pinned marker DIFFERS from
   *  the baked one AND its edge release exists (a different marker
   *  whose tag is missing offers nothing — the install would 404; the
   *  operator publishes the build via `scripts/edge-release.sh` and the
   *  next tick offers). The channel fact is the TRACKED BRANCH (the
   *  pin rides on the branch channel — the install routes on it: an
   *  edge value is its OWN tag, the marker-named zip). */
  func applyPinCheck(exists: Bool, pinMarker: String) {
    let offer = UpdateCheck.pinUpdateMarker(pinMarker: pinMarker, localMarker: version, exists: exists)
    updateAvailable = offer
    updateChannel = offer == nil ? nil : (config.updateChannel ?? "releases")
  }

  /** Install action (phase 1 — sha256, not Developer ID): download the
   *  menubar zip + its sha256 sidecar for the available build — a release
   *  (the release's numbered zip) or an EDGE build (the branch channel's
   *  marker-named zip, same verification) — verify the hash BEFORE any
   *  swap (a mismatch or missing sidecar refuses and keeps the current
   *  binary), then swap the bundle in place under the repo root and
   *  kickstart the LaunchAgent when it is loaded. */
  func installUpdate() {
    guard let version = updateAvailable else { return }
    // `updateAvailable` is a release's BARE version (the releases channel)
    // or a branch's EDGE MARKER (the branch channel). downloadRef keeps the
    // two straight: releases re-add the "v" tag + numbered zip name (the
    // per-tag route is keyed on the tag — a bare version there would 404);
    // an edge marker IS its own tag and its zip's name.
    let isEdge = updateChannel != "releases"
    let ref = UpdateCheck.downloadRef(version: version, isEdge: isEdge)
    updateNote = "installing \(version) …"
    UpdateCheck.install(
      base: AppModel.updateBase(),
      tag: ref.tag,
      zipName: ref.zip,
      bundleURL: AppModel.menubarBundleURL(),
      repoRoot: repoRoot,
      label: UpdatePlan.label
    ) { [weak self] outcome in
      guard let self else { return }
      DispatchQueue.main.async {
        switch outcome {
        case .installed:
          self.updateNote = "installed \(version) — relaunched"
          self.updateAvailable = nil
          self.updateChannel = nil
        case .notLoaded:
          self.updateNote = "installed \(version) — agent not loaded: run menubar/install.sh"
          self.updateAvailable = nil
          self.updateChannel = nil
        case .agentFailed(let why):
          // The bundle IS swapped; the agent did not end on it. Surface it
          // (issue #23: a mismatch is a repair failure, not a success).
          self.updateNote = "installed \(version) — agent NOT re-pointed: \(why)"
          self.updateAvailable = nil
          self.updateChannel = nil
        case .refused:
          // The current binary is untouched; the note explains the refusal.
          break
        }
      }
    }
  }
}

// MARK: - release update check (pure + async — testable headlessly)

/** The update check over the network (issue #10) + the EDGE CHANNEL
 *  (issue #26): on launch + every `update_check_minutes` (config; default
 *  360 = 6h) the menu bar checks the update
 *  channel ANONYMOUSLY (the repo is public; the arbiter token is never
 *  sent to Forgejo) and, when a newer build is published, sets
 *  `updateAvailable`:
 *
 *  - releases channel (the default): the newest release number (or
 *    legacy semver tag) strictly above the baked version. Plus the
 *    BACK-SWITCH rule (issue #26): a machine whose baked version is a
 *    NON-NUMERIC marker (an edge marker, a dev build) can never compare
 *    numerically — today that made `versionSegments` return nil and the
 *    check fail quiet FOREVER (the machine could not come back to the
 *    releases channel at all). Now a non-numeric local version offers
 *    the newest release unconditionally.
 *  - branch channel: the tracked branch's TIP (via the git refs API)
 *    vs the baked marker — an update is available whenever the baked
 *    marker differs from the tip marker (no ordering on branch builds:
 *    a newer push is a different marker, and that is the signal).
 *
 *  OFFLINE-TOLERANT: any fetch/parse failure sets nothing — no dialog, no
 *  error row; the next cadence tick retries.
 *
 *  Phase 1 verification is a published sha256 sidecar (Developer ID signing
 *  + notarization is tracked separately): the install downloads the zip AND
 *  the `.sha256` sidecar, verifies the hash BEFORE any swap, and a mismatch
 *  or missing sidecar refuses (the current binary is kept). */
enum UpdateCheck {
  /// The DEFAULT check cadence in MINUTES (issue #27 made it configurable
  /// via `update_check_minutes`): launch, then every 6 hours.
  static let cadenceMinutesDefault = 6 * 60
  /// The floor for a configured cadence — below it the value is clamped
  /// up AND the clamp is logged once at launch (never silently).
  static let cadenceMinutesMin = 5

  /** Pure: resolve the raw `update_check_minutes` JSON value into the
   *  cadence actually used. Absent / empty / non-numeric / non-integer /
   *  boolean -> the default (360), no clamp note. A numeric value below
   *  the floor -> the floor, with `clampedFrom` carrying the raw value so
   *  the caller can log the clamp once at launch. (JSON booleans box as
   *  NSNumber too — they are not a cadence.) */
  static func resolveCadence(_ raw: Any?) -> (value: Int, clampedFrom: Int?) {
    var parsed: Int? = nil
    if let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() {
      let d = n.doubleValue
      if d == d.rounded(), d >= -2_147_483_647, d <= 2_147_483_647 { parsed = n.intValue }
    }
    guard let p = parsed else { return (cadenceMinutesDefault, nil) }
    if p < cadenceMinutesMin { return (cadenceMinutesMin, p) }
    return (p, nil)
  }

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
  /// nothing is strictly newer. Malformed tags are skipped; a fetch/parse
  /// failure (unparseable payload, no valid tags) → nil: fail quiet,
  /// nothing set, next tick retries.
  ///
  /// BACK-SWITCH rule (issue #26): a NON-NUMERIC local version (an edge
  /// marker, a dev build) cannot compare numerically — the pre-#26 code
  /// returned nil here and failed quiet FOREVER, so a machine baked with
  /// a non-numeric version could never come back to the releases channel.
  /// It now offers the newest release unconditionally: any release is a
  /// known-good signed build, and a non-numeric local build is never
  /// "newer" than it. Numeric local versions keep the old rule exactly.
  static func latestUpdateTag(data: Data?, localVersion: String) -> String? {
    guard let data,
          let o = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
      return nil
    }
    var best: ([Int], String)?
    for rel in o {
      guard let tag = rel["tag_name"] as? String,
            let parsed = parseTag(tag) else { continue }
      if best == nil || versionOrder(parsed.0, best!.0) > 0 { best = (parsed.0, parsed.1) }
    }
    guard let b = best else { return nil }
    guard let local = versionSegments(localVersion) else { return b.1 }
    return versionOrder(b.0, local) > 0 ? b.1 : nil
  }

  // -- branch (edge) channel (issue #26) -----------------------------------

  /** The edge-channel marker: `edge-<branch>-<sha7>`. ONE string, three
   *  uses — the Forgejo release TAG, the Forgejo release name's tail
   *  ("Edge <branch> <sha7>"), and the artifact-zip name part
   *  (`IdlefillMenubar-<marker>.app.zip` / `Idlefill <marker>.zip`). The
   *  branch must be URL-safe (the edge publish derives it from the pushed
   *  branch name); sha7 is the pushed commit's first 7 hex chars. */
  static func edgeMarker(branch: String, sha7: String) -> String {
    "edge-\(branch)-\(sha7)"
  }

  /** The DEVELOPMENT PIN (the branch channel's pinning extension): a pin
   *  value is a commit SHA — its first 7–40 hex chars (the marker uses
   *  the sha7; a full 40-hex sha pins the same marker as its own prefix).
   *  Anything else = malformed = ABSENT (the caller falls back to
   *  tip-following; a hand-typed garbage pin must never become a marker
   *  tail that 404s forever). */
  static func isPinSha(_ s: String) -> Bool {
    (7...40).contains(s.count) && s.allSatisfy(\.isHexDigit)
  }

  /** Pure (the pinning check, given a pinned marker + the availability
   *  probe's verdict): the pin's OFFER. `pinMarker == localMarker` ->
   *  nil (up to date — the machine already runs the pinned build). A
   *  DIFFERENT pinned marker is offered only when `exists` (the pinned
   *  edge release's tag answers 200 — its per-commit tag, published by
   *  edge.yml on push or `scripts/edge-release.sh` on demand); a
   *  non-existent pin (a commit that was never pushed/published, or the
   *  release was cleaned) -> nil (NOT an offer: the install would 404 —
   *  the check says nothing and the operator publishes the build, e.g.
   *  `scripts/edge-release.sh edge-<branch>-<sha7> <sha>`; the next
   *  cadence tick retries and then offers). */
  static func pinUpdateMarker(pinMarker: String, localMarker: String, exists: Bool) -> String? {
    guard pinMarker != localMarker else { return nil }
    return exists ? pinMarker : nil
  }

  /** Pure (the branch channel): the channel facts an available update
   *  carries, given the refs-API payload + the local's BAKED marker.
   *  Split out so the headless test can drive it with a CHOSEN local
   *  marker (the app's own baked version can't be injected). The
   *  CHANNEL fact is the branch the tip belongs to (the payload's own
   *  ref — the source of truth), never re-derived from the marker
   *  string. `nil` = nothing to set (equal markers, or any
   *  fetch/parse failure). */
  static func branchCheck(data: Data?, localMarker: String) -> (marker: String, channel: String)? {
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
    let branch = String(ref.dropFirst("refs/heads/".count))
    guard !branch.isEmpty else { return nil }
    let marker = edgeMarker(branch: branch, sha7: String(sha.prefix(7)))
    guard marker != localMarker else { return nil }
    return (marker, branch)
  }

  /** Pure: the BRANCH-channel update verdict. Given the refs-API payload
   *  (verified live: `GET …/git/refs/heads/<b>` → 200
   *  `[{ref, url, object:{type:"commit", sha}}]`; unknown branch → 404
   *  JSON) + the baked marker, an update is available ⇔ the baked marker
   *  DIFFERS from the tip's marker — no ordering on branch builds: a
   *  newer push is a different marker, and the difference IS the update
   *  (equal markers → up to date → nil). The branch name is read from
   *  the payload's own `ref` (the source of truth — a config that was
   *  switched to a different branch must see the new branch's tip). Any
   *  failure (nil payload, malformed, 404 JSON, malformed sha) → nil:
   *  fail quiet, nothing set, next tick retries. */
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
    let tip = edgeMarker(branch: branch, sha7: String(sha.prefix(7)))
    return tip == localMarker ? nil : tip
  }

  /** GET `<base>/api/v1/repos/sam/idlefill/git/refs/heads/<branch>`
   *  (anonymous — the same posture as `fetchReleases`; the
   *  `IDLEFILL_UPDATE_BASE` test hook applies). The completion ALWAYS
   *  runs, on any thread — including failure (that is the
   *  offline-tolerant contract: the caller must set nothing). */
  static func fetchBranchTip(base: String, branch: String,
                             completion: @escaping (Data?) -> Void) {
    let branchEnc = branch.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? branch
    guard let url = URL(string: "\(base)/api/v1/repos/sam/idlefill/git/refs/heads/\(branchEnc)") else {
      completion(nil); return
    }
    var req = URLRequest(url: url)
    req.timeoutInterval = 10
    URLSession.shared.dataTask(with: req) { data, _, _ in
      completion(data)
    }.resume()
  }

  /** GET `<base>/api/v1/repos/sam/idlefill/releases/tags/<tag>` — the
   *  PIN's availability probe (the pinning check's one network fact):
   *  the pinned marker IS an edge release's TAG (the per-commit tag
   *  edge.yml pushes / `scripts/edge-release.sh` publishes), so its
   *  EXISTENCE is the whole verdict. The completion runs with the
   *  payload on a genuine 2xx and with `nil` on everything else — 404
   *  (the tag was never published / was cleaned), a non-2xx, or no
   *  response at all (the network is down): a failed probe must not be
   *  mistaken for an existing release (the offline-tolerant contract —
   *  the pin offers nothing and the next cadence tick retries).
   *  ANONYMOUS, like the rest of the check (the repo is public; the
   *  arbiter token is never sent to Forgejo). The `IDLEFILL_UPDATE_BASE`
   *  test hook applies (the caller builds the base). */
  static func fetchReleaseExists(base: String, tag: String,
                                 completion: @escaping (Data?) -> Void) {
    let tagEnc = tag.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? tag
    guard let url = URL(string: "\(base)/api/v1/repos/sam/idlefill/releases/tags/\(tagEnc)") else {
      completion(nil); return
    }
    var req = URLRequest(url: url)
    req.timeoutInterval = 10
    URLSession.shared.dataTask(with: req) { data, resp, _ in
      if let e = resp as? HTTPURLResponse, (200..<300).contains(e.statusCode) {
        completion(data)
      } else {
        completion(nil)
      }
    }.resume()
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
  /// RELEASES-channel form — untouched by issue #26 (the edge path calls
  /// the overload below with `isEdge: true`).
  static func downloadRef(version: String) -> (tag: String, zip: String) {
    downloadRef(version: version, isEdge: false)
  }

  /** The CHANNEL-AWARE ref resolution (issue #26). Releases channel
   *  (`isEdge: false`): the release rule above, byte-identical. Edge
   *  channel (`isEdge: true`): `updateAvailable` holds the marker
   *  (`edge-<branch>-<sha7>`) — the marker IS the tag (no "v" to add),
   *  and the edge publish names the zip after the marker
   *  (`IdlefillMenubar-<marker>.app.zip`). */
  static func downloadRef(version: String, isEdge: Bool) -> (tag: String, zip: String) {
    if isEdge {
      return (version, "IdlefillMenubar-\(version).app.zip")
    }
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

  enum Outcome: Equatable {
    case installed     // swapped + the agent verified on the swapped bundle
    case notLoaded     // swapped; nothing loaded under the label (install.sh's job)
    case refused(String)   // hash/sidecar/swap refusal — the current bundle kept
    case agentFailed(String) // swapped, but the agent take-over/verify failed
                              // (issue #23: a mismatch is surfaced, not success)
  }

  /** Download `<base>/releases/download/<tag>/<zipName>` + the sidecar
   *  (`<zipName>.sha256`) to a temp dir, verify the hash, then swap the
   *  bundle in place (a temp dir next to the target, then a rename — no
   *  partial-bundle window), and take over the LaunchAgent (issue #23):
   *  already running this repo's bundle → `kickstart -k`; a stale label
   *  INSIDE this repo → render the committed template + bootout +
   *  bootstrap (re-point at the swapped bundle); a label outside this
   *  repo belongs to another checkout — never touched. After a successful
   *  kick/bootstrap, `launchctl print` must show ProgramArguments.0 ==
   *  the swapped bundle executable — a mismatch is `.agentFailed`, not
   *  success. A hash mismatch, a missing/malformed sidecar, or a failed
   *  swap REFUSES: the current bundle is untouched and the refusal reason
   *  is returned. */
  static func install(base: String, tag: String, zipName: String,
                      bundleURL: URL, repoRoot: String, label: String,
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
      // The repo path is PART of the download route (Gitea's form is
      // /{owner}/{repo}/releases/download/{tag}/{file} — the API routes
      // above carry it too). Omitting it 404s on the REAL server while a
      // stub mounted at its root serves the bytes anyway: the download
      // then "succeeds" with the 11-byte "Not found." body and only the
      // sha256 sidecar check refuses it, so the update silently never
      // installs. (Reproduced live 2026-10-01: the menubar sat on
      // edge-main-3ee6d5c through four published edge builds.)
      guard let url = URL(string: "\(base)/sam/idlefill/releases/download/\(tagEnc)/\(encodedName)") else {
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
        // Issue #23: re-point, don't just note. The loaded agent must end
        // RUNNING the swapped bundle (kick / repair / never-touch-foreign),
        // then the post-kick verify confirms the LOADED service's
        // ProgramArguments.0 equals the bundle executable.
        let take = LaunchAgent.takeOver(repo: repoRoot, label: label)
        switch take {
        case .kicked, .repaired:
          let want = UpdateFacts.bundleExecutable(repo: repoRoot)
          let got = UpdateFacts.labelRuns(uid: geteuid(), label: label)
          if got == want {
            completion(.installed)
          } else {
            completion(.agentFailed("launchctl shows \(got ?? "<nothing>") — not the installed bundle"))
          }
        case .notLoaded:
          completion(.notLoaded)
        case .foreign:
          completion(.agentFailed("the loaded agent runs another checkout's binary — not re-pointed"))
        case .failed(let why):
          completion(.agentFailed(why))
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
    var labelRunsBundle: Bool   // the label's ProgramArguments.0 == the bundle
                                // executable this update builds (the kick case)
    var labelUnderRepo: Bool    // the label's ProgramArguments.0 lives under
                                // the repo root being updated — the REPAIR
                                // gate (issue #23). A label pointing at
                                // ANOTHER checkout is that checkout's agent:
                                // re-pointing it here would hijack it, so it
                                // stays a note (the same safety the old kick
                                // gate gave via thisIsLabelBinary, widened
                                // only to "this repo").
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
    case repairAgent    // issue #23: the loaded agent runs a STALE path
                        // inside this repo — render the committed plist
                        // template + bootout + bootstrap (re-point it at
                        // the freshly built bundle), then verify. A repair
                        // STEP, never a note.
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
   *    6. the agent take-over (issue #23 — the loaded agent must end
   *       RUNNING the freshly built bundle, not merely be noted):
   *        - labelLoaded && labelRunsBundle → kickMenubar (today's
   *          behavior — the label already points at the rebuilt bundle)
   *        - labelLoaded && !labelRunsBundle && labelUnderRepo →
   *          repairAgent (a stale label INSIDE this repo: render the
   *          committed plist template + bootout + bootstrap re-points it
   *          at the rebuilt bundle — a repair step, not a note)
   *        - anything else (not loaded, or the label belongs to ANOTHER
   *          checkout) → no kill, no hijack: the note says relaunch.
   *       Every take-over step is followed by the executor's post-kick
   *       verify (launchctl print shows the bundle executable) — a
   *       mismatch is a repair failure, not a success.
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
    if input.labelLoaded && input.labelRunsBundle {
      steps.append(.kickMenubar)
    } else if input.labelLoaded && input.labelUnderRepo {
      steps.append(.repairAgent)
    }
    var note = "updated"
    if input.daemonPids.isEmpty { note += " (daemon was not running — no restart)" }
    if !(input.labelLoaded && (input.labelRunsBundle || input.labelUnderRepo)) {
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

  /** Does `path` live under `repoRoot` (the repair-safety gate, issue
   *  #23)? A label whose executable sits inside the repo being updated is
   *  THIS checkout's agent (possibly a stale path within it) — re-pointing
   *  it is a repair. A label outside the repo belongs to another checkout
   *  (e.g. the real label while a worktree runs the update) — never
   *  touched. Pure so the harness asserts the gate directly. */
  static func pathUnderRepo(_ path: String, repoRoot: String) -> Bool {
    let root = repoRoot.hasSuffix("/") ? String(repoRoot.dropLast()) : repoRoot
    return path == root || path.hasPrefix(root + "/")
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

  /** The bundle executable this checkout's build produces — the path a
   *  healthy agent's ProgramArguments.0 must equal (menubar/build.sh's
   *  output; the committed plist template renders exactly this). */
  static func bundleExecutable(repo: String) -> String {
    (repo as NSString).appendingPathComponent("menubar/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar")
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
                     label: String = UpdatePlan.label) -> UpdatePlan.Input? {
    guard let old = shortSha("HEAD", cwd: repo) else { return nil }
    let loaded = labelLoaded(uid: uid, label: label)
    // Issue #23 facts: the label's CURRENT executable decides kick vs
    // repair vs note. The compare is against the BUNDLE executable this
    // checkout builds (not this process's own binary — the update rebuilds
    // the bundle, and the agent must end on THAT). The repair gate is
    // repo-scoped: a label outside this repo belongs to another checkout
    // and is never re-pointed (the old kick gate's safety, kept).
    let runs = loaded ? labelRuns(uid: uid, label: label) : nil
    let bundleExe = bundleExecutable(repo: repo)
    let labelRunsBundle = loaded && (runs == bundleExe)
    let labelUnderRepo = loaded && (runs.map { UpdatePlan.pathUnderRepo($0, repoRoot: repo) } ?? false)
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
        labelRunsBundle: labelRunsBundle, labelUnderRepo: labelUnderRepo,
        currentShortSha: old)
    }
    return UpdatePlan.Input(
      treeClean: clean, fetchOk: true, isAncestor: false, hasDelta: false,
      lockChanged: false, daemonPids: pids, labelLoaded: loaded,
      labelRunsBundle: labelRunsBundle, labelUnderRepo: labelUnderRepo,
      currentShortSha: old)
  }
}

/** The menubar LaunchAgent re-point machinery (issue #23). Shared by the
 *  Update Code executor (the `.repairAgent` step) and the release install
 *  (`UpdateCheck.install`) so both update paths treat the loaded agent as
 *  "runs this checkout's freshly built bundle" and REPAIR it when it
 *  doesn't — instead of merely noting the drift.
 *
 *  A repair renders the COMMITTED plist template (`menubar/IdlefillMenubar
 *  .plist`) with this checkout's values — the same substitution
 *  `menubar/install.sh` performs — then `bootout` + `bootstrap`. The
 *  render happens BEFORE the bootout (fail closed: a render refusal never
 *  leaves the previously-loaded agent unloaded). The repair is gated:
 *  only a label whose current executable lives INSIDE the repo being
 *  updated is re-pointed — a label pointing at another checkout belongs
 *  to that checkout and is never hijacked (the same safety the old kick
 *  gate gave, widened only to "this repo").
 *
 *  Test hooks (inert in production, same names as install.sh's):
 *  `IDLEFILL_MENUBAR_PLIST_DIR` re-points where the rendered plist lands
 *  (the harness uses a scratch dir, never ~/Library/LaunchAgents). */
enum LaunchAgent {
  enum Takeover {
    case kicked          // the label already ran the bundle — kickstart -k
    case repaired        // stale label inside this repo — render + bootout + bootstrap
    case notLoaded       // nothing loaded under this label
    case foreign         // loaded, but its executable lives OUTSIDE this repo
    case failed(String)  // a step failed (kick / bootout / bootstrap / render)
  }

  /** Where the rendered plist lands: `IDLEFILL_MENUBAR_PLIST_DIR` (test
   *  hook) or ~/Library/LaunchAgents (production). */
  static func plistDir() -> String {
    let hook = ProcessInfo.processInfo.environment["IDLEFILL_MENUBAR_PLIST_DIR"]
    return (hook?.isEmpty == false) ? hook!
      : ((NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents"))
  }

  /** Render the committed template with this checkout's values (the same
   *  substitutions install.sh does: the repo-root prefix into every path,
   *  the Label value). Returns the rendered plist's path, or nil on any
   *  failure (missing template, write failure, byte-verify refusal). The
   *  byte-verify mirrors install.sh's: when this checkout IS the template's
   *  hardcoded repo the rendered paths legitimately equal the template
   *  literal, so assert the rendered ProgramArguments.0 + Label instead;
   *  any other checkout must not carry the template literal at all. */
  static func renderPlist(repo: String, label: String) -> String? {
    let template = (repo as NSString).appendingPathComponent("menubar/IdlefillMenubar.plist")
    guard let raw = try? String(contentsOfFile: template, encoding: .utf8) else { return nil }
    let trepo = "/Users/sam/Software/idlefill"
    var out = raw.replacingOccurrences(of: trepo, with: repo)
    out = out.replacingOccurrences(of: "<string>com.sam.idlefill.menubar</string>",
                                   with: "<string>\(label)</string>")
    // Byte-verify the render.
    let bundleExe = UpdateFacts.bundleExecutable(repo: repo)
    let binTag = "<string>\(bundleExe)</string>"
    guard out.contains(binTag), out.contains("<string>\(label)</string>") else { return nil }
    if repo != trepo, out.contains(trepo) { return nil }
    // launchd refuses to start a job whose log paths do not exist.
    try? FileManager.default.createDirectory(
      atPath: (repo as NSString).appendingPathComponent("logs"),
      withIntermediateDirectories: true)
    let dir = plistDir()
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let path = (dir as NSString).appendingPathComponent("\(label).plist")
    do { try out.write(toFile: path, atomically: true, encoding: .utf8) } catch { return nil }
    return path
  }

  /** `launchctl bootout gui/<uid>/<label>` — the SINGLE combined target
   *  (the two-arg form fails rc=5). rc 3 "No such process" = not loaded =
   *  a clean no-op. */
  static func bootout(label: String, uid: UInt32, log: String?) -> Bool {
    let rc = runLogged(["/bin/launchctl", "bootout", "gui/\(uid)/\(label)"], log: log)
    return rc == 0 || rc == 3
  }

  /** `launchctl bootstrap gui/<uid> <plist>`. */
  static func bootstrap(plist: String, uid: UInt32, log: String?) -> Bool {
    runLogged(["/bin/launchctl", "bootstrap", "gui/\(uid)", plist], log: log) == 0
  }

  /** The full re-point: RENDER FIRST (fail closed — a render refusal
   *  leaves the loaded agent untouched), then bootout + bootstrap. */
  static func repair(repo: String, label: String, uid: UInt32 = geteuid(), log: String? = nil) -> Bool {
    guard let plist = renderPlist(repo: repo, label: label) else { return false }
    guard bootout(label: label, uid: uid, log: log) else { return false }
    return bootstrap(plist: plist, uid: uid, log: log)
  }

  /** The take-over decision for a loaded agent (issue #23): already on
   *  the bundle → kick; stale inside this repo → repair; outside this
   *  repo → foreign (never touched); not loaded → notLoaded. After a
   *  successful kick/bootstrap the caller verifies `labelRuns` against
   *  the bundle executable (a mismatch is a failure, not a success). */
  static func takeOver(repo: String, label: String, uid: UInt32 = geteuid(), log: String? = nil) -> Takeover {
    guard UpdateFacts.labelLoaded(uid: uid, label: label) else { return .notLoaded }
    let runs = UpdateFacts.labelRuns(uid: uid, label: label)
    let bundleExe = UpdateFacts.bundleExecutable(repo: repo)
    if runs == bundleExe {
      let rc = runLogged(["/bin/launchctl", "kickstart", "-k", "gui/\(uid)/\(label)"], log: log)
      return rc == 0 ? .kicked : .failed("kickstart failed (exit \(rc))")
    }
    guard UpdatePlan.pathUnderRepo(runs ?? "", repoRoot: repo) else { return .foreign }
    return repair(repo: repo, label: label, uid: uid, log: log) ? .repaired
      : .failed("render/bootout/bootstrap re-point failed")
  }

  /** Run + log a command the way updateCode's gatedRun does (the update
   *  log records what a repair did). Returns the exit status. */
  @discardableResult
  static func runLogged(_ cmd: [String], log: String?) -> Int32 {
    let tmp = (NSTemporaryDirectory() as NSString)
      .appendingPathComponent("idlefill-launchagent-\(getpid())-\(Int(Date().timeIntervalSince1970 * 1000)).txt")
    FileManager.default.createFile(atPath: tmp, contents: nil)
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: cmd[0])
    p.arguments = Array(cmd.dropFirst())
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", env["PATH"] ?? ""].joined(separator: ":")
    p.environment = env
    // Temp file, never a Pipe (the 64 KB deadlock class — launchctl print
    // output is small but the rule is the class fix).
    let h = FileHandle(forWritingAtPath: tmp)
    if let h { p.standardOutput = h; p.standardError = h }
    do { try p.run() } catch { if let h { try? h.close() }; return 255 }
    p.waitUntilExit()
    if let h { try? h.close() }
    let rc = p.terminationStatus
    if let log {
      let data = (try? Data(contentsOf: URL(fileURLWithPath: tmp))) ?? Data()
      UpdateLog.appendCommand(cmd: cmd, data: data, exit: Int(rc), at: log)
    }
    return rc
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

  /** Append one command's record (the `$ cmd … [exit N]` shape the update
   *  log uses) — the shared form AppModel.gatedRun and LaunchAgent.runLogged
   *  both write, so a repair is auditable in the same log. */
  static func appendCommand(cmd: [String], data: Data, exit: Int, at path: String) {
    rotateIfNeeded(path: path)
    let dir = (path as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    // 3-arg open + O_APPEND (the mode-0000 + truncate pitfalls — see the
    // appendLog note in AppModel): create with 0o644, write at the true end.
    let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
    guard fd >= 0 else { return }
    defer { close(fd) }
    var bytes = Data("\n$ \(cmd.joined(separator: " "))".utf8)
    bytes.append(data)
    bytes.append(Data("\n[exit \(exit)]\n".utf8))
    _ = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
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

/** A picker row (machine / project): a dot + label + an optional
 *  exception tag (paused/budget-full/paused-worker — DESIGN.md: tags for
 *  exceptions only) + a checkmark on the selected row. */
struct PickRow: View {
  let label: String
  let selected: Bool
  var dot: Color = Pal.dim            // online dot (green) or off (dim)
  var showDot: Bool = true
  var tag: (text: String, color: Color)? = nil
  var body: some View {
    HStack(spacing: 6) {
      if showDot {
        Circle().fill(dot).frame(width: 7, height: 7)
      }
      Text(label).font(.system(.body, design: .monospaced))
        .foregroundStyle(selected ? Pal.text : Pal.dim)
      if let t = tag {
        Text(t.text).font(.system(.caption, design: .monospaced)).foregroundStyle(t.color)
      }
      Spacer()
      if selected {
        Text("•").font(.system(.body, design: .monospaced)).foregroundStyle(Pal.accent)
      }
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
        // The arc's spin stays tied to THIS client's leases (the scope
        // machine's — every active lease, not just the first).
        LogoView(spinning: !m.leases.isEmpty)
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

      // ---- the scope (machine × project). The default is "this machine ·
      // all projects" (the config's client_name row — today's behaviour);
      // the pickers widen it. The machine picker lists the explicitly
      // labelled "all machines" aggregate FIRST, then every clients[] row
      // (online dot + the exception-only override tag); the aggregate's
      // dot stays dim (it is a view, not a machine). The project picker
      // lists the scope's projects; "all projects" is the aggregate.
      VStack(spacing: 3) {
        Text("machine").font(.system(.caption, design: .monospaced))
          .foregroundStyle(Pal.dim).textCase(.uppercase).kerning(0.5)
        ForEach(Array(m.viewMachines.enumerated()), id: \.element.key) { _, opt in
          let isAll = opt.key == ScopeView.allMachinesKey
          let ov = m.viewMachineOverride(opt.key)
          let ovTag: (text: String, color: Color)? = ov.map { t in
            (text: (t == "pause" ? "paused" : t), color: (t == "pause" ? Pal.err : Pal.warn))
          }
          pickRow(label: isAll ? "all machines" : opt.label,
                  selected: opt.key == m.machine.key,
                  dot: opt.online ? Pal.ok : Pal.dim,
                  showDot: !isAll,
                  tag: ovTag) {
            m.selectMachine(opt.key)
          }
        }
        Text("project").font(.system(.caption, design: .monospaced))
          .foregroundStyle(Pal.dim).textCase(.uppercase).kerning(0.5)
        pickRow(label: "all projects",
                selected: m.projectKey == ScopeView.allProjectsKey, showDot: false) {
          m.selectProject(ScopeView.allProjectsKey)
        }
        ForEach(m.scopeProjects, id: \.name) { p in
          pickRow(label: p.name, selected: p.name == m.projectKey, showDot: false,
                  tag: p.paused ? ("paused", Pal.warn) : (p.budgetFull ? ("budget full", Pal.warn) : (p.mePaused == true ? ("worker paused", Pal.err) : nil))) {
            m.selectProject(p.name)
          }
        }
      }
      .padding(14).padding(.vertical, 8)

      DividerLine()

      VStack(spacing: 4) {
        KVRow(k: machineLabelKey, v: statusRow)
        if let rev = m.deployedRevision {
          KVRow(k: "revision", v: rev)
        }
        // Code-staleness (issue #49) — Exception-Only: the row renders
        // only when the running daemon predates this checkout (the amber
        // exception color the paused/budget tags use). The operator's
        // fix is one click: the Restart row above.
        if m.daemonBehind {
          KVRow(k: "", v: "daemon behind", vcolor: Pal.warn)
        }
        KVRow(k: "queue", v: "\(m.queueDepth)")
        KVRow(k: "today", v: "\(m.today.finished) ok · \(m.today.failed) failed")
        if m.tokenRowVisible {
          KVRow(k: "tokens out", v: tokenRow)
        }
        // Every running lease of the scope machine (max concurrent > 1
        // lists them all — today showed only the first).
        ForEach(Array(m.leases.enumerated()), id: \.offset) { _, l in
          KVRow(k: "running", v: leaseRow(l), vcolor: Pal.accent)
        }
        // Interactive sessions (#9) — read-only at-a-glance (the controls
        // live on the dashboard). The count line renders ONLY when
        // sessions exist (Exception-Only: no sessions = no rows at all);
        // the one-liners are the EXCEPTION states only (paused / forced /
        // queued / stale) — a healthy session renders no row. Colors mirror the
        // dashboard's tags: paused (override) red, forced / stale amber.
        if let count = m.sessionsCountLine {
          KVRow(k: "sessions", v: count)
        }
        ForEach(Array(m.sessions.enumerated()), id: \.offset) { _, s in
          if let line = s.exceptionLine {
            KVRow(k: "", v: line,
                  vcolor: s.overrideLabel == "pause" ? Pal.err : Pal.warn)
          }
        }
        // The picked project's published queue peek (a worker publishing
        // no preview degrades to the depth number above).
        ForEach(Array(m.queuePreview.prefix(4).enumerated()), id: \.offset) { i, r in
          KVRow(k: "queue \(i + 1)", v: queuePeekRow(r))
        }
        if !m.queuePreview.isEmpty {
          KVRow(k: "", v: "\(m.queuePreview.count) shown of \(m.queueDepth) waiting")
        }
      }
      .padding(14).padding(.vertical, 8)

      DividerLine()

      // ---- the scope controls (exception-only; existing routes, the
      // dashboard's token gate).
      if m.pickedProjectVisible {
        controlRow(m.pickedProjectLabel) { m.toggleProjectPaused() }
      }
      if m.scopeWorkerControlLabel != nil {
        controlRow(m.scopeWorkerControlLabel!) { m.cycleWorkerOverride() }
      }

      DividerLine()

      // The action block renders the PURE spec (AppModel.panelActionRows)
      // — the headless harness asserts that same spec, so what the tests
      // prove IS what ships (issue #27). Open Desktop carries the
      // exception-only update tag (the updateAvailable value VERBATIM;
      // no update = label-only row, no tag — DESIGN.md Exception-Only
      // rule); Install Update <v> is exception-only. NO Update Code,
      // NO Quit rows (the exit path is the CLI / launchd).
      ForEach(Array(AppModel.panelActionRows(updateAvailable: m.updateAvailable,
                                             daemonRunning: m.daemonRunning).enumerated()),
              id: \.offset) { _, r in
        if r.dividerBefore { DividerLine() }
        actionRow(r.label, arrow: r.arrow, tag: r.tag)
      }

      if let note = m.updateNote {
        DividerLine()
        Text(note).font(.system(.caption, design: .monospaced)).foregroundStyle(Pal.dim)
          .padding(10).frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .background(Pal.canvas)
    .frame(width: 300)
  }

  // The picker rows (tappable PickRows) — the same row style as the
  // action rows (hover-free; the whole row is the tap target).
  private func pickRow(label: String, selected: Bool,
                       dot: Color = Pal.dim, showDot: Bool = true,
                       tag: (text: String, color: Color)? = nil,
                       action: @escaping () -> Void) -> some View {
    Button(action: action) {
      PickRow(label: label, selected: selected, dot: dot, showDot: showDot, tag: tag)
        .padding(.horizontal, 14).padding(.vertical, 4)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  /** A scope-control row (the project gate / worker override): the same
   *  row style as the pickers; the label carries the LIVE state ("pause
   *  project" / "resume project", "pause this worker" / "unpause …"). */
  private func controlRow(_ label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack {
        Text(label).font(.system(.body, design: .monospaced))
          .foregroundStyle(m.conn == .noToken || m.conn == .unauthorized ? Pal.warn : Pal.accent)
        Spacer()
      }
      .padding(.horizontal, 14).padding(.vertical, 4)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private var statusRow: String {
    if m.conn == .noToken {
      // Criterion 4/5: the status row NAMES the missing token (and no
      // request was ever sent).
      return "no token — set the arbiter token in \(m.configPath)"
    }
    if m.conn == .unauthorized {
      return "bad token — the arbiter rejected it (\(m.configPath))"
    }
    if !m.daemonRunning { return "stopped" }
    if let s = m.lastSeenS, s >= 120 { return "stale (\(s / 60) min)" }
    return m.conn.word
  }

  /** The machine row's key: "this machine" for the name-matched default,
   *  "machine" when the operator widened to the aggregate. */
  private var machineLabelKey: String {
    m.machine.key == ScopeView.allMachinesKey ? "machines" : "machine"
  }

  private var tokenRow: String {
    let (label, cap, v) = m.tokensToday
    let head = label == "all projects" ? "" : "\(label) · "
    if cap > 0 {
      return head + String(format: "%.0f / %.0f (%.0f%%)", v, cap, v / cap * 100)
    }
    return head + String(format: "%.0f (cap ∞)", v)
  }

  private func leaseRow(_ l: ScopeLease) -> String {
    let left = Int(max(0, l.expiresAt / 1000 - Date().timeIntervalSince1970))
    let job = l.project.isEmpty ? l.jobId : "\(l.jobId) · \(l.project)"
    return "\(job) · auto-cancels \(left / 60)m \(left % 60)s"
  }

  private func queuePeekRow(_ r: ScopeQueueRow) -> String {
    let t = r.company.isEmpty ? r.title : "\(r.title) · \(r.company)"
    return t.count > 34 ? String(t.prefix(34)) + "…" : t
  }

  @ViewBuilder
  func actionRow(_ label: String, arrow: Bool = false,
                 tag: (text: String, color: Color)? = nil) -> some View {
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
      // The Open Desktop row = the double-click action, executed through
      // the SAME shared helper the router calls (issue #27 — one call
      // path, no drift). The Update Code and Quit rows are gone: the
      // UpdatePlan/updateCode() machinery stays (CLI/launchd drive the
      // exit path; uc-update-test.sh still proves the core).
      case "Open Desktop": MenuBarAppState.openDesktopApp()
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
        // The exception-only right-half tag (the PickRow pattern —
        // DESIGN.md: no tag is the healthy state). nil renders nothing.
        if let t = tag {
          Text(t.text).font(.system(.caption, design: .monospaced)).foregroundStyle(t.color)
        }
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

  /** THE desktop-app-open action (issue #27): `idlefill://open` — the
   *  State view — with the app-path fallback. The ONE call path for both
   *  the double-click routing (AppDelegate) and the panel's `Open Desktop`
   *  row (ContentView), so the two can never drift. */
  static func openDesktopApp() {
    openDesktopURL("\(DesktopApp.scheme)://open")
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
      button.image = MenuIcon.image(spinning: !(self.model?.leases ?? []).isEmpty)
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
      // `open` of the app path is inside openDesktopApp). The panel's
      // `Open Desktop` row calls the SAME helper (issue #27).
      MenuBarAppState.openDesktopApp()
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
