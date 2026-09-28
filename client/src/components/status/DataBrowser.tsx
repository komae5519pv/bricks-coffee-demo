import { Fragment, useCallback, useEffect, useState } from 'react';
import { Button, Card, CardContent, Input } from '@databricks/appkit-ui/react';
import { RefreshCw, Search, Table2 } from 'lucide-react';
import { api, type BrowseResult } from '../../lib/api';

/** Safe cell text: primitives as-is, objects/arrays as compact JSON. */
function cellText(v: unknown): string {
  if (v == null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Data browser for the status page: on-demand, read-only table inspection.
 * Delta fetches happen ONLY on explicit user action (no polling, no
 * auto-refresh — warehouse cost discipline). Lakebase tables are cheap but
 * follow the same click-to-load flow for a uniform mental model. */
export function DataBrowser() {
  const [tables, setTables] = useState<{ key: string; source: string; label: string }[]>([]);
  const [tableKey, setTableKey] = useState('lakebase:orders');
  const [q, setQ] = useState('');
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    api.browseTables().then((d) => setTables(d.tables)).catch(() => setTables([]));
  }, []);

  const load = useCallback(
    (offset: number, replace: boolean) => {
      setLoading(true);
      setError(null);
      api
        .browse(tableKey, { limit: 50, offset, q: q || undefined })
        .then((r) => {
          setResult((prev) =>
            replace || !prev || prev.table !== r.table
              ? r
              : { ...r, rows: [...prev.rows, ...r.rows], offset: r.offset },
          );
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
          if (replace) setResult(null);
        })
        .finally(() => setLoading(false));
    },
    [tableKey, q],
  );

  const def = tables.find((t) => t.key === tableKey);

  return (
    <Card className="dash-enter rounded-2xl border shadow-xs">
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-medium text-sm flex items-center gap-2">
            <Table2 className="h-4 w-4" /> データブラウザ
          </h3>
          <span className="text-xs text-muted-foreground">ボタン押下時のみ取得（ポーリングなし）</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            data-browse-table-select
            className="h-11 sm:h-9 max-w-full rounded-md border bg-background px-3 text-sm"
            value={tableKey}
            onChange={(e) => {
              setTableKey(e.target.value);
              setResult(null);
              setError(null);
              setExpanded(null);
            }}
          >
            <optgroup label="Lakebase（生テーブル）">
              {tables.filter((t) => t.source === 'lakebase').map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </optgroup>
            <optgroup label="Delta（同期テーブル）">
              {tables.filter((t) => t.source === 'delta').map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </optgroup>
          </select>
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              data-browse-filter
              className="pl-8 h-11 sm:h-9"
              placeholder="テキストフィルタ（部分一致）"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') load(0, true);
              }}
            />
          </div>
          <Button
            data-browse-load
            size="sm"
            className="h-11 sm:h-9"
            disabled={loading}
            onClick={() => load(0, true)}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            {result ? '再取得' : '読み込む'}
          </Button>
        </div>

        {def && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span
              data-browse-source-badge
              className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${
                def.source === 'lakebase' ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-border bg-muted text-muted-foreground'
              }`}
            >
              {def.source === 'lakebase' ? 'Lakebase の生テーブル' : 'Delta の同期テーブル'}
            </span>
            <span>{result?.scopeNote}</span>
            {result && (
              <span className="ml-auto tabular-nums">
                {new Date(result.fetchedAt).toLocaleTimeString('ja-JP', { hour12: false })} 取得
              </span>
            )}
          </div>
        )}

        {error && <div className="text-sm text-destructive">{error}</div>}

        {result && result.rows.length === 0 && !loading && (
          <div className="text-sm text-muted-foreground">0件（スコープまたはフィルタに一致する行がありません）</div>
        )}

        {result && result.rows.length > 0 && (
          <>
            <div className="overflow-x-auto rounded-md border" data-browse-table>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50">
                    {result.columns.slice(0, 8).map((c) => (
                      <th key={c} className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                    {result.columns.length > 8 && (
                      <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">…</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <Fragment key={`${result.offset}-${cellText(row[result.columns[0]]).slice(0, 40)}`}>
                      <tr
                        data-browse-row
                        className={`border-b last:border-0 cursor-pointer hover:bg-muted/30 ${expanded === i ? 'bg-muted/40' : ''}`}
                        onClick={() => setExpanded(expanded === i ? null : i)}
                      >
                        {result.columns.slice(0, 8).map((c) => (
                          <td key={c} className="px-2 py-1.5 max-w-[220px] truncate tabular-nums" title={cellText(row[c])}>
                            {row[c] == null ? <span className="text-muted-foreground">null</span> : cellText(row[c])}
                          </td>
                        ))}
                        {result.columns.length > 8 && <td className="px-2 py-1.5 text-muted-foreground">…</td>}
                      </tr>
                      {expanded === i && (
                        <tr>
                          <td colSpan={result.columns.length > 8 ? 9 : result.columns.length} className="bg-muted/30 px-3 py-2">
                            <pre className="text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
                              {JSON.stringify(row, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{result.rows.length}行表示（offset {result.offset}）</span>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs ml-auto"
                disabled={loading || result.rows.length % 50 !== 0}
                onClick={() => load(result.offset + 50, false)}
              >
                さらに読み込む
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
