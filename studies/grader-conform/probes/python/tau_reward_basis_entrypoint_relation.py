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
        "all_error": None,
        "all_reward": None,
        "explicit_error": None,
        "explicit_reward": None,
        "nl_evaluator_calls": 0,
    }

    with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
        try:
            sys.path.insert(0, str(revision_root / "src"))
            import tau2.evaluator.evaluator as evaluator_module
            from tau2.data_model.simulation import RewardInfo, TerminationReason
            from tau2.data_model.tasks import RewardType

            class UnitEvaluator:
                @staticmethod
                def calculate_reward(**_kwargs):
                    return RewardInfo(reward=1.0, info={})

            class NaturalLanguageEvaluator:
                calls = 0

                @staticmethod
                def calculate_reward(**_kwargs):
                    NaturalLanguageEvaluator.calls += 1
                    return RewardInfo(
                        reward=0.5,
                        info={},
                    )

            evaluator_module.EnvironmentEvaluator = UnitEvaluator
            evaluator_module.ActionEvaluator = UnitEvaluator
            evaluator_module.CommunicateEvaluator = UnitEvaluator
            evaluator_module.NLAssertionsEvaluator = NaturalLanguageEvaluator

            simulation = SimpleNamespace(
                termination_reason=TerminationReason.USER_STOP,
                messages=[],
                ticks=[],
            )
            task = SimpleNamespace(
                evaluation_criteria=SimpleNamespace(
                    reward_basis=[RewardType.NL_ASSERTION]
                )
            )

            def evaluate(evaluation_type):
                try:
                    result = evaluator_module.evaluate_simulation(
                        simulation=simulation,
                        task=task,
                        evaluation_type=evaluation_type,
                        solo_mode=False,
                        domain="mock",
                    )
                    return result.reward, None
                except Exception as error:
                    return None, f"{type(error).__name__}: {error}"

            observations["all_reward"], observations["all_error"] = evaluate(
                evaluator_module.EvaluationType.ALL
            )
            (
                observations["explicit_reward"],
                observations["explicit_error"],
            ) = evaluate(evaluator_module.EvaluationType.ALL_WITH_NL_ASSERTIONS)
            observations["nl_evaluator_calls"] = NaturalLanguageEvaluator.calls
        except Exception as error:
            observations["all_error"] = f"{type(error).__name__}: {error}"

    relation_holds = (
        observations["all_error"] is None
        and observations["explicit_error"] is None
        and observations["all_reward"] == observations["explicit_reward"] == 0.5
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
