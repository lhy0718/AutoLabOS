from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "access_preflight.py"
SPEC = importlib.util.spec_from_file_location("access_preflight", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class AccessPreflightTest(unittest.TestCase):
    def write_rows(self, rows):
        directory = tempfile.TemporaryDirectory()
        path = Path(directory.name) / "source.jsonl"
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        self.addCleanup(directory.cleanup)
        return path

    def test_groups_discrepancies_by_paper_without_reading_gold(self):
        path = self.write_rows(
            [
                {
                    "paper_url_versioned": "https://arxiv.org/pdf/1v1.pdf",
                    "code_url_versioned": "https://github.com/org/repo/tree/abcdef1",
                    "changed_code_files": {"file_name": ["secret.py"]},
                },
                {
                    "paper_url_versioned": "https://arxiv.org/pdf/1v1.pdf",
                    "code_url_versioned": "https://github.com/org/repo/tree/abcdef1",
                    "relevant_code_files_gpt": ["secret.py"],
                },
            ]
        )
        units = MODULE.build_units(path, "salt", ["changed_code_files", "relevant_code_files_gpt"])
        self.assertEqual(len(units), 1)
        self.assertNotIn("secret.py", repr(units[0]))

    def test_hash_order_is_input_order_independent(self):
        rows = [
            {
                "paper_url_versioned": f"https://arxiv.org/pdf/{index}v1.pdf",
                "code_url_versioned": f"https://github.com/org/repo{index}/tree/abcdef{index}",
            }
            for index in range(3)
        ]
        forward = MODULE.build_units(self.write_rows(rows), "salt", [])
        reverse = MODULE.build_units(self.write_rows(list(reversed(rows))), "salt", [])
        self.assertEqual([unit.unit_id for unit in forward], [unit.unit_id for unit in reverse])

    def test_normalizes_arxiv_abstract_and_pdf_urls(self):
        self.assertEqual(
            MODULE.paper_pdf_url("https://arxiv.org/abs/2304.01933v3"),
            "https://arxiv.org/pdf/2304.01933v3",
        )
        self.assertEqual(
            MODULE.paper_pdf_url("https://arxiv.org/pdf/2304.01933v3.pdf"),
            "https://arxiv.org/pdf/2304.01933v3",
        )

    def test_rejects_multiple_repositories_for_one_paper(self):
        path = self.write_rows(
            [
                {
                    "paper_url_versioned": "https://arxiv.org/pdf/1v1.pdf",
                    "code_url_versioned": "https://github.com/org/one/tree/abcdef1",
                },
                {
                    "paper_url_versioned": "https://arxiv.org/pdf/1v1.pdf",
                    "code_url_versioned": "https://github.com/org/two/tree/abcdef2",
                },
            ]
        )
        with self.assertRaisesRegex(ValueError, "versioned repositories"):
            MODULE.build_units(path, "salt", [])

    def test_rejects_one_repository_shared_by_multiple_papers(self):
        path = self.write_rows(
            [
                {
                    "paper_url_versioned": "https://arxiv.org/pdf/1v1.pdf",
                    "code_url_versioned": "https://github.com/org/shared/tree/abcdef1",
                },
                {
                    "paper_url_versioned": "https://arxiv.org/pdf/2v1.pdf",
                    "code_url_versioned": "https://github.com/org/shared/tree/abcdef1",
                },
            ]
        )
        with self.assertRaisesRegex(ValueError, "maps to multiple papers"):
            MODULE.build_units(path, "salt", [])

    def test_classifies_permissive_license_families(self):
        self.assertEqual(
            MODULE.classify_license("Permission is hereby granted, free of charge, to any person"),
            "MIT",
        )
        self.assertEqual(MODULE.classify_license("Apache License\nVersion 2.0"), "Apache-2.0")
        self.assertEqual(
            MODULE.classify_license("Redistribution and use in source and binary forms are permitted"),
            "BSD",
        )
        self.assertIsNone(MODULE.classify_license("all rights reserved"))

    def test_probe_requires_all_three_eligibility_checks(self):
        unit = MODULE.Unit(
            unit_id="u",
            paper_url="https://paper",
            code_url="https://github.com/org/repo/tree/abcdef1",
            archive_url="https://archive",
            owner="org",
            repository="repo",
            revision="abcdef1",
            ordering_hash="0" * 64,
        )

        def fetch(url, _max_bytes):
            if "raw.githubusercontent.com" in url and url.endswith("/LICENSE"):
                return True, b"Permission is hereby granted, free of charge", "http_200"
            if url.startswith("https://paper"):
                return True, b"%PDF-1.7", "http_206"
            return True, b"ok", "http_206"

        result = MODULE.probe_unit(unit, fetch)
        self.assertTrue(result["eligible"])
        self.assertEqual(result["license"], "MIT")

    def test_parallel_probe_preserves_hash_order(self):
        units = [
            MODULE.Unit(
                unit_id=str(index),
                paper_url=f"https://paper/{index}",
                code_url=f"https://github.com/org/repo{index}/tree/abcdef{index}",
                archive_url=f"https://archive/{index}",
                owner="org",
                repository=f"repo{index}",
                revision=f"abcdef{index}",
                ordering_hash=str(index) * 64,
            )
            for index in range(3)
        ]

        def fetch(url, _max_bytes):
            if "raw.githubusercontent.com" in url and url.endswith("/LICENSE"):
                return True, b"Permission is hereby granted, free of charge", "http_200"
            if url.startswith("https://paper"):
                return True, b"%PDF-1.7", "http_206"
            return True, b"ok", "http_206"

        records = MODULE.probe_units(units, fetch, workers=3)
        self.assertEqual([record["unit_id"] for record in records], ["0", "1", "2"])


if __name__ == "__main__":
    unittest.main()
