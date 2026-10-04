#!/usr/bin/env python3
"""Shared helpers for the tools/*.py scripts.

databricks.yml is the single source of truth for environment parameters.
These helpers resolve its bundle variables (global defaults + target
overrides + nested ${var.*}) via tools/bundle_vars.mjs so the python tools
do not hardcode workspace-specific values. CLI arguments always win over
bundle variables.

Requires node + `npm install` (bundle_vars.mjs uses the yaml package).
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def bundle_vars(target: str | None = None) -> dict:
    cmd = ['node', str(ROOT / 'tools' / 'bundle_vars.mjs')]
    if target:
        cmd += ['-t', target]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    if r.returncode != 0:
        print(
            f'FAILED: {" ".join(cmd)}\n{r.stdout}{r.stderr}\n'
            '(node と npm install が必要です。bundle_vars.mjs は databricks.yml を解決します)',
            file=sys.stderr,
        )
        sys.exit(1)
    return json.loads(r.stdout)


def add_common_args(ap: argparse.ArgumentParser) -> None:
    ap.add_argument(
        '--profile',
        default=os.environ.get('DATABRICKS_CONFIG_PROFILE'),
        help='Databricks CLI プロファイル (省略時: DATABRICKS_CONFIG_PROFILE)',
    )
    ap.add_argument(
        '-t',
        '--target',
        default=None,
        help='変数解決に使う databricks.yml のターゲット (省略時: default: true のターゲット)',
    )


def resolve(args: argparse.Namespace, *names: str) -> None:
    """Fill unset CLI args from databricks.yml bundle variables; exit if still missing."""
    if not args.profile:
        print(
            'ERROR: --profile <PROFILE> が必要です (または DATABRICKS_CONFIG_PROFILE を設定)',
            file=sys.stderr,
        )
        sys.exit(2)
    vars_: dict | None = None
    for name in names:
        if getattr(args, name, None) in (None, ''):
            if vars_ is None:
                vars_ = bundle_vars(args.target)
            value = vars_.get(name)
            if value in (None, ''):
                print(
                    f'ERROR: --{name.replace("_", "-")} が未指定で、databricks.yml の variables.{name} も未設定です',
                    file=sys.stderr,
                )
                sys.exit(2)
            setattr(args, name, value)
