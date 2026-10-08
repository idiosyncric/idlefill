//! Deep-link view map, ported verbatim from AppModel.hashView(for:)
//! (IdlefillDesktop.swift:1063-1072). The scheme must be `idlefill`.
//! `state` -> overview; sessions/projects/usage map to themselves;
//! anything else (open, dashboard, logs, unknown, empty) -> None = the
//! page's default view (the page owns hash reading: the location.hash
//! read site in dashboard/src/App.tsx).

/// The URL's view hash for the live origin, or None for the default.
pub fn hash_view(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    if u.scheme() != "idlefill" {
        return None;
    }
    match u.host_str() {
        Some("state") => Some("overview".into()),
        Some("sessions") => Some("sessions".into()),
        Some("projects") => Some("projects".into()),
        Some("usage") => Some("usage".into()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The hashView map (the desktop/sessions harness's map family).
    #[test]
    fn state_maps_to_overview() {
        assert_eq!(hash_view("idlefill://state").as_deref(), Some("overview"));
    }

    #[test]
    fn direct_views() {
        assert_eq!(
            hash_view("idlefill://sessions").as_deref(),
            Some("sessions")
        );
        assert_eq!(
            hash_view("idlefill://projects").as_deref(),
            Some("projects")
        );
        assert_eq!(hash_view("idlefill://usage").as_deref(), Some("usage"));
    }

    #[test]
    fn everything_else_is_the_default_view() {
        // open/dashboard/logs/unknown/empty -> None (the page default).
        for u in [
            "idlefill://open",
            "idlefill://dashboard",
            "idlefill://logs",
            "idlefill://nonsense",
            "idlefill://",
        ] {
            assert_eq!(hash_view(u), None, "{u} must map to None");
        }
    }

    #[test]
    fn foreign_scheme_is_none() {
        assert_eq!(hash_view("http://state"), None);
        assert_eq!(hash_view("not a url"), None);
    }
}
