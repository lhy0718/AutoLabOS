# Research Brief

## Topic
State the research area and the concrete problem in 1–3 sentences.

Example:
Improve calibration or macro-F1 on small tabular classification tasks under tight compute budgets.

## Objective Metric
State the primary success metric and any important secondary metrics.

Required:
- Primary metric
- Secondary metrics (if any)
- What counts as meaningful improvement

Example:
Primary metric: macro-F1.
Secondary metrics: runtime, peak memory.
Meaningful improvement: at least +0.5 macro-F1 points over the strongest baseline without an unacceptable runtime increase.

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

## Research Question
Write one clear research question that could be answered by a small real experiment.

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

Required:
- baseline name
- why it is relevant
- expected comparison dimension

Example:
- Logistic regression: strong simple tabular baseline
- RBF-SVM: classical non-linear comparator

## Dataset / Task / Bench
Specify the experimental setting.

Required:
- dataset(s)
- task type
- train/eval protocol
- split or validation discipline
- known limitations

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