import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, Button } from '@databricks/appkit-ui/react';
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { select } from 'd3-selection';
import 'd3-transition';
import { Plus, Minus, RotateCcw } from 'lucide-react';
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

interface ZoomState {
  x: number;
  y: number;
  k: number;
}

/** World map with revenue bubbles + d3-zoom pan/zoom/reset. The map and
 * bubbles live in a single <g> under the zoom transform; bubble radius is
 * screen-fixed (r / k) so zooming in doesn't blow them up. */
export function StoreMap({ data, selectedStoreId }: { data: import('../../lib/api').HistorySummary; selectedStoreId: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  // zoomState mirrors the d3 transform only at zoom end (not during), so
  // pan/zoom doesn't re-render React 60x/sec; d3 applies the transform
  // directly to the <g> element during the gesture.
  const [zoomState, setZoomState] = useState<ZoomState>({ x: 0, y: 0, k: 1 });

  const countryPaths = useMemo(() => {
    // TopoJSON -> GeoJSON, self-implemented (world-atlas 110m structure is
    // simple: arcs are delta-encoded quantized integers with a transform;
    // decode: cumulative sum, then scale+translate).
    const topology = worldData;
    const scale = topology.transform.scale;
    const translate = topology.transform.translate;
    const arc = (idx: number): [number, number][] => {
      const raw = topology.arcs[idx < 0 ? ~idx : idx];
      const pts: [number, number][] = [];
      let x = 0;
      let y = 0;
      for (const [dx, dy] of raw) {
        x += dx;
        y += dy;
        pts.push([x * scale[0] + translate[0], y * scale[1] + translate[1]]);
      }
      return idx < 0 ? pts.reverse() : pts;
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

  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const svg = select<SVGSVGElement, unknown>(svgRef.current);
    const g = select<SVGGElement, unknown>(gRef.current);
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 8])
      .translateExtent([
        [-W * 2, -H * 2],
        [W * 3, H * 3],
      ])
      .on('zoom', (event: { transform: ZoomTransform }) => {
        // d3 applies the transform directly — no React re-render mid-gesture
        g.attr('transform', event.transform.toString());
      })
      .on('end', (event: { transform: ZoomTransform }) => {
        // sync React state once, at gesture end
        setZoomState({ x: event.transform.x, y: event.transform.y, k: event.transform.k });
      });
    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior);
    return () => {
      svg.on('.zoom', null);
    };
  }, []);

  const zoomBy = (factor: number) => {
    if (!svgRef.current || !zoomRef.current) return;
    const svg = select<SVGSVGElement, unknown>(svgRef.current);
    const zb = zoomRef.current;
    // scaleBy keeps the viewport center fixed — pan position is preserved
    svg.transition().duration(300).call((sel) => zb.scaleBy(sel as never, factor));
  };
  const zoomIn = () => zoomBy(Math.SQRT2);
  const zoomOut = () => zoomBy(1 / Math.SQRT2);
  const reset = () => {
    if (!svgRef.current || !zoomRef.current) return;
    const svg = select<SVGSVGElement, unknown>(svgRef.current);
    const zb = zoomRef.current;
    svg.transition().duration(300).call((sel) => zb.transform(sel as never, zoomIdentity));
  };

  return (
    <Card className="dash-enter dash-enter-3 border shadow-xs">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm">店舗別売上（世界）</h3>
          <SourceBadge live={false} />
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={zoomOut} title="縮小">
              <Minus className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={zoomIn} title="拡大">
              <Plus className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={reset} title="リセット">
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="relative overflow-hidden rounded-md border bg-muted/20">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full cursor-grab active:cursor-grabbing"
            style={{ touchAction: 'none' }}
            aria-label="世界地図"
          >
            {/* d3 owns this transform during gestures; React only sets the
                initial identity and re-syncs at zoom end via zoomState */}
            <g ref={gRef} transform={`translate(${zoomState.x},${zoomState.y}) scale(${zoomState.k})`}>
              {countryPaths.map((d) => (
                <path
                  key={d.slice(0, 60)}
                  d={d}
                  fill="var(--chart-land)"
                  stroke="var(--chart-land-stroke)"
                  strokeWidth={0.5 / zoomState.k}
                />
              ))}
              {stores.map((s) => {
                const p = px(s.lon, s.lat);
                // screen-fixed radius: divide by zoom so the bubble doesn't
                // blow up when zooming in (design decision: readable at all
                // zoom levels; a geographic-radius bubble would dominate).
                const r = (4 + Math.sqrt(s.revenueNum / maxRevenue) * 14) / zoomState.k;
                return (
                  <g key={s.store_id}>
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={r}
                      fill={s.isSelected ? 'var(--chart-accent)' : 'var(--chart-primary)'}
                      fillOpacity={0.75}
                      stroke="var(--background)"
                      strokeWidth={1.5 / zoomState.k}
                    />
                    <title>{`${s.store_name}: ${fmtPrice(s.revenueNum, 'JPY')}`}</title>
                  </g>
                );
              })}
            </g>
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
