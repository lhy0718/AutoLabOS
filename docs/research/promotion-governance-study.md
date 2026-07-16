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

Primary confidence intervals use paired bootstrap resampling clustered by base
bundle. Because content-distinct runs from one system family are not
independent system samples, the final analysis must also report family-stratified
results and leave-one-family-out sensitivity. The implemented evaluator emits
per-family system metrics and recomputes all paired comparisons after each
declared family is omitted. It also reports an exact paired sign test over
base-bundle effects; McNemar's test may
additionally be reported for a frozen single-trial binary comparison when its
assumptions are met. Effect sizes and raw counts are reported regardless of
significance. Synthetic development suites are always marked exploratory.

## Leakage And Validity Controls

- Split by base bundle, not by mutated variant, so paired siblings cannot cross
  train and test partitions.
- Keep gold labels outside the artifact tree visible to evaluated systems.
- Separate mutation implementation from policy implementation and test that a
  mutation does not introduce undeclared faults.
- Include clean positive, clean null, and clean negative controls.
- Freeze at least 20 source-hash-distinct canonical bundles before building the
  confirmatory suite. Require at least three declared source-system families
  and three declared operator groups, and allow neither a family nor an
  operator group to contribute more than half of the bases. These declarations
  support stratification; they do not prove real-world independence. Derive
  public base IDs from hashes and keep local source IDs and original paths
  outside the frozen corpus.
- Preserve a non-empty `SOURCE_LICENSE.txt` and its hash for every native or
  projected source. Carry only hashed family/operator identifiers and the
  `declared_stratified` status through recipes, mutation provenance, case
  manifests, suite loading, adjudication, and scoring. Each downstream gate
  must recheck the minimum counts, per-base consistency, and 50 percent cap.
- Admit non-native bundles through two separate stages. First,
  `project-promotion-source` permits only byte-for-byte file selection and
  JSON-pointer extraction, records source and output hashes, rejects symlinks
  and credential-like paths or values, and cannot introduce literal evidence
  values. Projection integrity is evaluated separately from confirmatory
  readiness, so an intact but incomplete source can proceed to annotation
  without being promoted.
- Second, export an opaque source-normalization pack and require two independent
  human mappings or a distinct third-party resolution. The materializer accepts
  only source-bound result, execution, figure, claim, citation, and readiness
  paths, preserves both initial labels, and writes generated canonical fields
  separately from the nested projected source. The readiness path must be the
  same manifest-bound file selected for the review-decision role. The
  independent inspector rechecks every output hash, the closed nested
  projection, the adjudication trace, execution evidence, license, and all
  mutation targets. Human mapping is never treated as proof that execution
  occurred.
- Require each normalized or native source to bind run configuration, events, metrics, review
  decision, command, and execution log files in `execution-evidence.json`.
  Reject non-real or failed modes, fewer than three distinct portable trial
  identifiers, hash drift, and duplicate run IDs or execution fingerprints
  before freezing. Seed fields remain valid provenance when present, but the
  benchmark contract does not assume that every external system is stochastic.
- Treat `execution_provenance_status=artifact_verified` as verification of the
  declared artifact record, not proof that execution occurred or that operators
  were independent.
- Report deterministic replay, synthetic mutation, real provider, and live-run
  evidence as different evidence classes.
- Do not claim human validation until at least two independent reviewers have
  adjudicated the held-out labels.
- Export a separate paired mutation-audit pack. Require exactly two complete
  `isolated` judgments per mutated case, bind the report to suite and artifact
  hashes, and block on any `confounded` judgment.
- Export opaque annotation IDs and artifact directories before review; keep the
  case map, provisional gold, mutation metadata, and system predictions hidden.
- Require exactly two complete initial label files and a distinct third
  resolver for every disagreement. Do not infer agreement from missing rows.
- Require mutation-auditor pseudonyms to be distinct from promotion-label
  adjudicator pseudonyms. Preserve an external role-assignment log because
  pseudonymous IDs do not prove real-world identity.
- Let the adjudication importer set paper eligibility only after the external
  real-run, artifact-verified provenance, held-out split, source-hash
  uniqueness, declared family/operator diversity, 20-base, 200-case, and
  clean-plus-nine-family paired-coverage gates pass and mutation isolation is
  `double_verified`.
- Keep every frozen recipe label at provisional `needs_review`; only the blind
  independent adjudication importer may replace labels or change eligibility.

## Source Acquisition Audit

The public-source route was inspected on 2026-07-16 and rechecked on 2026-07-17 using official project
repositories and linked first-party archives.

- [CodeScientist](https://github.com/allenai/codescientist) exposes 20 reports,
  external review ratings, and a linked 52 MB experiment archive. The archive
  contains 20 top-level experiments with two to fourteen recorded runtime
  directories per experiment, but several have fewer than three. It also
  contains credential-labelled paths, so direct extraction is unsafe and the
  selected evidence files require a secret scan and license review.
- [The AI Scientist](https://github.com/sakanaai/ai-scientist) exposes ten
  example projects and 59 run directories with structured result JSON, but the
  repository examples do not supply every required execution-log, independent
  human-review, figure-audit, checkpoint, and claim-link artifact. Its current
  source license also requires explicit review before redistribution.
- [AutoSOTA](https://github.com/tsinghua-fib-lab/AutoSOTA) exposes optimized
  repository snapshots with final reports, result files, and execution code.
  The selected deterministic sample contained three structured result files
  with 35 recorded values each, but lacked a complete start/end/exit trace,
  source-grounded figure audit, and independent human claim-evidence mapping.
- [Agent Laboratory](https://github.com/SamuelSchmidgall/AgentLaboratory)
  documents checkpointed end-to-end execution but does not include completed
  run bundles in the official repository.

No inspected source is currently counted as confirmatory evidence. The
acquisition audit establishes feasible raw-material routes, not 20 eligible
bases. Missing canonical governance artifacts must not be filled with inferred
or hand-authored success values.

The machine-readable acquisition audit is preserved in
`docs/research/evidence/promotion-source-route-audit.json`. Across the 20
CodeScientist experiment directories, it found 86 recorded runtime directories
and complete report/history coverage; ten experiments had at least three
runtime directories. The current confirmatory intake still admitted zero
bases: every experiment lacked a hash-bound AutoLabOS execution manifest,
preserved source-license evidence, reviewed redistribution status, a projection
manifest, and compatibility with the nine canonical mutations. Runtime
directory counts are therefore source-route observations, not trial or
eligibility claims.

One official AI Scientist example was then exercised through the new route at
repository revision `1de1dbc1f4ee2c5f61e9c94348d55eb51d7fa2eb`. A deterministic
projection selected 18 manifest-bound outputs, including six structured run
results, run scripts, logs, review and paper records, and figures. A
CodeScientist experiment selected by the preregistered rule "first
lexicographic experiment with at least three non-empty result files" was also
projected into 18 manifest-bound outputs from three recorded runs. The first
lexicographic AutoSOTA ICML directory with a final report and at least three
structured result or seed-log files was projected at revision
`151532bd861cd40f5d7e8d0b6caa9c72fce24f55` into 13 manifest-bound output
records. All three closed projections passed integrity inspection and produced
opaque normalization tasks. They remain intentionally blocked with
`local_evaluation_only`, `unreviewed` license status, zero human annotations,
no accepted normalization, and no confirmatory admission. These are same-flow
validations of source routes, not empirical benchmark results.

A balanced acquisition pass then froze 20 source-hash-distinct candidate
projections across the three routes, with a 7/7/6 family distribution and a
maximum declared family share of 35 percent. Candidates were traversed in
lexical order and required three bounded standard-JSON result records with a
shared numeric comparison pointer. Metric values and apparent outcome quality
were not used for selection. Six structurally ineligible candidates were
logged by opaque hash rather than silently replaced; five came from the third
route, so the resulting pool is not representative of all source outputs.
Every selected projection passed byte and manifest integrity checks and
produced a blind annotation pack. However, all 20 remain local-only and
license-unreviewed, with zero human annotations, zero accepted normalizations,
and zero confirmatory admissions. They are candidate projections, not clean
benchmark bases, and the declared route groups do not establish independent
real-world operator identities. The frozen hashes, selection rules, exclusions,
and evidence ceiling are recorded in
`docs/research/evidence/promotion-source-acquisition-v3.json`.

The 20 annotation packs were subsequently assembled into one closed reviewer
batch containing 20 opaque tasks and 343 hash-bound outputs. Its reviewer
directory occupies 159,120,555 bytes. Self-inspection reproduced the manifest,
task, common-rubric, and reviewer-artifact-tree hashes and found neither the
current machine path nor the controller-private map in the reviewer directory.
The artifact copies preserve source-native upstream paths exactly because
changing those bytes would invalidate the source evidence; this is an
additional reason to keep the batch local until license and privacy review are
complete. No human annotation has been imported, and the closed packaging does
not establish reviewer independence, accepted normalization, clean execution
evidence, or confirmatory eligibility.

## Minimum Publishable Experiment

- At least 20 source-hash-distinct base bundles covering positive, null, and
  negative outcomes, drawn from at least three declared source families and
  three declared operator groups with no group above 50 percent; 30 bases are
  preferred for the final submission.
- At least 200 held-out cases total. At the 20-base floor, each base contributes
  one clean control and one variant from every required fault family.
- Ungated, presence-checklist, manuscript-only, and full artifact-grounded
  comparisons.
- At least one gate ablation and one post-repair rerun per fault family.
- Three independent provider runs per manuscript-only case when that condition
  is used for external claims.
- Raw decisions, concerns, manifests, hashes, costs, and failures preserved.
- A passing hash-bound execution-provenance audit for every base bundle.
- Two independent mutation-isolation audit files and the hash-bound verifier
  report preserved.

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
