import { describe, expect, it } from "vitest";

import { scoreLiteratureDiscoveryAudit } from "../src/core/audit/literatureDiscoveryAudit.js";

describe("literature discovery audit", () => {
  it("keeps literature trace findings separate and explicit", () => {
    const score = scoreLiteratureDiscoveryAudit({
      payloads: [
        {
          path: "collect_papers/literature_discovery_audit.json",
          payload: {
            track: "wide_related_work",
            included_papers: ["paper-a"],
            excluded_papers: ["paper-b"],
            exclusion_reasons_present: false
          }
        }
      ]
    });

    expect(score.measured).toBe(true);
    expect(score.included_excluded_trace_present).toBe(true);
    expect(score.exclusion_reasons_present).toBe(false);
    expect(score.findings.map((finding) => finding.code)).toEqual(["literature_exclusion_reasons_missing"]);
    expect(score.findings[0].severity).toBe("warning");
  });

  it("passes through as unmeasured when no literature audit artifact exists", () => {
    const score = scoreLiteratureDiscoveryAudit({ payloads: [] });

    expect(score.measured).toBe(false);
    expect(score.findings).toEqual([]);
  });
});
