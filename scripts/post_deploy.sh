#!/usr/bin/env bash
# =============================================================================
# post_deploy.sh — BRICKS COFFEE 再現デプロイの仕上げ (冪等)
#
# `databricks bundle deploy` + `databricks apps deploy` の後に実行する。
# DABs では作れない/埋め込めないものをセットアップする:
#
#   1. Lakebase 側ブートストラップ完了待ち (アプリ初回起動が DDL/seed/RLS を流す)
#   2. CDC 対象 6 テーブルの REPLICA IDENTITY FULL 確認 (アプリが設定済みのはず、冪等)
#   3. Lakehouse Sync (CDF config) 作成 — DABs 非対応 (REST/CLI のみ)
#   4. UC 側: 最新状態ビュー + menu_items Delta テーブル (tools/setup_delta.py)
#   5. アプリ SP への UC GRANT (tools/grant_app_sp_uc.py) — bundle に grants リソースが無い
#   6. Genie スペース ID を databricks.yml に記入 → app.yaml 再生成 → apps 再デプロイ
#   7. (任意・対話時のみ) Unsplash API キーをシークレットスコープに投入
#
# 使い方:
#   scripts/post_deploy.sh --profile <PROFILE> [-t <target>] [--yes]
#
# 前提: databricks CLI >= v1.4.0 / node (npm install 済み) / python3 / psql
# 冪等: 何度実行してもよい (存在チェック→作成、CREATE OR REPLACE、GRANT は additive)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=""
TARGET=""
ASSUME_YES=0
BOOTSTRAP_WAIT_SEC="${BOOTSTRAP_WAIT_SEC:-600}"   # アプリ初回ブートストラップ待ち
CDC_WAIT_SEC="${CDC_WAIT_SEC:-900}"               # 初回スナップショット待ち

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    -t|--target) TARGET="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROFILE" ] || { echo "ERROR: --profile <PROFILE> is required" >&2; exit 2; }

log()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

db() { databricks "$@" --profile "$PROFILE"; }

# JSON 取值ヘルパ (jq 非依存)
jget() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

# --- 0. 前提チェック -----------------------------------------------------------
log "0. prerequisites"
command -v databricks >/dev/null || die "databricks CLI not found"
command -v node      >/dev/null || die "node not found"
command -v python3   >/dev/null || die "python3 not found"
command -v psql      >/dev/null || die "psql not found (brew install libpq)"
[ -d node_modules/yaml ] || die "node_modules がありません。先に npm install を実行"

CLI_VER=$(databricks version | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | tr -d v)
CLI_MAJOR=$(echo "$CLI_VER" | cut -d. -f1); CLI_MINOR=$(echo "$CLI_VER" | cut -d. -f2)
[ "$CLI_MAJOR" -gt 1 ] || [ "$CLI_MAJOR" -eq 1 -a "$CLI_MINOR" -ge 4 ] \
  || die "databricks CLI >= v1.4.0 が必要 (postgres/genie の DABs 直接リソース)。現在: v$CLI_VER"
info "databricks CLI v$CLI_VER"

# --- 1. バンドル変数の解決 ------------------------------------------------------
log "1. bundle variables (databricks.yml)"
EVAL_VARS=$(mktemp)
node tools/bundle_vars.mjs ${TARGET:+-t "$TARGET"} --env > "$EVAL_VARS"
# shellcheck disable=SC1090
. "$EVAL_VARS"; rm -f "$EVAL_VARS"

: "${catalog:?databricks.yml の variables.catalog を設定してください (対象ターゲットの variables: に記入)}"
: "${warehouse_id:?databricks.yml の variables.warehouse_id を設定してください}"
schema="${schema:-cofee_shop}"
app_name="${app_name:-daiwt-coffee-shop}"
secret_scope="${secret_scope:-daiwt-coffee-shop}"
cdf_config_id="${cdf_config_id:-coffee_shop_cdc}"
genie_space_title="${genie_space_title:-BRICKS COFFEE (Lakebase CDC デモ)}"
postgres_branch="${postgres_branch:?postgres_branch unresolved}"
postgres_database="${postgres_database:?postgres_database unresolved}"
pg_db_name="$(basename "$postgres_database" | tr '-' '_')"
info "UC:        ${catalog}.${schema}"
info "Lakebase:  ${postgres_database} (pg db: ${pg_db_name})"
info "app:       ${app_name} / warehouse: ${warehouse_id}"
export DATABRICKS_WAREHOUSE_ID="$warehouse_id"   # aitools query が使う

# --- 2. Lakebase ブランチ/DB/エンドポイントの確認 --------------------------------
log "2. Lakebase branch / endpoint"
db postgres get-branch "$postgres_branch" -o json >/dev/null \
  || die "ブランチ ${postgres_branch} が見つかりません。bundle deploy は実行済みですか?
   (プロジェクト作成時にデフォルトブランチが自動作成されます。名前が違う場合は
    databricks.yml の lakebase_branch_id を実際の名前に合わせてください)"
ENDPOINT=$(db postgres list-endpoints "$postgres_branch" -o json \
  | python3 -c "import json,sys; eps=json.load(sys.stdin); rw=[e for e in eps if e.get('status',{}).get('endpoint_type')=='ENDPOINT_TYPE_READ_WRITE']; print(rw[0]['name'] if rw else '')")
[ -n "$ENDPOINT" ] || die "read-write エンドポイントが見つかりません (branch: ${postgres_branch})"
# 作成直後は hosts が未割当てのことがあるため短く待つ
PGHOST=""
for _ in 1 2 3 4 5 6; do
  PGHOST=$(db postgres get-endpoint "$ENDPOINT" -o json | jget "['status'].get('hosts',{}).get('host') or ''")
  [ -n "$PGHOST" ] && break
  sleep 10
done
[ -n "$PGHOST" ] || die "エンドポイント ${ENDPOINT} のホスト名が取得できません (provisioning 中?)"
info "endpoint: ${ENDPOINT##*/} (${PGHOST})"

PGUSER=$(db current-user me -o json | jget "['userName']")
PGTOKEN=$(db postgres generate-database-credential "$ENDPOINT" -o json | jget "['token']")
export PGHOST PGUSER PGPASSWORD="$PGTOKEN" PGDATABASE="$pg_db_name" PGSSLMODE=require PGPORT=5432

# --- 3. アプリの初回ブートストラップ待ち -----------------------------------------
log "3. wait for app bootstrap (Lakebase DDL/seed; timeout ${BOOTSTRAP_WAIT_SEC}s)"
deadline=$(( $(date +%s) + BOOTSTRAP_WAIT_SEC ))
until psql -tAX -c "SELECT 1 FROM cofee_shop.stores LIMIT 1" >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$deadline" ] || die "cofee_shop.stores ができません。
   アプリが起動して初回ブートストラップを完了したか確認してください:
     databricks apps logs ${app_name} --profile ${PROFILE}"
  sleep 10
done
info "cofee_shop スキーマ + seed 確認"

# --- 4. REPLICA IDENTITY FULL (CDC 必須・冪等) ----------------------------------
log "4. REPLICA IDENTITY FULL on 6 CDC source tables"
for t in stores orders order_items historical_orders customer_preferences staff; do
  psql -tAX -c "ALTER TABLE cofee_shop.${t} REPLICA IDENTITY FULL" >/dev/null
  info "cofee_shop.${t}"
done

# --- 5. Lakehouse Sync (CDF config) — DABs 非対応 --------------------------------
log "5. Lakehouse Sync (CDF config: ${cdf_config_id})"
if db postgres list-cdf-configs "$postgres_database" -o json | grep -q "\"${cdf_config_id}\""; then
  info "既に存在します (skip)"
else
  db postgres create-cdf-config "$postgres_database" "$catalog" "$schema" cofee_shop \
    --cdf-config-id "$cdf_config_id"
  info "created: ${catalog}.${schema} <- PG schema cofee_shop"
fi

# --- 6. 初回スナップショット待ち (lb_*_history 出現) ------------------------------
log "6. wait for initial CDC snapshot (lb_*_history; timeout ${CDC_WAIT_SEC}s)"
deadline=$(( $(date +%s) + CDC_WAIT_SEC ))
until databricks experimental aitools tools query \
    "SHOW TABLES IN ${catalog}.${schema}" --profile "$PROFILE" 2>/dev/null | grep -q lb_orders_history; do
  [ "$(date +%s)" -lt "$deadline" ] || die "lb_orders_history が ${catalog}.${schema} に現れません。
   CDF config と REPLICA IDENTITY を確認してください (初回スナップショットは分単位かかることがあります)"
  sleep 20
done
info "CDC 履歴テーブル確認"

# --- 7. Delta 側ビュー + menu_items ---------------------------------------------
log "7. Delta views + menu_items (tools/setup_delta.py)"
python3 tools/setup_delta.py --profile "$PROFILE" --catalog "$catalog" --schema "$schema"

# --- 8. アプリ SP への UC GRANT ---------------------------------------------------
log "8. UC grants for app SP (tools/grant_app_sp_uc.py)"
python3 tools/grant_app_sp_uc.py --profile "$PROFILE" --catalog "$catalog" --schema "$schema" --app-name "$app_name"

# --- 9. Genie スペース ID の記入 + app.yaml 再生成 + 再デプロイ -------------------
log "9. Genie space id -> databricks.yml -> app.yaml -> apps deploy"
PAGE=""
SPACE_ID=""
while : ; do
  if [ -n "$PAGE" ]; then
    RESP=$(databricks api get "/api/2.0/genie/spaces?page_token=${PAGE}" --profile "$PROFILE")
  else
    RESP=$(databricks api get "/api/2.0/genie/spaces" --profile "$PROFILE")
  fi
  SPACE_ID=$(printf '%s' "$RESP" | GENIE_TITLE="$genie_space_title" python3 -c "
import json,os,sys
d=json.load(sys.stdin)
m=[s['space_id'] for s in d.get('spaces',[]) if s.get('title')==os.environ['GENIE_TITLE']]
print(m[0] if m else '')")
  [ -n "$SPACE_ID" ] && break
  PAGE=$(printf '%s' "$RESP" | jget ".get('next_page_token') or ''")
  [ -n "$PAGE" ] || break
done
[ -n "$SPACE_ID" ] || die "Genie スペース '${genie_space_title}' が見つかりません。
   bundle deploy で genie_spaces リソースが作成されているか確認してください。
   (bundle で作れない環境では genie/genie_space.json から REST で手動作成できます。
    手順は README「再現デプロイ (DABs)」のフォールバック項を参照)"

if [ "${genie_space_id:-}" = "$SPACE_ID" ]; then
  info "genie_space_id は記入済み (${SPACE_ID}) — apps 再デプロイは skip"
else
  node tools/set_bundle_var.mjs genie_space_id "$SPACE_ID" ${TARGET:+-t "$TARGET"}
  node tools/render_app_yaml.mjs ${TARGET:+-t "$TARGET"}
  databricks apps deploy --profile "$PROFILE"
  info "GENIE_SPACE_ID=${SPACE_ID} でアプリを再デプロイしました"
fi

# --- 10. (任意) Unsplash API キー ------------------------------------------------
log "10. secret scope (${secret_scope})"
info "アプリ本体はシークレット不要。Unsplash キーは商品画像を再取得する場合のみ使用"
if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
  read -r -p "   Unsplash API キーをスコープに登録しますか? [y/N] " ans
  if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
    databricks secrets put-secret "$secret_scope" unsplash-access-key --profile "$PROFILE"
    info "登録しました: ${secret_scope}/unsplash-access-key"
  else
    info "skip"
  fi
else
  info "非対話モードのため skip (必要なら: databricks secrets put-secret ${secret_scope} unsplash-access-key)"
fi

# --- 完了サマリ ------------------------------------------------------------------
log "done"
APP_URL=$(db apps get "$app_name" -o json | jget ".get('url') or ''")
WS_HOST=$(databricks auth env --profile "$PROFILE" 2>/dev/null | jget "['env'].get('DATABRICKS_HOST') or ''" || true)
info "app:   ${APP_URL:-(databricks apps get ${app_name} で URL を確認)}"
info "genie: ${WS_HOST:-<workspace>}/genie/rooms/${SPACE_ID}"
info "ステータスページで Lakebase → Delta レプリケーションが STREAMING になることを確認してください"
