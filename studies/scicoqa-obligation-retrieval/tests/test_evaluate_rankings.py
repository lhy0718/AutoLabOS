from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "evaluate_rankings.py"
SPEC = importlib.util.spec_from_file_location("evaluate_rankings", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class EvaluateRankingsTest(unittest.TestCase):
    def setUp(self):
        self.contract = {
            "context_budget": {"selected_code_tokens": 100},
            "systems": [{"id": "baseline"}, {"id": "frontier"}],
            "frontier_model_fairness": {
                "systems_with_calls": ["frontier"],
                "model": "configured-model",
                "reasoning_effort": "high",
            },
        }
        self.manifest = [
            {"unit_id": "unit-a", "split": "development"},
            {"unit_id": "unit-b", "split": "development"},
        ]
        self.payload = {
            "prediction_kind": "deterministic",
            "split": "development",
            "systems": ["baseline"],
            "gold_fields_read": [],
            "records": [
                {
                    "unit_id": unit_id,
                    "split": "development",
                    "system": "baseline",
                    "used_code_tokens": 50,
                    "selected_chunk_ids": ["chunk-1"],
                    "retrieved_files": ["src/file.py"],
                }
                for unit_id in ("unit-a", "unit-b")
            ],
        }

    def test_accepts_a_complete_deterministic_grid(self):
        MODULE.validate_prediction_payload(
            self.payload,
            self.contract,
            self.manifest,
        )

    def test_rejects_a_missing_unit_system_pair(self):
        self.payload["records"].pop()
        with self.assertRaisesRegex(ValueError, "complete unit-system grid"):
            MODULE.validate_prediction_payload(
                self.payload,
                self.contract,
                self.manifest,
            )

    def test_rejects_nonempty_rankings_for_invalid_output(self):
        self.payload["records"][0]["invalid_output"] = True
        with self.assertRaisesRegex(ValueError, "empty ranking"):
            MODULE.validate_prediction_payload(
                self.payload,
                self.contract,
                self.manifest,
            )

    def test_rejects_frontier_provenance_without_effective_model(self):
        self.payload["prediction_kind"] = "frontier_provider"
        self.payload["systems"] = ["frontier"]
        self.payload["records"] = [
            {
                "unit_id": unit_id,
                "split": "development",
                "system": "frontier",
                "used_code_tokens": 50,
                "selected_chunk_ids": ["chunk-1"],
                "retrieved_files": ["src/file.py"],
            }
            for unit_id in ("unit-a", "unit-b")
        ]
        self.payload["provenance"] = [
            {
                "unit_id": unit_id,
                "system": "frontier",
                "provider": "openai_responses_api",
                "requested_model": "configured-model",
                "reasoning_effort": "high",
                "prompt_sha256": "a" * 64,
                "input_sha256": "b" * 64,
                "response_sha256": "c" * 64,
                "response_id": "response-fixture",
                "usage": {},
                "latency_ms": 1,
            }
            for unit_id in ("unit-a", "unit-b")
        ]
        with self.assertRaisesRegex(ValueError, "effective model"):
            MODULE.validate_prediction_payload(
                self.payload,
                self.contract,
                self.manifest,
            )


if __name__ == "__main__":
    unittest.main()
