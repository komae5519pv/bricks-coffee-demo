# /// script
# requires-python = ">=3.11"
# dependencies = ["mlflow>=3.2", "databricks-agents>=1.0"]
# ///
"""Register production-monitoring scorers on the barista experiment.

Implements the databricks-mlflow-evaluation skill's Pattern 12: scorers are
(.register() + .start())-ed on the experiment so live traces (the ones the
app's TS tracing writes per chat turn) get assessments attached automatically,
asynchronously, on a sampled basis. The SQL warehouse runs the scheduled
monitoring job — we point it at the app's serverless warehouse.

Idempotent: an already-registered scorer name is re-started (with the new
sample rate) instead of failing. No UC DDL anywhere (pitfall #3: CREATE OR
REPLACE drops grants — this script creates nothing in UC).

Usage:
  uv run tools/register_monitoring.py \
      --tracking-uri databricks://fevm-konomi-demo \
      --warehouse-id 348478745ad64b30

Verify afterwards (assessments appear on NEW traces only — monitoring is not
retroactive): chat with the app, then poll
  POST /api/3.0/mlflow/traces/search  {"locations": [{"mlflow_experiment": {"experiment_id": "<ID>"}}]}
and check trace.assessments.
"""
import argparse

DEFAULT_EXPERIMENT = '/Shared/daiwt-coffee-shop-barista'

# Demo volume is a handful of chats — 100% sampling is cheap and makes the
# "every live trace gets judged" story deterministic on stage.
SAMPLE_RATE = 1.0


def build_scorer_specs():
    from mlflow.genai.scorers import Guidelines, Safety

    return [
        ('safety', Safety),
        (
            'barista_domain_rubric',
            lambda: Guidelines(
                name='barista_domain_rubric',
                guidelines=(
                    'コーヒーショップのバリスタAIとして: (1) ユーザーの言語に合わせて応答していること'
                    '(日本語の質問には日本語)。(2) 応答中の価格・カロリー等の数値が、トレース内の'
                    'ツール(search_menu等)の出力と矛盾していないこと(矛盾がなければツール経由とみなす)。'
                    '(3) スタッフ専用機能(注文ステータス更新等)を客には提供しないこと。'
                ),
            ),
        ),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--experiment', default=DEFAULT_EXPERIMENT)
    parser.add_argument('--warehouse-id', required=True, help='SQL warehouse that runs the monitoring job')
    parser.add_argument('--tracking-uri', default='databricks')
    parser.add_argument('--sample-rate', type=float, default=SAMPLE_RATE)
    args = parser.parse_args()

    import mlflow
    from mlflow.genai.scorers import ScorerSamplingConfig, get_scorer, list_scorers
    from mlflow.tracing import set_databricks_monitoring_sql_warehouse_id

    mlflow.set_tracking_uri(args.tracking_uri)
    mlflow.set_experiment(args.experiment)
    experiment_id = mlflow.get_experiment_by_name(args.experiment).experiment_id
    print(f'experiment: {args.experiment} (id {experiment_id})')

    # The monitoring job runs ON this warehouse (Pattern 12 step 1).
    # NB: the kwarg is sql_warehouse_id in mlflow 3.16 (the skill's
    # warehouse_id= example predates the rename).
    set_databricks_monitoring_sql_warehouse_id(sql_warehouse_id=args.warehouse_id, experiment_id=experiment_id)
    print(f'monitoring warehouse: {args.warehouse_id}')

    existing = {s.name for s in list_scorers()}
    print(f'already registered: {sorted(existing) or "none"}')

    sampling = ScorerSamplingConfig(sample_rate=args.sample_rate)
    for name, factory in build_scorer_specs():
        # CRITICAL (GOTCHAS): register() alone does not activate monitoring —
        # start() is what schedules the scorer against live traces.
        # Re-register on every run so guideline wording edits take effect
        # (same name registers a new version); fall back to the existing one.
        try:
            scorer = factory().register(name=name)
        except Exception as e:  # noqa: BLE001 — duplicate-name handling is server-version dependent
            print(f'  register({name}) fell back to existing ({e})')
            scorer = get_scorer(name=name)
        scorer.start(sampling_config=sampling)
        print(f'  started: {name}')

    print('\nregistered scorers (from list_scorers):')
    for sc in list_scorers():
        cfg = getattr(sc, 'sampling_config', None)
        rate = getattr(cfg, 'sample_rate', '?') if cfg else '?'
        print(f'  {sc.name}: sample_rate={rate}')
    print('\nmonitoring live. Assessments attach to NEW traces only (not retroactive).')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
