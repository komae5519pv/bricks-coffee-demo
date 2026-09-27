import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, Button } from '@databricks/appkit-ui/react';
import { BarChart3, ShoppingBag, Wallet, Clock, Layers } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { api, fmtPrice, type HistorySummary, type Store } from '../lib/api';

// dataviz validated palette (validate_palette.js "#2a78d6,#eb6834" --mode light: ALL CHECKS PASS)
const CHART_PRIMARY = '#2a78d6'; // slot 1 (blue)
const CHART_ACCENT = '#eb6834';  // slot 2 (orange) — live overlay / selected store
const CHART_TRACK = '#e9e9e7';   // de-emphasis track
const CHART_TEXT = '#52514e';    // secondary text

function Badge({ live }: { live: boolean }) {
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

function KpiTile({
  icon,
  label,
  value,
  sub,
  hero,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  hero?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {label}
          <span className="ml-auto">
            <Badge live />
          </span>
        </div>
        <div className={`font-bold ${hero ? 'text-4xl' : 'text-2xl'}`}>{value}</div>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
}

/** Sales & history analytics dashboard: live Lakebase KPIs + historical trends. */
export function HistoryPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [data, setData] = useState<HistorySummary | null>(null);
  const [trendMetric, setTrendMetric] = useState<'revenue' | 'orders'>('revenue');
  const [popularMetric, setPopularMetric] = useState<'revenue' | 'qty'>('revenue');

  useEffect(() => {
    void api.stores().then(setStores).catch(() => setStores([]));
  }, []);

  const load = useCallback(() => {
    api.history(storeId || undefined).then(setData).catch(() => setData(null));
  }, [storeId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const currency = data?.today_currency ?? 'JPY';
  const fmt = (v: string | number) => fmtPrice(v, currency);

  const trendData = useMemo(
    () =>
      (data?.monthly ?? []).map((m) => ({
        month: m.month,
        revenue: Number(m.revenue),
        orders: Number(m.orders),
      })),
    [data],
  );
  const currentMonth = trendData.length > 0 ? trendData[trendData.length - 1].month : null;

  const hourlyData = useMemo(
    () =>
      (data?.hourly ?? []).map((h) => ({
        hour: `${h.hour}時`,
        orders: Number(h.orders),
      })),
    [data],
  );

  const categoryData = useMemo(
    () =>
      (data?.category ?? []).map((c) => ({
        category: c.category,
        revenue: Number(c.revenue),
      })),
    [data],
  );

  const storeData = useMemo(
    () =>
      (data?.store ?? []).map((s) => ({
        store: `${s.store_name} (${s.store_id})`,
        revenue: Number(s.revenue),
        isSelected: storeId !== '' && s.store_id === storeId,
      })),
    [data, storeId],
  );

  const popularData = useMemo(
    () =>
      (data?.popular ?? []).map((p) => ({
        item: p.item_name,
        revenue: Number(p.revenue),
        qty: Number(p.qty),
      })),
    [data],
  );

  const maxCategory = Math.max(1, ...categoryData.map((c) => c.revenue));
  const maxPopular = Math.max(1, ...popularData.map((p) => (popularMetric === 'revenue' ? p.revenue : p.qty)));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold flex items-center gap-2 whitespace-nowrap">
          <BarChart3 className="h-5 w-5" /> 売上・履歴
        </h2>
        <select
          className="h-11 sm:h-9 max-w-full rounded-md border bg-background px-3 text-sm"
          value={storeId}
          onChange={(e) => setStoreId(e.target.value)}
        >
          <option value="">全店舗</option>
          {stores.map((s) => (
            <option key={s.store_id} value={s.store_id}>
              {s.store_name} ({s.store_id})
            </option>
          ))}
        </select>
      </div>

      {/* Row 1: KPI strip (live) */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          hero
          icon={<Wallet className="h-4 w-4" />}
          label="今日の売上"
          value={data ? fmt(data.today_revenue) : '-'}
          sub={`昨日最終 ${data ? fmt(data.yesterday_revenue) : '-'} / 過去データ同日平均 ${data ? fmt(data.hist_avg_daily_revenue) : '-'}`}
        />
        <KpiTile
          icon={<ShoppingBag className="h-4 w-4" />}
          label="今日の注文数"
          value={data ? `${data.today_orders}件` : '-'}
          sub={`昨日 ${data ? data.yesterday_orders : '-'}件 / 過去平均 ${data ? Math.round(Number(data.hist_avg_daily_orders)).toLocaleString() : '-'}件`}
        />
        <KpiTile
          icon={<Layers className="h-4 w-4" />}
          label="平均客単価"
          value={data ? fmt(data.avg_order_value) : '-'}
          sub={`過去データ平均 ${data ? fmt(data.hist_avg_order_value) : '-'}`}
        />
        <KpiTile
          icon={<Clock className="h-4 w-4" />}
          label="進行中の注文"
          value={data ? `${Number(data.in_progress.received) + Number(data.in_progress.preparing) + Number(data.in_progress.ready)}件` : '-'}
          sub={`受付 ${data?.in_progress.received ?? '-'}・調理中 ${data?.in_progress.preparing ?? '-'}・完成 ${data?.in_progress.ready ?? '-'}`}
        />
      </div>

      {/* Row 2: monthly trend */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-3">
            <h3 className="font-medium text-sm">月別売上トレンド</h3>
            <Badge live={false} />
            <div className="ml-auto flex gap-1">
              <Button
                size="sm"
                variant={trendMetric === 'revenue' ? 'default' : 'outline'}
                className="h-8 text-xs"
                onClick={() => setTrendMetric('revenue')}
              >
                売上
              </Button>
              <Button
                size="sm"
                variant={trendMetric === 'orders' ? 'default' : 'outline'}
                className="h-8 text-xs"
                onClick={() => setTrendMetric('orders')}
              >
                注文数
              </Button>
            </div>
          </div>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="0" stroke={CHART_TRACK} vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: CHART_TEXT }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: CHART_TEXT }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => (trendMetric === 'revenue' ? fmt(v) : String(v))}
                />
                <Tooltip
                  formatter={(v) => [trendMetric === 'revenue' ? fmt(Number(v)) : `${Number(v)}件`, trendMetric === 'revenue' ? '売上' : '注文数']}
                  cursor={{ fill: CHART_TRACK, opacity: 0.3 }}
                />
                <Bar dataKey={trendMetric} radius={[4, 4, 0, 0]} maxBarSize={24}>
                  {trendData.map((d, i) => (
                    <Cell key={d.month} fill={i === trendData.length - 1 ? CHART_ACCENT : CHART_PRIMARY} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {currentMonth && (
            <p className="text-xs text-muted-foreground">
              当月 ({currentMonth}) はライブの今日分を含む (オレンジ)。過去月は履歴データ。
            </p>
          )}
        </CardContent>
      </Card>

      {/* Row 3: category + hourly */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm">カテゴリ別売上</h3>
              <Badge live={false} />
            </div>
            <div className="space-y-2">
              {categoryData.map((c) => (
                <div key={c.category} className="space-y-0.5">
                  <div className="flex justify-between text-xs">
                    <span>{c.category}</span>
                    <span className="text-muted-foreground">{fmt(c.revenue)}</span>
                  </div>
                  <div className="h-3 rounded bg-muted">
                    <div
                      className="h-3 rounded"
                      style={{
                        width: `${(c.revenue / maxCategory) * 100}%`,
                        background: CHART_PRIMARY,
                        borderRadius: '0 4px 4px 0',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm">時間帯別注文分布</h3>
              <Badge live={false} />
            </div>
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourlyData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="0" stroke={CHART_TRACK} vertical={false} />
                  <XAxis dataKey="hour" tick={{ fontSize: 11, fill: CHART_TEXT }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: CHART_TEXT }} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(v) => [`${Number(v)}件`, '注文数']} cursor={{ fill: CHART_TRACK, opacity: 0.3 }} />
                  <Bar dataKey="orders" fill={CHART_PRIMARY} radius={[4, 4, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Row 4: store + popular */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm">店舗別売上</h3>
              <Badge live={false} />
            </div>
            <div className="space-y-2">
              {storeData.map((s) => (
                <div key={s.store} className="space-y-0.5">
                  <div className="flex justify-between text-xs">
                    <span className={s.isSelected ? 'font-semibold' : ''}>{s.store}</span>
                    <span className="text-muted-foreground">{fmt(s.revenue)}</span>
                  </div>
                  <div className="h-3 rounded bg-muted">
                    <div
                      className="h-3 rounded"
                      style={{
                        width: `${(s.revenue / Math.max(1, ...storeData.map((x) => x.revenue))) * 100}%`,
                        background: s.isSelected ? CHART_ACCENT : CHART_PRIMARY,
                        borderRadius: '0 4px 4px 0',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm">人気商品 Top 10</h3>
              <Badge live={false} />
              <div className="ml-auto flex gap-1">
                <Button
                  size="sm"
                  variant={popularMetric === 'revenue' ? 'default' : 'outline'}
                  className="h-8 text-xs"
                  onClick={() => setPopularMetric('revenue')}
                >
                  売上
                </Button>
                <Button
                  size="sm"
                  variant={popularMetric === 'qty' ? 'default' : 'outline'}
                  className="h-8 text-xs"
                  onClick={() => setPopularMetric('qty')}
                >
                  点数
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              {popularData.map((p) => {
                const val = popularMetric === 'revenue' ? p.revenue : p.qty;
                return (
                  <div key={p.item} className="space-y-0.5">
                    <div className="flex justify-between text-xs">
                      <span>{p.item}</span>
                      <span className="text-muted-foreground">
                        {popularMetric === 'revenue' ? fmt(p.revenue) : `${p.qty}点`}
                      </span>
                    </div>
                    <div className="h-3 rounded bg-muted">
                      <div
                        className="h-3 rounded"
                        style={{
                          width: `${(val / maxPopular) * 100}%`,
                          background: CHART_PRIMARY,
                          borderRadius: '0 4px 4px 0',
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
