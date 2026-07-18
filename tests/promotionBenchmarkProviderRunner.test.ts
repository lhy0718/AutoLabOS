import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";
import {
  runPromotionBenchmarkProvider,
  type PromotionProviderClient
} from "../src/core/benchmark/promotionBenchmarkProviderRunner.js";

const tempDirs: string[] = [];
const originalFakeResponse = process.env.AUTOLABOS_FAKE_OPENAI_RESPONSE;

afterEach(async () => {
  if (originalFakeResponse === undefined) delete process.env.AUTOLABOS_FAKE_OPENAI_RESPONSE;
  else process.env.AUTOLABOS_FAKE_OPENAI_RESPONSE = originalFakeResponse;
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion benchmark provider runner", () => {
  it("persists hash-bound external outputs, usage, and complete predictions", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    let index = 0;
    const responseIds: string[] = [];
    const client: PromotionProviderClient = {
      complete: vi.fn(async () => {
        index += 1;
        const responseId = `response-private-${index}`;
        responseIds.push(responseId);
        return {
          text: JSON.stringify({
            decision: "needs_review",
            concerns: [{
              code: "manuscript_evidence_uncertain",
              severity: "warning",
              evidence_refs: ["manuscript"]
            }],
            repair_owners: ["review"]
          }),
          responseId,
          model: "gpt-5.4",
          usage: { inputTokens: 10 + index, outputTokens: 4, costUsd: 0.002 * index }
        };
      })
    };

    const result = await runPromotionBenchmarkProvider(providerInput(workspace, suitePath, "provider-run"), client);

    expect(result.manifest).toMatchObject({
      schema_version: "1.1",
      status: "completed",
      evidence_class: "external_real_provider",
      provider_receipt_status: "recorded_not_independently_verified",
      provider_identity_independently_verified: false,
      external_empirical_evidence_eligible: true,
      paper_claim_evidence_eligible: false,
      independent_trial_requirement_met: false,
      source_suite: {
        evidence_class: "unspecified",
        paper_claim_eligible: false,
        manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        snapshot_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      },
      request_count: 2,
      completed_response_count: 2,
      failed_response_count: 0,
      usage: {
        input_tokens: 23,
        output_tokens: 8,
        cost_usd: 0.006
      }
    });
    expect(result.manifest.artifacts).toMatchObject({
      provider_outputs_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      provider_responses_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      predictions_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      failures_sha256: null
    });
    const outputText = await readFile(path.join(workspace, "provider-run", "provider-outputs.jsonl"), "utf8");
    for (const responseId of responseIds) expect(outputText).not.toContain(responseId);
    expect(outputText).toContain(createHash("sha256").update(responseIds[0]).digest("hex"));
    const predictions = (await readFile(path.join(workspace, result.predictions_path), "utf8")).trim().split("\n");
    expect(predictions).toHaveLength(2);
    expect(predictions.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        system_id: "manuscript-reviewer",
        trial_id: "trial-alpha",
        decision: "needs_review"
      })
    ]));
    const requestsText = await readFile(path.join(workspace, "provider-run", "prompt-pack", "requests.jsonl"), "utf8");
    const requestMap = JSON.parse(
      await readFile(path.join(workspace, "provider-run", "prompt-pack", "private-request-map.json"), "utf8")
    ) as { requests_sha256: string };
    expect(requestMap.requests_sha256).toBe(createHash("sha256").update(requestsText).digest("hex"));

    await expect(runPromotionBenchmarkProvider(providerInput(workspace, suitePath, "provider-run"), client))
      .rejects.toThrow("output already exists");
  });

  it("preserves partial artifacts and withholds predictions after malformed output", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    let index = 0;
    const client: PromotionProviderClient = {
      complete: async () => {
        index += 1;
        return {
          text: index === 1
            ? JSON.stringify({ decision: "promote", concerns: [], repair_owners: [] })
            : "not-json"
        };
      }
    };

    await expect(runPromotionBenchmarkProvider({
      ...providerInput(workspace, suitePath, "failed-run"),
      evidenceClass: "test_fixture"
    }, client)).rejects.toThrow("partial artifacts were preserved");

    const manifest = JSON.parse(
      await readFile(path.join(workspace, "failed-run", "provider-run-manifest.json"), "utf8")
    );
    expect(manifest).toMatchObject({
      status: "failed",
      external_empirical_evidence_eligible: false,
      paper_claim_evidence_eligible: false,
      completed_response_count: 1,
      failed_response_count: 1,
      failure: {
        error_name: "Error",
        message: expect.stringContaining("not one JSON object")
      }
    });
    const responses = (await readFile(path.join(workspace, "failed-run", "provider-responses.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(responses).toHaveLength(1);
    await expect(stat(path.join(workspace, "failed-run", "predictions", "predictions.jsonl"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects fake response environments for external evidence before creating output", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    process.env.AUTOLABOS_FAKE_OPENAI_RESPONSE = "{}";
    const client: PromotionProviderClient = {
      complete: vi.fn(async () => ({ text: "{}" }))
    };

    await expect(runPromotionBenchmarkProvider(providerInput(workspace, suitePath, "fake-run"), client))
      .rejects.toThrow("rejects fake response environment");
    expect(client.complete).not.toHaveBeenCalled();
    await expect(stat(path.join(workspace, "fake-run"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a source suite outside the provider workspace", async () => {
    const workspace = await createWorkspace();
    const sourceWorkspace = await createWorkspace();
    const suitePath = await createSuite(sourceWorkspace);
    const client: PromotionProviderClient = {
      complete: vi.fn(async () => ({ text: "{}" }))
    };

    await expect(runPromotionBenchmarkProvider(
      providerInput(workspace, path.join(sourceWorkspace, suitePath), "outside-suite-run"),
      client
    )).rejects.toThrow("Promotion suite must be inside the workspace");
    expect(client.complete).not.toHaveBeenCalled();
    await expect(stat(path.join(workspace, "outside-suite-run"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails external evidence when provider provenance or usage is missing", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    const client: PromotionProviderClient = {
      complete: async () => ({
        text: JSON.stringify({ decision: "promote", concerns: [], repair_owners: [] })
      })
    };

    await expect(runPromotionBenchmarkProvider(providerInput(workspace, suitePath, "missing-provenance"), client))
      .rejects.toThrow("response id is missing");
    const manifest = JSON.parse(
      await readFile(path.join(workspace, "missing-provenance", "provider-run-manifest.json"), "utf8")
    );
    expect(manifest).toMatchObject({
      status: "failed",
      completed_response_count: 0,
      failed_response_count: 1,
      external_empirical_evidence_eligible: false,
      paper_claim_evidence_eligible: false
    });

    const missingModelClient: PromotionProviderClient = {
      complete: async () => ({
        text: JSON.stringify({ decision: "promote", concerns: [], repair_owners: [] }),
        responseId: "response-private",
        usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.002 }
      })
    };
    await expect(runPromotionBenchmarkProvider(
      providerInput(workspace, suitePath, "missing-model"),
      missingModelClient
    )).rejects.toThrow("resolved model is missing");
  });
});

function providerInput(workspace: string, suitePath: string, outDir: string) {
  return {
    cwd: workspace,
    suitePath,
    outDir,
    provider: "openai_responses_api" as const,
    model: "gpt-5.4",
    reasoningEffort: "high",
    systemId: "manuscript-reviewer",
    trialId: "trial-alpha",
    evidenceClass: "external_real_provider" as const
  };
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-provider-runner-"));
  tempDirs.push(workspace);
  return workspace;
}

async function createSuite(workspace: string): Promise<string> {
  await mkdir(path.join(workspace, "bundle", "paper"), { recursive: true });
  await writeFile(
    path.join(workspace, "bundle", "paper", "main.tex"),
    "\\section{Results}\nA bounded comparison is reported.\n",
    "utf8"
  );
  await writeFile(
    path.join(workspace, "bundle", "result_table.json"),
    `${JSON.stringify([{ baseline: 0.6, comparator: 0.7 }])}\n`,
    "utf8"
  );
  await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
    schema_version: "1.0",
    suite_id: "provider-suite",
    cases: [
      {
        case_id: "case-control",
        base_bundle_id: "base-alpha",
        split: "test",
        source_root: "bundle",
        operations: [],
        gold: { decision: "promote", blocking_concerns: [], repair_owners: [] }
      },
      {
        case_id: "case-variant",
        base_bundle_id: "base-alpha",
        split: "test",
        source_root: "bundle",
        mutation_family: "comparison_evidence_gap",
        operations: [{ op: "remove_json_pointer", path: "result_table.json", pointer: "/0/comparator" }],
        gold: {
          decision: "block",
          blocking_concerns: ["baseline_or_comparator_missing"],
          repair_owners: ["design_experiments"]
        }
      }
    ]
  }), "utf8");
  const built = await buildPromotionBenchmarkSuite({
    cwd: workspace,
    recipePath: "recipe.json",
    outDir: "suite"
  });
  return built.suite_path;
}
