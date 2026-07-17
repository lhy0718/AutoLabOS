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
import {
  PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS,
  PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE,
  adjudicatePromotionTrialCandidateReview,
  inspectPromotionTrialCandidateReviewAdjudication,
  preparePromotionTrialCandidateAnnotationWorksheet,
  preflightPromotionTrialCandidateAnnotation
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateReview.js";
import {
  PROMOTION_TRIAL_CANDIDATE_ANNOTATION_SCHEMA,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_GUIDE,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_SCHEMA,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK,
  PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS,
  PROMOTION_TRIAL_CANDIDATE_RESOLUTION_SCHEMA,
  PROMOTION_TRIAL_CANDIDATE_RUBRIC,
  type PromotionTrialCandidateHumanLabel,
  type PromotionTrialCandidateInitialAnnotationSet,
  type PromotionTrialCandidateLicenseReviewSet
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateReviewContract.js";

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
      license_reviewer_dir: "handoff/license",
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
    expect(JSON.parse(await readFile(path.join(workspace, result.evidence_summary_path), "utf8"))).toMatchObject({
      base_candidate_count: 72,
      trial_artifact_count: 216,
      independent_candidate_review_completed: false,
      confirmatory_admitted: false,
      remaining_blockers: expect.arrayContaining(["human_license_review", "independent_double_candidate_review"])
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

  it("preflights exact human task coverage without promoting negative labels", async () => {
    const handoffRoot = path.join(workspace, "handoff");
    const annotationPath = path.join(workspace, "review-a.json");
    await writeHumanAnnotation(annotationPath, handoffRoot, "reviewer-a");

    const result = await preflightPromotionTrialCandidateAnnotation({
      cwd: workspace,
      handoffRoot: "handoff",
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
      handoffRoot: "handoff",
      annotationPath: "reviews/reviewer-a/review-worksheet.json",
      outDir: "review-worksheet-preflight"
    });
    expect(preflight.report.passed).toBe(false);
    expect(preflight.report.validation_issues.map((issue) => issue.code)).toContain(
      "trial_candidate_annotation_file_invalid"
    );
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
      handoffRoot: "handoff",
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
      handoffRoot: "handoff",
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
      candidate_review_progression_floor_met: false,
      confirmatory_admitted: false
    });
    expect(await inspectPromotionTrialCandidateReviewAdjudication(
      path.join(workspace, "review-adjudication")
    )).toMatchObject({ passed: true, issues: [] });
  });

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

async function writeHumanAnnotation(
  target: string,
  handoffRoot: string,
  annotatorId: string,
  options: {
    firstCandidateObservation?: "negative" | "uncertain";
    firstCandidatePositive?: boolean;
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
        index === 0 && options.firstCandidatePositive
          ? "positive"
          : index === 0 && field === "execution_trace_completeness" && options.firstCandidateObservation
          ? options.firstCandidateObservation
          : "negative"
      ])) as PromotionTrialCandidateHumanLabel["observations"],
      evidence_refs: index === 0 && options.firstCandidatePositive
        ? candidate.trials.map((trial: Record<string, any>, trialIndex: number) => ({
            trial_id: trial.trial_id,
            observations: [...PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS],
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
  reviewerId: string
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
      status: "uncertain",
      evidence_refs: [],
      rationale: "The neutral contract fixture does not establish redistribution permission."
    }
  };
  await writeFile(target, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  return review;
}
