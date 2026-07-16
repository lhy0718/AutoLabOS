import path from "node:path";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  loadPromotionBenchmarkSuite,
  type PromotionBenchmarkConcernPrediction,
  type PromotionBenchmarkPrediction
} from "./promotionBenchmark.js";

export interface AnalyzePromotionBenchmarkFailuresInput {
  cwd: string;
  suitePath: string;
  predictionsPath: string;
  systemId: string;
  outDir: string;
}

export interface PromotionBenchmarkFailureAnalysisResult {
  suite_id: string;
  system_id: string;
  evaluated_case_count: number;
  failed_case_count: number;
  recommendation_count: number;
  output_dir: string;
  analysis_path: string;
  recommendations_path: string;
  diagnostics_path: string;
}

interface FailureRow {
  case_id: string;
  mutation_family: string;
  gold_decision: string;
  predicted_decision?: string;
  missing_blocking_concerns: string[];
  unexpected_blocking_concerns: string[];
  gold_repair_owners: string[];
  predicted_repair_owners: string[];
  failure_modes: string[];
}

export async function analyzePromotionBenchmarkFailures(
  input: AnalyzePromotionBenchmarkFailuresInput
): Promise<PromotionBenchmarkFailureAnalysisResult> {
  const cwd = path.resolve(input.cwd);
  const suitePath = path.resolve(cwd, input.suitePath);
  const predictionsPath = path.resolve(cwd, input.predictionsPath);
  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(`Promotion benchmark suite validation failed: ${loaded.issues.map((issue) => issue.code).join(", ")}`);
  }
  const predictions = (await readPredictions(predictionsPath)).filter((prediction) => prediction.system_id === input.systemId);
  const predictionByCase = new Map<string, PromotionBenchmarkPrediction>();
  for (const prediction of predictions) {
    if (predictionByCase.has(prediction.case_id)) {
      throw new Error(`Failure analysis requires one trial per case; duplicate case for system ${input.systemId}: ${prediction.case_id}`);
    }
    predictionByCase.set(prediction.case_id, prediction);
  }

  const failures: FailureRow[] = [];
  for (const benchmarkCase of loaded.suite.cases) {
    const prediction = predictionByCase.get(benchmarkCase.case_id);
    const predictedBlockers = new Set(
      (prediction?.concerns || []).filter((concern) => concern.severity === "blocking").map((concern) => concern.code)
    );
    const expectedBlockers = new Set(benchmarkCase.gold.blocking_concerns);
    const missingBlockers = [...expectedBlockers].filter((code) => !predictedBlockers.has(code));
    const unexpectedBlockers = [...predictedBlockers].filter((code) => !expectedBlockers.has(code));
    const failureModes: string[] = [];
    if (!prediction) failureModes.push("prediction_missing");
    else if (prediction.decision !== benchmarkCase.gold.decision) failureModes.push("decision_mismatch");
    if (missingBlockers.length > 0) failureModes.push("blocking_concern_missed");
    if (unexpectedBlockers.length > 0) failureModes.push("unexpected_blocking_concern");
    if (!setsEqual(new Set(prediction?.repair_owners || []), new Set(benchmarkCase.gold.repair_owners))) {
      failureModes.push("repair_owner_mismatch");
    }
    if (failureModes.length === 0) continue;
    failures.push({
      case_id: benchmarkCase.case_id,
      mutation_family: benchmarkCase.mutation_family || "clean_control",
      gold_decision: benchmarkCase.gold.decision,
      ...(prediction ? { predicted_decision: prediction.decision } : {}),
      missing_blocking_concerns: missingBlockers,
      unexpected_blocking_concerns: unexpectedBlockers,
      gold_repair_owners: benchmarkCase.gold.repair_owners,
      predicted_repair_owners: prediction?.repair_owners || [],
      failure_modes: failureModes
    });
  }

  const diagnostics = failures.flatMap((failure) => {
    const targets = failure.gold_repair_owners.length > 0 ? failure.gold_repair_owners : ["review"];
    return targets.map((targetNode) => ({
      id: `promotion_benchmark:${failure.mutation_family}:${failure.failure_modes.join("+")}`,
      severity: "blocking",
      target_node: targetNode,
      source_node: "review",
      summary: `${input.systemId} failed ${failure.mutation_family}: ${failure.failure_modes.join(", ")}.${failure.missing_blocking_concerns.length > 0 ? ` Missing blockers: ${failure.missing_blocking_concerns.join(", ")}.` : ""}`,
      missing_blocking_concerns: failure.missing_blocking_concerns,
      unexpected_blocking_concerns: failure.unexpected_blocking_concerns,
      recheck_condition: `Re-run ${loaded.suite?.manifest.suite_id} and require correct decision, blocker coverage, and repair owner for ${failure.mutation_family}.`,
      case_id: failure.case_id
    }));
  });
  const recommendations = buildRecommendations(diagnostics);
  const outDir = path.resolve(cwd, input.outDir);
  const reviewDir = path.join(outDir, "review");
  await fs.mkdir(reviewDir, { recursive: true });
  const analysisPath = path.join(reviewDir, "promotion_benchmark_failure_analysis.json");
  const diagnosticsPath = path.join(reviewDir, "paper_scale_diagnostics.json");
  const recommendationsPath = path.join(reviewDir, "node_strengthening_recommendations.json");
  await writeJsonFile(analysisPath, {
    schema_version: "1.0",
    suite_id: loaded.suite.manifest.suite_id,
    system_id: input.systemId,
    evaluated_case_count: loaded.suite.cases.length,
    failed_case_count: failures.length,
    failures
  });
  await writeJsonFile(diagnosticsPath, { diagnostics });
  await writeJsonFile(recommendationsPath, { recommendations });
  await writeJsonFile(path.join(reviewDir, "decision.json"), {
    outcome: failures.length > 0 ? "revise" : "accept",
    failed_case_count: failures.length
  });

  return {
    suite_id: loaded.suite.manifest.suite_id,
    system_id: input.systemId,
    evaluated_case_count: loaded.suite.cases.length,
    failed_case_count: failures.length,
    recommendation_count: recommendations.length,
    output_dir: portableRef(cwd, outDir),
    analysis_path: portableRef(cwd, analysisPath),
    recommendations_path: portableRef(cwd, recommendationsPath),
    diagnostics_path: portableRef(cwd, diagnosticsPath)
  };
}

function buildRecommendations(diagnostics: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byNode = new Map<string, Array<Record<string, unknown>>>();
  for (const diagnostic of diagnostics) {
    const node = String(diagnostic.target_node || "review");
    byNode.set(node, [...(byNode.get(node) || []), diagnostic]);
  }
  return [...byNode.entries()].map(([node, rows]) => ({
    node,
    priority: "high",
    diagnostic_ids: [...new Set(rows.map((row) => String(row.id)))],
    problem_summary: [...new Set(rows.map((row) => String(row.summary)))].join(" "),
    recheck_condition: [...new Set(rows.map((row) => String(row.recheck_condition)))].join(" ")
  })).sort((left, right) => String(left.node).localeCompare(String(right.node)));
}

async function readPredictions(filePath: string): Promise<PromotionBenchmarkPrediction[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const predictions: PromotionBenchmarkPrediction[] = [];
  for (const [index, line] of raw.split(/\r?\n/gu).entries()) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.case_id !== "string" || typeof value.system_id !== "string" || typeof value.trial_id !== "string"
        || typeof value.decision !== "string" || !Array.isArray(value.concerns) || !Array.isArray(value.repair_owners)) {
      throw new Error(`Invalid promotion prediction at line ${index + 1}.`);
    }
    predictions.push({
      case_id: value.case_id,
      system_id: value.system_id,
      trial_id: value.trial_id,
      decision: value.decision as PromotionBenchmarkPrediction["decision"],
      concerns: value.concerns as PromotionBenchmarkConcernPrediction[],
      repair_owners: value.repair_owners.map(String)
    });
  }
  return predictions;
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : "<external-output>";
}
