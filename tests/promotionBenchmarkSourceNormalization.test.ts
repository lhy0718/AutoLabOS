import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { auditPromotionConfirmatoryIntake } from "../src/core/benchmark/promotionBenchmarkConfirmatoryIntake.js";
import { projectPromotionSource } from "../src/core/benchmark/promotionBenchmarkSourceProjection.js";
import {
  exportPromotionSourceNormalizationPack,
  inspectPromotionSourceNormalization,
  normalizePromotionSource
} from "../src/core/benchmark/promotionBenchmarkSourceNormalization.js";
import {
  exportPromotionSourceNormalizationBatch,
  inspectPromotionSourceNormalizationBatch
} from "../src/core/benchmark/promotionBenchmarkSourceNormalizationBatch.js";
import { adjudicatePromotionSourceNormalizationBatch } from
  "../src/core/benchmark/promotionBenchmarkSourceNormalizationAdjudication.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion source normalization", () => {
  it("materializes an integrity-bound canonical bundle only after two independent matching annotations", async () => {
    const workspace = await createProjectedWorkspace();
    const pack = await exportPromotionSourceNormalizationPack({
      cwd: workspace,
      sourceRoot: "projected",
      outDir: "normalization-pack"
    });
    const label = normalizationAnnotation(pack.normalization_id, "reviewer-a");
    await writeJsonLine(path.join(workspace, "annotation-a.jsonl"), label);
    await writeJsonLine(path.join(workspace, "annotation-b.jsonl"), { ...label, annotator_id: "reviewer-b" });

    const result = await normalizePromotionSource({
      cwd: workspace,
      sourceRoot: "projected",
      privateMapPath: "normalization-pack/private-normalization-map.json",
      annotationPaths: ["annotation-a.jsonl", "annotation-b.jsonl"],
      outDir: "normalized"
    });
    const inspection = await inspectPromotionSourceNormalization(path.join(workspace, "normalized"));
    const experimentEvidence = JSON.parse(await readFile(path.join(workspace, "normalized", "experiment_evidence.json"), "utf8"));

    expect(result.adjudication_source).toBe("double_adjudication_consensus");
    expect(inspection).toMatchObject({ passed: true, issues: [] });
    expect(experimentEvidence.trials).toEqual([
      { trial_id: "trial-a" },
      { trial_id: "trial-b" },
      { trial_id: "trial-c" }
    ]);
    expect(await readFile(path.join(workspace, "normalized", "source", "observations", "result-table.json"), "utf8"))
      .toBe(await readFile(path.join(workspace, "projected", "observations", "result-table.json"), "utf8"));
  });

  it("admits a valid normalized origin at source level while retaining corpus-wide diversity floors", async () => {
    const workspace = await createProjectedWorkspace();
    const pack = await exportPromotionSourceNormalizationPack({ cwd: workspace, sourceRoot: "projected", outDir: "pack" });
    const label = normalizationAnnotation(pack.normalization_id, "reviewer-a");
    await writeJsonLine(path.join(workspace, "a.jsonl"), label);
    await writeJsonLine(path.join(workspace, "b.jsonl"), { ...label, annotator_id: "reviewer-b" });
    await normalizePromotionSource({
      cwd: workspace,
      sourceRoot: "projected",
      privateMapPath: "pack/private-normalization-map.json",
      annotationPaths: ["a.jsonl", "b.jsonl"],
      outDir: "normalized"
    });
    await writeJson(path.join(workspace, "intake.json"), {
      schema_version: "1.0",
      study_id: "normalization-intake-test",
      sources: [{
        source_id: "source-neutral-a",
        source_root: "normalized",
        evidence_class: "external_real_run",
        source_family_id: "family-neutral-a",
        operator_group_id: "operator-neutral-a",
        source_revision: "revision-neutral-a",
        origin_kind: "normalized",
        distribution_scope: "redistributable",
        license_review_status: "human_verified"
      }]
    });

    const audit = await auditPromotionConfirmatoryIntake({
      cwd: workspace,
      manifestPath: "intake.json",
      outDir: "intake-audit"
    });

    expect(audit.report.passed).toBe(false);
    expect(audit.report.artifact_verified_source_count).toBe(1);
    expect(audit.report.sources[0]).toMatchObject({ origin_kind: "normalized", passed: true, issues: [] });
    expect(audit.report.global_issues.map((issue) => issue.code)).toContain("confirmatory_source_count_minimum_not_met");
  });

  it("rejects human-only supporting evidence that is not bound by the source projection", async () => {
    const workspace = await createProjectedWorkspace();
    const pack = await exportPromotionSourceNormalizationPack({ cwd: workspace, sourceRoot: "projected", outDir: "pack" });
    const label = normalizationAnnotation(pack.normalization_id, "reviewer-a");
    const unboundFigure = "support/unbound-figure.png";
    const invalid = {
      ...label,
      figure_paths: [unboundFigure],
      evidence_refs: [...label.evidence_refs, unboundFigure]
    };
    await writeJsonLine(path.join(workspace, "a.jsonl"), invalid);
    await writeJsonLine(path.join(workspace, "b.jsonl"), { ...invalid, annotator_id: "reviewer-b" });

    await expect(normalizePromotionSource({
      cwd: workspace,
      sourceRoot: "projected",
      privateMapPath: "pack/private-normalization-map.json",
      annotationPaths: ["a.jsonl", "b.jsonl"],
      outDir: "rejected-unbound-support"
    })).rejects.toThrow("manifest-bound projected outputs");

    const wrongReadiness = { ...label, readiness_source_path: "execution/metrics-source.json" };
    await writeJsonLine(path.join(workspace, "c.jsonl"), wrongReadiness);
    await writeJsonLine(path.join(workspace, "d.jsonl"), { ...wrongReadiness, annotator_id: "reviewer-b" });
    await expect(normalizePromotionSource({
      cwd: workspace,
      sourceRoot: "projected",
      privateMapPath: "pack/private-normalization-map.json",
      annotationPaths: ["c.jsonl", "d.jsonl"],
      outDir: "rejected-wrong-readiness"
    })).rejects.toThrow("selected review-decision");
  });

  it("fails closed on non-independent annotations and on post-normalization drift", async () => {
    const workspace = await createProjectedWorkspace();
    const pack = await exportPromotionSourceNormalizationPack({ cwd: workspace, sourceRoot: "projected", outDir: "pack" });
    const label = normalizationAnnotation(pack.normalization_id, "reviewer-a");
    await writeJsonLine(path.join(workspace, "a.jsonl"), label);
    await writeJsonLine(path.join(workspace, "same.jsonl"), label);

    await expect(normalizePromotionSource({
      cwd: workspace,
      sourceRoot: "projected",
      privateMapPath: "pack/private-normalization-map.json",
      annotationPaths: ["a.jsonl", "same.jsonl"],
      outDir: "rejected"
    })).rejects.toThrow("distinct annotator IDs");

    await writeJsonLine(path.join(workspace, "b.jsonl"), { ...label, annotator_id: "reviewer-b" });
    await normalizePromotionSource({
      cwd: workspace,
      sourceRoot: "projected",
      privateMapPath: "pack/private-normalization-map.json",
      annotationPaths: ["a.jsonl", "b.jsonl"],
      outDir: "normalized"
    });
    await writeJson(path.join(workspace, "normalized", "result_table.json"), [{ baseline: 0.5, comparator: 0.9 }]);

    const inspection = await inspectPromotionSourceNormalization(path.join(workspace, "normalized"));
    expect(inspection.passed).toBe(false);
    expect(inspection.issues).toContainEqual(expect.objectContaining({
      code: "source_normalization_output_hash_mismatch",
      ref: "result_table.json"
    }));
  });

  it("requires an independent resolver when initial annotations disagree", async () => {
    const workspace = await createProjectedWorkspace();
    const pack = await exportPromotionSourceNormalizationPack({ cwd: workspace, sourceRoot: "projected", outDir: "pack" });
    const left = normalizationAnnotation(pack.normalization_id, "reviewer-a");
    const right = { ...left, annotator_id: "reviewer-b", claim_text: "A different source-grounded comparison is reported." };
    await writeJsonLine(path.join(workspace, "a.jsonl"), left);
    await writeJsonLine(path.join(workspace, "b.jsonl"), right);

    await expect(normalizePromotionSource({
      cwd: workspace,
      sourceRoot: "projected",
      privateMapPath: "pack/private-normalization-map.json",
      annotationPaths: ["a.jsonl", "b.jsonl"],
      outDir: "unresolved"
    })).rejects.toThrow("third-party resolution");

    await writeJsonLine(path.join(workspace, "resolution.jsonl"), { ...left, annotator_id: "reviewer-c" });
    const result = await normalizePromotionSource({
      cwd: workspace,
      sourceRoot: "projected",
      privateMapPath: "pack/private-normalization-map.json",
      annotationPaths: ["a.jsonl", "b.jsonl"],
      resolutionPath: "resolution.jsonl",
      outDir: "resolved"
    });

    expect(result.adjudication_source).toBe("third_party_resolution");
    expect((await inspectPromotionSourceNormalization(path.join(workspace, "resolved"))).passed).toBe(true);
  });

  it("binds the normalized license to the nested projected source even if local manifest hashes are rewritten", async () => {
    const workspace = await createProjectedWorkspace();
    const pack = await exportPromotionSourceNormalizationPack({ cwd: workspace, sourceRoot: "projected", outDir: "pack" });
    const label = normalizationAnnotation(pack.normalization_id, "reviewer-a");
    await writeJsonLine(path.join(workspace, "a.jsonl"), label);
    await writeJsonLine(path.join(workspace, "b.jsonl"), { ...label, annotator_id: "reviewer-b" });
    await normalizePromotionSource({
      cwd: workspace,
      sourceRoot: "projected",
      privateMapPath: "pack/private-normalization-map.json",
      annotationPaths: ["a.jsonl", "b.jsonl"],
      outDir: "normalized"
    });

    const replacementLicense = "Different local license text.\n";
    const replacementHash = createHash("sha256").update(replacementLicense).digest("hex");
    await writeFile(path.join(workspace, "normalized", "SOURCE_LICENSE.txt"), replacementLicense, "utf8");
    const manifestPath = path.join(workspace, "normalized", "source-normalization.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.license_sha256 = replacementHash;
    manifest.outputs.find((output: { path: string }) => output.path === "SOURCE_LICENSE.txt").sha256 = replacementHash;
    await writeJson(manifestPath, manifest);

    const inspection = await inspectPromotionSourceNormalization(path.join(workspace, "normalized"));
    expect(inspection.passed).toBe(false);
    expect(inspection.issues.map((issue) => issue.code)).toContain("source_normalization_license_source_mismatch");
  });

  it("exports a closed multi-source reviewer batch without exposing controller maps", async () => {
    const workspace = await createProjectedWorkspace();
    await exportPromotionSourceNormalizationPack({
      cwd: workspace,
      sourceRoot: "projected",
      outDir: "pack-a"
    });
    await createAdditionalProjectedSource(workspace);
    await exportPromotionSourceNormalizationPack({
      cwd: workspace,
      sourceRoot: "projected-b",
      outDir: "pack-b"
    });
    await writeJson(path.join(workspace, "batch-recipe.json"), {
      schema_version: "1.0",
      batch_id: "review-batch-neutral",
      items: [
        { item_id: "source-item-001", source_root: "projected", pack_root: "pack-a" },
        { item_id: "source-item-002", source_root: "projected-b", pack_root: "pack-b" }
      ]
    });

    const exported = await exportPromotionSourceNormalizationBatch({
      cwd: workspace,
      recipePath: "batch-recipe.json",
      outDir: "review-batch"
    });
    const inspection = await inspectPromotionSourceNormalizationBatch(path.join(workspace, "review-batch"));
    const tasks = (await readFile(path.join(workspace, exported.tasks_path), "utf8"))
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const controllerMap = JSON.parse(await readFile(path.join(workspace, exported.controller_map_path), "utf8"));

    expect(exported).toMatchObject({ batch_id: "review-batch-neutral", item_count: 2 });
    expect(inspection).toMatchObject({ passed: true, issues: [] });
    expect(tasks.map((task) => task.item_id)).toEqual(["source-item-001", "source-item-002"]);
    expect(new Set(tasks.map((task) => task.normalization_id)).size).toBe(2);
    expect(controllerMap.items.map((item: { source_root: string }) => item.source_root))
      .toEqual(["projected", "projected-b"]);
    await expect(access(path.join(workspace, exported.reviewer_dir, "private-normalization-map.json"))).rejects.toThrow();
    expect(inspection.manifest?.outputs.some((output) => output.path.startsWith("reviewer/controller/"))).toBe(false);
    expect(await readFile(path.join(workspace, exported.tasks_path), "utf8")).not.toContain("private_map_path");

    await writeFile(path.join(workspace, exported.tasks_path), "{}\n", "utf8");
    const drifted = await inspectPromotionSourceNormalizationBatch(path.join(workspace, "review-batch"));
    expect(drifted.passed).toBe(false);
    expect(drifted.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "source_normalization_batch_output_hash_mismatch",
      "source_normalization_batch_controller_map_invalid",
      "source_normalization_batch_reviewer_payload_invalid"
    ]));
  });

  it("rejects duplicate normalization packs and non-portable recipe paths", async () => {
    const workspace = await createProjectedWorkspace();
    await exportPromotionSourceNormalizationPack({ cwd: workspace, sourceRoot: "projected", outDir: "pack-a" });
    await cp(path.join(workspace, "pack-a"), path.join(workspace, "pack-copy"), { recursive: true });
    await cp(path.join(workspace, "projected"), path.join(workspace, "projected-copy"), { recursive: true });
    await writeJson(path.join(workspace, "duplicate-recipe.json"), {
      schema_version: "1.0",
      batch_id: "review-batch-duplicate",
      items: [
        { item_id: "source-item-001", source_root: "projected", pack_root: "pack-a" },
        { item_id: "source-item-002", source_root: "projected-copy", pack_root: "pack-copy" }
      ]
    });

    await expect(exportPromotionSourceNormalizationBatch({
      cwd: workspace,
      recipePath: "duplicate-recipe.json",
      outDir: "duplicate-batch"
    })).rejects.toThrow("normalization IDs must be unique");

    await writeJson(path.join(workspace, "absolute-recipe.json"), {
      schema_version: "1.0",
      batch_id: "review-batch-absolute",
      items: [{
        item_id: "source-item-001",
        source_root: path.join(workspace, "projected"),
        pack_root: "pack-a"
      }]
    });
    await expect(exportPromotionSourceNormalizationBatch({
      cwd: workspace,
      recipePath: "absolute-recipe.json",
      outDir: "absolute-batch"
    })).rejects.toThrow("Invalid source-normalization batch recipe item");
  });

  it("adjudicates complete independent batch labels into runnable materialization jobs", async () => {
    const { workspace, tasks } = await createReviewBatchWorkspace();
    await writeJsonLines(path.join(workspace, "reviewer-a.jsonl"), tasks.map((task) =>
      normalizationAnnotation(task.normalization_id, "reviewer-a")));
    await writeJsonLines(path.join(workspace, "reviewer-b.jsonl"), tasks.map((task) =>
      normalizationAnnotation(task.normalization_id, "reviewer-b")));

    const result = await adjudicatePromotionSourceNormalizationBatch({
      cwd: workspace,
      batchRoot: "review-batch",
      annotationPaths: ["reviewer-a.jsonl", "reviewer-b.jsonl"],
      outDir: "batch-adjudication"
    });
    const jobs = (await readFile(path.join(workspace, result.materialization_jobs_path!), "utf8"))
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));

    expect(result.report).toMatchObject({
      passed: true,
      task_count: 2,
      accepted_label_count: 2,
      disagreement_count: 0,
      resolved_disagreement_count: 0,
      initial_annotator_ids: ["reviewer-a", "reviewer-b"],
      resolver_id: null
    });
    expect(result.report.agreement.full_label_exact_rate).toBe(1);
    expect(Object.values(result.report.agreement.field_exact_rates).every((rate) => rate === 1)).toBe(true);
    expect(jobs).toHaveLength(2);

    await normalizePromotionSource({
      cwd: workspace,
      sourceRoot: jobs[0].source_root,
      privateMapPath: jobs[0].private_map_path,
      annotationPaths: jobs[0].annotation_paths,
      outDir: "normalized-from-batch"
    });
    expect((await inspectPromotionSourceNormalization(path.join(workspace, "normalized-from-batch"))).passed)
      .toBe(true);
  });

  it("requires a distinct resolver for every batch-label disagreement", async () => {
    const { workspace, tasks } = await createReviewBatchWorkspace();
    const left = tasks.map((task) => normalizationAnnotation(task.normalization_id, "reviewer-a"));
    const right = tasks.map((task, index) => ({
      ...normalizationAnnotation(task.normalization_id, "reviewer-b"),
      ...(index === 0 ? { claim_text: "A distinct artifact-grounded comparison is reported." } : {})
    }));
    await writeJsonLines(path.join(workspace, "reviewer-a.jsonl"), left);
    await writeJsonLines(path.join(workspace, "reviewer-b.jsonl"), right);

    const unresolved = await adjudicatePromotionSourceNormalizationBatch({
      cwd: workspace,
      batchRoot: "review-batch",
      annotationPaths: ["reviewer-a.jsonl", "reviewer-b.jsonl"],
      outDir: "unresolved-adjudication"
    });
    expect(unresolved.report.passed).toBe(false);
    expect(unresolved.materialization_jobs_path).toBeNull();
    expect(unresolved.report.validation_issues).toContainEqual(expect.objectContaining({
      code: "source_normalization_batch_disagreement_unresolved",
      ref: tasks[0].normalization_id
    }));

    await writeJsonLines(path.join(workspace, "resolver.jsonl"), [
      { ...left[0], annotator_id: "reviewer-c" }
    ]);
    const resolved = await adjudicatePromotionSourceNormalizationBatch({
      cwd: workspace,
      batchRoot: "review-batch",
      annotationPaths: ["reviewer-a.jsonl", "reviewer-b.jsonl"],
      resolutionPath: "resolver.jsonl",
      outDir: "resolved-adjudication"
    });

    expect(resolved.report).toMatchObject({
      passed: true,
      disagreement_count: 1,
      resolved_disagreement_count: 1,
      resolver_id: "reviewer-c"
    });
    expect(resolved.report.agreement.full_label_exact_rate).toBe(0.5);
    expect(resolved.report.agreement.field_exact_rates.claim_text).toBe(0.5);
  });

  it("fails closed on reused annotator IDs and incomplete batch coverage", async () => {
    const { workspace, tasks } = await createReviewBatchWorkspace();
    await writeJsonLines(path.join(workspace, "reviewer-a.jsonl"), tasks.map((task) =>
      normalizationAnnotation(task.normalization_id, "reviewer-a")));
    await writeJsonLines(path.join(workspace, "reviewer-incomplete.jsonl"), [
      normalizationAnnotation(tasks[0].normalization_id, "reviewer-a")
    ]);

    const result = await adjudicatePromotionSourceNormalizationBatch({
      cwd: workspace,
      batchRoot: "review-batch",
      annotationPaths: ["reviewer-a.jsonl", "reviewer-incomplete.jsonl"],
      outDir: "invalid-adjudication"
    });
    const codes = result.report.validation_issues.map((issue) => issue.code);

    expect(result.report.passed).toBe(false);
    expect(result.accepted_labels_path).toBeNull();
    expect(codes).toEqual(expect.arrayContaining([
      "source_normalization_batch_initial_annotators_not_independent",
      "source_normalization_batch_annotation_coverage_incomplete"
    ]));
  });

  it("keeps adjudication outputs outside the closed reviewer batch", async () => {
    const { workspace } = await createReviewBatchWorkspace();
    await expect(adjudicatePromotionSourceNormalizationBatch({
      cwd: workspace,
      batchRoot: "review-batch",
      annotationPaths: ["reviewer-a.jsonl", "reviewer-b.jsonl"],
      outDir: "review-batch/adjudication"
    })).rejects.toThrow("outside the closed review batch");
  });
});

async function createReviewBatchWorkspace(): Promise<{
  workspace: string;
  tasks: Array<{ item_id: string; normalization_id: string }>;
}> {
  const workspace = await createProjectedWorkspace();
  await exportPromotionSourceNormalizationPack({ cwd: workspace, sourceRoot: "projected", outDir: "pack-a" });
  await createAdditionalProjectedSource(workspace);
  await exportPromotionSourceNormalizationPack({ cwd: workspace, sourceRoot: "projected-b", outDir: "pack-b" });
  await writeJson(path.join(workspace, "batch-recipe.json"), {
    schema_version: "1.0",
    batch_id: "review-batch-neutral",
    items: [
      { item_id: "source-item-001", source_root: "projected", pack_root: "pack-a" },
      { item_id: "source-item-002", source_root: "projected-b", pack_root: "pack-b" }
    ]
  });
  const batch = await exportPromotionSourceNormalizationBatch({
    cwd: workspace,
    recipePath: "batch-recipe.json",
    outDir: "review-batch"
  });
  const tasks = (await readFile(path.join(workspace, batch.tasks_path), "utf8"))
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  return { workspace, tasks };
}

async function createProjectedWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-source-normalization-"));
  tempDirs.push(workspace);
  const rawRoot = path.join(workspace, "raw");
  await mkdir(rawRoot, { recursive: true });
  await writeFile(path.join(rawRoot, "LICENSE"), "Neutral test fixture license.\n", "utf8");
  await writeJson(path.join(rawRoot, "reported-results.json"), [{ metric: "primary_score", baseline: 0.5, comparator: 0.6 }]);
  const sourceFiles = [
    ["run-config-source.json", "{\"declared_trials\":3}\n"],
    ["events-source.jsonl", "{\"event\":\"completed\",\"at\":\"2026-01-01T00:01:00.000Z\"}\n"],
    ["metrics-source.json", "{\"completed_trials\":3}\n"],
    ["review-source.json", "{\"outcome\":\"accept\"}\n"],
    ["command-source.txt", "runner --config run-config-source.json\n"],
    ["execution-source.log", "started=2026-01-01T00:00:00.000Z completed=2026-01-01T00:01:00.000Z exit=0\n"]
  ] as const;
  const supportFiles = [
    ["figure-source.png", "source-grounded figure fixture\n"],
    ["claim-source.md", "The source reports a baseline/comparator comparison.\n"],
    ["citations-source.bib", "@article{source_primary, title={Source record}}\n"]
  ] as const;
  for (const [fileName, contents] of sourceFiles) await writeFile(path.join(rawRoot, fileName), contents, "utf8");
  for (const [fileName, contents] of supportFiles) await writeFile(path.join(rawRoot, fileName), contents, "utf8");
  await writeJson(path.join(workspace, "projection.json"), {
    schema_version: "1.0",
    projection_id: "projection-neutral-a",
    source_family_id: "family-neutral-a",
    operator_group_id: "operator-neutral-a",
    source_revision: "revision-neutral-a",
    distribution_scope: "redistributable",
    license_review_status: "human_verified",
    license_path: "LICENSE",
    entries: [
      { mode: "copy_file", source_path: "reported-results.json", target_path: "observations/result-table.json" },
      ...sourceFiles.map(([fileName]) => ({ mode: "copy_file", source_path: fileName, target_path: `execution/${fileName}` })),
      ...supportFiles.map(([fileName]) => ({ mode: "copy_file", source_path: fileName, target_path: `support/${fileName}` }))
    ]
  });
  const projection = await projectPromotionSource({
    cwd: workspace,
    sourceRoot: "raw",
    recipePath: "projection.json",
    outDir: "projected"
  });
  expect(projection.manifest.ready_for_confirmatory_intake).toBe(false);
  return workspace;
}

async function createAdditionalProjectedSource(workspace: string): Promise<void> {
  await writeJson(path.join(workspace, "raw", "reported-results.json"), [
    { metric: "primary_score", baseline: 0.4, comparator: 0.7 }
  ]);
  const recipe = JSON.parse(await readFile(path.join(workspace, "projection.json"), "utf8"));
  await writeJson(path.join(workspace, "projection-b.json"), {
    ...recipe,
    projection_id: "projection-neutral-b",
    source_family_id: "family-neutral-b",
    operator_group_id: "operator-neutral-b",
    source_revision: "revision-neutral-b"
  });
  await projectPromotionSource({
    cwd: workspace,
    sourceRoot: "raw",
    recipePath: "projection-b.json",
    outDir: "projected-b"
  });
}

function normalizationAnnotation(normalizationId: string, annotatorId: string) {
  const executionArtifacts = [
    { role: "run_config", path: "execution/run-config-source.json" },
    { role: "event_log", path: "execution/events-source.jsonl" },
    { role: "metrics", path: "execution/metrics-source.json" },
    { role: "review_decision", path: "execution/review-source.json" },
    { role: "command", path: "execution/command-source.txt" },
    { role: "execution_log", path: "execution/execution-source.log" }
  ];
  return {
    schema_version: "1.0",
    normalization_id: normalizationId,
    annotator_id: annotatorId,
    label_source: "human",
    run_id: "run-neutral-a",
    run_status: "completed",
    execution_backend: "local_runtime",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:01:00.000Z",
    exit_code: 0,
    planned_trial_count: 3,
    executed_trial_count: 3,
    trial_ids: ["trial-a", "trial-b", "trial-c"],
    execution_artifacts: executionArtifacts,
    result_table_path: "observations/result-table.json",
    figure_count: 1,
    figure_paths: ["support/figure-source.png"],
    severe_mismatch_count: 0,
    review_block_required: false,
    claim_text: "The source-reported comparison is represented by the result table.",
    claim_section_heading: "Results",
    claim_status: "verified",
    claim_source_paths: ["support/claim-source.md"],
    citation_refs: ["source-primary"],
    citation_source_paths: ["support/citations-source.bib"],
    evidence_ids: ["evidence-primary"],
    citation_paper_ids: ["source-primary"],
    paper_ready: true,
    readiness_source_path: "execution/review-source.json",
    sota_ranking_claimed: false,
    sota_evidence_present: false,
    evidence_refs: [
      "observations/result-table.json",
      ...executionArtifacts.map((artifact) => artifact.path),
      "support/figure-source.png",
      "support/claim-source.md",
      "support/citations-source.bib"
    ],
    rationale: "Every normalized field is linked to a projected source artifact."
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonLine(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeJsonLines(filePath: string, values: unknown[]): Promise<void> {
  await writeFile(filePath, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}
