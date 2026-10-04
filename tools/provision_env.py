#!/usr/bin/env python3
"""Provision the workspace resources for a first-time deploy (idempotent).

  python3 tools/provision_env.py --profile <PROFILE> [--catalog C] [--schema S]
                                 [--lakebase-project-id ID] [-t TARGET] [--dry-run]

Creates, only when missing (defaults come from databricks.yml bundle
variables; CLI arguments override them):
  1. UC catalog          — CREATE CATALOG IF NOT EXISTS (needs the metastore
                           privilege; skipped silently if it already exists)
  2. UC schema           — CREATE SCHEMA IF NOT EXISTS <catalog>.<schema>
  3. Lakebase project    — PG17, 1 CU fixed, default branch from
                           variables.lakebase_branch_id (matches
                           resources/lakebase.postgres.yml)

The DABs flow (`databricks bundle deploy`) creates 2+3 via bundle resources,
so this script is mainly for the manual setup path (README 「再デプロイ手順」)
and for checking that everything is in place. It never deletes anything.
"""
import argparse
import json
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from bundle_defaults import add_common_args, resolve  # noqa: E402


def cli(*args: str, profile: str, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run(
        ['databricks', *args, '--profile', profile],
        capture_output=True, text=True, timeout=600,
    )
    if check and r.returncode != 0:
        print(f'FAILED: databricks {" ".join(args)}\n{r.stdout}{r.stderr}', file=sys.stderr)
        sys.exit(1)
    return r


def run_sql(sql: str, profile: str) -> None:
    r = cli('experimental', 'aitools', 'tools', 'query', sql, profile=profile, check=False)
    if r.returncode != 0:
        print(f'FAILED: {sql}\n{r.stdout}{r.stderr}', file=sys.stderr)
        sys.exit(1)


def exists(*args: str, profile: str) -> bool:
    return cli(*args, profile=profile, check=False).returncode == 0


def main() -> int:
    ap = argparse.ArgumentParser()
    add_common_args(ap)
    ap.add_argument('--catalog', default=None, help='UC カタログ (省略時: databricks.yml)')
    ap.add_argument('--schema', default=None, help='UC スキーマ (省略時: databricks.yml)')
    ap.add_argument('--lakebase-project-id', default=None, help='Lakebase プロジェクト ID (省略時: databricks.yml)')
    ap.add_argument('--dry-run', action='store_true', help='作成は行わず、実行内容の表示だけ')
    args = ap.parse_args()
    resolve(args, 'catalog', 'schema', 'lakebase_project_id', 'lakebase_branch_id')
    p = args.profile
    dry = args.dry_run

    branch_path = f'projects/{args.lakebase_project_id}/branches/{args.lakebase_branch_id}'
    print(f'profile: {p} / UC: {args.catalog}.{args.schema} / Lakebase: projects/{args.lakebase_project_id}')

    # 1. UC catalog
    if exists('catalogs', 'get', args.catalog, profile=p):
        print(f'[skip] catalog {args.catalog} (exists)')
    else:
        sql = f'CREATE CATALOG IF NOT EXISTS {args.catalog}'
        print(f'[create] {sql}' + (' (dry-run)' if dry else ''))
        if not dry:
            r = cli('experimental', 'aitools', 'tools', 'query', sql, profile=p, check=False)
            if r.returncode != 0:
                print(
                    f'ERROR: カタログ {args.catalog} の作成に失敗しました。\n{r.stderr}\n'
                    'メタストアの CREATE CATALOG 権限が必要です。権限のある既存カタログを '
                    'databricks.yml の variables.catalog に指定してください。',
                    file=sys.stderr,
                )
                sys.exit(1)

    # 2. UC schema
    if exists('schemas', 'get', f'{args.catalog}.{args.schema}', profile=p):
        print(f'[skip] schema {args.catalog}.{args.schema} (exists)')
    else:
        sql = f'CREATE SCHEMA IF NOT EXISTS {args.catalog}.{args.schema}'
        print(f'[create] {sql}' + (' (dry-run)' if dry else ''))
        if not dry:
            run_sql(sql, p)

    # 3. Lakebase project
    if exists('postgres', 'get-project', f'projects/{args.lakebase_project_id}', profile=p):
        print(f'[skip] Lakebase project {args.lakebase_project_id} (exists)')
    else:
        spec = {
            'spec': {
                'display_name': 'BRICKS COFFEE',
                'pg_version': 17,
                # full resource path (API requirement, same as resources/lakebase.postgres.yml)
                'default_branch': branch_path,
                'default_endpoint_settings': {
                    'autoscaling_limit_min_cu': 1,
                    'autoscaling_limit_max_cu': 1,
                },
            }
        }
        print(f'[create] Lakebase project {args.lakebase_project_id} (PG17, 1 CU)' + (' (dry-run)' if dry else ''))
        if not dry:
            cli('postgres', 'create-project', args.lakebase_project_id, '--json', json.dumps(spec), profile=p)

    print('done.' + (' (dry-run: 変更なし)' if dry else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
