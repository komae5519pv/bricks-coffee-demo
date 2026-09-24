#!/usr/bin/env python3
"""Grant the app's service principal UC read access for the status page.

The status page runs Delta queries (Lakebase<->Delta sync state) through the
Statement Execution API as the app SP. The sql-warehouse resource only grants
CAN_USE on the warehouse — UC data permissions are separate and must be
granted once after the app is first created:

  python3 tools/grant_app_sp_uc.py [--profile fevm-konomi-demo]

Idempotent (GRANT is additive).
"""
import argparse
import json
import subprocess
import sys

CATALOG = 'konomi_demo_catalog'
SCHEMA = 'cofee_shop'
APP_NAME = 'daiwt-coffee-shop'


def cli(*args: str, profile: str) -> str:
    r = subprocess.run(['databricks', *args, '--profile', profile], capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        print(f'FAILED: databricks {" ".join(args)}\n{r.stdout}{r.stderr}', file=sys.stderr)
        sys.exit(1)
    return r.stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--profile', default='fevm-konomi-demo')
    args = ap.parse_args()

    app = json.loads(cli('apps', 'get', APP_NAME, '-o', 'json', profile=args.profile))
    sp = app['service_principal_client_id']
    print(f'app SP: {sp}')

    for sql in [
        f'GRANT USE CATALOG ON CATALOG {CATALOG} TO `{sp}`',
        f'GRANT USE SCHEMA ON SCHEMA {CATALOG}.{SCHEMA} TO `{sp}`',
        f'GRANT SELECT ON SCHEMA {CATALOG}.{SCHEMA} TO `{sp}`',
    ]:
        print('==', sql)
        cli('experimental', 'aitools', 'tools', 'query', sql, profile=args.profile)
    print('done.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
