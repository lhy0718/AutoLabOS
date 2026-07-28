# Research Brief

This document is the governed execution contract for one run.
Keep workspace-level provider/runtime defaults in `.autolabos/config.yaml`.
Put run-specific research intent, evidence thresholds, baseline expectations, manuscript-format targets, and any manuscript template path here.

## Research Mode

Choose one:

- `hypothesis_test`: the brief already defines the experimental question and comparison contract.
- `topic_discovery`: the brief defines a broad research scope and selection constraints; each shortlisted topic must later supply its own metric, explicit unit and numeric scale, direction, structured effect criterion, comparator, data, falsifier, and local budget before any probe is authorized.

When omitted, the mode is `hypothesis_test`.

For `topic_discovery`, the required sections below remain required, but their
meaning changes from final experiment values to candidate-selection rules:

- `Topic` defines the bounded search domain and excluded directions.
- `Objective Metric` defines how topic candidates will be promoted and what
  makes a metric admissible; it does not name the final experiment metric.
- `Research Question` asks which evidence-backed, locally testable question
  should be promoted.
- `Baseline / Comparator` defines the rule that every candidate must name its
  strongest feasible comparator.
- `Dataset / Task / Bench` defines admissible source, license, size, and local
  execution constraints rather than pretending a dataset is already selected.
- `Target Comparison` defines the fields every candidate comparison must bind.
- `Minimum Acceptable Evidence` separates the bounded-probe promotion floor
  from the later confirmatory paper-evidence floor.
- `Plan` requires broad literature discovery across multiple independent
  scientific lenses before candidate generation. It must not collapse topic
  selection into one keyword query or preselect a favored intervention.

The collection stage assigns each query family a stable identifier, a lens
describing what central relation would count as direct evidence, and a
contribution intent such as method, measurement, dataset or benchmark,
empirical finding, theory, or reproducibility. Papers that merely apply the
target object are retained only as non-evidence diagnostics. Candidate topics
must be grounded in papers judged as direct support under the declared family
contract; lexical overlap alone is not admissible support.

The selected candidate, not the broad discovery brief, owns the final primary
metric, explicit unit and numeric scale, direction, structured practical-effect criterion,
comparator, data/task scope,
falsifier, kill signal, and local budget.

For `topic_discovery`, the brief must also state numeric ceilings for both the
bounded probe and the confirmatory stage: aggregate GPU-hours and maximum
concurrent GPUs and fresh trials for each stage. Include one exact line in the
`Constraints` section using this form:

`Machine-readable compute ceiling: {"bounded_probe":{"max_gpu_hours":1,"max_concurrent_gpus":1,"max_trials":1},"confirmatory":{"max_gpu_hours":1,"max_concurrent_gpus":1,"max_trials":1}}`

A candidate may declare tighter limits, but it must not omit either stage or
exceed any brief-owned ceiling.

## Topic
State the research area and the concrete problem in 1–3 sentences.

In `topic_discovery`, state a bounded search scope and exclusions instead of a
preselected intervention.

Example:
Test whether [intervention] improves [prespecified outcome] over [comparator] on [task scope] within [budget].

## Scientific Scope
Required for `topic_discovery`. This section is the deterministic authority for
literature-query scope. Keep scientific content separate from eligibility,
execution, and publication rules by using the role headings below.

Required structure:

```md
## Scientific Scope

### Scientific Object
- [one concise 2-to-5-term domain object used as the shared search anchor]

### Empirical Problems
- [observable problem or failure relation]
- [second independent observable problem or failure relation]

### Scientific Relations
- [optional testable relation between measured quantities]

### Prior-Work Probes
- [closest-prior or subsumption question; this does not authorize a scientific axis]

### Admissibility Constraints
- [data, license, grading, or local-execution eligibility rule]

### Process Rules
- [workflow or preregistration rule]

### Publication Goals
- [venue or contribution target]

### Exclusions
- [forbidden direction]
```

Only `Empirical Problems` and `Scientific Relations` authorize literature query
families. `Scientific Object` authorizes the immutable shared anchor.
`Prior-Work Probes` are routed to closest-prior checks. Constraints, process
rules, publication goals, and exclusions never become scientific query axes.

## Objective Metric
State the primary success metric and any important secondary metrics.

In `topic_discovery`, state the topic-promotion objective and metric
admissibility rules. Each candidate must later declare its own experimental
metric, explicit unit and numeric scale, optimization direction, and structured practical-effect
criterion.

Required:
- Primary metric
- Secondary metrics (if any)
- What counts as meaningful improvement

Example:
Primary metric: [metric key, unit, and optimization direction].
Secondary metrics: [cost, reliability, or resource metrics, if any].
Meaningful improvement: [prespecified effect size or decision boundary] over [named comparator] without violating [resource or quality constraint].

## Constraints
List practical constraints that shape the run.

Include:
- compute/time budget
- dataset or environment limits
- provider/tooling constraints
- reproducibility constraints
- forbidden shortcuts

Example:
- Keep experiments runnable on a local laptop or modest workstation.
- Prefer public datasets and reproducible scripts.
- Do not fabricate missing evidence.
- Do not treat workflow smoke tests as paper evidence.

## Plan
Provide a short step-by-step plan.

Recommended:
1. collect paper-scale related work
2. identify comparator family
3. form a falsifiable hypothesis
4. design a small but real experiment
5. implement and run baseline + proposed condition
6. analyze results
7. draft only after evidence is sufficient

## Manuscript Format
Optional manuscript-format targets for writing and validation.

Recommended:
- columns: 1 or 2
- main_body_pages: nominal target page count for the main body
- references_excluded_from_page_limit: true/false
- appendices_excluded_from_page_limit: true/false

Important:
- `main_body_pages` is a page-budget target, not a hard upper cap.
- AutoLabOS uses it to size writing budgets and, unless overridden, as the minimum compiled main-body page floor.
- If the compiled PDF lands below that floor, the page-budget check warns or fails depending on validation mode.
- These manuscript-format targets are brief-owned. Persisted workspace config may omit them and let the brief define them per run.

## Manuscript Template
Optional. Relative path to a `.tex` template file from the workspace root.
If provided, the `write_paper` node uses the file's preamble
(`\documentclass` through `\begin{document}`) and any detected section
structure as a structural guide.
The template can also supply layout-sensitive manuscript defaults such as appendix format.
Leave blank to use the built-in preamble generator.

Example:
template.tex

## Appendix Preferences
Optional. Use this section to route detail deliberately.
Use stable identifiers so the appendix planner can keep the main paper focused.

Prefer appendix for:
- hyperparameter_grids
- per_fold_results
- prompt_templates
- environment_dump
- extended_error_analysis

Keep in main body:
- main_result_tables
- primary_ablation

Example:
```md
## Manuscript Format
- columns: 2
- main_body_pages: 8
- references_excluded_from_page_limit: true
- appendices_excluded_from_page_limit: true

## Manuscript Template
templates/neurips.tex

## Appendix Preferences
Prefer appendix for:
- hyperparameter_grids
- per_fold_results
- environment_dump

Keep in main body:
- main_result_tables
- primary_ablation
```

## Research Question
Write one clear research question that could be answered by a small real experiment.

In `topic_discovery`, use a selection question such as: Which independently
supported gap yields the strongest falsifiable comparison under the declared
local budget and evidence floor?

Good example:
Can method X outperform baseline Y on task Z under constraint C?

Bad example:
Can we build a cool autonomous research system?

## Why This Can Be Tested With A Small Real Experiment
Explain why this topic is suitable for a modest, real, executable experiment.

Include:
- accessible dataset/task
- feasible implementation scope
- feasible baseline
- realistic run budget
- expected signal size or decision rule

## Baseline / Comparator
List at least one explicit baseline or comparator.

In `topic_discovery`, define the comparator-selection rule and require every
candidate to name the strongest feasible comparator; do not invent one shared
baseline for unrelated candidate families.

Required:
- baseline name
- why it is relevant
- expected comparison dimension

Example:
- `[baseline_condition_id]`: strongest feasible comparator under the same budget
- `[secondary_comparator_id]`: simpler or mechanism-matched reference condition

## Dataset / Task / Bench
Specify the experimental setting.

In `topic_discovery`, specify admissibility constraints such as public access,
license, maximum download size, deterministic sampling, and local runtime. The
candidate contract supplies the selected data/task identifier.

Required:
- dataset(s)
- task type
- train/eval protocol
- split or validation discipline
- known limitations

## Target Comparison
Specify the primary comparison the experiment should produce.

In `topic_discovery`, require each candidate to bind a proposed condition,
strongest feasible comparator, metric, explicit unit and numeric scale, direction,
delta-versus-reference effect criterion, and matched evaluation scope.

Required:
- proposed method or condition name
- comparator or baseline name
- comparison dimension (metric, unit, setting, or resource)
- direction of expected improvement
- structured effect criterion (`basis`, numeric `magnitude`, `scale`, and
  inclusive/exclusive boundary)

Example:
- Proposed: `[candidate_condition_id]`
- Comparator: `[baseline_condition_id]`
- Dimension: `[primary metric]` (`[unit]`) on `[dataset/task scope]`
- Expected: cross the prespecified `[effect or decision boundary]` in the favorable direction

## Minimum Acceptable Evidence
Define the threshold below which the result is not useful.

Required:
- minimum effect size or decision boundary
- minimum number of runs or folds
- what counts as "no signal" vs. "weak signal"

Example:
- At least `[N]` independent repeats, folds, or matched evaluation units
- A prespecified effect or error-rate boundary for a meaningful result
- An uncertainty rule that classifies the result as supported, inconclusive, or falsified

## Disallowed Shortcuts
List experimental shortcuts that would invalidate the result.

Examples:
- Do not use workflow smoke artifacts as experimental evidence.
- Do not cherry-pick a single favorable dataset and omit others.
- Do not fabricate or interpolate missing metric values.
- Do not claim statistical significance without running the test.
- Do not skip the baseline condition even if it seems obviously weaker.

## Allowed Budgeted Passes
Specify any additional analysis passes that are permitted within the compute budget.

Examples:
- One optional second-stage judging/reranking pass using a stronger model
- One optional verifier pass that re-evaluates ambiguous outputs
- No additional passes beyond the primary and confirmatory profiles

Budget note: total experiment cost should not exceed the stated compute constraint.

## Paper Ceiling If Evidence Remains Weak
State the maximum paper classification if the evidence does not clear the minimum bar.

Options:
- `system_validation_note` — pipeline runs but no external task evidence
- `research_memo` — some evidence but below paper-scale requirements
- `blocked_for_paper_scale` — evidence exists but is structurally insufficient

Example:
If the primary decision boundary is not crossed or the result lacks the required independent support,
cap the output at `research_memo` and do not claim a paper-ready result.

## Minimum Experiment Plan
Describe the minimum experiment package required before the run can be called paper-scale candidate.

Required:
- one baseline run
- one proposed or alternative condition
- one result table
- one limitation note
- one claim→evidence mapping

## Paper-worthiness Gate
The run should not be considered paper-ready unless the answer is effectively “yes” to all:

- Is the research question explicit?
- Is the related work sufficient to position the study?
- Is there at least one explicit baseline?
- Is there at least one real executed experiment?
- Is there at least one quantitative comparison?
- Can major claims be traced to evidence?
- Are limitations stated?

If not, downgrade to:
- system validation note
- research memo
- blocked for paper scale

## Failure Conditions
State what would count as failure or a blocked outcome.

Examples:
- No usable dataset can be identified.
- No meaningful baseline can be implemented.
- The experiment only proves the pipeline runs.
- Results are too weak to support the intended claim.
- Related work remains too shallow to position the study.

## Notes
Optional notes, assumptions, or background context.

## Questions / Risks
List unresolved questions and high-risk assumptions.

Examples:
- Is the dataset too small to support the claim?
- Is the proposed comparison fair?
- Are we relying too much on abstract-only papers?
- Could a simpler baseline already dominate?
