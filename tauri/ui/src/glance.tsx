/* The glance view (D1): renders ONLY what the pure specs produce —
   glance_state returns the status word, the sessions count + exception
   lines, the inference-server load readouts (#59, the arbiter's
   servers[] rows projected by the Rust spec — Exception-Only section:
   no servers = no rows at all), the action rows, and the exception-only
   relaunch flag. The verdict stays in Rust (cargo tests pin it); this
   view is a projector. Rust re-invokes window.__glanceRefresh() after
   each 5s tick (lib.rs eval), so the refresh seam stays under the same
   name. */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./glance.css";
import { ipc, type GlanceState } from "@/lib/ipc";
import { Button } from "@/components/button";

createRoot(document.getElementById("root")!).render(<Glance />);

export default function Glance() {
  const [s, setS] = useState<GlanceState | null>(null);

  const render = useCallback(async () => {
    setS(await ipc.glanceState());
  }, []);

  useEffect(() => {
    void render();
    window.__glanceRefresh = () => void render();
    return () => {
      delete window.__glanceRefresh;
    };
  }, [render]);

  if (!s) return null;

  const act = (id: string) => () => void ipc.glanceAction(id);

  return (
    <div className="p-[10px_12px] select-none">
      <div className={`font-semibold mb-[2px]${s.red ? " text-err" : ""}`}>{s.word}</div>
      {s.sessionsCount && <div className="text-dim my-[8px_0_2px]">{s.sessionsCount}</div>}
      {s.exceptionLines.map((line, i) => (
        <div key={i} className="text-warn my-[2px_0]">
          {line}
        </div>
      ))}
      {/* Inference-server load (#59): renders ONLY the specs' readouts —
          the section is Exception-Only (no servers = no rows at all).
          The name is the row's identity (console text); the load facts
          are dim; the marker line ("degraded" red, "no signal" dim —
          never a fake zero) rides the row's tone. */}
      {s.serverLoads.length > 0 && (
        <div className="my-[6px_0_2px]">
          {s.serverLoads.map((sv) => (
            <div key={sv.name} className="my-[2px_0]">
              <span className="font-semibold">{sv.name}</span>
              {sv.line && <span className="text-dim"> · {sv.line}</span>}
              {sv.idle && <span className="text-dim"> · {sv.idle}</span>}
              {sv.status && (
                <span className={`ml-[6px] ${sv.tone === "err" ? "text-err" : "text-dim"}`}>
                  {sv.status}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {/* Action rows ride the vendored shadcn Button (ghost, full
          width): the popover tone is the body background, hover is
          the card tone — the tokens replace the old .row rules. */}
      {s.relaunch && (
        <Button
          variant="ghost"
          className="-mx-1 my-[3px] w-full justify-start text-warn"
          onClick={act("relaunch")}
        >
          Relaunch arbiter
        </Button>
      )}
      {s.rows.map((r) => (
        <Button
          key={r.id}
          variant="ghost"
          className="-mx-1 my-[3px] w-full justify-start"
          onClick={act(r.id)}
        >
          {r.label}
        </Button>
      ))}
    </div>
  );
}

declare global {
  interface Window {
    __glanceRefresh?: () => void;
  }
}
