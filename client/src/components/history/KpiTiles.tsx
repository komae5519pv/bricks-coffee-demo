import { Card, CardContent } from '@databricks/appkit-ui/react';
import { ShoppingBag, Wallet, Clock, Layers, TrendingUp, TrendingDown } from 'lucide-react';
import { fmtPrice } from '../../lib/api';
import { useTweenedNumber } from '../../lib/use-tweened-number';
import { Sparkline, SourceBadge } from './chart-parts';

interface Delta {
  pct: number;
  up: boolean;
}

/** % change vs a baseline, from real aggregates only. Returns null when the
 * baseline is missing/zero — the tile then honestly shows no badge instead
 * of a made-up number. */
function computeDelta(current: number, baseline: number): Delta | null {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline <= 0) return null;
  const pct = Math.round(((current - baseline) / baseline) * 100);
  if (!Number.isFinite(pct)) return null;
  return { pct: Math.abs(pct), up: pct >= 0 };
}

function DeltaBadge({ delta, title }: { delta: Delta | null; title: string }) {
  if (!delta) return null;
  const Icon = delta.up ? TrendingUp : TrendingDown;
  return (
    <span
      data-delta-badge
      title={title}
      className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
        delta.pct === 0
          ? 'border-border bg-muted text-muted-foreground'
          : delta.up
            ? 'border-green-200 bg-green-50 text-green-700'
            : 'border-red-200 bg-red-50 text-red-700'
      }`}
    >
      <Icon className="h-3 w-3" />
      {delta.pct}%
    </span>
  );
}

/** 5-layer KPI tile (craft rule 7): icon chip + label + provenance pill /
 * big tweened number (tabular-nums) + delta badge / full-bleed sparkline /
 * baseline footer. shadcn dashboard-01's subtle gradient lift is kept. */
function KpiTile({
  icon,
  label,
  value,
  format,
  delta,
  deltaTitle,
  baseline,
  sparkValues,
  hero,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  /** value formatter: ¥ for money, N件 for counts */
  format: (v: number) => string;
  delta: Delta | null;
  deltaTitle: string;
  baseline: string;
  sparkValues: number[];
  hero?: boolean;
}) {
  const tweened = useTweenedNumber(value);
  return (
    <Card data-kpi-tile className="dash-enter rounded-2xl border shadow-xs bg-gradient-to-t from-primary/5 to-card">
      <CardContent className="p-4 space-y-2.5">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-primary/10 p-1.5 text-primary">{icon}</span>
          <span className="text-xs text-muted-foreground tracking-wide">{label}</span>
          <span className="ml-auto">
            <SourceBadge live />
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className={`font-semibold tabular-nums tracking-tight ${hero ? 'text-4xl' : 'text-2xl'}`}>
            {format(tweened)}
          </span>
          <DeltaBadge delta={delta} title={deltaTitle} />
        </div>
        <Sparkline values={sparkValues} className="h-9 w-full" />
        <div className="text-xs text-muted-foreground">{baseline}</div>
      </CardContent>
    </Card>
  );
}

export function KpiTiles({ data }: { data: import('../../lib/api').HistorySummary }) {
  const daily = data.daily ?? [];
  const sparkRevenue = daily.map((d) => Number(d.revenue));
  const sparkOrders = daily.map((d) => Number(d.orders));
  const inProgressTotal =
    Number(data.in_progress.received) + Number(data.in_progress.preparing) + Number(data.in_progress.ready);

  // Deltas vs the historical same-day average (the footer shows the same
  // baseline, so the badge is verifiable at a glance). 進行中の注文 has no
  // meaningful historical counterpart — no badge by design.
  const salesDelta = computeDelta(Number(data.today_revenue), Number(data.hist_avg_daily_revenue));
  const ordersDelta = computeDelta(Number(data.today_orders), Number(data.hist_avg_daily_orders));
  const aovDelta = computeDelta(Number(data.avg_order_value), Number(data.hist_avg_order_value));

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <KpiTile
        hero
        icon={<Wallet className="h-4 w-4" />}
        label="今日の売上"
        value={Number(data.today_revenue)}
        format={(v) => fmtPrice(v, 'JPY')}
        delta={salesDelta}
        deltaTitle="過去データ同日平均比"
        baseline={`昨日最終 ${fmtPrice(data.yesterday_revenue, 'JPY')} / 過去データ同日平均 ${fmtPrice(data.hist_avg_daily_revenue, 'JPY')}`}
        sparkValues={sparkRevenue}
      />
      <KpiTile
        icon={<ShoppingBag className="h-4 w-4" />}
        label="今日の注文数"
        value={Number(data.today_orders)}
        format={(v) => `${v}件`}
        delta={ordersDelta}
        deltaTitle="過去データ同日平均比"
        baseline={`昨日 ${data.yesterday_orders}件 / 過去平均 ${Math.round(Number(data.hist_avg_daily_orders))}件`}
        sparkValues={sparkOrders}
      />
      <KpiTile
        icon={<Layers className="h-4 w-4" />}
        label="平均客単価"
        value={Number(data.avg_order_value)}
        format={(v) => fmtPrice(v, 'JPY')}
        delta={aovDelta}
        deltaTitle="過去データ平均比"
        baseline={`過去データ平均 ${fmtPrice(data.hist_avg_order_value, 'JPY')}`}
        sparkValues={sparkRevenue.map((r, i) => (sparkOrders[i] > 0 ? Math.round(r / sparkOrders[i]) : 0))}
      />
      <KpiTile
        icon={<Clock className="h-4 w-4" />}
        label="進行中の注文"
        value={inProgressTotal}
        format={(v) => `${v}件`}
        delta={null}
        deltaTitle=""
        baseline={`受付 ${data.in_progress.received}・調理中 ${data.in_progress.preparing}・完成 ${data.in_progress.ready}`}
        sparkValues={sparkOrders}
      />
    </div>
  );
}
