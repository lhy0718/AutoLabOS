---
name: tui-live-validation
description: Use this skill when the task is to run or analyze real TUI validation, reproduce an interactive issue, compare a fresh session against an existing one, or produce a structured validation report before proposing a fix.
---

# TUI Live Validation

## Purpose

Produce a structured validation result for a real TUI workflow before proposing or evaluating a code change.

## When to use this skill

Use this skill when the user wants to:

- run real TUI validation
- reproduce an interactive bug
- compare a fresh TUI session with an already running session
- verify whether persisted output matches what the UI shows
- confirm whether a fix actually solved the live symptom

Typical trigger phrases:

- “TUI live validation”
- “run live validation”
- “reproduce the interactive bug”
- “compare it with a fresh session”
- “only the existing session is stale”
- “run it for real and check”
- “the screen output looks wrong”

## Output format

Always produce these sections:

1. Validation target
2. Environment / session context
3. Reproduction steps
4. Expected behavior
5. Actual behavior
6. Fresh session vs existing session comparison
7. Persisted artifact vs UI comparison
8. Most likely failure area
9. Recommended next step

## Method

1. Restate the validation target in one sentence.
2. Identify the relevant flow, command, session mode, or screen.
3. Reproduce the behavior or inspect the evidence provided.
4. Record the exact steps and observations.
5. Compare:
   - fresh session behavior
   - existing session behavior
   - persisted artifacts
   - top-level summary or projection shown on screen
6. Classify the issue into one dominant category:
   - persistence bug
   - loader bug
   - projection / aggregation bug
   - refresh / subscription bug
   - resume / session bug
   - timing / race bug
   - renderer-only bug
7. Recommend the next action:
   - boundary investigation
   - patch
   - instrumentation
   - rerun with a narrower hypothesis

## Guardrails

- Do not jump into a fix before writing the validation record.
- Do not assume the live UI is correct just because persisted state is correct.
- If a fresh reopen resolves the issue, explicitly suspect in-memory projection, refresh wiring, resume handling, or session-local cache.
- Separate observed facts from hypotheses.
- Prefer precise reproduction records over broad conclusions.

## Good completion standard

This skill is complete when:

- the symptom is described clearly enough for another agent to reproduce
- fresh-session and existing-session behavior are explicitly compared when relevant
- persisted state and displayed UI state are explicitly compared when relevant
- the most likely failing boundary has been narrowed down