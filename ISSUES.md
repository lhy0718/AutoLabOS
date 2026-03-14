# ISSUES.md

## Current status
- Last updated: 2026-03-15T00:25:48 KST
- Current validation target: `test/` real TUI path `/new -> /brief start --latest` completes end-to-end with artifact/UI consistency checks
- Current test/ workspace: `test/tui-live-cycle-20260314-225525-iter8`
- Current active run: `a5dde90b-a4f8-44d1-be22-c1972cbdd3ed`
- Current overall state: done
- Current paper-scale target: move from workflow-complete to paper-ready experimental manuscript
- Current paper readiness state: not_yet_paper_ready

## Active live-validation issues
- None (no blocking issue remains for the current validation target).

## Research completion risks

### R-001 — Paper-ready evidence still weaker than workflow completion evidence
- Status: open
- Blocking for paper-ready: yes
- Evidence:
  - end-to-end workflow is completed
  - `write_paper` completes
  - PDF build succeeds
  - but completion evidence is still stronger than experimental evidence
- Missing artifact:
  - stronger result table and clearer claim→evidence linkage
- Owner node:
  - `review`
  - `write_paper`
- Next action:
  - run `paper-scale-research-loop`
  - force paper-readiness downgrade unless experimental evidence improves

### R-002 — Scientific gate warnings remain non-blocking but unresolved
- Status: open
- Blocking for paper-ready: maybe
- Evidence:
  - scientific gate warns remain, even though they no longer block completion
- Missing artifact:
  - categorized warning summary
  - explicit resolution or limitation text in manuscript
- Owner node:
  - `review`
  - `write_paper`
- Next action:
  - select one representative warning
  - determine whether it is a true paper-quality blocker or only a style issue

### R-003 — Risk of system-validation paper shape instead of experiment paper
- Status: open
- Blocking for paper-ready: yes
- Evidence:
  - workflow validation artifacts are rich and easy to write around
  - this can crowd out external-task experimental contribution
- Missing artifact:
  - explicit downgrade logic in review
  - external-task experiment emphasis in manuscript plan
- Owner node:
  - `review`
  - `write_paper`
- Next action:
  - enforce `blocked_for_paper_scale` when baseline/result-table/claim-evidence mapping are missing

## Paper readiness risks

### P-001 — Baseline/comparator may be too weak or under-specified
- Status: open
- Blocking for paper-ready: yes
- Evidence:
  - paper-ready state requires explicit comparator discipline
- Missing artifact:
  - reviewer-readable baseline summary
- Owner node:
  - `design_experiments`
  - `run_experiments`
  - `review`
- Next action:
  - make comparator list explicit in experiment and paper artifacts

### P-002 — Quantitative result packaging may be insufficient
- Status: open
- Blocking for paper-ready: yes
- Evidence:
  - completion evidence exists, but result-table discipline may still be weak
- Missing artifact:
  - compact result table
  - numeric comparison summary
- Owner node:
  - `analyze_results`
  - `write_paper`
- Next action:
  - force result-table materialization before `paper_ready=true`

### P-003 — Related-work depth may still be shallower than needed
- Status: open
- Blocking for paper-ready: maybe
- Evidence:
  - workflow can complete with relatively shallow related-work positioning
- Missing artifact:
  - explicit full-text-grounded subset summary
- Owner node:
  - `collect_papers`
  - `analyze_papers`
  - `review`
- Next action:
  - separate shallow metadata coverage from paper-positioning-ready evidence

## Current iteration log

### Iteration 8
- Goal: finish live cycle through `write_paper` without stale/looping blocker.
- What was validated in `test/`:
  - persisted run status/checkpoints while `write_paper` executed
  - live artifact growth in `paper/` (`outline/draft/review/finalize`, gate artifacts)
  - existing-session vs fresh-read comparison for stale projection behavior
- What broke:
  - `write_paper` initially failed quality gate with `caption_internal_name`
  - `paperWriterSessionManager` stage timeout fallback (`90000ms`) repeatedly degraded stage outputs
- What changed:
  - `src/core/analysis/scientificWriting.ts`
    - sanitize internal-token captions before lint/gating
    - sanitize candidate/main/appendix visual captions in manuscript materialization
  - `src/core/agents/paperWriterSessionManager.ts`
    - disable default per-stage timeout by default (`DEFAULT_PAPER_WRITER_STAGE_TIMEOUT_MS = 0`)
    - apply timeout race only when explicit positive timeout is configured
  - `tests/scientificWriting.test.ts`
    - add regression for internal-token caption sanitization
- Tests run:
  - `npx vitest run tests/scientificWriting.test.ts`
  - `npx vitest run tests/paperWriterSessionManager.test.ts tests/scientificWriting.test.ts`
  - `npx vitest run tests/experimentGovernance.test.ts tests/objectiveMetricPropagation.test.ts tests/analyzePapers.test.ts tests/terminalAppPlanExecution.test.ts tests/interactionSession.test.ts tests/scientificWriting.test.ts tests/paperWriterSessionManager.test.ts`
- Re-validation result:
  - Run completed: `status=completed`, `currentNode=write_paper`, `checkpointSeq=42`
  - Final summary: LaTeX draft generated, scientific gate `warn(6)` (non-blocking), PDF build success
  - `paper/consistency_lint.json`: `manuscript.ok=true`, no `caption_internal_name`
  - Collection remained research-grade (`collect_result.json`: `stored=200`; scout `paper_count=40`)
- Decision: done

## Next paper-scale iteration template

### Paper-scale Iteration N
- Goal:
- Research question:
- Why this is testable with a small real experiment:
- Corpus adequacy summary:
  - total collected:
  - full-text grounded:
  - comparator family coverage:
- Baseline/comparator:
- Dataset/task/metric:
- What was actually executed:
- Quantitative result summary:
- Claim→evidence status:
- Paper-readiness decision:
  - `paper_ready`
  - `paper_scale_candidate`
  - `research_memo`
  - `system_validation_note`
  - `blocked_for_paper_scale`
- Missing artifacts:
- Next action: