import { useMemo, useState } from 'react';
import { Card, CardContent, Button } from '@databricks/appkit-ui/react';
import { fmtPrice } from '../../lib/api';

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

function RankBar({
  rank,
  name,
  value,
  max,
  accent,
  sub,
}: {
  rank: number;
  name: string;
  value: number;
  max: number;
  accent?: boolean;
  sub?: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="w-5 text-muted-foreground tabular-nums shrink-0">{rank}</span>
        <span className={`min-w-0 truncate ${accent ? 'font-semibold' : ''}`}>{name}</span>
        <span className="ml-auto font-semibold tabular-nums shrink-0">{fmtPrice(value, 'JPY')}</span>
        {sub && <span className="text-muted-foreground tabular-nums w-12 text-right shrink-0">{sub}</span>}
      </div>
      <div className="h-3 rounded bg-muted overflow-hidden">
        <div
          className="h-full rounded-r-sm"
          style={{
            width: `${Math.max(2, (value / max) * 100)}%`,
            background: accent ? 'var(--chart-accent)' : 'var(--chart-primary)',
          }}
        />
      </div>
    </div>
  );
}

/** Store ranking + popular items (horizontal bars, rank labels, qty re-sort). */
export function RankingBars({ data, storeId }: { data: import('../../lib/api').HistorySummary; storeId: string }) {
  const [popularMetric, setPopularMetric] = useState<'revenue' | 'qty'>('revenue');

  const storeData = useMemo(
    () =>
      (data?.store ?? []).map((s) => ({
        store: `${s.store_name} (${s.store_id})`,
        revenue: Number(s.revenue),
        isSelected: storeId !== '' && s.store_id === storeId,
      })),
    [data, storeId],
  );
  const maxStore = Math.max(1, ...storeData.map((s) => s.revenue));

  const popularData = useMemo(() => {
    const rows = (data?.popular ?? []).map((p) => ({
      item: p.item_name,
      revenue: Number(p.revenue),
      qty: Number(p.qty),
    }));
    return popularMetric === 'qty' ? [...rows].sort((a, b) => b.qty - a.qty) : rows;
  }, [data, popularMetric]);
  const maxPopular = Math.max(1, ...popularData.map((p) => (popularMetric === 'revenue' ? p.revenue : p.qty)));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="dash-enter dash-enter-4 border shadow-xs">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm">店舗別売上ランキング</h3>
            <SourceBadge live={false} />
          </div>
          <div className="space-y-2">
            {storeData.map((s, i) => (
              <RankBar
                key={s.store}
                rank={i + 1}
                name={s.store}
                value={s.revenue}
                max={maxStore}
                accent={s.isSelected}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="dash-enter dash-enter-4 border shadow-xs">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm">人気商品 Top 10</h3>
            <SourceBadge live={false} />
            <div className="ml-auto flex gap-1">
              <Button
                size="sm"
                variant={popularMetric === 'revenue' ? 'default' : 'outline'}
                className="h-11 text-xs"
                onClick={() => setPopularMetric('revenue')}
              >
                売上
              </Button>
              <Button
                size="sm"
                variant={popularMetric === 'qty' ? 'default' : 'outline'}
                className="h-11 text-xs"
                onClick={() => setPopularMetric('qty')}
              >
                点数
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            {popularData.map((p, i) => (
              <RankBar
                key={p.item}
                rank={i + 1}
                name={p.item}
                value={popularMetric === 'revenue' ? p.revenue : p.qty}
                max={maxPopular}
                sub={popularMetric === 'revenue' ? `${p.qty}点` : fmtPrice(p.revenue, 'JPY')}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
