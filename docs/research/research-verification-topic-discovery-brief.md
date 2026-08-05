# Research Brief

## Research Mode

`topic_discovery`

## Topic

Search for a workshop-scale empirical question about verification and completion decisions in AI-assisted scientific research. Compare independent candidate families rather than assuming a preferred topic survives: open-ended literature-discovery completion, scientific-review independence and fault detection, and research-artifact or workflow-gate integrity. The selected study must test a scientific capability on public external tasks; AutoLabOS may govern the study but cannot be its only empirical object.

## Scientific Scope

### Scientific Object

- agent workflow verification

### Empirical Problems

- literature retrieval stopping and coverage calibration
- reviewer defect localization under provenance diversity
- workflow gate sensitivity to cross-artifact inconsistency
- prior-work subsumption detection under incomplete retrieval

### Scientific Relations

- retrieval saturation versus gold-set coverage
- provenance diversity versus defect recall and false positives
- gate strictness versus mutation detection and false blocking
- evidence depth versus false novelty and over-abstention

### Prior-Work Probes

- AutoResearchBench wide research and open-ended literature discovery
- evidence-aware termination and stopping criteria for deep-research agents
- automatic reviewers under counterfactual faulty reasoning
- PaperAudit-Bench, SciReview, and reviewer monoculture or diversity-collapse studies
- Agent-Native Research Artifacts and its mutation benchmark
- DeployBench completion-judgment failures, CORE-Bench, and Artisan-Bench
- harness safety, harness evolution, and scientific-agent benchmark suites
- literature-grounded scientific novelty assessment and its judge reliability limits

### Admissibility Constraints

- every candidate must use a public, research-compatible task or dataset with an auditable version and externally defined target labels or verifiers
- no candidate may require new expert annotation as a prerequisite for the bounded probe
- a candidate already matched by a closest prior on problem, intervention, evaluation unit, metric, and evidence regime must be killed rather than cosmetically reframed
- the selected primary endpoint must be computable without an LLM judge, or independently validated against public human or deterministic gold
- the bounded probe must run on this machine using CPU, available local GPUs, or a predeclared small real-provider budget

### Publication Goals

- a falsifiable 4-page workshop contribution with a strong comparator, paired or clustered uncertainty, failure analysis, and an explicit evidence ceiling

### Exclusions

- a generic benchmark survey, a system-description paper, a prompt-only demo, and AutoLabOS itself as the only empirical object
- new foundation-model training, proprietary datasets, hidden private labels, or conclusions supported only by model self-evaluation
- reviving any previously killed relation-serialization, generic evaluator-replacement, or artifact-obligation study without a demonstrably different research question and evaluation regime

## Objective Metric

- Primary topic-selection metric: pass/fail on every hard gate, followed by the governed candidate scorecard over closest-prior non-overlap, evaluation validity, baseline strength, local feasibility, failure information value, reproducibility, and workshop fit.
- Candidate metrics must be numeric and task-grounded. Preferred primary endpoints include risk-coverage or premature-stop error for literature completion, defect-level recall at a prespecified false-positive ceiling for review, and mutation kill rate at a prespecified false-block ceiling for workflow gates.
- Meaningful improvement must be frozen per candidate before execution. Aggregate topic scores cannot compensate for prior-work absorption, invalid denominators, missing labels, or an infeasible comparator.

## Constraints

- Use public data with an explicit research-compatible license and a pinned release, commit, or immutable snapshot.
- Keep the bounded probe within 2 aggregate GPU-hours, 150 real-provider calls, 20 wall-clock hours, 20 GB of new downloads, and an estimated provider cost ceiling of USD 25.
- Do not execute a paid-provider probe if the preflight estimate exceeds the ceiling; revise or kill the candidate first.
- Keep a confirmatory study within 12 aggregate GPU-hours, 600 real-provider calls, 60 wall-clock hours, 60 GB of new downloads, and an estimated provider cost ceiling of USD 100.
- Machine-readable compute ceiling: `{"bounded_probe":{"max_gpu_hours":2,"max_provider_calls":150,"max_wall_clock_hours":20,"max_download_gb":20,"max_estimated_provider_cost_usd":25},"confirmatory":{"max_gpu_hours":12,"max_provider_calls":600,"max_wall_clock_hours":60,"max_download_gb":60,"max_estimated_provider_cost_usd":100}}`
- Prefer released traces, deterministic retrieval/evaluation code, or reproducible open models where they answer the research question. A real provider may be used only when its exact model snapshot, parameters, prompts, tool trace, token usage, and cost are logged.
- `codex_mock`, normal Codex assistance, deterministic smoke fixtures, and AutoLabOS-generated self-scores are development evidence only and cannot support paper claims.
- Freeze the task sample, exclusions, intervention conditions, primary endpoint, practical-effect boundary, statistical test, retries, and kill criteria before aggregate outcomes are opened.
- Do not silently replace failed tasks, alter denominators after outcomes, or promote a topic because a secondary metric looks favorable.

## Plan

1. Collect current primary literature from at least three independent clusters in the declared scientific scope.
2. Build an opportunity ledger that separates already-absorbed questions from unresolved, externally testable failure modes.
3. Generate 5-7 candidates across at least three independent families. Each candidate must identify two closest full-text priors, exact non-overlap, a reviewer-absorption objection, public task units, strongest feasible comparator, deterministic or validated endpoint, cost estimate, and falsifier.
4. Run independent adversarial reviews for novelty, task validity, statistics, systems feasibility, and workshop fit. Consensus is not evidence, and reviewer provenance must remain inspectable.
5. Rank no more than three finalists. Select none if every finalist fails a hard gate.
6. For the leading survivor, inspect the public repository, license, task denominator, evaluator, and a small raw sample before freezing a bounded-probe protocol.
7. Execute exactly one frozen bounded probe with real external task units. Promote, revise, or kill it using the frozen decision rule.
8. Run a confirmatory study only after promotion, with repeated or paired uncertainty analysis, at least one robustness check, and defect- or task-level error analysis.
9. Draft only after the review gate confirms a quantitative comparator table, claim-to-evidence mapping, real execution receipts, and a reproducibility handoff.

## Manuscript Format

- columns: 2
- main_body_pages: 4
- references_excluded_from_page_limit: true
- appendices_excluded_from_page_limit: true

## Appendix Preferences

Prefer appendix for:
- full_candidate_scorecard
- search_queries_and_source_ledger
- full_prompts_or_policies
- environment_and_cost_receipts
- per_task_results
- robustness_and_sensitivity_checks

Keep in main body:
- research_question
- strongest_baseline
- primary_result_table
- central_failure_analysis
- claim_ceiling

## Research Question

Which unresolved verification or completion failure in AI-assisted scientific research admits the strongest externally grounded, locally executable comparison after current closest-prior work is treated as an absorption test rather than as motivation alone?

## Why This Can Be Tested With A Small Real Experiment

Recent public benchmarks expose externally defined task sets, gold paper sets, injected scientific errors, reproduction targets, or executable artifact checks. A bounded probe can therefore compare a small number of frozen decision policies on paired task units without training a foundation model. The probe is only a topic-selection instrument; paper-scale claims require confirmatory evidence and uncertainty analysis.

## Baseline / Comparator

Every candidate must bind its strongest feasible comparator before promotion. Candidate-appropriate baselines include:

- fixed-budget literature search and the original AutoResearchBench evaluation protocol for search-completion candidates
- single-reviewer, repeated-same-reviewer, and same-budget aggregation baselines for reviewer-independence candidates
- the original artifact compiler/auditor, schema-only checks, and task-specific hidden verification for workflow-gate candidates
- retrieval-plus-LLM novelty assessment and judge-only novelty scoring for prior-subsumption candidates

A weak prompt baseline cannot be the only comparator when released code or a stronger published method is executable.

## Dataset / Task / Bench

Candidate data sources to verify, not assume admissible:

- AutoResearchBench Wide Research tasks and its public evaluator
- public counterfactual faulty-reasoning, PaperAudit-Bench, or SciReview task units
- public Agent-Native Research Artifact mutation tasks or independently licensed research-artifact checks
- public scientific novelty-assessment datasets with source-paper evidence and human or deterministic labels

The selected dataset must pass license, snapshot, denominator, leakage, evaluator, and raw-sample audits before protocol freeze.

## Target Comparison

The selected study must compare equal-budget conditions on the same frozen task units. It must distinguish outcome quality from completion confidence, nominal multiplicity from substantive reviewer diversity, or schema validity from scientific validity, depending on the selected candidate. All task exclusions and failed executions remain visible in the denominator.

## Minimum Acceptable Evidence

- at least two verified full-text closest priors and an explicit non-overlap matrix
- at least 24 independent task units in the bounded probe unless the public benchmark defines a smaller complete census
- at least 50 independent task units or a complete public census in the confirmatory study
- at least one strong executable comparator under the same budget
- paired or cluster-aware uncertainty intervals for every headline contrast
- a prespecified practical-effect or decision boundary, not only statistical significance
- a quantitative result table plus task-level error analysis
- exact run configuration, provider/model snapshot where applicable, prompts or policies, raw outputs, evaluator version, token/runtime/cost receipts, and failed-run disclosure

## Disallowed Shortcuts

- treating workflow completion, PDF creation, multi-agent agreement, or reviewer fluency as research evidence
- selecting a topic before closest-prior full-text review
- using abstract-only evidence for a non-overlap claim when full text is accessible
- using model judges as both treatment and sole outcome evaluator
- changing the task sample, metric, or kill threshold after aggregate outcomes are observed
- reporting only successful runs or silently retrying until a preferred result appears
- presenting a provider-specific result as a general law of research agents

## Allowed Budgeted Passes

- broad collection: up to 2 passes
- candidate generation: up to 2 passes, 5-7 candidates per pass
- closest-prior challenge: up to 2 passes per finalist
- independent candidate review: 2 parallel reviews plus 1 meta-review
- bounded probe: 1 frozen primary execution plus 1 declared infrastructure-only retry when no outcome was produced
- confirmatory study: 1 frozen execution plus only prespecified missing-run recovery
- manuscript review: 2 independent reviews plus 1 meta-review, followed by at most 2 bounded revision cycles

## Paper Ceiling If Evidence Remains Weak

If no candidate passes all hard gates, output a `topic_discovery_no_pass` decision and do not draft a paper. If only the bounded probe passes, classify the result as `paper_scale_candidate` or `research_memo`. If confirmatory task count, uncertainty, comparator, or external validity remains inadequate, cap the artifact at a workshop position or preliminary note and state the missing evidence explicitly.

## Minimum Experiment Plan

1. Verify task license, immutable snapshot, denominator, evaluator, and raw examples.
2. Freeze one primary endpoint, one practical-effect boundary, one comparator family, and one kill rule.
3. Run a small infrastructure canary that cannot inspect aggregate treatment outcomes.
4. Execute all frozen conditions on the same task units with complete attempt logs.
5. Compute paired outcomes, uncertainty intervals, cost, and failure taxonomy.
6. Apply the frozen promote/revise/kill decision without metric shopping.
7. If promoted, expand to confirmatory task units or an external task family and run the prespecified robustness check.

## Paper-worthiness Gate

The study may enter `write_paper` only when all of the following are true:

- closest-prior non-overlap survives independent full-text challenge
- the public dataset and evaluator audits pass
- a real bounded probe passes its frozen promotion rule
- confirmatory evidence meets the minimum task count or complete-census rule
- the strongest comparator is executed under an equal or explicitly normalized budget
- headline effects include paired or clustered uncertainty and practical magnitude
- claims map to raw evidence and remain below the declared evidence ceiling
- independent review and meta-review find no unresolved fatal methodology or reproducibility issue

## Failure Conditions

- a closest prior matches the candidate on problem, intervention, evaluation unit, metric, and evidence regime
- the task license, snapshot, denominator, or gold/evaluator provenance cannot be verified
- the strongest feasible comparator cannot run within the declared budget
- fewer than 24 independent probe units remain after prespecified exclusions without a complete-census justification
- the primary endpoint requires an unvalidated model judge
- the provider-cost or compute preflight exceeds the frozen ceiling
- the bounded probe misses its practical-effect boundary or reveals an invalid measurement contract
- reviewer provenance is not independent or inspectable where independence is part of the claim
- confirmatory evidence fails the task-count, uncertainty, robustness, or reproducibility gate
