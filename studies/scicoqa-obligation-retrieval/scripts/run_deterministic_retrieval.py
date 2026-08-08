#!/usr/bin/env python3
"""Run frozen deterministic systems against a blind corpus manifest."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]
LIBRARY_PATH = ROOT / "lib" / "retrieval.py"
SPEC = importlib.util.spec_from_file_location("obligation_retrieval", LIBRARY_PATH)
assert SPEC is not None and SPEC.loader is not None
RETRIEVAL = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RETRIEVAL
SPEC.loader.exec_module(RETRIEVAL)

GOVERNANCE_PATH = ROOT / "lib" / "governance.py"
GOVERNANCE_SPEC = importlib.util.spec_from_file_location(
    "retrieval_governance",
    GOVERNANCE_PATH,
)
assert GOVERNANCE_SPEC is not None and GOVERNANCE_SPEC.loader is not None
GOVERNANCE = importlib.util.module_from_spec(GOVERNANCE_SPEC)
sys.modules[GOVERNANCE_SPEC.name] = GOVERNANCE
GOVERNANCE_SPEC.loader.exec_module(GOVERNANCE)

SYSTEMS = [
    "alphabetical_prefix",
    "whole_paper_bm25",
    "methods_only_bm25",
    "generic_hybrid",
    "deterministic_obligations",
]
FORBIDDEN_MANIFEST_KEYS = {
    "target_files",
    "changed_code_files",
    "changed_snippets",
    "discrepancy_type",
    "relevant_code_files",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--blind-manifest", type=Path, required=True)
    parser.add_argument("--cache-root", type=Path, required=True)
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument(
        "--freeze-receipt",
        type=Path,
        default=ROOT / "method" / "freeze-receipt.v3.json",
    )
    parser.add_argument("--split", choices=["development", "confirmatory"], required=True)
    parser.add_argument("--promotion-receipt", type=Path)
    parser.add_argument("--development-gold-root", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seal-output", type=Path, required=True)
    return parser.parse_args()


def verify_frozen_inputs(contract_path: Path, freeze_receipt_path: Path) -> None:
    receipt = json.loads(freeze_receipt_path.read_text(encoding="utf-8"))
    frozen_files = receipt["files"]
    checks = {
        contract_path: frozen_files["experiment-contract.v1.json"],
        ROOT / "lib" / "retrieval.py": frozen_files["../lib/retrieval.py"],
        ROOT / "lib" / "governance.py": frozen_files["../lib/governance.py"],
        Path(__file__): frozen_files["../scripts/run_deterministic_retrieval.py"],
    }
    for path, expected_hash in checks.items():
        if RETRIEVAL.sha256_file(path) != expected_hash:
            raise ValueError(f"frozen input hash mismatch: {path.name}")


def main() -> int:
    args = parse_args()
    canonical_freeze = ROOT / "method" / "freeze-receipt.v3.json"
    canonical_contract = ROOT / "method" / "experiment-contract.v1.json"
    if args.freeze_receipt.resolve() != canonical_freeze.resolve():
        raise ValueError("execution requires the canonical freeze receipt v3")
    if args.contract.resolve() != canonical_contract.resolve():
        raise ValueError("execution requires the canonical experiment contract")
    verify_frozen_inputs(args.contract, args.freeze_receipt)
    GOVERNANCE.validate_canonical_frozen_method(args.contract, args.blind_manifest)
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    contract_hash = RETRIEVAL.sha256_file(args.contract)
    manifest_sha256 = RETRIEVAL.sha256_file(args.blind_manifest)
    expected_manifest = contract["corpus"]["blind_manifest_sha256"]
    if manifest_sha256 != expected_manifest:
        raise ValueError(f"blind manifest hash mismatch: expected {expected_manifest}, got {manifest_sha256}")
    records = [json.loads(line) for line in args.blind_manifest.read_text(encoding="utf-8").splitlines()]
    for record in records:
        forbidden = FORBIDDEN_MANIFEST_KEYS & record.keys()
        if forbidden:
            raise ValueError(f"blind manifest contains forbidden keys: {sorted(forbidden)}")
    selected_records = [record for record in records if record["split"] == args.split]
    promotion_receipt_hash = None
    if args.split == "confirmatory":
        if args.development_gold_root is None:
            raise ValueError("confirmatory retrieval requires the development gold root")
        _, promotion_receipt_hash = GOVERNANCE.validate_promotion_receipt(
            args.promotion_receipt,
            args.contract,
            args.blind_manifest,
            args.cache_root,
            args.development_gold_root,
        )
    context = contract["context_budget"]
    encoder = GOVERNANCE.encoder_from_contract(contract)
    predictions = []
    for completed, record in enumerate(selected_records, start=1):
        paper_path, repository = RETRIEVAL.verify_blind_unit(args.cache_root, record)
        paper_text = paper_path.read_text(encoding="utf-8")
        chunks = RETRIEVAL.build_chunks(
            repository,
            encoder,
            int(context["chunk_tokens"]),
            int(context["chunk_overlap_tokens"]),
        )
        for system in SYSTEMS:
            ranking = RETRIEVAL.rank_chunks(system, paper_text, chunks)
            packed, used_tokens = RETRIEVAL.pack_chunks(chunks, ranking, int(context["selected_code_tokens"]))
            predictions.append(
                {
                    "unit_id": record["unit_id"],
                    "split": args.split,
                    "system": system,
                    "used_code_tokens": used_tokens,
                    "selected_chunk_ids": [chunk.chunk_id for chunk in packed],
                    "retrieved_files": RETRIEVAL.retrieved_files(packed),
                }
            )
        print(f"progress={completed}/{len(selected_records)} unit_id={record['unit_id']}", flush=True)
    payload = {
        "schema_version": "1.1",
        "prediction_kind": GOVERNANCE.PREDICTION_KIND_DETERMINISTIC,
        "split": args.split,
        "systems": SYSTEMS,
        "contract_sha256": contract_hash,
        "blind_manifest_sha256": manifest_sha256,
        "gold_fields_read": [],
        "records": predictions,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    GOVERNANCE.write_prediction_seal(
        args.seal_output,
        predictions_path=args.output,
        split=args.split,
        contract_sha256=contract_hash,
        blind_manifest_sha256=manifest_sha256,
        promotion_receipt_sha256=promotion_receipt_hash,
        prediction_kind=GOVERNANCE.PREDICTION_KIND_DETERMINISTIC,
        execution_receipt_sha256=None,
    )
    print(json.dumps({"units": len(selected_records), "predictions": len(predictions)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
