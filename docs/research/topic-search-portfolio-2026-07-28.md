# Research Topic Search Portfolio: Adversarial Refresh

## Controller State

- Search date: 2026-07-28
- Topic selected: `false`
- Probe authorization: `narrow_discovery_only`
- Paper ready: `false`
- Target: a focused archival workshop paper that can be executed locally
- Completion rule: no candidate is selected by literature score or agent consensus; a frozen local probe must pass
- Historical artifacts: quarantined unless explicitly re-admitted below
- Multi-agent consensus is evidence: `false`

The refresh treats every prior topic and every implemented AutoLabOS feature as
a hypothesis. A candidate survives only if it has a source-native unit, a
strong comparator, a deterministic or auditable outcome, a bounded local
execution path, and a useful result even if the main hypothesis fails.

## New Closest-Prior Pressure

Recent work sharply narrows benchmark-auditing claims:

| Work | Primary source | What it absorbs |
|---|---|---|
| Task Verification Bench | https://openreview.net/pdf?id=QdDcI0Ftvo | Version-diff ground truth and LLM detection of benchmark defects |
| Auto Benchmark Audit | https://arxiv.org/abs/2605.26079 | Generic agentic auditing across heterogeneous benchmark artifacts |
| BenchGuard | https://arxiv.org/abs/2604.24955 | Frontier-model auditing of task-oriented evaluation infrastructure |
| BenchJack | https://arxiv.org/abs/2605.12673 | Exploitability and reward-hacking audits across agent benchmarks |
| STING | https://arxiv.org/abs/2604.01518 | Semantically altered ground-truth patches and test augmentation |
| EvalPlus | https://arxiv.org/abs/2305.01210 | Test augmentation for code-generation evaluation |
| Semantic-Preserving Transformations as Mutation Operators | https://arxiv.org/abs/2503.23448 | Generic semantic-preserving mutation and its oracle-validity risks |
| Auto Benchmark Audit artifact | https://github.com/IsThatYou/autobenchaudit | Public benchmark-audit implementation and annotations |

Therefore, “find benchmark bugs with an LLM,” “mine benchmark updates,” and
“add more tests” are not available contributions. The only newly admitted route
is a deterministic evaluator-conformance method whose empirical object is an
implementation fault in the evaluation pipeline, not a task defect.

## Current Portfolio

| Candidate | Cluster | Source-native unit | Strongest comparator | Local feasibility | Current decision |
|---|---|---|---|---|---|
| `grader_conform` | evaluator implementation assurance | author-acknowledged parent/fix commit lineage | parent-native tests and equal-budget untyped perturbation | high; CPU-first | conditional bounded probe |
| `artifact_revision_closure` | scientific revision verification | licensed review obligation plus execution receipt | paper-only, trace-only, and diff-only review | medium | source/license audit |
| `counterevidence_revision` | scientific belief revision | frozen analysis plus counterevidence packet | unconstrained revision and no-counterevidence control | medium | reserve |
| `research_run_integrity` | reproducibility diagnostics | pinned run and selectively replayed claim path | full rerun and artifact-only audit | medium | reserve |
| `executable_idea_utility` | topic-selection evaluation | source-grounded idea plus bounded execution outcome | novelty-only and feasibility-only ranking | low to medium | source audit |

The portfolio preserves five candidates across four clusters. Narrowing is
provisional because `grader_conform` still has to pass novelty review, semantic
lineage adjudication, and behavioral replay.

## Candidate Under Probe: `grader_conform`

### Question

Can a small, preregistered set of semantic conformance relations detect
historical deterministic implementation defects in public agent-evaluation
pipelines that their pre-fix native tests did not expose?

### Non-Overlap Claim

The proposed contribution is not benchmark defect discovery by an LLM and it
does not transform grader source. It is an executable conformance layer that
transforms graded artifacts, responses, traces, terminal states, or invocation
context and checks evaluator invariants such as
live-versus-replay equivalence, harmless representation changes, benign-action
invariance, entry-point parity, adapter symmetry, and sequential state
isolation. Its ground truth is a parent/fix behavior pair from official source
history.

### Reviewer-Absorption Objection

A collection of hand-written regression tests is not a method. The candidate
is killed unless relation definitions are reusable across lineages, applied
unchanged to parent and fixed revisions, and evaluated against parent-native
tests plus an equal-budget perturbation baseline. Retrospective probes that
encode the fix diff are inadmissible.

### Feasibility Census Before Outcomes

The frozen registry contains 16 candidates from three licensed public
repositories. A pre-outcome semantic adjudication admits 14 and excludes two
model-facing preprocessing changes:

- six trajectory, reward, database, and replay lineages from tau2-bench;
- six execution checker, type, parser, and adapter lineages from BFCL;
- four context, scroll-state, process-state, and fallback lineages from OSWorld.

These are candidates, not positive outcomes. The structural registry is
`studies/grader-conform/corpus/lineages.v1.json`; the frozen decision rules are
`docs/research/grader-conform-probe-preregistration-v1.json`; the semantic
adjudication is `studies/grader-conform/corpus/semantic-adjudication.v1.json`.

### Probe Gate

The bounded discovery probe passes only if at least 12 independent lineages from all
three repositories remain reproducible and at least three defects missed by
parent-native tests are detected across at least two repositories, with no
false alarm on the paired fixed revisions. Otherwise the candidate is killed
and the controller advances to another cluster. Passing this gate authorizes
only expansion to at least 36 independent lineages from five repositories,
including 24 held-out lineages; it does not authorize a manuscript claim.

## Scorecard

Scores use a 1-5 scale and do not authorize execution by themselves.

| Candidate | Importance | Non-overlap | Falsifiability | Baseline | Evaluation validity | Realism | Local feasibility | Null-result value | Workshop fit | Reproducibility | Decision |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `grader_conform` | 4 | 3 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | Conditional probe |
| `artifact_revision_closure` | 4 | 3 | 4 | 5 | 3 | 4 | 3 | 5 | 4 | 3 | Audit |
| `counterevidence_revision` | 4 | 3 | 4 | 4 | 3 | 4 | 4 | 4 | 4 | 4 | Reserve |
| `research_run_integrity` | 4 | 3 | 4 | 5 | 3 | 5 | 4 | 4 | 4 | 4 | Reserve |
| `executable_idea_utility` | 3 | 3 | 3 | 4 | 2 | 3 | 4 | 4 | 3 | 3 | Audit |

`grader_conform` leads on executable falsifiability and local cost, not on
proven novelty. The novelty score remains deliberately limited until the
independent closest-prior review closes.

## Next Allowed State

1. Run the structural census over read-only official repository clones.
2. Independently adjudicate implementation-defect eligibility and duplicate
   root causes without viewing probe outcomes.
3. Freeze executable relation adapters and baseline budgets.
4. Run parent/fixed pairs and native parent tests.
5. Apply the preregistered pass/kill rule.

No manuscript claim, topic selection, or paper-readiness promotion is allowed
before step 5.
