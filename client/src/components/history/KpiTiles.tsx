import { Card, CardContent } from '@databricks/appkit-ui/react';
import { ShoppingBag, Wallet, Clock, Layers } from 'lucide-react';
import { fmtPrice } from '../../lib/api';
import { useTweenedNumber } from '../../lib/use-tweened-number';
import { Sparkline } from './chart-parts';

function SourceBadge({ live }: { live: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
        live ? 'bg-blue-100 text-blue-800' : 'bg-muted text-muted-foreground'
      }`}
    >
      {live ? 'ライブ / Lakebase' : '履歴'}
    </span>
  );
}

/** 5-layer KPI tile: label / value (tweened, tabular-nums) / sparkline /
 * insight line / source badge + baseline (craft rule 7). */
function KpiTile({
  icon,
  label,
  value,
  baseline,
  sparkValues,
  hero,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  baseline: string;
  sparkValues: number[];
  hero?: boolean;
}) {
  const tweened = useTweenedNumber(value);
  return (
    <Card className="dash-enter border shadow-xs">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground tracking-wide">
          {icon}
          {label}
          <span className="ml-auto">
            <SourceBadge live />
          </span>
        </div>
        <div className="flex items-end justify-between gap-2">
          <div className={`font-semibold tabular-nums tracking-tight ${hero ? 'text-4xl' : 'text-2xl'}`}>
            {fmtPrice(tweened, 'JPY')}
          </div>
          <Sparkline values={sparkValues} className="h-8 w-24 shrink-0" />
        </div>
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

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <KpiTile
        hero
        icon={<Wallet className="h-4 w-4" />}
        label="今日の売上"
        value={Number(data.today_revenue)}
        baseline={`昨日最終 ${fmtPrice(data.yesterday_revenue, 'JPY')} / 過去データ同日平均 ${fmtPrice(data.hist_avg_daily_revenue, 'JPY')}`}
        sparkValues={sparkRevenue}
      />
      <KpiTile
        icon={<ShoppingBag className="h-4 w-4" />}
        label="今日の注文数"
        value={Number(data.today_orders)}
        baseline={`昨日 ${data.yesterday_orders}件 / 過去平均 ${Math.round(Number(data.hist_avg_daily_orders))}件`}
        sparkValues={sparkOrders}
      />
      <KpiTile
        icon={<Layers className="h-4 w-4" />}
        label="平均客単価"
        value={Number(data.avg_order_value)}
        baseline={`過去データ平均 ${fmtPrice(data.hist_avg_order_value, 'JPY')}`}
        sparkValues={sparkRevenue.map((r, i) => (sparkOrders[i] > 0 ? Math.round(r / sparkOrders[i]) : 0))}
      />
      <KpiTile
        icon={<Clock className="h-4 w-4" />}
        label="進行中の注文"
        value={inProgressTotal}
        baseline={`受付 ${data.in_progress.received}・調理中 ${data.in_progress.preparing}・完成 ${data.in_progress.ready}`}
        sparkValues={sparkOrders}
      />
    </div>
  );
}
