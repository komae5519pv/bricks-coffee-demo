import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Card, CardContent } from '@databricks/appkit-ui/react';
import { Activity, ArrowRight, Bot, CheckCircle2, Database, KeyRound, ListOrdered, RefreshCw, Sparkles, Timer } from 'lucide-react';
import { api, fmtPrice, type OrderEvent, type StatusResponse } from '../lib/api';
import { fmtAgo, useNow } from '../lib/use-now';

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`min-w-0 text-right break-all ${mono ? 'font-mono text-xs' : ''}`}>{value ?? '-'}</span>
    </div>
  );
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
        ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-green-600' : 'bg-red-600'}`} />
      {label}
    </span>
  );
}

/** Architecture / runtime status page shown during the demo. */
export function StatusPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const load = useCallback(() => {
    api
      .status()
      .then((d) => {
        setData(d);
        setError(null);
        setRefreshedAt(new Date());
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  // Live order event log: app write -> Lakebase commit -> Delta reflect.
  // Polled faster than the rest of the page (4s); the server keeps quiet
  // polls cheap (warehouse is re-queried only while the newest ids are
  // unsynced).
  const [events, setEvents] = useState<OrderEvent[] | null>(null);
  useEffect(() => {
    const loadEvents = () => {
      api
        .orderEvents()
        .then((d) => setEvents(d.events))
        .catch(() => undefined);
    };
    loadEvents();
    const t = setInterval(loadEvents, 4000);
    return () => clearInterval(t);
  }, []);

  const now = useNow(1000);
  const [params] = useSearchParams();
  const focusOrder = params.get('order');
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (scrolledRef.current || !focusOrder || !events?.some((e) => e.id === focusOrder)) return;
    scrolledRef.current = true;
    document.querySelector(`[data-order-event="${CSS.escape(focusOrder)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [events, focusOrder]);

  const lag = data?.delta_sync?.lag_seconds;
  const latest = events?.[0] ?? null;
  const latestSyncedLag = events?.find((e) => e.lag_seconds != null)?.lag_seconds ?? null;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Activity className="h-5 w-5" /> アーキテクチャ & ステータス
        </h2>
        <button
          onClick={load}
          className="ml-auto inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-4 w-4" /> 更新
        </button>
        {refreshedAt && (
          <span className="text-xs text-muted-foreground">{refreshedAt.toLocaleTimeString()} 取得 (10秒ごと自動更新)</span>
        )}
      </div>
      {error && <div className="text-sm text-red-600">ステータス取得に失敗: {error}</div>}

      {/* Architecture flow */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-medium text-sm">アーキテクチャ</h3>
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-stretch gap-2 text-xs">
            {[
              { title: 'ブラウザ', sub: 'React SPA' },
              { title: 'Databricks App', sub: 'Express + バリスタエージェント (on-app)' },
              { title: 'Lakebase', sub: 'OLTP / OBO + RLS' },
              { title: 'Lakehouse Sync', sub: 'CDC (Beta)' },
              { title: 'UC Delta', sub: 'lb_*_history → ビュー' },
              { title: 'Genie', sub: '自然言語分析' },
            ].map((n, i, arr) => (
              <div key={n.title} className="flex items-center gap-2">
                <div className="rounded-md border bg-muted/40 px-3 py-2">
                  <div className="font-semibold">{n.title}</div>
                  <div className="text-muted-foreground">{n.sub}</div>
                </div>
                {i < arr.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 rotate-90 sm:rotate-0" />}
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            注文は Lakebase に OBO (ユーザー本人の権限) で書き込まれ、CDC で数秒後に Unity Catalog の Delta
            テーブルへ複製されます。Genie はその Delta テーブル(最新状態ビュー)を参照して分析・提案を行います。
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Agent status */}
        <Card>
          <CardContent className="p-4 space-y-1">
            <h3 className="font-medium text-sm flex items-center gap-2 pb-2">
              <Bot className="h-4 w-4" /> エージェント稼働状態
              <span className="ml-auto">{data && <Badge ok label="稼働中" />}</span>
            </h3>
            <Row label="エージェント" value={data?.agent.name} />
            <Row label="ホスト形態" value={data?.agent.hosting} />
            <Row label="LLM エンドポイント" value={data?.agent.model_endpoint} mono />
            <Row label="埋め込みエンドポイント" value={data?.agent.embedding_endpoint} mono />
            <Row label="トレーシング" value={data?.agent.tracing} />
            <Row label="ツール" value={data?.agent.tools.join(', ')} mono />
          </CardContent>
        </Card>

        {/* OBO token */}
        <Card>
          <CardContent className="p-4 space-y-1">
            <h3 className="font-medium text-sm flex items-center gap-2 pb-2">
              <KeyRound className="h-4 w-4" /> OBO トークン (このリクエストの実物)
              <span className="ml-auto">
                {data && <Badge ok={data.obo.token_present} label={data.obo.token_present ? 'OBO 有効' : 'トークン無し'} />}
              </span>
            </h3>
            <Row label="x-forwarded-user" value={data?.obo.forwarded_user} mono />
            <Row label="x-forwarded-email" value={data?.obo.forwarded_email} mono />
            {data?.obo.token_claims ? (
              <div className="mt-2 rounded-md bg-muted/40 p-2">
                <div className="text-xs text-muted-foreground pb-1">JWT クレーム (値はマスク表示)</div>
                <pre className="text-xs font-mono overflow-x-auto">{JSON.stringify(data.obo.token_claims, null, 2)}</pre>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground pt-1">クレームをデコードできません (ローカル開発時はトークンが注入されません)</div>
            )}
          </CardContent>
        </Card>

        {/* Lakebase */}
        <Card>
          <CardContent className="p-4 space-y-1">
            <h3 className="font-medium text-sm flex items-center gap-2 pb-2">
              <Database className="h-4 w-4" /> Lakebase (書き込み側)
              <span className="ml-auto">{data && <Badge ok={data.lakebase.ok} label={data.lakebase.ok ? '接続中' : 'エラー'} />}</span>
            </h3>
            {data?.lakebase.error && <div className="text-xs text-red-600">{data.lakebase.error}</div>}
            <Row label="PostgreSQL" value={data?.lakebase.server_version?.split(' ').slice(0, 2).join(' ')} />
            <Row label="DB 時刻" value={data?.lakebase.db_now} mono />
            <Row label="注文総数" value={data?.lakebase.orders_count} mono />
            <Row
              label="最新注文"
              value={
                data?.lakebase.latest_order
                  ? `${data.lakebase.latest_order.created_at} (${data.lakebase.latest_order.channel})`
                  : 'まだ注文なし'
              }
              mono
            />
            <Row label="Lakebase プロジェクト" value={data?.config.lakebase_project} mono />
            <Row
              label="CDC 対象テーブル"
              value={
                data?.lakebase.wal2delta_tables
                  ? `${data.lakebase.wal2delta_tables.length} テーブル (wal2delta)`
                  : 'Lakehouse Sync 未有効化'
              }
            />
          </CardContent>
        </Card>

        {/* Delta sync */}
        <Card>
          <CardContent className="p-4 space-y-1">
            <h3 className="font-medium text-sm flex items-center gap-2 pb-2">
              <Sparkles className="h-4 w-4" /> Delta 同期状態 (読み出し側)
              <span className="ml-auto">
                {data && <Badge ok={data.delta_sync.ok} label={data.delta_sync.ok ? '同期中' : '未設定/エラー'} />}
              </span>
            </h3>
            {data?.delta_sync.error && <div className="text-xs text-red-600 break-all">{data.delta_sync.error}</div>}
            <Row label="Delta テーブル" value={data ? `${data.delta_sync.catalog}.${data.delta_sync.schema}.lb_orders_history` : null} mono />
            <Row label="変更イベント総数" value={data?.delta_sync.lb_orders_history_rows} mono />
            <Row label="Delta 側 最新注文時刻" value={data?.delta_sync.delta_last_order_created_at ?? 'まだ無し'} mono />
            <Row label="Delta 側 最終同期時刻" value={data?.delta_sync.delta_last_change_at ?? 'まだ無し'} mono />
            <div className="mt-2 rounded-md bg-muted/40 p-3 text-center">
              <div className="text-xs text-muted-foreground">
                Lakebase → Delta レプリケーション遅延 (最新変更の実測: 反映時刻 − コミット時刻)
              </div>
              <div className="text-3xl font-bold">
                {lag === null || lag === undefined ? '-' : lag < 1 ? lag.toFixed(3) : lag.toFixed(1)}
                {lag !== null && lag !== undefined && <span className="text-base font-normal"> 秒</span>}
              </div>
            </div>
            <Row label="SQL ウェアハウス" value={data?.config.warehouse_id} mono />
          </CardContent>
        </Card>
      </div>

      {/* Genie */}
      <Card>
        <CardContent className="p-4 space-y-1">
          <h3 className="font-medium text-sm pb-2">Genie スペース (同期済み Delta を分析)</h3>
          <Row label="スペース ID" value={data?.config.genie_space_id ?? '未作成'} mono />
          {data?.config.genie_space_url && (
            <div className="pt-1">
              <a href={data.config.genie_space_url} target="_blank" rel="noreferrer" className="text-sm text-primary underline">
                Genie スペースを開く
              </a>
            </div>
          )}
          <Row label="カタログ / スキーマ" value={data ? `${data.config.catalog}.${data.config.schema}` : null} mono />
        </CardContent>
      </Card>

      {/* Live order event log: the Lakebase realtime story, per order. */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-medium text-sm flex items-center gap-2">
            <ListOrdered className="h-4 w-4" /> 注文イベントログ (書込み → Lakebase コミット → Delta 反映)
            <span className="ml-auto text-xs font-normal text-muted-foreground">4秒ごと自動更新</span>
          </h3>

          <div data-live-ticker className="rounded-md bg-muted/40 p-3 flex items-center gap-3">
            <Timer className="h-5 w-5 text-primary shrink-0" />
            <div>
              <div className="text-sm font-semibold">
                {latest == null
                  ? 'まだ注文イベントがありません'
                  : latest.sync_stalled
                    ? 'CDC 同期が遅れています (最後の注文が5分以上 Delta に未反映)'
                    : latest.lag_seconds != null
                      ? `最後の注文が Delta に反映: ${latest.lag_seconds < 1 ? latest.lag_seconds.toFixed(3) : latest.lag_seconds.toFixed(1)}秒`
                      : `最新注文は Delta 反映待ち (コミットから ${Math.max(0, Math.floor((now - new Date(latest.lakebase_committed_at).getTime()) / 1000))}秒)`}
              </div>
              <div className="text-xs text-muted-foreground">
                {latest?.sync_stalled
                  ? 'Lakehouse Sync (wal2delta) の状態を確認してください。5分を超えた未反映注文の Delta 再クエリは停止しています'
                  : latestSyncedLag != null
                    ? `直近の反映遅延の実測: ${latestSyncedLag < 1 ? latestSyncedLag.toFixed(3) : latestSyncedLag.toFixed(1)}秒 (Delta 反映時刻 − Lakebase コミット時刻)`
                    : 'Delta への反映を待っています (CDC はコミット後おおむね数秒で反映)'}
              </div>
            </div>
          </div>

          {events && events.length > 0 && (
            <div className="space-y-2">
              {events.map((e) => {
                const waiting = e.delta_synced_at == null;
                const focused = focusOrder === e.id;
                return (
                  <div
                    key={e.id}
                    data-order-event={e.id}
                    className={`rounded-md border px-3 py-2 text-xs ${focused ? 'ring-2 ring-primary/50 bg-primary/5' : ''}`}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-mono text-muted-foreground">#{e.id.slice(0, 8)}</span>
                      <span className="font-medium">{e.customer_name} 様</span>
                      <span className="text-muted-foreground">
                        {fmtPrice(e.total_price, e.currency)} · {e.channel === 'chat' ? 'チャット注文' : '画面注文'}
                      </span>
                      <span className="ml-auto text-muted-foreground">{fmtAgo(e.lakebase_committed_at, now)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono">
                      <span className="rounded bg-muted px-1.5 py-0.5">
                        アプリ書込{e.commit_ms != null ? ` ${(e.commit_ms / 1000).toFixed(e.commit_ms < 100 ? 2 : 1)}秒` : ''}
                      </span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span className="rounded bg-muted px-1.5 py-0.5">
                        Lakebase コミット {new Date(e.lakebase_committed_at).toLocaleTimeString('ja-JP', { hour12: false })}
                      </span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      {waiting ? (
                        e.sync_stalled ? (
                          <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">
                            Delta 同期遅延 (5分超・再クエリ停止)
                          </span>
                        ) : (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">Delta 反映待ち…</span>
                        )
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-green-800">
                          <CheckCircle2 className="h-3 w-3" />
                          Delta 反映 {new Date(e.delta_synced_at!).toLocaleTimeString('ja-JP', { hour12: false })}
                          {e.lag_seconds != null &&
                            ` (+${e.lag_seconds < 1 ? e.lag_seconds.toFixed(3) : e.lag_seconds.toFixed(1)}秒)`}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
