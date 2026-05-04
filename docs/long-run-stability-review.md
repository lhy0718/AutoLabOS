# Long-Run Stability Review

This design note defines the stability expectations for long-running AutoLabOS workflows. It is not evidence that month-long autonomous execution has already been completed.

## Stability Goals

Long-running operation should preserve:

- resumable workflow state
- checkpoint consistency
- event traceability
- bounded retries
- human-review pauses
- budget and policy stops
- artifact completeness
- claim ceilings after resume

## Required State Surfaces

Long-run validation should inspect:

- `.autolabos/runs/<run-id>/run_record.json`
- `.autolabos/runs/runs.json`
- optional `.autolabos/runs/runs.sqlite`
- `.autolabos/runs/<run-id>/events.jsonl`
- checkpoint records
- run context memory
- node-owned artifacts
- public output manifests
- stage routing artifacts when a pause/failure occurs

## Failure Classes

Long-run review should explicitly classify:

- stale checkpoint resume
- checkpoint write failure
- timeout partial
- repeated equivalent failure
- budget exhaustion
- policy-blocked external action
- missing artifact after resume
- public/run artifact divergence
- approval-state mismatch

## Pause And Retry Rules

The system should pause rather than continue when:

- checkpoint persistence is unsafe
- human approval is required
- a failure repeats without changed cause
- a result would weaken evidence discipline
- a public output cannot be traced to run artifacts

Retries should be safe, bounded, and tied to a changed failure hypothesis.

## Monitoring Without Overclaiming

Low-cost monitoring may summarize:

- current node and status
- last checkpoint
- last event
- pending transition
- artifact completeness
- last failure class
- budget use

Monitoring must not mark research complete or paper-ready. It is an operational health surface only.

## Validation Plan

Before claiming long-run stability:

1. Run a multi-session workflow with at least one intentional pause.
2. Restart the process and resume from the persisted state.
3. Verify run index, checkpoint, event, and artifact consistency.
4. Verify public bundle traceability.
5. Verify review and paper-readiness gates still apply after resume.
6. Record failures in `ISSUES.md` when live behavior diverges.

