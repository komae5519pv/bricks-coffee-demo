import { useMemo, useState } from 'react';
import { Card, CardContent, Button } from '@databricks/appkit-ui/react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { fmtPrice } from '../../lib/api';
import { ChartTooltipCard, SourceBadge } from './chart-parts';

/** Monthly revenue trend: area with transparent gradient fill; the live
 * current month renders as an accent dot + segment (B1's is_live data). */
export function TrendChart({ data }: { data: import('../../lib/api').HistorySummary }) {
  const [metric, setMetric] = useState<'revenue' | 'orders'>('revenue');
  const trendData = useMemo(
    () =>
      (data?.monthly ?? []).map((m) => ({
        month: m.month,
        revenue: Number(m.revenue),
        orders: Number(m.orders),
        is_live: m.is_live,
      })),
    [data],
  );
  const liveMonth = trendData.find((m) => m.is_live)?.month ?? null;
  const fmt = (v: number) => (metric === 'revenue' ? fmtPrice(v, 'JPY') : `${v}件`);

  return (
    <Card className="dash-enter dash-enter-2 rounded-2xl border shadow-xs">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-3">
          <h3 className="font-medium text-sm">月別売上トレンド</h3>
          <SourceBadge live={false} />
          <div className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant={metric === 'revenue' ? 'default' : 'outline'}
              className="h-11 text-xs"
              onClick={() => setMetric('revenue')}
            >
              売上
            </Button>
            <Button
              size="sm"
              variant={metric === 'orders' ? 'default' : 'outline'}
              className="h-11 text-xs"
              onClick={() => setMetric('orders')}
            >
              注文数
            </Button>
          </div>
        </div>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-primary)" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="var(--chart-primary)" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--chart-track)" strokeWidth={1} />
              <XAxis
                dataKey="month"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: 'var(--chart-text)' }}
                tickMargin={8}
                minTickGap={32}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: 'var(--chart-text)' }}
                style={{ fontVariantNumeric: 'tabular-nums' }}
                tickFormatter={(v: number) => (metric === 'revenue' ? fmtPrice(v, 'JPY') : String(v))}
                width={70}
              />
              <Tooltip content={<ChartTooltipCard fmt={fmt} />} cursor={{ stroke: 'var(--chart-track)', strokeWidth: 1 }} />
              <Area isAnimationActive={false}
                type="monotone"
                dataKey={metric}
                stroke="var(--chart-primary)"
                strokeWidth={2}
                fill="url(#trend-fill)"
                dot={(props: { cx?: number; cy?: number; index?: number }) => {
                  const i = props.index ?? 0;
                  const isLive = trendData[i]?.is_live;
                  if (!isLive) return <g key={i} />;
                  return (
                    <circle
                      key={i}
                      cx={props.cx}
                      cy={props.cy}
                      r={5}
                      fill="var(--chart-accent)"
                      stroke="var(--background)"
                      strokeWidth={2}
                    />
                  );
                }}
                activeDot={{ r: 5, fill: 'var(--chart-accent)', stroke: 'var(--background)', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        {liveMonth && (
          <p className="text-xs text-muted-foreground">
            当月 ({liveMonth}) はライブの注文 (Lakebase) のみ (オレンジの点)。履歴月は過去データ (〜{trendData.filter((m) => !m.is_live).slice(-1)[0]?.month ?? '—'})。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
