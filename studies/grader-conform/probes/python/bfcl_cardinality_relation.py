#!/usr/bin/env python3

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision-root", required=True)
    return parser.parse_args()


def write_jsonl(path, rows):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def main():
    args = parse_args()
    revision_root = Path(args.revision_root).resolve()
    benchmark_root = revision_root / "berkeley-function-call-leaderboard"
    checker = benchmark_root / "openfunctions_executable_checker.py"

    with tempfile.TemporaryDirectory(prefix="grader-conform-bfcl-") as temporary:
        cwd = Path(temporary)
        shutil.copytree(benchmark_root / "data", cwd / "data", copy_function=os.link)
        (cwd / "function_credential_config.json").write_text("[]\n", encoding="utf-8")
        write_jsonl(cwd / "eval_data_total.json", [{"question_type": "executable_probe"}])
        write_jsonl(
            cwd / "gorilla_probe_predictions.jsonl",
            [
                {
                    "text": [
                        "calculate_triangle_area(base=2,height=3)",
                        "math_factorial(n=3)",
                    ]
                }
            ],
        )
        write_jsonl(
            cwd / "data" / "gorilla_openfunctions_v1_test_executable_probe.json",
            [
                {
                    "execution_result": [3.0, 7],
                    "execution_result_type": "exact_match",
                }
            ],
        )

        completed = subprocess.run(
            [
                sys_executable(),
                str(checker),
                "--model_name",
                "offline-probe",
                "--test_category",
                "executable_probe",
                "--input_file",
                str(cwd / "gorilla_probe_predictions.jsonl"),
            ],
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
        )

    combined_output = f"{completed.stdout}\n{completed.stderr}"
    match = re.search(r"success rate:\s*([0-9.]+)", combined_output)
    success_rate = float(match.group(1)) if match else None
    execution_ok = completed.returncode == 0 and success_rate is not None
    invalid_response_rejected = execution_ok and success_rate == 0.0

    print(
        json.dumps(
            {
                "schema_version": "1.0",
                "relation_holds": invalid_response_rejected,
                "observations": {
                    "checker_exit_code": completed.returncode,
                    "invalid_response_success_rate": success_rate,
                    "output_tail": combined_output[-1000:],
                },
            },
            sort_keys=True,
        )
    )


def sys_executable():
    import sys

    return sys.executable


if __name__ == "__main__":
    main()
