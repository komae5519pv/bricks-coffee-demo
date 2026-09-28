import { useMemo, useState } from 'react';
import { Card, CardContent } from '@databricks/appkit-ui/react';
import { TooltipCard, SourceBadge } from './chart-parts';

const DAYS = ['日', '月', '火', '水', '木', '金', '土'];
const HOURS = Array.from({ length: 13 }, (_, i) => i + 7); // 7-19

/** Weekday x hour heatmap (UTC). Single-hue sequential ramp (thin→thick),
 * hover shows the value in a card tooltip. */
export function WeekdayHeatmap({ data }: { data: import('../../lib/api').HistorySummary }) {
  const [hover, setHover] = useState<{ dow: number; hour: number; orders: number } | null>(null);

  const { grid, max } = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of data?.heatmap ?? []) {
      map.set(`${h.dow}-${h.hour}`, Number(h.orders));
    }
    const grid = DAYS.map((_, dow) => HOURS.map((hour) => map.get(`${dow}-${hour}`) ?? 0));
    const max = grid.flat().reduce((m, v) => Math.max(m, v), 0);
    return { grid, max };
  }, [data]);

  return (
    <Card className="dash-enter dash-enter-4 rounded-2xl border shadow-xs">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm">曜日×時間帯の注文分布 (UTC)</h3>
          <SourceBadge live={false} />
        </div>
        <div className="relative">
          <div className="grid gap-0.5" style={{ gridTemplateColumns: `auto repeat(${HOURS.length}, 1fr)` }}>
            <div />
            {HOURS.map((h) => (
              <div key={h} className="text-center text-[10px] text-muted-foreground tabular-nums">
                {h}
              </div>
            ))}
            {grid.map((row, dow) => (
              <div key={`row-${DAYS[dow]}`} className="contents">
                <div className="flex items-center justify-end pr-2 text-xs text-muted-foreground">
                  {DAYS[dow]}
                </div>
                {row.map((orders, hourIdx) => {
                  const intensity = max > 0 ? orders / max : 0;
                  return (
                    <div
                      key={`${DAYS[dow]}-${HOURS[hourIdx]}`}
                      className="aspect-square rounded-sm transition-transform duration-150 hover:scale-110 hover:z-10 relative"
                      style={{
                        background: `color-mix(in srgb, var(--chart-primary) ${Math.round(intensity * 100)}%, var(--chart-track))`,
                      }}
                      onMouseEnter={() => setHover({ dow, hour: HOURS[hourIdx], orders })}
                      onMouseLeave={() => setHover(null)}
                    >
                      {hover?.dow === dow && hover?.hour === HOURS[hourIdx] && (
                        <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 -translate-x-1/2 whitespace-nowrap">
                          <TooltipCard title={`${DAYS[dow]}曜 ${HOURS[hourIdx]}時 (UTC)`} rows={[{ label: '注文数', value: `${orders}件` }]} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>少</span>
          <div className="flex-1 h-2 rounded" style={{ background: 'linear-gradient(to right, var(--chart-track), var(--chart-primary))' }} />
          <span>多</span>
          <span className="ml-2 tabular-nums">最大 {max}件</span>
        </div>
      </CardContent>
    </Card>
  );
}
