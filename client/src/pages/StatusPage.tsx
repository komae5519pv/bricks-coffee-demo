import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent } from '@databricks/appkit-ui/react';
import { Activity, ArrowRight, Bot, Database, KeyRound, RefreshCw, Sparkles } from 'lucide-react';
import { api, type StatusResponse } from '../lib/api';

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right break-all ${mono ? 'font-mono text-xs' : ''}`}>{value ?? '-'}</span>
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

  const lag = data?.delta_sync?.lag_seconds;

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
          <div className="flex flex-wrap items-stretch gap-2 text-xs">
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
                {i < arr.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />}
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            注文は Lakebase に OBO (ユーザー本人の権限) で書き込まれ、CDC で数秒後に Unity Catalog の Delta
            テーブルへ複製されます。Genie はその Delta テーブル(最新状態ビュー)を参照して分析・提案を行います。
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
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
              <div className="text-xs text-muted-foreground">Lakebase → Delta レプリケーション遅延</div>
              <div className="text-3xl font-bold">
                {lag === null || lag === undefined ? '-' : lag <= 0 ? '< 1' : lag}
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
    </div>
  );
}
