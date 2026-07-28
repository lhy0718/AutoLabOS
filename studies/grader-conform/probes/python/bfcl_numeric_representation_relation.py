#!/usr/bin/env python3

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision-root", required=True)
    return parser.parse_args()


def load_checker(revision_root):
    benchmark_root = revision_root / "berkeley-function-call-leaderboard"
    checker_root = benchmark_root / "eval_checker"
    checker_path = checker_root / "checker.py"
    previous_cwd = Path.cwd()
    previous_sys_path = list(sys.path)

    try:
        os.chdir(checker_root)
        sys.path[:0] = [str(checker_root), str(benchmark_root)]
        spec = importlib.util.spec_from_file_location(
            "historical_bfcl_numeric_checker", checker_path
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        os.chdir(previous_cwd)
        sys.path[:] = previous_sys_path


def main():
    args = parse_args()
    checker = load_checker(Path(args.revision_root).resolve())
    function_name = "set_threshold"
    parameter_name = "threshold"
    canonical_value = 1.0
    equivalent_integer_spelling = 1
    function_description = {
        "name": function_name,
        "parameters": {
            "properties": {parameter_name: {"type": "float"}},
            "required": [parameter_name],
        },
    }
    possible_answer = {
        function_name: {parameter_name: [canonical_value]},
    }

    def grade(value):
        return checker.simple_function_checker(
            function_description,
            {function_name: {parameter_name: value}},
            possible_answer,
            "Python",
            "contract-model",
        )

    canonical_result = grade(canonical_value)
    equivalent_result = grade(equivalent_integer_spelling)
    canonical_accepted = canonical_result.get("valid") is True
    equivalent_accepted = equivalent_result.get("valid") is True

    print(
        json.dumps(
            {
                "schema_version": "1.0",
                "relation_holds": canonical_accepted and equivalent_accepted,
                "observations": {
                    "canonical_accepted": canonical_accepted,
                    "canonical_error_type": canonical_result.get("error_type"),
                    "equivalent_integer_spelling_accepted": equivalent_accepted,
                    "equivalent_integer_spelling_error_type": equivalent_result.get(
                        "error_type"
                    ),
                },
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
