---
name: autolabos
description: "Use when Codex should operate AutoLabOS as a research governance layer: create governed briefs, discover paper topics inside the fixed workflow, audit run artifacts, review paper readiness, strengthen weak nodes, or package traceable research bundles."
---

# AutoLabOS

## When to use

Use this skill when the user wants Codex to run, inspect, repair, or package research work with AutoLabOS governance. This includes brief creation, workflow-native paper-topic discovery, artifact intake, evidence-gate review, claim-ceiling checks, meta-harness repair planning, and paper-readiness bundle export.

Use it especially when the work may otherwise be mistaken for a complete paper merely because a workflow finished, a draft exists, or a PDF builds.

## Goal

Treat Codex and external tools as execution engines, while AutoLabOS owns the artifact, gate, review, downgrade, and meta-harness contract.

The public governance contract is artifact-first:

- `ResearchBrief`
- `EvidenceBundle`
- `GateReport`
- `ReviewReport`
- `MetaHarnessPatchPlan`
- `PaperReadinessBundle`

Workflow-native discovery emits a separate artifact class:

- `ResearchGapMap`
- `TopicPortfolio`
- `TopicProbeDecision`
- `ActiveTopicProbeContract`
- `VenueViabilityReport`

`ModelReviewBundle` is a review sidecar. `PluginDependencyReport` is an
operational artifact and cannot substitute for research evidence.

The standalone AutoLabOS TUI/web workflow remains a reference implementation and compatibility shell. It is not the only way to use the governance layer.

## Procedure

1. Classify the request as an executable CLI intent or a workflow-native intent.
   - Executable CLI intents are `research:new`, `research:audit`, `research:review`, `research:improve`, and `research:pack`.
   - `research:discover` is a workflow-native intent. It is not an `autolabos research discover` command and must not be routed through `scripts/run-research-intent.mjs`.
2. For `research:discover`, require a complete discovery-scoped `ResearchBrief` before exploration starts. If the brief is incomplete, use `research:new` to repair it first.
   - Set `Research Mode` to `topic_discovery`. Completeness in this mode means the brief owns the broad search scope, resource limits, evidence floor, and disallowed shortcuts. It does not require the user to preselect a final topic, primary metric, metric direction, meaningful-effect boundary, comparator, or dataset/task.
   - Treat any brief-level objective metric, comparator, or dataset/task entry as a candidate-selection rule or admissibility boundary, not as the final experiment contract.
   - Keep discovery inside the existing reference workflow: `collect_papers -> analyze_papers -> generate_hypotheses -> design_experiments`.
   - `collect_papers` gathers the brief-bounded literature corpus. Preserve the retrieved candidate universe, lexical paper-family universe, semantic reviewer universe, and bounded retained corpus as separate hash-bound stages. Compute semantic precision before applying the final corpus cap. A partial or unavailable semantic reviewer triggers a reviewer-only retry; it must not revise query feedback or teach the planner from an incomplete judgment set.
   - Every query family owns a stable contract fingerprint derived from its query, shared anchor, axis terms, scientific lens, and contribution intent. Do not inherit support counts or reformulation feedback across a changed family contract.
   - `analyze_papers` emits `ResearchGapMap`, preserving evidence links, `opportunity_type`, and the epistemic status of each research-opportunity candidate. Admit only five typed routes: `explicit_limitation`, `cross_paper_result_disagreement`, `boundary_or_transfer_mismatch`, `missing_comparator_or_control`, and `reproducibility_gap`.
   - Every opportunity type requires grounded full-text spans from at least two independent canonical works, its own deterministic support rule, and all required adversarial reviewer conditions. Shared topic words, empty fields, source-visibility caveats, different task/metric frames, or an unconditioned model `accept` response cannot establish an opportunity.
   - `generate_hypotheses` emits `TopicPortfolio` with 5-7 candidates across at least 3 distinct nonempty evidence-axis clusters.
   - Every candidate owns its `primary_metric`, explicit `metric_unit`, numeric `metric_scale`, `metric_direction`, structured `effect_criterion`, comparator, dataset/task, falsifier, kill signal, and local budget, plus closest-prior non-overlap, the strongest-baseline absorption objection, and minimum publishable evidence. `meaningful_effect` may explain the boundary to a reader, but it is not the machine-readable decision contract.
   - Require `effect_criterion` to bind `basis=delta_vs_reference`, a finite nonnegative numeric magnitude, an explicit scale, and an inclusive/exclusive boundary. Do not reconstruct these fields from prose after candidate authorization.
   - `design_experiments` validates the portfolio, emits `TopicProbeDecision`, and selects exactly one candidate into `active_topic_probe_contract.json`. That `ActiveTopicProbeContract` binds the portfolio and active candidate by SHA-256; every non-active authorized candidate remains explicitly `deferred`.
   - Freeze the active candidate into `ResultsPlanV2.primary_comparison_id` and `ResultsPlanV2.primary_effect_criterion`. Bind the exact subject/reference comparison to the raw metric, unit/scale semantics, direction, and inclusive/exclusive threshold. Preserve this binding through `ExperimentContract`, analysis, review, and writing; do not promote a merely favorable but sub-threshold delta.
   - The discovery intent ends at closed-chain probe authorization after that single-candidate handoff succeeds.
   - Probe authorization permits only a `bounded_probe` in the downstream workflow. Probe output is screening evidence, not paper claim evidence. A bounded probe is not final topic selection, research completion, or paper readiness.
   - After a valid bounded-probe outcome, require a recomputable `VenueViabilityReport` scoped to the active candidate. Keep top-tier readiness `blocked` or `unresolved`, report confirmatory candidacy separately, and preserve `top_tier_ready=false`, `acceptance_likelihood_assessed=false`, and `current_evidence_ceiling=screening_only`. The report cannot authorize a transition, but `confirmatory_candidacy=unsupported` must veto a stale confirmatory route.
   - A failed authorization backtracks to `generate_hypotheses`; it does not create a new top-level node or bypass the fixed workflow.
3. For executable CLI intent work, select the matching contract.
   - `research:new`: create or repair a governed research brief with objective metric, baseline/comparator, evidence floor, disallowed shortcuts, and failure conditions. For `topic_discovery`, encode these as selection rules and admissibility boundaries rather than pretending a final candidate contract already exists.
   - `research:audit`: inspect a run or external artifact bundle as untrusted evidence and emit missing-evidence, traceability, and done-condition findings.
   - `research:review`: run deterministic gates first, then review paper readiness, claim ceilings, downgrade class, and upstream repair targets from the bound artifacts.
   - `research:improve`: map gate/review failures to the smallest node-local
     prompt, skill, validator, policy, or runtime strengthening plan.
   - `research:pack`: export or describe a portable paper-readiness bundle with provenance, claim evidence, downgrade decisions, and limitations. Before distribution, run `research verify-pack --root <bundle-dir>` and require a passing closed-inventory, hash, portability, and artifact-binding inspection.
   - `research verify-milestone` (cross-intent verification mode): verify every requirement in a long-running research contract against hash-bound artifacts and JSON assertions. Keep the goal active and follow the grouped node targets while any required evidence remains missing, unbound, rewritten, or assertion-failing.
4. For executable intent work, run the bundled `scripts/run-research-intent.mjs --check` bridge first. The bridge delegates to `autolabos research <new|audit|review|improve|pack|verify-pack|verify-milestone>` and must emit a blocking `PluginDependencyReport`, not a research `GateReport`, when the CLI dependency is unavailable.
5. On first use inside the AutoLabOS repository, inspect the plugin contract with `npm run plugin:contract`, run `npm run plugin:dogfood`, and use `npm run plugin:doctor` when checking whether the installed Codex plugin cache matches the repo-local contract. Use `npm run plugin:doctor -- --strict` for CI or release checks that should fail on cache drift, `npm run plugin:discovery-check` on a Codex-enabled workstation to verify local installation, enablement, version, source, cache, and skill alignment, `npm run validate:plugin-bridge` for deterministic bridge acceptance, `npm run validate:plugin-bridge:local` for the installed-cache research chain, `npm run validate:plugin-faults` for blocking-path coverage, `npm run validate:plugin-hermetic` for an isolated cache lifecycle, `npm run validate:plugin-operations` for the CI aggregate, `npm run validate:plugin-operations:local` for the workstation aggregate, `npm run plugin:sync-cache` for dry-run cache refresh planning, and `npm run plugin:release-check` before release. Treat a passing dogfood or release-check report as plugin-contract coherence only, not as research completion.
6. Load repo-local source-of-truth documents before changing behaviorally significant code:
   - `AGENTS.md`
   - `docs/architecture.md`
   - `docs/experiment-quality-bar.md`
   - `docs/model-review-protocol.md`
   - `docs/paper-quality-bar.md`
   - `docs/reproducibility.md`
7. Keep external outputs behind the artifact firewall.
   - Imported reports, code runs, reviews, or generated papers are evidence candidates, not trusted conclusions.
   - Missing metrics, baselines, task definitions, seeds, or references must stay missing until artifacts provide them.
   - Bind every available copied or audited input by portable path, SHA-256, and byte length. A changed manuscript or evidence file requires a fresh `EvidenceBundle`, `GateReport`, and model panel.
   - When a claim cites code, tests, or other files outside the external artifact root, require both `--support-root` and a schema `1.0` `--support-manifest` that binds each portable relative path by lowercase SHA-256 and byte length. Reject path escape, symlinks, collisions, missing files, hash drift, size drift, and any copied file omitted from the resulting closed evidence inventory.
   - For large human review assignments, resumable candidate and source-license workspaces may split blank templates into per-item files and report structural progress. They must never supply labels or license decisions, set human attestations, infer reviewer identity or legal authority, grant redistribution permission, or bypass the packet-bound return preflight.
   - For citation-claim review, use the governed `reference-review prepare -> distribute-private -> package-private -> verify-private-package -> preflight -> import` path. A reviewer may insert `prepare-workspace -> audit-workspace -> finalize-workspace` after package verification to resume per-task work, but the workspace and extracted full text remain private. Require the receiver to rerun package verification after transfer. Treat deterministic packaging, workspace progress, and fresh-extraction verification as transport or structural integrity only, never as redistribution permission, human judgment, reviewer identity, attestation, or claim approval. Never generate the human review or final approval. Import only an all-supported, hash-bound return with explicit human approval, keep the canonical claims file unchanged, and require a separate Refgate submission audit before adoption.
   - Candidate, reference, and license work may be performed as model screening or model adjudication only in a separate `A1` or `A2` artifact that identifies the reviewer as a model and leaves every human field unset. Citation support requires direct reading of bound full text plus a precise evidence location. License screening requires direct public license evidence; otherwise keep the material `local_only` or `uncertain` and do not infer redistribution permission.
8. Apply the authority hierarchy from `docs/model-review-protocol.md`.
   - `A0 deterministic` owns mechanical blockers and the maximum claim/readiness ceiling.
   - `A1 model advisory` may critique, screen, and recommend repairs without mutating gates.
   - `A2 model conservative` may preserve or add blockers, lower readiness within the deterministic ceiling, or route work, but cannot clear an `A0` blocker, change the deterministic ceiling, create missing external evidence, create human attestation, or create legal or redistribution permission.
   - `A3 human authority` remains a separate identified and hash-bound human artifact. Model review is never labeled as human review.
   - A3 is conditional, not universal. For a controlled fault-injection
     benchmark, A0 may establish metric gold through a frozen registry,
     independently implemented artifact-replay oracle, hash-bound development
     and test suites, and a source- and fault-family-disjoint split. That path
     must declare `evaluation_regime=controlled_deterministic_fault_injection`,
     keep `claim_ceiling=registered_fault_families_only`, and must not claim
     external validation. A3 remains required for naturalistic labels, human
     identity or attestation, legal or redistribution permission, and claims
     of generalization beyond the registered fault families.
9. For `research:review`, use the governed multi-agent protocol whenever the user requests multi-agent review or the target is paper-scale.
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
10. Preserve review as a structural gate.
   - A completed run, successful draft, compiled PDF, or external agent success is not paper readiness.
   - If evidence is weak, downgrade or backtrack instead of polishing prose.
   - Missing, malformed, or intentionally ablated figure-audit evidence cannot
     authorize manuscript promotion and must not be represented as a successful
     zero-count measurement.
11. Prefer node-local repair.
   - Strengthen the failing node, prompt, validator, or skill that allowed the bad artifact.
   - Do not redesign the top-level workflow unless the architecture contract explicitly changes.
12. Keep public code and fixtures domain-neutral.
   - Do not hardcode one historical experiment, model, dataset, benchmark, condition marker, or run id into source, tests, docs, or plugin examples.
   - Keep concrete experiment identifiers inside run artifacts or user-provided inputs.
13. For plugin or governance-skill changes, dogfood the plugin against its own artifacts.
   - Run `npm run plugin:dogfood` from the repository root.
   - Treat any failed self-dogfood check as a `research:improve` finding and repair the smallest plugin-local artifact first.
   - Reinstall or restart the Codex thread when changing installed skill behavior.
14. Validate the smallest honest surface before reporting completion.
   - Public-code hygiene changes should keep `tests/publicCodeSanitization.test.ts` passing.
   - Runtime or harness changes should run the focused tests plus `npm run build` when shipped TypeScript changes.
   - Harness contract changes should include `npm run validate:harness` when applicable.

## Output Format

For substantial work, report:

- command intent used
- workflow intent used, when applicable
- artifacts inspected or created
- gate verdicts and downgrade class
- node or contract strengthened
- files changed
- validation commands and results
- remaining evidence gaps

## Common Failure Modes

- Treating a finished workflow as a finished research contribution.
- Treating `research:discover` as a CLI subcommand or adding a discovery node to the fixed workflow.
- Starting topic discovery from an incomplete `ResearchBrief`.
- Requiring a `topic_discovery` brief to preselect the final topic, metric, comparator, or dataset before literature-backed candidates exist.
- Allowing a candidate metric without an explicit unit and numeric scale, conflating the observed metric scale with the effect-threshold scale, or treating free-form `meaningful_effect` prose as the executable promotion threshold.
- Treating a weak, narrow, or under-specified candidate list as a governed `TopicPortfolio`.
- Applying the retained-corpus cap before semantic review, learning query feedback from a partial reviewer response, or treating retrieved candidates as paper evidence.
- Collapsing opportunity discovery into explicit author limitations only, or approving result disagreement, transfer, comparator, or reproducibility opportunities without their type-specific grounded evidence and reviewer conditions.
- Treating `TopicProbeDecision` as final topic selection or paper readiness.
- Activating more than one candidate, silently dropping non-active candidates instead of marking them `deferred`, or accepting an unbound `active_topic_probe_contract.json`.
- Treating `bounded_probe` output as paper claim evidence.
- Treating a paper-shaped draft or compiled PDF as paper readiness.
- Letting an external research system bypass AutoLabOS gates.
- Inventing missing baselines, metrics, sample sizes, seeds, references, or uncertainty estimates.
- Publishing a private reference-review archive or treating archive integrity as source-license approval.
- Treating reference-review preflight as canonical claim approval, or fabricating the human review or final approval needed for import.
- Treating a resumable review workspace as completed human evidence, or auto-filling labels, license decisions, or attestations.
- Treating `A1` or `A2` model output as human review, final approval, external evidence, or redistribution permission.
- Requiring human adjudication for registry-derived deterministic gold after
  independent oracle replay, or using that exemption to claim naturalistic
  generalization.
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
