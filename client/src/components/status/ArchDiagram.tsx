/**
 * Native-SVG architecture diagram for the status page. Theme-aware via CSS
 * variables (light/dark both work); elbow arrows with flow labels; two
 * layout variants — horizontal on >=sm, vertical stack on phones.
 */

interface NodeDef {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  accent?: boolean;
}

function Node({ x, y, w, h, title, sub, accent }: NodeDef) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        fill="var(--background)"
        stroke={accent ? 'var(--chart-primary)' : 'var(--border)'}
        strokeWidth={accent ? 1.5 : 1}
      />
      <text x={x + w / 2} y={y + h / 2 - 6} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--foreground)">
        {title}
      </text>
      <text x={x + w / 2} y={y + h / 2 + 12} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)">
        {sub}
      </text>
    </g>
  );
}

function Zone({ x, y, w, h, label }: { x: number; y: number; w: number; h: number; label: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={14} fill="var(--muted)" fillOpacity={0.35} stroke="var(--border)" strokeOpacity={0.5} />
      <text x={x + 10} y={y + 16} fontSize={9} fontWeight={600} letterSpacing="0.06em" fill="var(--muted-foreground)">
        {label}
      </text>
    </g>
  );
}

function ArrowH({ x1, x2, y, label }: { x1: number; x2: number; y: number; label?: string }) {
  const mid = (x1 + x2) / 2;
  return (
    <g>
      <path d={`M${x1},${y} L${x2 - 6},${y}`} stroke="var(--muted-foreground)" strokeWidth={1.2} fill="none" />
      <path d={`M${x2 - 6},${y - 3.5} L${x2},${y} L${x2 - 6},${y + 3.5} Z`} fill="var(--muted-foreground)" />
      {label && (
        <text x={mid} y={y - 6} textAnchor="middle" fontSize={9} fill="var(--muted-foreground)">
          {label}
        </text>
      )}
    </g>
  );
}

function ArrowV({ y1, y2, x, label }: { y1: number; y2: number; x: number; label?: string }) {
  return (
    <g>
      <path d={`M${x},${y1} L${x},${y2 - 6}`} stroke="var(--muted-foreground)" strokeWidth={1.2} fill="none" />
      <path d={`M${x - 3.5},${y2 - 6} L${x},${y2} L${x + 3.5},${y2 - 6} Z`} fill="var(--muted-foreground)" />
      {label && (
        <text x={x + 6} y={(y1 + y2) / 2 + 3} fontSize={9} fill="var(--muted-foreground)">
          {label}
        </text>
      )}
    </g>
  );
}

/** Horizontal layout (sm and up): client | app | data zones, elbow arrow
 * down from UC Delta to Genie. */
function Horizontal() {
  return (
    <svg viewBox="0 0 720 240" className="w-full" role="img" aria-label="アーキテクチャ構成図">
      <Zone x={8} y={26} w={150} h={200} label="CLIENT" />
      <Zone x={166} y={26} w={188} h={200} label="APP" />
      <Zone x={362} y={26} w={350} h={200} label="DATA" />

      <Node x={26} y={92} w={114} h={56} title="ブラウザ" sub="React SPA" />
      <Node x={186} y={84} w={148} h={72} title="Databricks App" sub="Express + バリスタ (on-app)" accent />
      <Node x={384} y={92} w={96} h={56} title="Lakebase" sub="OLTP / OBO+RLS" accent />
      <Node x={506} y={92} w={92} h={56} title="Lakehouse" sub="Sync (CDC)" />
      <Node x={624} y={92} w={80} h={56} title="UC Delta" sub="最新状態ビュー" />
      <Node x={624} y={180} w={80} h={40} title="Genie" sub="自然言語分析" />

      <ArrowH x1={140} x2={186} y={112} label="HTTPS" />
      <ArrowH x1={334} x2={384} y={112} label="OBO+RLS" />
      <ArrowH x1={480} x2={506} y={112} label="WAL" />
      <ArrowH x1={598} x2={624} y={112} label="複製" />
      {/* elbow: Delta bottom -> Genie top */}
      <path d="M664,148 L664,172" stroke="var(--muted-foreground)" strokeWidth={1.2} fill="none" />
      <path d="M660.5,172 L664,178 L667.5,172 Z" fill="var(--muted-foreground)" />
      <text x={672} y={164} fontSize={9} fill="var(--muted-foreground)">分析</text>
    </svg>
  );
}

/** Vertical layout (phones): zones stacked top to bottom. */
function Vertical() {
  return (
    <svg viewBox="0 0 320 560" className="w-full" role="img" aria-label="アーキテクチャ構成図">
      <Zone x={10} y={8} w={300} h={96} label="CLIENT" />
      <Zone x={10} y={116} w={300} h={128} label="APP" />
      <Zone x={10} y={256} w={300} h={296} label="DATA" />

      <Node x={95} y={32} w={130} h={56} title="ブラウザ" sub="React SPA" />
      <Node x={85} y={132} w={150} h={72} title="Databricks App" sub="Express + バリスタ (on-app)" accent />
      <Node x={95} y={272} w={130} h={56} title="Lakebase" sub="OLTP / OBO+RLS" accent />
      <Node x={95} y={352} w={130} h={56} title="Lakehouse Sync" sub="CDC" />
      <Node x={95} y={432} w={130} h={56} title="UC Delta" sub="最新状態ビュー" />
      <Node x={95} y={500} w={130} h={44} title="Genie" sub="自然言語分析" />

      <ArrowV y1={88} y2={132} x={160} label="HTTPS" />
      <ArrowV y1={204} y2={272} x={160} label="OBO+RLS" />
      <ArrowV y1={328} y2={352} x={160} label="WAL" />
      <ArrowV y1={408} y2={432} x={160} label="複製" />
      <ArrowV y1={488} y2={500} x={160} />
    </svg>
  );
}

export function ArchDiagram() {
  return (
    <>
      <div className="hidden sm:block">
        <Horizontal />
      </div>
      <div className="sm:hidden max-w-[340px]">
        <Vertical />
      </div>
    </>
  );
}
