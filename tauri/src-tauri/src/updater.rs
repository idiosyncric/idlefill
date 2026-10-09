//! The shell's signed updater channel (issue #75, decision doc
//! docs/architecture/shell-updater.md). D2/D6 LOCKED: the feed is the
//! Forgejo release endpoint (two anonymous GETs, no auth, the
//! `latest` pseudo-tag shape), and the check is GUI-triggered — NO
//! check at launch, NO timer, NO watchdog. The only trigger is the
//! settings window's "Check for updates…" verb.
//!
//! D4 (key plane): the shell verifies a download ONLY against a
//! non-empty `plugins.updater.pubkey` (tauri.conf.json, content in the
//! repo — public by design). An empty pubkey means the updater is
//! INERT, not broken: every command returns a clean "channel off"
//! result and NO feed request is made (the channel is off by
//! configuration, fail-closed). This is the committed, key-free
//! posture: the operator generates the keypair (the owner step, #75
//! "Blocked on the owner"), drops the public key into the config, and
//! the first signed release turns the channel live.
//!
//! The plugin itself is always registered (it needs no key to manage
//! its state — verified against tauri-plugin-updater 2.13.2: the
//! Builder::build setup stores the config verbatim, validation is
//! per-request). Registration is free; use is gated on the pubkey.
//!
//! Every verdict here is a PURE function (the pin rule the tray and
//! window rules use, lib.rs: the pure spec, the cargo tests assert
//! what ships). The IPC commands are thin executors over these.

use serde::Serialize;
use serde_json::json;
use tauri_plugin_updater::UpdaterExt;

/// The status word the settings view renders. `none` = the channel is
/// configured and the check found nothing newer than the installed
/// shell (the normal state, not an error).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatus {
    /// The pubkey is empty/absent: the updater is inert (D4). The view
    /// renders the meta line only — no check is even attempted.
    Inert,
    /// The check ran and no newer version exists on the feed.
    None,
    /// A newer version exists on the feed.
    Available,
    /// The check failed (the feed is unreachable, the manifest is bad,
    /// the signature is bad). `message` carries the reason.
    Error,
}

/// One state the settings Update section can be in. `version` is the
/// feed's SemVer (`1.0.<N>`, D5) — present only when Available.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub status: UpdateStatus,
    pub version: Option<String>,
    pub message: Option<String>,
}

impl UpdateState {
    pub fn inert() -> Self {
        Self {
            status: UpdateStatus::Inert,
            version: None,
            message: None,
        }
    }

    pub fn none() -> Self {
        Self {
            status: UpdateStatus::None,
            version: None,
            message: None,
        }
    }

    pub fn available(version: impl Into<String>) -> Self {
        Self {
            status: UpdateStatus::Available,
            version: Some(version.into()),
            message: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            status: UpdateStatus::Error,
            version: None,
            message: Some(message.into()),
        }
    }
}

/// The download-progress word for one on_chunk tick. `done` is the
/// running byte total, `total` is the content length (the feed's
/// `Content-Length`; absent = a chunked body, so the line shows the
/// running total only — no fake percentage).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub done: u64,
    pub total: Option<u64>,
}

/// The feed URL (D2 LOCKED): the `latest` pseudo-tag shape, the one
/// entry of `plugins.updater.endpoints` in tauri.conf.json. The
/// GitHub-style route `/releases/latest/download/` 404s on Forgejo —
/// never use it.
pub const FEED_URL: &str =
    "https://git.samwarth.com/sam/idlefill/releases/download/latest/latest.json";

/// The installed version, read from the app config at runtime (the
/// `version` field tauri/build.sh cuts via the TAURI_CONFIG merge).
fn installed_version(app: &tauri::AppHandle) -> semver::Version {
    app.config()
        .version
        .clone()
        .unwrap_or_default()
        .parse()
        .unwrap_or_else(|_| semver::Version::new(0, 0, 0))
}

/// The D4 gate: the channel is OFF by configuration when the pubkey
/// (tauri.conf.json `plugins.updater.pubkey`) is empty/absent.
/// `tauri-plugin-updater 2.13.2` `Builder::build` stores the config
/// verbatim at setup (no validation), so the gate lives HERE — the
/// commands refuse before any feed request.
pub fn channel_configured(app: &tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// The pure check verdict (D5: the SemVer compare the updater itself
/// applies): a feed version equal to or below the installed one is
/// ignored.
pub fn check_verdict(installed: &semver::Version, feed: &semver::Version) -> UpdateStatus {
    if feed > installed {
        UpdateStatus::Available
    } else {
        UpdateStatus::None
    }
}

/// The pure status-line text the settings view renders (the harness
/// rule: the view renders the verdict, it never recomputes one).
pub fn status_line(state: &UpdateState, progress: Option<&DownloadProgress>) -> String {
    match state.status {
        UpdateStatus::Inert => {
            "updater off — no signing key configured (owner step: generate the keypair)".into()
        }
        UpdateStatus::None => "up to date".into(),
        UpdateStatus::Available => match progress {
            Some(p) => {
                let v = state.version.as_deref().unwrap_or("?");
                match p.total {
                    Some(t) if t > 0 => format!("downloading {v} — {} / {} bytes", p.done, t),
                    _ => format!("downloading {v} — {} bytes", p.done),
                }
            }
            None => format!("update {} available", state.version.as_deref().unwrap_or("?")),
        },
        UpdateStatus::Error => format!(
            "check failed — {}",
            state.message.as_deref().unwrap_or("unknown error")
        ),
    }
}

/// Run the GUI-triggered check (D6: this is the ONLY trigger — no call
/// site outside the command the settings window invokes). Inert when
/// the pubkey is empty (fail-closed by configuration, D4).
///
/// The plugin already compares SemVer (its default comparator: newer
/// only) and returns `None` for equal-or-older feeds — `check_verdict`
/// is the same rule pinned as a pure function the tests assert.
pub async fn check(app: &tauri::AppHandle) -> UpdateState {
    if !channel_configured(app) {
        return UpdateState::inert();
    }
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => return UpdateState::error(format!("updater init: {e}")),
    };
    match updater.check().await {
        Ok(Some(found)) => {
            // The plugin already verified the signature against the pubkey
            // and applied its own "newer only" comparator. The shell
            // re-asserts its own D5 rule (the pure spec the tests pin): a
            // feed version equal to or below the installed one is ignored.
            match found.version.parse::<semver::Version>() {
                Ok(feed) => match check_verdict(&installed_version(app), &feed) {
                    UpdateStatus::Available => UpdateState::available(found.version),
                    _ => UpdateState::none(),
                },
                Err(e) => UpdateState::error(format!("feed version is not SemVer: {e}")),
            }
        }
        Ok(None) => UpdateState::none(),
        Err(e) => UpdateState::error(e.to_string()),
    }
}

/// Download-and-install. Only meaningful in the Available state; the
/// settings row that calls it renders only then (D6 exception-only).
/// The updater's install replaces the app bundle and relaunches it (the
/// relaunch path D6 checks against the D1 tray-keepalive by
/// acceptance). `on_progress` gets the running byte total per chunk.
///
/// It re-runs the check to obtain the found `Update` (the plugin holds
/// the signature + url per found release), then downloads and installs
/// THAT release — no stale state, and it is a no-op (a named error)
/// when the check finds nothing newer.
pub async fn install(
    app: &tauri::AppHandle,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<(), String> {
    if !channel_configured(app) {
        return Err("updater off — no signing key configured".into());
    }
    let updater = app
        .updater()
        .map_err(|e| format!("updater init: {e}"))?;
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return Err("no update found on the feed".into()),
        Err(e) => return Err(e.to_string()),
    };
    let mut done: u64 = 0;
    update
        .download_and_install(
            |chunk: usize, total: Option<u64>| {
                done = done.saturating_add(chunk as u64);
                on_progress(done, total);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

/// Build the `latest.json` manifest (the D3 LOCKED shape) from the
/// release inputs. PURE: no I/O, no env — `scripts/release.sh` feeds
/// the values, and the dry-run harness (tauri/ui/test/
/// updater-manifest.test.ts) asserts the same shape against stand-in
/// artifacts.
///
/// Contract (D3, verified against the client, tauri-plugin-updater
/// 2.13.2 `verify_signature` + tauri-cli 2.12.1 `sign_file`):
/// - `version` is the release SemVer `1.0.<N>` (D5); a leading `v` is
///   stripped (the tag v3 -> 1.0.3 is the release.sh mapping).
/// - `platforms` keys are `<os>-<arch>` (`darwin-aarch64` today; the
///   keys are additive — a future Intel build adds `darwin-x86_64`).
/// - each platform's `signature` is the base64 (STANDARD) of the
///   `.sig` FILE CONTENT. The tauri-cli writes the `.sig` as one
///   base64 line (the minisign signature box, 4-line text), and the
///   client base64-decodes the manifest field back to that text and
///   decodes the signature box — so the field is the file content
///   base64'd, one line. A PATH or a URL in the field is rejected by
///   the client; this builder refuses it too.
/// - `notes` + `pub_date` (RFC 3339) are optional, present when given.
pub fn latest_json(
    version: &str,
    platforms: &[(&str, &str, &str)],
    notes: Option<&str>,
    pub_date: Option<&str>,
) -> Result<serde_json::Value, String> {
    let v = version.trim().trim_start_matches('v').trim().to_string();
    if v.is_empty() {
        return Err("version is empty".into());
    }
    semver::Version::parse(&v).map_err(|e| format!("version is not SemVer: {e}"))?;
    if platforms.is_empty() {
        return Err("no platforms".into());
    }
    let mut platforms_json = serde_json::Map::new();
    for (platform, url, signature) in platforms {
        if platform.trim().is_empty() {
            return Err("platform key is empty".into());
        }
        if url.trim().is_empty() {
            return Err(format!("url is empty for platform {platform}"));
        }
        // The .sig field is the base64 of the .sig file content: one
        // line, STANDARD base64 alphabet. Anything else is the
        // operator pasting a path or a URL — the client rejects both.
        if !is_sig_b64(signature) {
            return Err(format!(
                "signature for {platform} is not base64 .sig content (expected one base64 line)"
            ));
        }
        platforms_json.insert(
            platform.to_string(),
            json!({ "url": url, "signature": signature }),
        );
    }
    let mut obj = serde_json::Map::new();
    obj.insert("version".into(), json!(v));
    if let Some(pd) = pub_date {
        if pd.is_empty() {
            return Err("pub_date is empty".into());
        }
        obj.insert("pub_date".into(), json!(pd));
    }
    if let Some(n) = notes {
        obj.insert("notes".into(), json!(n));
    }
    obj.insert("platforms".into(), serde_json::Value::Object(platforms_json));
    Ok(serde_json::Value::Object(obj))
}

/// The `.sig` field check: one line, STANDARD base64 alphabet
/// ([A-Za-z0-9+/=]), non-empty. Pure — the harness re-asserts it in
/// TypeScript.
pub fn is_sig_b64(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() || t.contains(char::is_whitespace) {
        return false;
    }
    t.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=')
}

#[cfg(test)]
mod tests {
    use super::*;
    use semver::Version;

    // D5: a newer feed version is the only Available verdict.
    #[test]
    fn check_verdict_newer_only() {
        let installed = Version::new(1, 0, 0);
        assert_eq!(check_verdict(&installed, &Version::new(1, 0, 1)), UpdateStatus::Available);
        assert_eq!(check_verdict(&installed, &Version::new(1, 0, 0)), UpdateStatus::None);
        assert_eq!(check_verdict(&installed, &Version::new(0, 9, 9)), UpdateStatus::None);
    }

    // The status line is the pure spec: each state has exactly one
    // wording, the download progress overrides the available line.
    #[test]
    fn status_line_words() {
        assert_eq!(
            status_line(&UpdateState::inert(), None),
            "updater off — no signing key configured (owner step: generate the keypair)"
        );
        assert_eq!(status_line(&UpdateState::none(), None), "up to date");
        assert_eq!(
            status_line(&UpdateState::available("1.0.3"), None),
            "update 1.0.3 available"
        );
        let p = Some(&DownloadProgress { done: 4096, total: Some(8192) });
        assert_eq!(
            status_line(&UpdateState::available("1.0.3"), p),
            "downloading 1.0.3 — 4096 / 8192 bytes"
        );
        let p = Some(&DownloadProgress { done: 4096, total: None });
        assert_eq!(
            status_line(&UpdateState::available("1.0.3"), p),
            "downloading 1.0.3 — 4096 bytes"
        );
        assert_eq!(
            status_line(&UpdateState::error("feed unreachable".to_string()), None),
            "check failed — feed unreachable"
        );
    }

    // D3: the manifest shape — the exact contract the dry-run harness
    // re-asserts in TypeScript over stand-in artifacts. The signature
    // field is the base64 of the .sig file content (one line).
    #[test]
    fn latest_json_shape() {
        let sig = base64_std("untrusted comment: signature from tauri secret key\nRWR...\n");
        let v = latest_json(
            "1.0.3",
            &[("darwin-aarch64", "https://git.samwarth.com/sam/idlefill/releases/download/latest/Idlefill.app.tar.gz", &sig)],
            Some("Release #3"),
            Some("2026-10-09T12:00:00Z"),
        )
        .expect("valid inputs");
        assert_eq!(v["version"], "1.0.3");
        assert_eq!(v["pub_date"], "2026-10-09T12:00:00Z");
        assert_eq!(v["notes"], "Release #3");
        let p = &v["platforms"]["darwin-aarch64"];
        assert!(p["url"].as_str().unwrap().ends_with("Idlefill.app.tar.gz"));
        assert_eq!(p["signature"], sig);
        // No extra keys: the client contract is exactly these.
        assert_eq!(v.as_object().unwrap().len(), 4);
    }

    /// A tiny STANDARD-base64 encoder for the tests (the real path
    /// base64s the .sig file in release.sh; this pins the alphabet).
    fn base64_std(s: &str) -> String {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        let b: Vec<u8> = s.as_bytes().to_vec();
        for c in b.chunks(3) {
            let v = ((c[0] as u32) << 16)
                | ((c.get(1).copied().unwrap_or(0) as u32) << 8)
                | c.get(2).copied().unwrap_or(0) as u32;
            out.push(A[(v >> 18) as usize & 63] as char);
            out.push(A[(v >> 12) as usize & 63] as char);
            out.push(if c.len() > 1 { A[(v >> 6) as usize & 63] as char } else { '=' });
            out.push(if c.len() > 2 { A[v as usize & 63] as char } else { '=' });
        }
        out
    }

    // The leading `v` is stripped (the tag v3 -> 1.0.3 mapping).
    #[test]
    fn latest_json_strips_leading_v() {
        let v = latest_json("v1.0.3", &[("darwin-aarch64", "https://x/Idlefill.app.tar.gz", "sig")], None, None)
            .expect("valid");
        assert_eq!(v["version"], "1.0.3");
        assert!(v.get("pub_date").is_none());
        assert!(v.get("notes").is_none());
    }

    // Fail-closed inputs: a non-SemVer version, an empty platform, and a
    // signature that is a PATH or a URL (the client rejects both — the
    // field must be one base64 line).
    #[test]
    fn latest_json_rejects_bad_inputs() {
        let bad_sig = "dX50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK";
        assert!(latest_json("not-semver", &[("darwin-aarch64", "https://x/y", bad_sig)], None, None).is_err());
        assert!(latest_json("1.0.0", &[], None, None).is_err());
        assert!(latest_json("1.0.3", &[("", "https://x/y", bad_sig)], None, None).is_err());
        assert!(latest_json("1.0.3", &[("darwin-aarch64", "", bad_sig)], None, None).is_err());
        assert!(latest_json("1.0.3", &[("darwin-aarch64", "https://x/y", "")], None, None).is_err());
        // A PATH and a URL are not base64 .sig content (the '/' rule).
        assert!(latest_json("1.0.3", &[("darwin-aarch64", "https://x/y", "~/keys/sig.txt")], None, None).is_err());
        assert!(latest_json("1.0.3", &[("darwin-aarch64", "https://x/y", "https://x/sig")], None, None).is_err());
        // A multi-line .sig pasted raw (unencoded) is rejected.
        assert!(latest_json("1.0.3", &[("darwin-aarch64", "https://x/y", "line1\nline2")], None, None).is_err());
    }
}
