// The idlefill shell binary (issue #70). All logic lives in the lib
// (tauri's mobile-target convention: the app lib + this thin main), so
// `cargo test` exercises the pure ports without a window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The marker contract (desktop/build.sh analog): `idlefill
    // --version` prints `idlefill <marker>` and exits without opening
    // a window. The marker is baked at compile time (build.rs
    // rerun-if-env-changed + option_env! in the lib).
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("idlefill {}", idlefill_app_lib::build_marker());
        return;
    }
    idlefill_app_lib::build().expect("idlefill shell failed to start");
}
