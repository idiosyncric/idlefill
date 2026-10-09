fn main() {
    // The build marker (D7): IDLEFILL_BUILD_MARKER baked via option_env! in
    // the lib. Re-run this build script when the env changes so a re-build
    // with a new marker actually re-bakes it (desktop/build.sh's
    // placeholder-substitution analog).
    println!("cargo:rerun-if-env-changed=IDLEFILL_BUILD_MARKER");

    // D4-shape's platform-enforced lock, spelled in build config: every
    // app command gets a generated allow-*/deny-* permission (tauri-build
    // 2.7.1 AppManifest::commands -> autogenerate_command_permissions).
    // A command only runs for a window/origin a capability names: the
    // remote arbiter page (an External origin) has NO capability that
    // matches it, so it can invoke NOTHING here. The local windows
    // (settings/glance) are named in capabilities/default.json.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "settings_state",
            "set_arbiter",
            "set_daemon",
            "relaunch_arbiter_cmd",
            "glance_state",
            "glance_action",
            // The signed updater channel (#75, D6: GUI-triggered — these
            // are the only updater IPC the settings window reaches).
            "update_check",
            "update_install",
        ]),
    ))
    .expect("tired of reading tauri build errors? run `tauri dev`")
}
