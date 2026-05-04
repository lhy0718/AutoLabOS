# External Benchmark Plan

This plan defines measurement targets for external evaluation. It does not report achieved benchmark performance.

## Purpose

External benchmarks should test whether AutoLabOS governance improves research-run reliability, artifact completeness, claim discipline, and repairability without inflating weak evidence into paper-ready outputs.

## Candidate Benchmark Families

Candidate external benchmark targets:

- AGB-001 through AGB-010 as governed benchmark seeds and task manifests
- governed research-run suites with missing-baseline and weak-evidence traps
- controlled paper-readiness tasks with known artifact requirements
- code-and-experiment repair tasks that require runnable outputs
- long-run checkpoint/resume tasks
- review-gated writing tasks where unsupported claims must be downgraded
- artifact-bundle export tasks requiring public/private traceability

Any imported benchmark must be mapped to the fixed workflow and must not require bypassing review gates.

## Conditions

Each benchmark should define conditions such as:

- gated default
- no review gate
- no claim ceiling
- no figure audit
- no baseline lock
- no single-change enforcement

Ablations must affect benchmark/evaluation mode only. Production defaults must remain governed.

## Metrics

Primary measurement targets:

- false paper-ready rate
- unsupported claim count
- claim-to-evidence coverage
- missing-baseline pass rate
- result-table completeness
- figure/result mismatch rate
- checkpoint/resume recovery rate
- policy-blocked action handling
- public bundle traceability
- time and attempts to reach a defensible stop condition

Secondary measurement targets:

- operator intervention count
- repair success rate
- reproducibility artifact completeness
- benchmark task cost and wall time

## Required Artifacts

Each benchmark run should preserve:

- seed or task input
- condition config
- run events
- checkpoints
- required node artifacts
- result table
- baseline comparison surface when applicable
- review artifacts
- paper-readiness or downgrade decision
- scoring output
- public bundle manifest

## Reporting Rules

Benchmark reports must distinguish:

- planned benchmark
- dry-run replay
- live run
- partial live run
- failed run
- achieved measured result

Never report placeholder values, fixture values, or dry-run expectations as measured performance.

Dry-run and demo scores are governance validation signals. They are not scientific benchmark results unless backed by executed task artifacts, preserved run traces, and scored outputs.

## Acceptance Bar

A benchmark result is reportable only when:

- the run condition is explicit
- the task input is preserved
- the artifact set is complete enough for inspection
- scores are computed from artifacts, not hand-entered claims
- limitations are stated
- failures are included rather than hidden
