# Exploration Strategy Review

This note documents the P1 design position for StagePolicies, ExplorationManager automation, rapid iteration, baseline-first support, and HITL modes.

It is a design review, not evidence that long-run autonomous exploration has already been achieved.

## Contract

AutoLabOS keeps the governed top-level workflow fixed:

`collect_papers -> analyze_papers -> generate_hypotheses -> design_experiments -> implement_experiments -> run_experiments -> analyze_results -> figure_audit -> review -> write_paper`

Exploration is node-internal coordination under that workflow. It must not add, remove, reorder, or redefine top-level nodes unless `docs/architecture.md` is explicitly updated and validation expectations are changed.

## Stage Policy Position

`src/core/exploration/stagePolicies.ts` defines the current exploration stages:

- `feasibility`
- `baseline_hardening`
- `main_agenda`
- `ablation`

The stages are allowed to evolve only as auditable policies. A future StagePolicy change must preserve:

- deterministic transition reasons
- budget ceilings
- rollback and stop conditions
- reproducibility minimums
- baseline discipline
- artifact-backed stage decisions

No stage policy may silently weaken review, claim ceiling, result table, or baseline/comparator requirements.

## ExplorationManager Automation

`ExplorationManager` is an internal coordinator for bounded branch search. It may propose, block, complete, and resume exploration-tree nodes, but it remains subordinate to the governed node currently executing.

Automation must remain bounded by:

- `max_nodes_per_stage`
- `max_children_per_node`
- `max_tree_depth`
- stage-specific budgets
- failure-memory subtree blocking
- `BaselineLock`
- `SingleChangeEnforcer`

If automation cannot prove a branch is executed and reproducible, it may keep operational state but must not promote that branch as paper evidence.

## Current Gaps Before Further Automation

The current exploration implementation is intentionally conservative, but the following gaps must be closed before claiming autonomous exploration maturity:

- The manager currently initializes at `baseline_hardening`; a future feasibility-to-baseline proposal lifecycle needs an explicit contract.
- Stage transitions are policy-like but do not yet declare typed automation levels, HITL requirements, stage ownership, or brief-derived evidence floors.
- Stage decision recording must clearly distinguish the current stage, the decided stage, and the next stage before policy evolution is expanded.
- The first executed branch may become the provisional `best_defensible_branch_id`; future promotion should route through strongest-defensible scoring before that state is treated as research evidence.
- Baseline lock creation and baseline candidate generation need a clear handoff contract from design artifacts to execution artifacts.
- Meta-harness support is currently prompt-improvement oriented and should not be described as autonomous stage-policy evolution.

## Baseline-First Support

Baseline-first support is mandatory before comparative claims.

The baseline-first path must preserve:

- a stable baseline lock
- dataset slice identity
- evaluator identity
- seed policy
- a single changed intervention dimension per branch
- explicit baseline/comparator rows in result artifacts
- downgrade behavior when baseline evidence is missing

`baseline_comparison.json` is an output projection. It exposes comparison and enforcement state, but it is not the enforcement mechanism. Enforcement remains in the baseline lock, single-change checks, result-table validation, analysis governance, review, and claim ceilings.

## Rapid Iteration

Rapid iteration is allowed only inside bounded node responsibilities. It should produce short feedback cycles without skipping the evidence gates.

Acceptable rapid iteration:

- repair a runner before `run_experiments` handoff
- rerun a bounded branch after a concrete failure reason
- backtrack from review to design or implementation with a recorded transition
- use cached or existing artifacts only when provenance and command drift checks pass

Unacceptable rapid iteration:

- treating smoke output as paper-scale evidence
- repeatedly retrying equivalent failures without a changed cause
- changing multiple experimental dimensions while claiming a clean comparison
- bypassing review because a result looks promising

## HITL Modes

Human review is a gate, not a decorative approval label.

Supported modes should remain explicit:

- manual: pause at approval boundaries
- minimal: auto-approve only when existing policy permits
- hybrid: auto-apply only strongly supported, executable recommendations

Any future HITL mode must specify:

- which transitions can be auto-applied
- which artifacts the operator must inspect
- how manual overrides are recorded
- how approval decisions survive resume/reload
- when the system must pause rather than continue

Proposed HITL vocabulary for future implementation:

- advisory: system suggests, operator acts manually
- approval_required: system pauses until explicit approval
- autonomous_with_audit: system may act under policy and records artifacts
- manual_block: system must stop until a human changes the evidence, configuration, or policy context

## Implementation Readiness

Before implementing the next exploration automation expansion, require:

- tests for stage transition decisions
- tests for baseline lock and single-change blocking
- artifact examples for promoted, blocked, and rolled-back branches
- review coverage showing weak evidence cannot advance to `write_paper`
- documentation of any new operator command or approval state
