import { gibfmt } from "@/lib/fleet-stats.js";

// One memory bar on a unit card (vram / model mem / host ram): used
// against total, tone at the same thresholds everywhere, dimmed when the
// load reading is stale (last-known truth, labelled).
export function MemBar({ label, used, total, stale, note }: { label: string; used: number; total?: number; stale: boolean; note: string }) {
  const pct = total !== undefined && total > 0 ? Math.min(100, Math.round((used / total) * 100)) : null;
  const tone = pct === null ? "bg-accent" : pct < 80 ? "bg-accent" : pct < 95 ? "bg-warn" : "bg-err";
  return (
    <div className={`flex flex-col gap-1 ${stale ? "opacity-60" : ""}`} title={`${note}${pct !== null ? ` (${pct}%)` : ""}${stale ? " — stale read" : ""}`}>
      <div className="flex items-center justify-between text-[10px] text-dim">
        <span>{label}</span>
        <span>{gibfmt(used)}{total !== undefined ? ` / ${gibfmt(total)}` : ""}</span>
      </div>
      {pct !== null && (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div className={`h-1 rounded-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
