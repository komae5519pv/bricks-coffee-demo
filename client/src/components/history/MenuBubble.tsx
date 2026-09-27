import { useMemo } from 'react';
import { Card, CardContent } from '@databricks/appkit-ui/react';
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
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

const QUADRANT_COLORS = ['var(--chart-cat-1)', 'var(--chart-cat-2)', 'var(--chart-cat-3)', 'var(--chart-cat-4)'];

/** Menu engineering bubble: X=qty, Y=avg price, size=revenue, median split
 * into 4 quadrants. Honest axes: no cost data, so no margin pretense. */
export function MenuBubble({ data }: { data: import('../../lib/api').HistorySummary }) {
  const { points, medianQty, medianPrice } = useMemo(() => {
    const rows = (data?.bubble ?? []).map((b) => ({
      item: b.item_name,
      qty: Number(b.qty),
      price: Number(b.avg_price),
      revenue: Number(b.revenue),
      category: b.category,
    }));
    const qtys = rows.map((r) => r.qty).sort((a, b) => a - b);
    const prices = rows.map((r) => r.price).sort((a, b) => a - b);
    const medianQty = qtys[Math.floor(qtys.length / 2)] ?? 0;
    const medianPrice = prices[Math.floor(prices.length / 2)] ?? 0;
    const points = rows.map((r) => ({
      ...r,
      z: Math.sqrt(r.revenue), // bubble size scales with revenue
      quadrant:
        r.qty >= medianQty && r.price >= medianPrice
          ? 0 // 稼ぎ頭 (high qty, high price)
          : r.qty >= medianQty
            ? 1 // 集客商品 (high qty, low price)
            : r.price >= medianPrice
              ? 2 // 高級ニッチ (low qty, high price)
              : 3, // 低調 (low qty, low price)
    }));
    return { points, medianQty, medianPrice };
  }, [data]);

  const quadrantLabels = ['稼ぎ頭', '集客商品', '高級ニッチ', '低調'];

  return (
    <Card className="dash-enter dash-enter-4 border shadow-xs">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm">メニューエンジニアリング</h3>
          <SourceBadge live={false} />
          <span className="ml-auto text-xs text-muted-foreground">X=販売数量・Y=平均単価・サイズ=売上高</span>
        </div>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--chart-track)" strokeWidth={1} />
              <XAxis
                type="number"
                dataKey="qty"
                name="販売数量"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: 'var(--chart-text)' }}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              />
              <YAxis
                type="number"
                dataKey="price"
                name="平均単価"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: 'var(--chart-text)' }}
                style={{ fontVariantNumeric: 'tabular-nums' }}
                tickFormatter={(v: number) => fmtPrice(v, 'JPY')}
                width={70}
              />
              <ZAxis type="number" dataKey="z" range={[60, 400]} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.[0]) return null;
                  const p = payload[0].payload as { item: string; qty: number; price: number; revenue: number; quadrant: number };
                  return (
                    <div className="rounded-md border bg-background px-3 py-2 text-sm shadow-md">
                      <div className="text-xs text-muted-foreground">{p.item}</div>
                      <div className="mt-0.5 space-y-0.5 text-xs">
                        <div className="flex justify-between gap-4">
                          <span>販売数量</span>
                          <span className="font-semibold tabular-nums">{p.qty}点</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>平均単価</span>
                          <span className="font-semibold tabular-nums">{fmtPrice(p.price, 'JPY')}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>売上高</span>
                          <span className="font-semibold tabular-nums">{fmtPrice(p.revenue, 'JPY')}</span>
                        </div>
                        <div className="flex justify-between gap-4">
                          <span>象限</span>
                          <span className="font-semibold">{quadrantLabels[p.quadrant]}</span>
                        </div>
                      </div>
                    </div>
                  );
                }}
              />
              <ReferenceLine x={medianQty} stroke="var(--chart-track)" strokeDasharray="4 4" />
              <ReferenceLine y={medianPrice} stroke="var(--chart-track)" strokeDasharray="4 4" />
              {[0, 1, 2, 3].map((q) => (
                <Scatter
                  key={q}
                  data={points.filter((p) => p.quadrant === q)}
                  fill={QUADRANT_COLORS[q]}
                  fillOpacity={0.7}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {quadrantLabels.map((label, i) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: QUADRANT_COLORS[i] }} />
              <span>{label}</span>
              <span className="text-muted-foreground ml-auto">{points.filter((p) => p.quadrant === i).length}品</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          中央値で4象限分割。原価データはないため粗利のふりをせず、数量・単価・売上の構造として読む。
        </p>
      </CardContent>
    </Card>
  );
}
