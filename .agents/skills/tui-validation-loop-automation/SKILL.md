---
name: tui-validation-loop-automation
description: Use this skill when the task is to repeatedly run real TUI validation inside test/ workspaces, log issues, apply the smallest possible fix, re-validate, and keep ISSUES.md updated as part of an automation loop.
---

# TUI Validation Loop Automation

## Purpose

Run a repeated live-validation loop in a `test/` workspace: reproduce the issue, record it structurally in `ISSUES.md`, apply the smallest plausible fix, re-run the same flow, and check adjacent regressions.

The core principle is to prioritize a **live-validation-based reproduce → record → re-validate loop** over “just fixing the code.”

Important: the primary goal of this skill is **real TUI / workflow / state / artifact consistency validation**.

`cycle completed`, `write_paper completed`, and `PDF built successfully` only mean the system run finished.
They do **not** mean the work has reached paper-ready research quality.

If the goal includes experimental-paper quality output, this skill must be used together with `paper-scale-research-loop`.

## When to use this skill

Use this skill for requests like:

- “Keep repeating TUI live validation.”
- “Automate the TUI validation loop until the issue is solved.”
- “Repeat validate → fix → re-validate inside test/.”
- “Run the live-validation loop while updating ISSUES.md.”
- “Keep comparing fresh and existing sessions in the loop.”
- “Use the real TUI as ground truth and keep narrowing the stuck point.”

Typical trigger phrases:

- “validation loop automation”
- “repeat TUI validation”
- “live-validation cycle”
- “reproduce, fix, and validate again”
- “update ISSUES.md while doing it”
- “test/-based live validation”

## What this skill does not guarantee

This skill alone does not guarantee:

- academic validity of the research topic
- corpus adequacy at paper-writing scale
- quality of falsifiable hypotheses
- sufficiency of experiment design with baselines or ablations
- a paper-ready manuscript with numerical results and tables

If those goals matter, use `paper-scale-research-loop` together with this skill.

## Default working-directory rule

- Live-validation workspaces must live under `test/`.
- Temporary research workspaces, artifacts, logs, and execution traces created during live validation must also be managed under `test/`.
- Application source changes may be applied to the main source tree, but the validation run itself must be executed from the `test/` context.

Examples:

- `test/tui-live-cycle--iterN`
- `test/live-loop`
- `test/validation`

## Loop contract

One iteration must always follow this order:

1. **Fix the validation target**
   - Lock the flow being checked in one sentence.
   - Example: `/new -> /brief start --latest -> implement_experiments -> run_experiments`

2. **Collect current state**
   - session type (fresh / existing)
   - workspace path
   - run id
   - relevant artifacts
   - current screen symptom
   - latest failure point

3. **Reproduce for real**
   - Reproduce with the same command sequence and conditions whenever possible.
   - Leave steps detailed enough that another agent can follow them exactly.

4. **Record structurally**
   - Append a structured entry to `ISSUES.md`.

   Required fields:

   - Validation target
   - Environment / session context
   - Reproduction steps
   - Expected behavior
   - Actual behavior
   - Fresh vs existing session comparison
   - Artifact vs UI comparison
   - Root cause hypothesis
   - Code/test changes
   - Regression status
   - Follow-up risks

5. **Classify the issue**
   - Always assign one dominant class:
     - `persisted_state_bug`
     - `in_memory_projection_bug`
     - `refresh_render_bug`
     - `resume_reload_bug`
     - `race_timing_bug`

6. **Apply the smallest fix**
   - Fix only the smallest plausible failure boundary.
   - Broad refactors, UX contract changes, and state-model redesigns are prohibited.
   - The purpose of the edit is to narrow the current loop’s single failure boundary.

7. **Strengthen tests**
   - Add a unit or regression test for that boundary when feasible.
   - Do not treat test coverage as a replacement for live validation.

8. **Re-validate the same flow**
   - Re-run the exact same flow.
   - Judge success only from the rerun result.

9. **Check adjacent regressions**
   - Inspect nearby flows such as resume, fresh session, screen refresh, and artifact reflection.

10. **Decide whether to continue**
    - success: move to the next bottleneck
    - failure: continue on the same issue with a narrower hypothesis
    - uncertainty: add instrumentation, then repeat

## Output format

Summarize every iteration with these sections:

1. Iteration target
2. Workspace / session context
3. Actual steps executed
4. Expected behavior
5. Actual behavior
6. Fresh vs existing comparison
7. Artifact vs UI comparison
8. Root-cause hypothesis
9. Applied fix
10. Added or updated tests
11. Re-validation result
12. Remaining risks
13. Next-iteration decision

## ISSUES.md update rule

- Treat `ISSUES.md` as an append-only live-validation log.
- Instead of deleting old entries:
  - add a new iteration log
  - update status (`open`, `re-validating`, `blocked`, `fixed`)
  - accumulate related code/test changes and re-validation results
- Do not write “fixed.”
  Write **“not reproduced in re-validation of the same flow”** instead.

## Fresh vs existing session rule

Do not skip the comparison when:

- the issue appears stale only in an existing session
- the display becomes wrong after resume
- the artifact is correct but the UI summary is wrong
- restarting makes the symptom disappear
- refresh / subscription / projection issues are suspected

When comparing, always record:

- fresh session result
- existing session result
- whether divergence exists
- the step where divergence begins

## Artifact vs UI comparison rule

Always separate:

- persisted artifact
- runtime in-memory state
- top-level UI summary
- detailed screen / detailed output

Do not make either of these assumptions:

- “the artifact is correct, so the UI must also be correct”
- “the screen looks correct, so persisted state must also be correct”

## Allowed fix priority

Prefer fixes in this order:

1. boundary-condition fix
2. resume / load path fix
3. projection / aggregation fix
4. refresh / render wiring fix
5. minimal instrumentation

Be cautious with:

- large state-structure changes
- slash-command contract changes
- changing the meaning of the 9-node workflow
- changing the TUI/web UX contract

## Prohibitions

- Do not patch before reproduction.
- Do not create temporary validation workspaces outside `test/`.
- Do not declare success from passing tests alone without live validation.
- Do not mix observations with speculation.
- Do not fix multiple failure boundaries at once.
- Do not slip in unrelated refactors.
- Do not declare paper-readiness just because `write_paper` completed.

## Good completion standard

A loop for one issue may stop only when:

- the symptom has been recorded in reproducible form
- the failure boundary has been narrowed to one dominant class
- the smallest plausible fix has been applied
- relevant tests were added or updated
- the same TUI flow no longer reproduces the issue in re-validation
- adjacent flows show no critical regression
- `ISSUES.md` records the reproduction, fix, re-validation, and remaining risks

## Recommended execution attitude

- Do not try to fix everything at once; reduce the bottleneck one layer at a time.
- Every iteration should leave behind “what was learned.”
- Failed iterations still have value and must feed the next hypothesis.
- If research completeness is also a goal, always invoke `paper-scale-research-loop` together with this skill.