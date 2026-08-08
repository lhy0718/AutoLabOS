#!/usr/bin/env python3
"""Evaluate sealed file targets after gold-free rankings have been written."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path


LIBRARY_PATH = Path(__file__).parents[1] / "lib" / "retrieval.py"
SPEC = importlib.util.spec_from_file_location("obligation_retrieval", LIBRARY_PATH)
assert SPEC is not None and SPEC.loader is not None
RETRIEVAL = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RETRIEVAL
SPEC.loader.exec_module(RETRIEVAL)

GOVERNANCE_PATH = Path(__file__).parents[1] / "lib" / "governance.py"
GOVERNANCE_SPEC = importlib.util.spec_from_file_location("retrieval_governance", GOVERNANCE_PATH)
assert GOVERNANCE_SPEC is not None and GOVERNANCE_SPEC.loader is not None
GOVERNANCE = importlib.util.module_from_spec(GOVERNANCE_SPEC)
sys.modules[GOVERNANCE_SPEC.name] = GOVERNANCE
GOVERNANCE_SPEC.loader.exec_module(GOVERNANCE)
ROOT = Path(__file__).parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--blind-manifest", type=Path, required=True)
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--cache-root", type=Path, required=True)
    parser.add_argument("--sealed-gold-root", type=Path, required=True)
    parser.add_argument("--development-gold-root", type=Path)
    parser.add_argument("--split", choices=["development", "confirmatory"], required=True)
    parser.add_argument("--prediction-seal", type=Path, required=True)
    parser.add_argument("--promotion-receipt", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def require_sha256(value, field: str) -> None:
    if not isinstance(value, str) or len(value) != 64:
        raise ValueError(f"{field} must be a SHA-256 hex digest")
    try:
        int(value, 16)
    except ValueError as exc:
        raise ValueError(f"{field} must be a SHA-256 hex digest") from exc


def validate_prediction_payload(payload, contract, manifest) -> None:
    prediction_kind = GOVERNANCE.validate_prediction_kind(payload, contract)
    if payload.get("gold_fields_read") != []:
        raise ValueError("retrieval payload must declare zero gold fields read")
    split = payload.get("split")
    manifest_units = [
        record["unit_id"]
        for record in manifest
        if record.get("split") == split
    ]
    if len(manifest_units) != len(set(manifest_units)):
        raise ValueError("blind manifest contains duplicate unit ids")
    systems = payload.get("systems")
    if not isinstance(systems, list) or not systems or len(systems) != len(set(systems)):
        raise ValueError("prediction systems must be a non-empty unique list")
    contract_systems = {system["id"] for system in contract["systems"]}
    if not set(systems).issubset(contract_systems):
        raise ValueError("prediction payload contains an unknown system")
    records = payload.get("records")
    if not isinstance(records, list):
        raise ValueError("prediction records must be a list")
    expected_pairs = {
        (unit_id, system)
        for unit_id in manifest_units
        for system in systems
    }
    observed_pairs = []
    budget = int(contract["context_budget"]["selected_code_tokens"])
    for record in records:
        if record.get("split") != split:
            raise ValueError("prediction record split mismatch")
        pair = (record.get("unit_id"), record.get("system"))
        observed_pairs.append(pair)
        used_tokens = record.get("used_code_tokens")
        if not isinstance(used_tokens, int) or not 0 <= used_tokens <= budget:
            raise ValueError(f"selected-code budget violation: {pair}")
        retrieved_files = record.get("retrieved_files")
        if (
            not isinstance(retrieved_files, list)
            or any(not isinstance(path, str) for path in retrieved_files)
            or len(retrieved_files) != len(set(retrieved_files))
        ):
            raise ValueError(f"invalid retrieved-file list: {pair}")
        if record.get("invalid_output") is True and (
            used_tokens != 0
            or retrieved_files
            or record.get("selected_chunk_ids")
        ):
            raise ValueError(f"invalid model output must produce an empty ranking: {pair}")
    if len(observed_pairs) != len(set(observed_pairs)):
        raise ValueError("duplicate prediction pair")
    if set(observed_pairs) != expected_pairs:
        raise ValueError("prediction payload does not cover the complete unit-system grid")

    called_systems = set(contract["frontier_model_fairness"]["systems_with_calls"])
    required_provenance_pairs = {
        pair for pair in expected_pairs if pair[1] in called_systems
    }
    provenance = payload.get("provenance", [])
    if required_provenance_pairs and not isinstance(provenance, list):
        raise ValueError("frontier predictions require provenance records")
    observed_provenance_pairs = []
    for record in provenance:
        pair = (record.get("unit_id"), record.get("system"))
        observed_provenance_pairs.append(pair)
        if record.get("provider") != "openai_responses_api":
            raise ValueError(f"invalid frontier provider provenance: {pair}")
        if record.get("requested_model") != contract["frontier_model_fairness"]["model"]:
            raise ValueError(f"frontier model drift: {pair}")
        if record.get("effective_model") != contract["frontier_model_fairness"]["model"]:
            raise ValueError(f"frontier effective model drift: {pair}")
        if record.get("reasoning_effort") != contract["frontier_model_fairness"]["reasoning_effort"]:
            raise ValueError(f"frontier reasoning drift: {pair}")
        for field in ("prompt_sha256", "input_sha256", "response_sha256"):
            require_sha256(record.get(field), f"{pair}.{field}")
        if not isinstance(record.get("response_id"), str):
            raise ValueError(f"missing response id provenance: {pair}")
        if not isinstance(record.get("usage"), dict):
            raise ValueError(f"missing usage provenance: {pair}")
        if not isinstance(record.get("latency_ms"), (int, float)):
            raise ValueError(f"missing latency provenance: {pair}")
    if len(observed_provenance_pairs) != len(set(observed_provenance_pairs)):
        raise ValueError("duplicate frontier provenance pair")
    if set(observed_provenance_pairs) != required_provenance_pairs:
        raise ValueError("frontier provenance does not cover the complete called-system grid")
    if (
        prediction_kind == GOVERNANCE.PREDICTION_KIND_DETERMINISTIC
        and observed_provenance_pairs
    ):
        raise ValueError("deterministic predictions cannot contain frontier provenance")


def main() -> int:
    args = parse_args()
    GOVERNANCE.validate_canonical_frozen_method(args.contract, args.blind_manifest)
    prediction_sha256 = RETRIEVAL.sha256_file(args.predictions)
    payload = json.loads(args.predictions.read_text(encoding="utf-8"))
    if payload["split"] != args.split:
        raise ValueError("prediction split does not match requested evaluation split")
    contract_sha256 = RETRIEVAL.sha256_file(args.contract)
    if payload.get("contract_sha256") != contract_sha256:
        raise ValueError("prediction contract hash mismatch")
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    prediction_kind = GOVERNANCE.validate_prediction_kind(payload, contract)
    blind_manifest_sha256 = RETRIEVAL.sha256_file(args.blind_manifest)
    if (
        payload.get("blind_manifest_sha256") != blind_manifest_sha256
        or contract["corpus"]["blind_manifest_sha256"] != blind_manifest_sha256
    ):
        raise ValueError("prediction blind manifest hash mismatch")
    promotion_receipt_hash = None
    if args.split == "confirmatory":
        if args.development_gold_root is None:
            raise ValueError("confirmatory evaluation requires the development gold root")
        _, promotion_receipt_hash = GOVERNANCE.validate_promotion_receipt(
            args.promotion_receipt,
            args.contract,
            args.blind_manifest,
            args.cache_root,
            args.development_gold_root,
        )
    execution_receipt_hash = None
    if prediction_kind == GOVERNANCE.PREDICTION_KIND_FRONTIER:
        _, execution_receipt_hash = GOVERNANCE.validate_frontier_execution_receipt(
            GOVERNANCE.canonical_frontier_execution_receipt_path(args.split),
            predictions_path=args.predictions,
            contract_path=args.contract,
            blind_manifest_path=args.blind_manifest,
            cache_root=args.cache_root,
            split=args.split,
        )
    GOVERNANCE.validate_prediction_seal(
        args.prediction_seal,
        predictions_path=args.predictions,
        split=args.split,
        contract_sha256=contract_sha256,
        blind_manifest_sha256=blind_manifest_sha256,
        promotion_receipt_sha256=promotion_receipt_hash,
        prediction_kind=prediction_kind,
        execution_receipt_sha256=execution_receipt_hash,
    )
    manifest = [
        json.loads(line)
        for line in args.blind_manifest.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    validate_prediction_payload(payload, contract, manifest)
    if prediction_kind == GOVERNANCE.PREDICTION_KIND_DETERMINISTIC:
        GOVERNANCE.validate_deterministic_prediction_derivation(
            payload,
            cache_root=args.cache_root,
            manifest=manifest,
            split=args.split,
            contract=contract,
        )
    if args.split == "confirmatory":
        if promotion_receipt_hash is None:
            raise ValueError("confirmatory evaluation requires a promotion receipt")
        lock = GOVERNANCE.lock_confirmatory_evaluation(
            GOVERNANCE.canonical_confirmatory_lock_path(),
            predictions_sha256=prediction_sha256,
            prediction_seal_sha256=GOVERNANCE.sha256_file(args.prediction_seal),
            contract_sha256=contract_sha256,
            blind_manifest_sha256=blind_manifest_sha256,
            promotion_receipt_sha256=promotion_receipt_hash,
            prediction_kind=prediction_kind,
            execution_receipt_sha256=execution_receipt_hash,
        )
        if lock.get("complete") is not True:
            raise ValueError(
                "confirmatory evaluation lock is incomplete; register both frozen "
                "prediction kinds before reading confirmatory gold"
            )
    result = GOVERNANCE.derive_evaluation(
        args.predictions,
        args.contract,
        args.blind_manifest,
        args.sealed_gold_root,
        args.split,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result["summary"], sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
