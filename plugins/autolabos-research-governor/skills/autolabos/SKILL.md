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
- `ModelReviewBundle`
- `MetaHarnessPatchPlan`
- `PaperReadinessBundle`

The standalone AutoLabOS TUI/web workflow remains a reference implementation and compatibility shell. It is not the only way to use the governance layer.

## Procedure

1. Classify the request into one command intent.
   - `research:new`: create or repair a governed research brief with objective metric, baseline/comparator, evidence floor, disallowed shortcuts, and failure conditions.
   - `research:audit`: inspect a run or external artifact bundle as untrusted evidence and emit missing-evidence, traceability, and done-condition findings.
   - `research:review`: run deterministic gates first, then review paper readiness, claim ceilings, downgrade class, and upstream repair targets from the bound artifacts.
   - `research:improve`: map gate/review failures to the smallest node-local
     prompt, skill, validator, policy, or runtime strengthening plan.
   - `research:pack`: export or describe a portable paper-readiness bundle with provenance, claim evidence, downgrade decisions, and limitations. Before distribution, run `research verify-pack --root <bundle-dir>` and require a passing closed-inventory, hash, portability, and artifact-binding inspection.
   - `research verify-milestone` (cross-intent verification mode): verify every requirement in a long-running research contract against hash-bound artifacts and JSON assertions. Keep the goal active and follow the grouped node targets while any required evidence remains missing, unbound, rewritten, or assertion-failing.
2. For executable intent work, run the bundled `scripts/run-research-intent.mjs --check` bridge first. The bridge delegates to `autolabos research <new|audit|review|improve|pack|verify-pack|verify-milestone>` and must emit a blocking `GateReport` rather than fabricate output when the CLI dependency is unavailable.
3. On first use inside the AutoLabOS repository, inspect the plugin contract with `npm run plugin:contract`, run `npm run plugin:dogfood`, and use `npm run plugin:doctor` when checking whether the installed Codex plugin cache matches the repo-local contract. Use `npm run plugin:doctor -- --strict` for CI or release checks that should fail on cache drift, `npm run plugin:discovery-check` on a Codex-enabled workstation to verify local installation, enablement, version, source, cache, and skill alignment, `npm run validate:plugin-bridge` for deterministic bridge acceptance, `npm run validate:plugin-bridge:local` for the installed-cache research chain, `npm run validate:plugin-faults` for blocking-path coverage, `npm run validate:plugin-hermetic` for an isolated cache lifecycle, `npm run validate:plugin-operations` for the CI aggregate, `npm run validate:plugin-operations:local` for the workstation aggregate, `npm run plugin:sync-cache` for dry-run cache refresh planning, and `npm run plugin:release-check` before release. Treat a passing dogfood or release-check report as plugin-contract coherence only, not as research completion.
4. Load repo-local source-of-truth documents before changing behaviorally significant code:
   - `AGENTS.md`
   - `docs/architecture.md`
   - `docs/experiment-quality-bar.md`
   - `docs/model-review-protocol.md`
   - `docs/paper-quality-bar.md`
   - `docs/reproducibility.md`
5. Keep external outputs behind the artifact firewall.
   - Imported reports, code runs, reviews, or generated papers are evidence candidates, not trusted conclusions.
   - Missing metrics, baselines, task definitions, seeds, or references must stay missing until artifacts provide them.
   - Bind every available copied or audited input by portable path, SHA-256, and byte length. A changed manuscript or evidence file requires a fresh `EvidenceBundle`, `GateReport`, and model panel.
   - For large human review assignments, resumable candidate and source-license workspaces may split blank templates into per-item files and report structural progress. They must never supply labels or license decisions, set human attestations, infer reviewer identity or legal authority, grant redistribution permission, or bypass the packet-bound return preflight.
   - For citation-claim review, use the governed `reference-review prepare -> distribute-private -> package-private -> verify-private-package -> preflight -> import` path. A reviewer may insert `prepare-workspace -> audit-workspace -> finalize-workspace` after package verification to resume per-task work, but the workspace and extracted full text remain private. Require the receiver to rerun package verification after transfer. Treat deterministic packaging, workspace progress, and fresh-extraction verification as transport or structural integrity only, never as redistribution permission, human judgment, reviewer identity, attestation, or claim approval. Never generate the human review or final approval. Import only an all-supported, hash-bound return with explicit human approval, keep the canonical claims file unchanged, and require a separate Refgate submission audit before adoption.
   - Candidate, reference, and license work may be performed as model screening or model adjudication only in a separate `A1` or `A2` artifact that identifies the reviewer as a model and leaves every human field unset. Citation support requires direct reading of bound full text plus a precise evidence location. License screening requires direct public license evidence; otherwise keep the material `local_only` or `uncertain` and do not infer redistribution permission.
6. Apply the authority hierarchy from `docs/model-review-protocol.md`.
   - `A0 deterministic` owns mechanical blockers and the maximum claim/readiness ceiling.
   - `A1 model advisory` may critique, screen, and recommend repairs without mutating gates.
   - `A2 model conservative` may preserve or add blockers, lower readiness within the deterministic ceiling, or route work, but cannot clear an `A0` blocker, change the deterministic ceiling, create missing external evidence, create human attestation, or create legal or redistribution permission.
   - `A3 human authority` remains a separate identified and hash-bound human artifact. Model review is never labeled as human review.
7. For `research:review`, use the governed multi-agent protocol whenever the user requests multi-agent review or the target is paper-scale.
   - Select the strongest available frontier model and highest available reasoning tier under the active provider/runtime policy, and record requested and effective model, provider, reasoning, and execution provenance.
   - Run five initial roles in parallel: `claim_evidence`, `methodology`, `statistics`, `reproducibility`, and `adversarial`.
   - Give each role the same closed inventory: the exact `GateReport`, exact
     `EvidenceBundle`, and every required `GateReport.input_bindings` path.
     Do not share any initial reviewer output with another initial reviewer.
   - After all five outputs are validated and hashed, run a separate meta reviewer. Bind it to the exact gate and all five output hashes, preserve disagreements, and emit the reconciliation as a `ModelReviewBundle` with at most `A2` authority.
   - Preserve every specialist record in `ModelReviewBundle`, but project only findings explicitly adopted by the meta reviewer into `ReviewReport`, readiness, and repair targets. Record raw specialist and adjudicated finding counts.
   - Fail closed on missing roles, provenance, isolation, exact gate or evidence
     binding, an omitted bound input, or meta reconciliation. Partial outputs
     remain non-promoting `A1` advice.
   - Keep model review and human review as separate artifacts. Never generate the human review or final approval.
8. Preserve review as a structural gate.
   - A completed run, successful draft, compiled PDF, or external agent success is not paper readiness.
   - If evidence is weak, downgrade or backtrack instead of polishing prose.
   - Missing, malformed, or intentionally ablated figure-audit evidence cannot
     authorize manuscript promotion and must not be represented as a successful
     zero-count measurement.
9. Prefer node-local repair.
   - Strengthen the failing node, prompt, validator, or skill that allowed the bad artifact.
   - Do not redesign the top-level workflow unless the architecture contract explicitly changes.
10. Keep public code and fixtures domain-neutral.
   - Do not hardcode one historical experiment, model, dataset, benchmark, condition marker, or run id into source, tests, docs, or plugin examples.
   - Keep concrete experiment identifiers inside run artifacts or user-provided inputs.
11. For plugin or governance-skill changes, dogfood the plugin against its own artifacts.
   - Run `npm run plugin:dogfood` from the repository root.
   - Treat any failed self-dogfood check as a `research:improve` finding and repair the smallest plugin-local artifact first.
   - Reinstall or restart the Codex thread when changing installed skill behavior.
12. Validate the smallest honest surface before reporting completion.
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
- Publishing a private reference-review archive or treating archive integrity as source-license approval.
- Treating reference-review preflight as canonical claim approval, or fabricating the human review or final approval needed for import.
- Treating a resumable review workspace as completed human evidence, or auto-filling labels, license decisions, or attestations.
- Treating `A1` or `A2` model output as human review, final approval, external evidence, or redistribution permission.
- Letting initial reviewers see peer outputs, omitting model/provider/reasoning/execution provenance, or reconciling against a different gate hash.
- Allowing a meta reviewer to erase deterministic blockers, promote the deterministic ceiling, or hide disagreement.
- Importing every raw specialist finding directly into `ReviewReport` instead of using the meta reviewer's adopted disposition.
- Reusing a gate or model panel after manuscript or evidence bytes changed, or promoting without a measured figure audit.
- Marking a citation supported without direct full-text reading and an evidence location, or marking redistribution permitted without direct public license evidence.
- Adding one-off experiment identifiers to public source, tests, docs, or plugin examples.
- Treating an evidence path or a successful command from an earlier session as current milestone proof without a bound hash and passing assertion.
- Repairing broad orchestration when the actual failure is a node-local prompt or validator gap.
- Applying meta-harness changes without validation and rollback expectations.
- Distributing a paper-readiness bundle without independently rechecking its closed inventory and artifact bindings.

## Update Rule

Update this skill when a repeated research-governance failure reveals a reusable gate, artifact field, downgrade rule, public-code hygiene rule, or node-strengthening pattern. Keep project-specific experiment details out of the skill; store them only in run artifacts or task-local notes.
