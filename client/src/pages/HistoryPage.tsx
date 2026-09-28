import { useCallback, useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { api, type HistorySummary, type Store } from '../lib/api';
import { KpiTiles } from '../components/history/KpiTiles';
import { TrendChart } from '../components/history/TrendChart';
import { CategoryDonut } from '../components/history/CategoryDonut';
import { StoreMap } from '../components/history/StoreMap';
import { MenuBubble } from '../components/history/MenuBubble';
import { WeekdayHeatmap } from '../components/history/WeekdayHeatmap';
import { RankingBars } from '../components/history/RankingBars';

/** Sales & history analytics dashboard v3: live KPIs + 7 chart forms
 * (sparkline tiles, area trend, world map, donut, menu bubble, heatmap,
 * ranking bars) — craft rules applied throughout. */
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

  return (
    // 3-layer material in the light theme: the page area carries a very
    // light gray tint (bg-muted/25) so white cards float above it, and
    // sunken elements (bg-muted) sit one step below. Light cleanliness is
    // preserved — this is a tint, not a dark theme.
    <div data-history-page className="-m-4 md:-m-6 min-h-[calc(100vh-3.5rem)] bg-muted/25 p-4 md:p-6 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold flex items-center gap-2 whitespace-nowrap tracking-tight">
          <BarChart3 className="h-5 w-5" /> 売上・履歴
        </h2>
        <select
          className="h-11 sm:h-11 max-w-full rounded-md border bg-background px-3 text-sm"
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

      {data && (
        <>
          {/* Row 1: KPI tiles with sparklines */}
          <KpiTiles data={data} />

          {/* Row 2: monthly trend (area) */}
          <TrendChart data={data} />

          {/* Row 3: world map + category donut */}
          <div className="grid gap-6 lg:grid-cols-2">
            <StoreMap data={data} selectedStoreId={storeId} />
            <CategoryDonut data={data} />
          </div>

          {/* Row 4: menu bubble + weekday heatmap */}
          <div className="grid gap-6 lg:grid-cols-2">
            <MenuBubble data={data} />
            <WeekdayHeatmap data={data} />
          </div>

          {/* Row 5: store ranking + popular items */}
          <RankingBars data={data} storeId={storeId} />
        </>
      )}
      {!data && (
        <div className="text-sm text-muted-foreground">読み込み中…</div>
      )}
    </div>
  );
}
