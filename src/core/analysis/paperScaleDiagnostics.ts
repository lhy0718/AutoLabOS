import type { AnalysisReport } from "../resultAnalysis.js";
import { GATE_THRESHOLDS } from "./paperGateThresholds.js";

export type PaperScaleDiagnosticSeverity = "blocking" | "warning";

export type PaperScaleDiagnosticCategory =
  | "evaluation_sample_size"
  | "statistical_adequacy"
  | "training_budget"
  | "execution_coverage"
  | "related_work_depth"
  | "resource_claim";

export interface PaperScaleDiagnostic {
  id: string;
  severity: PaperScaleDiagnosticSeverity;
  category: PaperScaleDiagnosticCategory;
  source_node: string;
  target_node: string;
  summary: string;
  evidence: string;
  recommended_action: string;
  recheck_condition: string;
}

export interface PaperScaleDiagnosticSummary {
  generated_at: string;
  diagnostics: PaperScaleDiagnostic[];
  blocking_count: number;
  warning_count: number;
}

export function evaluatePaperScaleDiagnostics(input: {
  report: AnalysisReport;
  topic: string;
  bibliographyText?: string;
}): PaperScaleDiagnosticSummary {
  const diagnostics: PaperScaleDiagnostic[] = [];

  const evalSample = extractEvalSampleSummary(input.report);
  if (
    evalSample.minimumCount !== undefined
    && evalSample.minimumCount < GATE_THRESHOLDS.minEvaluationExamplesPerTaskForPaperScale
  ) {
    diagnostics.push({
      id: "tiny_eval_sample",
      severity: "blocking",
      category: "evaluation_sample_size",
      source_node: "run_experiments",
      target_node: "run_experiments",
      summary: "Evaluation sample size is too small for paper-scale claims.",
      evidence: `Minimum observed per-task evaluation count is ${evalSample.minimumCount}; task counts: ${formatTaskCounts(evalSample.taskCounts)}.`,
      recommended_action: "Expand each benchmark/task evaluation split before claiming a stable model or hyperparameter effect.",
      recheck_condition: `Every primary task reports at least ${GATE_THRESHOLDS.minEvaluationExamplesPerTaskForPaperScale} evaluation examples, or the manuscript is explicitly capped as a pilot note.`
    });
  }

  const positiveComparisonSignal = detectPositiveComparisonSignal(input.report);
  const seedSummary = extractSeedSummary(input.report);
  if (
    positiveComparisonSignal
    && seedSummary.distinctSeeds < GATE_THRESHOLDS.minDistinctSeedsForPaperScale
  ) {
    diagnostics.push({
      id: "missing_seed_replication",
      severity: "blocking",
      category: "statistical_adequacy",
      source_node: "run_experiments",
      target_node: "run_experiments",
      summary: "Positive comparative signal has no repeated-seed support.",
      evidence: `${positiveComparisonSignal} Observed distinct seed count is ${seedSummary.distinctSeeds || 0}; ${seedSummary.seedEvidencePresent ? `seeds: ${seedSummary.seeds.join(", ") || "none"}` : "seed fields are absent or empty"}.`,
      recommended_action: "Run repeated seeds for the baseline and leading condition, then report seed-level variance or paired uncertainty.",
      recheck_condition: `At least ${GATE_THRESHOLDS.minDistinctSeedsForPaperScale} distinct seeds are present for the comparison or the claim is downgraded.`
    });
  }

  const executionCoverage = extractExecutionCoverage(input.report);
  if (
    executionCoverage.expectedRuns !== undefined
    && executionCoverage.executedRuns !== undefined
    && executionCoverage.executedRuns < executionCoverage.expectedRuns
  ) {
    diagnostics.push({
      id: "incomplete_planned_runs",
      severity: "blocking",
      category: "execution_coverage",
      source_node: "run_experiments",
      target_node: "run_experiments",
      summary: "Executed runs do not cover the approved experiment plan.",
      evidence: `Executed ${executionCoverage.executedRuns} of ${executionCoverage.expectedRuns} planned run(s) (${formatRatio(executionCoverage.executedRuns, executionCoverage.expectedRuns)} coverage).`,
      recommended_action: "Execute the missing conditions or repetitions, or explicitly downgrade the design and all dependent claims before review.",
      recheck_condition: "Executed run coverage reaches the approved plan, or the plan and claim ceiling are governed down to the completed scope."
    });
  }

  const oneItemGain = detectOneItemGain(input.report);
  if (oneItemGain) {
    diagnostics.push({
      id: "single_item_gain",
      severity: "blocking",
      category: "statistical_adequacy",
      source_node: "analyze_results",
      target_node: "analyze_results",
      summary: "Headline improvement is consistent with a one-example accuracy change.",
      evidence: oneItemGain,
      recommended_action: "Report the result as a pilot screening signal and require a larger paired evaluation before claiming a condition-parameter effect.",
      recheck_condition: "The leading-vs-baseline delta is supported by more than a one-example change or by robust paired statistics."
    });
  }

  const stepSummary = extractOptimizerStepSummary(input.report);
  if (
    stepSummary.maximumSteps !== undefined
    && stepSummary.maximumSteps < GATE_THRESHOLDS.minOptimizerStepsForTuningClaim
  ) {
    diagnostics.push({
      id: "thin_training_budget",
      severity: "warning",
      category: "training_budget",
      source_node: "implement_experiments",
      target_node: "implement_experiments",
      summary: "Training budget is closer to a smoke test than a tuning experiment.",
      evidence: `Maximum observed optimizer steps is ${stepSummary.maximumSteps}; condition steps: ${stepSummary.stepValues.join(", ") || "none"}.`,
      recommended_action: "Increase the train budget or restrict claims to pipeline/preflight validation.",
      recheck_condition: `Optimizer steps are at least ${GATE_THRESHOLDS.minOptimizerStepsForTuningClaim} for paper-scale tuning claims, or the manuscript genre is downgraded.`
    });
  }

  const trainingSampleBudget = extractTrainingSampleBudget(input.report);
  if (
    trainingSampleBudget.plannedSamples !== undefined
    && trainingSampleBudget.actualSamples !== undefined
    && trainingSampleBudget.actualSamples < trainingSampleBudget.plannedSamples
  ) {
    diagnostics.push({
      id: "training_budget_mismatch",
      severity: "blocking",
      category: "training_budget",
      source_node: "implement_experiments",
      target_node: "implement_experiments",
      summary: "Executed training sample budget is below the approved design budget.",
      evidence: `Run configuration used at most ${trainingSampleBudget.actualSamples} training sample(s), while the selected design specifies ${trainingSampleBudget.plannedSamples} (${formatRatio(trainingSampleBudget.actualSamples, trainingSampleBudget.plannedSamples)} coverage).`,
      recommended_action: "Regenerate and rerun the implementation with the approved training budget, or govern the result down to a preflight/system-validation claim.",
      recheck_condition: "The executed training sample budget matches the selected design, or the design and claim ceiling explicitly adopt the smaller budget."
    });
  }

  const interactionRisk = detectWeakInteractionClaim(input.report);
  if (interactionRisk) {
    diagnostics.push({
      id: "weak_interaction_evidence",
      severity: "warning",
      category: "statistical_adequacy",
      source_node: "generate_hypotheses",
      target_node: "design_experiments",
      summary: "Interaction framing is stronger than the observed grid evidence.",
      evidence: interactionRisk,
      recommended_action: "Reframe as candidate screening or redesign the grid with enough samples and seeds to test interaction effects.",
      recheck_condition: "Interaction claims are supported by repeated cells, adequate samples, and multiple non-baseline deltas rather than one isolated condition."
    });
  }

  const canonicalReferenceGap = detectCanonicalReferenceGap(input.topic, input.report, input.bibliographyText);
  if (canonicalReferenceGap) {
    diagnostics.push({
      id: "canonical_method_references_missing",
      severity: "warning",
      category: "related_work_depth",
      source_node: "collect_papers",
      target_node: "collect_papers",
      summary: "Related work appears to miss canonical sources for a named method-family topic.",
      evidence: canonicalReferenceGap,
      recommended_action: "Collect and cite the original method-family papers before paper-scale review.",
      recheck_condition: "The bibliography includes canonical references when the topic or metrics center on a named method family."
    });
  }

  const resourceRisk = detectResourceClaimRisk(input.report);
  if (resourceRisk) {
    diagnostics.push({
      id: "resource_claim_unsupported",
      severity: "warning",
      category: "resource_claim",
      source_node: "analyze_results",
      target_node: "analyze_results",
      summary: "Resource measurements are present but not strong enough for efficiency claims.",
      evidence: resourceRisk,
      recommended_action: "Keep runtime/VRAM as diagnostics unless condition-level aggregates and repeated measurements are available.",
      recheck_condition: "Resource claims are backed by repeated condition-level runtime/memory summaries or removed from claim-level prose."
    });
  }

  return {
    generated_at: new Date().toISOString(),
    diagnostics,
    blocking_count: diagnostics.filter((diagnostic) => diagnostic.severity === "blocking").length,
    warning_count: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length
  };
}

function extractEvalSampleSummary(report: AnalysisReport): {
  taskCounts: Array<{ task: string; count: number }>;
  minimumCount?: number;
} {
  const taskCounts: Array<{ task: string; count: number }> = [];
  const metrics = asRecord(report.metrics);
  const data = asRecord(metrics.data);
  const evalData = asRecord(data.eval);
  for (const [task, value] of Object.entries(evalData)) {
    const count = asNumber(asRecord(value).count);
    if (count !== undefined) {
      taskCounts.push({ task, count });
    }
  }

  for (const condition of asArray(metrics.conditions)) {
    const marker = asString(asRecord(condition).marker) || "condition";
    const perTask = asRecord(asRecord(condition).per_task_metrics);
    for (const [task, value] of Object.entries(perTask)) {
      const total = asNumber(asRecord(value).total);
      if (total !== undefined) {
        taskCounts.push({ task: `${marker}:${task}`, count: total });
      }
    }
  }

  const counts = taskCounts.map((entry) => entry.count).filter((count) => Number.isFinite(count));
  return {
    taskCounts,
    minimumCount: counts.length > 0 ? Math.min(...counts) : undefined
  };
}

function extractSeedSummary(report: AnalysisReport): { seeds: string[]; distinctSeeds: number; seedEvidencePresent: boolean } {
  const seeds = new Set<string>();
  let seedEvidencePresent = false;
  let reportedSeedCount = 0;
  const metrics = asRecord(report.metrics);
  seedEvidencePresent = addSeed(seeds, asRecord(metrics.run_config).seed) || seedEvidencePresent;
  seedEvidencePresent = addSeeds(seeds, asArray(metrics.seeds)) || seedEvidencePresent;
  for (const condition of [
    ...asArray(metrics.conditions),
    ...asArray(metrics.condition_results),
    ...asArray(metrics.raw_condition_results)
  ]) {
    const record = asRecord(condition);
    seedEvidencePresent = addSeed(seeds, record.seed) || seedEvidencePresent;
    seedEvidencePresent = addSeed(seeds, record.random_seed) || seedEvidencePresent;
    seedEvidencePresent = addSeeds(seeds, asArray(record.seeds)) || seedEvidencePresent;
    const seedCount = asNumber(record.seed_count);
    if (seedCount !== undefined && seedCount > 0) {
      seedEvidencePresent = true;
      reportedSeedCount = Math.max(reportedSeedCount, seedCount);
    }
  }
  const distinctSeeds = Math.max(seeds.size, reportedSeedCount);
  const seedLabels = Array.from(seeds);
  if (seedLabels.length === 0 && reportedSeedCount > 0) {
    seedLabels.push(`reported_seed_count=${reportedSeedCount}`);
  }
  return { seeds: seedLabels, distinctSeeds, seedEvidencePresent };
}

function detectPositiveComparisonSignal(report: AnalysisReport): string | undefined {
  if (report.overview?.objective_status === "met") {
    return "The objective status is met.";
  }

  const positiveComparison = (report.condition_comparisons ?? []).find((comparison) =>
    comparison.metrics.some((metric) => Number.isFinite(metric.value) && metric.value > 0)
  );
  if (positiveComparison) {
    return `Condition comparison ${positiveComparison.id || "unknown"} contains a positive delta.`;
  }

  const metrics = asRecord(report.metrics);
  const summary = asRecord(metrics.summary);
  const observedDelta =
    asNumber(summary.best_accuracy_delta_vs_baseline)
    ?? asNumber(metrics.accuracy_delta_vs_baseline)
    ?? report.overview?.observed_value;
  if (observedDelta !== undefined && observedDelta > 0 && (report.condition_comparisons?.length ?? 0) > 0) {
    return `A baseline-relative comparative delta of ${observedDelta} is reported.`;
  }
  return undefined;
}

function extractExecutionCoverage(report: AnalysisReport): { expectedRuns?: number; executedRuns?: number } {
  const portfolio = report.experiment_portfolio;
  const structuredExpected = [
    portfolio?.total_expected_trials,
    ...(portfolio?.trial_groups ?? []).map((group) => group.expected_trials)
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const structuredExecuted = [
    portfolio?.executed_trials,
    report.statistical_summary?.executed_trials,
    report.overview?.execution_runs,
    ...(portfolio?.trial_groups ?? []).map((group) => group.executed_trials)
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);

  const planTexts = [
    report.plan_context?.selected_design?.summary,
    ...(report.plan_context?.selected_design?.evaluation_steps ?? []),
    ...(report.plan_context?.selected_design?.resource_notes ?? []),
    ...(portfolio?.trial_groups ?? []).flatMap((group) => group.notes ?? [])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const textualExpected = planTexts.flatMap(extractExpectedRunCounts);

  return {
    expectedRuns: maximumDefined([...structuredExpected, ...textualExpected]),
    executedRuns: maximumDefined(structuredExecuted)
  };
}

function extractExpectedRunCounts(value: string): number[] {
  const counts: number[] = [];
  for (const match of value.matchAll(/\b(\d[\d,]*)\s+(?:(?:planned|completed|training|full|total|expected)\s+){0,4}runs?\b/giu)) {
    const count = parseCount(match[1]);
    if (count !== undefined) {
      counts.push(count);
    }
  }
  for (const match of value.matchAll(/\b(\d[\d,]*)\s*(?:conditions?|cells?)\s*[x×]\s*(\d[\d,]*)\s*seeds?\s*=\s*(\d[\d,]*)\s*(?:completed\s+)?runs?\b/giu)) {
    const statedTotal = parseCount(match[3]);
    if (statedTotal !== undefined) {
      counts.push(statedTotal);
    }
  }
  return counts;
}

function detectOneItemGain(report: AnalysisReport): string | undefined {
  const metrics = asRecord(report.metrics);
  const summary = asRecord(metrics.summary);
  const baselineMarker = asString(summary.baseline_condition_marker);
  const bestMarker = asString(summary.best_condition_marker);
  const conditions = asArray(metrics.conditions).map(asRecord);
  const baseline = conditions.find((condition) => asString(condition.marker) === baselineMarker);
  const best = conditions.find((condition) => asString(condition.marker) === bestMarker);
  if (!baseline || !best) {
    return undefined;
  }

  const deltas: string[] = [];
  let totalCorrectDelta = 0;
  let comparedTasks = 0;
  const baselineTasks = asRecord(baseline.per_task_metrics);
  const bestTasks = asRecord(best.per_task_metrics);
  for (const [task, baselineValue] of Object.entries(baselineTasks)) {
    const baselineCorrect = asNumber(asRecord(baselineValue).correct);
    const baselineTotal = asNumber(asRecord(baselineValue).total);
    const bestTask = asRecord(bestTasks[task]);
    const bestCorrect = asNumber(bestTask.correct);
    const bestTotal = asNumber(bestTask.total);
    if (
      baselineCorrect === undefined ||
      bestCorrect === undefined ||
      baselineTotal === undefined ||
      bestTotal === undefined ||
      baselineTotal !== bestTotal
    ) {
      continue;
    }
    const delta = bestCorrect - baselineCorrect;
    totalCorrectDelta += Math.abs(delta);
    comparedTasks += 1;
    deltas.push(`${task}: ${baselineCorrect}/${baselineTotal} -> ${bestCorrect}/${bestTotal} (delta ${delta})`);
  }

  if (comparedTasks === 0 || totalCorrectDelta > 1) {
    return undefined;
  }

  const headlineDelta =
    asNumber(summary.best_accuracy_delta_vs_baseline) ??
    asNumber(metrics.accuracy_delta_vs_baseline) ??
    report.overview?.observed_value;
  if (headlineDelta === undefined || headlineDelta <= 0) {
    return undefined;
  }

  return `Best condition ${bestMarker || "unknown"} differs from baseline ${baselineMarker || "unknown"} by ${totalCorrectDelta} total correct answer(s): ${deltas.join("; ")}. Headline delta=${headlineDelta}.`;
}

function extractOptimizerStepSummary(report: AnalysisReport): { stepValues: number[]; maximumSteps?: number } {
  const metrics = asRecord(report.metrics);
  const stepValues: number[] = [];
  const runConfig = asRecord(metrics.run_config);
  for (const value of [runConfig.max_steps, runConfig.optimizer_steps, runConfig.steps_completed]) {
    const steps = asNumber(value);
    if (steps !== undefined) {
      stepValues.push(steps);
    }
  }
  for (const condition of [
    ...asArray(metrics.conditions),
    ...asArray(metrics.condition_results),
    ...asArray(metrics.condition_summaries)
  ]) {
    const steps = asNumber(asRecord(condition).steps_completed);
    if (steps !== undefined) {
      stepValues.push(steps);
    }
  }
  return {
    stepValues,
    maximumSteps: stepValues.length > 0 ? Math.max(...stepValues) : undefined
  };
}

function extractTrainingSampleBudget(report: AnalysisReport): { plannedSamples?: number; actualSamples?: number } {
  const runConfig = asRecord(asRecord(report.metrics).run_config);
  const actualSamples = maximumDefined([
    asNumber(runConfig.max_train_samples),
    asNumber(runConfig.train_samples),
    asNumber(runConfig.training_examples),
    asNumber(runConfig.max_training_examples)
  ].filter((value): value is number => value !== undefined));
  const planTexts = [
    report.plan_context?.selected_design?.summary,
    ...(report.plan_context?.selected_design?.implementation_notes ?? [])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const plannedSamples = maximumDefined(planTexts.flatMap((value) => {
    const counts: number[] = [];
    for (const match of value.matchAll(/\b(\d[\d,]*)\s+(?:training\s+)?examples?\b/giu)) {
      const count = parseCount(match[1]);
      if (count !== undefined) {
        counts.push(count);
      }
    }
    return counts;
  }));
  return { plannedSamples, actualSamples };
}

function detectWeakInteractionClaim(report: AnalysisReport): string | undefined {
  const metrics = asRecord(report.metrics);
  const conditions = asArray(metrics.conditions).map(asRecord);
  const parameterXValues = new Set<string>();
  const parameterYValues = new Set<string>();
  let positiveDeltaCount = 0;
  for (const condition of conditions) {
    const parameterX = asNumber(condition.condition_parameter_x ?? condition.parameter_x);
    const parameterY = asNumber(condition.condition_parameter_y ?? condition.parameter_y);
    if (parameterX !== undefined) {
      parameterXValues.add(String(parameterX));
    }
    if (parameterY !== undefined) {
      parameterYValues.add(String(parameterY));
    }
    const delta = asNumber(condition.accuracy_delta_vs_baseline);
    if (delta !== undefined && delta > 0) {
      positiveDeltaCount += 1;
    }
  }
  const text = [
    report.overview?.objective_summary,
    ...(report.primary_findings ?? []),
    ...(report.paper_claims ?? []).map((claim) => claim.claim)
  ].join(" ");
  if (parameterXValues.size < 2 || parameterYValues.size < 2 || positiveDeltaCount !== 1 || !/\binteraction|factor|parameter\b/iu.test(text)) {
    return undefined;
  }
  return `Grid has ${parameterXValues.size} factor-x value(s), ${parameterYValues.size} factor-y value(s), and only ${positiveDeltaCount} positive-delta condition(s).`;
}

function detectCanonicalReferenceGap(topic: string, report: AnalysisReport, bibliographyText?: string): string | undefined {
  const text = [
    topic,
    report.overview?.objective_summary,
    ...(report.primary_findings ?? []),
    ...(report.paper_claims ?? []).map((claim) => claim.claim)
  ].join(" ");
  const methodMatch =
    text.match(/\b(?:canonical|original|seminal)\s+([A-Z][A-Za-z0-9-]{2,40})\b/u)
    || text.match(/\b([A-Z][A-Za-z0-9-]{2,40})\s+(?:method|model|algorithm|framework|family)\b/u);
  const methodName = (methodMatch?.[1] || "").replace(/[^A-Za-z0-9-]+/gu, "").trim();
  if (!methodName || /^(?:The|This|That|Prior|Original|Canonical|Related|Benchmark)$/u.test(methodName)) {
    return undefined;
  }
  const bibliography = (bibliographyText || "").toLowerCase();
  if (!bibliography) {
    return `No bibliography text was available for canonical-reference audit of ${methodName}.`;
  }
  if (bibliography.includes(methodName.toLowerCase())) {
    return undefined;
  }
  return `Canonical coverage may be missing for named method family: ${methodName}.`;
}

function detectResourceClaimRisk(report: AnalysisReport): string | undefined {
  const metrics = asRecord(report.metrics);
  const conditions = asArray(metrics.conditions).map(asRecord);
  const hasResourceValues = conditions.some(
    (condition) => asNumber(condition.runtime_sec) !== undefined || asNumber(condition.peak_cuda_memory_bytes) !== undefined
  );
  if (!hasResourceValues) {
    return undefined;
  }
  const stabilityMetricCount = report.statistical_summary?.stability_metrics?.length ?? 0;
  const totalTrials = report.statistical_summary?.total_trials ?? report.statistical_summary?.executed_trials ?? report.overview?.execution_runs;
  if (stabilityMetricCount > 0 && typeof totalTrials === "number" && totalTrials >= 3) {
    return undefined;
  }
  return `Runtime/VRAM values are present, but stability_metrics=${stabilityMetricCount} and total_trials=${totalTrials ?? "unknown"}.`;
}

function formatTaskCounts(taskCounts: Array<{ task: string; count: number }>): string {
  return taskCounts.slice(0, 8).map((entry) => `${entry.task}=${entry.count}`).join(", ") || "none";
}

function formatRatio(numerator: number, denominator: number): string {
  return denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : "unknown";
}

function parseCount(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value.replace(/,/gu, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function maximumDefined(values: number[]): number | undefined {
  return values.length > 0 ? Math.max(...values) : undefined;
}

function addSeed(target: Set<string>, value: unknown): boolean {
  const seed = asString(value);
  if (seed) {
    target.add(seed);
    return true;
  }
  return false;
}

function addSeeds(target: Set<string>, values: unknown[]): boolean {
  let added = false;
  for (const value of values) {
    added = addSeed(target, value) || added;
  }
  return added;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
