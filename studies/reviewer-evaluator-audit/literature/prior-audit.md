# Prior-Work Audit

> **Superseded on 2026-07-28.** The original `DISCOVERY_GO` conclusion below
> was invalidated by a newly identified direct prior and an estimator
> identifiability audit. The authoritative decision is
> `method/termination-decision.v1.json`.

## Residual Claim

The surviving contribution is a benchmark-specific forensic measurement audit:
the released non-ML FLAWS outputs are re-evaluated under the paper
specification, the pinned implementation, a context-reduced but
localization-preserving reference set, two blinded independent judge
lineages, and fixed aggregation rules. The study asks whether individual
decisions and the resulting system ranking remain stable.

The contribution is not a new judge, a general theory of evaluator bias, or a
claim that an independent jury is more accurate. The public extension does not
release instance-level human labels, so evaluator disagreement establishes
sensitivity rather than validity.

## Closest Work

| Work | Verified contribution | Direct overlap | Residual non-overlap |
|---|---|---|---|
| Yang et al. (2026), [When the Judge Changes, So Does the Measurement](https://arxiv.org/abs/2607.08535) | Holds candidate outputs fixed and measures how evaluator replacement, scaling, repeated juries, debate, parser behavior, and fallback handling change measurements across four datasets. | Directly absorbs the core fixed-output evaluator-replacement question and the need for protocol audit trails. | Does not study the FLAWS paper-code-data chain, but a new benchmark instance alone is not enough novelty for the proposed workshop paper. |
| Xi et al. (2025), [FLAWS](https://arxiv.org/abs/2511.21843) | Introduces 713 scientific paper-error pairs, an OR combination of lexical matching and an insertion-model judge, human validation on 29 overlapping ML papers, and insertion-adjusted model rankings. | Same benchmark family, task, outputs, and reference evaluator. | Does not report a code-versus-prose conformance audit, independent rejudging of the public non-ML extension, or ranking sensitivity across the frozen evaluator variants. |
| Xiao et al. (2023), [MetricEval](https://aclanthology.org/2023.emnlp-main.676/) | Formalizes reliability and validity analysis for NLG metrics using measurement theory. | Establishes why evaluator uncertainty and construct boundaries matter. | General framework and summarization case study; no scientific-error localization artifact audit. |
| Bavaresco et al. (2025), [JuStRank](https://aclanthology.org/2025.acl-long.34/) | Evaluates LLM judges by their ability to recover system rankings and characterizes system-level judge traits. | Makes rank stability a first-class judge outcome. | Compares judges on dedicated datasets; does not trace a released benchmark from paper specification through code and stored decisions. |
| Bellibatlu (2026), [JudgeSense](https://arxiv.org/abs/2604.23478) | Measures decision stability under semantically related prompt variants and exposes prompt and dataset artifacts. | Demonstrates that evaluator configuration can create apparent instability. | Prompt sensitivity rather than span-reference, implementation, and aggregation sensitivity in scientific localization. |
| Yagubyan (2026), [The Coin Flip Judge?](https://arxiv.org/abs/2606.13685) | Measures repeated-trial, prompt, position, and cross-judge instability. | Motivates repeated local judgments and explicit test-retest reporting. | No fixed-output benchmark replay or code/data specification audit. |
| Norman et al. (2026), [Reliability without Validity](https://arxiv.org/abs/2606.19544) | Audits 21 judges across three benchmarks and separates raw agreement, chance-corrected agreement, consistency, and bias. | Strongly absorbs any generic claim that judge rankings or agreement are sufficient evidence of validity. | Does not study scientific-review localization or a released evaluator's code-versus-paper behavior. |
| Verga et al. (2024), [Replacing Judges with Juries](https://arxiv.org/abs/2404.18796) | Shows that diverse judge panels can outperform one large judge and reduce intra-model bias on six datasets. | Supplies the strongest jury baseline and aggregation rationale. | The present study does not propose a better jury; it tests whether fixed single-judge and jury-like rules alter a specific leaderboard without claiming greater validity. |
| Shi et al. (2025), [Preference Leakage](https://arxiv.org/abs/2502.01534) | Studies contamination and preference leakage when evaluators are related to generation processes. | Makes insertion-model judging a plausible dependence risk. | Disagreement cannot identify preference leakage without human reference labels; the study therefore reports coupling sensitivity only. |
| Tan et al. (2024), [JudgeBench](https://arxiv.org/abs/2410.12784) | Evaluates judges on difficult objectively labeled response pairs. | Establishes that judge competence itself requires evaluation. | Objective pairwise correctness differs from excerpt-localization matching and benchmark implementation conformance. |
| Kovatchev and Lease (2024), [Benchmark Transparency](https://aclanthology.org/2024.naacl-long.86/) | Quantifies how data distributions alter absolute scores and model rankings. | Treats benchmark rankings as measurements sensitive to design choices. | Focuses on data composition rather than evaluator implementation, reference granularity, and judge aggregation. |
| Tu et al. (2026), [PaperAudit-Bench](https://arxiv.org/abs/2601.19916) | Builds a separate long-context scientific error-detection benchmark and review workflow. | Closest adjacent scientific-review benchmark. | New benchmark construction and detection methods rather than forensic re-evaluation of public FLAWS outputs. |

## Subsumption Test

| Axis | Closest match | Assessment |
|---|---|---|
| Research object | FLAWS | Same benchmark family, but the target is the separately released 115-instance non-ML extension and its complete stored outputs. |
| Core question | JuStRank; Reliability without Validity | Both ask whether judges support stable evaluation, but neither audits this localization evaluator's paper-code-data chain. |
| Intervention | FLAWS; Replacing Judges with Juries | The components are known. The residual intervention is a frozen cross-layer replay, not a new metric or jury method. |
| Evaluation unit | FLAWS | Same model-instance cells, extended with paired decision flips, paper-cluster uncertainty, and cross-condition adjusted rankings. |
| Claim scope | Measurement-audit literature | Narrower: reproducibility and sensitivity for one public extension, with validity claims prohibited. |

The former five-axis rule was too permissive: requiring one work to match all
five axes allowed a change of dataset object to mask substantial question and
intervention overlap. With the Yang et al. prior included, the residual
paper-code discrepancy is below the frozen materiality gate and the proposed
adjusted ranking estimator is not identifiable. The candidate is therefore
`KILL_CURRENT_FORMULATION`.

## Reviewer Absorption Risks

1. **“Generic LLM-as-judge instability is already known.”**
   The paper must lead with the exact paper-code-data conformance result and
   scientific localization ranking consequences, not a generic judge warning.

2. **“The original FLAWS paper already validates its OR metric with humans.”**
   The 29-paper validation applies to the main ML corpus and supports the
   original evaluator. It does not release labels for the 115-instance non-ML
   extension or resolve whether the stored implementation follows the stated
   metric.

3. **“A jury is an established mitigation.”**
   Majority and OR rules are sensitivity probes, not a proposed improvement.
   Without human labels, no aggregation rule may be declared superior.

4. **“The non-ML extension is too small for a new leaderboard.”**
   The effective sample is 68 paper clusters. Counts, cluster bootstrap
   intervals, and a benchmark-specific claim ceiling are mandatory.

5. **“Implementation discrepancies are merely software bugs.”**
   A workshop contribution survives only if the discrepancies materially alter
   decisions or rankings, or independent judge lineages expose the same
   ranking sensitivity. Otherwise the output is downgraded to a reproducibility
   note.

## Source Verification

| Source | Primary location | Verification depth |
|---|---|---|
| When the Judge Changes, So Does the Measurement | arXiv v1 record and paper text | Fixed-output replacement design, datasets, jury/debate results, and audit-trail recommendations checked |
| FLAWS paper | arXiv v1 source and HTML | Full methods, evaluation, human-validation, ranking, and appendix sections checked |
| FLAWS code | GitHub commit `80309b1948c45a43ab6b9c128247eecdf4c4db0e` | Evaluation helpers, prompts, execution path, and README checked |
| FLAWS data | Hugging Face revision `a20a57860ed4afc8a046a73abab6bd1222068762` | Complete revision tree and both non-ML archives checked |
| MetricEval | ACL Anthology paper page and PDF text | Abstract, measurement framing, and method overview checked |
| JuStRank | ACL 2025 paper PDF | System-ranking method, behavior analysis, and related-work scope checked |
| JudgeSense | arXiv full HTML | Method, prompt variants, results, and limitations checked |
| The Coin Flip Judge? | arXiv full HTML | Experimental design and headline reliability results checked |
| Reliability without Validity | arXiv primary record and paper text | Protocols, cohort, metrics, and ranking findings checked |
| Replacing Judges with Juries | arXiv full HTML | Method, datasets, human comparison, and bias claims checked |
| Preference Leakage | arXiv primary record | Abstract and stated contamination scope checked |
| JudgeBench | arXiv full HTML | Construction, objective labels, judge comparisons, and limitations checked |
| Benchmark Transparency | ACL Anthology paper page | Method, datasets, and rank-sensitivity findings checked |
| PaperAudit-Bench | arXiv full HTML | Benchmark scope, detection modes, and review workflow checked |
