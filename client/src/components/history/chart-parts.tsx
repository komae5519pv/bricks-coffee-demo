
/** Card-style tooltip replacing recharts' white default (craft rule 6). */
export function ChartTooltipCard({
  active,
  payload,
  label,
  fmt,
}: {
  active?: boolean;
  payload?: { value?: number | string; name?: string; dataKey?: string }[];
  label?: string;
  fmt: (v: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const v = payload[0];
  return (
    <div className="rounded-md border bg-background px-3 py-2 text-sm shadow-md">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-xs text-muted-foreground">{v.name}</span>
        <span className="ml-auto font-semibold tabular-nums">{fmt(Number(v.value))}</span>
      </div>
    </div>
  );
}

/** Tiny inline sparkline (KPI tiles), last-N values, area + line. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return <div className={className} />;
  const w = 96;
  const h = 32;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => ({
    x: (i / (values.length - 1)) * w,
    y: h - 2 - ((v - min) / span) * (h - 4),
  }));
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden>
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-primary)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--chart-primary)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark-fill)" />
      <path d={line} fill="none" stroke="var(--chart-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r="2.5" fill="var(--chart-accent)" stroke="var(--background)" strokeWidth="1.5" />
    </svg>
  );
}
