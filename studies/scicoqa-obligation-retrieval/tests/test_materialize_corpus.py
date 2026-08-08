from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "materialize_corpus.py"
SPEC = importlib.util.spec_from_file_location("materialize_corpus", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


CONTRACT = {
    "corpus": {
        "excluded_directory_names": [".git", "docs", "tests", "examples"],
        "candidate_extensions": [".py", ".yaml"],
        "maximum_source_file_bytes": 1024,
    }
}


class MaterializeCorpusTest(unittest.TestCase):
    def archive(self, members):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "repo.zip"
        with zipfile.ZipFile(path, "w") as bundle:
            for name, body in members.items():
                bundle.writestr(name, body)
        return path

    def test_rejects_path_traversal(self):
        path = self.archive({"../escape.py": "print('bad')"})
        with self.assertRaisesRegex(ValueError, "unsafe archive member"):
            MODULE.load_candidate_files(path, CONTRACT)

    def test_normalizes_arxiv_abstract_url_for_pdf_download(self):
        self.assertEqual(
            MODULE.paper_pdf_url("https://arxiv.org/abs/2304.01933v3"),
            "https://arxiv.org/pdf/2304.01933v3",
        )

    def test_pdf_validation_requires_header_and_eof(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "paper.pdf"
        path.write_bytes(b"%PDF-1.7\npartial")
        self.assertFalse(MODULE.valid_pdf(path))
        path.write_bytes(b"%PDF-1.7\nbody\n%%EOF\n")
        self.assertTrue(MODULE.valid_pdf(path))

    def test_filters_directories_and_converts_notebooks(self):
        notebook = json.dumps(
            {"cells": [{"cell_type": "code", "source": ["x = 1\n"], "outputs": [{"text": "secret"}]}]}
        )
        path = self.archive(
            {
                "root/src/main.py": "print('ok')",
                "root/tests/test_main.py": "assert True",
                "root/notebook.ipynb": notebook,
                "root/image.bin": "ignored",
            }
        )
        files = MODULE.load_candidate_files(path, CONTRACT)
        self.assertEqual(set(files), {"src/main.py", "notebook.py"})
        self.assertIn("x = 1", files["notebook.py"])
        self.assertNotIn("secret", files["notebook.py"])

    def test_mutation_map_is_last_write_wins_and_deduplicates_gold(self):
        rows = [
            {
                "discrepancy_type": "Difference",
                "changed_code_files": {"file_name": ["src/a.py"], "discrepancy_code": ["first"]},
            },
            {
                "discrepancy_type": "Paper Omission",
                "changed_code_files": {"file_name": ["src/a.py"], "discrepancy_code": ["second"]},
            },
        ]
        replacements, targets, types, conflicts = MODULE.mutation_map(rows)
        self.assertEqual(replacements, {"src/a.py": "second"})
        self.assertEqual(targets, ["src/a.py"])
        self.assertEqual(types, ["Difference", "Paper Omission"])
        self.assertEqual(conflicts, 1)

    def test_component_detection_groups_exact_snapshots(self):
        def unit(identifier, snapshot, features):
            return MODULE.MaterializedUnit(
                unit_id=identifier,
                ordering_hash=identifier * 64,
                paper_url="paper",
                code_url="code",
                paper_sha256="p",
                paper_text_sha256="pt",
                archive_sha256="a",
                original_snapshot_sha256=snapshot,
                mutated_repository_sha256="m",
                candidate_file_count=1,
                candidate_source_bytes=1,
                candidate_source_tokens=1,
                fingerprint_features=tuple(features),
                mutation_conflicts=0,
                mutation_targets_missing_from_candidate_universe=0,
                target_files=("src/main.py",),
                discrepancy_types=("Difference",),
            )

        groups = MODULE.components(
            [unit("1", "same", ["a"]), unit("2", "same", ["b"]), unit("3", "other", ["c"])]
        )
        self.assertEqual(sorted(len(group) for group in groups), [1, 2])

    def test_access_receipt_rejects_unsafe_unit_id_before_materialization(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        receipt = root / "receipt.json"
        registry = root / "source.json"
        receipt.write_text(
            json.dumps({
                "decision": "PASS_PREFLIGHT",
                "records": [{"unit_id": "../escape"}],
            }),
            encoding="utf-8",
        )
        registry.write_text("{}", encoding="utf-8")
        contract = {
            "corpus": {
                "access_receipt_sha256": MODULE.sha256_file(receipt),
                "source_registry_sha256": MODULE.sha256_file(registry),
            }
        }
        with self.assertRaisesRegex(ValueError, "unsafe unit id"):
            MODULE.validate_access_receipt(receipt, json.loads(receipt.read_text()), registry, contract)

    def test_gold_bundle_is_split_specific_and_hash_bound(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        unit = MODULE.MaterializedUnit(
            unit_id="0123456789abcdef",
            ordering_hash="0" * 64,
            paper_url="paper",
            code_url="code",
            paper_sha256="p",
            paper_text_sha256="pt",
            archive_sha256="a",
            original_snapshot_sha256="o",
            mutated_repository_sha256="m",
            candidate_file_count=1,
            candidate_source_bytes=1,
            candidate_source_tokens=1,
            fingerprint_features=("feature",),
            mutation_conflicts=0,
            mutation_targets_missing_from_candidate_universe=0,
            target_files=("src/main.py",),
            discrepancy_types=("Difference",),
        )
        manifest, digest = MODULE.write_gold_bundle(
            Path(directory.name),
            "development",
            [unit],
        )
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        self.assertEqual(payload["split"], "development")
        self.assertEqual(payload["records"][0]["unit_id"], unit.unit_id)
        self.assertEqual(MODULE.sha256_file(manifest), digest)

    def test_dataset_source_must_match_registry_and_access_receipt(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        dataset = Path(directory.name) / "dataset.jsonl"
        dataset.write_text('{"row": 1}\n', encoding="utf-8")
        digest = MODULE.sha256_file(dataset)
        self.assertEqual(
            MODULE.verify_dataset_source(
                dataset,
                {"dataset_sha256": digest},
                {"source_dataset_sha256": digest},
            ),
            digest,
        )
        with self.assertRaisesRegex(ValueError, "source registry"):
            MODULE.verify_dataset_source(
                dataset,
                {"dataset_sha256": "0" * 64},
                {"source_dataset_sha256": digest},
            )


if __name__ == "__main__":
    unittest.main()
