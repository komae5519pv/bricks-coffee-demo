# DAIWT Coffee Shop (2026 rebuild)

世界12か国のコーヒーチェーンを模した Databricks Apps デモ。
**注文は Lakebase (OLTP) に OBO + RLS で書き込まれ、CDC (Lakehouse Sync) で数秒で
Unity Catalog の Delta テーブルに複製され、Genie がそれを分析・提案する** ——
「運用DBと分析基盤の分断がない」世界を1本の流れで見せる。

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

## デモ台本 (5ステップ)

1. **アプリで注文** — 注文する → 商品をカートに入れて注文。「マイ注文」に即反映(Lakebase)。
   ステータスページで OBO トークンのクレーム(scope に `postgres`)と RLS を見せる。
2. **AI バリスタに注文** — 「東京駅前店でアイスコーヒーのMを1つ」→ 確認 → **承認ゲート**を承認。
   channel=chat で Lakebase に書き込まれる。アレルギーを伝えると save_preference の提案→保存も見せられる。
3. **CDC のライブ感** — ステータスページの「Lakebase → Delta レプリケーション遅延」が
   0〜数秒であること、wal2delta が STREAMING であることを見せる(実測 0.002〜0.6秒)。
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
# Playwright スモーク(要 npx playwright install): APP_URL=<app url> npx playwright test tests/smoke.spec.ts
```

## 既知の制限

- スレッド履歴は InMemoryThreadStore(再起動で消失)。本番用途なら永続ストアを agents() に渡す。
- menu_items は CDC 対象外(vector 列)。メニュー管理で編集しても Delta 側 menu_items は
  自動更新されない(デモの Genie 参照は seed 時点のメニュー)。
- ページの言語は日本語中心。価格は店舗通貨建て(JPY/USD/GBP/SGD/AUD/EUR)。
