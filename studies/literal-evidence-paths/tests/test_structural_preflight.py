from __future__ import annotations

import ast
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


STUDY_ROOT = Path(__file__).parents[1]
MODULE_PATH = STUDY_ROOT / "scripts" / "structural_preflight.py"
SPEC = importlib.util.spec_from_file_location("structural_preflight", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class StructuralPreflightTest(unittest.TestCase):
    def scan(self, source: str):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "exp" / "aggregate.py"
            path.parent.mkdir(parents=True)
            path.write_text(source, encoding="utf-8")
            return MODULE.scan_python_file(path, root)

    @staticmethod
    def expression(source: str):
        return ast.parse(source, mode="eval").body

    @staticmethod
    def frozen_gate():
        return {
            "minimum_confirmatory_workspaces_with_eligible_target": 40,
            "minimum_development_workspaces_with_eligible_target": 5,
            "python_parse_success_rate": 1.0,
            "mutation_parse_success_rate": 1.0,
            "maximum_duplicate_target_hash_rate": 0.05,
            "manual_development_mutation_validity": 1.0,
            "action_on_failure": "KILL",
        }

    @staticmethod
    def passing_summary():
        return {
            "confirmatory_eligible": 40,
            "development_eligible": 5,
            "python_parse_success_rate": 1.0,
            "mutation_parse_success_rate": 1.0,
            "duplicate_target_hash_rate": 0.0,
            "manual_development_mutation_validity": 1.0,
        }

    def test_finds_computed_value_in_json_dictionary(self):
        candidates, error = self.scan(
            "import json\n"
            "score = values.mean()\n"
            "with open('result.json', 'w') as handle:\n"
            "    json.dump({'score': score / 100}, handle)\n"
        )
        self.assertIsNone(error)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].sink_family, "json_serialization")
        self.assertEqual(candidates[0].expression_kind, "BinOp")

    def test_traces_container_assignment_before_json_dump(self):
        candidates, error = self.scan(
            "import json\n"
            "summary = {}\n"
            "summary['metric'] = float(raw_score)\n"
            "with open('result.json', 'w') as handle:\n"
            "    json.dump(summary, handle)\n"
        )
        self.assertIsNone(error)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].expression_kind, "Call")

    def test_does_not_trace_assignments_across_function_scopes(self):
        candidates, error = self.scan(
            "import json\n"
            "def collect():\n"
            "    payload = {}\n"
            "    payload['score'] = values.mean()\n"
            "    return payload\n"
            "def emit(payload, handle):\n"
            "    json.dump(payload, handle)\n"
        )
        self.assertIsNone(error)
        self.assertEqual(candidates, [])

    def test_dataframe_writer_scans_receiver_not_path_argument(self):
        candidates, error = self.scan(
            "import pandas as pd\n"
            "frame = pd.DataFrame({'score': values.mean()})\n"
            "frame.to_csv(path_score.mean())\n"
        )
        self.assertIsNone(error)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].line_start, 2)
        self.assertEqual(candidates[0].sink_call, "frame.to_csv")

    def test_dataframe_writer_ignores_path_binop(self):
        candidates, error = self.scan(
            "frame.to_parquet(output_dir / 'results.parquet')\n"
        )
        self.assertIsNone(error)
        self.assertEqual(candidates, [])

    def test_dataframe_writer_rejects_unreduced_column_vector(self):
        candidates, error = self.scan(
            "frame['copy'] = frame['score']\n"
            "frame.to_csv('results.csv')\n"
        )
        self.assertIsNone(error)
        self.assertEqual(candidates, [])

    def test_dataframe_writer_does_not_mutate_receiver_lookup(self):
        candidates, error = self.scan(
            "modes['extended'].to_parquet(path_score.mean())\n"
        )
        self.assertIsNone(error)
        self.assertEqual(candidates, [])

    def test_savetxt_and_torch_save_use_data_positions(self):
        candidates, error = self.scan(
            "import numpy as np\n"
            "import torch\n"
            "np.savetxt(path_score.mean(), [[table_score.std()]])\n"
            "torch.save(model_score.mean(), path_score.std())\n"
        )
        self.assertIsNone(error)
        self.assertEqual(len(candidates), 2)
        self.assertEqual(
            {candidate.expression_sha256 for candidate in candidates},
            {
                MODULE.sha256_text("table_score.std()"),
                MODULE.sha256_text("model_score.mean()"),
            },
        )

    def test_scalar_classifier_rejects_overbroad_binops(self):
        rejected = (
            "output_dir / 'results.csv'",
            "'prefix-' + suffix",
            "left | right",
            "matrix @ weights",
            "left + right",
        )
        for source in rejected:
            with self.subTest(source=source):
                self.assertFalse(MODULE.is_scalar_expression(self.expression(source)))
        self.assertTrue(MODULE.is_scalar_expression(self.expression("score / 100")))

    def test_scalar_classifier_rejects_dynamic_and_sliced_subscripts(self):
        self.assertFalse(MODULE.is_scalar_expression(self.expression("results[key]")))
        self.assertFalse(MODULE.is_scalar_expression(self.expression("values[1:3]")))
        self.assertFalse(MODULE.is_scalar_expression(self.expression("results['score']")))
        self.assertFalse(MODULE.is_scalar_expression(self.expression("values[0]")))
        self.assertFalse(MODULE.is_scalar_expression(self.expression("ds['data']")))
        self.assertFalse(MODULE.is_scalar_expression(self.expression("timeline['epoch']")))
        self.assertTrue(
            MODULE.is_scalar_expression(self.expression("results['score'].item()"))
        )
        self.assertTrue(
            MODULE.is_scalar_expression(self.expression("float(results['score'])"))
        )

    def test_ignores_existing_literal(self):
        candidates, error = self.scan(
            "import json\n"
            "with open('result.json', 'w') as handle:\n"
            "    json.dump({'score': 0.5}, handle)\n"
        )
        self.assertIsNone(error)
        self.assertEqual(candidates, [])

    def test_requires_saved_figure_for_plot_data(self):
        candidates, error = self.scan("plotter.plot(x, values.mean())\n")
        self.assertIsNone(error)
        self.assertEqual(candidates, [])

    def test_reports_syntax_error(self):
        candidates, error = self.scan("def broken(:\n")
        self.assertEqual(candidates, [])
        self.assertIn("SyntaxError", error)

    def test_manuscript_literals_preserve_source_token_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "paper.tex"
            path.write_text("rate 0.025 and seed 25\n", encoding="utf-8")
            literals = MODULE.manuscript_numeric_literals(path)
        self.assertIn(
            MODULE.ManuscriptLiteral(source_token="0.025", python_literal="0.025"),
            literals,
        )
        self.assertIn(
            MODULE.ManuscriptLiteral(source_token="25", python_literal="25"),
            literals,
        )

    def test_mutation_replaces_one_span_and_reparses(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source_path = workspace / "exp" / "aggregate.py"
            source_path.parent.mkdir(parents=True)
            source_path.write_text(
                "import json\njson.dump({'score': score / 100}, handle)\n",
                encoding="utf-8",
            )
            paper_path = workspace / "paper.tex"
            paper_path.write_text("The measured score was 0.5.\n", encoding="utf-8")
            candidates, error = MODULE.scan_python_file(source_path, workspace)
            self.assertIsNone(error)
            mutation, literal = MODULE.evaluate_mutation(
                workspace,
                paper_path,
                "workspace-id",
                candidates[0],
            )
        self.assertIsNotNone(literal)
        self.assertTrue(mutation["attempted"])
        self.assertTrue(mutation["parse_success"])
        self.assertRegex(mutation["mutated_file_sha256"], r"^[0-9a-f]{64}$")

    def test_evaluates_every_declared_frozen_gate(self):
        results = MODULE.evaluate_frozen_gates(
            self.frozen_gate(),
            self.passing_summary(),
        )
        self.assertEqual(set(results), set(MODULE.FROZEN_NUMERIC_GATES))
        self.assertTrue(all(result["passed"] for result in results.values()))
        self.assertEqual(
            results["maximum_duplicate_target_hash_rate"]["operator"],
            "<=",
        )

    def test_frozen_gate_failures_are_not_collapsed_into_eligibility_only(self):
        summary = self.passing_summary()
        summary["mutation_parse_success_rate"] = 0.9
        summary["duplicate_target_hash_rate"] = 0.1
        summary["manual_development_mutation_validity"] = 0.5
        results = MODULE.evaluate_frozen_gates(self.frozen_gate(), summary)
        failed = {name for name, result in results.items() if not result["passed"]}
        self.assertEqual(
            failed,
            {
                "mutation_parse_success_rate",
                "maximum_duplicate_target_hash_rate",
                "manual_development_mutation_validity",
            },
        )

    def test_manual_audit_declared_count_must_match_current_development_mutations(self):
        records = [
            {
                "source_path": "papers/example/workspace",
                "split": "development",
                "selected_candidate": {},
                "selected_mutation": {},
            }
        ]
        audit = {
            "artifact_kind": "literal_evidence_paths_manual_development_mutation_audit",
            "corpus_commit": "revision",
            "source_registry_sha256": "registry",
            "generated_mutation_count": 0,
            "records": [],
        }
        with self.assertRaisesRegex(ValueError, "mutation count does not match"):
            MODULE.evaluate_manual_audit(records, audit, "revision", "registry")

    def test_rejects_unimplemented_frozen_gate(self):
        frozen_gate = self.frozen_gate()
        frozen_gate["new_unimplemented_gate"] = 1.0
        with self.assertRaisesRegex(ValueError, "unsupported frozen gate keys"):
            MODULE.evaluate_frozen_gates(frozen_gate, self.passing_summary())

    def test_kill_decision_returns_nonzero(self):
        self.assertEqual(MODULE.decision_exit_code("KILL"), MODULE.KILL_EXIT_CODE)
        self.assertNotEqual(MODULE.decision_exit_code("KILL"), 0)
        self.assertEqual(MODULE.decision_exit_code("PASS_PREFLIGHT"), 0)

    def test_rejects_noncanonical_result_and_termination_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "canonical study path"):
                MODULE.validate_output_paths(
                    root / "result.json",
                    root / "termination.json",
                )
            MODULE.validate_output_paths(MODULE.CANONICAL_RESULT, None)

    def test_only_kill_requires_a_termination_receipt(self):
        MODULE.require_termination_receipt("PASS_PREFLIGHT", None)
        with self.assertRaisesRegex(ValueError, "KILL decision requires"):
            MODULE.require_termination_receipt("KILL", None)
        MODULE.require_termination_receipt("KILL", MODULE.CANONICAL_TERMINATION)

    def test_contract_cryptographically_pins_registry_and_manual_audit(self):
        contract = json.loads(
            (STUDY_ROOT / "method" / "preflight-contract.v1.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(
            contract["corpus"]["registry_sha256"],
            MODULE.sha256_file(STUDY_ROOT / "corpus" / "source.v1.json"),
        )
        audit_spec = contract["structural_preflight_evidence"][
            "manual_development_mutation_audit"
        ]
        self.assertEqual(
            audit_spec["sha256"],
            MODULE.sha256_file(
                STUDY_ROOT / "method" / "manual-development-mutation-audit.v1.json"
            ),
        )

    def test_rejects_an_arbitrary_self_asserted_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "contract.json"
            path.write_text(
                json.dumps(
                    {
                        "status": "frozen_pre_execution",
                        "corpus": {
                            "registry": "arbitrary.json",
                            "registry_sha256": "0" * 64,
                        },
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "canonical study file"):
                MODULE.load_canonical_configuration(path)

    def test_source_registry_pins_the_paper_index_hash(self):
        registry = json.loads(
            (STUDY_ROOT / "corpus" / "source.v1.json").read_text(encoding="utf-8")
        )
        self.assertRegex(
            registry["selection"]["metadata_sha256"],
            r"^[0-9a-f]{64}$",
        )

    def test_rejects_a_paper_index_that_does_not_match_the_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "papers.html"
            path.write_text("<html>different</html>", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "paper index hash mismatch"):
                MODULE.verify_paper_index(
                    path,
                    {"selection": {"metadata_sha256": "0" * 64}},
                )


if __name__ == "__main__":
    unittest.main()
