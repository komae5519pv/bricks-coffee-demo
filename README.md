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

## パーソナライズ (よく買ってるやつ / 前回と同じ)

本人の注文履歴 (OBO + RLS で本人分のみ) に基づく再注文機能。認証演示とパーソナライズ演示が重なるポイント。

- **バリスタ**: `get_my_frequent_items`(本人履歴の集計・回数付きランキング→画像カードで追加可)と `reorder_last`(直近注文と同じ SKU・数量をセットカードで返し「まとめて追加」)。履歴0件なら「まだ注文履歴がありません」と人気商品を案内
- **注文ページ**: 「前回と同じ」クイックアクション(直近注文をワンクリックでカートに。注文店舗が表示店舗と違う場合は自動で店舗切替)と「よく注文する商品」セクション(×N バッジ付き小カード帯・履歴0件なら非表示)。/api/orders は OBO+RLS で本人分のみ取得
- **ツールの OBO 構成**(重要): バリスタの DB ツールは coffee-tools ツールキットプラグイン経由で実行(`PluginContext.executeTool → asUser(req)` で実行時に本人コンテキスト。inline function tool だと SP 実行になり user_email=SP になってしまうため)
- **RLS 実証**: 他者注文(other.user@example.com のデモ用注文 bb180140 が存在)があっても、ツールの owner フィルタ(user_email=current_user)では0件・frequent ランキングにも混入しない。なお konomi.omae@databricks.com は global staff のため REST /api/orders ではスタッフ権限で店舗の全注文が見える(設計通り)

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

- スレッド履歴は InMemoryThreadStore(再起動で消失)。本番用途なら永続ストアを agents() に渡す。
- menu_items は CDC 対象外(vector 列)。メニュー管理で編集しても Delta 側 menu_items は
  自動更新されない(デモの Genie 参照は seed 時点のメニュー)。
- ページの言語は日本語中心。価格は店舗通貨建て(JPY/USD/GBP/SGD/AUD/EUR)。
