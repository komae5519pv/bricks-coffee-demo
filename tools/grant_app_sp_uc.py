#!/usr/bin/env python3
"""Grant the app's service principal UC read access for the status page.

The status page runs Delta queries (Lakebase<->Delta sync state) through the
Statement Execution API as the app SP. The sql-warehouse resource only grants
CAN_USE on the warehouse — UC data permissions are separate and must be
granted once after the app is first created:

  python3 tools/grant_app_sp_uc.py --profile <PROFILE> [--catalog C] [--schema S] [--app-name A] [-t TARGET]

catalog/schema/app-name default to databricks.yml bundle variables (single
source of truth); CLI arguments override them. See tools/bundle_defaults.py.

Idempotent (GRANT is additive).
"""
import argparse
import json
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from bundle_defaults import add_common_args, resolve  # noqa: E402


def cli(*args: str, profile: str) -> str:
    r = subprocess.run(['databricks', *args, '--profile', profile], capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        print(f'FAILED: databricks {" ".join(args)}\n{r.stdout}{r.stderr}', file=sys.stderr)
        sys.exit(1)
    return r.stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    add_common_args(ap)
    ap.add_argument('--catalog', default=None, help='UC カタログ (省略時: databricks.yml の variables.catalog)')
    ap.add_argument('--schema', default=None, help='UC スキーマ (省略時: databricks.yml の variables.schema)')
    ap.add_argument('--app-name', default=None, help='アプリ名 (省略時: databricks.yml の variables.app_name)')
    args = ap.parse_args()
    resolve(args, 'catalog', 'schema', 'app_name')

    app = json.loads(cli('apps', 'get', args.app_name, '-o', 'json', profile=args.profile))
    sp = app['service_principal_client_id']
    print(f'app SP: {sp}')

    catalog, schema = args.catalog, args.schema
    for sql in [
        f'GRANT USE CATALOG ON CATALOG {catalog} TO `{sp}`',
        f'GRANT USE SCHEMA ON SCHEMA {catalog}.{schema} TO `{sp}`',
        f'GRANT SELECT ON SCHEMA {catalog}.{schema} TO `{sp}`',
        # menu_items is a static Delta copy synced by the app on admin edits
        # (PG vector column keeps it out of CDC) — needs MODIFY, not just SELECT.
        f'GRANT MODIFY ON TABLE {catalog}.{schema}.menu_items TO `{sp}`',
    ]:
        print('==', sql)
        cli('experimental', 'aitools', 'tools', 'query', sql, profile=args.profile)
    print('done.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
