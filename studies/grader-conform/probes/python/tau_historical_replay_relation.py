#!/usr/bin/env python3

import argparse
import contextlib
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision-root", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    revision_root = Path(args.revision_root).resolve()
    captured = io.StringIO()
    observations = {
        "rescore_error": None,
        "reward": None,
        "db_match": None,
    }

    with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
        try:
            sys.path.insert(0, str(revision_root / "src"))
            from tau2.data_model.message import (
                AssistantMessage,
                ToolCall,
                ToolMessage,
            )
            from tau2.data_model.simulation import SimulationRun, TerminationReason
            from tau2.evaluator.evaluator import EvaluationType
            from tau2.run import get_tasks
            from tau2.scripts.evaluate_trajectories import (
                compute_simulation_rewards,
            )

            task = get_tasks("mock", task_ids=["create_task_1"])[0]
            messages = [
                AssistantMessage(
                    id="call_1",
                    role="assistant",
                    content=None,
                    tool_calls=[
                        ToolCall(
                            id="call_1",
                            name="create_task",
                            arguments={
                                "user_id": "user_1",
                                "title": "Important Meeting",
                            },
                        )
                    ],
                ),
                ToolMessage(
                    id="call_1",
                    role="tool",
                    content=(
                        '{"task_id": "task_2", '
                        '"title": "Important Meeting ", '
                        '"description": null, "status": "pending"}'
                    ),
                ),
            ]
            simulation = SimulationRun(
                id="historical-replay-probe",
                task_id=task.id,
                start_time="2026-01-01T00:00:00",
                end_time="2026-01-01T00:01:00",
                duration=60.0,
                termination_reason=TerminationReason.USER_STOP,
                messages=messages,
            )
            results = SimpleNamespace(
                info=SimpleNamespace(
                    environment_info=SimpleNamespace(domain_name="mock"),
                    agent_info=SimpleNamespace(implementation="llm_agent"),
                    user_info=SimpleNamespace(implementation="user_simulator"),
                    audio_native_config=None,
                ),
                tasks=[task],
                simulations=[simulation],
            )
            rescored = compute_simulation_rewards(
                results,
                evaluation_type=EvaluationType.ENV,
            )
            reward_info = rescored.simulations[0].reward_info
            observations["reward"] = reward_info.reward
            observations["db_match"] = (
                reward_info.db_check.db_match
                if reward_info.db_check is not None
                else None
            )
        except Exception as error:
            observations["rescore_error"] = type(error).__name__

    relation_holds = (
        observations["rescore_error"] is None
        and observations["reward"] == 1.0
        and observations["db_match"] is True
    )
    print(
        json.dumps(
            {
                "schema_version": "1.0",
                "relation_holds": relation_holds,
                "observations": observations,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
