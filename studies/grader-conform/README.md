# GraderConform Study

This directory contains the study-specific, reproducible material for a
historical evaluation-pipeline conformance experiment. It is deliberately
separate from AutoLabOS runtime code.

The study asks whether a small registry of semantic conformance relations can
detect historical implementation defects in public agent-evaluation pipelines.
Repository names, commit pins, and fault descriptions live in data files, not
in reusable runtime or test logic.

## Current Stage

- Topic status: blinded confirmatory corpus build
- Scientific outcomes observed: bounded development only
- Paper-scale claims authorized: no
- Candidate lineage registry: `corpus/lineages.v1.json`
- Preregistration: `../../docs/research/grader-conform-probe-preregistration-v1.json`
- Development decision: `../../docs/research/grader-conform-bounded-development-decision-v1.json`
- Frozen relation templates: `method/relation-templates.v1.json`
- Three-replay summary: `results/bounded-development-summary.v1.json`
- Native-test static census: `results/native-test-static-census.v1.json`
- Structural census command:

```bash
node studies/grader-conform/scripts/audit-corpus.mjs \
  --registry studies/grader-conform/corpus/lineages.v1.json \
  --repo-root /path/to/read-only/repository-cache \
  --output /path/to/census-structural.json
```

The repository cache is an execution input and is never embedded in published
artifacts. The audit output records commit and diff hashes so a later run can
prove which source state it inspected.

The development set contains 14 pre-adjudicated lineages from three
repositories. All 14 parent/fix pairs reproduced over three runs with no fixed
control failure. Eleven concrete probes were implemented after the initial
three outcomes, so this result measures development-set fit rather than
generalization. Held-out lineages remain required for any paper claim.

## Evidence Boundary

An explicit upstream fix is candidate evidence, not proof that the proposed
method detects the defect. A lineage counts in the primary result only when:

1. the parent revision exhibits the registered conformance failure;
2. the fixed revision removes that failure;
3. the probe uses the same relation definition on both revisions; and
4. the lineage passes the preregistered implementation-defect and independence
   checks.

Task annotation changes, intended contract changes, and model-output quality
failures are excluded from the primary corpus.
