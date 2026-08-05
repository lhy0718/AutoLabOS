# Research Brief

## Research Mode

`topic_discovery`

## Topic

Search for a workshop-scale empirical question about the reliability, validity, and efficiency of evaluating language model agents. Explore multiple established evaluation lineages without assuming that a new metric, benchmark, scaffold, or robustness intervention is needed. Prefer questions that can be tested with public artifacts, deterministic task outcomes, and small open models on local hardware.

## Scientific Scope

### Scientific Object

- language model agents

### Empirical Problems

- evaluation validity across agent scaffolds and execution environments
- reliability across repeated executions and task-preserving perturbations
- tool-use efficiency and resource accounting
- trajectory-level failure attribution and reproducibility

### Scientific Relations

- agent scaffold versus measured task capability
- environment variation versus task success
- tool-call budget versus task performance
- trajectory evidence versus failure diagnosis

### Prior-Work Probes

- realistic and de-idealized agent benchmark environments
- cross-environment and open-ended evaluation of language model agents
- repeated-execution, perturbation, and tool-fault reliability benchmarks
- unified evaluation frameworks that separate model, scaffold, and environment effects
- task-agnostic and trajectory-aware agent evaluation
- deterministic evaluation of tool use and end-state task completion

### Admissibility Constraints

- a candidate must expose public, version-pinned task units, traces, or executable environments under an explicit research-compatible license
- the primary endpoint must be deterministic or independently auditable and cannot rely on the treatment model as its sole judge
- the strongest feasible comparator must run under matched information, task, and compute budgets
- bounded probes must fit two local 24 GB GPUs, 80 GB of new storage, and the declared wall-clock ceiling
- candidates fully absorbed by a verified closest prior on research object, question, intervention, evaluation unit, and claim scope must be rejected

### Publication Goals

- a falsifiable four-page workshop contribution about a concrete validity, reliability, or efficiency boundary in language-model-agent evaluation

### Exclusions

- a new general-purpose agent benchmark without a demonstrated measurement gap
- proprietary task sets or paid-provider-only empirical evidence
- generic LLM-as-judge comparisons
- new foundation-model training
- AutoLabOS as the only empirical object

## Objective Metric

- Primary topic-selection metric: pass/fail on closest-prior non-overlap, public artifact validity, deterministic or independently auditable grading, strong comparator availability, local execution feasibility, and a predeclared falsifier, followed by the governed candidate scorecard.
- Preferred study endpoints include paired task-success disagreement, ranking instability, repeated-run failure probability, perturbation sensitivity, resource-normalized success, and deterministic failure-attribution accuracy.
- Every candidate must freeze one numeric primary endpoint, explicit unit and scale, optimization direction, and practical-effect boundary before execution. Secondary outcomes cannot rescue a failed primary gate.

## Constraints

- Use public data and code under explicit research-compatible licenses and pin every repository, dataset, benchmark, evaluator, and environment revision.
- Keep the bounded probe within 6 aggregate GPU-hours, 80 real-provider calls, 16 wall-clock hours, 80 GB of new downloads, and an estimated paid-provider ceiling of USD 25.
- Keep confirmation within 40 aggregate GPU-hours, 320 real-provider calls, 48 wall-clock hours, and the same storage ceiling unless a new preflight proves sufficient headroom.
- Machine-readable compute ceiling: `{"bounded_probe":{"max_gpu_hours":6,"max_concurrent_gpus":2,"max_provider_calls":80,"max_wall_clock_hours":16,"max_download_gb":80,"max_estimated_provider_cost_usd":25},"confirmatory":{"max_gpu_hours":40,"max_concurrent_gpus":2,"max_provider_calls":320,"max_wall_clock_hours":48,"max_download_gb":80,"max_estimated_provider_cost_usd":100}}`
- Prefer cached or openly downloadable models and released traces. Paid-provider runs may be used only when a candidate cannot be tested otherwise and its estimate passes the applicable ceiling.
- When model behavior is the empirical unit, use at least two independently pretrained model families in confirmation and preserve exact prompts, decoding, tool traces, retries, token usage, runtime, and failures.
- `codex_mock`, ordinary Codex assistance, smoke fixtures, and AutoLabOS self-evaluations are development evidence only.
- Freeze task sampling, exclusions, conditions, maximum budgets, retry handling, endpoint, uncertainty method, practical threshold, and kill rule before aggregate outcomes are opened.
- Keep failed, timed-out, malformed, and empty executions in the prespecified denominator.

## Plan

1. Collect current primary literature across at least three independent language-model-agent evaluation clusters.
2. Build a gap ledger that separates capability deficits from evaluator, scaffold, environment, reliability, and accounting defects.
3. Generate 5-7 candidates across at least three evidence-axis clusters without preselecting a method or benchmark.
4. For every candidate, verify two closest full-text priors, a five-axis non-overlap claim, the strongest reviewer-absorption objection, public data rights, a deterministic endpoint, a strong comparator, a local cost estimate, and a falsifier.
5. Run independent novelty, methodology, statistics, reproducibility, and adversarial reviews, followed by a separate meta-review. Consensus cannot substitute for source or execution evidence.
6. Rank no more than three finalists and select none when every candidate fails a hard gate.
7. Audit the leading repository, license, task denominator, evaluator, environment setup, and raw examples before freezing exactly one bounded-probe contract.
8. Execute the frozen probe and apply its promote, revise, or kill rule. Run confirmation only after promotion.
9. Draft only after a quantitative comparator table, paired or clustered uncertainty, failure analysis, claim-to-evidence mapping, and reproducibility bundle pass review.

## Manuscript Format

- columns: 2
- main_body_pages: 4
- references_excluded_from_page_limit: true
- appendices_excluded_from_page_limit: true

## Appendix Preferences

Prefer appendix for:
- full_candidate_scorecard
- closest_prior_and_absorption_matrix
- complete_task_and_trace_ledger
- prompts_and_agent_scaffolds
- environment_and_cost_receipts
- robustness_and_sensitivity_checks

Keep in main body:
- research_question
- primary_result_table
- strongest_baseline
- uncertainty_plot
- central_failure_analysis
- claim_ceiling

## Research Question

Which independently grounded measurement gap in evaluating language model agents yields the strongest falsifiable, locally executable comparison, and does the observed effect survive a strong comparator and matched task, scaffold, environment, and resource controls?

## Why This Can Be Tested With A Small Real Experiment

Recent agent benchmarks and evaluation frameworks release executable environments, task definitions, deterministic end-state checks, traces, or open-source implementations. A bounded subset can test one frozen measurement contrast with cached 1B-scale models or released trajectories while preserving task-level outcomes and costs. The small probe selects a direction only; paper claims require the declared confirmation breadth, repeated units, and uncertainty analysis.

## Baseline / Comparator

Every promoted candidate must include:

- the original public evaluation protocol or evaluator
- an equal-budget simple deterministic baseline appropriate to the proposed measurement
- the strongest executable published method that addresses the same measurement relation
- matched model, task, prompt, scaffold, environment, tool access, retry, and maximum-budget settings whenever the research question permits pairing

A generic ReAct agent, a point estimate, or an LLM judge alone is not a sufficient strongest comparator when a more direct published baseline exists.

## Dataset / Task / Bench

- Candidate sources may include public agent benchmark tasks, released execution traces, deterministic tool-use suites, sandboxed interaction environments, and benchmark repositories with inspectable end-state evaluators.
- The selected source must define the independent task unit, eligible denominator, split boundaries, exclusions, environment state, evaluator revision, and license before execution.
- A released aggregate table without task-level or replayable evidence cannot authorize a primary empirical claim.
- Synthetic or controlled fault injection is admissible only with a frozen registry, independent oracle, disjoint development and test fault families, and a claim ceiling limited to the registered faults.

## Target Comparison

Compare one proposed measurement, control, or evaluation policy against its strongest feasible baseline on the same frozen task units. Record task success, disagreement or ranking changes, retries, tool calls, token usage, runtime, cost, environment failures, and trace-level failure labels as applicable. Keep model capability, scaffold behavior, evaluator behavior, and environment volatility as separate causal targets.

## Minimum Acceptable Evidence

- 5-7 candidates across at least three independent evidence-axis clusters before narrowing
- two verified full-text closest priors and an explicit five-axis non-overlap matrix for every finalist
- at least 30 independent or paired task units in the bounded probe unless a complete smaller census is justified
- at least 80 independent units or a complete eligible census in confirmation
- at least one strong published comparator plus the original protocol and a simple deterministic control
- at least three repeated executions per task in confirmation when stochastic reliability is claimed
- paired, task-clustered bootstrap, or another prespecified dependence-aware uncertainty method
- a numeric practical-effect boundary and explicit non-inferiority constraint when trading reliability against cost or task success
- exact task IDs, environment revisions, configurations, raw outputs, tool traces, failure handling, evaluator outputs, and resource receipts

## Disallowed Shortcuts

- using workflow completion, a generated PDF, or AutoLabOS scores as scientific evidence
- treating retrieval candidates, snippets, or abstracts as support for central novelty claims when full text is available
- changing tasks, thresholds, budgets, retry policies, or endpoints after aggregate outcomes are visible
- dropping failures, empty runs, timeouts, or environment crashes from the denominator
- calling a bounded probe confirmatory evidence
- claiming general agent reliability from one benchmark, one scaffold, one model family, or one environment
- adding experiment-specific identifiers to reusable runtime code or public test contracts

## Allowed Budgeted Passes

- literature collection: up to 2 passes
- candidate generation: up to 2 passes with 5-7 candidates per pass
- closest-prior challenge: up to 2 passes per finalist
- independent candidate review: five isolated roles plus one meta-review
- bounded probe: one frozen execution plus one infrastructure-only retry when no treatment outcome was produced
- confirmation: one frozen execution plus prespecified recovery of missing runs only
- manuscript review: five isolated roles plus one meta-review and at most two bounded revision cycles

## Paper Ceiling If Evidence Remains Weak

If no candidate passes every hard gate, emit `topic_discovery_no_pass` and do not draft a paper. A valid bounded probe without confirmation remains `paper_scale_candidate` or `research_memo`. Evidence from one benchmark, scaffold, or model family limits claims to that setting and cannot support a general evaluation method claim.

## Minimum Experiment Plan

1. Audit and pin the benchmark, evaluator, environment, task denominator, and raw task sample.
2. Freeze one primary comparison, conditions, task sample, budgets, repeats, endpoint, uncertainty method, practical threshold, non-inferiority constraint, and kill rule.
3. Implement deterministic replay and evaluator-integrity checks before model execution.
4. Run an infrastructure canary that cannot inspect aggregate treatment outcomes.
5. Execute every frozen condition on matched tasks and preserve every attempt.
6. Compute the primary endpoint, uncertainty, task success, reliability, and resource accounting.
7. Apply the frozen decision rule and inspect disagreements, brittle tasks, and environment failures.
8. If promoted, expand to confirmation and the prespecified cross-model, cross-scaffold, or cross-environment robustness check.

## Paper-worthiness Gate

The run may enter `write_paper` only when:

- closest-prior non-overlap survives independent full-text challenge
- source licenses, revisions, denominator, evaluator, and environment audits pass
- the bounded probe passes its frozen practical-effect and non-inferiority rules
- confirmation meets task-count, model-family, repeat, uncertainty, and robustness requirements
- original, deterministic, and strongest published comparators execute under matched budgets
- every headline contrast maps to task-level evidence and respects the setting-specific claim ceiling
- independent review and meta-review find no unresolved fatal method, denominator, evaluator, or reproducibility defect

## Failure Conditions

- fewer than five viable candidates or fewer than three independent evidence-axis clusters survive source verification
- a closest prior already matches the research object, question, intervention, evaluation unit, and claim scope
- source license, task denominator, evaluator, environment, or task provenance cannot be verified
- the strongest feasible comparator cannot run under a matched budget
- fewer than 30 independent probe units remain without a complete-census justification
- the primary endpoint depends on an unvalidated model judge
- execution exceeds the frozen compute, provider, storage, or wall-clock ceiling
- the probe misses its practical-effect boundary, violates non-inferiority, or reveals target leakage
- confirmation fails the task-count, repeat, uncertainty, cross-context, or reproducibility gate

## Notes

Current primary-source lineages include realistic agent environments, repeated-execution and perturbation reliability, cross-environment evaluation, trajectory-aware evaluation, and frameworks that separate model, scaffold, and environment effects. These are search anchors and required comparators, not evidence that a new contribution already exists.

## Questions / Risks

- Do recent unified evaluation frameworks already absorb scaffold- or environment-sensitivity candidates?
- Can public task evaluators be replayed deterministically without hidden services or proprietary dependencies?
- Are repeated task executions independent enough for the proposed reliability estimator?
- Can a local 1B-scale probe expose a measurement defect without reducing the contribution to small-model behavior?
