import { useMemo } from 'react';
import { Card, CardContent } from '@databricks/appkit-ui/react';
import { fmtPrice } from '../../lib/api';

// world-atlas topojson (110m, lightweight) — vendored like every other dep
import worldData from 'world-atlas/countries-110m.json';

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

interface StoreGeo {
  store_id: string;
  store_name: string;
  country: string;
  lat: string;
  lon: string;
  revenue: string;
}

// equirectangular projection: lon/lat -> pixel in the viewBox
const W = 720;
const H = 360;
const px = (lon: number, lat: number) => ({
  x: ((lon + 180) / 360) * W,
  y: ((90 - lat) / 180) * H,
});

// GeoJSON polygon ring -> SVG path string
function ringToPath(ring: number[][]): string {
  return ring
    .map(([lon, lat], i) => {
      const p = px(lon, lat);
      return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(' ') + ' Z';
}

/** World map with revenue bubbles: topojson -> GeoJSON -> self-drawn SVG
 * (equirectangular). No react-simple-maps (React 19 peer conflict). */
export function StoreMap({ data, selectedStoreId }: { data: import('../../lib/api').HistorySummary; selectedStoreId: string }) {
  const countryPaths = useMemo(() => {
    // TopoJSON -> GeoJSON, self-implemented (world-atlas 110m structure is
    // simple: arcs are absolute lon/lat pairs, geometries reference them by
    // index; a negative index means reverse the arc).
    const topology = worldData as {
      arcs: [number, number][][];
      objects: {
        countries: {
          geometries: ({
            type: 'Polygon' | 'MultiPolygon';
            arcs: number[][] | number[][][];
            properties: { name: string };
          })[];
        };
      };
    };
    const arc = (idx: number): [number, number][] => {
      const a = topology.arcs[idx < 0 ? ~idx : idx];
      return idx < 0 ? [...a].reverse() : a;
    };
    const paths: string[] = [];
    for (const g of topology.objects.countries.geometries) {
      if (g.type === 'Polygon') {
        const rings = (g.arcs as number[][]).map((ring) => ring.flatMap(arc));
        paths.push(rings.map(ringToPath).join(' '));
      } else if (g.type === 'MultiPolygon') {
        const polys = (g.arcs as number[][][]).map((poly) => poly.map((ring) => ring.flatMap(arc)));
        paths.push(polys.map((rings) => rings.map(ringToPath).join(' ')).join(' '));
      }
    }
    return paths.filter(Boolean);
  }, []);

  const stores = useMemo(
    () =>
      (data?.store_geo ?? []).map((s: StoreGeo) => ({
        ...s,
        lat: Number(s.lat),
        lon: Number(s.lon),
        revenueNum: Number(s.revenue),
        isSelected: selectedStoreId !== '' && s.store_id === selectedStoreId,
      })),
    [data, selectedStoreId],
  );
  const maxRevenue = Math.max(1, ...stores.map((s) => s.revenueNum));

  return (
    <Card className="dash-enter dash-enter-3 border shadow-xs">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm">店舗別売上（世界）</h3>
          <SourceBadge live={false} />
        </div>
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label="世界地図">
            {countryPaths.map((d) => (
              <path
                key={d.slice(0, 60)}
                d={d}
                fill="var(--chart-track)"
                stroke="var(--background)"
                strokeWidth={0.5}
              />
            ))}
            {stores.map((s) => {
              const p = px(s.lon, s.lat);
              const r = 4 + Math.sqrt(s.revenueNum / maxRevenue) * 14;
              return (
                <g key={s.store_id}>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    fill={s.isSelected ? 'var(--chart-accent)' : 'var(--chart-primary)'}
                    fillOpacity={0.75}
                    stroke="var(--background)"
                    strokeWidth={1.5}
                  />
                  <title>{`${s.store_name}: ${fmtPrice(s.revenueNum, 'JPY')}`}</title>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {stores.slice(0, 6).map((s) => (
            <span key={s.store_id} className="inline-flex items-center gap-1">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: s.isSelected ? 'var(--chart-accent)' : 'var(--chart-primary)' }}
              />
              {s.store_name} {fmtPrice(s.revenueNum, 'JPY')}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
