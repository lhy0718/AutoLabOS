import path from "node:path";
import { tmpdir } from "node:os";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryEventStream } from "../src/core/events.js";
import { MockLLMClient } from "../src/core/llm/client.js";
import { createWritePaperNode } from "../src/core/nodes/writePaper.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import type { RunRecord } from "../src/types.js";
import { seedValidNonIndependentReviewAssurance } from "./helpers/reviewAssuranceFixture.js";

const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
});

describe("review-before-writing governance", () => {
  it("keeps a bounded topic-probe parent outside paper drafting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-before-bounded-parent-"));
    process.chdir(root);
    const run = makeRun("run-review-before-bounded-parent");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await seedValidWritePaperInputs(runDir);
    await mkdir(path.join(runDir, "brief"), { recursive: true });
    await mkdir(path.join(runDir, "hypothesis_generation"), { recursive: true });
    const topicDiscoveryBrief = [
      "# Research Brief",
      "",
      "## Research Mode",
      "topic_discovery",
      "",
      "## Topic",
      "Bounded candidate evaluation."
    ].join("\n");
    await writeFile(
      path.join(runDir, "memory", "run_context.json"),
      JSON.stringify({
        version: 1,
        items: [{ key: "run_brief.raw", value: topicDiscoveryBrief }]
      }),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "brief", "source_brief.md"),
      `${topicDiscoveryBrief}\n`,
      "utf8"
    );
    await writeFile(
      path.join(runDir, "hypothesis_generation", "topic_portfolio.json"),
      "{}\n",
      "utf8"
    );

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("bounded_probe_parent_cannot_draft_paper");
    await expect(access(path.join(runDir, "paper", "main.tex"))).rejects.toThrow();
  });

  it("blocks write_paper before drafting when governed workflow config has no pre-draft critique", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-before-writing-"));
    process.chdir(root);
    const run = makeRun("run-review-before-writing");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await seedValidWritePaperInputs(runDir);

    const node = createWritePaperNode({
      config: {
        workflow: {
          mode: "agent_approval",
          wizard_enabled: true,
          approval_mode: "minimal",
          execution_approval_mode: "manual"
        },
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("review/paper_critique.json is required before drafting");
    const eligibility = JSON.parse(
      await readFile(path.join(runDir, "paper", "write_paper_eligibility.json"), "utf8")
    ) as { allowed: boolean; reason: string };
    expect(eligibility.allowed).toBe(false);
    await expect(access(path.join(runDir, "paper", "main.tex"))).rejects.toThrow();
  });

  it("enforces the V2 result artifact after the pre-draft critique gate passes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-before-results-"));
    process.chdir(root);
    const run = makeRun("run-review-before-results");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await seedValidWritePaperInputs(runDir);
    await mkdir(path.join(runDir, "review"), { recursive: true });
    await writeFile(
      path.join(runDir, "review", "paper_critique.json"),
      JSON.stringify({
        stage: "pre_draft_review",
        generated_at: new Date().toISOString(),
        manuscript_type: "paper_scale_candidate",
        overall_decision: "advance",
        overall_score: 4,
        confidence: 0.9,
        blocking_issues_count: 0,
        non_blocking_issues_count: 0,
        category_scores: [],
        blocking_issues: [],
        non_blocking_issues: [],
        transition_recommendation: "advance",
        paper_readiness_state: "paper_scale_candidate",
        downgrade_reason: null,
        manuscript_claim_risk_summary: "No pre-draft blockers.",
        needs_additional_experiments: false,
        needs_additional_statistics: false,
        needs_additional_related_work: false,
        needs_design_revision: false
      }),
      "utf8"
    );
    await seedValidNonIndependentReviewAssurance({ workspaceRoot: root, run });
    run.graph.checkpointSeq += 2;

    const node = createWritePaperNode({
      config: {
        workflow: {
          mode: "agent_approval",
          wizard_enabled: true,
          approval_mode: "minimal",
          execution_approval_mode: "manual"
        },
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("requires AnalysisReport.results_artifact V2");
    const eligibility = JSON.parse(
      await readFile(path.join(runDir, "paper", "write_paper_eligibility.json"), "utf8")
    ) as { allowed: boolean };
    expect(eligibility.allowed).toBe(true);
    await expect(access(path.join(runDir, "paper", "main.tex"))).rejects.toThrow();
  });
  it("blocks drafting when the review handoff critique changes after review", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-handoff-tamper-"));
    process.chdir(root);
    const run = makeRun("run-review-handoff-tamper");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await seedValidWritePaperInputs(runDir);
    await seedValidNonIndependentReviewAssurance({ workspaceRoot: root, run });
    const critiquePath = path.join(runDir, "review", "paper_critique.json");
    const critique = JSON.parse(await readFile(critiquePath, "utf8")) as Record<string, unknown>;
    critique.manuscript_claim_risk_summary = "Changed after review.";
    await writeFile(critiquePath, JSON.stringify(critique), "utf8");

    const node = createWritePaperNode({
      config: {
        workflow: {
          mode: "agent_approval",
          wizard_enabled: true,
          approval_mode: "minimal",
          execution_approval_mode: "manual"
        },
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "review_handoff_paper_critique_binding_mismatch"
    );
    const eligibility = JSON.parse(
      await readFile(path.join(runDir, "paper", "write_paper_eligibility.json"), "utf8")
    ) as {
      allowed: boolean;
      review_assurance_reason_codes: string[];
    };
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.review_assurance_reason_codes).toContain(
      "review_handoff_paper_critique_binding_mismatch"
    );
    await expect(access(path.join(runDir, "paper", "main.tex"))).rejects.toThrow();
  });

});

function makeRun(runId: string): RunRecord {
  return {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Review Before Writing",
    topic: "governed research workflow",
    constraints: [],
    objectiveMetric: "accuracy",
    status: "running",
    currentNode: "write_paper",
    latestSummary: undefined,
    nodeThreads: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    graph: createDefaultGraphState(),
    memoryRefs: {
      runContextPath: `.autolabos/runs/${runId}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${runId}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${runId}/memory/episodes.jsonl`
    }
  };
}

async function seedValidWritePaperInputs(runDir: string): Promise<void> {
  await mkdir(path.join(runDir, "memory"), { recursive: true });
  await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
  await writeFile(
    path.join(runDir, "paper_summaries.jsonl"),
    `${JSON.stringify({
      paper_id: "paper_1",
      title: "Governed Writing",
      source_type: "full_text",
      summary: "Review gates prevent unsupported paper-ready claims.",
      key_findings: ["Review gates prevent unsupported paper-ready claims."],
      limitations: ["Small fixture."],
      datasets: ["fixture"],
      metrics: ["accuracy"],
      novelty: "governed workflow",
      reproducibility_notes: ["fixture"]
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(runDir, "evidence_store.jsonl"),
    `${JSON.stringify({
      evidence_id: "ev_1",
      paper_id: "paper_1",
      claim: "Review gates prevent unsupported paper-ready claims.",
      evidence_span: "Review gates prevent unsupported paper-ready claims.",
      source_type: "full_text",
      confidence: 0.8
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(runDir, "hypotheses.jsonl"),
    `${JSON.stringify({
      hypothesis_id: "h_1",
      text: "Review-before-writing improves claim discipline.",
      evidence_links: ["ev_1"]
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(runDir, "corpus.jsonl"),
    `${JSON.stringify({
      paper_id: "paper_1",
      title: "Governed Writing",
      abstract: "Review gates prevent unsupported paper-ready claims.",
      authors: ["Test Author"],
      year: 2026,
      venue: "TestConf"
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(runDir, "experiment_plan.yaml"),
    ["selected_design:", '  title: "Review gate fixture"', '  summary: "Check review-before-writing enforcement."'].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(runDir, "result_analysis.json"),
    JSON.stringify({
      overview: {
        objective_status: "met",
        objective_summary: "Fixture objective met.",
        execution_runs: 1
      },
      primary_findings: [
        {
          id: "f1",
          title: "Review gate fixture",
          finding: "Review gate fixture generated.",
          confidence: 0.8,
          source: "fixture"
        }
      ],
      condition_comparisons: [],
      paper_claims: [],
      limitations: [],
      warnings: [],
      shortlisted_designs: [],
      recommendations: []
    }),
    "utf8"
  );
}
