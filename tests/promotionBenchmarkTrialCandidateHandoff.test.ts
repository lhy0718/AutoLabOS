import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parquetWriteBuffer } from "hyparquet-writer";

import {
  PROMOTION_TRIAL_CANDIDATE_CONTROLLER_MAP,
  PROMOTION_TRIAL_CANDIDATE_EVIDENCE_SUMMARY,
  PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST,
  PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST,
  PROMOTION_TRIAL_CANDIDATE_SOURCE_RECIPE,
  exportPromotionTrialCandidateHandoff,
  inspectPromotionTrialCandidateHandoff,
  inspectPromotionTrialCandidateLicensePacket,
  inspectPromotionTrialCandidateReviewerPacket,
  type PromotionTrialCandidateRecord
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateHandoff.js";
import {
  PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS,
  PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE,
  adjudicatePromotionTrialCandidateReview,
  inspectPromotionTrialCandidateReviewAdjudication,
  loadPromotionTrialCandidateReviewAdmissionEvidence,
  preparePromotionTrialCandidateAnnotationWorksheet,
  preparePromotionTrialCandidateLicenseReviewWorksheet,
  preflightPromotionTrialCandidateAnnotation,
  preflightPromotionTrialCandidateLicenseReview
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateReview.js";
import {
  PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_MANIFEST,
  inspectPromotionTrialCandidateReviewCampaign,
  preparePromotionTrialCandidateReviewCampaign
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateReviewCampaign.js";
import {
  PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT,
  collectPromotionTrialCandidateReviewCampaign,
  inspectPromotionTrialCandidateCampaignReturn
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateReviewCampaignReturn.js";
import {
  PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_ATTESTATION,
  PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_MANIFEST,
  auditPromotionTrialCandidateReviewWorkspace,
  finalizePromotionTrialCandidateReviewWorkspace,
  preparePromotionTrialCandidateReviewWorkspace
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateReviewWorkspace.js";
import {
  PROMOTION_TRIAL_CANDIDATE_ANNOTATION_SCHEMA,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_GUIDE,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_SCHEMA,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK,
  PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS,
  PROMOTION_TRIAL_CANDIDATE_RESOLUTION_SCHEMA,
  PROMOTION_TRIAL_CANDIDATE_RUBRIC,
  parsePromotionTrialCandidateInitialAnnotationSet,
  parsePromotionTrialCandidateLicenseReviewSet,
  type PromotionTrialCandidateHumanLabel,
  type PromotionTrialCandidateInitialAnnotationSet,
  type PromotionTrialCandidateLicenseReviewSet
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateReviewContract.js";
import { projectPromotionReviewerArtifact } from "../src/core/benchmark/promotionArtifactPrivacy.js";
import {
  PROMOTION_CANONICAL_ARTIFACT_PATHS,
  PROMOTION_CANONICAL_CURATION_RECORD,
  PROMOTION_CANONICAL_CURATION_SCHEMA_VERSION,
  type PromotionCanonicalCurationRecord
} from "../src/core/benchmark/promotionBenchmarkCanonicalCuration.js";
import {
  PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST,
  PROMOTION_CANONICAL_CURATION_TASKS,
  inspectPromotionCanonicalCurationHandoff,
  preparePromotionCanonicalCurationHandoff
} from "../src/core/benchmark/promotionBenchmarkCanonicalCurationHandoff.js";
import {
  PROMOTION_CANONICAL_CURATION_RETURN_RECEIPT,
  collectPromotionCanonicalCurationReturn,
  inspectPromotionCanonicalCurationReturn
} from "../src/core/benchmark/promotionBenchmarkCanonicalCurationReturn.js";
import {
  auditPromotionConfirmatoryIntake,
  freezePromotionConfirmatoryCorpus
} from "../src/core/benchmark/promotionBenchmarkConfirmatoryIntake.js";
import {
  PROMOTION_CONFIRMATORY_UPSTREAM_HANDOFF_ROOT,
  PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT,
  PROMOTION_CONFIRMATORY_UPSTREAM_CURATION_RETURN_ROOT,
  inspectPromotionConfirmatoryFreezeEvidence
} from "../src/core/benchmark/promotionBenchmarkConfirmatoryFreeze.js";

const execFileAsync = promisify(execFile);

describe("promotion trial-candidate handoff", () => {
  let workspace = "";
  let gitSourceRoot = "";
  let revision = "";
  let credentialRevision = "";
  let privatePathRevision = "";
  let emptyRevision = "";

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "trial-candidate-handoff-"));
    gitSourceRoot = path.join(workspace, "source-repository");
    await mkdir(gitSourceRoot, { recursive: true });
    await runGit(gitSourceRoot, ["init"]);
    await runGit(gitSourceRoot, ["config", "user.email", "fixture@example.org"]);
    await runGit(gitSourceRoot, ["config", "user.name", "Fixture Author"]);
    await runGit(gitSourceRoot, ["remote", "add", "origin", "https://example.org/source-repository.git"]);
    await writeFile(path.join(gitSourceRoot, "LICENSE"), "Permission is granted for fixture use.\n", "utf8");
    for (let operatorIndex = 0; operatorIndex < 3; operatorIndex += 1) {
      for (let familyIndex = 0; familyIndex < 4; familyIndex += 1) {
        for (let baseIndex = 0; baseIndex < 20; baseIndex += 1) {
          for (let trialIndex = 0; trialIndex < 3; trialIndex += 1) {
            const relativePath = [
              "records",
              `operator-${String.fromCharCode(97 + operatorIndex)}`,
              `family-${String.fromCharCode(97 + familyIndex)}`,
              `base-${baseIndex.toString().padStart(2, "0")}`,
              `trial-${trialIndex.toString().padStart(2, "0")}`,
              "trace.json"
            ].join("/");
            const target = path.join(gitSourceRoot, relativePath);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, `${JSON.stringify({
              event: "completed",
              record_id: `${operatorIndex}-${familyIndex}-${baseIndex}-${trialIndex}`,
              ...(operatorIndex === 0 && familyIndex === 0 && baseIndex === 0 && trialIndex === 0
                ? { snippet: "load resource as f:\n- continue" }
                : {})
            })}\n`, "utf8");
          }
        }
      }
    }
    await runGit(gitSourceRoot, ["add", "LICENSE", "records"]);
    await runGit(gitSourceRoot, ["commit", "-m", "add neutral trial records"]);
    revision = (await runGit(gitSourceRoot, ["rev-parse", "HEAD"])).trim();

    const firstTrace = path.join(
      gitSourceRoot,
      "records",
      "operator-a",
      "family-a",
      "base-00",
      "trial-00",
      "trace.json"
    );
    await writeFile(firstTrace, `${JSON.stringify({ event: "completed", api_key: "short-secret" })}\n`, "utf8");
    await runGit(gitSourceRoot, ["add", "records"]);
    await runGit(gitSourceRoot, ["commit", "-m", "add credential contamination fixture"]);
    credentialRevision = (await runGit(gitSourceRoot, ["rev-parse", "HEAD"])).trim();

    const privatePath = ["", "home", "example", "private-workspace", "record.json"].join("/");
    await writeFile(firstTrace, `${JSON.stringify({
      event: "completed",
      artifact_path: privatePath,
      locations: { [privatePath]: "observed" }
    })}\n`, "utf8");
    await runGit(gitSourceRoot, ["add", "records"]);
    await runGit(gitSourceRoot, ["commit", "-m", "add private path contamination fixture"]);
    privatePathRevision = (await runGit(gitSourceRoot, ["rev-parse", "HEAD"])).trim();

    await writeFile(firstTrace, "", "utf8");
    await runGit(gitSourceRoot, ["add", "records"]);
    await runGit(gitSourceRoot, ["commit", "-m", "add empty trace fixture"]);
    emptyRevision = (await runGit(gitSourceRoot, ["rev-parse", "HEAD"])).trim();
  }, 30_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("exports a balanced 72-base, three-trial opaque reviewer handoff", async () => {
    const recipePath = path.join(workspace, "recipe.json");
    await writeRecipe(recipePath, {
      revision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<base>[^/]+)/(?<trial>[^/]+)/trace\\.json$"
    });

    const result = await exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "recipe.json",
      sourceRoot: gitSourceRoot,
      outDir: "handoff"
    });
    const manifest = JSON.parse(await readFile(
      path.join(workspace, result.manifest_path),
      "utf8"
    )) as Record<string, any>;
    const reviewerPacketManifest = JSON.parse(await readFile(path.join(
      workspace,
      result.reviewer_dir,
      PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST
    ), "utf8")) as Record<string, any>;
    const licensePacketManifest = JSON.parse(await readFile(path.join(
      workspace,
      result.license_reviewer_dir,
      PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST
    ), "utf8")) as Record<string, any>;
    const portableRecipeText = await readFile(path.join(
      workspace,
      result.source_recipe_path
    ), "utf8");

    expect(result).toMatchObject({
      base_candidate_count: 72,
      trial_artifact_count: 216,
      reviewer_dir: "handoff/reviewer",
      license_reviewer_dir: "handoff/license",
      controller_map_path: `handoff/${PROMOTION_TRIAL_CANDIDATE_CONTROLLER_MAP}`,
      source_recipe_path: `handoff/${PROMOTION_TRIAL_CANDIDATE_SOURCE_RECIPE}`,
      evidence_summary_path: `handoff/${PROMOTION_TRIAL_CANDIDATE_EVIDENCE_SUMMARY}`
    });
    expect(manifest).toMatchObject({
      status: "candidate_handoff_ready",
      selection_pre_content: true,
      source_materialization: "git_archive",
      matched_trial_artifact_count: 720,
      empty_blob_exclusion_count: 0,
      duplicate_blob_exclusion_count: 0,
      unique_eligible_trial_artifact_count: 720,
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
    expect(manifest.source_recipe_path).toBe(PROMOTION_TRIAL_CANDIDATE_SOURCE_RECIPE);
    expect(manifest.outputs).toContainEqual({
      path: PROMOTION_TRIAL_CANDIDATE_SOURCE_RECIPE,
      sha256: manifest.recipe_sha256
    });
    expect(JSON.stringify(manifest)).not.toContain("operator-a");
    expect(JSON.stringify(manifest)).not.toContain("family-a");
    expect(portableRecipeText).not.toContain(["repository", "root"].join("_"));
    expect(portableRecipeText).not.toContain(gitSourceRoot);
    expect(reviewerPacketManifest).toMatchObject({
      packet_role: "initial_candidate_review",
      candidate_count: 72,
      trials_per_candidate: 3,
      trial_artifact_count: 216
    });
    expect(JSON.stringify(reviewerPacketManifest)).not.toMatch(
      /source_url|source_revision|source_family|operator_group|controller_map/u
    );
    expect(licensePacketManifest).toMatchObject({
      packet_role: "source_license_review",
      task_count: 1
    });
    expect(JSON.stringify(licensePacketManifest)).not.toMatch(
      /candidate_artifact|candidate_annotation|controller_map/u
    );
    await expect(access(path.join(workspace, "handoff", PROMOTION_TRIAL_CANDIDATE_ANNOTATION_SCHEMA))).resolves.toBeUndefined();
    await expect(access(path.join(workspace, "handoff", PROMOTION_TRIAL_CANDIDATE_RESOLUTION_SCHEMA))).resolves.toBeUndefined();
    await expect(access(path.join(workspace, "handoff", PROMOTION_TRIAL_CANDIDATE_RUBRIC))).resolves.toBeUndefined();
    await expect(access(path.join(workspace, "handoff", PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK))).resolves.toBeUndefined();
    await expect(access(path.join(workspace, "handoff", PROMOTION_TRIAL_CANDIDATE_LICENSE_SCHEMA))).resolves.toBeUndefined();
    await expect(access(path.join(workspace, "handoff", PROMOTION_TRIAL_CANDIDATE_LICENSE_GUIDE))).resolves.toBeUndefined();
    await expect(access(path.join(workspace, "handoff/reviewer/controller"))).rejects.toThrow();
    expect(await inspectPromotionTrialCandidateHandoff(path.join(workspace, "handoff"))).toMatchObject({
      passed: true,
      issues: []
    });
    expect(await inspectPromotionTrialCandidateReviewerPacket(path.join(
      workspace,
      result.reviewer_dir
    ))).toMatchObject({ passed: true, issues: [] });
    expect(await inspectPromotionTrialCandidateLicensePacket(path.join(
      workspace,
      result.license_reviewer_dir
    ))).toMatchObject({ passed: true, issues: [] });
    expect(JSON.parse(await readFile(path.join(workspace, result.evidence_summary_path), "utf8"))).toMatchObject({
      base_candidate_count: 72,
      trial_artifact_count: 216,
      independent_candidate_review_completed: false,
      confirmatory_admitted: false,
      remaining_blockers: expect.arrayContaining(["human_license_review", "independent_double_candidate_review"])
    });
    await expect(preparePromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      handoffRoot: result.output_dir,
      annotatorIds: ["reviewer-alpha", "reviewer-beta"],
      licenseReviewerId: "license-reviewer",
      outDir: "unpaired-review-campaign"
    })).rejects.toThrow("paired six-trial");
    await expect(access(path.join(workspace, "unpaired-review-campaign"))).rejects.toThrow();
  }, 30_000);

  it("rejects a source route with fewer than three operator groups", async () => {
    const recipePath = path.join(workspace, "two-operator-recipe.json");
    await writeRecipe(recipePath, {
      revision,
      pathPattern: "^records/(?<operator>operator-[ab])/(?<family>[^/]+)/(?<base>[^/]+)/(?<trial>[^/]+)/trace\\.json$"
    });

    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "two-operator-recipe.json",
      sourceRoot: gitSourceRoot,
      outDir: "invalid-handoff"
    })).rejects.toThrow("at least three source families and three operator groups");
  });

  it("rejects a recipe whose source URL does not match the Git origin", async () => {
    const recipePath = path.join(workspace, "wrong-origin-recipe.json");
    await writeRecipe(recipePath, {
      revision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<base>[^/]+)/(?<trial>[^/]+)/trace\\.json$",
      sourceUrl: "https://example.org/different-repository"
    });

    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "wrong-origin-recipe.json",
      sourceRoot: gitSourceRoot,
      outDir: "wrong-origin-handoff"
    })).rejects.toThrow("does not match the repository origin");
  });

  it("rejects machine-local repository paths inside a portable source recipe", async () => {
    const recipePath = path.join(workspace, "machine-bound-recipe.json");
    await writeRecipe(recipePath, {
      revision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<base>[^/]+)/(?<trial>[^/]+)/trace\\.json$"
    });
    const recipe = JSON.parse(await readFile(recipePath, "utf8")) as Record<string, unknown>;
    recipe[["repository", "root"].join("_")] = gitSourceRoot;
    await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`, "utf8");

    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "machine-bound-recipe.json",
      sourceRoot: gitSourceRoot,
      outDir: "machine-bound-handoff"
    })).rejects.toThrow("machine-local source paths");
  });

  it("requires the machine-local clone as a separate runtime input", async () => {
    const recipePath = path.join(workspace, "missing-runtime-root-recipe.json");
    await writeRecipe(recipePath, {
      revision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<base>[^/]+)/(?<trial>[^/]+)/trace\\.json$"
    });

    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "missing-runtime-root-recipe.json",
      sourceRoot: "",
      outDir: "missing-runtime-root-handoff"
    })).rejects.toThrow("separate local source root");
  });

  it("rejects an artifact URL template for Git-archive materialization", async () => {
    const recipePath = path.join(workspace, "git-archive-url-recipe.json");
    await writeRecipe(recipePath, {
      revision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<base>[^/]+)/(?<trial>[^/]+)/trace\\.json$",
      materializationMode: "git_archive",
      artifactUrlTemplate: "https://example.org/{revision}/{path}"
    });

    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "git-archive-url-recipe.json",
      sourceRoot: gitSourceRoot,
      outDir: "git-archive-url-handoff"
    })).rejects.toThrow("must not declare an artifact_url_template");
  });

  it("materializes HTTPS blobs only when their bytes match the selected Git objects", async () => {
    const recipePath = path.join(workspace, "https-recipe.json");
    await writeRecipe(recipePath, {
      revision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<base>[^/]+)/(?<trial>[^/]+)/trace\\.json$",
      materializationMode: "verified_https_blobs",
      artifactUrlTemplate: "https://example.org/raw/{revision}/{path}"
    });
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const prefix = `/raw/${revision}/`;
      const sourcePath = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
      const bytes = await runGit(gitSourceRoot, ["show", `${revision}:${sourcePath}`]);
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;

    const result = await exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "https-recipe.json",
      sourceRoot: gitSourceRoot,
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
      revision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<base>[^/]+)/(?<trial>[^/]+)/trace\\.json$",
      materializationMode: "verified_https_blobs",
      artifactUrlTemplate: "https://example.org/raw/{revision}/{path}"
    });
    const fetchImpl = (async () => new Response("{}\n", { status: 200 })) as typeof fetch;

    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "https-mismatch-recipe.json",
      sourceRoot: gitSourceRoot,
      outDir: "https-mismatch-handoff",
      fetchImpl
    })).rejects.toThrow("does not match its Git object ID");
  });

  it("fails closed when a preselected trace contains a credential-like JSON field", async () => {
    const recipePath = path.join(workspace, "credential-recipe.json");
    await writeRecipe(recipePath, {
      revision: credentialRevision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<base>[^/]+)/(?<trial>[^/]+)/trace\\.json$"
    });

    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "credential-recipe.json",
      sourceRoot: gitSourceRoot,
      outDir: "credential-handoff"
    })).rejects.toThrow("credential-like");
    await expect(access(path.join(workspace, "credential-handoff"))).rejects.toThrow();
  });

  it("keeps credential projection fail-closed when no redaction pattern can complete", () => {
    const incompletePrivateMaterial = [
      "-----BEGIN",
      "PRIVATE",
      "KEY-----"
    ].join(" ");
    const bytes = Buffer.from(`${JSON.stringify({ content: incompletePrivateMaterial })}\n`, "utf8");

    expect(() => projectPromotionReviewerArtifact(
      "trace.json",
      bytes,
      { redactCredentialLikeValues: true }
    )).toThrow("credential-like");
  });

  it("keeps the preselected trace while deterministically redacting a private machine path", async () => {
    const recipePath = path.join(workspace, "private-path-recipe.json");
    await writeRecipe(recipePath, {
      revision: privatePathRevision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<base>[^/]+)/(?<trial>[^/]+)/trace\\.json$"
    });

    const result = await exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "private-path-recipe.json",
      sourceRoot: gitSourceRoot,
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
      revision: emptyRevision,
      pathPattern: "^records/(?<operator>[^/]+)/(?<family>[^/]+)/(?<base>[^/]+)/(?<trial>[^/]+)/trace\\.json$"
    });

    const result = await exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "empty-blob-recipe.json",
      sourceRoot: gitSourceRoot,
      outDir: "empty-blob-handoff"
    });
    const manifest = JSON.parse(await readFile(path.join(workspace, result.manifest_path), "utf8"));

    expect(manifest).toMatchObject({
      matched_trial_artifact_count: 720,
      empty_blob_exclusion_count: 1,
      duplicate_blob_exclusion_count: 0,
      unique_eligible_trial_artifact_count: 719,
      base_candidate_count: 72,
      trial_artifact_count: 216
    });
  });

  it("exports explicit same-base trials from hash-bound Parquet row sources", async () => {
    const sourceRoot = path.join(workspace, "parquet-source");
    await mkdir(sourceRoot, { recursive: true });
    const licenseText = "---\nlicense: mit\n---\n# Neutral rollout fixture\n";
    const credentialAssignment = [
      ["api", "key"].join("_"),
      ["fixture", "credential", "value"].join("-")
    ].join("=");
    const reviewerIdentity = "https://huggingface.co/datasets/source-org/rollout-corpus";
    const incompletePrivateMaterial = [
      "-----BEGIN",
      "OPENSSH",
      "PRIVATE",
      "KEY-----"
    ].join(" ");
    await writeFile(path.join(sourceRoot, "README.md"), licenseText, "utf8");
    const parquetSources: Array<{ path: string; sha256: string }> = [];
    for (let operatorIndex = 0; operatorIndex < 3; operatorIndex += 1) {
      const rows: Array<Record<string, string>> = [];
      for (let familyIndex = 0; familyIndex < 4; familyIndex += 1) {
        for (let baseIndex = 0; baseIndex < 20; baseIndex += 1) {
          for (let trialIndex = 0; trialIndex < 3; trialIndex += 1) {
            rows.push({
              operator: `operator-${operatorIndex}`,
              source_key: `family-${familyIndex}-base-${baseIndex}`,
              metadata: JSON.stringify({ operator: `operator-${operatorIndex}` }),
              instance: JSON.stringify({
                domain: `family-${familyIndex}`,
                sample_id: `base-${baseIndex}`,
                source_key: `family-${familyIndex}-base-${baseIndex}`,
                shared_id: `base-${baseIndex % 6}`
              }),
              prediction: `observation-${baseIndex}-${trialIndex}`,
              termination: "answer",
              messages: JSON.stringify([
                { role: "user", content: `task-${baseIndex}` },
                { role: "assistant", content: `observation-${baseIndex}-${trialIndex}` },
                ...(operatorIndex === 0 && familyIndex === 0 && baseIndex === 0 && trialIndex === 0
                  ? [
                      { role: "tool", content: credentialAssignment },
                      { role: "tool", content: reviewerIdentity }
                    ]
                  : []),
                ...(familyIndex === 0 && baseIndex === 1 && trialIndex === 0
                  ? [{ role: "tool", content: incompletePrivateMaterial }]
                  : [])
              ]),
              auto_judge: JSON.stringify({ observed_score: trialIndex / 10 })
            });
          }
        }
      }
      const fileName = `operator-${operatorIndex}.parquet`;
      const bytes = new Uint8Array(parquetWriteBuffer({
        columnData: [
          "operator", "source_key", "metadata", "instance", "prediction", "termination", "messages", "auto_judge"
        ].map((name) => ({
          name,
          data: rows.map((row) => row[name]),
          type: "STRING" as const
        }))
      }));
      await writeFile(path.join(sourceRoot, fileName), bytes);
      parquetSources.push({
        path: fileName,
        sha256: createHash("sha256").update(bytes).digest("hex")
      });
    }
    const recipePath = path.join(workspace, "parquet-recipe.json");
    await writeFile(recipePath, `${JSON.stringify({
      schema_version: "1.1",
      handoff_id: "candidate-handoff-parquet",
      source_url: "https://huggingface.co/datasets/example-org/neutral-rollouts",
      source_revision: "a".repeat(40),
      required_base_count: 72,
      trials_per_base: 3,
      artifact_format: "json",
      selection_policy: "Lexical row selection with explicit same-base grouping and balanced operator-family traversal before outcome inspection.",
      materialization_mode: "huggingface_parquet",
      credential_projection: "redact_values",
      reviewer_identity_redactions: [reviewerIdentity],
      license_evidence: [{
        path: "README.md",
        sha256: createHash("sha256").update(licenseText).digest("hex")
      }],
      parquet_sources: parquetSources,
      columns: ["operator", "source_key", "metadata", "instance", "prediction", "termination", "messages", "auto_judge"],
      json_columns: ["metadata", "instance", "messages", "auto_judge"],
      reviewer_columns: ["prediction", "termination", "messages", "auto_judge"],
      operator_pointer: "/metadata/operator",
      family_pointer: "/instance/source_key",
      family_value_transform: {
        operation: "prefix_before_last",
        delimiter: "-base-"
      },
      base_pointer: "/instance/source_key"
    }, null, 2)}\n`, "utf8");

    const result = await exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "parquet-recipe.json",
      sourceRoot,
      outDir: "parquet-handoff"
    });
    const manifest = JSON.parse(await readFile(
      path.join(workspace, result.manifest_path),
      "utf8"
    )) as Record<string, any>;
    const controller = JSON.parse(await readFile(
      path.join(workspace, result.controller_map_path),
      "utf8"
    )) as Record<string, any>;
    const reviewerFiles = await Promise.all(manifest.candidates
      .flatMap((candidate: Record<string, any>) => candidate.trials)
      .map((trial: Record<string, any>) => readFile(
        path.join(workspace, result.reviewer_dir, trial.artifact_path),
        "utf8"
      )));

    expect(manifest).toMatchObject({
      source_materialization: "huggingface_parquet",
      matched_trial_artifact_count: 720,
      unique_eligible_trial_artifact_count: 720,
      base_candidate_count: 72,
      source_family_count: 4,
      operator_group_count: 3,
      trial_artifact_count: 216,
      privacy_preflight_applied: true,
      privacy_unsafe_base_exclusion_count: 1,
      privacy_projection_applied: true,
      privacy_redaction_count: 2
    });
    expect(new Set(controller.candidates.map((candidate: Record<string, any>) =>
      candidate.source_family + ":" + candidate.base_group)).size).toBe(72);
    expect(controller.candidates.every((candidate: Record<string, any>) =>
      candidate.trials.length === 3
      && new Set(candidate.trials.map((trial: Record<string, any>) =>
        trial.source_ref_algorithm)).size === 1)).toBe(true);
    expect(reviewerFiles.join("\n")).not.toMatch(/operator-[0-9]|family-[0-9]|parquet_path/u);
    expect(reviewerFiles.join("\n")).not.toContain(credentialAssignment);
    expect(reviewerFiles.join("\n")).not.toContain(reviewerIdentity);
    expect(reviewerFiles.join("\n")).toContain("<credential-like-value>");
    expect(reviewerFiles.join("\n")).toContain("<reviewer-identity>");
    expect(await inspectPromotionTrialCandidateHandoff(path.join(
      workspace,
      "parquet-handoff"
    ))).toMatchObject({ passed: true, issues: [] });
    expect(await inspectPromotionTrialCandidateLicensePacket(path.join(
      workspace,
      result.license_reviewer_dir
    ))).toMatchObject({ passed: true, issues: [] });

    const nativeColumnRecipe = JSON.parse(await readFile(recipePath, "utf8")) as Record<string, any>;
    nativeColumnRecipe.handoff_id = "candidate-handoff-parquet-native-columns";
    nativeColumnRecipe.json_columns = [];
    nativeColumnRecipe.operator_pointer = "/operator";
    nativeColumnRecipe.family_pointer = "/source_key";
    nativeColumnRecipe.base_pointer = "/source_key";
    const nativeColumnRecipePath = path.join(workspace, "parquet-native-column-recipe.json");
    await writeFile(nativeColumnRecipePath, `${JSON.stringify(nativeColumnRecipe, null, 2)}\n`, "utf8");
    const nativeColumnResult = await exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "parquet-native-column-recipe.json",
      sourceRoot,
      outDir: "parquet-native-column-handoff"
    });
    expect(await inspectPromotionTrialCandidateHandoff(path.join(
      workspace,
      nativeColumnResult.output_dir
    ))).toMatchObject({ passed: true, issues: [] });

    const pairedRecipe = JSON.parse(await readFile(recipePath, "utf8")) as Record<string, any>;
    pairedRecipe.handoff_id = "candidate-handoff-parquet-paired";
    pairedRecipe.comparison_policy = {
      mode: "paired_operator",
      groups_per_base: 2,
      trials_per_group: 3
    };
    const pairedRecipePath = path.join(workspace, "parquet-paired-recipe.json");
    await writeFile(pairedRecipePath, `${JSON.stringify(pairedRecipe, null, 2)}\n`, "utf8");
    const pairedResult = await exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "parquet-paired-recipe.json",
      sourceRoot,
      outDir: "parquet-paired-handoff"
    });
    const pairedManifest = JSON.parse(await readFile(
      path.join(workspace, pairedResult.manifest_path),
      "utf8"
    )) as Record<string, any>;
    const pairedController = JSON.parse(await readFile(
      path.join(workspace, pairedResult.controller_map_path),
      "utf8"
    )) as Record<string, any>;
    const pairedTasks = (await readFile(
      path.join(workspace, pairedResult.reviewer_dir, "candidate-tasks.jsonl"),
      "utf8"
    )).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
    const pairedTrials = pairedManifest.candidates.flatMap((candidate: Record<string, any>) => [
      ...candidate.trials,
      ...candidate.comparator_trials
    ]);
    const pairedReviewerFiles = await Promise.all(pairedTrials.map((trial: Record<string, any>) =>
      readFile(path.join(workspace, pairedResult.reviewer_dir, trial.artifact_path), "utf8")));

    expect(pairedResult).toMatchObject({ base_candidate_count: 72, trial_artifact_count: 432 });
    expect(pairedManifest).toMatchObject({
      comparison_mode: "paired_operator",
      operator_groups_per_base: 2,
      trials_per_operator_group: 3,
      base_candidate_count: 72,
      trial_artifact_count: 432,
      comparator_operator_group_count: 3,
      largest_comparator_operator_group_share: 1 / 3,
      paired_comparison_floor_met: true,
      privacy_preflight_applied: true,
      privacy_unsafe_base_exclusion_count: 1
    });
    expect(pairedController.candidates.every((candidate: Record<string, any>) => {
      const primaryRefs = candidate.trials.map((trial: Record<string, any>) => trial.source_ref_id);
      const comparatorRefs = candidate.comparator_trials
        .map((trial: Record<string, any>) => trial.source_ref_id);
      return candidate.operator_group !== candidate.comparator_operator_group
        && candidate.trials.length === 3
        && candidate.comparator_trials.length === 3
        && new Set([...primaryRefs, ...comparatorRefs]).size === 6;
    })).toBe(true);
    expect(new Set(pairedController.candidates.map((candidate: Record<string, any>) =>
      candidate.source_family + ":" + candidate.base_group)).size).toBe(72);
    expect(pairedTasks.every((task) => task.schema_version === "1.1"
      && task.trial_ids.length === 6
      && task.trial_groups.length === 2
      && task.trial_groups[0].group_id === "group-a"
      && task.trial_groups[1].group_id === "group-b"
      && task.trial_groups.flatMap((group: Record<string, any>) => group.trial_ids).join("\0")
        === task.trial_ids.join("\0"))).toBe(true);
    expect(pairedReviewerFiles.join("\n")).not.toMatch(/operator-[0-9]|family-[0-9]|parquet_path/u);
    expect(await inspectPromotionTrialCandidateHandoff(path.join(
      workspace,
      pairedResult.output_dir
    ))).toMatchObject({ passed: true, issues: [] });
    const pairedWorksheet = await preparePromotionTrialCandidateAnnotationWorksheet({
      cwd: workspace,
      handoffRoot: pairedResult.output_dir,
      annotatorId: "reviewer-paired-worksheet",
      outputPath: "reviews/paired/review-worksheet.json"
    });
    expect(pairedWorksheet).toMatchObject({ task_count: 72, annotator_id: "reviewer-paired-worksheet" });
    await expect(preparePromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      handoffRoot: pairedResult.output_dir,
      annotatorIds: ["reviewer-alpha", "reviewer-alpha"],
      licenseReviewerId: "license-reviewer",
      outDir: "invalid-review-campaign"
    })).rejects.toThrow("two distinct annotators");
    await expect(access(path.join(workspace, "invalid-review-campaign"))).rejects.toThrow();

    const campaign = await preparePromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      handoffRoot: pairedResult.output_dir,
      annotatorIds: ["reviewer-alpha", "reviewer-beta"],
      licenseReviewerId: "license-reviewer",
      outDir: "paired-review-campaign"
    });
    expect(campaign).toMatchObject({
      candidate_count: 72,
      human_annotation_completed_count: 0,
      human_license_review_completed: false,
      reviewer_package_paths: [
        "paired-review-campaign/reviewer-a",
        "paired-review-campaign/reviewer-b"
      ],
      license_package_path: "paired-review-campaign/license-reviewer"
    });
    const campaignRoot = path.join(workspace, campaign.output_dir);
    expect(await inspectPromotionTrialCandidateReviewCampaign(campaignRoot)).toMatchObject({
      passed: true,
      issues: [],
      manifest: {
        status: "human_review_pending",
        candidate_count: 72,
        human_annotation_completed_count: 0,
        human_license_review_completed: false,
        adjudication_completed: false,
        confirmatory_admitted: false
      }
    });
    const campaignManifest = JSON.parse(await readFile(
      path.join(campaignRoot, PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_MANIFEST),
      "utf8"
    )) as Record<string, any>;
    expect(campaignManifest.assignments.map((item: Record<string, any>) =>
      item.participant_id)).toEqual([
      "reviewer-alpha",
      "reviewer-beta",
      "license-reviewer"
    ]);
    const reviewerATemplatePath = path.join(
      campaignRoot,
      "reviewer-a",
      "annotation-template.json"
    );
    const reviewerATemplateBytes = await readFile(reviewerATemplatePath);
    const reviewerATemplate = JSON.parse(
      reviewerATemplateBytes.toString("utf8")
    ) as Record<string, any>;
    expect(reviewerATemplate.independence_attestation).toEqual({
      completed_by_human: false,
      peer_annotations_unseen: false,
      controller_map_unseen: false
    });
    expect(reviewerATemplate.annotations).toHaveLength(72);
    expect(reviewerATemplate.annotations.every((item: Record<string, any>) =>
      Object.values(item.observations).every((value) => value === null)
      && item.evidence_refs.length === 0
      && item.rationale === "")).toBe(true);
    const licenseTemplate = JSON.parse(await readFile(path.join(
      campaignRoot,
      "license-reviewer",
      "license-review-template.json"
    ), "utf8")) as Record<string, any>;
    expect(licenseTemplate).toMatchObject({
      reviewer_id: "license-reviewer",
      independence_attestation: {
        completed_by_human: false,
        candidate_annotations_unseen: false,
        controller_map_unseen: false
      },
      review: { status: null, evidence_refs: [], rationale: "" }
    });
    await expect(access(path.join(
      campaignRoot,
      "reviewer-a",
      "packet",
      "controller"
    ))).rejects.toThrow();
    expect(await inspectPromotionTrialCandidateReviewerPacket(path.join(
      campaignRoot,
      "reviewer-a",
      "packet"
    ))).toMatchObject({ passed: true, issues: [] });
    expect(await inspectPromotionTrialCandidateReviewerPacket(path.join(
      campaignRoot,
      "reviewer-b",
      "packet"
    ))).toMatchObject({ passed: true, issues: [] });
    expect(await inspectPromotionTrialCandidateLicensePacket(path.join(
      campaignRoot,
      "license-reviewer",
      "packet"
    ))).toMatchObject({ passed: true, issues: [] });
    reviewerATemplate.independence_attestation.completed_by_human = true;
    await writeFile(
      reviewerATemplatePath,
      `${JSON.stringify(reviewerATemplate, null, 2)}\n`,
      "utf8"
    );
    const changedCampaign = await inspectPromotionTrialCandidateReviewCampaign(campaignRoot);
    expect(changedCampaign.passed).toBe(false);
    expect(changedCampaign.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "trial_candidate_review_campaign_inventory_invalid",
      "trial_candidate_review_campaign_reviewer_template_invalid"
    ]));
    await writeFile(reviewerATemplatePath, reviewerATemplateBytes);
    expect(await inspectPromotionTrialCandidateReviewCampaign(campaignRoot)).toMatchObject({
      passed: true,
      issues: []
    });

    const invalidPairedRoot = path.join(workspace, "parquet-paired-invalid-controller");
    await cp(path.join(workspace, pairedResult.output_dir), invalidPairedRoot, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    const invalidControllerPath = path.join(
      invalidPairedRoot,
      "controller",
      "trial-candidate-map.json"
    );
    const invalidController = JSON.parse(await readFile(invalidControllerPath, "utf8")) as Record<string, any>;
    invalidController.candidates[0].comparator_operator_group =
      invalidController.candidates[0].operator_group;
    await writeFile(invalidControllerPath, `${JSON.stringify(invalidController, null, 2)}\n`, "utf8");
    const invalidPairedInspection = await inspectPromotionTrialCandidateHandoff(invalidPairedRoot);
    expect(invalidPairedInspection.passed).toBe(false);
    expect(invalidPairedInspection.issues.map((issue) => issue.code)).toContain(
      "trial_candidate_handoff_controller_map_invalid"
    );

    const malformedTransformRecipe = JSON.parse(await readFile(recipePath, "utf8")) as Record<string, any>;
    malformedTransformRecipe.handoff_id = "candidate-handoff-parquet-malformed-transform";
    malformedTransformRecipe.family_value_transform.delimiter = "";
    const malformedTransformRecipePath = path.join(workspace, "parquet-malformed-transform-recipe.json");
    await writeFile(
      malformedTransformRecipePath,
      `${JSON.stringify(malformedTransformRecipe, null, 2)}\n`,
      "utf8"
    );
    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "parquet-malformed-transform-recipe.json",
      sourceRoot,
      outDir: "parquet-malformed-transform-handoff"
    })).rejects.toThrow("valid grouping pointers");

    const malformedPairedRecipe = JSON.parse(await readFile(recipePath, "utf8")) as Record<string, any>;
    malformedPairedRecipe.handoff_id = "candidate-handoff-parquet-malformed-paired";
    malformedPairedRecipe.comparison_policy = {
      mode: "paired_operator",
      groups_per_base: 2,
      trials_per_group: 2
    };
    const malformedPairedRecipePath = path.join(workspace, "parquet-malformed-paired-recipe.json");
    await writeFile(
      malformedPairedRecipePath,
      `${JSON.stringify(malformedPairedRecipe, null, 2)}\n`,
      "utf8"
    );
    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "parquet-malformed-paired-recipe.json",
      sourceRoot,
      outDir: "parquet-malformed-paired-handoff"
    })).rejects.toThrow("three trials per group");

    const duplicateRecipe = JSON.parse(await readFile(recipePath, "utf8")) as Record<string, any>;
    duplicateRecipe.handoff_id = "candidate-handoff-parquet-duplicate-source";
    duplicateRecipe.base_pointer = "/instance/shared_id";
    const duplicateRecipePath = path.join(workspace, "parquet-duplicate-recipe.json");
    await writeFile(duplicateRecipePath, `${JSON.stringify(duplicateRecipe, null, 2)}\n`, "utf8");
    await expect(exportPromotionTrialCandidateHandoff({
      cwd: workspace,
      recipePath: "parquet-duplicate-recipe.json",
      sourceRoot,
      outDir: "parquet-duplicate-handoff"
    })).rejects.toThrow("globally distinct source-native balanced three-trial bases");
  });

  it("keeps resumable human review blank, partial, and preflight-bound", async () => {
    const prepared = await preparePromotionTrialCandidateReviewWorkspace({
      cwd: workspace,
      packageRoot: "paired-review-campaign/reviewer-a",
      outDir: "paired-review-workspace"
    });
    expect(prepared).toMatchObject({
      annotator_id: "reviewer-alpha",
      task_count: 72,
      output_dir: "paired-review-workspace"
    });

    const blankAudit = await auditPromotionTrialCandidateReviewWorkspace({
      cwd: workspace,
      workspaceRoot: prepared.output_dir,
      outDir: "paired-review-workspace-audit-blank"
    });
    expect(blankAudit.report).toMatchObject({
      workspace_valid: true,
      ready_to_finalize: false,
      task_count: 72,
      completed_annotation_count: 0,
      incomplete_annotation_count: 72,
      malformed_annotation_count: 0,
      attestation_complete: false,
      packet_integrity_valid: true,
      validation_issues: []
    });
    await expect(finalizePromotionTrialCandidateReviewWorkspace({
      cwd: workspace,
      workspaceRoot: prepared.output_dir,
      outputPath: "paired-review-returns/reviewer-alpha.json"
    })).rejects.toThrow("not ready to finalize");
    await expect(access(path.join(
      workspace,
      "paired-review-returns/reviewer-alpha.json"
    ))).rejects.toThrow();

    const workspaceManifest = JSON.parse(await readFile(path.join(
      workspace,
      prepared.output_dir,
      PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_MANIFEST
    ), "utf8")) as Record<string, any>;
    const completeCandidate = async (
      item: Record<string, string>,
      rationale: string
    ): Promise<void> => {
      const target = path.join(workspace, prepared.output_dir, item.path);
      const annotation = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
      annotation.observations = Object.fromEntries(
        PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.map((field) => [field, "negative"])
      );
      annotation.rationale = rationale;
      await writeJsonFile(target, annotation);
    };
    await completeCandidate(
      workspaceManifest.candidate_files[0],
      "No positive availability observation was established in this contract fixture."
    );
    const partialAudit = await auditPromotionTrialCandidateReviewWorkspace({
      cwd: workspace,
      workspaceRoot: prepared.output_dir,
      outDir: "paired-review-workspace-audit-partial"
    });
    expect(partialAudit.report).toMatchObject({
      workspace_valid: true,
      ready_to_finalize: false,
      completed_annotation_count: 1,
      incomplete_annotation_count: 71,
      malformed_annotation_count: 0
    });

    await Promise.all(workspaceManifest.candidate_files.slice(1).map(
      (item: Record<string, string>) => completeCandidate(
        item,
        "No positive availability observation was established in this contract fixture."
      )
    ));
    await writeJsonFile(path.join(
      workspace,
      prepared.output_dir,
      PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_ATTESTATION
    ), {
      completed_by_human: true,
      peer_annotations_unseen: true,
      controller_map_unseen: true
    });
    const completedAudit = await auditPromotionTrialCandidateReviewWorkspace({
      cwd: workspace,
      workspaceRoot: prepared.output_dir,
      outDir: "paired-review-workspace-audit-complete"
    });
    expect(completedAudit.report).toMatchObject({
      workspace_valid: true,
      ready_to_finalize: true,
      completed_annotation_count: 72,
      incomplete_annotation_count: 0,
      malformed_annotation_count: 0,
      attestation_complete: true
    });

    const finalized = await finalizePromotionTrialCandidateReviewWorkspace({
      cwd: workspace,
      workspaceRoot: prepared.output_dir,
      outputPath: "paired-review-returns/reviewer-alpha.json"
    });
    expect(finalized).toMatchObject({
      annotator_id: "reviewer-alpha",
      task_count: 72,
      reviewer_root: "paired-review-workspace/packet",
      preflight_required: true
    });
    const parsed = parsePromotionTrialCandidateInitialAnnotationSet(JSON.parse(
      await readFile(path.join(workspace, finalized.output_path), "utf8")
    ) as unknown);
    expect(parsed.annotations).toHaveLength(72);
    const preflight = await preflightPromotionTrialCandidateAnnotation({
      cwd: workspace,
      reviewerRoot: finalized.reviewer_root,
      annotationPath: finalized.output_path,
      outDir: "paired-review-workspace-preflight"
    });
    expect(preflight.report).toMatchObject({
      passed: true,
      annotator_id: "reviewer-alpha",
      annotation_count: 72,
      positive_candidate_count: 0,
      source_eligible_candidate_count: 0,
      validation_issues: []
    });
  });

  it("collects only assigned campaign returns and binds the adjudication inputs", async () => {
    await preparePromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      handoffRoot: "parquet-paired-handoff",
      annotatorIds: ["campaign-reviewer-a", "campaign-reviewer-b"],
      licenseReviewerId: "campaign-license-reviewer",
      outDir: "assigned-return-campaign"
    });
    await writeHumanAnnotation(
      path.join(workspace, "assigned-review-a.json"),
      path.join(workspace, "parquet-paired-handoff"),
      "campaign-reviewer-a"
    );
    await writeHumanAnnotation(
      path.join(workspace, "assigned-review-b.json"),
      path.join(workspace, "parquet-paired-handoff"),
      "campaign-reviewer-b"
    );
    await writeLicenseReview(
      path.join(workspace, "assigned-license-review.json"),
      path.join(workspace, "parquet-paired-handoff"),
      "campaign-license-reviewer"
    );

    const result = await collectPromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      campaignRoot: "assigned-return-campaign",
      handoffRoot: "parquet-paired-handoff",
      annotationPaths: ["assigned-review-b.json", "assigned-review-a.json"],
      licenseReviewPath: "assigned-license-review.json",
      outDir: "assigned-campaign-return"
    });

    expect(result.receipt).toMatchObject({
      status: "adjudicated",
      passed: true,
      assigned_return_count: 3,
      required_return_count: 3,
      adjudication: {
        attempted: true,
        passed: true,
        accepted_label_count: 72,
        task_count: 72,
        source_eligible_candidate_count: 0
      },
      validation_issues: [],
      confirmatory_admitted: false
    });
    expect(await inspectPromotionTrialCandidateCampaignReturn(
      path.join(workspace, "assigned-campaign-return")
    )).toMatchObject({ passed: true, issues: [] });

    await writeFile(
      path.join(workspace, "assigned-campaign-return", "returns", "reviewer-a.json"),
      "{}\n",
      "utf8"
    );
    const changed = await inspectPromotionTrialCandidateCampaignReturn(
      path.join(workspace, "assigned-campaign-return")
    );
    expect(changed.passed).toBe(false);
    expect(changed.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "trial_candidate_campaign_return_inventory_invalid",
      "trial_candidate_campaign_return_file_hash_mismatch"
    ]));
  });

  it("blocks malformed or wrong-handoff campaign returns before adjudication", async () => {
    await preparePromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      handoffRoot: "parquet-paired-handoff",
      annotatorIds: ["assigned-reviewer-a", "assigned-reviewer-b"],
      licenseReviewerId: "assigned-license-reviewer",
      outDir: "mismatched-return-campaign"
    });
    await writeHumanAnnotation(
      path.join(workspace, "mismatched-review-a.json"),
      path.join(workspace, "parquet-paired-handoff"),
      ""
    );
    await writeHumanAnnotation(
      path.join(workspace, "mismatched-review-b.json"),
      path.join(workspace, "parquet-paired-handoff"),
      "assigned-reviewer-b"
    );
    await writeLicenseReview(
      path.join(workspace, "mismatched-license-review.json"),
      path.join(workspace, "parquet-paired-handoff"),
      "assigned-license-reviewer"
    );
    await expect(collectPromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      campaignRoot: "mismatched-return-campaign",
      handoffRoot: "handoff",
      annotationPaths: ["mismatched-review-a.json", "mismatched-review-b.json"],
      licenseReviewPath: "mismatched-license-review.json",
      outDir: "wrong-handoff-campaign-return"
    })).rejects.toThrow("does not bind");
    await expect(access(path.join(workspace, "wrong-handoff-campaign-return"))).rejects.toThrow();

    const result = await collectPromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      campaignRoot: "mismatched-return-campaign",
      handoffRoot: "parquet-paired-handoff",
      annotationPaths: ["mismatched-review-a.json", "mismatched-review-b.json"],
      licenseReviewPath: "mismatched-license-review.json",
      outDir: "mismatched-campaign-return"
    });

    expect(result.receipt).toMatchObject({
      status: "review_return_blocked",
      passed: false,
      assigned_return_count: 2,
      adjudication: { attempted: false, passed: false },
      confirmatory_admitted: false
    });
    expect(result.receipt.validation_issues.map((issue) => issue.code)).toContain(
      "trial_candidate_campaign_return_reviewer_assignment_mismatch"
    );
    expect(await inspectPromotionTrialCandidateCampaignReturn(
      path.join(workspace, "mismatched-campaign-return")
    )).toMatchObject({ passed: true, issues: [] });
  });

  it("preserves pending campaign templates as a blocked adjudication", async () => {
    await preparePromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      handoffRoot: "parquet-paired-handoff",
      annotatorIds: ["pending-reviewer-a", "pending-reviewer-b"],
      licenseReviewerId: "pending-license-reviewer",
      outDir: "pending-return-campaign"
    });

    const result = await collectPromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      campaignRoot: "pending-return-campaign",
      handoffRoot: "parquet-paired-handoff",
      annotationPaths: [
        "pending-return-campaign/reviewer-a/annotation-template.json",
        "pending-return-campaign/reviewer-b/annotation-template.json"
      ],
      licenseReviewPath: "pending-return-campaign/license-reviewer/license-review-template.json",
      outDir: "pending-campaign-return"
    });

    expect(result.receipt).toMatchObject({
      status: "review_return_blocked",
      passed: false,
      assigned_return_count: 3,
      adjudication: {
        attempted: true,
        passed: false,
        accepted_label_count: 0,
        task_count: 72,
        source_eligible_candidate_count: 0
      },
      confirmatory_admitted: false
    });
    expect(result.receipt.validation_issues.map((issue) => issue.code)).toContain(
      "trial_candidate_campaign_return_adjudication_blocked"
    );
    expect(await inspectPromotionTrialCandidateCampaignReturn(
      path.join(workspace, "pending-campaign-return")
    )).toMatchObject({ passed: true, issues: [] });
  });

  it("preflights exact human task coverage without promoting negative labels", async () => {
    const handoffRoot = path.join(workspace, "handoff");
    const annotationPath = path.join(workspace, "review-a.json");
    await writeHumanAnnotation(annotationPath, handoffRoot, "reviewer-a");
    await cp(path.join(handoffRoot, "reviewer"), path.join(workspace, "isolated-reviewer-packet"), {
      recursive: true,
      errorOnExist: true,
      force: false
    });

    const result = await preflightPromotionTrialCandidateAnnotation({
      cwd: workspace,
      reviewerRoot: "isolated-reviewer-packet",
      annotationPath: "review-a.json",
      outDir: "review-a-preflight"
    });

    expect(result.report).toMatchObject({
      passed: true,
      annotator_id: "reviewer-a",
      task_count: 72,
      annotation_count: 72,
      positive_candidate_count: 0,
      validation_issues: []
    });
  });

  it("prepares an unlabeled worksheet that cannot pass human annotation preflight", async () => {
    const result = await preparePromotionTrialCandidateAnnotationWorksheet({
      cwd: workspace,
      handoffRoot: "handoff",
      annotatorId: "reviewer-worksheet",
      outputPath: "reviews/reviewer-a/review-worksheet.json"
    });
    const worksheet = JSON.parse(await readFile(
      path.join(workspace, result.output_path),
      "utf8"
    )) as Record<string, any>;

    expect(result).toMatchObject({ task_count: 72, annotator_id: "reviewer-worksheet" });
    expect(worksheet.independence_attestation).toEqual({
      completed_by_human: false,
      peer_annotations_unseen: false,
      controller_map_unseen: false
    });
    expect(worksheet.annotations).toHaveLength(72);
    expect(worksheet.annotations.every((annotation: Record<string, any>) =>
      Object.values(annotation.observations).every((value) => value === null)
      && annotation.evidence_refs.length === 0
      && annotation.rationale === ""
    )).toBe(true);

    const preflight = await preflightPromotionTrialCandidateAnnotation({
      cwd: workspace,
      reviewerRoot: "handoff/reviewer",
      annotationPath: "reviews/reviewer-a/review-worksheet.json",
      outDir: "review-worksheet-preflight"
    });
    expect(preflight.report.passed).toBe(false);
    expect(preflight.report.validation_issues.map((issue) => issue.code)).toContain(
      "trial_candidate_annotation_file_invalid"
    );
  });

  it("prepares an undecided source-license worksheet that cannot pass human review parsing", async () => {
    const result = await preparePromotionTrialCandidateLicenseReviewWorksheet({
      cwd: workspace,
      handoffRoot: "handoff",
      reviewerId: "license-reviewer-worksheet",
      outputPath: "reviews/license/license-review.json"
    });
    const worksheet = JSON.parse(await readFile(
      path.join(workspace, result.output_path),
      "utf8"
    )) as Record<string, any>;

    expect(result).toMatchObject({ reviewer_id: "license-reviewer-worksheet" });
    expect(worksheet.independence_attestation).toEqual({
      completed_by_human: false,
      candidate_annotations_unseen: false,
      controller_map_unseen: false
    });
    expect(worksheet.review).toEqual({ status: null, evidence_refs: [], rationale: "" });
    expect(() => parsePromotionTrialCandidateLicenseReviewSet(worksheet)).toThrow(
      "Trial-candidate source-license review set is invalid."
    );

    const incompletePreflight = await preflightPromotionTrialCandidateLicenseReview({
      cwd: workspace,
      licenseRoot: "handoff/license",
      reviewPath: result.output_path,
      outDir: "reviews/license/incomplete-preflight"
    });
    expect(incompletePreflight.report.passed).toBe(false);
    expect(incompletePreflight.report.validation_issues.map((issue) => issue.code)).toContain(
      "trial_candidate_license_review_file_invalid"
    );
  });

  it("preflights one complete source-license review without candidate annotations", async () => {
    const handoffRoot = path.join(workspace, "handoff");
    await writeLicenseReview(
      path.join(workspace, "reviews", "license", "complete-review.json"),
      handoffRoot,
      "license-reviewer-preflight"
    );
    await cp(path.join(handoffRoot, "license"), path.join(workspace, "isolated-license-packet"), {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    const result = await preflightPromotionTrialCandidateLicenseReview({
      cwd: workspace,
      licenseRoot: "isolated-license-packet",
      reviewPath: "reviews/license/complete-review.json",
      outDir: "reviews/license/complete-preflight"
    });

    expect(result.report).toMatchObject({
      passed: true,
      reviewer_id: "license-reviewer-preflight",
      license_status: "uncertain",
      evidence_reference_count: 0,
      validation_issues: []
    });
    expect(Object.values(result.report.input_sha256).every((value) => /^[a-f0-9]{64}$/u.test(value))).toBe(true);
  });

  it("requires observation-specific citations and existing JSON Pointers for positive labels", async () => {
    const handoffRoot = path.join(workspace, "handoff");
    await writeHumanAnnotation(
      path.join(workspace, "review-positive.json"),
      handoffRoot,
      "reviewer-positive",
      { firstCandidatePositive: true }
    );
    const valid = await preflightPromotionTrialCandidateAnnotation({
      cwd: workspace,
      reviewerRoot: "handoff/reviewer",
      annotationPath: "review-positive.json",
      outDir: "review-positive-preflight"
    });
    expect(valid.report).toMatchObject({ passed: true, positive_candidate_count: 1 });

    await writeHumanAnnotation(
      path.join(workspace, "review-invalid-pointer.json"),
      handoffRoot,
      "reviewer-invalid-pointer",
      { firstCandidatePositive: true, invalidPointer: true }
    );
    const invalid = await preflightPromotionTrialCandidateAnnotation({
      cwd: workspace,
      reviewerRoot: "handoff/reviewer",
      annotationPath: "review-invalid-pointer.json",
      outDir: "review-invalid-pointer-preflight"
    });
    expect(invalid.report.passed).toBe(false);
    expect(invalid.report.validation_issues.map((issue) => issue.code)).toContain(
      "trial_candidate_annotation_json_pointer_missing"
    );
  });

  it("adjudicates two independent negative reviews without confirmatory admission", async () => {
    const handoffRoot = path.join(workspace, "handoff");
    const secondPath = path.join(workspace, "review-b.json");
    await writeHumanAnnotation(secondPath, handoffRoot, "reviewer-b");
    await writeLicenseReview(path.join(workspace, "license-review.json"), handoffRoot, "reviewer-license");

    const result = await adjudicatePromotionTrialCandidateReview({
      cwd: workspace,
      handoffRoot: "handoff",
      annotationPaths: ["review-a.json", "review-b.json"],
      licenseReviewPath: "license-review.json",
      outDir: "review-adjudication"
    });
    const evidence = JSON.parse(await readFile(
      path.join(workspace, "review-adjudication", PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE),
      "utf8"
    ));

    expect(result.report).toMatchObject({
      passed: true,
      accepted_label_count: 72,
      disagreement_count: 0,
      initial_annotator_ids: ["reviewer-a", "reviewer-b"],
      license_reviewer_id: "reviewer-license"
    });
    expect(evidence).toMatchObject({
      double_human_annotation_completed: true,
      human_license_review_recorded: true,
      source_license_status: "uncertain",
      source_license_adjudication: {
        reviewer_id: "reviewer-license",
        review: { status: "uncertain" }
      },
      positive_candidate_count: 0,
      redistributable_positive_candidate_count: 0,
      source_eligible_candidate_count: 0,
      redistributable_source_eligible_candidate_count: 0,
      candidate_review_progression_floor_met: false,
      confirmatory_admitted: false
    });
    expect(await inspectPromotionTrialCandidateReviewAdjudication(
      path.join(workspace, "review-adjudication")
    )).toMatchObject({ passed: true, issues: [] });
    await expect(preparePromotionCanonicalCurationHandoff({
      cwd: workspace,
      handoffRoot: "handoff",
      campaignReturnRoot: "review-adjudication",
      curatorId: "curator-alpha",
      verifierId: "verifier-beta",
      curatorProtocolVersion: "curation-protocol-1",
      verifierProtocolVersion: "verification-protocol-1",
      outDir: "raw-adjudication-curation-handoff"
    })).rejects.toThrow("assigned review-campaign return");
    const pairedHandoffRoot = path.join(workspace, "parquet-paired-handoff");
    await writeHumanAnnotation(
      path.join(workspace, "ineligible-paired-review-a.json"),
      pairedHandoffRoot,
      "ineligible-reviewer-a"
    );
    await writeHumanAnnotation(
      path.join(workspace, "ineligible-paired-review-b.json"),
      pairedHandoffRoot,
      "ineligible-reviewer-b"
    );
    await writeLicenseReview(
      path.join(workspace, "ineligible-paired-license.json"),
      pairedHandoffRoot,
      "ineligible-license-reviewer"
    );
    await preparePromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      handoffRoot: "parquet-paired-handoff",
      annotatorIds: ["ineligible-reviewer-a", "ineligible-reviewer-b"],
      licenseReviewerId: "ineligible-license-reviewer",
      outDir: "ineligible-review-campaign"
    });
    await collectPromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      campaignRoot: "ineligible-review-campaign",
      handoffRoot: "parquet-paired-handoff",
      annotationPaths: ["ineligible-paired-review-a.json", "ineligible-paired-review-b.json"],
      licenseReviewPath: "ineligible-paired-license.json",
      outDir: "ineligible-campaign-return"
    });
    await expect(preparePromotionCanonicalCurationHandoff({
      cwd: workspace,
      handoffRoot: "parquet-paired-handoff",
      campaignReturnRoot: "ineligible-campaign-return",
      curatorId: "curator-alpha",
      verifierId: "verifier-beta",
      curatorProtocolVersion: "curation-protocol-1",
      verifierProtocolVersion: "verification-protocol-1",
      outDir: "ineligible-curation-handoff"
    })).rejects.toThrow("source-eligible review floor");
    await expect(access(path.join(workspace, "ineligible-curation-handoff"))).rejects.toThrow();
  });

  it("allows source-eligible reviews to progress to curation without inventing paper artifacts", async () => {
    const handoffRoot = path.join(workspace, "parquet-paired-handoff");
    await writeHumanAnnotation(
      path.join(workspace, "source-eligible-a.json"),
      handoffRoot,
      "source-reviewer-a",
      { allCandidatesSourceEligible: true }
    );
    await writeHumanAnnotation(
      path.join(workspace, "source-eligible-b.json"),
      handoffRoot,
      "source-reviewer-b",
      { allCandidatesSourceEligible: true }
    );
    await writeLicenseReview(
      path.join(workspace, "source-eligible-license.json"),
      handoffRoot,
      "source-license-reviewer",
      {
        status: "redistribution_permitted",
        evidenceRefs: ["https://example.org/source-license"]
      }
    );

    const result = await adjudicatePromotionTrialCandidateReview({
      cwd: workspace,
      handoffRoot: "parquet-paired-handoff",
      annotationPaths: ["source-eligible-a.json", "source-eligible-b.json"],
      licenseReviewPath: "source-eligible-license.json",
      outDir: "source-eligible-adjudication"
    });
    const evidence = JSON.parse(await readFile(
      path.join(workspace, "source-eligible-adjudication", PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE),
      "utf8"
    ));

    expect(result.report).toMatchObject({ passed: true, accepted_label_count: 72 });
    expect(evidence).toMatchObject({
      positive_candidate_count: 0,
      redistributable_positive_candidate_count: 0,
      source_eligible_candidate_count: 72,
      redistributable_source_eligible_candidate_count: 72,
      candidate_review_progression_floor_met: true,
      confirmatory_admitted: false,
      remaining_blockers: ["canonical_source_projection", "confirmatory_intake_freeze"]
    });
    expect(await inspectPromotionTrialCandidateReviewAdjudication(
      path.join(workspace, "source-eligible-adjudication")
    )).toMatchObject({ passed: true, issues: [] });
    const admission = await loadPromotionTrialCandidateReviewAdmissionEvidence(
      path.join(workspace, "source-eligible-adjudication")
    );
    expect(admission).toMatchObject({
      candidate_count: 72,
      source_license_status: "redistribution_permitted",
      candidate_review_progression_floor_met: true
    });
    expect(admission.source_eligible_candidate_ids).toHaveLength(72);
    expect(new Set(admission.source_eligible_candidate_ids)).toHaveProperty("size", 72);

    await preparePromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      handoffRoot: "parquet-paired-handoff",
      annotatorIds: ["source-reviewer-a", "source-reviewer-b"],
      licenseReviewerId: "source-license-reviewer",
      outDir: "source-eligible-review-campaign"
    });
    const campaignReturn = await collectPromotionTrialCandidateReviewCampaign({
      cwd: workspace,
      campaignRoot: "source-eligible-review-campaign",
      handoffRoot: "parquet-paired-handoff",
      annotationPaths: ["source-eligible-b.json", "source-eligible-a.json"],
      licenseReviewPath: "source-eligible-license.json",
      outDir: "source-eligible-campaign-return"
    });
    expect(campaignReturn.receipt).toMatchObject({
      passed: true,
      assigned_return_count: 3,
      adjudication: {
        passed: true,
        source_eligible_candidate_count: 72
      }
    });

    const curationHandoff = await preparePromotionCanonicalCurationHandoff({
      cwd: workspace,
      handoffRoot: "parquet-paired-handoff",
      campaignReturnRoot: "source-eligible-campaign-return",
      curatorId: "curator-alpha",
      verifierId: "verifier-beta",
      curatorProtocolVersion: "curation-protocol-1",
      verifierProtocolVersion: "verification-protocol-1",
      outDir: "canonical-curation-handoff"
    });
    expect(curationHandoff).toMatchObject({
      task_count: 72,
      canonical_source_count: 0,
      canonical_curation_completed: false
    });
    const curationInspection = await inspectPromotionCanonicalCurationHandoff(
      path.join(workspace, "canonical-curation-handoff")
    );
    expect(curationInspection).toMatchObject({
      passed: true,
      issues: [],
      manifest: {
        schema_version: "1.1",
        status: "human_curation_pending",
        source_eligible_candidate_count: 72,
        task_count: 72,
        canonical_source_count: 0,
        curation_completed_count: 0,
        verification_completed_count: 0,
        canonical_curation_completed: false,
        confirmatory_admitted: false
      }
    });
    const curationTasks = (await readFile(path.join(
      workspace,
      "canonical-curation-handoff",
      PROMOTION_CANONICAL_CURATION_TASKS
    ), "utf8")).split(/\r?\n/u).filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
    expect(curationTasks).toHaveLength(72);
    expect(curationTasks.every((task) =>
      task.status === "pending_human_curation"
      && task.source_trials.length === 6
      && task.required_artifacts.length === 15
      && task.canonical_source_root === null
      && task.curator_attestation.completed_by_human === false
      && task.verifier_attestation.completed_by_human === false)).toBe(true);
    await expect(access(path.join(
      workspace,
      "canonical-curation-handoff",
      PROMOTION_CANONICAL_CURATION_RECORD
    ))).rejects.toThrow();
    const curationManifest = JSON.parse(await readFile(path.join(
      workspace,
      "canonical-curation-handoff",
      PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST
    ), "utf8"));
    expect(path.basename(curationManifest.upstream.campaign_return_receipt_path)).toBe(
      PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT
    );
    expect(curationManifest.files.map((file: { path: string }) => file.path)).toEqual(
      expect.arrayContaining([
        curationManifest.upstream.campaign_return_receipt_path,
        "upstream/review-campaign-return/returns/reviewer-a.json",
        "upstream/review-campaign-return/returns/reviewer-b.json",
        "upstream/review-campaign-return/returns/license-reviewer.json"
      ])
    );
    expect(curationManifest.files.some((file: { path: string }) =>
      path.basename(file.path) === PROMOTION_CANONICAL_CURATION_RECORD)).toBe(false);
    const firstCurationTrace = path.join(
      workspace,
      "canonical-curation-handoff",
      "curator",
      curationTasks[0].source_trials[0].artifact_path
    );
    const originalCurationTrace = await readFile(firstCurationTrace);
    await writeFile(firstCurationTrace, "{}\n", "utf8");
    const curationTampered = await inspectPromotionCanonicalCurationHandoff(
      path.join(workspace, "canonical-curation-handoff")
    );
    expect(curationTampered.passed).toBe(false);
    expect(curationTampered.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "canonical_curation_handoff_file_inventory_invalid",
      "canonical_curation_handoff_tasks_invalid"
    ]));
    await writeFile(firstCurationTrace, originalCurationTrace);
    const copiedHandoffPath = path.join(
      workspace,
      "canonical-curation-handoff",
      curationManifest.upstream.handoff_manifest_path
    );
    const originalCopiedHandoff = await readFile(copiedHandoffPath);
    const changedCopiedHandoff = JSON.parse(originalCopiedHandoff.toString("utf8"));
    changedCopiedHandoff.candidates[0].base_candidate_sha256 = "f".repeat(64);
    await writeJsonFile(copiedHandoffPath, changedCopiedHandoff);
    const changedHandoffHash = createHash("sha256")
      .update(await readFile(copiedHandoffPath)).digest("hex");
    curationManifest.upstream.handoff_manifest_sha256 = changedHandoffHash;
    const handoffBinding = curationManifest.files.find((file: { path: string }) =>
      file.path === curationManifest.upstream.handoff_manifest_path);
    if (!handoffBinding) throw new Error("Missing copied handoff binding.");
    handoffBinding.sha256 = changedHandoffHash;
    await writeJsonFile(path.join(
      workspace,
      "canonical-curation-handoff",
      PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST
    ), curationManifest);
    const semanticHandoffTampered = await inspectPromotionCanonicalCurationHandoff(
      path.join(workspace, "canonical-curation-handoff")
    );
    expect(semanticHandoffTampered.passed).toBe(false);
    expect(semanticHandoffTampered.issues.map((issue) => issue.code)).toContain(
      "canonical_curation_handoff_upstream_handoff_invalid"
    );
    expect(semanticHandoffTampered.issues.map((issue) => issue.code)).toContain(
      "canonical_curation_handoff_upstream_campaign_return_invalid"
    );
    expect(semanticHandoffTampered.issues.map((issue) => issue.code)).not.toContain(
      "canonical_curation_handoff_file_inventory_invalid"
    );
    await writeFile(copiedHandoffPath, originalCopiedHandoff);
    const originalHandoffHash = createHash("sha256")
      .update(originalCopiedHandoff).digest("hex");
    curationManifest.upstream.handoff_manifest_sha256 = originalHandoffHash;
    handoffBinding.sha256 = originalHandoffHash;
    const unauthorizedCompletionPath = path.join(
      workspace,
      "canonical-curation-handoff",
      "curator",
      "completion.json"
    );
    await writeFile(unauthorizedCompletionPath, "{}\n", "utf8");
    curationManifest.files.push({
      path: "curator/completion.json",
      sha256: createHash("sha256").update(await readFile(unauthorizedCompletionPath)).digest("hex")
    });
    curationManifest.files.sort((left: { path: string }, right: { path: string }) =>
      left.path.localeCompare(right.path));
    await writeJsonFile(path.join(
      workspace,
      "canonical-curation-handoff",
      PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST
    ), curationManifest);
    const unauthorizedCompletion = await inspectPromotionCanonicalCurationHandoff(
      path.join(workspace, "canonical-curation-handoff")
    );
    expect(unauthorizedCompletion.passed).toBe(false);
    expect(unauthorizedCompletion.issues.map((issue) => issue.code)).toContain(
      "canonical_curation_handoff_file_contract_invalid"
    );
    expect(unauthorizedCompletion.issues.map((issue) => issue.code)).not.toContain(
      "canonical_curation_handoff_file_inventory_invalid"
    );
    await rm(unauthorizedCompletionPath);
    curationManifest.files = curationManifest.files.filter((file: { path: string }) =>
      file.path !== "curator/completion.json");
    await writeJsonFile(path.join(
      workspace,
      "canonical-curation-handoff",
      PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST
    ), curationManifest);
    expect(await inspectPromotionCanonicalCurationHandoff(path.join(
      workspace,
      "canonical-curation-handoff"
    ))).toMatchObject({ passed: true, issues: [] });

    const handoffManifest = JSON.parse(await readFile(
      path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST),
      "utf8"
    )) as {
      handoff_id: string;
      source_revision: string;
      candidates: PromotionTrialCandidateRecord[];
    };
    const controllerMap = JSON.parse(await readFile(
      path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_CONTROLLER_MAP),
      "utf8"
    )) as {
      candidates: Array<{
        candidate_id: string;
        source_family: string;
        operator_group: string;
      }>;
    };
    const controllerByCandidate = new Map(controllerMap.candidates.map((candidate) => [
      candidate.candidate_id,
      candidate
    ]));
    const intakeSources = [];
    const canonicalSourceRoots: string[] = [];
    for (const [index, candidate] of handoffManifest.candidates.entries()) {
      const controller = controllerByCandidate.get(candidate.candidate_id);
      if (!controller) throw new Error("Controller fixture is missing a candidate.");
      const sourceRoot = path.join(workspace, "canonical-sources", candidate.candidate_id);
      await writeCanonicalConfirmatorySource({
        root: sourceRoot,
        ordinal: index + 1,
        handoffId: handoffManifest.handoff_id,
        sourceRevision: handoffManifest.source_revision,
        candidate
      });
      canonicalSourceRoots.push(path.relative(workspace, sourceRoot).replace(/\\/gu, "/"));
      intakeSources.push({
        source_id: `source-${String(index + 1).padStart(2, "0")}`,
        source_root: path.relative(workspace, sourceRoot).replace(/\\/gu, "/"),
        evidence_class: "external_real_run",
        source_family_id: controller.source_family,
        operator_group_id: controller.operator_group,
        source_revision: handoffManifest.source_revision,
        origin_kind: "native",
        distribution_scope: "redistributable",
        license_review_status: "human_verified",
        candidate_id: candidate.candidate_id
      });
    }
    await expect(collectPromotionCanonicalCurationReturn({
      cwd: workspace,
      curationHandoffRoot: "canonical-curation-handoff",
      sourceRoots: [
        canonicalSourceRoots[0],
        `${canonicalSourceRoots[0]}/paper`
      ],
      outDir: "canonical-curation-return-overlap"
    })).rejects.toThrow("source roots must not overlap");
    await expect(access(path.join(
      workspace,
      "canonical-curation-return-overlap"
    ))).rejects.toThrow();
    const roleMismatchReturn = await collectPromotionCanonicalCurationReturn({
      cwd: workspace,
      curationHandoffRoot: "canonical-curation-handoff",
      sourceRoots: canonicalSourceRoots,
      outDir: "canonical-curation-return-role-mismatch"
    });
    expect(roleMismatchReturn.receipt).toMatchObject({
      status: "curation_return_blocked",
      passed: false,
      received_return_count: 72,
      assigned_return_count: 0,
      verified_return_count: 0,
      required_return_count: 72
    });
    expect(roleMismatchReturn.receipt.validation_issues.every((issue) =>
      issue.code === "canonical_curation_return_role_assignment_mismatch")).toBe(true);
    expect(await inspectPromotionCanonicalCurationReturn(path.join(
      workspace,
      "canonical-curation-return-role-mismatch"
    ))).toMatchObject({ passed: true, issues: [], receipt: { passed: false } });

    for (const sourceRoot of canonicalSourceRoots) {
      const curationPath = path.join(workspace, sourceRoot, PROMOTION_CANONICAL_CURATION_RECORD);
      const record = JSON.parse(await readFile(curationPath, "utf8"));
      record.curator_id = "curator-alpha";
      record.verifier_id = "verifier-beta";
      await writeJsonFile(curationPath, record);
    }
    const curationReturn = await collectPromotionCanonicalCurationReturn({
      cwd: workspace,
      curationHandoffRoot: "canonical-curation-handoff",
      sourceRoots: canonicalSourceRoots,
      outDir: "canonical-curation-return"
    });
    expect(curationReturn.receipt).toMatchObject({
      status: "verified",
      passed: true,
      received_return_count: 72,
      assigned_return_count: 72,
      verified_return_count: 72,
      required_return_count: 72,
      confirmatory_admitted: false,
      validation_issues: []
    });
    expect(curationReturn.receipt.returns).toHaveLength(72);
    const returnedSourceByCandidate = new Map(curationReturn.receipt.returns.flatMap(
      (binding) => binding.candidate_id ? [[binding.candidate_id, binding.source_path] as const] : []
    ));
    const returnedIntakeSources = intakeSources.map((source) => {
      const returnedSourcePath = returnedSourceByCandidate.get(source.candidate_id);
      if (!returnedSourcePath) throw new Error("Curation return fixture is missing a candidate.");
      return {
        ...source,
        source_root: `canonical-curation-return/${returnedSourcePath}`
      };
    });
    expect(await inspectPromotionCanonicalCurationReturn(path.join(
      workspace,
      "canonical-curation-return"
    ))).toMatchObject({ passed: true, issues: [], receipt: { passed: true } });
    expect(path.basename(curationReturn.receipt_path)).toBe(
      PROMOTION_CANONICAL_CURATION_RETURN_RECEIPT
    );
    const returnedResultPath = path.join(
      workspace,
      "canonical-curation-return",
      curationReturn.receipt.returns[0].source_path,
      "result_table.json"
    );
    const returnedResult = await readFile(returnedResultPath);
    await writeFile(returnedResultPath, "[]\n", "utf8");
    const tamperedReturn = await inspectPromotionCanonicalCurationReturn(path.join(
      workspace,
      "canonical-curation-return"
    ));
    expect(tamperedReturn.passed).toBe(false);
    expect(tamperedReturn.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "canonical_curation_return_inventory_invalid",
      "canonical_curation_return_recomputation_mismatch"
    ]));
    await writeFile(returnedResultPath, returnedResult);
    expect(await inspectPromotionCanonicalCurationReturn(path.join(
      workspace,
      "canonical-curation-return"
    ))).toMatchObject({ passed: true, issues: [], receipt: { passed: true } });
    const malformedSourcePath = path.join(
      workspace,
      "canonical-curation-return",
      "sources",
      "unexpected.json"
    );
    await writeFile(malformedSourcePath, "{}\n", "utf8");
    const malformedReturn = await inspectPromotionCanonicalCurationReturn(path.join(
      workspace,
      "canonical-curation-return"
    ));
    expect(malformedReturn.passed).toBe(false);
    expect(malformedReturn.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "canonical_curation_return_inventory_invalid",
      "canonical_curation_return_sources_invalid"
    ]));
    await rm(malformedSourcePath);
    expect(await inspectPromotionCanonicalCurationReturn(path.join(
      workspace,
      "canonical-curation-return"
    ))).toMatchObject({ passed: true, issues: [], receipt: { passed: true } });

    await writeJsonFile(path.join(workspace, "paper-scale-raw-review-intake.json"), {
      schema_version: "1.3",
      intake_tier: "paper_scale",
      study_id: "promotion-confirmatory-raw-review-bypass",
      candidate_handoff_root: "parquet-paired-handoff",
      candidate_campaign_return_root: "source-eligible-adjudication",
      canonical_curation_return_root: "canonical-curation-return",
      sources: returnedIntakeSources
    });
    const rawReviewBypass = await auditPromotionConfirmatoryIntake({
      cwd: workspace,
      manifestPath: "paper-scale-raw-review-intake.json",
      outDir: "paper-scale-raw-review-intake-audit"
    });
    expect(rawReviewBypass.report.passed).toBe(false);
    expect(rawReviewBypass.report.global_issues.map((issue) => issue.code)).toContain(
      "confirmatory_paper_scale_campaign_return_invalid"
    );
    await expect(freezePromotionConfirmatoryCorpus({
      cwd: workspace,
      manifestPath: "paper-scale-raw-review-intake.json",
      outDir: "paper-scale-raw-review-frozen"
    })).rejects.toThrow("confirmatory_paper_scale_campaign_return_invalid");

    await writeJsonFile(path.join(workspace, "paper-scale-raw-source-intake.json"), {
      schema_version: "1.3",
      intake_tier: "paper_scale",
      study_id: "promotion-confirmatory-raw-source-bypass",
      candidate_handoff_root: "parquet-paired-handoff",
      candidate_campaign_return_root: "source-eligible-campaign-return",
      canonical_curation_return_root: "canonical-curation-return",
      sources: intakeSources
    });
    const rawSourceBypass = await auditPromotionConfirmatoryIntake({
      cwd: workspace,
      manifestPath: "paper-scale-raw-source-intake.json",
      outDir: "paper-scale-raw-source-intake-audit"
    });
    expect(rawSourceBypass.report.passed).toBe(false);
    expect(rawSourceBypass.report.sources.every((source) =>
      source.issues.some((issue) =>
        issue.code === "confirmatory_curation_return_source_mismatch"))).toBe(true);
    await expect(freezePromotionConfirmatoryCorpus({
      cwd: workspace,
      manifestPath: "paper-scale-raw-source-intake.json",
      outDir: "paper-scale-raw-source-frozen"
    })).rejects.toThrow("confirmatory_curation_return_source_mismatch");

    await writeJsonFile(path.join(workspace, "paper-scale-intake.json"), {
      schema_version: "1.3",
      intake_tier: "paper_scale",
      study_id: "promotion-confirmatory-paper-scale",
      candidate_handoff_root: "parquet-paired-handoff",
      candidate_campaign_return_root: "source-eligible-campaign-return",
      canonical_curation_return_root: "canonical-curation-return",
      sources: returnedIntakeSources
    });
    const intakeAudit = await auditPromotionConfirmatoryIntake({
      cwd: workspace,
      manifestPath: "paper-scale-intake.json",
      outDir: "paper-scale-intake-audit"
    });
    expect(intakeAudit.report).toMatchObject({
      passed: true,
      intake_tier: "paper_scale",
      source_count: 72,
      minimum_source_count: 72,
      candidate_handoff_verified: true,
      candidate_review_verified: true,
      candidate_curation_return_verified: true,
      source_eligible_candidate_count: 72,
      canonical_curation_verified_source_count: 72
    });
    const frozen = await freezePromotionConfirmatoryCorpus({
      cwd: workspace,
      manifestPath: "paper-scale-intake.json",
      outDir: "paper-scale-frozen"
    });
    expect(frozen).toMatchObject({
      intake_tier: "paper_scale",
      base_bundle_count: 72,
      case_count: 720
    });
    const freezeInspection = await inspectPromotionConfirmatoryFreezeEvidence({
      freezeManifestPath: path.join(workspace, frozen.freeze_manifest_path),
      recipePath: path.join(workspace, frozen.recipe_path)
    });
    expect(freezeInspection.issues).toEqual([]);
    expect(freezeInspection.provenance).toMatchObject({
      method: "verified_confirmatory_freeze",
      intake_tier: "paper_scale",
      base_bundle_count: 72,
      case_count: 720,
      upstream_evidence_file_count: expect.any(Number),
      candidate_review: {
        source_eligible_candidate_count: 72
      }
    });
    expect(freezeInspection.provenance?.upstream_evidence_file_count).toBeGreaterThan(5);
    expect(await inspectPromotionTrialCandidateHandoff(path.join(
      workspace,
      "paper-scale-frozen",
      PROMOTION_CONFIRMATORY_UPSTREAM_HANDOFF_ROOT
    ))).toMatchObject({ passed: true, issues: [] });
    expect(await inspectPromotionTrialCandidateCampaignReturn(path.join(
      workspace,
      "paper-scale-frozen",
      PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT
    ))).toMatchObject({ passed: true, issues: [] });
    expect(await inspectPromotionTrialCandidateReviewAdjudication(path.join(
      workspace,
      "paper-scale-frozen",
      PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT,
      "adjudication"
    ))).toMatchObject({ passed: true, issues: [] });
    expect(await inspectPromotionCanonicalCurationReturn(path.join(
      workspace,
      "paper-scale-frozen",
      PROMOTION_CONFIRMATORY_UPSTREAM_CURATION_RETURN_ROOT
    ))).toMatchObject({ passed: true, issues: [], receipt: { passed: true } });
    const frozenCampaignReceiptPath = path.join(
      workspace,
      "paper-scale-frozen",
      PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT,
      PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT
    );
    const frozenCampaignReceiptBytes = await readFile(frozenCampaignReceiptPath);
    const changedFrozenCampaignReceipt = JSON.parse(
      frozenCampaignReceiptBytes.toString("utf8")
    );
    changedFrozenCampaignReceipt.assigned_return_count = 2;
    await writeJsonFile(frozenCampaignReceiptPath, changedFrozenCampaignReceipt);
    const changedFrozenCampaign = await inspectPromotionConfirmatoryFreezeEvidence({
      freezeManifestPath: path.join(workspace, frozen.freeze_manifest_path),
      recipePath: path.join(workspace, frozen.recipe_path)
    });
    expect(changedFrozenCampaign.passed).toBe(false);
    expect(changedFrozenCampaign.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "confirmatory_freeze_upstream_hash_mismatch",
        "confirmatory_freeze_campaign_return_invalid"
      ])
    );
    await writeFile(frozenCampaignReceiptPath, frozenCampaignReceiptBytes);
    const frozenCurationReceiptPath = path.join(
      workspace,
      "paper-scale-frozen",
      PROMOTION_CONFIRMATORY_UPSTREAM_CURATION_RETURN_ROOT,
      PROMOTION_CANONICAL_CURATION_RETURN_RECEIPT
    );
    const frozenCurationReceiptBytes = await readFile(frozenCurationReceiptPath);
    const changedFrozenCurationReceipt = JSON.parse(
      frozenCurationReceiptBytes.toString("utf8")
    );
    changedFrozenCurationReceipt.verified_return_count = 71;
    await writeJsonFile(frozenCurationReceiptPath, changedFrozenCurationReceipt);
    const changedFrozenCuration = await inspectPromotionConfirmatoryFreezeEvidence({
      freezeManifestPath: path.join(workspace, frozen.freeze_manifest_path),
      recipePath: path.join(workspace, frozen.recipe_path)
    });
    expect(changedFrozenCuration.passed).toBe(false);
    expect(changedFrozenCuration.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "confirmatory_freeze_upstream_hash_mismatch",
        "confirmatory_freeze_curation_return_invalid"
      ])
    );
    await writeFile(frozenCurationReceiptPath, frozenCurationReceiptBytes);
    const frozenManifest = JSON.parse(await readFile(
      path.join(workspace, frozen.freeze_manifest_path),
      "utf8"
    )) as { source_bundles: Array<{ copied_root: string }> };
    const frozenSourcePath = path.join(
      workspace,
      "paper-scale-frozen",
      frozenManifest.source_bundles[0].copied_root,
      "result_table.json"
    );
    const frozenSourceBytes = await readFile(frozenSourcePath);
    await writeFile(frozenSourcePath, "[]\n", "utf8");
    const changedFrozenSource = await inspectPromotionConfirmatoryFreezeEvidence({
      freezeManifestPath: path.join(workspace, frozen.freeze_manifest_path),
      recipePath: path.join(workspace, frozen.recipe_path)
    });
    expect(changedFrozenSource.passed).toBe(false);
    expect(changedFrozenSource.issues.map((issue) => issue.code)).toContain(
      "confirmatory_freeze_source_tree_mismatch"
    );
    await writeFile(frozenSourcePath, frozenSourceBytes);

    const labelTamperedRoot = path.join(workspace, "label-tampered-adjudication");
    await cp(path.join(workspace, "source-eligible-adjudication"), labelTamperedRoot, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    const labelsPath = path.join(labelTamperedRoot, PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS);
    const rows = (await readFile(labelsPath, "utf8")).split(/\r?\n/u).filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
    rows[0].label.observations.execution_trace_completeness = "negative";
    await writeFile(labelsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    const labelTamperedReportPath = path.join(
      labelTamperedRoot,
      "trial-candidate-review-adjudication.json"
    );
    const labelTamperedReport = JSON.parse(await readFile(labelTamperedReportPath, "utf8"));
    labelTamperedReport.outputs.labels_sha256 = createHash("sha256")
      .update(await readFile(labelsPath)).digest("hex");
    await writeFile(
      labelTamperedReportPath,
      `${JSON.stringify(labelTamperedReport, null, 2)}\n`,
      "utf8"
    );
    const labelTampered = await inspectPromotionTrialCandidateReviewAdjudication(
      labelTamperedRoot
    );
    expect(labelTampered.passed).toBe(false);
    expect(labelTampered.issues.map((issue) => issue.code)).toContain(
      "trial_candidate_review_output_semantics_invalid"
    );

    evidence.source_eligible_candidate_count = 0;
    await writeFile(
      path.join(workspace, "source-eligible-adjudication", PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8"
    );
    const reportPath = path.join(
      workspace,
      "source-eligible-adjudication",
      "trial-candidate-review-adjudication.json"
    );
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.outputs.evidence_sha256 = createHash("sha256").update(await readFile(
      path.join(workspace, "source-eligible-adjudication", PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE)
    )).digest("hex");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const tampered = await inspectPromotionTrialCandidateReviewAdjudication(
      path.join(workspace, "source-eligible-adjudication")
    );
    expect(tampered.passed).toBe(false);
    expect(tampered.issues.map((issue) => issue.code)).toContain(
      "trial_candidate_review_output_semantics_invalid"
    );
  }, 30_000);

  it("rejects reused reviewer identities and unresolved candidate disagreements", async () => {
    const handoffRoot = path.join(workspace, "handoff");
    const duplicateReviewerPath = path.join(workspace, "review-duplicate.json");
    await writeHumanAnnotation(duplicateReviewerPath, handoffRoot, "reviewer-a");
    const duplicate = await adjudicatePromotionTrialCandidateReview({
      cwd: workspace,
      handoffRoot: "handoff",
      annotationPaths: ["review-a.json", "review-duplicate.json"],
      licenseReviewPath: "license-review.json",
      outDir: "duplicate-reviewer-adjudication"
    });
    expect(duplicate.report.passed).toBe(false);
    expect(duplicate.report.validation_issues.map((issue) => issue.code)).toContain(
      "trial_candidate_review_initial_annotators_not_independent"
    );

    await writeLicenseReview(path.join(workspace, "reused-license-review.json"), handoffRoot, "reviewer-a");
    const reusedLicenseReviewer = await adjudicatePromotionTrialCandidateReview({
      cwd: workspace,
      handoffRoot: "handoff",
      annotationPaths: ["review-a.json", "review-b.json"],
      licenseReviewPath: "reused-license-review.json",
      outDir: "reused-license-reviewer-adjudication"
    });
    expect(reusedLicenseReviewer.report.passed).toBe(false);
    expect(reusedLicenseReviewer.report.validation_issues.map((issue) => issue.code)).toContain(
      "trial_candidate_license_reviewer_not_independent"
    );

    const disagreementPath = path.join(workspace, "review-disagreement.json");
    const disagreement = await writeHumanAnnotation(
      disagreementPath,
      handoffRoot,
      "reviewer-c",
      { firstCandidateObservation: "uncertain" }
    );
    const unresolved = await adjudicatePromotionTrialCandidateReview({
      cwd: workspace,
      handoffRoot: "handoff",
      annotationPaths: ["review-a.json", "review-disagreement.json"],
      licenseReviewPath: "license-review.json",
      outDir: "unresolved-review-adjudication"
    });
    expect(unresolved.report.passed).toBe(false);
    expect(unresolved.report.disagreement_count).toBe(1);
    expect(unresolved.report.validation_issues.map((issue) => issue.code)).toContain(
      "trial_candidate_review_disagreement_unresolved"
    );

    const resolutionPath = path.join(workspace, "review-resolution.json");
    await writeFile(resolutionPath, `${JSON.stringify({
      schema_version: "1.0",
      handoff_id: disagreement.handoff_id,
      resolver_id: "reviewer-d",
      label_source: "human",
      review_role: "resolver",
      independence_attestation: {
        completed_by_human: true,
        controller_map_unseen: true
      },
      resolutions: [disagreement.annotations[0]]
    }, null, 2)}\n`, "utf8");
    const resolved = await adjudicatePromotionTrialCandidateReview({
      cwd: workspace,
      handoffRoot: "handoff",
      annotationPaths: ["review-a.json", "review-disagreement.json"],
      licenseReviewPath: "license-review.json",
      resolutionPath: "review-resolution.json",
      outDir: "resolved-review-adjudication"
    });
    expect(resolved.report).toMatchObject({
      passed: true,
      disagreement_count: 1,
      resolved_disagreement_count: 1,
      resolver_id: "reviewer-d"
    });
  });

  it("fails closed when an isolated review packet is changed or extended", async () => {
    const reviewerPacket = path.join(workspace, "tampered-reviewer-packet");
    await cp(path.join(workspace, "handoff", "reviewer"), reviewerPacket, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    const firstTask = JSON.parse((await readFile(
      path.join(reviewerPacket, "candidate-tasks.jsonl"),
      "utf8"
    )).split(/\r?\n/u).filter(Boolean)[0]) as Record<string, any>;
    const firstArtifact = path.join(
      reviewerPacket,
      firstTask.artifact_root,
      firstTask.trial_ids[0],
      "trace.json"
    );
    await writeFile(firstArtifact, "{}\n", "utf8");

    const reviewerInspection = await inspectPromotionTrialCandidateReviewerPacket(reviewerPacket);
    expect(reviewerInspection.passed).toBe(false);
    expect(reviewerInspection.issues.map((issue) => issue.code)).toContain(
      "trial_candidate_reviewer_packet_hash_mismatch"
    );
    await expect(preflightPromotionTrialCandidateAnnotation({
      cwd: workspace,
      reviewerRoot: "tampered-reviewer-packet",
      annotationPath: "review-a.json",
      outDir: "tampered-reviewer-preflight"
    })).rejects.toThrow("integrity-valid reviewer packet");

    const licensePacket = path.join(workspace, "extended-license-packet");
    await cp(path.join(workspace, "handoff", "license"), licensePacket, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    await writeFile(path.join(licensePacket, "untracked.json"), "{}\n", "utf8");
    const licenseInspection = await inspectPromotionTrialCandidateLicensePacket(licensePacket);
    expect(licenseInspection.passed).toBe(false);
    expect(licenseInspection.issues.map((issue) => issue.code)).toContain(
      "trial_candidate_license_packet_untracked_file"
    );
    await expect(preflightPromotionTrialCandidateLicenseReview({
      cwd: workspace,
      licenseRoot: "extended-license-packet",
      reviewPath: "reviews/license/complete-review.json",
      outDir: "extended-license-preflight"
    })).rejects.toThrow("integrity-valid source-license packet");
  });

  it("detects adjudicated review output tampering", async () => {
    await writeFile(
      path.join(workspace, "review-adjudication", PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS),
      "{}\n",
      "utf8"
    );

    const inspection = await inspectPromotionTrialCandidateReviewAdjudication(
      path.join(workspace, "review-adjudication")
    );

    expect(inspection.passed).toBe(false);
    expect(inspection.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "trial_candidate_review_output_hash_mismatch",
      "trial_candidate_review_output_semantics_invalid"
    ]));
  });

  it("detects portable source recipe tampering", async () => {
    const handoffRoot = path.join(workspace, "tampered-source-recipe-handoff");
    await cp(path.join(workspace, "handoff"), handoffRoot, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    const recipePath = path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_SOURCE_RECIPE);
    const recipe = JSON.parse(await readFile(recipePath, "utf8")) as Record<string, unknown>;
    recipe.selection_policy = "changed-after-export";
    await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`, "utf8");

    const inspection = await inspectPromotionTrialCandidateHandoff(handoffRoot);

    expect(inspection.passed).toBe(false);
    expect(inspection.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "trial_candidate_handoff_output_hash_mismatch",
      "trial_candidate_handoff_source_recipe_invalid"
    ]));
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
    revision: string;
    pathPattern: string;
    sourceUrl?: string;
    materializationMode?: "git_archive" | "verified_https_blobs";
    artifactUrlTemplate?: string;
  }
): Promise<void> {
  const licenseBytes = await readFile(path.join(path.dirname(target), "source-repository", "LICENSE"));
  await writeFile(target, `${JSON.stringify({
    schema_version: "1.1",
    handoff_id: "candidate-handoff-neutral",
    source_url: input.sourceUrl || "https://example.org/source-repository",
    source_revision: input.revision,
    path_scope: "records",
    path_pattern: input.pathPattern,
    required_base_count: 72,
    trials_per_base: 3,
    artifact_format: "json",
    selection_policy: "Lexical path selection followed by balanced operator and source-family round robin before artifact-content inspection.",
    materialization_mode: input.materializationMode || "git_archive",
    license_evidence: [{
      path: "LICENSE",
      sha256: createHash("sha256").update(licenseBytes).digest("hex")
    }],
    ...(input.artifactUrlTemplate ? { artifact_url_template: input.artifactUrlTemplate } : {})
  }, null, 2)}\n`, "utf8");
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}

async function writeHumanAnnotation(
  target: string,
  handoffRoot: string,
  annotatorId: string,
  options: {
    firstCandidateObservation?: "negative" | "uncertain";
    firstCandidatePositive?: boolean;
    allCandidatesSourceEligible?: boolean;
    invalidPointer?: boolean;
  } = {}
): Promise<PromotionTrialCandidateInitialAnnotationSet> {
  const manifest = JSON.parse(await readFile(
    path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST),
    "utf8"
  )) as Record<string, any>;
  const annotations: PromotionTrialCandidateHumanLabel[] = manifest.candidates.map(
    (candidate: Record<string, any>, index: number) => ({
      candidate_id: candidate.candidate_id,
      observations: Object.fromEntries(PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.map((field) => [
        field,
        options.allCandidatesSourceEligible
          && (field === "execution_trace_completeness" || field === "repeated_trial_comparability")
          ? "positive"
          : index === 0 && options.firstCandidatePositive
          ? "positive"
          : index === 0 && field === "execution_trace_completeness" && options.firstCandidateObservation
          ? options.firstCandidateObservation
          : "negative"
      ])) as PromotionTrialCandidateHumanLabel["observations"],
      evidence_refs: options.allCandidatesSourceEligible || (index === 0 && options.firstCandidatePositive)
        ? [...candidate.trials, ...(candidate.comparator_trials || [])].map((trial: Record<string, any>, trialIndex: number) => ({
            trial_id: trial.trial_id,
            observations: options.allCandidatesSourceEligible
              ? ["execution_trace_completeness", "repeated_trial_comparability"]
              : [...PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS],
            json_pointers: [options.invalidPointer && trialIndex === 0 ? "/missing" : ""]
          }))
        : [],
      rationale: "The neutral contract fixture does not include the required governed evidence artifact."
    })
  );
  const annotation: PromotionTrialCandidateInitialAnnotationSet = {
    schema_version: "1.0",
    handoff_id: manifest.handoff_id,
    annotator_id: annotatorId,
    label_source: "human",
    review_role: "initial",
    independence_attestation: {
      completed_by_human: true,
      peer_annotations_unseen: true,
      controller_map_unseen: true
    },
    annotations
  };
  await writeFile(target, `${JSON.stringify(annotation, null, 2)}\n`, "utf8");
  return annotation;
}

async function writeLicenseReview(
  target: string,
  handoffRoot: string,
  reviewerId: string,
  options: {
    status?: PromotionTrialCandidateLicenseReviewSet["review"]["status"];
    evidenceRefs?: string[];
  } = {}
): Promise<PromotionTrialCandidateLicenseReviewSet> {
  const manifest = JSON.parse(await readFile(
    path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST),
    "utf8"
  )) as Record<string, any>;
  const review: PromotionTrialCandidateLicenseReviewSet = {
    schema_version: "1.0",
    handoff_id: manifest.handoff_id,
    reviewer_id: reviewerId,
    label_source: "human",
    review_role: "source_license",
    independence_attestation: {
      completed_by_human: true,
      candidate_annotations_unseen: true,
      controller_map_unseen: true
    },
    review: {
      status: options.status || "uncertain",
      evidence_refs: options.evidenceRefs || [],
      rationale: options.status === "redistribution_permitted"
        ? "The neutral fixture binds the declared HTTPS permission reference."
        : "The neutral contract fixture does not establish redistribution permission."
    }
  };
  await writeFile(target, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  return review;
}

async function writeCanonicalConfirmatorySource(input: {
  root: string;
  ordinal: number;
  handoffId: string;
  sourceRevision: string;
  candidate: PromotionTrialCandidateRecord;
}): Promise<void> {
  const { root, ordinal, candidate } = input;
  const trialIds = [
    ...candidate.trials,
    ...(candidate.comparator_trials || [])
  ].map((trial) => trial.trial_id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "SOURCE_LICENSE.txt"), "Permission is granted for fixture use.\n", "utf8");
  await writeJsonFile(path.join(root, "result_table.json"), [{
    metric: "primary_metric",
    baseline: ordinal / 100,
    comparator: (ordinal + 1) / 100,
    delta: 0.01,
    direction: "higher_better"
  }]);
  await writeJsonFile(path.join(root, "experiment_evidence.json"), {
    trials: trialIds.map((trialId) => ({ trial_id: trialId }))
  });
  await writeJsonFile(path.join(root, "run_config.json"), {
    planned_budget: { trials: trialIds.length }
  });
  await writeJsonFile(path.join(root, "run_record.json"), {
    id: `run-${String(ordinal).padStart(2, "0")}`,
    status: "completed",
    executed_budget: { trials: trialIds.length },
    fixture_ordinal: ordinal
  });
  await writeFile(
    path.join(root, "evidence_store.jsonl"),
    `${JSON.stringify({ id: "evidence-primary", metric_evidence_present: true })}\n`,
    "utf8"
  );
  await writeJsonFile(path.join(root, "figure_audit", "figure_audit_summary.json"), {
    audited_at: "2026-01-01T00:00:00.000Z",
    figure_count: 1,
    issues: [],
    severe_mismatch_count: 0,
    review_block_required: false
  });
  const claim = {
    claim_id: "claim-primary",
    statement: "The measured comparison is reported.",
    section_heading: "Results",
    status: "verified",
    artifact_refs: ["result_table.json"],
    citation_refs: ["source-primary"],
    reproduction_trace_present: true
  };
  await writeJsonFile(path.join(root, "paper", "claim_status_table.json"), { claims: [claim] });
  await writeJsonFile(path.join(root, "paper", "claim_evidence_table.json"), { claims: [claim] });
  await writeJsonFile(path.join(root, "paper", "evidence_links.json"), {
    claims: [{
      claim_id: claim.claim_id,
      evidence_ids: ["evidence-primary"],
      citation_paper_ids: ["source-primary"]
    }]
  });
  await writeFile(
    path.join(root, "paper", "main.tex"),
    "\\section{Results}\nThe measured comparison is linked to the canonical evidence artifacts.\n",
    "utf8"
  );
  await writeJsonFile(path.join(root, "paper", "paper_readiness.json"), {
    paper_ready: true,
    readiness_state: "paper_ready"
  });
  await writeJsonFile(path.join(root, "checkpoint", "state.json"), {
    paper_ready: true,
    run_status: "completed"
  });
  await writeJsonFile(path.join(root, "design_contracts.json"), {
    sota_ranking_claimed: false,
    sota_evidence_present: false
  });
  await writeFile(
    path.join(root, "events.jsonl"),
    `${JSON.stringify({ event: "completed", ordinal })}\n`,
    "utf8"
  );
  await writeJsonFile(path.join(root, "metrics.json"), {
    completed_trials: candidate.trials.length,
    ordinal
  });
  await writeJsonFile(path.join(root, "review", "decision.json"), {
    outcome: "accept",
    ordinal
  });
  await writeJsonFile(path.join(root, "review", "paper_critique.json"), {
    paper_readiness_state: "paper_ready",
    claim_ceiling_applied: true
  });
  await writeFile(path.join(root, "command.txt"), `runner --item ${ordinal}\n`, "utf8");
  await writeFile(path.join(root, "execution.log"), `completed item ${ordinal}\n`, "utf8");
  const evidenceArtifacts = [
    { role: "run_config", path: "run_config.json" },
    { role: "event_log", path: "events.jsonl" },
    { role: "metrics", path: "metrics.json" },
    { role: "review_decision", path: "review/decision.json" },
    { role: "command", path: "command.txt" },
    { role: "execution_log", path: "execution.log" }
  ];
  await writeJsonFile(path.join(root, "execution-evidence.json"), {
    schema_version: "1.0",
    evidence_class: "external_real_run",
    run_id: `run-${String(ordinal).padStart(2, "0")}`,
    execution_mode: "real_execution",
    execution_status: "completed",
    execution_backend: "local_runtime",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:01:00.000Z",
    exit_code: 0,
    trial_ids: candidate.trials.map((trial) => trial.trial_id),
    artifacts: await Promise.all(evidenceArtifacts.map(async (artifact) => ({
      ...artifact,
      sha256: createHash("sha256").update(await readFile(path.join(root, artifact.path))).digest("hex")
    })))
  });
  const artifacts = await Promise.all(Object.entries(PROMOTION_CANONICAL_ARTIFACT_PATHS)
    .map(async ([role, relativePath]) => ({
      role,
      path: relativePath,
      sha256: createHash("sha256").update(await readFile(path.join(root, relativePath))).digest("hex")
    })));
  const curation: PromotionCanonicalCurationRecord = {
    schema_version: PROMOTION_CANONICAL_CURATION_SCHEMA_VERSION,
    provenance_class: "benchmark_curated",
    handoff_id: input.handoffId,
    candidate_id: candidate.candidate_id,
    source_revision: input.sourceRevision,
    base_candidate_sha256: candidate.base_candidate_sha256,
    curation_status: "human_verified",
    curator_id: "curator-a",
    verifier_id: "verifier-b",
    curated_at: "2026-01-02T00:00:00.000Z",
    verified_at: "2026-01-03T00:00:00.000Z",
    curator_protocol_version: "curation-protocol-1",
    verifier_protocol_version: "verification-protocol-1",
    derivation_mode: "deterministic",
    intended_readiness: "promote",
    evidence_ceiling: "paper_scale_candidate",
    source_trials: [
      ...candidate.trials.map((trial) => ({
        group_id: "group-a" as const,
        trial_id: trial.trial_id,
        source_ref_sha256: trial.source_ref_sha256,
        source_blob_sha256: trial.source_blob_sha256,
        reviewer_blob_sha256: trial.reviewer_blob_sha256
      })),
      ...(candidate.comparator_trials || []).map((trial) => ({
        group_id: "group-b" as const,
        trial_id: trial.trial_id,
        source_ref_sha256: trial.source_ref_sha256,
        source_blob_sha256: trial.source_blob_sha256,
        reviewer_blob_sha256: trial.reviewer_blob_sha256
      }))
    ],
    artifacts: artifacts as PromotionCanonicalCurationRecord["artifacts"],
    evidence_boundary: "This is a synthetic contract fixture and never paper evidence."
  };
  await writeJsonFile(path.join(root, PROMOTION_CANONICAL_CURATION_RECORD), curation);
}

async function writeJsonFile(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
