// Metrics wave S2 — the utilization read, pure (no DOM, no fetch). Two
// surfaces, one vocabulary:
//
//  1. The Usage tab's exception-only rows, built from the hour buckets' S1
//     aggregates (busy %, peak in-flight, gpu util max, power max, queue max).
//     Peaks and counts only — never a mean of a spiky gauge (grill D2).
//  2. The per-engine card's raw drill: the peak of each gauge per hour inside
//     the raw window, computed from the raw lines themselves.
//
// The honesty rules are the repo's: an engine whose hour lines carry no
// `load_reads` key produces NO row — the absence is named, never zeroed. A
// gauge the kind never reports is absent, so it is never seen, and its peak is
// undefined, not 0. Sparkline gaps are rendered as 0 exactly as the existing
// token rows do, and the row's `title` names the gap.
import type { MetricPoint, RawLoadLine } from "./api";

export type UsageRow = {
  label: string;
  values: number[];
  stroke: string;
  valueCls: string;
  valueText: string;
  title: string;
};

const HOUR_MS = 3_600_000;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * The utilization rows for ONE engine's hour buckets. Returns rows only for
 * the aggregates that actually exist, and an `absence` line for an engine the
 * store never saw load-read (the named absence, not a zero).
 */
export function utilizationRowsFor(key: string, points: MetricPoint[]): { rows: UsageRow[]; absence: string | null } {
  const withLoads = points.filter((p) => num(p.load_reads) !== null && (p.load_reads ?? 0) > 0);
  if (withLoads.length === 0) {
    return {
      rows: [],
      absence: points.length > 0
        ? `${key} — no load axis in this window: the store saw no load read for this engine`
        : null,
    };
  }
  const rows: UsageRow[] = [];

  // busy %: counts, never a mean of a gauge. The denominator is the reads.
  const busy = withLoads.map((p) => Math.round(((num(p.busy_reads) ?? 0) / (p.load_reads as number)) * 100));
  const totalReads = withLoads.reduce((a, p) => a + (p.load_reads as number), 0);
  const totalBusy = withLoads.reduce((a, p) => a + (num(p.busy_reads) ?? 0), 0);
  rows.push(
    row(`${key} busy %`, busy, "var(--warn)", "text-warn", `${Math.round((totalBusy / totalReads) * 100)}% of ${totalReads} reads`,
      "share of load reads that fired the busy veto, per hour bucket · counts, not a gauge mean",
    ),
  );

  // Peaks: a row only when the kind reported that gauge at least once.
  const peak = (getter: (p: MetricPoint) => number | null, label: string, unit: string, stroke: string, cls: string, note: string) => {
    const vals = withLoads.map(getter);
    if (!vals.some((v) => v !== null && v > 0)) return;
    const shown = vals.map((v) => v ?? 0);
    const max = Math.max(...shown);
    rows.push(
      row(`${key} ${label}`, shown, stroke, cls, `${max}${unit}`,
        `${note} · peak over the hour buckets that reported it; hours with no reading are a gap, not a zero`,
      ),
    );
  };
  peak((p) => num(p.peak_in_flight), "peak in-flight", "", "var(--accent)", "text-accent", "highest in-flight count seen in the hour");
  peak((p) => num(p.peak_queue_depth), "peak queue", "", "var(--accent)", "text-accent", "scheduler queue depth (only oMLX reports a queue)");
  peak((p) => num(p.gpu_util_max), "gpu util max", "%", "var(--warn)", "text-warn", "highest GPU utilization the engine reported in the hour");
  peak((p) => num(p.gpu_power_max), "gpu power max", " W", "var(--warn)", "text-warn", "highest GPU power draw the engine reported in the hour");

  return { rows, absence: null };
}

/**
 * The per-engine card's raw drill: the peak of each gauge per hour inside the
 * raw window. Peaks only (the same law as the hour rollup); an hour with no
 * reading of a gauge is a gap the row never claims.
 */
export function rawLoadDrill(
  lines: RawLoadLine[],
  windowMs: number,
  now: number,
): { rows: UsageRow[]; coverage: string } | null {
  const loadLines = lines.filter((l) => typeof l.load_source === "string" && l.load_source !== "");
  if (loadLines.length === 0) return null;
  const earliest = Math.min(...loadLines.map((l) => l.ts));
  const gauge = (getter: (l: RawLoadLine) => number | null, label: string, unit: string, stroke: string, cls: string): UsageRow | null => {
    const peaks: number[] = [];
    for (let h = 0; h * HOUR_MS < windowMs; h++) {
      const from = now - (h + 1) * HOUR_MS;
      const to = now - h * HOUR_MS;
      let peak: number | null = null;
      for (const l of loadLines) {
        if (l.ts < from || l.ts >= to) continue;
        const v = getter(l);
        if (v !== null && (peak === null || v > peak)) peak = v;
      }
      peaks.push(peak ?? 0);
    }
    peaks.reverse();
    if (!peaks.some((v) => v > 0)) return null;
    return row(`${label} · raw peak/hr`, peaks, stroke, cls, `${Math.max(...peaks)}${unit}`, "raw samples, peak per hour — the 48h raw window, oldest points trimmed by the store's 2,000-point cap");
  };
  const rows = [
    gauge((l) => num(l.in_flight), "in-flight", "", "var(--accent)", "text-accent"),
    gauge((l) => num(l.queue_depth), "queue", "", "var(--accent)", "text-accent"),
    gauge((l) => num(l.gpu_util_percent), "gpu util", "%", "var(--warn)", "text-warn"),
    gauge((l) => num(l.gpu_power_watts), "gpu power", " W", "var(--warn)", "text-warn"),
  ].filter((r): r is UsageRow => r !== null);
  if (rows.length === 0) return null;
  const spanH = Math.max(1, Math.round((now - earliest) / 3600000));
  return { rows, coverage: `${loadLines.length} raw samples, oldest at ${new Date(earliest).toLocaleString()} (${spanH}h span)` };
}

function row(label: string, values: number[], stroke: string, valueCls: string, valueText: string, title: string): UsageRow {
  return { label, values, stroke, valueCls, valueText, title };
}
