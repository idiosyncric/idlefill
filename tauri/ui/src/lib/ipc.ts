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

/* #59: one inference-server load readout (the Rust spec projects the
   arbiter's `servers[]` rows — serverView in server/src/api.ts). `line`
   = the load facts (Exception-Only, null for healthy load-less rows),
   `status` = the marker line ("degraded" / "no signal", null when
   healthy), `tone` = the marker line's class (err = red, dim = muted;
   "no signal" is dim — never a fake zero), `idle` = the idle countdown
   (null when no activity is provable). */
export type GlanceServerLoad = {
  name: string;
  line: string | null;
  status: string | null;
  tone: "err" | "dim";
  idle: string | null;
};

export type GlanceState = {
  word: string;
  red: boolean;
  sessionsCount: string | null;
  exceptionLines: string[];
  serverLoads: GlanceServerLoad[];
  rows: GlanceRow[];
  relaunch: boolean;
};

/* The signed updater channel's state (lib.rs updater::UpdateState —
   serde camelCase). `inert` = the channel is off by configuration
   (tauri.conf.json plugins.updater.pubkey empty — the committed
   key-free posture, #75 D4): the check never runs, and the view
   renders the owner-step hint. `available` carries `version` (the
   feed's SemVer, 1.0.<N> — D5). */
export type UpdateState = {
  status: "inert" | "none" | "available" | "error";
  version: string | null;
  message: string | null;
};

/* One on_chunk tick from the install download (lib.rs update_install's
   updater-progress event). `total` is the Content-Length — null for a
   chunked body (no fake percentage, the line shows the running total). */
export type UpdateProgress = {
  done: number;
  total: number | null;
  finished?: boolean;
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
  // The signed updater channel (#75, D6: GUI-triggered — these are the
  // only updater verbs, there is no check at launch and no timer).
  // `update_check` resolves to the state the view renders (inert when
  // the channel is off by configuration, D4). `update_install`
  // downloads + installs; the progress rides the updater-progress
  // event, not this call.
  updateCheck: () => invoke<UpdateState>("update_check"),
  updateInstall: () => invoke<void>("update_install"),
};
