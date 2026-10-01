# BRICKS COFFEE (daiwt-coffee-shop)

> **表示名は BRICKS COFFEE**。Databricks Apps のリソース名・URL・ワークスペースの
> パスは `daiwt-coffee-shop` のまま(作り直し回避のため名称は変更しない)。

日本のコーヒーチェーン(世界12か国展開)を模した Databricks Apps デモ。
**メニュー・カテゴリはすべて日本語、価格はすべて円(整数)表示**。
**注文は Lakebase (OLTP) に OBO + RLS で書き込まれ、CDC (Lakehouse Sync) で数秒で
Unity Catalog の Delta テーブルに複製され、Genie がそれを分析・提案する** ——
「運用DBと分析基盤の分断がない」世界を1本の流れで見せる。

価格のルール: 旧現地通貨価格 x100 (A$8.50 → ¥850) の整数円。店舗による価格差は
残る(東京 ¥800 / ロンドン ¥450 のハンドドリップ 等)。historical_orders は金額列を
持たないため変換対象なし(売上は menu_items との sku 結合で算出)。

- アプリ: https://daiwt-coffee-shop-7474646087200844.aws.databricksapps.com
- Genie スペース: https://fevm-konomi-demo.cloud.databricks.com/genie/rooms/01f1b7fc22dd131a98457d1273f90b8a
- ワークスペース: fevm-konomi-demo (CLI は必ず `--profile fevm-konomi-demo`)

## アーキテクチャ

```
ブラウザ (React SPA)
  └─ Databricks App (AppKit: Express + バリスタエージェント on-app ホスト)
       │  OBO: x-forwarded-access-token をユーザーごとの pg プールに使い、
       │  Postgres RLS が認可 (顧客=自分の注文のみ / スタッフ=店舗の注文)
       ├─ Lakebase (PG17 + pgvector)  … 注文・メニュー・嗜好の OLTP
       │     │  pgvector: メニューのセマンティック検索 (qwen3-embedding 1024次元)
       │     ▼  Lakehouse Sync (CDC, Beta) — REPLICA IDENTITY FULL が必須
       ├─ UC Delta: konomi_demo_catalog.cofee_shop.lb_*_history  … SCD2 変更履歴
       │     ▼  最新状態ビュー (orders 等) + menu_items (Delta 複製)
       └─ Genie スペース  … 過去履歴の分析・嗜好を踏まえた提案 (Serverless WH)
LLM: databricks-kimi-k3 (FMAPI OSS pay-per-token) / 埋め込み: databricks-qwen3-embedding-0-6b
```

- エージェントはモデルサービングではなく**アプリ内ホスト**(AppKit agents プラグイン, beta)。
  書き込み系ツールは承認ゲート(human-in-the-loop)付き。ツールは全て OBO 実行され RLS が効く。
- エージェントの LLM は **Kimi K3 (FMAPI OSS pay-per-token)**。社内コンテストの要件で
  FMAPI Partner モデル(Claude)は使えないため差し替えた。環境変数 `BARISTA_MODEL` で
  差し替え可能(省略時 `databricks-kimi-k3`、server/agents/barista.ts)。
  権限・リソースバインディングは databricks.yml の `agents_serving_endpoint_name` が単一ソース。
- トレーシングは AppKit の OpenTelemetry スパン(自動)。agents プラグインの標準パスに
  MLflow tracing の設定項目は存在しない(MLflow は Supervisor API アダプタ経由の managed agents 側の話)。

## データ (Lakebase スキーマ `cofee_shop` / UC `konomi_demo_catalog.cofee_shop`)

| Lakebase テーブル | 内容 | Delta 側 |
|---|---|---|
| stores | 店舗マスタ 12店 | lb_stores_history → ビュー stores |
| menu_items | SKU 924件 + vector(1024) | **CDC 非対象**(vector 非サポート)。Delta には seed から menu_items テーブルとして複製。**メニュー管理での編集はアプリが DELETE+INSERT で Delta にミラー**(server/lib/menu.ts syncMenuItemToDelta) |
| orders | ライブ注文 | lb_orders_history → ビュー orders |
| order_items | 注文明細 | lb_order_items_history → ビュー order_items |
| historical_orders | 過去注文 7,284行(分析用) | lb_historical_orders_history → ビュー historical_orders |
| customer_preferences | 嗜好(milk_allergy 等) | lb_customer_preferences_history → ビュー customer_preferences |
| user_memories | 長期記憶(自由記述・バリスタが同意取得で保存) | **CDC 非対象** |
| staff | スタッフ(RLS 判定用) | lb_staff_history (Genie には非公開) |
| chat_threads | バリスタ会話スレッド(owner=user_email) | **CDC 非対象** |
| chat_messages | 会話メッセージ(thread_id FK・ON DELETE CASCADE) | **CDC 非対象** |

注: 注文 ID は当初 UUID 型だったが、Lakehouse Sync は uuid を base64 バイナリで複製するため
TEXT 型に移行済み(起動時マイグレーション `UUID_TO_TEXT_MIGRATION` が冪等に変換)。
型変更は CDC の resnapshot を引くので、**resnapshot 後は Delta 側ビューを CREATE OR REPLACE で
作り直すこと**(tools/setup_delta.py を再実行すればよい)。

**chat_threads/chat_messages/user_memories の REPLICA IDENTITY FULL**: wal2delta で SKIPPED(REPLICA IDENTITY FULL 未設定)だが、会話・記憶の Delta 同期要件は現時点でないため現状維持。Delta 側で分析したくなったら REPLICA IDENTITY FULL を設定して CDC 対象に加える。

## 商品画像 (Unsplash)

- 注文タブのメニューカードに商品写真を表示。画像は Unsplash CDN (images.unsplash.com) への
  **hotlink のみ**(再ホスト禁止のため画像ファイルはリポジトリ/Volume に保存しない)。
  サイズ調整は imgix パラメータ(`?w=400&q=80&auto=format&fit=crop`)。lazy loading 付き。
- 各画像に `Photo by {撮影者} on Unsplash` のクレジットをカード隅に小さく表示
  (撮影者ページ・Unsplash への utm_source 付きリンク)。
- 仕組み: `tools/fetch_unsplash_images.mjs` が**初回1回だけ** Unsplash API を叩き、
  **ユニーク商品48点それぞれに専用の英語クエリ**で画像を取得(デモ枠 50 req/時に収まる。
  サイズ違いは同一商品=同一画像)。結果は `server/seed/menu_images.json` の
  `products`(item_key→画像)に保存。カテゴリ別プール(8カテゴリ×5枚)はフォールバックとして
  `pool` に保持(管理画面からの新規商品や、専用画像が取れなかった商品用)。
  アプリは起動時にこの JSON から各 SKU に画像を確定的に割り当て `menu_items` の4カラムに保存する
  (image_url / image_photographer / image_photographer_url / image_unsplash_url)。
  **アプリ実行時は API を叩かない**。クエリ→item_key の対応はスクリプト内の明示マップで管理
  (商品名が日本語でもクエリは英語のまま)。
- 再取得: 自分の Unsplash Access Key を `~/.config/daiwt-coffee-shop/unsplash_access_key`
  に置いて `node tools/fetch_unsplash_images.mjs` を実行(キーは絶対にリポジトリに入れない)。

## モバイル対応 (iPhone 375px / iPad 768px)

全6ページがモバイル表示に対応 (375px・768px の両幅で横スクロールなしを Playwright で定期検証)。

- **ヘッダー**: ナビ・メールバッジ・ハンバーガーのブレークポイントは lg (1024px)。iPad (768px) はハンバーガー表示
- **注文ページ**: 店舗セレクトは w-full sm:w-auto、検索はモバイルで下段フル幅。モバイルの grid は grid-cols-1 (暗黙トラックの max-content 化による横溢れ防止)
- **フローティングカートバー** (モバイルのみ): カートが縦積みで埋もれるため、画面下に件数+合計のピルを常時表示。タップでカートへスクロール
- **カートのカロリー**: 明細ごとに「¥550 / 60kcal」、合計行に「合計 ¥X / Ykcal」(栄養データの無い SKU は非表示)
- **タッチターゲット**: モバイルで最低 44px (カートの＋/−・クリア・カテゴリ/サイズチップ・前回と同じ・チャットの追加ボタン)。デスクトップのサイズは据置き
- メニュー管理テーブルは min-w-[640px] + 横スクロール。ステータスページのアーキ図はモバイルで縦積み

## パーソナライズ (よく買ってるやつ / 前回と同じ)

本人の注文履歴 (OBO + RLS で本人分のみ) に基づく再注文機能。認証演示とパーソナライズ演示が重なるポイント。

- **バリスタ**: `get_my_frequent_items`(本人履歴の集計・回数付きランキング→画像カードで追加可)と `reorder_last`(直近注文と同じ SKU・数量をセットカードで返し「まとめて追加」)。履歴0件なら「まだ注文履歴がありません」と人気商品を案内
- **注文ページ**: 「前回と同じ」クイックアクション(直近注文をワンクリックでカートに。注文店舗が表示店舗と違う場合は自動で店舗切替)と「よく注文する商品」セクション(×N バッジ付き小カード帯・履歴0件なら非表示)。/api/orders は `user_email = current_user` の明示フィルタで本人分のみ返す(RLS だけに頼らない。global staff でも他者の注文は混ざらない)
- **ツールの OBO 構成**(重要): バリスタの DB ツールは coffee-tools ツールキットプラグイン経由で実行(`PluginContext.executeTool → asUser(req)` で実行時に本人コンテキスト。inline function tool だと SP 実行になり user_email=SP になってしまうため)
- **RLS 実証**: 他者注文(other.user@example.com のデモ用注文 bb180140 が存在)があっても、ツールの owner フィルタ(user_email=current_user)では0件・frequent ランキングにも混入しない。/api/orders も owner フィルタで本人分のみ(スタッフの RLS 許可に頼らない)。店舗の全注文が見えるのは /api/board(キッチンボード)経由のみで、これはスタッフ業務としての設計通り

## チャット UI (フローティングオーバーレイ) + 会話履歴 (Lakebase 永続化)

バリスタとの会話は右下のフローティングボタンから開くオーバーレイパネルに集約(右カラムはカート専用。
カートの明細は長い時だけ内部スクロールし、合計行・注文ボタンは常に表示)。パネルは**非モーダル**:
開いたまま商品閲覧・カート追加・数量変更ができ、外クリックでは閉じずヘッダーの閉じるボタンのみ。
開閉状態と会話内容はページ遷移を跨いで維持される(Layout 内の単一インスタンス・非表示時も mount 維持)。
デスクトップは画面右端の浮遊パネル(デフォルト幅420px・高さ75vh)。左辺・上辺・左上コーナーの
ドラッグでリサイズでき、サイズは localStorage に保存される(モバイル/タブレットでは従来どおり
ほぼ全画面のシート)。カートと選択中店舗は共有ストア化(cart-store / current-store)し、
全ページからチャットの商品カード追加・店舗ヒントが効く。

会話は Lakebase (chat_threads / chat_messages) に永続化され、アプリ再起動後も残る。
agents プラグインの ThreadStore を Lakebase 実装に差し替えている(server/lib/thread-store.ts)。

- パネルヘッダーの「履歴」で一覧・過去スレッドの閲覧・**再開**(過去のコンテキストを引いたまま続きを話せる)、「＋」で新規会話、各スレッドの削除(確認ダイアログ付き)
- タイトルは各スレッドの最初のユーザーメッセージ先頭30文字から自動付与(店舗ヒントは除く)
- 他人の会話は見えない: 全クエリが user_email 明示フィルタ + chat テーブルの RLS は per-user プールに対し default-deny(実行はアプリ SP プール)
- 回答の Markdown テーブルは remark-gfm で描画(依存は vendor/ 同梱)
- 商品カードは「最終回答で実際に推薦された商品だけ」: バリスタは search_menu で探索した後、最終的に推すSKUを
  show_recommendations ツールに渡し、カードはそれだけを描画(最大6枚・SKU重複排除・サイズ違いは1枚に集約)。
  ツールを使わなかった回答への安全網として、探索途中の検索結果はターン内でバッファし、最終回答テキストに
  正式名称が登場する商品だけを回答後にカード化する(探索の中間結果がカードに残らない)

## エージェントメモリ (Lakebase)

バリスタは **短期メモリ(会話セッション)** と **長期記憶(嗜好 + 保存した事実)** の2層を持ち、
どちらもアプリ自身の Lakebase プロジェクト上のテーブルに永続化される。アプリを再起動しても
会話の続きが話せ、別の会話でも「いつもの」を覚えている —— 「エージェントの記憶も運用DBに置く」
物語を、注文と同じ OBO + RLS の枠組みで見せる。

**短期メモリ — 会話セッション (chat_threads / chat_messages)**

- AppKit agents プラグインの ThreadStore を Lakebase 実装に差し替え(server/lib/thread-store.ts)。
  全メッセージが INSERT され、アプリ再起動・別デバイスからも会話を再開できる
- 所有者キーはプラットフォームの `x-forwarded-user`(スレッド単位)。全クエリが user_email 明示
  フィルタ + chat テーブルの RLS は per-user プールに対し default-deny(実行はアプリ SP プール)で、
  他人の会話は読み書き・削除とも不可

**長期記憶 — 嗜好 (customer_preferences) + 記憶 (user_memories)**

- `customer_preferences` は構造化プロファイル(milk_allergy=true 等の key/value)。CDC → Delta で
  Genie も参照する既存のパーソナライズ基盤
- `user_memories` は自由記述の永続メモリ(例:「いつもオーツミルクラテのMを頼む」「甘さ控えめが好み」)。
  key/value に収まらない事実を kind(allergy/preference/habit/order_pattern/fact)付きで保持
- 取得は `get_my_memories` ツール(嗜好+記憶をまとめて返す。提案前・会話開始時にエージェントが確認)、
  保存は `remember_fact` ツール(自由記述)と `save_preference` ツール(構造化嗜好)。どちらも
  **effect=write の承認ゲート付き**で、会話でユーザーの同意を得た時だけ実行される(place_order と同じ
  human-in-the-loop)。ツールは OBO 実行なので current_user=本人、RLS + 明示 owner フィルタで本人分のみ
- **明示保存(explicit)を選んだ理由**: 会話からの自動抽出(derived)は裏側の抽出ロジックがブラックボックス
  になり、デモで「何が・いつ記憶されたか」を説明しにくい。明示保存なら「保存してよいですか?→承認→
  ステータスページに記憶が出る」という1本の演示フローになり、既存の注文承認ゲートと物語が揃う

**可視化 (デモで「記憶が見える」ように)**

- **ステータスページ「エージェントメモリ (Lakebase)」カード**: 本人の会話セッション一覧(タイトル・
  メッセージ数・更新時刻)と長期記憶(嗜好 + 記憶)を10秒ポーリングで表示。remember_fact で保存すると
  数秒以内にカードに現れる
- **データブラウザ**: user_memories / chat_threads / chat_messages / customer_preferences を本人分
  スコープで実テーブルの行として参照できる(「記憶 = Lakebase の行」をそのまま見せる)

**公式 Managed agent sessions / memory との関係 (設計判断)**

Databricks 公式の提供形態は **Managed agent sessions**(短期)と **Managed agent memory**(長期)の
2本(いずれも Beta・Lakebase バックエンド・framework-agnostic・カスタム Apps ホスト型エージェントから
REST(`/api/2.0/agents/session-stores` / `/api/2.0/agents/memory-stores`)で直接利用可)。

本デモは **自前テーブル実装** を選択した:

1. 短期側は既に Lakebase ThreadStore として実装・検証済みで、移行の実益がない
2. マネージド版のストアはワークスペーススコープの Databricks 管理 Lakebase インスタンスに置かれ、
   アプリ自身の Lakebase プロジェクトの行としては見えない。デモの肝である「ステータスページの
   データブラウザで実データを見せる」「注文と同じ OBO + RLS の枠組みで語る」と相性が悪い
3. Beta の REST はガイドの curl 例が唯一の仕様で、SDK 表面が未安定

概念は公式モデルに対応させてある: session ≈ chat_threads、session item ≈ chat_messages、
memory entry (actor_id + content) ≈ user_memories (user_email + content) + customer_preferences。
本番で新規に組むなら公式 Managed(Beta)が推奨筋。

出典(docs.databricks.com、2026-09-29/30 更新版で確認):

- Agent memory and sessions: https://docs.databricks.com/aws/en/agents/custom-agents/stateful-agents
- Managed agent sessions: https://docs.databricks.com/aws/en/agents/agent-memory/managed-sessions
- Managed agent memory: https://docs.databricks.com/aws/en/agents/agent-memory/managed-memory

## MLflow トレーシング & 評価 (バリスタエージェント)

本番エージェントの可観測性ストーリー。**1会話ターン = 1 MLflow トレース**として、
Databricks ホストの MLflow エクスペリメントに記録される(デフォルト
`/Shared/daiwt-coffee-shop-barista`、`MLFLOW_EXPERIMENT_NAME` で変更可)。

### トレース構造

```
barista.turn (AGENT, ルート)        inputs: ユーザーメッセージ / outputs: 最終応答+ツール呼出名
├── llm databricks-kimi-k3 (CHAT_MODEL)  モデル呼出ごと。inputs: リクエスト / outputs: ストリーム復元テキスト
├── search_menu (TOOL)              ツール実行ごと。inputs: 引数 / outputs: 結果(4KB で切り詰め)
├── recommend_set (TOOL)
└── ...
```

- 実装は `server/lib/tracing.ts`。フック点は2箇所+ツールラッパ:
  アダプタの `run()`(ルートスパン)、アダプタの公開フィールド `streamBody`(LLM スパン。
  SSE をパススルーしつつ内容を復元)、各ツール execute(TOOL スパン。toolkit は
  `CoffeeToolsPlugin.executeAgentTool` の一箇所で全ツールをカバー)
- スパン連携は AsyncLocalStorage。承認ゲート(HITL)で停止してもコンテキストは維持される

### 公式 TS SDK (mlflow-tracing) の評価結果

公式 `mlflow-tracing` v0.1.3 を採用しているが、**その `init()`/`withSpan` は使っていない**。
理由: SDK の `init()` は内部で OTel NodeSDK を起動しグローバルトレーサープロバイダを奪う。
AppKit も NodeSDK を持つ(プラットフォームの OTLP テレメトリ)ため先着1個しか登録できず、
MLflow が勝てば AppKit の HTTP スパンが実験に「トレース」として流入して汚染され、
AppKit が勝てば MLflow スパンが無音で no-op になる。そこで SDK の部品
(MlflowClient / MlflowSpanExporter / trace manager / エンティティ)だけを再利用し、
非グローバルの専用 TracerProvider + 明示スパンで駆動している(詳細は tracing.ts 冒頭コメント)。
Databricks 認証(プロファイル/OAuth M2M)は SDK の auth モジュールをそのまま利用。

### ステータスページ連携

`/api/status` とステータスページに「MLflow トレーシング」カードを追加。エクスペリメントへの
リンク + 最近のトレース(クリックで該当トレースを開ける)を表示する。

### 評価ハーネス (`npm run eval`)

`tools/eval_barista.py` + 10シナリオのゴールデンデータセット(`tools/eval_barista_golden.json`:
アレルギー制約つき推薦、カロリー上限セット、リオーダー、記憶の想起/保存同意、
スタッフ機能の拒否、注文確認フロー、店舗一覧、栄養検索)。シナリオは全て読み取り系で、
破壊的操作は「拒否されること」側を検証する設計(本番データを汚さない)。

```bash
npm run dev        # 別ターミナルでアプリを起動
npm run eval       # 本実行: アプリに実問い合わせ → mlflow.genai.evaluate → 実験に記録
npm run eval:smoke # 密閉ドライラン: ワークスペース不要。データセットの缶詰応答で
                   # 決定論スコアラの配線と集約を検証(ローカル sqlite ストア)
```

スコアラ3本:

1. **tool_call_correctness**(決定論) — 必須ツールの呼出・禁止ツールの非呼出・
   ツール引数制約(例: search_menu が exclude_allergens=["milk"] 付きで呼ばれたか)
2. **response_requirements**(決定論) — must_mention 文字列(例: "kcal")の応答内含むか
3. **rubric_compliance**(LLM ジャッジ, make_judge) — シナリオごとのルーブリックを
   0.0-1.0 で採点。ジャッジモデルは `BARISTA_EVAL_JUDGE_MODEL`(デフォルト
   databricks:/databricks-meta-llama-3-3-70b-instruct、structured outputs 対応が必須)

結果の見方: ワークスペース MLflow UI → エクスペリメント → **Evaluations タブ**。
実行ごとの集約メトリクスと、サンプルごとのスコア・根拠(rationale)・トレースが見える。

### デモの一拍

1. チャットで注文(例:「牛乳アレルギーなんだけどおすすめは?」→ 確認 → 注文確定)
2. ステータスページの「最近のトレース」から該当トレースを開く →
   LLM/ツールの各スパン(引数・結果・所要時間)が見える
3. `npm run eval` を実行 → Evaluations タブで10シナリオのスコアを見せる
   (「本番エージェントの品質を継続評価する仕組み」として)

### MLflow 落とし穴(実測由来・対応済み)

1. **UC トレース宛先はプロデューサー側の設定**。エクスペリメントと UC スキーマを
   リンクするだけでは UC に入らない。Python では `mlflow.tracing.set_destination(...)`
   だが TS SDK v0.1.3 に相当 API が無いため、本アプリのトレースはエクスペリメント行き。
   UC 側の準備スキーマ作成と Python 側の設定例は `tools/setup_mlflow_uc_traces.py` に集約
2. **make_judge の集約欠落対策**。フィードバックの型を推論任せにすると集約から
   落ちる事案があった(bool 型で実害)。`feedback_value_type=float` を明示し、
   決定論スコアラも数値(1.0/0.0)を返す設計。smoke モードが集約の存在をゲートする
3. **CREATE OR REPLACE 禁止**。UC オブジェクトの再作成は権限を落とす。セットアップは
   全て `CREATE ... IF NOT EXISTS` + 個別 GRANT、実験 ACL も PUT ではなく PATCH(追加)
4. **UC から再取得したトレースの span.inputs/outputs は JSON 文字列**。dict 前提で
   扱わず `json.loads()` してから使うこと(setup スクリプトの docstring にも明記)

## Lakebase リアルタイム演示 (書込み → コミット → Delta 反映)

「普段のUIには痕跡を残さず、イベントが起きた瞬間だけ光る」原則で、注文のライブ感を3箇所に仕込んである。

- **注文ページ**: 注文成功トーストにサーバー実測のコミット時間を表示(「…Lakebase にコミットしました (0.3秒)」。
  POST /api/orders が単一文トランザクションの実行時間を実測して返す。固定値・推測値は入れない)。トーストの
  「このレコードを見る」からステータスページの該当注文イベントにジャンプ(行がハイライト)
- **キッチンボード**: ポーリングで届いた新規注文カードだけがパルスして登場(1回きり・既存カードは無反応)。
  カードの時刻は「たった今/○秒前/○分前」の相対表示で秒ごとに更新
- **ステータスページ**: 注文イベントログ(4秒ポーリング)。注文ごとに「アプリ書込(実測秒) → Lakebase コミット
  (時刻) → Delta 反映(時刻・遅延)」を時系列表示し、ライブ遅延ティッカーが最後の注文の反映遅延を実測表示
  (反映待ちの間はコミットからの経過秒が流れる)。Delta 側の再クエリは未反映の注文がある間だけ
  (平時のポーリングは Lakebase のみでウェアハウスを叩かない)

## 栄養・健康軸 (カロリー・アレルゲン・代替乳)

SKU 単位で栄養データを保持(実在チェーン相当の妥当な値・全店共通):

- **栄養列**: calories_kcal / protein_g / fat_g(サイズ連動。例: エスプレッソ 10kcal、抹茶ラテM 200kcal、フラペ L ~400kcal 台)
- **アレルゲン列**: contains_milk / contains_egg / contains_wheat / contains_nuts
- **代替乳**: alt_milk_options(オーツ/アーモンド/豆乳に変更可能なミルク系ドリンク)
- **タグ列**: scenes(breakfast/lunch/snack)、is_classic/is_new/is_seasonal、target_tags(傾向コード・UI には直接出さずエージェントが利用)

使い方:

- **注文ページ**: カードにサイズ連動の「¥750 / 210kcal」表示。折りたたみ「絞り込み」で kcal上限(200/300/400)・低脂質・高タンパク・シーン・季節限定/新商品/定番を絞り込める(クライアント側フィルタ)
- **バリスタ**: search_menu に構造化フィルタ(max_calories/min_protein/max_fat/scene/tags/exclude_allergens/alt_milk)。「300kcal以内でタンパク質多め」等を正確に。recommend_set でシーン別セット提案(合計価格・合計カロリー付き・まとめてカート追加)。牛乳アレルギーには乳なし商品 + 代替乳変更可能ラテを区別して案内
- **Genie**: 栄養・アレルゲン・人気(historical_orders 結合)の質問に対応(「最もカロリーが低いドリンクは?」→ 緑茶/アールグレイ 2kcal)
- 埋め込みテキストにも栄養・アレルゲン文を含め、セマンティック検索が健康軸の問いに効く(「カロリー控えめ」等)

## ロール別 UI (お客さん表示 / スタッフ表示)

OBO で「誰がアクセスしたか」を認識し、権限で見える画面が変わること自体を演示するため、
ナビゲーションはロールで出し分ける:

- **お客さん**: 「注文する」「マイ注文」の2項目のみ
- **スタッフ**(staff テーブル登録者): 上記 + 「キッチンボード」「メニュー管理」「売上・履歴」「ステータス」
- **デモ用切替スイッチ**: スタッフのヘッダーに「お客さん表示 / スタッフ表示」の
  プレビュー切替を配置(ツールチップに「デモ用表示切替(プレビュー。実際の権限は変わりません)」)。
  1アカウントのままプレゼンで両面を見せられる。表示を変えるだけで実ロールは変わらない。
- サーバー側の認可は従来どおり RLS + staff 判定(ナビの出し分けはあくまで整理であり、
  守りはサーバー側にある)。

## デモ台本 (5ステップ)

1. **ロールの出し分け** — 「お客さん表示」でナビが2項目になること、「スタッフ表示」で
   全項目に戻ることを見せる(OBO で本人を認識し権限で画面が変わる)。続けて注文する →
   商品をカートに入れて注文。「マイ注文」に即反映(Lakebase)。
2. **AI バリスタに注文** — 「東京駅前店でアイスコーヒーのMを1つ」→ 確認 → **承認ゲート**を承認。
   channel=chat で Lakebase に書き込まれる。アレルギーを伝えると save_preference の提案→保存も見せられる。
   続けて「いつもオーツミルクラテなんだよね」と伝えると remember_fact の提案 → 承認で長期記憶に保存。
   ステータスページの「エージェントメモリ」カードに数秒で現れ、**新しい会話を開いて**「おすすめは?」と
   聞くと get_my_memories で記憶を参照した提案になる(会話を跨ぐ長期記憶の演示)。
3. **CDC のライブ感** — ステータスページの「Lakebase → Delta レプリケーション遅延」が
   0〜数秒であること、wal2delta が STREAMING であることを見せる(定常の実測 0.002〜0.6秒)。
   注文直後はトーストの「このレコードを見る」からイベントログへ飛び、書込み → コミット →
   Delta 反映が遅延ティッカーと共に実測で流れるのを見せる。キッチンボードでは新着カードの
   パルスと「○秒前」のライブ更新を見せる。
   なお CDF config 作成直後の初回スナップショットや、型変更による resnapshot 直後は
   分単位かかる場合がある(実績: 初回の manual 注文が resnapshot 反映まで約9分)。
4. **Genie で分析** — Genie スペースで「過去の注文履歴を見せて」→「ライブ注文の最新を見せて」。
   さっき入れた注文がもう Delta 経由で見えることを確認。
5. **嗜好を踏まえた提案** — 「TYO001 で私におすすめを提案して」→ customer_preferences の
   milk_allergy=true を読み、ラテ系を除外した提案(緑茶・エスプレッソ等)が返る。

## 前提

- Node.js 22+, Databricks CLI, プロファイル `fevm-konomi-demo`(OAuth)
- Lakebase プロジェクト `konomi-coffee-shop`(PG17 / production ブランチ)
- UC `konomi_demo_catalog.cofee_shop` / Serverless Starter Warehouse (348478745ad64b30)
- 初回起動時にアプリが DDL・シード・RLS・埋め込みバックフィルを自動実行する

## 環境パラメータの単一ソース

**databricks.yml の variables が唯一の正**。カタログ/スキーマ/Lakebase/LLM/埋め込み/
warehouse/Genie スペース ID は全てここ。app.yaml は生成物なので直接編集しない:

```bash
npm run render:appyaml     # databricks.yml -> app.yaml 再生成 (tools/render_app_yaml.mjs)
```

別環境ターゲットの追加例は databricks.yml 末尾のコメント参照(事前に Lakebase ブランチと UC スキーマの作成が必要)。

## 再デプロイ手順

```bash
npm install
npm run build                                # typecheck + client/server ビルド
npm run render:appyaml                       # databricks.yml を変えた場合
databricks bundle deploy --profile fevm-konomi-demo   # 初回/リソース変更時
databricks apps deploy --profile fevm-konomi-demo     # コード更新のデプロイ(引数なし=enhanced)
```

**重要**: `databricks apps deploy <アプリ名>` は API デプロイになりローカルソースを
アップロードしない(古いコードがデプロイされる)。必ずプロジェクト dir で引数なしで実行。

初回セットアップ(新規環境で再現する場合):

```bash
# 1. Lakebase プロジェクト作成(既存ならスキップ)後、アプリをデプロイ(上記)
# 2. Lakehouse Sync (CDC) 有効化 — PG スキーマ cofee_shop -> UC konomi_demo_catalog.cofee_shop
databricks postgres create-cdf-config \
  projects/konomi-coffee-shop/branches/production/databases/databricks-postgres \
  konomi_demo_catalog cofee_shop cofee_shop \
  --cdf-config-id coffee_shop_cdc --profile fevm-konomi-demo
# 3. Genie 用ビュー + menu_items Delta テーブル
python3 tools/setup_delta.py --profile fevm-konomi-demo
# 4. アプリ SP に UC 読み取り権限(ステータスページの Delta 参照用)
python3 tools/grant_app_sp_uc.py --profile fevm-konomi-demo
# 5. Genie スペース作成(REST API: POST /api/2.0/genie/spaces、CLI は `databricks genie create-space`)
#    作成した space id を databricks.yml の genie_space_id に記録 -> render:appyaml -> apps deploy
```

## 再現デプロイ (DABs)

別のワークスペースにこのデモを一式再現する手順 (Declarative Automation Bundles + 仕上げスクリプト)。
上の「再デプロイ手順」が本番ワークスペース (fevm-konomi-demo) 向けなのに対し、こちらは
**自分のワークスペースにクローンから作る** 汎用フロー。host/profile は databricks.yml に
書かず、実行時に `--profile` で渡す。

### 前提

- Databricks CLI **>= v1.4.0** (postgres/genie の DABs 直接リソースに必要)
- Node.js 22+ / python3 / **psql** (例: `brew install libpq`)
- ワークスペース権限: Apps 作成・Lakebase プロジェクト作成・既存 UC カタログへの CREATE SCHEMA・
  SQL warehouse の CAN_USE・モデルサービングエンドポイント (Claude Sonnet 4.5 / qwen3 embedding) の CAN_QUERY
- 自分の CLI プロファイル (OAuth)

### 手順 (3コマンド + 仕上げ1本)

```bash
git clone <this repo> && cd daiwt-coffee-shop
npm install && npm run build

# 0. 必須変数2つを databricks.yml の targets.dev.variables に書く:
#      catalog      … CREATE SCHEMA 可能な既存 UC カタログ
#      warehouse_id … 任意の SQL warehouse の ID
npm run render:appyaml                        # databricks.yml -> app.yaml 生成
databricks bundle deploy --profile <PROFILE>  # リソース一式作成
databricks apps deploy   --profile <PROFILE>  # ソースのデプロイ (必ず引数なしで)
scripts/post_deploy.sh   --profile <PROFILE>  # 仕上げ (冪等)
```

### 工程の担当分け

| 工程                                                                | 担当                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC スキーマ (var.catalog 配下)                                      | bundle (`resources/uc.schema.yml`)                                                                                                                                                                                                      |
| Lakebase プロジェクト (PG17)                                        | bundle (`resources/lakebase.postgres.yml`)。production ブランチ / primary エンドポイント / databricks-postgres DB / owner ロールはプロジェクト作成時に自動作成されるため bundle では宣言しない (二重宣言は fresh デプロイで 409 になる) |
| Genie スペース (指示文・6テーブル・サンプル質問入り)                | bundle (`resources/genie.genie_space.yml` — 本番スペースの serialized export を変数化したもの)                                                                                                                                          |
| App 登録・SP・Lakebase/warehouse/LLM エンドポイントのバインディング | bundle (`resources/app.app.yml`)                                                                                                                                                                                                        |
| シークレットスコープ (器のみ)                                       | bundle (`resources/secrets.secret_scope.yml`)                                                                                                                                                                                           |
| アプリのソース・ビルド                                              | `databricks apps deploy`                                                                                                                                                                                                                |
| Lakebase の DDL/seed/RLS/REPLICA IDENTITY FULL                      | アプリ初回起動 (server/db.ts)。post_deploy.sh が psql で完了を待ち RIF を冪等に再確認                                                                                                                                                   |
| Lakehouse Sync (CDF config)                                         | post_deploy.sh。**DABs 非対応** (REST/CLI のみ)                                                                                                                                                                                         |
| 最新状態ビュー + menu_items Delta テーブル                          | post_deploy.sh → tools/setup_delta.py                                                                                                                                                                                                   |
| アプリ SP への UC GRANT                                             | post_deploy.sh → tools/grant_app_sp_uc.py (bundle に grants リソースが無い)                                                                                                                                                             |
| GENIE_SPACE_ID の反映                                               | post_deploy.sh (スペース ID を検出 → databricks.yml 記入 → app.yaml 再生成 → apps 再デプロイ)                                                                                                                                           |
| シークレットの値 (Unsplash キー・任意)                              | post_deploy.sh が対話時に聞く / 手動 `databricks secrets put-secret`                                                                                                                                                                    |

### 自動化できず手動で残るもの

- **必須変数2つ (catalog, warehouse_id) の設定** — ワークスペース固有のため
- Genie スペース / アプリの他ユーザーへの共有 (デモで見せる場合。UI から権限付与)
- Unsplash API キー (商品画像の再取得を行う場合のみ。アプリ実行には不要)

### デモ/コンテスト固有の値の置き場

- `databricks.yml` の variables が単一ソース (app_name / lakebase_project_id / genie_space_title / demo_user_email / モデルエンドポイント名 等)
- Genie の指示文・サンプル質問・参照テーブル: `resources/genie.genie_space.yml`
  (エクスポート元の素 JSON は `genie/genie_space.json`。プレースホルダ `__UC_CATALOG__` 等を置換して
  `POST /api/2.0/genie/spaces` に投げれば bundle を使わず手動でも作れる = フォールバック)
- シードデータ (店舗・メニュー 924SKU・過去注文 7,284行): `server/seed/*.json` (生成は tools/generate_seed.py)
- 商品画像マッピング: `server/seed/menu_images.json` (再取得は tools/fetch_unsplash_images.mjs)

### 注意

- Lakebase 側の PG スキーマ名 `cofee_shop` はアプリコードにハードコードされている (変えるにはアプリ改修が必要)。
  変数化されているのは UC 側 (`var.catalog` / `var.schema`) のみ。CDF config は PG `cofee_shop` → UC `var.catalog.var.schema` にマップされる
- `databricks bundle validate` は必須変数未設定だと「no value assigned to required variable catalog」で止まる
  (仕様。変数を書くか `--var "catalog=..." --var "warehouse_id=..."` を付ける)
- 同一ワークスペースに複数人がデプロイする場合は app_name / lakebase_project_id / schema を各人で変える

### フォールバック: Genie スペースを bundle を使わず REST で作る

`genie/genie_space.json` のプレースホルダを置換して POST する (作成後の ID 記入は post_deploy.sh がやる):

```bash
python3 - <<'EOF'
import json, subprocess
body = json.load(open('genie/genie_space.json'))
s = json.dumps(body['serialized_space'], ensure_ascii=False)
s = (s.replace('__UC_CATALOG__', '<CATALOG>').replace('__UC_SCHEMA__', '<SCHEMA>')
      .replace('__DEMO_USER_EMAIL__', '<YOUR_EMAIL>'))
body.update(serialized_space=s, warehouse_id='<WAREHOUSE_ID>',
            parent_path='/Workspace/Users/<YOUR_EMAIL>', title='BRICKS COFFEE (Lakebase CDC デモ)')
subprocess.run(['databricks', 'api', 'post', '/api/2.0/genie/spaces', '--profile', '<PROFILE>',
                '--json', json.dumps(body, ensure_ascii=False)], check=True)
EOF
```

## 品質ゲート

```bash
npm run lint            # eslint (0 errors)
npm run lint:ast-grep   # appkit lint
npm test                # vitest 単体テスト
npm run build           # typecheck 込み

# Playwright スモーク (tests/smoke.spec.ts):
npm i --no-save @playwright/test   # 注: package.json には意図的に未宣言(後述)
npx playwright install chromium    # 初回のみ
APP_URL=https://daiwt-coffee-shop-7474646087200844.aws.databricksapps.com npx playwright test tests/smoke.spec.ts
```

**@playwright/test を package.json に宣言していない理由**: Databricks Apps のビルド環境
(npm-proxy.dev.databricks.com 経由) が playwright-core の tarball 取得に 4 回連続で
ETIMEDOUT となりデプロイが失敗したため(手元のネットワークからは 1.5 秒で取得可能=
プラットフォーム側のプロキシ問題)。宣言するとデプロイが壊れるため、実行時に
`npm i --no-save` で入れる運用。yaml だけは devDependencies に宣言済み。

## 既知の制限

- menu_items は CDC 対象外(vector 列)。メニュー管理で編集しても Delta 側 menu_items は
  自動更新されない(デモの Genie 参照は seed 時点のメニュー)。
- 「前回と同じ」のエッジ: 直近注文が他店舗の商品のみの場合、店舗切替後も当該店舗で
  取り扱いのない商品はカートに入らない(メッセージで通知)。
- エージェント機能は AppKit agents プラグイン(beta) 依存。API 変更時は追随が必要。
- チャットのツール結果紐付け(toolNameByCallId)はセッション内 Map 保持のため、極端に長い
  会話ではわずかに増大する(実用上は無害)。
- ページの言語は日本語中心。価格はすべて円(整数・店舗により価格差あり)。
