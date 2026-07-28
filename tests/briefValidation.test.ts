import { describe, expect, it } from "vitest";

import {
  buildBriefCompletenessArtifact,
  buildResearchBriefTemplate,
  validateResearchBriefDraftMarkdown,
  validateResearchBriefMarkdown
} from "../src/core/runs/researchBriefFiles.js";
import { parseMarkdownRunBriefSections } from "../src/core/runs/runBriefParser.js";

function fullBrief(): string {
  return [
    "# Research Brief",
    "",
    "## Topic",
    "Controlled intervention comparison on a public evaluation collection under a bounded runtime.",
    "",
    "## Objective Metric",
    "- Primary metric: primary_score.",
    "- Secondary metrics (if any): uncertainty interval, wall-clock runtime.",
    "- What counts as meaningful improvement: at least 0.03 absolute improvement over the reference condition without more than 2x runtime.",
    "",
    "## Constraints",
    "- compute/time budget: keep the full experiment runnable on a single workstation in under 6 hours.",
    "- dataset or environment limits: use a public evaluation collection with a reproducible split.",
    "- provider/tooling constraints: local Python runner only.",
    "- reproducibility constraints: persist scripts, configs, and result tables under outputs/ within the active workspace.",
    "- forbidden shortcuts: no fabricated metrics or workflow-only evidence.",
    "",
    "## Plan",
    "1. collect related work on the intervention 2. lock a reference condition 3. implement one candidate condition 4. run matched comparisons 5. analyze primary_score, uncertainty, and runtime 6. draft only if evidence clears the gate.",
    "",
    "## Research Question",
    "Can the candidate intervention improve primary_score under a fixed execution budget compared with the declared reference condition?",
    "",
    "## Why This Can Be Tested With A Small Real Experiment",
    "- accessible dataset/task: the evaluation collection is public and has a stable split.",
    "- feasible implementation scope: both conditions share the same inputs and differ in one declared intervention.",
    "- feasible baseline: the reference procedure is already supported.",
    "- realistic run budget: evaluate a bounded sample before scaling to the full split.",
    "- expected signal size or decision rule: stop if the effect stays below the practical boundary after runtime normalization.",
    "",
    "## Baseline / Comparator",
    "- baseline name: reference_condition.",
    "- why it is relevant: it is the simplest supported procedure without the candidate intervention.",
    "- expected comparison dimension: primary_score versus execution cost.",
    "",
    "## Dataset / Task / Bench",
    "- dataset(s): public_evaluation_collection.",
    "- task type: deterministic prediction over held-out records.",
    "- train/eval protocol: compare matched conditions on a held-out evaluation set.",
    "- split or validation discipline: fixed evaluation subset first, then full evaluation if promising.",
    "- known limitations: one dataset is not enough for a paper-ready general claim.",
    "",
    "## Target Comparison",
    "- proposed method or condition: candidate_condition.",
    "- comparator or baseline: reference_condition.",
    "- comparison dimension: primary_score, uncertainty, and runtime.",
    "- direction of expected improvement: higher primary_score at similar or moderately higher cost.",
    "",
    "## Minimum Acceptable Evidence",
    "- minimum effect size or decision boundary: at least 0.03 absolute primary_score improvement or a clear score-cost tradeoff win.",
    "- minimum number of runs or folds: run the baseline and proposal on the same evaluation slice, then repeat on the full slice if promising.",
    "- what counts as no signal vs weak signal: no signal if primary_score is flat; weak signal if gains vanish after accounting for runtime.",
    "",
    "## Disallowed Shortcuts",
    "- Do not use workflow smoke artifacts as experimental evidence.",
    "- Do not cherry-pick a single favorable subset and omit failures.",
    "- Do not fabricate or interpolate missing metric values.",
    "- Do not claim statistical significance without running the test.",
    "",
    "## Allowed Budgeted Passes",
    "- permitted extra pass(es) within budget: one adjudication pass for ambiguous records.",
    "- total budget guardrail: keep the full comparison within the stated workstation budget.",
    "",
    "## Paper Ceiling If Evidence Remains Weak",
    "Cap the output at research_memo if the comparator set or quantitative evidence remains too weak.",
    "",
    "## Minimum Experiment Plan",
    "- one baseline run: reference_condition on the held-out records.",
    "- one proposed or alternative condition: candidate_condition on the same records.",
    "- one result table: primary_score, uncertainty, and runtime by condition.",
    "- one limitation note: single-collection scope.",
    "- one claim->evidence mapping: link each conclusion to the result table or cited literature.",
    "",
    "## Paper-worthiness Gate",
    "- Is the research question explicit? yes.",
    "- Is the related work sufficient to position the study? yes, if paper collection yields comparator families.",
    "- Is there at least one explicit baseline? yes.",
    "- Is there at least one real executed experiment? yes.",
    "- Is there at least one quantitative comparison? yes.",
    "- Can major claims be traced to evidence? yes.",
    "- Are limitations stated? yes.",
    "",
    "## Failure Conditions",
    "- No usable public benchmark can be run within budget.",
    "- No meaningful baseline can be implemented fairly.",
    "- The experiment only proves the pipeline runs.",
    "- Results are too weak to support the intended claim.",
    "",
    "## Manuscript Format",
    "- Columns: 2",
    "- Main body pages: 8",
    "- References excluded from page limit: yes",
    "- Appendices excluded from page limit: yes",
    "",
    "## Notes",
    "Keep the broad topic fixed while allowing the hypothesis to evolve.",
    "",
    "## Questions / Risks",
    "- Will a simpler reference procedure dominate the candidate intervention?"
  ].join("\n");
}

function minimalBrief(): string {
  return [
    "# Research Brief",
    "",
    "## Topic",
    "Some research topic here.",
    "",
    "## Objective Metric",
    "macro-F1"
  ].join("\n");
}

function partialBrief(): string {
  return [
    "# Research Brief",
    "",
    "## Topic",
    "Controlled intervention comparison on a public evaluation collection.",
    "",
    "## Objective Metric",
    "- Primary metric: primary_score.",
    "- What counts as meaningful improvement: +0.02 over the reference condition.",
    "",
    "## Constraints",
    "- compute/time budget: keep evaluation within one workstation session.",
    "",
    "## Plan",
    "Compare a reference condition against one candidate condition on a small public collection.",
    "",
    "## Research Question",
    "Can the candidate condition outperform the reference condition under a fixed budget?",
    "",
    "## Baseline / Comparator",
    "- baseline name: reference_condition.",
    "",
    "## Dataset / Task / Bench",
    "- dataset(s): public_evaluation_collection.",
    "",
    "## Target Comparison",
    "- proposed method or condition: candidate_condition.",
    "- comparator or baseline: reference_condition.",
    "",
    "## Minimum Acceptable Evidence",
    "- minimum effect size or decision boundary: +1 point.",
    "",
    "## Failure Conditions",
    "- The experiment only proves the pipeline runs."
  ].join("\n");
}

function malformedBrief(): string {
  return "This is just plain text with no headings at all.";
}

describe("validateResearchBriefDraftMarkdown", () => {
  it("allows a topic-only working draft", () => {
    const result = validateResearchBriefDraftMarkdown([
      "# Research Brief",
      "",
      "## Topic",
    "A bounded comparison between a reference and candidate procedure."
    ].join("\n"));
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("requires a substantive topic before a draft is considered usable", () => {
    const result = validateResearchBriefDraftMarkdown(buildResearchBriefTemplate());
    expect(result.errors).toEqual([
      'Replace the placeholder text in "## Topic" before using the brief as a working draft.'
    ]);
  });
});

describe("validateResearchBriefMarkdown", () => {
  it("validates a full paper-scale brief with no errors", () => {
    const result = validateResearchBriefMarkdown(fullBrief());
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("rejects an explicitly unsupported research mode instead of silently changing modes", () => {
    const brief = fullBrief().replace(
      "## Topic",
      "## Research Mode\nautomatic selection\n\n## Topic"
    );

    const result = validateResearchBriefMarkdown(brief);

    expect(result.errors).toContain(
      'Set "## Research Mode" to either "hypothesis_test" or "topic_discovery".'
    );
  });

  it("blocks topic discovery when the explicit scientific scope is missing", () => {
    const brief = fullBrief().replace(
      "## Topic",
      "## Research Mode\ntopic_discovery\n\n## Topic"
    );

    const result = validateResearchBriefMarkdown(brief);
    const completeness = buildBriefCompletenessArtifact(brief);

    expect(result.errors).toContain(
      'Fill in the "## Scientific Scope" section before starting a topic-discovery run.'
    );
    expect(completeness.missing_sections).toContain("Scientific Scope");
    expect(completeness.contract_ready).toBe(false);
  });

  it("accepts a role-valid explicit scientific scope for topic discovery", () => {
    const brief = fullBrief().replace(
      "## Topic",
      [
        "## Research Mode",
        "topic_discovery",
        "",
        "## Scientific Scope",
        "### Scientific Object",
        "- configured evaluation decisions",
        "",
        "### Empirical Problems",
        "- decision stability under finite evidence",
        "- uncertainty calibration under dependent units",
        "",
        "### Prior-Work Probes",
        "- whether adaptive evaluation already subsumes the question",
        "",
        "## Topic"
      ].join("\n")
    );

    const result = validateResearchBriefMarkdown(brief);
    const completeness = buildBriefCompletenessArtifact(brief);

    expect(result.errors).toHaveLength(0);
    expect(completeness.sections.scientificScope.substantive).toBe(true);
    expect(completeness.missing_sections).not.toContain("Scientific Scope");
    expect(completeness.contract_ready).toBe(true);
  });

  it("blocks a minimal brief that omits required paper-scale sections", () => {
    const result = validateResearchBriefMarkdown(minimalBrief());
    expect(result.errors).not.toHaveLength(0);
    expect(result.errors.some((error) => error.includes("Constraints"))).toBe(true);
    expect(result.errors.some((error) => error.includes("Research Question"))).toBe(true);
    expect(result.errors.some((error) => error.includes("Baseline / Comparator"))).toBe(true);
    expect(result.errors.some((error) => error.includes("Failure Conditions"))).toBe(true);
  });

  it("blocks the generated template until placeholder sections are replaced", () => {
    const result = validateResearchBriefMarkdown(buildResearchBriefTemplate());
    expect(result.errors.some((error) => error.includes("Replace the placeholder text"))).toBe(true);
    expect(result.errors.some((error) => error.includes("Topic"))).toBe(true);
    expect(result.errors.some((error) => error.includes("Objective Metric"))).toBe(true);
    expect(result.errors.some((error) => error.includes("Minimum Experiment Plan"))).toBe(true);
  });

  it("produces errors for malformed brief", () => {
    const result = validateResearchBriefMarkdown(malformedBrief());
    expect(result.errors.length).toBeGreaterThanOrEqual(10);
  });

  it("accepts heading variations for the new paper-scale sections", () => {
    const brief = [
      "# Research Brief",
      "",
      "## Topic",
      "A substantive topic for a small real experiment.",
      "",
      "## Objective",
      "A metric with a real threshold.",
      "",
      "## Constraints",
      "A reproducible workstation budget.",
      "",
      "## Plan",
      "Compare one proposal against one baseline.",
      "",
      "## Research Question",
      "Can the proposal outperform the baseline?",
      "",
      "## Why This Can Be Tested With A Small Experiment",
      "The task is public and the comparison is small.",
      "",
      "## Baseline Comparator",
      "Reference condition versus one candidate condition.",
      "",
      "## Dataset / Task / Benchmark",
      "A public held-out evaluation collection.",
      "",
      "## Comparison",
      "Candidate versus reference on primary_score.",
      "",
      "## Minimum Evidence",
      "One shared evaluation slice plus a quantitative threshold.",
      "",
      "## Forbidden Shortcuts",
      "No cherry-picking.",
      "",
      "## Budgeted Passes",
      "One verifier pass.",
      "",
      "## Paper Ceiling",
      "Cap at research_memo if evidence is weak.",
      "",
      "## Minimum Experiment Plan",
      "Run baseline and proposal, then emit a result table.",
      "",
      "## Paper Readiness Gate",
      "Yes, once evidence exists and limitations are stated.",
      "",
      "## Failure Conditions",
      "Fail if the run only validates the workflow."
    ].join("\n");

    const result = validateResearchBriefMarkdown(brief);
    expect(result.errors).toHaveLength(0);
  });
});

describe("parseMarkdownRunBriefSections", () => {
  it("parses the full paper-scale section set", () => {
    const sections = parseMarkdownRunBriefSections(fullBrief());
    expect(sections).toBeDefined();
    expect(sections!.researchQuestion).toContain("candidate intervention");
    expect(sections!.whySmallExperiment).toContain("evaluation collection");
    expect(sections!.baselineComparator).toContain("reference_condition");
    expect(sections!.datasetTaskBench).toContain("public_evaluation_collection");
    expect(sections!.targetComparison).toContain("candidate_condition");
    expect(sections!.minimumExperimentPlan).toContain("one baseline run");
    expect(sections!.paperWorthinessGate).toContain("quantitative comparison");
    expect(sections!.failureConditions).toContain("pipeline runs");
  });

  it("returns undefined for missing extended sections in a minimal brief", () => {
    const sections = parseMarkdownRunBriefSections(minimalBrief());
    expect(sections).toBeDefined();
    expect(sections!.researchQuestion).toBeUndefined();
    expect(sections!.baselineComparator).toBeUndefined();
    expect(sections!.datasetTaskBench).toBeUndefined();
    expect(sections!.minimumExperimentPlan).toBeUndefined();
    expect(sections!.paperWorthinessGate).toBeUndefined();
    expect(sections!.failureConditions).toBeUndefined();
  });
});

describe("buildBriefCompletenessArtifact", () => {
  it("grades a full brief as complete", () => {
    const artifact = buildBriefCompletenessArtifact(fullBrief());
    expect(artifact.grade).toBe("complete");
    expect(artifact.paper_scale_ready).toBe(true);
    expect(artifact.missing_sections).toHaveLength(0);
    expect(artifact.sections.researchQuestion.substantive).toBe(true);
    expect(artifact.sections.minimumExperimentPlan.substantive).toBe(true);
  });

  it("grades a minimal brief as minimal and lists incomplete required sections", () => {
    const artifact = buildBriefCompletenessArtifact(minimalBrief());
    expect(artifact.grade).toBe("minimal");
    expect(artifact.paper_scale_ready).toBe(false);
    expect(artifact.missing_sections).toEqual(
      expect.arrayContaining([
        "Constraints",
        "Research Question",
        "Baseline / Comparator",
        "Minimum Experiment Plan",
        "Failure Conditions"
      ])
    );
  });

  it("grades a partial brief correctly", () => {
    const artifact = buildBriefCompletenessArtifact(partialBrief());
    expect(artifact.grade).toBe("partial");
    expect(artifact.paper_scale_ready).toBe(false);
    expect(artifact.sections.targetComparison.substantive).toBe(true);
    expect(artifact.sections.minimumAcceptableEvidence.substantive).toBe(true);
    expect(artifact.sections.paperWorthinessGate.present).toBe(false);
  });

  it("treats the generated template as non-substantive", () => {
    const artifact = buildBriefCompletenessArtifact(buildResearchBriefTemplate());
    expect(artifact.sections.topic.present).toBe(true);
    expect(artifact.sections.topic.substantive).toBe(false);
    expect(artifact.sections.objectiveMetric.present).toBe(true);
    expect(artifact.sections.objectiveMetric.substantive).toBe(false);
    expect(artifact.grade).toBe("minimal");
    expect(artifact.paper_scale_ready).toBe(false);
  });

  it("handles malformed input gracefully", () => {
    const artifact = buildBriefCompletenessArtifact(malformedBrief());
    expect(artifact.grade).toBe("minimal");
    expect(artifact.paper_scale_ready).toBe(false);
    expect(artifact.missing_sections.length).toBeGreaterThanOrEqual(10);
  });
});
