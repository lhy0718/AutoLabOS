import path from "node:path";
import { promises as fs } from "node:fs";

import { hashCanonical } from "../../src/core/canonicalHash.js";
import { reassessEvidenceAdequacyArtifacts } from "../../src/core/analysis/evidenceAdequacyArtifacts.js";
import {
  buildModelReviewGateBinding,
  buildReviewGateReport,
  buildReviewHandoff,
  buildReviewInputManifest,
  buildReviewInputManifestBinding,
  REVIEW_ASSURANCE_RELATIVE_PATH,
  REVIEW_GATE_REPORT_RELATIVE_PATH,
  REVIEW_HANDOFF_RELATIVE_PATH,
  REVIEW_INPUT_MANIFEST_RELATIVE_PATH,
  REVIEW_INPUT_SNAPSHOT_RELATIVE_PATH,
  serializeReviewGateReport,
  serializeReviewHandoff,
  serializeReviewInputManifest
} from "../../src/core/reviewInputManifest.js";
import type { RunRecord } from "../../src/types.js";

export async function seedValidNonIndependentReviewAssurance(input: {
  workspaceRoot: string;
  run: RunRecord;
}): Promise<void> {
  const runDir = path.join(
    input.workspaceRoot,
    ".autolabos",
    "runs",
    input.run.id
  );
  await fs.mkdir(path.join(runDir, "review"), { recursive: true });
  await fs.mkdir(path.join(runDir, "governance"), { recursive: true });

  const expectedPrimaryComparisonId = await readPrimaryComparisonId(runDir);
  const evidenceReassessment = await reassessEvidenceAdequacyArtifacts({
    runDir,
    evidenceRoots: [runDir],
    expectedPrimaryComparisonId,
    requireStoredAssessment: true
  });
  const evidenceTrusted =
    evidenceReassessment.integrityValid
    && Boolean(evidenceReassessment.assessment);
  const evidencePassed =
    evidenceTrusted
    && evidenceReassessment.assessment?.passed === true;
  const reviewEvidenceArtifact = {
    schema_version: 1,
    artifact_kind: "review_evidence_adequacy_reassessment",
    status: evidencePassed
      ? "pass"
      : evidenceTrusted
        ? evidenceReassessment.assessment?.overall_status || "blocked"
        : evidenceReassessment.contractPresent
          ? "invalid"
          : "missing_contract",
    trusted: evidenceTrusted,
    paper_evidence_allowed: evidencePassed,
    integrity_valid: evidenceReassessment.integrityValid,
    contract_present: evidenceReassessment.contractPresent,
    receipt_present: evidenceReassessment.receiptPresent,
    stored_assessment_present: evidenceReassessment.storedAssessmentPresent,
    primary_comparison_id: evidenceReassessment.assessment?.primary_comparison_id ?? null,
    overall_status: evidenceReassessment.assessment?.overall_status ?? null,
    issues: evidenceReassessment.issues,
    warnings: evidenceReassessment.warnings
  };
  const requiredArtifacts: Array<[string, unknown]> = [
    ["result_analysis.json", { overview: { objective_status: "unknown" } }],
    [REVIEW_INPUT_SNAPSHOT_RELATIVE_PATH, {
      schema_version: 1,
      artifact_kind: "review_input_snapshot",
      resolved_inputs: []
    }],
    ["review/minimum_gate.json", {
      passed: false,
      ceiling_type: "research_memo"
    }],
    ["review/evidence_adequacy_reassessment.json", reviewEvidenceArtifact],
    ["review/pre_review_summary.json", {
      summary: "Bound review inputs."
    }],
    ["review/paper_critique.json", {
      stage: "pre_draft_review",
      manuscript_type: "paper_scale_candidate",
      overall_decision: "advance"
    }],
    ["review/decision.json", {
      outcome: "advance",
      recommended_transition: "write_paper"
    }],
    ["review/review_packet.json", {
      readiness: { status: "ready" },
      decision: { outcome: "advance" }
    }],
    ["governance/research_mode_guard.json", {
      valid: true,
      effective_mode: "hypothesis_test"
    }]
  ];
  for (const [relativePath, value] of requiredArtifacts) {
    await writeJsonIfMissing(path.join(runDir, relativePath), value);
  }

  const manifest = await buildReviewInputManifest({
    runDir,
    runId: input.run.id,
    researchCycle: input.run.graph.researchCycle,
    checkpointSeq: input.run.graph.checkpointSeq
  });
  const manifestBytes = serializeReviewInputManifest(manifest);
  await fs.writeFile(
    path.join(runDir, REVIEW_INPUT_MANIFEST_RELATIVE_PATH),
    manifestBytes,
    "utf8"
  );

  const gateReport = await buildReviewGateReport({
    runDir,
    runId: input.run.id
  });
  const gateReportBytes = serializeReviewGateReport(gateReport);
  await fs.writeFile(
    path.join(runDir, REVIEW_GATE_REPORT_RELATIVE_PATH),
    gateReportBytes,
    "utf8"
  );

  const assurancePayload = {
    schema_version: 1,
    required_for_paper_ready: false,
    paper_ready_eligible: false,
    model_review_bundle_valid: false,
    model_review_bundle_content_sha256: null,
    gate_report_content_sha256:
      buildModelReviewGateBinding(gateReportBytes).sha256,
    review_input_manifest_content_sha256:
      buildReviewInputManifestBinding(manifestBytes).sha256
  };
  await fs.writeFile(
    path.join(runDir, REVIEW_ASSURANCE_RELATIVE_PATH),
    `${JSON.stringify({
      ...assurancePayload,
      content_sha256: hashCanonical(assurancePayload)
    }, null, 2)}\n`,
    "utf8"
  );

  const handoff = await buildReviewHandoff({ runDir, runId: input.run.id });
  await fs.writeFile(
    path.join(runDir, REVIEW_HANDOFF_RELATIVE_PATH),
    serializeReviewHandoff(handoff),
    "utf8"
  );
}

async function writeJsonIfMissing(
  filePath: string,
  value: unknown
): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8"
    );
  }
}

async function readPrimaryComparisonId(runDir: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(runDir, "experiment_contract.json"), "utf8")
    ) as {
      results_plan?: {
        primary_comparison_id?: unknown;
      };
    };
    const candidate = value.results_plan?.primary_comparison_id;
    return typeof candidate === "string" && candidate.trim()
      ? candidate.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
