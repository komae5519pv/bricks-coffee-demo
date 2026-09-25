import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent } from '@databricks/appkit-ui/react';
import { BarChart3, ShoppingBag, Wallet } from 'lucide-react';
import { api, fmtPrice, type HistorySummary, type Store } from '../lib/api';

/** Sales & history analytics - served straight from Lakebase (no SQL warehouse). */
export function HistoryPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [data, setData] = useState<HistorySummary | null>(null);

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

  const maxQty = Math.max(1, ...(data?.popular.map((p) => Number(p.qty)) ?? [1]));
  const maxOrders = Math.max(1, ...(data?.monthly.map((m) => Number(m.orders)) ?? [1]));

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

      <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <ShoppingBag className="h-8 w-8 text-muted-foreground" />
            <div>
              <div className="text-2xl font-bold">{data?.today_orders ?? '-'}</div>
              <div className="text-xs text-muted-foreground">今日の注文数(ライブ / Lakebase)</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Wallet className="h-8 w-8 text-muted-foreground" />
            <div>
              <div className="text-2xl font-bold">
                {data?.today_currency ? fmtPrice(data.today_revenue, data.today_currency) : '-'}
              </div>
              <div className="text-xs text-muted-foreground">今日の売上(ライブ / Lakebase)</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="font-medium text-sm">人気商品 Top 10(過去データ)</h3>
            {(data?.popular ?? []).map((p) => (
              <div key={p.item_name} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span>{p.item_name}</span>
                  <span className="text-muted-foreground">{p.qty} 点</span>
                </div>
                <div className="h-2 rounded bg-muted">
                  <div
                    className="h-2 rounded bg-primary"
                    style={{ width: `${(Number(p.qty) / maxQty) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="font-medium text-sm">月別注文数(過去データ)</h3>
            {(data?.monthly ?? []).map((m) => (
              <div key={m.month} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="font-mono">{m.month}</span>
                  <span className="text-muted-foreground">{m.orders} 件</span>
                </div>
                <div className="h-2 rounded bg-muted">
                  <div
                    className="h-2 rounded bg-primary/70"
                    style={{ width: `${(Number(m.orders) / maxOrders) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
