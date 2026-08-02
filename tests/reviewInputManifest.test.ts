import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { hashCanonical } from "../src/core/canonicalHash.js";
import {
  buildModelReviewGateBinding,
  buildReviewGateReport,
  buildReviewHandoff,
  buildReviewInputManifest,
  buildReviewInputManifestBinding,
  inspectReviewAssuranceArtifacts,
  REVIEW_ASSURANCE_RELATIVE_PATH,
  REVIEW_GATE_REPORT_RELATIVE_PATH,
  REVIEW_HANDOFF_RELATIVE_PATH,
  REVIEW_INPUT_MANIFEST_RELATIVE_PATH,
  REVIEW_INPUT_SNAPSHOT_RELATIVE_PATH,
  serializeReviewGateReport,
  serializeReviewHandoff,
  serializeReviewInputManifest,
  validateReviewInputManifestAtRest
} from "../src/core/reviewInputManifest.js";

let workspaceRoot: string;

afterEach(async () => {
  if (workspaceRoot) {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

describe("review input manifest", () => {
  it("fails closed before model review when a required input is absent", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-review-manifest-missing-"));
    const runId = "run-review-manifest-missing";
    const runDir = path.join(workspaceRoot, ".autolabos", "runs", runId);
    await fs.mkdir(path.join(runDir, "review"), { recursive: true });
    await fs.writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify({ overview: { objective_status: "unknown" } }),
      "utf8"
    );
    const manifest = await buildReviewInputManifest({
      runDir,
      runId,
      researchCycle: 0,
      checkpointSeq: 0
    });
    await fs.writeFile(
      path.join(runDir, REVIEW_INPUT_MANIFEST_RELATIVE_PATH),
      serializeReviewInputManifest(manifest),
      "utf8"
    );

    const validation = await validateReviewInputManifestAtRest({
      runDir,
      runId,
      researchCycle: 0,
      checkpointSeq: 0
    });

    expect(validation.valid).toBe(false);
    expect(validation.reason_codes).toContain(
      "review_input_required_missing:review/review_input_snapshot.json"
    );
  });

  it("accepts a closed manifest and invalidates it when a bound input changes", async () => {
    const fixture = await seedReviewAssuranceFixture();

    const valid = await inspectReviewAssuranceArtifacts({
      runDir: fixture.runDir,
      runId: fixture.runId,
      researchCycle: 2,
      checkpointSeq: 7
    });
    expect(valid).toMatchObject({
      status: "valid",
      trusted: true,
      paper_ready_eligible: true,
      input_manifest_valid: true,
      gate_report_valid: true,
      assurance_valid: true,
      handoff_valid: true,
      required_for_paper_ready: false,
      reason_codes: []
    });

    await fs.writeFile(
      path.join(fixture.runDir, "result_analysis.json"),
      JSON.stringify({ status: "changed-after-review" }),
      "utf8"
    );
    const tampered = await inspectReviewAssuranceArtifacts({
      runDir: fixture.runDir,
      runId: fixture.runId,
      researchCycle: 2,
      checkpointSeq: 7
    });
    expect(tampered).toMatchObject({
      status: "invalid",
      trusted: false,
      paper_ready_eligible: false,
      input_manifest_valid: false
    });
    expect(tampered.reason_codes).toContain(
      "review_input_changed:result_analysis.json"
    );
  });

  it("invalidates the review handoff when a bound critique changes", async () => {
    const fixture = await seedReviewAssuranceFixture();

    await fs.writeFile(
      path.join(fixture.runDir, "review", "paper_critique.json"),
      JSON.stringify({ overall_decision: "changed-after-review" }),
      "utf8"
    );
    const inspection = await inspectReviewAssuranceArtifacts({
      runDir: fixture.runDir,
      runId: fixture.runId,
      researchCycle: 2,
      checkpointSeq: 7
    });

    expect(inspection).toMatchObject({
      status: "invalid",
      trusted: false,
      paper_ready_eligible: false,
      handoff_valid: false
    });
    expect(inspection.reason_codes).toContain(
      "review_handoff_paper_critique_binding_mismatch"
    );
  });

  it("invalidates a closed manifest when a previously absent governed input appears", async () => {
    const fixture = await seedReviewAssuranceFixture();

    await fs.writeFile(
      path.join(fixture.runDir, "metrics.json"),
      JSON.stringify({ primary_measure: 1 }),
      "utf8"
    );
    const inspection = await inspectReviewAssuranceArtifacts({
      runDir: fixture.runDir,
      runId: fixture.runId,
      researchCycle: 2,
      checkpointSeq: 7
    });

    expect(inspection.status).toBe("invalid");
    expect(inspection.reason_codes).toContain(
      "review_input_newly_present:metrics.json"
    );
  });

  it("invalidates the gate report when deterministic gate bytes change", async () => {
    const fixture = await seedReviewAssuranceFixture();

    await fs.writeFile(
      path.join(fixture.runDir, "review", "minimum_gate.json"),
      JSON.stringify({ passed: true, changed_after_review: true }),
      "utf8"
    );
    const inspection = await inspectReviewAssuranceArtifacts({
      runDir: fixture.runDir,
      runId: fixture.runId,
      researchCycle: 2,
      checkpointSeq: 7
    });

    expect(inspection.status).toBe("invalid");
    expect(inspection.reason_codes).toEqual(
      expect.arrayContaining([
        "review_input_changed:review/minimum_gate.json",
        "review_gate_report_minimum_gate_binding_mismatch"
      ])
    );
  });

  it.each([
    [
      REVIEW_GATE_REPORT_RELATIVE_PATH,
      "gate_report_valid",
      "review_gate_report_content_hash_mismatch"
    ],
    [
      REVIEW_ASSURANCE_RELATIVE_PATH,
      "assurance_valid",
      "review_assurance_content_hash_mismatch"
    ],
    [
      REVIEW_HANDOFF_RELATIVE_PATH,
      "handoff_valid",
      "review_handoff_content_hash_mismatch"
    ]
  ] as const)(
    "marks %s invalid when its self-hash changes",
    async (relativePath, validityField, reasonCode) => {
      const fixture = await seedReviewAssuranceFixture();
      const artifactPath = path.join(fixture.runDir, relativePath);
      const artifact = JSON.parse(
        await fs.readFile(artifactPath, "utf8")
      ) as Record<string, unknown>;
      artifact.content_sha256 = "0".repeat(64);
      await fs.writeFile(
        artifactPath,
        `${JSON.stringify(artifact, null, 2)}\n`,
        "utf8"
      );

      const inspection = await inspectReviewAssuranceArtifacts({
        runDir: fixture.runDir,
        runId: fixture.runId,
        researchCycle: 2
      });

      expect(inspection.status).toBe("invalid");
      expect(inspection[validityField]).toBe(false);
      expect(inspection.reason_codes).toContain(reasonCode);
    }
  );
});

async function seedReviewAssuranceFixture(): Promise<{
  runDir: string;
  runId: string;
}> {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-review-manifest-"));
  const runId = "run-review-manifest";
  const runDir = path.join(workspaceRoot, ".autolabos", "runs", runId);
  await fs.mkdir(path.join(runDir, "review"), { recursive: true });
  await fs.mkdir(path.join(runDir, "governance"), { recursive: true });

  const requiredArtifacts: Array<[string, unknown]> = [
    ["result_analysis.json", { overview: { objective_status: "unknown" } }],
    [REVIEW_INPUT_SNAPSHOT_RELATIVE_PATH, {
      schema_version: 1,
      artifact_kind: "review_input_snapshot",
      resolved_inputs: []
    }],
    ["review/minimum_gate.json", { passed: false, ceiling_type: "research_memo" }],
    ["review/evidence_adequacy_reassessment.json", {
      status: "unknown",
      trusted: false
    }],
    ["review/pre_review_summary.json", { summary: "Bound review inputs." }],
    ["review/paper_critique.json", {
      stage: "pre_draft_review",
      manuscript_type: "paper_scale_candidate",
      overall_decision: "advance"
    }],
    ["review/decision.json", { outcome: "advance" }],
    ["review/review_packet.json", { readiness: { status: "ready" } }],
    ["governance/research_mode_guard.json", {
      valid: true,
      effective_mode: "hypothesis_test"
    }]
  ];
  for (const [relativePath, value] of requiredArtifacts) {
    await fs.writeFile(
      path.join(runDir, relativePath),
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8"
    );
  }

  const manifest = await buildReviewInputManifest({
    runDir,
    runId,
    researchCycle: 2,
    checkpointSeq: 7
  });
  const manifestBytes = serializeReviewInputManifest(manifest);
  await fs.writeFile(
    path.join(runDir, REVIEW_INPUT_MANIFEST_RELATIVE_PATH),
    manifestBytes,
    "utf8"
  );

  const gateReport = await buildReviewGateReport({ runDir, runId });
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
    gate_report_content_sha256: buildModelReviewGateBinding(gateReportBytes).sha256,
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

  const handoff = await buildReviewHandoff({ runDir, runId });
  await fs.writeFile(
    path.join(runDir, REVIEW_HANDOFF_RELATIVE_PATH),
    serializeReviewHandoff(handoff),
    "utf8"
  );

  return { runDir, runId };
}
