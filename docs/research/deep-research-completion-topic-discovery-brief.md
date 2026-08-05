# Research Brief

## Research Mode

`topic_discovery`

## Topic

Search for a workshop-scale empirical question about whether deep research agents know when an open-ended search is complete enough to support a conclusion. Explore calibrated completion, premature stopping, query-path stability, and cost-aware coverage without assuming that any proposed stopping rule improves retrieval.

## Scientific Scope

### Scientific Object

- web search agents

### Empirical Problems

- search behavior and failure modes
- retrieval strategy and answer quality
- query planning and tool use
- benchmark evaluation and reproducibility

### Scientific Relations

- search depth versus relevant-source recall
- tool-call budget versus answer quality
- query reformulation versus source diversity
- search trajectory versus failure mode

### Prior-Work Probes

- AutoResearchBench Wide Research and its unknown-size target sets
- evidence-aware termination in scalable enterprise deep research
- process and outcome evaluation in MiroEval
- retrieval coverage in DeepResearch Bench and ReportBench
- stopping, abstention, and uncertainty control in tool-using agents
- recall estimation and stopping rules in systematic literature review

### Admissibility Constraints

- candidates must use public task units with externally defined relevant-paper sets or another auditable coverage denominator
- the primary endpoint must be deterministic and cannot depend on an LLM judge
- no new expert annotation may be required for the bounded probe
- agent executions, search traces, retrieved identifiers, stopping signals, token usage, and cost must be preserved
- candidates fully absorbed by an existing termination method and evaluation regime must be killed

### Publication Goals

- a falsifiable 4-page workshop contribution about completion reliability in deep research agents

### Exclusions

- generic report-quality scoring, citation faithfulness alone, proprietary task sets, new foundation-model training, or AutoLabOS as the only empirical object

## Objective Metric

- Primary topic-selection metric: pass/fail on closest-prior non-overlap, public denominator validity, strong comparator availability, local execution feasibility, and deterministic evaluation, followed by the governed candidate scorecard.
- Preferred study endpoints: risk-coverage error, premature-stop rate at a prespecified recall floor, calibration error between predicted and achieved coverage, or cost needed to reach a fixed recall target.
- Every candidate must freeze one numeric primary endpoint, optimization direction, and practical-effect boundary before execution. Secondary metrics cannot rescue a failed primary gate.

## Constraints

- Use public data under an explicit research-compatible license and pin the dataset and evaluator revision.
- Keep the bounded probe within 2 aggregate GPU-hours, 120 real-provider calls, 16 wall-clock hours, 20 GB of downloads, and an estimated provider cost ceiling of USD 25.
- Keep the confirmatory study within 8 aggregate GPU-hours, 480 real-provider calls, 48 wall-clock hours, 50 GB of downloads, and an estimated provider cost ceiling of USD 100.
- Machine-readable compute ceiling: `{"bounded_probe":{"max_gpu_hours":2,"max_provider_calls":120,"max_wall_clock_hours":16,"max_download_gb":20,"max_estimated_provider_cost_usd":25},"confirmatory":{"max_gpu_hours":8,"max_provider_calls":480,"max_wall_clock_hours":48,"max_download_gb":50,"max_estimated_provider_cost_usd":100}}`
- Do not execute a paid-provider condition when its preflight estimate exceeds the applicable ceiling.
- Prefer released traces and public evaluators. When a real provider is necessary, log the exact model snapshot, parameters, prompts, tool traces, token usage, and cost.
- `codex_mock`, ordinary Codex assistance, smoke fixtures, and AutoLabOS self-scores are development evidence only.
- Freeze task sampling, exclusions, stopping signals, budgets, retries, primary endpoint, uncertainty method, practical-effect threshold, and kill rule before aggregate outcomes are opened.
- Keep all failed and timed-out attempts in the denominator under prespecified handling.

## Plan

1. Collect current primary literature from deep-research evaluation, open-ended scientific literature discovery, and sequential stopping or coverage estimation.
2. Build a gap ledger distinguishing outcome-quality evaluation from completion-confidence evaluation.
3. Generate 5-7 candidates across at least three mechanism families, such as self-reported confidence, retrieval saturation, query-path agreement, unseen-relevant-item estimation, and cost-aware stopping.
4. For each candidate, verify two closest full-text priors, an exact non-overlap claim, a reviewer-absorption objection, public task units, strongest comparator, deterministic endpoint, cost estimate, and falsifier.
5. Run independent novelty, methods, statistics, systems, and workshop-fit reviews. Keep provenance inspectable and do not treat consensus as evidence.
6. Rank no more than three finalists and select none when every finalist fails a hard gate.
7. Inspect the leading dataset repository, license, denominator, evaluator, and raw task examples before freezing exactly one bounded-probe protocol.
8. Execute the frozen probe, apply its promote/revise/kill rule, and run a confirmatory study only after promotion.
9. Draft only after a quantitative comparator table, uncertainty analysis, task-level errors, claim-to-evidence mapping, and reproducibility bundle pass review and meta-review.

## Manuscript Format

- columns: 2
- main_body_pages: 4
- references_excluded_from_page_limit: true
- appendices_excluded_from_page_limit: true

## Appendix Preferences

Prefer appendix for:
- full_candidate_scorecard
- complete_search_and_prior_ledger
- prompts_and_stopping_policies
- task_level_outputs
- cost_and_runtime_receipts
- sensitivity_and_robustness_checks

Keep in main body:
- research_question
- primary_result_table
- strongest_baseline
- calibration_or_risk_coverage_plot
- central_failure_analysis
- claim_ceiling

## Research Question

Which observable signal, if any, enables a deep research agent to decide that an open-ended literature search is sufficiently complete under a fixed cost budget, and does that signal remain calibrated across tasks or search paths?

## Why This Can Be Tested With A Small Real Experiment

AutoResearchBench Wide Research exposes open-ended paper-set retrieval tasks and a public evaluator with externally defined target sets. A bounded subset can compare frozen stopping policies on the same task units while recording retrieved identifiers after each search step. No foundation-model training or model-based outcome judge is required. The small probe selects a direction only; paper claims require the confirmatory task count and uncertainty plan.

## Baseline / Comparator

Every promoted candidate must include:

- a fixed-budget search baseline using the original public evaluation protocol
- an equal-budget always-continue or maximum-step baseline
- a simple deterministic saturation baseline based on newly retrieved unique papers
- the strongest executable published evidence-aware termination method when its required state is available

Self-reported confidence alone is a diagnostic condition, not a sufficient strong baseline.

## Dataset / Task / Bench

- Primary candidate: AutoResearchBench Wide Research tasks and its released evaluator, subject to license, decryption, denominator, and raw-sample audit.
- Secondary validation candidates: a compatible public literature-discovery or deep-research retrieval benchmark with auditable relevant-source sets.
- Report-generation rubrics may provide context but cannot replace paper-set coverage gold for the primary endpoint.

## Target Comparison

Compare stopping policies at equal maximum search and provider budgets on the same frozen tasks. Record achieved recall or IoU, stop step, retrieved-set growth, duplicate rate, query-path agreement, token usage, wall time, and cost. Distinguish a policy's ability to stop from the underlying agent's ability to retrieve.

## Minimum Acceptable Evidence

- at least two verified full-text closest priors and an explicit non-overlap matrix
- at least 24 independent Wide Research task units in the bounded probe unless the released benchmark has a smaller complete eligible census
- at least 50 independent task units or a complete eligible census in confirmation
- at least three frozen stopping conditions including fixed-budget and deterministic saturation baselines
- at least two repeated query paths or seeds per task in confirmation when the agent is stochastic
- task-clustered bootstrap or another prespecified paired uncertainty method
- a prespecified practical threshold, such as reducing premature stops by at least 10 percentage points without lowering mean recall by more than 2 points under equal budget
- exact configurations, task IDs, raw retrieved identifiers by step, stop decisions, failures, evaluator version, and cost receipts

## Disallowed Shortcuts

- using final report quality as a proxy for search completeness
- letting the same model act as treatment and sole outcome judge
- inferring coverage from citation count without a gold or audited denominator
- selecting only tasks where the proposed policy succeeds
- changing stop thresholds or maximum budgets after aggregate results are visible
- dropping failed searches, empty retrievals, or timeouts from the denominator
- claiming a universal stopping rule from one provider, one benchmark, or one search backend

## Allowed Budgeted Passes

- literature collection: up to 2 passes
- candidate generation: up to 2 passes, 5-7 candidates per pass
- closest-prior challenge: up to 2 passes per finalist
- independent candidate review: 2 parallel reviews plus 1 meta-review
- bounded probe: 1 frozen execution plus 1 infrastructure-only retry when no treatment outcome was produced
- confirmatory study: 1 frozen execution plus prespecified recovery of missing runs only
- manuscript review: 2 independent reviews plus 1 meta-review and at most 2 bounded revision cycles

## Paper Ceiling If Evidence Remains Weak

If no candidate passes all hard gates, emit `topic_discovery_no_pass` and do not draft a paper. A successful bounded probe without confirmation remains a `paper_scale_candidate` or `research_memo`. If only one benchmark or backend is available, limit claims to that environment and prefer a preliminary workshop note over a general method claim.

## Minimum Experiment Plan

1. Audit and pin the benchmark, evaluator, eligible task denominator, and raw task sample.
2. Define the observable search-step trace and implement deterministic replay checks.
3. Freeze task sample, policies, thresholds, maximum budgets, repeats, endpoints, uncertainty, and kill rule.
4. Run an infrastructure canary that cannot inspect aggregate policy outcomes.
5. Execute every policy on matched tasks and preserve every attempt.
6. Compute coverage, stopping, calibration, cost, and paired uncertainty.
7. Apply the frozen decision rule and inspect premature-stop and wasted-search cases.
8. If promoted, expand to confirmation and the prespecified cross-path or cross-backend robustness check.

## Paper-worthiness Gate

The run may enter `write_paper` only when:

- closest-prior non-overlap survives independent full-text challenge
- dataset license, snapshot, denominator, and evaluator audits pass
- the bounded probe passes its frozen practical-effect rule
- confirmatory evidence meets the task-count and repeat requirements
- fixed-budget, saturation, and strongest published comparators execute under matched budgets
- headline contrasts include paired or task-clustered uncertainty
- every claim maps to raw task-level evidence and respects the benchmark-specific evidence ceiling
- independent review and meta-review find no unresolved fatal method, denominator, or reproducibility issue

## Failure Conditions

- a closest prior already evaluates the same stopping signal on the same open-ended task unit and endpoint
- the benchmark license, target-set denominator, evaluator, or task provenance cannot be verified
- search-step traces cannot be exposed or replayed, preventing stopping-policy comparison
- the strongest feasible comparator cannot run within budget
- fewer than 24 independent probe tasks remain without a complete-census justification
- the primary endpoint requires an unvalidated model judge
- estimated provider cost, compute, storage, or wall time exceeds the frozen ceiling
- the probe misses its practical-effect boundary or reveals target leakage
- confirmation fails the task-count, repeat, uncertainty, robustness, or reproducibility gate
