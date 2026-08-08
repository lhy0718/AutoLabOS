#!/usr/bin/env python3
"""Outcome-blind access and license preflight for versioned paper/code pairs."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable


GITHUB_TREE_URL = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/tree/(?P<revision>[0-9a-fA-F]{7,40})/?$"
)
ARXIV_URL = re.compile(r"^https?://(?:export\.)?arxiv\.org/(?:abs|pdf)/(?P<identifier>[^?#]+?)(?:\.pdf)?/?$")
LICENSE_NAMES = ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING")
ALLOWED_LICENSES = ("MIT", "Apache-2.0", "BSD", "CC-BY")


@dataclass(frozen=True)
class Unit:
    unit_id: str
    paper_url: str
    code_url: str
    archive_url: str
    owner: str
    repository: str
    revision: str
    ordering_hash: str


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def require_source_hash(dataset_path: Path, expected: str) -> None:
    actual = sha256_bytes(dataset_path.read_bytes())
    if actual != expected:
        raise ValueError(f"dataset hash mismatch: expected {expected}, got {actual}")


def iter_outcome_blind_rows(dataset_path: Path, forbidden_fields: Iterable[str]) -> Iterable[dict[str, str]]:
    forbidden = set(forbidden_fields)
    for line_number, line in enumerate(dataset_path.read_text(encoding="utf-8").splitlines(), start=1):
        raw = json.loads(line)
        if not isinstance(raw, dict):
            raise ValueError(f"line {line_number} is not a JSON object")
        missing = {"paper_url_versioned", "code_url_versioned"} - raw.keys()
        if missing:
            raise ValueError(f"line {line_number} is missing {sorted(missing)}")
        yield {
            key: str(value)
            for key, value in raw.items()
            if key in {"paper_url_versioned", "code_url_versioned"} and key not in forbidden
        }


def parse_code_url(code_url: str) -> tuple[str, str, str, str]:
    match = GITHUB_TREE_URL.match(code_url)
    if match is None:
        raise ValueError(f"unsupported versioned repository URL: {code_url}")
    owner = match.group("owner")
    repository = match.group("repo")
    revision = match.group("revision").lower()
    archive_url = f"https://codeload.github.com/{owner}/{repository}/zip/{revision}"
    return owner, repository, revision, archive_url


def paper_pdf_url(paper_url: str) -> str:
    match = ARXIV_URL.match(paper_url)
    if match is None:
        return paper_url
    identifier = match.group("identifier")
    return f"https://arxiv.org/pdf/{identifier}"


def build_units(dataset_path: Path, ordering_salt: str, forbidden_fields: Iterable[str]) -> list[Unit]:
    grouped: dict[str, dict[str, object]] = {}
    for row in iter_outcome_blind_rows(dataset_path, forbidden_fields):
        paper_url = row["paper_url_versioned"]
        code_url = row["code_url_versioned"]
        group = grouped.setdefault(paper_url, {"code_urls": set()})
        code_urls = group["code_urls"]
        assert isinstance(code_urls, set)
        code_urls.add(code_url)

    units: list[Unit] = []
    paper_by_code_url: dict[str, str] = {}
    for paper_url, group in grouped.items():
        code_urls = sorted(group["code_urls"])
        if len(code_urls) != 1:
            raise ValueError(f"paper maps to {len(code_urls)} versioned repositories: {paper_url}")
        code_url = code_urls[0]
        prior_paper = paper_by_code_url.setdefault(code_url, paper_url)
        if prior_paper != paper_url:
            raise ValueError(f"versioned repository maps to multiple papers: {code_url}")
        owner, repository, revision, archive_url = parse_code_url(code_url)
        ordering_hash = sha256_bytes(
            f"{ordering_salt}\0{paper_url}\0{code_url}".encode("utf-8")
        )
        units.append(
            Unit(
                unit_id=ordering_hash[:16],
                paper_url=paper_url,
                code_url=code_url,
                archive_url=archive_url,
                owner=owner,
                repository=repository,
                revision=revision,
                ordering_hash=ordering_hash,
            )
        )
    return sorted(units, key=lambda unit: unit.ordering_hash)


def bounded_fetch(url: str, max_bytes: int = 65536, timeout_seconds: int = 12) -> tuple[bool, bytes, str]:
    request = urllib.request.Request(
        url,
        headers={
            "Range": f"bytes=0-{max_bytes - 1}",
            "User-Agent": "AutoLabOS-research-preflight/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            data = response.read(max_bytes)
            return 200 <= response.status < 400, data, f"http_{response.status}"
    except urllib.error.HTTPError as exc:
        return False, b"", f"http_{exc.code}"
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return False, b"", type(exc).__name__


def classify_license(text: str) -> str | None:
    lowered = text.lower()
    if "apache license" in lowered and "version 2.0" in lowered:
        return "Apache-2.0"
    if "permission is hereby granted, free of charge" in lowered:
        return "MIT"
    if "redistribution and use in source and binary forms" in lowered:
        return "BSD"
    if "creative commons attribution" in lowered or "creativecommons.org/licenses/by/" in lowered:
        return "CC-BY"
    return None


def probe_license(unit: Unit, fetch: Callable[[str, int], tuple[bool, bytes, str]]) -> tuple[str | None, str | None]:
    for name in LICENSE_NAMES:
        url = f"https://raw.githubusercontent.com/{unit.owner}/{unit.repository}/{unit.revision}/{name}"
        ok, data, _ = fetch(url, 65536)
        if not ok:
            continue
        classification = classify_license(data.decode("utf-8", errors="replace"))
        if classification in ALLOWED_LICENSES:
            return classification, name
    return None, None


def probe_unit(unit: Unit, fetch: Callable[[str, int], tuple[bool, bytes, str]]) -> dict[str, object]:
    paper_probe_url = paper_pdf_url(unit.paper_url)
    paper_ok, paper_bytes, paper_detail = fetch(paper_probe_url, 2048)
    paper_ok = paper_ok and paper_bytes.startswith(b"%PDF-")
    archive_ok, _, archive_detail = fetch(unit.archive_url, 2048)
    license_id, license_path = probe_license(unit, fetch) if archive_ok else (None, None)
    return {
        "unit_id": unit.unit_id,
        "paper_url": unit.paper_url,
        "paper_probe_url": paper_probe_url,
        "code_url": unit.code_url,
        "ordering_hash": unit.ordering_hash,
        "paper_accessible": paper_ok,
        "paper_probe": paper_detail,
        "archive_accessible": archive_ok,
        "archive_probe": archive_detail,
        "license": license_id,
        "license_path": license_path,
        "eligible": paper_ok and archive_ok and license_id in ALLOWED_LICENSES,
    }


def probe_units(
    units: list[Unit],
    fetch: Callable[[str, int], tuple[bool, bytes, str]],
    workers: int,
) -> list[dict[str, object]]:
    by_id: dict[str, dict[str, object]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(probe_unit, unit, fetch): unit for unit in units}
        for completed, future in enumerate(concurrent.futures.as_completed(futures), start=1):
            result = future.result()
            by_id[str(result["unit_id"])] = result
            if completed % 8 == 0 or completed == len(units):
                eligible = sum(1 for record in by_id.values() if record["eligible"])
                print(f"progress={completed}/{len(units)} eligible={eligible}", flush=True)
    return [by_id[unit.unit_id] for unit in units]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--source-registry", type=Path, required=True)
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=12)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    registry = json.loads(args.source_registry.read_text(encoding="utf-8"))
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    require_source_hash(args.dataset, registry["dataset_sha256"])
    units = build_units(
        args.dataset,
        registry["ordering_salt"],
        registry["outcome_fields_forbidden_during_preflight"],
    )
    probe_limit = int(contract["selection"]["probe_limit"])
    if args.workers < 1 or args.workers > 32:
        raise ValueError("workers must be between 1 and 32")
    records = probe_units(units[:probe_limit], bounded_fetch, args.workers)
    eligible = [record for record in records if record["eligible"]]
    development_count = int(contract["selection"]["development_count"])
    confirmatory_count = int(contract["selection"]["confirmatory_count"])
    required = development_count + confirmatory_count
    decision = "PASS_PREFLIGHT" if len(eligible) >= required else "KILL_DATASET"
    payload = {
        "schema_version": "1.0",
        "decision": decision,
        "outcome_fields_read": [],
        "source_dataset_sha256": registry["dataset_sha256"],
        "unique_units_in_source": len(units),
        "probed_units": len(records),
        "eligible_units": len(eligible),
        "required_units": required,
        "development_unit_ids": [row["unit_id"] for row in eligible[:development_count]],
        "confirmatory_unit_ids": [row["unit_id"] for row in eligible[development_count:required]],
        "reserve_unit_ids": [row["unit_id"] for row in eligible[required:]],
        "records": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({key: payload[key] for key in ("decision", "probed_units", "eligible_units", "required_units")}))
    return 0 if decision == "PASS_PREFLIGHT" else 2


if __name__ == "__main__":
    raise SystemExit(main())
