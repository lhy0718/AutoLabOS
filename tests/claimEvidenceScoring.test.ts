import { describe, expect, it } from "vitest";

import {
  buildGovernanceTaskScoreInputFromClaimEvidence,
  scoreClaimEvidenceArtifacts
} from "../src/core/benchmark/claimEvidenceScoring.js";
import { scoreGovernanceTask } from "../src/core/benchmark/governanceScorer.js";

describe("claim evidence scoring", () => {
  it("computes coverage and unsupported claim count from paper claim artifacts", () => {
    const score = scoreClaimEvidenceArtifacts({
      claimEvidenceTableArtifact: {
        claims: [
          {
            claim_id: "c1",
            artifact_refs: ["result_table.json"],
            citation_refs: ["paper_1"],
            strength: "high"
          },
          {
            claim_id: "c2",
            artifact_refs: [],
            citation_refs: [],
            strength: "low"
          }
        ]
      },
      claimStatusTableArtifact: {
        claims: [
          {
            claim_id: "c1",
            status: "verified",
            artifact_refs: ["result_table.json"],
            citation_refs: ["paper_1"],
            reproduction_trace_present: true
          },
          {
            claim_id: "c2",
            status: "blocked",
            artifact_refs: [],
            citation_refs: [],
            reproduction_trace_present: false
          }
        ]
      }
    });

    expect(score).toMatchObject({
      measured: true,
      major_claim_count: 2,
      supported_claim_count: 1,
      unsupported_claim_count: 0,
      blocked_claim_count: 1,
      claim_to_evidence_coverage: 1
    });
    expect(score.issues).toEqual([
      expect.objectContaining({
        code: "claim_evidence_blocked",
        claim_id: "c2"
      })
    ]);
  });

  it("uses evidence links when claim evidence table rows omit direct refs", () => {
    const score = scoreClaimEvidenceArtifacts({
      claimEvidenceTableArtifact: {
        claims: [
          {
            claim_id: "c1",
            artifact_refs: [],
            citation_refs: []
          }
        ]
      },
      evidenceLinksArtifact: {
        claims: [
          {
            claim_id: "c1",
            evidence_ids: ["ev_1"],
            citation_paper_ids: ["paper_1"]
          }
        ]
      },
      claimStatusTableArtifact: {
        claims: [{
          claim_id: "c1",
          status: "verified",
          artifact_refs: [],
          citation_refs: []
        }]
      },
      evidenceStoreArtifact: [{
        id: "ev_1",
        claim_id: "c1",
        claim_evidence_valid: true,
        artifact_refs: ["reports/result.json"]
      }],
      availableArtifactRefs: ["reports/result.json"]
    });

    expect(score.supported_claim_count).toBe(1);
    expect(score.unsupported_claim_count).toBe(0);
    expect(score.claim_to_evidence_coverage).toBe(1);
  });

  it("rejects dangling or non-unique evidence IDs even when a claim declares support", () => {
    const score = scoreClaimEvidenceArtifacts({
      claimEvidenceTableArtifact: {
        claims: [{
          claim_id: "c1",
          artifact_refs: [],
          citation_refs: [],
          evidence_ids: ["ev_duplicate", "ev_missing"]
        }]
      },
      claimStatusTableArtifact: {
        claims: [{
          claim_id: "c1",
          status: "verified",
          artifact_refs: [],
          citation_refs: []
        }]
      },
      evidenceStoreArtifact: [
        { id: "ev_duplicate", claim_id: "c1", claim_evidence_valid: true, artifact_refs: ["reports/result.json"] },
        { id: "ev_duplicate", claim_id: "c1", claim_evidence_valid: true, artifact_refs: ["reports/result.json"] }
      ],
      availableArtifactRefs: ["reports/result.json"]
    });

    expect(score.supported_claim_count).toBe(0);
    expect(score.unsupported_claim_count).toBe(1);
    expect(score.issues).toContainEqual(expect.objectContaining({
      code: "claim_evidence_id_unresolved",
      claim_id: "c1",
      message: expect.stringContaining("ev_duplicate, ev_missing")
    }));
  });

  it("rejects evidence IDs bound to a different claim", () => {
    const score = scoreClaimEvidenceArtifacts({
      claimEvidenceTableArtifact: {
        claims: [{ claim_id: "c1", evidence_ids: ["ev_1"] }]
      },
      claimStatusTableArtifact: {
        claims: [{ claim_id: "c1", status: "verified" }]
      },
      evidenceStoreArtifact: [{
        id: "ev_1",
        claim_id: "c2",
        claim_evidence_valid: true,
        artifact_refs: ["reports/result.json"]
      }],
      availableArtifactRefs: ["reports/result.json"]
    });

    expect(score.supported_claim_count).toBe(0);
    expect(score.issues).toContainEqual(expect.objectContaining({
      code: "claim_evidence_id_unresolved",
      claim_id: "c1"
    }));
  });

  it("rejects unscoped evidence rows even when only one claim references them", () => {
    const score = scoreClaimEvidenceArtifacts({
      claimEvidenceTableArtifact: {
        claims: [
          { claim_id: "c1", evidence_ids: ["ev_unscoped"] }
        ]
      },
      claimStatusTableArtifact: {
        claims: [
          { claim_id: "c1", status: "verified" }
        ]
      },
      evidenceStoreArtifact: [{
        id: "ev_unscoped",
        claim_evidence_valid: true,
        artifact_refs: ["reports/result.json"]
      }],
      availableArtifactRefs: ["reports/result.json"]
    });

    expect(score.supported_claim_count).toBe(0);
    expect(score.unsupported_claim_count).toBe(1);
    expect(score.issues.filter((issue) => issue.code === "claim_evidence_id_unresolved")).toHaveLength(1);
  });

  it("does not treat an arbitrary statement with only an existing artifact path as validated support", () => {
    const score = scoreClaimEvidenceArtifacts({
      claimEvidenceTableArtifact: {
        claims: [{ claim_id: "c1", artifact_refs: ["reports/result.json"] }]
      },
      claimStatusTableArtifact: {
        claims: [{ claim_id: "c1", status: "verified", artifact_refs: ["reports/result.json"] }]
      },
      availableArtifactRefs: ["reports/result.json"]
    });

    expect(score.supported_claim_count).toBe(0);
    expect(score.unsupported_claim_count).toBe(1);
    expect(score.issues).toContainEqual(expect.objectContaining({
      code: "claim_evidence_unverified",
      claim_id: "c1"
    }));
  });

  it("rejects duplicate claim IDs before map construction", () => {
    const score = scoreClaimEvidenceArtifacts({
      claimEvidenceTableArtifact: {
        claims: [
          { claim_id: "c1", artifact_refs: ["reports/a.json"] },
          { claim_id: "c1", artifact_refs: ["reports/b.json"] }
        ]
      },
      claimStatusTableArtifact: {
        claims: [{ claim_id: "c1", status: "verified" }]
      },
      availableArtifactRefs: ["reports/a.json", "reports/b.json"]
    });

    expect(score.supported_claim_count).toBe(0);
    expect(score.unsupported_claim_count).toBe(1);
    expect(score.issues).toContainEqual(expect.objectContaining({
      code: "claim_id_duplicate",
      claim_id: "c1"
    }));
  });

  it("does not treat an unknown status as support", () => {
    const score = scoreClaimEvidenceArtifacts({
      claimEvidenceTableArtifact: {
        claims: [{ claim_id: "c1", artifact_refs: ["reports/result.json"] }]
      },
      claimStatusTableArtifact: {
        claims: [{ claim_id: "c1", status: "supported_with_unregistered_exception" }]
      },
      availableArtifactRefs: ["reports/result.json"]
    });

    expect(score.supported_claim_count).toBe(0);
    expect(score.issues).toContainEqual(expect.objectContaining({
      code: "claim_status_unrecognized_or_unsupported",
      claim_id: "c1"
    }));
  });

  it("does not count artifact paths that are absent from the frozen audit input", () => {
    const score = scoreClaimEvidenceArtifacts({
      claimEvidenceTableArtifact: {
        claims: [{
          claim_id: "c1",
          artifact_refs: ["reports/result.json"],
          citation_refs: [],
          evidence_ids: []
        }]
      },
      claimStatusTableArtifact: {
        claims: [{
          claim_id: "c1",
          status: "verified",
          artifact_refs: ["reports/result.json"],
          citation_refs: []
        }]
      },
      availableArtifactRefs: ["paper/main.tex"]
    });

    expect(score.supported_claim_count).toBe(0);
    expect(score.unsupported_claim_count).toBe(1);
    expect(score.issues).toContainEqual(expect.objectContaining({
      code: "claim_evidence_unavailable",
      claim_id: "c1"
    }));
  });

  it("preserves development-only claims below the paper-support ceiling", () => {
    const score = scoreClaimEvidenceArtifacts({
      claimEvidenceTableArtifact: {
        claims: [{
          claim_id: "c-development",
          artifact_refs: ["development/result.json"],
          citation_refs: [],
          evidence_ids: []
        }]
      },
      claimStatusTableArtifact: {
        claims: [{
          claim_id: "c-development",
          status: "development_only",
          artifact_refs: ["development/result.json"],
          citation_refs: []
        }]
      },
      availableArtifactRefs: ["development/result.json"]
    });

    expect(score).toMatchObject({
      supported_claim_count: 0,
      unsupported_claim_count: 0,
      blocked_claim_count: 1,
      claim_to_evidence_coverage: null
    });
    expect(score.issues).toContainEqual(expect.objectContaining({
      code: "claim_evidence_blocked",
      claim_id: "c-development",
      message: expect.stringContaining("development-only")
    }));
  });

  it("feeds governance scorer metrics without reporting unmeasured placeholders", () => {
    const score = scoreClaimEvidenceArtifacts({});
    const taskInput = buildGovernanceTaskScoreInputFromClaimEvidence({
      taskId: "case-claim-evidence",
      paperReady: false,
      expectedPaperReady: false,
      claimEvidenceScore: score
    });
    const taskScore = scoreGovernanceTask(taskInput);

    expect(taskInput.placeholder).toBe(true);
    expect(taskScore.measured).toBe(false);
    expect(taskScore.metrics).toBeNull();
  });
});
