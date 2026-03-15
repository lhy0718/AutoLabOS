---
name: stale-state-triage
description: Use this skill when the issue involves stale UI state, a stale top-level summary, refresh mismatch, resume mismatch, or inconsistency between persisted artifacts and the active interactive session.
---

# Stale State Triage

## Purpose

Narrow a stale-state bug down to the smallest plausible failure boundary before implementing a fix.

## When to use this skill

Use this skill for issues such as:

- stale top-level summaries
- newly persisted output is not reflected in the UI
- a fresh session looks correct, but an existing session remains stale
- resume or reopen behavior differs from live session behavior
- state drift exists between persisted data and the rendered view

Typical trigger phrases:

- “stale”
- “the top-level summary is not updating”
- “it looks correct when reopened fresh”
- “only the existing session is wrong”
- “runs.json is correct but the UI is wrong”
- “this looks like a refresh-path problem”
- “this looks like an in-memory projection issue”

## Required output

Always provide:

1. Symptom summary
2. Source-of-truth state
3. Session comparison
4. Most likely failure boundary
5. Evidence supporting that boundary
6. Lowest-risk fix direction
7. Regression risk

## Boundary model

Use the following boundary model to narrow the bug:

- persisted artifact layer
- loader / read layer
- projection / aggregation layer
- refresh / subscription / invalidation layer
- session resume / restore layer
- renderer presentation layer
- timing / race boundary between layers

## Method

1. Identify the changed source of truth.
2. Check whether the persisted artifact reflects that new truth.
3. Check whether a fresh process or session displays that truth.
4. Check whether only the currently running session remains stale.
5. Determine which boundary most likely failed to propagate the update.
6. State the strongest evidence explicitly.
7. Recommend the lowest-risk fix direction.

## Fix-direction priority

Prefer fix directions in this order:

1. missing refresh trigger
2. stale in-memory projection invalidation
3. resume / restore state refresh
4. loader refresh bug
5. renderer consumption bug
6. persistence bug

Do not jump to “persistence corruption” unless the evidence truly supports it.

## Guardrails

- Avoid vague phrases like “it seems like some sync issue.”
- Name the failed boundary as specifically as possible.
- Separate evidence from inference.
- If a fresh reopen fixes the issue, prefer refresh, projection, resume, or cache-local explanations before assuming persistence corruption.
- Prefer a narrowly scoped patch over a cross-layer rewrite.

## Good completion standard

This skill is complete when:

- one dominant failure boundary has been identified
- that choice is supported by evidence
- the recommended patch direction is small and testable
- plausible regression risks are explicitly named