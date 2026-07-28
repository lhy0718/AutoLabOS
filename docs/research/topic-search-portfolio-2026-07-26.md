# Research Topic Search Portfolio

## Search Frame

- Status: `portfolio_refresh_after_pre_execution_kill`
- Topic selected: `false`
- Search date: 2026-07-26
- Target: REALM @ EMNLP 2026 archival short paper
- Direct-submission deadline: 2026-08-05, 23:59 Anywhere on Earth
- Local resources: two RTX 4090 GPUs, 125 GiB RAM, local open-weight language models
- Candidate policy: retain five to seven candidates across at least three independent research clusters before narrowing
- Historical portfolio breadth: seven candidate records across seven independent clusters
- Active refresh routes: review closure, counterevidence revision, run integrity, and executable-idea utility
- Current primary probe dataset: none
- Current external-validation dataset: none
- Promotion rule: literature scores and reviewer consensus cannot select a topic; a preregistered local execution probe must pass
- Last preregistration: `docs/research/relation-serialization-probe-preregistration-v1.json`; frozen but failed its binding pre-execution audit

The search optimizes for a credible workshop contribution under a short execution window. The primary ranking target is not apparent novelty. It is the probability of producing a falsifiable, baseline-bearing, reproducible result whose claims remain useful if the main hypothesis fails.

## Current Controller Decision

`topic_relation_serialization` is killed before inference. Its frozen 70-record manual-audit universe required every record to pass. The binding semantic audit passed 31 records and failed 39, so sample replacement, sample expansion, threshold reduction, and model execution are forbidden. No research-model call was made. The exact decision receipt is `docs/research/relation-serialization-probe-decision-v1.json`.

The portfolio is therefore being regenerated. Plain review generation and unconstrained paper revision are not viable gaps: recent work already evaluates faulty-reasoning detection, real reviewer-comment-to-edit alignment, full autonomous paper revision, scientific error localization, multimodal inconsistency remedy, and full-manuscript review. The only review route still worth a source-feasibility audit is narrower: whether an execution-requiring revision can be proven complete from artifact and rerun receipts, rather than merely judged as a better paper.

## Verified Evidence Basis

| Evidence ID | Source | Verification depth | Relevant finding | Candidate-evidence use |
|---|---|---|---|---|
| `src_preregister_next_model` | Thomas, Gligoric, and Shah (2026), *Mitigating LLM-based p-Hacking by Preregistering for the Next LLM*, arXiv:2606.27687 | Full paper checked | Prompt, decoding, and output flexibility can support desired conclusions. The paper evaluates commitment to the first eligible future model and explicitly recommends integration into autonomous research systems. | Closest prior for `topic_null_contract` |
| `src_agent_preregistration` | Vaccaro (2026), *Preregistration for Experiments with AI Agents*, arXiv:2606.11217 | Full paper checked | Catalogues model, prompt, sampling, retry, parsing, analysis, and reporting freedoms; proposes a detailed preregistration template and staged adaptive rules. | Closest prior for `topic_null_contract` and `topic_adaptive_reporting` |
| `src_hidden_pitfalls` | Luo, Kasirzadeh, and Shah (2025), *The More You Automate, the Less You See*, arXiv:2509.08713 | Full paper checked | Controlled experiments identify post-hoc selection bias in two AI-scientist systems. Trace logs and code improve pitfall detection over paper-only review. | Closest prior for `topic_null_contract`, `topic_review_backtracking`, and `topic_run_integrity` |
| `src_prompts_dont_protect` | Uppala (2026), *Prompts Don't Protect: Architectural Enforcement via MCP Proxy for LLM Tool Access Control*, arXiv:2605.18414 | Full text checked | Directly compares prompted restrictions with runtime filtering across three models. The paper body reports 200 adversarial tasks, while the arXiv abstract reports 150; both report residual prompted unauthorized invocation and zero governed unauthorized invocation. | Primary absorption prior: generic prompt-versus-enforcement and unauthorized-tool-use novelty is unavailable |
| `src_scientific_cicd` | *Scientific CI/CD for Self-Modifying Discovery Agents: Statistical Goedel Gates, Capacity Budgets, and Domain Verifiers* (2026) | Public OpenReview PDF checked | Protected holdouts, anytime-valid gates, capacity budgets, domain verification, replayable provenance, and 200-proposal streams address optional stopping and harmful promotion. | Primary absorption prior for protected holdouts, capacity budgets, and append-only provenance |
| `src_compressed_validation` | Bertran, Roth, and Wu (2026), *What Fits (Into Few Tokens) Doesn't Overfit*, arXiv:2606.11045 | Official abstract checked | Tests adaptive validation reuse through one-bit feedback and short-prompt reproduction; deliberately induced overfitting fails to reproduce. | Absorption prior for generic adaptive holdout reuse and compressed feedback |
| `src_materials_holdout` | Ning et al. (2026), *Auto Research for Materials*, arXiv:2607.17100 | Official abstract checked | Evaluates 701 changes, freezes selected code, and tests once on an untouched holdout with transfer across materials tasks. | Absorption prior for untouched-holdout and held-out-transfer evaluation |
| `src_sciintegrity` | Yang, Liu, and Xu (2026), *SciIntegrity-Bench*, arXiv:2605.10246 | Official abstract checked | Evaluates 33 scenarios, 11 traps, and 7 models; prompt ablation separates completion pressure from persistent integrity failures. | Closest prior for prompt-sensitive scientific integrity behavior |
| `src_adaptive_falsification` | Li et al. (2026), *Let the Abyss Stare Back*, arXiv:2603.29045 | Official abstract checked | Adaptive falsification under a fixed scientific contract rejects artifacts that static validation accepts and tests transfer beyond the discovery environment. | Absorption prior for adaptive falsification as a general contribution |
| `src_auditweave` | Nakrani (2026), *AuditWeave*, arXiv:2607.09682 | Official abstract checked | Implements and evaluates an append-only hash-chained evidence ledger with mutation detection and low recording overhead. | Primary absorption prior: hash chaining is infrastructure, not novelty |
| `src_agent_verdict_layer` | Alizadeh et al. (2026), *AI Coding Agents in Social Science*, arXiv:2606.11456 | Abstract and official metadata checked | A confirmatory prompt changed verdicts from 10% to 90% while leaving coefficient distributions essentially unchanged, separating analysis design from interpretation. | Closest prior for `topic_counterevidence_revision` |
| `src_agentic_science_limits` | Bisht et al. (2026), *Agentic AI Scientists Are Not Built For Autonomous Scientific Discovery*, arXiv:2605.08956 | Abstract and official metadata checked | Identifies problem selection, missing failure knowledge, diversity compression, and weak feedback as structural barriers; recommends preregistered hypotheses. | Search-space and systems motivation |
| `src_claimcheck` | Ou et al. (2025), *CLAIMCHECK: How Grounded are LLM Critiques of Scientific Papers?*, Findings of EMNLP 2025 | ACL Anthology paper record and abstract checked | LLMs underperform experts on linking weaknesses to claims and grounded claim verification. | Closest prior for `topic_review_backtracking` |
| `src_scientistone` | Meng et al. (2026), *ScientistOne: Towards Human-Level Autonomous Research via Chain-of-Evidence*, arXiv:2605.26340 | Primary abstract checked | Introduces claim-to-evidence chains and audits reference, score, specification, and method-code alignment. | Absorption prior for `topic_claim_artifact_integrity` |
| `src_badscientist` | Jiang et al. (2026), *BadScientist: Can a Research Agent Write Convincing but Unsound Papers that Fool LLM Reviewers?*, ACL 2026 | ACL Anthology paper record and abstract checked | Fabrication-oriented research agents can fool LLM review systems despite aggregation. | Closest prior for `topic_review_backtracking` |
| `src_faulty_reasoning_review` | Dycke and Gurevych (2026), *Automatic Reviewers Fail to Detect Faulty Reasoning in Research Papers*, TACL | ACL Anthology record and abstract checked | A controlled counterfactual framework finds that faulty research logic has no significant effect on automatic reviews. | Direct prior for fault detection; absorbs a generic automatic-reviewer benchmark |
| `src_aries` | D'Arcy et al. (2024), *ARIES: A Corpus of Scientific Paper Edits Made in Response to Peer Reviews*, ACL | ACL Anthology record and abstract checked | Links real reviewer comments to author edits; models struggle with indirect edit alignment and generate superficial, technically thin revisions. | Direct prior for review-comment-to-edit mapping and revision generation |
| `src_revisebench` | Luo et al. (2026), *Can AI Revise Research Papers with Human Review Feedback?*, Findings of ACL | Full public repository structure plus ACL Anthology record and abstract checked | Evaluates paper interpretation, experimental implementation, and paper formulation against human camera-ready revisions; reports under 10% win rate and potential fabrication. The repository exposes 12 source paper workspaces, execution logs, original/human/model PDFs, and automated pairwise evaluation, but no repository license is detected. | Primary absorption prior for autonomous review-to-revision; possible inspection-only feasibility source, not yet approved for experimental reuse |
| `src_flaws` | *FLAWS: A Benchmark for Error Identification and Localization in Scientific Papers* (2025); official repository and dataset | Repository, dataset card, license, file manifest, and task structure checked | Provides 713 original/altered scientific-paper pairs with inserted-error text and locations. The dataset is CC BY 4.0, code is MIT, and two non-ML archives contain 67 and 48 examples at about 351 MB and 225 MB. | Public candidate source for a bounded detection-to-verified-repair probe |
| `src_prismm` | Selch et al. (2026), *PRISMM-Bench*, ICLR | Current arXiv abstract checked | Curates 384 real reviewer-flagged multimodal inconsistencies and directly evaluates identification, remedy, and pair matching. | Absorbs a generic paper-inconsistency correction task |
| `src_pat` | Jayaram et al. (2026), *Towards Automating Scientific Review with Google's Paper Assistant Tool* | Current arXiv abstract checked | Full-manuscript review and verification improves mathematical-error recall over zero-shot and suggests substantive improvements. | Absorbs broad deep-review and recommendation claims; does not by itself establish executed repair closure |
| `src_sciclaimeval_dev` | Ho et al. (2026), *SciClaimEval: Cross-modal Claim Verification in Scientific Papers*; official task site and `alabnii/sciclaimeval-shared-task` | Official task specification, pinned repository metadata, Task 2 JSON, and TeX manifest directly checked; bounded parser-yield audit recorded | Revision `efb3807399acec43854fdf7741c1bcfe605a72b9` is public and non-gated. The table/`use_context=no`/CC BY 4.0 filter yields 134 rows from 63 papers, but only 104 rows from 49 papers have TeX for both evidence tables; the strict parser retains 17 paper-unique units and the multicolumn parser retains 25. | Secondary external-validation candidate; parser attrition blocks it as the primary probe |
| `src_tabverse` | Ahsan et al. (2026), *TABVERSE: Benchmarking Cross-Format Table Understanding in LLMs and VLMs*, arXiv:2606.09578 | Full-text methods and results checked | Holds table content fixed across HTML, Markdown, LaTeX, and rendered images and finds representation-dependent table performance. | Primary absorption prior: a generic same-content representation effect is not novel |
| `src_table_meets_llm` | Sui et al. (2023), *Table Meets LLM: Can Large Language Models Understand Structured Table Data?*, arXiv:2305.13062 | Official abstract and study description checked | Evaluates structural table understanding and reports sensitivity to input format, content order, prompting, and partition marks. | Closest prior for format and order sensitivity |
| `src_serialization_strategies` | Wang et al. (2025), *How to Talk to Language Models: Serialization Strategies for Structured Entities*, Findings of NAACL 2025 | Full-text problem formulation and experiments checked | Systematically compares serialization scheme, attribute order, special tokens, and plain versus JSON formats across model backbones. | Primary absorption prior: broad serialization and order effects are unavailable as the contribution |
| `src_scitab` | Lu et al. (2023), *SCITAB: A Challenging Benchmark for Compositional Reasoning and Claim Verification on Scientific Tables*, EMNLP 2023; official `XinyuanLu00/SciTab` repository | Full paper plus pinned commit, dataset JSON, README, and license directly checked | Commit `217cfbd71ebf39ba26a0938f0d87a9fce560e0fe` provides 1,224 structured claims from 80 papers and 213 tables: 457 supports, 411 refutes, and 356 not enough info. Every entry exposes `table_column_names` and `table_content_values`; all 1,224 are rectangular under the exact array check. The repository license is MIT. | Primary source-native unit and closest task prior for `topic_relation_serialization` |
| `src_scitab_align` | Ho et al. (2025), *Table-Text Alignment: Explaining Claim Verification Against Tables in Scientific Papers*, Findings of EMNLP 2025 | Full-text dataset, task, and results sections checked | Adds cell-level evidence rationales to scientific-table claim verification and finds evidence-cell selection substantially harder than final-label prediction. | Closest prior for scientific claim-to-cell binding errors |
| `src_data_referencing_errors` | Yang et al. (2026), *When LLMs Read Tables Carelessly: Measuring and Reducing Data Referencing Errors*, ACL 2026 | ACL Anthology paper record and abstract checked | Systematically measures incorrect or omitted table-value references across models and tasks and introduces a critic for those errors. | Absorption prior for generic data-referencing-error measurement |
| `src_realm_cfp` | REALM @ EMNLP 2026 Call for Papers | Official page checked | Archival short papers may report a small focused contribution or negative result; agent evaluation, robustness, and governance are in scope; ACL 2026 style is required. | Venue and deadline basis only |

Search hits are not treated as full-text evidence. Any candidate promoted beyond the pilot must have at least two closest priors checked at full-text depth and recorded in the paper evidence ledger.

## Quarantined Execution Record

### `topic_null_contract`: Agents Under Null Probe

**Rejected question.** Under an identical preregistration prompt and equal executed-analysis opportunity cap, does a hidden-holdout tool policy change adaptive scientific false-claim behavior under the global null while preserving planted-effect utility?

- Closest priors: `src_prompts_dont_protect`, `src_scientific_cicd`, `src_preregister_next_model`, `src_agent_preregistration`, `src_compressed_validation`, `src_materials_holdout`, `src_sciintegrity`, `src_adaptive_falsification`, `src_hidden_pitfalls`, `src_auditweave`
- Absorption decision: current work already covers prompt-versus-runtime enforcement, protected and untouched holdouts, adaptive validation and falsification, capacity controls, and append-only provenance. Recasting those controls as a research-method contract does not support a defensible broad method claim.
- Kill criterion satisfied: the remaining non-overlap is too narrow to survive the strongest hidden-holdout and runtime-enforcement baselines without making the paper's central claim a restatement of current literature.
- Status: `quarantined_not_executed`
- Decision: `rejected`
- Execution allowed: `false`

The existing preregistration is retained only as a quarantined audit artifact. It does not authorize a pilot and must not be used to revive or execute this topic.

## Candidate Portfolio

The historical portfolio contained seven candidate records across seven clusters. The current refresh retains four independent routes after quarantine and pre-execution kills; no route is selected for execution yet.

### `topic_relation_serialization`: Information-Equivalent Verdict Invariance Probe [Killed]

**Probe question.** Under information-equivalent serializations of identical SCITAB canonical atoms, how often do scientific-table claim verdicts flip, and how much does single-format evaluation hide that vulnerability?

- Cluster: representation-sensitive evidence binding
- Gap: Existing studies already show that table format, order, and serialization can change model performance. The narrower unresolved question is whether information-equivalent renderers expose verdict instability that a conventional single-format score hides on paper-balanced scientific claim verification.
- Closest priors: `src_scitab`, `src_tabverse`, `src_table_meets_llm`, `src_serialization_strategies`, `src_scitab_align`, `src_data_referencing_errors`, `src_sciclaimeval_dev`
- Novelty absorption: `src_tabverse`, `src_table_meets_llm`, and `src_serialization_strategies` absorb broad serialization sensitivity and any simple JSON-versus-natural-language winner claim; `src_scitab` and `src_scitab_align` absorb generic scientific-table verification or grounding. Per-format superiority is not a primary contribution.
- Reviewer-absorption objection: a macro-F1 difference between JSON and natural row statements is a routine format comparison. Only paired verdict flips, invariance failure, worst-case correctness loss, and the gap hidden by single-format evaluation under same-cell and matched-permutation controls can support a narrow result.
- Non-overlap hypothesis: information-equivalent renderers of the same canonical atoms produce non-trivial paired verdict disagreement, causing standalone single-format correctness to overstate worst-case correctness. The hypothesis does not predict a universal winning format.
- Primary dataset snapshot: SCITAB at commit `217cfbd71ebf39ba26a0938f0d87a9fce560e0fe`, repository license MIT. The single structured JSON contains 1,224 claims, 80 papers, and 213 tables: 457 supports, 411 refutes, and 356 not enough info. Every item has `table_column_names` and `table_content_values`, and all items pass an exact rectangular-array check.
- Primary sample target: freeze 60 paper-unique units, 30 supports and 30 refutes, with at most one primary claim per paper after parser and information-parity audits. No outcome-driven replacement is allowed. The promotion floor is 40 valid paper-unique units; not-enough-info examples are secondary because they span only nine papers and cannot promote the topic.
- Conditions: deterministic natural row statements; deterministic typed JSON; claim-only control. Identity order and the same deterministic row/column permutations are applied to both serialization conditions for every item.
- Parser rule: SCITAB canonicalization fails closed on missing arrays, empty tables, non-rectangular rows, unstable cell IDs, or serializer round-trip mismatch. No silent repair, row dropping, value normalization, or fallback rendering is allowed.
- Same-information audit: both treatment serializers must round-trip to the identical canonical cell-ID, row-header, column-header, and value multiset under the same permutation before inference. Any mismatch blocks the item and is reported before outcomes are opened.
- Token-ratio audit: per-item token counts are computed with each evaluated model tokenizer. The acceptance threshold and handling of outliers must be frozen in the preregistration; a failed audit blocks readiness rather than being repaired after results are observed.
- Permutation audit: row and column permutations preserve header-cell bindings and are generated once per item. The identical schedule is reused across natural row statements and typed JSON; permutation consistency is scored separately from label accuracy.
- Leakage boundary: gold labels may be used only by the frozen class-balancing step and terminal exact grader. Renderers, prompts, retry logic, models, and parser repair receive no labels or answer keys.
- Exact grader: normalized output must exactly match `supports`, `refutes`, or `not enough info`; invalid or additional labels are errors. No model judge or post-hoc semantic relabeling is allowed.
- Model scope: two independently pretrained local model families, with decoding and prompt templates frozen per family before inference.
- Primary endpoints: paired verdict disagreement and invariance for the same item and matched permutation; worst-case correctness, where an item is correct only if every tested renderer-by-permutation view is correct; and each renderer's single-format correctness minus worst-case correctness as the hidden-vulnerability gap.
- Primary analysis: estimate the primary endpoints at the paper level for each model family with paired exact tests and paper-level bootstrap confidence intervals, then require the preregistered direction or instability floor to replicate across both families. The claim-only control cannot promote the topic.
- Secondary endpoints: per-format macro-F1, per-format exact accuracy, format-winner contrasts, and not-enough-info performance. A format winner alone cannot promote the topic or support a general JSON-versus-natural-language claim.
- Claim ceiling: conclusions are limited to the two tested deterministic renderers, matched permutation schedule, two local model families, and SCITAB commit `217cfbd71ebf39ba26a0938f0d87a9fce560e0fe`.
- Secondary external validation: SciClaimEval remains a separate candidate at revision `efb3807399acec43854fdf7741c1bcfe605a72b9`. Its top-level filter yields 134 rows over 63 papers, but both-table TeX availability falls to 104 rows over 49 papers; strict and multicolumn parsers retain only 17 and 25 paper-unique units, respectively. It is not required for the primary probe.
- Falsifier: paired disagreement and hidden-vulnerability gaps fall below their preregistered floors under same-cell parity, matched row/column permutations, or the second model family, even if one format has higher macro-F1.
- Kill criteria: fewer than 40 balanced paper-unique binary units survive; parser or same-information parity fails; the preregistered token-ratio gate fails; any gold leakage reaches inference; row/column order explains the result; invariance or hidden-vulnerability evidence does not replicate across both model families; only a format-winner result remains; or full-text review shows an existing study already tests the same SCITAB invariance contrast.
- Status: `killed_pre_execution`
- Topic selected: `false`
- Preregistration: `docs/research/relation-serialization-probe-preregistration-v1.json`, `frozen=true`, `ready=false`
- Binding audit: 31 of 70 records passed all checks; 39 failed closed
- Model calls: `0`
- Decision receipt: `docs/research/relation-serialization-probe-decision-v1.json`

### `topic_claim_artifact_integrity`: Transactional Claim-to-Artifact Integrity

**Claim.** Transaction-bound claim compilation prevents unsupported manuscript claims when research runs are resumed, switched, or partially regenerated.

- Cluster: artifact integrity
- Gap: Trace auditing and chain-of-evidence systems verify links, but cross-session state transitions may still attach valid evidence to the wrong run or stale claim.
- Closest priors: `src_hidden_pitfalls`, `src_scientistone`
- Reviewer-absorption objection: ScientistOne already presents claim-to-evidence chains and method-code alignment; the remaining contribution may be a software consistency test.
- Strong baselines: path-based references; chain-of-evidence audit; immutable run-bound claim ledger.
- Primary metric: unsupported or cross-run claim rate under controlled state-transition faults.
- Local probe: seeded run-switch, resume, stale-cache, and partial-write scenarios over generated research bundles.
- Falsifier: existing chain-of-evidence checks detect all seeded faults.
- Kill signal: no undetected cross-run failures or no meaningful difference from a generic transactional database invariant.
- Status: `rejected_prior_absorption`

### `topic_review_backtracking`: Artifact-Grounded Revision Closure

**Question.** When a scientific revision requires code or experiment changes, can a typed obligation plus execution receipt distinguish a completed repair from an unsupported "done" claim better than paper-only comparison, trace-only review, or file-diff presence?

- Cluster: closed-loop review
- Gap: Detection, comment-to-edit alignment, remedy generation, and end-to-end revision are directly studied. A narrower open question may remain at the boundary between revision text and executable scientific state: whether the claimed experimental repair actually ran, produced the cited result, and closed the exact reviewer obligation.
- Closest priors: `src_faulty_reasoning_review`, `src_aries`, `src_revisebench`, `src_flaws`, `src_prismm`, `src_pat`, `src_hidden_pitfalls`
- Reviewer-absorption objection: this may reduce to CI provenance or software trace validation, while ReviseBench may already contain enough logs for a reviewer to infer completion.
- Strong baselines: paper-only pairwise quality; paper plus agent trace; source-diff presence; typed obligation plus pinned rerun receipt; human revision where licensing permits.
- Candidate unit: an externally sourced review obligation that can be deterministically linked to an expected source, experiment, result, and manuscript change. Synthetic AutoLabOS runs cannot be the primary empirical unit.
- Candidate public source: FLAWS original/altered LaTeX pairs can support error-removal and collateral-edit checks. ReviseBench has 12 public workspaces and execution traces but currently lacks a detected repository license, so it is not an approved experimental dependency.
- Primary endpoints: unsupported-completion detection, false-block rate on genuinely closed obligations, exact repair success, collateral-change rate, and correct routing to the owning artifact.
- Local probe: use a small licensed subset to verify that original/altered source, error span, deterministic repair target, and local-model inference can be processed within a frozen budget before any paper claim is authorized.
- Falsifier: a source-diff or trace-only baseline matches the obligation-and-rerun gate, or deterministic ground truth cannot separate scientifically closed repairs from cosmetic edits.
- Kill signal: no licensed real source with at least two independently meaningful obligation classes; fewer than 40 valid units; no deterministic closure label; excessive full-paper context cost; or closest-prior review shows that executed closure is already directly evaluated.
- Status: `source_feasibility_audit`

### `topic_counterevidence_revision`: Counterevidence-Calibrated Belief Revision

**Claim.** Explicit contradiction ledgers and decision rules improve whether research agents retract or weaken hypotheses after negative evidence, compared with ordinary memory and reviewer prompting.

- Cluster: scientific reasoning
- Gap: Recent evidence separates statistical estimates from agent verdicts, but reliable belief revision across an autonomous research trajectory remains under-evaluated.
- Closest priors: `src_agent_verdict_layer`, `src_claimcheck`
- Reviewer-absorption objection: a structured ledger may merely force the desired answer through prompt formatting.
- Strong baselines: ordinary transcript memory; critic prompt; evidence ledger without a decision rule; ledger plus executable decision rule.
- Primary metric: calibrated claim revision after controlled supporting, null, and contradictory evidence sequences.
- Local probe: paired synthetic study summaries with invariant numerical evidence and randomized framing.
- Falsifier: gains vanish under format-matched controls or judge-independent deterministic scoring.
- Kill signal: performance depends on one prompt form, or the task can be solved by shallow lexical cues.
- Status: `reserve`

### `topic_executable_idea_utility`: Executable Research-Idea Utility

**Claim.** A gap-grounded, refutation-first topic portfolio produces more locally executable and baseline-bearing research plans than single-shot topic generation.

- Cluster: topic discovery
- Gap: Autonomous-research benchmarks emphasize downstream task execution, while topic ideation is often judged by model preference rather than implementation survival.
- Closest priors: autonomous research benchmarks and AI-scientist systems require a dedicated full-text overlap audit before promotion.
- Reviewer-absorption objection: evaluator preference and AutoLabOS-specific workflow rules may dominate the result.
- Strong baselines: single-shot idea generation; self-refinement; multi-agent debate; evidence-linked portfolio with hard gates.
- Primary metric: blinded plan survival through deterministic executability, baseline, evidence, and bounded-pilot gates.
- Local probe: multiple topic seeds across independent NLP/agent clusters, with fixed budget and hidden gate order.
- Falsifier: portfolio generation improves rubric scores but not actual pilot completion or information value.
- Kill signal: no task-independent ground truth, high evaluator disagreement, or prohibitive implementation cost before the venue deadline.
- Status: `reserve_after_source_audit`

### `topic_diversity_preservation`: Diversity-Preserving Topic Search

**Claim.** Explicit cluster floors reduce premature convergence in research-topic search without lowering executable idea quality.

- Cluster: search diversity
- Gap: output diversity compression may narrow autonomous scientific search.
- Closest priors: `src_agentic_science_limits` plus 2026 work on exploration narrowing and diverse hypothesis search.
- Reviewer-absorption objection: the closest 2026 work directly studies the central failure and likely subsumes a simple cluster-floor intervention.
- Strong baselines: top-score-only selection; stochastic resampling; novelty-penalized selection.
- Primary metric: independent-cluster coverage at a fixed executability floor.
- Local probe: repeated topic-search generations over controlled literature packets.
- Falsifier: cluster floors increase surface diversity but not semantic or executable diversity.
- Kill signal: direct closest-prior overlap remains after full-text review.
- Status: `product_feature_only`

### `topic_run_integrity`: Selective Reproduction for Research Runs

**Claim.** Risk-ranked selective reproduction of artifact-producing steps catches more consequential scientific inconsistencies per compute unit than full rerun or static audit.

- Cluster: reproducibility
- Gap: Existing work shows that logs and code improve fault detection, but does not establish which run segments should be re-executed under a constrained verification budget.
- Closest priors: `src_hidden_pitfalls`, `src_scientistone`
- Reviewer-absorption objection: prioritization may be a generic test-selection heuristic with no distinctive scientific-agent insight.
- Strong baselines: final-artifact audit; full rerun; random step replay; dependency-centrality replay.
- Primary metric: weighted seeded-fault detection per GPU-minute.
- Local probe: replay a controlled corpus of run DAGs with stale, swapped, truncated, and nondeterministic artifacts.
- Falsifier: full rerun dominates within the local budget or simple dependency centrality matches the learned/risk-ranked policy.
- Kill signal: no realistic run corpus or fault distribution can be assembled without using AutoLabOS-specific fixtures as the empirical target.
- Status: `reserve`

## Pressure Scores

Scores use a one-to-five scale. High `cost` means low execution cost.
The quarantined `topic_null_contract` decision is excluded from the active score table.

| Topic | Novelty | Importance | Testability | Baseline clarity | Evaluation validity | Local feasibility | Failure information value | Workshop fit | Reproducibility | Cost | Decision |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `topic_relation_serialization` | 3 | 4 | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | Killed pre-execution |
| `topic_claim_artifact_integrity` | 2 | 4 | 4 | 4 | 4 | 5 | 3 | 3 | 5 | 4 | Reject |
| `topic_review_backtracking` | 3 | 4 | 3 | 5 | 3 | 3 | 5 | 5 | 5 | 3 | Source and license audit |
| `topic_counterevidence_revision` | 3 | 4 | 4 | 4 | 3 | 5 | 4 | 4 | 4 | 5 | Reserve |
| `topic_executable_idea_utility` | 3 | 4 | 3 | 4 | 2 | 3 | 5 | 4 | 3 | 2 | Source audit |
| `topic_diversity_preservation` | 2 | 4 | 3 | 4 | 3 | 4 | 3 | 3 | 4 | 4 | Product feature |
| `topic_run_integrity` | 3 | 4 | 4 | 5 | 3 | 4 | 4 | 4 | 5 | 3 | Reserve |

## Historical Adversarial Review: Killed Candidate

The following objections and required controls explain why the relation-serialization candidate reached a frozen pre-execution audit. They are retained as a decision trace and do not authorize revival or model execution.

### Novelty reviewer

The leading candidate is squeezed by direct work on controlled cross-format table evaluation, serialization schemes and attribute order, scientific-table claim verification, cell-level alignment, and data referencing errors. A paper that merely ranks JSON against natural-language rendering is weakly novel and absorbed by `src_tabverse`, `src_table_meets_llm`, and `src_serialization_strategies`.

Required answer: measure paired verdict disagreement, invariance, worst-case correctness, and the vulnerability hidden by standalone single-format scores under same-cell parity and matched row/column permutations. The effect must survive two local model families, exact grading, and the claim-only control. A format winner cannot promote the topic.

### Methods reviewer

The source-native unit is a SCITAB claim-table pair, but multiple claims share papers and tables. Primary sampling therefore uses at most one supports/refutes claim per paper. Parser exclusions, balanced sample IDs, serializer output, token counts, matched permutations, model outputs, and grader results must be recorded before aggregate comparisons are opened.

Required answer: freeze 60 paper-unique primary units at 30 supports and 30 refutes, keep 40 valid units as the promotion floor, use paired item-level contrasts, paired exact tests, paper-level bootstrap intervals, predeclared exclusions, and no endpoint or token-ratio rule changes after predictions begin. Gold labels may construct the frozen balance but may not enter any model-visible artifact.

### Systems reviewer

A typed rendering can win by construction if it adds fields, normalizes values, changes cell order, shortens the input materially, or receives parser repair unavailable to the natural row statements. Row or column order can also masquerade as a serialization effect.

Required answer: generate both renderings from one immutable SCITAB cell table, require successful round-trip parity, fail closed symmetrically, audit token ratios per tokenizer, reuse one matched row/column permutation schedule, and keep gold labels outside every inference and repair path.

### Venue reviewer

The topic fits REALM evaluation and robustness only as a narrow controlled probe. Workshop fit does not make a broad serialization method claim defensible. A short paper needs one crisp paired result, exact controls, and an honest null or absorption path.

Required answer: restrict conclusions to the pinned SCITAB commit, the balanced supports/refutes sample, the two tested local model families, the two deterministic renderers, and the matched permutation schedule. Per-format macro-F1 is secondary. Do not generalize to table reasoning, scientific claim verification as a whole, or JSON-versus-natural-language superiority; SciClaimEval remains optional external validation subject to a separate parser gate.

## Provisional Ranking

1. `topic_review_backtracking` - source-feasibility audit only
2. `topic_counterevidence_revision`
3. `topic_run_integrity`
4. `topic_executable_idea_utility`

No replacement topic is selected. `topic_review_backtracking` is only the first source-feasibility route because recent literature sharply narrows it to executed revision closure. Before preregistration, it must pass license, real-unit, deterministic-ground-truth, closest-prior, local-context-cost, and strong-baseline gates. If it fails, the controller must advance to the next independent route rather than repairing the candidate after seeing model outcomes. `topic_relation_serialization` remains killed with zero model calls, and `topic_null_contract` remains quarantined and rejected.

## Promotion Ledger

- `ResearchBasisIsCandidateEvidence`: `false`
- `MultiAgentConsensusIsEvidence`: `false`
- `MainControllerRetainsPromotionAuthority`: `true`
- `ExplorationBreadthFloorActive`: `true`
- `HistoricalPortfolioCandidateClusterCount`: `7`
- `ActiveRefreshRouteCount`: `4`
- `SingleSourceFamilyConvergenceRequiresScorecard`: `true`
- `PilotLatentGateRequiredBeforePrePassKillOrReserve`: `true`
- `PrePassKillRequiresNonRecoverableReason`: `true`
- `QuarantinedTopic`: `topic_null_contract`
- `QuarantinedTopicStatus`: `quarantined_not_executed`
- `QuarantinedTopicDecision`: `rejected`
- `KilledCandidate`: `topic_relation_serialization`
- `KilledCandidateDecision`: `KILL_PRE_EXECUTION`
- `KilledCandidateModelCalls`: `0`
- `KilledCandidateDecisionReceipt`: `docs/research/relation-serialization-probe-decision-v1.json`
- `PreregistrationPath`: `docs/research/relation-serialization-probe-preregistration-v1.json`
- `PreregistrationPresent`: `true`
- `PreregistrationFrozen`: `true`
- `ProbeReady`: `false`
- `CurrentPrimaryProbeDataset`: `none`
- `CurrentExternalValidationDataset`: `none`
- `LeadingRefreshRoute`: `topic_review_backtracking`
- `LeadingRefreshRouteSelected`: `false`
- `ReviseBenchRepositoryLicenseDetected`: `false`
- `FLAWSDatasetLicense`: `CC_BY_4_0`
- `FLAWSCodeLicense`: `MIT`
- `TopicSelected`: `false`
- `NextAllowedState`: complete the artifact-grounded revision-closure source and feasibility audit; require licensed real units, deterministic closure labels, two full-text closest priors, strong baselines, a local cost bound, and a frozen pre-execution kill signal before selecting or running a replacement topic

## Sources

- https://arxiv.org/abs/2606.27687
- https://arxiv.org/abs/2606.11217
- https://arxiv.org/abs/2509.08713
- https://arxiv.org/abs/2605.18414
- https://openreview.net/pdf?id=4ob0d33A2l
- https://arxiv.org/abs/2606.11045
- https://arxiv.org/abs/2607.17100
- https://arxiv.org/abs/2605.10246
- https://arxiv.org/abs/2603.29045
- https://arxiv.org/abs/2607.09682
- https://arxiv.org/abs/2606.11456
- https://arxiv.org/abs/2605.08956
- https://aclanthology.org/2025.findings-emnlp.1185/
- https://arxiv.org/abs/2605.26340
- https://aclanthology.org/2026.acl-long.1134/
- https://sciclaimeval.github.io/
- https://huggingface.co/datasets/alabnii/sciclaimeval-shared-task/tree/efb3807399acec43854fdf7741c1bcfe605a72b9
- https://arxiv.org/abs/2602.07621
- https://arxiv.org/abs/2606.09578
- https://arxiv.org/abs/2305.13062
- https://aclanthology.org/2025.findings-naacl.437/
- https://aclanthology.org/2023.emnlp-main.483/
- https://github.com/XinyuanLu00/SciTab/tree/217cfbd71ebf39ba26a0938f0d87a9fce560e0fe
- https://aclanthology.org/2025.findings-emnlp.135/
- https://aclanthology.org/2026.acl-long.762/
- https://aclanthology.org/2026.tacl-1.22/
- https://aclanthology.org/2024.acl-long.377/
- https://aclanthology.org/2026.findings-acl.887/
- https://github.com/CGCL-codes/ReviseBench
- https://arxiv.org/abs/2511.21843
- https://github.com/xasayi/FLAWS
- https://huggingface.co/datasets/xasayi/FLAWS
- https://arxiv.org/abs/2510.16505
- https://arxiv.org/abs/2606.28277
- https://realm-workshop.github.io/call_for_papers/
