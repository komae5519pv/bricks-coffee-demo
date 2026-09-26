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
LLM: databricks-claude-sonnet-4-5 / 埋め込み: databricks-qwen3-embedding-0-6b
```

- エージェントはモデルサービングではなく**アプリ内ホスト**(AppKit agents プラグイン, beta)。
  書き込み系ツールは承認ゲート(human-in-the-loop)付き。ツールは全て OBO 実行され RLS が効く。
- トレーシングは AppKit の OpenTelemetry スパン(自動)。agents プラグインの標準パスに
  MLflow tracing の設定項目は存在しない(MLflow は Supervisor API アダプタ経由の managed agents 側の話)。

## データ (Lakebase スキーマ `cofee_shop` / UC `konomi_demo_catalog.cofee_shop`)

| Lakebase テーブル | 内容 | Delta 側 |
|---|---|---|
| stores | 店舗マスタ 12店 | lb_stores_history → ビュー stores |
| menu_items | SKU 924件 + vector(1024) | **CDC 非対象**(vector 非サポート)。Delta には seed から menu_items テーブルとして複製 |
| orders | ライブ注文 | lb_orders_history → ビュー orders |
| order_items | 注文明細 | lb_order_items_history → ビュー order_items |
| historical_orders | 過去注文 7,284行(分析用) | lb_historical_orders_history → ビュー historical_orders |
| customer_preferences | 嗜好(milk_allergy 等) | lb_customer_preferences_history → ビュー customer_preferences |
| staff | スタッフ(RLS 判定用) | lb_staff_history (Genie には非公開) |
| chat_threads | バリスタ会話スレッド(owner=user_email) | **CDC 非対象** |
| chat_messages | 会話メッセージ(thread_id FK・ON DELETE CASCADE) | **CDC 非対象** |

注: 注文 ID は当初 UUID 型だったが、Lakehouse Sync は uuid を base64 バイナリで複製するため
TEXT 型に移行済み(起動時マイグレーション `UUID_TO_TEXT_MIGRATION` が冪等に変換)。
型変更は CDC の resnapshot を引くので、**resnapshot 後は Delta 側ビューを CREATE OR REPLACE で
作り直すこと**(tools/setup_delta.py を再実行すればよい)。

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

別環境ターゲットの例として `staging` target あり(事前に Lakebase ブランチと UC スキーマの作成が必要)。

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
