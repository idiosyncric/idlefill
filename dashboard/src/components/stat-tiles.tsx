import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { StatTile } from "@/lib/fleet-stats.js";

// The sparkDash stat tile — the one markup every tab's above-the-fold
// headline row shares (Overview fleet tiles, Machines mesh tiles, and the
// per-tab tiles in lib/*-stats.ts). The tile itself stays pure (lib/fleet-
// stats.ts StatTile: value + sub); this is only the render. Absent = "—"
// with the reason named in the sub line — never a fake zero.

export type LabeledTile = { label: string; title: string; tile: StatTile };

const COLS: Record<number, string> = {
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
};

export function StatTiles({ tiles, cols = 5 }: { tiles: LabeledTile[]; cols?: number }) {
  return (
    <div className={`grid grid-cols-2 gap-3 ${COLS[cols] ?? COLS[5]}`}>
      {tiles.map(({ label, title, tile }) => (
        <Card key={label} className="py-0 shadow-none">
          <CardContent className="flex flex-col gap-0.5 px-4 py-2.5" title={title}>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-dim">{label}</span>
            <span className="text-[16px] font-semibold">{tile.value}</span>
            <span className="text-[11px] text-dim">{tile.sub}</span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// First-poll skeleton — the same shape the tiles will take.
export function TilesSkeleton({ cols = 5, count }: { cols?: number; count?: number }) {
  const n = count ?? cols;
  return (
    <div className={`grid grid-cols-2 gap-3 ${COLS[cols] ?? COLS[5]}`}>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className="h-20 rounded-lg" />
      ))}
    </div>
  );
}
