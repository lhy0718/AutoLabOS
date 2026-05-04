import path from "node:path";
import { promises as fs } from "node:fs";

import { RunRecord } from "../../types.js";
import { fileExists } from "../../utils/fs.js";
import { HarnessValidationIssue } from "./harnessValidators.js";

interface LongRunResumeAuditInput {
  run: RunRecord;
  runDir: string;
}

interface CheckpointRecordLike {
  seq?: number;
  runId?: string;
  node?: string;
  phase?: string;
  runSnapshot?: {
    id?: string;
    graph?: {
      checkpointSeq?: number;
    };
  };
  filePath: string;
}

export async function auditLongRunResumeSurfaces(
  input: LongRunResumeAuditInput
): Promise<HarnessValidationIssue[]> {
  const issues: HarnessValidationIssue[] = [];
  const runId = input.run.id;
  const checkpointSeq = Number(input.run.graph?.checkpointSeq || 0);
  const runRecordPath = path.join(input.runDir, "run_record.json");
  const checkpointsDir = path.join(input.runDir, "checkpoints");
  const checkpointDirPresent = await fileExists(checkpointsDir);
  const runRecordPresent = await fileExists(runRecordPath);

  const runRecord = runRecordPresent
    ? await readRunRecord(runRecordPath, runId, issues)
    : undefined;
  const shouldHaveLongRunSurfaces = checkpointSeq > 0 || checkpointDirPresent || runRecordPresent;

  if (shouldHaveLongRunSurfaces && !runRecordPresent) {
    issues.push({
      code: "run_record_missing_for_resume",
      message: "Runs with checkpoints or resume state must persist run_record.json for restart inspection.",
      filePath: runRecordPath,
      runId
    });
  }

  if (runRecord) {
    validateRunRecord({
      run: input.run,
      runRecord,
      runRecordPath,
      issues
    });
  }

  const checkpointRecords = await readCheckpointRecords({
    checkpointsDir,
    runId,
    issues
  });
  const maxCheckpointSeq = Math.max(0, ...checkpointRecords.map((record) => record.seq || 0));

  if (checkpointSeq > 0 || checkpointDirPresent || checkpointRecords.length > 0) {
    await validateLatestCheckpointPointer({
      checkpointsDir,
      checkpointSeq,
      maxCheckpointSeq,
      runId,
      issues
    });
    if (checkpointSeq > 0 && checkpointRecords.length === 0) {
      issues.push({
        code: "checkpoint_record_missing_for_resume",
        message: `Run ${runId} records checkpointSeq=${checkpointSeq}, but no checkpoint records were found.`,
        filePath: checkpointsDir,
        runId
      });
    }
  }

  if (maxCheckpointSeq > checkpointSeq) {
    issues.push({
      code: "runs_json_stale_vs_checkpoint",
      message:
        `runs.json records checkpointSeq=${checkpointSeq}, but checkpoint records reach seq=${maxCheckpointSeq}.`,
      filePath: path.join(path.dirname(input.runDir), "runs.json"),
      runId
    });
  }

  if (checkpointSeq > 0 && maxCheckpointSeq > 0 && maxCheckpointSeq < checkpointSeq) {
    issues.push({
      code: "checkpoint_record_behind_runs_json_for_resume",
      message:
        `runs.json records checkpointSeq=${checkpointSeq}, but checkpoint records only reach seq=${maxCheckpointSeq}.`,
      filePath: checkpointsDir,
      runId
    });
  }

  const runRecordCheckpointSeq = Number(runRecord?.graph?.checkpointSeq || 0);
  if (runRecord && maxCheckpointSeq > runRecordCheckpointSeq) {
    issues.push({
      code: "run_record_stale_vs_checkpoint",
      message:
        `run_record.json records checkpointSeq=${runRecordCheckpointSeq}, but checkpoint records reach seq=${maxCheckpointSeq}.`,
      filePath: runRecordPath,
      runId
    });
  }

  return issues;
}

async function readRunRecord(
  filePath: string,
  runId: string,
  issues: HarnessValidationIssue[]
): Promise<RunRecord | undefined> {
  const parsed = await readJsonObject({
    filePath,
    malformedCode: "run_record_malformed_for_resume",
    runId,
    issues
  });
  return parsed as RunRecord | undefined;
}

function validateRunRecord(input: {
  run: RunRecord;
  runRecord: RunRecord;
  runRecordPath: string;
  issues: HarnessValidationIssue[];
}): void {
  if (input.runRecord.id !== input.run.id) {
    input.issues.push({
      code: "run_record_id_mismatch_for_resume",
      message: `run_record.json references runId ${input.runRecord.id || "(missing)"}, expected ${input.run.id}.`,
      filePath: input.runRecordPath,
      runId: input.run.id
    });
  }

  const projectedSeq = Number(input.run.graph?.checkpointSeq || 0);
  const recordSeq = Number(input.runRecord.graph?.checkpointSeq || 0);
  if (recordSeq < projectedSeq) {
    input.issues.push({
      code: "run_record_checkpoint_regression",
      message:
        `run_record.json checkpointSeq=${recordSeq} is older than runs.json checkpointSeq=${projectedSeq}.`,
      filePath: input.runRecordPath,
      runId: input.run.id
    });
  }
}

async function readCheckpointRecords(input: {
  checkpointsDir: string;
  runId: string;
  issues: HarnessValidationIssue[];
}): Promise<CheckpointRecordLike[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(input.checkpointsDir);
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }

  const records: CheckpointRecordLike[] = [];
  for (const entry of entries.filter((item) => item.endsWith(".json") && item !== "latest.json").sort()) {
    const filePath = path.join(input.checkpointsDir, entry);
    const parsed = await readJsonObject({
      filePath,
      malformedCode: "checkpoint_record_malformed_for_resume",
      runId: input.runId,
      issues: input.issues
    });
    if (!parsed) {
      continue;
    }
    const record = {
      ...parsed,
      filePath
    } as CheckpointRecordLike;
    validateCheckpointRecord(record, input.runId, input.issues);
    records.push(record);
  }
  return records;
}

function validateCheckpointRecord(
  record: CheckpointRecordLike,
  runId: string,
  issues: HarnessValidationIssue[]
): void {
  if (!Number.isFinite(record.seq)) {
    issues.push({
      code: "checkpoint_record_seq_missing_for_resume",
      message: "Checkpoint record must include numeric seq.",
      filePath: record.filePath,
      runId
    });
  }
  if (record.runId !== runId) {
    issues.push({
      code: "checkpoint_record_run_id_mismatch_for_resume",
      message: `Checkpoint record references runId ${record.runId || "(missing)"}, expected ${runId}.`,
      filePath: record.filePath,
      runId
    });
  }
  if (record.runSnapshot?.id !== runId) {
    issues.push({
      code: "checkpoint_snapshot_run_id_mismatch_for_resume",
      message: `Checkpoint snapshot references runId ${record.runSnapshot?.id || "(missing)"}, expected ${runId}.`,
      filePath: record.filePath,
      runId
    });
  }
  if (
    Number.isFinite(record.seq)
    && Number.isFinite(record.runSnapshot?.graph?.checkpointSeq)
    && record.runSnapshot?.graph?.checkpointSeq !== record.seq
  ) {
    issues.push({
      code: "checkpoint_snapshot_seq_mismatch_for_resume",
      message:
        `Checkpoint snapshot checkpointSeq=${record.runSnapshot?.graph?.checkpointSeq}, expected seq=${record.seq}.`,
      filePath: record.filePath,
      runId
    });
  }
}

async function validateLatestCheckpointPointer(input: {
  checkpointsDir: string;
  checkpointSeq: number;
  maxCheckpointSeq: number;
  runId: string;
  issues: HarnessValidationIssue[];
}): Promise<void> {
  const latestPath = path.join(input.checkpointsDir, "latest.json");
  if (!(await fileExists(latestPath))) {
    input.issues.push({
      code: "checkpoint_latest_missing_for_resume",
      message: "Checkpointed runs must include checkpoints/latest.json for restart inspection.",
      filePath: latestPath,
      runId: input.runId
    });
    return;
  }

  const latest = await readJsonObject({
    filePath: latestPath,
    malformedCode: "checkpoint_latest_malformed_for_resume",
    runId: input.runId,
    issues: input.issues
  });
  if (!latest) {
    return;
  }

  const latestSeq = Number(latest.seq || 0);
  const latestFile = typeof latest.file === "string" ? latest.file : "";
  if (!latestFile || path.basename(latestFile) !== latestFile) {
    input.issues.push({
      code: "checkpoint_latest_file_invalid_for_resume",
      message: "checkpoints/latest.json must reference a checkpoint file by basename only.",
      filePath: latestPath,
      runId: input.runId
    });
    return;
  }

  const referencedPath = path.join(input.checkpointsDir, latestFile);
  if (!(await fileExists(referencedPath))) {
    input.issues.push({
      code: "checkpoint_latest_file_missing_for_resume",
      message: `checkpoints/latest.json references ${latestFile}, but that checkpoint file is missing.`,
      filePath: latestPath,
      runId: input.runId
    });
  }

  if (input.maxCheckpointSeq > latestSeq) {
    input.issues.push({
      code: "checkpoint_latest_stale_for_resume",
      message:
        `checkpoints/latest.json points to seq=${latestSeq}, but checkpoint records reach seq=${input.maxCheckpointSeq}.`,
      filePath: latestPath,
      runId: input.runId
    });
  }

  if (input.checkpointSeq > latestSeq) {
    input.issues.push({
      code: "checkpoint_latest_behind_runs_json_for_resume",
      message:
        `runs.json records checkpointSeq=${input.checkpointSeq}, but checkpoints/latest.json points to seq=${latestSeq}.`,
      filePath: latestPath,
      runId: input.runId
    });
  }

  if (input.checkpointSeq > 0 && latestSeq === 0) {
    input.issues.push({
      code: "checkpoint_latest_seq_missing_for_resume",
      message: "checkpoints/latest.json must include a numeric seq for checkpointed runs.",
      filePath: latestPath,
      runId: input.runId
    });
  }
}

async function readJsonObject(input: {
  filePath: string;
  malformedCode: string;
  runId: string;
  issues: HarnessValidationIssue[];
}): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(input.filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      input.issues.push({
        code: input.malformedCode,
        message: `${path.basename(input.filePath)} must decode to an object.`,
        filePath: input.filePath,
        runId: input.runId
      });
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    input.issues.push({
      code: input.malformedCode,
      message: `Unable to parse ${path.basename(input.filePath)}: ${errorMessage(error)}`,
      filePath: input.filePath,
      runId: input.runId
    });
    return undefined;
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
