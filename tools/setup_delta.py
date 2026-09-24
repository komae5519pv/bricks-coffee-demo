#!/usr/bin/env python3
"""Set up the Delta-side objects for the Genie demo in konomi_demo_catalog.cofee_shop.

Run AFTER Lakehouse Sync (CDF config) is ONLINE:

  python3 tools/setup_delta.py [--profile fevm-konomi-demo]

Creates, in the UC schema:
  - views orders / order_items / customer_preferences / historical_orders / stores:
    "latest state" projections over the lb_*_history CDC tables (dedup by PK,
    deletes filtered out) so Genie sees clean current-state tables
  - table menu_items: a Delta copy of the Lakebase menu (the PG table has a
    vector(1024) column, unsupported by Lakehouse Sync, so the menu is
    materialized from server/seed/menu_items.json instead)
  - table comments used by Genie for semantics
"""
import argparse
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CATALOG = 'konomi_demo_catalog'
SCHEMA = 'cofee_shop'
FQ = f'{CATALOG}.{SCHEMA}'


def run_sql(sql: str, profile: str) -> None:
    r = subprocess.run(
        ['databricks', 'experimental', 'aitools', 'tools', 'query', sql, '--profile', profile],
        capture_output=True, text=True, timeout=600,
    )
    if r.returncode != 0:
        print(f'FAILED: {sql[:200]}\n{r.stdout}\n{r.stderr}', file=sys.stderr)
        sys.exit(1)


def latest_view(view: str, history: str, pk: str) -> str:
    return f"""
CREATE OR REPLACE VIEW {FQ}.{view} AS
SELECT * EXCEPT(_pg_change_type, _pg_lsn, _pg_xid, _timestamp, _sort_by, rn)
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY {pk} ORDER BY _pg_lsn DESC) AS rn
  FROM {FQ}.{history}
  WHERE _pg_change_type IN ('insert', 'update_postimage', 'delete')
)
WHERE rn = 1 AND _pg_change_type != 'delete'
"""


TABLE_COMMENTS = {
    'orders': 'ライブ注文(アプリからの現在の注文)。Lakebase の cofee_shop.orders が CDC で複製された最新状態ビュー。status: received→preparing→ready→done/cancelled',
    'order_items': 'ライブ注文の明細行。order_id で orders と結合。最新状態ビュー',
    'historical_orders': '過去の注文履歴(シードデータ・行単位の注文明細)。分析用',
    'customer_preferences': '顧客の嗜好設定。user_email ごとの preference_key/preference_value(例: milk_allergy=true は牛乳アレルギー)。提案時は必ずこの嗜好を考慮すること',
    'stores': '店舗マスタ。12か国・通貨/ロケール付き',
    'menu_items': '店舗別メニュー(SKU単位)。price は店舗通貨建て。active=true が販売中',
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--profile', default='fevm-konomi-demo')
    args = ap.parse_args()
    p = args.profile

    print('creating latest-state views...')
    run_sql(latest_view('orders', 'lb_orders_history', 'id'), p)
    run_sql(latest_view('order_items', 'lb_order_items_history', 'id'), p)
    run_sql(latest_view('customer_preferences', 'lb_customer_preferences_history', 'user_email, preference_key'), p)
    run_sql(latest_view('historical_orders', 'lb_historical_orders_history', 'row_id'), p)
    run_sql(latest_view('stores', 'lb_stores_history', 'store_id'), p)

    print('creating menu_items Delta table from seed...')
    seed = json.loads((ROOT / 'server/seed/menu_items.json').read_text())
    run_sql(f"""
CREATE OR REPLACE TABLE {FQ}.menu_items (
  sku STRING, store_id STRING, item_key STRING, item_name STRING, category STRING,
  size STRING, price DECIMAL(10,2), currency STRING, description STRING, active BOOLEAN
)
""", p)
    run_sql(f'DELETE FROM {FQ}.menu_items', p)

    def esc(v: object) -> str:
        if isinstance(v, bool):
            return 'true' if v else 'false'
        if isinstance(v, (int, float)):
            return str(v)
        return "'" + str(v).replace("'", "''") + "'"

    batch = 100
    for i in range(0, len(seed), batch):
        rows = seed[i : i + batch]
        values = ',\n'.join(
            '(' + ', '.join(esc(m[k]) for k in
                            ('sku', 'store_id', 'item_key', 'item_name', 'category', 'size', 'price', 'currency', 'description', 'active')) + ')'
            for m in rows
        )
        run_sql(
            f'INSERT INTO {FQ}.menu_items (sku, store_id, item_key, item_name, category, size, price, currency, description, active) VALUES\n{values}',
            p,
        )
        print(f'  inserted {min(i + batch, len(seed))}/{len(seed)}')

    print('adding table comments...')
    for table, comment in TABLE_COMMENTS.items():
        run_sql(f"COMMENT ON TABLE {FQ}.{table} IS '{comment}'", p)

    print('done.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
