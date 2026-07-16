# Research Brief

## Topic

Fail-closed promotion governance for autonomous research workflows. The study
tests whether artifact-grounded gates prevent scientifically defective run
bundles from being promoted as paper-ready while preserving valid positive,
null, and negative research outcomes.

## Objective Metric

- Primary metric: false paper-ready promotion rate on held-out paired bundles.
- Co-primary safety metric: concern-acceptance conflict rate.
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
6. Collect at least 20 independently sourced real-run bundles, freeze their
   hashes into a provisional clean-plus-nine held-out corpus, obtain blind
   double adjudication, execute the comparison systems, and compute paired
   uncertainty and tests.
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
- Full artifact-grounded promotion policy: proposed condition.
- Gate ablations: isolate concern-to-action binding, claim ceiling, figure
  consistency, and execution-state contributions.

## Dataset / Task / Bench

- Dataset: a public, manifest-driven suite of portable research-run bundles.
- Task: return a promotion decision, blocking concerns, evidence locations, and
  an upstream repair owner.
- Protocol: paired clean/counterfactual evaluation with base-bundle-disjoint
  development and test splits.
- Minimum scale: 20 independently sourced base bundles, at least 200
  counterfactual variants across nine blocking fault families, and all clean
  controls; 30 base bundles are preferred for submission.
- Limitation: mutation-based cases approximate real research failures and must
  be separated from naturally occurring live-run evidence in reporting.

## Target Comparison

- Proposed: full artifact-grounded fail-closed promotion policy.
- Comparator: artifact-presence checklist; ungated and manuscript-only
  conditions provide additional reference points.
- Dimension: false promotion, concern-acceptance conflict, and clean-case
  promotion accuracy.
- Expected: at least 20 absolute percentage points lower false promotion than
  the checklist with at least 90 percent clean-case promotion accuracy.

## Minimum Acceptable Evidence

- At least 20 base bundles and 200 held-out cases, split by base bundle, with a
  clean control and all nine required fault-family variants per base.
- All required fault families and clean positive, null, and negative controls.
- At least one post-repair rerun for every fault family.
- Three independent real-provider runs per manuscript-only test case when that
  baseline supports an external claim.
- Paired bootstrap confidence intervals over base bundles.
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
- Do not expose the private annotation map, provisional gold, mutation
  metadata, or model predictions to either initial adjudicator.
- Do not resolve annotation disagreement by majority inference from two labels;
  require a distinct third resolver and preserve the resolution record.

## Allowed Budgeted Passes

- One development pilot for schema and mutation validation.
- One repair pass after the development pilot.
- One frozen confirmatory test pass.
- Up to three real-provider repetitions for the manuscript-only condition.
- One independent metric recomputation from preserved raw predictions.

## Paper Ceiling If Evidence Remains Weak

- Without a real manuscript-only provider comparison or independent held-out
  label adjudication: `research_memo`.
- With complete deterministic comparisons but fewer than 20 base bundles or 200
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
  BadScientist, CLAIM-BENCH, MADS-CPS, and end-to-end research benchmarks.
- The benchmark has frozen manifests, hashes, independent labels, and no split
  leakage.
- Ungated, checklist, and full-policy conditions are executed on the held-out
  set.
- Manuscript-only claims rely on real provider runs rather than mocks.
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
