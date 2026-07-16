# Fail-Closed Promotion Governance for Autonomous Research Workflows

## Thesis

Autonomous research systems need a promotion policy that binds detected
scientific concerns to block, downgrade, or repair actions. A reviewer that
mentions a serious defect but still allows paper-ready promotion has not
provided effective governance.

The selected research direction evaluates whether artifact-grounded,
machine-checkable promotion gates reduce concern-acceptance conflicts without
over-blocking clean research bundles.

## Search Snapshot

Literature and system coverage was checked on 2026-07-16 against primary
records from ACL Anthology, OpenReview, arXiv, and official benchmark pages.
The following boundary is an evidence-backed positioning hypothesis, not a
claim that no adjacent work exists.

- End-to-end capability benchmarks measure whether agents can reproduce or
  rediscover scientific work. PaperBench evaluates replication of 20 machine
  learning papers, while ResearchClawBench evaluates 40 tasks across 10
  scientific domains. Their stated targets are research capability and
  artifact quality rather than fail-closed promotion decisions over a run's
  evidence trail.
- Scientific review benchmarks expose weak reasoning and integrity detection.
  BadScientist reports that fabricated papers can still receive acceptance
  decisions and names the resulting concern-acceptance conflict. A
  counterfactual review study reports that injected reasoning flaws had no
  significant effect on automatic reviews. CLAIM-BENCH evaluates scientific
  claim-evidence extraction and validation.
- Reproducibility and admissibility work provides nearby assurance mechanisms.
  Agentic Reproducibility Assessment reconstructs workflow graphs for
  reproducibility assessment. REPRO-Bench evaluates agents against papers and
  replication packages. MADS-CPS defines a machine-checkable run-level
  admissibility contract for autonomous laboratories. These are the closest
  artifact-level neighbors; the remaining distinction is an explicit
  concern-to-promotion decision contract with repair ownership and clean-case
  over-blocking measurement.
- Recovery work makes node-local failure attribution an insufficient novelty
  claim by itself. SAGE routes experiment failures to hypothesis, design, or
  implementation interventions. ClaimGarden similarly studies update-aware
  claim-state control and manuscript export gates.

Primary records:

- BadScientist: https://aclanthology.org/2026.acl-long.1134/
- Counterfactual automatic-review evaluation:
  https://aclanthology.org/2026.tacl-1.22/
- CLAIM-BENCH: https://aclanthology.org/2025.ijcnlp-long.127/
- Agent Laboratory: https://aclanthology.org/2025.findings-emnlp.320/
- PaperBench: https://openai.com/index/paperbench/
- ResearchClawBench: https://arxiv.org/abs/2606.07591
- Agentic Reproducibility Assessment: https://arxiv.org/abs/2605.02651
- REPRO-Bench: https://arxiv.org/abs/2507.18901
- MADS-CPS: https://openreview.net/forum?id=VrYHFXGyUO
- SAGE: https://arxiv.org/abs/2606.31478
- ClaimGarden: https://openreview.net/forum?id=Y8INhipPQe

## Candidate Comparison

| Candidate | Falsifiable claim | Nearest overlap | Decision |
| --- | --- | --- | --- |
| Fail-closed promotion policy | Artifact-bound gates reduce false promotion and concern-acceptance conflict while preserving clean cases | BadScientist, automatic review, MADS-CPS | Selected |
| Node-local experiment recovery | Structured attribution improves selection of hypothesis, design, or implementation repairs | SAGE directly studies this mechanism | Reject as primary contribution; retain repair localization as a secondary metric |
| Update-aware claim-state control | Versioned evidence updates prevent stale claims from reaching manuscript export | ClaimGarden directly studies claim-state drift and export gates | Reject as primary contribution; retain stale-state cases in the benchmark |
| End-to-end autonomous research benchmark | A new suite measures full research capability better than paper-only evaluation | PaperBench, ResearchClawBench, AstaBench, ResearchGym, AIRS-Bench | Reject; the space is crowded and exceeds the available curation budget |

## Research Questions

**RQ1.** On paired clean and counterfactual research-run bundles, how much do
artifact-grounded promotion gates reduce false paper-ready promotion relative
to an ungated policy, an artifact-presence checklist, and manuscript-only
review?

**RQ2.** Do promotion gates eliminate concern-acceptance conflict, defined as a
system reporting a blocking scientific concern while still returning a
paper-ready promotion decision?

**RQ3.** What are the costs of fail-closed governance in false blocks, latency,
and repair burden, and how accurately can blocking findings identify the
upstream artifact owner that must be rechecked?

## Hypotheses

- **H1:** Artifact-grounded gates lower false promotion rate by at least 20
  absolute percentage points relative to an artifact-presence checklist on the
  held-out fault-family split.
- **H2:** Binding blocker severity to transition policy lowers
  concern-acceptance conflict rate to at most 5 percent.
- **H3:** The full policy retains at least 90 percent clean-case promotion
  accuracy and therefore does not obtain safety gains by blocking every case.
- **H4:** Upstream repair-owner accuracy exceeds the strongest non-governed
  baseline by at least 15 absolute percentage points.

## Benchmark Object

The unit of evaluation is a portable research-run artifact bundle, not a paper
paragraph or an internal workflow fixture. Each clean bundle has one or more
paired counterfactual variants produced by a declared mutation operator.

Required fault families:

1. missing baseline or comparator
2. missing repeated-run evidence
3. incomplete or failed execution hidden by a positive summary
4. approved-versus-executed budget mismatch
5. result-table and figure conflict
6. claim and evidence-link conflict
7. citation support mismatch
8. stale checkpoint or active-node projection
9. unsupported claim-strength promotion
10. clean positive, null, and negative controls

Gold labels are stored independently of the evaluated policy and include the
expected promotion decision, blocking fault family, evidence locations, and
upstream repair owner. Benchmark code discovers cases from manifests; runtime
source does not enumerate case identifiers or encode case-specific metrics.

## Comparison Conditions

- **Ungated:** trusts the incoming paper-ready state.
- **Presence checklist:** checks required file presence and parseability but not
  semantic consistency.
- **Manuscript-only reviewer:** reviews the paper-facing text without run
  artifacts. Results from this condition are reportable only when produced by
  a real provider under a preserved protocol; Codex mock runs remain smoke
  evidence.
- **Artifact-grounded promotion:** applies the full gate, claim ceiling, figure
  consistency, execution-state, and review-transition policy.
- **Ablations:** remove one of concern-to-action binding, claim ceiling, figure
  consistency, or execution-state validation while preserving all other inputs.

## Metrics

Primary metrics:

- false paper-ready promotion rate
- concern-acceptance conflict rate
- macro-averaged promotion-decision F1
- clean-case promotion accuracy

Secondary metrics:

- blocker precision, recall, and F1 by fault family
- upstream repair-owner accuracy
- successful recovery rate after one declared repair
- regression rate on previously passing checks
- artifact trace coverage
- wall time and provider cost

All confidence intervals use paired bootstrap resampling clustered by base
bundle. The implemented evaluator reports an exact paired sign test over
base-bundle effects; McNemar's test may additionally be reported for a frozen
single-trial binary comparison when its assumptions are met. Effect sizes and
raw counts are reported regardless of significance. Synthetic development
suites are always marked exploratory.

## Leakage And Validity Controls

- Split by base bundle, not by mutated variant, so paired siblings cannot cross
  train and test partitions.
- Keep gold labels outside the artifact tree visible to evaluated systems.
- Separate mutation implementation from policy implementation and test that a
  mutation does not introduce undeclared faults.
- Include clean positive, clean null, and clean negative controls.
- Freeze at least 20 source-hash-distinct canonical bundles before building the
  confirmatory suite. Derive public base IDs from hashes and keep local source
  IDs and original paths outside the frozen corpus.
- Treat `external_real_run` as an operator attestation until run records and raw
  execution evidence are independently checked; hash freezing alone does not
  prove that execution occurred.
- Report deterministic replay, synthetic mutation, real provider, and live-run
  evidence as different evidence classes.
- Do not claim human validation until at least two independent reviewers have
  adjudicated the held-out labels.
- Export opaque annotation IDs and artifact directories before review; keep the
  case map, provisional gold, mutation metadata, and system predictions hidden.
- Require exactly two complete initial label files and a distinct third
  resolver for every disagreement. Do not infer agreement from missing rows.
- Let the adjudication importer set paper eligibility only after the external
  real-run, held-out split, source-hash independence, 20-base, 200-case, and
  clean-plus-nine-family paired-coverage gates pass.
- Keep every frozen recipe label at provisional `needs_review`; only the blind
  independent adjudication importer may replace labels or change eligibility.

## Minimum Publishable Experiment

- At least 20 independent base bundles covering positive, null, and negative
  outcomes, with 30 preferred for the final submission.
- At least 200 held-out cases total. At the 20-base floor, each base contributes
  one clean control and one variant from every required fault family.
- Ungated, presence-checklist, manuscript-only, and full artifact-grounded
  comparisons.
- At least one gate ablation and one post-repair rerun per fault family.
- Three independent provider runs per manuscript-only case when that condition
  is used for external claims.
- Raw decisions, concerns, manifests, hashes, costs, and failures preserved.

## Kill Signals

- The full policy gains recall only by blocking more than 10 percent of clean
  bundles.
- The presence checklist matches the full policy within five percentage points
  on both false promotion and clean-case accuracy.
- Counterfactual mutations are detectable from superficial filenames or labels.
- Held-out labels cannot be independently adjudicated.
- A nearest-neighbor publication already evaluates the same artifact-level
  concern-to-promotion binding under comparable conditions.

## Venue Class

The current primary target is the NeurIPS 2026 AutoResearch workshop. Its
official call includes datasets, benchmarks, evaluation, reproducibility, and
governance for end-to-end autonomous research, and allows 4--8 page full
papers. As checked on 2026-07-16, the August 29 deadline and workshop details
remain tentative. The submission must use the official NeurIPS 2026 template,
but no past-year or ACL style may be substituted before the workshop exposes
the official file. The REALM workshop at EMNLP 2026 is a secondary venue fit.
