//! Runtime config: repo root discovery + the gitignored client config parse.
//! Port of the desktop app's token()/serverURL()/findRepoRoot() semantics
//! (IdlefillDesktop.swift:1123-1137). The token is read at call time,
//! never baked, never printed, never logged.

use std::path::PathBuf;

#[derive(Debug, Default, Clone)]
pub struct ClientConfig {
    pub token: Option<String>,
    pub server_url: Option<String>,
    pub client_name: Option<String>,
}

/// Parse the client config JSON. Absent / empty / wrong-type fields fall
/// back to None (the menubar's ClientConfig parse discipline, #12). Pure
/// so the cargo test pins the shape.
pub fn parse_client_config(raw: &str) -> ClientConfig {
    let v: serde_json::Value = serde_json::from_str(raw).unwrap_or(serde_json::Value::Null);
    let field = |k: &str| -> Option<String> {
        v.get(k)
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    ClientConfig {
        token: field("token"),
        server_url: field("server_url"),
        client_name: field("client_name"),
    }
}

/// The repo root the app acts on. `IDLEFILL_REPO_PATH` wins (the desktop
/// app's override, and the headless harness's scratch hook). Otherwise
/// walk up from the executable looking for a dir that contains both
/// `client/` and `server/` — the bundle lives under
/// `tauri/src-tauri/target/.../`, so the walk finds the checkout. The
/// final fallback is `~/Software/idlefill` (the desktop's default).
pub fn find_repo_root() -> PathBuf {
    if let Ok(p) = std::env::var("IDLEFILL_REPO_PATH") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        while let Some(d) = dir {
            if d.join("client").is_dir() && d.join("server").is_dir() {
                return d;
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join("Software/idlefill")
}

pub fn client_config_path(repo: &std::path::Path) -> PathBuf {
    repo.join("client/config.json")
}

pub fn server_config_exists(repo: &std::path::Path) -> bool {
    repo.join("server/config.json").is_file()
}

/// Read the client config at call time. A missing/unreadable file yields
/// the empty config (the page then loads read-only — the Swift nil-token
/// path).
pub fn load_client_config(repo: &std::path::Path) -> ClientConfig {
    match std::fs::read_to_string(client_config_path(repo)) {
        Ok(raw) => parse_client_config(&raw),
        Err(_) => ClientConfig::default(),
    }
}

/// The arbiter's listen port from `server/config.json` (the desktop's
/// serverConfigPort — default 8787, garbage falls back).
pub fn server_config_port(repo: &std::path::Path) -> u16 {
    std::fs::read_to_string(repo.join("server/config.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("listen").and_then(|n| n.as_f64()))
        .filter(|n| *n > 0.0)
        .map(|n| n as u16)
        .unwrap_or(8787)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_full_parse() {
        let c = parse_client_config(
            r#"{"server_url":"http://127.0.0.1:8787","client_name":"mac","token":"abc"}"#,
        );
        assert_eq!(c.server_url.as_deref(), Some("http://127.0.0.1:8787"));
        assert_eq!(c.client_name.as_deref(), Some("mac"));
        assert_eq!(c.token.as_deref(), Some("abc"));
    }

    #[test]
    fn config_empty_strings_are_none() {
        let c = parse_client_config(r#"{"token":"","server_url":"","client_name":""}"#);
        assert!(c.token.is_none());
        assert!(c.server_url.is_none());
        assert!(c.client_name.is_none());
    }

    #[test]
    fn config_missing_file_shape() {
        let c = parse_client_config("not json");
        assert!(c.token.is_none() && c.server_url.is_none());
    }
}
