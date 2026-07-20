import { describe, expect, it } from "vitest";

import { buildClaimEvidenceExport } from "../src/core/audit/claimEvidenceExport.js";

describe("claim evidence audit export", () => {
  it("normalizes existing claim artifacts without inventing support", () => {
    const exportPayload = buildClaimEvidenceExport({
      claimEvidenceTableArtifact: {
        claims: [
          {
            claim_id: "claim_supported",
            statement: "The metric improved in the scoped run.",
            artifact_refs: ["result_table.json"],
            citation_refs: [],
            evidence_ids: ["ev_metric"]
          },
          {
            claim_id: "claim_missing",
            statement: "The result generalizes broadly.",
            artifact_refs: [],
            citation_refs: [],
            evidence_ids: []
          }
        ]
      },
      claimStatusTableArtifact: {
        claims: [
          { claim_id: "claim_supported", status: "verified", artifact_refs: ["result_table.json"], reproduction_trace_present: true },
          { claim_id: "claim_missing", status: "blocked", artifact_refs: [], reproduction_trace_present: false }
        ]
      },
      evidenceLinksArtifact: {
        claims: [{ claim_id: "claim_supported", artifact_refs: ["result_table.json"], evidence_ids: ["ev_metric"] }]
      },
      claimEvidenceScore: {
        measured: true,
        major_claim_count: 2,
        supported_claim_count: 1,
        unsupported_claim_count: 0,
        blocked_claim_count: 1,
        claim_to_evidence_coverage: 1,
        issues: [{ code: "claim_evidence_blocked", claim_id: "claim_missing", message: "blocked" }]
      },
      unsupportedClaims: [{ claim_id: "claim_missing", message: "missing", status: "blocked", statement: "The result generalizes broadly." }]
    });

    expect(exportPayload.summary).toEqual({
      major_claim_count: 2,
      supported_claim_count: 1,
      unsupported_claim_count: 0,
      blocked_claim_count: 1,
      claim_to_evidence_coverage: 1
    });
    expect(exportPayload.claims.find((claim) => claim.claim_id === "claim_supported")?.support_level).toBe("artifact_or_citation_linked");
    expect(exportPayload.claims.find((claim) => claim.claim_id === "claim_missing")?.support_level).toBe("blocked");
    expect(exportPayload.policy_note).toContain("does not create evidence");
  });

  it("never retains a positive status when the frozen scorer reports an issue", () => {
    const exportPayload = buildClaimEvidenceExport({
      claimStatusTableArtifact: {
        claims: [{
          claim_id: "claim_unavailable",
          status: "verified",
          artifact_refs: ["results/missing.json"]
        }]
      },
      claimEvidenceScore: {
        measured: true,
        major_claim_count: 1,
        supported_claim_count: 0,
        unsupported_claim_count: 1,
        blocked_claim_count: 0,
        claim_to_evidence_coverage: 0,
        issues: [{
          code: "claim_evidence_unavailable",
          claim_id: "claim_unavailable",
          message: "missing from frozen input"
        }]
      },
      unsupportedClaims: [{
        claim_id: "claim_unavailable",
        message: "missing from frozen input",
        status: "unsupported",
        declared_status: "verified"
      }]
    });

    expect(exportPayload.claims[0]).toMatchObject({
      status: "unsupported",
      support_level: "unsupported",
      issue_codes: ["claim_evidence_unavailable"]
    });
  });
});
