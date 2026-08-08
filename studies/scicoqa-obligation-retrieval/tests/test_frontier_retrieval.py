from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "lib" / "frontier_retrieval.py"
SPEC = importlib.util.spec_from_file_location("frontier_retrieval", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

RUNNER_PATH = Path(__file__).parents[1] / "scripts" / "run_frontier_retrieval.py"
RUNNER_SPEC = importlib.util.spec_from_file_location("run_frontier_retrieval", RUNNER_PATH)
assert RUNNER_SPEC is not None and RUNNER_SPEC.loader is not None
RUNNER = importlib.util.module_from_spec(RUNNER_SPEC)
sys.modules[RUNNER_SPEC.name] = RUNNER
RUNNER_SPEC.loader.exec_module(RUNNER)


class FrontierRetrievalTest(unittest.TestCase):
    def test_extracts_responses_output_text(self):
        payload = {"output": [{"content": [{"type": "output_text", "text": '{"ok": true}'}]}]}
        self.assertEqual(MODULE.extract_output_text(payload), '{"ok": true}')

    def test_parses_fenced_json_defensively(self):
        self.assertEqual(MODULE.parse_json_output('```json\n{"ok": true}\n```'), {"ok": True})

    def test_hashes_the_exact_canonical_responses_input(self):
        request = MODULE.build_responses_request("configured-model", "high", "prompt")
        self.assertEqual(request["model"], "configured-model")
        self.assertEqual(
            MODULE.sha256_json(request),
            MODULE.sha256_json({
                "max_output_tokens": 6000,
                "reasoning": {"effort": "high"},
                "text": {"format": {"type": "text"}},
                "input": [{
                    "content": [{"text": "prompt", "type": "input_text"}],
                    "role": "user",
                }],
                "model": "configured-model",
            }),
        )

    def test_selector_discards_unknown_and_duplicate_paths(self):
        parsed = {"ranked_files": [{"path": "src/a.py"}, {"path": "missing.py"}, {"path": "src/a.py"}]}
        self.assertEqual(MODULE.selected_paths(parsed, {"src/a.py"}), ["src/a.py"])

    def test_repository_map_respects_the_frozen_candidate_universe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src").mkdir()
            (root / "docs").mkdir()
            (root / "src" / "kept.py").write_text("def kept():\n    pass\n", encoding="utf-8")
            (root / "docs" / "excluded.py").write_text(
                "def excluded():\n    pass\n",
                encoding="utf-8",
            )
            repository_map = MODULE.build_repository_map(root, {"src/kept.py"})
        self.assertIn("src/kept.py", repository_map)
        self.assertNotIn("docs/excluded.py", repository_map)

    def test_obligation_query_uses_only_structured_fields(self):
        parsed = {
            "obligations": [
                {
                    "statement": "Normalize each input.",
                    "evidence": "we normalize inputs",
                    "concepts": ["normalization"],
                    "identifiers": ["normalize"],
                }
            ]
        }
        query = MODULE.obligation_query(parsed)
        self.assertIn("Normalize each input", query)
        self.assertIn("normalize", query)

    def test_env_loader_does_not_require_export_syntax(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("OPENAI_API_KEY='test-value'\n", encoding="utf-8")
            self.assertEqual(MODULE.load_env_key(path, "OPENAI_API_KEY"), "test-value")

    def test_invalid_provider_json_is_cached_with_complete_provenance(self):
        response = {
            "id": "response-fixture",
            "model": "configured-model",
            "usage": {"input_tokens": 10, "output_tokens": 2},
            "output": [{"content": [{"type": "output_text", "text": "not json"}]}],
        }
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory) / "response.json"
            with patch.object(RUNNER.FRONTIER, "call_responses_api", return_value=response):
                record = RUNNER.cached_or_call(
                    cache_path,
                    "input-hash",
                    "test-value",
                    "configured-model",
                    "high",
                    "prompt",
                )
        self.assertIsNone(record["parsed"])
        self.assertEqual(record["invalid_output_reason"], "invalid_json_object")
        self.assertEqual(record["input_sha256"], "input-hash")
        self.assertEqual(record["response_sha256"], MODULE.sha256_json(response))
        self.assertEqual(record["response"], response)

    def test_rejects_any_existing_cache_before_a_paper_grade_call(self):
        response = {
            "id": "response-fixture",
            "model": "configured-model",
            "usage": {"input_tokens": 10, "output_tokens": 2},
            "output": [{
                "content": [{
                    "type": "output_text",
                    "text": '{"ranked_files": [{"path": "src/a.py"}]}',
                }],
            }],
        }
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory) / "response.json"
            record = {
                "request_sha256": "input-hash",
                "input_sha256": "input-hash",
                "response_sha256": MODULE.sha256_json(response),
                "response_id": response["id"],
                "effective_model": response["model"],
                "usage": response["usage"],
                "output_text_sha256": MODULE.sha256_text(
                    MODULE.extract_output_text(response)
                ),
                "response": response,
                "parsed": {"ranked_files": [{"path": "src/tampered.py"}]},
                "invalid_output_reason": None,
            }
            cache_path.write_text(json.dumps(record), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "cache reuse is forbidden"):
                RUNNER.cached_or_call(
                    cache_path,
                    "input-hash",
                    "test-value",
                    "configured-model",
                    "high",
                    "prompt",
                )

    def test_rejects_even_a_well_formed_existing_cache(self):
        response = {
            "id": "response-fixture",
            "model": "configured-model",
            "usage": {"input_tokens": 10, "output_tokens": 2},
            "output": [{"content": [{"type": "output_text", "text": '{"ok": true}'}]}],
        }
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory) / "response.json"
            record = {
                "request_sha256": "input-hash",
                "input_sha256": "input-hash",
                "response_sha256": MODULE.sha256_json(response),
                "response_id": response["id"],
                "effective_model": response["model"],
                "usage": response["usage"],
                "output_text_sha256": MODULE.sha256_text(
                    MODULE.extract_output_text(response)
                ),
                "response": response,
                "parsed": {"ok": True},
                "invalid_output_reason": None,
            }
            cache_path.write_text(json.dumps(record), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "cache reuse is forbidden"):
                RUNNER.cached_or_call(
                    cache_path,
                    "input-hash",
                    "test-value",
                    "configured-model",
                    "high",
                    "prompt",
                )

    def test_invalid_system_schema_produces_an_empty_ranking(self):
        ranking, reason = RUNNER.resolve_ranking(
            "frontier_obligations",
            {"obligations": []},
            set(),
            "paper",
            [],
        )
        self.assertEqual(ranking, [])
        self.assertEqual(reason, "invalid_system_schema")

    def test_frozen_input_verifier_rejects_prompt_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            contract_path = Path(directory) / "experiment-contract.v1.json"
            contract_path.write_bytes(
                (Path(__file__).parents[1] / "method" / "experiment-contract.v1.json")
                .read_bytes()
            )
            receipt = json.loads(
                (Path(__file__).parents[1] / "method" / "freeze-receipt.v3.json")
                .read_text(encoding="utf-8")
            )
            receipt["files"]["experiment-contract.v1.json"] = (
                RUNNER.RETRIEVAL.sha256_file(contract_path)
            )
            receipt["files"]["prompts/frontier-obligations.v1.txt"] = "0" * 64
            receipt_path = Path(directory) / "freeze.json"
            receipt_path.write_text(
                json.dumps(receipt),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "frozen input hash mismatch"):
                RUNNER.verify_frozen_inputs(contract_path, receipt_path)

    def test_current_contract_and_prompts_match_the_freeze_receipt(self):
        root = Path(__file__).parents[1]
        RUNNER.verify_frozen_inputs(
            root / "method" / "experiment-contract.v1.json",
            root / "method" / "freeze-receipt.v3.json",
        )

    def test_every_freeze_v3_file_binding_matches_the_study_bytes(self):
        root = Path(__file__).parents[1].resolve()
        receipt_path = root / "method" / "freeze-receipt.v3.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        for relative, expected_hash in receipt["files"].items():
            with self.subTest(relative=relative):
                path = (receipt_path.parent / relative).resolve()
                self.assertTrue(path.is_relative_to(root))
                self.assertEqual(RUNNER.RETRIEVAL.sha256_file(path), expected_hash)


if __name__ == "__main__":
    unittest.main()
