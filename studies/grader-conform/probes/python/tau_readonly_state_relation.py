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
        "before_hash": None,
        "after_hash": None,
        "record_count": None,
        "call_error": None,
    }

    with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
        try:
            sys.path.insert(0, str(revision_root / "src"))
            from tau2.domains.banking_knowledge.environment import get_db
            from tau2.domains.banking_knowledge.tools import KnowledgeTools

            tools = KnowledgeTools(get_db())
            account_id = next(
                key
                for key, record in tools.db.accounts.data.items()
                if record.get("class", "").lower() == "checking"
            )
            observations["account_id"] = account_id
            observations["before_hash"] = tools.get_db_hash()
            unlock_result = tools.unlock_discoverable_agent_tool(
                "get_bank_account_transactions_9173"
            )
            call_result = tools.call_discoverable_agent_tool(
                "get_bank_account_transactions_9173",
                json.dumps({"account_id": account_id}),
            )
            observations["after_hash"] = tools.get_db_hash()
            observations["record_count"] = len(
                tools.db.agent_discoverable_tools.data
            )
            if unlock_result.startswith("Error"):
                observations["call_error"] = unlock_result
            elif call_result.startswith("Error"):
                observations["call_error"] = call_result
        except Exception as error:
            observations["call_error"] = f"{type(error).__name__}: {error}"

    relation_holds = (
        observations["call_error"] is None
        and observations["before_hash"] == observations["after_hash"]
        and observations["record_count"] == 0
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
