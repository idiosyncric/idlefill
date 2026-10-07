//! idlefill Tauri v2 shell (issue #70). One artifact: the live arbiter
//! page in one window (D2), a tray with the glance (D1), the launchd
//! lifecycle on a 5s tick (D4), the exception-only reload machinery (D6 +
//! Q-a), and `idlefill://` deep links (D5). Version-locked citations to
//! tauri 2.12.1 live in the comments; the decision doc is
//! docs/architecture/tauri-cutover.md.

mod config;
mod deeplink;
mod glance;
mod lifecycle;
mod token;

use glance::Conn;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

/// The build marker (D7): baked at compile time from
/// IDLEFILL_BUILD_MARKER (tauri/build.sh), default `dev`. The Swift
/// analog's contract: `idlefill --version` prints `idlefill <marker>`.
pub fn build_marker() -> &'static str {
    option_env!("IDLEFILL_BUILD_MARKER").unwrap_or("dev")
}

const MAIN_LABEL: &str = "main";
const GLANCE_LABEL: &str = "glance";
const SETTINGS_LABEL: &str = "settings";

// ---------------------------------------------------------------------------
// shared state
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
struct LaunchdState {
    daemon_loaded: bool,
    arbiter_loaded: bool,
    arbiter_running: bool,
    menubar_loaded: bool,
    daemon_runs: Option<String>,
    arbiter_runs: Option<String>,
    menubar_runs: Option<String>,
    arbiter_note: Option<String>,
    daemon_note: Option<String>,
    menubar_note: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct GlanceState {
    conn: Conn,
    daemon_running: bool,
    sessions: Vec<glance::SessionRow>,
    sessions_count: Option<String>,
}

pub struct Shared {
    repo: PathBuf,
    launchd: Mutex<LaunchdState>,
    glance: Mutex<GlanceState>,
    hook: lifecycle::TestHook,
    /// The deep-link view hash carried into every (re)load — the
    /// desktop's dashboardHash (:1096).
    dashboard_hash: Mutex<Option<String>>,
    /// Q-a one-shot reload plumbing: `armed` arms on the dead edge and
    /// the dead->live edge consumes it (exactly one reload per
    /// transition, no storm — transitions are edges).
    armed: AtomicBool,
    prev_running: AtomicBool,
    first_tick: AtomicBool,
    tray: Mutex<Option<TrayIcon>>,
    /// Last tray click position (physical px) — the glance anchors there
    /// (the NSPopover-anchor substitute, D1).
    tray_pos: Mutex<Option<(f64, f64)>>,
    /// Last logged arbiter (loaded, running) pair — edge-only logging.
    last_launchd_live: Mutex<Option<(bool, bool)>>,
}

impl Shared {
    fn config_path_display(&self) -> String {
        config::client_config_path(&self.repo).display().to_string()
    }

    /// The tray word (D6): the loaded-but-exited arbiter wins over the
    /// arbiter verdict — "stopped" is the honest signal when the pid
    /// line is gone. Exception-Only otherwise.
    fn tray_word(&self) -> (String, bool) {
        let l = self.launchd.lock().unwrap();
        if l.arbiter_loaded && !l.arbiter_running {
            return ("stopped".into(), true);
        }
        let g = self.glance.lock().unwrap();
        let daemon_running = g.daemon_running;
        (
            glance::glance_status_row(g.conn, daemon_running, &self.config_path_display()),
            g.conn.red(),
        )
    }

    fn arbiter_label(&self) -> String {
        self.hook
            .label(lifecycle::ARBITER_LABEL, "IDLEFILL_TAURI_TEST_LABEL_ARBITER")
    }
    fn daemon_label(&self) -> String {
        self.hook
            .label(lifecycle::DAEMON_LABEL, "IDLEFILL_TAURI_TEST_LABEL_DAEMON")
    }
    fn menubar_label(&self) -> String {
        self.hook
            .label(lifecycle::MENUBAR_LABEL, "IDLEFILL_TAURI_TEST_LABEL_MENUBAR")
    }
}

// ---------------------------------------------------------------------------
// main window (D2 + D3)
// ---------------------------------------------------------------------------

/// dashboardURL(): the live origin from client/config.json + the stored
/// deep-link hash (IdlefillDesktop.swift:1989-1994, trailing-slash rule
/// ported verbatim).
fn dashboard_url(repo: &std::path::Path, hash: Option<&str>) -> Option<tauri::Url> {
    let cfg = config::load_client_config(repo);
    let u = cfg.server_url.filter(|s| !s.is_empty())?;
    let frag = hash.map(|h| format!("#{h}")).unwrap_or_default();
    let base = if u.ends_with('/') { u } else { format!("{u}/") };
    format!("{base}{frag}").parse().ok()
}

/// The runtime-built window (D2 LOCKED: WebviewWindowBuilder +
/// WebviewUrl::External). The token is re-read from client/config.json
/// on EVERY build path (D3 re-arm rule — a rotated token takes effect on
/// reload; the desktop's reloadDashboard :1999-2009 does the same).
fn build_main_window(app: &mut tauri::App) -> tauri::Result<()> {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let cfg = config::load_client_config(&shared.repo);
    let hash = shared.dashboard_hash.lock().unwrap().clone();
    let url = dashboard_url(&shared.repo, hash.as_deref())
        // No usable server_url: open on the 8787 default so tray +
        // settings stay reachable (the config-fallback posture).
        .or_else(|| "http://127.0.0.1:8787/".parse().ok())
        .unwrap();
    let origin_display = cfg.server_url.unwrap_or_else(|| "?".into());
    let mut builder = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::External(url))
        .title(format!("idlefill — {origin_display}"))
        .resizable(true)
        .inner_size(1280.0, 800.0)
        .on_page_load(|_win, payload| {
            // D6: the load events are the programmatic signal (the
            // spike's negative control: a dead origin fires NEITHER
            // Started nor Finished). eprintln = the acceptance log line.
            eprintln!("PAGE_LOAD {:?} {}", payload.event(), payload.url());
        });
    // D3: initialization_script -> wry WKUserScript AtDocumentStart
    // (wry 0.57.0 wkwebview/mod.rs:646-648,780-791). Empty/missing token
    // -> NO script (the page stays read-only with its own hint).
    if let Some(script) = token::gate_token_script(cfg.token.as_deref()) {
        builder = builder.initialization_script(script);
    }
    builder.build()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// tray (D1, Q-c LOCKED: single click = glance only)
// ---------------------------------------------------------------------------

fn tray_menu(app: &AppHandle, with_relaunch: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open", "Open Desktop", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    if with_relaunch {
        // D6 exception-only item: rendered ONLY in the loaded-but-exited
        // state (the desktop's strip row :2047-2055 re-homed to the tray).
        let relaunch =
            MenuItem::with_id(app, "relaunch", "Relaunch arbiter", true, None::<&str>)?;
        Menu::with_items(app, &[&open, &relaunch, &settings, &quit])
    } else {
        Menu::with_items(app, &[&open, &settings, &quit])
    }
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let handle = app.handle().clone();
    let menu = tray_menu(&handle, false)?;
    let icon = tauri::image::Image::new_owned(TRAY_RGBA.to_vec(), TRAY_W, TRAY_H);
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        // Q-c: the left click is the glance gesture, not a menu open.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "settings" => show_settings(app),
            "relaunch" => relaunch_arbiter(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event({
            let handle = handle.clone();
            move |tray, event| {
                // The anchor position rides every click event (hover
                // events carry one too, but they never act — see
                // tray_directive).
                if let TrayIconEvent::Click { position, .. } = &event {
                    let shared = tray.app_handle().state::<Arc<Shared>>();
                    *shared.tray_pos.lock().unwrap() = Some((position.x, position.y));
                }
                // The gesture resolves through the pure rule, then the
                // verdict runs. Toggle on the LEFT PRESS ONLY.
                // macOS fires Enter/Move/Leave for every pixel of hover
                // over the icon (tray-icon installs an NSTrackingArea
                // with MouseMoved), and mouseDown + mouseUp each fire a
                // Click. An unconditional toggle therefore flipped the
                // glance on every mouse movement near the icon — the
                // flicker the owner reported.
                let gesture = match &event {
                    TrayIconEvent::Click {
                        button,
                        button_state,
                        ..
                    } => match (button, button_state) {
                        (MouseButton::Left, MouseButtonState::Down) => TrayGesture::LeftPress,
                        (MouseButton::Left, MouseButtonState::Up) => TrayGesture::LeftRelease,
                        _ => TrayGesture::OtherPress,
                    },
                    TrayIconEvent::Enter { .. }
                    | TrayIconEvent::Move { .. }
                    | TrayIconEvent::Leave { .. } => TrayGesture::Hover,
                    _ => TrayGesture::OtherPress,
                };
                if tray_directive(gesture) == TrayDirective::ToggleGlance {
                    toggle_glance(&handle);
                }
            }
        })
        .build(app)?;
    *shared.tray.lock().unwrap() = Some(tray);
    Ok(())
}

// The tray icon: a 22x22 template PNG pre-rendered by
// tauri/make-tray-icon.py into icons/tray-icon.rgba (RGBA bytes; tauri's
// Image has no PNG decoder — the spike's correction). macOS draws a
// template image in the menu bar's own ink.
static TRAY_RGBA: &[u8] = include_bytes!("../icons/tray-icon.rgba");
const TRAY_W: u32 = 22;
const TRAY_H: u32 = 22;

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn show_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(
        app,
        SETTINGS_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("idlefill settings")
    .inner_size(600.0, 520.0)
    .resizable(true)
    .build();
}

/// D6 exception fix (relaunchArbiter :1555-1563): kickstart WITHOUT -k,
/// then reload the page — the same one-button fix for the blank canvas.
fn relaunch_arbiter(app: &AppHandle) {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let label = shared.arbiter_label();
    let note = lifecycle::kickstart(&label);
    shared.launchd.lock().unwrap().arbiter_note = note;
    refresh_launchd(app);
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.reload();
    }
}

// ---------------------------------------------------------------------------
// glance window (D1): a borderless positioned window, blur-dismissed.
// NOT an NSPopover (the stated degradation); the content renders the
// PURE specs (glance_status_row + glance_action_rows + the sessions
// projector) over IPC, so the cargo tests assert what ships. The pinned
// fallback (plain tray menu) also stays present: the native menu carries
// the same rows.
// ---------------------------------------------------------------------------

fn toggle_glance(app: &AppHandle) {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    if let Some(w) = app.get_webview_window(GLANCE_LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            return;
        }
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        let _ = WebviewWindowBuilder::new(
            app,
            GLANCE_LABEL,
            WebviewUrl::App("glance.html".into()),
        )
        .title("idlefill")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(true)
        .inner_size(280.0, 220.0)
        .build();
    }
    if let Some(w) = app.get_webview_window(GLANCE_LABEL) {
        if let Some((x, y)) = *shared.tray_pos.lock().unwrap() {
            // Anchor under the tray icon, right edge kept near it (the
            // hand-written NSPopover-anchor substitute, D1 cost (1)).
            let _ = w.set_position(PhysicalPosition::new(x - 240.0, y + 24.0));
        }
    }
}

// ---------------------------------------------------------------------------
// the 5s lifecycle tick (D4 — the only native poll; the desktop's Timer
// :256-265 ported) + the glance state poll (the menubar's 10s posture
// rides the same loop; one loop).
// ---------------------------------------------------------------------------

fn refresh_launchd(app: &AppHandle) {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let d = lifecycle::launchctl_print(&shared.daemon_label());
    let a = lifecycle::launchctl_print(&shared.arbiter_label());
    let m = lifecycle::launchctl_print(&shared.menubar_label());
    let mut st = shared.launchd.lock().unwrap();
    st.daemon_loaded = d.is_some();
    st.arbiter_loaded = a.is_some();
    st.menubar_loaded = m.is_some();
    st.daemon_runs = d.as_deref().and_then(lifecycle::first_argument);
    st.arbiter_runs = a.as_deref().and_then(lifecycle::first_argument);
    st.menubar_runs = m.as_deref().and_then(lifecycle::first_argument);
    // loaded != live: the pid line decides (e737411).
    st.arbiter_running = a.as_deref().and_then(lifecycle::pid_line).is_some();
    // Acceptance proof channel (gate 5): one log line per arbiter
    // loaded/running EDGE — the headless harness greps these. No state
    // churn, edges only.
    let live = (st.arbiter_loaded, st.arbiter_running);
    let mut last = shared.last_launchd_live.lock().unwrap();
    if *last != Some(live) {
        eprintln!(
            "LAUNCHD arbiter loaded={} running={}",
            live.0 as i32, live.1 as i32
        );
        *last = Some(live);
    }
    drop(st);

    // Q-a one-shot auto-reload: exactly one reload() per dead->live
    // transition edge. A dead tick arms; the running edge consumes the
    // arm. No timer loop storm (edges only).
    let running = shared.launchd.lock().unwrap().arbiter_running;
    if shared.first_tick.swap(false, Ordering::SeqCst) {
        shared.prev_running.store(running, Ordering::SeqCst);
    } else {
        let was_running = shared.prev_running.swap(running, Ordering::SeqCst);
        if !running {
            shared.armed.store(true, Ordering::SeqCst);
        }
        if running && !was_running && shared.armed.swap(false, Ordering::SeqCst) {
            if let Some(w) = app.get_webview_window(MAIN_LABEL) {
                eprintln!("AUTO_RELOAD dead->live edge (exactly one per transition)");
                let _ = w.reload();
            }
        }
    }

    // Re-render the tray from the shared state: tooltip = the word
    // (Exception-Only red lives in the glance HTML), and the menu
    // carries the exception-only Relaunch item only in the stopped
    // state (remove/insert at runtime, D4/D6).
    let (word, _red) = shared.tray_word();
    let with_relaunch = {
        let l = shared.launchd.lock().unwrap();
        glance::relaunch_row_present(l.arbiter_loaded, l.arbiter_running)
    };
    if let Some(tray) = shared.tray.lock().unwrap().as_ref() {
        let _ = tray.set_tooltip(Some(&word));
        if let Ok(menu) = tray_menu(app, with_relaunch) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    // Keep the glance current while it is open.
    if let Some(w) = app.get_webview_window(GLANCE_LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.eval("if(window.__glanceRefresh){window.__glanceRefresh();}");
        }
    }
}

fn spawn_ticks(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        poll_glance(&handle);
        refresh_launchd(&handle);
    });
}

/// The arbiter poll (the menubar's poll(): GET /api/state with the
/// Bearer token, 5s timeout; 401 -> bad token; fetch failure ->
/// unreachable; no token -> no request at all, the word names the
/// missing token).
fn poll_glance(app: &AppHandle) {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let cfg = config::load_client_config(&shared.repo);
    let client_name = cfg.client_name.clone();
    let (url, tok) = match (&cfg.server_url, &cfg.token) {
        (Some(u), Some(t)) => (u.clone(), token::SecretToken(Some(t.clone()))),
        _ => {
            shared.glance.lock().unwrap().conn = Conn::NoToken;
            return;
        }
    };
    drop(cfg);
    let full = format!("{}/api/state", url.trim_end_matches('/'));
    let auth = format!("Bearer {}", tok.0.as_deref().unwrap_or(""));
    let result = ureq::get(&full)
        .timeout(std::time::Duration::from_secs(5))
        .set("Authorization", &auth)
        .call();
    match result {
        Ok(resp) => {
            let body = resp.into_string().unwrap_or_default();
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let word = glance::state_word(&v);
            let now = now_ms();
            let running = glance::daemon_running(&v, client_name.as_deref(), now);
            let sessions = glance::project_sessions(&v, now);
            let count = glance::sessions_count_line(&sessions);
            let mut g = shared.glance.lock().unwrap();
            g.conn = word;
            g.daemon_running = running;
            g.sessions = sessions;
            g.sessions_count = count;
        }
        Err(e) => {
            // The same HTTP-status -> Conn mapping the menubar poll uses:
            // 401 -> unauthorized, any other failure -> unreachable.
            let status = match &e {
                ureq::Error::Status(code, _) => Some(*code),
                _ => None,
            };
            let ok_to_word = matches!(status, Some(401));
            shared.glance.lock().unwrap().conn = glance::conn_from_http(status, ok_to_word);
        }
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

// ---------------------------------------------------------------------------
// IPC commands (reachable ONLY from the bundled settings/glance windows:
// the capability file names those windows and no `remote` block — the
// remote arbiter page has NO IPC access at all, D4-shape's platform-
// enforced posture)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct SettingsSnapshot {
    daemon_loaded: bool,
    arbiter_loaded: bool,
    arbiter_running: bool,
    menubar_loaded: bool,
    arbiter_stopped: bool,
    daemon_runs: Option<String>,
    arbiter_runs: Option<String>,
    menubar_runs: Option<String>,
    daemon_note: Option<String>,
    arbiter_note: Option<String>,
    menubar_note: Option<String>,
    repo: String,
    config_path: String,
    marker: &'static str,
}

fn snapshot(app: &AppHandle) -> SettingsSnapshot {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let l = shared.launchd.lock().unwrap();
    SettingsSnapshot {
        daemon_loaded: l.daemon_loaded,
        arbiter_loaded: l.arbiter_loaded,
        arbiter_running: l.arbiter_running,
        menubar_loaded: l.menubar_loaded,
        arbiter_stopped: glance::relaunch_row_present(l.arbiter_loaded, l.arbiter_running),
        daemon_runs: l.daemon_runs.clone(),
        arbiter_runs: l.arbiter_runs.clone(),
        menubar_runs: l.menubar_runs.clone(),
        daemon_note: l.daemon_note.clone(),
        arbiter_note: l.arbiter_note.clone(),
        menubar_note: l.menubar_note.clone(),
        repo: shared.repo.display().to_string(),
        config_path: shared.config_path_display(),
        marker: build_marker(),
    }
}

#[tauri::command]
fn settings_state(app: AppHandle) -> SettingsSnapshot {
    snapshot(&app)
}

/// setArbiter parity (:1502-1527): the remote-arbiter refusal + the
/// foreign-port refusal guard the bootstrap; the scratch test-hook
/// bypasses both exactly as the Swift testDir rule does.
#[tauri::command]
fn set_arbiter(app: AppHandle, on: bool) -> SettingsSnapshot {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let test = shared.hook.dir.is_some();
    shared.launchd.lock().unwrap().arbiter_note = None;
    if on {
        if !test {
            let url = config::load_client_config(&shared.repo)
                .server_url
                .unwrap_or_default();
            if lifecycle::is_arbiter_remote(&url, config::server_config_exists(&shared.repo)) {
                shared.launchd.lock().unwrap().arbiter_note = Some(
                    "this checkout's server_url is a remote arbiter — a local agent would shadow it; not installed".into(),
                );
                refresh_launchd(&app);
                return snapshot(&app);
            }
            let port = config::server_config_port(&shared.repo);
            if let Some(owner) = lifecycle::foreign_port_owner(port, &shared.arbiter_label()) {
                shared.launchd.lock().unwrap().arbiter_note = Some(format!(
                    "port {port} is served by pid {owner}, not this agent — stop the hand-run arbiter first"
                ));
                refresh_launchd(&app);
                return snapshot(&app);
            }
        }
        let label = shared.arbiter_label();
        let xml = if test {
            lifecycle::test_plist_xml(&label)
        } else {
            lifecycle::arbiter_plist_xml(&label, &shared.repo)
        };
        let path = shared.hook.plist_dir().join(format!("{label}.plist"));
        shared.launchd.lock().unwrap().arbiter_note = lifecycle::install_label(&path, &xml);
    } else {
        let label = shared.arbiter_label();
        shared.launchd.lock().unwrap().arbiter_note = lifecycle::bootout_label(&label);
    }
    refresh_launchd(&app);
    snapshot(&app)
}

#[tauri::command]
fn set_daemon(app: AppHandle, on: bool) -> SettingsSnapshot {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let label = shared.daemon_label();
    shared.launchd.lock().unwrap().daemon_note = None;
    if on {
        let xml = if shared.hook.dir.is_some() {
            lifecycle::test_plist_xml(&label)
        } else {
            lifecycle::daemon_plist_xml(&label, &shared.repo)
        };
        let path = shared.hook.plist_dir().join(format!("{label}.plist"));
        shared.launchd.lock().unwrap().daemon_note = lifecycle::install_label(&path, &xml);
    } else {
        shared.launchd.lock().unwrap().daemon_note = lifecycle::bootout_label(&label);
    }
    refresh_launchd(&app);
    snapshot(&app)
}

#[tauri::command]
fn set_menubar(app: AppHandle, on: bool) -> SettingsSnapshot {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let label = shared.menubar_label();
    shared.launchd.lock().unwrap().menubar_note = None;
    if on {
        let xml = if shared.hook.dir.is_some() {
            lifecycle::test_plist_xml(&label)
        } else {
            lifecycle::menubar_plist_xml(&label, &shared.repo)
        };
        let path = shared.hook.plist_dir().join(format!("{label}.plist"));
        shared.launchd.lock().unwrap().menubar_note = lifecycle::install_label(&path, &xml);
    } else {
        shared.launchd.lock().unwrap().menubar_note = lifecycle::bootout_label(&label);
    }
    refresh_launchd(&app);
    snapshot(&app)
}

#[tauri::command]
fn relaunch_arbiter_cmd(app: AppHandle) -> SettingsSnapshot {
    relaunch_arbiter(&app);
    snapshot(&app)
}

/// The glance's render source: the pure specs projected to JSON. The
/// glance HTML never recomputes anything (the "rows render from the
/// spec" rule the Swift harnesses pinned).
#[tauri::command]
fn glance_state(app: AppHandle) -> Value {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let (word, red) = shared.tray_word();
    let g = shared.glance.lock().unwrap();
    let l = shared.launchd.lock().unwrap();
    json!({
        "word": word,
        "red": red,
        "sessionsCount": g.sessions_count,
        "exceptionLines": g
            .sessions
            .iter()
            .filter_map(|s| s.exception_line.clone())
            .collect::<Vec<_>>(),
        "rows": glance::glance_action_rows(),
        "relaunch": glance::relaunch_row_present(l.arbiter_loaded, l.arbiter_running),
    })
}

#[tauri::command]
fn glance_action(app: AppHandle, id: String) {
    match id.as_str() {
        "open" => {
            show_main(&app);
            if let Some(w) = app.get_webview_window(GLANCE_LABEL) {
                let _ = w.hide();
            }
        }
        "settings" => {
            show_settings(&app);
            if let Some(w) = app.get_webview_window(GLANCE_LABEL) {
                let _ = w.hide();
            }
        }
        "relaunch" => relaunch_arbiter(&app),
        "quit" => app.exit(0),
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// deep links (D5)
// ---------------------------------------------------------------------------

/// hashView(for:) (:1063-1072) + handleDeepLink/reloadDashboard
/// (:1082-1098, :1989-1994): map the URL to the page view, store the
/// hash so a later Reload keeps the view, navigate the live origin to
/// origin#view, focus the window. `open` and unknown hosts land on the
/// page default view (hashView -> None).
fn route_deep_link(app: &AppHandle, url: &str) {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let view = deeplink::hash_view(url);
    {
        let mut h = shared.dashboard_hash.lock().unwrap();
        *h = view;
    }
    let hash = shared.dashboard_hash.lock().unwrap().clone();
    if let Some(u) = dashboard_url(&shared.repo, hash.as_deref()) {
        if let Some(w) = app.get_webview_window(MAIN_LABEL) {
            let _ = w.show();
            let _ = w.set_focus();
            let _ = w.navigate(u);
        }
    } else {
        show_main(app);
    }
}

// ---------------------------------------------------------------------------
// tray-gesture rule (the glance-toggle flicker fix), pure spec so the
// cargo tests assert what ships
// ---------------------------------------------------------------------------

/// The tray event classes the rule cares about, abstracted so tests can
/// build them (tauri's TrayIconEvent carries a non-constructible Rect /
/// TrayIconId payload in a crate-private shape).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayGesture {
    /// Left mouse press on the icon (Click + Left + Down).
    LeftPress,
    /// Left mouse release on the icon (Click + Left + Up). A real click
    /// fires Down AND Up: toggling on both would open-then-close the
    /// glance on one click.
    LeftRelease,
    /// Hover: Enter / Move / Leave. macOS fires these for every pixel of
    /// mouse movement over the icon (tray-icon installs an NSTrackingArea
    /// with MouseMoved). Q-c LOCKED is CLICK = glance; hover never acts.
    Hover,
    /// Right/middle press or anything else (the menu path).
    OtherPress,
}

/// The native action the handler performs, decided by the pure rule.
#[derive(Debug, PartialEq, Eq)]
pub enum TrayDirective {
    /// Show/hide the glance (Q-c: single left click = glance).
    ToggleGlance,
    /// No native action.
    NoAction,
}

/// The tray gesture rule as a pure function: gesture -> verdict. ONLY
/// the left press toggles. Every other class is inert — that is the
/// flicker fix: hover Move events used to reach the toggle, so the
/// glance opened and closed with every mouse movement near the icon.
pub fn tray_directive(gesture: TrayGesture) -> TrayDirective {
    match gesture {
        TrayGesture::LeftPress => TrayDirective::ToggleGlance,
        _ => TrayDirective::NoAction,
    }
}

// ---------------------------------------------------------------------------
// window-event rule (D1), pure spec so the cargo tests assert what ships
// ---------------------------------------------------------------------------

/// The event kinds the rule cares about, abstracted so tests can build
/// them (tauri's WindowEvent is #[non_exhaustive] and CloseRequestApi is
/// not constructible outside the crate).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowEventKind {
    CloseRequested,
    Blurred,
    Other,
}

/// The native action the handler performs, decided by the pure rule.
#[derive(Debug, PartialEq, Eq)]
pub enum WindowDirective {
    /// D1 close-to-tray: the app keeps running behind the tray
    /// (prevent_close + hide). #71: BOTH halves — prevent alone left the
    /// red button doing nothing.
    CloseToTray,
    /// D1 cost (1) blur-dismiss for the glance.
    Dismiss,
    /// No native action (the settings window keeps its plain close).
    NoAction,
}

/// The D1 window rule as a pure function: label + event kind -> verdict.
pub fn window_directive(label: &str, kind: WindowEventKind) -> WindowDirective {
    match (label, kind) {
        (MAIN_LABEL, WindowEventKind::CloseRequested) => WindowDirective::CloseToTray,
        (GLANCE_LABEL, WindowEventKind::Blurred) => WindowDirective::Dismiss,
        _ => WindowDirective::NoAction,
    }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

pub fn build() -> tauri::Result<()> {
    // The `--version` marker contract survives the updater's death (D7):
    // `idlefill --version` prints `idlefill <marker>` and exits.
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-v") {
        println!("idlefill {}", build_marker());
        std::process::exit(0);
    }

    let repo = config::find_repo_root();
    let shared = Arc::new(Shared {
        repo,
        launchd: Mutex::new(LaunchdState::default()),
        glance: Mutex::new(GlanceState::default()),
        hook: lifecycle::TestHook::from_env(),
        dashboard_hash: Mutex::new(None),
        armed: AtomicBool::new(false),
        prev_running: AtomicBool::new(false),
        first_tick: AtomicBool::new(true),
        tray: Mutex::new(None),
        tray_pos: Mutex::new(None),
        last_launchd_live: Mutex::new(None),
    });

    let app = tauri::Builder::default()
        // Single instance FIRST with the deep-link feature (the
        // docs-documented desktop chain the spike verified). A second
        // launch forwards its idlefill:// argv through the same route.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for a in &argv {
                if a.starts_with("idlefill://") {
                    route_deep_link(app, a);
                }
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(shared)
        // Window events: close-to-tray for the main window (D1:
        // CloseRequested -> prevent_close + hide, webview_window.rs:1643 /
        // app.rs:103), blur-dismiss for the glance (D1 cost (1)).
        // The verdict is the pure window_directive (#71: prevent alone
        // left the red button doing nothing — CloseToTray carries BOTH
        // halves). Builder-level: this is the Builder's API (app.rs:2197),
        // not App's — setup has no on_window_event.
        .on_window_event(|window, event| {
            // One executor for every directive: the kind and the close
            // api resolve together, then the verdict runs BOTH halves
            // inline. An early `return` in the CloseRequested arm is how
            // the red X went back to being a no-op after #71 — the hide
            // half lived in a match that arm never reached.
            let (kind, api) = match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    (WindowEventKind::CloseRequested, Some(api))
                }
                tauri::WindowEvent::Focused(false) => (WindowEventKind::Blurred, None),
                _ => (WindowEventKind::Other, None),
            };
            match window_directive(window.label(), kind) {
                WindowDirective::CloseToTray => {
                    if let Some(api) = api {
                        api.prevent_close();
                    }
                    let _ = window.hide();
                }
                WindowDirective::Dismiss => {
                    let _ = window.hide();
                }
                WindowDirective::NoAction => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            settings_state,
            set_arbiter,
            set_daemon,
            set_menubar,
            relaunch_arbiter_cmd,
            glance_state,
            glance_action
        ])
        .setup(move |app| {
            build_main_window(app)?;
            build_tray(app)?;

            // App menu: Reload + ⌘R (the strip's Reload fact re-homed,
            // D4-shape), Open Desktop, Settings, Quit.
            let handle = app.handle().clone();
            let open = MenuItem::with_id(&handle, "open", "Open Desktop", true, None::<&str>)?;
            let settings =
                MenuItem::with_id(&handle, "settings", "Settings", true, None::<&str>)?;
            let reload =
                MenuItem::with_id(&handle, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            let quit =
                MenuItem::with_id(&handle, "quitapp", "Quit idlefill", true, Some("CmdOrCtrl+Q"))?;
            let app_menu = Menu::with_items(&handle, &[&open, &settings, &reload, &quit])?;
            app.set_menu(app_menu)?;
            handle.on_menu_event(move |app, event| match event.id().as_ref() {
                "open" => show_main(app),
                "settings" => show_settings(app),
                "reload" => {
                    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
                        let _ = w.reload();
                    }
                }
                "quitapp" => app.exit(0),
                _ => {}
            });

            // Deep links while running (D5): on_open_url -> hashView ->
            // navigate(origin#view) + focus. Cold start: the
            // single-instance argv path above.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let s = url.to_string();
                    eprintln!("DEEPLINK {s}");
                    route_deep_link(&handle, &s);
                }
            });

            refresh_launchd(app.handle());
            spawn_ticks(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())?;

    app.run(|app, event| {
        // Dock re-open (the desktop stays a .regular app, D1): re-show
        // the window (the Swift restore-as-a-GUI-app posture).
        if let tauri::RunEvent::Reopen { .. } = event {
            show_main(app);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // #71: the red close button on the main window must close-to-tray —
    // prevent AND hide. The handler executes this verdict; the directive
    // is the pin (the bug was the missing hide half).
    #[test]
    fn main_window_close_goes_to_tray() {
        assert_eq!(
            window_directive(MAIN_LABEL, WindowEventKind::CloseRequested),
            WindowDirective::CloseToTray
        );
    }

    // D1 cost (1): the glance dismisses on blur.
    #[test]
    fn glance_blur_dismisses() {
        assert_eq!(
            window_directive(GLANCE_LABEL, WindowEventKind::Blurred),
            WindowDirective::Dismiss
        );
    }

    // D1 pins ONLY the main window's close. The settings window keeps
    // its plain close (close-and-destroy, re-built by show_settings).
    #[test]
    fn settings_window_close_is_plain() {
        assert_eq!(
            window_directive(SETTINGS_LABEL, WindowEventKind::CloseRequested),
            WindowDirective::NoAction
        );
    }

    // The glance-toggle flicker: ONLY the left press acts. Hover
    // (Enter/Move/Leave) and the left release must be inert — the bug
    // was an unconditional toggle that every hover pixel and both click
    // halves reached.
    #[test]
    fn tray_left_press_is_the_only_toggle() {
        assert_eq!(
            tray_directive(TrayGesture::LeftPress),
            TrayDirective::ToggleGlance
        );
        assert_eq!(
            tray_directive(TrayGesture::LeftRelease),
            TrayDirective::NoAction
        );
        assert_eq!(tray_directive(TrayGesture::Hover), TrayDirective::NoAction);
        assert_eq!(
            tray_directive(TrayGesture::OtherPress),
            TrayDirective::NoAction
        );
    }

    // Nothing else reacts: labels outside the rule ignore both event
    // kinds, the glance never intercepts a close, the main window never
    // reacts to blur.
    #[test]
    fn no_other_label_or_pair_reacts() {
        assert_eq!(
            window_directive("glance", WindowEventKind::CloseRequested),
            WindowDirective::NoAction
        );
        assert_eq!(
            window_directive("main", WindowEventKind::Blurred),
            WindowDirective::NoAction
        );
        assert_eq!(
            window_directive(GLANCE_LABEL, WindowEventKind::CloseRequested),
            WindowDirective::NoAction
        );
        assert_eq!(
            window_directive(MAIN_LABEL, WindowEventKind::Other),
            WindowDirective::NoAction
        );
        assert_eq!(
            window_directive("whatever", WindowEventKind::Blurred),
            WindowDirective::NoAction
        );
    }
}
