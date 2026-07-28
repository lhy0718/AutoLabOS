import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractRunBrief,
  looksLikeRunBriefRequest,
  parseDeclaredResearchRunMode,
  parseMarkdownRunBriefSections,
  parseResearchRunMode,
  summarizeRunBrief
} from "../src/core/runs/runBriefParser.js";

describe("runBriefParser", () => {
  const originalRunBriefTimeout = process.env.AUTOLABOS_RUN_BRIEF_TIMEOUT_MS;

  afterEach(() => {
    if (originalRunBriefTimeout === undefined) {
      delete process.env.AUTOLABOS_RUN_BRIEF_TIMEOUT_MS;
    } else {
      process.env.AUTOLABOS_RUN_BRIEF_TIMEOUT_MS = originalRunBriefTimeout;
    }
  });

  it("parses an explicit research mode and defaults only when the mode is absent", () => {
    const discoveryBrief = [
      "# Research Brief",
      "",
      "## Research Mode",
      "topic discovery",
      "",
      "## Topic",
      "A broad, governed search scope."
    ].join("\n");
    const invalidBrief = discoveryBrief.replace("topic discovery", "automatic selection");

    expect(parseDeclaredResearchRunMode(discoveryBrief)).toBe("topic_discovery");
    expect(parseResearchRunMode(discoveryBrief)).toBe("topic_discovery");
    expect(
      parseDeclaredResearchRunMode(discoveryBrief.replace("topic discovery", "`topic_discovery`"))
    ).toBe("topic_discovery");
    expect(parseDeclaredResearchRunMode(invalidBrief)).toBeUndefined();
    expect(parseResearchRunMode("# Research Brief\n\n## Topic\nA concrete hypothesis.")).toBe("hypothesis_test");
  });

  it("preserves role headings inside an explicit scientific scope section", () => {
    const sections = parseMarkdownRunBriefSections([
      "# Research Brief",
      "",
      "## Scientific Scope",
      "### Scientific Object",
      "- document ranking",
      "",
      "### Empirical Problems",
      "- ranking stability under annotation disagreement"
    ].join("\n"));

    expect(sections?.scientificScope).toContain("### Scientific Object");
    expect(sections?.scientificScope).toContain("### Empirical Problems");
  });

  it("detects natural-language run brief requests", () => {
    expect(looksLikeRunBriefRequest("새 연구를 시작해줘\n주제: 구성된 방법 비교")).toBe(true);
    expect(looksLikeRunBriefRequest("Start a new research run on a configured method comparison")).toBe(true);
    expect(looksLikeRunBriefRequest("How many papers did we collect?")).toBe(false);
  });

  it("extracts structured fields heuristically from a labeled brief", async () => {
    const extracted = await extractRunBrief({
      brief: [
        "새 연구를 시작해줘",
        "주제: 구성된 방법의 반복 비교",
        "목표: primary_score improvement over reference",
        "제약: 최근 3년 논문, 오픈소스 코드만, 8시간 이내",
        "계획: 공개 평가 자료에서 reference와 candidate_a를 비교"
      ].join("\n"),
      defaults: {
        topic: "default topic",
        constraints: ["default constraint"],
        objectiveMetric: "default metric"
      }
    });

    expect(extracted).toMatchObject({
      topic: "구성된 방법의 반복 비교",
      objectiveMetric: "primary_score improvement over reference",
      constraints: ["최근 3년 논문", "오픈소스 코드만", "8시간 이내"],
      planSummary: "공개 평가 자료에서 reference와 candidate_a를 비교",
      source: "heuristic_fallback"
    });
    expect(extracted.assumptions).toEqual([]);
    expect(summarizeRunBrief(extracted)).toEqual(
      expect.arrayContaining([
        "Topic: 구성된 방법의 반복 비교",
        "Objective: primary_score improvement over reference",
        "Plan hint: 공개 평가 자료에서 reference와 candidate_a를 비교"
      ])
    );
  });

  it("preserves markdown bullet constraints in heuristic fallback", async () => {
    const extracted = await extractRunBrief({
      brief: [
        "# Research Brief",
        "",
        "## Topic",
        "",
        "Configured method comparison on a public evaluation collection.",
        "",
        "## Constraints",
        "",
        "- Prefer CPU-only execution and lightweight Python dependencies.",
        "- Avoid large downloads, accelerator-specific methods, and heavy preprocessing pipelines.",
        "- Use a fixed train/validation/test protocol and report primary_score, runtime, and memory consistently."
      ].join("\n"),
      defaults: {
        topic: "default topic",
        constraints: ["default constraint"],
        objectiveMetric: "default metric"
      }
    });

    expect(extracted.source).toBe("heuristic_fallback");
    expect(extracted.constraints).toEqual([
      "Prefer CPU-only execution and lightweight Python dependencies.",
      "Avoid large downloads, accelerator-specific methods, and heavy preprocessing pipelines.",
      "Use a fixed train/validation/test protocol and report primary_score, runtime, and memory consistently."
    ]);
  });

  it("prefers the LLM extraction when valid JSON is returned", async () => {
    const llm = {
      runForText: vi.fn(async () =>
        [
          "```json",
          JSON.stringify({
            topic: "Configured evaluation pipeline",
            objective_metric: "primary_score >= 0.8",
            constraints: ["latest papers", "bounded local compute"],
            plan_summary: "Compare reference, candidate, and confirmatory runs.",
            assumptions: ["Assumed the evaluation collection is public."]
          }),
          "```"
        ].join("\n")
      )
    };

    const extracted = await extractRunBrief({
      brief: "Start a new research run for evaluation planning.",
      defaults: {
        topic: "default topic",
        constraints: ["default constraint"],
        objectiveMetric: "default metric"
      },
      llm
    });

    expect(llm.runForText).toHaveBeenCalledOnce();
    expect(extracted).toMatchObject({
      topic: "Configured evaluation pipeline",
      objectiveMetric: "primary_score >= 0.8",
      constraints: ["latest papers", "bounded local compute"],
      planSummary: "Compare reference, candidate, and confirmatory runs.",
      assumptions: ["Assumed the evaluation collection is public."],
      source: "llm"
    });
  });

  it("keeps an explicit topic from the brief even when the llm narrows it", async () => {
    const llm = {
      runForText: vi.fn(async () =>
        JSON.stringify({
          topic: "Budget-qualified candidate comparison on a small public evaluation collection",
          objective_metric: "primary_score",
          constraints: ["bounded local compute"],
          plan_summary: "Compare the declared candidate set.",
          assumptions: []
        })
      )
    };

    const extracted = await extractRunBrief({
      brief: [
        "# Research Brief",
        "",
        "## Topic",
        "",
        "Configured method comparison on a public evaluation collection.",
        "",
        "## Constraints",
        "",
        "- Prefer CPU-only execution and lightweight Python dependencies.",
        "- Avoid large downloads, accelerator-specific methods, and heavy preprocessing pipelines."
      ].join("\n"),
      defaults: {
        topic: "default topic",
        constraints: ["default constraint"],
        objectiveMetric: "default metric"
      },
      llm
    });

    expect(extracted.source).toBe("llm");
    expect(extracted.topic).toBe("Configured method comparison on a public evaluation collection.");
    expect(extracted.constraints).toEqual([
      "Prefer CPU-only execution and lightweight Python dependencies.",
      "Avoid large downloads, accelerator-specific methods, and heavy preprocessing pipelines."
    ]);
    expect(extracted.planSummary).toBe("Compare the declared candidate set.");
  });

  it("keeps the broader brief topic when the llm injects constraint qualifiers into an unlabeled brief", async () => {
    const llm = {
      runForText: vi.fn(async () =>
        JSON.stringify({
          topic: "Resource-aware configured method comparison under bounded local compute",
          objective_metric: "primary_score over reference",
          constraints: ["CPU-only execution"],
          plan_summary: "Compare the declared candidate set.",
          assumptions: []
        })
      )
    };

    const extracted = await extractRunBrief({
      brief: [
        "Start a new research run on configured method comparison.",
        "Objective: improve primary_score over a declared reference while preserving reproducible local runtime and memory efficiency.",
        "Constraints: CPU-only execution, lightweight Python dependencies."
      ].join("\n"),
      defaults: {
        topic: "default topic",
        constraints: ["default constraint"],
        objectiveMetric: "default metric"
      },
      llm
    });

    expect(extracted.source).toBe("llm");
    expect(extracted.topic).toBe("configured method comparison.");
    expect(extracted.assumptions).toContain(
      "Preserved broader topic wording from the brief for literature collection stability."
    );
  });

  it("recovers inline bullet-like constraints without fragmenting comma-rich items", async () => {
    const extracted = await extractRunBrief({
      brief: [
        "# Research Brief",
        "",
        "## Topic",
        "",
        "Configured method comparison on a public evaluation collection.",
        "",
        "## Constraints",
        "",
        "Prefer CPU-only execution and lightweight dependencies. - Avoid large downloads, accelerator-specific methods, and heavy preprocessing pipelines. - Use a fixed train/validation/test protocol and report primary_score, runtime, and memory consistently."
      ].join("\n"),
      defaults: {
        topic: "default topic",
        constraints: ["default constraint"],
        objectiveMetric: "default metric"
      }
    });

    expect(extracted.constraints).toEqual([
      "Prefer CPU-only execution and lightweight dependencies.",
      "Avoid large downloads, accelerator-specific methods, and heavy preprocessing pipelines.",
      "Use a fixed train/validation/test protocol and report primary_score, runtime, and memory consistently."
    ]);
  });

  it("falls back heuristically when the run-brief llm hangs", async () => {
    process.env.AUTOLABOS_RUN_BRIEF_TIMEOUT_MS = "5";

    const llm = {
      runForText: vi.fn(async () => await new Promise<string>(() => {}))
    };

    const extracted = await extractRunBrief({
      brief: [
        "# Research Brief",
        "",
        "## Topic",
        "",
        "Configured method comparison under a bounded budget.",
        "",
        "## Objective Metric",
        "",
        "Average primary_score on the declared evaluation partitions",
        "",
        "## Constraints",
        "",
        "- Use a bounded real experiment.",
        "- Keep seed 42 fixed."
      ].join("\n"),
      defaults: {
        topic: "default topic",
        constraints: ["default constraint"],
        objectiveMetric: "default metric"
      },
      llm
    });

    expect(extracted.source).toBe("heuristic_fallback");
    expect(extracted.topic).toBe("Configured method comparison under a bounded budget.");
    expect(extracted.objectiveMetric).toBe("Average primary_score on the declared evaluation partitions");
    expect(extracted.constraints).toEqual([
      "Use a bounded real experiment.",
      "Keep seed 42 fixed."
    ]);
  });
});
