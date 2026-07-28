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


def load_module(revision_root: Path):
    if "PyPDF2" not in sys.modules:
        pdf_stub = types.ModuleType("PyPDF2")

        class UnavailablePdfReader:
            def __init__(self, *_args, **_kwargs):
                raise AssertionError("Unexpected PDF path in sequential-import probe")

        pdf_stub.PdfReader = UnavailablePdfReader
        sys.modules["PyPDF2"] = pdf_stub

    module_path = revision_root / "desktop_env/evaluators/metrics/vscode.py"
    spec = importlib.util.spec_from_file_location("grader_conform_vscode_metric", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load evaluator module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_task(root: Path, expected_value: str):
    root.mkdir()
    (root / "settings.py").write_text(
        f"VALUE = {expected_value!r}\n",
        encoding="utf8",
    )
    test_path = root / "test_suite.py"
    test_path.write_text(
        "from settings import VALUE\n\n"
        f"def test():\n    return VALUE == {expected_value!r}\n",
        encoding="utf8",
    )
    return test_path


def main():
    args = parse_args()
    revision_root = Path(args.revision_root).resolve()

    captured = io.StringIO()
    with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
        module = load_module(revision_root)
        sys.modules.pop("settings", None)
        with tempfile.TemporaryDirectory(prefix="grader-conform-osworld-import-") as temporary:
            root = Path(temporary)
            first_test = write_task(root / "first", "first-task")
            second_test = write_task(root / "second", "second-task")
            first_score = module.check_python_file_by_test_suite([], str(first_test))
            cached_after_first = "settings" in sys.modules
            second_score = module.check_python_file_by_test_suite([], str(second_test))
            cached_after_second = "settings" in sys.modules
        sys.modules.pop("settings", None)

    scores = [first_score, second_score]
    print(
        json.dumps(
            {
                "schema_version": "1.0",
                "relation_holds": scores == [1.0, 1.0],
                "observations": {
                    "sequential_scores": scores,
                    "shared_module_cached_after_first": cached_after_first,
                    "shared_module_cached_after_second": cached_after_second,
                },
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
