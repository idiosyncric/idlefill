// The peer-row expand's row builder (#79 D6). Pure + exception-only, the
// #52/#57 Usage sparkline vocabulary reused: one renderer (Sparkline) for
// local and remote points. The remote points are the PEER's own store
// lines, keyed as the peer's arbiter named them — attribution, never a
// merge (the #79 conflict rule): no cross-peer sums, no renaming here.
// A feed-delta engine with no counter-backed token truth gets NO token
// row — a gap, never a fake zero (the #62 honesty rule).

export type RemoteSeries = { key: string; points: Record<string, unknown>[] }[];

export type RemoteRow = {
  key: string;
  series: "engine" | "session";
  label: string;
  values: number[];
  stroke: string;
  valueText: string;
  title: string;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export function buildRemoteRows(engine: RemoteSeries, session: RemoteSeries): RemoteRow[] {
  const rows: RemoteRow[] = [];
  for (const s of engine.slice(0, 20)) {
    const reqs = s.points.map((p) => num(p.req_total) ?? 0);
    rows.push({
      key: s.key,
      series: "engine",
      label: `${s.key} req/hour`,
      values: reqs,
      stroke: "var(--accent)",
      valueText: reqs.reduce((a, b) => a + b, 0).toLocaleString(),
      title: "requests per hour bucket, the peer's own store (last 7 days)",
    });
    const tokOut = s.points.map((p) => num(p.engine_tokens_out));
    if (tokOut.some((v) => v !== null && v > 0)) {
      rows.push({
        key: s.key,
        series: "engine",
        label: `${s.key} tok out/hour (engine)`,
        values: tokOut.map((v) => v ?? 0),
        stroke: "var(--warn)",
        valueText: tokOut.reduce<number>((a, b) => a + (b ?? 0), 0).toLocaleString(),
        title: "engine-reported output tokens per hour bucket (null = no counter-backed sample — a gap, not a zero)",
      });
    }
  }
  // Session rows: the series key is the peer's derived session token —
  // often a model name (the owner allowed this field to cross, #79 Q5/Q6).
  for (const s of session.slice(0, 20)) {
    const rpm = s.points.map((p) => num(p.reqs_per_min_max) ?? 0);
    rows.push({
      key: s.key,
      series: "session",
      label: `${s.key} req/min (peak)`,
      values: rpm,
      stroke: "var(--ok)",
      valueText: rpm.length ? String(Math.max(...rpm)) : "—",
      title: "peak requests/min per hour bucket, the peer's session series (key = its derived token)",
    });
  }
  return rows;
}
