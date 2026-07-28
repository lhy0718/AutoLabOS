#!/usr/bin/env python3

import argparse
import contextlib
import copy
import importlib.util
import io
import json
from datetime import datetime
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision-root", required=True)
    return parser.parse_args()


def load_module(revision_root: Path):
    module_path = revision_root / "desktop_env/evaluators/getters/misc.py"
    spec = importlib.util.spec_from_file_location("grader_conform_misc", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load evaluator module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FrozenHostDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        frozen = cls(2024, 1, 15, 12, 0, 0)
        return tz.localize(frozen) if tz is not None else frozen


class VmClockController:
    def __init__(self, iso_datetime: str):
        self.iso_datetime = iso_datetime

    def execute_python_command(self, _command: str):
        return {"output": self.iso_datetime}


class Environment:
    def __init__(self, iso_datetime: str):
        self.controller = VmClockController(iso_datetime)


def evaluate(module, iso_datetime: str):
    config = {
        "rules": {
            "relativeTime": {"from": "tomorrow"},
            "expected": {"time": "{Year}-{Month0D}-{Day0D}"},
        }
    }
    result = module.get_rule_relativeTime(Environment(iso_datetime), copy.deepcopy(config))
    return result["expected"]["time"]


def main():
    args = parse_args()
    revision_root = Path(args.revision_root).resolve()

    captured = io.StringIO()
    with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
        module = load_module(revision_root)
        module.datetime = FrozenHostDateTime
        module.get_timezone_from_ip = lambda: "UTC"
        vm_datetimes = [
            "2030-03-10T23:30:00+09:00",
            "2030-04-20T08:00:00-04:00",
        ]
        expected_dates = ["2030-03-11", "2030-04-21"]
        observed_dates = [evaluate(module, value) for value in vm_datetimes]

    print(
        json.dumps(
            {
                "schema_version": "1.0",
                "relation_holds": observed_dates == expected_dates,
                "observations": {
                    "host_date": "2024-01-15",
                    "vm_datetimes": vm_datetimes,
                    "expected_relative_dates": expected_dates,
                    "observed_relative_dates": observed_dates,
                },
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
