import { describe, expect, it, vi } from "vitest";

import { generateHypothesesFromEvidence } from "../src/core/analysis/researchPlanning.js";

describe("topic discovery prompt contract", () => {
  it("passes bounded search rules to staged and single-pass generation prompts", async () => {
    const prompts: string[] = [];
    const llm = {
      complete: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        throw new Error("provider unavailable for contract test");
      })
    };

    await generateHypothesesFromEvidence({
      llm: llm as never,
      runTitle: "Governed topic search",
      runTopic: "Find an evidence-backed local comparison in the declared scope.",
      objectiveMetric: "",
      evidenceSeeds: [
        {
          evidence_id: "evidence_a",
          paper_id: "paper_a",
          source_type: "full_text",
          claim_slot: "The reference method leaves an unresolved comparison.",
          method_slot: "Matched evaluation protocol.",
          result_slot: "A measurable difference was reported.",
          limitation_slot: "The strongest feasible comparator was not evaluated.",
          dataset_slot: "public_collection",
          metric_slot: "primary_score"
        }
      ],
      branchCount: 2,
      topK: 1,
      governance: {
        researchMode: "topic_discovery",
        constraints: ["Use licensed public data.", "Finish the probe within one workstation-hour."],
        objectiveRule: "Promote candidates with independent full-text support and an executable measurement contract.",
        comparatorRule: "Every candidate must name the strongest feasible comparator.",
        minimumEvidenceRule: "A bounded probe may screen only; paper claims require repeated matched comparisons.",
        failureConditionsRule: "Stop when source licensing or deterministic grading cannot be verified."
      }
    });

    expect(prompts.length).toBeGreaterThanOrEqual(2);
    for (const prompt of prompts) {
      expect(prompt).toContain("research_mode=topic_discovery");
      expect(prompt).toContain("Do not copy a broad brief objective into candidate metric fields.");
      expect(prompt).toContain("Use licensed public data.");
      expect(prompt).toContain("Every candidate must name the strongest feasible comparator.");
      expect(prompt).toContain("paper claims require repeated matched comparisons");
      expect(prompt).toContain("source licensing or deterministic grading cannot be verified");
    }
  });
});
