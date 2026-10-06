//! Token injection port (D3): the gateTokenScript pure function
//! (IdlefillDesktop.swift:1974-1982). The token rides a JSON string
//! literal into the page's own `idlefill.token` key at document start
//! (wry feeds initialization_script into a WKUserScript with
//! AtDocumentStart — wry 0.57.0 src/wkwebview/mod.rs:646-648,780-791).
//! Write-only: the value is NEVER printed, logged, or returned in any
//! other form. The wrapper type redacts Debug so a stray {token:?} in a
//! future log line cannot leak the value.

/// The page's gate key (the page's own contract, GATE_TOKEN_KEY in
/// server/public/index.html). If the page renames it, this constant and
/// the live eyeball are the two places to change (sessions-test (i)).
pub const GATE_TOKEN_KEY: &str = "idlefill.token";

/// A token value that never Debug-prints itself (write-only discipline).
#[derive(Clone, Default)]
pub struct SecretToken(pub Option<String>);

impl std::fmt::Debug for SecretToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SecretToken([redacted])")
    }
}

/// The document-start script that satisfies the page's gate mechanism
/// before the page's inline script ever runs. nil/empty token -> None:
/// the page still loads read-only and its own token-box hint works.
/// Port of gateTokenScript: the value is JSON-encoded into a string
/// literal (serde_json escapes like the Swift JSONEncoder did), so no
/// character can break out of it.
pub fn gate_token_script(token: Option<&str>) -> Option<String> {
    let t = token.filter(|s| !s.is_empty())?;
    let literal = serde_json::to_string(t).ok()?;
    Some(format!(
        "(function(){{try{{localStorage.setItem(\"{GATE_TOKEN_KEY}\", {literal});}}catch(e){{}}}})();"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_shape_matches_the_swift_port() {
        let s = gate_token_script(Some("tok")).unwrap();
        assert_eq!(
            s,
            "(function(){try{localStorage.setItem(\"idlefill.token\", \"tok\");}catch(e){}})();"
        );
    }

    #[test]
    fn script_escapes_special_characters() {
        // JSON string literal: quotes, backslashes, and control chars are
        // escaped — nothing can break out of the literal.
        let s = gate_token_script(Some("a\"b\\c\n")).unwrap();
        assert!(s.contains("\"a\\\"b\\\\c\\n\""));
        assert!(!s.contains("a\"b")); // the raw quote never appears bare
    }

    #[test]
    fn empty_and_missing_tokens_emit_no_script() {
        assert!(gate_token_script(None).is_none());
        assert!(gate_token_script(Some("")).is_none());
    }

    #[test]
    fn debug_never_prints_the_token() {
        let t = SecretToken(Some("super-secret-value".into()));
        let d = format!("{t:?}");
        assert!(!d.contains("super-secret-value"));
        assert!(d.contains("redacted"));
    }
}
