#!/usr/bin/env python3
"""Apply regenerated seed data (Japanese names/categories, JPY prices) to Lakebase.

Batch-updates cofee_shop.menu_items from server/seed/menu_items.json by SKU
(names, categories, descriptions, prices, currency) and NULLs the embedding
column so the app re-backfills embeddings from the Japanese text on next boot.
Store master currency is unified to JPY. historical_orders has no amount
column, so there is nothing to update there (revenue derives from menu prices).

Idempotent; safe to re-run. Uses the caller's identity (must be global staff).

  python3 tools/refresh_menu_data.py [--profile fevm-konomi-demo]
"""
import argparse
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
EP = 'projects/konomi-coffee-shop/branches/production/endpoints/primary'
CHUNK = 100


def cli_json(*args: str, profile: str):
    r = subprocess.run(['databricks', *args, '--profile', profile, '-o', 'json'],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        print(f'FAILED: databricks {" ".join(args)}\n{r.stdout}{r.stderr}', file=sys.stderr)
        sys.exit(1)
    return json.loads(r.stdout)


def psql(sql: str, host: str, token: str, user: str) -> str:
    r = subprocess.run(
        ['psql', f'host={host} user={user} dbname=databricks_postgres sslmode=require', '-v', 'ON_ERROR_STOP=1', '-c', sql],
        capture_output=True, text=True, timeout=300,
        env={'PGPASSWORD': token, 'PATH': '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin'},
    )
    if r.returncode != 0:
        print(f'PSQL FAILED: {sql[:200]}\n{r.stderr}', file=sys.stderr)
        sys.exit(1)
    return r.stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--profile', default='fevm-konomi-demo')
    ap.add_argument('--user', default='konomi.omae@databricks.com')
    args = ap.parse_args()

    host = cli_json('postgres', 'get-endpoint', EP, profile=args.profile)['status']['hosts']['host']
    token = cli_json('postgres', 'generate-database-credential', EP, profile=args.profile)['token']

    items = json.loads((ROOT / 'server/seed/menu_items.json').read_text())
    print(f'updating {len(items)} menu rows from regenerated seed...')
    for i in range(0, len(items), CHUNK):
        batch = items[i : i + CHUNK]
        payload = json.dumps([
            {k: m[k] for k in (
                'sku', 'item_name', 'category', 'description', 'price',
                'calories_kcal', 'protein_g', 'fat_g',
                'contains_milk', 'contains_egg', 'contains_wheat', 'contains_nuts',
                'alt_milk_options', 'scenes', 'is_classic', 'is_new', 'is_seasonal', 'target_tags',
            )}
            for m in batch
        ], ensure_ascii=False)
        # psql has no parameter binding via -c; inline the JSON safely via dollar-quoting
        psql(
            "UPDATE cofee_shop.menu_items AS m "
            "SET item_name = v.item_name, category = v.category, description = v.description, "
            "    price = v.price, currency = 'JPY', embedding = NULL, updated_at = now(), "
            "    calories_kcal = v.calories_kcal, protein_g = v.protein_g, fat_g = v.fat_g, "
            "    contains_milk = v.contains_milk, contains_egg = v.contains_egg, "
            "    contains_wheat = v.contains_wheat, contains_nuts = v.contains_nuts, "
            "    alt_milk_options = v.alt_milk_options, scenes = v.scenes, "
            "    is_classic = v.is_classic, is_new = v.is_new, is_seasonal = v.is_seasonal, "
            "    target_tags = v.target_tags "
            "FROM jsonb_to_recordset($payload$" + payload.replace('$payload$', '') + "$payload$::jsonb) "
            "AS v(sku text, item_name text, category text, description text, price numeric, "
            "     calories_kcal int, protein_g numeric, fat_g numeric, "
            "     contains_milk boolean, contains_egg boolean, contains_wheat boolean, contains_nuts boolean, "
            "     alt_milk_options text, scenes text, "
            "     is_classic boolean, is_new boolean, is_seasonal boolean, target_tags text) "
            "WHERE m.sku = v.sku",
            host, token, args.user,
        )
        print(f'  updated {min(i + CHUNK, len(items))}/{len(items)}')

    print('unifying store currency to JPY...')
    psql("UPDATE cofee_shop.stores SET currency = 'JPY'", host, token, args.user)

    out = psql(
        "SELECT count(*) FILTER (WHERE currency <> 'JPY') AS non_jpy, "
        "count(*) FILTER (WHERE embedding IS NULL) AS null_embeddings, count(*) AS total "
        "FROM cofee_shop.menu_items",
        host, token, args.user,
    )
    print(out)
    print('done. Redeploy the app to re-backfill embeddings from the Japanese text.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
