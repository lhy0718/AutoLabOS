import { promises as fs } from "node:fs";
import path from "node:path";

import {
  validateActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "./activeTopicProbeContract.js";
import {
  validateResearchFunnelClosedChain,
  type TopicDecision,
  type TopicPortfolio
} from "./researchFunnel.js";
import { buildResearchGapEvidenceChain } from "./analysis/researchGapEvidenceChain.js";
import type { AnalysisReport } from "./resultAnalysis.js";
import {
  validateTopicProbeOutcomeDecision,
  type TopicProbeOutcomeDecision
} from "./topicProbeOutcome.js";
import { buildWorkspaceRunRoot } from "./runs/runPaths.js";

export const TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS = {
  gapMap: "analysis/gap_map.json",
  gapSynthesis: "analysis/gap_synthesis.json",
  evidenceStore: "evidence_store.jsonl",
  corpus: "corpus.jsonl",
  collectGeneration: "collect_generation.json",
  evidenceAxes: "hypothesis_generation/evidence_axes.json",
  priorAbsorptionMatrix: "hypothesis_generation/prior_absorption_matrix.json",
  hypotheses: "hypotheses.jsonl",
  drafts: "hypothesis_generation/drafts.jsonl",
  reviews: "hypothesis_generation/reviews.jsonl",
  probeShortlist: "hypothesis_generation/probe_shortlist.json",
  portfolio: "hypothesis_generation/topic_portfolio.json",
  topicDecision: "design_experiments_panel/topic_decision.json",
  activeContract: "design_experiments_panel/active_topic_probe_contract.json",
  outcome: "analysis/topic_probe_outcome.json"
} as const;

export const TOPIC_PROBE_GAP_MAP_RELATIVE_PATH =
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.gapMap;
export const TOPIC_PROBE_HYPOTHESES_RELATIVE_PATH =
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.hypotheses;
export const TOPIC_PROBE_DRAFTS_RELATIVE_PATH =
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.drafts;
export const TOPIC_PROBE_REVIEWS_RELATIVE_PATH =
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.reviews;
export const TOPIC_PROBE_SHORTLIST_RELATIVE_PATH =
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.probeShortlist;
export const TOPIC_PROBE_PORTFOLIO_RELATIVE_PATH =
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.portfolio;
export const TOPIC_PROBE_DECISION_RELATIVE_PATH =
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.topicDecision;
export const ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH =
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.activeContract;
export const TOPIC_PROBE_OUTCOME_RELATIVE_PATH =
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.outcome;

export const TOPIC_PROBE_REQUIRED_ARTIFACT_RELATIVE_PATHS = [
  TOPIC_PROBE_GAP_MAP_RELATIVE_PATH,
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.gapSynthesis,
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.evidenceStore,
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.corpus,
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.collectGeneration,
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.evidenceAxes,
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.priorAbsorptionMatrix,
  TOPIC_PROBE_HYPOTHESES_RELATIVE_PATH,
  TOPIC_PROBE_DRAFTS_RELATIVE_PATH,
  TOPIC_PROBE_REVIEWS_RELATIVE_PATH,
  TOPIC_PROBE_SHORTLIST_RELATIVE_PATH,
  TOPIC_PROBE_PORTFOLIO_RELATIVE_PATH,
  TOPIC_PROBE_DECISION_RELATIVE_PATH,
  ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH
] as const;

export interface TopicProbeOutcomeArtifactsLoadInput {
  workspaceRoot: string;
  runId: string;
  researchCycle?: number;
  expectedResearchCycle?: number;
  requireOutcome?: boolean;
  report?: AnalysisReport;
  analysisReport?: AnalysisReport;
}

export type LoadTopicProbeOutcomeArtifactsInput =
  TopicProbeOutcomeArtifactsLoadInput;

export interface TopicProbeOutcomeArtifactsValidation {
  measured: boolean;
  valid: boolean;
  reasons: string[];
  portfolio?: TopicPortfolio;
  topicDecision?: TopicDecision;
  contract?: ActiveTopicProbeContract;
  decision?: TopicProbeOutcomeDecision;
}

type ArtifactRead =
  | { status: "read"; raw: string }
  | { status: "missing" }
  | { status: "read_error"; reasonCode: string };

export async function loadTopicProbeOutcomeArtifacts(
  input: TopicProbeOutcomeArtifactsLoadInput
): Promise<TopicProbeOutcomeArtifactsValidation> {
  try {
    return await loadTopicProbeOutcomeArtifactsUnchecked(input);
  } catch {
    return {
      measured: false,
      valid: false,
      reasons: ["topic_probe_outcome_artifacts_loader_error"]
    };
  }
}

export const loadValidatedTopicProbeOutcomeArtifacts =
  loadTopicProbeOutcomeArtifacts;

async function loadTopicProbeOutcomeArtifactsUnchecked(
  input: TopicProbeOutcomeArtifactsLoadInput
): Promise<TopicProbeOutcomeArtifactsValidation> {
  const inputReasons: string[] = [];
  const workspaceRoot =
    typeof input.workspaceRoot === "string" ? input.workspaceRoot : "";
  const runId = typeof input.runId === "string" ? input.runId : "";
  if (!workspaceRoot.trim()) {
    inputReasons.push("topic_probe_outcome_artifacts_workspace_root_missing");
  }
  if (!runId.trim()) {
    inputReasons.push("topic_probe_outcome_artifacts_run_id_missing");
  }

  const cycle = resolveResearchCycle(input, inputReasons);
  const runRoot = buildWorkspaceRunRoot(workspaceRoot, runId);
  const paths = TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS;
  const requiredReads = await Promise.all([
    readArtifact(runRoot, paths.gapMap),
    readArtifact(runRoot, paths.gapSynthesis),
    readArtifact(runRoot, paths.evidenceStore),
    readArtifact(runRoot, paths.corpus),
    readArtifact(runRoot, paths.collectGeneration),
    readArtifact(runRoot, paths.evidenceAxes),
    readArtifact(runRoot, paths.priorAbsorptionMatrix),
    readArtifact(runRoot, paths.hypotheses),
    readArtifact(runRoot, paths.drafts),
    readArtifact(runRoot, paths.reviews),
    readArtifact(runRoot, paths.probeShortlist),
    readArtifact(runRoot, paths.portfolio),
    readArtifact(runRoot, paths.topicDecision),
    readArtifact(runRoot, paths.activeContract)
  ]);
  const [
    gapMapRead,
    gapSynthesisRead,
    evidenceStoreRead,
    corpusRead,
    collectGenerationRead,
    evidenceAxesRead,
    priorAbsorptionMatrixRead,
    hypothesesRead,
    draftsRead,
    reviewsRead,
    probeShortlistRead,
    portfolioRead,
    topicDecisionRead,
    activeContractRead
  ] = requiredReads;
  const requireOutcome = input.requireOutcome === true;
  const outcomeRead = requireOutcome
    ? await readArtifact(runRoot, paths.outcome)
    : undefined;

  const validationExceptionReasons: string[] = [];
  let funnelValidation: ReturnType<typeof validateResearchFunnelClosedChain> | undefined;
  try {
    const gapEvidenceChain = buildResearchGapEvidenceChain({
      runId,
      researchCycle: cycle,
      corpusRaw: readRaw(corpusRead) || "",
      evidenceRaw: readRaw(evidenceStoreRead) || "",
      synthesisRaw: readRaw(gapSynthesisRead) || "",
      collectGenerationRaw: readRaw(collectGenerationRead) || ""
    });
    funnelValidation = validateResearchFunnelClosedChain({
      expectedRunId: runId,
      expectedResearchCycle: cycle,
      gapMapRaw: readRaw(gapMapRead),
      evidenceAxesRaw: readRaw(evidenceAxesRead),
      priorAbsorptionMatrixRaw: readRaw(priorAbsorptionMatrixRead),
      hypothesesRaw: readRaw(hypothesesRead),
      draftsRaw: readRaw(draftsRead),
      reviewsRaw: readRaw(reviewsRead),
      probeShortlistRaw: readRaw(probeShortlistRead),
      portfolioRaw: readRaw(portfolioRead),
      decisionRaw: readRaw(topicDecisionRead),
      requireDecision: true,
      gapValidationContext: gapEvidenceChain.validationContext,
      gapValidationReasonCodes: gapEvidenceChain.reasonCodes
    });
  } catch {
    validationExceptionReasons.push(
      "topic_probe_outcome_artifacts_validation_error:research_funnel"
    );
  }

  const portfolio =
    funnelValidation?.portfolioValidation.valid === true
      ? funnelValidation.portfolio
      : undefined;
  const topicDecision =
    funnelValidation?.decisionValidation.valid === true
      ? funnelValidation.decision
      : undefined;

  let contractValidation:
    | ReturnType<typeof validateActiveTopicProbeContract>
    | undefined;
  try {
    contractValidation = validateActiveTopicProbeContract(
      readRaw(activeContractRead) || "",
      {
        expectedRunId: runId,
        expectedResearchCycle: cycle,
        portfolio
      }
    );
  } catch {
    validationExceptionReasons.push(
      "topic_probe_outcome_artifacts_validation_error:active_contract"
    );
  }
  const contract = contractValidation?.contract;

  let outcomeValidation:
    | ReturnType<typeof validateTopicProbeOutcomeDecision>
    | undefined;
  if (requireOutcome) {
    try {
      outcomeValidation = validateTopicProbeOutcomeDecision(
        readRaw(outcomeRead) || "",
        {
          expectedRunId: runId,
          expectedResearchCycle: cycle,
          contract,
          report: input.report ?? input.analysisReport
        }
      );
    } catch {
      validationExceptionReasons.push(
        "topic_probe_outcome_artifacts_validation_error:outcome"
      );
    }
  }

  const reads = [
    ...requiredReads,
    ...(outcomeRead ? [outcomeRead] : [])
  ];
  const readReasons = reads.flatMap((read) =>
    read.status === "read_error" ? [read.reasonCode] : []
  );
  const reasons = uniqueStrings([
    ...inputReasons,
    ...(funnelValidation?.reasons || []),
    ...(contractValidation?.reasons || []),
    ...(outcomeValidation?.reasons || []),
    ...validationExceptionReasons,
    ...readReasons
  ]);
  const measured =
    funnelValidation?.measured === true
    || contractValidation?.measured === true
    || outcomeValidation?.measured === true
    || reads.some((read) => read.status === "read_error");
  const valid =
    inputReasons.length === 0
    && readReasons.length === 0
    && validationExceptionReasons.length === 0
    && funnelValidation?.valid === true
    && contractValidation?.valid === true
    && (!requireOutcome || outcomeValidation?.valid === true);

  return {
    measured,
    valid,
    reasons,
    portfolio,
    topicDecision,
    contract,
    decision: outcomeValidation?.decision
  };
}

function resolveResearchCycle(
  input: TopicProbeOutcomeArtifactsLoadInput,
  reasons: string[]
): number {
  if (
    input.researchCycle !== undefined
    && input.expectedResearchCycle !== undefined
    && input.researchCycle !== input.expectedResearchCycle
  ) {
    reasons.push("topic_probe_outcome_artifacts_research_cycle_input_mismatch");
  }
  const value = input.expectedResearchCycle ?? input.researchCycle;
  if (!Number.isInteger(value) || Number(value) < 0) {
    reasons.push("topic_probe_outcome_artifacts_research_cycle_invalid");
    return 0;
  }
  return Number(value);
}

async function readArtifact(
  runRoot: string,
  relativePath: string
): Promise<ArtifactRead> {
  try {
    return {
      status: "read",
      raw: await fs.readFile(path.join(runRoot, relativePath), "utf8")
    };
  } catch (error) {
    const code = readErrorCode(error);
    if (code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "read_error",
      reasonCode:
        `topic_probe_artifact_read_error:${relativePath}:`
        + (code?.toLowerCase() || "unknown")
    };
  }
}

function readRaw(read: ArtifactRead | undefined): string | undefined {
  return read?.status === "read" ? read.raw : undefined;
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
