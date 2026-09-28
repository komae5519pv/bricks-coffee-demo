import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, Button } from '@databricks/appkit-ui/react';
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { select } from 'd3-selection';
import 'd3-transition';
import { Plus, Minus, RotateCcw } from 'lucide-react';
import { fmtPrice } from '../../lib/api';
import { TooltipCard, SourceBadge } from './chart-parts';

// world-atlas topojson (110m, lightweight) — vendored like every other dep
import worldData from 'world-atlas/countries-110m.json';

interface StoreGeo {
  store_id: string;
  store_name: string;
  country: string;
  lat: string;
  lon: string;
  revenue: string;
  orders: string;
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
  return (
    ring
      .map(([lon, lat], i) => {
        const p = px(lon, lat);
        return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      })
      .join(' ') + ' Z'
  );
}

interface ZoomState {
  x: number;
  y: number;
  k: number;
}

interface TipState {
  id: string;
  x: number;
  y: number;
}

/** World map with revenue bubbles + d3-zoom pan/zoom/reset. No legend —
 * bubble hover (desktop) / tap (touch) opens the shared TooltipCard with
 * store details. Zoom/pan gestures suppress and clear tooltips. */
export function StoreMap({ data, selectedStoreId }: { data: import('../../lib/api').HistorySummary; selectedStoreId: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  // Suppress tooltips while a pan/pinch is in flight (drag vs hover conflict).
  const draggingRef = useRef(false);
  const hoverCapable = useRef(false);
  const [zoomState, setZoomState] = useState<ZoomState>({ x: 0, y: 0, k: 1 });
  const [hoverTip, setHoverTip] = useState<TipState | null>(null);
  const [pinnedTip, setPinnedTip] = useState<TipState | null>(null);
  const activeTip = pinnedTip ?? hoverTip;

  useEffect(() => {
    hoverCapable.current = window.matchMedia('(hover: hover)').matches;
  }, []);

  const countryPaths = useMemo(() => {
    // TopoJSON arcs are delta-encoded quantized integers with a transform;
    // decode: cumulative sum, then scale+translate.
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
        ordersNum: Number(s.orders),
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
      .on('start', () => {
        // A pan/zoom gesture begins: tooltips would chase a moving bubble —
        // suppress and clear them.
        draggingRef.current = true;
        setHoverTip(null);
        setPinnedTip(null);
      })
      .on('zoom', (event: { transform: ZoomTransform }) => {
        // d3 applies the transform directly — no React re-render mid-gesture
        g.attr('transform', event.transform.toString());
      })
      .on('end', (event: { transform: ZoomTransform }) => {
        draggingRef.current = false;
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

  // Tooltip position from the bubble's CURRENT on-screen rect (relative to
  // the wrapper) — correct at any zoom/pan, no manual transform math.
  const tipFor = (el: Element, id: string): TipState | null => {
    if (draggingRef.current) return null;
    const rect = el.getBoundingClientRect();
    const wrap = wrapperRef.current?.getBoundingClientRect();
    if (!wrap) return null;
    return { id, x: rect.left - wrap.left + rect.width / 2, y: rect.top - wrap.top };
  };

  // Escape dismisses a pinned (tap) tooltip from anywhere; existing exits
  // (same-bubble tap, zoom gesture) are unchanged.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPinnedTip(null);
        setHoverTip(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const tipStore = activeTip ? stores.find((s) => s.store_id === activeTip.id) : null;

  return (
    <Card className="dash-enter dash-enter-3 rounded-2xl border shadow-xs">
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
        <div ref={wrapperRef} className="relative overflow-hidden rounded-md border bg-muted/20">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full cursor-grab active:cursor-grabbing"
            style={{ touchAction: 'none' }}
            aria-label="世界地図"
            // background click/tap (land or ocean, not a bubble — bubbles
            // stopPropagation) dismisses a pinned tooltip
            onClick={() => setPinnedTip(null)}
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
                const base = 4 + Math.sqrt(s.revenueNum / maxRevenue) * 14;
                const emphasized = activeTip?.id === s.store_id;
                const r = (emphasized ? base * 1.2 : base) / zoomState.k;
                return (
                  <g key={s.store_id}>
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={r}
                      data-store-bubble={s.store_id}
                      fill={s.isSelected ? 'var(--chart-accent)' : 'var(--chart-primary)'}
                      fillOpacity={activeTip && !emphasized ? 0.35 : 0.75}
                      stroke="var(--background)"
                      strokeWidth={(emphasized ? 2.5 : 1.5) / zoomState.k}
                      style={{ cursor: 'pointer' }}
                      tabIndex={0}
                      aria-label={`${s.store_name}: 売上 ${fmtPrice(s.revenueNum, 'JPY')}、注文数 ${s.ordersNum.toLocaleString()}件`}
                      onMouseEnter={(e) => {
                        if (hoverCapable.current) {
                          const t = tipFor(e.currentTarget, s.store_id);
                          if (t) setHoverTip(t);
                        }
                      }}
                      onMouseLeave={() => setHoverTip(null)}
                      // keyboard: focus shows the same tooltip as hover;
                      // blur/Escape close it (Escape handled globally)
                      onFocus={(e) => {
                        const t = tipFor(e.currentTarget, s.store_id);
                        if (t) setHoverTip(t);
                      }}
                      onBlur={() => setHoverTip(null)}
                      onClick={(e) => {
                        e.stopPropagation(); // keep background-click dismissal working
                        const t = tipFor(e.currentTarget, s.store_id);
                        if (t) setPinnedTip((prev) => (prev?.id === s.store_id ? null : t));
                      }}
                    />
                  </g>
                );
              })}
            </g>
          </svg>
          {activeTip && tipStore && (
            <div
              data-map-tooltip
              className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap"
              style={{ left: activeTip.x, top: activeTip.y - 6 }}
            >
              <TooltipCard
                title={tipStore.store_name}
                rows={[
                  { label: '国', value: tipStore.country },
                  { label: '売上', value: fmtPrice(tipStore.revenueNum, 'JPY'), color: tipStore.isSelected ? 'var(--chart-accent)' : 'var(--chart-primary)' },
                  { label: '注文数', value: `${tipStore.ordersNum.toLocaleString()}件` },
                ]}
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
