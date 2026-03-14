# Active TUI Validation Issues

This tracker keeps only unresolved or mitigated issues from live TUI validation.
Verified fixed items are removed instead of kept as historical notes.

## Current status

- Last updated: 2026-03-14
- Active live-validation workspace: [test/tui-live-cycle-20260314-12](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12)
- Current research-grade brief: [20260314-150505-research-brief.md](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/briefs/20260314-150505-research-brief.md)
- Current primary run under investigation: [84b99657-e0c6-4e7d-92a3-07c66cce1383](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/84b99657-e0c6-4e7d-92a3-07c66cce1383)
- Current counts:
  - `[Open]` 1
  - `[Mitigated]` 3
  - `[Environment]` 0

## Current progress summary

- Research-grade collect is currently healthy. Fresh live run [df33cf1f-eb68-40c5-b44a-acd7db3be4e4](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/df33cf1f-eb68-40c5-b44a-acd7db3be4e4) reached `stored = 200` with keyword-anchor query `evaluate classical modern baseline families tabular` and did not collapse into a toy sample. [collect_result.json](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/df33cf1f-eb68-40c5-b44a-acd7db3be4e4/collect_result.json)
- The rerank timeout and `90 -> 45 -> 30` shrink path were removed from [paperSelection.ts](/Users/hanyonglee/AutoLabOS/src/core/analysis/paperSelection.ts), and fresh built-TUI live validation confirmed a single `90`-candidate rerank with `candidatePoolSize = 90` and `rerankApplied = true`. The latest rerun on preserved run [84b99657-e0c6-4e7d-92a3-07c66cce1383](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/84b99657-e0c6-4e7d-92a3-07c66cce1383) also rebuilt a `90`-candidate shortlist from the same `200`-paper corpus. [analysis_manifest.json](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/84b99657-e0c6-4e7d-92a3-07c66cce1383/analysis_manifest.json)
- The stale `running` state after mid-node process exit is now fixed in live validation. In workspace [test/tui-live-cycle-20260314-12](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12), run [df33cf1f-eb68-40c5-b44a-acd7db3be4e4](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/df33cf1f-eb68-40c5-b44a-acd7db3be4e4) was interrupted with `SIGHUP` during `analyze_papers`; the persisted run landed in `status = "paused"`, `analyze_papers.status = "pending"`, and `latestSummary = "Canceled by user"`, and a fresh reopen showed the same paused state instead of stale `running`. [runs.json](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/runs.json)
- `analyze_papers` no longer drifts into a broken `0/0` success path when the corpus has been cleared. The node now pauses for manual review if `corpus.jsonl` is empty, and `clear_papers` explicitly warns that it removes the collected corpus rather than just analysis outputs. Focused regressions passed for the current code path: `tests/analyzePapers.test.ts`, `tests/terminalAppPlanExecution.test.ts`, `tests/interactionSession.test.ts`
- The current live blocker is no longer rerank liveness. It is the first-paper analysis budget in `analyze_papers`: the shortlist is rebuilt, but the first selected paper still hits planner/extractor timeouts before any persisted outputs are produced.

## Active issues

### [Open] `analyze_papers` still hits a zero-output early pause on the first selected papers because planner/extractor budgets are too small for the current full-text workload

- Validation target:
  A research-grade `200`-paper collect with a valid top-`30` shortlist should progress into persisted summaries/evidence instead of pausing before the first usable analysis artifact lands.
- Actual behavior:
  On preserved run [84b99657-e0c6-4e7d-92a3-07c66cce1383](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/84b99657-e0c6-4e7d-92a3-07c66cce1383), the latest built TUI successfully rebuilt a `90`-candidate reranked shortlist from the `200`-paper corpus, but the first selected paper still hit `planner exceeded the 20000ms timeout`, then `extractor exceeded the 45000ms timeout` after the page-image retry and the full-text-only retry. The run paused before any summary or evidence row was persisted.
- Evidence:
  [analysis_manifest.json](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/84b99657-e0c6-4e7d-92a3-07c66cce1383/analysis_manifest.json), [runs.json](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/runs.json), [0005-analyze_papers-after.json](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/84b99657-e0c6-4e7d-92a3-07c66cce1383/checkpoints/0005-analyze_papers-after.json), [0006-analyze_papers-before.json](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/84b99657-e0c6-4e7d-92a3-07c66cce1383/checkpoints/0006-analyze_papers-before.json)
- Current hypothesis:
  `paperAnalyzer.ts` uses fixed planner/extractor budgets (`20s` / `45s`) that are too small for the current full-text payload on some top-ranked papers. The zero-output early pause then stops the node after the first two failed analyses instead of allowing the run to reach a paper that can actually persist outputs.
- Minimal fix direction:
  Make planner/extractor budgeting more adaptive to large full-text inputs, and/or relax the early zero-output pause when the initial failures are pure timeout failures so the node can continue far enough to land the first persisted outputs.

### [Mitigated] Single-shot `90`-candidate rerank shortlist quality is much better, but the lower tail still contains some weakly aligned papers

- Validation target:
  A research-grade tabular-classification run should keep the top-30 shortlist tightly aligned to tabular baselines, evaluation methodology, datasets, and leakage-safe benchmarking, not generic classification or unrelated application-domain papers.
- Actual behavior:
  The latest rebuilt shortlist on [84b99657-e0c6-4e7d-92a3-07c66cce1383](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/84b99657-e0c6-4e7d-92a3-07c66cce1383) is far better than the earlier live shortlist and the top 10 are now strongly tabular/benchmark-oriented, but the lower tail still contains weaker items such as `A Comparison of Low-Shot Learning Methods for Imbalanced Binary Classification`, `A Comprehensive Review of Reinforcement Learning: From Classical Frameworks to Deep Learning Paradigms`, and some quantum or application-shifted papers.
- Evidence:
  [analysis_manifest.json](/Users/hanyonglee/AutoLabOS/test/tui-live-cycle-20260314-12/.autolabos/runs/84b99657-e0c6-4e7d-92a3-07c66cce1383/analysis_manifest.json)
- Scope judgment:
  This is improved enough that it is no longer the top blocker, but it is not fully clean yet.

### [Mitigated] Some analyzed papers still fall back to abstracts despite run-level PDF recovery and cached PDFs

- Validation target:
  A selected paper with recovered PDF metadata should normally attempt usable full-text extraction before settling on abstract fallback.
- Actual behavior:
  The active retried run [4a28a184-0da4-4926-aefe-07bb46ebedaf](/Users/hanyonglee/AutoLabOS/test/tui-paper-writing-e2e/.autolabos/runs/4a28a184-0da4-4926-aefe-07bb46ebedaf) is now at `12` completed analyses with `3 full_text / 9 abstract fallback`, and earlier large-corpus run [e1ccd3b5-cf6c-4685-9cc7-242c4d13d683](/Users/hanyonglee/AutoLabOS/test/tui-paper-writing-e2e/.autolabos/runs/e1ccd3b5-cf6c-4685-9cc7-242c4d13d683) also recorded `source_type = "abstract"` with `fallback_reason = "pdf_extract_failed"` despite a cached PDF path and run-level `pdfRecovered = 105`.
- Evidence:
  [analysis_manifest.json](/Users/hanyonglee/AutoLabOS/test/tui-paper-writing-e2e/.autolabos/runs/4a28a184-0da4-4926-aefe-07bb46ebedaf/analysis_manifest.json), [paper_summaries.jsonl](/Users/hanyonglee/AutoLabOS/test/tui-paper-writing-e2e/.autolabos/runs/4a28a184-0da4-4926-aefe-07bb46ebedaf/paper_summaries.jsonl), [collect_result.json](/Users/hanyonglee/AutoLabOS/test/tui-paper-writing-e2e/.autolabos/runs/e1ccd3b5-cf6c-4685-9cc7-242c4d13d683/collect_result.json), [analysis_manifest.json](/Users/hanyonglee/AutoLabOS/test/tui-paper-writing-e2e/.autolabos/runs/e1ccd3b5-cf6c-4685-9cc7-242c4d13d683/analysis_manifest.json), [analysis_cache/pdfs/81013536fdc7e251df05cf18ff00e1baaeed768f.pdf](/Users/hanyonglee/AutoLabOS/test/tui-paper-writing-e2e/.autolabos/runs/e1ccd3b5-cf6c-4685-9cc7-242c4d13d683/analysis_cache/pdfs/81013536fdc7e251df05cf18ff00e1baaeed768f.pdf)
- Scope judgment:
  This is a quality-risk marker, not the current top blocker, because runs can still progress and persist evidence.

### [Mitigated] Related-work selection in final paper outputs can still drift toward applied or domain-shifted papers

- Validation target:
  Final paper-writing outputs should keep related-work citations close to the intended benchmark domain.
- Actual behavior:
  The last completed paper-writing run still cited some domain-shifted items in related-work intermediates and bibliography.
- Evidence:
  [related_work_notes.json](/Users/hanyonglee/AutoLabOS/test/tui-paper-writing-e2e/.autolabos/runs/bdd703ec-0c3e-46bd-bec9-bf1b67711f87/paper/related_work_notes.json), [draft.json](/Users/hanyonglee/AutoLabOS/test/tui-paper-writing-e2e/.autolabos/runs/bdd703ec-0c3e-46bd-bec9-bf1b67711f87/paper/draft.json), [references.bib](/Users/hanyonglee/AutoLabOS/test/tui-paper-writing-e2e/.autolabos/runs/bdd703ec-0c3e-46bd-bec9-bf1b67711f87/paper/references.bib)
- Scope judgment:
  This is downstream quality cleanup and not the current live-TUI execution blocker.
