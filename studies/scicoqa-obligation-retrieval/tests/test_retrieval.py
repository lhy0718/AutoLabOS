from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

import tiktoken


MODULE_PATH = Path(__file__).parents[1] / "lib" / "retrieval.py"
SPEC = importlib.util.spec_from_file_location("obligation_retrieval", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class RetrievalTest(unittest.TestCase):
    def chunk(self, identifier, path, text, tokens=10):
        return MODULE.Chunk(identifier, path, 0, tokens, text, tokens)

    def test_methods_extraction_excludes_following_results(self):
        paper = "INTRODUCTION\nBackground.\n\n2 METHODS\nWe train with Adam.\nThe loss is cross entropy.\nA third method line.\n\n3 RESULTS\nAccuracy improves."
        methods = MODULE.extract_methods_text(paper)
        self.assertIn("Adam", methods)
        self.assertNotIn("Accuracy improves", methods)

    def test_deterministic_obligations_prioritize_implementation_sentences(self):
        paper = "METHODS\nWe train the encoder with Adam at learning rate 0.001.\nThis problem is important to society."
        obligations = MODULE.deterministic_obligations(paper)
        self.assertEqual(obligations, ["We train the encoder with Adam at learning rate 0.001."])

    def test_bm25_ranks_matching_code_first(self):
        chunks = [
            self.chunk("a", "src/data.py", "load and normalize images"),
            self.chunk("b", "src/model.py", "adam optimizer cross entropy loss"),
        ]
        ranking = MODULE.ranked_indexes(chunks, MODULE.bm25_scores("Adam loss", chunks))
        self.assertEqual(ranking[0], 1)

    def test_chunking_uses_frozen_overlap(self):
        encoder = tiktoken.get_encoding("o200k_base")
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "x.py").write_text("value = 1\n" * 200, encoding="utf-8")
            chunks = MODULE.build_chunks(root, encoder, chunk_tokens=32, overlap_tokens=8)
        self.assertGreater(len(chunks), 2)
        self.assertEqual(chunks[1].start_token, 24)

    def test_packing_never_exceeds_budget(self):
        chunks = [self.chunk("a", "a.py", "a", 7), self.chunk("b", "b.py", "b", 7)]
        selected, used = MODULE.pack_chunks(chunks, [0, 1], 10)
        self.assertEqual([chunk.chunk_id for chunk in selected], ["a"])
        self.assertEqual(used, 7)

    def test_file_recall_deduplicates_paths(self):
        self.assertEqual(MODULE.file_recall(["src/a.py", "src/a.py"], ["src/a.py", "src/b.py"]), 0.5)

    def test_blind_unit_verification_binds_paper_and_repository_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unit_id = "0000000000000001"
            unit_root = root / "blind" / unit_id
            repository = unit_root / "repository"
            repository.mkdir(parents=True)
            paper = unit_root / "paper.txt"
            paper.write_text("frozen paper", encoding="utf-8")
            source = repository / "source.py"
            source.write_text("value = 1\n", encoding="utf-8")
            record = {
                "unit_id": unit_id,
                "blind_paper_relative_path": f"blind/{unit_id}/paper.txt",
                "blind_repository_relative_path": f"blind/{unit_id}/repository",
                "paper_text_sha256": MODULE.sha256_file(paper),
                "mutated_repository_sha256": MODULE.sha256_tree(repository),
            }
            self.assertEqual(
                MODULE.verify_blind_unit(root, record),
                (paper, repository),
            )
            paper.write_text("poisoned paper", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "paper text hash mismatch"):
                MODULE.verify_blind_unit(root, record)

    def test_blind_unit_verification_rejects_repository_poisoning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unit_id = "0000000000000002"
            unit_root = root / "blind" / unit_id
            repository = unit_root / "repository"
            repository.mkdir(parents=True)
            paper = unit_root / "paper.txt"
            paper.write_text("frozen paper", encoding="utf-8")
            source = repository / "source.py"
            source.write_text("value = 1\n", encoding="utf-8")
            record = {
                "unit_id": unit_id,
                "blind_paper_relative_path": f"blind/{unit_id}/paper.txt",
                "blind_repository_relative_path": f"blind/{unit_id}/repository",
                "paper_text_sha256": MODULE.sha256_file(paper),
                "mutated_repository_sha256": MODULE.sha256_tree(repository),
            }
            source.write_text("value = 2\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "repository tree hash mismatch"):
                MODULE.verify_blind_unit(root, record)


if __name__ == "__main__":
    unittest.main()
