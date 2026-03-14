# Experiment and Result Quality Bar

This file defines structural quality gates for experiment/run/result artifacts.

## 1) Scope

Applies to:

- `run_experiments`
- `analyze_results`
- `review`

Checks are deterministic and artifact-driven.

## 2) Required artifact expectations

### A. `run_experiments` success expectations

When execution is recorded as successful (for example verifier status `pass`):

- `metrics.json` must exist and be parseable as an object.
- `objective_evaluation.json` should exist.

### B. `analyze_results` success expectations

When `analyze_results` is completed:

- `result_analysis.json` must exist.
- Objective evaluation evidence must exist (`objective_evaluation.json`).
- Transition/result artifacts should exist (`transition_recommendation.json`).

### C. `review` output expectations

When `review` is completed:

- `review/review_packet.json` must exist and contain core sections.
- `review/decision.json` and `review/revision_plan.json` must exist when review packet decisioning is present.

## 3) Why this bar exists

These artifacts are handoff boundaries between nodes. Missing structure here causes ambiguous runtime state, weak operator trust, and brittle paper-stage behavior.

## 4) Intended strictness

- Strict on structural presence and non-empty required fields.
- Conservative on semantic quality (no heavy heuristic scoring in this layer).
