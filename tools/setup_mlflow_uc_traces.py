#!/usr/bin/env python3
"""One-time MLflow setup for the barista tracing demo (idempotent, safe to re-run).

  python3 tools/setup_mlflow_uc_traces.py [--profile fevm-konomi-demo]

Does:
  1. Creates the MLflow experiment (/Shared/daiwt-coffee-shop-barista) if missing.
     The app also auto-creates it on first traced turn; pre-creating here lets
     step 2 attach permissions deterministically.
  2. Grants the app's service principal CAN_MANAGE on the experiment (PATCH —
     additive, never PUT, which would replace the whole ACL and drop the
     owner's access). The deployed app authenticates AS the SP, and an
     experiment created by a human does not implicitly grant the SP write.
  3. Creates the UC schema reserved for UC-side trace storage
     (CREATE SCHEMA IF NOT EXISTS + explicit GRANTs).

Pitfall notes (from real incidents — kept here because this script is the
only UC-touching piece of the tracing story):

  #1 UC trace destination is producer-side. Linking an experiment to a UC
     schema is NOT enough for traces to land in UC; the process emitting the
     traces must select the UC destination. In Python:
         import mlflow
         from mlflow.tracing.destination import DatabricksTraceLocation
         mlflow.tracing.set_destination(DatabricksTraceLocation(
             catalog='konomi_demo_catalog', schema='cofee_shop_agent_traces'))
     The official mlflow-tracing TypeScript SDK (v0.1.3, used by the app) has
     NO equivalent API — so app traces go to the MLflow experiment only, and
     this script deliberately does NOT pretend otherwise. The schema below is
     preparation for a Python-side producer or a future TS SDK.

  #3 No CREATE OR REPLACE. Recreating a UC object silently drops its grants.
     Everything here is CREATE ... IF NOT EXISTS + separate GRANTs.

  #4 When reading traces back from UC tables, span inputs/outputs come back
     as JSON STRINGS, not dicts — always json.loads() them before use.
"""
import argparse
import json
import subprocess
import sys

EXPERIMENT_NAME = '/Shared/daiwt-coffee-shop-barista'
CATALOG = 'konomi_demo_catalog'
TRACE_SCHEMA = 'cofee_shop_agent_traces'
APP_NAME = 'daiwt-coffee-shop'


def run(args: list[str], capture: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=capture, text=True, timeout=120)


def host_and_token(profile: str) -> tuple[str, str]:
    r = run(['databricks', 'auth', 'token', '--profile', profile])
    if r.returncode != 0:
        print(f'FAILED: databricks auth token\n{r.stdout}\n{r.stderr}', file=sys.stderr)
        sys.exit(1)
    tok = json.loads(r.stdout)
    env = run(['databricks', 'auth', 'env', '--profile', profile])
    host_url = ''
    if env.returncode == 0:
        try:
            host_url = json.loads(env.stdout).get('env', {}).get('DATABRICKS_HOST', '')
        except json.JSONDecodeError:
            host_url = ''
    if not host_url:
        print('FAILED: could not resolve workspace host from `databricks auth env`', file=sys.stderr)
        sys.exit(1)
    return host_url.rstrip('/'), tok['access_token']


def api(method: str, host: str, token: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    cmd = ['curl', '-s', '-o', '-', '-w', '\n%{http_code}', '-X', method, '-H', f'Authorization: Bearer {token}']
    if body is not None:
        cmd += ['-H', 'Content-Type: application/json', '-d', json.dumps(body)]
    cmd.append(f'{host}{path}')
    r = run(cmd)
    lines = r.stdout.rsplit('\n', 1)
    payload = json.loads(lines[0]) if lines[0].strip() else {}
    return int(lines[1]), payload


def run_sql(sql: str, profile: str) -> None:
    r = subprocess.run(
        ['databricks', 'experimental', 'aitools', 'tools', 'query', sql, '--profile', profile],
        capture_output=True, text=True, timeout=600,
    )
    if r.returncode != 0:
        print(f'FAILED: {sql[:200]}\n{r.stdout}\n{r.stderr}', file=sys.stderr)
        sys.exit(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--profile', default='fevm-konomi-demo')
    ap.add_argument('--experiment', default=EXPERIMENT_NAME)
    ap.add_argument('--skip-uc', action='store_true', help='only do the experiment + SP grant steps (no UC DDL)')
    args = ap.parse_args()

    host, token = host_and_token(args.profile)
    print(f'workspace: {host}')

    # 1. experiment (get-by-name, create only if missing)
    from urllib.parse import quote

    status, body = api('GET', host, token, f'/api/2.0/mlflow/experiments/get-by-name?experiment_name={quote(args.experiment, safe="")}')
    experiment_id = (body.get('experiment') or {}).get('experiment_id')
    if status == 200 and experiment_id:
        print(f'experiment exists: {args.experiment} (id {experiment_id})')
    else:
        status, body = api('POST', host, token, '/api/2.0/mlflow/experiments/create', {'name': args.experiment})
        experiment_id = body.get('experiment_id')
        if status != 200 or not experiment_id:
            print(f'FAILED to create experiment: {status} {body}', file=sys.stderr)
            return 1
        print(f'created experiment: {args.experiment} (id {experiment_id})')

    # 2. app SP CAN_MANAGE on the experiment (PATCH = additive; PUT would
    # replace the entire ACL — same class of footgun as CREATE OR REPLACE)
    app = run(['databricks', 'apps', 'get', APP_NAME, '--profile', args.profile, '-o', 'json'])
    if app.returncode != 0:
        print(f'FAILED: databricks apps get {APP_NAME}\n{app.stdout}\n{app.stderr}', file=sys.stderr)
        return 1
    sp_id = json.loads(app.stdout).get('service_principal_client_id')
    if not sp_id:
        print('FAILED: app has no service_principal_client_id', file=sys.stderr)
        return 1
    status, body = api(
        'PATCH',
        host,
        token,
        f'/api/2.0/permissions/experiments/{experiment_id}',
        {'access_control_list': [{'service_principal_name': sp_id, 'permission_level': 'CAN_MANAGE'}]},
    )
    if status != 200:
        print(f'FAILED to grant SP on experiment: {status} {body}', file=sys.stderr)
        return 1
    print(f'granted CAN_MANAGE on experiment {experiment_id} to app SP {sp_id}')

    if args.skip_uc:
        print('skip-uc: stopping before UC DDL (experiment + SP grant done)')
        return 0

    # 3. UC schema for UC-side trace storage (see pitfall #1 above — nothing
    # writes here yet; CREATE IF NOT EXISTS + GRANTs only, never OR REPLACE)
    run_sql(f'CREATE SCHEMA IF NOT EXISTS {CATALOG}.{TRACE_SCHEMA}', args.profile)
    print(f'schema ready: {CATALOG}.{TRACE_SCHEMA}')
    run_sql(f'GRANT USE SCHEMA ON SCHEMA {CATALOG}.{TRACE_SCHEMA} TO `{sp_id}`', args.profile)
    run_sql(f'GRANT CREATE TABLE ON SCHEMA {CATALOG}.{TRACE_SCHEMA} TO `{sp_id}`', args.profile)
    print(f'granted USE SCHEMA + CREATE TABLE on {CATALOG}.{TRACE_SCHEMA} to {sp_id}')

    print('\ndone. Traces flow to the experiment today; UC destination needs a')
    print('producer-side set_destination call (pitfall #1 — see docstring).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
