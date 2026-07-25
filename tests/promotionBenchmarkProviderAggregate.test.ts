import os from "node:os";
import path from "node:path";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { scorePromotionBenchmarkFromFiles } from "../src/core/benchmark/promotionBenchmark.js";
import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";
import { generateControlledPromotionBenchmark } from "../src/core/benchmark/promotionBenchmarkControlledCorpus.js";
import { aggregatePromotionBenchmarkProviderRuns } from "../src/core/benchmark/promotionBenchmarkProviderAggregate.js";
import {
  runPromotionBenchmarkProvider,
  type PromotionProviderClient
} from "../src/core/benchmark/promotionBenchmarkProviderRunner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion provider run aggregation", () => {
  it("verifies three distinct hash-bound trials and emits score-compatible predictions", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    const manifests = await createProviderRuns(workspace, suitePath, ["trial-a", "trial-b", "trial-c"]);

    const result = await aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: manifests,
      outDir: "aggregate"
    });

    expect(result.manifest).toMatchObject({
      schema_version: "1.3",
      status: "completed",
      evidence_class: "external_real_provider",
      execution_environment: "remote_api",
      execution_receipt_status: "recorded_not_independently_verified",
      provider_identity_independently_verified: false,
      external_empirical_evidence_eligible: true,
      real_model_empirical_evidence_eligible: true,
      paper_claim_evidence_eligible: false,
      receipt_distinct_trial_requirement_met: true,
      source_suite: {
        evidence_class: "unspecified",
        paper_claim_eligible: false,
        manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        snapshot_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      },
      case_count: 2,
      request_count_per_trial: 2,
      trial_count: 3,
      trial_ids: ["trial-a", "trial-b", "trial-c"],
      prediction_count: 6,
      usage: {
        input_tokens: 69,
        output_tokens: 24
      },
      receipt_distinctness: {
        distinct_run_ids: true,
        distinct_trial_ids: true,
        distinct_execution_receipts: true,
        identical_prompt_pack: true,
        statistical_independence_established: false,
        statistical_replicates: false
      }
    });
    expect(result.manifest.usage.cost_usd).toBeCloseTo(0.009, 12);
    expect(result.manifest.source_runs).toHaveLength(3);
    expect(result.manifest.artifacts.predictions_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const predictions = (await readFile(path.join(workspace, result.predictions_path), "utf8")).trim().split("\n");
    expect(predictions).toHaveLength(6);

    const score = await scorePromotionBenchmarkFromFiles({
      cwd: workspace,
      suitePath,
      predictionsPath: result.predictions_path,
      outDir: "score"
    });
    expect(score.report.passed).toBe(true);
    expect(score.report.systems).toEqual([
      expect.objectContaining({ system_id: "manuscript-reviewer", trial_count: 3, prediction_count: 6 })
    ]);
    await expect(aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: manifests,
      outDir: "aggregate"
    })).rejects.toThrow("output already exists");
  });

  it("aggregates three local real-model trials with one exact model digest", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    const manifests = await createLocalProviderRuns(workspace, suitePath);

    const result = await aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: manifests,
      outDir: "local-aggregate"
    });

    expect(result.manifest).toMatchObject({
      schema_version: "1.3",
      provider: "ollama_local",
      evidence_class: "local_real_model",
      execution_environment: "local_runtime",
      execution_receipt_status: "local_runtime_hash_bound",
      external_empirical_evidence_eligible: false,
      real_model_empirical_evidence_eligible: true,
      paper_claim_evidence_eligible: false,
      trial_count: 3,
      model_artifact_digest: `sha256:${"c".repeat(64)}`,
      receipt_distinctness: {
        distinct_execution_receipts: true,
        statistical_independence_established: false,
        statistical_replicates: false,
        caveat: expect.stringContaining("local runtime receipts")
      }
    });
  });

  it("aggregates three provider trials over an oracle-certified controlled suite", async () => {
    const workspace = await createWorkspace();
    const controlled = await generateControlledPromotionBenchmark({
      cwd: workspace,
      outDir: "controlled",
      seed: "provider-aggregate-controlled",
      developmentBaseBundleCount: 1,
      testBaseBundleCount: 1
    });
    const manifests = await createProviderRuns(
      workspace,
      controlled.certified_suite_path,
      ["controlled-a", "controlled-b", "controlled-c"],
      "controlled-provider"
    );

    const result = await aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath: controlled.certified_suite_path,
      runManifestPaths: manifests,
      outDir: "controlled-aggregate"
    });

    expect(result.manifest).toMatchObject({
      status: "completed",
      receipt_distinct_trial_requirement_met: true,
      source_suite: {
        evidence_class: "deterministic_fault_injection_test"
      },
      trial_count: 3
    });
  });

  it("accepts a verified resumed run and rejects attempt-ledger drift", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    let requestIndex = 0;
    const interruptedClient: PromotionProviderClient = {
      complete: async () => {
        requestIndex += 1;
        return {
          text: requestIndex === 1
            ? JSON.stringify({ decision: "needs_review", concerns: [], repair_owners: ["review"] })
            : "not-json",
          responseId: `interrupted-${requestIndex}`,
          model: "gpt-5.4",
          usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.001 }
        };
      }
    };
    const interruptedInput = {
      cwd: workspace,
      suitePath,
      outDir: "resumed-provider",
      provider: "openai_responses_api" as const,
      model: "gpt-5.4",
      reasoningEffort: "high",
      systemId: "manuscript-reviewer",
      trialId: "trial-a",
      evidenceClass: "external_real_provider" as const
    };
    await expect(runPromotionBenchmarkProvider(interruptedInput, interruptedClient))
      .rejects.toThrow("partial artifacts were preserved");
    const resumed = await runPromotionBenchmarkProvider({ ...interruptedInput, resume: true }, {
      complete: async () => ({
        text: JSON.stringify({ decision: "block", concerns: [], repair_owners: ["review"] }),
        responseId: "resumed-2",
        model: "gpt-5.4",
        usage: { inputTokens: 12, outputTokens: 5, costUsd: 0.001 }
      })
    });
    const cleanManifests = await createProviderRuns(
      workspace,
      suitePath,
      ["trial-b", "trial-c"],
      "resume-clean"
    );
    const manifests = [resumed.manifest_path, ...cleanManifests];

    const aggregate = await aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: manifests,
      outDir: "resumed-aggregate"
    });
    expect(aggregate.manifest.trial_count).toBe(3);

    await appendFile(
      path.join(workspace, "resumed-provider", "provider-attempt-failures.jsonl"),
      " ",
      "utf8"
    );
    await expect(aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: manifests,
      outDir: "tampered-resumed-aggregate"
    })).rejects.toThrow("attempt failures SHA-256 mismatch");
  });

  it("rejects tampering with a stale-checkpoint recovery preimage", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    const runRoot = path.join(workspace, "recovered-provider");
    let requestIndex = 0;
    const interruptedInput = {
      cwd: workspace,
      suitePath,
      outDir: "recovered-provider",
      provider: "openai_responses_api" as const,
      model: "gpt-5.4",
      reasoningEffort: "high",
      systemId: "manuscript-reviewer",
      trialId: "trial-a",
      evidenceClass: "external_real_provider" as const
    };
    await expect(runPromotionBenchmarkProvider(interruptedInput, {
      complete: async () => {
        requestIndex += 1;
        return {
          text: requestIndex === 1
            ? JSON.stringify({ decision: "needs_review", concerns: [], repair_owners: ["review"] })
            : "not-json",
          responseId: `interrupted-${requestIndex}`,
          model: "gpt-5.4",
          usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.001 }
        };
      }
    })).rejects.toThrow("partial artifacts were preserved");

    const manifestPath = path.join(runRoot, "provider-run-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.status = "running";
    manifest.completed_at = null;
    manifest.failed_response_count = 0;
    manifest.failure = null;
    manifest.artifacts.failures_sha256 = null;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await unlink(path.join(runRoot, "provider-failures.jsonl"));
    const staleTime = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(manifestPath, staleTime, staleTime);

    const recovered = await runPromotionBenchmarkProvider({ ...interruptedInput, resume: true }, {
      complete: async () => ({
        text: JSON.stringify({ decision: "block", concerns: [], repair_owners: ["review"] }),
        responseId: "resumed-2",
        model: "gpt-5.4",
        usage: { inputTokens: 12, outputTokens: 5, costUsd: 0.001 }
      })
    });
    const cleanManifests = await createProviderRuns(
      workspace,
      suitePath,
      ["trial-b", "trial-c"],
      "recovery-clean"
    );
    const manifests = [recovered.manifest_path, ...cleanManifests];
    await aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: manifests,
      outDir: "recovery-aggregate"
    });

    const attemptRow = JSON.parse((await readFile(
      path.join(runRoot, "provider-attempt-failures.jsonl"),
      "utf8"
    )).trim());
    expect(attemptRow.schema_version).toBe("1.1");
    await appendFile(path.join(workspace, attemptRow.prior_manifest_ref), " ", "utf8");
    await expect(aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: manifests,
      outDir: "tampered-recovery-aggregate"
    })).rejects.toThrow("attempt prior manifest SHA-256 mismatch");
  });

  it("rejects missing or duplicate trial manifests before creating output", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    const twoManifests = await createProviderRuns(workspace, suitePath, ["trial-a", "trial-b"]);

    await expect(aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: twoManifests,
      outDir: "too-few"
    })).rejects.toThrow("exactly 3 run manifests");
    await expect(stat(path.join(workspace, "too-few"))).rejects.toMatchObject({ code: "ENOENT" });

    const duplicateTrialManifests = await createProviderRuns(
      workspace,
      suitePath,
      ["trial-c", "trial-d", "trial-d"],
      "duplicate-trial"
    );
    await expect(aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: duplicateTrialManifests,
      outDir: "duplicate-trial-aggregate"
    })).rejects.toThrow("three distinct trial_ids");
    await expect(stat(path.join(workspace, "duplicate-trial-aggregate"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects artifact tampering and current-suite manuscript drift", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    const tamperedManifests = await createProviderRuns(
      workspace,
      suitePath,
      ["trial-a", "trial-b", "trial-c"],
      "tampered"
    );
    const tamperedManifest = JSON.parse(await readFile(path.join(workspace, tamperedManifests[1]), "utf8")) as {
      artifacts: { predictions_path: string };
    };
    await writeFile(
      path.join(workspace, tamperedManifest.artifacts.predictions_path),
      "{\"tampered\":true}\n",
      { flag: "a" }
    );

    await expect(aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: tamperedManifests,
      outDir: "tampered-aggregate"
    })).rejects.toThrow("predictions SHA-256 mismatch");

    const cleanManifests = await createProviderRuns(
      workspace,
      suitePath,
      ["trial-d", "trial-e", "trial-f"],
      "drift"
    );
    const suite = JSON.parse(await readFile(path.join(workspace, suitePath), "utf8")) as {
      cases: string[];
    };
    const firstCasePath = path.join(workspace, path.dirname(suitePath), suite.cases[0]);
    const firstCase = JSON.parse(await readFile(firstCasePath, "utf8")) as {
      artifact_root: string;
    };
    await writeFile(
      path.join(path.dirname(firstCasePath), firstCase.artifact_root, "paper", "main.tex"),
      "\\section{Changed}\nThe manuscript changed after execution.\n",
      "utf8"
    );
    await expect(aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: cleanManifests,
      outDir: "drift-aggregate"
    })).rejects.toThrow("Promotion benchmark suite validation failed: artifact_hash_mismatch");
  });

  it("rejects reused execution receipts across otherwise distinct trials", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    const manifests = await createProviderRuns(
      workspace,
      suitePath,
      ["trial-a", "trial-b", "trial-c"],
      "reused-receipts",
      true
    );

    await expect(aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: manifests,
      outDir: "reused-receipts-aggregate"
    })).rejects.toThrow("distinct execution receipts");
    await expect(stat(path.join(workspace, "reused-receipts-aggregate"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a run manifest whose paper-claim suite binding was changed after execution", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    const manifests = await createProviderRuns(workspace, suitePath, ["trial-a", "trial-b", "trial-c"]);
    const manifestPath = path.join(workspace, manifests[0]);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      source_suite: { paper_claim_eligible: boolean };
      paper_claim_evidence_eligible: boolean;
    };
    manifest.source_suite.paper_claim_eligible = true;
    manifest.paper_claim_evidence_eligible = true;
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: manifests,
      outDir: "eligibility-drift-aggregate"
    })).rejects.toThrow("source-suite binding does not match");
  });

  it("rejects case-manifest byte drift after provider execution", async () => {
    const workspace = await createWorkspace();
    const suitePath = await createSuite(workspace);
    const manifests = await createProviderRuns(workspace, suitePath, ["trial-a", "trial-b", "trial-c"]);
    const suite = JSON.parse(await readFile(path.join(workspace, suitePath), "utf8")) as { cases: string[] };
    const casePath = path.join(workspace, path.dirname(suitePath), suite.cases[0]);
    const caseManifest = JSON.parse(await readFile(casePath, "utf8"));
    await writeFile(casePath, `${JSON.stringify(caseManifest)}\n`);

    await expect(aggregatePromotionBenchmarkProviderRuns({
      cwd: workspace,
      suitePath,
      runManifestPaths: manifests,
      outDir: "case-drift-aggregate"
    })).rejects.toThrow("source-suite binding does not match");
  });
});

async function createProviderRuns(
  workspace: string,
  suitePath: string,
  trialIds: string[],
  prefix = "provider",
  reuseReceipts = false
): Promise<string[]> {
  const manifests: string[] = [];
  for (const [trialIndex, trialId] of trialIds.entries()) {
    let requestIndex = 0;
    const client: PromotionProviderClient = {
      complete: async () => {
        requestIndex += 1;
        return {
          text: JSON.stringify({
            decision: "needs_review",
            concerns: [{
              code: "manuscript_evidence_uncertain",
              severity: "warning",
              evidence_refs: ["paper/main.tex"]
            }],
            repair_owners: ["review"]
          }),
          responseId: reuseReceipts
            ? `response-${requestIndex}`
            : `response-${trialIndex + 1}-${requestIndex}`,
          model: "gpt-5.4",
          usage: {
            inputTokens: 10 + requestIndex,
            outputTokens: 4,
            costUsd: 0.001 * requestIndex
          }
        };
      }
    };
    const result = await runPromotionBenchmarkProvider({
      cwd: workspace,
      suitePath,
      outDir: `${prefix}-${trialIndex + 1}`,
      provider: "openai_responses_api",
      model: "gpt-5.4",
      reasoningEffort: "high",
      systemId: "manuscript-reviewer",
      trialId,
      evidenceClass: "external_real_provider"
    }, client);
    manifests.push(result.manifest_path);
  }
  return manifests;
}

async function createLocalProviderRuns(workspace: string, suitePath: string): Promise<string[]> {
  const manifests: string[] = [];
  for (const [index, trialId] of ["local-a", "local-b", "local-c"].entries()) {
    const client: PromotionProviderClient = {
      complete: async () => ({
        text: JSON.stringify({
          decision: "needs_review",
          concerns: [{
            code: "manuscript_evidence_uncertain",
            severity: "warning",
            evidence_refs: ["paper/main.tex"]
          }],
          repair_owners: ["review"]
        }),
        model: "local-model:latest",
        totalDurationNs: 1_000_000 + index,
        usage: { inputTokens: 11, outputTokens: 4, costUsd: 0 }
      })
    };
    const result = await runPromotionBenchmarkProvider({
      cwd: workspace,
      suitePath,
      outDir: `local-provider-${index + 1}`,
      provider: "ollama_local",
      model: "local-model:latest",
      modelArtifactDigest: `sha256:${"c".repeat(64)}`,
      reasoningEffort: "off",
      systemId: "manuscript-reviewer",
      trialId,
      evidenceClass: "local_real_model"
    }, client);
    manifests.push(result.manifest_path);
  }
  return manifests;
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-provider-aggregate-"));
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
    `${JSON.stringify([{ reference: 0.6, candidate: 0.7 }])}\n`,
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
        operations: [{ op: "remove_json_pointer", path: "result_table.json", pointer: "/0/candidate" }],
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
