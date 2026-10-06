//! Glance + tray content ported pin-for-pin from the menubar's pure
//! specs (D1/D9): the Conn state word (`glanceStatusRow`
//! IdlefillMenubar.swift:807, Conn.word :127-137), the action-row set
//! (`panelActionRows` :778-785 MINUS the Install Update row — the update
//! plane retires, Q-b), and the sessions-at-a-glance projector
//! (sessions-test.sh fixtures). The glance ROWS render from these specs,
//! so the cargo tests assert what ships.

use serde_json::Value;

/// The arbiter-connection verdict (menubar enum Conn :106). `word` is
/// Conn.word verbatim; `red`/`amber` mirror the Conn.color mapping
/// (red = failure, amber = operator-actionable — DESIGN.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Conn {
    Off,
    Busy,
    Working,
    Idle,
    Degraded,
    #[default]
    Unreachable,
    NoToken,
    Unauthorized,
}

impl Conn {
    pub fn word(&self) -> &'static str {
        match self {
            Conn::Off => "stopped",
            Conn::Busy => "busy",
            Conn::Working => "running idle tasks",
            Conn::Idle => "idle",
            Conn::Degraded => "degraded",
            Conn::Unreachable => "unreachable",
            Conn::NoToken => "no token",
            Conn::Unauthorized => "bad token",
        }
    }

    /// true = red (failure), false = amber/dim (operator-actionable or ok).
    pub fn red(&self) -> bool {
        matches!(self, Conn::Degraded | Conn::Unreachable)
    }
}

/// The glance's STATUS ROW (glanceStatusRow :807-827), branch order
/// verbatim: token facts first (no token / bad token name the config
/// path — both operator-actionable), then liveness ("stopped" outside
/// the 90s window), then the arbiter's state word.
pub fn glance_status_row(conn: Conn, daemon_running: bool, config_path: &str) -> String {
    match conn {
        Conn::NoToken => format!("no token — set the arbiter token in {config_path}"),
        Conn::Unauthorized => format!("bad token — the arbiter rejected it ({config_path})"),
        _ if !daemon_running => "stopped".to_string(),
        _ => conn.word().to_string(),
    }
}

/// One glance action row (PanelActionRow :770-776, minus arrow/tag: the
/// update tag retires with the update plane). `id` is the IPC/route the
/// row triggers.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GlanceRow {
    pub id: &'static str,
    pub label: &'static str,
}

/// The action block's row SET (panelActionRows :778-785 MINUS the
/// `Install Update <v>` row — Q-b LOCKED: no update plane). Open
/// Desktop is the ONE nav row (inside one artifact: show + focus the
/// window — the idlefill://open dance retires). D1 adds Settings and
/// Quit to the tray surface; they ride the same row spec.
pub fn glance_action_rows() -> Vec<GlanceRow> {
    vec![
        GlanceRow {
            id: "open",
            label: "Open Desktop",
        },
        GlanceRow {
            id: "settings",
            label: "Settings",
        },
        GlanceRow {
            id: "quit",
            label: "Quit",
        },
    ]
}

/// The exception-only "Relaunch arbiter" item (D6): present ONLY in the
/// loaded-but-exited state (arbiterLoaded && !arbiterRunning). The
/// desktop's exception-only stop row (IdlefillDesktop.swift:2047-2055)
/// re-homed to the tray per D4.
pub fn relaunch_row_present(arbiter_loaded: bool, arbiter_running: bool) -> bool {
    arbiter_loaded && !arbiter_running
}

/// One sessions-at-a-glance row (ScopeSession :289-311 ported verbatim:
/// stale = now - last_seen > 90_000; override "pause"->"paused",
/// "force"->"forced"; queued rides with the waiting count when >1; the
/// one-liner word order override, queued, stale).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub token: String,
    pub client_name: Option<String>,
    pub override_label: Option<&'static str>, // "pause" | "force" | None
    pub stale: bool,
    pub queued: bool,
    pub waiting_count: usize,
    pub exception_line: Option<String>,
}

/// Project the payload's sessions[] rows (the sessions-test.sh read
/// site). The stale verdict mirrors daemonRunning's 90s window. The
/// naming rule: the router's client_name when it identified itself,
/// else an 8-char token prefix + the ellipsis. Healthy sessions render
/// NO one-liner (Exception-Only).
pub fn project_sessions(payload: &Value, now_ms: f64) -> Vec<SessionRow> {
    let rows = payload.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
    rows.iter()
        .filter_map(|s| {
            let tok = s.get("token").and_then(Value::as_str).filter(|t| !t.is_empty())?;
            let last_seen = s.get("last_seen").and_then(Value::as_f64).unwrap_or(0.0);
            let stale = now_ms - last_seen > 90_000.0;
            let ov = s
                .get("override")
                .and_then(|o| o.get("override"))
                .and_then(Value::as_str);
            let label: Option<&'static str> = match ov {
                Some("pause") => Some("pause"),
                Some("force") => Some("force"),
                _ => None,
            };
            let name = s
                .get("client_name")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
                .map(|n| n.to_string());
            let gate = s.get("gate");
            let queued = gate.and_then(|g| g.get("state")).and_then(Value::as_str) == Some("queued");
            let waiting = gate
                .and_then(|g| g.get("waiting"))
                .and_then(Value::as_f64)
                .map(|w| w as usize)
                .unwrap_or(0);
            let who = name.clone().unwrap_or_else(|| {
                let end = tok.char_indices().nth(8).map(|(i, _)| i).unwrap_or(tok.len());
                format!("{}…", &tok[..end])
            });
            let mut words: Vec<String> = Vec::new();
            match label {
                Some("pause") => words.push("paused".into()),
                Some("force") => words.push("forced".into()),
                _ => {}
            }
            if queued {
                words.push(if waiting > 1 {
                    format!("queued · {waiting} waiting")
                } else {
                    "queued".into()
                });
            }
            if stale {
                words.push("stale".into());
            }
            let line = if words.is_empty() {
                None
            } else {
                Some(format!("{who} · {}", words.join(" · ")))
            };
            Some(SessionRow {
                token: tok.to_string(),
                client_name: name,
                override_label: label,
                stale,
                queued,
                waiting_count: if waiting > 1 { waiting } else { 0 },
                exception_line: line,
            })
        })
        .collect()
}

/// The sessions count line (sessionsCountLine :646-658): nil when there
/// are no sessions (Exception-Only — no row at all), else the buckets in
/// order active, paused, forced, stale, zero buckets omitted.
pub fn sessions_count_line(rows: &[SessionRow]) -> Option<String> {
    if rows.is_empty() {
        return None;
    }
    let paused = rows.iter().filter(|r| r.override_label == Some("pause")).count();
    let forced = rows.iter().filter(|r| r.override_label == Some("force")).count();
    let stale = rows.iter().filter(|r| r.override_label.is_none() && r.stale).count();
    let active = rows.iter().filter(|r| r.override_label.is_none() && !r.stale).count();
    let mut parts: Vec<String> = Vec::new();
    if active > 0 {
        parts.push(format!("{active} active"));
    }
    if paused > 0 {
        parts.push(format!("{paused} paused"));
    }
    if forced > 0 {
        parts.push(format!("{forced} forced"));
    }
    if stale > 0 {
        parts.push(format!("{stale} stale"));
    }
    Some(parts.join(", "))
}

/// The state word decision (applyProjection :1102-1108): NO client rows
/// -> .unreachable (an arbiter with zero registered clients is
/// indistinguishable from a dead one — today's semantics). Then:
/// degraded -> degraded; any active lease -> working; idle flag -> idle;
/// else busy. `active_leases` counts rows with status "active" (the
/// activeLeasesGlobal filter :1115-1118).
pub fn state_word(payload: &Value) -> Conn {
    let clients = payload.get("clients").and_then(Value::as_array);
    if clients.map(|c| c.is_empty()).unwrap_or(true) {
        return Conn::Unreachable;
    }
    let idle = payload.get("idle").cloned().unwrap_or(Value::Null);
    let degraded = idle.get("degraded").and_then(Value::as_bool).unwrap_or(false);
    let idle_flag = idle.get("idle").and_then(Value::as_bool).unwrap_or(false);
    let active = payload
        .get("active_leases")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|l| {
                    l.get("status").and_then(Value::as_str).unwrap_or("active") == "active"
                })
                .count()
        })
        .unwrap_or(0);
    if degraded {
        Conn::Degraded
    } else if active > 0 {
        Conn::Working
    } else if idle_flag {
        Conn::Idle
    } else {
        Conn::Busy
    }
}

/// Liveness of THIS machine (applyProjection :1065-1073): the
/// name-matched client row's last_seen inside 90s; no name match falls
/// back to the freshest row (the old heuristic, only ever a fallback).
pub fn daemon_running(payload: &Value, client_name: Option<&str>, now_ms: f64) -> bool {
    let clients = payload.get("clients").and_then(Value::as_array).cloned().unwrap_or_default();
    let me_last_seen: f64 = match client_name {
        Some(cn) => match clients.iter().find(|c| c.get("name").and_then(Value::as_str) == Some(cn)) {
            Some(c) => c.get("last_seen").and_then(Value::as_f64).unwrap_or(0.0),
            None => clients
                .iter()
                .filter_map(|c| c.get("last_seen").and_then(Value::as_f64))
                .fold(0.0_f64, f64::max),
        },
        None => clients
            .iter()
            .filter_map(|c| c.get("last_seen").and_then(Value::as_f64))
            .fold(0.0_f64, f64::max),
    };
    me_last_seen > 0.0 && now_ms - me_last_seen < 90_000.0
}

/// The arbiter HTTP status -> Conn mapping the poll drives (poll :1001-
/// 1031): 401 -> unauthorized, any fetch failure -> unreachable.
pub fn conn_from_http(status: Option<u16>, fetch_ok: bool) -> Conn {
    if !fetch_ok {
        return Conn::Unreachable;
    }
    match status {
        Some(401) => Conn::Unauthorized,
        _ => Conn::Off, // the caller then runs state_word over the payload
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // glanceStatusRow branches (panel-test.sh check family 3).
    #[test]
    fn status_row_no_token_names_the_config_path() {
        assert_eq!(
            glance_status_row(Conn::NoToken, true, "/repo/client/config.json"),
            "no token — set the arbiter token in /repo/client/config.json"
        );
    }

    #[test]
    fn status_row_bad_token_names_the_config_path() {
        assert_eq!(
            glance_status_row(Conn::Unauthorized, true, "/c.json"),
            "bad token — the arbiter rejected it (/c.json)"
        );
    }

    #[test]
    fn status_row_out_of_window_is_stopped() {
        assert_eq!(glance_status_row(Conn::Idle, false, "/c.json"), "stopped");
    }

    #[test]
    fn status_row_in_window_is_the_state_word() {
        assert_eq!(glance_status_row(Conn::Working, true, "/c.json"), "running idle tasks");
        assert_eq!(glance_status_row(Conn::Idle, true, "/c.json"), "idle");
        assert_eq!(glance_status_row(Conn::Degraded, true, "/c.json"), "degraded");
    }

    // panelActionRows minus the update row (panel-test.sh check family 1).
    #[test]
    fn action_rows_open_desktop_is_the_first_and_only_nav_row() {
        let rows = glance_action_rows();
        assert_eq!(rows[0].label, "Open Desktop");
        let labels: Vec<&str> = rows.iter().map(|r| r.label).collect();
        assert_eq!(labels, ["Open Desktop", "Settings", "Quit"]);
        // Retired rows stay absent (update plane LOCKED gone):
        for retired in [
            "Install Update",
            "Open Dashboard",
            "Show Logs",
            "Start",
            "Stop",
            "Restart",
            "Update Code",
        ] {
            assert!(!labels.iter().any(|l| l.starts_with(retired)), "{retired} must not render");
        }
    }

    #[test]
    fn relaunch_item_is_exception_only() {
        assert!(relaunch_row_present(true, false)); // loaded-but-exited
        assert!(!relaunch_row_present(true, true)); // healthy
        assert!(!relaunch_row_present(false, false)); // not loaded
    }

    // sessions-test.sh fixtures (sessions-at-a-glance retirement).
    #[test]
    fn sessions_absent_or_empty_yield_no_facts() {
        let p = json!({});
        let rows = project_sessions(&p, 1_000_000.0);
        assert!(rows.is_empty());
        assert_eq!(sessions_count_line(&rows), None);
    }

    #[test]
    fn sessions_count_line_buckets_and_exception_lines() {
        let now = 1_000_000_000.0_f64;
        let fresh = now - 10_000.0;
        let p = json!({"sessions": [
            {"token": "aaaa1111bbbb", "last_seen": fresh},
            {"token": "cccc2222dddd", "last_seen": fresh},
            {"token": "eeee3333ffff", "last_seen": fresh, "override": {"override": "pause"}},
        ]});
        let rows = project_sessions(&p, now);
        assert_eq!(rows.len(), 3);
        assert_eq!(sessions_count_line(&rows).as_deref(), Some("2 active, 1 paused"));
        // Exception-Only: the two healthy rows render NO one-liner.
        assert_eq!(rows[0].exception_line, None);
        assert_eq!(rows[1].exception_line, None);
        assert_eq!(
            rows[2].exception_line.as_deref(),
            Some("eeee3333… · paused")
        );
    }

    #[test]
    fn stale_session_counts_stale_not_active() {
        let now = 1_000_000_000.0_f64;
        let old = now - 2.0 * 60.0 * 60.0 * 1000.0; // 2h
        let p = json!({"sessions": [{"token": "tok1", "last_seen": old}]});
        let rows = project_sessions(&p, now);
        assert!(rows[0].stale);
        assert_eq!(sessions_count_line(&rows).as_deref(), Some("1 stale"));
        assert_eq!(rows[0].exception_line.as_deref(), Some("tok1… · stale"));
    }

    #[test]
    fn paused_and_stale_show_both_words() {
        let now = 1_000_000_000.0_f64;
        let old = now - 95_000.0;
        let p = json!({"sessions": [{
            "token": "t", "client_name": "mac", "last_seen": old,
            "override": {"override": "pause"}
        }]});
        let rows = project_sessions(&p, now);
        assert_eq!(rows[0].exception_line.as_deref(), Some("mac · paused · stale"));
    }

    #[test]
    fn queued_gate_rides_the_one_liner_with_waiting_count() {
        let now = 1_000_000_000.0_f64;
        let p = json!({"sessions": [
            {"token": "t1", "last_seen": now, "gate": {"state": "queued"}},
            {"token": "t2", "last_seen": now, "gate": {"state": "queued", "waiting": 3}},
        ]});
        let rows = project_sessions(&p, now);
        // Swift: String(tok.prefix(8)) + "…" — the ellipsis rides even
        // when the token is shorter than 8 chars (sessions-test.sh pins
        // the 8-char form: "xyzw9876… · stale").
        assert_eq!(rows[0].exception_line.as_deref(), Some("t1… · queued"));
        assert_eq!(rows[1].exception_line.as_deref(), Some("t2… · queued · 3 waiting"));
        assert_eq!(rows[1].waiting_count, 3);
    }

    #[test]
    fn malformed_gate_renders_as_before() {
        let now = 1_000_000_000.0_f64;
        let p = json!({"sessions": [
            {"token": "t", "last_seen": now, "gate": null},
            {"token": "u", "last_seen": now, "gate": {"state": "parked"}},
        ]});
        let rows = project_sessions(&p, now);
        assert!(!rows[0].queued && rows[0].exception_line.is_none());
        assert!(!rows[1].queued && rows[1].exception_line.is_none());
    }

    // The state word (the arbiter's GLOBAL verdict).
    #[test]
    fn state_word_no_clients_is_unreachable() {
        assert_eq!(state_word(&json!({"clients": []})), Conn::Unreachable);
        assert_eq!(state_word(&json!({})), Conn::Unreachable);
    }

    #[test]
    fn state_word_switch_order() {
        let c = json!({"clients": [{"name": "mac"}]});
        assert_eq!(
            state_word(&json!({"clients": c["clients"], "idle": {"degraded": true}, "active_leases": []})),
            Conn::Degraded
        );
        assert_eq!(
            state_word(&json!({"clients": c["clients"], "idle": {"idle": false},
                "active_leases": [{"status": "active"}]})),
            Conn::Working
        );
        assert_eq!(
            state_word(&json!({"clients": c["clients"], "idle": {"idle": true}, "active_leases": []})),
            Conn::Idle
        );
        assert_eq!(
            state_word(&json!({"clients": c["clients"], "idle": {"idle": false}, "active_leases": []})),
            Conn::Busy
        );
    }

    #[test]
    fn active_lease_filter_ignores_terminal_rows() {
        // status absent counts as active (the Swift default); a
        // completed row never makes the word "working".
        assert_eq!(
            state_word(&json!({"clients": [{"name":"m"}], "idle": {"idle": true},
                "active_leases": [{"status": "completed"}]})),
            Conn::Idle
        );
        assert_eq!(
            state_word(&json!({"clients": [{"name":"m"}], "idle": {"idle": true},
                "active_leases": [{}]})),
            Conn::Working
        );
    }

    // Liveness: name-matched row, freshest-row fallback, 90s window.
    #[test]
    fn daemon_running_matches_by_name() {
        let now = 1_000_000_000.0_f64;
        let p = json!({"clients": [
            {"name": "urza", "last_seen": now - 1000.0},
            {"name": "mac", "last_seen": now - 95_000.0},
        ]});
        assert!(!daemon_running(&p, Some("mac"), now)); // matched row is out of window
        assert!(daemon_running(&p, Some("urza"), now));
        // no name match -> freshest row (the fallback)
        assert!(daemon_running(&p, Some("nope"), now));
        // all rows stale: now 200s past the newest row (90s window)
        assert!(!daemon_running(&p, None, now + 200_000.0));
    }

    #[test]
    fn conn_from_http_status() {
        assert_eq!(conn_from_http(Some(401), true), Conn::Unauthorized);
        assert_eq!(conn_from_http(None, false), Conn::Unreachable);
        // A fetch that returns 2xx hands off to state_word: the helper
        // signals that handoff with Off ("stopped" never renders from
        // here; the caller overwrites the word from the payload).
        assert_eq!(conn_from_http(Some(200), true), Conn::Off);
    }
}
