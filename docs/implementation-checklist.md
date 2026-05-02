# AutoLabOS Governance Benchmark Implementation Checklist

Created: 2026-05-02

This checklist turns repo contracts and private planning notes into repo-local implementation work. Do not include machine-local reference paths or private documentation paths in this public checklist.

## Direction

AutoLabOS should not compete primarily as a stronger end-to-end AI scientist. The implementation direction is an artifact-grounded governance runtime that prevents paper-shaped output from being promoted to paper-ready evidence without baseline/comparator evidence, result tables, claim-evidence links, figure consistency, review-before-writing, and reproducible run artifacts.

The governed workflow remains fixed around:

`collect_papers -> analyze_papers -> generate_hypotheses -> design_experiments -> implement_experiments -> run_experiments -> analyze_results -> figure_audit -> review -> write_paper`

`figure_audit` is the approved independent checkpoint before `review`; no additional top-level workflow node is planned here.

## Reference Inputs Read

- Repo: `AGENTS.md`
- Repo: `docs/architecture.md`
- Repo: `docs/tui-live-validation.md`
- Repo: `docs/experiment-quality-bar.md`
- Repo: `docs/paper-quality-bar.md`
- Repo: `docs/reproducibility.md`
- Repo: `docs/research-brief-template.md`
- Repo: `docs/live-validation-issue-template.md`

## Execution Order

1. Make the benchmark seed bundle consumable without modifying any external reference source.
2. Add a deterministic benchmark condition model for gated, ungated, and ablation runs.
3. Validate required artifact contracts against real run directories.
4. Add scoring outputs for claim discipline, evidence linkage, result table completeness, figure audit, paper readiness, and live-validation failure handling.
5. Run AGB-001 as a dry-run to lock the contract.
6. Batch or replay AGB-002 through AGB-010.
7. Export paper/demo-ready artifact bundles only after run-scoped artifacts and public outputs agree.

## Implementation Items

### 1. Research Brief Input Path Handling

- [ ] Status: not started
- Related repo files:
  - Existing: `src/core/runs/researchBriefFiles.ts`
  - Existing: `src/core/runs/runBriefParser.ts`
  - Existing: `src/core/commands/parseSlash.ts`
  - Existing: `src/interaction/InteractionSession.ts`
  - Tests: `tests/researchBriefFiles.test.ts`, `tests/runBriefParser.test.ts`, `tests/runBriefStartFlow.test.ts`, `tests/newSlashCommands.test.ts`
- Planned files if needed:
  - `tests/benchmarkSeedBriefStart.test.ts`
- Validation commands:
  - `npm test -- tests/researchBriefFiles.test.ts tests/runBriefParser.test.ts tests/runBriefStartFlow.test.ts tests/newSlashCommands.test.ts`
  - `npm run build`
- Completion criteria:
  - `/brief start <path-to-AGB-001-brief.md>` is accepted as an input path without copying from or modifying an external reference source.
  - `--latest` behavior remains unchanged.
  - Missing required research-brief governance fields are surfaced as execution risks.
  - Path handling is covered by regression tests using a fixture path outside the repo.

### 2. Benchmark Seed Import Or Reference Execution

- [ ] Status: not started
- Related repo files:
  - Existing: `src/cli/main.ts`
  - Existing: `src/cli/args.ts`
  - Existing: `src/core/runs/researchBriefFiles.ts`
  - Existing: `src/core/validation/harnessValidationService.ts`
  - Existing: `src/core/validation/harnessValidators.ts`
  - Tests: `tests/harnessValidationService.test.ts`, `tests/harnessValidators.test.ts`, `tests/cliArgs.test.ts`
- Planned files if needed:
  - `src/core/benchmark/governanceSeedBundle.ts`
  - `src/cli/governanceBenchmark.ts`
  - `tests/governanceSeedBundle.test.ts`
- Validation commands:
  - `npm test -- tests/governanceSeedBundle.test.ts tests/harnessValidators.test.ts`
  - `npm run validate:harness`
- Completion criteria:
  - Repo supports either reference execution from an external reference path or an explicit import into a repo-controlled generated directory.
  - Any import command records source path, checksum or mtime, and task id.
  - No implementation path writes outside repo-controlled outputs unless explicitly requested.

### 3. Gated, Ungated, And Ablation Execution Branches

- [ ] Status: not started
- Related repo files:
  - Existing: `src/config/governance.default.yaml`
  - Existing: `src/config.ts`
  - Existing: `src/core/analysis/paperMinimumGate.ts`
  - Existing: `src/core/nodes/review.ts`
  - Existing: `src/core/nodes/figureAudit.ts`
  - Existing: `src/core/analysis/resultsTableSchema.ts`
  - Existing: `src/core/stateGraph/runtime.ts`
  - Tests: `tests/paperMinimumGate.test.ts`, `tests/reviewNode.test.ts`, `tests/figureAuditNode.test.ts`, `tests/resultTable.test.ts`, `tests/stateGraphRuntime.test.ts`
- Planned files if needed:
  - `src/core/benchmark/governanceCondition.ts`
  - `tests/governanceCondition.test.ts`
- Validation commands:
  - `npm test -- tests/governanceCondition.test.ts tests/paperMinimumGate.test.ts tests/reviewNode.test.ts tests/figureAuditNode.test.ts tests/resultTable.test.ts`
  - `npm run build`
- Completion criteria:
  - Conditions are explicit: `gated`, `ungated`, `no_claim_ceiling`, `no_review_gate`, `no_figure_audit`.
  - Ablations affect only benchmark/evaluation mode and do not weaken normal production defaults.
  - Each run records the active condition in run-scoped artifacts and events.

### 4. Required Artifact Contract Validation

- [ ] Status: not started
- Related repo files:
  - Existing: `src/core/validation/harnessValidators.ts`
  - Existing: `src/core/validation/harnessValidationService.ts`
  - Existing: `src/core/runs/runCompletenessChecklist.ts`
  - Existing: `src/core/publicArtifacts.ts`
  - Existing: `src/core/publicOutputPublisher.ts`
  - Tests: `tests/harnessValidators.test.ts`, `tests/harnessValidationService.test.ts`, `tests/runProjection.test.ts`, `tests/publicOutputPublisher.test.ts`
- Planned files if needed:
  - `src/core/benchmark/governanceArtifactContract.ts`
  - `tests/governanceArtifactContract.test.ts`
- Validation commands:
  - `npm test -- tests/governanceArtifactContract.test.ts tests/harnessValidators.test.ts tests/harnessValidationService.test.ts`
  - `npm run validate:harness`
- Completion criteria:
  - Benchmark validation checks required artifacts per task condition, including `result_table.json`, `evidence_store.jsonl`, `figure_audit/figure_audit_summary.json`, `review/*`, and `paper/*` where applicable.
  - `draft.md`, `main.tex`, or successful PDF build alone is never enough for paper-ready status.
  - Public `outputs/` bundles remain traceable to `.autolabos/runs/<run-id>/` artifacts.

### 5. Paper-Readiness Gate And Claim Ceiling

- [ ] Status: not started
- Related repo files:
  - Existing: `src/core/analysis/paperMinimumGate.ts`
  - Existing: `src/core/paperCritique.ts`
  - Existing: `src/core/analysis/llmPaperQualityEvaluator.ts`
  - Existing: `src/core/analysis/paperGateThresholds.ts`
  - Existing: `src/core/nodes/review.ts`
  - Existing: `src/core/nodes/writePaper.ts`
  - Tests: `tests/paperMinimumGate.test.ts`, `tests/paperCritique.test.ts`, `tests/reviewGateStrength.test.ts`, `tests/reviewDecision.test.ts`, `tests/paperGateThresholds.test.ts`, `tests/writePaperPdfBuild.test.ts`
- Planned files if needed:
  - `tests/governancePaperReadinessGate.test.ts`
- Validation commands:
  - `npm test -- tests/paperMinimumGate.test.ts tests/reviewGateStrength.test.ts tests/reviewDecision.test.ts tests/paperGateThresholds.test.ts`
  - `npm run build`
- Completion criteria:
  - Weak evidence is classified as `system_validation_note`, `research_memo`, or `blocked_for_paper_scale`, not `paper_ready`.
  - `write_paper` fails fast when pre-draft critique or brief evidence assessment blocks paper-scale drafting.
  - AGB-001, AGB-002, AGB-003, AGB-009, and AGB-010 cannot pass as paper-ready when their intended missing evidence remains unresolved.

### 6. Claim-Evidence Table

- [ ] Status: not started
- Related repo files:
  - Existing: `src/core/nodes/writePaper.ts`
  - Existing: `src/core/analysis/scientificWriting.ts`
  - Existing: `src/core/analysis/citationConsistencyChecker.ts`
  - Existing: `src/core/analysis/verifiedRegistry.ts`
  - Existing: `src/core/exploration/evidenceSerializer.ts`
  - Tests: `tests/citationConsistencyChecker.test.ts`, `tests/evidenceSerializer.test.ts`, `tests/verifiedRegistry.test.ts`, `tests/scientificWriting.test.ts`
- Planned files if needed:
  - `src/core/benchmark/claimEvidenceScoring.ts`
  - `tests/claimEvidenceScoring.test.ts`
- Validation commands:
  - `npm test -- tests/claimEvidenceScoring.test.ts tests/citationConsistencyChecker.test.ts tests/evidenceSerializer.test.ts`
  - `npm run validate:harness`
- Completion criteria:
  - `paper/claim_evidence_table.json` maps every major claim to literature, experiment, qualitative observation, or limitation evidence.
  - Unsupported claims are counted, downgraded, or blocked.
  - AGB scoring can compute `unsupported_claim_count`, `claim_to_evidence_coverage`, and citation support metrics from artifacts.

### 7. Result Table Validation

- [ ] Status: not started
- Related repo files:
  - Existing: `src/core/analysis/resultsTableSchema.ts`
  - Existing: `src/core/nodes/analyzeResults.ts`
  - Existing: `src/core/resultAnalysis.ts`
  - Existing: `src/core/resultAnalysisPresentation.ts`
  - Tests: `tests/resultTable.test.ts`, `tests/resultAnalysis.test.ts`, `tests/resultAnalysisPresentation.test.ts`, `tests/analyzeResultsAOCS.test.ts`
- Planned files if needed:
  - `src/core/benchmark/resultTableScoring.ts`
  - `tests/resultTableScoring.test.ts`
- Validation commands:
  - `npm test -- tests/resultTable.test.ts tests/resultAnalysis.test.ts tests/resultTableScoring.test.ts`
  - `npm run build`
- Completion criteria:
  - Result tables preserve condition, dataset/task, primary metric, numeric result, comparator status, and caveats.
  - Missing comparator or missing metric is represented explicitly, not silently omitted.
  - AGB-003 and AGB-009 block superiority/performance claims without valid comparator and metric evidence.

### 8. Figure Audit

- [ ] Status: not started
- Related repo files:
  - Existing: `src/core/analysis/figureAuditor.ts`
  - Existing: `src/core/nodes/figureAudit.ts`
  - Existing: `src/core/nodes/review.ts`
  - Tests: `tests/figureAuditor.test.ts`, `tests/figureAuditNode.test.ts`, `tests/reviewNode.test.ts`
- Planned files if needed:
  - `src/core/benchmark/figureAuditScoring.ts`
  - `tests/figureAuditScoring.test.ts`
- Validation commands:
  - `npm test -- tests/figureAuditor.test.ts tests/figureAuditNode.test.ts tests/figureAuditScoring.test.ts`
  - `npm run build`
- Completion criteria:
  - `figure_audit/figure_audit_summary.json` detects figure/caption/result-table mismatch with an affected figure id.
  - Severe mismatch escalates review to repair or backtrack.
  - `no_figure_audit` ablation is recorded distinctly from a clean audit pass.

### 9. Review-Before-Writing

- [ ] Status: not started
- Related repo files:
  - Existing: `src/core/nodes/review.ts`
  - Existing: `src/core/nodes/writePaper.ts`
  - Existing: `src/core/reviewPacket.ts`
  - Existing: `src/core/reviewSystem.ts`
  - Tests: `tests/reviewNode.test.ts`, `tests/reviewDecision.test.ts`, `tests/paperWriting.test.ts`, `tests/writePaperPdfBuild.test.ts`
- Planned files if needed:
  - `tests/reviewBeforeWritingGovernance.test.ts`
- Validation commands:
  - `npm test -- tests/reviewNode.test.ts tests/reviewDecision.test.ts tests/reviewBeforeWritingGovernance.test.ts`
  - `npm run validate:harness`
- Completion criteria:
  - `review/paper_critique.json` is produced before drafting and blocks weak evidence from entering `write_paper`.
  - `review/decision.json` recommends supported upstream targets for missing baseline, missing result table, unsupported claim, or figure mismatch.
  - `write_paper completed` remains visibly distinct from `paper_ready`.

### 10. Live-Validation Failure Taxonomy

- [ ] Status: not started
- Related repo files:
  - Existing: `ISSUES.md`
  - Existing: `docs/live-validation-issue-template.md`
  - Existing: `src/core/doctor.ts`
  - Existing: `src/core/validation/harnessValidators.ts`
  - Tests: `tests/doctorHarnessIntegration.test.ts`, `tests/harnessValidators.test.ts`, `tests/liveFixtureWorkspace.test.ts`
- Planned files if needed:
  - `src/core/benchmark/liveValidationScoring.ts`
  - `tests/liveValidationScoring.test.ts`
- Validation commands:
  - `npm test -- tests/doctorHarnessIntegration.test.ts tests/harnessValidators.test.ts tests/liveValidationScoring.test.ts`
  - `npm run validate:harness`
  - For real interactive defects: re-run the same TUI/web flow after fixes.
- Completion criteria:
  - Every live-validation case records one dominant class: `persisted_state_bug`, `in_memory_projection_bug`, `refresh_render_bug`, `resume_reload_bug`, or `race_timing_bug`.
  - AGB-009 separates syntax success from metric evidence.
  - AGB-010 preserves fallback labels and excludes deterministic fallback from paper-scale evidence.

### 11. Rubric Scoring Output

- [ ] Status: not started
- Related repo files:
  - Existing: `src/cli/evalHarness.ts`
  - Existing: `src/core/evaluation/evalHarness.ts`
  - Existing: `src/core/metaHarness/harnessApplier.ts`
  - Existing: `src/core/metaHarness/harnessLoader.ts`
  - Existing: `src/core/metaHarness/types.ts`
  - Tests: `tests/evalHarness.test.ts`, `tests/harnessLoader.test.ts`, `tests/harnessApplier.test.ts`, `tests/metaHarness.test.ts`
- Planned files if needed:
  - `src/core/benchmark/governanceRubric.ts`
  - `src/core/benchmark/governanceScorer.ts`
  - `tests/governanceRubric.test.ts`
  - `tests/governanceScorer.test.ts`
- Validation commands:
  - `npm test -- tests/governanceRubric.test.ts tests/governanceScorer.test.ts tests/evalHarness.test.ts`
  - `npm run validate:harness`
- Completion criteria:
  - Each task has a 10-point rubric over evidence linkage, claim discipline, gate correctness, artifact completeness, and repairability.
  - Scoring output includes primary metrics such as `false_paper_ready_rate`, `unsupported_claim_count`, `claim_to_evidence_coverage`, `missing_baseline_pass_rate`, and `figure_result_mismatch_rate`.
  - Placeholder values are never reported as measured results.

### 12. AGB-001 Dry-Run

- [ ] Status: not started
- Related repo files:
  - Existing: `src/cli/main.ts`
  - Existing: `src/core/runs/researchBriefFiles.ts`
  - Existing: `src/core/validation/harnessValidationService.ts`
  - Existing: `src/core/nodes/review.ts`
  - Existing: `src/core/nodes/writePaper.ts`
- Planned files if needed:
  - `outputs/governance-benchmark/AGB-001/README.md` generated by run/export tooling
- Validation commands:
  - `npm run build`
  - `npm test -- tests/governanceSeedBundle.test.ts tests/governanceArtifactContract.test.ts tests/governanceScorer.test.ts`
  - `npm run validate:harness`
  - Real flow, when ready: start AutoLabOS and run `/brief start <path-to-AGB-001-brief.md>`
- Completion criteria:
  - AGB-001 produces or replays a run under both `gated` and `ungated` conditions.
  - Missing baseline is detected.
  - Comparative improvement claim is blocked or downgraded.
  - Required artifacts and scoring outputs exist and are parseable.

### 13. AGB-002 Through AGB-010 Batch Or Replay

- [ ] Status: not started
- Related repo files:
  - Existing: `src/cli/evalHarness.ts`
  - Existing: `src/core/evaluation/evalHarness.ts`
  - Existing: `src/core/publicOutputPublisher.ts`
  - Existing: `src/core/validation/harnessValidationService.ts`
- Planned files if needed:
  - `src/cli/governanceBenchmark.ts`
  - `src/core/benchmark/governanceRunner.ts`
  - `tests/governanceRunner.test.ts`
- Validation commands:
  - `npm test -- tests/governanceRunner.test.ts tests/governanceScorer.test.ts tests/harnessValidationService.test.ts`
  - `npm run validate:harness`
  - `npm run build`
- Completion criteria:
  - All 10 tasks can be queued for gated/ungated runs or replayed from fixed artifacts.
  - AGB-002 validates scope-limited claims and limitations.
  - AGB-003 validates comparator-failure result table discipline.
  - AGB-004 validates citation support precision.
  - AGB-005 validates figure audit behavior.
  - AGB-006 validates BaselineLock and SingleChangeEnforcer behavior.
  - AGB-007 and AGB-008 validate literature discovery trace, abstention, and exclusion reasons.
  - AGB-009 and AGB-010 validate live execution evidence boundaries.

### 14. Paper/System Demo Artifact Bundle Export

- [ ] Status: not started
- Related repo files:
  - Existing: `src/core/publicOutputPublisher.ts`
  - Existing: `src/core/publicArtifacts.ts`
  - Existing: `src/cli/metaHarness.ts`
  - Existing: `src/core/metaHarness/metaHarness.ts`
  - Existing: `src/web/artifacts.ts`
  - Tests: `tests/publicOutputPublisher.test.ts`, `tests/webArtifacts.test.ts`, `tests/metaHarness.test.ts`
- Planned files if needed:
  - `src/core/benchmark/governanceBundleExporter.ts`
  - `tests/governanceBundleExporter.test.ts`
- Validation commands:
  - `npm test -- tests/governanceBundleExporter.test.ts tests/publicOutputPublisher.test.ts tests/webArtifacts.test.ts`
  - `npm run validate:harness`
  - `npm run build`
- Completion criteria:
  - Export bundle includes brief, condition, run config, events, required artifacts, scoring output, unsupported claim notes, and README.
  - Bundle distinguishes workflow completion, `write_paper` completion, PDF build success, and `paper_ready=true`.
  - At least 3 public demo bundles can be selected without editing run-scoped source artifacts.

## First Implementation Slice

Start with items 1, 2, 3, 4, and 11 before executing benchmark runs. These establish the input, condition, artifact, and scoring contracts. Then run item 12 as the contract lock. Only after AGB-001 passes should items 5 through 10 be broadened across AGB-002 through AGB-010.

## Validation Policy For Future Edits

- Docs-only checklist edits: no build required; run a markdown/readability inspection.
- TypeScript/runtime edits: `npm run build` plus targeted tests.
- Workflow, harness, artifact, or reproducibility edits: `npm run validate:harness`.
- TUI/web interactive behavior: same-flow live validation in addition to tests when the environment allows.
- Web UI edits: `npm run test:web`.
- Smoke paths: use targeted smoke commands when changing natural command or run execution flows.
