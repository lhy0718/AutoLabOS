# Research Brief

## Research Mode

`topic_discovery`

## Topic

Search for a workshop-scale empirical question at the intersection of language-model evaluation, statistical reliability under limited evaluation budgets, and reproducible local execution. Exclude new foundation-model training, purely theoretical results without an executable empirical test, proprietary data, evaluator designs that require paid model APIs, and questions whose only empirical object is AutoLabOS itself.

## Scientific Scope

### Scientific Object

- language-model evaluation

### Empirical Problems

- uncertainty estimation for model-ranking decisions under finite evaluation samples
- evaluation-set sufficiency for stable comparative conclusions
- finite-benchmark census versus external task-population inference
- dependence-aware uncertainty across evaluation items, tasks, and model families

### Scientific Relations

- sampling budget versus false model-selection decisions
- dependence structure versus interval coverage for comparative evaluation

### Prior-Work Probes

- anytime-valid inference for language-model evaluation
- evaluation-set sufficiency and adaptive stopping
- finite-benchmark inference and benchmark generalization

### Admissibility Constraints

- candidate tasks must expose auditable item-level outcomes and run locally within the declared compute ceiling

### Publication Goals

- a falsifiable workshop-scale contribution with a strong comparator and explicit evidence ceiling

### Exclusions

- proprietary evaluators, paid model APIs as primary evidence, new foundation-model training, and AutoLabOS itself as the only empirical object

## Objective Metric

- Primary metric: candidate promotion utility under the governed topic scorecard, with closest-prior non-overlap, evaluation validity, local feasibility, and workshop contribution treated as hard constraints rather than interchangeable score bonuses.
- Secondary metrics: independent research-cluster coverage, full-text evidence coverage, expected GPU-hours, estimated item-level observations, baseline strength, failure information value, reproducibility, and venue fit.
- What counts as meaningful improvement: a candidate may be promoted only if it binds a numeric primary metric with an explicit unit and numeric scale, an optimization direction, and a prespecified structured practical-effect or decision boundary against its strongest feasible comparator. A high aggregate topic score cannot compensate for a failed hard gate.

## Constraints

- Use public data with an explicit research-compatible license and a pinned version or immutable snapshot.
- Keep the bounded feasibility probe within 6 aggregate GPU-hours and the confirmatory study within 60 aggregate GPU-hours on at most two local 24 GB GPUs.
- Machine-readable compute ceiling: `{"bounded_probe":{"max_gpu_hours":6,"max_concurrent_gpus":2,"max_trials":12},"confirmatory":{"max_gpu_hours":60,"max_concurrent_gpus":2,"max_trials":96}}`
- Keep total new downloads below 120 GB and record model, dataset, code, and environment versions.
- Prefer inference-time or evaluation-method studies over new model training.
- Use at least two independently pretrained local model families in the bounded probe when model behavior is the empirical unit.
- Do not use paid model APIs as primary empirical evidence.
- Do not use `codex_mock`, deterministic smoke fixtures, workflow artifacts, or AutoLabOS-generated self-evaluations as paper evidence.
- Freeze sampling, exclusions, metrics, direction, practical-effect boundary, and kill criteria before opening aggregate probe outcomes.
- Do not fabricate missing evidence or repair a failed preregistered gate after observing outcomes.

## Plan

1. Collect broad primary literature from at least three independent research clusters within budgeted language-model evaluation.
2. Build a gap map that distinguishes empirical gaps from already-solved theoretical or systems questions.
3. Generate 5–7 candidates, each with two closest priors, a reviewer-absorption objection, a strong comparator, an admissible dataset, a falsifier, and a local cost estimate.
4. Adversarially review novelty, methods, data validity, statistics, systems feasibility, and workshop fit; kill absorbed or non-executable candidates.
5. Freeze exactly one active bounded-probe contract and defer all other candidates.
6. Implement and execute the selected probe with real local models or other real task units, then promote, revise, or kill using the frozen decision rule.
7. Run a confirmatory study only after probe promotion, including repeated or paired uncertainty analysis and error analysis.
8. Draft only after the review gate confirms an explicit ResultsArtifactV2 comparison, claim-to-evidence mapping, and reproducibility handoff.

## Manuscript Format

- columns: 2
- main_body_pages: 4
- references_excluded_from_page_limit: true
- appendices_excluded_from_page_limit: true

## Appendix Preferences

Prefer appendix for:
- full_candidate_scorecard
- full_prompt_templates
- environment_dump
- per_task_results
- robustness_checks

Keep in main body:
- primary_result_table
- research_question
- strongest_baseline
- central_failure_analysis

## Research Question

Which independently supported gap in reliable, budgeted language-model evaluation yields the strongest falsifiable empirical comparison that can be executed locally and defended as a workshop contribution under the declared evidence and compute ceilings?

## Why This Can Be Tested With A Small Real Experiment

Public language-model benchmarks expose item-level paired outcomes, and several capable local model families are already available on the target machine. Candidate studies must support a small frozen probe whose grading is deterministic or independently auditable, whose strongest baseline can be implemented under the same item and compute budget, and whose failure still resolves a concrete methodological uncertainty. The probe is a selection instrument only; paper claims require a later confirmatory profile.

## Baseline / Comparator

- Every candidate must name its strongest feasible comparator from verified closest prior work and explain why a simpler control is insufficient.
- Baseline and proposed conditions must use matched items, model settings, prompts, decoding, and stopping rules whenever the research question permits pairing.
- Weak controls such as point estimates, one-item decisions, or uncalibrated heuristics may be reported only as secondary references when a statistically principled comparator is feasible.
- A candidate with no reproducible strong comparator is ineligible for a probe.

## Dataset / Task / Bench

- Data must be publicly accessible, version-pinned, license-audited, and locally processable within the storage and time budget.
- The candidate must define the task unit, sampling frame, train/development/test boundaries, exclusion rules, and deterministic grading path before execution.
- When a finite benchmark is used, distinguish a full fixed benchmark census from claims about an external task population.
- The bounded probe must include enough independent or paired units to exercise its decision rule; tiny convenience samples cannot promote a topic.
- Outcome-driven sample replacement, hidden test-set tuning, and post-hoc endpoint selection are forbidden.

## Target Comparison

Each candidate must bind:

- Proposed: one named intervention, policy, or measurement procedure.
- Comparator: the strongest feasible baseline under the same matched evaluation scope.
- Dimension: one numeric primary metric with an explicit unit, a `raw|proportion|percent|percentage_point` numeric scale, and `maximize` or `minimize` direction.
- Expected: cross a prespecified practical-effect or error-rate boundary in the favorable direction without violating a named reliability, cost, or false-decision constraint.

## Minimum Acceptable Evidence

- Before narrowing: 5–7 candidates across at least three independent research clusters.
- Before probe authorization: at least two distinct verified full-text closest priors, an explicit non-overlap statement, a reviewer-absorption objection, a strong comparator, a licensed real task, a frozen metric/direction/effect boundary, a paired or clustered uncertainty plan, and a predeclared kill signal.
- Bounded probe: real execution within 6 aggregate GPU-hours, complete item-level logs, deterministic or independently auditable grading, and no failed contract-integrity checks.
- Confirmatory study: at least three independent model families or an equivalently defensible independent-unit design; at least five task or slice contexts when cross-task robustness is claimed; all planned repeats or paired units completed; uncertainty intervals and false-decision analysis reported.
- `supported`: the primary boundary and all reliability constraints pass on held-out or confirmatory evidence.
- `inconclusive`: execution is valid but the boundary or uncertainty requirement is unresolved.
- `falsified`: the preregistered kill condition fires or a strong baseline matches or dominates the proposed condition.

## Disallowed Shortcuts

- Do not select a topic from aggregate scores without inspecting hard-gate failures and dissenting reviews.
- Do not turn a product feature, workflow completion, generated PDF, or successful build into a research contribution.
- Do not cite search snippets or abstracts as support for central novelty or method claims when full text is available.
- Do not use a single favorable task, model, seed, or threshold while omitting planned failures.
- Do not call a bounded probe confirmatory evidence.
- Do not claim statistical significance or efficiency without executing the prespecified test and cost accounting.
- Do not introduce experiment-specific identifiers into reusable runtime code or public test contracts.

## Allowed Budgeted Passes

- One initial 5–7 candidate portfolio.
- One portfolio refresh after a documented pre-execution kill, while preserving killed-candidate receipts.
- One bounded probe for exactly one active candidate at a time.
- One confirmatory execution profile after promotion.
- One prespecified robustness pass and one error-analysis pass after confirmatory results.
- No outcome-driven metric, sample, threshold, or comparator changes.

## Paper Ceiling If Evidence Remains Weak

If no candidate clears the bounded-probe promotion rule, cap the output at `research_memo`. If a candidate clears the probe but lacks the confirmatory independence, task breadth, uncertainty, or strong-baseline requirements, mark it `blocked_for_paper_scale`. A successful workflow, PDF build, or locally interesting point estimate does not raise this ceiling.

## Minimum Experiment Plan

- one frozen active-candidate contract with a content hash
- one strong baseline and one proposed condition on matched real units
- one bounded-probe result table with item-level execution receipts
- one confirmatory profile with the required independent units if the probe promotes
- one uncertainty analysis and one failure or error analysis
- one limitation note and one claim-to-evidence mapping
- one reproducibility manifest covering data, models, code, environment, and commands

## Paper-worthiness Gate

The run is not paper-ready unless the selected question is explicit and differentiated from verified closest priors; the experimental contract is frozen; real baseline and proposed conditions were executed; the ResultsArtifactV2 primary comparison names metric, unit, direction, roles, and independent-unit coverage; uncertainty and failure analyses are present; every major claim links to inspectable evidence; references pass authority checks; and independent review plus meta-review accept the evidence ceiling. Otherwise the run must backtrack or be downgraded.

## Failure Conditions

- Fewer than five viable candidates or fewer than three independent research clusters survive source verification.
- No candidate has two verified full-text closest priors and a defensible non-overlap.
- No licensed real dataset or deterministic/auditable grading path is feasible locally.
- The strongest comparator cannot be implemented under a matched budget.
- The bounded probe exceeds its budget, violates its frozen contract, or yields only a convenience-sample signal.
- Confirmatory evidence fails the practical-effect, reliability, false-decision, uncertainty, or cross-context requirement.
- A closest-prior audit absorbs the proposed contribution.
- The only remaining contribution is AutoLabOS workflow validation.

## Notes

The intended venue class is an NLP evaluation, uncertainty, reproducibility, or agent-methodology workshop. Venue scope and submission rules must be verified from the official call before drafting to a specific template.

## Questions / Risks

- Does recent anytime-valid or evaluation-set-sufficiency work already subsume the best empirical candidate?
- Can finite-benchmark census labels be used without overgeneralizing to an external population?
- Are model-family and task-family units sufficiently independent for the intended uncertainty claim?
- Will the strongest principled baseline leave enough novelty for a short workshop paper?
