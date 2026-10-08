import { invoke } from "@tauri-apps/api/core";

/* The snapshot the settings window renders (lib.rs SettingsSnapshot —
   serde default camelCase → snake_case per the Rust struct fields; the
   old view read s.daemon_loaded etc., the Rust pins stay). */
export type SettingsSnapshot = {
  daemon_loaded: boolean;
  arbiter_loaded: boolean;
  arbiter_running: boolean;
  arbiter_stopped: boolean;
  daemon_runs: string | null;
  arbiter_runs: string | null;
  daemon_note: string | null;
  arbiter_note: string | null;
  repo: string;
  config_path: string;
  marker: string;
};

export type GlanceRow = { id: string; label: string };

export type GlanceState = {
  word: string;
  red: boolean;
  sessionsCount: string | null;
  exceptionLines: string[];
  rows: GlanceRow[];
  relaunch: boolean;
};

/* The verbs the capability file grants to the local windows only
   (capabilities/default.json: windows ["settings","glance"], no remote
   block — the arbiter page has NO IPC reach, the D4-shape lock). */
export const ipc = {
  settingsState: () => invoke<SettingsSnapshot>("settings_state"),
  setToggle: (kind: "arbiter" | "daemon", on: boolean) =>
    invoke<SettingsSnapshot>(`set_${kind}`, { on }),
  relaunchArbiter: () => invoke<SettingsSnapshot>("relaunch_arbiter_cmd"),
  glanceState: () => invoke<GlanceState>("glance_state"),
  glanceAction: (id: string) => invoke("glance_action", { id }),
};
