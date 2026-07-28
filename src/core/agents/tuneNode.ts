import path from "node:path";
import { createHash } from "node:crypto";

import { RunRecord } from "../../types.js";
import {
  buildSelfCritiqueRetryPromptVariant,
  getNodePromptPath,
  loadAnalyzeResultsPromptSections,
  loadDesignExperimentsPromptSections,
  loadGenerateHypothesesPromptSections,
  TUNABLE_NODE_NAMES,
  TunableNodeName
} from "../nodePrompts.js";

export type TuneNodeEvaluationStatus = "available" | "unavailable" | "error";

export interface TuneNodeVariantScore {
  label: "original" | "mutant";
  status: TuneNodeEvaluationStatus;
  evaluatorId: string;
  diagnosticId: string;
  score: number | null;
  passed: boolean;
  subjectHash: string | null;
  artifactPath: string | null;
  notes: string[];
}

export interface TuneNodeReport {
  node: TunableNodeName;
  runId: string;
  promptPath: string;
  evaluationStatus: "comparable" | "unavailable" | "incomparable";
  original: TuneNodeVariantScore;
  mutant: TuneNodeVariantScore;
  delta: number | null;
  recommendation: "keep" | "revert" | "unavailable";
  lines: string[];
}

export interface TuneNodeRunnerInput {
  workspaceRoot: string;
  run: Pick<RunRecord, "id" | "title" | "topic" | "objectiveMetric" | "constraints">;
  node: TunableNodeName;
}

export interface TuneNodeRunner {
  run(input: TuneNodeRunnerInput): Promise<TuneNodeReport>;
}

export interface TuneNodeEvaluatorInput extends TuneNodeRunnerInput {
  variant: "original" | "mutant";
  systemPrompt: string;
  promptHash: string;
}

export type TuneNodeEvaluator = (input: TuneNodeEvaluatorInput) => Promise<TuneNodeVariantScore>;

interface TuneNodeComparison {
  status: TuneNodeReport["evaluationStatus"];
  delta: number | null;
  recommendation: TuneNodeReport["recommendation"];
  reason: string | null;
}

export class DefaultTuneNodeRunner implements TuneNodeRunner {
  constructor(private readonly evaluator: TuneNodeEvaluator = evaluateTuneNodeVariant) {}

  async run(input: TuneNodeRunnerInput): Promise<TuneNodeReport> {
    assertSupportedTunableNode(input.node);

    const originalPrompt = getPrimarySystemPrompt(input.node);
    const mutantPrompt = buildSelfCritiqueRetryPromptVariant(originalPrompt);
    const originalPromptHash = hashPrompt(originalPrompt);
    const mutantPromptHash = hashPrompt(mutantPrompt);
    const original = await runTuneNodeEvaluation(this.evaluator, {
      ...input,
      variant: "original",
      systemPrompt: originalPrompt,
      promptHash: originalPromptHash
    });
    const mutant = await runTuneNodeEvaluation(this.evaluator, {
      ...input,
      variant: "mutant",
      systemPrompt: mutantPrompt,
      promptHash: mutantPromptHash
    }, original);
    const comparison = compareTuneNodeEvaluations(original, mutant);
    const evaluatorId = original.evaluatorId || mutant.evaluatorId || "unavailable";
    const diagnosticId = original.diagnosticId || mutant.diagnosticId || `node:${input.node}`;
    const lines = [
      `Tune-node report for ${input.node} on ${input.run.id}.`,
      `Prompt file: ${path.relative(input.workspaceRoot, getNodePromptPath(input.node)) || getNodePromptPath(input.node)}`,
      `EVALUATION STATUS: ${comparison.status}`,
      `EVALUATOR: ${evaluatorId}`,
      `DIAGNOSTIC: ${diagnosticId}`,
      `SCORE_BEFORE: ${formatScore(original.score)}`,
      `SCORE_AFTER: ${formatScore(mutant.score)}`,
      `SUBJECT_HASH_BEFORE: ${original.subjectHash || "unavailable"}`,
      `SUBJECT_HASH_AFTER: ${mutant.subjectHash || "unavailable"}`,
      `DELTA: ${formatSignedScore(comparison.delta)}`,
      "PASS CRITERION: each score is bound to its prompt hash, evaluator and diagnostic match, score_after > score_before, and candidate passed evaluator criterion.",
      `RECOMMENDATION: ${comparison.recommendation}`,
      "This comparison is report-only. No prompt changes were applied."
    ];

    if (comparison.reason) {
      lines.push(`Comparison blocked: ${comparison.reason}`);
    }
    if (original.notes.length > 0) {
      lines.push(`Original notes: ${original.notes.join("; ")}`);
    }
    if (mutant.notes.length > 0) {
      lines.push(`Mutant notes: ${mutant.notes.join("; ")}`);
    }

    return {
      node: input.node,
      runId: input.run.id,
      promptPath: getNodePromptPath(input.node),
      evaluationStatus: comparison.status,
      original,
      mutant,
      delta: comparison.delta,
      recommendation: comparison.recommendation,
      lines
    };
  }
}

export async function evaluateTuneNodeVariant(
  input: TuneNodeEvaluatorInput
): Promise<TuneNodeVariantScore> {
  return {
    label: input.variant,
    status: "unavailable",
    evaluatorId: "unconfigured",
    diagnosticId: `prompt_quality:${input.node}`,
    score: null,
    passed: false,
    subjectHash: input.promptHash,
    artifactPath: null,
    notes: ["No domain evaluator was injected; tune-node is report-only."]
  };
}

function compareTuneNodeEvaluations(
  original: TuneNodeVariantScore,
  mutant: TuneNodeVariantScore
): TuneNodeComparison {
  if (original.status !== "available" || mutant.status !== "available") {
    return {
      status: "unavailable",
      delta: scoreDelta(original.score, mutant.score),
      recommendation: "unavailable",
      reason: `evaluation unavailable: before=${original.status}, after=${mutant.status}`
    };
  }
  if (original.evaluatorId !== mutant.evaluatorId) {
    return {
      status: "incomparable",
      delta: scoreDelta(original.score, mutant.score),
      recommendation: "unavailable",
      reason: `evaluator mismatch: before=${original.evaluatorId}, after=${mutant.evaluatorId}`
    };
  }
  if (original.diagnosticId !== mutant.diagnosticId) {
    return {
      status: "incomparable",
      delta: scoreDelta(original.score, mutant.score),
      recommendation: "unavailable",
      reason: `diagnostic mismatch: before=${original.diagnosticId}, after=${mutant.diagnosticId}`
    };
  }

  const delta = scoreDelta(original.score, mutant.score);
  if (delta === null) {
    return {
      status: "incomparable",
      delta: null,
      recommendation: "unavailable",
      reason: "finite before and after scores are required"
    };
  }
  return {
    status: "comparable",
    delta,
    recommendation: delta > 0 && mutant.passed ? "keep" : "revert",
    reason: delta > 0 && mutant.passed
      ? null
      : delta <= 0
        ? "score_after did not exceed score_before"
        : "candidate did not pass the evaluator criterion"
  };
}

async function runTuneNodeEvaluation(
  evaluator: TuneNodeEvaluator,
  input: TuneNodeEvaluatorInput,
  expected?: TuneNodeVariantScore
): Promise<TuneNodeVariantScore> {
  try {
    const result = await evaluator(input);
    if (result.subjectHash !== input.promptHash) {
      return {
        ...result,
        status: "error",
        score: null,
        passed: false,
        notes: [
          ...result.notes,
          `score subject hash mismatch: expected=${input.promptHash}, actual=${result.subjectHash || "missing"}`
        ]
      };
    }
    return result;
  } catch (error) {
    return {
      label: input.variant,
      status: "error",
      evaluatorId: expected?.evaluatorId || "unknown",
      diagnosticId: expected?.diagnosticId || `prompt_quality:${input.node}`,
      score: null,
      passed: false,
      subjectHash: input.promptHash,
      artifactPath: null,
      notes: [error instanceof Error ? error.message : String(error)]
    };
  }
}

function assertSupportedTunableNode(node: string): asserts node is TunableNodeName {
  if (!(TUNABLE_NODE_NAMES as readonly string[]).includes(node)) {
    throw new Error(
      `Unsupported node for tune-node: ${node}. Allowed nodes: ${TUNABLE_NODE_NAMES.join(", ")}.`
    );
  }
}

function getPrimarySystemPrompt(node: TunableNodeName): string {
  if (node === "generate_hypotheses") {
    return loadGenerateHypothesesPromptSections().system;
  }
  if (node === "design_experiments") {
    return loadDesignExperimentsPromptSections().system;
  }
  return loadAnalyzeResultsPromptSections().system;
}

function formatScore(score: number | null): string {
  return score === null ? "unavailable" : score.toFixed(2);
}

function formatSignedScore(score: number | null): string {
  if (score === null) {
    return "unavailable";
  }
  return `${score >= 0 ? "+" : ""}${score.toFixed(2)}`;
}

function scoreDelta(before: number | null, after: number | null): number | null {
  if (before === null || after === null || !Number.isFinite(before) || !Number.isFinite(after)) {
    return null;
  }
  return Math.round((after - before) * 100) / 100;
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}
