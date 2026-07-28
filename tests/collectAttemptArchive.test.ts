import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCollectAttemptId,
  persistCollectAttemptArchive
} from "../src/core/collection/collectAttemptArchive.js";
import { writeRunArtifact } from "../src/core/nodes/helpers.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import type { RunRecord } from "../src/types.js";

const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
});

describe("collect attempt archive", () => {
  it("copies exact snapshot bytes and binds them to one attempt manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-collect-attempt-"));
    process.chdir(root);
    const run = buildRun("run-attempt-archive");
    await mkdir(path.join(root, ".autolabos", "runs", run.id), { recursive: true });
    const attemptId = createCollectAttemptId(
      new Date("2026-01-02T03:04:05.678Z"),
      "genericattemptnonce"
    );
    const plan = `${JSON.stringify({ collect_attempt_id: attemptId, families: [] }, null, 2)}\n`;
    const emptyCorpus = "";
    await writeRunArtifact(run, "collect_query_plan.json", plan);
    await writeRunArtifact(run, "corpus.jsonl", emptyCorpus);

    const manifest = await persistCollectAttemptArchive({
      run,
      attemptId,
      status: "quality_gate_failed",
      artifactPaths: ["collect_query_plan.json", "corpus.jsonl"]
    });

    expect(attemptId).toBe("20260102030405678-genericattem");
    expect(manifest).toMatchObject({
      version: 2,
      phase: "collection",
      revision_id: expect.stringMatching(/^collection-[a-f0-9]{20}$/u)
    });
    expect(manifest.files).toEqual([
      expect.objectContaining({
        source_path: "collect_query_plan.json",
        sha256: createHash("sha256").update(plan).digest("hex"),
        byte_size: Buffer.byteLength(plan)
      }),
      expect.objectContaining({
        source_path: "corpus.jsonl",
        sha256: createHash("sha256").update(emptyCorpus).digest("hex"),
        byte_size: 0
      })
    ]);
    expect(
      await readFile(
        path.join(
          root,
          ".autolabos",
          "runs",
          run.id,
          "collect_attempts",
          attemptId,
          "collect_query_plan.json"
        ),
        "utf8"
      )
    ).toBe(plan);
    expect(
      await readFile(
        path.join(root, ".autolabos", "runs", run.id, "collect_attempt_manifest.json"),
        "utf8"
      )
    ).toContain(`"collect_attempt_id": "${attemptId}"`);
  });

  it("keeps phase revisions immutable and does not republish a superseded attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-collect-revisions-"));
    process.chdir(root);
    const run = buildRun("run-attempt-revisions");
    await mkdir(path.join(root, ".autolabos", "runs", run.id), { recursive: true });
    const firstAttempt = createCollectAttemptId(
      new Date("2026-01-02T03:04:05.678Z"),
      "firstgenericattempt"
    );
    const secondAttempt = createCollectAttemptId(
      new Date("2026-01-02T03:04:06.678Z"),
      "secondgenericattempt"
    );
    const collectionResult = `${JSON.stringify({
      collect_attempt_id: firstAttempt,
      enrichment: { status: "pending" }
    }, null, 2)}\n`;
    const enrichedResult = `${JSON.stringify({
      collect_attempt_id: firstAttempt,
      enrichment: { status: "completed" }
    }, null, 2)}\n`;

    const collectionManifest = await persistCollectAttemptArchive({
      run,
      attemptId: firstAttempt,
      status: "quality_gate_passed",
      phase: "collection",
      artifactPaths: ["collect_result.json"],
      artifactContents: { "collect_result.json": collectionResult },
      archivedAt: "2026-01-02T03:05:00.000Z"
    });
    const enrichmentManifest = await persistCollectAttemptArchive({
      run,
      attemptId: firstAttempt,
      status: "quality_gate_passed",
      phase: "enrichment",
      artifactPaths: ["collect_result.json"],
      artifactContents: { "collect_result.json": enrichedResult },
      archivedAt: "2026-01-02T03:06:00.000Z"
    });

    expect(collectionManifest.revision_id).not.toBe(enrichmentManifest.revision_id);
    expect(
      await readFile(
        path.join(root, ".autolabos", "runs", run.id, collectionManifest.files[0]!.archived_path),
        "utf8"
      )
    ).toBe(collectionResult);
    expect(
      await readFile(
        path.join(root, ".autolabos", "runs", run.id, enrichmentManifest.files[0]!.archived_path),
        "utf8"
      )
    ).toBe(enrichedResult);

    await persistCollectAttemptArchive({
      run,
      attemptId: secondAttempt,
      status: "quality_gate_passed",
      phase: "collection",
      artifactPaths: ["collect_result.json"],
      artifactContents: {
        "collect_result.json": `${JSON.stringify({ collect_attempt_id: secondAttempt }, null, 2)}\n`
      }
    });
    await persistCollectAttemptArchive({
      run,
      attemptId: firstAttempt,
      status: "quality_gate_passed",
      phase: "enrichment",
      artifactPaths: ["collect_result.json"],
      artifactContents: { "collect_result.json": enrichedResult },
      publishTopLevelLatest: false
    });

    expect(
      await readFile(
        path.join(root, ".autolabos", "runs", run.id, "collect_attempt_manifest.json"),
        "utf8"
      )
    ).toContain(`"collect_attempt_id": "${secondAttempt}"`);
  });

  it("rejects paths that could escape or recursively archive the attempt tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-collect-attempt-path-"));
    process.chdir(root);
    const run = buildRun("run-attempt-path-guard");

    await expect(
      persistCollectAttemptArchive({
        run,
        attemptId: "20260102030405678-genericattem",
        status: "planning_failed",
        artifactPaths: ["../outside.json"]
      })
    ).rejects.toThrow("collect_attempt_artifact_path_invalid");
  });
});

function buildRun(id: string): RunRecord {
  const now = new Date().toISOString();
  return {
    version: 3,
    workflowVersion: 3,
    id,
    title: "Generic collection attempt",
    topic: "generic research topic",
    constraints: [],
    objectiveMetric: "evidence coverage",
    status: "running",
    currentNode: "collect_papers",
    nodeThreads: {},
    createdAt: now,
    updatedAt: now,
    graph: createDefaultGraphState(),
    memoryRefs: {
      runContextPath: `.autolabos/runs/${id}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${id}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${id}/memory/episodes.jsonl`
    }
  };
}
