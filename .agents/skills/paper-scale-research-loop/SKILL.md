---
name: paper-scale-research-loop
description: Use this skill when the goal is to choose a research topic that supports a real small-scale experiment, collect a paper-writing-scale related-work corpus, formulate falsifiable hypotheses, run experiments with baselines and ablations, and push toward a paper-ready manuscript with results and limitations.
---

# Paper-Scale Research Loop

## Purpose

This skill is for work that must go beyond “the system completed the workflow.”

Its goal is to choose a genuinely testable research question, collect related work at a scale and density suitable for paper writing, formulate falsifiable hypotheses, run small but real experiments, and produce a manuscript with result tables and limitations.

The core principle of this skill is to prioritize **validated research claims** over a document that merely **looks like a paper**.

## When to use this skill

Use this skill when the user wants things like:

- “I want a paper with a real small experiment, not just a test-level demo.”
- “Collect papers at a scale that is sufficient for actual paper writing.”
- “Form a hypothesis and run real experiments with a baseline.”
- “Raise the work to a paper-ready level, not just a completed run.”
- “Produce an experiment paper, not just a survey.”
- “Deliver a manuscript with real experimental substance.”

Typical trigger phrases:

- “paper-scale”
- “small real experiment”
- “with baseline”
- “experimental paper”
- “paper-ready”
- “a paper with numerical results”

## Required distinctions

Explicitly distinguish among:

- **workflow completed**
- **write_paper completed**
- **paper-shaped draft**
- **paper-ready experimental manuscript**

The first three are not sufficient.

If the target is the last one, the work must pass the hard gate below.

## Hard Gate: Paper-Worthy Minimum

If any of the following is missing, the output must be marked `paper_ready=false` or `blocked_for_paper_scale`.

1. The research question is explicit and testable.
2. Related work is not just a list of titles or abstracts; at least some of it must be grounded in full-text evidence.
3. The collected corpus is not just a tiny test sample; it must cover the main axes of the topic.
4. The hypothesis is falsifiable.
5. There is at least one explicit baseline or comparator.
6. There is at least one actually executed experiment.
7. The results section includes a numeric table or a core quantitative comparison.
8. Major claims are linked to explicit evidence.
9. Failed experiments or limitations are included in the manuscript.
10. Workflow validation itself is not treated as the paper’s main contribution.

## Conditions that force blocked or downgrade status

Automatically block or downgrade when any of the following happens:

- Only a literature-only draft is produced, without experiments
- The manuscript describes only the proposed method, with no baseline
- A run trace is mistaken for a research contribution
- Novelty is claimed without evidence
- The results section has no tables or quantitative evidence
- The work depends too heavily on abstract-only evidence
- A toy smoke experiment is treated as the main experimental evidence
- A system validation report is packaged as if it were an experiment paper

## Topic selection rules

A good topic should satisfy most of the following:

- A real experiment is possible even at small scope
- A dataset, task, metric, and baseline are realistically available
- The implementation and execution budget is not excessive
- A meaningful signal could appear in a 1–3 day experiment window
- Related work is not too thin
- A negative result would still be interpretable and worthwhile

## Corpus collection standard

Do not optimize for raw volume alone.
Require coverage across the following axes:

- seminal paper
- recent paper
- baseline paper
- method paper
- evaluation paper
- task or dataset paper

When summarizing the corpus, always record:

- total collected count
- count with full text available
- count that are abstract-only
- whether any topic axis is over- or under-represented
- the core subset that will actually support the downstream experiment

## Hypothesis standard

Every hypothesis must include:

- independent variable
- dependent variable
- expected mechanism
- expected change relative to the baseline
- falsification condition

Bad examples:

- “This approach might be better.”
- “This research is meaningful.”

Good example:

- “Setting X will improve macro-F1 by at least 0.5 points over logistic regression on small tabular classification tasks. If no improvement appears, or runtime cost is too high, the hypothesis is rejected.”

## Experiment design requirements

Must include:

- dataset / task / bench
- objective metric
- baseline / comparator
- ablation or controlled variation
- compute or time budget
- stopping rule
- failure condition
- reproducibility artifact

## Output format

Always include these sections:

1. Research question
2. Why this topic can be tested with a small real experiment
3. Corpus scale and inclusion/exclusion criteria
4. Main related-work axes and research gap
5. Hypothesis and falsification condition
6. Experiment design
7. Baseline / comparator
8. Dataset / task / metric
9. Actually executed experiments
10. Result table and key numbers
11. Failed experiments / negative results
12. Claim-to-evidence mapping
13. Paper-ready decision
14. Reproducibility assets
15. Remaining weaknesses and next iteration

## Review-stage rule

Do not auto-advance to `write_paper` from `review` if any of the following is true:

- No experiment was run on a real external task
- No baseline exists
- No result table exists
- Claim-to-evidence mapping is weak
- Related work is too shallow
- Workflow validation dominates the manuscript

In those cases, mark the outcome as:

- `blocked_for_paper_scale`
- or `downgrade_to_system_validation_note`

## Recommended execution order

1. Narrow the research question
2. Collect a paper-worthy corpus
3. Structure the related work
4. State a falsifiable hypothesis
5. Design a feasible small experiment
6. Implement with a baseline
7. Run the real experiment
8. Analyze results and build tables
9. Organize claim-to-evidence links
10. State limitations and failed experiments
11. Decide whether the work is paper-ready
12. If not, iterate again

## Prohibitions

- Do not declare success just because `write_paper` completed.
- Do not call something an experimental paper without a baseline.
- Do not decorate a results section without real experiments.
- Do not substitute internal workflow artifacts for research contribution.
- Do not package weak evidence as a strong claim.

## Good completion standard

This skill is complete only when:

- the paper-worthy research question is clear
- the corpus is large and deep enough for actual paper writing
- a falsifiable hypothesis exists
- experiments with baseline and ablation were actually run
- quantitative results are organized in tables
- claim-to-evidence links are explicit
- limitations are stated
- the manuscript is honestly judged as either paper-ready or explicitly blocked