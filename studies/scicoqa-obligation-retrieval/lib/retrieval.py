"""Gold-free retrieval primitives for budgeted paper-code localization."""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


LEXICAL_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9]*|[0-9]+(?:\.[0-9]+)?")
CAMEL_BOUNDARY = re.compile(r"([a-z0-9])([A-Z])")
SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+(?=[A-Z])|\n{2,}")
METHOD_HEADING = re.compile(
    r"^(?:\d+(?:\.\d+)*\s+)?(?:methods?|methodology|approach|model|implementation(?: details)?|experimental setup|experiments?)$",
    re.IGNORECASE,
)
GENERAL_HEADING = re.compile(r"^(?:\d+(?:\.\d+)*\s+)?[A-Z][A-Z0-9 &:/_-]{2,80}$")
OBLIGATION_CUES = (
    "we use",
    "we train",
    "we optimize",
    "we compute",
    "we apply",
    "we initialize",
    "is computed",
    "is trained",
    "is optimized",
    "loss",
    "objective",
    "algorithm",
    "hyperparameter",
    "learning rate",
    "batch size",
    "preprocess",
    "evaluation",
)


@dataclass(frozen=True)
class Chunk:
    chunk_id: str
    path: str
    start_token: int
    end_token: int
    text: str
    packed_tokens: int


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_tree(root: Path) -> str:
    resolved = root.resolve()
    if not resolved.is_dir():
        raise ValueError(f"repository tree is missing: {root}")
    digest = hashlib.sha256()
    files = sorted(item for item in resolved.rglob("*") if item.is_file())
    for path in files:
        if path.is_symlink():
            raise ValueError(f"repository tree contains a symlink: {path}")
        relative = path.relative_to(resolved).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256_file(path).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def verify_blind_unit(cache_root: Path, record: dict[str, object]) -> tuple[Path, Path]:
    unit_id = record.get("unit_id")
    if not isinstance(unit_id, str) or re.fullmatch(r"[0-9a-f]{16}", unit_id) is None:
        raise ValueError("blind manifest contains an unsafe unit id")
    blind_root = (cache_root.resolve() / "blind").resolve()
    unit_root = (blind_root / unit_id).resolve()
    if unit_root.parent != blind_root:
        raise ValueError("blind unit path escapes the cache root")
    paper_path = unit_root / "paper.txt"
    repository = unit_root / "repository"
    if record.get("blind_paper_relative_path") != f"blind/{unit_id}/paper.txt":
        raise ValueError(f"blind paper path mismatch: {unit_id}")
    if record.get("blind_repository_relative_path") != f"blind/{unit_id}/repository":
        raise ValueError(f"blind repository path mismatch: {unit_id}")
    if sha256_file(paper_path) != record.get("paper_text_sha256"):
        raise ValueError(f"blind paper text hash mismatch: {unit_id}")
    if sha256_tree(repository) != record.get("mutated_repository_sha256"):
        raise ValueError(f"blind repository tree hash mismatch: {unit_id}")
    return paper_path, repository


def lexical_tokens(text: str) -> list[str]:
    expanded = CAMEL_BOUNDARY.sub(r"\1 \2", text.replace("_", " "))
    return [token.lower() for token in LEXICAL_TOKEN.findall(expanded) if len(token) > 1]


def extract_methods_text(paper_text: str) -> str:
    sections: list[str] = []
    current: list[str] = []
    collecting = False
    for raw_line in paper_text.splitlines():
        line = " ".join(raw_line.strip().split())
        if not line:
            if collecting:
                current.append("")
            continue
        if METHOD_HEADING.fullmatch(line):
            if current:
                sections.append("\n".join(current).strip())
                current = []
            collecting = True
            continue
        if collecting and GENERAL_HEADING.fullmatch(line) and len(current) >= 3:
            sections.append("\n".join(current).strip())
            current = []
            collecting = False
            continue
        if collecting:
            current.append(line)
    if current:
        sections.append("\n".join(current).strip())
    extracted = "\n\n".join(section for section in sections if section)
    return extracted or paper_text


def deterministic_obligations(paper_text: str, maximum: int = 12) -> list[str]:
    methods = extract_methods_text(paper_text)
    sentences = [" ".join(sentence.split()) for sentence in SENTENCE_BOUNDARY.split(methods)]
    ranked: list[tuple[int, int, str]] = []
    for index, sentence in enumerate(sentences):
        if len(sentence) < 40 or len(sentence) > 700:
            continue
        lowered = sentence.lower()
        cue_score = sum(cue in lowered for cue in OBLIGATION_CUES)
        symbol_score = int(bool(re.search(r"[=<>]|\b(?:CNN|RNN|MLP|API|GPU|Adam|SGD)\b", sentence)))
        number_score = int(bool(re.search(r"\b\d+(?:\.\d+)?\b", sentence)))
        score = cue_score * 3 + symbol_score + number_score
        if score > 0:
            ranked.append((-score, index, sentence))
    return [sentence for _, _, sentence in sorted(ranked)[:maximum]]


def build_chunks(repository: Path, encoder, chunk_tokens: int, overlap_tokens: int) -> list[Chunk]:
    if chunk_tokens <= 0 or overlap_tokens < 0 or overlap_tokens >= chunk_tokens:
        raise ValueError("invalid chunk or overlap size")
    chunks: list[Chunk] = []
    step = chunk_tokens - overlap_tokens
    for path in sorted(item for item in repository.rglob("*") if item.is_file()):
        relative = path.relative_to(repository).as_posix()
        text = path.read_text(encoding="utf-8", errors="ignore")
        token_ids = encoder.encode(text, disallowed_special=())
        starts = range(0, max(1, len(token_ids)), step)
        for start in starts:
            end = min(len(token_ids), start + chunk_tokens)
            content = encoder.decode(token_ids[start:end]) if token_ids else ""
            header = f"# File: {relative}\n# Token span: {start}:{end}\n"
            packed_tokens = len(encoder.encode(header + content, disallowed_special=()))
            chunks.append(
                Chunk(
                    chunk_id=f"{relative}#{start}:{end}",
                    path=relative,
                    start_token=start,
                    end_token=end,
                    text=content,
                    packed_tokens=packed_tokens,
                )
            )
            if end >= len(token_ids):
                break
    return chunks


def bm25_scores(query: str, chunks: Sequence[Chunk], k1: float = 1.2, b: float = 0.75) -> list[float]:
    documents = [lexical_tokens(chunk.path + "\n" + chunk.text) for chunk in chunks]
    if not documents:
        return []
    query_terms = lexical_tokens(query)
    lengths = [len(document) for document in documents]
    average_length = sum(lengths) / len(lengths) if lengths else 1.0
    frequencies = [Counter(document) for document in documents]
    document_frequency = Counter()
    for terms in frequencies:
        document_frequency.update(terms.keys())
    scores = [0.0 for _ in chunks]
    for term, query_count in Counter(query_terms).items():
        frequency = document_frequency.get(term, 0)
        if frequency == 0:
            continue
        inverse_document_frequency = math.log(1.0 + (len(chunks) - frequency + 0.5) / (frequency + 0.5))
        for index, terms in enumerate(frequencies):
            term_frequency = terms.get(term, 0)
            if term_frequency == 0:
                continue
            denominator = term_frequency + k1 * (1.0 - b + b * lengths[index] / max(1.0, average_length))
            scores[index] += query_count * inverse_document_frequency * term_frequency * (k1 + 1.0) / denominator
    return scores


def ranked_indexes(chunks: Sequence[Chunk], scores: Sequence[float]) -> list[int]:
    return sorted(
        range(len(chunks)),
        key=lambda index: (-scores[index], chunks[index].path.lower(), chunks[index].start_token),
    )


def overlap_scores(query: str, chunks: Sequence[Chunk], path_only: bool) -> list[float]:
    query_terms = set(lexical_tokens(query))
    scores = []
    for chunk in chunks:
        candidate = chunk.path if path_only else chunk.path + "\n" + chunk.text
        terms = set(lexical_tokens(candidate))
        scores.append(float(len(query_terms & terms)))
    return scores


def reciprocal_rank_fusion(rankings: Sequence[Sequence[int]], size: int, constant: int = 60) -> list[float]:
    scores = [0.0] * size
    for ranking in rankings:
        for rank, index in enumerate(ranking, start=1):
            scores[index] += 1.0 / (constant + rank)
    return scores


def hybrid_scores(query: str, chunks: Sequence[Chunk]) -> list[float]:
    bm25 = ranked_indexes(chunks, bm25_scores(query, chunks))
    paths = ranked_indexes(chunks, overlap_scores(query, chunks, path_only=True))
    symbols = ranked_indexes(chunks, overlap_scores(query, chunks, path_only=False))
    return reciprocal_rank_fusion([bm25, paths, symbols], len(chunks))


def rank_chunks(system: str, paper_text: str, chunks: Sequence[Chunk]) -> list[int]:
    if system == "alphabetical_prefix":
        return sorted(range(len(chunks)), key=lambda index: (chunks[index].path.lower(), chunks[index].start_token))
    methods = extract_methods_text(paper_text)
    if system == "whole_paper_bm25":
        return ranked_indexes(chunks, bm25_scores(paper_text, chunks))
    if system == "methods_only_bm25":
        return ranked_indexes(chunks, bm25_scores(methods, chunks))
    if system == "generic_hybrid":
        return ranked_indexes(chunks, hybrid_scores(methods, chunks))
    if system == "deterministic_obligations":
        obligations = deterministic_obligations(paper_text)
        query = "\n".join(obligations) if obligations else methods
        return ranked_indexes(chunks, hybrid_scores(query, chunks))
    raise ValueError(f"unsupported deterministic system: {system}")


def pack_chunks(chunks: Sequence[Chunk], ranking: Sequence[int], budget_tokens: int) -> tuple[list[Chunk], int]:
    selected: list[Chunk] = []
    used = 0
    for index in ranking:
        chunk = chunks[index]
        if used + chunk.packed_tokens > budget_tokens:
            continue
        selected.append(chunk)
        used += chunk.packed_tokens
    return selected, used


def retrieved_files(selected: Sequence[Chunk]) -> list[str]:
    return sorted({chunk.path for chunk in selected})


def file_recall(predicted: Iterable[str], gold: Iterable[str]) -> float:
    predicted_set = {PurePath(value) for value in predicted}
    gold_set = {PurePath(value) for value in gold}
    if not gold_set:
        raise ValueError("gold file set must not be empty")
    return len(predicted_set & gold_set) / len(gold_set)


def PurePath(value: str) -> str:
    return Path(value.replace("\\", "/")).as_posix().lstrip("./")
