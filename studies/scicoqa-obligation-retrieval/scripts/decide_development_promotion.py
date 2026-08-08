#!/usr/bin/env python3
"""Derive the development promotion decision from sealed evaluation artifacts."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path


ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location(
    "retrieval_governance",
    ROOT / "lib" / "governance.py",
)
assert SPEC is not None and SPEC.loader is not None
GOVERNANCE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = GOVERNANCE
SPEC.loader.exec_module(GOVERNANCE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--blind-manifest", type=Path, required=True)
    parser.add_argument("--cache-root", type=Path, required=True)
    parser.add_argument("--frontier-predictions", type=Path, required=True)
    parser.add_argument("--frontier-prediction-seal", type=Path, required=True)
    parser.add_argument("--frontier-evaluation", type=Path, required=True)
    parser.add_argument("--deterministic-predictions", type=Path, required=True)
    parser.add_argument("--deterministic-prediction-seal", type=Path, required=True)
    parser.add_argument("--deterministic-evaluation", type=Path, required=True)
    parser.add_argument("--development-gold-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def relative_study_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(ROOT.resolve()).as_posix()
    except ValueError as exc:
        raise ValueError(f"promotion artifact must stay inside the study: {path}") from exc


def artifact_record(path: Path) -> dict[str, str]:
    return {
        "path": relative_study_path(path),
        "sha256": GOVERNANCE.sha256_file(path),
    }


def main() -> int:
    args = parse_args()
    GOVERNANCE.validate_canonical_frozen_method(args.contract, args.blind_manifest)
    if args.output.resolve().parent != ROOT.resolve() / "results":
        raise ValueError("promotion receipt must use the canonical study results directory")
    contract_sha256 = GOVERNANCE.sha256_file(args.contract)
    manifest_sha256 = GOVERNANCE.sha256_file(args.blind_manifest)
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    frontier_payload = json.loads(args.frontier_predictions.read_text(encoding="utf-8"))
    deterministic_payload = json.loads(
        args.deterministic_predictions.read_text(encoding="utf-8")
    )
    if (
        GOVERNANCE.validate_prediction_kind(frontier_payload, contract)
        != GOVERNANCE.PREDICTION_KIND_FRONTIER
    ):
        raise ValueError("frontier promotion input has the wrong prediction kind")
    if (
        GOVERNANCE.validate_prediction_kind(deterministic_payload, contract)
        != GOVERNANCE.PREDICTION_KIND_DETERMINISTIC
    ):
        raise ValueError("deterministic promotion input has the wrong prediction kind")
    manifest = [
        json.loads(line)
        for line in args.blind_manifest.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    GOVERNANCE.validate_deterministic_prediction_derivation(
        deterministic_payload,
        cache_root=args.cache_root,
        manifest=manifest,
        split="development",
        contract=contract,
    )
    frontier_execution_receipt = (
        GOVERNANCE.canonical_frontier_execution_receipt_path("development")
    )
    _, execution_receipt_hash = GOVERNANCE.validate_frontier_execution_receipt(
        frontier_execution_receipt,
        predictions_path=args.frontier_predictions,
        contract_path=args.contract,
        blind_manifest_path=args.blind_manifest,
        cache_root=args.cache_root,
        split="development",
    )
    GOVERNANCE.validate_prediction_seal(
        args.frontier_prediction_seal,
        predictions_path=args.frontier_predictions,
        split="development",
        contract_sha256=contract_sha256,
        blind_manifest_sha256=manifest_sha256,
        promotion_receipt_sha256=None,
        prediction_kind=GOVERNANCE.PREDICTION_KIND_FRONTIER,
        execution_receipt_sha256=execution_receipt_hash,
    )
    GOVERNANCE.validate_prediction_seal(
        args.deterministic_prediction_seal,
        predictions_path=args.deterministic_predictions,
        split="development",
        contract_sha256=contract_sha256,
        blind_manifest_sha256=manifest_sha256,
        promotion_receipt_sha256=None,
        prediction_kind=GOVERNANCE.PREDICTION_KIND_DETERMINISTIC,
        execution_receipt_sha256=None,
    )
    frontier_evaluation = json.loads(
        args.frontier_evaluation.read_text(encoding="utf-8")
    )
    deterministic_evaluation = json.loads(
        args.deterministic_evaluation.read_text(encoding="utf-8")
    )
    derived_frontier_evaluation = GOVERNANCE.derive_evaluation(
        args.frontier_predictions,
        args.contract,
        args.blind_manifest,
        args.development_gold_root,
        "development",
    )
    derived_deterministic_evaluation = GOVERNANCE.derive_evaluation(
        args.deterministic_predictions,
        args.contract,
        args.blind_manifest,
        args.development_gold_root,
        "development",
    )
    if frontier_evaluation != derived_frontier_evaluation:
        raise ValueError("frontier evaluation does not match recomputed development evidence")
    if deterministic_evaluation != derived_deterministic_evaluation:
        raise ValueError("deterministic evaluation does not match recomputed development evidence")
    gate = GOVERNANCE.compute_development_gate(
        contract,
        frontier_evaluation,
        deterministic_evaluation,
    )
    payload = {
        "schema_version": "1.0",
        "artifact_type": "development_promotion_receipt",
        "decision": "PROMOTE" if gate["passed"] else "KILL",
        "contract_sha256": contract_sha256,
        "blind_manifest_sha256": manifest_sha256,
        "development_gold_manifest_sha256":
            contract["corpus"]["sealed_gold_manifest_sha256"]["development"],
        "development_gate": gate,
        "development_artifacts": {
            "frontier_predictions": artifact_record(args.frontier_predictions),
            "frontier_prediction_seal": artifact_record(
                args.frontier_prediction_seal
            ),
            "frontier_execution_receipt": artifact_record(
                frontier_execution_receipt
            ),
            "frontier_evaluation": artifact_record(args.frontier_evaluation),
            "deterministic_predictions": artifact_record(
                args.deterministic_predictions
            ),
            "deterministic_prediction_seal": artifact_record(
                args.deterministic_prediction_seal
            ),
            "deterministic_evaluation": artifact_record(
                args.deterministic_evaluation
            ),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if args.output.exists() and args.output.read_text(encoding="utf-8") != serialized:
        raise ValueError("promotion receipt already records a different decision")
    args.output.write_text(serialized, encoding="utf-8")
    print(json.dumps({"decision": payload["decision"], "gate": gate}, sort_keys=True))
    return 0 if gate["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
