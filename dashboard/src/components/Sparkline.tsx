// The legacy dashboard's sparkline, ported: a fixed 120x22 box, the
// series scaled to its own max, the latest value riding the right edge
// outside the svg. Flat by default: no fill, no shadow — one hairline
// polyline.
export function Sparkline({
  values,
  className,
  title,
}: {
  values: number[];
  className?: string;
  title?: string;
}) {
  if (values.length === 0) return null;
  const w = 120;
  const h = 22;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={`h-[22px] min-w-0 flex-1 ${className ?? ""}`}
      aria-hidden="true"
    >
      <title>{title}</title>
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
