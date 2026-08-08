# Research Topic Search Portfolio: Verification-Unit Refresh

## Controller State

- Search date: 2026-08-07
- Leading candidate selected for frozen development: `topic_scicoqa_obligation_retrieval`
- Topic selected for a paper: `false`
- Experiment authorization: `frontier development only after real provider access`
- Paper ready: `false`
- Historical candidates and studies: quarantined unless explicitly re-admitted
- Selection rule: literature fit, agent consensus, and data access do not authorize execution

This refresh changes the research object, evidence modality, and evaluation unit
after the previous portfolio produced no pilot-ready candidate. It also treats a
dataset previously assumed to be locally convenient as a liability rather than
a reason to revive a terminated formulation. A candidate may advance only after
direct-prior review, data-rights review, an outcome-blind executable preflight,
and an explicit kill rule.

## Direct-Prior Pressure

| Work | Primary source | Constraint on this portfolio |
|---|---|---|
| FLAWS | https://arxiv.org/abs/2511.21843 | Already defines altered-PDF top-k scientific error localization and releases exact source mutations. |
| SciReview | https://openreview.net/forum?id=k4bz0CMaO3 | Already establishes false-positive-aware scientific-review scoring and ranking changes; generic selectivity claims are unavailable. |
| Automatic Reviewers Fail to Detect Faulty Reasoning | https://arxiv.org/abs/2508.21422 | Already compares reviews of original and counterfactually edited papers; generic edit-sensitivity claims are unavailable. |
| PaperAudit-Bench | https://arxiv.org/abs/2601.19916 | Already evaluates long-paper error coverage and finding precision while warning that unmatched findings need not be false positives. |
| LIT-RAGBench | https://arxiv.org/abs/2603.06198 | Already constructs same-question sufficient/insufficient-evidence pairs by removing positive evidence. |
| Context Perturbation in Science QA | https://aclanthology.org/2024.findings-emnlp.197/ | Already measures answer-to-abstain changes under removed, random, and noisy scientific context. |

The broad claims that automated reviewers need false-positive penalties, that
counterfactual edits can test reviewer sensitivity, and that missing evidence
can test abstention are therefore absorbed.

## Current Portfolio

| Candidate | Research object | Evaluation unit | Data/access | Current decision |
|---|---|---|---|---|
| `topic_flaws_same_location_attribution` | attribution of a localization hit to an inserted edit | clean/altered top-k hit pair, clustered by source paper | reported CC BY 4.0 dataset and MIT code labels; exact source, extraction, and build provenance unattested | `KILL_PROVENANCE` |
| `topic_peerqa_evidence_removal_transfer` | transfer validity of synthetic evidence removal | same-question answer/abstain pair | PeerQA and LIT-RAGBench are public | `KILL_BROAD_HOLD_NARROW` |
| `topic_claimcheck_scope_sensitivity` | claim-grounding sensitivity to context scope | weakness-to-claim association under matched context | paper and annotations described; redistribution/license basis not closed | `HOLD_LICENSE` |
| `topic_autosupervision_resolution_conflict` | disagreement among response, manuscript change, and evidence | reviewer-obligation resolution tuple | 56,000-record corpus described; executable release not verified | `HOLD_ACCESS` |
| `topic_reviewbench_rubric_leakage` | evaluator dependence on human-review-derived rubrics | review score with and without protected rubric fields | public executable data and license not verified | `HOLD_ACCESS_LICENSE` |
| `topic_abgen_eval_defect_sensitivity` | evaluator response to controlled ablation-design defects | clean/defective design judgment pair | benchmark described; public data license not verified | `HOLD_LICENSE` |
| `topic_literal_evidence_paths` | static result-to-report provenance in research repositories | independent repository workspace | public repositories passed an outcome-blind structural scan | `KILL_PREFLIGHT` |
| `topic_scicoqa_obligation_retrieval` | retrieval of discrepancy-bearing code for paper-code audits | independent paper/repository pair | 86 licensed pairs materialized; 72 confirmatory units remain sealed | `HOLD_EXTERNAL_PROVIDER_AUTHORIZATION` |

The refreshed candidates span scientific error localization, evidence-conditioned
answerability, claim grounding, revision verification, rubric-based review
evaluation, experimental-design evaluation, result provenance, and paper-code
retrieval. SciCoQA obligation retrieval is selected only for its frozen
development gate; it is not yet selected as a paper topic.

## Terminated Candidate: `topic_flaws_same_location_attribution`

### Residual Question

For the same source paper, target location, prompt, model, and top-k budget, how
often does a localization hit occur only after the FLAWS edit rather than on
the corresponding clean-source location as well?

Let `A` indicate an altered-paper hit at the injected location and `C` indicate
a clean-paper hit at its mapped original location. The candidate must report
the complete `00/01/10/11` table. Its primary endpoint is the paper-clustered
paired effect `delta = E[A-C] = p10-p01`; `p10 = P(A=1,C=0)` is a key secondary
diagnostic, not a global false-positive rate. A clean-location hit is called
stable location suspicion, not proof that the model made a false scientific
criticism.

### Unverified Diagnostic Context

- Dataset revision: `xasayi/FLAWS@a20a57860ed4afc8a046a73abab6bd1222068762`
- Official code revision: `xasayi/FLAWS@80309b1948c45a43ab6b9c128247eecdf4c4db0e`
- Code license: MIT
- Dataset card license: CC BY 4.0

These identifiers and license labels describe the intended source boundary, not
a verified execution receipt. Earlier quantitative mapping, layout, input-size,
and hardware observations were invalidated because archive hashes, fresh
extraction, and the build toolchain were not fully enforced. They cannot support
selection, feasibility, or scientific claims.

Raw papers and archives remain outside Git. A reproducibility bundle may ship
download scripts, revision IDs, hashes, mappings, and derived measurements, but
must not redistribute embedded paper sources without per-paper rights review.

### Non-Overlap and Absorption Objection

SciReview absorbs the broad false-positive-aware claim, and Dycke and Gurevych
absorb the broad original-versus-counterfactual comparison. The only residual
unit is deterministic same-location discrimination on full papers. This is a
narrow composition of existing ideas, so novelty remains `HOLD` unless a
frozen probe finds a material and stable attribution gap or model-order change.

The terminated `studies/reviewer-evaluator-audit` formulation is not revived.
Its paper-versus-code scorer discrepancy changed only 8 of 575 public cells,
below its frozen materiality gate. Independent methods and scorer audits both
rejected a combined scorer-repair plus same-location paper. Those scorer
findings are known negative background, not a new contribution and not a
reason to authorize this candidate.

### Required Preflight

1. Hash clean, metadata, and altered sources; deterministically replay each edit
   onto the clean source and require byte-identical altered output. Ambiguous,
   fuzzy-only, or damaged pairs fail closed before model output exists.
2. Derive equal-length target windows from the actual token diff core rather
   than the metadata envelope, and freeze byte offsets plus bilateral context
   hashes for every eligible pair.
3. Build both clean and altered PDFs fresh under the same pinned container,
   TeX toolchain, fonts, job name, epoch, and raster DPI. Existing altered PDFs
   are diagnostic inputs only.
4. Define a model-output-blind layout-stable primary subset using frozen page,
   column, and anchor-movement rules; report the full mapped set as sensitivity.
5. Make a neutral prompt that allows an empty list the primary arm. Keep the
   original presuppositional prompt secondary and freeze the interaction test.
6. Freeze an exact deterministic prediction-to-PDF matcher, opaque document
   IDs, independent sessions, pair-blind ordering, top-k budgets, model
   revisions, decoding, retries, invalid-output handling, and paper-cluster
   uncertainty. Do not use an LLM judge in the primary endpoint.
7. Add a random-location and a length, style, and number-matched surface
   placebo. Without a scientifically valid placebo, cap the claim at
   injection-responsive same-location selection rather than semantic detection.
8. Use at least two independent model families for a paper-scale phenomenon
   claim and at least three for any model-order claim. A single Qwen3-VL family
   may support only a bounded feasibility decision.
9. Run a small outcome-blind gate before full execution.

### Pilot Kill Rule

A bounded pilot may promote this candidate only if all mapping/build gates pass
and the altered-versus-clean paired effect exceeds a frozen materiality floor
relative to the surface-placebo effect. Source replay and target mapping must
succeed for every included pair; projected layout-stable coverage must include
at least 40 unique paper clusters; invalid model output must remain at or below
5%; condition leakage must remain zero; and at least 20 GB of disk must remain.
The exact paired-effect margin, pilot sample size, and promotion calculation
must be frozen before any pilot output is generated. A null, unstable, or
placebo-equivalent pilot kills the candidate; it is not converted into a
generic FLAWS reproduction note.

### Termination Result

The diagnostic rerun did not enforce the frozen archive hashes, prove fresh
extraction, or fully attest a fresh build toolchain. Its replay, build, and
layout-filter counts therefore cannot serve as scientific gate evidence. The
candidate is killed on provenance before model execution, and the unverified
receipts are excluded from the public study bundle. The decision is recorded in
`studies/flaws-counterfactual-attribution/method/termination-decision.v2.json`.

### Claim Ceiling

No empirical FLAWS result is currently admissible. A future provenance-valid
rerun could at most conclude that under pinned models, prompts, rendering,
matcher, and FLAWS extension, some altered-paper hits do or do not survive a
same-location clean control. It could not estimate the true false-positive
rate, claim causal scientific understanding, generalize to all AI reviewers,
or infer benchmark-wide validity from the non-ML extension alone.

## Terminated Candidate: `topic_literal_evidence_paths`

The conservative outcome-blind structural preflight found eligible targets in
25 of 40 confirmatory workspaces and 2 of 5 development workspaces. Both frozen
eligibility floors failed. Python parsing, generated-mutation parsing, and the
duplicate-target rate passed; the two surviving development mutations remain
unaudited after the scalar-classifier revision, so manual validity also failed.
The candidate was terminated before model execution with process exit code 2
and without weakening any threshold. The decision is recorded in
`studies/literal-evidence-paths/method/termination-decision.v1.json`.
The threshold set predates the initial scan, but corrected scanner semantics and
registry/audit hash bindings were added after structural eligibility was known;
the contract records this as a post-scan integrity amendment, not preregistered
confirmatory evidence.

## Development Candidate: `topic_scicoqa_obligation_retrieval`

This candidate asks whether implementation obligations derived from a paper
improve localization of discrepancy-bearing scientific-code files over the
strongest equal-budget generic retrieval baseline. SciCoQA already absorbs the
broad paper-code auditing task, while repository RAG and code-search work absorb
generic retrieval and query reformulation. The remaining comparison is narrowly
defined as obligation structure versus an equal-call generic frontier selector.

The outcome-blind access gate found 86 eligible paper/repository pairs against a
floor of 80. A zero-failure fresh-download materialization produced 86
independent repository components with no duplicate component, split into 8
development, 72 sealed confirmatory, and 6 reserve units. The blind candidate
universe contains 5,690 files. Every extracted paper and mutated repository tree
is byte-hash bound, and each split has a separate sealed-gold manifest.
Confirmatory gold fields have not been opened.

Under the frozen 16,384-token selected-code budget, development macro changed-file
recall was 0.6563 for alphabetical selection, 0.7604 for generic hybrid retrieval,
0.8021 for deterministic obligations, 0.8021 for methods-only BM25, and 0.8438
for whole-paper BM25. Deterministic obligations therefore do not promote the
candidate. The frozen frontier comparison remains unexecuted. It requires 16
fresh `gpt-5.6-sol`/`high` Responses API calls that transmit paper text and
repository-derived content to a paid external service, so explicit data-egress
and cost approval is required. Codex mock outputs and provider-cache replay are
prohibited from paper evidence.
Any future frontier prediction must also bind the complete raw Responses API
payloads, model and reasoning identity, usage, token ceiling, latency, request
and response hashes, and the full frozen unit-by-system grid in one canonical
execution receipt. Evaluation and promotion fail closed without that receipt.
The current freeze v3 is also a transparent post-development integrity
amendment: development outcomes were already known, confirmatory outcomes were
not, and the scientific split, metric, baselines, budget, model, and promotion
thresholds were unchanged.

The candidate promotes only if frontier obligations exceed the strongest
non-oracle development baseline by at least 0.10, improve on at least five of
eight development papers, and beat the frozen methods, hybrid, and generic
frontier comparators. Failure terminates the candidate without opening
confirmatory gold.

## Scorecard

Scores use a 1-5 scale and cannot authorize execution. `N/A` means the axis is
not scored because the evidence required for that score is invalid or absent.

| Candidate | Importance | Non-overlap | Falsifiability | Baseline | Eval validity | Realism | Local feasibility | Null value | Workshop fit | Reproducibility | Decision |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `topic_flaws_same_location_attribution` | 4 | 2 | 5 | 5 | 4 | 4 | N/A | 4 | 5 | N/A | Kill provenance (local feasibility and reproducibility unscored) |
| `topic_peerqa_evidence_removal_transfer` | 4 | 1 | 5 | 5 | 3 | 4 | 5 | 4 | 3 | 5 | Kill broad; hold narrow |
| `topic_claimcheck_scope_sensitivity` | 4 | 2 | 4 | 4 | 4 | 5 | 4 | 4 | 4 | 2 | Hold license |
| `topic_autosupervision_resolution_conflict` | 5 | 2 | 4 | 5 | 4 | 5 | 2 | 5 | 5 | 2 | Hold access |
| `topic_reviewbench_rubric_leakage` | 4 | 2 | 4 | 5 | 3 | 4 | 3 | 4 | 4 | 2 | Hold access/license |
| `topic_abgen_eval_defect_sensitivity` | 3 | 2 | 4 | 4 | 4 | 4 | 4 | 4 | 3 | 2 | Hold license |
| `topic_literal_evidence_paths` | 4 | 2 | 5 | 4 | 2 | 4 | 4 | 4 | 3 | 4 | Kill preflight (25/40 confirmatory, 2/5 development, manual audit 0/2) |
| `topic_scicoqa_obligation_retrieval` | 4 | 3 | 5 | 5 | 4 | 4 | 4 | 5 | 4 | 5 | Hold external provider authorization |

The FLAWS and literal-evidence candidates are terminated. SciCoQA obligation
retrieval has passed access and materialization gates but has not passed its
frontier development gate. All other entries remain unselected comparison
points.

## Next Allowed State

1. Keep all terminated formulations quarantined.
2. Preserve the frozen SciCoQA split, budget, prompts, baselines, metrics, and
   promotion rule.
3. Run only the two equal-call frontier development systems after explicit
   approval for paid external transfer of paper and repository-derived content.
4. Terminate the candidate if its development gates fail. Open confirmatory gold
   only after a recorded promotion decision.

Paper drafting and confirmatory execution remain forbidden.
