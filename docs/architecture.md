# Architecture (Harness-Focused)

This document captures the runtime contracts that must remain stable while improving quality enforcement.

## 1) Fixed workflow contract

AutoLabOS runs a fixed 9-node research workflow:

`collect_papers -> analyze_papers -> generate_hypotheses -> design_experiments -> implement_experiments -> run_experiments -> analyze_results -> review -> write_paper`

Do not add, remove, or reorder top-level nodes without an explicit contract change.

## 2) Shared runtime surfaces

- TUI (`autolabos`) and local web ops UI (`autolabos web`) share the same interaction/runtime layer.
- Node execution and transitions are controlled by `StateGraphRuntime`.
- Approval mode and transition recommendation behavior are part of runtime contracts.

Harness work must preserve both TUI and web behaviors unless a change is explicitly requested.

## 3) Artifact model

- Run-scoped source of truth: `.autolabos/runs/<run_id>/...`
- Public mirrored outputs: `outputs/<run-title>-<run_id_prefix>/...`
- Checkpoints and run context are persisted under each run directory.

Quality checks should be deterministic and file-based whenever possible.

## 4) Node-internal loops are bounded

Internal control loops inside nodes (for example analyze/design/run/analyze/write) are allowed and expected, but they must remain bounded and auditable through artifacts/logs.

## 5) Harness engineering goals

- Turn important quality assumptions into explicit checks.
- Keep checks cheap enough for routine CI.
- Fail early on structural incompleteness (missing required artifacts, malformed records).
- Keep enforcement incremental and compatible with current contracts.

## 6) Non-goals for this track

- No redesign of product UX.
- No broad refactor of orchestration/runtime.
- No speculative replacement of existing node logic.
