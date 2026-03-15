# AGENTS.md

## Mission

This repository builds and validates a 9-node research workflow that runs through real TUI/web interactions, produces evidence-grounded artifacts, and, when the bar is met, reaches paper-ready outputs.

Always prioritize:

1. Correct interactive behavior
2. State and artifact consistency
3. Reproducible validation
4. Honest scientific writing that does not exceed the evidence
5. Paper-readiness only when the minimum experimental bar is actually met

---

## Source of Truth

For detailed policy, defer to these documents first:

- `docs/architecture.md`
- `docs/tui-live-validation.md`
- `docs/experiment-quality-bar.md`
- `docs/paper-quality-bar.md`
- `docs/reproducibility.md`
- `docs/live-validation-issue-template.md`
- `docs/research-brief-template.md`

Keep this file short, high-signal, and operational.
Use the docs above as the canonical source for detailed rules.

---

## Working Rules

- Plan briefly before editing when the issue is complex.
- Do not claim a fix is complete until the same validation flow has been re-run.
- Record live-validation issues in `ISSUES.md` with reproduction steps, expected behavior, actual behavior, session comparison, root-cause hypothesis, and regression status.
- Lower the strength of any claim that is not backed by explicit evidence.
- Do not change the 9-node flow, TUI/web UX contract, or runtime boundaries unless the task explicitly requires it.
- Do not present partial success as full completion.
- Do not mark unverified improvements as done.

---

## Do Not Confuse System Completion with Research Completion

These are not equivalent:

- workflow completed
- `write_paper` completed
- PDF build succeeded
- paper-ready experimental manuscript

The first three may indicate that the system ran successfully.
They do not, by themselves, mean the work is submission-ready.

For an experimental paper target, require at least:

- a clear research question
- a paper-worthy related-work corpus
- a falsifiable hypothesis
- a baseline or comparator
- real executed experiments
- quantitative result tables
- explicit claim-to-evidence mapping
- limitations or failure modes

If that bar is not met, downgrade the output explicitly, for example as:

- `paper_ready=false`
- `blocked_for_paper_scale`
- `system_validation_note`
- `research_memo`

---

## Interactive Bug Taxonomy

Every live-validation issue must name one dominant root-cause class:

- `persisted_state_bug`
- `in_memory_projection_bug`
- `refresh_render_bug`
- `resume_reload_bug`
- `race_timing_bug`

---

## Research Quality Rules

- Do not substitute workflow artifacts for research contributions.
- Do not use toy smoke experiments as primary experimental evidence.
- Do not claim an experimental paper without a baseline or comparator.
- Do not over-rely on abstract-only evidence.
- Negative results are acceptable, but they still require real evidence and honest interpretation.
- If the experiment is not strong enough, explicitly lower the genre of the output.

---

## Review Is a Gate, Not a Polish Pass

`review` is not just a writing cleanup step.
It is a structural gate for:

- readiness
- methodology sanity
- experiment adequacy
- evidence linkage
- writing discipline
- reproducibility handoff

Do not allow automatic progression to `write_paper` unless the work includes:

- a baseline or comparator
- a result table or equivalent quantitative comparison
- claim-to-evidence mapping
- evidence that real experiments were executed
- minimum acceptable related-work depth

---

## Research Brief Contract

A brief created from `/new` is not just an idea note.
It is the execution contract for a real research run.

Every brief must include:

- Topic
- Objective Metric
- Constraints
- Plan
- Research Question
- Why This Can Be Tested With a Small Real Experiment
- Baseline / Comparator
- Dataset / Task / Bench
- Minimum Experiment Plan
- Paper-worthiness Gate
- Failure Conditions

---

## ISSUES.md Expectations

`ISSUES.md` is not only a bug list.
It is also the running log for validation status and research-completion risk.

Keep these categories distinct:

- live validation issues
- research completion risks
- paper readiness risks

---

## Definition of Done

Do not report work as done unless:

- the issue was reproduced
- the same flow was re-run after the change
- the original symptom no longer reproduces
- relevant tests, smoke checks, or live validation were re-run
- key artifacts were checked for consistency
- adjacent regression risk was reviewed
- remaining risks were stated in the final summary

For experimental-paper targets, also require:

- executed experiments with a baseline
- quantitative results
- clear claim-to-evidence linkage
- passing the review gate, or an explicit blocked decision