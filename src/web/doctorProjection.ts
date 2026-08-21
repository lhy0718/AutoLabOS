import type { DoctorReadinessSnapshot } from "../core/doctor.js";
import type { DoctorResponse } from "./contracts.js";

export function projectDoctorReadinessForApi(
  readiness: DoctorReadinessSnapshot
): NonNullable<DoctorResponse["readiness"]> {
  return {
    blocked: readiness.blocked,
    llmMode: readiness.llmMode,
    pdfAnalysisMode: readiness.pdfAnalysisMode,
    approvalMode: readiness.approvalMode,
    executionApprovalMode: readiness.executionApprovalMode,
    dependencyMode: readiness.dependencyMode,
    sessionMode: readiness.sessionMode,
    candidateIsolation: readiness.candidateIsolation,
    networkPolicy: readiness.networkPolicy,
    networkPurpose: readiness.networkPurpose,
    networkDeclarationPresent: readiness.networkDeclarationPresent,
    networkApprovalSatisfied: readiness.networkApprovalSatisfied,
    warningChecks: [...readiness.warningChecks],
    failedChecks: [...readiness.failedChecks]
  };
}
