#!/usr/bin/env python3
"""Run equal-call frontier selector and obligation retrieval systems."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parents[1]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


RETRIEVAL = load_module("obligation_retrieval", ROOT / "lib" / "retrieval.py")
FRONTIER = load_module("frontier_retrieval", ROOT / "lib" / "frontier_retrieval.py")
GOVERNANCE = load_module("retrieval_governance", ROOT / "lib" / "governance.py")
SYSTEMS = ("generic_frontier_selector", "frontier_obligations")


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
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seal-output", type=Path, required=True)
    return parser.parse_args()


def fill_prompt(template: str, **values: str) -> str:
    return FRONTIER.fill_prompt(template, **values)


def cached_or_call(cache_path: Path, request_hash: str, api_key: str, model: str, effort: str, prompt: str):
    if cache_path.exists():
        raise ValueError(
            "paper-grade frontier cache reuse is forbidden; use a fresh empty cache root"
        )
    started = time.monotonic()
    response = FRONTIER.call_responses_api(api_key, model, effort, prompt)
    if not isinstance(response.get("id"), str):
        raise RuntimeError("Responses API payload is missing response id provenance")
    if response.get("model") != model:
        raise RuntimeError("Responses API effective model does not match the frozen contract")
    if not isinstance(response.get("usage"), dict):
        raise RuntimeError("Responses API payload is missing usage provenance")
    output_text = FRONTIER.extract_output_text(response)
    invalid_output_reason = None
    try:
        parsed = FRONTIER.parse_json_output(output_text)
    except (TypeError, ValueError):
        parsed = None
        invalid_output_reason = "invalid_json_object"
    record = {
        "provider": "openai_responses_api",
        "requested_model": model,
        "reasoning_effort": effort,
        "prompt_sha256": FRONTIER.sha256_text(prompt),
        "request_max_output_tokens": GOVERNANCE.PAPER_GRADE_MAX_OUTPUT_TOKENS,
        "request_sha256": request_hash,
        "input_sha256": request_hash,
        "response_sha256": FRONTIER.sha256_json(response),
        "response_id": response.get("id"),
        "effective_model": response.get("model"),
        "usage": response.get("usage"),
        "latency_ms": round((time.monotonic() - started) * 1000),
        "output_text_sha256": FRONTIER.sha256_text(output_text),
        "response": response,
        "parsed": parsed,
        "invalid_output_reason": invalid_output_reason,
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with cache_path.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(record, indent=2, sort_keys=True) + "\n")
    return record


def resolve_ranking(system, parsed, allowed_paths, paper_text, chunks):
    return FRONTIER.resolve_system_ranking(
        system,
        parsed,
        allowed_paths,
        paper_text,
        chunks,
        RETRIEVAL,
    )


def verify_frozen_inputs(contract_path: Path, freeze_receipt_path: Path) -> None:
    receipt = json.loads(freeze_receipt_path.read_text(encoding="utf-8"))
    frozen_files = receipt["files"]
    checks = {
        contract_path: frozen_files["experiment-contract.v1.json"],
        ROOT / "method" / "prompts" / "frontier-obligations.v1.txt":
            frozen_files["prompts/frontier-obligations.v1.txt"],
        ROOT / "method" / "prompts" / "generic-selector.v1.txt":
            frozen_files["prompts/generic-selector.v1.txt"],
        ROOT / "lib" / "retrieval.py": frozen_files["../lib/retrieval.py"],
        ROOT / "lib" / "frontier_retrieval.py":
            frozen_files["../lib/frontier_retrieval.py"],
        ROOT / "lib" / "governance.py": frozen_files["../lib/governance.py"],
        Path(__file__): frozen_files["../scripts/run_frontier_retrieval.py"],
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
    api_key = os.environ.get("OPENAI_API_KEY") or FRONTIER.load_env_key(args.env_file, "OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for paper-grade frontier retrieval; Codex mock is not accepted")
    verify_frozen_inputs(args.contract, args.freeze_receipt)
    GOVERNANCE.validate_canonical_frozen_method(args.contract, args.blind_manifest)
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    contract_hash = RETRIEVAL.sha256_file(args.contract)
    manifest_hash = RETRIEVAL.sha256_file(args.blind_manifest)
    if manifest_hash != contract["corpus"]["blind_manifest_sha256"]:
        raise ValueError("blind manifest hash mismatch")
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
    model_contract = contract["frontier_model_fairness"]
    model = str(model_contract["model"])
    effort = str(model_contract["reasoning_effort"])
    execution_receipt_path = GOVERNANCE.canonical_frontier_execution_receipt_path(
        args.split
    )
    if execution_receipt_path.exists():
        raise ValueError(
            "paper-grade frontier execution receipt already exists; "
            "a fresh execution requires an empty canonical receipt path"
        )
    context = contract["context_budget"]
    encoder = GOVERNANCE.encoder_from_contract(contract)
    obligation_template_path = ROOT / "method" / "prompts" / "frontier-obligations.v1.txt"
    selector_template_path = ROOT / "method" / "prompts" / "generic-selector.v1.txt"
    obligation_template = obligation_template_path.read_text(encoding="utf-8")
    selector_template = selector_template_path.read_text(encoding="utf-8")
    manifest = [json.loads(line) for line in args.blind_manifest.read_text(encoding="utf-8").splitlines()]
    units = [record for record in manifest if record["split"] == args.split]
    predictions = []
    provenance = []
    raw_provider_records = []
    for completed, unit in enumerate(units, start=1):
        paper_path, repository = RETRIEVAL.verify_blind_unit(args.cache_root, unit)
        paper_text = paper_path.read_text(encoding="utf-8")
        chunks = RETRIEVAL.build_chunks(
            repository,
            encoder,
            int(context["chunk_tokens"]),
            int(context["chunk_overlap_tokens"]),
        )
        allowed_paths = {chunk.path for chunk in chunks}
        repository_map = FRONTIER.build_repository_map(repository, allowed_paths)
        prompts = {
            "generic_frontier_selector": fill_prompt(
                selector_template,
                paper_text=paper_text,
                repository_map=repository_map,
            ),
            "frontier_obligations": fill_prompt(obligation_template, paper_text=paper_text),
        }
        for system in SYSTEMS:
            prompt = prompts[system]
            prompt_hash = FRONTIER.sha256_text(prompt)
            request_hash = FRONTIER.sha256_json(
                FRONTIER.build_responses_request(model, effort, prompt)
            )
            cache_path = args.cache_root / "frontier" / args.split / system / f"{unit['unit_id']}.json"
            call = cached_or_call(cache_path, request_hash, api_key, model, effort, prompt)
            parsed = call["parsed"]
            invalid_output_reason = call.get("invalid_output_reason")
            ranking, schema_error = resolve_ranking(
                system,
                parsed,
                allowed_paths,
                paper_text,
                chunks,
            )
            invalid_output_reason = invalid_output_reason or schema_error
            packed, used_tokens = RETRIEVAL.pack_chunks(chunks, ranking, int(context["selected_code_tokens"]))
            predictions.append(
                {
                    "unit_id": unit["unit_id"],
                    "split": args.split,
                    "system": system,
                    "used_code_tokens": used_tokens,
                    "selected_chunk_ids": [chunk.chunk_id for chunk in packed],
                    "retrieved_files": RETRIEVAL.retrieved_files(packed),
                    "invalid_output": invalid_output_reason is not None,
                }
            )
            provenance.append(
                {
                    "unit_id": unit["unit_id"],
                    "system": system,
                    "provider": "openai_responses_api",
                    "requested_model": model,
                    "effective_model": call.get("effective_model"),
                    "reasoning_effort": effort,
                    "prompt_sha256": prompt_hash,
                    "input_sha256": call.get("input_sha256"),
                    "request_sha256": request_hash,
                    "response_id": call.get("response_id"),
                    "response_sha256": call.get("response_sha256"),
                    "output_text_sha256": call.get("output_text_sha256"),
                    "usage": call.get("usage"),
                    "latency_ms": call.get("latency_ms"),
                    "request_max_output_tokens":
                        GOVERNANCE.PAPER_GRADE_MAX_OUTPUT_TOKENS,
                    "valid_output": invalid_output_reason is None,
                    "invalid_output_reason": invalid_output_reason,
                }
            )
            raw_provider_records.append({
                "unit_id": unit["unit_id"],
                "system": system,
                "record": call,
            })
        print(f"progress={completed}/{len(units)} unit_id={unit['unit_id']}", flush=True)
    payload = {
        "schema_version": "1.1",
        "prediction_kind": GOVERNANCE.PREDICTION_KIND_FRONTIER,
        "split": args.split,
        "systems": list(SYSTEMS),
        "contract_sha256": contract_hash,
        "blind_manifest_sha256": manifest_hash,
        "gold_fields_read": [],
        "provider": "openai_responses_api",
        "requested_model": model,
        "reasoning_effort": effort,
        "records": predictions,
        "provenance": provenance,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    GOVERNANCE.write_frontier_execution_receipt(
        execution_receipt_path,
        predictions_path=args.output,
        contract_path=args.contract,
        blind_manifest_path=args.blind_manifest,
        cache_root=args.cache_root,
        raw_provider_records=raw_provider_records,
    )
    execution_receipt_hash = GOVERNANCE.sha256_file(execution_receipt_path)
    GOVERNANCE.write_prediction_seal(
        args.seal_output,
        predictions_path=args.output,
        split=args.split,
        contract_sha256=contract_hash,
        blind_manifest_sha256=manifest_hash,
        promotion_receipt_sha256=promotion_receipt_hash,
        prediction_kind=GOVERNANCE.PREDICTION_KIND_FRONTIER,
        execution_receipt_sha256=execution_receipt_hash,
    )
    print(json.dumps({
        "units": len(units),
        "calls": len(provenance),
        "execution_receipt": execution_receipt_path.as_posix(),
        "execution_receipt_sha256": execution_receipt_hash,
    }), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
