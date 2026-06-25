---
name: research-governance-harness
description: "Use when Codex should operate AutoLabOS as a research governance layer: create governed briefs, audit run artifacts, review paper readiness, strengthen weak nodes, or package traceable research bundles."
---

# Research Governance Harness

## When to use

Use this skill when the user wants Codex to run, inspect, repair, or package research work with AutoLabOS governance. This includes brief creation, artifact intake, evidence-gate review, claim-ceiling checks, meta-harness repair planning, and paper-readiness bundle export.

Use it especially when the work may otherwise be mistaken for a complete paper merely because a workflow finished, a draft exists, or a PDF builds.

## Goal

Treat Codex and external tools as execution engines, while AutoLabOS owns the artifact, gate, review, downgrade, and meta-harness contract.

The public contract is artifact-first:

- `ResearchBrief`
- `EvidenceBundle`
- `GateReport`
- `ReviewReport`
- `MetaHarnessPatchPlan`
- `PaperReadinessBundle`

The standalone AutoLabOS TUI/web workflow remains a reference implementation and compatibility shell. It is not the only way to use the governance layer.

## Procedure

1. Classify the request into one command intent.
   - `research:new`: create or repair a governed research brief with objective metric, baseline/comparator, evidence floor, disallowed shortcuts, and failure conditions.
   - `research:audit`: inspect a run or external artifact bundle as untrusted evidence and emit missing-evidence, traceability, and done-condition findings.
   - `research:review`: decide paper readiness, claim ceilings, downgrade class, and upstream repair targets from the available artifacts.
   - `research:improve`: map gate/review failures to the smallest node-local prompt, skill, or validator strengthening plan.
   - `research:pack`: export or describe a portable paper-readiness bundle with provenance, claim evidence, downgrade decisions, and limitations.
2. Load repo-local source-of-truth documents before changing behaviorally significant code:
   - `AGENTS.md`
   - `docs/architecture.md`
   - `docs/experiment-quality-bar.md`
   - `docs/paper-quality-bar.md`
   - `docs/reproducibility.md`
3. Keep external outputs behind the artifact firewall.
   - Imported reports, code runs, reviews, or generated papers are evidence candidates, not trusted conclusions.
   - Missing metrics, baselines, task definitions, seeds, or references must stay missing until artifacts provide them.
4. Preserve review as a structural gate.
   - A completed run, successful draft, compiled PDF, or external agent success is not paper readiness.
   - If evidence is weak, downgrade or backtrack instead of polishing prose.
5. Prefer node-local repair.
   - Strengthen the failing node, prompt, validator, or skill that allowed the bad artifact.
   - Do not redesign the top-level workflow unless the architecture contract explicitly changes.
6. Keep public code and fixtures domain-neutral.
   - Do not hardcode one historical experiment, model, dataset, benchmark, condition marker, or run id into source, tests, docs, or plugin examples.
   - Keep concrete experiment identifiers inside run artifacts or user-provided inputs.
7. Validate the smallest honest surface before reporting completion.
   - Public-code hygiene changes should keep `tests/publicCodeSanitization.test.ts` passing.
   - Runtime or harness changes should run the focused tests plus `npm run build` when shipped TypeScript changes.
   - Harness contract changes should include `npm run validate:harness` when applicable.

## Output Format

For substantial work, report:

- command intent used
- artifacts inspected or created
- gate verdicts and downgrade class
- node or contract strengthened
- files changed
- validation commands and results
- remaining evidence gaps

## Common Failure Modes

- Treating a finished workflow as a finished research contribution.
- Treating a paper-shaped draft or compiled PDF as paper readiness.
- Letting an external research system bypass AutoLabOS gates.
- Inventing missing baselines, metrics, sample sizes, seeds, references, or uncertainty estimates.
- Adding one-off experiment identifiers to public source, tests, docs, or plugin examples.
- Repairing broad orchestration when the actual failure is a node-local prompt or validator gap.
- Applying meta-harness changes without validation and rollback expectations.

## Update Rule

Update this skill when a repeated research-governance failure reveals a reusable gate, artifact field, downgrade rule, public-code hygiene rule, or node-strengthening pattern. Keep project-specific experiment details out of the skill; store them only in run artifacts or task-local notes.
