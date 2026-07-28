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


def install_getter_boundary(workspace_dump: str, events: dict):
    package_name = "desktop_env.evaluators.getters"
    for name in ("desktop_env", "desktop_env.evaluators", package_name):
        package = types.ModuleType(name)
        package.__path__ = []
        sys.modules[name] = package

    file_module = types.ModuleType(f"{package_name}.file")

    def get_vm_file(_env, _config):
        events["file_fetches"] += 1
        return None

    file_module.get_vm_file = get_vm_file
    sys.modules[file_module.__name__] = file_module

    replay_module = types.ModuleType(f"{package_name}.replay")

    def get_replay(_env, trajectory):
        events["replays"].append(trajectory)

    replay_module.get_replay = get_replay
    sys.modules[replay_module.__name__] = replay_module

    general_module = types.ModuleType(f"{package_name}.general")

    def get_vm_command_line(_env, _config):
        events["workspace_scans"] += 1
        return workspace_dump

    general_module.get_vm_command_line = get_vm_command_line
    sys.modules[general_module.__name__] = general_module
    return package_name


def load_module(revision_root: Path, package_name: str):
    module_name = f"{package_name}.vscode"
    module_path = revision_root / "desktop_env/evaluators/getters/vscode.py"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load evaluator module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    module.time.sleep = lambda _seconds: None
    return module


class SetupController:
    def __init__(self, events: dict):
        self.events = events

    def _activate_window_setup(self, title: str):
        self.events["activated_windows"].append(title)


class Environment:
    def __init__(self, cache_dir: str, events: dict):
        self.vm_platform = "Linux"
        self.cache_dir = cache_dir
        self.setup_controller = SetupController(events)


def main():
    args = parse_args()
    revision_root = Path(args.revision_root).resolve()
    workspace_dump = '{"folder": "file:///home/user/project"}'
    events = {
        "file_fetches": 0,
        "workspace_scans": 0,
        "replays": [],
        "activated_windows": [],
    }

    captured = io.StringIO()
    with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
        package_name = install_getter_boundary(workspace_dump, events)
        module = load_module(revision_root, package_name)
        with tempfile.TemporaryDirectory(prefix="grader-conform-osworld-workspace-") as temporary:
            env = Environment(temporary, events)
            result = module.get_vscode_config(
                env,
                {
                    "vscode_extension_command": "OpenProject",
                    "path": "/tmp/OpenProject.txt",
                    "dest": "open_project.txt",
                },
            )
            result_path = Path(result) if isinstance(result, str) and result else None
            recovered = result_path is not None and result_path.is_file()
            recovered_content = result_path.read_text(encoding="utf8") if recovered else None

    relation_holds = recovered and recovered_content == workspace_dump
    print(
        json.dumps(
            {
                "schema_version": "1.0",
                "relation_holds": relation_holds,
                "observations": {
                    "primary_helper_missing": True,
                    "recovered_equivalent_state": recovered,
                    "workspace_content_matches": recovered_content == workspace_dump,
                    "file_fetch_count": events["file_fetches"],
                    "workspace_scan_count": events["workspace_scans"],
                    "window_activation_count": len(events["activated_windows"]),
                },
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
