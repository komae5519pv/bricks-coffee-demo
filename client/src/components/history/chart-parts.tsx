/** Shared parts for the history dashboard (single source — the seven
 * sections previously each defined their own copy of SourceBadge). */

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

/** Provenance pill. Live = pulsing dot (the dashboard is alive, streaming
 * from Lakebase); history = quiet static pill. Status color is reserved for
 * the live state only, per the semantic-color rule. */
export function SourceBadge({ live }: { live: boolean }) {
  if (!live) {
    return (
      <span className="inline-flex items-center rounded-full border bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        履歴
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
      <span className="relative flex h-1.5 w-1.5" data-live-pulse>
        <span className="animate-ping-slow absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-500" />
      </span>
      ライブ / Lakebase
    </span>
  );
}

/** Tiny inline sparkline (KPI tiles), last-N values, gradient area + line.
 * Stretches full-bleed (preserveAspectRatio="none") so it hugs the card
 * edge Tremor-style; the end dot was dropped because horizontal stretch
 * turns a circle into an ellipse. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return <div className={className} />;
  const w = 240;
  const h = 36;
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
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={className} aria-hidden>
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-primary)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--chart-primary)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark-fill)" />
      <path d={line} fill="none" stroke="var(--chart-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
