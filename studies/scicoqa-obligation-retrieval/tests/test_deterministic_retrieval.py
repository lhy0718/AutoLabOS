from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = (
    Path(__file__).parents[1] / "scripts" / "run_deterministic_retrieval.py"
)
SPEC = importlib.util.spec_from_file_location("run_deterministic_retrieval", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class DeterministicRetrievalTest(unittest.TestCase):
    def setUp(self):
        self.original_root = MODULE.ROOT

    def tearDown(self):
        MODULE.ROOT = self.original_root

    @staticmethod
    def _fixture(root: Path, development_gold_root: Path | None) -> argparse.Namespace:
        manifest = root / "manifest.jsonl"
        manifest.write_text(
            json.dumps({
                "unit_id": "0000000000000001",
                "split": "confirmatory",
            }) + "\n",
            encoding="utf-8",
        )
        contract = root / "method" / "experiment-contract.v1.json"
        contract.parent.mkdir()
        contract.write_text(
            json.dumps({
                "corpus": {"blind_manifest_sha256": MODULE.RETRIEVAL.sha256_file(manifest)},
            }),
            encoding="utf-8",
        )
        freeze = root / "method" / "freeze-receipt.v3.json"
        freeze.write_text(
            json.dumps({
                "files": {
                    "experiment-contract.v1.json": MODULE.RETRIEVAL.sha256_file(contract),
                },
            }),
            encoding="utf-8",
        )
        return argparse.Namespace(
            blind_manifest=manifest,
            cache_root=root / "cache",
            contract=contract,
            freeze_receipt=freeze,
            split="confirmatory",
            promotion_receipt=root / "promotion.json",
            development_gold_root=development_gold_root,
            output=root / "predictions.json",
            seal_output=root / "seal.json",
        )

    def test_confirmatory_run_requires_development_gold_for_promotion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            MODULE.ROOT = root
            args = self._fixture(root, None)
            with patch.object(MODULE, "parse_args", return_value=args), patch.object(
                MODULE, "verify_frozen_inputs"
            ), patch.object(
                MODULE.GOVERNANCE, "validate_canonical_frozen_method"
            ):
                with self.assertRaisesRegex(ValueError, "development gold root"):
                    MODULE.main()

    def test_confirmatory_run_cannot_bypass_promotion_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            MODULE.ROOT = root
            args = self._fixture(root, root / "sealed" / "development-gold")
            with patch.object(MODULE, "parse_args", return_value=args), patch.object(
                MODULE, "verify_frozen_inputs"
            ), patch.object(
                MODULE.GOVERNANCE, "validate_canonical_frozen_method"
            ):
                with patch.object(
                    MODULE.GOVERNANCE,
                    "validate_promotion_receipt",
                    side_effect=ValueError("promotion rejected"),
                ) as validate:
                    with self.assertRaisesRegex(ValueError, "promotion rejected"):
                        MODULE.main()
            validate.assert_called_once_with(
                args.promotion_receipt,
                args.contract,
                args.blind_manifest,
                args.cache_root,
                args.development_gold_root,
            )


if __name__ == "__main__":
    unittest.main()
