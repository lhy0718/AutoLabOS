# Research Brief

## Research Mode

`topic_discovery`

## Topic

Search for a workshop-scale empirical question about robust, efficient, and
diagnosable function calling by language models. First map established
benchmark, perturbation, multi-turn dependency, and failure-analysis lineages
without assuming that a new benchmark, metric, or training method is needed.
Prefer public executable tasks with deterministic tool outputs and auditable
end states that small open models can run locally.

## Scientific Scope

### Scientific Object

- function calling

### Empirical Problems

- benchmark coverage and deterministic function-selection and argument correctness
- robustness under task-preserving query and function-schema perturbations
- multi-turn and multi-hop dependency handling with explicit state transitions
- detection and correction of function-selection and argument-generation failures

### Scientific Relations

- query or function-schema variation versus exact invocation correctness
- candidate-function count or similarity versus selection and argument errors
- dialogue or dependency depth versus state-transition and end-state correctness
- retry or correction policy versus recovery, task success, and unnecessary calls

### Prior-Work Probes

- executable function-calling benchmark evaluation
- agentic function-calling robustness under query and toolkit variation
- exact function-selection and argument-generation accuracy
- multi-turn function-calling dialogue state evaluation
- multi-hop and compositional function-calling evaluation
- function-calling error detection and correction
- unnecessary calls, retries, and marginal function utility

### Admissibility Constraints

- a candidate must expose public version-pinned tasks, tool schemas, expected
  states, traces, or executable tools under a research-compatible license
- the primary endpoint must be deterministic or independently auditable and
  cannot rely on the treatment model as its sole judge
- the strongest feasible comparator must use matched task information, tools,
  retry limits, and inference budget
- bounded probes must fit two local 24 GB GPUs, 80 GB of new storage, and the
  declared wall-clock ceiling
- candidates absorbed by a verified closest prior on object, question,
  intervention, evaluation unit, and claim scope must be rejected

### Publication Goals

- a falsifiable four-page workshop contribution about a concrete robustness,
  efficiency, statefulness, or diagnostic boundary in language-model tool use

### Exclusions

- a new general-purpose tool-use benchmark without a verified measurement gap
- proprietary tools, hidden task sets, or paid-provider-only evidence
- generic LLM-as-judge comparisons
- new foundation-model training
- AutoLabOS as the only empirical object

## Objective Metric

- Primary topic-selection metric: pass/fail on closest-prior non-overlap,
  public artifact validity, deterministic grading, strong comparator
  availability, local execution feasibility, and a predeclared falsifier,
  followed by the governed candidate scorecard.
- Preferred endpoints include paired task-success disagreement, perturbation
  failure rate, state-transition correctness, success under a tool-call budget,
  unnecessary-call rate, and deterministic failure-attribution or repair accuracy.
- Every candidate must freeze one numeric primary endpoint with unit, scale,
  direction, practical-effect boundary, and non-inferiority constraint before execution.

## Constraints

- Use public data and code under explicit research-compatible licenses and pin
  every repository, dataset, tool registry, evaluator, and environment revision.
- Keep the bounded probe within 6 aggregate GPU-hours, 80 real-provider calls,
  16 wall-clock hours, 80 GB of new downloads, and USD 25 estimated provider cost.
- Keep confirmation within 40 aggregate GPU-hours, 320 real-provider calls,
  48 wall-clock hours, 80 GB of new downloads, and USD 100 estimated provider cost.
- Machine-readable compute ceiling: `{"bounded_probe":{"max_gpu_hours":6,"max_concurrent_gpus":2,"max_provider_calls":80,"max_wall_clock_hours":16,"max_download_gb":80,"max_estimated_provider_cost_usd":25},"confirmatory":{"max_gpu_hours":40,"max_concurrent_gpus":2,"max_provider_calls":320,"max_wall_clock_hours":48,"max_download_gb":80,"max_estimated_provider_cost_usd":100}}`
- Prefer cached or openly downloadable models and locally executable tools.
- Confirmation must use at least two independently pretrained model families
  when model behavior is the empirical unit.
- Preserve exact prompts, tool schemas, tool outputs, state transitions,
  decoding, retries, token usage, runtime, and every failure.
- `codex_mock`, smoke fixtures, and AutoLabOS self-evaluations are development evidence only.
- Freeze sampling, exclusions, perturbations, conditions, budgets, retry
  handling, endpoint, uncertainty method, practical threshold, and kill rule
  before aggregate outcomes are opened.

## Plan

1. Collect current primary literature across at least three independent tool-use evaluation clusters.
2. Separate model capability gaps from task, tool, environment, evaluator, and accounting defects.
3. Generate 5-7 candidates across at least three evidence-axis clusters.
4. Verify two closest full-text priors, five-axis non-overlap, strongest
   absorption objection, license, deterministic endpoint, comparator, local
   cost, and falsifier for each finalist.
5. Run isolated novelty, methodology, statistics, reproducibility, and
   adversarial reviews plus a separate meta-review.
6. Rank no more than three finalists and select none if every candidate fails a hard gate.
7. Audit the leading benchmark repository, task denominator, evaluator, tool
   registry, raw examples, and license before freezing one bounded probe.
8. Execute the frozen probe; confirm only after its promote rule passes.
9. Draft only after quantitative comparison, dependence-aware uncertainty,
   failure analysis, claim mapping, and reproducibility checks pass.

## Manuscript Format

- columns: 2
- main_body_pages: 4
- references_excluded_from_page_limit: true
- appendices_excluded_from_page_limit: true

## Appendix Preferences

Prefer appendix for complete candidate scorecards, closest-prior matrices,
task and trajectory ledgers, prompts and tool schemas, perturbation registries,
environment receipts, and sensitivity checks. Keep the research question,
primary comparison, uncertainty, central failure analysis, and claim ceiling in
the main body.

## Research Question

Which independently grounded measurement gap in language-model tool use yields
the strongest falsifiable local comparison, and does the effect survive a
matched strong comparator across task units, tool access, environment state,
and inference budget?

## Why This Can Be Tested With A Small Real Experiment

Several tool-use benchmarks release executable tools, explicit schemas,
deterministic answers or end states, annotated dialogues, and public task
splits. A frozen subset can test one paired contrast with cached open models.
The bounded probe selects a direction only; paper claims require confirmation,
multiple model families, sufficient task units, and uncertainty analysis.

## Baseline / Comparator

Every promoted candidate must include the original public protocol, an
equal-budget deterministic baseline, and the strongest executable published
method addressing the same relation. Match model, task, prompt, tool registry,
environment state, retry policy, and maximum inference budget whenever pairing
permits. A generic ReAct prompt or LLM judge alone is not a sufficient strongest comparator.

## Dataset / Task / Bench

- Candidate sources may include public function-calling, multi-hop, stateful,
  conversational, robustness, reflective, and failure-diagnosis suites.
- The selected source must define independent task units, eligible denominator,
  split boundaries, tool behavior, expected state, evaluator revision, and license.
- Aggregate tables without task-level or replayable evidence cannot authorize a primary claim.
- Controlled perturbations or fault injection require a frozen registry,
  independent oracle, disjoint development and test families, and a claim
  ceiling limited to registered transformations.

## Target Comparison

Compare one measurement, control, or tool-use policy against its strongest
feasible baseline on matched task units. Record end-state success, function and
argument correctness, unnecessary or repeated calls, state transitions,
recovery, tokens, runtime, and failures. Keep model behavior, tool behavior,
environment state, and evaluator behavior as separate causal targets.

## Minimum Acceptable Evidence

- 5-7 candidates across at least three independent evidence-axis clusters
- two verified full-text closest priors and a five-axis non-overlap matrix per finalist
- at least 30 paired or independent task units in the bounded probe unless a complete smaller census is justified
- at least 80 units or a complete eligible census in confirmation
- the original protocol, a simple deterministic control, and one strong published comparator
- at least three repeats per task in confirmation when stochastic reliability is claimed
- paired, task-clustered bootstrap, or another prespecified dependence-aware uncertainty method
- a numeric practical-effect boundary and non-inferiority constraint for success when optimizing cost or diagnostics
- exact task IDs, revisions, prompts, schemas, raw outputs, traces, failures, and resource receipts

## Disallowed Shortcuts

- using workflow completion, generated papers, or AutoLabOS scores as scientific evidence
- treating retrieval snippets or abstracts as central novelty evidence when full text is available
- changing tasks, perturbations, thresholds, budgets, retries, or endpoints after outcomes are visible
- removing malformed calls, timeouts, tool errors, or environment crashes from the denominator
- calling a bounded probe confirmatory evidence
- claiming general tool-use reliability from one benchmark or model family
- adding experiment-specific identifiers to reusable public runtime code or tests

## Allowed Budgeted Passes

- literature collection: up to 2 passes
- candidate generation: up to 2 passes with 5-7 candidates each
- closest-prior challenge: up to 2 passes per finalist
- independent candidate review: five isolated roles plus one meta-review
- bounded probe: one frozen execution plus one infrastructure-only retry when no treatment outcome exists
- confirmation: one frozen execution plus prespecified missing-run recovery only
- manuscript review: five isolated roles plus one meta-review and at most two revision cycles

## Paper Ceiling If Evidence Remains Weak

If no candidate passes every hard gate, emit `topic_discovery_no_pass` and do
not draft a paper. A valid bounded probe without confirmation remains
`paper_scale_candidate` or `research_memo`. Evidence from one benchmark or
model family supports only a setting-specific claim.

## Minimum Experiment Plan

1. Audit and pin the benchmark, evaluator, tool registry, environment, denominator, and raw sample.
2. Freeze one comparison, task sample, perturbations, conditions, budgets,
   repeats, endpoint, uncertainty method, practical threshold, and kill rule.
3. Implement deterministic tool replay, state checks, and evaluator-integrity tests.
4. Run an infrastructure canary without opening aggregate treatment outcomes.
5. Execute all frozen conditions on matched tasks and preserve every attempt.
6. Compute the primary endpoint, uncertainty, success, failure taxonomy, and resource accounting.
7. Apply the frozen decision rule and inspect brittle tasks and evaluator disagreements.
8. If promoted, run confirmation and the prespecified cross-model or cross-benchmark check.

## Paper-worthiness Gate

- closest-prior non-overlap survives independent full-text challenge
- licenses, revisions, denominator, tools, evaluator, and environment audits pass
- the bounded probe passes practical-effect and non-inferiority rules
- confirmation meets task-count, model-family, repeat, uncertainty, and robustness requirements
- original, deterministic, and strongest published comparators run under matched budgets
- every headline claim maps to task-level evidence and respects the setting-specific ceiling
- independent review and meta-review have no unresolved fatal defect

## Failure Conditions

- fewer than five viable candidates or three evidence-axis clusters survive verification
- a closest prior matches object, question, intervention, unit, and claim scope
- license, denominator, tool behavior, evaluator, environment, or provenance cannot be verified
- the strongest comparator cannot run under a matched budget
- fewer than 30 probe units remain without a complete-census justification
- the primary endpoint depends on an unvalidated model judge
- execution exceeds compute, provider, storage, or wall-clock ceilings
- the probe misses its practical boundary, violates success non-inferiority, or reveals leakage
- confirmation fails task-count, repeat, uncertainty, cross-context, or reproducibility gates

## Notes

Primary-source lineages span executable API evaluation, stateful multi-turn
interaction, multi-hop tool composition, robustness to query and toolkit
changes, reflective repair, efficiency accounting, and trace-level failure
diagnosis. They are required search anchors and comparators, not evidence that a
new contribution has already been established.

## Questions / Risks

- Do recent robustness or failure-diagnosis suites already absorb controlled perturbation candidates?
- Can locally executable tools reproduce published state and evaluator behavior without hidden services?
- Can small open models produce enough successful tool trajectories for paired inference?
- Does an efficiency contrast remain meaningful after enforcing task-success non-inferiority?
