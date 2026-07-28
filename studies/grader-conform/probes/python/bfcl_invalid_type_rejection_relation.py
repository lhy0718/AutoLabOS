#!/usr/bin/env python3

import argparse
import importlib
import json
import sys
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision-root", required=True)
    return parser.parse_args()


def load_handler(revision_root):
    benchmark_root = revision_root / "berkeley-function-call-leaderboard"
    previous_sys_path = list(sys.path)

    try:
        sys.path.insert(0, str(benchmark_root))
        module = importlib.import_module("model_handler.gpt_handler")
        handler = module.OpenAIHandler.__new__(module.OpenAIHandler)
        handler.model_name = "contract-FC"
        return handler
    finally:
        sys.path[:] = previous_sys_path


def main():
    args = parse_args()
    handler = load_handler(Path(args.revision_root).resolve())
    function_name = "set_label"
    parameter_name = "label"
    canonical_value = "7"
    invalid_numeric_value = 7

    def decode(language, value):
        raw_response = [
            {
                function_name: json.dumps(
                    {parameter_name: value},
                    separators=(",", ":"),
                )
            }
        ]
        return handler.decode_ast(raw_response, language=language)[0][function_name][
            parameter_name
        ]

    language_observations = {}
    relation_holds = True
    for language in ("Java", "JavaScript"):
        canonical_decoded = decode(language, canonical_value)
        invalid_decoded = decode(language, invalid_numeric_value)
        invalid_remains_distinguishable = (
            type(canonical_decoded) is str
            and canonical_decoded == canonical_value
            and type(invalid_decoded) is int
            and invalid_decoded == invalid_numeric_value
        )
        relation_holds = relation_holds and invalid_remains_distinguishable
        language_observations[language] = {
            "canonical_decoded_type": type(canonical_decoded).__name__,
            "invalid_decoded_type": type(invalid_decoded).__name__,
            "invalid_remains_distinguishable": invalid_remains_distinguishable,
        }

    print(
        json.dumps(
            {
                "schema_version": "1.0",
                "relation_holds": relation_holds,
                "observations": {"languages": language_observations},
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
