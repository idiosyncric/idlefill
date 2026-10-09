/* The settings disclosure (D4-shape): the three launchd toggles, the
   runs:/note lines, the exception-only "arbiter stopped" + Relaunch,
   the exception-only Update section (#75, D6: "Check for updates…" is
   the ONLY trigger — no check at launch, no timer; the "Install and
   restart" row renders only when an update is found, like the arbiter
   rows; the status line rides the updater's progress events), and the
   meta line. The verbs ride the capability-gated IPC (local windows
   only). The launchd facts come from the Rust side — the view renders
   the snapshot, it never recomputes a verdict (the harnesses' rule).
   Built on the vendored shadcn components: Switch (checked =
   installed), Separator (the row hairlines), Button (Relaunch,
   Check for updates…, Install and restart). */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./styles.css";
import {
  ipc,
  type SettingsSnapshot,
  type UpdateState,
  type UpdateProgress,
} from "@/lib/ipc";
import { Button } from "@/components/button";
import { Separator } from "@/components/separator";
import { Switch } from "@/components/switch";

createRoot(document.getElementById("root")!).render(<Settings />);

type ToggleKind = "daemon" | "arbiter";

function stateText(loaded: boolean, runs: string | null): string {
  if (!loaded) return "not installed";
  return "installed" + (runs ? ` — runs: ${runs}` : "");
}

function SettingsRow({
  id,
  name,
  loaded,
  runs,
  note,
  onToggle,
}: {
  id: ToggleKind;
  name: string;
  loaded: boolean;
  runs: string | null;
  note: string | null;
  onToggle: (on: boolean) => void;
}) {
  return (
    <div className="py-[7px]">
      <div className="flex items-center gap-[10px]">
        <label htmlFor={id} className="flex-1 cursor-default">
          {name}
        </label>
        <span className="text-dim text-[12px]">{stateText(loaded, runs)}</span>
        {/* The snapshot is the single source of truth: checked rides
            the Rust-side *_loaded flag, never local state. */}
        <Switch id={id} size="sm" checked={loaded} onCheckedChange={onToggle} />
      </div>
      {note && <div className="text-warn text-[12px] pt-[2px]">{note}</div>}
    </div>
  );
}

export default function Settings() {
  const [snap, setSnap] = useState<SettingsSnapshot | null>(null);
  // The Update section (#75, D6): null = never checked in this window
  // (the section renders only the trigger row). The state is re-read
  // only when the operator clicks "Check for updates…" — no check at
  // launch, no timer (Exception-Only, the check watchdog stays
  // retired). `updateErr` is the install/download error (the status
  // line renders it in the error tone, Exception-Only).
  const [upd, setUpd] = useState<UpdateState | null>(null);
  const [prog, setProg] = useState<UpdateProgress | null>(null);
  const [updateErr, setUpdateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"check" | "install" | null>(null);

  const refresh = useCallback(async () => {
    setSnap(await ipc.settingsState());
  }, []);

  const toggle = useCallback(async (kind: ToggleKind, on: boolean) => {
    setSnap(await ipc.setToggle(kind, on));
  }, []);

  // D6: on a programmatic reload the page re-reads everything — no
  // state survives a reload (the desktop's full-rebuild posture).
  // The Update state is an exception: it is operator-triggered and
  // dies with the window (a re-open starts from the trigger row).
  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (document.hasFocus()) void refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // The download status line rides the updater's progress events
  // (lib.rs update_install emits updater-progress per chunk). The
  // finished tick clears the line (install + relaunch take over).
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<UpdateProgress>("updater-progress", (e) => {
      const p = e.payload;
      if (p.finished) setProg(null);
      else setProg({ done: p.done, total: p.total });
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    setBusy("check");
    setUpdateErr(null);
    setProg(null);
    try {
      setUpd(await ipc.updateCheck());
    } finally {
      setBusy(null);
    }
  }, []);

  const installAndRestart = useCallback(async () => {
    setBusy("install");
    setUpdateErr(null);
    try {
      await ipc.updateInstall();
      // Success: the updater relaunches the app — the window dies.
      // No state to set.
    } catch (e) {
      setUpdateErr(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }, []);

  if (!snap) return null;

  return (
    <div className="p-[16px_18px]">
      <h2 className="text-[14px] font-semibold mb-[10px]">LaunchAgents</h2>
      <div className="flex flex-col">
        <SettingsRow
          id="daemon"
          name="Client daemon"
          loaded={snap.daemon_loaded}
          runs={snap.daemon_runs}
          note={snap.daemon_note}
          onToggle={(on) => void toggle("daemon", on)}
        />
        <Separator />
        <SettingsRow
          id="arbiter"
          name="Arbiter (this checkout's server)"
          loaded={snap.arbiter_loaded}
          runs={snap.arbiter_runs}
          note={snap.arbiter_note}
          onToggle={(on) => void toggle("arbiter", on)}
        />
      </div>

      <h2 className="text-[14px] font-semibold mt-[18px] mb-[10px]">Arbiter</h2>
      <div className="flex items-center gap-[10px]">
        {/* Exception-Only (DESIGN.md): the stopped row renders ONLY in
            the loaded-but-exited state. */}
        <span
          className={
            snap.arbiter_stopped ? "flex-1 text-err font-semibold" : "flex-1"
          }
        >
          {snap.arbiter_stopped ? "arbiter stopped — loaded but exited" : ""}
        </span>
        {snap.arbiter_stopped && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void ipc.relaunchArbiter().then(setSnap)}
          >
            Relaunch arbiter
          </Button>
        )}
      </div>

      <h2 className="text-[14px] font-semibold mt-[18px] mb-[10px]">Update</h2>
      <div className="flex items-center gap-[10px]">
        {/* D6: the check is GUI-triggered — the button is the ONLY
            trigger (no check at launch, no timer). `inert` = the
            channel is off by configuration (D4: no signing key yet —
            the owner step), the status line names the missing step.
            `available` renders the exception-only install row, like
            the arbiter stopped row above. */}
        <span
          className={
            updateErr
              ? "flex-1 text-err text-[12px] break-all"
              : upd?.status === "error"
                ? "flex-1 text-err text-[12px] break-all"
                : "flex-1"
          }
        >
          {updateErr ?? updateStatusLine(upd, prog)}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void checkForUpdates()}
        >
          {busy === "check" ? "checking…" : "Check for updates…"}
        </Button>
      </div>
      {upd?.status === "available" && (
        <div className="flex items-center gap-[10px] pt-[6px]">
          <span className="flex-1 text-dim text-[12px]">
            {upd.version} is ready to install
          </span>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => void installAndRestart()}
          >
            {busy === "install" ? "installing…" : "Install and restart"}
          </Button>
        </div>
      )}

      <div className="text-dim text-[12px] mt-[14px] break-all">
        build {snap.marker} · repo {snap.repo} · config {snap.config_path}
      </div>
    </div>
  );
}

/* The status line the Update section renders (pure spec — the view
   renders the verdict, it never recomputes one; the Rust side has the
   same rule pinned in updater::status_line's tests). */
function updateStatusLine(
  upd: UpdateState | null,
  prog: UpdateProgress | null,
): string {
  if (upd === null) return "";
  switch (upd.status) {
    case "inert":
      return "updater off — no signing key configured (owner step: generate the keypair)";
    case "none":
      return "up to date";
    case "available": {
      const v = upd.version ?? "?";
      if (prog === null) return `update ${v} available`;
      return prog.total !== null
        ? `downloading ${v} — ${prog.done} / ${prog.total} bytes`
        : `downloading ${v} — ${prog.done} bytes`;
    }
    case "error":
      return `check failed — ${upd.message ?? "unknown error"}`;
  }
}
