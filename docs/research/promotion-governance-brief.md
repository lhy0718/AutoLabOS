# Research Brief

## Topic

Fail-closed promotion governance for autonomous research workflows. The study
tests whether artifact-grounded gates prevent scientifically defective run
bundles from being promoted as paper-ready while preserving valid positive,
null, and negative research outcomes.

## Objective Metric

- Primary metric: base-weighted false paper-ready promotion rate on held-out
  defective bundles.
- Co-primary utility metric: base-weighted clean-control promotion retention.
- Concern-acceptance conflict is a diagnostic metric, not independent evidence
  of effectiveness when the detector and decision rule share concerns.
- Secondary metrics: promotion-decision macro F1, clean-case promotion
  accuracy, blocker precision/recall/F1, upstream repair-owner accuracy,
  post-repair recovery rate, regression rate, trace coverage, wall time, and
  provider cost.
- Meaningful improvement: at least 20 absolute percentage points lower false
  promotion than the artifact-presence checklist while retaining at least 90
  percent clean-case promotion accuracy.

## Constraints

- Preserve the fixed 10-node AutoLabOS workflow contract.
- Use portable, domain-neutral artifact bundles and public manifests.
- Keep gold labels outside the artifact tree visible to evaluated systems.
- Use base-bundle-disjoint development and test splits.
- Do not encode case identifiers, model names, benchmark names, condition
  markers, or expected metrics in runtime source.
- Do not use deterministic replay, smoke fixtures, or Codex mock outputs as
  external empirical evidence.
- Preserve raw decisions, logs, failures, costs, hashes, and repair outcomes.
- Do not fabricate independent annotation, provider repetitions, or
  statistical significance.

## Plan

1. Freeze the literature boundary and nearest-neighbor comparison.
2. Define a manifest-driven paired benchmark and independent gold schema.
3. Build clean base bundles and audited mutation operators.
4. Implement ungated, presence-checklist, manuscript-only, full-policy, and
   ablation conditions.
5. Run a development pilot and repair benchmark validity failures.
6. Complete a prospective clustered precision analysis, then collect at least
   72 source-hash-distinct real-run bundles across at least
   three declared source families and three declared operator groups, cap every
   family and group at half of the sample, verify hash-bound execution
   provenance and preserved license evidence, and freeze them with an
   end-to-end `declared_stratified` marker into a provisional
   clean-plus-nine held-out corpus, obtain blind double adjudication and a
   separately blinded double mutation-isolation audit. Hash-freeze evaluated
   implementations, prompts, policies, thresholds, statistical code, and
   environments before confirmatory labels or outcomes are revealed; then
   execute the comparison systems and compute the preregistered estimates.
7. Run review and meta-harness gates, then draft only within the measured
   evidence ceiling.

## Manuscript Format

- columns: 2
- main_body_pages: 8
- references_excluded_from_page_limit: true
- appendices_excluded_from_page_limit: true

## Manuscript Template

To be set only after the active workshop call and official template are
verified.

## Appendix Preferences

Prefer appendix for:
- benchmark_case_manifests
- mutation_operator_definitions
- provider_prompts
- per_case_results
- extended_error_analysis
- environment_and_cost_records

Keep in main body:
- primary_result_tables
- concern_acceptance_definition
- benchmark_construction_overview
- main_ablation

## Research Question

Do artifact-grounded, fail-closed promotion gates reduce false paper-ready
promotion and concern-acceptance conflict relative to ungated, file-presence,
and manuscript-only review policies without materially increasing false blocks
on clean research bundles?

## Why This Can Be Tested With A Small Real Experiment

- The artifact schemas, audit path, review path, claim ceiling, figure audit,
  and transition policy already exist and can be exercised without training a
  new model.
- Counterfactual variants can be generated from a bounded set of clean bundles
  with deterministic, inspectable mutation operators.
- Ungated and presence-checklist baselines are inexpensive and reproducible.
- A real manuscript-only provider condition can be run over the held-out set
  within a bounded API budget; without it, the paper ceiling remains below an
  external empirical workshop claim.
- Paired variants provide a direct decision signal and support paired
  statistical analysis.

## Baseline / Comparator

- Ungated incoming-state trust: measures the failure rate when completion or an
  incoming paper-ready flag is accepted without governance.
- Artifact-presence checklist: measures whether semantic gates add value beyond
  file existence and parseability.
- Manuscript-only reviewer: measures whether paper text review converts
  concerns into consistent decisions when run artifacts are hidden.
- Independently implemented artifact-aware comparator: receives the same closed
  artifact inventory and output schema as the full policy, but uses a
  separately specified detector and decision policy.
- Full artifact-grounded promotion policy: proposed condition.
- Gate ablations: isolate concern-to-action binding, claim ceiling, figure
  consistency, and execution-state contributions.

## Dataset / Task / Bench

- Dataset: a public, manifest-driven suite of portable research-run bundles.
- Task: return a promotion decision, blocking concerns, evidence locations, and
  an upstream repair owner.
- Protocol: paired clean/counterfactual evaluation with base-bundle-disjoint
  development and test splits.
- Minimum scale: a prospective precision analysis at the base-bundle level
  determines the final sample, subject to a floor of 72 source-hash-distinct
  base bundles from at least three
  declared source families and three declared operator groups, with no family
  or group above 50 percent; at least 720 held-out cases across nine blocking
  fault families and all clean controls.
- Limitation: mutation-based cases approximate real research failures and must
  be separated from naturally occurring live-run evidence in reporting.

## Target Comparison

- Proposed: full artifact-grounded fail-closed promotion policy.
- Comparator: an independently implemented artifact-aware decision policy with
  the same frozen inventory and output space. Artifact-presence, ungated, and
  manuscript-only conditions are secondary mechanism or information ablations.
- Dimension: false promotion, concern-acceptance conflict, and clean-case
  promotion accuracy.
- Expected: at least 20 absolute percentage points lower false promotion than
  the matched artifact-aware comparator with at least 90 percent clean-case
  promotion retention.

## Confirmatory Decision Contract

- Target population: portable research-run bundles produced by declared public
  research-agent or workflow families. Mutation stress tests and naturally
  occurring defects form separate strata; the fixed mutation prevalence is
  never reported as a deployment prevalence estimate.
- Independent unit: the source-hash-distinct base bundle. Clean and defective
  variants are clustered within the base; repeated stochastic trials are
  nested within system, case, and base and are never counted as independent
  cases.
- Gold labels: a policy-independent scientific-readiness rubric is frozen
  before evaluation. Two blinded annotators label promotion eligibility,
  blocking concern severity, and repair owner without seeing system outputs or
  condition identity; a distinct adjudicator resolves disagreements.
- Decision mapping: `promote` is acceptance. `needs_review`, `downgrade`,
  and `block` are non-promotion. False promotion is `promote` on a gold
  ineligible case. Clean retention is `promote` on a gold eligible clean
  control. Concern-acceptance conflict is `promote` together with a declared
  blocking concern and is reported only as a diagnostic.
- Failure policy: every dispatched case-trial remains in the intention-to-test
  denominator. Timeout, invalid schema, missing output, provenance rejection,
  or execution failure is non-promotion for the safety endpoint and failure
  for clean retention. Failure classes and a completed-run sensitivity
  analysis are reported separately; no post hoc exclusion is allowed.
- Repeated trials: every stochastic condition uses the same preregistered
  repetition count and paired dispatch schedule. Primary rates average
  case-trial indicators within base before equal weighting across bases.
  Between-trial disagreement and variance are secondary outcomes.
- Freeze boundary: before confirmatory inventory or labels are revealed,
  freeze hashes for every evaluated implementation, prompt, policy, threshold,
  comparator, mutation recipe, scorer, statistical script, dependency lock,
  and runtime image. Any post-freeze change invalidates the confirmatory pass.
- Generalization: report registered-fault stress results separately from
  natural defects and prespecified leave-one-source-family,
  leave-one-operator-group, and leave-one-schema-family-out analyses. No
  cross-family claim is allowed without the corresponding untouched stratum.
- Primary inference: estimate the paired base-level difference in false
  promotion between the full policy and matched comparator, and the full
  policy's clean retention. Use base-clustered intervals with a frozen
  confidence level, RNG, seed, interval method, and software versions.
- Success rule: the lower confidence bound for false-promotion reduction must
  exceed 20 percentage points and the lower confidence bound for clean
  retention must be at least 90 percent. Equality, ties, and missing outcomes
  follow the frozen failure policy.
- Multiplicity: the two primary endpoints use a frozen joint gatekeeping rule.
  Pairwise baseline, fault-family, generalization, cost, latency, repair-owner,
  and recovery analyses are secondary or exploratory unless a family-wise
  correction is preregistered.
- Precision: simulate the base-clustered design under explicit comparator
  event rates, intrabase dependence, trial variance, family imbalance, and
  attrition. Increase the base count above 72 when the planned confidence-bound
  decision does not meet the frozen precision target.
- Recovery: rerun every original fault case after one declared node-owned
  repair under a fixed attempt and cost budget. Preserve before/after pairs,
  failed repairs, and matched clean controls; report recovery and collateral
  regression with base-clustered uncertainty.

## Minimum Acceptable Evidence

- A prospective clustered precision report that justifies the final base count,
  with a floor of 72 source-hash-distinct base bundles and 720 held-out cases,
  split by base bundle, with a clean control and all nine required fault-family
  variants per base.
- At least three declared source families and three declared operator groups,
  no family or group above half of the base bundles, family-stratified metrics,
  and leave-one-family-out sensitivity analysis.
- All required fault families and clean positive, null, and negative controls.
- One post-repair rerun for every original fault case, covering every fault
  family without selective case omission.
- Three complete real-model runs per manuscript-only test case when that
  baseline supports an empirical claim. Remote API runs require provider
  response receipts; local runs require an exact model artifact digest and
  hash-bound runtime receipts.
- Paired bootstrap confidence intervals over base bundles.
- A frozen estimand, failure-denominator, repetition, multiplicity, threshold,
  RNG, and confidence-bound decision contract.
- At least one independently implemented artifact-aware comparator receiving
  the same closed inventory and output schema as the proposed policy.
- Separately reported natural-defect and registered-mutation strata, including
  prespecified held-out family/operator/schema analyses.
- Raw counts and effect sizes reported even when significance tests are
  inconclusive.
- No signal: less than five percentage points difference from the presence
  checklist on false promotion.
- Weak signal: five to nineteen percentage points lower false promotion, or
  clean-case accuracy below 90 percent.

## Disallowed Shortcuts

- Do not count dry-run, replay, generated expectations, or unit-test fixtures as
  measured benchmark performance.
- Do not expose gold labels or mutation family names to evaluated systems.
- Do not split paired variants from the same base bundle across development and
  test sets.
- Do not report Codex mock runs as provider evidence.
- Do not hand-edit generated metrics, predictions, confidence intervals, or
  run artifacts.
- Do not omit clean cases, failed runs, null results, or unfavorable ablations.
- Do not claim human validation without independent adjudication records.
- Do not convert an external source into canonical evidence with inferred
  constants. Use only byte-preserving copies or JSON-pointer extraction, retain
  source/output hashes, and require a completed human license review before
  public freezing.
- Do not expose the private annotation map, provisional gold, mutation
  metadata, or model predictions to either initial adjudicator.
- Do not resolve annotation disagreement by majority inference from two labels;
  require a distinct third resolver and preserve the resolution record.
- Do not let promotion-label adjudicators perform the mutation-isolation audit.
  Require two complete audit files under distinct role IDs and block on any
  confounded mutation.

## Allowed Budgeted Passes

- One development pilot for schema and mutation validation.
- One repair pass after the development pilot.
- One frozen confirmatory test pass.
- Up to three real-model repetitions for the manuscript-only condition.
- One independent metric recomputation from preserved raw predictions.

## Paper Ceiling If Evidence Remains Weak

- Without a real manuscript-only provider comparison or independent held-out
  label adjudication: `research_memo`.
- With complete deterministic comparisons but fewer than 72 base bundles or 720
  variants: `blocked_for_paper_scale`.
- With only internal dry-run or smoke evidence: `system_validation_note`.
- A failed primary hypothesis remains publishable only as a bounded negative
  result when the benchmark and baselines satisfy the minimum evidence bar.

## Minimum Experiment Plan

- One ungated baseline run.
- One artifact-presence checklist run.
- One full artifact-grounded policy run.
- One real manuscript-only reviewer condition when provider access is
  available.
- One concern-to-action binding ablation.
- One quantitative result table with paired uncertainty.
- One limitation and validity-threat analysis.
- One claim-to-evidence mapping from every headline result to raw decisions and
  manifests.

## Paper-worthiness Gate

- The research question is explicit and remains distinct from SAGE,
  BadScientist, CLAIM-BENCH, reproducibility-assessment systems, and end-to-end
  research benchmarks.
- The benchmark has frozen manifests, hashes, independent labels, and no split
  leakage.
- Every held-out mutation has two hash-bound `isolated` audit judgments from
  declared auditors separate from promotion-label adjudicators.
- Ungated, checklist, and full-policy conditions are executed on the held-out
  set.
- Manuscript-only claims rely on complete real-model runs rather than mocks.
- Results include false promotion and clean-case error, not safety recall alone.
- Concern-acceptance conflicts and repair outcomes are traceable to raw
  predictions.
- Limitations, mutation validity, annotation limits, and negative results are
  reported.

## Failure Conditions

- A nearest-neighbor study already evaluates the same artifact-level
  concern-to-promotion binding under comparable conditions.
- The full policy blocks more than 10 percent of clean bundles.
- The checklist matches the full policy within five percentage points on both
  false promotion and clean-case accuracy.
- Mutation variants contain superficial leakage or undeclared secondary faults.
- Independent held-out label adjudication cannot be obtained.
- Only internal workflow validation is completed and no reportable benchmark
  evidence is executed.

## Notes

The historical parameter-tuning pilot remains a system-validation case and is
not part of the scientific evidence for this study.

## Questions / Risks

- Can naturally occurring external research-agent bundles be licensed and
  normalized without leaking private or model-specific identifiers?
- Is manuscript-only review a fair baseline unless it receives the same stated
  decision rubric but not the hidden run artifacts?
- How much of the full-policy gain comes from deterministic artifact checks
  rather than the transition-binding mechanism?
- Can two independent reviewers adjudicate the held-out gold labels before the
  confirmatory run?
