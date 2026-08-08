"""Fail-closed promotion, sealing, and confirmatory-evaluation helpers."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import statistics
import sys
from pathlib import Path


STUDY_ROOT = Path(__file__).parents[1]
LIBRARY_ROOT = Path(__file__).resolve().parent
PREDICTION_KIND_DETERMINISTIC = "deterministic"
PREDICTION_KIND_FRONTIER = "frontier_provider"
PAPER_GRADE_MAX_OUTPUT_TOKENS = 6000

FROZEN_METHOD_BINDINGS = {
    "experiment-contract.v1.json": "method/experiment-contract.v1.json",
    "prompts/frontier-obligations.v1.txt":
        "method/prompts/frontier-obligations.v1.txt",
    "prompts/generic-selector.v1.txt": "method/prompts/generic-selector.v1.txt",
    "../corpus/blind-manifest.v1.jsonl": "corpus/blind-manifest.v1.jsonl",
    "../lib/retrieval.py": "lib/retrieval.py",
    "../lib/frontier_retrieval.py": "lib/frontier_retrieval.py",
    "../lib/governance.py": "lib/governance.py",
    "../scripts/run_deterministic_retrieval.py":
        "scripts/run_deterministic_retrieval.py",
    "../scripts/run_frontier_retrieval.py":
        "scripts/run_frontier_retrieval.py",
    "../scripts/evaluate_rankings.py": "scripts/evaluate_rankings.py",
    "../scripts/decide_development_promotion.py":
        "scripts/decide_development_promotion.py",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_json(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def require_sha256(value: object, field: str) -> str:
    if not isinstance(value, str) or len(value) != 64:
        raise ValueError(f"{field} must be a SHA-256 hex digest")
    try:
        int(value, 16)
    except ValueError as exc:
        raise ValueError(f"{field} must be a SHA-256 hex digest") from exc
    return value


def canonical_confirmatory_lock_path() -> Path:
    return STUDY_ROOT.resolve() / "results" / "confirmatory-evaluation.lock.json"


def canonical_freeze_receipt_path() -> Path:
    return STUDY_ROOT.resolve() / "method" / "freeze-receipt.v3.json"


def canonical_frontier_execution_receipt_path(split: str) -> Path:
    if split not in {"development", "confirmatory"}:
        raise ValueError("frontier execution receipt requires a governed split")
    return (
        STUDY_ROOT.resolve()
        / "results"
        / f"{split}-frontier-execution-receipt.v1.json"
    )


def validate_canonical_frozen_method(
    contract_path: Path,
    blind_manifest_path: Path,
) -> tuple[dict[str, object], str]:
    root = STUDY_ROOT.resolve()
    canonical_contract = root / "method" / "experiment-contract.v1.json"
    canonical_manifest = root / "corpus" / "blind-manifest.v1.jsonl"
    if contract_path.resolve() != canonical_contract:
        raise ValueError("method validation requires the canonical experiment contract")
    if blind_manifest_path.resolve() != canonical_manifest:
        raise ValueError("method validation requires the canonical blind manifest")

    receipt_path = canonical_freeze_receipt_path()
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if receipt.get("schema_version") != "3.0":
        raise ValueError("method validation requires freeze receipt schema 3.0")
    files = receipt.get("files")
    if not isinstance(files, dict):
        raise ValueError("canonical freeze receipt is missing file bindings")
    for receipt_key, study_relative in FROZEN_METHOD_BINDINGS.items():
        expected_hash = require_sha256(
            files.get(receipt_key),
            f"freeze.files.{receipt_key}",
        )
        candidate = (root / study_relative).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            raise ValueError(f"frozen method file is missing: {study_relative}")
        if sha256_file(candidate) != expected_hash:
            raise ValueError(f"frozen method hash mismatch: {study_relative}")

    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    manifest_sha256 = sha256_file(blind_manifest_path)
    binding = receipt.get("dataset_binding")
    if not isinstance(binding, dict):
        raise ValueError("canonical freeze receipt is missing dataset binding")
    if binding.get("blind_manifest_sha256") != manifest_sha256:
        raise ValueError("freeze receipt blind manifest hash mismatch")
    if contract.get("corpus", {}).get("blind_manifest_sha256") != manifest_sha256:
        raise ValueError("contract blind manifest hash mismatch")
    return receipt, sha256_file(receipt_path)


def validate_prediction_kind(
    payload: dict[str, object],
    contract: dict[str, object],
) -> str:
    kind = payload.get("prediction_kind")
    if kind not in {PREDICTION_KIND_DETERMINISTIC, PREDICTION_KIND_FRONTIER}:
        raise ValueError("prediction payload must declare a governed prediction_kind")
    systems = payload.get("systems")
    if not isinstance(systems, list) or any(not isinstance(item, str) for item in systems):
        raise ValueError("prediction payload has an invalid system list")
    called_systems = list(contract["frontier_model_fairness"]["systems_with_calls"])
    if kind == PREDICTION_KIND_FRONTIER:
        if systems != called_systems:
            raise ValueError("frontier prediction must cover the full frozen frontier system list")
    elif set(systems) & set(called_systems):
        raise ValueError("deterministic prediction contains a frontier-call system")
    if kind == PREDICTION_KIND_DETERMINISTIC and payload.get("provenance") not in (None, []):
        raise ValueError("deterministic prediction cannot contain provider provenance")
    return str(kind)


def _relative_study_path(path: Path, field: str) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(STUDY_ROOT.resolve()).as_posix()
    except ValueError as exc:
        raise ValueError(f"{field} must stay inside the canonical study") from exc


def _raw_output_text(response: dict[str, object]) -> str:
    parts = []
    output = response.get("output")
    if not isinstance(output, list):
        return ""
    for item in output:
        if not isinstance(item, dict) or not isinstance(item.get("content"), list):
            continue
        for content in item["content"]:
            if (
                isinstance(content, dict)
                and content.get("type") == "output_text"
                and isinstance(content.get("text"), str)
                and content["text"].strip()
            ):
                parts.append(content["text"].strip())
    return "\n".join(parts)


def _expected_frontier_grid(
    manifest: list[dict[str, object]],
    split: str,
    systems: list[str],
) -> list[dict[str, str]]:
    unit_ids = [
        record.get("unit_id")
        for record in manifest
        if record.get("split") == split
    ]
    if (
        not unit_ids
        or any(not isinstance(unit_id, str) for unit_id in unit_ids)
        or len(unit_ids) != len(set(unit_ids))
    ):
        raise ValueError("blind manifest has an invalid governed split grid")
    return [
        {"unit_id": str(unit_id), "system": system}
        for unit_id in unit_ids
        for system in systems
    ]


def _frontier_provider_evidence(
    raw_provider_records: list[dict[str, object]],
    provenance: list[dict[str, object]],
    expected_grid: list[dict[str, str]],
    contract: dict[str, object],
) -> list[dict[str, object]]:
    expected_pairs = {
        (item["unit_id"], item["system"])
        for item in expected_grid
    }
    provenance_by_pair: dict[tuple[str, str], dict[str, object]] = {}
    for item in provenance:
        if not isinstance(item, dict):
            raise ValueError("frontier provenance record must be an object")
        pair = (item.get("unit_id"), item.get("system"))
        if pair in provenance_by_pair:
            raise ValueError("duplicate frontier provenance pair")
        if pair not in expected_pairs:
            raise ValueError("frontier provenance is outside the expected system grid")
        provenance_by_pair[pair] = item
    if set(provenance_by_pair) != expected_pairs:
        raise ValueError("frontier provenance does not cover the complete expected grid")

    model = contract["frontier_model_fairness"]["model"]
    effort = contract["frontier_model_fairness"]["reasoning_effort"]
    evidence_by_pair: dict[tuple[str, str], dict[str, object]] = {}
    response_ids: set[str] = set()
    for item in raw_provider_records:
        if not isinstance(item, dict):
            raise ValueError("raw provider record wrapper must be an object")
        pair = (item.get("unit_id"), item.get("system"))
        if pair in evidence_by_pair:
            raise ValueError("duplicate raw provider record pair")
        if pair not in expected_pairs:
            raise ValueError("raw provider record is outside the expected system grid")
        record = item.get("record")
        if not isinstance(record, dict):
            raise ValueError(f"raw provider response record is missing: {pair}")
        response = record.get("response")
        if not isinstance(response, dict):
            raise ValueError(f"raw provider response is missing: {pair}")
        response_hash = sha256_json(response)
        if record.get("response_sha256") != response_hash:
            raise ValueError(f"raw provider response hash mismatch: {pair}")
        response_id = response.get("id")
        if (
            not isinstance(response_id, str)
            or not response_id
            or record.get("response_id") != response_id
        ):
            raise ValueError(f"raw provider response identity mismatch: {pair}")
        if response_id in response_ids:
            raise ValueError("raw provider response ids must be unique per execution")
        response_ids.add(response_id)
        usage = response.get("usage")
        if not isinstance(usage, dict) or record.get("usage") != usage:
            raise ValueError(f"raw provider usage mismatch: {pair}")
        output_tokens = usage.get("output_tokens")
        if (
            not isinstance(output_tokens, int)
            or output_tokens < 0
            or output_tokens > PAPER_GRADE_MAX_OUTPUT_TOKENS
        ):
            raise ValueError(f"raw provider output-token budget mismatch: {pair}")
        if (
            response.get("model") != model
            or record.get("effective_model") != model
            or record.get("requested_model") != model
            or record.get("reasoning_effort") != effort
            or record.get("provider") != "openai_responses_api"
            or record.get("request_max_output_tokens")
                != PAPER_GRADE_MAX_OUTPUT_TOKENS
        ):
            raise ValueError(f"raw provider execution configuration mismatch: {pair}")
        request_hash = require_sha256(record.get("request_sha256"), f"{pair}.request")
        if record.get("input_sha256") != request_hash:
            raise ValueError(f"raw provider input hash mismatch: {pair}")
        prompt_hash = require_sha256(record.get("prompt_sha256"), f"{pair}.prompt")
        output_text_hash = hashlib.sha256(
            _raw_output_text(response).encode("utf-8")
        ).hexdigest()
        if record.get("output_text_sha256") != output_text_hash:
            raise ValueError(f"raw provider output-text hash mismatch: {pair}")
        latency = record.get("latency_ms")
        if not isinstance(latency, (int, float)) or latency < 0:
            raise ValueError(f"raw provider latency is missing: {pair}")

        public = provenance_by_pair[pair]
        comparisons = {
            "provider": "openai_responses_api",
            "requested_model": model,
            "effective_model": model,
            "reasoning_effort": effort,
            "prompt_sha256": prompt_hash,
            "input_sha256": request_hash,
            "request_sha256": request_hash,
            "response_id": response_id,
            "response_sha256": response_hash,
            "output_text_sha256": output_text_hash,
            "usage": usage,
            "latency_ms": latency,
            "request_max_output_tokens": PAPER_GRADE_MAX_OUTPUT_TOKENS,
        }
        for field, expected in comparisons.items():
            if public.get(field) != expected:
                raise ValueError(f"frontier provenance/raw-response mismatch: {pair}.{field}")

        evidence_by_pair[pair] = {
            "unit_id": pair[0],
            "system": pair[1],
            "provider_record_sha256": sha256_json(record),
            "raw_response_sha256": response_hash,
            "record": record,
        }
    if set(evidence_by_pair) != expected_pairs:
        raise ValueError("raw provider responses do not cover the complete expected grid")
    return [
        evidence_by_pair[(item["unit_id"], item["system"])]
        for item in expected_grid
    ]


def _load_study_library(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError(f"cannot load frozen study library: {path.name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def encoder_from_contract(contract: dict[str, object]):
    import importlib.metadata
    import tiktoken

    context = contract["context_budget"]
    expected_version = context.get("tokenizer_version")
    if not isinstance(expected_version, str) or not expected_version:
        raise ValueError("contract must freeze a tokenizer_version")
    installed_version = importlib.metadata.version("tiktoken")
    if installed_version != expected_version:
        raise ValueError(
            "tiktoken version mismatch: "
            f"expected {expected_version}, got {installed_version}"
        )
    tokenizer = context.get("tokenizer")
    if not isinstance(tokenizer, str) or not tokenizer.strip():
        raise ValueError("contract must freeze a tokenizer encoding")
    return tiktoken.get_encoding(tokenizer.split()[-1])


def derive_frontier_prediction_records(
    *,
    cache_root: Path,
    manifest: list[dict[str, object]],
    split: str,
    contract: dict[str, object],
    raw_provider_records: list[dict[str, object]],
    provenance: list[dict[str, object]],
) -> list[dict[str, object]]:
    retrieval = _load_study_library(
        "scicoqa_governed_retrieval",
        LIBRARY_ROOT / "retrieval.py",
    )
    frontier = _load_study_library(
        "scicoqa_governed_frontier_retrieval",
        LIBRARY_ROOT / "frontier_retrieval.py",
    )
    systems = list(contract["frontier_model_fairness"]["systems_with_calls"])
    if not systems:
        raise ValueError("frontier derivation requires at least one frozen system")
    expected_grid = _expected_frontier_grid(manifest, split, systems)
    raw_by_pair = {
        (item.get("unit_id"), item.get("system")): item.get("record")
        for item in raw_provider_records
    }
    provenance_by_pair = {
        (item.get("unit_id"), item.get("system")): item
        for item in provenance
    }
    context = contract["context_budget"]
    encoder = encoder_from_contract(contract)
    obligation_template = (
        STUDY_ROOT / "method" / "prompts" / "frontier-obligations.v1.txt"
    ).read_text(encoding="utf-8")
    selector_template = (
        STUDY_ROOT / "method" / "prompts" / "generic-selector.v1.txt"
    ).read_text(encoding="utf-8")
    unit_by_id = {
        item["unit_id"]: item
        for item in manifest
        if item.get("split") == split
    }
    derived: list[dict[str, object]] = []
    for unit_id in [item["unit_id"] for item in expected_grid[::len(systems)]]:
        unit = unit_by_id[unit_id]
        paper_path, repository = retrieval.verify_blind_unit(cache_root, unit)
        paper_text = paper_path.read_text(encoding="utf-8")
        chunks = retrieval.build_chunks(
            repository,
            encoder,
            int(context["chunk_tokens"]),
            int(context["chunk_overlap_tokens"]),
        )
        allowed_paths = {chunk.path for chunk in chunks}
        repository_map = frontier.build_repository_map(repository, allowed_paths)
        prompts = {
            "generic_frontier_selector": frontier.fill_prompt(
                selector_template,
                paper_text=paper_text,
                repository_map=repository_map,
            ),
            "frontier_obligations": frontier.fill_prompt(
                obligation_template,
                paper_text=paper_text,
            ),
        }
        for system in systems:
            pair = (unit_id, system)
            record = raw_by_pair.get(pair)
            public = provenance_by_pair.get(pair)
            if not isinstance(record, dict) or not isinstance(public, dict):
                raise ValueError(f"frontier derivation evidence is missing: {pair}")
            prompt = prompts.get(system)
            if not isinstance(prompt, str):
                raise ValueError(f"unsupported frozen frontier system: {system}")
            prompt_hash = frontier.sha256_text(prompt)
            request_hash = frontier.sha256_json(
                frontier.build_responses_request(
                    str(contract["frontier_model_fairness"]["model"]),
                    str(contract["frontier_model_fairness"]["reasoning_effort"]),
                    prompt,
                )
            )
            if (
                record.get("prompt_sha256") != prompt_hash
                or record.get("request_sha256") != request_hash
                or record.get("input_sha256") != request_hash
            ):
                raise ValueError(f"frontier canonical request mismatch: {pair}")
            response = record.get("response")
            if not isinstance(response, dict):
                raise ValueError(f"frontier raw response is missing: {pair}")
            output_text = frontier.extract_output_text(response)
            raw_invalid_reason = None
            try:
                parsed = frontier.parse_json_output(output_text)
            except (TypeError, ValueError):
                parsed = None
                raw_invalid_reason = "invalid_json_object"
            if (
                record.get("parsed") != parsed
                or record.get("invalid_output_reason") != raw_invalid_reason
            ):
                raise ValueError(f"frontier parsed response mismatch: {pair}")
            ranking, schema_error = frontier.resolve_system_ranking(
                system,
                parsed,
                allowed_paths,
                paper_text,
                chunks,
                retrieval,
            )
            invalid_output_reason = raw_invalid_reason or schema_error
            packed, used_tokens = retrieval.pack_chunks(
                chunks,
                ranking,
                int(context["selected_code_tokens"]),
            )
            if (
                public.get("valid_output") != (invalid_output_reason is None)
                or public.get("invalid_output_reason") != invalid_output_reason
            ):
                raise ValueError(f"frontier output-validity provenance mismatch: {pair}")
            derived.append({
                "unit_id": unit_id,
                "split": split,
                "system": system,
                "used_code_tokens": used_tokens,
                "selected_chunk_ids": [chunk.chunk_id for chunk in packed],
                "retrieved_files": retrieval.retrieved_files(packed),
                "invalid_output": invalid_output_reason is not None,
            })
    return derived


def derive_deterministic_prediction_records(
    *,
    cache_root: Path,
    manifest: list[dict[str, object]],
    split: str,
    contract: dict[str, object],
    systems: list[str],
) -> list[dict[str, object]]:
    called_systems = set(contract["frontier_model_fairness"]["systems_with_calls"])
    expected_systems = [
        str(system["id"])
        for system in contract["systems"]
        if system.get("id") not in called_systems
    ]
    if systems != expected_systems or not systems:
        raise ValueError(
            "deterministic predictions must cover the full frozen deterministic system list"
        )
    retrieval = _load_study_library(
        "scicoqa_governed_deterministic_retrieval",
        LIBRARY_ROOT / "retrieval.py",
    )
    context = contract["context_budget"]
    encoder = encoder_from_contract(contract)
    units = [item for item in manifest if item.get("split") == split]
    if not units:
        raise ValueError("deterministic derivation requires a governed split")
    derived: list[dict[str, object]] = []
    for unit in units:
        paper_path, repository = retrieval.verify_blind_unit(cache_root, unit)
        paper_text = paper_path.read_text(encoding="utf-8")
        chunks = retrieval.build_chunks(
            repository,
            encoder,
            int(context["chunk_tokens"]),
            int(context["chunk_overlap_tokens"]),
        )
        for system in systems:
            ranking = retrieval.rank_chunks(system, paper_text, chunks)
            packed, used_tokens = retrieval.pack_chunks(
                chunks,
                ranking,
                int(context["selected_code_tokens"]),
            )
            derived.append({
                "unit_id": unit["unit_id"],
                "split": split,
                "system": system,
                "used_code_tokens": used_tokens,
                "selected_chunk_ids": [chunk.chunk_id for chunk in packed],
                "retrieved_files": retrieval.retrieved_files(packed),
            })
    return derived


def validate_deterministic_prediction_derivation(
    payload: dict[str, object],
    *,
    cache_root: Path,
    manifest: list[dict[str, object]],
    split: str,
    contract: dict[str, object],
) -> None:
    records = payload.get("records")
    systems = payload.get("systems")
    if not isinstance(records, list) or not isinstance(systems, list):
        raise ValueError("deterministic prediction is missing its system grid")
    derived = derive_deterministic_prediction_records(
        cache_root=cache_root,
        manifest=manifest,
        split=split,
        contract=contract,
        systems=systems,
    )
    if records != derived:
        raise ValueError(
            "deterministic predictions do not match blind-corpus ranking derivation"
        )


def _frontier_execution_payload(
    *,
    predictions_path: Path,
    contract_path: Path,
    blind_manifest_path: Path,
    cache_root: Path,
    raw_provider_records: list[dict[str, object]],
    freeze_receipt: dict[str, object],
    freeze_receipt_sha256: str,
) -> dict[str, object]:
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    predictions = json.loads(predictions_path.read_text(encoding="utf-8"))
    kind = validate_prediction_kind(predictions, contract)
    if kind != PREDICTION_KIND_FRONTIER:
        raise ValueError("frontier execution receipt cannot bind deterministic predictions")
    split = predictions.get("split")
    if split not in {"development", "confirmatory"}:
        raise ValueError("frontier predictions have an invalid split")
    contract_sha256 = sha256_file(contract_path)
    manifest_sha256 = sha256_file(blind_manifest_path)
    if (
        predictions.get("contract_sha256") != contract_sha256
        or predictions.get("blind_manifest_sha256") != manifest_sha256
        or predictions.get("gold_fields_read") != []
    ):
        raise ValueError("frontier predictions are not bound to canonical blind inputs")
    manifest = [
        json.loads(line)
        for line in blind_manifest_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    systems = list(contract["frontier_model_fairness"]["systems_with_calls"])
    expected_grid = _expected_frontier_grid(manifest, str(split), systems)
    expected_pairs = {
        (item["unit_id"], item["system"])
        for item in expected_grid
    }
    records = predictions.get("records")
    if not isinstance(records, list):
        raise ValueError("frontier predictions are missing records")
    if any(not isinstance(item, dict) for item in records):
        raise ValueError("frontier prediction records must be objects")
    prediction_pairs = [(item.get("unit_id"), item.get("system")) for item in records]
    if len(prediction_pairs) != len(set(prediction_pairs)) or set(prediction_pairs) != expected_pairs:
        raise ValueError("frontier predictions do not cover the complete expected grid")
    provenance = predictions.get("provenance")
    if not isinstance(provenance, list):
        raise ValueError("frontier predictions are missing provider provenance")
    provider_records = _frontier_provider_evidence(
        raw_provider_records,
        provenance,
        expected_grid,
        contract,
    )
    derived_records = derive_frontier_prediction_records(
        cache_root=cache_root,
        manifest=manifest,
        split=str(split),
        contract=contract,
        raw_provider_records=raw_provider_records,
        provenance=provenance,
    )
    if records != derived_records:
        raise ValueError(
            "frontier predictions do not match raw-response ranking derivation"
        )
    token_budget = {
        "selected_code": contract["context_budget"],
        "provider_max_output_tokens": PAPER_GRADE_MAX_OUTPUT_TOKENS,
    }
    runner_hash = require_sha256(
        freeze_receipt.get("files", {}).get("../scripts/run_frontier_retrieval.py"),
        "freeze.files...run_frontier_retrieval.py",
    )
    identity = {
        "split": split,
        "contract_sha256": contract_sha256,
        "blind_manifest_sha256": manifest_sha256,
        "freeze_receipt_sha256": freeze_receipt_sha256,
        "predictions_sha256": sha256_file(predictions_path),
        "provider": "openai_responses_api",
        "model": contract["frontier_model_fairness"]["model"],
        "reasoning_effort": contract["frontier_model_fairness"]["reasoning_effort"],
        "token_budget_sha256": sha256_json(token_budget),
        "expected_system_grid_sha256": sha256_json(expected_grid),
        "provider_record_sha256s": [
            item["provider_record_sha256"] for item in provider_records
        ],
        "response_ids": [item["record"]["response_id"] for item in provider_records],
        "runner_sha256": runner_hash,
    }
    return {
        "schema_version": "1.0",
        "artifact_type": "frontier_execution_receipt",
        "execution_id": sha256_json(identity),
        "prediction_kind": PREDICTION_KIND_FRONTIER,
        "split": split,
        "predictions": {
            "path": _relative_study_path(predictions_path, "frontier predictions"),
            "sha256": sha256_file(predictions_path),
        },
        "contract_sha256": contract_sha256,
        "blind_manifest_sha256": manifest_sha256,
        "freeze_receipt_sha256": freeze_receipt_sha256,
        "generated_by": {
            "path": "scripts/run_frontier_retrieval.py",
            "sha256": runner_hash,
        },
        "provider": "openai_responses_api",
        "model": contract["frontier_model_fairness"]["model"],
        "reasoning_effort": contract["frontier_model_fairness"]["reasoning_effort"],
        "token_budget": token_budget,
        "token_budget_sha256": sha256_json(token_budget),
        "expected_system_grid": expected_grid,
        "expected_system_grid_sha256": sha256_json(expected_grid),
        "provider_records": provider_records,
        "provider_records_sha256": sha256_json(provider_records),
        "prediction_derivation": "recomputed_from_raw_response_and_blind_corpus",
        "derived_prediction_records_sha256": sha256_json(derived_records),
    }


def write_frontier_execution_receipt(
    path: Path,
    *,
    predictions_path: Path,
    contract_path: Path,
    blind_manifest_path: Path,
    cache_root: Path,
    raw_provider_records: list[dict[str, object]],
) -> dict[str, object]:
    freeze_receipt, freeze_hash = validate_canonical_frozen_method(
        contract_path,
        blind_manifest_path,
    )
    predictions = json.loads(predictions_path.read_text(encoding="utf-8"))
    split = predictions.get("split")
    if not isinstance(split, str) or path.resolve() != canonical_frontier_execution_receipt_path(split):
        raise ValueError("frontier execution receipt must use the canonical split path")
    payload = _frontier_execution_payload(
        predictions_path=predictions_path,
        contract_path=contract_path,
        blind_manifest_path=blind_manifest_path,
        cache_root=cache_root,
        raw_provider_records=raw_provider_records,
        freeze_receipt=freeze_receipt,
        freeze_receipt_sha256=freeze_hash,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return payload


def validate_frontier_execution_receipt(
    path: Path,
    *,
    predictions_path: Path,
    contract_path: Path,
    blind_manifest_path: Path,
    cache_root: Path,
    split: str,
) -> tuple[dict[str, object], str]:
    if path.resolve() != canonical_frontier_execution_receipt_path(split):
        raise ValueError("frontier evaluation requires the canonical execution receipt")
    freeze_receipt, freeze_hash = validate_canonical_frozen_method(
        contract_path,
        blind_manifest_path,
    )
    receipt = json.loads(path.read_text(encoding="utf-8"))
    raw_provider_records = receipt.get("provider_records")
    if not isinstance(raw_provider_records, list):
        raise ValueError("frontier execution receipt is missing raw provider responses")
    expected = _frontier_execution_payload(
        predictions_path=predictions_path,
        contract_path=contract_path,
        blind_manifest_path=blind_manifest_path,
        cache_root=cache_root,
        raw_provider_records=raw_provider_records,
        freeze_receipt=freeze_receipt,
        freeze_receipt_sha256=freeze_hash,
    )
    if receipt != expected:
        raise ValueError("frontier execution receipt does not match canonical execution evidence")
    return receipt, sha256_file(path)


def validate_sealed_gold_root(
    sealed_gold_root: Path,
    split: str,
    contract: dict[str, object],
) -> dict[str, dict[str, object]]:
    expected_name = f"{split}-gold"
    root = sealed_gold_root.resolve()
    if root.name != expected_name:
        raise ValueError(f"sealed gold root must end in {expected_name}")
    manifest_path = root.parent / f"{split}-gold-manifest.json"
    expected_hash = contract["corpus"]["sealed_gold_manifest_sha256"][split]
    if sha256_file(manifest_path) != expected_hash:
        raise ValueError(f"{split} sealed gold manifest hash mismatch")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("split") != split or not isinstance(manifest.get("records"), list):
        raise ValueError(f"invalid {split} sealed gold manifest")
    records: dict[str, dict[str, object]] = {}
    expected_files: set[str] = set()
    for item in manifest["records"]:
        if not isinstance(item, dict):
            raise ValueError(f"invalid {split} sealed gold record")
        unit_id = item.get("unit_id")
        relative = item.get("path")
        expected = item.get("sha256")
        if (
            not isinstance(unit_id, str)
            or not isinstance(relative, str)
            or relative != f"{unit_id}.json"
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
        ):
            raise ValueError(f"unsafe {split} sealed gold record")
        path = (root / relative).resolve()
        if path.parent != root or sha256_file(path) != expected:
            raise ValueError(f"{split} sealed gold file hash mismatch: {unit_id}")
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("unit_id") != unit_id or payload.get("split") != split:
            raise ValueError(f"{split} sealed gold identity mismatch: {unit_id}")
        if unit_id in records:
            raise ValueError(f"duplicate {split} sealed gold unit: {unit_id}")
        records[unit_id] = payload
        expected_files.add(relative)
    actual_files = {
        path.name for path in root.iterdir()
        if path.is_file() and not path.is_symlink()
    }
    if actual_files != expected_files:
        raise ValueError(f"{split} sealed gold directory closure mismatch")
    return records


def _normalized_file(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("retrieved and gold file paths must be strings")
    candidate = Path(value.replace("\\", "/"))
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError("retrieved and gold file paths must stay relative")
    normalized = candidate.as_posix()
    return normalized[2:] if normalized.startswith("./") else normalized


def derive_evaluation(
    predictions_path: Path,
    contract_path: Path,
    blind_manifest_path: Path,
    sealed_gold_root: Path,
    split: str,
) -> dict[str, object]:
    contract_sha256 = sha256_file(contract_path)
    blind_manifest_sha256 = sha256_file(blind_manifest_path)
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    if contract["corpus"]["blind_manifest_sha256"] != blind_manifest_sha256:
        raise ValueError("blind manifest hash does not match the contract")
    payload = json.loads(predictions_path.read_text(encoding="utf-8"))
    if (
        payload.get("split") != split
        or payload.get("contract_sha256") != contract_sha256
        or payload.get("blind_manifest_sha256") != blind_manifest_sha256
        or payload.get("gold_fields_read") != []
    ):
        raise ValueError("prediction payload is not bound to the requested evaluation")
    manifest = [
        json.loads(line)
        for line in blind_manifest_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    unit_ids = [record["unit_id"] for record in manifest if record.get("split") == split]
    if len(unit_ids) != len(set(unit_ids)):
        raise ValueError("blind manifest contains duplicate unit ids")
    systems = payload.get("systems")
    records = payload.get("records")
    contract_systems = {system["id"] for system in contract["systems"]}
    if (
        not isinstance(systems, list)
        or not systems
        or len(systems) != len(set(systems))
        or not set(systems).issubset(contract_systems)
        or not isinstance(records, list)
    ):
        raise ValueError("prediction payload has an invalid system grid")
    expected_pairs = {(unit_id, system) for unit_id in unit_ids for system in systems}
    observed_pairs = [(record.get("unit_id"), record.get("system")) for record in records]
    if len(observed_pairs) != len(set(observed_pairs)) or set(observed_pairs) != expected_pairs:
        raise ValueError("prediction payload does not cover the complete unit-system grid")
    gold = validate_sealed_gold_root(sealed_gold_root, split, contract)
    if set(gold) != set(unit_ids):
        raise ValueError(f"{split} sealed gold units do not match the blind manifest")
    scores_by_system: dict[str, list[float]] = {}
    all_retrieved_by_system: dict[str, list[bool]] = {}
    unit_scores = []
    for record in records:
        retrieved = record.get("retrieved_files")
        if not isinstance(retrieved, list):
            raise ValueError("prediction record is missing retrieved files")
        predicted = {_normalized_file(value) for value in retrieved}
        target_files = gold[record["unit_id"]].get("target_files")
        if not isinstance(target_files, list) or not target_files:
            raise ValueError("sealed gold target files are missing")
        targets = {_normalized_file(value) for value in target_files}
        recall = len(predicted & targets) / len(targets)
        complete = recall == 1.0
        system = record["system"]
        scores_by_system.setdefault(system, []).append(recall)
        all_retrieved_by_system.setdefault(system, []).append(complete)
        unit_scores.append({
            "unit_id": record["unit_id"],
            "system": system,
            "changed_file_recall": recall,
            "all_changed_files_retrieved": complete,
            "target_file_count": len(targets),
        })
    summary = {
        system: {
            "units": len(scores),
            "macro_changed_file_recall": statistics.fmean(scores),
            "all_changed_files_rate":
                statistics.fmean(all_retrieved_by_system[system]),
        }
        for system, scores in sorted(scores_by_system.items())
    }
    return {
        "schema_version": "1.0",
        "split": split,
        "prediction_sha256": sha256_file(predictions_path),
        "sealed_gold_manifest_sha256":
            contract["corpus"]["sealed_gold_manifest_sha256"][split],
        "summary": summary,
        "unit_scores": unit_scores,
    }


def _system_scores(evaluation: dict[str, object]) -> dict[str, dict[str, float]]:
    if evaluation.get("split") != "development":
        raise ValueError("promotion evidence must use the development split")
    rows = evaluation.get("unit_scores")
    if not isinstance(rows, list):
        raise ValueError("development evaluation is missing unit scores")
    scores: dict[str, dict[str, float]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("invalid development unit score")
        system = row.get("system")
        unit_id = row.get("unit_id")
        recall = row.get("changed_file_recall")
        if not isinstance(system, str) or not isinstance(unit_id, str):
            raise ValueError("development unit score is missing identity")
        if not isinstance(recall, (int, float)):
            raise ValueError("development unit score is missing recall")
        if unit_id in scores.setdefault(system, {}):
            raise ValueError("duplicate development unit score")
        scores[system][unit_id] = float(recall)
    return scores


def compute_development_gate(
    contract: dict[str, object],
    frontier_evaluation: dict[str, object],
    deterministic_evaluation: dict[str, object],
) -> dict[str, object]:
    proposed = [
        system.get("id")
        for system in contract["systems"]
        if system.get("role") == "proposed system"
    ]
    if len(proposed) != 1 or not isinstance(proposed[0], str):
        raise ValueError("contract must declare exactly one proposed system")
    proposed_id = proposed[0]
    combined: dict[str, dict[str, float]] = {}
    for evaluation in (frontier_evaluation, deterministic_evaluation):
        for system, scores in _system_scores(evaluation).items():
            if system in combined:
                raise ValueError(f"development system appears in multiple evaluations: {system}")
            combined[system] = scores
    if proposed_id not in combined:
        raise ValueError("development evaluation is missing the proposed system")
    development_units = int(contract["corpus"]["development_units"])
    expected_units = set(combined[proposed_id])
    if len(expected_units) != development_units:
        raise ValueError("proposed development score count does not match the contract")
    if any(set(scores) != expected_units for scores in combined.values()):
        raise ValueError("development systems do not cover the same paper units")
    means = {
        system: sum(scores.values()) / len(scores)
        for system, scores in combined.items()
    }
    baseline_ids = sorted(system for system in combined if system != proposed_id)
    if not baseline_ids:
        raise ValueError("development promotion requires at least one baseline")
    strongest = max(baseline_ids, key=lambda system: (means[system], system))
    proposed_mean = means[proposed_id]
    strongest_mean = means[strongest]
    positive_papers = sum(
        combined[proposed_id][unit] > combined[strongest][unit]
        for unit in expected_units
    )
    rule = contract["development_promotion"]
    required = list(rule["must_beat"])
    missing = [system for system in required if system not in combined]
    if missing:
        raise ValueError(f"development evaluation is missing required baselines: {missing}")
    required_results = {
        system: proposed_mean > means[system]
        for system in required
    }
    gain = proposed_mean - strongest_mean
    gain_passed = gain >= float(rule["minimum_absolute_macro_recall_gain"])
    positive_passed = positive_papers >= int(rule["minimum_papers_with_positive_difference"])
    baselines_passed = all(required_results.values())
    return {
        "passed": gain_passed and positive_passed and baselines_passed,
        "proposed_system": proposed_id,
        "strongest_baseline": strongest,
        "proposed_macro_recall": proposed_mean,
        "strongest_baseline_macro_recall": strongest_mean,
        "absolute_macro_recall_gain": gain,
        "minimum_absolute_macro_recall_gain":
            rule["minimum_absolute_macro_recall_gain"],
        "minimum_absolute_macro_recall_gain_passed": gain_passed,
        "positive_papers": positive_papers,
        "minimum_positive_papers": rule["minimum_papers_with_positive_difference"],
        "minimum_positive_papers_passed": positive_passed,
        "required_baselines": required_results,
        "all_required_baselines_beaten": baselines_passed,
    }


def _bound_artifact(
    receipt_path: Path,
    receipt: dict[str, object],
    field: str,
) -> tuple[Path, str]:
    artifacts = receipt.get("development_artifacts")
    if not isinstance(artifacts, dict) or not isinstance(artifacts.get(field), dict):
        raise ValueError(f"promotion receipt is missing development_artifacts.{field}")
    item = artifacts[field]
    relative = item.get("path")
    expected_hash = require_sha256(
        item.get("sha256"),
        f"development_artifacts.{field}.sha256",
    )
    if not isinstance(relative, str):
        raise ValueError(f"development_artifacts.{field}.path must be relative")
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError(f"development_artifacts.{field}.path must stay inside the study")
    study_root = STUDY_ROOT.resolve()
    path = (study_root / candidate).resolve()
    if not path.is_relative_to(study_root):
        raise ValueError(f"development_artifacts.{field}.path escapes the study")
    if sha256_file(path) != expected_hash:
        raise ValueError(f"promotion artifact hash mismatch: {field}")
    return path, expected_hash


def validate_promotion_receipt(
    path: Path | None,
    contract_path: Path,
    blind_manifest_path: Path,
    cache_root: Path,
    development_gold_root: Path,
) -> tuple[dict[str, object], str]:
    if path is None:
        raise ValueError("confirmatory execution requires a development promotion receipt")
    validate_canonical_frozen_method(contract_path, blind_manifest_path)
    if path.resolve().parent != STUDY_ROOT.resolve() / "results":
        raise ValueError("promotion receipt must use the canonical study results directory")
    receipt = json.loads(path.read_text(encoding="utf-8"))
    if receipt.get("decision") != "PROMOTE":
        raise ValueError("development promotion receipt does not authorize confirmation")
    contract_sha256 = sha256_file(contract_path)
    blind_manifest_sha256 = sha256_file(blind_manifest_path)
    if receipt.get("contract_sha256") != contract_sha256:
        raise ValueError("promotion receipt contract hash mismatch")
    if receipt.get("blind_manifest_sha256") != blind_manifest_sha256:
        raise ValueError("promotion receipt blind manifest hash mismatch")
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    if (
        receipt.get("development_gold_manifest_sha256")
        != contract["corpus"]["sealed_gold_manifest_sha256"]["development"]
    ):
        raise ValueError("promotion receipt development gold manifest hash mismatch")
    frontier_predictions, _ = _bound_artifact(path, receipt, "frontier_predictions")
    frontier_seal, _ = _bound_artifact(path, receipt, "frontier_prediction_seal")
    frontier_execution_receipt, _ = _bound_artifact(
        path,
        receipt,
        "frontier_execution_receipt",
    )
    frontier_evaluation, _ = _bound_artifact(path, receipt, "frontier_evaluation")
    deterministic_predictions, _ = _bound_artifact(
        path, receipt, "deterministic_predictions"
    )
    deterministic_seal, _ = _bound_artifact(
        path, receipt, "deterministic_prediction_seal"
    )
    deterministic_evaluation, _ = _bound_artifact(
        path, receipt, "deterministic_evaluation"
    )
    frontier_payload = json.loads(frontier_predictions.read_text(encoding="utf-8"))
    deterministic_payload = json.loads(
        deterministic_predictions.read_text(encoding="utf-8")
    )
    if validate_prediction_kind(frontier_payload, contract) != PREDICTION_KIND_FRONTIER:
        raise ValueError("promotion frontier artifact has the wrong prediction kind")
    if (
        validate_prediction_kind(deterministic_payload, contract)
        != PREDICTION_KIND_DETERMINISTIC
    ):
        raise ValueError("promotion deterministic artifact has the wrong prediction kind")
    manifest = [
        json.loads(line)
        for line in blind_manifest_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    validate_deterministic_prediction_derivation(
        deterministic_payload,
        cache_root=cache_root,
        manifest=manifest,
        split="development",
        contract=contract,
    )
    _, execution_receipt_hash = validate_frontier_execution_receipt(
        frontier_execution_receipt,
        predictions_path=frontier_predictions,
        contract_path=contract_path,
        blind_manifest_path=blind_manifest_path,
        cache_root=cache_root,
        split="development",
    )
    validate_prediction_seal(
        frontier_seal,
        predictions_path=frontier_predictions,
        split="development",
        contract_sha256=contract_sha256,
        blind_manifest_sha256=blind_manifest_sha256,
        promotion_receipt_sha256=None,
        prediction_kind=PREDICTION_KIND_FRONTIER,
        execution_receipt_sha256=execution_receipt_hash,
    )
    validate_prediction_seal(
        deterministic_seal,
        predictions_path=deterministic_predictions,
        split="development",
        contract_sha256=contract_sha256,
        blind_manifest_sha256=blind_manifest_sha256,
        promotion_receipt_sha256=None,
        prediction_kind=PREDICTION_KIND_DETERMINISTIC,
        execution_receipt_sha256=None,
    )
    frontier_eval = json.loads(frontier_evaluation.read_text(encoding="utf-8"))
    deterministic_eval = json.loads(
        deterministic_evaluation.read_text(encoding="utf-8")
    )
    derived_frontier_eval = derive_evaluation(
        frontier_predictions,
        contract_path,
        blind_manifest_path,
        development_gold_root,
        "development",
    )
    derived_deterministic_eval = derive_evaluation(
        deterministic_predictions,
        contract_path,
        blind_manifest_path,
        development_gold_root,
        "development",
    )
    if frontier_eval != derived_frontier_eval:
        raise ValueError("frontier evaluation does not match recomputed development evidence")
    if deterministic_eval != derived_deterministic_eval:
        raise ValueError("deterministic evaluation does not match recomputed development evidence")
    recomputed_gate = compute_development_gate(
        contract,
        frontier_eval,
        deterministic_eval,
    )
    if receipt.get("development_gate") != recomputed_gate:
        raise ValueError("promotion receipt gate does not match development evidence")
    if recomputed_gate.get("passed") is not True:
        raise ValueError("development promotion gate did not pass")
    return receipt, sha256_file(path)


def write_prediction_seal(
    path: Path,
    *,
    predictions_path: Path,
    split: str,
    contract_sha256: str,
    blind_manifest_sha256: str,
    promotion_receipt_sha256: str | None,
    prediction_kind: str,
    execution_receipt_sha256: str | None,
) -> dict[str, object]:
    if prediction_kind not in {
        PREDICTION_KIND_DETERMINISTIC,
        PREDICTION_KIND_FRONTIER,
    }:
        raise ValueError("prediction seal requires a governed prediction kind")
    if prediction_kind == PREDICTION_KIND_FRONTIER:
        require_sha256(execution_receipt_sha256, "execution_receipt_sha256")
    elif execution_receipt_sha256 is not None:
        raise ValueError("deterministic prediction seal cannot bind a frontier receipt")
    payload = {
        "schema_version": "2.0",
        "artifact_type": "prediction_seal",
        "prediction_kind": prediction_kind,
        "split": split,
        "predictions_sha256": sha256_file(predictions_path),
        "contract_sha256": contract_sha256,
        "blind_manifest_sha256": blind_manifest_sha256,
        "promotion_receipt_sha256": promotion_receipt_sha256,
        "execution_receipt_sha256": execution_receipt_sha256,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if existing != payload:
            raise ValueError("prediction seal already binds a different artifact")
        return payload
    with path.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return payload


def validate_prediction_seal(
    path: Path,
    *,
    predictions_path: Path,
    split: str,
    contract_sha256: str,
    blind_manifest_sha256: str,
    promotion_receipt_sha256: str | None,
    prediction_kind: str,
    execution_receipt_sha256: str | None,
) -> dict[str, object]:
    seal = json.loads(path.read_text(encoding="utf-8"))
    expected = {
        "schema_version": "2.0",
        "artifact_type": "prediction_seal",
        "prediction_kind": prediction_kind,
        "split": split,
        "predictions_sha256": sha256_file(predictions_path),
        "contract_sha256": contract_sha256,
        "blind_manifest_sha256": blind_manifest_sha256,
        "promotion_receipt_sha256": promotion_receipt_sha256,
        "execution_receipt_sha256": execution_receipt_sha256,
    }
    for field, value in expected.items():
        if seal.get(field) != value:
            raise ValueError(f"prediction seal mismatch: {field}")
    return seal


def lock_confirmatory_evaluation(
    path: Path,
    *,
    predictions_sha256: str,
    prediction_seal_sha256: str,
    contract_sha256: str,
    blind_manifest_sha256: str,
    promotion_receipt_sha256: str,
    prediction_kind: str,
    execution_receipt_sha256: str | None,
) -> dict[str, object]:
    if prediction_kind not in {
        PREDICTION_KIND_DETERMINISTIC,
        PREDICTION_KIND_FRONTIER,
    }:
        raise ValueError("confirmatory lock requires a governed prediction kind")
    if prediction_kind == PREDICTION_KIND_FRONTIER:
        require_sha256(execution_receipt_sha256, "execution_receipt_sha256")
    elif execution_receipt_sha256 is not None:
        raise ValueError("deterministic confirmatory lock cannot bind a frontier receipt")
    common = {
        "contract_sha256": require_sha256(contract_sha256, "contract_sha256"),
        "blind_manifest_sha256": require_sha256(
            blind_manifest_sha256,
            "blind_manifest_sha256",
        ),
        "promotion_receipt_sha256": require_sha256(
            promotion_receipt_sha256,
            "promotion_receipt_sha256",
        ),
    }
    entry = {
        "predictions_sha256": require_sha256(
            predictions_sha256,
            "predictions_sha256",
        ),
        "prediction_seal_sha256": require_sha256(
            prediction_seal_sha256,
            "prediction_seal_sha256",
        ),
        "execution_receipt_sha256": execution_receipt_sha256,
    }
    entries: dict[str, object] = {}
    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if (
            existing.get("schema_version") != "2.0"
            or existing.get("artifact_type") != "confirmatory_evaluation_lock"
            or any(existing.get(field) != value for field, value in common.items())
            or not isinstance(existing.get("predictions"), dict)
        ):
            raise ValueError("confirmatory evaluation lock has incompatible bindings")
        entries = dict(existing["predictions"])
        bound = entries.get(prediction_kind)
        if bound is not None and bound != entry:
            raise ValueError("confirmatory evaluation is locked to a different prediction")
    entries[prediction_kind] = entry
    required_kinds = [PREDICTION_KIND_DETERMINISTIC, PREDICTION_KIND_FRONTIER]
    if any(kind not in required_kinds for kind in entries):
        raise ValueError("confirmatory evaluation lock contains an unknown prediction kind")
    payload = {
        "schema_version": "2.0",
        "artifact_type": "confirmatory_evaluation_lock",
        **common,
        "required_prediction_kinds": required_kinds,
        "predictions": {
            kind: entries[kind]
            for kind in required_kinds
            if kind in entries
        },
        "complete": all(kind in entries for kind in required_kinds),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == serialized:
        return payload
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        handle.write(serialized)
    temporary.replace(path)
    return payload
