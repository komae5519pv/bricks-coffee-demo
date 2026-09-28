import { useState } from 'react';

/** Shared parts for the history dashboard (single source — the seven
 * sections previously each defined their own copy of SourceBadge, and the
 * charts each had their own tooltip shape). */

export interface TooltipRow {
  label: string;
  value: string;
  /** optional series-color dot shown before the label */
  color?: string;
}

/**
 * ONE tooltip design for the whole dashboard (craft rule 6: card-style,
 * values right-aligned tabular-nums, never the recharts white default).
 * recharts consumers adapt their payload to rows; hand-rolled charts
 * (map, heatmap, sparkline, ranking) render this directly.
 */
export function TooltipCard({ title, rows }: { title: React.ReactNode; rows: TooltipRow[] }) {
  return (
    <div data-tooltip-card className="rounded-md border bg-background px-3 py-2 text-sm shadow-md">
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline gap-3 text-xs">
            {r.color && <span className="h-2 w-2 shrink-0 self-center rounded-full" style={{ background: r.color }} />}
            <span className="text-muted-foreground">{r.label}</span>
            <span className="ml-auto font-semibold tabular-nums">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** recharts Tooltip content adapter for single-series charts. */
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
  return <TooltipCard title={label} rows={[{ label: v.name ?? '', value: fmt(Number(v.value)) }]} />;
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

/**
 * Tiny inline sparkline (KPI tiles), last-N values, gradient area + line.
 * Stretches full-bleed (preserveAspectRatio="none") so it hugs the card
 * edge Tremor-style. When `labels` are given, hovering shows a TooltipCard
 * with the day and value (index from the pointer's horizontal fraction).
 */
export function Sparkline({
  values,
  labels,
  format,
  className,
}: {
  values: number[];
  labels?: string[];
  format?: (v: number) => string;
  className?: string;
}) {
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
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
  const fmt = format ?? ((v: number) => String(v));
  return (
    <div
      className={`relative ${className ?? ''}`}
      onMouseMove={(e) => {
        if (!labels) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const i = Math.round(frac * (values.length - 1));
        setHover({ i, x: e.clientX - rect.left });
      }}
      onMouseLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full" aria-hidden>
        <defs>
          <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-primary)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--chart-primary)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#spark-fill)" />
        <path d={line} fill="none" stroke="var(--chart-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {hover && (
          <circle cx={pts[hover.i].x} cy={pts[hover.i].y} r={3} fill="var(--chart-accent)" stroke="var(--background)" strokeWidth={1.5} />
        )}
      </svg>
      {hover && labels && (
        <div className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full" style={{ left: hover.x }}>
          <TooltipCard title={labels[hover.i]} rows={[{ label: '値', value: fmt(values[hover.i]) }]} />
        </div>
      )}
    </div>
  );
}
