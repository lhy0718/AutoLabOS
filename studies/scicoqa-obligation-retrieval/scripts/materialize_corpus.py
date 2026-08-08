#!/usr/bin/env python3
"""Materialize blind paper/repository inputs and sealed file-level gold."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import importlib.metadata
import json
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable

import tiktoken


GITHUB_TREE_URL = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/tree/(?P<revision>[0-9a-fA-F]{7,40})/?$"
)
ARXIV_URL = re.compile(r"^https?://(?:export\.)?arxiv\.org/(?:abs|pdf)/(?P<identifier>[^?#]+?)(?:\.pdf)?/?$")
TOKEN_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")


@dataclass(frozen=True)
class MaterializedUnit:
    unit_id: str
    ordering_hash: str
    paper_url: str
    code_url: str
    paper_sha256: str
    paper_text_sha256: str
    archive_sha256: str
    original_snapshot_sha256: str
    mutated_repository_sha256: str
    candidate_file_count: int
    candidate_source_bytes: int
    candidate_source_tokens: int
    fingerprint_features: tuple[str, ...]
    mutation_conflicts: int
    mutation_targets_missing_from_candidate_universe: int
    target_files: tuple[str, ...]
    discrepancy_types: tuple[str, ...]


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(root: Path) -> str:
    resolved = root.resolve()
    digest = hashlib.sha256()
    for path in sorted(item for item in resolved.rglob("*") if item.is_file()):
        if path.is_symlink():
            raise ValueError(f"materialized repository contains a symlink: {path}")
        digest.update(path.relative_to(resolved).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256_file(path).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def download(
    url: str,
    destination: Path,
    max_bytes: int,
    timeout_seconds: int = 60,
    expected_magic: bytes | None = None,
) -> Path:
    destination.unlink(missing_ok=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/pdf, application/zip, application/octet-stream", "User-Agent": "AutoLabOS-research-materializer/1.0"},
    )
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
        total = 0
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                expected_length = response.headers.get("Content-Length")
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError(f"download exceeds {max_bytes} bytes: {url}")
                    temporary.write(chunk)
            if expected_length is not None and total != int(expected_length):
                raise ValueError(f"download length mismatch: expected {expected_length}, got {total}: {url}")
            temporary.flush()
            if expected_magic is not None:
                temporary.seek(0)
                if temporary.read(len(expected_magic)) != expected_magic:
                    raise ValueError(f"download has unexpected file signature: {url}")
            temporary_path.replace(destination)
        except Exception:
            temporary_path.unlink(missing_ok=True)
            raise
    return destination


def valid_pdf(path: Path) -> bool:
    if not path.exists() or path.stat().st_size < 16:
        return False
    with path.open("rb") as handle:
        if handle.read(5) != b"%PDF-":
            return False
        handle.seek(max(0, path.stat().st_size - 8192))
        return b"%%EOF" in handle.read()


def download_pdf(url: str, destination: Path, max_bytes: int, attempts: int = 3) -> Path:
    for attempt in range(1, attempts + 1):
        destination.unlink(missing_ok=True)
        try:
            download(url, destination, max_bytes, expected_magic=b"%PDF-")
        except Exception:
            if attempt == attempts:
                raise
            continue
        if valid_pdf(destination):
            return destination
        destination.unlink(missing_ok=True)
        if attempt == attempts:
            raise ValueError(f"PDF failed end-of-file validation after {attempts} attempts: {url}")
    raise AssertionError("unreachable")


def download_archive(
    url: str,
    destination: Path,
    max_bytes: int,
    attempts: int = 3,
) -> Path:
    for attempt in range(1, attempts + 1):
        try:
            return download(url, destination, max_bytes)
        except Exception:
            if attempt == attempts:
                raise
    raise AssertionError("unreachable")


def archive_url(code_url: str) -> str:
    match = GITHUB_TREE_URL.match(code_url)
    if match is None:
        raise ValueError(f"unsupported code URL: {code_url}")
    return (
        f"https://codeload.github.com/{match.group('owner')}/{match.group('repo')}"
        f"/zip/{match.group('revision').lower()}"
    )


def paper_pdf_url(paper_url: str) -> str:
    match = ARXIV_URL.match(paper_url)
    if match is None:
        return paper_url
    return f"https://arxiv.org/pdf/{match.group('identifier')}"


def normalized_member_path(name: str, common_root: str | None) -> str | None:
    raw = PurePosixPath(name)
    if raw.is_absolute() or ".." in raw.parts:
        raise ValueError(f"unsafe archive member: {name}")
    parts = list(raw.parts)
    if common_root and parts and parts[0] == common_root:
        parts = parts[1:]
    if not parts:
        return None
    normalized = PurePosixPath(*parts)
    if normalized.is_absolute() or ".." in normalized.parts:
        raise ValueError(f"unsafe normalized archive member: {name}")
    return normalized.as_posix()


def common_archive_root(names: Iterable[str]) -> str | None:
    roots = {PurePosixPath(name).parts[0] for name in names if PurePosixPath(name).parts}
    return next(iter(roots)) if len(roots) == 1 else None


def is_candidate_path(path: str, contract: dict[str, object]) -> bool:
    lowered_parts = [part.lower() for part in PurePosixPath(path).parts]
    excluded = {str(value).lower() for value in contract["corpus"]["excluded_directory_names"]}
    if any(part in excluded for part in lowered_parts[:-1]):
        return False
    lowered = path.lower()
    return lowered.endswith(tuple(str(value).lower() for value in contract["corpus"]["candidate_extensions"]))


def notebook_text(data: bytes) -> str:
    notebook = json.loads(data.decode("utf-8", errors="replace"))
    cells = []
    for cell in notebook.get("cells", []):
        if cell.get("cell_type") != "code":
            continue
        source = cell.get("source", [])
        cells.append("".join(source) if isinstance(source, list) else str(source))
    return "\n\n".join(cells)


def load_candidate_files(archive: Path, contract: dict[str, object]) -> dict[str, str]:
    maximum_file_bytes = int(contract["corpus"]["maximum_source_file_bytes"])
    maximum_total_bytes = 128 * 1024 * 1024
    maximum_members = 20000
    files: dict[str, str] = {}
    total = 0
    with zipfile.ZipFile(archive) as bundle:
        infos = [info for info in bundle.infolist() if not info.is_dir()]
        if len(infos) > maximum_members:
            raise ValueError(f"archive has too many members: {len(infos)}")
        root = common_archive_root(info.filename for info in infos)
        for info in infos:
            path = normalized_member_path(info.filename, root)
            if path is None or info.file_size > maximum_file_bytes:
                continue
            lowered = path.lower()
            is_notebook = lowered.endswith(".ipynb")
            candidate_path = path[:-6] + ".py" if is_notebook else path
            if not is_candidate_path(candidate_path, contract):
                continue
            data = bundle.read(info)
            text = notebook_text(data) if is_notebook else data.decode("utf-8", errors="ignore")
            encoded_size = len(text.encode("utf-8"))
            total += encoded_size
            if total > maximum_total_bytes:
                raise ValueError("candidate source exceeds per-unit materialization ceiling")
            files[candidate_path] = text
    return dict(sorted(files.items()))


def mutation_map(rows: list[dict[str, object]]) -> tuple[dict[str, str], list[str], list[str], int]:
    replacements: dict[str, str] = {}
    targets: list[str] = []
    discrepancy_types: list[str] = []
    conflicts = 0
    for row in rows:
        discrepancy_types.append(str(row.get("discrepancy_type") or "unknown"))
        changed = row.get("changed_code_files") or {}
        if not isinstance(changed, dict):
            raise ValueError("changed_code_files must be a dict of lists")
        names = changed.get("file_name") or []
        bodies = changed.get("discrepancy_code") or []
        if len(names) != len(bodies):
            raise ValueError("changed_code_files columns have unequal lengths")
        for name, body in zip(names, bodies):
            normalized = PurePosixPath(str(name)).as_posix()
            if PurePosixPath(normalized).is_absolute() or ".." in PurePosixPath(normalized).parts:
                raise ValueError(f"unsafe mutation path: {name}")
            next_body = str(body)
            if normalized in replacements and replacements[normalized] != next_body:
                conflicts += 1
            replacements[normalized] = next_body
            targets.append(normalized)
    return replacements, sorted(set(targets)), discrepancy_types, conflicts


def original_fingerprint(files: dict[str, str]) -> tuple[str, tuple[str, ...]]:
    digest = hashlib.sha256()
    features: set[str] = set()
    for path, text in sorted(files.items()):
        normalized_text = "\n".join(line.rstrip() for line in text.splitlines()).strip()
        content_hash = sha256_bytes(normalized_text.encode("utf-8"))
        digest.update(path.lower().encode("utf-8") + b"\0" + content_hash.encode("ascii") + b"\n")
        features.add(f"path:{path.lower()}")
        features.add(f"content:{content_hash}")
        for token in set(TOKEN_PATTERN.findall(path.lower())):
            features.add(f"path_token:{token}")
    return digest.hexdigest(), tuple(sorted(features))


def write_blind_repository(root: Path, files: dict[str, str]) -> None:
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    for relative, text in files.items():
        destination = root / PurePosixPath(relative)
        destination.resolve().relative_to(root.resolve())
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(text, encoding="utf-8")


def extract_paper_text(pdf_path: Path, text_path: Path) -> None:
    text_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["pdftotext", "-layout", "-enc", "UTF-8", str(pdf_path), str(text_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    if text_path.stat().st_size < 1000:
        raise ValueError("paper text extraction produced less than 1000 bytes")


def load_rows_by_paper(dataset: Path, selected_urls: set[str]) -> dict[str, list[dict[str, object]]]:
    grouped = {url: [] for url in selected_urls}
    for line in dataset.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        paper_url = row.get("paper_url_versioned")
        if paper_url in grouped:
            grouped[paper_url].append(row)
    missing = [url for url, rows in grouped.items() if not rows]
    if missing:
        raise ValueError(f"selected papers missing from dataset: {len(missing)}")
    return grouped


def materialize_unit(
    record: dict[str, object],
    rows: list[dict[str, object]],
    contract: dict[str, object],
    cache_root: Path,
) -> MaterializedUnit:
    unit_id = str(record["unit_id"])
    if re.fullmatch(r"[0-9a-f]{16}", unit_id) is None:
        raise ValueError(f"unsafe unit id: {unit_id}")
    cache_root = cache_root.resolve()
    downloads = cache_root / "downloads"
    paper_path = download_pdf(
        paper_pdf_url(str(record["paper_url"])),
        downloads / f"{unit_id}.pdf",
        128 * 1024 * 1024,
    )
    archive_path = download_archive(
        archive_url(str(record["code_url"])),
        downloads / f"{unit_id}.zip",
        256 * 1024 * 1024,
    )
    if not zipfile.is_zipfile(archive_path):
        archive_path.unlink(missing_ok=True)
        raise ValueError("repository archive is not a ZIP file")
    original_files = load_candidate_files(archive_path, contract)
    snapshot_hash, features = original_fingerprint(original_files)
    replacements, targets, discrepancy_types, conflicts = mutation_map(rows)
    mutated_files = dict(original_files)
    missing_targets = 0
    for target, body in replacements.items():
        if target in mutated_files:
            mutated_files[target] = body
        else:
            missing_targets += 1

    unit_root = cache_root / "blind" / unit_id
    write_blind_repository(unit_root / "repository", mutated_files)
    extract_paper_text(paper_path, unit_root / "paper.txt")

    context = contract["context_budget"]
    expected_tokenizer_version = context.get("tokenizer_version")
    installed_tokenizer_version = importlib.metadata.version("tiktoken")
    if installed_tokenizer_version != expected_tokenizer_version:
        raise ValueError(
            "tiktoken version mismatch: "
            f"expected {expected_tokenizer_version}, got {installed_tokenizer_version}"
        )
    encoder = tiktoken.get_encoding(str(context["tokenizer"]).split()[-1])
    source_bytes = sum(len(text.encode("utf-8")) for text in mutated_files.values())
    source_tokens = sum(len(encoder.encode(text, disallowed_special=())) for text in mutated_files.values())
    return MaterializedUnit(
        unit_id=unit_id,
        ordering_hash=str(record["ordering_hash"]),
        paper_url=str(record["paper_url"]),
        code_url=str(record["code_url"]),
        paper_sha256=sha256_file(paper_path),
        paper_text_sha256=sha256_file(unit_root / "paper.txt"),
        archive_sha256=sha256_file(archive_path),
        original_snapshot_sha256=snapshot_hash,
        mutated_repository_sha256=sha256_tree(unit_root / "repository"),
        candidate_file_count=len(mutated_files),
        candidate_source_bytes=source_bytes,
        candidate_source_tokens=source_tokens,
        fingerprint_features=features,
        mutation_conflicts=conflicts,
        mutation_targets_missing_from_candidate_universe=missing_targets,
        target_files=tuple(targets),
        discrepancy_types=tuple(discrepancy_types),
    )


def jaccard(left: tuple[str, ...], right: tuple[str, ...]) -> float:
    left_set = set(left)
    right_set = set(right)
    union = left_set | right_set
    return len(left_set & right_set) / len(union) if union else 1.0


def components(units: list[MaterializedUnit], threshold: float = 0.85) -> list[list[MaterializedUnit]]:
    parents = list(range(len(units)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    for left in range(len(units)):
        for right in range(left + 1, len(units)):
            exact = units[left].original_snapshot_sha256 == units[right].original_snapshot_sha256
            similar = jaccard(units[left].fingerprint_features, units[right].fingerprint_features) >= threshold
            if exact or similar:
                union(left, right)
    grouped: dict[int, list[MaterializedUnit]] = {}
    for index, unit in enumerate(units):
        grouped.setdefault(find(index), []).append(unit)
    return [sorted(group, key=lambda unit: unit.ordering_hash) for group in grouped.values()]


def public_record(unit: MaterializedUnit, split: str) -> dict[str, object]:
    return {
        "unit_id": unit.unit_id,
        "split": split,
        "paper_url": unit.paper_url,
        "code_url": unit.code_url,
        "paper_sha256": unit.paper_sha256,
        "paper_text_sha256": unit.paper_text_sha256,
        "archive_sha256": unit.archive_sha256,
        "original_snapshot_sha256": unit.original_snapshot_sha256,
        "mutated_repository_sha256": unit.mutated_repository_sha256,
        "candidate_file_count": unit.candidate_file_count,
        "candidate_source_bytes": unit.candidate_source_bytes,
        "candidate_source_tokens": unit.candidate_source_tokens,
        "blind_paper_relative_path": f"blind/{unit.unit_id}/paper.txt",
        "blind_repository_relative_path": f"blind/{unit.unit_id}/repository",
    }


def write_gold_bundle(
    cache_root: Path,
    split: str,
    units: list[MaterializedUnit],
) -> tuple[Path, str]:
    gold_root = cache_root / "sealed" / f"{split}-gold"
    if gold_root.exists():
        shutil.rmtree(gold_root)
    gold_root.mkdir(parents=True)
    records = []
    for unit in sorted(units, key=lambda item: item.unit_id):
        payload = {
            "schema_version": "1.0",
            "unit_id": unit.unit_id,
            "split": split,
            "target_files": list(unit.target_files),
            "discrepancy_types": list(unit.discrepancy_types),
            "mutation_conflicts": unit.mutation_conflicts,
            "mutation_targets_missing_from_candidate_universe":
                unit.mutation_targets_missing_from_candidate_universe,
        }
        path = gold_root / f"{unit.unit_id}.json"
        path.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        records.append({
            "unit_id": unit.unit_id,
            "path": path.name,
            "sha256": sha256_file(path),
        })
    manifest = {
        "schema_version": "1.0",
        "split": split,
        "records": records,
    }
    manifest_path = cache_root / "sealed" / f"{split}-gold-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest_path, sha256_file(manifest_path)


def validate_access_receipt(
    receipt_path: Path,
    receipt: dict[str, object],
    source_registry_path: Path,
    contract: dict[str, object],
) -> None:
    corpus = contract["corpus"]
    if receipt.get("decision") != "PASS_PREFLIGHT":
        raise ValueError("access receipt did not pass")
    if sha256_file(receipt_path) != corpus["access_receipt_sha256"]:
        raise ValueError("access receipt hash does not match the experiment contract")
    if sha256_file(source_registry_path) != corpus["source_registry_sha256"]:
        raise ValueError("source registry hash does not match the experiment contract")
    records = receipt.get("records")
    if not isinstance(records, list):
        raise ValueError("access receipt records are missing")
    unit_ids = [record.get("unit_id") for record in records if isinstance(record, dict)]
    if len(unit_ids) != len(records) or len(unit_ids) != len(set(unit_ids)):
        raise ValueError("access receipt unit ids must be complete and unique")
    if any(not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{16}", value) is None for value in unit_ids):
        raise ValueError("access receipt contains an unsafe unit id")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--source-registry", type=Path, required=True)
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--cache-root", type=Path, required=True)
    parser.add_argument("--blind-manifest-output", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=6)
    return parser.parse_args()


def verify_dataset_source(
    dataset: Path,
    source_registry: dict[str, object],
    access_receipt: dict[str, object],
) -> str:
    actual = sha256_file(dataset)
    expected_registry = source_registry.get("dataset_sha256")
    expected_receipt = access_receipt.get("source_dataset_sha256")
    if actual != expected_registry:
        raise ValueError("dataset hash does not match the frozen source registry")
    if actual != expected_receipt:
        raise ValueError("dataset hash does not match the access receipt")
    return actual


def main() -> int:
    args = parse_args()
    if args.workers < 1 or args.workers > 16:
        raise ValueError("workers must be between 1 and 16")
    receipt = json.loads(args.receipt.read_text(encoding="utf-8"))
    source_registry = json.loads(args.source_registry.read_text(encoding="utf-8"))
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    validate_access_receipt(args.receipt, receipt, args.source_registry, contract)
    dataset_sha256 = verify_dataset_source(args.dataset, source_registry, receipt)
    eligible_records = [record for record in receipt["records"] if record["eligible"]]
    rows_by_paper = load_rows_by_paper(args.dataset, {str(record["paper_url"]) for record in eligible_records})
    successes: list[MaterializedUnit] = []
    failures: list[dict[str, str]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_by_record = {
            executor.submit(
                materialize_unit,
                record,
                rows_by_paper[str(record["paper_url"])],
                contract,
                args.cache_root,
            ): record
            for record in eligible_records
        }
        for completed, future in enumerate(concurrent.futures.as_completed(future_by_record), start=1):
            record = future_by_record[future]
            try:
                successes.append(future.result())
            except Exception as exc:
                failures.append({"unit_id": str(record["unit_id"]), "error": f"{type(exc).__name__}: {exc}"})
            if completed % 5 == 0 or completed == len(future_by_record):
                print(f"progress={completed}/{len(future_by_record)} successes={len(successes)} failures={len(failures)}", flush=True)

    successes.sort(key=lambda unit: unit.ordering_hash)
    groups = components(successes)
    representatives = sorted((group[0] for group in groups), key=lambda unit: unit.ordering_hash)
    development_count = int(contract["corpus"]["development_units"])
    confirmatory_count = int(contract["corpus"]["confirmatory_units"])
    required = development_count + confirmatory_count
    decision = "PASS_MATERIALIZATION" if len(representatives) >= required else "KILL_DATASET"
    selected = representatives[:required]
    development_ids = {unit.unit_id for unit in selected[:development_count]}
    confirmatory_ids = {unit.unit_id for unit in selected[development_count:]}
    records = [
        public_record(
            unit,
            "development" if unit.unit_id in development_ids else "confirmatory" if unit.unit_id in confirmatory_ids else "reserve",
        )
        for unit in representatives
    ]
    split_units = {
        "development": selected[:development_count],
        "confirmatory": selected[development_count:],
        "reserve": representatives[required:],
    }
    gold_manifests = {
        split: write_gold_bundle(args.cache_root, split, units)[1]
        for split, units in split_units.items()
    }
    args.cache_root.mkdir(parents=True, exist_ok=True)
    manifest_path = args.cache_root / "blind" / "manifest.jsonl"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_text = "".join(
        json.dumps(record, sort_keys=True) + "\n" for record in records
    )
    manifest_path.write_text(manifest_text, encoding="utf-8")
    if args.blind_manifest_output is not None:
        published_manifest = args.blind_manifest_output.resolve()
        if published_manifest != manifest_path.resolve():
            published_manifest.parent.mkdir(parents=True, exist_ok=True)
            published_manifest.write_text(manifest_text, encoding="utf-8")
            if sha256_file(published_manifest) != sha256_file(manifest_path):
                raise ValueError("published blind manifest does not match materialized bytes")
    payload = {
        "schema_version": "1.0",
        "decision": decision,
        "gold_fields_read_only_by_materializer": ["changed_code_files", "discrepancy_type"],
        "source_registry_sha256": sha256_file(args.source_registry),
        "source_dataset_sha256": dataset_sha256,
        "eligible_access_units": len(eligible_records),
        "materialized_units": len(successes),
        "failed_units": failures,
        "independent_components": len(groups),
        "duplicate_components": [[unit.unit_id for unit in group] for group in groups if len(group) > 1],
        "development_unit_ids": [unit.unit_id for unit in selected[:development_count]],
        "confirmatory_unit_ids": [unit.unit_id for unit in selected[development_count:]],
        "reserve_unit_ids": [unit.unit_id for unit in representatives[required:]],
        "blind_manifest_sha256": sha256_file(manifest_path),
        "sealed_gold_manifest_sha256": gold_manifests,
        "aggregate": {
            "candidate_files": sum(unit.candidate_file_count for unit in successes),
            "candidate_source_bytes": sum(unit.candidate_source_bytes for unit in successes),
            "candidate_source_tokens": sum(unit.candidate_source_tokens for unit in successes),
            "mutation_conflicts": sum(unit.mutation_conflicts for unit in successes),
            "mutation_targets_missing_from_candidate_universe": sum(
                unit.mutation_targets_missing_from_candidate_universe for unit in successes
            ),
        },
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({key: payload[key] for key in ("decision", "materialized_units", "independent_components")}), flush=True)
    return 0 if decision == "PASS_MATERIALIZATION" else 2


if __name__ == "__main__":
    raise SystemExit(main())
