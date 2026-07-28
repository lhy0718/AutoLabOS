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
    captured = io.StringIO()
    observations = {
        "account_id": None,
        "integer_hash": None,
        "floating_hash": None,
        "integer_error": None,
        "floating_error": None,
    }

    with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
        try:
            sys.path.insert(0, str(revision_root / "src"))
            from tau2.domains.banking_knowledge.environment import get_db
            from tau2.domains.banking_knowledge.tools import KnowledgeTools

            base_db = get_db()
            account_id = next(
                key
                for key, record in base_db.accounts.data.items()
                if record.get("class", "").lower() in {"saving", "savings"}
                and record.get("status") in {"ACTIVE", "OPEN"}
            )
            observations["account_id"] = account_id

            def execute(amount_spelling):
                tools = KnowledgeTools(base_db.model_copy(deep=True))
                unlock_result = tools.unlock_discoverable_agent_tool(
                    "apply_savings_account_credit_6831"
                )
                arguments = (
                    f'{{"account_id": {json.dumps(account_id)}, '
                    f'"amount": {amount_spelling}, '
                    f'"credit_type": "interest_correction"}}'
                )
                call_result = tools.call_discoverable_agent_tool(
                    "apply_savings_account_credit_6831",
                    arguments,
                )
                error = None
                if unlock_result.startswith("Error"):
                    error = unlock_result
                elif call_result.startswith("Error"):
                    error = call_result
                return tools.get_db_hash(), error

            (
                observations["integer_hash"],
                observations["integer_error"],
            ) = execute("33")
            (
                observations["floating_hash"],
                observations["floating_error"],
            ) = execute("33.0")
        except Exception as error:
            observations["integer_error"] = f"{type(error).__name__}: {error}"

    relation_holds = (
        observations["integer_error"] is None
        and observations["floating_error"] is None
        and observations["integer_hash"] == observations["floating_hash"]
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
