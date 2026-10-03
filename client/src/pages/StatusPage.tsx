import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Card, CardContent } from '@databricks/appkit-ui/react';
import { Activity, ArrowRight, Bot, Brain, CheckCircle2, Database, KeyRound, ListOrdered, RefreshCw, Sparkles, Timer } from 'lucide-react';
import { api, fmtPrice, type OrderEvent, type StatusResponse } from '../lib/api';
import { fmtAgo, useNow } from '../lib/use-now';
import { ArchDiagram } from '../components/status/ArchDiagram';
import { DataBrowser } from '../components/status/DataBrowser';

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

const MEMORY_KIND_LABELS: Record<string, string> = {
  allergy: 'アレルギー',
  preference: '好み',
  habit: '習慣',
  order_pattern: '注文パターン',
  fact: '事実',
};

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
    <div className="space-y-6 max-w-7xl">
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

      {/* Architecture diagram (native SVG, theme-aware, responsive) */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-medium text-sm">アーキテクチャ</h3>
          <ArchDiagram />
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

        {/* MLflow tracing: experiment link + recent traces (demo beat:
            place an order in chat, then open its trace here) */}
        <Card>
          <CardContent className="p-4 space-y-1">
            <h3 className="font-medium text-sm flex items-center gap-2 pb-2">
              <Timer className="h-4 w-4" /> MLflow トレーシング (バリスタエージェント)
              <span className="ml-auto">
                {data && (
                  <Badge ok={data.tracing.enabled} label={data.tracing.enabled ? '記録中' : '無効'} />
                )}
              </span>
            </h3>
            {data?.tracing.reason && !data.tracing.enabled && (
              <div className="text-xs text-red-600 break-all">{data.tracing.reason}</div>
            )}
            <Row
              label="エクスペリメント"
              value={
                data?.tracing.experiment_url ? (
                  <a
                    href={data.tracing.experiment_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {data.tracing.experiment_name}
                  </a>
                ) : (
                  (data?.tracing.experiment_name ?? '-')
                )
              }
              mono
            />
            <Row label="トレース構造" value="1会話ターン = 1トレース (AGENT > LLM + TOOL)" />
            {/* Latest offline eval run (npm run eval) — real aggregated scores
                from the experiment, or an honest "not run yet" note */}
            <div className="pt-2">
              <div className="text-xs text-muted-foreground pb-1">最新の評価ラン (オフライン評価: npm run eval)</div>
              {!data ? null : data.tracing.latest_eval === null ? (
                <div className="text-xs text-muted-foreground">まだ評価ランがありません — npm run eval を実行するとここに出ます</div>
              ) : (
                <div className="text-xs space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground shrink-0">{fmtAgo(data.tracing.latest_eval.started_at, now)}</span>
                    {data.tracing.latest_eval.url ? (
                      <a
                        href={data.tracing.latest_eval.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 text-blue-600 hover:underline font-mono"
                      >
                        {data.tracing.latest_eval.run_name ?? data.tracing.latest_eval.run_id} <ArrowRight className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="font-mono">{data.tracing.latest_eval.run_name ?? data.tracing.latest_eval.run_id}</span>
                    )}
                  </div>
                  <ul className="space-y-0.5 font-mono">
                    {Object.entries(data.tracing.latest_eval.metrics)
                      .filter(([k]) => k.endsWith('/mean'))
                      .map(([k, v]) => (
                        <li key={k} className="flex items-center gap-2">
                          <span className="text-muted-foreground">{k.replace(/\/mean$/, '')}</span>
                          <span className="ml-auto">{v.toFixed(2)}</span>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="pt-2">
              <div className="text-xs text-muted-foreground pb-1">最近のトレース (このプロセスが記録したもの)</div>
              {!data || data.tracing.recent_traces.length === 0 ? (
                <div className="text-xs text-muted-foreground">まだトレースがありません — チャットで注文するとここに出ます</div>
              ) : (
                <ul className="space-y-1">
                  {data.tracing.recent_traces.slice(0, 6).map((t) => (
                    <li key={t.trace_id} className="flex items-center gap-2 text-xs font-mono">
                      <span
                        className={`h-1.5 w-1.5 rounded-full shrink-0 ${t.status === 'OK' ? 'bg-green-600' : t.status === 'ERROR' ? 'bg-red-600' : 'bg-yellow-500'}`}
                      />
                      <span className="text-muted-foreground shrink-0">{fmtAgo(t.started_at, now)}</span>
                      <span className="truncate">{t.name}</span>
                      {t.duration_ms != null && (
                        <span className="text-muted-foreground shrink-0">{(t.duration_ms / 1000).toFixed(1)}s</span>
                      )}
                      {t.url && (
                        <a
                          href={t.url}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-auto inline-flex items-center gap-0.5 text-blue-600 hover:underline shrink-0"
                        >
                          開く <ArrowRight className="h-3 w-3" />
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Agent memory: what the barista remembers about the current user */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="font-medium text-sm flex items-center gap-2">
            <Brain className="h-4 w-4" /> エージェントメモリ (Lakebase)
            <span className="ml-auto text-xs font-normal text-muted-foreground">本人分のみ · 10秒ごと自動更新</span>
          </h3>
          <p className="text-xs text-muted-foreground">
            バリスタがあなたについて覚えていること。短期メモリ(会話セッション)と長期記憶(嗜好 + 保存した事実)は
            どちらも Lakebase 上のテーブルに永続化され、アプリ再起動後も残ります。長期記憶は会話で同意した時だけ
            保存されます (remember_fact / save_preference は承認ゲート付き)。
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Short-term: chat sessions */}
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                短期メモリ — 会話セッション (chat_threads)
              </div>
              {!data || data.memory.sessions.length === 0 ? (
                <div className="text-xs text-muted-foreground">まだ会話セッションがありません</div>
              ) : (
                data.memory.sessions.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate font-medium">{s.title || '(無題の会話)'}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5">{s.message_count}件</span>
                    <span className="shrink-0 text-muted-foreground">{fmtAgo(s.updated_at, now)}</span>
                  </div>
                ))
              )}
            </div>
            {/* Long-term: structured preferences + free-form memories */}
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                長期記憶 — 嗜好 (customer_preferences) + 記憶 (user_memories)
              </div>
              {data && data.memory.preferences.length === 0 && data.memory.memories.length === 0 && (
                <div className="text-xs text-muted-foreground">保存されている長期記憶はありません</div>
              )}
              {data?.memory.preferences.map((p) => (
                <div key={p.preference_key} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono">{p.preference_key}</span>
                  <span className="min-w-0 flex-1 truncate">{p.preference_value}</span>
                </div>
              ))}
              {data?.memory.memories.map((m) => (
                <div key={m.id} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                  <span className="shrink-0 rounded bg-primary/10 text-primary px-1.5 py-0.5">
                    {MEMORY_KIND_LABELS[m.kind] ?? m.kind}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{m.content}</span>
                  <span className="shrink-0 text-muted-foreground">{fmtAgo(m.updated_at, now)}</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

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
                    ? '5分を超えて Delta に未反映の注文があります (照会済み)'
                    : latest.lag_seconds != null
                      ? `最後の注文が Delta に反映: ${latest.lag_seconds < 1 ? latest.lag_seconds.toFixed(3) : latest.lag_seconds.toFixed(1)}秒`
                      : `最新注文は Delta 反映待ち (コミットから ${Math.max(0, Math.floor((now - new Date(latest.lakebase_committed_at).getTime()) / 1000))}秒)`}
              </div>
              <div className="text-xs text-muted-foreground">
                {latest?.sync_stalled
                  ? '起動時の一括照会で確認済みです。5分を超えた注文の Delta 再クエリは停止しています（Lakehouse Sync の状態を確認してください）'
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
                            5分超・未反映 (照会済み・再クエリ停止)
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

      {/* Data browser: on-demand, read-only table inspection (Lakebase + Delta) */}
      <DataBrowser />
    </div>
  );
}
