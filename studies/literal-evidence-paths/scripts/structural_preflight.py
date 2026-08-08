#!/usr/bin/env python3
"""Run the frozen structural preflight for direct result-sink mutations."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path, PurePosixPath
from typing import Iterable, Mapping, Sequence


PAPERS_MARKER = "const PAPERS = "
NUMERIC_TOKEN = re.compile(
    r"(?<![A-Za-z0-9])[-+]?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][-+]?\d+)?(?![A-Za-z0-9])"
)
STUDY_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = STUDY_ROOT.parents[1]
CANONICAL_CONTRACT = STUDY_ROOT / "method" / "preflight-contract.v1.json"
CANONICAL_SOURCE_REGISTRY = STUDY_ROOT / "corpus" / "source.v1.json"
CANONICAL_MANUAL_AUDIT = STUDY_ROOT / "method" / "manual-development-mutation-audit.v1.json"
CANONICAL_RESULT = STUDY_ROOT / "results" / "structural-preflight.v1.json"
CANONICAL_TERMINATION = STUDY_ROOT / "method" / "termination-decision.v1.json"
KILL_EXIT_CODE = 2

SCALAR_CALL_SUFFIXES = {
    "accuracy",
    "count",
    "float",
    "int",
    "item",
    "len",
    "max",
    "mean",
    "median",
    "min",
    "percentile",
    "quantile",
    "round",
    "score",
    "std",
    "sum",
    "var",
}
SCALAR_NAME_PARTS = {
    "accuracy",
    "count",
    "error",
    "f1",
    "latency",
    "loss",
    "mean",
    "median",
    "metric",
    "precision",
    "rate",
    "ratio",
    "recall",
    "result",
    "runtime",
    "score",
    "std",
    "throughput",
    "time",
    "total",
    "value",
}
ARITHMETIC_BINOPS = (
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.FloorDiv,
    ast.Mod,
    ast.Pow,
)
FROZEN_NUMERIC_GATES = (
    "minimum_confirmatory_workspaces_with_eligible_target",
    "minimum_development_workspaces_with_eligible_target",
    "python_parse_success_rate",
    "mutation_parse_success_rate",
    "maximum_duplicate_target_hash_rate",
    "manual_development_mutation_validity",
)
MANUAL_VALIDITY_CHECKS = (
    "computed_scalar_directly_supplies_recognized_sink",
    "single_expression_span_only",
    "surrounding_call_key_container_schema_unchanged",
    "replacement_is_manuscript_derived",
    "replacement_scalar_type_compatible",
    "no_marker_or_formatting_cue",
    "mutated_file_parses",
)


@dataclass(frozen=True)
class Candidate:
    file: str
    line_start: int
    line_end: int
    column_start: int
    column_end: int
    sink_family: str
    sink_call: str
    expression_kind: str
    scalar_type: str
    expression_sha256: str


@dataclass(frozen=True)
class ManuscriptLiteral:
    source_token: str
    python_literal: str


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def dotted_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = dotted_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def name_parts(node: ast.AST) -> set[str]:
    name = dotted_name(node).lower()
    return {part for part in re.split(r"[^a-z0-9]+", name) if part}


def is_numeric_constant(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Constant)
        and isinstance(node.value, (int, float))
        and not isinstance(node.value, bool)
    )


def contains_text_literal(node: ast.AST) -> bool:
    return any(
        isinstance(item, ast.JoinedStr)
        or (isinstance(item, ast.Constant) and isinstance(item.value, (str, bytes)))
        for item in ast.walk(node)
    )


def is_scalar_reference(node: ast.AST) -> bool:
    if is_numeric_constant(node):
        return True
    if isinstance(node, (ast.Name, ast.Attribute)):
        return bool(name_parts(node) & SCALAR_NAME_PARTS)
    if isinstance(node, ast.Subscript):
        return False
    if isinstance(node, ast.Call):
        leaf = dotted_name(node.func).lower().rsplit(".", 1)[-1]
        return leaf in SCALAR_CALL_SUFFIXES
    if isinstance(node, ast.UnaryOp):
        return isinstance(node.op, (ast.UAdd, ast.USub)) and is_scalar_reference(node.operand)
    if isinstance(node, ast.IfExp):
        return is_scalar_reference(node.body) and is_scalar_reference(node.orelse)
    if isinstance(node, ast.BinOp):
        return is_scalar_expression(node)
    return False


def is_scalar_expression(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant):
        return False
    if isinstance(node, ast.Call):
        leaf = dotted_name(node.func).lower().rsplit(".", 1)[-1]
        return leaf in SCALAR_CALL_SUFFIXES
    if isinstance(node, ast.Subscript):
        return False
    if isinstance(node, ast.UnaryOp):
        return (
            isinstance(node.op, (ast.UAdd, ast.USub))
            and not contains_text_literal(node)
            and is_scalar_reference(node.operand)
        )
    if isinstance(node, ast.IfExp):
        return is_scalar_reference(node.body) and is_scalar_reference(node.orelse)
    if isinstance(node, ast.BinOp):
        if not isinstance(node.op, ARITHMETIC_BINOPS) or contains_text_literal(node):
            return False
        return is_scalar_reference(node.left) and is_scalar_reference(node.right)
    return False


def infer_scalar_type(node: ast.AST) -> str:
    if isinstance(node, ast.Call):
        leaf = dotted_name(node.func).lower().rsplit(".", 1)[-1]
        if leaf in {"count", "int", "len"}:
            return "integer"
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.FloorDiv):
        return "integer"
    return "number"


def iter_scalar_nodes(node: ast.AST) -> Iterable[ast.AST]:
    if is_scalar_expression(node):
        yield node
        return
    if isinstance(node, ast.Dict):
        for value in node.values:
            if value is not None:
                yield from iter_scalar_nodes(value)
    elif isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        for item in node.elts:
            yield from iter_scalar_nodes(item)
    elif isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
        yield from iter_scalar_nodes(node.elt)
    elif isinstance(node, ast.DictComp):
        yield from iter_scalar_nodes(node.value)
    elif isinstance(node, ast.JoinedStr):
        for value in node.values:
            if isinstance(value, ast.FormattedValue):
                yield from iter_scalar_nodes(value.value)
    elif isinstance(node, ast.Call):
        leaf = dotted_name(node.func).lower().rsplit(".", 1)[-1]
        if leaf in {"dataframe", "series"}:
            for argument in node.args:
                yield from iter_scalar_nodes(argument)
            for keyword in node.keywords:
                yield from iter_scalar_nodes(keyword.value)


class AssignmentIndex(ast.NodeVisitor):
    def __init__(self) -> None:
        self.by_name: dict[tuple[int, str], list[tuple[int, ast.AST]]] = {}
        self.by_container: dict[tuple[int, str], list[tuple[int, ast.AST]]] = {}
        self.call_scope: dict[int, int] = {}
        self.scope_stack = [0]

    def visit_Assign(self, node: ast.Assign) -> None:  # noqa: N802
        for target in node.targets:
            self._record(target, node.lineno, node.value)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:  # noqa: N802
        if node.value is not None:
            self._record(node.target, node.lineno, node.value)
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:  # noqa: N802
        self._visit_scope(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:  # noqa: N802
        self._visit_scope(node)

    def visit_Lambda(self, node: ast.Lambda) -> None:  # noqa: N802
        self._visit_scope(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:  # noqa: N802
        self._visit_scope(node)

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        self.call_scope[id(node)] = self.scope_stack[-1]
        self.generic_visit(node)

    def _visit_scope(self, node: ast.AST) -> None:
        self.scope_stack.append(id(node))
        self.generic_visit(node)
        self.scope_stack.pop()

    def _record(self, target: ast.AST, line: int, value: ast.AST) -> None:
        scope = self.scope_stack[-1]
        if isinstance(target, ast.Name):
            self.by_name.setdefault((scope, target.id), []).append((line, value))
        elif isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name):
            self.by_container.setdefault((scope, target.value.id), []).append((line, value))

    def latest_scalars(
        self,
        name: str,
        before_line: int,
        call: ast.Call,
        tabular_receiver: bool = False,
    ) -> Iterable[ast.AST]:
        scope = self.call_scope[id(call)]
        direct = [
            entry
            for entry in self.by_name.get((scope, name), [])
            if entry[0] < before_line
        ]
        if direct:
            yield from iter_scalar_nodes(direct[-1][1])
        for line, value in self.by_container.get((scope, name), []):
            if line < before_line:
                for scalar in iter_scalar_nodes(value):
                    if tabular_receiver and is_unreduced_container_expression(scalar, name):
                        continue
                    yield scalar


def is_unreduced_container_expression(node: ast.AST, container_name: str) -> bool:
    if isinstance(node, ast.Call):
        leaf = dotted_name(node.func).lower().rsplit(".", 1)[-1]
        if leaf in SCALAR_CALL_SUFFIXES:
            return False
    return any(
        isinstance(item, ast.Subscript)
        and isinstance(item.value, ast.Name)
        and item.value.id == container_name
        for item in ast.walk(node)
    )


def call_arguments(call: ast.Call, index: int, keyword_names: Sequence[str]) -> list[ast.AST]:
    if index < len(call.args):
        return [call.args[index]]
    for keyword in call.keywords:
        if keyword.arg in keyword_names:
            return [keyword.value]
    return []


def sink_payloads(call: ast.Call) -> tuple[str, list[ast.AST]] | None:
    name = dotted_name(call.func).lower()
    leaf = name.rsplit(".", 1)[-1]
    if name.endswith("json.dump"):
        return "json_serialization", call_arguments(call, 0, ("obj",))
    if leaf in {"writerow", "writerows"}:
        return "tabular_serialization", call_arguments(call, 0, ("row", "rows"))
    if leaf in {"to_csv", "to_json", "to_parquet"} and isinstance(call.func, ast.Attribute):
        return "tabular_serialization", [call.func.value]
    if name in {"np.savetxt", "numpy.savetxt"}:
        return "tabular_serialization", call_arguments(call, 1, ("X",))
    if name in {"np.save", "numpy.save"}:
        return "array_serialization", call_arguments(call, 1, ("arr",))
    if name == "torch.save":
        return "array_serialization", call_arguments(call, 0, ("obj",))
    if leaf == "write":
        return "text_or_latex_emission", call_arguments(call, 0, ("s",))
    if leaf in {"plot", "scatter", "bar", "barh", "errorbar", "fill_between"}:
        positional_limits = {
            "plot": len(call.args),
            "scatter": 2,
            "bar": 2,
            "barh": 2,
            "errorbar": 2,
            "fill_between": 3,
        }
        payloads = list(call.args[: positional_limits[leaf]])
        data_keywords = {"x", "y", "height", "width", "yerr", "xerr", "y1", "y2"}
        payloads.extend(keyword.value for keyword in call.keywords if keyword.arg in data_keywords)
        return "saved_figure_data", payloads
    return None


def make_candidate(
    source: str,
    file_path: str,
    family: str,
    call_name: str,
    node: ast.AST,
) -> Candidate:
    segment = ast.get_source_segment(source, node) or ""
    return Candidate(
        file=file_path,
        line_start=node.lineno,
        line_end=getattr(node, "end_lineno", node.lineno),
        column_start=node.col_offset,
        column_end=getattr(node, "end_col_offset", node.col_offset),
        sink_family=family,
        sink_call=call_name,
        expression_kind=type(node).__name__,
        scalar_type=infer_scalar_type(node),
        expression_sha256=sha256_text(segment),
    )


def scan_python_file(path: Path, workspace: Path) -> tuple[list[Candidate], str | None]:
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
    except (OSError, UnicodeDecodeError, SyntaxError) as exc:
        return [], f"{type(exc).__name__}: {exc}"

    assignments = AssignmentIndex()
    assignments.visit(tree)
    has_saved_figure = any(
        isinstance(node, ast.Call) and dotted_name(node.func).lower().endswith("savefig")
        for node in ast.walk(tree)
    )
    candidates: list[Candidate] = []
    relative = path.relative_to(workspace).as_posix()

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        spec = sink_payloads(node)
        if spec is None:
            continue
        family, payloads = spec
        if family == "saved_figure_data" and not has_saved_figure:
            continue
        call_name = dotted_name(node.func)
        leaf = call_name.lower().rsplit(".", 1)[-1]
        for payload in payloads:
            tabular_receiver = (
                leaf in {"to_csv", "to_json", "to_parquet"}
                and isinstance(node.func, ast.Attribute)
                and payload is node.func.value
            )
            if tabular_receiver and not isinstance(payload, (ast.Name, ast.Call)):
                scalars = []
            else:
                scalars = list(iter_scalar_nodes(payload))
            if isinstance(payload, ast.Name):
                scalars.extend(
                    assignments.latest_scalars(
                        payload.id,
                        node.lineno,
                        node,
                        tabular_receiver=tabular_receiver,
                    )
                )
            for scalar in scalars:
                candidates.append(make_candidate(source, relative, family, call_name, scalar))

    unique = {
        (
            item.file,
            item.line_start,
            item.column_start,
            item.expression_sha256,
            item.sink_family,
            item.sink_call,
        ): item
        for item in candidates
    }
    family_order = {
        "json_serialization": 0,
        "tabular_serialization": 1,
        "array_serialization": 2,
        "text_or_latex_emission": 3,
        "saved_figure_data": 4,
    }
    ordered = sorted(
        unique.values(),
        key=lambda item: (
            family_order[item.sink_family],
            item.file,
            item.line_start,
            item.column_start,
        ),
    )
    return ordered, None


def extract_papers(index_html: Path) -> list[dict[str, object]]:
    source = index_html.read_text(encoding="utf-8")
    start = source.find(PAPERS_MARKER)
    if start < 0:
        raise ValueError("paper index does not contain the expected JSON marker")
    start += len(PAPERS_MARKER)
    end = source.find(";\n", start)
    if end < 0:
        raise ValueError("paper index JSON is not terminated")
    value = json.loads(source[start:end])
    if not isinstance(value, list):
        raise ValueError("paper index JSON must be an array")
    if not all(isinstance(item, dict) for item in value):
        raise ValueError("paper index rows must be objects")
    return value


def manuscript_numeric_literals(path: Path) -> list[ManuscriptLiteral]:
    try:
        source = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    literals: list[ManuscriptLiteral] = []
    for match in NUMERIC_TOKEN.finditer(source):
        source_token = match.group(0)
        literal = source_token
        if literal.startswith("+"):
            literal = literal[1:]
        if literal.startswith("."):
            literal = f"0{literal}"
        elif literal.startswith("-."):
            literal = f"-0{literal[1:]}"
        try:
            parsed = ast.parse(literal, mode="eval").body
        except SyntaxError:
            continue
        if is_numeric_constant(parsed):
            literals.append(
                ManuscriptLiteral(
                    source_token=source_token,
                    python_literal=literal,
                )
            )
    return literals


def manuscript_numeric_count(path: Path) -> int:
    return len(manuscript_numeric_literals(path))


def source_segment_bytes(source: str, candidate: Candidate) -> tuple[bytes, int, int]:
    encoded_lines = [line.encode("utf-8") for line in source.splitlines(keepends=True)]
    if candidate.line_start < 1 or candidate.line_end > len(encoded_lines):
        raise ValueError("candidate line span is outside the source file")
    start = (
        sum(len(line) for line in encoded_lines[: candidate.line_start - 1])
        + candidate.column_start
    )
    end = (
        sum(len(line) for line in encoded_lines[: candidate.line_end - 1])
        + candidate.column_end
    )
    source_bytes = source.encode("utf-8")
    return source_bytes, start, end


def select_replacement_literal(
    literals: Sequence[ManuscriptLiteral],
    workspace_id: str,
    candidate: Candidate,
    expression: str,
) -> ManuscriptLiteral | None:
    compatible = list(literals)
    if candidate.scalar_type == "integer":
        compatible = [
            literal
            for literal in compatible
            if isinstance(ast.literal_eval(literal.python_literal), int)
            and not isinstance(ast.literal_eval(literal.python_literal), bool)
        ]
    expression_lower = expression.lower()
    values = {
        literal: float(ast.literal_eval(literal.python_literal))
        for literal in compatible
    }
    if any(
        hint in expression_lower
        for hint in ("accuracy", "coverage", "precision", "recall", "f1", "rate", "ratio")
    ):
        compatible = [literal for literal in compatible if 0.0 <= values[literal] <= 1.0]
    elif any(hint in expression_lower for hint in ("pct", "percent")):
        compatible = [literal for literal in compatible if -100.0 <= values[literal] <= 100.0]
    elif any(hint in expression_lower for hint in ("len(", "count")):
        compatible = [literal for literal in compatible if 0.0 <= values[literal] <= 100.0]
    if not compatible:
        return None
    seed = sha256_text(f"{workspace_id}\n{candidate.expression_sha256}")
    return compatible[int(seed[:16], 16) % len(compatible)]


def evaluate_mutation(
    workspace: Path,
    paper_path: Path,
    workspace_id: str,
    candidate: Candidate,
) -> tuple[dict[str, object], ManuscriptLiteral | None]:
    source_path = workspace / candidate.file
    source = source_path.read_text(encoding="utf-8")
    source_bytes, start, end = source_segment_bytes(source, candidate)
    original = source_bytes[start:end]
    try:
        original_text = original.decode("utf-8")
    except UnicodeDecodeError as exc:
        return {
            "attempted": False,
            "parse_success": False,
            "parse_error": f"candidate span is not valid UTF-8: {exc}",
        }, None

    literals = manuscript_numeric_literals(paper_path)
    selected_literal = select_replacement_literal(
        literals,
        workspace_id,
        candidate,
        original_text,
    )
    replacement = selected_literal.python_literal if selected_literal is not None else None
    if replacement is None:
        return {
            "attempted": False,
            "parse_success": False,
            "parse_error": "no compatible manuscript-derived numeric literal",
        }, None
    if sha256_text(original_text) != candidate.expression_sha256:
        return {
            "attempted": False,
            "parse_success": False,
            "parse_error": "candidate source hash changed before mutation",
        }, selected_literal

    mutated_bytes = source_bytes[:start] + replacement.encode("utf-8") + source_bytes[end:]
    try:
        mutated_source = mutated_bytes.decode("utf-8")
        ast.parse(mutated_source, filename=str(source_path))
    except (UnicodeDecodeError, SyntaxError) as exc:
        return {
            "attempted": True,
            "parse_success": False,
            "parse_error": f"{type(exc).__name__}: {exc}",
            "replacement_literal_sha256": sha256_text(replacement),
            "replacement_source_token_sha256": sha256_text(selected_literal.source_token),
        }, selected_literal
    return {
        "attempted": True,
        "parse_success": True,
        "parse_error": None,
        "replacement_literal_sha256": sha256_text(replacement),
        "replacement_source_token_sha256": sha256_text(selected_literal.source_token),
        "replacement_scalar_type": candidate.scalar_type,
        "mutated_file_sha256": hashlib.sha256(mutated_bytes).hexdigest(),
    }, selected_literal


def read_json_object(path: Path, label: str) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def require_canonical_path(path: Path, canonical: Path, label: str) -> None:
    if path.resolve() != canonical.resolve():
        raise ValueError(f"{label} must be the canonical study file: {canonical}")


def resolve_canonical_reference(reference: object, canonical: Path, label: str) -> Path:
    if not isinstance(reference, str) or not reference:
        raise ValueError(f"{label} path is missing")
    relative = PurePosixPath(reference)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"{label} path must be repository-relative")
    resolved = (REPOSITORY_ROOT / Path(*relative.parts)).resolve()
    require_canonical_path(resolved, canonical, label)
    return resolved


def require_sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def load_canonical_configuration(
    contract_path: Path = CANONICAL_CONTRACT,
) -> tuple[dict[str, object], dict[str, object], dict[str, object], dict[str, str]]:
    require_canonical_path(contract_path, CANONICAL_CONTRACT, "preflight contract")
    contract = read_json_object(CANONICAL_CONTRACT, "preflight contract")
    if contract.get("artifact_kind") != "literal_evidence_paths_preflight_contract":
        raise ValueError("canonical preflight contract has the wrong artifact kind")
    if contract.get("study_slug") != "literal-evidence-paths":
        raise ValueError("canonical preflight contract has the wrong study slug")
    if contract.get("status") != "post_scan_integrity_amendment":
        raise ValueError("preflight contract is missing the governed integrity amendment")
    amendment = contract.get("integrity_amendment")
    if (
        contract.get("thresholds_frozen_before_initial_scan") is not True
        or not isinstance(amendment, dict)
        or amendment.get("structural_eligibility_outcomes_observed") is not True
        or amendment.get("confirmatory_model_outcomes_observed") is not False
        or amendment.get("scientific_thresholds_changed") is not False
    ):
        raise ValueError("preflight integrity amendment metadata is incomplete")

    corpus = contract.get("corpus")
    if not isinstance(corpus, dict):
        raise ValueError("preflight contract is missing corpus metadata")
    registry_path = resolve_canonical_reference(
        corpus.get("registry"),
        CANONICAL_SOURCE_REGISTRY,
        "source registry",
    )
    expected_registry_sha256 = require_sha256(
        corpus.get("registry_sha256"),
        "contract corpus.registry_sha256",
    )
    actual_registry_sha256 = sha256_file(registry_path)
    if actual_registry_sha256 != expected_registry_sha256:
        raise ValueError(
            "canonical source registry hash mismatch: "
            f"expected {expected_registry_sha256}, got {actual_registry_sha256}"
        )
    registry = read_json_object(registry_path, "source registry")
    if registry.get("artifact_kind") != "external_corpus_source_registry":
        raise ValueError("canonical source registry has the wrong artifact kind")

    evidence = contract.get("structural_preflight_evidence")
    if not isinstance(evidence, dict):
        raise ValueError("preflight contract is missing structural preflight evidence")
    audit_spec = evidence.get("manual_development_mutation_audit")
    if not isinstance(audit_spec, dict):
        raise ValueError("preflight contract is missing the manual development audit")
    audit_path = resolve_canonical_reference(
        audit_spec.get("path"),
        CANONICAL_MANUAL_AUDIT,
        "manual development audit",
    )
    expected_audit_sha256 = require_sha256(
        audit_spec.get("sha256"),
        "manual development audit sha256",
    )
    actual_audit_sha256 = sha256_file(audit_path)
    if actual_audit_sha256 != expected_audit_sha256:
        raise ValueError(
            "canonical manual development audit hash mismatch: "
            f"expected {expected_audit_sha256}, got {actual_audit_sha256}"
        )
    audit = read_json_object(audit_path, "manual development audit")
    hashes = {
        "contract_sha256": sha256_file(CANONICAL_CONTRACT),
        "source_registry_sha256": actual_registry_sha256,
        "manual_audit_sha256": actual_audit_sha256,
    }
    return contract, registry, audit, hashes


def git_output(root: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", *arguments],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def normalize_repository_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    if normalized.endswith(".git"):
        normalized = normalized[:-4]
    return normalized.lower()


def verify_corpus_checkout(
    root: Path,
    registry: Mapping[str, object],
) -> tuple[str, str]:
    actual_revision = git_output(root, "rev-parse", "HEAD")
    expected_revision = registry.get("commit")
    if actual_revision != expected_revision:
        raise ValueError(
            f"corpus revision mismatch: expected {expected_revision}, got {actual_revision}"
        )
    status = git_output(root, "status", "--porcelain", "--untracked-files=all")
    if status:
        raise ValueError("corpus checkout is not clean")
    actual_url = git_output(root, "remote", "get-url", "origin")
    expected_url = registry.get("repository_url")
    if (
        not isinstance(expected_url, str)
        or normalize_repository_url(actual_url) != normalize_repository_url(expected_url)
    ):
        raise ValueError(f"corpus origin mismatch: expected {expected_url}, got {actual_url}")
    return actual_revision, actual_url


def verify_paper_index(path: Path, registry: Mapping[str, object]) -> str:
    actual = sha256_file(path)
    selection = registry.get("selection")
    if not isinstance(selection, dict):
        raise ValueError("source registry is missing selection metadata")
    expected = selection.get("metadata_sha256")
    if actual != expected:
        raise ValueError(f"paper index hash mismatch: expected {expected}, got {actual}")
    return actual


def selected_cpu_rows(
    paper_index: Path,
    registry: Mapping[str, object],
) -> tuple[list[dict[str, object]], set[str]]:
    selection = registry.get("selection")
    split = registry.get("development_split")
    if not isinstance(selection, dict) or not isinstance(split, dict):
        raise ValueError("source registry is missing selection or split metadata")
    platform = selection.get("platform")
    rows = [row for row in extract_papers(paper_index) if row.get("platform") == platform]
    expected_count = registry.get("cpu_workspace_count")
    if len(rows) != expected_count:
        raise ValueError(
            f"selected workspace count mismatch: expected {expected_count}, got {len(rows)}"
        )
    paths = [row.get("path") for row in rows]
    if not all(isinstance(path, str) for path in paths) or len(set(paths)) != len(paths):
        raise ValueError("paper index contains missing or duplicate selected paths")
    for path in paths:
        pure = PurePosixPath(path)
        if pure.is_absolute() or ".." in pure.parts:
            raise ValueError(f"paper index contains an unsafe workspace path: {path}")

    reserved_raw = split.get("reserved_after_exploratory_inspection")
    lowest_raw = split.get("lowest_hash_paths")
    if not isinstance(reserved_raw, list) or not all(
        isinstance(path, str) for path in reserved_raw
    ):
        raise ValueError("source registry has invalid explicitly reserved paths")
    if not isinstance(lowest_raw, list) or not all(
        isinstance(item, dict) for item in lowest_raw
    ):
        raise ValueError("source registry has invalid lowest-hash split records")
    salt = split.get("salt")
    if not isinstance(salt, str):
        raise ValueError("source registry development salt is missing")
    for item in lowest_raw:
        path = item.get("path")
        expected_hash = item.get("sha256")
        if not isinstance(path, str) or sha256_text(f"{salt}\n{path}") != expected_hash:
            raise ValueError(f"development split hash mismatch for {path}")
    explicit = set(reserved_raw)
    available = [path for path in paths if path not in explicit]
    expected_lowest = [
        path
        for _, path in sorted(
            (sha256_text(f"{salt}\n{path}"), path) for path in available
        )[: len(lowest_raw)]
    ]
    actual_lowest = [str(item["path"]) for item in lowest_raw]
    if actual_lowest != expected_lowest:
        raise ValueError(
            "source registry does not contain the frozen lowest-hash development split"
        )
    reserved = explicit | set(actual_lowest)
    if len(reserved) != split.get("count") or not reserved.issubset(set(paths)):
        raise ValueError("development split count or membership is inconsistent")
    confirmatory_capacity = registry.get("confirmatory_capacity_before_structural_gate")
    if len(rows) - len(reserved) != confirmatory_capacity:
        raise ValueError("confirmatory capacity is inconsistent with the frozen split")
    return rows, reserved


def build_records(
    corpus_root: Path,
    paper_rows: Sequence[Mapping[str, object]],
    reserved: set[str],
    revision: str,
) -> tuple[list[dict[str, object]], dict[str, dict[str, str]]]:
    records: list[dict[str, object]] = []
    replacements: dict[str, dict[str, str]] = {}
    for row in sorted(paper_rows, key=lambda item: str(item["path"])):
        workspace_path = str(row["path"])
        workspace = corpus_root / Path(*PurePosixPath(workspace_path).parts)
        parse_failures: list[dict[str, str]] = []
        candidates: list[Candidate] = []
        python_files = (
            sorted((workspace / "exp").rglob("*.py"))
            if (workspace / "exp").exists()
            else []
        )
        for path in python_files:
            file_candidates, error = scan_python_file(path, workspace)
            candidates.extend(file_candidates)
            if error is not None:
                parse_failures.append(
                    {
                        "file": path.relative_to(workspace).as_posix(),
                        "error": error,
                    }
                )
        candidates.sort(key=lambda item: (item.file, item.line_start, item.column_start))
        paper_path = workspace / "paper.tex"
        numeric_count = manuscript_numeric_count(paper_path)
        workspace_id = sha256_text(f"{revision}\n{workspace_path}")[:16]
        selected = candidates[0] if candidates else None
        mutation: dict[str, object] | None = None
        if selected is not None and paper_path.is_file() and numeric_count:
            mutation, selected_literal = evaluate_mutation(
                workspace,
                paper_path,
                workspace_id,
                selected,
            )
            if selected_literal is not None:
                replacements[workspace_path] = asdict(selected_literal)
        records.append(
            {
                "workspace_id": workspace_id,
                "source_path": workspace_path,
                "split": "development" if workspace_path in reserved else "confirmatory",
                "paper_present": paper_path.is_file(),
                "manuscript_numeric_token_count": numeric_count,
                "python_file_count": len(python_files),
                "python_parse_failure_count": len(parse_failures),
                "parse_failures": parse_failures,
                "candidate_count": len(candidates),
                "selected_candidate": asdict(selected) if selected is not None else None,
                "selected_mutation": mutation,
                "structurally_eligible": bool(
                    paper_path.is_file()
                    and python_files
                    and not parse_failures
                    and selected is not None
                    and numeric_count > 0
                ),
            }
        )
    return records, replacements


def evaluate_manual_audit(
    records: Sequence[Mapping[str, object]],
    audit: Mapping[str, object],
    revision: str,
    source_registry_sha256: str,
) -> tuple[int, int, list[str]]:
    mismatches: list[str] = []
    if (
        audit.get("artifact_kind")
        != "literal_evidence_paths_manual_development_mutation_audit"
    ):
        raise ValueError("manual development audit has the wrong artifact kind")
    if audit.get("corpus_commit") != revision:
        raise ValueError("manual development audit has the wrong corpus commit")
    if audit.get("source_registry_sha256") != source_registry_sha256:
        raise ValueError("manual development audit has the wrong source registry hash")
    audit_records = audit.get("records")
    if not isinstance(audit_records, list) or not all(
        isinstance(item, dict) for item in audit_records
    ):
        raise ValueError("manual development audit records must be an array of objects")
    by_path = {item.get("source_path"): item for item in audit_records}
    if len(by_path) != len(audit_records):
        raise ValueError("manual development audit contains duplicate source paths")

    development = [
        record
        for record in records
        if record.get("split") == "development"
        and isinstance(record.get("selected_candidate"), dict)
        and isinstance(record.get("selected_mutation"), dict)
    ]
    if audit.get("generated_mutation_count") != len(development):
        raise ValueError(
            "manual development audit mutation count does not match the current scan"
        )
    expected_paths = {record.get("source_path") for record in development}
    extra_paths = set(by_path) - expected_paths
    if extra_paths:
        raise ValueError(
            f"manual development audit contains unexpected paths: {sorted(extra_paths)}"
        )
    valid_count = 0
    for record in development:
        source_path = str(record["source_path"])
        item = by_path.get(source_path)
        candidate = record.get("selected_candidate")
        mutation = record.get("selected_mutation")
        if item is None or not isinstance(candidate, dict) or not isinstance(mutation, dict):
            mismatches.append(source_path)
            continue
        replacement = item.get("replacement_literal")
        replacement_source_token = item.get("replacement_source_token")
        checks = item.get("checks")
        identity_matches = (
            item.get("workspace_id") == record.get("workspace_id")
            and item.get("target") == candidate
            and isinstance(replacement, str)
            and sha256_text(replacement) == mutation.get("replacement_literal_sha256")
            and isinstance(replacement_source_token, str)
            and sha256_text(replacement_source_token)
            == mutation.get("replacement_source_token_sha256")
            and item.get("mutated_file_sha256") == mutation.get("mutated_file_sha256")
        )
        checks_pass = (
            isinstance(checks, dict)
            and set(checks) == set(MANUAL_VALIDITY_CHECKS)
            and all(checks.get(name) is True for name in MANUAL_VALIDITY_CHECKS)
        )
        if identity_matches and checks_pass and item.get("valid") is True:
            valid_count += 1
        else:
            mismatches.append(source_path)
    return len(development), valid_count, mismatches


def rate(numerator: int, denominator: int) -> float:
    return numerator / denominator if denominator else 0.0


def summarize_records(
    records: Sequence[Mapping[str, object]],
    audit: Mapping[str, object],
    revision: str,
    source_registry_sha256: str,
) -> dict[str, object]:
    development = [record for record in records if record["split"] == "development"]
    confirmatory = [record for record in records if record["split"] == "confirmatory"]
    python_file_count = sum(int(record["python_file_count"]) for record in records)
    python_parse_failures = sum(
        int(record["python_parse_failure_count"]) for record in records
    )
    mutations = [
        record.get("selected_mutation")
        for record in records
        if record.get("selected_candidate")
    ]
    mutation_attempt_count = len(mutations)
    mutation_parse_success_count = sum(
        isinstance(mutation, dict) and mutation.get("parse_success") is True
        for mutation in mutations
    )
    target_hashes = [
        str(candidate["expression_sha256"])
        for record in records
        if record.get("structurally_eligible")
        for candidate in [record.get("selected_candidate")]
        if isinstance(candidate, dict)
    ]
    duplicate_target_count = sum(
        count - 1 for count in Counter(target_hashes).values() if count > 1
    )
    manual_count, manual_valid, manual_mismatches = evaluate_manual_audit(
        records,
        audit,
        revision,
        source_registry_sha256,
    )
    return {
        "workspace_count": len(records),
        "development_count": len(development),
        "confirmatory_count": len(confirmatory),
        "development_eligible": sum(
            bool(record["structurally_eligible"]) for record in development
        ),
        "confirmatory_eligible": sum(
            bool(record["structurally_eligible"]) for record in confirmatory
        ),
        "python_file_count": python_file_count,
        "python_parse_success_count": python_file_count - python_parse_failures,
        "python_parse_failure_count": python_parse_failures,
        "python_parse_success_rate": rate(
            python_file_count - python_parse_failures,
            python_file_count,
        ),
        "parse_failure_workspaces": sum(
            bool(record["python_parse_failure_count"]) for record in records
        ),
        "mutation_attempt_count": mutation_attempt_count,
        "mutation_parse_success_count": mutation_parse_success_count,
        "mutation_parse_success_rate": rate(
            mutation_parse_success_count,
            mutation_attempt_count,
        ),
        "selected_target_count": len(target_hashes),
        "unique_target_hash_count": len(set(target_hashes)),
        "duplicate_target_count": duplicate_target_count,
        "duplicate_target_hash_rate": rate(
            duplicate_target_count,
            len(target_hashes),
        ),
        "manual_development_audit_count": manual_count,
        "manual_development_valid_count": manual_valid,
        "manual_development_mutation_validity": rate(manual_valid, manual_count),
        "manual_development_audit_mismatches": manual_mismatches,
    }


def evaluate_frozen_gates(
    frozen_gate: Mapping[str, object],
    summary: Mapping[str, object],
) -> dict[str, dict[str, object]]:
    expected_keys = set(FROZEN_NUMERIC_GATES) | {"action_on_failure"}
    if set(frozen_gate) != expected_keys:
        missing = sorted(expected_keys - set(frozen_gate))
        unknown = sorted(set(frozen_gate) - expected_keys)
        raise ValueError(
            f"unsupported frozen gate keys: missing={missing}, unknown={unknown}"
        )
    if frozen_gate.get("action_on_failure") != "KILL":
        raise ValueError("the frozen structural preflight action must be KILL")
    observed = {
        "minimum_confirmatory_workspaces_with_eligible_target": summary[
            "confirmatory_eligible"
        ],
        "minimum_development_workspaces_with_eligible_target": summary[
            "development_eligible"
        ],
        "python_parse_success_rate": summary["python_parse_success_rate"],
        "mutation_parse_success_rate": summary["mutation_parse_success_rate"],
        "maximum_duplicate_target_hash_rate": summary["duplicate_target_hash_rate"],
        "manual_development_mutation_validity": summary[
            "manual_development_mutation_validity"
        ],
    }
    results: dict[str, dict[str, object]] = {}
    for name in FROZEN_NUMERIC_GATES:
        threshold = frozen_gate[name]
        value = observed[name]
        if not isinstance(threshold, (int, float)) or isinstance(threshold, bool):
            raise ValueError(f"frozen gate {name} must be numeric")
        comparator = "<=" if name.startswith("maximum_") else ">="
        passed = value <= threshold if comparator == "<=" else value >= threshold
        results[name] = {
            "observed": value,
            "operator": comparator,
            "threshold": threshold,
            "passed": passed,
        }
    return results


def decision_exit_code(decision: str) -> int:
    return KILL_EXIT_CODE if decision == "KILL" else 0


def write_json(path: Path, value: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def build_termination_receipt(
    contract: Mapping[str, object],
    result: Mapping[str, object],
    result_path: Path,
) -> dict[str, object]:
    if result.get("decision") != "KILL":
        raise ValueError("a termination receipt may only be written for a KILL decision")
    summary = result["summary"]
    failed_gates = result["failed_gates"]
    return {
        "schema_version": 1,
        "artifact_kind": "literal_evidence_paths_termination_decision",
        "study_slug": contract["study_slug"],
        "candidate_id": contract["candidate_id"],
        "decision": "KILL_PREFLIGHT",
        "decided_at": date.today().isoformat(),
        "topic_selected": False,
        "execution_allowed": False,
        "confirmatory_model_calls_completed": 0,
        "contract": {
            "path": CANONICAL_CONTRACT.relative_to(REPOSITORY_ROOT).as_posix(),
            "sha256": result["contract_sha256"],
        },
        "receipt": {
            "path": result_path.resolve()
            .relative_to(REPOSITORY_ROOT.resolve())
            .as_posix(),
            "sha256": sha256_file(result_path),
            "corpus_commit": result["corpus_commit"],
            "source_registry_sha256": result["source_registry_sha256"],
            "manual_development_audit_sha256": result[
                "manual_development_audit_sha256"
            ],
            "paper_index_sha256": result["paper_index_sha256"],
            "scanner_sha256": result["scanner_sha256"],
        },
        "frozen_gate": result["frozen_gate"],
        "gate_results": result["gate_results"],
        "failed_gates": failed_gates,
        "observed_preflight": summary,
        "decision_reason": (
            "The actual frozen corpus failed one or more declared structural preflight "
            "gates before any reviewer output was generated. Every declared gate is "
            "reported in gate_results; no failed threshold is weakened or repaired by "
            "replacing units."
        ),
        "forbidden_revival": [
            "Lowering a frozen structural threshold",
            "Promoting development units into the confirmatory set",
            "Adding sink families after observing eligibility",
            "Adding GPU workspaces to repair the failed CPU-only contract",
            "Treating a structurally incomplete subset as paper-scale evidence",
        ],
        "next_allowed_state": (
            "Return to wide topic search with a different research object or evaluation unit."
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus-root", type=Path, required=True)
    parser.add_argument("--paper-index-html", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--termination-receipt", type=Path)
    return parser.parse_args()


def validate_output_paths(output: Path, termination_receipt: Path | None) -> None:
    if output.resolve() != CANONICAL_RESULT.resolve():
        raise ValueError("structural preflight output must use the canonical study path")
    if (
        termination_receipt is not None
        and termination_receipt.resolve() != CANONICAL_TERMINATION.resolve()
    ):
        raise ValueError("termination receipt must use the canonical study path")


def require_termination_receipt(decision: str, termination_receipt: Path | None) -> None:
    if decision == "KILL" and termination_receipt is None:
        raise ValueError("a KILL decision requires the canonical termination receipt")


def main() -> int:
    args = parse_args()
    validate_output_paths(args.output, args.termination_receipt)
    contract, registry, audit, hashes = load_canonical_configuration()
    actual_revision, actual_url = verify_corpus_checkout(args.corpus_root, registry)
    paper_index_sha256 = verify_paper_index(args.paper_index_html, registry)
    paper_rows, reserved = selected_cpu_rows(args.paper_index_html, registry)
    records, _ = build_records(
        args.corpus_root,
        paper_rows,
        reserved,
        actual_revision,
    )
    summary = summarize_records(
        records,
        audit,
        actual_revision,
        hashes["source_registry_sha256"],
    )
    frozen_gate = contract.get("structural_preflight")
    if not isinstance(frozen_gate, dict):
        raise ValueError("preflight contract is missing structural_preflight")
    gate_results = evaluate_frozen_gates(frozen_gate, summary)
    failed_gates = [
        name for name, result in gate_results.items() if not result["passed"]
    ]
    decision = (
        "PASS_PREFLIGHT"
        if not failed_gates
        else str(frozen_gate["action_on_failure"])
    )
    require_termination_receipt(decision, args.termination_receipt)
    output = {
        "schema_version": 1,
        "artifact_kind": "literal_evidence_paths_structural_preflight",
        "corpus_commit": actual_revision,
        "corpus_repository_url": actual_url,
        "corpus_worktree_clean": True,
        "source_registry_sha256": hashes["source_registry_sha256"],
        "contract_sha256": hashes["contract_sha256"],
        "manual_development_audit_sha256": hashes["manual_audit_sha256"],
        "scanner_sha256": sha256_file(Path(__file__).resolve()),
        "paper_index_sha256": paper_index_sha256,
        "structural_outcomes_observed": True,
        "confirmatory_model_outcomes_observed": False,
        "decision": decision,
        "frozen_gate": dict(frozen_gate),
        "gate_results": gate_results,
        "failed_gates": failed_gates,
        "summary": summary,
        "records": records,
    }
    write_json(args.output, output)
    if decision == "KILL" and args.termination_receipt is not None:
        receipt = build_termination_receipt(contract, output, args.output)
        write_json(args.termination_receipt, receipt)
    print(
        json.dumps(
            {"decision": decision, "failed_gates": failed_gates, **summary},
            sort_keys=True,
        )
    )
    return decision_exit_code(decision)


if __name__ == "__main__":
    raise SystemExit(main())
