import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkline } from "@/components/Sparkline";
import { StatTiles, TilesSkeleton } from "@/components/stat-tiles";
import { usageTiles, type UsageTile } from "@/lib/usage-stats";
import { utilizationRowsFor, type UsageRow as UtilRow } from "@/lib/utilization-stats";
import {
  getMetrics,
  type MetricsSeries,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Usage (#51) — charts over the metrics retention store. Its OWN timer:
// charts over days do not need the 5s /api/state cadence (the store's
// pitfall list says so explicitly). Reads GET /api/metrics anonymously
// (the /api/state exception extends to it) — no gate token involved.
// Exception-only: a row only exists for a series with points.
//
// The row set (legacy semantics, verbatim):
//   engine:  <key> req/hour [(engine)] — requests per hour bucket, accent
//            <key> tok out/hour (engine) — engine-reported output tokens, warn
//                (only when some point carries a counter-backed sample)
//            <key> tok in/hour (engine)  — engine-reported input tokens, warn
//            <key> idle % — idle samples per hour bucket, ok (avg in the value)
//   engine (metrics wave S2 — the utilization rows, exception-only, from the
//          hour line's bounded aggregates):
//            <key> busy %          — share of load reads that fired the veto
//            <key> peak in-flight  — the max the kind reported, never a mean
//            <key> peak queue      — oMLX only; other kinds publish no queue
//            <key> gpu util max / gpu power max — only when the gauge exists
//          An engine with no load axis gets NO row; the absence is named.
//   lease:   <key> tokens/hour — lease output tokens, warn
// ---------------------------------------------------------------------------

const USAGE_MS = 7 * 86400000; // the default view: last 7 days (D8)
const REFRESH_MS = 300_000; // 5 min — its own timer, not the state poll

type UsageRow = UtilRow;

function buildRows(engKeys: MetricsSeries, leaseKeys: MetricsSeries): { rows: UsageRow[]; absences: string[] } {
  const rows: UsageRow[] = [];
  const absences: string[] = [];
  for (const s of engKeys) {
    const pts = s.points;
    // requests per hour (the doc's chart 1)
    const reqs = pts.map((p) => p.req_total ?? 0);
    const src = pts.map((p) => p.requests_source).filter(Boolean).slice(-1)[0];
    rows.push(
      usageRow(
        s.key + (src === "sqlite" || src === "metrics-counter" ? " req/hour (engine)" : " req/hour"),
        reqs,
        "var(--accent)",
        "text-accent",
        String(reqs.reduce((a, b) => a + b, 0)),
        "requests per hour bucket, last 7 days" + (src ? " · source: " + src : ""),
      ),
    );
    // engine-reported tokens per hour (#62): the strata /metrics counters
    // and the oMLX usage store carry token truth the lease reports never
    // saw. Exception-only: no counter-backed samples = no rows.
    const tokOut = pts.map((p) => p.engine_tokens_out);
    if (tokOut.some((v) => typeof v === "number" && v > 0)) {
      rows.push(
        usageRow(
          s.key + " tok out/hour (engine)",
          tokOut.map((v) => v ?? 0),
          "var(--warn)",
          "text-warn",
          tokOut.reduce((a: number, b) => a + (b ?? 0), 0).toLocaleString(),
          "engine-reported output tokens per hour bucket, last 7 days",
        ),
      );
    }
    const tokIn = pts.map((p) => p.engine_tokens_in);
    if (tokIn.some((v) => typeof v === "number" && v > 0)) {
      rows.push(
        usageRow(
          s.key + " tok in/hour (engine)",
          tokIn.map((v) => v ?? 0),
          "var(--warn)",
          "text-warn",
          tokIn.reduce((a: number, b) => a + (b ?? 0), 0).toLocaleString(),
          "engine-reported input tokens per hour bucket, last 7 days",
        ),
      );
    }
    // idle share per hour (the doc's "idle hours" as a per-hour ratio)
    const idleShare = pts.map((p) => (p.samples ? Math.round(((p.idle_samples ?? 0) / p.samples) * 100) : 0));
    rows.push(
      usageRow(
        s.key + " idle %",
        idleShare,
        "var(--ok)",
        "text-ok",
        idleShare.length ? Math.round(idleShare.reduce((a, b) => a + b, 0) / idleShare.length) + "% avg" : "—",
        "idle samples per hour bucket, last 7 days",
      ),
    );
    // The utilization rows (S2): exception-only, from the hour line's bounded
    // aggregates. No load_reads key anywhere → no row, and the absence is named.
    const util = utilizationRowsFor(s.key, pts);
    rows.push(...util.rows);
    if (util.absence) absences.push(util.absence);
  }
  for (const s of leaseKeys) {
    const pts = s.points;
    const toks = pts.map((p) => p.tokens_out ?? 0);
    rows.push(
      usageRow(
        s.key + " tokens/hour",
        toks,
        "var(--warn)",
        "text-warn",
        toks.reduce((a, b) => a + b, 0).toLocaleString(),
        "lease output tokens per hour bucket, last 7 days",
      ),
    );
  }
  return { rows, absences };
}

function usageRow(
  label: string,
  values: number[],
  stroke: string,
  valueCls: string,
  valueText: string,
  title: string,
): UsageRow {
  return { label, values, stroke, valueCls, valueText, title };
}

export function Usage() {
  const [rows, setRows] = React.useState<UsageRow[] | null>(null);
  const [absences, setAbsences] = React.useState<string[]>([]);
  const [tiles, setTiles] = React.useState<UsageTile[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [loadedAt, setLoadedAt] = React.useState<number | null>(null);

  // The store is anonymous + additive: a 501 (not wired) or a store failure
  // keeps the last good rows (drop-don't-wipe), like the legacy refresh.
  const refresh = React.useCallback(async () => {
    const now = Date.now();
    const from = now - USAGE_MS;
    try {
      const [eng, lease] = await Promise.all([getMetrics("engine", from, now), getMetrics("lease", from, now)]);
      const built = buildRows(eng, lease);
      setTiles(usageTiles(eng, lease));
      setRows(built.rows);
      setAbsences(built.absences);
      setErr(null);
      setLoadedAt(now);
    } catch {
      // Store unreachable / not wired: keep the last good rows (drop-don't-wipe).
      setErr("the metrics store is unreachable or not wired (501)");
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const total = (rows ?? []).reduce((n, r) => n + r.values.length, 0);

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-dim">Usage</h2>
        <span className="text-[11px] text-dim">last 7 days · {rows === null ? "loading…" : loadedAt ? new Date(loadedAt).toLocaleTimeString() : "no data"}</span>
        <Button onClick={() => void refresh()} title="refresh the usage rows now" className="ml-auto">
          refresh
        </Button>
      </div>

      {tiles === null && !err ? (
        <TilesSkeleton cols={3} />
      ) : (
        tiles && (
          <StatTiles
            cols={3}
            tiles={tiles.map((tile, i) => ({
              label: ["Requests", "Tokens out", "Idle share"][i],
              title: [
                "requests the engines served over the 7-day window — counted from the engine series",
                "output tokens over the 7-day window — engine counters when the engines publish them, lease reports otherwise",
                "share of sampled time the engines sat idle over the 7-day window",
              ][i],
              tile,
            }))}
          />
        )
      )}

      <Card className="py-0 shadow-none">
        <CardContent className="flex flex-col gap-1 px-4 py-3">
          {rows === null && !err && (
            <div className="text-[12px] text-dim">reading the metrics store…</div>
          )}
          {err && <div className="text-[12px] text-dim italic">{err}</div>}
          {rows !== null && total === 0 && (
            <div className="text-[12px] text-dim italic">no usage recorded yet — the metrics store fills as the box runs</div>
          )}
          {rows !== null && rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2.5 py-0.5 text-[12px]" title={r.title}>
              <span className="flex-none basis-[180px] truncate text-dim" title={r.label}>
                {r.label}
              </span>
              <Sparkline values={r.values} stroke={r.stroke} />
              <span className={`ml-auto flex-none ${r.valueCls}`}>{r.valueText}</span>
            </div>
          ))}
          {/* Named absences: an engine with no load axis gets no row, and the
              gap is stated — never a confident zero. */}
          {absences.map((a, i) => (
            <div key={`abs-${i}`} className="text-[11px] text-dim italic" title="the utilization rows are exception-only: no load read means nothing to report">
              {a}
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
