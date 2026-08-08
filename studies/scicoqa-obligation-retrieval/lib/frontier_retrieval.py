"""Frontier-model request, parsing, and ranking helpers."""

from __future__ import annotations

import ast
import hashlib
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Sequence


SYMBOL_LINE = re.compile(
    r"^\s*(?:def|class|function|fn|struct|enum|interface|module)\s+([A-Za-z_][A-Za-z0-9_]*)",
    re.MULTILINE,
)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_json(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_env_key(env_path: Path, key: str) -> str | None:
    if not env_path.exists():
        return None
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() == key:
            return value.strip().strip('"').strip("'") or None
    return None


def extract_symbols(path: Path, text: str, maximum: int = 40) -> list[str]:
    symbols: list[str] = []
    if path.suffix.lower() == ".py":
        try:
            tree = ast.parse(text)
            symbols.extend(
                node.name
                for node in ast.walk(tree)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            )
        except SyntaxError:
            pass
    symbols.extend(SYMBOL_LINE.findall(text))
    return list(dict.fromkeys(symbols))[:maximum]


def build_repository_map(
    repository: Path,
    allowed_paths: set[str] | None = None,
) -> str:
    lines = []
    for path in sorted(item for item in repository.rglob("*") if item.is_file()):
        relative = path.relative_to(repository).as_posix()
        if allowed_paths is not None and relative not in allowed_paths:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        symbols = extract_symbols(path, text)
        suffix = f" | symbols: {', '.join(symbols)}" if symbols else ""
        lines.append(relative + suffix)
    return "\n".join(lines)


def extract_output_text(payload: dict[str, object]) -> str:
    parts = []
    for output in payload.get("output", []):
        if not isinstance(output, dict):
            continue
        for content in output.get("content", []):
            if isinstance(content, dict) and content.get("type") == "output_text":
                text = content.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
    return "\n".join(parts)


def parse_json_output(text: str) -> dict[str, object]:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        stripped = "\n".join(lines).strip()
    value = json.loads(stripped)
    if not isinstance(value, dict):
        raise ValueError("frontier output must be a JSON object")
    return value


def build_responses_request(
    model: str,
    reasoning_effort: str,
    prompt: str,
) -> dict[str, object]:
    return {
        "model": model,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
        "text": {"format": {"type": "text"}},
        "reasoning": {"effort": reasoning_effort},
        "max_output_tokens": 6000,
    }


def fill_prompt(template: str, **values: str) -> str:
    result = template
    for key, value in values.items():
        result = result.replace("{{" + key + "}}", value)
    if "{{" in result or "}}" in result:
        raise ValueError("unresolved prompt placeholder")
    return result


def call_responses_api(
    api_key: str,
    model: str,
    reasoning_effort: str,
    prompt: str,
    attempts: int = 3,
) -> dict[str, object]:
    body = build_responses_request(model, reasoning_effort, prompt)
    encoded = json.dumps(body).encode("utf-8")
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(
            "https://api.openai.com/v1/responses",
            data=encoded,
            method="POST",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=900) as response:
                payload = json.loads(response.read().decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("Responses API returned a non-object payload")
                return payload
        except urllib.error.HTTPError as exc:
            retryable = exc.code == 429 or 500 <= exc.code < 600
            if not retryable or attempt == attempts:
                detail = exc.read(4096).decode("utf-8", errors="replace")
                raise RuntimeError(f"Responses API failed with HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            if attempt == attempts:
                raise RuntimeError(f"Responses API network failure: {exc}") from exc
        time.sleep(2 ** (attempt - 1))
    raise AssertionError("unreachable")


def obligation_query(parsed: dict[str, object]) -> str:
    obligations = parsed.get("obligations")
    if not isinstance(obligations, list):
        raise ValueError("obligation output is missing obligations array")
    parts = []
    for item in obligations[:12]:
        if not isinstance(item, dict):
            continue
        for key in ("statement", "evidence"):
            value = item.get(key)
            if isinstance(value, str):
                parts.append(value)
        for key in ("concepts", "identifiers"):
            value = item.get(key)
            if isinstance(value, list):
                parts.extend(str(entry) for entry in value if isinstance(entry, str))
    query = "\n".join(parts).strip()
    if not query:
        raise ValueError("obligation output contains no usable query text")
    return query


def selected_paths(parsed: dict[str, object], allowed_paths: set[str]) -> list[str]:
    ranked_files = parsed.get("ranked_files")
    if not isinstance(ranked_files, list):
        raise ValueError("selector output is missing ranked_files array")
    paths = []
    for item in ranked_files:
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        if isinstance(path, str) and path in allowed_paths and path not in paths:
            paths.append(path)
    return paths


def selector_chunk_ranking(paths: Sequence[str], paper_text: str, chunks, retrieval) -> list[int]:
    bm25_ranking = retrieval.ranked_indexes(chunks, retrieval.bm25_scores(paper_text, chunks))
    by_path: dict[str, list[int]] = {}
    for index in bm25_ranking:
        by_path.setdefault(chunks[index].path, []).append(index)
    selected = []
    seen = set()
    for path in paths:
        for index in by_path.get(path, []):
            selected.append(index)
            seen.add(index)
    selected.extend(index for index in bm25_ranking if index not in seen)
    return selected


def resolve_system_ranking(
    system: str,
    parsed: dict[str, object] | None,
    allowed_paths: set[str],
    paper_text: str,
    chunks,
    retrieval,
) -> tuple[list[int], str | None]:
    if not isinstance(parsed, dict):
        return [], "invalid_json_object"
    try:
        if system == "generic_frontier_selector":
            paths = selected_paths(parsed, allowed_paths)
            return selector_chunk_ranking(paths, paper_text, chunks, retrieval), None
        if system == "frontier_obligations":
            query = obligation_query(parsed)
            return (
                retrieval.ranked_indexes(
                    chunks,
                    retrieval.hybrid_scores(query, chunks),
                ),
                None,
            )
    except (TypeError, ValueError):
        return [], "invalid_system_schema"
    raise ValueError(f"unsupported frontier system: {system}")
