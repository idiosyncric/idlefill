/* The glance view (D1): renders ONLY what the pure specs produce —
   glance_state returns the status word, the sessions count + exception
   lines, the action rows, and the exception-only relaunch flag. The
   verdict stays in Rust (cargo tests pin it); this view is a projector.
   Rust re-invokes window.__glanceRefresh() after each 5s tick
   (lib.rs eval), so the refresh seam stays under the same name. */
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
