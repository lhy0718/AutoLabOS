import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PROMOTION_TRIAL_CANDIDATE_CONTROLLER_MAP,
  PROMOTION_TRIAL_CANDIDATE_EVIDENCE_SUMMARY,
  PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST,
  exportPromotionTrialCandidateHandoff,
  inspectPromotionTrialCandidateHandoff
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateHandoff.js";

const execFileAsync = promisify(execFile);

describe("promotion trial-candidate handoff", () => {
  let workspace = "";
  let repositoryRoot = "";
  let revision = "";
  let credentialRevision = "";
  let privatePathRevision = "";
  let emptyRevision = "";

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "trial-candidate-handoff-"));
    repositoryRoot = path.join(workspace, "source-repository");
    await mkdir(repositoryRoot, { recursive: true });
    await runGit(repositoryRoot, ["init"]);
    await runGit(repositoryRoot, ["config", "user.email", "fixture@example.org"]);
    await runGit(repositoryRoot, ["config", "user.name", "Fixture Author"]);
    await runGit(repositoryRoot, ["remote", "add", "origin", "https://example.org/source-repository.git"]);
    for (let operatorIndex = 0; operatorIndex < 3; operatorIndex += 1) {
      for (let familyIndex = 0; familyIndex < 4; familyIndex += 1) {
        for (let trialIndex = 0; trialIndex < 21; trialIndex += 1) {
          const relativePath = [
            "records",
            `operator-${String.fromCharCode(97 + operatorIndex)}`,
            `family-${String.fromCharCode(97 + familyIndex)}`,
            `run-${trialIndex.toString().padStart(2, "0")}`,
            "trace.json"
          ].join("/");
          const target = path.join(repositoryRoot, relativePath);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, `${JSON.stringify({
            event: "completed",
            record_id: `${operatorIndex}-${familyIndex}-${trialIndex}`,
            ...(operatorIndex === 0 && familyIndex === 0 && trialIndex === 0
              ? { snippet: "load resource as f:\n- continue" }
              : {})
          })}\n`, "utf8");
        }
      }
    }
    await runGit(repositoryRoot, ["add", "records"]);
    await runGit(repositoryRoot, ["commit", "-m", "add neutral trial records"]);
    revision = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).trim();

    const firstTrace = path.join(repositoryRoot, "records", "operator-a", "family-a", "run-00", "trace.json");
    await writeFile(firstTrace, `${JSON.stringify({ event: "completed", api_key: "short-secret" })}\n`, "utf8");
    await runGit(repositoryRoot, ["add", "records"]);
    await runGit(repositoryRoot, ["commit", "-m", "add credential contamination fixture"]);
    credentialRevision = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).trim();

    const privatePath = ["", "home", "example", "private-workspace", "record.json"].join("/");
    await writeFile(firstTrace, `${JSON.stringify({
      event: "completed",
      artifact_path: privatePath,
      locations: { [privatePath]: "observed" }
    })}\n`, "utf8");
    await runGit(repositoryRoot, ["add", "records"]);
    await runGit(repositoryRoot, ["commit", "-m", "add private path contamination fixture"]);
    privatePathRevision = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).trim();

    await writeFile(firstTrace, "", "utf8");
    await runGit(repositoryRoot, ["add", "records"]);
    await runGit(repositoryRoot, ["commit", "-m", "add empty trace fixture"]);
    emptyRevision = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  }, 30_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("exports a balanced 72-base, three-trial opaque reviewer handoff", async () => {
    const recipePath = path.join(workspace, "recipe.json");
    await writeRecipe(recipePath, {
      repositoryRoot,
      revision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<trial>[^/]+)/trace\\.json$"
    });

    const result = await exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "handoff"
    });
    const manifest = JSON.parse(await readFile(
      path.join(workspace, result.manifest_path),
      "utf8"
    )) as Record<string, any>;

    expect(result).toMatchObject({
      base_candidate_count: 72,
      trial_artifact_count: 216,
      reviewer_dir: "handoff/reviewer",
      controller_map_path: `handoff/${PROMOTION_TRIAL_CANDIDATE_CONTROLLER_MAP}`,
      evidence_summary_path: `handoff/${PROMOTION_TRIAL_CANDIDATE_EVIDENCE_SUMMARY}`
    });
    expect(manifest).toMatchObject({
      status: "candidate_handoff_ready",
      selection_pre_content: true,
      source_materialization: "git_archive",
      matched_trial_artifact_count: 252,
      empty_blob_exclusion_count: 0,
      duplicate_blob_exclusion_count: 0,
      unique_eligible_trial_artifact_count: 252,
      base_candidate_count: 72,
      trials_per_base: 3,
      trial_artifact_count: 216,
      source_family_count: 4,
      operator_group_count: 3,
      paper_scale_trace_floor_met: true,
      privacy_projection_applied: false,
      privacy_redaction_count: 0,
      distribution_scope: "local_evaluation_only",
      source_license_status: "unreviewed",
      confirmatory_admitted: false
    });
    expect(manifest.largest_source_family_share).toBeLessThanOrEqual(0.5);
    expect(manifest.largest_operator_group_share).toBeLessThanOrEqual(0.5);
    expect(JSON.stringify(manifest)).not.toContain("operator-a");
    expect(JSON.stringify(manifest)).not.toContain("family-a");
    await expect(access(path.join(workspace, "handoff/reviewer/controller"))).rejects.toThrow();
    expect(await inspectPromotionTrialCandidateHandoff(path.join(workspace, "handoff"))).toMatchObject({
      passed: true,
      issues: []
    });
    expect(JSON.parse(await readFile(path.join(workspace, result.evidence_summary_path), "utf8"))).toMatchObject({
      base_candidate_count: 72,
      trial_artifact_count: 216,
      independent_human_normalization_completed: false,
      confirmatory_admitted: false,
      remaining_blockers: expect.arrayContaining(["human_license_review", "independent_double_normalization"])
    });
  }, 30_000);

  it("rejects a source route with fewer than three operator groups", async () => {
    const recipePath = path.join(workspace, "two-operator-recipe.json");
    await writeRecipe(recipePath, {
      repositoryRoot,
      revision,
      pathPattern: "^records/(?<operator>operator-[ab])/(?<family>[^/]+)/(?<trial>[^/]+)/trace\\.json$"
    });

    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "two-operator-recipe.json",
      outDir: "invalid-handoff"
    })).rejects.toThrow("at least three source families and three operator groups");
  });

  it("rejects a recipe whose source URL does not match the Git origin", async () => {
    const recipePath = path.join(workspace, "wrong-origin-recipe.json");
    await writeRecipe(recipePath, {
      repositoryRoot,
      revision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<trial>[^/]+)/trace\\.json$",
      sourceUrl: "https://example.org/different-repository"
    });

    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "wrong-origin-recipe.json",
      outDir: "wrong-origin-handoff"
    })).rejects.toThrow("does not match the repository origin");
  });

  it("materializes HTTPS blobs only when their bytes match the selected Git objects", async () => {
    const recipePath = path.join(workspace, "https-recipe.json");
    await writeRecipe(recipePath, {
      repositoryRoot,
      revision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<trial>[^/]+)/trace\\.json$",
      materializationMode: "verified_https_blobs",
      artifactUrlTemplate: "https://example.org/raw/{revision}/{path}"
    });
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const prefix = `/raw/${revision}/`;
      const sourcePath = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
      const bytes = await runGit(repositoryRoot, ["show", `${revision}:${sourcePath}`]);
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;

    const result = await exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "https-recipe.json",
      outDir: "https-handoff",
      fetchImpl
    });
    const manifest = JSON.parse(await readFile(path.join(workspace, result.manifest_path), "utf8"));

    expect(manifest).toMatchObject({
      source_materialization: "verified_https_blobs",
      base_candidate_count: 72,
      trial_artifact_count: 216,
      privacy_projection_applied: false,
      privacy_redaction_count: 0
    });
  }, 30_000);

  it("rejects HTTPS artifact bytes that do not match the selected Git object", async () => {
    const recipePath = path.join(workspace, "https-mismatch-recipe.json");
    await writeRecipe(recipePath, {
      repositoryRoot,
      revision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<trial>[^/]+)/trace\\.json$",
      materializationMode: "verified_https_blobs",
      artifactUrlTemplate: "https://example.org/raw/{revision}/{path}"
    });
    const fetchImpl = (async () => new Response("{}\n", { status: 200 })) as typeof fetch;

    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "https-mismatch-recipe.json",
      outDir: "https-mismatch-handoff",
      fetchImpl
    })).rejects.toThrow("does not match its Git object ID");
  });

  it("fails closed when a preselected trace contains a credential-like JSON field", async () => {
    const recipePath = path.join(workspace, "credential-recipe.json");
    await writeRecipe(recipePath, {
      repositoryRoot,
      revision: credentialRevision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<trial>[^/]+)/trace\\.json$"
    });

    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "credential-recipe.json",
      outDir: "credential-handoff"
    })).rejects.toThrow("credential-like");
    await expect(access(path.join(workspace, "credential-handoff"))).rejects.toThrow();
  });

  it("keeps the preselected trace while deterministically redacting a private machine path", async () => {
    const recipePath = path.join(workspace, "private-path-recipe.json");
    await writeRecipe(recipePath, {
      repositoryRoot,
      revision: privatePathRevision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<trial>[^/]+)/trace\\.json$"
    });

    const result = await exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "private-path-recipe.json",
      outDir: "private-path-handoff"
    });
    const manifest = JSON.parse(await readFile(path.join(workspace, result.manifest_path), "utf8")) as Record<string, any>;
    const redactedTrial = manifest.candidates
      .flatMap((candidate: Record<string, any>) => candidate.trials)
      .find((trial: Record<string, any>) => trial.privacy_redaction_count > 0) as Record<string, any>;
    const artifactText = await readFile(path.join(workspace, "private-path-handoff", "reviewer", redactedTrial.artifact_path), "utf8");
    const originalPrivatePath = ["", "home", "example", "private-workspace", "record.json"].join("/");

    expect(manifest).toMatchObject({
      privacy_projection_applied: true,
      privacy_redaction_count: 2
    });
    expect(redactedTrial.source_blob_sha256).not.toBe(redactedTrial.reviewer_blob_sha256);
    expect(artifactText).toContain("<private-path>");
    expect(artifactText).not.toContain(originalPrivatePath);
    expect(await inspectPromotionTrialCandidateHandoff(path.join(workspace, "private-path-handoff"))).toMatchObject({
      passed: true,
      issues: []
    });
  });

  it("excludes empty Git blobs before content inspection and accounts for them", async () => {
    const recipePath = path.join(workspace, "empty-blob-recipe.json");
    await writeRecipe(recipePath, {
      repositoryRoot,
      revision: emptyRevision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<trial>[^/]+)/trace\\.json$"
    });

    const result = await exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "empty-blob-recipe.json",
      outDir: "empty-blob-handoff"
    });
    const manifest = JSON.parse(await readFile(path.join(workspace, result.manifest_path), "utf8"));

    expect(manifest).toMatchObject({
      matched_trial_artifact_count: 252,
      empty_blob_exclusion_count: 1,
      duplicate_blob_exclusion_count: 0,
      unique_eligible_trial_artifact_count: 251,
      base_candidate_count: 72,
      trial_artifact_count: 216
    });
  });

  it("detects reviewer artifact tampering", async () => {
    const handoffRoot = path.join(workspace, "handoff");
    const manifest = JSON.parse(await readFile(
      path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST),
      "utf8"
    )) as Record<string, any>;
    const firstArtifact = manifest.candidates[0].trials[0].artifact_path as string;
    await writeFile(path.join(handoffRoot, "reviewer", firstArtifact), "{}\n", "utf8");

    const inspection = await inspectPromotionTrialCandidateHandoff(handoffRoot);

    expect(inspection.passed).toBe(false);
    expect(inspection.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "trial_candidate_handoff_output_hash_mismatch",
      "trial_candidate_handoff_trial_hash_mismatch",
      "trial_candidate_handoff_reviewer_tree_mismatch"
    ]));
  });
});

async function writeRecipe(
  target: string,
  input: {
    repositoryRoot: string;
    revision: string;
    pathPattern: string;
    sourceUrl?: string;
    materializationMode?: "git_archive" | "verified_https_blobs";
    artifactUrlTemplate?: string;
  }
): Promise<void> {
  await writeFile(target, `${JSON.stringify({
    schema_version: "1.0",
    handoff_id: "candidate-handoff-neutral",
    source_url: input.sourceUrl || "https://example.org/source-repository",
    source_revision: input.revision,
    repository_root: input.repositoryRoot,
    path_scope: "records",
    path_pattern: input.pathPattern,
    required_base_count: 72,
    trials_per_base: 3,
    artifact_format: "json",
    selection_policy: "Lexical path selection followed by balanced operator and source-family round robin before artifact-content inspection.",
    ...(input.materializationMode ? { materialization_mode: input.materializationMode } : {}),
    ...(input.artifactUrlTemplate ? { artifact_url_template: input.artifactUrlTemplate } : {})
  }, null, 2)}\n`, "utf8");
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}
