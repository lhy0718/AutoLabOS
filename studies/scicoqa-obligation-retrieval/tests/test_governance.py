from __future__ import annotations

import importlib.util
import importlib.metadata
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "lib" / "governance.py"
SPEC = importlib.util.spec_from_file_location("retrieval_governance", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class GovernanceTest(unittest.TestCase):
    def setUp(self):
        self.original_study_root = MODULE.STUDY_ROOT

    def tearDown(self):
        MODULE.STUDY_ROOT = self.original_study_root

    @staticmethod
    def _write_json(path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    def _write_freeze_fixture(
        self,
        root: Path,
        contract_path: Path,
        blind_manifest_path: Path,
    ) -> Path:
        files = {}
        for receipt_key, study_relative in MODULE.FROZEN_METHOD_BINDINGS.items():
            path = root / study_relative
            if path not in {contract_path, blind_manifest_path}:
                path.parent.mkdir(parents=True, exist_ok=True)
                if not path.exists():
                    path.write_text(f"fixture:{study_relative}\n", encoding="utf-8")
            files[receipt_key] = MODULE.sha256_file(path)
        freeze = root / "method" / "freeze-receipt.v3.json"
        self._write_json(freeze, {
            "schema_version": "3.0",
            "dataset_binding": {
                "blind_manifest_sha256": MODULE.sha256_file(blind_manifest_path),
            },
            "files": files,
        })
        return freeze

    def _write_promotion_fixture(self, root: Path) -> dict[str, Path]:
        MODULE.STUDY_ROOT = root
        results = root / "results"
        results.mkdir()
        cache_root = root / "cache"
        blind_manifest_path = root / "corpus" / "blind-manifest.v1.jsonl"
        blind_manifest_path.parent.mkdir()
        units = ["0000000000000001", "0000000000000002"]
        retrieval = MODULE._load_study_library(
            "test_governance_retrieval",
            MODULE.LIBRARY_ROOT / "retrieval.py",
        )
        frontier = MODULE._load_study_library(
            "test_governance_frontier",
            MODULE.LIBRARY_ROOT / "frontier_retrieval.py",
        )
        manifest = []
        paper_text = (
            "METHODS\n"
            "We compute the target score with target_score from the target module.\n"
        )
        for unit_id in units:
            unit_root = cache_root / "blind" / unit_id
            paper_path = unit_root / "paper.txt"
            repository = unit_root / "repository"
            repository.mkdir(parents=True)
            paper_path.write_text(paper_text, encoding="utf-8")
            (repository / "target.py").write_text(
                "def target_score():\n    return 1\n",
                encoding="utf-8",
            )
            (repository / "distractor.py").write_text(
                "value = 0\n",
                encoding="utf-8",
            )
            manifest.append({
                "unit_id": unit_id,
                "split": "development",
                "blind_paper_relative_path": f"blind/{unit_id}/paper.txt",
                "blind_repository_relative_path": f"blind/{unit_id}/repository",
                "paper_text_sha256": MODULE.sha256_file(paper_path),
                "mutated_repository_sha256": retrieval.sha256_tree(repository),
            })
        blind_manifest_path.write_text(
            "".join(json.dumps(item, sort_keys=True) + "\n" for item in manifest),
            encoding="utf-8",
        )

        obligation_template_path = (
            root / "method" / "prompts" / "frontier-obligations.v1.txt"
        )
        selector_template_path = (
            root / "method" / "prompts" / "generic-selector.v1.txt"
        )
        obligation_template_path.parent.mkdir(parents=True)
        obligation_template_path.write_text(
            "Extract implementation obligations as JSON.\n{{paper_text}}\n",
            encoding="utf-8",
        )
        selector_template_path.write_text(
            "Rank repository files as JSON.\nPaper:\n{{paper_text}}\nFiles:\n"
            "{{repository_map}}\n",
            encoding="utf-8",
        )

        sealed_root = root / "sealed"
        gold_root = sealed_root / "development-gold"
        gold_root.mkdir(parents=True)
        gold_records = []
        for unit_id in units:
            path = gold_root / f"{unit_id}.json"
            self._write_json(path, {
                "unit_id": unit_id,
                "split": "development",
                "target_files": ["target.py"],
            })
            gold_records.append({
                "unit_id": unit_id,
                "path": path.name,
                "sha256": MODULE.sha256_file(path),
            })
        gold_manifest_path = sealed_root / "development-gold-manifest.json"
        self._write_json(gold_manifest_path, {
            "schema_version": "1.0",
            "split": "development",
            "records": gold_records,
        })

        contract_path = root / "method" / "experiment-contract.v1.json"
        contract = {
            "corpus": {
                "development_units": 2,
                "blind_manifest_sha256": MODULE.sha256_file(blind_manifest_path),
                "sealed_gold_manifest_sha256": {
                    "development": MODULE.sha256_file(gold_manifest_path),
                },
            },
            "systems": [
                {"id": "frontier_obligations", "role": "proposed system"},
                {"id": "generic_frontier_selector", "role": "strong baseline"},
                {"id": "alphabetical_prefix", "role": "deterministic baseline"},
            ],
            "context_budget": {
                "tokenizer": "tiktoken cl100k_base",
                "tokenizer_version": importlib.metadata.version("tiktoken"),
                "chunk_tokens": 128,
                "chunk_overlap_tokens": 16,
                "selected_code_tokens": 24,
            },
            "frontier_model_fairness": {
                "model": "configured-model",
                "reasoning_effort": "high",
                "systems_with_calls": [
                    "generic_frontier_selector",
                    "frontier_obligations",
                ],
            },
            "development_promotion": {
                "minimum_absolute_macro_recall_gain": 0.1,
                "minimum_papers_with_positive_difference": 2,
                "must_beat": [
                    "generic_frontier_selector",
                    "alphabetical_prefix",
                ],
            },
        }
        self._write_json(contract_path, contract)
        contract_hash = MODULE.sha256_file(contract_path)
        manifest_hash = MODULE.sha256_file(blind_manifest_path)
        self._write_freeze_fixture(root, contract_path, blind_manifest_path)

        raw_provider_records = []
        provenance = []
        for index, unit_id in enumerate(units):
            unit = manifest[index]
            verified_paper, repository = retrieval.verify_blind_unit(
                cache_root,
                unit,
            )
            unit_paper_text = verified_paper.read_text(encoding="utf-8")
            import tiktoken
            encoder = tiktoken.get_encoding("cl100k_base")
            chunks = retrieval.build_chunks(repository, encoder, 128, 16)
            repository_map = frontier.build_repository_map(
                repository,
                {chunk.path for chunk in chunks},
            )
            prompts = {
                "generic_frontier_selector": frontier.fill_prompt(
                    selector_template_path.read_text(encoding="utf-8"),
                    paper_text=unit_paper_text,
                    repository_map=repository_map,
                ),
                "frontier_obligations": frontier.fill_prompt(
                    obligation_template_path.read_text(encoding="utf-8"),
                    paper_text=unit_paper_text,
                ),
            }
            outputs = {
                "generic_frontier_selector": {
                    "ranked_files": [{"path": "distractor.py"}],
                },
                "frontier_obligations": {
                    "obligations": [{
                        "statement": "Compute the target score.",
                        "evidence": "target_score from the target module",
                        "concepts": ["target", "score"],
                        "identifiers": ["target_score"],
                    }],
                },
            }
            for system in (
                "generic_frontier_selector",
                "frontier_obligations",
            ):
                output_text = json.dumps(outputs[system], sort_keys=True)
                prompt = prompts[system]
                request = frontier.build_responses_request(
                    "configured-model",
                    "high",
                    prompt,
                )
                response = {
                    "id": f"response-{index}-{system}",
                    "model": "configured-model",
                    "usage": {"input_tokens": 10, "output_tokens": 2},
                    "output": [{
                        "content": [{"type": "output_text", "text": output_text}],
                    }],
                }
                prompt_hash = frontier.sha256_text(prompt)
                request_hash = frontier.sha256_json(request)
                output_hash = hashlib.sha256(output_text.encode("utf-8")).hexdigest()
                record = {
                    "provider": "openai_responses_api",
                    "requested_model": "configured-model",
                    "effective_model": "configured-model",
                    "reasoning_effort": "high",
                    "prompt_sha256": prompt_hash,
                    "request_max_output_tokens": 6000,
                    "request_sha256": request_hash,
                    "input_sha256": request_hash,
                    "response_sha256": MODULE.sha256_json(response),
                    "response_id": response["id"],
                    "usage": response["usage"],
                    "latency_ms": 1,
                    "output_text_sha256": output_hash,
                    "response": response,
                    "parsed": outputs[system],
                    "invalid_output_reason": None,
                }
                raw_provider_records.append({
                    "unit_id": unit_id,
                    "system": system,
                    "record": record,
                })
                provenance.append({
                    "unit_id": unit_id,
                    "system": system,
                    **{
                        key: record[key]
                        for key in (
                            "provider", "requested_model", "effective_model",
                            "reasoning_effort", "prompt_sha256", "request_sha256",
                            "input_sha256", "response_sha256", "response_id", "usage",
                            "latency_ms", "output_text_sha256",
                            "request_max_output_tokens",
                        )
                    },
                    "valid_output": True,
                    "invalid_output_reason": None,
                })
        frontier_records = MODULE.derive_frontier_prediction_records(
            cache_root=cache_root,
            manifest=manifest,
            split="development",
            contract=contract,
            raw_provider_records=raw_provider_records,
            provenance=provenance,
        )
        frontier_predictions = results / "frontier-predictions.json"
        self._write_json(frontier_predictions, {
            "schema_version": "1.0",
            "prediction_kind": MODULE.PREDICTION_KIND_FRONTIER,
            "split": "development",
            "systems": [
                "generic_frontier_selector",
                "frontier_obligations",
            ],
            "contract_sha256": contract_hash,
            "blind_manifest_sha256": manifest_hash,
            "gold_fields_read": [],
            "records": frontier_records,
            "provenance": provenance,
        })
        deterministic_systems = ["alphabetical_prefix"]
        deterministic_records = MODULE.derive_deterministic_prediction_records(
            cache_root=cache_root,
            manifest=manifest,
            split="development",
            contract=contract,
            systems=deterministic_systems,
        )
        deterministic_predictions = results / "deterministic-predictions.json"
        self._write_json(deterministic_predictions, {
            "schema_version": "1.1",
            "prediction_kind": MODULE.PREDICTION_KIND_DETERMINISTIC,
            "split": "development",
            "systems": deterministic_systems,
            "contract_sha256": contract_hash,
            "blind_manifest_sha256": manifest_hash,
            "gold_fields_read": [],
            "records": deterministic_records,
        })
        execution_receipt = MODULE.canonical_frontier_execution_receipt_path(
            "development"
        )
        MODULE.write_frontier_execution_receipt(
            execution_receipt,
            predictions_path=frontier_predictions,
            contract_path=contract_path,
            blind_manifest_path=blind_manifest_path,
            cache_root=cache_root,
            raw_provider_records=raw_provider_records,
        )
        execution_receipt_hash = MODULE.sha256_file(execution_receipt)
        frontier_seal = results / "frontier-seal.json"
        deterministic_seal = results / "deterministic-seal.json"
        for predictions, seal, kind, execution_hash in (
            (
                frontier_predictions,
                frontier_seal,
                MODULE.PREDICTION_KIND_FRONTIER,
                execution_receipt_hash,
            ),
            (
                deterministic_predictions,
                deterministic_seal,
                MODULE.PREDICTION_KIND_DETERMINISTIC,
                None,
            ),
        ):
            MODULE.write_prediction_seal(
                seal,
                predictions_path=predictions,
                split="development",
                contract_sha256=contract_hash,
                blind_manifest_sha256=manifest_hash,
                promotion_receipt_sha256=None,
                prediction_kind=kind,
                execution_receipt_sha256=execution_hash,
            )

        frontier_eval = results / "frontier-evaluation.json"
        deterministic_eval = results / "deterministic-evaluation.json"
        frontier_payload = MODULE.derive_evaluation(
            frontier_predictions,
            contract_path,
            blind_manifest_path,
            gold_root,
            "development",
        )
        deterministic_payload = MODULE.derive_evaluation(
            deterministic_predictions,
            contract_path,
            blind_manifest_path,
            gold_root,
            "development",
        )
        self._write_json(frontier_eval, frontier_payload)
        self._write_json(deterministic_eval, deterministic_payload)

        def artifact(path: Path) -> dict[str, str]:
            return {
                "path": path.relative_to(root).as_posix(),
                "sha256": MODULE.sha256_file(path),
            }

        receipt = results / "promotion.json"
        self._write_json(receipt, {
            "decision": "PROMOTE",
            "contract_sha256": contract_hash,
            "blind_manifest_sha256": manifest_hash,
            "development_gold_manifest_sha256": MODULE.sha256_file(
                gold_manifest_path
            ),
            "development_gate": MODULE.compute_development_gate(
                contract, frontier_payload, deterministic_payload
            ),
            "development_artifacts": {
                "frontier_predictions": artifact(frontier_predictions),
                "frontier_prediction_seal": artifact(frontier_seal),
                "frontier_execution_receipt": artifact(execution_receipt),
                "frontier_evaluation": artifact(frontier_eval),
                "deterministic_predictions": artifact(deterministic_predictions),
                "deterministic_prediction_seal": artifact(deterministic_seal),
                "deterministic_evaluation": artifact(deterministic_eval),
            },
        })
        return {
            "receipt": receipt,
            "contract": contract_path,
            "manifest": blind_manifest_path,
            "cache_root": cache_root,
            "gold_root": gold_root,
            "frontier_evaluation": frontier_eval,
            "deterministic_evaluation": deterministic_eval,
            "gold_manifest": gold_manifest_path,
            "frontier_predictions": frontier_predictions,
            "deterministic_predictions": deterministic_predictions,
            "frontier_seal": frontier_seal,
            "frontier_execution_receipt": execution_receipt,
        }

    def test_manual_gate_booleans_cannot_authorize_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = self._write_promotion_fixture(root)
            receipt = json.loads(paths["receipt"].read_text(encoding="utf-8"))
            receipt.pop("development_artifacts")
            self._write_json(paths["receipt"], receipt)
            with self.assertRaisesRegex(ValueError, "frontier_predictions"):
                MODULE.validate_promotion_receipt(
                    paths["receipt"],
                    paths["contract"],
                    paths["manifest"],
                    paths["cache_root"],
                    paths["gold_root"],
                )

    def test_computes_promotion_from_paper_level_evidence(self):
        contract = {
            "corpus": {"development_units": 2},
            "systems": [
                {"id": "proposed", "role": "proposed system"},
                {"id": "generic", "role": "strong baseline"},
                {"id": "methods", "role": "focused baseline"},
                {"id": "hybrid", "role": "deterministic baseline"},
            ],
            "development_promotion": {
                "minimum_absolute_macro_recall_gain": 0.1,
                "minimum_papers_with_positive_difference": 2,
                "must_beat": ["generic", "methods", "hybrid"],
            },
        }

        def evaluation(rows):
            return {
                "split": "development",
                "unit_scores": [
                    {
                        "unit_id": unit,
                        "system": system,
                        "changed_file_recall": score,
                    }
                    for system, unit, score in rows
                ],
            }

        frontier = evaluation([
            ("proposed", "u1", 1.0),
            ("proposed", "u2", 1.0),
            ("generic", "u1", 0.5),
            ("generic", "u2", 0.0),
        ])
        deterministic = evaluation([
            ("methods", "u1", 0.5),
            ("methods", "u2", 0.0),
            ("hybrid", "u1", 0.0),
            ("hybrid", "u2", 0.0),
        ])
        gate = MODULE.compute_development_gate(contract, frontier, deterministic)
        self.assertTrue(gate["passed"])
        self.assertEqual(gate["positive_papers"], 2)

    def test_tokenizer_version_drift_fails_closed(self):
        contract = {
            "context_budget": {
                "tokenizer": "tiktoken cl100k_base",
                "tokenizer_version": "0.0.0",
            },
        }
        with self.assertRaisesRegex(ValueError, "tiktoken version mismatch"):
            MODULE.encoder_from_contract(contract)

    def test_validates_promotion_against_recomputed_bound_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self._write_promotion_fixture(Path(directory))
            MODULE.validate_promotion_receipt(
                paths["receipt"],
                paths["contract"],
                paths["manifest"],
                paths["cache_root"],
                paths["gold_root"],
            )
            paths["frontier_evaluation"].write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "artifact hash mismatch"):
                MODULE.validate_promotion_receipt(
                    paths["receipt"],
                    paths["contract"],
                    paths["manifest"],
                    paths["cache_root"],
                    paths["gold_root"],
                )

    def test_rejects_relocated_contract_and_manifest_even_with_same_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = self._write_promotion_fixture(root)
            relocated_contract = root / "alternate-contract.json"
            relocated_manifest = root / "alternate-manifest.jsonl"
            relocated_contract.write_bytes(paths["contract"].read_bytes())
            relocated_manifest.write_bytes(paths["manifest"].read_bytes())
            with self.assertRaisesRegex(ValueError, "canonical experiment contract"):
                MODULE.validate_promotion_receipt(
                    paths["receipt"],
                    relocated_contract,
                    paths["manifest"],
                    paths["cache_root"],
                    paths["gold_root"],
                )
            with self.assertRaisesRegex(ValueError, "canonical blind manifest"):
                MODULE.validate_promotion_receipt(
                    paths["receipt"],
                    paths["contract"],
                    relocated_manifest,
                    paths["cache_root"],
                    paths["gold_root"],
                )

    def test_rejects_a_forged_evaluation_even_when_receipt_hash_is_updated(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self._write_promotion_fixture(Path(directory))
            forged = json.loads(
                paths["frontier_evaluation"].read_text(encoding="utf-8")
            )
            forged["unit_scores"][0]["changed_file_recall"] = 1.0
            self._write_json(paths["frontier_evaluation"], forged)
            receipt = json.loads(paths["receipt"].read_text(encoding="utf-8"))
            receipt["development_artifacts"]["frontier_evaluation"]["sha256"] = (
                MODULE.sha256_file(paths["frontier_evaluation"])
            )
            self._write_json(paths["receipt"], receipt)
            with self.assertRaisesRegex(ValueError, "does not match recomputed"):
                MODULE.validate_promotion_receipt(
                    paths["receipt"],
                    paths["contract"],
                    paths["manifest"],
                    paths["cache_root"],
                    paths["gold_root"],
                )

    def test_raw_responses_cannot_authorize_injected_retrieval_or_token_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self._write_promotion_fixture(Path(directory))
            predictions = json.loads(
                paths["frontier_predictions"].read_text(encoding="utf-8")
            )
            predictions["records"][0]["retrieved_files"] = ["target.py"]
            predictions["records"][0]["used_code_tokens"] += 1
            self._write_json(paths["frontier_predictions"], predictions)
            execution = json.loads(
                paths["frontier_execution_receipt"].read_text(encoding="utf-8")
            )
            raw_provider_records = execution["provider_records"]
            paths["frontier_execution_receipt"].unlink()
            with self.assertRaisesRegex(
                ValueError,
                "do not match raw-response ranking derivation",
            ):
                MODULE.write_frontier_execution_receipt(
                    paths["frontier_execution_receipt"],
                    predictions_path=paths["frontier_predictions"],
                    contract_path=paths["contract"],
                    blind_manifest_path=paths["manifest"],
                    cache_root=paths["cache_root"],
                    raw_provider_records=raw_provider_records,
                )

    def test_self_authored_deterministic_ranking_cannot_weaken_baselines(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self._write_promotion_fixture(Path(directory))
            predictions = json.loads(
                paths["deterministic_predictions"].read_text(encoding="utf-8")
            )
            predictions["records"][0]["retrieved_files"] = []
            predictions["records"][0]["used_code_tokens"] = 0
            predictions["records"][0]["selected_chunk_ids"] = []
            self._write_json(paths["deterministic_predictions"], predictions)
            receipt = json.loads(paths["receipt"].read_text(encoding="utf-8"))
            receipt["development_artifacts"]["deterministic_predictions"][
                "sha256"
            ] = MODULE.sha256_file(paths["deterministic_predictions"])
            self._write_json(paths["receipt"], receipt)
            with self.assertRaisesRegex(
                ValueError,
                "do not match blind-corpus ranking derivation",
            ):
                MODULE.validate_promotion_receipt(
                    paths["receipt"],
                    paths["contract"],
                    paths["manifest"],
                    paths["cache_root"],
                    paths["gold_root"],
                )

    def test_rejects_tampered_sealed_gold_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self._write_promotion_fixture(Path(directory))
            gold_file = next(paths["gold_root"].glob("*.json"))
            payload = json.loads(gold_file.read_text(encoding="utf-8"))
            payload["target_files"] = ["src/forged.py"]
            self._write_json(gold_file, payload)
            with self.assertRaisesRegex(ValueError, "gold file hash mismatch"):
                MODULE.validate_promotion_receipt(
                    paths["receipt"],
                    paths["contract"],
                    paths["manifest"],
                    paths["cache_root"],
                    paths["gold_root"],
                )

    def test_self_authored_frontier_prediction_and_seal_cannot_bypass_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self._write_promotion_fixture(Path(directory))
            paths["frontier_execution_receipt"].unlink()
            receipt = json.loads(paths["receipt"].read_text(encoding="utf-8"))
            receipt["development_artifacts"].pop("frontier_execution_receipt")
            self._write_json(paths["receipt"], receipt)
            with self.assertRaisesRegex(ValueError, "frontier_execution_receipt"):
                MODULE.validate_promotion_receipt(
                    paths["receipt"],
                    paths["contract"],
                    paths["manifest"],
                    paths["cache_root"],
                    paths["gold_root"],
                )

    def test_promotion_rejects_frozen_evaluator_hash_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self._write_promotion_fixture(Path(directory))
            freeze = MODULE.canonical_freeze_receipt_path()
            payload = json.loads(freeze.read_text(encoding="utf-8"))
            payload["files"]["../scripts/evaluate_rankings.py"] = "0" * 64
            self._write_json(freeze, payload)
            with self.assertRaisesRegex(ValueError, "frozen method hash mismatch"):
                MODULE.validate_promotion_receipt(
                    paths["receipt"],
                    paths["contract"],
                    paths["manifest"],
                    paths["cache_root"],
                    paths["gold_root"],
                )

    def test_prediction_seal_rejects_a_different_prediction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            predictions = root / "predictions.json"
            seal = root / "seal.json"
            predictions.write_text("first", encoding="utf-8")
            MODULE.write_prediction_seal(
                seal,
                predictions_path=predictions,
                split="development",
                contract_sha256="a" * 64,
                blind_manifest_sha256="b" * 64,
                promotion_receipt_sha256=None,
                prediction_kind=MODULE.PREDICTION_KIND_DETERMINISTIC,
                execution_receipt_sha256=None,
            )
            predictions.write_text("second", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "prediction seal mismatch"):
                MODULE.validate_prediction_seal(
                    seal,
                    predictions_path=predictions,
                    split="development",
                    contract_sha256="a" * 64,
                    blind_manifest_sha256="b" * 64,
                    promotion_receipt_sha256=None,
                    prediction_kind=MODULE.PREDICTION_KIND_DETERMINISTIC,
                    execution_receipt_sha256=None,
                )

    def test_confirmatory_lock_rejects_an_alternate_prediction(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "confirmatory.lock.json"
            common = {
                "prediction_seal_sha256": "b" * 64,
                "contract_sha256": "c" * 64,
                "blind_manifest_sha256": "d" * 64,
                "promotion_receipt_sha256": "e" * 64,
                "prediction_kind": MODULE.PREDICTION_KIND_DETERMINISTIC,
                "execution_receipt_sha256": None,
            }
            MODULE.lock_confirmatory_evaluation(
                path,
                predictions_sha256="a" * 64,
                **common,
            )
            with self.assertRaisesRegex(ValueError, "locked to a different prediction"):
                MODULE.lock_confirmatory_evaluation(
                    path,
                    predictions_sha256="f" * 64,
                    **common,
                )

    def test_confirmatory_lock_requires_both_prediction_kinds_before_gold(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "confirmatory.lock.json"
            shared = {
                "contract_sha256": "c" * 64,
                "blind_manifest_sha256": "d" * 64,
                "promotion_receipt_sha256": "e" * 64,
            }
            first = MODULE.lock_confirmatory_evaluation(
                path,
                predictions_sha256="a" * 64,
                prediction_seal_sha256="b" * 64,
                prediction_kind=MODULE.PREDICTION_KIND_DETERMINISTIC,
                execution_receipt_sha256=None,
                **shared,
            )
            self.assertFalse(first["complete"])
            second = MODULE.lock_confirmatory_evaluation(
                path,
                predictions_sha256="f" * 64,
                prediction_seal_sha256="1" * 64,
                prediction_kind=MODULE.PREDICTION_KIND_FRONTIER,
                execution_receipt_sha256="2" * 64,
                **shared,
            )
            self.assertTrue(second["complete"])
            self.assertEqual(
                set(second["predictions"]),
                {
                    MODULE.PREDICTION_KIND_DETERMINISTIC,
                    MODULE.PREDICTION_KIND_FRONTIER,
                },
            )
            self.assertEqual(
                MODULE.lock_confirmatory_evaluation(
                    path,
                    predictions_sha256="a" * 64,
                    prediction_seal_sha256="b" * 64,
                    prediction_kind=MODULE.PREDICTION_KIND_DETERMINISTIC,
                    execution_receipt_sha256=None,
                    **shared,
                ),
                second,
            )

    def test_confirmatory_lock_path_is_fixed_to_the_study_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            MODULE.STUDY_ROOT = root
            self.assertEqual(
                MODULE.canonical_confirmatory_lock_path(),
                root.resolve() / "results" / "confirmatory-evaluation.lock.json",
            )


if __name__ == "__main__":
    unittest.main()
