#!/usr/bin/env python3

import argparse
import importlib.util
import io
import json
import sys
import types
from contextlib import redirect_stdout
from pathlib import Path

import tree_sitter as installed_tree_sitter
import tree_sitter_javascript


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision-root", required=True)
    return parser.parse_args()


class PackagedJavascriptLanguage:
    @staticmethod
    def build_library(*_args, **_kwargs):
        return None

    def __new__(cls, _library_path, language_name):
        if language_name != "javascript":
            raise ValueError(f"Unsupported grammar: {language_name}")
        return installed_tree_sitter.Language(
            tree_sitter_javascript.language(),
            language_name,
        )


def load_parser(revision_root):
    parser_path = revision_root / "openfunctions" / "utils" / "js_parser.py"
    compatibility_module = types.ModuleType("tree_sitter")
    compatibility_module.Language = PackagedJavascriptLanguage
    compatibility_module.Parser = installed_tree_sitter.Parser
    previous_module = sys.modules.get("tree_sitter")

    try:
        sys.modules["tree_sitter"] = compatibility_module
        spec = importlib.util.spec_from_file_location(
            "historical_bfcl_javascript_parser", parser_path
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if previous_module is None:
            del sys.modules["tree_sitter"]
        else:
            sys.modules["tree_sitter"] = previous_module


def main():
    args = parse_args()
    function_name = "set_status"
    parameter_name = "status"
    semantic_value = "ready"
    single_quoted = f"{function_name}({parameter_name}='{semantic_value}')"
    double_quoted = f'{function_name}({parameter_name}="{semantic_value}")'
    expected = {
        "function": {
            "name": function_name,
            "parameters": {parameter_name: semantic_value},
        }
    }
    implementation_stdout = io.StringIO()

    with redirect_stdout(implementation_stdout):
        parser = load_parser(Path(args.revision_root).resolve())
        single_result = parser.parse_javascript_function_call(single_quoted)
        double_result = parser.parse_javascript_function_call(double_quoted)

    equivalent_surface_forms = single_result == expected and double_result == expected
    print(
        json.dumps(
            {
                "schema_version": "1.0",
                "relation_holds": equivalent_surface_forms,
                "observations": {
                    "double_quoted_result": double_result,
                    "equivalent_surface_forms": equivalent_surface_forms,
                    "implementation_stdout": implementation_stdout.getvalue()[-500:],
                    "single_quoted_result": single_result,
                },
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
