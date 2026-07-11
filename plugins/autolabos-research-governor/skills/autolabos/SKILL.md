---
name: autolabos
description: "Use when Codex should operate AutoLabOS as a research governance layer: create governed briefs, audit run artifacts, review paper readiness, strengthen weak nodes, or package traceable research bundles."
---

# AutoLabOS

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
2. For executable intent work, run the bundled `scripts/run-research-intent.mjs --check` bridge first. The bridge delegates to `autolabos research <new|audit|review|improve|pack>` and must emit a blocking `GateReport` rather than fabricate output when the CLI dependency is unavailable.
3. On first use inside the AutoLabOS repository, inspect the plugin contract with `npm run plugin:contract`, run `npm run plugin:dogfood`, and use `npm run plugin:doctor` when checking whether the installed Codex plugin cache matches the repo-local contract. Use `npm run plugin:doctor -- --strict` for CI or release checks that should fail on cache drift, `npm run plugin:discovery-check` on a Codex-enabled workstation to verify local installation, enablement, version, source, cache, and skill alignment, `npm run validate:plugin-bridge` for deterministic bridge acceptance, `npm run validate:plugin-bridge:local` for the installed-cache research chain, `npm run validate:plugin-faults` for blocking-path coverage, `npm run validate:plugin-hermetic` for an isolated cache lifecycle, `npm run validate:plugin-operations` for the CI aggregate, `npm run validate:plugin-operations:local` for the workstation aggregate, `npm run plugin:sync-cache` for dry-run cache refresh planning, and `npm run plugin:release-check` before release. Treat a passing dogfood or release-check report as plugin-contract coherence only, not as research completion.
4. Load repo-local source-of-truth documents before changing behaviorally significant code:
   - `AGENTS.md`
   - `docs/architecture.md`
   - `docs/experiment-quality-bar.md`
   - `docs/paper-quality-bar.md`
   - `docs/reproducibility.md`
5. Keep external outputs behind the artifact firewall.
   - Imported reports, code runs, reviews, or generated papers are evidence candidates, not trusted conclusions.
   - Missing metrics, baselines, task definitions, seeds, or references must stay missing until artifacts provide them.
6. Preserve review as a structural gate.
   - A completed run, successful draft, compiled PDF, or external agent success is not paper readiness.
   - If evidence is weak, downgrade or backtrack instead of polishing prose.
7. Prefer node-local repair.
   - Strengthen the failing node, prompt, validator, or skill that allowed the bad artifact.
   - Do not redesign the top-level workflow unless the architecture contract explicitly changes.
8. Keep public code and fixtures domain-neutral.
   - Do not hardcode one historical experiment, model, dataset, benchmark, condition marker, or run id into source, tests, docs, or plugin examples.
   - Keep concrete experiment identifiers inside run artifacts or user-provided inputs.
9. For plugin or governance-skill changes, dogfood the plugin against its own artifacts.
   - Run `npm run plugin:dogfood` from the repository root.
   - Treat any failed self-dogfood check as a `research:improve` finding and repair the smallest plugin-local artifact first.
   - Reinstall or restart the Codex thread when changing installed skill behavior.
10. Validate the smallest honest surface before reporting completion.
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
