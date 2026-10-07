/* The settings disclosure (D4-shape): the three launchd toggles, the
   runs:/note lines, the exception-only "arbiter stopped" + Relaunch,
   the meta line. The verbs ride the capability-gated IPC (local windows
   only). The launchd facts come from the Rust side — the view renders
   the snapshot, it never recomputes a verdict (the harnesses' rule).
   Built on the vendored shadcn components: Switch (checked =
   installed), Separator (the row hairlines), Button (Relaunch). */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { ipc, type SettingsSnapshot } from "@/lib/ipc";
import { Button } from "@/components/button";
import { Separator } from "@/components/separator";
import { Switch } from "@/components/switch";

createRoot(document.getElementById("root")!).render(<Settings />);

type ToggleKind = "daemon" | "arbiter" | "menubar";

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

  const refresh = useCallback(async () => {
    setSnap(await ipc.settingsState());
  }, []);

  const toggle = useCallback(async (kind: ToggleKind, on: boolean) => {
    setSnap(await ipc.setToggle(kind, on));
  }, []);

  // D6: on a programmatic reload the page re-reads everything — no
  // state survives a reload (the desktop's full-rebuild posture).
  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (document.hasFocus()) void refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [refresh]);

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
        <Separator />
        <SettingsRow
          id="menubar"
          name="Legacy menubar agent"
          loaded={snap.menubar_loaded}
          runs={snap.menubar_runs}
          note={snap.menubar_note}
          onToggle={(on) => void toggle("menubar", on)}
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

      <div className="text-dim text-[12px] mt-[14px] break-all">
        build {snap.marker} · repo {snap.repo} · config {snap.config_path}
      </div>
    </div>
  );
}
