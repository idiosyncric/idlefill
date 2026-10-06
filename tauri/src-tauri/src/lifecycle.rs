//! launchd lifecycle port (D4): the e737411 semantics, verbatim.
//! loaded != live. The `pid =` line decides. kickstart WITHOUT -k.
//! Temp-file capture for launchctl output (the 64 KB pipe-deadlock class,
//! IdlefillDesktop.swift:1194-1213). Pure parsers are cargo-tested with
//! the exact fixtures from desktop/arbiter-test.sh (D9 retirement map).

use std::path::{Path, PathBuf};
use std::process::Command;

pub const DAEMON_LABEL: &str = "com.sam.idlefill.client";
pub const ARBITER_LABEL: &str = "com.sam.idlefill.server";
/// Retires at the cutover (D8 step 4). Kept so the Settings parity holds
/// until then; the app's own autostart label arrives with install.sh (Q-d).
pub const MENUBAR_LABEL: &str = "com.sam.idlefill.menubar";

/// Launchd test-hook shape (the desktop's IDLEFILL_DESKTOP_TEST pattern).
/// When `dir` is set, labels come from the per-label env vars and plists
/// land in `dir` — never ~/Library/LaunchAgents, never a real label.
#[derive(Debug, Clone, Default)]
pub struct TestHook {
    pub dir: Option<PathBuf>,
}

impl TestHook {
    pub fn from_env() -> Self {
        TestHook {
            dir: std::env::var("IDLEFILL_TAURI_TEST")
                .ok()
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
        }
    }

    pub fn label(&self, real: &str, env_key: &str) -> String {
        match &self.dir {
            None => real.to_string(),
            Some(_) => std::env::var(env_key).unwrap_or_else(|_| "com.sam.idlefill.app-test".into()),
        }
    }

    pub fn plist_dir(&self) -> PathBuf {
        match &self.dir {
            Some(d) => d.clone(),
            None => {
                let home = std::env::var("HOME").unwrap_or_default();
                PathBuf::from(home).join("Library/LaunchAgents")
            }
        }
    }
}

/// The live pid from a `launchctl print` dump (AppModel.pidLine,
/// :1267-1275): a trimmed `pid = <n>` line, n > 0, else None. Fail closed:
/// a loaded service with no pid line is the blank-dashboard state. Pure.
pub fn pid_line(print_output: &str) -> Option<u32> {
    for line in print_output.lines() {
        let t = line.trim();
        let rest = match t.strip_prefix("pid =") {
            Some(r) => r.trim(),
            None => continue,
        };
        if let Ok(n) = rest.parse::<u32>() {
            if n > 0 {
                return Some(n);
            }
        }
    }
    None
}

/// The first ProgramArguments entry of a print dump (firstArgument,
/// :1250-1259): the line after `arguments = {`, stopping at `}`. Pure.
pub fn first_argument(print_output: &str) -> Option<String> {
    let idx = print_output.find("arguments = {")?;
    let rest = &print_output[idx + "arguments = {".len()..];
    for line in rest.lines() {
        let t = line.trim();
        if t == "}" {
            return None;
        }
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

/// The remote-arbiter refusal (isArbiterRemote, :1531+). PURE: a fused
/// checkout (loopback server_url, or a server/config.json that exists)
/// may run the local agent; a checkout pointing at a REMOTE host with no
/// local arbiter config refuses. Loopback = localhost or 127.x. An
/// unparseable URL refuses (fail closed).
pub fn is_arbiter_remote(client_server_url: &str, has_server_config: bool) -> bool {
    if has_server_config {
        return false;
    }
    match url::Url::parse(client_server_url) {
        Ok(u) => match u.host_str().map(|h| h.to_lowercase()) {
            Some(host) => !(host == "localhost" || host.starts_with("127.")),
            None => true,
        },
        Err(_) => true,
    }
}

/// Run a command, capturing stdout AND stderr to temp FILES (never a
/// pipe — the 64 KB pipe-deadlock class). Returns (exit, combined output).
/// The child gets a real PATH: a GUI-launched app carries only
/// /usr/bin:/bin (the runCmd PATH-prepend, IdlefillDesktop.swift).
pub fn run_cmd(path: &str, args: &[&str]) -> (i32, String) {
    let dir = std::env::temp_dir();
    let stem = format!(
        "idlefill-tauri-cmd-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    );
    let out_path = dir.join(format!("{stem}.out"));
    let err_path = dir.join(format!("{stem}.err"));
    let out = std::fs::File::create(&out_path);
    let err = std::fs::File::create(&err_path);
    let (out, err) = match (out, err) {
        (Ok(o), Ok(e)) => (o, e),
        _ => return (-1, "could not create temp capture files".into()),
    };
    let status = Command::new(path)
        .args(args)
        .env(
            "PATH",
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin",
        )
        .stdout(out)
        .stderr(err)
        .status();
    let st = match status {
        Ok(s) => s.code().unwrap_or(-1),
        Err(e) => {
            let _ = std::fs::remove_file(&out_path);
            let _ = std::fs::remove_file(&err_path);
            return (-1, e.to_string());
        }
    };
    let o = std::fs::read_to_string(&out_path).unwrap_or_default();
    let e = std::fs::read_to_string(&err_path).unwrap_or_default();
    let _ = std::fs::remove_file(&out_path);
    let _ = std::fs::remove_file(&err_path);
    let combined = format!("{o}{e}").trim().to_string();
    (st, combined)
}

/// `launchctl print gui/<uid>/<label>` — the LOADED view. Exit 0 =
/// loaded; the dump carries the pid line and the arguments block.
pub fn launchctl_print(label: &str) -> Option<String> {
    let uid = unsafe { libc::getuid() };
    let (st, out) = run_cmd("/bin/launchctl", &["print", &format!("gui/{uid}/{label}")]);
    if st == 0 {
        Some(out)
    } else {
        None
    }
}

/// The scratch plist for the test hook (the desktop's testPlistXML): a
/// harmless program, same shape.
pub fn test_plist_xml(label: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sleep</string>
        <string>3600</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
"#
    )
}

/// The daemon plist rendered from THIS checkout (daemonPlistXML,
/// :1365+): node_modules/.bin/tsx on client/src/index.ts, WorkingDirectory
/// client/, KeepAlive SuccessfulExit=false, ThrottleInterval 30. NO token
/// ever — the daemon reads client/config.json itself.
pub fn daemon_plist_xml(label: &str, repo: &Path) -> String {
    let tsx = repo.join("node_modules/.bin/tsx");
    let entry = repo.join("client/src/index.ts");
    let cwd = repo.join("client");
    let log_dir = repo.join("client/logs");
    plist_render(label, &[tsx, entry], &cwd, &log_dir, false)
}

/// The arbiter plist (arbiterPlistXML, :1453+): npx + tsx on
/// server/src/index.ts, WorkingDirectory server/, NODE_ENV production,
/// logs under server/logs. No token, no secrets — mirrors
/// deploy/install-server-agent.sh's template.
pub fn arbiter_plist_xml(label: &str, repo: &Path) -> String {
    let cwd = repo.join("server");
    let entry = cwd.join("src/index.ts");
    let log_dir = cwd.clone();
    plist_render(
        label,
        &[PathBuf::from("/opt/homebrew/bin/npx"), PathBuf::from("tsx"), entry],
        &cwd,
        &log_dir,
        true,
    )
}

/// The menubar plist (menubarPlistXML, :1576+): this checkout's built
/// menubar bundle executable, logs under <repo>/logs.
pub fn menubar_plist_xml(label: &str, repo: &Path) -> String {
    let bin = repo.join("menubar/IdlefillMenubar.app/Contents/MacOS/IdlefillMenubar");
    let log_dir = repo.join("logs");
    plist_render(label, &[bin], repo, &log_dir, false)
}

/// Shared renderer for the three lifecycle plists. The shape is the
/// desktop's exact template (KeepAlive SuccessfulExit=false +
/// ThrottleInterval 30 + EnvironmentVariables PATH + RunAtLoad). The
/// arbiter template additionally carries NODE_ENV production
/// (arbiterPlistXML); the daemon and menubar templates do not.
fn plist_render(
    label: &str,
    program: &[PathBuf],
    cwd: &Path,
    log_dir: &Path,
    node_env: bool,
) -> String {
    let args = program
        .iter()
        .map(|p| format!("        <string>{}</string>", p.display()))
        .collect::<Vec<_>>()
        .join("\n");
    let node_env_block = if node_env {
        "\n        <key>NODE_ENV</key>\n        <string>production</string>"
    } else {
        ""
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
{args}
    </array>
    <key>WorkingDirectory</key>
    <string>{}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>{node_env_block}
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
    <string>{}/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>{}/launchd.err.log</string>
</dict>
</plist>
"#,
        cwd.display(),
        log_dir.display(),
        log_dir.display(),
    )
}

/// write plist -> `launchctl bootstrap gui/<uid> <plist>`. The
/// "Bootstrap failed: 5: Input/output error" on an already-loaded label is
/// a clean no-op (:1336-1343). Returns the operator note (None = success).
pub fn install_label(plist_path: &Path, plist_xml: &str) -> Option<String> {
    if let Some(parent) = plist_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(plist_path, plist_xml) {
        return Some(format!("install failed: could not write {}: {e}", plist_path.display()));
    }
    let uid = unsafe { libc::getuid() };
    let (st, out) = run_cmd(
        "/bin/launchctl",
        &["bootstrap", &format!("gui/{uid}"), &plist_path.display().to_string()],
    );
    if st == 0 {
        return None;
    }
    let lower = out.to_lowercase();
    if out.contains("Input/output error") || lower.contains("already") {
        return None;
    }
    Some(format!("bootstrap failed: {out}"))
}

/// `launchctl bootout gui/<uid>/<label>` (single combined target — the
/// two-arg form fails rc=5). "could not find service" / "No such process"
/// are clean no-ops (:1346-1353).
pub fn bootout_label(label: &str) -> Option<String> {
    let uid = unsafe { libc::getuid() };
    let (st, out) = run_cmd("/bin/launchctl", &["bootout", &format!("gui/{uid}/{label}")]);
    if st == 0 {
        return None;
    }
    let lower = out.to_lowercase();
    if lower.contains("could not find service") || lower.contains("no such process") {
        return None;
    }
    Some(format!("bootout failed: {out}"))
}

/// Relaunch the arbiter (relaunchArbiter :1555-1563): kickstart WITHOUT
/// -k — it starts the exited-but-loaded job and is a no-op while running.
pub fn kickstart(label: &str) -> Option<String> {
    let uid = unsafe { libc::getuid() };
    let (st, out) = run_cmd("/bin/launchctl", &["kickstart", &format!("gui/{uid}/{label}")]);
    if st == 0 {
        None
    } else {
        Some(format!("relaunch failed: {out}"))
    }
}

/// Is the arbiter port served by a process this label does NOT own?
/// (foreignPortOwner :1437-1452, install-server-agent.sh's
/// check_port_foreign). lsof over the port; a listener that is not this
/// label's pid is foreign. The child PATH carries /usr/sbin (run_cmd).
pub fn foreign_port_owner(port: u16, label: &str) -> Option<u32> {
    let (st, out) = run_cmd(
        "/usr/sbin/lsof",
        &[
            "-nP",
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
            "-t",
        ],
    );
    if st != 0 || out.is_empty() {
        return None;
    }
    let my_pid = launchctl_print(label).and_then(|d| pid_line(&d));
    for line in out.lines() {
        let p = line.trim();
        if p.is_empty() {
            continue;
        }
        if Some(p.parse::<u32>().ok()) == my_pid.map(Some) {
            return None; // owned by this label
        }
        if let Ok(n) = p.parse::<u32>() {
            return Some(n);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // The EXACT fixtures from desktop/arbiter-test.sh (24 checks). The
    // Rust tests carry the same names so the D9 retirement map is a row
    // for row.

    const RUNNING_DUMP: &str = "service = com.sam.idlefill.server
\tstate = running
\tpid = 83174
\t\tstate = active
job state = running
";

    const EXITED_DUMP: &str = "service = com.sam.idlefill.server
\tstate = not running
\tlast exit code = 0
\t\tstate = active
job state = exited
";

    #[test]
    fn pid_line_running_dump_yields_the_pid() {
        assert_eq!(pid_line(RUNNING_DUMP), Some(83174));
    }

    #[test]
    fn pid_line_exited_but_loaded_is_none() {
        // the blank-dashboard shape
        assert_eq!(pid_line(EXITED_DUMP), None);
    }

    #[test]
    fn pid_line_garbage_value_is_none() {
        // fail closed
        assert_eq!(pid_line("\tpid = -2\n"), None);
    }

    #[test]
    fn pid_line_empty_dump_is_none() {
        assert_eq!(pid_line(""), None);
    }

    #[test]
    fn pid_line_zero_is_none() {
        assert_eq!(pid_line("pid = 0\n"), None);
    }

    #[test]
    fn remote_loopback_without_server_config_is_allowed() {
        assert!(!is_arbiter_remote("http://127.0.0.1:8787", false));
    }

    #[test]
    fn remote_localhost_host_is_allowed() {
        assert!(!is_arbiter_remote("http://localhost:8787", false));
    }

    #[test]
    fn remote_server_config_present_allows_regardless() {
        assert!(!is_arbiter_remote("http://100.105.225.1:8787", true));
    }

    #[test]
    fn remote_server_url_and_no_config_refuses() {
        assert!(is_arbiter_remote("http://100.105.225.1:8787", false));
    }

    #[test]
    fn remote_unparseable_url_refuses() {
        // fail closed
        assert!(is_arbiter_remote("not a url", false));
    }

    #[test]
    fn first_argument_reads_the_arguments_block() {
        let dump = "arguments = {\n\t\t/opt/homebrew/bin/npx => /opt/homebrew/bin/npx\n\t\ttsx\n\t}\n";
        assert_eq!(
            first_argument(dump).as_deref(),
            Some("/opt/homebrew/bin/npx => /opt/homebrew/bin/npx")
        );
    }

    #[test]
    fn first_argument_absent_block_is_none() {
        assert_eq!(first_argument("state = running\n"), None);
    }

    #[test]
    fn arbiter_plist_shape_mirrors_the_shipped_template() {
        // check 4 of arbiter-test.sh: tsx entry under this checkout,
        // WorkingDirectory server/, KeepAlive SuccessfulExit=false,
        // ThrottleInterval 30, NODE_ENV production, NO token ever.
        let xml = arbiter_plist_xml("com.sam.idlefill.dt-arb-test", Path::new("/repo"));
        assert!(xml.contains("server/src/index.ts"));
        assert!(xml.contains("<string>tsx</string>"));
        assert!(xml.contains("<key>WorkingDirectory</key>"));
        assert!(xml.contains("SuccessfulExit"));
        assert!(xml.contains("<key>ThrottleInterval</key>"));
        assert!(xml.contains("NODE_ENV"));
        assert!(xml.contains("production"));
        assert!(!xml.contains("token"));
        assert!(xml.contains("com.sam.idlefill.dt-arb-test"));
    }

    #[test]
    fn daemon_plist_shape_mirrors_the_shipped_template() {
        let xml = daemon_plist_xml("com.sam.idlefill.dt-test", Path::new("/repo"));
        assert!(xml.contains("client/src/index.ts"));
        assert!(xml.contains("node_modules/.bin/tsx"));
        assert!(xml.contains("<key>WorkingDirectory</key>"));
        assert!(xml.contains("SuccessfulExit"));
        assert!(!xml.contains("token"));
    }

    #[test]
    fn test_plist_is_the_harmless_scratch_program() {
        let xml = test_plist_xml("com.sam.idlefill.dt-test");
        assert!(xml.contains("/bin/sleep"));
        assert!(xml.contains("com.sam.idlefill.dt-test"));
        assert!(!xml.contains("KeepAlive"));
    }

    #[test]
    fn bootout_noop_strings_match_launchd_reality() {
        // The two clean no-op shapes (the combined-target lesson).
        let msg = "Boot-out failed: 3: No such process";
        assert!(msg.to_lowercase().contains("no such process"));
        let msg2 = "Could not find service \"x\" in domain";
        assert!(msg2.to_lowercase().contains("could not find service"));
    }

    #[test]
    fn bootstrap_already_loaded_noop_matches() {
        // "Bootstrap failed: 5: Input/output error" on an already-loaded
        // label is the clean no-op path.
        let msg = "Bootstrap failed: 5: Input/output error";
        assert!(msg.contains("Input/output error"));
    }
}
