#!/usr/bin/env python3

import argparse
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import types
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision-root", required=True)
    return parser.parse_args()


def load_table_module(revision_root: Path):
    metrics_name = "desktop_env.evaluators.metrics"
    for package_name in ("desktop_env", "desktop_env.evaluators", metrics_name):
        package = types.ModuleType(package_name)
        package.__path__ = []
        sys.modules[package_name] = package

    utils_name = f"{metrics_name}.utils"
    utils = types.ModuleType(utils_name)

    def unavailable_utility(*_args, **_kwargs):
        raise AssertionError("Unexpected OSWorld utility call in freeze-only probe")

    for name in (
        "_match_value_to_rule",
        "_read_cell_style",
        "read_cell_value",
        "load_charts",
        "load_sparklines",
        "load_rows_or_cols",
        "load_xlsx_styles",
        "load_filters",
        "load_pivot_tables",
    ):
        setattr(utils, name, unavailable_utility)
    sys.modules[utils_name] = utils

    module_name = f"{metrics_name}.table"
    module_path = revision_root / "desktop_env/evaluators/metrics/table.py"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load evaluator module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def main():
    args = parse_args()
    revision_root = Path(args.revision_root).resolve()
    sys.path.insert(0, str(revision_root))

    captured = io.StringIO()
    with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
        from openpyxl import Workbook

        compare_table = load_table_module(revision_root).compare_table

        with tempfile.TemporaryDirectory(prefix="grader-conform-osworld-") as temporary:
            root = Path(temporary)
            expected_path = root / "expected.xlsx"
            result_path = root / "result.xlsx"

            expected = Workbook()
            expected.active.freeze_panes = "B2"
            expected.active.sheet_view.pane.topLeftCell = "B2"
            expected.save(expected_path)

            result = Workbook()
            result.active.freeze_panes = "B2"
            result.active.sheet_view.pane.topLeftCell = "F9"
            result.save(result_path)

            score = compare_table(
                str(result_path),
                str(expected_path),
                rules=[
                    {
                        "type": "freeze",
                        "sheet_idx0": "RI0",
                        "sheet_idx1": "EI0",
                    }
                ],
            )

    print(
        json.dumps(
            {
                "schema_version": "1.0",
                "relation_holds": score == 1.0,
                "observations": {
                    "metric_score": score,
                    "frozen_split": {"x": 1, "y": 1},
                    "expected_top_left_cell": "B2",
                    "transformed_top_left_cell": "F9",
                },
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
