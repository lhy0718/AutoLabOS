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
  semantic consistency. The fixed surface is `result_table.json`,
  `run_record.json`, `review/decision.json`, and
  `paper/paper_readiness.json`; each must be a regular, parseable JSON file.
- **Manuscript-only reviewer:** reviews the paper-facing text without run
  artifacts. Results from this condition are reportable only when produced by
  a real provider under a preserved protocol; Codex mock runs remain smoke
  evidence. The fresh provider runner hash-binds its prompt pack, requires a
  new output root, preserves outputs, hashed response identifiers, usage,
  cost, latency, failures, and predictions, and fails closed on partial or
  malformed responses. One completed runner invocation remains one trial and
  does not satisfy the three-trial requirement by itself. The three-trial
  aggregate is admissible only when exactly three completed manifests share
  the suite, system, model, reasoning effort, protocol, and prompt hashes;
  expose distinct run, trial, and hashed response receipt identifiers; retain
  complete case coverage; and pass artifact rehashing against the current
  suite. This operational repetition gate does not independently verify
  provider identity or statistical independence.
- **Artifact-grounded promotion:** applies the full gate, claim ceiling, figure
  consistency, execution-state, and review-transition policy.
- **Ablations:** remove one of concern-to-action binding, claim ceiling, figure
  consistency, or execution-state validation while preserving all other inputs.

Deterministic comparisons are bound to
`promotion-system-protocol-v2` in system-run manifest schema `1.1`. This
revision distinguishes the documented presence-plus-parseability baseline from
earlier development manifests that checked existence only. Unversioned
manifests remain inspectable as development history but are not admissible to
the confirmatory or post-repair evidence gate.

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

Confirmatory support is interval-based rather than point-estimate-based. H1 and
H4 use direction-normalized paired differences, while H2 and H3 use
base-bundle-clustered system intervals. All-zero and all-one binary system
outcomes use a two-sided exact boundary guard because a percentile bootstrap
would otherwise collapse to a zero-width interval. An at-least hypothesis is
supported
only when the 95 percent interval lower bound reaches its preregistered
threshold; an at-most hypothesis is supported only when the upper bound is no
greater than its threshold. A point estimate that clears the threshold while
its interval crosses the threshold is recorded as not supported. Missing
intervals make the corresponding hypothesis not evaluable and block
paper-scale progression, whereas a complete null or negative result does not.
For example, zero events across 20 independent base bundles still has an upper
95 percent boundary of about 16.8 percent, so it cannot support H2's 5 percent
ceiling. Seventy-two all-zero base bundles are required to move that boundary
to 5 percent or below. The calculation and superseded 20-base diagnostic are
recorded in
`docs/research/evidence/promotion-confirmatory-scale-audit.json`.

## Leakage And Validity Controls

- Split by base bundle, not by mutated variant, so paired siblings cannot cross
  train and test partitions.
- Keep gold labels outside the artifact tree visible to evaluated systems.
- Separate mutation implementation from policy implementation and test that a
  mutation does not introduce undeclared faults.
- Include clean positive, clean null, and clean negative controls.
- Freeze at least 72 source-hash-distinct canonical bundles before building the
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
  reviewer-side preflight uses only the opaque reviewer pack and one label
  file to check complete coverage before submission and to report
  projection-bound path and downstream materialization findings separately.
  Honest negative labels remain submission-valid even when they are not
  clean-base eligible; the preflight cannot read controller maps or peer
  labels and does not count as adjudication. The
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
  uniqueness, declared family/operator diversity, 72-base, 720-case, and
  clean-plus-nine-family paired-coverage gates pass and mutation isolation is
  `double_verified`.
- Forbid a benchmark recipe from self-asserting paper eligibility. A completed
  adjudication must preserve contained copies and SHA-256 bindings for the
  private annotation map, both initial human label files, any third-party
  resolution, the mutation-audit report, and the accepted labels. Suite loading
  must recheck those files and require accepted labels to cover every case
  exactly once and match the case gold values. The source-suite snapshot hash
  remains a receipt for the pre-adjudication suite; status fields alone do not
  establish lineage.
- Require paper-scale suite construction to receive the exact
  `frozen-intake-manifest.json` alongside its hash-bound recipe. Preserve both
  files inside a closed suite-local evidence directory and bind the study,
  intake tier, candidate-review receipt, source execution/curation receipts,
  base/case counts, fault-family coverage, immutable case fields, and exact
  mutation operations. A general builder run without this evidence may produce
  a development suite but cannot satisfy paper eligibility.
- Preserve the exact intake manifest and complete paper-scale candidate
  handoff/review roots under a sorted, hash-bound upstream evidence inventory.
  Recompute the intake, handoff-manifest, adjudicated-label, and review-evidence
  receipts from those contained bytes; reject missing, added, symlinked, or
  changed files before suite construction or confirmatory review.
- Preserve the pre-adjudication suite manifest and every original case manifest
  inside the adjudicated suite. Recompute the source-suite snapshot from those
  exact bytes plus the unchanged case artifact trees instead of treating the
  snapshot SHA as a non-reproducible receipt.
- Treat the original confirmatory suite and post-repair suite as different
  evidence roles. The original must remain paper-claim-eligible and freeze-bound;
  the repaired suite is artifact-verified recovery evidence and must not be
  promoted as an independently frozen paper claim.
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

The 20 annotation packs were subsequently reassembled into the v2 closed
reviewer handoff containing 20 opaque tasks and 344 hash-bound reviewer
outputs. Its reviewer directory occupies 159,135,380 bytes. The batch now
binds a runtime-owned JSON Schema and reviewer guide in addition to the common
rubric and projected artifacts. The schema distinguishes complete observations
from insufficient source evidence; the latter uses null scalar fields and empty
collections rather than fabricated sentinel values. Reviewer preflight rejects
altered contract files and records their hashes. Self-inspection reproduced all
manifest and output hashes and found neither a controller-private map nor a
label file in the reviewer directory. The earlier v1 handoff now fails the v2
contract because it lacks the schema and guide and exposes the stale field
contract; it remains historical acquisition evidence rather than a distributable
review packet. The artifact copies preserve source-native upstream paths exactly
because changing those bytes would invalidate the source evidence; this is an
additional reason to keep the batch local until license and privacy review are
complete. No human annotation has been imported. The closed packaging therefore
does not establish reviewer independence, accepted normalization, clean
execution evidence, or confirmatory eligibility. Exact hashes and the remaining
evidence boundary are recorded in
`docs/research/evidence/promotion-review-handoff-v2.json`.

The v2 handoff remains a seed batch for validating independent review
mechanics. It is 52 base bundles below the final 72-base paper-eligibility
floor and cannot by itself support a confirmatory suite.

### Source Expansion Evidence Ladder

The 2026-07-17 expansion audit widened the route search beyond the three seed
families while preserving distinct evidence classes. At pinned revisions, the
audited routes expose 98 exactly counted candidate artifacts, a conservative
lower bound of 422 additional public execution traces, and a separate report
of 40 papers whose individual corpus bytes were not acquired. The exact
candidate layer includes the current projections, 52 generated experiment-task
records, and eight showcase paper PDFs. Those objects are not interchangeable:
generated tasks are not executed results, traces are not complete paper-ready
base bundles, PDFs are not raw run provenance, and a reported corpus size is
not a hash-bound corpus.

The evidence ladder currently establishes an exact-or-lower-bound source-hash
floor of 502 artifacts and an execution-trace floor of 429. It establishes
only 20 previously projected candidates with repeated result records and 20
machine-readable comparison-result candidates. The v8 revision-bound handoff
below initially exposed 72 operator-conditioned candidate groups whose three
trials share an explicit source-native sample identifier. A later task-level
audit found only 37 distinct source-native bases after excluding operator
identity; 35 groups duplicated a base under another operator. The v10 handoff
now separately establishes 72 distinct source-native tasks with two different
operator groups and three disjoint rows per group. Human comparability review
is still incomplete, so this closes the structural paired-candidate floor but
does not create admitted confirmatory evidence.
The ladder establishes zero explicit readiness decisions, zero
source-grounded figure audits, zero claim-to-evidence maps, zero completed
human license reviews, zero double-human normalizations, and zero confirmatory
admissions. Consequently, source-native task and structural pair scale are now
closed, while human normalization and evidence completeness remain open; the
exact 72-base admission gap is unchanged.

The machine-readable inventory is
`docs/research/evidence/promotion-source-expansion-v1.json`. The
`audit-promotion-source-expansion` command recomputes the stage ladder and
returns `blocked_for_paper_scale` until exact admission, family/operator
diversity, and concentration limits all pass. Its current upstream targets are
`run_experiments`, `analyze_results`, `review`, and `design_experiments`.

### Revision-Bound Trial Candidates

The v7 Git handoff is retained as source-capacity and system-validation evidence,
not repeated-trial evidence. Its recipe grouped paths by operator and family but
did not capture a source-native base identifier. The earlier exporter therefore
formed nominal bases from consecutive eligible traces, which cannot establish
that the three traces are repeated executions of the same task. The pinned
repository also exposed no repository-level license; licenses under vendored
packages did not establish redistribution rights for the trace corpus. Its
2,361 matched paths, 1,736 unique blobs, 216 downloaded artifacts, and 288 path
redactions still exercise retrieval, hashing, privacy projection, packet
separation, and fail-closed review mechanics. They do not satisfy the source
contract for confirmatory research. The historical recipe and generated record
remain at
`docs/research/evidence/promotion-trial-candidate-source-v7.json` and
`docs/research/evidence/promotion-trial-candidate-handoff-v7.json`.

The replacement v8 route uses the pinned
[researchrubrics-react](https://huggingface.co/datasets/yoonsanglee/researchrubrics-react)
dataset revision `a81ac0d8ef324b3a8f705624de3fc99f75e45fd8`. The dataset
card declares an MIT license, and the recipe binds the card and all three
Parquet files by SHA-256. License metadata is evidence for human review, not a
legal decision produced by AutoLabOS. The 2,424 rows expose three model-defined
operator groups, ten task-domain groups, and a source-native sample identifier.
Selection resolves operator, family, and base from declared JSON pointers,
retains the first three lexical rows for each exact group, and balances 72
operator-conditioned candidate groups before predictions, costs, or
automatic-judge outputs are inspected. The resulting 216 rows contain exactly
three distinct source rows per candidate group. However, operator was part of
the selection identity: grouping by source family and source-native base while
excluding operator yields only 37 distinct tasks and 35 duplicate groups. The
largest nominal family share is 0.1111 and the largest nominal operator share
is 0.3333.

The Parquet file hashes and row locators anchor the original source. Source and
reviewer JSON projections receive separate hashes. Recipe-authorized reviewer
projection removed fourteen credential-like, private-path, or reviewer-identity
occurrences; a packet-wide scan found no remaining model identifier, source
identity, credential pattern, or private machine path. The reviewer and license
packets passed their isolated runtime inspections. The original handoff also
passed the earlier inspector, but the strengthened inspector now returns
`trial_candidate_handoff_source_base_duplicate`. The reviewer artifact tree hash is
`0903701a0989d9f36f852e3c43bd879b3a9cdf9b03016fe15b2a6387b9691606`.
Automatic-judge fields remain observable trace content only and are not labels,
human judgments, or eligibility evidence.

Two unassigned 72-task reviewer worksheets and one unassigned source-license
worksheet were generated from the closed v8 handoff. Each worksheet sets its
human and independence attestations to false and leaves every judgment empty.
Reviewer preflight rejected both files with zero accepted annotations; license
preflight rejected the license file with an unresolved reviewer, unresolved
status, and zero evidence references. Joint adjudication then accepted zero of
72 labels and emitted neither labels nor an evidence summary. These failures
confirm the input and promotion boundaries without creating human evidence.
Packet-manifest and worksheet hashes are recorded in
`docs/research/evidence/promotion-trial-candidate-review-preflight-v8.json`.

The portable source recipe is
`docs/research/evidence/promotion-trial-candidate-source-v8.json`; the historical
generated counts and retrospective source-base audit are recorded in
`docs/research/evidence/promotion-trial-candidate-handoff-v8.json`. This does
not close the numerical or structural trace-candidate floor. The three operator
groups are model identities from one rollout harness, and the ten families are
domains within one benchmark rather than ten independent research systems. The
source license has not received human review, two independent candidate reviews
have not been completed, comparison results and readiness artifacts have not
been verified, and no candidate has entered the frozen confirmatory corpus. The
paper-scale admission count therefore remains zero.

The v9 route replaces the undersized trace source with the pinned, ungated
[SWE-agent trajectories](https://huggingface.co/datasets/nebius/SWE-agent-trajectories)
revision `68195a1450865274106246d0d0296a1d6807b88e`. The official dataset
metadata declares CC BY 4.0, 80,036 executed trajectories, source-native task
IDs, three operator identities, binary outcomes, complete interaction traces,
generated patches, and evaluation logs. The source bytes contain 3,591 tasks;
4,130 task-operator groups have at least three rows, covering 3,504 distinct
tasks. These counts were computed from the pinned Parquet identity and outcome
columns. They do not replace human license review or establish that every row
is an independent stochastic repeat.

The portable v9 recipe derives a repository family from each task ID using a
declared `prefix_before_last` transform, keeps the complete task ID as the base,
and selects before reading outcomes, patches, logs, or trajectories. The
generated handoff contains 72 distinct task bases, 72 repository families, 216
rows, and 24 selected bases per operator. Its largest family and operator shares
are 0.0139 and 0.3333. Runtime inspection passes, all twelve Parquet hashes and
the README hash match the official revision, and an independent exact-string
scan finds zero controller source, family, base, or operator identities in the
216 reviewer artifacts. The reviewer packet occupies approximately 20 MB and
records 204 privacy redactions.

This closes only the source-native three-row trace floor. A pre-content audit
of the selected task IDs finds a second three-row operator group for 48 bases;
24 bases have only the selected operator. Therefore v9 does not yet provide 72
source-grounded paired comparisons. The source also does not contain paper
figures, claim-to-evidence maps, or paper-readiness decisions. AutoLabOS must
not reinterpret those absent artifacts as source observations. A future
canonical benchmark-curation stage may derive controlled positive envelopes
only under a separate provenance class, after a paired-comparator contract and
independent human review are complete. Such envelopes would support a
controlled governance benchmark, not a claim about naturally occurring paper
quality.

The v9 recipe and generated evidence record are
`docs/research/evidence/promotion-trial-candidate-source-v9.json` and
`docs/research/evidence/promotion-trial-candidate-handoff-v9.json`. No v9 item
has been human approved, canonically curated, or admitted to confirmatory
evaluation. The paper-scale admission count remains zero.

The v10 route upgrades the source contract by fixing eligibility, ordering, and
balancing before semantic inspection of outcomes, patches, logs, or
trajectories. It retains only source-native tasks with at least two eligible
three-row operator groups, forms a pair with different operator identities and
disjoint rows, and balances primary operator, comparator operator, and
repository family. A later mechanical privacy preflight reads selected bytes
only to apply the declared fail-closed projection and may exclude a complete
task before the same ordering rule backfills it. The generated handoff contains
72 distinct tasks, 72 repository families, and 432 rows. Primary and comparator
operator-group counts are each balanced 24/24/24; no pair reuses an operator,
source path, source-row hash, or public trial ID.

The declared privacy projection is applied as a mechanical preflight. One
selected task failed the fail-closed projection and was excluded in full; the
same outcome-blind traversal then backfilled the batch to 72 tasks. The final
packet records 380 redactions, 438 reviewer-side files, 34,345,592 bytes, and
no empty files. An exact-string scan over 147 controller identities found zero
matches in the reviewer packet. Runtime inspection reports zero issues. A
same-flow CLI rerun reproduced the canonical generated-recipe hash
`a1dd066c1a69fd2ed12e26913ea6ad93ed1d9cdeedd6621b0e519174341feac5`
and reviewer tree hash
`8eac031b59e170fc018344862f8007acddf7a668f7e94d0cadc2120b02ea384e`.

This closes the source-native trace and structural paired-comparison candidate
floors only. Different source operator labels do not prove independent
stochastic sampling, and automated integrity checks do not establish human
comparability or redistribution approval. Two independent candidate reviews,
human license review, canonical clean-control curation, and confirmatory freeze
remain incomplete. The v10 recipe and evidence record are
`docs/research/evidence/promotion-trial-candidate-source-v10.json` and
`docs/research/evidence/promotion-trial-candidate-handoff-v10.json`. The
confirmatory admission count remains zero.

Two 72-task reviewer worksheets and one source-license worksheet have now been
prepared from the closed v10 packets. They retain distinct unassigned role
slots, null observations and decisions, empty rationales, and false human and
independence attestations. The two annotation preflights therefore report
zero coverage and zero source-eligible candidates, while the license preflight
reports an unresolved decision with no evidence references. Combining these
three incomplete inputs in adjudication emits neither accepted labels nor an
evidence summary and leaves the accepted count at zero. Their hashes and exact
fail-closed outcomes are recorded in
`docs/research/evidence/promotion-trial-candidate-review-preflight-v10.json`.
This establishes reviewer handoff readiness only; it is not human-review or
license evidence.

The v10 handoff can now be materialized into three separately distributable
packages without manual copying: two opaque paired-candidate packages and one
source-license package. The controller-side campaign manifest binds the exact
upstream handoff, packet manifests, templates, and return guides. All 144
candidate labels, the license decision, and every human attestation remain
unfilled, so the campaign status is `human_review_pending`, completed human
annotation count is zero, and confirmatory admission remains zero. This closes
the packet-isolation and return-template preparation gap only; real independent
people must still complete and return the three inputs.
The actual v10 campaign passes standalone inspection with 888 hash-bound files
and no controller path in any participant package. Its local materialization is
approximately 72 MB because the two reviewer snapshots are physical copies;
hard links are avoided so one reviewer's edits cannot alter the other package.

The controller return path now has an assignment-bound collector. It rechecks
the pristine campaign and complete handoff, requires the two annotation
pseudonyms and source-license reviewer pseudonym to match their assigned slots,
copies the exact returned bytes, and verifies that any adjudication report used
those copied hashes. A same-flow run over the three still-blank v10 templates
produced an integrity-valid blocked receipt: all three pseudonymous assignments
matched, adjudication attempted and failed, accepted labels remained 0/72, and
confirmatory admission remained false. This closes a runtime provenance gap
only: no completed human v10 return has been collected, the human annotation
count remains zero, and the confirmatory admission count remains zero. The
observed contract outcome is recorded in
`docs/research/evidence/promotion-trial-candidate-review-preflight-v10.json`.

The post-review operator boundary is now executable without manufacturing the
missing judgments. A passing adjudication can be transformed into a
self-contained canonical-curation handoff with six hash-bound traces and the
15-role artifact contract per source-eligible task. The generated tasks remain
`pending_human_curation`, their curator and verifier attestations remain
false, and the handoff records zero canonical sources and zero confirmatory
admissions. Because the real v10 annotations and license decision remain
incomplete, no real v10 curation handoff can pass this command yet.

The implementation now separates the old 20-base provisional intake from a
72-base paper-scale intake. The latter accepts only candidate IDs recovered
from an integrity-valid paired handoff and recomputed as source-eligible from a
hash-bound double-human adjudication. Every source must also carry a schema
`1.1` `benchmark_curated` record that binds all six source traces, distinct
curator and verifier roles, protocol versions, timestamps, and the hashes of the
15 canonical result, execution, review, paper, figure, claim, citation, and
readiness artifacts. Hash validity is not sufficient: intake independently
checks result arithmetic, six-trial coverage, planned/executed budget equality,
completed run state, figure-audit clearance, exact claim/evidence/citation
linkage, evidence-store resolution, and consistent checkpoint/review/paper
readiness. This schema gate is independent of the evaluated promotion policy.
A synthetic end-to-end regression reaches 72 bases and 720 cases; it validates
the gate implementation only and does not alter the zero-admission status of
the real v10 candidate set.

The five-route public source comparison is frozen in
`docs/research/evidence/promotion-source-portfolio-v2.json`. It retains two
ungated corpora as holdout routes and excludes gated or non-redistributable raw
corpora from the default reproduction package. The provenance and admission
rules for future controls are defined in
`docs/research/promotion-benchmark-curation-boundary.md`. These records do not
change the zero-admission decision.

### Citation Claim Review Handoff

The manuscript's 14 citation-bearing claims are now separated into 12
full-text-backed review tasks and two missing-source blockers. A deterministic
handoff binds the current claim TSV, evidence-status record, Refgate lock, each
candidate passage, public record URL, source locator, and full-text SHA-256.
The reviewer package contains no third-party PDF and no controller-local path.
Its return template leaves all decisions and reviewer identity null and all
human and independence attestations false.

The generated incomplete return fails the same preflight used for future human
reviews: no reviewer is accepted, the claim gate remains closed, and no claim
status changes. A completed return must cover all 12 tasks, inspect the full
source text, and choose `supported`, `rewrite`, `wrong_source`, or
`missing_source` with decision-specific evidence. Structural preflight does not
prove real-world reviewer identity and cannot write `checked`; explicit final
approval and a separate Refgate import remain mandatory. The two unavailable
OpenReview full texts remain submission blockers rather than being replaced by
metadata or abstract evidence.

### Exploratory Instrument Check

A deterministic development run exercised the complete local instrument on
four synthetic base bundles and 40 paired cases. The artifact-grounded policy
matched the provisional labels on this generated suite, while the ungated,
presence-only, and concern-without-action conditions produced false promotions.
These values validate evaluator wiring only: the suite has one deterministic
trial, no held-out external sources, no independent human adjudication, no
provider repetition, and no post-repair evidence.

The same outputs were passed to the confirmatory gate rather than interpreted
as paper results. Score validation passed, but the gate returned
`blocked_for_paper_scale` with 50 findings. It routed insufficient scale,
held-out status, and source-family coverage to `design_experiments`; evidence
eligibility to `review`; and the missing provider, comparison-system, and
recovery records to `run_experiments`. Point estimates that appeared to support
H1 and H4 did not override these blockers, while the four-base intervals were
already too wide to support H2 or H3.

The cross-verified, hash-bound summary is
`docs/research/evidence/promotion-development-evidence-v1.json`. Its source
artifacts remain local run products and are represented by logical roles plus
SHA-256 values, not by machine-specific paths. The exporter refuses
paper-eligible input, a non-blocked gate decision, hash drift, system-coverage
drift, or a missing blocker-to-node recommendation.

### Confirmatory Decision Boundary

The implementation now separates benchmark score validity from paper-scale
claim eligibility. The confirmatory gate revalidates three source provider-run
manifests, merges only their hash-verified manuscript-only predictions,
recomputes all system and paired metrics, checks the frozen sample and
source-family contracts, and consumes a post-repair manifest whose recovery
and clean-control regression rates are derived from raw suites and predictions.
It also emits the same `paper_scale_diagnostics.json` and
`node_strengthening_recommendations.json` shapes used by the promotion
meta-harness.

The gate can return `paper_scale_candidate` for a complete null or negative
result while lowering its claim class; hypothesis support is not used as a
proxy for evidence validity. Missing evidence returns
`blocked_for_paper_scale` and identifies `design_experiments`,
`run_experiments`, `analyze_results`, or `review` as the recheck target. The
gate never returns `paper_ready=true`.

This is an implemented evaluation contract, not a completed experiment. At
the current checkpoint, no human normalization labels have been admitted and
no three-run external provider aggregate has been executed for a paper-eligible
suite. Therefore no confirmatory metrics, hypothesis verdicts, or paper-scale
empirical claims exist yet.

## Minimum Publishable Experiment

- At least 72 source-hash-distinct base bundles covering positive, null, and
  negative outcomes, drawn from at least three declared source families and
  three declared operator groups with no group above 50 percent.
- At least 720 held-out cases total. At the 72-base floor, each base contributes
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

The primary target is an archival long paper at REALM 2026, the Second Workshop
for Research on Agent Language Models at EMNLP 2026. Its official call includes
agent quality evaluation, safety and robustness, and ethics and governance;
long submissions may use up to eight content pages and must use the ACL 2026
style. As checked on 2026-07-18, the direct-submission deadline is 2026-08-05
Anywhere on Earth. The official generic `acl` review style is vendored with the
manuscript from a pinned upstream commit. The NeurIPS 2026 AutoResearch
workshop remains a secondary thematic fit, but its separate template and
submission schedule are not used for the REALM manuscript.
