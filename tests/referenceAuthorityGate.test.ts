import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { inspectReferenceAuthorityGate } from "../src/core/referenceAuthorityGate.js";

const HEADER = [
  "claim_id",
  "manuscript_location",
  "claim_text",
  "citation_key",
  "source_location",
  "quote_or_evidence",
  "evidence_kind",
  "status",
  "notes",
  "claim_type",
  "importance"
].join("\t");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("reference authority gate", () => {
  it("passes only when authoritative status and checked inventory agree", async () => {
    const root = await createPaperDir();
    await writeStatus(root, {
      schema_version: "1.0",
      submission_gate_passed: true,
      summary: {
        citation_bearing_claim_count: 2,
        independently_checked_claim_count: 2,
        missing_full_text_claim_count: 0
      },
      blocking_requirements: []
    });
    await fs.writeFile(
      path.join(root, "refgate_claims.tsv"),
      [HEADER, claimRow("claim-alpha", "checked"), claimRow("claim-beta", "checked"), ""].join("\n"),
      "utf8"
    );
    const publicKey = await writeAuthorityReceipt(root, 2);

    await expect(inspectReferenceAuthorityGate(root, {
      trusted_public_keys: { "fixture-key": publicKey }
    })).resolves.toMatchObject({
      status: "pass",
      submission_gate_passed: true,
      citation_bearing_claim_count: 2,
      independently_checked_claim_count: 2,
      inventory_claim_count: 2,
      unchecked_claim_count: 0,
      blocking_requirement_count: 0,
      human_authority_valid: true,
      human_authority_artifacts_bound: true,
      human_identity_verification_valid: true
    });
  });

  it("rejects self-authored or explicitly unverified identity claims", async () => {
    const root = await createPaperDir();
    await writeStatus(root, {
      schema_version: "1.0",
      submission_gate_passed: true,
      summary: {
        citation_bearing_claim_count: 1,
        independently_checked_claim_count: 1,
        missing_full_text_claim_count: 0
      },
      blocking_requirements: []
    });
    await fs.writeFile(
      path.join(root, "refgate_claims.tsv"),
      [HEADER, claimRow("claim-alpha", "checked"), ""].join("\n"),
      "utf8"
    );
    const publicKey = await writeAuthorityReceipt(root, 1, false);

    const gate = await inspectReferenceAuthorityGate(root, {
      trusted_public_keys: { "fixture-key": publicKey }
    });
    expect(gate).toMatchObject({
      status: "fail",
      human_authority_valid: false,
      human_identity_verification_valid: false
    });
    expect(gate.reason).toContain("trusted external signature");
  });

  it("rejects an identity signature from a key outside the trust root", async () => {
    const root = await createPaperDir();
    await writeStatus(root, {
      schema_version: "1.0",
      submission_gate_passed: true,
      summary: {
        citation_bearing_claim_count: 1,
        independently_checked_claim_count: 1,
        missing_full_text_claim_count: 0
      },
      blocking_requirements: []
    });
    await fs.writeFile(
      path.join(root, "refgate_claims.tsv"),
      [HEADER, claimRow("claim-alpha", "checked"), ""].join("\n"),
      "utf8"
    );
    await writeAuthorityReceipt(root, 1);
    const unrelated = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem"
    }).toString();

    const gate = await inspectReferenceAuthorityGate(root, {
      trusted_public_keys: { "fixture-key": unrelated }
    });
    expect(gate.human_identity_verification_valid).toBe(false);
    expect(gate.status).toBe("fail");
  });

  it("fails closed when a bound human authority artifact changes after import", async () => {
    const root = await createPaperDir();
    await writeStatus(root, {
      schema_version: "1.0",
      submission_gate_passed: true,
      summary: {
        citation_bearing_claim_count: 1,
        independently_checked_claim_count: 1,
        missing_full_text_claim_count: 0
      },
      blocking_requirements: []
    });
    await fs.writeFile(
      path.join(root, "refgate_claims.tsv"),
      [HEADER, claimRow("claim-alpha", "checked"), ""].join("\n"),
      "utf8"
    );
    await writeAuthorityReceipt(root, 1);
    await fs.appendFile(
      path.join(root, "reference-authority-evidence", "completed-review.json"),
      " ",
      "utf8"
    );

    const gate = await inspectReferenceAuthorityGate(root);
    expect(gate).toMatchObject({
      status: "fail",
      human_authority_valid: false,
      human_authority_artifacts_bound: false
    });
    expect(gate.reason).toContain("human reference-review import receipt is invalid");
  });

  it("rejects a self-asserted pass without a separate human authority receipt", async () => {
    const root = await createPaperDir();
    await writeStatus(root, {
      schema_version: "1.0",
      submission_gate_passed: true,
      summary: {
        citation_bearing_claim_count: 1,
        independently_checked_claim_count: 1,
        missing_full_text_claim_count: 0
      },
      blocking_requirements: []
    });
    await fs.writeFile(
      path.join(root, "refgate_claims.tsv"),
      [HEADER, claimRow("claim-alpha", "checked"), ""].join("\n"),
      "utf8"
    );

    const gate = await inspectReferenceAuthorityGate(root);
    expect(gate.status).toBe("fail");
    expect(gate.human_authority_required).toBe(true);
    expect(gate.human_authority_present).toBe(false);
    expect(gate.reason).toContain("human reference-review import receipt is missing");
  });

  it("fails closed when a claim remains unchecked despite a claimed status pass", async () => {
    const root = await createPaperDir();
    await writeStatus(root, {
      schema_version: "1.0",
      submission_gate_passed: true,
      summary: {
        citation_bearing_claim_count: 2,
        independently_checked_claim_count: 2,
        missing_full_text_claim_count: 0
      },
      blocking_requirements: []
    });
    await fs.writeFile(
      path.join(root, "refgate_claims.tsv"),
      [HEADER, claimRow("claim-alpha", "checked"), claimRow("claim-beta", "needs_review"), ""].join("\n"),
      "utf8"
    );

    const gate = await inspectReferenceAuthorityGate(root);
    expect(gate.status).toBe("fail");
    expect(gate.reason).toContain("1 Refgate claim(s) remain unchecked");
  });

  it("fails closed when authoritative artifacts are absent", async () => {
    const root = await createPaperDir();
    const gate = await inspectReferenceAuthorityGate(root);
    expect(gate).toMatchObject({ status: "fail", status_present: false, claims_present: false });
  });

  it("accepts an explicit empty inventory for a manuscript without citations", async () => {
    const root = await createPaperDir();
    await writeStatus(root, {
      schema_version: "1.0",
      submission_gate_passed: true,
      summary: {
        citation_bearing_claim_count: 0,
        independently_checked_claim_count: 0,
        missing_full_text_claim_count: 0
      },
      blocking_requirements: []
    });
    await fs.writeFile(path.join(root, "refgate_claims.tsv"), `${HEADER}\n`, "utf8");

    await expect(inspectReferenceAuthorityGate(root)).resolves.toMatchObject({
      status: "pass",
      inventory_claim_count: 0,
      manuscript_bound: true
    });
  });

  it("fails closed when the final manuscript changes after authority was recorded", async () => {
    const root = await createPaperDir();
    await writeStatus(root, {
      schema_version: "1.0",
      submission_gate_passed: true,
      summary: {
        citation_bearing_claim_count: 0,
        independently_checked_claim_count: 0,
        missing_full_text_claim_count: 0
      },
      blocking_requirements: []
    });
    await fs.writeFile(path.join(root, "refgate_claims.tsv"), `${HEADER}\n`, "utf8");
    await fs.appendFile(path.join(root, "main.tex"), "Changed after review.\n", "utf8");

    const gate = await inspectReferenceAuthorityGate(root);
    expect(gate.status).toBe("fail");
    expect(gate.manuscript_bound).toBe(false);
    expect(gate.reason).toContain("final manuscript hash does not match");
  });

  it("fails closed when blocking requirements are omitted", async () => {
    const root = await createPaperDir();
    await writeStatus(root, {
      schema_version: "1.0",
      submission_gate_passed: true,
      summary: {
        citation_bearing_claim_count: 0,
        independently_checked_claim_count: 0,
        missing_full_text_claim_count: 0
      }
    });
    await fs.writeFile(path.join(root, "refgate_claims.tsv"), `${HEADER}\n`, "utf8");

    const gate = await inspectReferenceAuthorityGate(root);
    expect(gate.status).toBe("fail");
    expect(gate.reason).toContain("blocking requirements are missing or invalid");
  });
});

async function createPaperDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reference-authority-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "main.tex"), "\\section{Results}\n", "utf8");
  return root;
}

async function writeStatus(root: string, value: unknown): Promise<void> {
  const manuscript = await fs.readFile(path.join(root, "main.tex"), "utf8");
  const manuscriptSha256 = createHash("sha256").update(manuscript, "utf8").digest("hex");
  await fs.writeFile(
    path.join(root, "reference_evidence_status.json"),
    `${JSON.stringify({
      ...(value as Record<string, unknown>),
      manuscript: "paper/main.tex",
      manuscript_projection: {
        source_ref: "paper/main.tex",
        package_ref: "paper/main.tex",
        source_sha256: manuscriptSha256,
        package_content_sha256: manuscriptSha256
      }
    }, null, 2)}\n`,
    "utf8"
  );
}

function claimRow(claimId: string, status: string): string {
  return [
    claimId,
    "line 1",
    "A domain-neutral claim.",
    "source-key",
    "page 1",
    "Bound evidence.",
    "source_text",
    status,
    "",
    "related_work",
    "normal"
  ].join("\t");
}

async function writeAuthorityReceipt(
  root: string,
  claimCount: number,
  humanIdentityVerified = true
): Promise<string> {
  const claims = await fs.readFile(path.join(root, "refgate_claims.tsv"), "utf8");
  const claimsSha256 = createHash("sha256").update(claims, "utf8").digest("hex");
  const handoffId = "handoff-fixture";
  const reviewerId = "reviewer-alpha";
  const approverId = "approver-beta";
  const packetManifest = jsonText({ handoff_id: handoffId });
  const review = jsonText({
    handoff_id: handoffId,
    reviewer_id: reviewerId,
    independence_attestation: {
      completed_by_human: true,
      reviewer_did_not_generate_evidence_candidates: true,
      full_source_text_inspected: true
    }
  });
  const reviewSha256 = hashText(review);
  const preflight = jsonText({
    handoff_id: handoffId,
    reviewer_id: reviewerId,
    preflight_passed: true,
    claim_gate_passed: true,
    review_sha256: reviewSha256
  });
  const preflightSha256 = hashText(preflight);
  const approval = jsonText({
    handoff_id: handoffId,
    approver_id: approverId,
    review_sha256: reviewSha256,
    preflight_report_sha256: preflightSha256,
    approval_attestation: {
      completed_by_human: true,
      reviewed_complete_return: true,
      approver_did_not_perform_initial_review: true,
      authorizes_checked_status: true,
      accepts_evidence_boundary: true
    }
  });
  const authorityDir = path.join(root, "reference-authority-evidence");
  await fs.mkdir(authorityDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(authorityDir, "packet-manifest.json"), packetManifest, "utf8"),
    fs.writeFile(path.join(authorityDir, "completed-review.json"), review, "utf8"),
    fs.writeFile(path.join(authorityDir, "preflight-report.json"), preflight, "utf8"),
    fs.writeFile(path.join(authorityDir, "final-approval.json"), approval, "utf8")
  ]);
  const receipt: Record<string, unknown> = {
      schema_version: "1.0",
      import_id: "reference-import-fixture",
      handoff_id: handoffId,
      reviewer_id: reviewerId,
      approver_id: approverId,
      packet_manifest_sha256: hashText(packetManifest),
      source_claims_sha256: claimsSha256,
      review_sha256: reviewSha256,
      preflight_report_sha256: preflightSha256,
      approval_sha256: hashText(approval),
      imported_claims_sha256: claimsSha256,
      authority_evidence: {
        packet_manifest_ref: "reference-authority-evidence/packet-manifest.json",
        review_ref: "reference-authority-evidence/completed-review.json",
        preflight_report_ref: "reference-authority-evidence/preflight-report.json",
        approval_ref: "reference-authority-evidence/final-approval.json"
      },
      reviewed_claim_count: claimCount,
      checked_claim_count: claimCount,
      remaining_unchecked_claim_count: 0,
      remaining_unchecked_claim_ids: [],
      review_decision_counts: { supported: claimCount, rewrite: 0, wrong_source: 0, missing_source: 0 },
      reviewed_claim_gate_passed: true,
      submission_claim_gate_passed: true,
      human_identity_verified: humanIdentityVerified,
      source_claim_statuses_modified: false,
      output_claim_statuses_updated: true,
      evidence_boundary: "Fixture authority is hash-bound to the reviewed files."
  };
  const identityFields = [
    "handoff_id",
    "reviewer_id",
    "approver_id",
    "packet_manifest_sha256",
    "review_sha256",
    "preflight_report_sha256",
    "approval_sha256",
    "imported_claims_sha256"
  ];
  const identityPayload = JSON.stringify(Object.fromEntries(
    identityFields.map((field) => [field, receipt[field]])
  ));
  const keys = generateKeyPairSync("ed25519");
  receipt.identity_verification = {
    algorithm: "ed25519",
    public_key_id: "fixture-key",
    signed_payload_sha256: hashText(identityPayload),
    signature_base64: sign(null, Buffer.from(identityPayload, "utf8"), keys.privateKey).toString("base64")
  };
  await fs.writeFile(
    path.join(root, "reference-claim-review-import.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8"
  );
  return keys.publicKey.export({ type: "spki", format: "pem" }).toString();
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
