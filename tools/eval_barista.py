# /// script
# requires-python = ">=3.11"
# dependencies = ["mlflow>=3.2"]
# ///
"""Offline eval harness for the barista agent (MLflow genai evaluate).

Scored on a golden dataset of 10 barista scenarios (eval_barista_golden.json):
recommendation under an allergy constraint, calorie-capped set building,
reorder flow, memory recall / memory-save consent, staff-only refusal,
order confirmation flow, store discovery, nutrition lookups.

Scorers (pitfall #2 mitigation: every scorer returns an explicitly typed
NUMERIC value so feedback is aggregated — the MLflow docs recommend
specifying feedback_value_type because judge-inferred types can be dropped
from aggregation; this harness had a real incident with bool feedback):
  1. tool_call_correctness (@scorer, deterministic) — required tools were
     called, forbidden tools were not, and tool-arg constraints hold
     (e.g. search_menu ran with exclude_allergens containing "milk",
     recommend_set ran with max_calories <= 500).
  2. response_requirements (@scorer, deterministic) — must_mention strings
     (e.g. "kcal") appear in the response text.
  3. rubric_compliance (make_judge LLM judge, feedback_value_type=float) —
     per-scenario rubric from the dataset, scored 0.0-1.0. Skipped in
     --smoke mode (needs a real judge endpoint).

Modes:
  npm run eval         full run — needs the app running locally
                       (BARISTA_EVAL_BASE_URL, default http://localhost:8000)
                       and Databricks auth (DATABRICKS_CONFIG_PROFILE).
                       Against the DEPLOYED app instead: pass --base-url
                       https://<app-url> plus --auth-token <sso token>
                       (or BARISTA_EVAL_AUTH_TOKEN).
  npm run eval:smoke   hermetic dry-run — canned outputs from the dataset,
                       local file store, deterministic scorers only, asserts
                       aggregation. No workspace, no app, no LLM calls.

Read-only by design: the 10 scenarios never require a mutating tool to
succeed (order placement is tested as a refusal/confirmation flow), and the
only workspace write is the evaluation run + judge traces logged to the
experiment. No UC DDL anywhere (pitfall #3: CREATE OR REPLACE drops grants —
this script creates nothing in UC).
"""
import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
GOLDEN_PATH = ROOT / 'tools' / 'eval_barista_golden.json'
# Smoke mode writes to a local sqlite tracking store (the filesystem store is
# in maintenance mode as of MLflow 3.16 and refuses new use).
SMOKE_STORE = ROOT / 'mlflow-eval-smoke.db'

DEFAULT_EXPERIMENT = '/Shared/daiwt-coffee-shop-barista'
DEFAULT_JUDGE_MODEL = 'databricks:/databricks-meta-llama-3-3-70b-instruct'

DETERMINISTIC_SCORERS = ('tool_call_correctness', 'response_requirements')


def load_scenarios() -> list[dict]:
    scenarios = json.loads(GOLDEN_PATH.read_text(encoding='utf-8'))
    ids = [s['id'] for s in scenarios]
    assert len(ids) == len(set(ids)), 'duplicate scenario ids in golden dataset'
    return scenarios


# ---------------------------------------------------------------------------
# predict_fn: one chat turn against the running app (or canned in smoke mode)
# ---------------------------------------------------------------------------

def chat_turn(base_url: str, message: str, auth_token: str | None = None, timeout: int = 180) -> dict:
    """POST /api/agents/chat and fold the SSE stream into a compact result.

    tool_calls capture the agent's INTENT (function_call items), which is what
    the forbidden-tools check wants: a gated place_order shows up here even
    though the human-approval gate blocks its execution.
    """
    headers = {'Content-Type': 'application/json', 'Accept': 'text/event-stream'}
    if auth_token:
        headers['Authorization'] = f'Bearer {auth_token}'
    req = urllib.request.Request(
        f'{base_url}/api/agents/chat',
        data=json.dumps({'message': message, 'agent': 'barista'}).encode(),
        headers=headers,
        method='POST',
    )
    text_parts: list[str] = []
    tool_calls: list[dict] = []
    approval_pending: list[dict] = []
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:
            line = raw.decode('utf-8', 'replace').strip()
            if not line.startswith('data:'):
                continue
            data = line[5:].strip()
            if not data or data == '[DONE]':
                continue
            try:
                ev = json.loads(data)
            except json.JSONDecodeError:
                continue
            ev_type = ev.get('type')
            if ev_type == 'response.output_text.delta' and isinstance(ev.get('delta'), str):
                text_parts.append(ev['delta'])
            elif ev_type == 'response.output_item.added':
                item = ev.get('item') or {}
                if item.get('type') == 'function_call' and item.get('name'):
                    args = item.get('arguments')
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except json.JSONDecodeError:
                            args = {}
                    tool_calls.append({'name': item['name'], 'args': args or {}})
            elif ev_type == 'appkit.approval_pending':
                approval_pending.append({'name': ev.get('tool_name'), 'args': ev.get('args')})
    return {
        'response': ''.join(text_parts),
        'tool_calls': tool_calls,
        'approval_pending': approval_pending,
    }


def make_predict_fn(base_url: str | None, smoke_outputs: dict[str, dict], auth_token: str | None = None):
    def predict_fn(message: str, scenario_id: str) -> dict:
        if base_url is None:  # smoke mode: canned, hermetic
            return smoke_outputs[scenario_id]
        return chat_turn(base_url, message, auth_token)

    return predict_fn


# ---------------------------------------------------------------------------
# Scorers
# ---------------------------------------------------------------------------

def match_where(args: dict, where: dict) -> bool:
    for key, cond in where.items():
        value = args.get(key)
        if 'eq' in cond and value != cond['eq']:
            return False
        if 'contains' in cond and (not isinstance(value, list) or cond['contains'] not in value):
            return False
        if 'lte' in cond and (not isinstance(value, (int, float)) or value > cond['lte']):
            return False
        if 'gte' in cond and (not isinstance(value, (int, float)) or value < cond['gte']):
            return False
    return True


def build_deterministic_scorers():
    from mlflow.entities import Feedback
    from mlflow.genai.scorers import scorer

    @scorer
    def tool_call_correctness(outputs: dict, expectations: dict) -> Feedback:
        tool_calls = (outputs or {}).get('tool_calls', [])
        names = [t['name'] for t in tool_calls]
        failures: list[str] = []
        for name in expectations.get('expected_tools', []):
            if name not in names:
                failures.append(f'expected tool "{name}" was not called (got: {names})')
        any_of = expectations.get('expected_any_of')
        if any_of and not any(all(t in names for t in alternative) for alternative in any_of):
            failures.append(f'none of the acceptable tool sets were called: {any_of} (got: {names})')
        for name in expectations.get('forbidden_tools', []):
            if name in names:
                failures.append(f'forbidden tool "{name}" was called')
        for spec in expectations.get('tool_args', []):
            if not any(t['name'] == spec['tool'] and match_where(t['args'], spec['where']) for t in tool_calls):
                failures.append(f'no {spec["tool"]} call satisfied {spec["where"]}')
        return Feedback(value=1.0 if not failures else 0.0, rationale='all checks passed' if not failures else '; '.join(failures))

    @scorer
    def response_requirements(outputs: dict, expectations: dict) -> Feedback:
        text = (outputs or {}).get('response') or ''
        missing = [s for s in expectations.get('must_mention', []) if s not in text]
        return Feedback(
            value=1.0 if not missing else 0.0,
            rationale='all required mentions present' if not missing else f'missing from response: {missing}',
        )

    return [tool_call_correctness, response_requirements]


def build_judge(model: str):
    from mlflow.genai.judges import make_judge

    return make_judge(
        name='rubric_compliance',
        instructions=(
            'あなたはコーヒーショップのバリスタAIエージェントを採点する厳格な審査員です。'
            'エージェントの応答 {{ outputs }} が、シナリオの期待値 {{ expectations }} に含まれる '
            'judge_rubric の基準をどの程度満たすかを、0.0(全く満たさない)〜1.0(完全に満たす)の'
            '小数で採点してください。0.5 などの中間値も使い、部分的な適合を区別すること。'
            'rubric に書かれていない観点では減点しないこと。'
        ),
        model=model,
        # Pitfall #2: leave the judge's value type to inference and bool-typed
        # feedback can be silently dropped from run-level aggregation. Pin a
        # numeric type so the score always aggregates in the eval UI.
        feedback_value_type=float,
    )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--smoke', action='store_true', help='hermetic dry-run: canned outputs, local file store, no LLM judge')
    parser.add_argument('--base-url', default=os.environ.get('BARISTA_EVAL_BASE_URL', 'http://localhost:8000'))
    parser.add_argument('--experiment', default=os.environ.get('BARISTA_EVAL_EXPERIMENT') or os.environ.get('MLFLOW_EXPERIMENT_NAME') or DEFAULT_EXPERIMENT)
    parser.add_argument('--judge-model', default=os.environ.get('BARISTA_EVAL_JUDGE_MODEL', DEFAULT_JUDGE_MODEL))
    parser.add_argument('--tracking-uri', default=os.environ.get('MLFLOW_TRACKING_URI', 'databricks'))
    parser.add_argument('--limit', type=int, default=0, help='run only the first N scenarios')
    parser.add_argument('--auth-token', default=os.environ.get('BARISTA_EVAL_AUTH_TOKEN'),
                        help='Bearer token for a deployed app (SSO). Not needed for local dev.')
    args = parser.parse_args()

    import mlflow

    scenarios = load_scenarios()
    if args.limit:
        scenarios = scenarios[: args.limit]
    print(f'{len(scenarios)} scenarios from {GOLDEN_PATH.name}')

    if args.smoke:
        tracking_uri = f'sqlite:///{SMOKE_STORE}'
        base_url = None
        scorers = build_deterministic_scorers()
        print(f'[smoke] tracking_uri={tracking_uri} (local sqlite store), judge skipped')
    else:
        tracking_uri = args.tracking_uri
        base_url = args.base_url
        scorers = [*build_deterministic_scorers(), build_judge(args.judge_model)]
        try:
            health_headers = {'Authorization': f'Bearer {args.auth_token}'} if args.auth_token else {}
            health_req = urllib.request.Request(f'{base_url}/api/stores', headers=health_headers)
            with urllib.request.urlopen(health_req, timeout=10) as resp:
                if resp.status != 200:
                    raise RuntimeError(f'status {resp.status}')
        except (urllib.error.URLError, RuntimeError) as e:
            print(f'error: app not reachable at {base_url} ({e}). Start it with `npm run dev` first.', file=sys.stderr)
            return 2
        print(f'app: {base_url}  judge: {args.judge_model}')

    mlflow.set_tracking_uri(tracking_uri)
    mlflow.set_experiment(args.experiment)
    print(f'experiment: {args.experiment}')

    records = [
        {'inputs': {'message': s['input'], 'scenario_id': s['id']}, 'expectations': s['expectations']}
        for s in scenarios
    ]
    predict_fn = make_predict_fn(base_url, {s['id']: s['smoke_output'] for s in scenarios}, args.auth_token)

    results = mlflow.genai.evaluate(data=records, predict_fn=predict_fn, scorers=scorers)
    metrics = results.metrics or {}
    print('\naggregated metrics:')
    for key, value in sorted(metrics.items()):
        print(f'  {key}: {value}')

    if args.smoke:
        # Gate: smoke must prove (a) every canned scenario passes the
        # deterministic scorers and (b) the scores AGGREGATE into run metrics
        # (the pitfall #2 failure mode is silent absence here).
        failures = []
        for name in DETERMINISTIC_SCORERS:
            key = next((k for k in metrics if k.startswith(name)), None)
            if key is None:
                failures.append(f'{name}: no aggregated metric found (aggregation broken)')
            elif metrics[key] != 1.0:
                failures.append(f'{name}: mean {metrics[key]} != 1.0 in hermetic run')
        if failures:
            print('\nsmoke FAILED:', file=sys.stderr)
            for f in failures:
                print(f'  - {f}', file=sys.stderr)
            return 1
        print('\nsmoke OK: dataset valid, deterministic scorers aggregate, all canned scenarios pass')
    else:
        print('\nview results: workspace MLflow UI -> experiment -> Evaluations tab')
    return 0


if __name__ == '__main__':
    sys.exit(main())
