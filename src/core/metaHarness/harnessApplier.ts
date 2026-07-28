import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { ensureDir, normalizeFsPath } from "../../utils/fs.js";

const execFile = promisify(execFileCallback);

export type HarnessEvaluationPhase = "before" | "after";
export type HarnessEvaluationStatus = "available" | "unavailable" | "error";

export interface HarnessEvaluationRequest {
  phase: HarnessEvaluationPhase;
  workspaceRoot: string;
  targetFile: string;
  source: "meta-harness" | "shadow-eval";
  candidateId: string | null;
  scope: Readonly<Record<string, unknown>>;
  subjectHash: string;
}

export interface HarnessEvaluationResult {
  status: HarnessEvaluationStatus;
  evaluatorId: string;
  diagnosticId: string;
  score: number | null;
  passed: boolean;
  subjectHash: string | null;
  artifactPath: string | null;
  reason: string | null;
}

export type HarnessEvaluator = (
  input: HarnessEvaluationRequest
) => Promise<HarnessEvaluationResult>;

export interface HarnessPromotionCriteria {
  minimumScoreDelta: number;
  minimumScoreAfter: number | null;
}

export const DEFAULT_HARNESS_PROMOTION_CRITERIA: HarnessPromotionCriteria = {
  minimumScoreDelta: 0,
  minimumScoreAfter: null
};

export interface HarnessApplyResult {
  applied: boolean;
  targetFile: string;
  gitCommitBefore: string | null;
  validationPassed: boolean;
  structuralValidationPassed: boolean;
  promotionAllowed: boolean;
  evaluationBefore: HarnessEvaluationResult | null;
  evaluationAfter: HarnessEvaluationResult | null;
  scoreBefore: number | null;
  scoreAfter: number | null;
  scoreDelta: number | null;
  subjectHashBefore: string | null;
  subjectHashAfter: string | null;
  promotionCriteria: HarnessPromotionCriteria;
  blockedReason: string | null;
  rolledBack: boolean;
  rollbackReason: string | null;
  auditLogPath: string;
}

export interface HarnessApplyOptions {
  targetFile: string;
  newContent: string;
  source: "meta-harness" | "shadow-eval";
  candidateId: string | null;
  evaluator?: HarnessEvaluator;
  evaluationScope?: Readonly<Record<string, unknown>>;
  promotionCriteria?: HarnessPromotionCriteria;
  dryRun?: boolean;
}

interface HarnessApplierDeps {
  runValidateHarness: (cwd: string) => Promise<void>;
  gitRevParseHead: (cwd: string) => Promise<string | null>;
  gitCommit: (cwd: string, targetFile: string, message: string) => Promise<void>;
}

interface PromotionAssessment {
  allowed: boolean;
  reason: string | null;
  scoreDelta: number | null;
}

export async function applyWithSafetyNet(
  options: HarnessApplyOptions,
  deps: Partial<HarnessApplierDeps> = {}
): Promise<HarnessApplyResult> {
  const targetFile = normalizeFsPath(options.targetFile);
  const workspaceRoot = findWorkspaceRoot(targetFile);
  const promptsRoot = normalizeFsPath(path.join(workspaceRoot, "node-prompts"));
  if (!isWithinDirectory(targetFile, promptsRoot)) {
    throw new Error("Harness targetFile must stay inside node-prompts/.");
  }

  const promotionCriteria = resolvePromotionCriteria(options.promotionCriteria);
  const auditLogPath = normalizeFsPath(path.join(workspaceRoot, ".autolabos", "harness-apply-log.jsonl"));
  const resolvedDeps: HarnessApplierDeps = {
    runValidateHarness: defaultRunValidateHarness,
    gitRevParseHead: defaultGitRevParseHead,
    gitCommit: defaultGitCommit,
    ...deps
  };
  const evaluator = options.evaluator || unavailableHarnessEvaluator;
  const evaluationScope = options.evaluationScope || {};
  const gitCommitBefore = await resolvedDeps.gitRevParseHead(workspaceRoot);

  if (options.dryRun) {
    const result = buildResult({
      targetFile,
      gitCommitBefore,
      promotionCriteria,
      auditLogPath,
      blockedReason: "dry_run"
    });
    await appendAuditLog(auditLogPath, buildAuditEntry(options, result));
    return result;
  }

  const previousContent = await fs.readFile(targetFile, "utf8");
  const subjectHashBefore = hashContent(previousContent);
  const candidateSubjectHash = hashContent(options.newContent);
  const evaluationBefore = await runEvaluation(evaluator, {
    phase: "before",
    workspaceRoot,
    targetFile,
    source: options.source,
    candidateId: options.candidateId,
    scope: evaluationScope,
    subjectHash: subjectHashBefore
  });
  const beforeBlockReason = evaluationBlockReason(evaluationBefore, "before", subjectHashBefore);
  if (beforeBlockReason) {
    const result = buildResult({
      targetFile,
      gitCommitBefore,
      promotionCriteria,
      auditLogPath,
      evaluationBefore,
      blockedReason: beforeBlockReason
    });
    await appendAuditLog(auditLogPath, buildAuditEntry(options, result));
    return result;
  }

  await fs.writeFile(targetFile, options.newContent, "utf8");

  try {
    await resolvedDeps.runValidateHarness(workspaceRoot);
  } catch (error) {
    const blockedReason = `structural_validation_failed: ${errorMessage(error)}`;
    await fs.writeFile(targetFile, previousContent, "utf8");
    const result = buildResult({
      targetFile,
      gitCommitBefore,
      promotionCriteria,
      auditLogPath,
      evaluationBefore,
      blockedReason,
      rolledBack: true,
      rollbackReason: blockedReason
    });
    await appendAuditLog(auditLogPath, buildAuditEntry(options, result));
    return result;
  }

  const subjectHashAfterValidation = hashContent(await fs.readFile(targetFile, "utf8"));
  if (subjectHashAfterValidation !== candidateSubjectHash) {
    const blockedReason = `candidate_subject_hash_changed: expected=${candidateSubjectHash}, actual=${subjectHashAfterValidation}`;
    await fs.writeFile(targetFile, previousContent, "utf8");
    const result = buildResult({
      targetFile,
      gitCommitBefore,
      promotionCriteria,
      auditLogPath,
      structuralValidationPassed: true,
      evaluationBefore,
      blockedReason,
      rolledBack: true,
      rollbackReason: blockedReason
    });
    await appendAuditLog(auditLogPath, buildAuditEntry(options, result));
    return result;
  }

  const evaluationAfter = await runEvaluation(evaluator, {
    phase: "after",
    workspaceRoot,
    targetFile,
    source: options.source,
    candidateId: options.candidateId,
    scope: evaluationScope,
    subjectHash: candidateSubjectHash
  }, evaluationBefore);
  const assessment = assessPromotion(
    evaluationBefore,
    evaluationAfter,
    promotionCriteria,
    subjectHashBefore,
    candidateSubjectHash
  );
  if (!assessment.allowed) {
    await fs.writeFile(targetFile, previousContent, "utf8");
    const result = buildResult({
      targetFile,
      gitCommitBefore,
      promotionCriteria,
      auditLogPath,
      structuralValidationPassed: true,
      evaluationBefore,
      evaluationAfter,
      scoreDelta: assessment.scoreDelta,
      blockedReason: assessment.reason,
      rolledBack: true,
      rollbackReason: assessment.reason
    });
    await appendAuditLog(auditLogPath, buildAuditEntry(options, result));
    return result;
  }

  try {
    await resolvedDeps.gitCommit(
      workspaceRoot,
      targetFile,
      `chore(harness): auto-apply ${options.source} -> ${path.basename(targetFile, ".md")}`
    );
  } catch (error) {
    const blockedReason = `commit_failed: ${errorMessage(error)}`;
    await fs.writeFile(targetFile, previousContent, "utf8");
    const result = buildResult({
      targetFile,
      gitCommitBefore,
      promotionCriteria,
      auditLogPath,
      structuralValidationPassed: true,
      evaluationBefore,
      evaluationAfter,
      scoreDelta: assessment.scoreDelta,
      blockedReason,
      rolledBack: true,
      rollbackReason: blockedReason
    });
    await appendAuditLog(auditLogPath, buildAuditEntry(options, result));
    return result;
  }

  const result = buildResult({
    applied: true,
    targetFile,
    gitCommitBefore,
    promotionCriteria,
    auditLogPath,
    structuralValidationPassed: true,
    promotionAllowed: true,
    evaluationBefore,
    evaluationAfter,
    scoreDelta: assessment.scoreDelta
  });
  await appendAuditLog(auditLogPath, buildAuditEntry(options, result));
  return result;
}

export async function unavailableHarnessEvaluator(
  input: HarnessEvaluationRequest
): Promise<HarnessEvaluationResult> {
  return {
    status: "unavailable",
    evaluatorId: "unconfigured",
    diagnosticId: `prompt:${path.basename(input.targetFile, path.extname(input.targetFile))}`,
    score: null,
    passed: false,
    subjectHash: input.subjectHash,
    artifactPath: null,
    reason: "No domain evaluator was injected; automatic promotion is report-only."
  };
}

function assessPromotion(
  before: HarnessEvaluationResult,
  after: HarnessEvaluationResult,
  criteria: HarnessPromotionCriteria,
  subjectHashBefore: string,
  subjectHashAfter: string
): PromotionAssessment {
  const afterBlockReason = evaluationBlockReason(after, "after", subjectHashAfter);
  if (afterBlockReason) {
    return {
      allowed: false,
      reason: afterBlockReason,
      scoreDelta: scoreDelta(before.score, after.score)
    };
  }
  if (before.subjectHash !== subjectHashBefore) {
    return {
      allowed: false,
      reason: `evaluation_before_subject_hash_mismatch: expected=${subjectHashBefore}, actual=${before.subjectHash || "missing"}`,
      scoreDelta: scoreDelta(before.score, after.score)
    };
  }
  if (subjectHashBefore === subjectHashAfter) {
    return {
      allowed: false,
      reason: "candidate_subject_unchanged",
      scoreDelta: scoreDelta(before.score, after.score)
    };
  }
  if (before.evaluatorId !== after.evaluatorId) {
    return {
      allowed: false,
      reason: `evaluator_mismatch: before=${before.evaluatorId}, after=${after.evaluatorId}`,
      scoreDelta: scoreDelta(before.score, after.score)
    };
  }
  if (before.diagnosticId !== after.diagnosticId) {
    return {
      allowed: false,
      reason: `diagnostic_mismatch: before=${before.diagnosticId}, after=${after.diagnosticId}`,
      scoreDelta: scoreDelta(before.score, after.score)
    };
  }

  const delta = scoreDelta(before.score, after.score);
  if (delta === null || before.score === null || after.score === null) {
    return {
      allowed: false,
      reason: "evaluation_score_missing",
      scoreDelta: delta
    };
  }
  if (!(after.score > before.score)) {
    return {
      allowed: false,
      reason: `score_not_improved: score_before=${before.score}, score_after=${after.score}`,
      scoreDelta: delta
    };
  }
  if (delta < criteria.minimumScoreDelta) {
    return {
      allowed: false,
      reason: `minimum_score_delta_not_met: required=${criteria.minimumScoreDelta}, actual=${delta}`,
      scoreDelta: delta
    };
  }
  if (criteria.minimumScoreAfter !== null && after.score < criteria.minimumScoreAfter) {
    return {
      allowed: false,
      reason: `minimum_score_after_not_met: required=${criteria.minimumScoreAfter}, actual=${after.score}`,
      scoreDelta: delta
    };
  }
  if (!after.passed) {
    return {
      allowed: false,
      reason: "evaluation_after_failed_pass_criterion",
      scoreDelta: delta
    };
  }
  return {
    allowed: true,
    reason: null,
    scoreDelta: delta
  };
}

function evaluationBlockReason(
  evaluation: HarnessEvaluationResult,
  phase: HarnessEvaluationPhase,
  expectedSubjectHash: string
): string | null {
  if (evaluation.status !== "available") {
    return `evaluation_${phase}_${evaluation.status}: ${evaluation.reason || "No score was produced."}`;
  }
  if (!evaluation.evaluatorId.trim()) {
    return `evaluation_${phase}_invalid: evaluatorId is required`;
  }
  if (!evaluation.diagnosticId.trim()) {
    return `evaluation_${phase}_invalid: diagnosticId is required`;
  }
  if (evaluation.score === null || !Number.isFinite(evaluation.score)) {
    return `evaluation_${phase}_invalid: finite score is required`;
  }
  if (evaluation.subjectHash !== expectedSubjectHash) {
    return `evaluation_${phase}_subject_hash_mismatch: expected=${expectedSubjectHash}, actual=${evaluation.subjectHash || "missing"}`;
  }
  return null;
}

async function runEvaluation(
  evaluator: HarnessEvaluator,
  request: HarnessEvaluationRequest,
  expected?: HarnessEvaluationResult
): Promise<HarnessEvaluationResult> {
  try {
    return await evaluator(request);
  } catch (error) {
    return {
      status: "error",
      evaluatorId: expected?.evaluatorId || "unknown",
      diagnosticId: expected?.diagnosticId || `prompt:${path.basename(request.targetFile, path.extname(request.targetFile))}`,
      score: null,
      passed: false,
      subjectHash: request.subjectHash,
      artifactPath: null,
      reason: errorMessage(error)
    };
  }
}

function resolvePromotionCriteria(
  criteria: HarnessPromotionCriteria | undefined
): HarnessPromotionCriteria {
  const resolved = criteria || DEFAULT_HARNESS_PROMOTION_CRITERIA;
  if (!Number.isFinite(resolved.minimumScoreDelta) || resolved.minimumScoreDelta < 0) {
    throw new Error("promotionCriteria.minimumScoreDelta must be a finite non-negative number.");
  }
  if (
    resolved.minimumScoreAfter !== null
    && !Number.isFinite(resolved.minimumScoreAfter)
  ) {
    throw new Error("promotionCriteria.minimumScoreAfter must be null or a finite number.");
  }
  return {
    minimumScoreDelta: resolved.minimumScoreDelta,
    minimumScoreAfter: resolved.minimumScoreAfter
  };
}

function buildResult(input: {
  applied?: boolean;
  targetFile: string;
  gitCommitBefore: string | null;
  promotionCriteria: HarnessPromotionCriteria;
  auditLogPath: string;
  structuralValidationPassed?: boolean;
  promotionAllowed?: boolean;
  evaluationBefore?: HarnessEvaluationResult | null;
  evaluationAfter?: HarnessEvaluationResult | null;
  scoreDelta?: number | null;
  blockedReason?: string | null;
  rolledBack?: boolean;
  rollbackReason?: string | null;
}): HarnessApplyResult {
  const structuralValidationPassed = input.structuralValidationPassed || false;
  const evaluationBefore = input.evaluationBefore || null;
  const evaluationAfter = input.evaluationAfter || null;
  return {
    applied: input.applied || false,
    targetFile: input.targetFile,
    gitCommitBefore: input.gitCommitBefore,
    validationPassed: structuralValidationPassed,
    structuralValidationPassed,
    promotionAllowed: input.promotionAllowed || false,
    evaluationBefore,
    evaluationAfter,
    scoreBefore: evaluationBefore?.score ?? null,
    scoreAfter: evaluationAfter?.score ?? null,
    scoreDelta: input.scoreDelta ?? scoreDelta(evaluationBefore?.score ?? null, evaluationAfter?.score ?? null),
    subjectHashBefore: evaluationBefore?.subjectHash ?? null,
    subjectHashAfter: evaluationAfter?.subjectHash ?? null,
    promotionCriteria: input.promotionCriteria,
    blockedReason: input.blockedReason || null,
    rolledBack: input.rolledBack || false,
    rollbackReason: input.rollbackReason || null,
    auditLogPath: input.auditLogPath
  };
}

function buildAuditEntry(options: HarnessApplyOptions, result: HarnessApplyResult) {
  return {
    timestamp: new Date().toISOString(),
    source: options.source,
    node: path.basename(result.targetFile, ".md"),
    target_file: result.targetFile,
    applied: result.applied,
    structural_validation_passed: result.structuralValidationPassed,
    promotion_allowed: result.promotionAllowed,
    rolled_back: result.rolledBack,
    rollback_reason: result.rollbackReason,
    blocked_reason: result.blockedReason,
    candidate_id: options.candidateId,
    evaluation_scope: options.evaluationScope || {},
    evaluator_id: result.evaluationBefore?.evaluatorId || null,
    diagnostic_id: result.evaluationBefore?.diagnosticId || null,
    evaluation_before: result.evaluationBefore,
    evaluation_after: result.evaluationAfter,
    score_before: result.scoreBefore,
    score_after: result.scoreAfter,
    score_delta: result.scoreDelta,
    subject_hash_before: result.subjectHashBefore,
    subject_hash_after: result.subjectHashAfter,
    promotion_criteria: {
      same_evaluator_required: true,
      same_diagnostic_required: true,
      score_subject_hash_binding_required: true,
      score_after_must_exceed_score_before: true,
      minimum_score_delta: result.promotionCriteria.minimumScoreDelta,
      minimum_score_after: result.promotionCriteria.minimumScoreAfter,
      evaluation_after_pass_required: true
    }
  };
}

async function appendAuditLog(
  auditLogPath: string,
  entry: ReturnType<typeof buildAuditEntry>
): Promise<void> {
  await ensureDir(path.dirname(auditLogPath));
  await fs.appendFile(auditLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function scoreDelta(before: number | null, after: number | null): number | null {
  if (before === null || after === null || !Number.isFinite(before) || !Number.isFinite(after)) {
    return null;
  }
  return Math.round((after - before) * 1_000_000) / 1_000_000;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findWorkspaceRoot(targetFile: string): string {
  const promptsIndex = targetFile.lastIndexOf(`${path.sep}node-prompts${path.sep}`);
  if (promptsIndex >= 0) {
    return targetFile.slice(0, promptsIndex);
  }
  return path.dirname(path.dirname(targetFile));
}

function isWithinDirectory(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function defaultRunValidateHarness(cwd: string): Promise<void> {
  await execFile("npm", ["run", "validate:harness"], {
    cwd,
    timeout: 120_000
  });
}

async function defaultGitRevParseHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function defaultGitCommit(cwd: string, targetFile: string, message: string): Promise<void> {
  // --only commits the named worktree path through Git's temporary index, so a
  // failed commit cannot leave the candidate staged in the caller's index.
  await execFile("git", ["commit", "--only", "-m", message, "--", targetFile], { cwd });
}
