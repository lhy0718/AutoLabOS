import path from "node:path";
import { promises as fs } from "node:fs";

import {
  evaluateEstimatorFeasibility,
  validateEstimatorFeasibilityContract,
  validateEstimatorFeasibilityReport,
  type EstimatorFeasibilityContract,
  type EstimatorFeasibilityReport
} from "./estimatorFeasibility.js";
import { buildEstimatorFeasibilityContractFromProtocol } from "./estimatorProtocol.js";
import {
  validateActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "./activeTopicProbeContract.js";
import { hashCanonical } from "./canonicalHash.js";
import {
  validateExperimentContract,
  type ExperimentContract
} from "./experiments/experimentContract.js";
import { ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH } from "./topicProbeOutcomeArtifacts.js";

export const ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH =
  "design_experiments_panel/estimator_feasibility_contract.json";
export const ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH =
  "design_experiments_panel/estimator_feasibility_report.json";
export const ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH =
  "design_experiments_panel/candidate_experiment_contract.json";

export interface EstimatorFeasibilityArtifacts {
  contract: EstimatorFeasibilityContract;
  report: EstimatorFeasibilityReport;
}

export interface PersistedEstimatorFeasibilityGate {
  measured: boolean;
  valid: boolean;
  status: "pass" | "blocked";
  reasons: string[];
  active_probe?: ActiveTopicProbeContract;
  experiment_contract?: ExperimentContract;
  estimator_contract?: EstimatorFeasibilityContract;
  estimator_report?: EstimatorFeasibilityReport;
}

export interface PersistedEstimatorFeasibilityAudit {
  measured: boolean;
  trusted: boolean;
  status: "unmeasured" | "pass" | "blocked" | "invalid";
  execution_authorized: boolean;
  reason_codes: string[];
  active_probe?: ActiveTopicProbeContract;
  candidate_experiment_contract?: ExperimentContract;
  executable_experiment_contract?: ExperimentContract;
  estimator_contract?: EstimatorFeasibilityContract;
  estimator_report?: EstimatorFeasibilityReport;
}

export function buildEstimatorFeasibilityArtifacts(input: {
  runId: string;
  activeProbeSha256: string;
  experimentContract: ExperimentContract;
  estimatorProtocol: unknown;
}): EstimatorFeasibilityArtifacts {
  if (input.experimentContract.run_id !== input.runId) {
    throw new Error("estimator_feasibility_experiment_run_binding_mismatch");
  }
  const experimentContractSha256 = hashCanonical(input.experimentContract);
  const bindingContext = {
    expectedRunId: input.runId,
    expectedActiveProbeSha256: input.activeProbeSha256,
    expectedExperimentContractSha256: experimentContractSha256
  };
  const contract = buildEstimatorFeasibilityContractFromProtocol({
    protocol: input.estimatorProtocol,
    bindings: {
      run_id: input.runId,
      active_probe_sha256: input.activeProbeSha256,
      experiment_contract_sha256: experimentContractSha256
    }
  });
  const contractValidation = validateEstimatorFeasibilityContract(
    contract,
    bindingContext
  );
  if (!contractValidation.valid) {
    throw new Error(
      `estimator_feasibility_contract_invalid:${contractValidation.reasons.join(",")}`
    );
  }
  const report = evaluateEstimatorFeasibility(contract, bindingContext);
  const reportValidation = validateEstimatorFeasibilityReport(
    report,
    contract,
    bindingContext
  );
  if (!reportValidation.valid) {
    throw new Error(
      `estimator_feasibility_report_invalid:${reportValidation.reasons.join(",")}`
    );
  }
  return { contract, report };
}

export async function validatePersistedEstimatorFeasibilityGate(input: {
  workspaceRoot: string;
  runId: string;
  expectedResearchCycle?: number;
}): Promise<PersistedEstimatorFeasibilityGate> {
  const runDir = path.join(input.workspaceRoot, ".autolabos", "runs", input.runId);
  const [activeProbeRaw, experimentRaw, estimatorContractRaw, estimatorReportRaw] =
    await Promise.all([
      readOptionalText(path.join(runDir, ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH)),
      readOptionalText(path.join(runDir, "experiment_contract.json")),
      readOptionalText(path.join(runDir, ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH)),
      readOptionalText(path.join(runDir, ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH))
    ]);
  const measured = Boolean(
    activeProbeRaw || experimentRaw || estimatorContractRaw || estimatorReportRaw
  );
  const reasons: string[] = [];

  if (!activeProbeRaw) reasons.push("estimator_gate_active_probe_missing");
  if (!experimentRaw) reasons.push("estimator_gate_experiment_contract_missing");
  if (!estimatorContractRaw) reasons.push("estimator_gate_contract_missing");
  if (!estimatorReportRaw) reasons.push("estimator_gate_report_missing");

  const activeProbeValidation = activeProbeRaw
    ? validateActiveTopicProbeContract(activeProbeRaw, {
        expectedRunId: input.runId,
        expectedResearchCycle: input.expectedResearchCycle
      })
    : undefined;
  const activeProbe = activeProbeValidation?.valid
    ? activeProbeValidation.contract
    : undefined;
  if (activeProbeValidation && !activeProbeValidation.valid) {
    reasons.push(
      ...activeProbeValidation.reasons.map(
        (reason) => `estimator_gate_active_probe_invalid:${reason}`
      )
    );
  }

  const experimentContract = parseExperimentContract(experimentRaw);
  if (experimentRaw && !experimentContract) {
    reasons.push("estimator_gate_experiment_contract_invalid");
  } else if (experimentContract) {
    if (experimentContract.run_id !== input.runId) {
      reasons.push("estimator_gate_experiment_run_binding_mismatch");
    }
    const experimentValidation = validateExperimentContract(experimentContract);
    if (!experimentValidation.valid) {
      reasons.push(
        ...experimentValidation.issues.map(
          (issue) => `estimator_gate_experiment_contract_issue:${normalizeReason(issue)}`
        )
      );
    }
  }

  const estimatorContract = parseJson<EstimatorFeasibilityContract>(
    estimatorContractRaw
  );
  const estimatorReport = parseJson<EstimatorFeasibilityReport>(estimatorReportRaw);
  if (estimatorContractRaw && !estimatorContract) {
    reasons.push("estimator_gate_contract_invalid_json");
  }
  if (estimatorReportRaw && !estimatorReport) {
    reasons.push("estimator_gate_report_invalid_json");
  }

  if (activeProbe && experimentContract && estimatorContract) {
    const bindingContext = {
      expectedRunId: input.runId,
      expectedActiveProbeSha256: activeProbe.content_sha256,
      expectedExperimentContractSha256: hashCanonical(experimentContract)
    };
    const contractValidation = validateEstimatorFeasibilityContract(
      estimatorContract,
      bindingContext
    );
    if (!contractValidation.valid) {
      reasons.push(
        ...contractValidation.reasons.map(
          (reason) => `estimator_gate_contract_invalid:${reason}`
        )
      );
    }
    if (estimatorReport) {
      const reportValidation = validateEstimatorFeasibilityReport(
        estimatorReport,
        estimatorContract,
        bindingContext
      );
      if (!reportValidation.valid) {
        reasons.push(
          ...reportValidation.reasons.map(
            (reason) => `estimator_gate_report_invalid:${reason}`
          )
        );
      }
    }
  }
  if (estimatorReport?.status === "blocked") {
    reasons.push(
      ...estimatorReport.reason_codes.map(
        (reason) => `estimator_gate_feasibility_blocked:${reason}`
      )
    );
  } else if (estimatorReport && estimatorReport.status !== "pass") {
    reasons.push("estimator_gate_report_status_invalid");
  }

  return {
    measured,
    valid: reasons.length === 0,
    status: reasons.length === 0 ? "pass" : "blocked",
    reasons: uniqueStrings(reasons),
    ...(activeProbe ? { active_probe: activeProbe } : {}),
    ...(experimentContract ? { experiment_contract: experimentContract } : {}),
    ...(estimatorContract ? { estimator_contract: estimatorContract } : {}),
    ...(estimatorReport ? { estimator_report: estimatorReport } : {})
  };
}

export async function loadPersistedEstimatorFeasibilityAudit(input: {
  runDir: string;
  runId: string;
  expectedResearchCycle?: number;
}): Promise<PersistedEstimatorFeasibilityAudit> {
  const [
    activeProbeRaw,
    candidateExperimentRaw,
    executableExperimentRaw,
    estimatorContractRaw,
    estimatorReportRaw
  ] = await Promise.all([
    readOptionalText(path.join(input.runDir, ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH)),
    readOptionalText(path.join(
      input.runDir,
      ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH
    )),
    readOptionalText(path.join(input.runDir, "experiment_contract.json")),
    readOptionalText(path.join(input.runDir, ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH)),
    readOptionalText(path.join(input.runDir, ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH))
  ]);
  const measured = Boolean(
    candidateExperimentRaw
    || executableExperimentRaw
    || estimatorContractRaw
    || estimatorReportRaw
  );
  if (!measured) {
    return {
      measured: false,
      trusted: false,
      status: "unmeasured",
      execution_authorized: false,
      reason_codes: []
    };
  }

  const artifactReasons: string[] = [];
  const activeProbeValidation = activeProbeRaw
    ? validateActiveTopicProbeContract(activeProbeRaw, {
        expectedRunId: input.runId,
        expectedResearchCycle: input.expectedResearchCycle
      })
    : undefined;
  const activeProbe = activeProbeValidation?.valid
    ? activeProbeValidation.contract
    : undefined;
  if (!activeProbeRaw) {
    artifactReasons.push("estimator_audit_active_probe_missing");
  } else if (!activeProbeValidation?.valid) {
    artifactReasons.push(
      ...(activeProbeValidation?.reasons ?? ["schema_invalid"]).map(
        (reason) => `estimator_audit_active_probe_invalid:${reason}`
      )
    );
  }

  const candidateExperiment = parseExperimentContract(candidateExperimentRaw);
  const executableExperiment = parseExperimentContract(executableExperimentRaw);
  if (candidateExperimentRaw && !candidateExperiment) {
    artifactReasons.push("estimator_audit_candidate_experiment_invalid_json");
  }
  if (executableExperimentRaw && !executableExperiment) {
    artifactReasons.push("estimator_audit_executable_experiment_invalid_json");
  }
  const evaluatedExperiment = candidateExperiment ?? executableExperiment;
  if (!evaluatedExperiment) {
    artifactReasons.push("estimator_audit_experiment_contract_missing");
  } else {
    if (evaluatedExperiment.run_id !== input.runId) {
      artifactReasons.push("estimator_audit_experiment_run_binding_mismatch");
    }
    const validation = validateExperimentContract(evaluatedExperiment);
    artifactReasons.push(
      ...validation.issues.map(
        (issue) => `estimator_audit_experiment_contract_issue:${normalizeReason(issue)}`
      )
    );
  }
  if (
    candidateExperiment
    && executableExperiment
    && hashCanonical(candidateExperiment) !== hashCanonical(executableExperiment)
  ) {
    artifactReasons.push("estimator_audit_candidate_promotion_mismatch");
  }

  const estimatorContract = parseJson<EstimatorFeasibilityContract>(
    estimatorContractRaw
  );
  const estimatorReport = parseJson<EstimatorFeasibilityReport>(estimatorReportRaw);
  if (!estimatorContractRaw) {
    artifactReasons.push("estimator_audit_contract_missing");
  } else if (!estimatorContract) {
    artifactReasons.push("estimator_audit_contract_invalid_json");
  }
  if (!estimatorReportRaw) {
    artifactReasons.push("estimator_audit_report_missing");
  } else if (!estimatorReport) {
    artifactReasons.push("estimator_audit_report_invalid_json");
  }

  if (activeProbe && evaluatedExperiment && estimatorContract) {
    const bindingContext = {
      expectedRunId: input.runId,
      expectedActiveProbeSha256: activeProbe.content_sha256,
      expectedExperimentContractSha256: hashCanonical(evaluatedExperiment)
    };
    const contractValidation = validateEstimatorFeasibilityContract(
      estimatorContract,
      bindingContext
    );
    if (!contractValidation.valid) {
      artifactReasons.push(
        ...contractValidation.reasons.map(
          (reason) => `estimator_audit_contract_invalid:${reason}`
        )
      );
    }
    if (estimatorReport) {
      const reportValidation = validateEstimatorFeasibilityReport(
        estimatorReport,
        estimatorContract,
        bindingContext
      );
      if (!reportValidation.valid) {
        artifactReasons.push(
          ...reportValidation.reasons.map(
            (reason) => `estimator_audit_report_invalid:${reason}`
          )
        );
      }
    }
  }

  const trusted = artifactReasons.length === 0;
  const status = !trusted
    ? "invalid"
    : estimatorReport?.status ?? "invalid";
  const executableMatchesEvaluation = Boolean(
    executableExperiment
    && evaluatedExperiment
    && hashCanonical(executableExperiment) === hashCanonical(evaluatedExperiment)
  );
  return {
    measured: true,
    trusted,
    status,
    execution_authorized:
      trusted && status === "pass" && executableMatchesEvaluation,
    reason_codes: uniqueStrings([
      ...artifactReasons,
      ...(estimatorReport?.reason_codes ?? [])
    ]),
    ...(activeProbe ? { active_probe: activeProbe } : {}),
    ...(candidateExperiment
      ? { candidate_experiment_contract: candidateExperiment }
      : {}),
    ...(executableExperiment
      ? { executable_experiment_contract: executableExperiment }
      : {}),
    ...(estimatorContract ? { estimator_contract: estimatorContract } : {}),
    ...(estimatorReport ? { estimator_report: estimatorReport } : {})
  };
}

function parseExperimentContract(raw: string | undefined): ExperimentContract | undefined {
  const value = parseJson<ExperimentContract>(raw);
  if (
    !value
    || value.version !== 2
    || typeof value.run_id !== "string"
    || typeof value.hypothesis !== "string"
  ) {
    return undefined;
  }
  return value;
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as T
      : undefined;
  } catch {
    return undefined;
  }
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function normalizeReason(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}
