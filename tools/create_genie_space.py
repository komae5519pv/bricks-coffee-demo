#!/usr/bin/env python3
"""Create the BRICKS COFFEE Genie space from the exported definition (genie/genie_space.json).

Fallback for environments where the bundle genie_spaces resource is not
available — post_deploy.sh normally wires the bundle-created space instead.

  python3 tools/create_genie_space.py --profile <PROFILE> [-t TARGET] [--dry-run]

Placeholders in genie/genie_space.json (__UC_CATALOG__ etc.) are filled from
databricks.yml bundle variables (CLI flags override). After creation the new
space ID is written back to databricks.yml (targets.<t>.variables.genie_space_id)
and app.yaml is re-rendered, so `databricks apps deploy` picks it up.
"""
import argparse
import json
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from bundle_defaults import ROOT, add_common_args, bundle_vars, resolve  # noqa: E402


def cli(*args: str, profile: str) -> str:
    r = subprocess.run(['databricks', *args, '--profile', profile], capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        print(f'FAILED: databricks {" ".join(args)}\n{r.stdout}{r.stderr}', file=sys.stderr)
        sys.exit(1)
    return r.stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    add_common_args(ap)
    ap.add_argument('--catalog', default=None)
    ap.add_argument('--schema', default=None)
    ap.add_argument('--warehouse-id', dest='warehouse_id', default=None)
    ap.add_argument('--title', dest='genie_space_title', default=None)
    ap.add_argument('--dry-run', action='store_true', help='POST せずリクエストボディを表示')
    args = ap.parse_args()
    resolve(args, 'catalog', 'schema', 'warehouse_id', 'genie_space_title')
    p = args.profile

    me = json.loads(cli('current-user', 'me', '-o', 'json', profile=p))['userName']
    vars_ = bundle_vars(args.target)
    demo_email = vars_.get('demo_user_email') or ''
    if demo_email.startswith('${'):  # e.g. ${workspace.current_user.userName}
        demo_email = me

    body = json.loads((ROOT / 'genie' / 'genie_space.json').read_text())
    s = json.dumps(body['serialized_space'], ensure_ascii=False)
    s = (
        s.replace('__UC_CATALOG__', args.catalog)
        .replace('__UC_SCHEMA__', args.schema)
        .replace('__DEMO_USER_EMAIL__', demo_email)
    )
    body.update(
        serialized_space=s,
        warehouse_id=args.warehouse_id,
        parent_path=f'/Workspace/Users/{me}',
        title=args.genie_space_title,
    )
    payload = json.dumps(body, ensure_ascii=False)

    if args.dry_run:
        print(payload)
        return 0

    resp = json.loads(cli('api', 'post', '/api/2.0/genie/spaces', '--json', payload, profile=p))
    space_id = resp.get('space_id') or resp.get('id') or ''
    if not space_id:
        print(f'ERROR: レスポンスに space_id がありません:\n{json.dumps(resp, indent=2)}', file=sys.stderr)
        sys.exit(1)
    print(f'created Genie space: {space_id} ({args.genie_space_title})')

    for cmd in (
        ['node', str(ROOT / 'tools' / 'set_bundle_var.mjs'), 'genie_space_id', space_id]
        + (['-t', args.target] if args.target else []),
        ['node', str(ROOT / 'tools' / 'render_app_yaml.mjs')] + (['-t', args.target] if args.target else []),
    ):
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        if r.returncode != 0:
            print(r.stderr, file=sys.stderr)
            sys.exit(1)
    print('databricks.yml に genie_space_id を記入し app.yaml を再生成しました。')
    print('反映には `databricks apps deploy --profile <PROFILE>` (引数なし) を実行してください。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
