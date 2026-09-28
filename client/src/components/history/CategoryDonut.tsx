import { useMemo } from 'react';
import { Card, CardContent } from '@databricks/appkit-ui/react';
import { PieChart, Pie, Tooltip, ResponsiveContainer } from 'recharts';
import { fmtPrice } from '../../lib/api';
import { ChartTooltipCard, SourceBadge } from './chart-parts';

const DONUT_COLORS = [
  'var(--chart-cat-1)',
  'var(--chart-cat-2)',
  'var(--chart-cat-3)',
  'var(--chart-cat-4)',
  'var(--chart-cat-5)',
  'var(--chart-cat-6)',
];

/** Category donut: top 5 + その他, direct labels, center total (dataviz:
 * categorical palette validated; CVD 6-8 floor band legal with direct labels). */
export function CategoryDonut({ data }: { data: import('../../lib/api').HistorySummary }) {
  const { slices, total } = useMemo(() => {
    const rows = (data?.category ?? []).map((c) => ({ name: c.category, value: Number(c.revenue) }));
    const total = rows.reduce((s, r) => s + r.value, 0);
    const top = rows.slice(0, 5);
    const rest = rows.slice(5);
    const restSum = rest.reduce((s, r) => s + r.value, 0);
    const merged = restSum > 0 ? [...top, { name: 'その他', value: restSum }] : top;
    // recharts v3: Cell is deprecated; each data point carries its own fill
    const slices = merged.map((s, i) => ({ ...s, fill: DONUT_COLORS[i % DONUT_COLORS.length] }));
    return { slices, total };
  }, [data]);

  return (
    <Card className="dash-enter dash-enter-3 rounded-2xl border shadow-xs">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm">カテゴリ別売上構成</h3>
          <SourceBadge live={false} />
        </div>
        <div className="relative h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie isAnimationActive={false}
                data={slices}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={90}
                paddingAngle={1}
                cornerRadius={4}
              />
              <Tooltip content={<ChartTooltipCard fmt={(v) => fmtPrice(v, 'JPY')} />} />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <div className="text-2xl font-semibold tabular-nums">{fmtPrice(total, 'JPY')}</div>
            <div className="text-xs text-muted-foreground">合計</div>
          </div>
        </div>
        <div className="space-y-1.5">
          {slices.map((s, i) => (
            <div key={s.name} className="flex items-center gap-2 text-xs">
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
              <span className="min-w-0 truncate">{s.name}</span>
              <span className="ml-auto font-semibold tabular-nums">{fmtPrice(s.value, 'JPY')}</span>
              <span className="text-muted-foreground tabular-nums w-12 text-right">
                {total > 0 ? `${Math.round((s.value / total) * 100)}%` : '-'}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

