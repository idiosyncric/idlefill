/* The settings disclosure (D4-shape): the three launchd toggles, the
   runs:/note lines, the exception-only "arbiter stopped" + Relaunch,
   the meta line. The verbs ride the capability-gated IPC (local windows
   only). The launchd facts come from the Rust side — the view renders
   the snapshot, it never recomputes a verdict (the harnesses' rule). */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { ipc, type SettingsSnapshot } from "@/lib/ipc";
import { Button } from "@/components/button";

createRoot(document.getElementById("root")!).render(<Settings />);

type ToggleKind = "daemon" | "arbiter" | "menubar";

function stateText(loaded: boolean, runs: string | null): string {
  if (!loaded) return "not installed";
  return "installed" + (runs ? ` — runs: ${runs}` : "");
}

function SettingsRow({
  name,
  loaded,
  runs,
  note,
  onToggle,
}: {
  name: string;
  loaded: boolean;
  runs: string | null;
  note: string | null;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-border/15 py-[7px]">
      <div className="flex items-center gap-[10px]">
        <span className="flex-1">{name}</span>
        <span className="text-dim text-[12px]">{stateText(loaded, runs)}</span>
        <Button variant="outline" size="sm" onClick={onToggle}>
          {loaded ? "Uninstall" : "Install"}
        </Button>
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

  const toggle = useCallback(async (kind: ToggleKind) => {
    const s = await ipc.settingsState();
    setSnap(await ipc.setToggle(kind, !s[`${kind}_loaded` as const]));
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
      <SettingsRow
        name="Client daemon"
        loaded={snap.daemon_loaded}
        runs={snap.daemon_runs}
        note={snap.daemon_note}
        onToggle={() => void toggle("daemon")}
      />
      <SettingsRow
        name="Arbiter (this checkout's server)"
        loaded={snap.arbiter_loaded}
        runs={snap.arbiter_runs}
        note={snap.arbiter_note}
        onToggle={() => void toggle("arbiter")}
      />
      <SettingsRow
        name="Legacy menubar agent"
        loaded={snap.menubar_loaded}
        runs={snap.menubar_runs}
        note={snap.menubar_note}
        onToggle={() => void toggle("menubar")}
      />

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
