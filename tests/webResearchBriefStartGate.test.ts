import { describe, expect, it } from "vitest";

import { buildGuidedResearchBriefMarkdown } from "../src/core/runs/researchBriefFiles.js";
import {
  buildWebDirectRunInputGate,
  buildWebResearchBriefStartGate
} from "../src/web/server.js";

describe("web research brief start gate", () => {
  it("blocks an empty brief even when auto-start is requested", () => {
    const gate = buildWebResearchBriefStartGate(undefined, true);

    expect(gate).toMatchObject({
      requested: true,
      canStart: false,
      blocked: true,
      effectiveAutoStart: false
    });
    expect(gate.missingFields).toContain("Topic");
    expect(gate.missingFields).toContain("Baseline / Comparator");
    expect(gate.missingFields).toContain("Failure Conditions");
    expect(gate.validationErrors.length).toBe(gate.missingFields.length);
  });

  it("keeps a partial brief draftable without authorizing execution", () => {
    const brief = [
      "# Research Brief",
      "",
      "## Topic",
      "Evaluate a candidate condition under a bounded protocol."
    ].join("\n");

    const requestedGate = buildWebResearchBriefStartGate(brief, true);
    const draftGate = buildWebResearchBriefStartGate(brief, false);

    expect(requestedGate.blocked).toBe(true);
    expect(requestedGate.effectiveAutoStart).toBe(false);
    expect(requestedGate.missingFields).not.toContain("Topic");
    expect(requestedGate.missingFields).toContain("Objective Metric");
    expect(draftGate).toMatchObject({
      requested: false,
      canStart: false,
      blocked: false,
      effectiveAutoStart: false
    });
  });

  it("authorizes a direct run only from complete explicit inputs", () => {
    expect(buildWebDirectRunInputGate({
      topic: "  configured research topic  ",
      constraints: [" declared literature scope ", ""],
      objectiveMetric: " configured evaluation metric "
    }, true)).toEqual({
      topic: "configured research topic",
      constraints: ["declared literature scope"],
      objectiveMetric: "configured evaluation metric",
      startGate: {
        requested: true,
        canStart: true,
        blocked: false,
        effectiveAutoStart: true,
        missingFields: [],
        validationErrors: [],
        validationWarnings: []
      }
    });
  });

  it("fails closed for an incomplete direct run", () => {
    expect(() => buildWebDirectRunInputGate({
      topic: "configured research topic",
      constraints: [],
      objectiveMetric: ""
    }, true)).toThrow("constraints, objectiveMetric");
  });

  it("authorizes auto-start only for a complete governed brief", () => {
    const brief = buildGuidedResearchBriefMarkdown({
      topic: "Evaluate a candidate condition against a declared reference condition.",
      primaryMetric: "Primary score on held-out evaluation units.",
      secondaryMetrics: "Runtime and resource use.",
      meaningfulImprovement: "Cross a prespecified improvement boundary over the reference condition.",
      constraints: "Use a bounded runtime, fixed inputs, and reproducible evaluation scripts.",
      researchQuestion: "Does the candidate condition improve the primary score under the fixed budget?",
      whySmallExperiment: "The inputs, reference condition, implementation, and repeated evaluation are bounded.",
      baselineComparator: "Use a declared reference condition under the same evaluation budget.",
      datasetTaskBench: "Use a user-supplied evaluation set with a fixed held-out split and documented limitations.",
      targetComparison: "Compare the candidate and reference conditions on the primary score in the favorable direction.",
      minimumAcceptableEvidence: "Require repeated matched units, a prespecified boundary, and an uncertainty rule.",
      disallowedShortcuts: "Do not omit the reference condition, invent values, or reuse workflow smoke output as evidence.",
      allowedBudgetedPasses: "Allow one primary pass and one bounded confirmatory pass within the fixed budget.",
      paperCeiling: "Cap the output at research_memo when the minimum evidence boundary is not met.",
      minimumExperimentPlan: "Run the reference and candidate conditions, produce one result table, and map claims to evidence.",
      failureConditions: "Stop when inputs, the reference condition, or the required quantitative comparison are unavailable."
    });

    const gate = buildWebResearchBriefStartGate(brief, true);

    expect(gate).toEqual({
      requested: true,
      canStart: true,
      blocked: false,
      effectiveAutoStart: true,
      missingFields: [],
      validationErrors: [],
      validationWarnings: []
    });
  });

  it("blocks topic-discovery auto-start until a role-valid scientific scope is present", () => {
    const base = buildGuidedResearchBriefMarkdown({
      researchMode: "topic_discovery",
      topic: "Search for reliable decisions under bounded evaluation evidence.",
      primaryMetric: "Each candidate must declare one numeric primary metric.",
      meaningfulImprovement: "Each candidate must declare a practical-effect boundary.",
      constraints: "Use licensed public data and bounded local compute.",
      researchQuestion: "Which evidence-backed problem supports a falsifiable comparison?",
      whySmallExperiment: "Promote only candidates with a bounded real probe.",
      baselineComparator: "Each candidate must name its strongest feasible comparator.",
      datasetTaskBench: "Each candidate must bind a licensed task and frozen split.",
      targetComparison: "Each candidate must bind a proposal, comparator, direction, and falsifier.",
      minimumAcceptableEvidence: "Require verified priors, real probe evidence, and uncertainty.",
      disallowedShortcuts: "No outcome-driven gate changes or fabricated evidence.",
      allowedBudgetedPasses: "One bounded repair pass before outcomes are opened.",
      paperCeiling: "research_memo",
      minimumExperimentPlan: "One frozen candidate contract, comparator, and bounded probe.",
      failureConditions: "No licensed data, deterministic endpoint, or viable comparator."
    });
    const complete = buildGuidedResearchBriefMarkdown({
      researchMode: "topic_discovery",
      topic: "Search for reliable decisions under bounded evaluation evidence.",
      scientificObject: "configured evaluation decisions",
      empiricalProblems: "decision stability under finite evidence; uncertainty calibration under dependent units",
      priorWorkProbes: "whether adaptive evaluation already subsumes the question",
      primaryMetric: "Each candidate must declare one numeric primary metric.",
      meaningfulImprovement: "Each candidate must declare a practical-effect boundary.",
      constraints: "Use licensed public data and bounded local compute.",
      researchQuestion: "Which evidence-backed problem supports a falsifiable comparison?",
      whySmallExperiment: "Promote only candidates with a bounded real probe.",
      baselineComparator: "Each candidate must name its strongest feasible comparator.",
      datasetTaskBench: "Each candidate must bind a licensed task and frozen split.",
      targetComparison: "Each candidate must bind a proposal, comparator, direction, and falsifier.",
      minimumAcceptableEvidence: "Require verified priors, real probe evidence, and uncertainty.",
      disallowedShortcuts: "No outcome-driven gate changes or fabricated evidence.",
      allowedBudgetedPasses: "One bounded repair pass before outcomes are opened.",
      paperCeiling: "research_memo",
      minimumExperimentPlan: "One frozen candidate contract, comparator, and bounded probe.",
      failureConditions: "No licensed data, deterministic endpoint, or viable comparator."
    });

    expect(buildWebResearchBriefStartGate(base, true)).toMatchObject({
      canStart: false,
      blocked: true,
      missingFields: expect.arrayContaining(["Scientific Scope"])
    });
    expect(buildWebResearchBriefStartGate(complete, true)).toMatchObject({
      canStart: true,
      blocked: false,
      missingFields: []
    });
  });
});
