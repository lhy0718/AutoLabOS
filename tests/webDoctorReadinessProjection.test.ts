import { describe, expect, it } from "vitest";

import { projectDoctorReadinessForApi } from "../src/web/doctorProjection.js";

describe("Web Doctor readiness projection", () => {
  it("preserves backend, PDF, isolation, approval, and network readiness", () => {
    const projected = projectDoctorReadinessForApi({
      generatedAt: "2026-01-01T00:00:00.000Z",
      workspaceRoot: "/workspace",
      workspaceProbePath: "/workspace/.probe",
      blocked: false,
      llmMode: "codex_chatgpt_only",
      pdfAnalysisMode: "codex_text_image_hybrid",
      approvalMode: "manual",
      executionApprovalMode: "risk_ack",
      dependencyMode: "local",
      sessionMode: "existing",
      candidateIsolation: "attempt_snapshot_restore",
      networkPolicy: "declared",
      networkPurpose: "model_download",
      networkDeclarationPresent: true,
      networkApprovalSatisfied: true,
      containerizationRequired: false,
      webRestrictionRequired: true,
      manualOverride: false,
      warningChecks: ["experiment-web-restriction"],
      failedChecks: []
    });

    expect(projected).toEqual({
      blocked: false,
      llmMode: "codex_chatgpt_only",
      pdfAnalysisMode: "codex_text_image_hybrid",
      approvalMode: "manual",
      executionApprovalMode: "risk_ack",
      dependencyMode: "local",
      sessionMode: "existing",
      candidateIsolation: "attempt_snapshot_restore",
      networkPolicy: "declared",
      networkPurpose: "model_download",
      networkDeclarationPresent: true,
      networkApprovalSatisfied: true,
      warningChecks: ["experiment-web-restriction"],
      failedChecks: []
    });
  });
});
