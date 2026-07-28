#!/usr/bin/env python3

import argparse
import contextlib
import io
import json
import sys
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision-root", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    revision_root = Path(args.revision_root).resolve()
    sys.path.insert(0, str(revision_root / "src"))

    captured = io.StringIO()
    with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
        from tau2.data_model.message import AssistantMessage, ToolCall, ToolMessage
        from tau2.environment.environment import Environment
        from tau2.environment.toolkit import ToolKitBase, ToolType, is_tool

        class CounterTools(ToolKitBase):
            def __init__(self):
                self.value = 0

            @is_tool(ToolType.WRITE)
            def increment(self, amount: int) -> str:
                self.value += amount
                return str(self.value)

        def replay(include_unknown_call):
            tools = CounterTools()
            environment = Environment(
                domain_name="conformance_probe",
                policy="",
                tools=tools,
            )
            messages = []
            if include_unknown_call:
                messages.extend(
                    [
                        AssistantMessage(
                            id="unknown",
                            role="assistant",
                            content=None,
                            tool_calls=[
                                ToolCall(
                                    id="unknown",
                                    name="missing_tool",
                                    arguments={},
                                )
                            ],
                        ),
                        ToolMessage(
                            id="unknown",
                            role="tool",
                            content="Error: Tool 'missing_tool' not found.",
                            error=True,
                        ),
                    ]
                )
            messages.extend(
                [
                    AssistantMessage(
                        id="valid",
                        role="assistant",
                        content=None,
                        tool_calls=[
                            ToolCall(
                                id="valid",
                                name="increment",
                                arguments={"amount": 1},
                            )
                        ],
                    ),
                    ToolMessage(
                        id="valid",
                        role="tool",
                        content="1",
                    ),
                ]
            )
            environment.set_state(
                initialization_data=None,
                initialization_actions=None,
                message_history=messages,
            )
            return tools.value

        clean_value = replay(False)
        transformed_value = None
        transformed_error = None
        try:
            transformed_value = replay(True)
        except Exception as error:
            transformed_error = f"{type(error).__name__}: {error}"

    relation_holds = (
        transformed_error is None
        and clean_value == transformed_value
        and clean_value == 1
    )
    print(
        json.dumps(
            {
                "schema_version": "1.0",
                "relation_holds": relation_holds,
                "observations": {
                    "clean_terminal_value": clean_value,
                    "transformed_terminal_value": transformed_value,
                    "transformed_error": transformed_error,
                },
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
