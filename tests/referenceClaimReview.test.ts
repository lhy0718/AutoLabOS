import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  importReferenceClaimReview,
  prepareReferenceClaimReview,
  prepareReferenceClaimReviewPrivateDistribution,
  preflightReferenceClaimReview,
  REFERENCE_CLAIM_REVIEW_APPROVAL_TEMPLATE,
  REFERENCE_CLAIM_REVIEW_IMPORT,
  REFERENCE_CLAIM_REVIEW_IMPORTED_CLAIMS,
  REFERENCE_CLAIM_REVIEW_MANIFEST,
  REFERENCE_CLAIM_REVIEW_PREFLIGHT,
  REFERENCE_CLAIM_REVIEW_PRIVATE_DISTRIBUTION,
  REFERENCE_CLAIM_REVIEW_SOURCE_README,
  REFERENCE_CLAIM_REVIEW_TASKS,
  REFERENCE_CLAIM_REVIEW_TEMPLATE
} from "../src/core/referenceClaimReview.js";

const tempDirs: string[] = [];
const SOURCE_ALPHA_TEXT = "Full source alpha for independent claim review.\n";
const SOURCE_ALPHA_SHA256 = createHash("sha256").update(SOURCE_ALPHA_TEXT).digest("hex");

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("reference claim review handoff", () => {
  it("exports only mapped evidence candidates and preserves missing-source blockers", async () => {
    const workspace = await createWorkspace();
    const result = await prepareReferenceClaimReview(reviewInput(workspace, "packet"));

    expect(result).toMatchObject({
      task_count: 2,
      missing_full_text_claim_count: 1,
      output_dir: "packet"
    });
    const manifest = JSON.parse(await readFile(
      path.join(workspace, "packet", REFERENCE_CLAIM_REVIEW_MANIFEST),
      "utf8"
    )) as {
      task_count: number;
      missing_full_text_claims: Array<{
        claim_id: string;
        citation_key: string;
        source_title: string;
        record_url: string;
      }>;
      evidence_boundary: string;
    };
    const tasks = (await readFile(
      path.join(workspace, "packet", REFERENCE_CLAIM_REVIEW_TASKS),
      "utf8"
    )).trim().split("\n").map((line) => JSON.parse(line) as { task_id: string });
    const template = JSON.parse(await readFile(
      path.join(workspace, "packet", REFERENCE_CLAIM_REVIEW_TEMPLATE),
      "utf8"
    )) as {
      reviewer_id: string | null;
      independence_attestation: Record<string, boolean>;
      reviews: Array<{ decision: string | null }>;
    };

    expect(manifest.task_count).toBe(2);
    expect(manifest.missing_full_text_claims).toEqual([{
      claim_id: "claim-c",
      citation_key: "source-b",
      source_title: "Source Beta",
      record_url: "https://example.test/source-b"
    }]);
    expect(tasks.map((task) => task.task_id)).toEqual(["claim-a", "claim-b"]);
    expect(template.reviewer_id).toBeNull();
    expect(Object.values(template.independence_attestation)).toEqual([false, false, false]);
    expect(template.reviews.every((review) => review.decision === null)).toBe(true);
    expect(manifest.evidence_boundary).toContain("no completed human judgment");
  });

  it("fails closed on the generated incomplete template", async () => {
    const workspace = await createWorkspace();
    await prepareReferenceClaimReview(reviewInput(workspace, "packet"));

    const result = await preflightReferenceClaimReview({
      cwd: workspace,
      packetRoot: "packet",
      reviewPath: path.join("packet", REFERENCE_CLAIM_REVIEW_TEMPLATE),
      outDir: "preflight"
    });

    expect(result.report).toMatchObject({
      preflight_passed: false,
      claim_gate_passed: false,
      reviewer_id: null,
      task_count: 2,
      claim_statuses_modified: false
    });
    expect(result.report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "reviewer_id_invalid",
      "review_independence_unattested",
      "review_decision_invalid"
    ]));
  });

  it("accepts a complete human return without mutating claim status", async () => {
    const workspace = await createWorkspace();
    await prepareReferenceClaimReview(reviewInput(workspace, "packet"));
    const reviewPath = await writeCompletedReview(workspace, "supported");

    const result = await preflightReferenceClaimReview({
      cwd: workspace,
      packetRoot: "packet",
      reviewPath,
      outDir: "preflight"
    });

    expect(result.report).toMatchObject({
      preflight_passed: true,
      claim_gate_passed: true,
      reviewer_id: "reviewer-alpha",
      reviewed_task_count: 2,
      decision_counts: { supported: 2, rewrite: 0, wrong_source: 0, missing_source: 0 },
      human_identity_verified: false,
      claim_statuses_modified: false
    });
    const approval = JSON.parse(await readFile(
      path.join(workspace, "preflight", REFERENCE_CLAIM_REVIEW_APPROVAL_TEMPLATE),
      "utf8"
    )) as {
      approver_id: string | null;
      approval_attestation: Record<string, boolean>;
      approved_task_ids: string[];
    };
    expect(approval.approver_id).toBeNull();
    expect(Object.values(approval.approval_attestation).every((value) => value === false)).toBe(true);
    expect(approval.approved_task_ids).toEqual(["claim-a", "claim-b"]);
  });

  it("imports an all-supported human review into a new claims file after final approval", async () => {
    const workspace = await createWorkspace();
    await prepareReferenceClaimReview(reviewInput(workspace, "packet"));
    const reviewPath = await writeCompletedReview(workspace, "supported");
    await preflightReferenceClaimReview({
      cwd: workspace,
      packetRoot: "packet",
      reviewPath,
      outDir: "preflight"
    });
    const approvalPath = await writeCompletedApproval(workspace);
    const sourceClaims = await readFile(path.join(workspace, "claims.tsv"), "utf8");

    const result = await importReferenceClaimReview({
      cwd: workspace,
      packetRoot: "packet",
      reviewPath,
      preflightReportPath: path.join("preflight", REFERENCE_CLAIM_REVIEW_PREFLIGHT),
      approvalPath,
      claimsPath: "claims.tsv",
      outDir: "import"
    });

    expect(result.receipt).toMatchObject({
      reviewed_claim_count: 2,
      checked_claim_count: 2,
      remaining_unchecked_claim_count: 1,
      remaining_unchecked_claim_ids: ["claim-c"],
      reviewed_claim_gate_passed: true,
      submission_claim_gate_passed: false,
      human_identity_verified: false,
      source_claim_statuses_modified: false,
      output_claim_statuses_updated: true
    });
    expect(await readFile(path.join(workspace, "claims.tsv"), "utf8")).toBe(sourceClaims);
    const importedClaims = await readFile(
      path.join(workspace, "import", REFERENCE_CLAIM_REVIEW_IMPORTED_CLAIMS),
      "utf8"
    );
    expect(importedClaims.match(/\tchecked\t/gu)).toHaveLength(2);
    expect(importedClaims).toContain("claim-c\tline 30\tClaim gamma.\tsource-b\t\t\t\tclaim_unchecked\t");
    expect(JSON.parse(await readFile(
      path.join(workspace, "import", REFERENCE_CLAIM_REVIEW_IMPORT),
      "utf8"
    ))).toMatchObject({ import_id: result.receipt.import_id });
  });

  it("rejects import when review, approval, preflight, or source claims are not exact", async () => {
    const workspace = await createWorkspace();
    await prepareReferenceClaimReview(reviewInput(workspace, "packet"));
    const reviewPath = await writeCompletedReview(workspace, "rewrite");
    await preflightReferenceClaimReview({
      cwd: workspace,
      packetRoot: "packet",
      reviewPath,
      outDir: "rewrite-preflight"
    });
    await expect(importReferenceClaimReview({
      cwd: workspace,
      packetRoot: "packet",
      reviewPath,
      preflightReportPath: path.join("rewrite-preflight", REFERENCE_CLAIM_REVIEW_PREFLIGHT),
      approvalPath: path.join("rewrite-preflight", REFERENCE_CLAIM_REVIEW_APPROVAL_TEMPLATE),
      claimsPath: "claims.tsv",
      outDir: "rewrite-import"
    })).rejects.toThrow("all-supported preflight");

    const supportedReviewPath = await writeCompletedReview(workspace, "supported");
    await preflightReferenceClaimReview({
      cwd: workspace,
      packetRoot: "packet",
      reviewPath: supportedReviewPath,
      outDir: "supported-preflight"
    });
    const incompleteApprovalPath = path.join(
      workspace,
      "supported-preflight",
      REFERENCE_CLAIM_REVIEW_APPROVAL_TEMPLATE
    );
    await expect(importReferenceClaimReview({
      cwd: workspace,
      packetRoot: "packet",
      reviewPath: supportedReviewPath,
      preflightReportPath: path.join("supported-preflight", REFERENCE_CLAIM_REVIEW_PREFLIGHT),
      approvalPath: incompleteApprovalPath,
      claimsPath: "claims.tsv",
      outDir: "incomplete-approval-import"
    })).rejects.toThrow("approval is incomplete");

    const approvalPath = await writeCompletedApproval(workspace, "supported-preflight");
    await writeFile(path.join(workspace, "claims.tsv"), "changed claims\n", "utf8");
    await expect(importReferenceClaimReview({
      cwd: workspace,
      packetRoot: "packet",
      reviewPath: supportedReviewPath,
      preflightReportPath: path.join("supported-preflight", REFERENCE_CLAIM_REVIEW_PREFLIGHT),
      approvalPath,
      claimsPath: "claims.tsv",
      outDir: "drifted-claims-import"
    })).rejects.toThrow("source claims have changed");
  });

  it("keeps the claim gate closed when a complete review requests revision", async () => {
    const workspace = await createWorkspace();
    await prepareReferenceClaimReview(reviewInput(workspace, "packet"));
    const reviewPath = await writeCompletedReview(workspace, "rewrite");

    const result = await preflightReferenceClaimReview({
      cwd: workspace,
      packetRoot: "packet",
      reviewPath,
      outDir: "preflight"
    });

    expect(result.report.preflight_passed).toBe(true);
    expect(result.report.claim_gate_passed).toBe(false);
    expect(result.report.decision_counts).toMatchObject({ supported: 1, rewrite: 1 });
  });

  it("does not count an unknown review item as packet coverage", async () => {
    const workspace = await createWorkspace();
    await prepareReferenceClaimReview(reviewInput(workspace, "packet"));
    const reviewPath = await writeCompletedReview(workspace, "supported");
    const review = JSON.parse(await readFile(reviewPath, "utf8")) as {
      reviews: Array<{ task_id: string }>;
    };
    review.reviews[1].task_id = "claim-unknown";
    await writeFile(reviewPath, JSON.stringify(review), "utf8");

    const result = await preflightReferenceClaimReview({
      cwd: workspace,
      packetRoot: "packet",
      reviewPath,
      outDir: "preflight"
    });

    expect(result.report).toMatchObject({
      preflight_passed: false,
      claim_gate_passed: false,
      reviewed_task_count: 1,
      decision_counts: { supported: 1, rewrite: 0, wrong_source: 0, missing_source: 0 }
    });
    expect(result.report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "unknown_review_task",
      "missing_review_task"
    ]));
  });

  it("rejects a packet whose task file changed after export", async () => {
    const workspace = await createWorkspace();
    await prepareReferenceClaimReview(reviewInput(workspace, "packet"));
    const tasksPath = path.join(workspace, "packet", REFERENCE_CLAIM_REVIEW_TASKS);
    await writeFile(tasksPath, (await readFile(tasksPath, "utf8")) + "\n", "utf8");
    const reviewPath = await writeCompletedReview(workspace, "supported");

    await expect(preflightReferenceClaimReview({
      cwd: workspace,
      packetRoot: "packet",
      reviewPath,
      outDir: "preflight"
    })).rejects.toThrow("packet hash mismatch");
  });

  it("creates a closed private distribution with one deduplicated hash-bound source", async () => {
    const workspace = await createWorkspace();
    await prepareReferenceClaimReview(reviewInput(workspace, "packet"));
    const sourceDir = path.join(workspace, "sources");
    await mkdir(sourceDir);
    await writeFile(path.join(sourceDir, "source-a.txt"), SOURCE_ALPHA_TEXT, "utf8");

    const result = await prepareReferenceClaimReviewPrivateDistribution({
      cwd: workspace,
      packetRoot: "packet",
      sourceDir: "sources",
      outDir: "private-distribution"
    });

    expect(result).toMatchObject({
      handoff_id: expect.stringMatching(/^reference-claim-review-/u),
      source_count: 1,
      output_dir: "private-distribution"
    });
    const manifest = JSON.parse(await readFile(
      path.join(workspace, "private-distribution", REFERENCE_CLAIM_REVIEW_PRIVATE_DISTRIBUTION),
      "utf8"
    )) as {
      public_distribution_allowed: boolean;
      license_review_status: string;
      sources: Array<{ citation_key: string; path: string; sha256: string }>;
    };
    expect(manifest).toMatchObject({
      public_distribution_allowed: false,
      license_review_status: "not_assessed",
      sources: [{
        citation_key: "source-a",
        path: "reviewer/sources/source-a.txt",
        sha256: SOURCE_ALPHA_SHA256
      }]
    });
    const sourceReadme = await readFile(
      path.join(workspace, "private-distribution", REFERENCE_CLAIM_REVIEW_SOURCE_README),
      "utf8"
    );
    expect(sourceReadme).toContain("must not be published");
    expect(sourceReadme).toContain("## Missing Full Text");
    expect(sourceReadme).toContain(
      "source-b: Source Beta (record: https://example.test/source-b; blocked claims: claim-c)"
    );
    expect(sourceReadme).toContain("must not be reviewed until the exact full text is acquired");

    const preflight = await preflightReferenceClaimReview({
      cwd: workspace,
      packetRoot: "private-distribution",
      reviewPath: path.join("private-distribution", REFERENCE_CLAIM_REVIEW_TEMPLATE),
      outDir: "private-distribution-preflight"
    });
    expect(preflight.report).toMatchObject({
      preflight_passed: false,
      claim_gate_passed: false,
      task_count: 2
    });
  });

  it("rejects a private distribution when a required source is missing or has the wrong hash", async () => {
    const workspace = await createWorkspace();
    await prepareReferenceClaimReview(reviewInput(workspace, "packet"));
    await mkdir(path.join(workspace, "empty-sources"));

    await expect(prepareReferenceClaimReviewPrivateDistribution({
      cwd: workspace,
      packetRoot: "packet",
      sourceDir: "empty-sources",
      outDir: "missing-distribution"
    })).rejects.toThrow("Missing hash-bound reference review source");

    await mkdir(path.join(workspace, "wrong-sources"));
    await writeFile(path.join(workspace, "wrong-sources", "source-a.txt"), "wrong source\n", "utf8");
    await expect(prepareReferenceClaimReviewPrivateDistribution({
      cwd: workspace,
      packetRoot: "packet",
      sourceDir: "wrong-sources",
      outDir: "wrong-distribution"
    })).rejects.toThrow("source hash mismatch");
  });

  it("rejects challenge HTML even when it is hash-bound as a PDF or text source", async () => {
    const pdfWorkspace = await createWorkspace();
    const challengeHtml = "<!doctype html><html><title>Verifying your browser</title></html>\n";
    const challengeSha256 = createHash("sha256").update(challengeHtml).digest("hex");
    const pdfStatusPath = path.join(pdfWorkspace, "status.json");
    const pdfStatus = JSON.parse(await readFile(pdfStatusPath, "utf8")) as {
      sources: Array<{ citation_key: string; pdf_sha256: string | null }>;
    };
    const pdfSource = pdfStatus.sources.find((source) => source.citation_key === "source-a");
    if (!pdfSource) throw new Error("Missing source-a test fixture.");
    pdfSource.pdf_sha256 = challengeSha256;
    await writeFile(pdfStatusPath, JSON.stringify(pdfStatus), "utf8");
    await prepareReferenceClaimReview(reviewInput(pdfWorkspace, "packet"));
    await mkdir(path.join(pdfWorkspace, "sources"));
    await writeFile(path.join(pdfWorkspace, "sources", "source-a.pdf"), challengeHtml, "utf8");

    await expect(prepareReferenceClaimReviewPrivateDistribution({
      cwd: pdfWorkspace,
      packetRoot: "packet",
      sourceDir: "sources",
      outDir: "private-distribution"
    })).rejects.toThrow("not a structurally valid PDF");

    const textWorkspace = await createWorkspace();
    const textStatusPath = path.join(textWorkspace, "status.json");
    const textStatus = JSON.parse(await readFile(textStatusPath, "utf8")) as {
      sources: Array<{ citation_key: string; pdf_sha256: string | null }>;
    };
    const textSource = textStatus.sources.find((source) => source.citation_key === "source-a");
    if (!textSource) throw new Error("Missing source-a test fixture.");
    textSource.pdf_sha256 = challengeSha256;
    await writeFile(textStatusPath, JSON.stringify(textStatus), "utf8");
    await prepareReferenceClaimReview(reviewInput(textWorkspace, "packet"));
    await mkdir(path.join(textWorkspace, "sources"));
    await writeFile(path.join(textWorkspace, "sources", "source-a.txt"), challengeHtml, "utf8");

    await expect(prepareReferenceClaimReviewPrivateDistribution({
      cwd: textWorkspace,
      packetRoot: "packet",
      sourceDir: "sources",
      outDir: "private-distribution"
    })).rejects.toThrow("not valid plain text");
  });

  it("rejects source symlinks and post-distribution source tampering", async () => {
    const workspace = await createWorkspace();
    await prepareReferenceClaimReview(reviewInput(workspace, "packet"));
    const linkedSourceDir = path.join(workspace, "linked-sources");
    await mkdir(linkedSourceDir);
    await writeFile(path.join(linkedSourceDir, "target.txt"), SOURCE_ALPHA_TEXT, "utf8");
    await symlink("target.txt", path.join(linkedSourceDir, "source-a.txt"));
    await expect(prepareReferenceClaimReviewPrivateDistribution({
      cwd: workspace,
      packetRoot: "packet",
      sourceDir: "linked-sources",
      outDir: "linked-distribution"
    })).rejects.toThrow("regular reference source");

    const sourceDir = path.join(workspace, "sources");
    await mkdir(sourceDir);
    await writeFile(path.join(sourceDir, "source-a.txt"), SOURCE_ALPHA_TEXT, "utf8");
    await prepareReferenceClaimReviewPrivateDistribution({
      cwd: workspace,
      packetRoot: "packet",
      sourceDir: "sources",
      outDir: "private-distribution"
    });
    await writeFile(
      path.join(workspace, "private-distribution", "reviewer", "sources", "source-a.txt"),
      "tampered source\n",
      "utf8"
    );

    await expect(preflightReferenceClaimReview({
      cwd: workspace,
      packetRoot: "private-distribution",
      reviewPath: path.join("private-distribution", REFERENCE_CLAIM_REVIEW_TEMPLATE),
      outDir: "tampered-preflight"
    })).rejects.toThrow("distribution hash mismatch");
  });
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "reference-claim-review-"));
  tempDirs.push(workspace);
  const header = [
    "claim_id", "manuscript_location", "claim_text", "citation_key",
    "source_location", "quote_or_evidence", "evidence_kind", "status",
    "notes", "claim_type", "importance"
  ].join("\t");
  const rows = [
    ["claim-a", "line 10", "Claim alpha.", "source-a", "page 1", "Evidence alpha.", "source_text", "needs_review", "Review required.", "related_work", "normal"],
    ["claim-b", "line 20", "Claim beta.", "source-a", "page 2", "Evidence beta.", "source_text", "needs_review", "Review required.", "related_work", "normal"],
    ["claim-c", "line 30", "Claim gamma.", "source-b", "", "", "", "claim_unchecked", "Full text missing.", "related_work", "normal"]
  ].map((row) => row.join("\t"));
  await writeFile(path.join(workspace, "claims.tsv"), [header, ...rows].join("\n") + "\n", "utf8");
  await writeFile(path.join(workspace, "status.json"), JSON.stringify({
    manuscript: "manuscript.tex",
    summary: {
      citation_bearing_claim_count: 3,
      full_text_evidence_candidate_count: 2,
      missing_full_text_claim_count: 1
    },
    sources: [
      {
        citation_key: "source-a",
        record_url: "https://example.test/source-a",
        full_text_status: "mapped",
        pdf_sha256: SOURCE_ALPHA_SHA256,
        claim_ids: ["claim-a", "claim-b"]
      },
      {
        citation_key: "source-b",
        record_url: "https://example.test/source-b",
        full_text_status: "missing",
        pdf_sha256: null,
        claim_ids: ["claim-c"]
      }
    ]
  }), "utf8");
  await writeFile(path.join(workspace, "lock.json"), JSON.stringify({
    entries: [
      { citation_key: "source-a", record: { title: "Source Alpha" } },
      { citation_key: "source-b", record: { title: "Source Beta" } }
    ]
  }), "utf8");
  return workspace;
}

function reviewInput(workspace: string, outDir: string) {
  return {
    cwd: workspace,
    claimsPath: "claims.tsv",
    statusPath: "status.json",
    lockPath: "lock.json",
    outDir
  };
}

async function writeCompletedApproval(
  workspace: string,
  preflightDir = "preflight"
): Promise<string> {
  const templatePath = path.join(
    workspace,
    preflightDir,
    REFERENCE_CLAIM_REVIEW_APPROVAL_TEMPLATE
  );
  const approval = JSON.parse(await readFile(templatePath, "utf8")) as {
    approver_id: string | null;
    approval_attestation: Record<string, boolean>;
    rationale: string | null;
  };
  approval.approver_id = "approver-beta";
  approval.approval_attestation = {
    completed_by_human: true,
    reviewed_complete_return: true,
    authorizes_checked_status: true,
    accepts_evidence_boundary: true
  };
  approval.rationale = "The complete review return and its evidence boundary were inspected.";
  const approvalPath = path.join(workspace, `${preflightDir}-completed-approval.json`);
  await writeFile(approvalPath, JSON.stringify(approval), "utf8");
  return approvalPath;
}

async function writeCompletedReview(
  workspace: string,
  secondDecision: "supported" | "rewrite"
): Promise<string> {
  const templatePath = path.join(workspace, "packet", REFERENCE_CLAIM_REVIEW_TEMPLATE);
  const review = JSON.parse(await readFile(templatePath, "utf8")) as {
    reviewer_id: string | null;
    independence_attestation: Record<string, boolean>;
    reviews: Array<{
      decision: string | null;
      source_location: string | null;
      supporting_passage: string | null;
      proposed_claim_text: string | null;
      rationale: string | null;
    }>;
  };
  review.reviewer_id = "reviewer-alpha";
  review.independence_attestation = {
    completed_by_human: true,
    reviewer_did_not_generate_evidence_candidates: true,
    full_source_text_inspected: true
  };
  for (const [index, item] of review.reviews.entries()) {
    item.decision = index === 1 ? secondDecision : "supported";
    item.source_location = `page ${index + 1}`;
    item.supporting_passage = `Reviewed passage ${index + 1}.`;
    item.proposed_claim_text = item.decision === "rewrite" ? "Revised claim beta." : null;
    item.rationale = "The full source was inspected against the manuscript claim.";
  }
  const reviewPath = path.join(workspace, "completed-review.json");
  await writeFile(reviewPath, JSON.stringify(review), "utf8");
  return reviewPath;
}
